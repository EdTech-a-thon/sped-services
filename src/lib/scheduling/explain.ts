/**
 * Why the planner grouped who it grouped.
 *
 * `group.ts` used to answer "may these students share a group?" with a boolean,
 * which is all the search needs but tells a teacher nothing. Here the same
 * question returns one entry per rule, so the UI can say *which* rule blocked a
 * pairing and which knob would unblock it. `group.ts` derives its boolean from
 * this list, so the explanation can never drift from the behaviour.
 */

import { normalizeKey } from "./parse";
import { buildEligibility } from "./permissions";
import {
  buildWeekWindows,
  buildWindowContext,
  intersectWindows,
} from "./windows";
import type {
  Candidate,
  RuleSettings,
  SchedulerInput,
  ServiceRequirement,
  Window,
} from "./types";

export type CheckStatus =
  /** The rule is satisfied. */
  | "pass"
  /** The rule is broken; this pairing is not allowed. */
  | "fail"
  /** A soft preference that is not met. Never blocks. */
  | "warn"
  /** The rule does not apply here — e.g. a whole-group service. */
  | "n/a";

/** One rule's verdict on adding a candidate to a group. */
export interface RuleCheck {
  /** Rules-sheet row, matching `SPEECH_RULES[].row`, so the UI can cross-link. */
  rule: number | null;
  /** The `RuleSettings` knob that would change this outcome, if any. */
  setting: keyof RuleSettings | null;
  label: string;
  detail: string;
  status: CheckStatus;
}

/** A stable identity for one row of the Minutes sheet. */
export function requirementKey(requirement: ServiceRequirement): string {
  return [
    normalizeKey(requirement.student),
    normalizeKey(requirement.service),
    requirement.model,
    requirement.groupType,
  ].join("|");
}

export function candidateKey(candidate: Candidate): string {
  return requirementKey(candidate.requirement);
}

function grades(members: Candidate[]): number[] {
  return members
    .map((member) => member.student.grade)
    .filter((grade): grade is number => grade != null);
}

/** 0 -> "K", 3 -> "grade 3". */
export function gradeName(grade: number | null): string {
  if (grade == null) return "no grade";
  return grade === 0 ? "K" : `grade ${grade}`;
}

function names(members: Candidate[]): string {
  return members.map((member) => member.student.name).join(", ");
}

/**
 * Every rule that governs adding `candidate` to `group`, with its verdict.
 *
 * `group` is the students already in the group; an empty group means every
 * check that compares against existing members trivially passes.
 */
export function checkCompatibility(
  group: Candidate[],
  candidate: Candidate,
  settings: RuleSettings,
): RuleCheck[] {
  const checks: RuleCheck[] = [];
  const first = group[0];

  // --- The partition: service, model and group type are never mixed. --------
  if (first) {
    const sameService =
      normalizeKey(first.requirement.service) ===
      normalizeKey(candidate.requirement.service);
    checks.push({
      rule: null,
      setting: null,
      label: "Same service",
      detail: sameService
        ? `Both prescribed ${candidate.requirement.service}`
        : `${first.requirement.service} and ${candidate.requirement.service} are different services`,
      status: sameService ? "pass" : "fail",
    });

    const sameModel = first.requirement.model === candidate.requirement.model;
    checks.push({
      rule: 9,
      setting: null,
      label: "Same delivery model",
      detail: sameModel
        ? `Both ${candidate.requirement.model}`
        : `${first.requirement.model} and ${candidate.requirement.model} cannot share a session`,
      status: sameModel ? "pass" : "fail",
    });

    const sameType =
      first.requirement.groupType === candidate.requirement.groupType;
    checks.push({
      rule: null,
      setting: null,
      label: "Same group type",
      detail: sameType
        ? `Both ${candidate.requirement.groupType}`
        : `${first.requirement.groupType} and ${candidate.requirement.groupType} are scheduled separately`,
      status: sameType ? "pass" : "fail",
    });

    // A group needs one provider who may deliver to everyone in it.
    const shared = candidate.requirement.providers.filter((provider) =>
      group.every((member) =>
        member.requirement.providers.some(
          (other) => normalizeKey(other) === normalizeKey(provider),
        ),
      ),
    );
    checks.push({
      rule: null,
      setting: null,
      label: "Shared provider",
      detail: shared.length
        ? `${shared.join(", ")} may deliver to everyone`
        : `No provider serves both ${names(group)} and ${candidate.student.name}`,
      status: shared.length ? "pass" : "fail",
    });
  }

  // --- Whole group deliberately bypasses the small-group limits. -----------
  // Rule 7's "max of four" is about small groups; an MTSS block is the whole
  // caseload at once, so size, grade span and session length do not apply.
  if (candidate.requirement.groupType === "Whole Group") {
    const why = "Whole Group — the small-group limits do not apply";
    checks.push(
      {
        rule: 7,
        setting: "maxGroupSize",
        label: "Group size",
        detail: why,
        status: "n/a",
      },
      {
        rule: 11,
        setting: "sessionLengthDelta",
        label: "Session length span",
        detail: why,
        status: "n/a",
      },
      {
        rule: 3,
        setting: "gradeDeltaGenEd",
        label: "Grade span",
        detail: why,
        status: "n/a",
      },
    );
  } else {
    const size = group.length + 1;
    checks.push({
      rule: 7,
      setting: "maxGroupSize",
      label: "Group size",
      detail: `${size} student${size === 1 ? "" : "s"}, limit is ${settings.maxGroupSize}${
        size > settings.preferredGroupSize && size <= settings.maxGroupSize
          ? ` (${settings.preferredGroupSize} preferred)`
          : ""
      }`,
      status:
        group.length >= settings.maxGroupSize
          ? "fail"
          : size > settings.preferredGroupSize
            ? "warn"
            : "pass",
    });

    const lengths = [...group, candidate].map(
      (member) => member.requirement.sessionLength,
    );
    const lengthSpan = Math.max(...lengths) - Math.min(...lengths);
    checks.push({
      rule: 11,
      setting: "sessionLengthDelta",
      label: "Session length span",
      detail: `${Math.min(...lengths)}-${Math.max(...lengths)} min — ${lengthSpan} apart, limit is ${settings.sessionLengthDelta}`,
      status: lengthSpan > settings.sessionLengthDelta ? "fail" : "pass",
    });

    const spread = grades([...group, candidate]);
    const gradeSpan = spread.length
      ? Math.max(...spread) - Math.min(...spread)
      : 0;
    checks.push({
      rule: 3,
      setting: "gradeDeltaGenEd",
      label: "Grade span",
      detail: spread.length
        ? `${gradeName(Math.min(...spread))} to ${gradeName(Math.max(...spread))} — ${gradeSpan} apart, limit is ${settings.gradeDeltaGenEd}`
        : "No grades on the Students sheet to compare",
      status:
        spread.length && gradeSpan > settings.gradeDeltaGenEd ? "fail" : "pass",
    });
  }

  // --- Shared free time is what makes a group real. -----------------------
  const shared = intersectWindows([
    ...group.map((member) => member.windows),
    candidate.windows,
  ]);
  const days = new Set(shared.map((window) => window.day)).size;
  checks.push({
    rule: null,
    setting: null,
    label: "Shared free time",
    detail: shared.length
      ? `${shared.length} window${shared.length === 1 ? "" : "s"} across ${days} day${days === 1 ? "" : "s"}`
      : group.length
        ? "No time everyone here is free at once"
        : "This prescription has no legal time at all",
    status: shared.length ? "pass" : "fail",
  });

  // --- Soft preference: rule 5 nudges, it never blocks. -------------------
  if (first) {
    const together = group.filter(
      (member) => member.student.classKey === candidate.student.classKey,
    );
    checks.push({
      rule: 5,
      setting: null,
      label: "Same classroom",
      detail: together.length
        ? `Shares ${candidate.student.className} with ${names(together)}`
        : `${candidate.student.name} is in ${candidate.student.className}; preferred but not required`,
      status: together.length ? "pass" : "warn",
    });
  }

  return checks;
}

/** The planner's own question, answered from the same checks the UI shows. */
export function isCompatible(
  group: Candidate[],
  candidate: Candidate,
  settings: RuleSettings,
): boolean {
  return checkCompatibility(group, candidate, settings).every(
    (check) => check.status !== "fail",
  );
}

/**
 * Every requirement in the workbook with its legal times worked out — the same
 * `buildWeekWindows` call the planner makes, so the explorer and the plan are
 * looking at identical windows.
 *
 * Unlike `buildPlan` this is not filtered to one provider: a student who cannot
 * join because nobody serves both of them should appear with that as the stated
 * reason rather than silently vanishing from the list.
 */
export function buildCandidatePool(input: SchedulerInput): Candidate[] {
  const context = buildWindowContext(
    input,
    buildEligibility(input.serviceMatches),
  );
  const pool: Candidate[] = [];

  for (const requirement of input.requirements) {
    const student = context.studentsByKey.get(
      normalizeKey(requirement.student),
    );
    if (!student) continue;
    const { windows, reason } = buildWeekWindows(requirement, context);
    pool.push({ requirement, student, windows, reason });
  }

  return pool;
}

export interface PartnerCandidate {
  candidate: Candidate;
  checks: RuleCheck[];
  /** True when nothing failed — this student may join the current selection. */
  eligible: boolean;
  /** Labels of the failing checks, for the one-line summary. */
  blockedBy: string[];
  /** The failing checks themselves, so the UI can offer the knob to change. */
  blockers: RuleCheck[];
  /** What the group's shared time would become if this student joined. */
  sharedWindows: Window[];
}

/**
 * Everyone who could conceivably share `focus`'s group, judged against the
 * focus plus whoever is already selected.
 *
 * The pool is narrowed to the same service only — a different service is not a
 * near miss worth explaining, it is a different group entirely. Everything
 * finer than that (model, group type, provider, grade, length, free time) is
 * reported as a check so the reason is visible.
 */
export function findPartners(
  focus: Candidate,
  selected: Candidate[],
  pool: Candidate[],
  settings: RuleSettings,
): PartnerCandidate[] {
  const focusKey = candidateKey(focus);
  const selectedKeys = new Set(selected.map(candidateKey));
  const service = normalizeKey(focus.requirement.service);

  const partners = pool
    .filter(
      (candidate) =>
        candidateKey(candidate) !== focusKey &&
        normalizeKey(candidate.requirement.service) === service,
    )
    .map((candidate) => {
      // An already-selected student is judged against the rest of the group,
      // not against themselves, or they would always fail on group size.
      const group = [
        focus,
        ...selected.filter(
          (member) => candidateKey(member) !== candidateKey(candidate),
        ),
      ];
      const checks = checkCompatibility(group, candidate, settings);
      const blockers = checks.filter((check) => check.status === "fail");
      return {
        candidate,
        checks,
        eligible: blockers.length === 0,
        blockedBy: blockers.map((check) => check.label),
        blockers,
        sharedWindows: intersectWindows([
          ...group.map((member) => member.windows),
          candidate.windows,
        ]),
      };
    });

  // Selected first so the group stays visible, then whoever can still join,
  // then the near misses — fewest broken rules first, since those are the ones
  // a single knob might unlock.
  return partners.sort((a, b) => {
    const selectedA = selectedKeys.has(candidateKey(a.candidate)) ? 0 : 1;
    const selectedB = selectedKeys.has(candidateKey(b.candidate)) ? 0 : 1;
    return (
      selectedA - selectedB ||
      a.blockers.length - b.blockers.length ||
      a.candidate.student.name.localeCompare(b.candidate.student.name)
    );
  });
}

export interface GroupPreview {
  members: Candidate[];
  /** The group meets for the longest session anyone needs, as `buildGroups` does. */
  sessionLength: number;
  /** The most sessions any member needs. */
  sessionsPerWeek: number;
  /** The focus student's own legal times, before the others narrow them. */
  ownWindows: Window[];
  /** Times every member is free, long enough to actually hold the session. */
  sharedWindows: Window[];
  /** Shared times too short for the session — visible, but unusable. */
  tooShort: Window[];
  /** Distinct days the group could meet; rule 2 wants one session per day. */
  distinctDays: number;
}

/** What the calendar draws: the focus student's week, narrowed by the selection. */
export function previewGroup(
  focus: Candidate,
  selected: Candidate[],
): GroupPreview {
  const members = [focus, ...selected];
  const sessionLength = Math.max(
    ...members.map((member) => member.requirement.sessionLength),
  );
  const shared = intersectWindows(members.map((member) => member.windows));
  const fits = shared.filter(
    (window) => window.end - window.start >= sessionLength,
  );

  return {
    members,
    sessionLength,
    sessionsPerWeek: Math.max(
      ...members.map((member) => member.requirement.sessionsPerWeek),
    ),
    ownWindows: focus.windows,
    sharedWindows: fits,
    tooShort: shared.filter(
      (window) => window.end - window.start < sessionLength,
    ),
    distinctDays: new Set(fits.map((window) => window.day)).size,
  };
}
