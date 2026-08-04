import { placeParaproCoverage, placeSlcCoverage } from "./coverage";
import { buildGroups, type Candidate, type ExtraCheck } from "./group";
import { normalizeKey } from "./parse";
import { buildEligibility } from "./permissions";
import { deriveCapacity } from "./rules";
import {
  placeTeam,
  soleProviderWindows,
  type TeamPlacement,
} from "./teamPlace";
import {
  isParapro,
  isSlcTeacher,
  resolveTeamSettings,
  schedulableStaff,
  TEAM_RULES,
  type TeamRule,
  type TeamSettings,
} from "./teamRules";
import { buildWindowContext, intersectWindows } from "./windows";
import {
  DAYS,
  type ComplianceRow,
  type CoverageGap,
  type Day,
  type Group,
  type SchedulerInput,
  type ServiceRequirement,
  type StaffEvent,
  type StaffMember,
  type Unplaced,
  type UnplacedReason,
} from "./types";

/** A rule plus whatever the workbook's own Rules sheet said about it. */
export interface ResolvedTeamRule extends TeamRule {
  /** True when this workbook's Rules sheet actually carries the rule. */
  onSheet: boolean;
}

export interface StaffLoad {
  staff: StaffMember;
  /** Minutes rows this person leads. */
  leadRequirements: number;
  sessions: number;
  scheduledMinutes: number;
  availableMinutes: number;
  lunch: StaffEvent[];
  breaks: StaffEvent[];
}

export interface RuleViolation {
  ruleId: string;
  summary: string;
  detail: string;
}

/** A prescription whose named lead provider never met the student. */
export interface LeadGap {
  student: string;
  service: string;
  leadProvider: string;
}

export interface TeamPlanResult {
  settings: TeamSettings;
  staff: StaffMember[];
  groups: Group[];
  placements: TeamPlacement[];
  coverage: StaffEvent[];
  coverageGaps: CoverageGap[];
  unplaced: Unplaced[];
  compliance: ComplianceRow[];
  load: StaffLoad[];
  violations: RuleViolation[];
  leadGaps: LeadGap[];
  rules: ResolvedTeamRule[];
  /** Rules-sheet rows this planner does not model, in the sheet's own words. */
  unmodelledRules: string[];
}

/* ---------- grouping ---------- */

/**
 * A push-in group meets in its students' own classroom, so it can only contain
 * students who share one. This is also what keeps co-taught services in the
 * designated co-teach room: those students are grouped by the room they are
 * already in.
 */
const sameClassroomForPushIn: ExtraCheck = (group, candidate) => {
  if (candidate.requirement.model !== "Push-In") return true;
  return group.every(
    (member) => member.student.classKey === candidate.student.classKey,
  );
};

/**
 * A group meets for its longest member's session, so the time everyone shares
 * has to be at least that long. Sharing *some* free minute is not enough: a
 * thirteen-student MTSS group whose only common gap is twenty minutes can never
 * meet for forty-five, and admitting it costs every one of those students their
 * whole prescription.
 */
const sharedTimeFitsSession: ExtraCheck = (group, candidate) => {
  const length = Math.max(
    candidate.requirement.sessionLength,
    ...group.map((member) => member.requirement.sessionLength),
  );
  return intersectWindows([
    ...group.map((member) => member.windows),
    candidate.windows,
  ]).some((window) => window.end - window.start >= length);
};

/* ---------- helpers ---------- */

function findGroup(
  groups: Group[],
  requirement: ServiceRequirement,
): Group | undefined {
  return groups.find(
    (group) =>
      normalizeKey(group.service) === normalizeKey(requirement.service) &&
      group.model === requirement.model &&
      group.groupType === requirement.groupType &&
      group.members.some(
        (member) => normalizeKey(member) === normalizeKey(requirement.student),
      ),
  );
}

function requiredMinutes(requirement: ServiceRequirement): number {
  return (
    requirement.minutesPerWeek ||
    requirement.sessionLength * requirement.sessionsPerWeek
  );
}

/* ---------- entry point ---------- */

/**
 * Build one week for the whole team.
 *
 * Unlike `buildPlan`, which answers "what does this provider's week look like",
 * this answers "can this staff actually deliver these minutes" — everybody is
 * placed against everybody else, lunches and breaks included, and the answer is
 * allowed to be no. Prescribed minutes are never reduced to make the week fit;
 * a shortfall is reported as a shortfall.
 */
export function buildTeamPlan(
  input: SchedulerInput,
  overrides?: Partial<TeamSettings>,
): TeamPlanResult {
  const resolved = resolveTeamSettings(input, overrides);
  const reading = resolved.reading;

  // "Allow mixed grades to pull-out groups when service minute needs align" —
  // the session-length span is that alignment test, so the grade span stops
  // being a grouping rule here. Push-in is held together by the classroom check
  // below instead, which is stricter than any grade span.
  const settings: TeamSettings = {
    ...resolved.settings,
    gradeDeltaGenEd: Number.MAX_SAFE_INTEGER,
    gradeDeltaSpecialEd: Number.MAX_SAFE_INTEGER,
  };

  const staff = schedulableStaff(input.staff);
  const eligibility = buildEligibility(input.serviceMatches);
  const context = buildWindowContext(input, eligibility);

  const requirements = input.requirements.filter((requirement) =>
    context.studentsByKey.has(normalizeKey(requirement.student)),
  );

  const { groups, unschedulable } = buildGroups(
    requirements,
    context,
    settings,
    [sameClassroomForPushIn, sharedTimeFitsSession],
  );

  // Parapro lunches and breaks are fixed before any session is placed: their
  // legal windows are narrow, and the SLC teacher's own cover depends on them.
  // Grouping first is what lets that choice see which windows a parapro is the
  // only person who could ever teach in.
  const paraCoverage = placeParaproCoverage(
    staff,
    context,
    settings,
    soleProviderWindows(groups, requirements),
  );

  const placement = placeTeam({
    groups,
    requirements,
    staff,
    coverage: paraCoverage.events,
    context,
    settings,
  });

  // The SLC teacher eats last, in whatever the week left free — which is the
  // rule, not an oversight: her lunch has to fall where the pull-out room is
  // empty and a parapro is free.
  const slc = staff.find(isSlcTeacher);
  const paraNames = staff.filter(isParapro).map((member) => member.name);
  const slcCoverage = slc
    ? placeSlcCoverage(
        {
          member: slc,
          slcBusy: placement.slcRoomBusy,
          paraBusy: new Map(
            paraNames.map((name) => [
              name,
              placement.staffBusy.get(normalizeKey(name)) ??
                new Map<Day, { start: number; end: number }[]>(),
            ]),
          ),
          paraNames,
        },
        context,
        settings,
      )
    : { events: [], gaps: [] };

  const coverage = [...paraCoverage.events, ...slcCoverage.events];
  const coverageGaps = [...paraCoverage.gaps, ...slcCoverage.gaps];

  /* ---------- reporting ---------- */

  const noWindowReason = new Map<string, UnplacedReason>(
    unschedulable.map((candidate: Candidate) => [
      `${normalizeKey(candidate.requirement.student)}|${normalizeKey(candidate.requirement.service)}`,
      candidate.reason ?? "No eligible subject in this class",
    ]),
  );

  const compliance: ComplianceRow[] = [];
  const unplaced: Unplaced[] = [];
  const leadGaps: LeadGap[] = [];

  for (const requirement of requirements) {
    const group = findGroup(groups, requirement);
    const sessions = group
      ? placement.placements.filter((entry) => entry.groupId === group.id)
      : [];

    // A group meets for its longest member's session; everyone else is only
    // credited the minutes they were actually prescribed.
    const credited = Math.min(sessions.length, requirement.sessionsPerWeek);
    const scheduledMinutes = credited * requirement.sessionLength;
    const required = requiredMinutes(requirement);

    compliance.push({
      student: requirement.student,
      service: requirement.service,
      requiredMinutes: required,
      scheduledMinutes,
      difference: scheduledMinutes - required,
      status:
        scheduledMinutes >= required
          ? "OK"
          : scheduledMinutes > 0
            ? "PARTIAL"
            : "MISSING",
    });

    if (
      requirement.leadProvider &&
      !sessions.some(
        (session) =>
          normalizeKey(session.staff) ===
          normalizeKey(requirement.leadProvider),
      )
    ) {
      leadGaps.push({
        student: requirement.student,
        service: requirement.service,
        leadProvider: requirement.leadProvider,
      });
    }

    const missingSessions = requirement.sessionsPerWeek - credited;
    if (missingSessions <= 0) continue;

    const key = `${normalizeKey(requirement.student)}|${normalizeKey(requirement.service)}`;
    const reason = noWindowReason.get(key);
    unplaced.push({
      student: requirement.student,
      service: requirement.service,
      model: requirement.model,
      missingSessions,
      missingMinutes: missingSessions * requirement.sessionLength,
      reasons: reason
        ? { [reason]: missingSessions }
        : ((group && placement.failures.get(group.id)) ?? {}),
    });
  }

  /* ---------- per-staff load ---------- */

  const load: StaffLoad[] = staff.map((member) => {
    const key = normalizeKey(member.name);
    const led = placement.placements.filter(
      (entry) => normalizeKey(entry.staff) === key,
    );
    const events = coverage.filter(
      (event) => normalizeKey(event.staff) === key,
    );
    return {
      staff: member,
      leadRequirements: requirements.filter(
        (requirement) => normalizeKey(requirement.leadProvider) === key,
      ).length,
      sessions: led.length,
      scheduledMinutes: led.reduce(
        (sum, entry) => sum + (entry.end - entry.start),
        0,
      ),
      availableMinutes: deriveCapacity(member).maxMinutesPerWeek,
      lunch: events.filter((event) => event.kind === "Lunch"),
      breaks: events.filter((event) => event.kind === "Break"),
    };
  });

  /* ---------- soft-rule violations ---------- */

  const violations: RuleViolation[] = [];
  const rule = (id: string) => TEAM_RULES.find((entry) => entry.id === id)!;

  for (const event of coverage) {
    for (const id of event.violates) {
      violations.push({
        ruleId: id,
        summary: rule(id).summary,
        detail: `${event.staff}'s ${event.kind.toLowerCase()} had to start outside the preferred window.`,
      });
    }
  }
  for (const gap of coverageGaps) {
    violations.push({
      ruleId: gap.kind === "Lunch" ? "slc-lunch-cover" : "para-break-window",
      summary: `${gap.staff} has no ${gap.kind.toLowerCase()} on ${gap.day}`,
      detail: gap.reason,
    });
  }
  for (const gap of leadGaps) {
    violations.push({
      ruleId: "lead-sees-weekly",
      summary: rule("lead-sees-weekly").summary,
      detail: `${gap.leadProvider} never meets ${gap.student} for ${gap.service}.`,
    });
  }

  // Deduplicated: the same sentence twice tells a teacher nothing.
  const seenViolations = new Set<string>();
  const uniqueViolations = violations.filter((entry) => {
    const key = `${entry.ruleId}|${entry.detail}`;
    if (seenViolations.has(key)) return false;
    seenViolations.add(key);
    return true;
  });

  /* ---------- the rule list ---------- */

  const onSheet = new Set(Object.keys(reading.hardness));
  const rules: ResolvedTeamRule[] = TEAM_RULES.map((entry) => ({
    ...entry,
    hardness: reading.hardness[entry.id] ?? entry.hardness,
    onSheet: onSheet.has(entry.id),
  }));

  return {
    settings,
    staff,
    groups,
    placements: placement.placements,
    coverage,
    coverageGaps,
    unplaced,
    compliance,
    load,
    violations: uniqueViolations,
    leadGaps,
    rules,
    unmodelledRules: reading.unmodelled,
  };
}

/** Every placement and lunch/break for one day, for the calendar. */
export function dayEvents(
  plan: TeamPlanResult,
  day: Day,
): { sessions: TeamPlacement[]; coverage: StaffEvent[] } {
  return {
    sessions: plan.placements.filter((entry) => entry.day === day),
    coverage: plan.coverage.filter((event) => event.day === day),
  };
}

export { DAYS };
