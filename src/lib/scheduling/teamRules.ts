import { DEFAULT_RULE_SETTINGS } from "./rules";
import type {
  RuleRow,
  RuleSettings,
  SchedulerInput,
  StaffMember,
} from "./types";

/**
 * The Staff, Instruction and Compliance blocks of the Rules sheet — the ones
 * `rules.ts` deliberately leaves alone, because the single-provider planner has
 * no way to express "a parapro may lead this when the SLC teacher is present".
 *
 * Every row of those three blocks is accounted for here, including the rows we
 * satisfy by construction and the ones we knowingly do not model, so the page
 * can show a teacher what is actually being enforced rather than implying
 * blanket coverage.
 */
export type RuleSection = "Staff" | "Instruction" | "Compliance";

/**
 * How a rule reaches the schedule.
 *
 * - `hard` — a slot that breaks it is never used.
 * - `soft` — preferred while placing, and reported when missed.
 * - `structural` — the data model cannot express a violation (one Staff row per
 *   person means availability is the same all week, and so on).
 * - `unmodelled` — listed, never enforced.
 */
export type RuleEnforcement = "hard" | "soft" | "structural" | "unmodelled";

/**
 * The settings a Rules-sheet Value can drive. `concurrentServices` is a list,
 * not a number, so it is not one of them.
 */
export type NumericTeamSetting = {
  [K in keyof TeamSettings]: TeamSettings[K] extends number ? K : never;
}[keyof TeamSettings];

export interface TeamRule {
  /** Stable code, so placements and violations can point back at a rule. */
  id: string;
  section: RuleSection;
  /** What the sheet's own "Hard"/"Soft" column says. */
  hardness: "Hard" | "Soft";
  summary: string;
  /**
   * Lowercase substring that identifies this rule in the sheet's text, or null
   * for a rule that comes from the teacher rather than from a row.
   */
  match: string | null;
  /** The knob this rule's Value column drives, when it drives one. */
  setting: NumericTeamSetting | null;
  enforcement: RuleEnforcement;
  /** How it is enforced, in a teacher's words. */
  detail: string;
}

/**
 * `RuleSettings` plus the knobs only the team planner has. The inherited ones
 * still apply: grouping, transition time and per-person minute caps work the
 * same way, they are just resolved per staff member instead of once.
 */
export interface TeamSettings extends RuleSettings {
  /** Rules 9 and 10: how many students one parapro may lead. */
  paraMaxGroupSize: number;
  /** Rule 6: how many pieces the SLC teacher's break may be split into. */
  slcBreakChunks: number;
  /** Rule 4: a parapro break may not start within this long of the day's start. */
  paraBreakMinAfterStart: number;
  /** Rule 4: nor end within this long of the day's end. */
  paraBreakMinBeforeEnd: number;
  /** Rule 5: minutes after midnight a parapro lunch should start between. */
  paraLunchStart: number;
  paraLunchEnd: number;
}

export const DEFAULT_TEAM_SETTINGS: TeamSettings = {
  ...DEFAULT_RULE_SETTINGS,
  paraMaxGroupSize: 3,
  slcBreakChunks: 2,
  paraBreakMinAfterStart: 60,
  paraBreakMinBeforeEnd: 60,
  paraLunchStart: 11 * 60 + 30,
  paraLunchEnd: 13 * 60 + 30,
};

export const TEAM_RULES: TeamRule[] = [
  /* ---------- Staff ---------- */
  {
    id: "slc-one-group",
    section: "Staff",
    hardness: "Hard",
    summary: "The SLC teacher teaches one group at a time",
    match: "can teach one group at a time",
    setting: null,
    enforcement: "hard",
    detail:
      "Every staff member has their own booked time; nobody is doubled up.",
  },
  {
    id: "para-supervised",
    section: "Staff",
    hardness: "Hard",
    summary: "A parapro instructs only while the SLC teacher is in the room",
    match: "when the slc teacher is present in the room",
    setting: null,
    enforcement: "hard",
    detail:
      "A parapro only leads a pull-out group while the SLC teacher is in the room — within her hours, and not on her lunch, her break, or a push-in that takes her to a classroom.",
  },
  {
    id: "para-no-new-sdi",
    section: "Staff",
    hardness: "Hard",
    summary: "Parapros do not introduce new instruction independently",
    match: "may not introduce new specially designed instruction",
    setting: null,
    enforcement: "hard",
    detail:
      'A parapro may only lead a service whose Minutes row says "Can Para Lead?", and the lead provider still takes one session of it each week.',
  },
  {
    id: "para-break-window",
    section: "Staff",
    hardness: "Hard",
    summary: "Parapro breaks avoid the first and last hour of the day",
    match: "breaks must be at least an hour after the school day starts",
    setting: "paraBreakMinAfterStart",
    enforcement: "hard",
    detail:
      "A parapro break starts at least an hour into their day and finishes before their last hour.",
  },
  {
    id: "para-lunch-window",
    section: "Staff",
    hardness: "Soft",
    summary: "Parapro lunches start between 11:30 and 1:30",
    match: "lunches must start within the hours",
    setting: null,
    enforcement: "soft",
    detail:
      "Preferred when placing lunch; a lunch that has to fall outside the window is reported rather than moved.",
  },
  {
    id: "slc-break-chunks",
    section: "Staff",
    hardness: "Hard",
    summary: "The SLC teacher's break may be split into chunks",
    match: "break can be broken up into chunks",
    setting: "slcBreakChunks",
    enforcement: "hard",
    detail: "The break is placed as up to this many pieces across the day.",
  },
  {
    id: "slc-lunch-cover",
    section: "Staff",
    hardness: "Hard",
    summary: "The SLC teacher's lunch is covered by a parapro",
    match: "lunch must take place when students are in ge",
    setting: null,
    enforcement: "hard",
    detail:
      "Placed only where no session at all is running in the SLC room and at least one parapro is not themselves on lunch or break.",
  },
  {
    id: "slc-break-cover",
    section: "Staff",
    hardness: "Hard",
    summary: "The SLC teacher's break is covered by a parapro",
    match: "break must take place when students are in ge",
    setting: null,
    enforcement: "hard",
    detail: "Same cover test as the lunch above.",
  },
  {
    id: "para-review-group-size",
    section: "Staff",
    hardness: "Soft",
    summary: "Parapro-led review groups are 3 students or fewer",
    match: "review groups may not exceed",
    setting: "paraMaxGroupSize",
    enforcement: "soft",
    detail:
      "A bigger group is left with its certified lead rather than handed to a parapro.",
  },
  {
    id: "para-support-group-size",
    section: "Staff",
    hardness: "Soft",
    summary: "Parapro-led support groups in general education are 3 or fewer",
    match: "support groups may not exceed",
    setting: "paraMaxGroupSize",
    enforcement: "soft",
    detail: "The same cap, applied to push-in support in a GE classroom.",
  },
  {
    id: "students-with-sped",
    section: "Staff",
    hardness: "Hard",
    summary: "Students are with special education staff at all times",
    match: "must be with special education staff",
    setting: null,
    enforcement: "structural",
    detail:
      "Every session carries a named staff member; outside their sessions students are in their general education class.",
  },
  {
    id: "availability-mon-fri",
    section: "Staff",
    hardness: "Hard",
    summary: "Staff availability is the same Monday to Friday",
    match: "availability is the same monday through friday",
    setting: null,
    enforcement: "structural",
    detail:
      "The one start and end time on the Staff sheet applies to all five days.",
  },
  {
    id: "assigned-services-only",
    section: "Staff",
    hardness: "Hard",
    summary: "Staff only provide the services assigned to them in Minutes",
    match: "may only provide services assigned to them",
    setting: null,
    enforcement: "hard",
    detail:
      "A session can only be given to that row's Lead Provider or one of its Alternate Providers.",
  },
  {
    id: "para-coverage",
    section: "Staff",
    hardness: "Hard",
    summary:
      "Parapros provide support and reinforcement per the coverage rules",
    match: "assigned student support and supervised reinforcement",
    setting: null,
    enforcement: "structural",
    detail: "Carried by the supervision and assigned-services rules above.",
  },
  {
    id: "para-preferred-grade",
    section: "Staff",
    hardness: "Soft",
    summary: "Parapros work with their preferred grade where possible",
    match: "preferred grade level when possible",
    setting: null,
    enforcement: "soft",
    detail:
      "When more than one parapro could take a session, the one whose preferred grade matches the group wins.",
  },
  {
    id: "slc-and-coteach-separate",
    section: "Staff",
    hardness: "Hard",
    summary: "The SLC teacher and co-teachers are separate providers",
    match: "considered separate providers",
    setting: null,
    enforcement: "structural",
    detail:
      "Each has their own diary, so their sessions may run at the same time.",
  },

  /* ---------- Instruction ---------- */
  {
    id: "never-miss-recess",
    section: "Instruction",
    hardness: "Hard",
    summary: "Never miss Recess",
    match: "never miss recess",
    setting: null,
    enforcement: "hard",
    detail:
      "No service lists Recess on Service Matches, so nothing may displace it.",
  },
  {
    id: "never-miss-specials",
    section: "Instruction",
    hardness: "Hard",
    summary: "Never miss Specials",
    match: "never miss specials",
    setting: null,
    enforcement: "hard",
    detail: "As above.",
  },
  {
    id: "never-miss-lunch",
    section: "Instruction",
    hardness: "Hard",
    summary: "Never miss Lunch",
    match: "never miss lunch",
    setting: null,
    enforcement: "hard",
    detail: "As above.",
  },
  {
    id: "student-one-place",
    section: "Instruction",
    hardness: "Hard",
    summary: "Students cannot be in two places at once",
    match: "students cannot be in two places",
    setting: null,
    enforcement: "hard",
    detail:
      "Each student's booked time is tracked across every provider, including OT, PT and Resource.",
  },
  {
    id: "staff-one-place",
    section: "Instruction",
    hardness: "Hard",
    summary: "Staff cannot be in two places at once",
    match: "staff cannot be in two places",
    setting: null,
    enforcement: "hard",
    detail:
      "Each staff member's sessions, lunch and break all block their diary.",
  },
  {
    id: "mixed-grade-pullout",
    section: "Instruction",
    hardness: "Hard",
    summary: "Mixed grades may share a pull-out group when minutes align",
    match: "allow mixed grades to pull-out groups",
    setting: null,
    enforcement: "hard",
    detail:
      "The grade span is waived for pull-out groups whose session lengths are already within the session-length span.",
  },
  {
    id: "same-group-all-week",
    section: "Instruction",
    hardness: "Soft",
    summary: "Students keep the same small group all week",
    match: "keep students with the same small groups",
    setting: null,
    enforcement: "structural",
    detail:
      "A group is formed once and every one of its sessions has the same members.",
  },
  {
    id: "mtss-whole-group",
    section: "Instruction",
    hardness: "Hard",
    summary: "MTSS uses the resource room as one whole group",
    match: "the resource room is utilized as a whole-group",
    setting: null,
    enforcement: "hard",
    detail:
      "No other pull-out group is placed in the SLC room while a whole-group MTSS session is running.",
  },
  {
    id: "coteach-classroom",
    section: "Instruction",
    hardness: "Hard",
    summary: "Co-taught services happen in the designated co-teach classroom",
    match: "must receive services in the designated co-teach classroom",
    setting: null,
    enforcement: "hard",
    detail:
      "Co-teach groups only take students who share that classroom, and the session is located there.",
  },
  {
    id: "pushin-stays-put",
    section: "Instruction",
    hardness: "Hard",
    summary: "Push-in services stay in the assigned classroom",
    match: "remain in the assigned instructional classroom",
    setting: null,
    enforcement: "structural",
    detail: "A push-in session is located in its students' own room.",
  },

  /* ---------- Compliance ---------- */
  {
    id: "dismissal-not-counted",
    section: "Compliance",
    hardness: "Soft",
    summary: "Dismissal does not count towards IEP minutes",
    match: "dismissal time does not count",
    setting: null,
    enforcement: "structural",
    detail:
      "Dismissal is on no service's subject list, so no session is ever placed in it or credited for it.",
  },
  {
    id: "report-dont-reduce",
    section: "Compliance",
    hardness: "Hard",
    summary: "Report an impossible schedule instead of changing minutes",
    match: "report it instead of changing minutes",
    setting: null,
    enforcement: "structural",
    detail:
      "Prescribed minutes are never lowered; a shortfall is listed as a shortfall.",
  },
  {
    id: "record-the-conflict",
    section: "Compliance",
    hardness: "Hard",
    summary: "Record the conflict rather than reducing minutes",
    match: "record the conflict instead of reducing",
    setting: null,
    enforcement: "structural",
    detail:
      "Every unplaced session is reported with the reason it would not fit.",
  },

  /* ---------- Not from a sheet row ---------- */
  {
    id: "lead-sees-weekly",
    section: "Staff",
    hardness: "Hard",
    summary: "The lead provider meets each student at least once a week",
    match: null,
    setting: null,
    enforcement: "hard",
    detail:
      "For every line on the Minutes sheet, the named Lead Provider personally takes one of that line's sessions each week before any alternate covers the rest.",
  },
];

export const TEAM_RULE_BY_ID = new Map(
  TEAM_RULES.map((rule) => [rule.id, rule]),
);

export interface TeamRuleReading {
  settings: Partial<TeamSettings>;
  /** Rows of the three blocks this registry has no entry for. */
  unmodelled: string[];
  /** Hard/Soft as the sheet itself states it, keyed by rule id. */
  hardness: Record<string, "Hard" | "Soft">;
}

/**
 * Interpret the Staff, Instruction and Compliance blocks.
 *
 * A row we recognise contributes its value to a knob; a row we do not is handed
 * back so the page can say plainly that it is not being checked, rather than
 * leaving a teacher to assume the sheet was obeyed.
 */
export function readTeamRules(rows: RuleRow[]): TeamRuleReading {
  const settings: Partial<TeamSettings> = {};
  const unmodelled: string[] = [];
  const hardness: Record<string, "Hard" | "Soft"> = {};

  for (const row of rows) {
    // The Speech block, where a workbook still has one, is `rules.ts`'s job.
    if (!row.section) continue;

    const rule = TEAM_RULES.find(
      (candidate) =>
        candidate.match != null &&
        row.text.toLowerCase().includes(candidate.match),
    );
    if (!rule) {
      unmodelled.push(row.text);
      continue;
    }

    if (/^soft$/i.test(row.hardness)) hardness[rule.id] = "Soft";
    else if (/^hard$/i.test(row.hardness)) hardness[rule.id] = "Hard";

    if (!rule.setting) continue;

    const value = Number(row.value);
    if (!row.value || !Number.isFinite(value)) continue;
    settings[rule.setting] = value;
  }

  return { settings, unmodelled, hardness };
}

/** Defaults, then whatever the Rules sheet filled in. */
export function resolveTeamSettings(
  input: SchedulerInput,
  overrides?: Partial<TeamSettings>,
): { settings: TeamSettings; reading: TeamRuleReading } {
  const reading = readTeamRules(input.ruleRows);
  return {
    settings: {
      ...DEFAULT_TEAM_SETTINGS,
      ...input.ruleOverrides,
      ...reading.settings,
      ...overrides,
    },
    reading,
  };
}

/* ---------- staff roles ---------- */

/**
 * The Staff sheet names roles in prose ("SLC Teacher", "Parapro", "Co-Teacher"),
 * so match loosely rather than by exact string.
 */
export function isParapro(member: StaffMember): boolean {
  return /para/i.test(member.role) || /para/i.test(member.providerType);
}

export function isSlcTeacher(member: StaffMember): boolean {
  return (
    /slc/i.test(member.role) || /pull-?out teacher/i.test(member.providerType)
  );
}

export function isCoTeacher(member: StaffMember): boolean {
  return (
    /co-?teach/i.test(member.role) ||
    /push-?in teacher/i.test(member.providerType)
  );
}

/** General education teachers are listed for reference; they deliver nothing. */
export function isGenEdTeacher(member: StaffMember): boolean {
  return /gen-?ed/i.test(member.providerType) || /^ge /i.test(member.role);
}

/** Everyone the planner may actually book. */
export function schedulableStaff(staff: StaffMember[]): StaffMember[] {
  return staff.filter((member) => !isGenEdTeacher(member));
}

/**
 * Which grades a parapro prefers. The column holds "K", "3", or "All"; anything
 * unparseable means no preference rather than none allowed.
 */
export function preferredGrades(member: StaffMember): number[] | null {
  const text = member.preferredGrades.trim();
  if (!text || /^all$/i.test(text)) return null;
  const grades = text
    .split(/[,/]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/^k$/i.test(part) ? 0 : Number(part)))
    .filter((grade) => Number.isFinite(grade));
  return grades.length ? grades : null;
}
