export const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
] as const;

export type Day = (typeof DAYS)[number];

/** A student pulled from the "Students" input sheet. */
export interface Student {
  name: string;
  /** Class exactly as written in the Students sheet, e.g. "K Cave". */
  className: string;
  /** Normalized key used to find the matching class schedule sheet. */
  classKey: string;
  /** Grade read off the front of the class name: "K Cave" -> 0, "3 Harris" -> 3. */
  grade: number | null;
}

/** One row of a class (teacher) schedule sheet, for one weekday. */
export interface ClassBlock {
  day: Day;
  /** Minutes after midnight. */
  start: number;
  end: number;
  subject: string;
  /**
   * The old template's "Service Possible" column. Newer workbooks drop it and
   * decide eligibility from Service Matches instead, so it is `null` there.
   */
  servicePossible: boolean | null;
}

/** A class schedule, split by weekday: newer templates vary the day columns. */
export type ClassSchedule = Record<Day, ClassBlock[]>;

export function emptyClassSchedule(): ClassSchedule {
  return {
    Monday: [],
    Tuesday: [],
    Wednesday: [],
    Thursday: [],
    Friday: [],
  };
}

/** One booked session from a service sheet such as OT, PT or Resource. */
export interface ServiceSession {
  day: Day;
  start: number;
  end: number;
  /** Student name as written on the service sheet. */
  student: string;
  /** Service name, taken from the sheet name (OT, PT, Resource, ...). */
  service: string;
}

export type DeliveryModel = "Pull-Out" | "Push-In";
export type GroupType = "Small Group" | "Whole Group";

/** One row of the "Minutes" sheet: what a student is prescribed. */
export interface ServiceRequirement {
  student: string;
  service: string;
  minutesPerWeek: number;
  sessionLength: number;
  sessionsPerWeek: number;
  providers: string[];
  canParaLead: boolean;
  paraSupports: boolean;
  model: DeliveryModel;
  groupType: GroupType;
}

/** One row of the "Service Definitions" sheet. */
export interface ServiceDefinition {
  service: string;
  parentService: string;
  location: string;
  requiresCertifiedTeacher: boolean;
  paraNeeded: boolean;
  paraCanDeliver: boolean;
  pullOut: boolean;
  pushIn: boolean;
  coTeachClassroomRequired: boolean;
}

/**
 * One row of "Service Matches": the classroom subjects a service is allowed to
 * displace, for one delivery model. This is the only authority on eligibility.
 */
export interface ServiceMatch {
  service: string;
  model: DeliveryModel;
  subjects: string[];
}

/** One row of the "Staff" sheet. */
export interface StaffMember {
  name: string;
  role: string;
  providerType: string;
  preferredGrades: string;
  /** Minutes after midnight; null when the sheet left it blank. */
  startMinutes: number | null;
  endMinutes: number | null;
  lunchMinutes: number | null;
  breakMinutes: number | null;
}

/**
 * The tunable numbers behind the Speech rules (Rules rows 2-14). Defaults live
 * in `rules.ts`; a non-blank Value on the Rules sheet overrides one.
 */
export interface RuleSettings {
  /** Rule 3. */
  gradeDeltaGenEd: number;
  /** Rule 4. */
  gradeDeltaSpecialEd: number;
  /** Rule 11. */
  sessionLengthDelta: number;
  /** Rule 7. */
  maxGroupSize: number;
  preferredGroupSize: number;
  /** Rule 10; rule 9 makes this zero for push-in. */
  pullOutTransitionMinutes: number;
  /** Rule 8, the core capacity rule. */
  maxMinutesPerDay: number;
  maxMinutesPerWeek: number;
  /** Rule 6: the only services that may run concurrently for one student. */
  concurrentServices: string[];
}

/** A stretch of one day a requirement could legally be delivered in. */
export interface Window {
  day: Day;
  /** Minutes after midnight. */
  start: number;
  end: number;
  /** The classroom subjects this window covers, for explaining it. */
  subjects: string[];
}

/**
 * Why a session could not be placed. These are counted into a histogram per
 * requirement, mirroring the workbook's own Conflicts sheet.
 */
export type UnplacedReason =
  | "No eligible subject in this class"
  | "Session longer than any eligible block"
  | "Student already booked with another provider"
  | "Provider already busy"
  | "Provider minute cap reached"
  | "Student already receiving another service";

/**
 * A requirement plus everything grouping needs to reason about it: who the
 * student is and when they are actually free. Lives here rather than in
 * `group.ts` so the planner and the explainer can both take one without
 * importing each other.
 */
export interface Candidate {
  requirement: ServiceRequirement;
  student: Student;
  windows: Window[];
  /** Set when there were no windows at all, so the plan can explain why. */
  reason: UnplacedReason | null;
}

/** Students who share a service, a session length and enough free time. */
export interface Group {
  id: string;
  service: string;
  model: DeliveryModel;
  groupType: GroupType;
  /** Student names, in roster order. */
  members: string[];
  /** The longest session length in the group — what the whole group is booked for. */
  sessionLength: number;
  /** The most sessions any member needs. */
  sessionsPerWeek: number;
  /** Windows every member is free for, the group's legal times. */
  sharedWindows: Window[];
}

export interface Placement {
  groupId: string;
  service: string;
  model: DeliveryModel;
  members: string[];
  day: Day;
  start: number;
  end: number;
  /** The classroom subject this session displaces. */
  subject: string;
}

export interface Unplaced {
  student: string;
  service: string;
  model: DeliveryModel;
  /** Sessions still owed after placement. */
  missingSessions: number;
  missingMinutes: number;
  reasons: Partial<Record<UnplacedReason, number>>;
}

export interface ComplianceRow {
  student: string;
  service: string;
  requiredMinutes: number;
  scheduledMinutes: number;
  difference: number;
  status: "OK" | "PARTIAL" | "MISSING";
}

export interface CapacityReport {
  provider: string;
  requirementCount: number;
  studentMinutesPerWeek: number;
  studentSessionsPerWeek: number;
  /** Provider minutes the grouped plan would need if every session fitted. */
  groupedMinutesPerWeek: number;
  /** Rule 8's cap. */
  availableMinutesPerWeek: number;
  scheduledMinutesPerWeek: number;
}

export interface PlanResult {
  provider: string;
  settings: RuleSettings;
  groups: Group[];
  placements: Placement[];
  unplaced: Unplaced[];
  compliance: ComplianceRow[];
  capacity: CapacityReport;
  /** Students the provider never meets, per rule 13. */
  unseenStudents: string[];
}

export interface SchedulerInput {
  fileName: string;
  students: Student[];
  /** Keyed by `classKey`. */
  classes: Record<string, ClassSchedule>;
  /** Sheet name each class schedule came from, keyed by `classKey`. */
  classSheetNames: Record<string, string>;
  services: ServiceSession[];
  /** Distinct service names found, in sheet order. */
  serviceNames: string[];
  /** Subject vocabulary, used to tokenize Service Matches subject lists. */
  subjects: string[];
  staff: StaffMember[];
  requirements: ServiceRequirement[];
  serviceMatches: ServiceMatch[];
  serviceDefinitions: ServiceDefinition[];
  /** Whatever the Rules sheet filled in; everything else falls back to defaults. */
  ruleOverrides: Partial<RuleSettings>;
  warnings: string[];
}

export interface GridSettings {
  /** Minutes after midnight. */
  startMinutes: number;
  endMinutes: number;
  /** Length of one row of the grid, in minutes. */
  slotMinutes: number;
}

export type CellStatus =
  /** Free to pull the student — some service is allowed to displace this block. */
  | "available"
  /** Class is in session but the student should not be pulled. */
  | "unavailable"
  /** Student is already booked with another service provider. */
  | "booked"
  /** Nothing scheduled for this student at this time. */
  | "empty";

export interface GridCell {
  label: string;
  status: CellStatus;
}

export interface GridSlot {
  start: number;
  end: number;
  label: string;
}

export interface DayGrid {
  day: Day;
  slots: GridSlot[];
  /** One row per slot, one cell per student (same order as `students`). */
  rows: GridCell[][];
}

export interface ScheduleResult {
  students: Student[];
  settings: GridSettings;
  grids: DayGrid[];
}
