import type { RuleSettings, SchedulerInput, StaffMember } from "./types";

/**
 * The Speech rules — the block on the Rules sheet under the "Speech" heading,
 * ending at the "Staff Rule" separator. Only these are in scope; the Staff,
 * Instruction and Compliance sections below them are not modelled.
 *
 * `setting` names the knob a rule drives, or null when the rule shapes the
 * search rather than a number. `enforced` is false for rules we knowingly do
 * not implement yet, so the UI can say so instead of implying coverage.
 */
export interface SpeechRule {
  /** Row on the Rules sheet, for cross-referencing. */
  row: number;
  summary: string;
  /** Substring that identifies this rule in the sheet text. */
  match: string;
  setting: keyof RuleSettings | null;
  enforced: boolean;
}

export const SPEECH_RULES: SpeechRule[] = [
  {
    row: 2,
    summary: "Spread a group's sessions across different days",
    match: "should not be happening on the same day",
    setting: null,
    enforced: true,
  },
  {
    row: 3,
    summary: "Group students within 1 grade of each other (general education)",
    match: "general education",
    setting: "gradeDeltaGenEd",
    enforced: true,
  },
  {
    row: 4,
    summary: "Group students within x grades of each other (special education)",
    match: "special education",
    setting: "gradeDeltaSpecialEd",
    enforced: true,
  },
  {
    row: 5,
    summary: "Prefer students from the same classroom",
    match: "same classroom together",
    setting: null,
    enforced: true,
  },
  {
    row: 6,
    summary:
      "One service at a time per student, except fluency and articulation",
    match: "served at the same time",
    setting: "concurrentServices",
    enforced: true,
  },
  {
    row: 7,
    summary: "Group size max 4, 2-3 preferred",
    match: "group size is a max",
    setting: "maxGroupSize",
    enforced: true,
  },
  {
    row: 8,
    summary: "Provider service-minute cap per day and per week (core rule)",
    match: "service minutes per day",
    setting: "maxMinutesPerDay",
    enforced: true,
  },
  {
    row: 9,
    summary: "Push-in has no transition time within the same class",
    match: "push-in has no transition",
    setting: null,
    enforced: true,
  },
  {
    row: 10,
    summary: "Pull-out has transition time",
    match: "pull-out has transition",
    setting: "pullOutTransitionMinutes",
    enforced: true,
  },
  {
    row: 11,
    summary: "Group students with similar session lengths",
    match: "similar service minute lengths",
    setting: "sessionLengthDelta",
    enforced: true,
  },
  {
    row: 12,
    summary: "Condense into three consistent weeks plus a makeup week",
    match: "condense services into three weeks",
    setting: null,
    enforced: false,
  },
  {
    row: 13,
    summary: "Lead provider sees every student every week",
    match: "see every student every week",
    setting: null,
    enforced: true,
  },
  {
    row: 14,
    summary: "Group prioritization ranking",
    match: "group prioritization ranking",
    setting: null,
    enforced: true,
  },
];

const SCHOOL_DAYS = 5;

export const DEFAULT_RULE_SETTINGS: RuleSettings = {
  gradeDeltaGenEd: 1,
  gradeDeltaSpecialEd: 1,
  sessionLengthDelta: 10,
  maxGroupSize: 4,
  preferredGroupSize: 3,
  pullOutTransitionMinutes: 5,
  // Overwritten from the Staff sheet whenever the provider's hours are known.
  maxMinutesPerDay: 375,
  maxMinutesPerWeek: 375 * SCHOOL_DAYS,
  concurrentServices: ["Fluency", "Articulation"],
};

/**
 * Rule 8's cap, derived from the provider's own row: the working day less lunch
 * and break. The Rules sheet leaves the number blank, so this is the default
 * until someone fills it in or edits it in the UI.
 */
export function deriveCapacity(
  provider: StaffMember | undefined,
): Pick<RuleSettings, "maxMinutesPerDay" | "maxMinutesPerWeek"> {
  if (!provider?.startMinutes || !provider.endMinutes) {
    return {
      maxMinutesPerDay: DEFAULT_RULE_SETTINGS.maxMinutesPerDay,
      maxMinutesPerWeek: DEFAULT_RULE_SETTINGS.maxMinutesPerWeek,
    };
  }
  const day =
    provider.endMinutes -
    provider.startMinutes -
    (provider.lunchMinutes ?? 0) -
    (provider.breakMinutes ?? 0);
  const maxMinutesPerDay = Math.max(day, 0);
  return {
    maxMinutesPerDay,
    maxMinutesPerWeek: maxMinutesPerDay * SCHOOL_DAYS,
  };
}

/**
 * Pull whatever the Rules sheet actually filled in. Every Value is blank in the
 * current template, so this mostly exists so the sheet can take over later
 * without a code change.
 */
export function readRuleOverrides(
  cell: (row: number, col: number) => string,
  rowCount: number,
): Partial<RuleSettings> {
  const overrides: Partial<RuleSettings> = {};

  for (let row = 2; row <= rowCount; row++) {
    const text = cell(row, 2);
    // The Speech block ends at the first blank row; "Staff Rule" and the
    // sections after it are out of scope.
    if (!text) break;

    const rule = SPEECH_RULES.find((candidate) =>
      text.toLowerCase().includes(candidate.match),
    );
    if (!rule?.setting || rule.setting === "concurrentServices") continue;

    const value = Number(cell(row, 3));
    if (!Number.isFinite(value) || cell(row, 3) === "") continue;

    overrides[rule.setting] = value;
    if (rule.setting === "maxMinutesPerDay") {
      overrides.maxMinutesPerWeek = value * SCHOOL_DAYS;
    }
  }

  return overrides;
}

/** Defaults, then the provider's derived capacity, then the sheet's overrides. */
export function resolveRuleSettings(
  input: SchedulerInput,
  providerName: string,
): RuleSettings {
  const provider = input.staff.find((member) => member.name === providerName);
  return {
    ...DEFAULT_RULE_SETTINGS,
    ...deriveCapacity(provider),
    ...input.ruleOverrides,
  };
}
