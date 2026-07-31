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
  /** Class exactly as written in the Students sheet, e.g. "K: Cave". */
  className: string;
  /** Normalized key used to find the matching class schedule sheet. */
  classKey: string;
}

/** One row of a class (teacher) schedule sheet. */
export interface ClassBlock {
  /** Minutes after midnight. */
  start: number;
  end: number;
  subject: string;
  /** "Service Possible" column — is it OK to pull a student during this block? */
  servicePossible: boolean;
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

export interface SchedulerInput {
  fileName: string;
  students: Student[];
  /** Keyed by `classKey`. */
  classes: Record<string, ClassBlock[]>;
  /** Sheet name each class schedule came from, keyed by `classKey`. */
  classSheetNames: Record<string, string>;
  services: ServiceSession[];
  /** Distinct service names found, in sheet order. */
  serviceNames: string[];
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
  /** Free to pull the student — class block is marked Service Possible. */
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
