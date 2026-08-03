import { buildGroups, type Candidate } from "./group";
import { normalizeKey } from "./parse";
import { buildEligibility } from "./permissions";
import { placeGroups } from "./place";
import { resolveRuleSettings } from "./rules";
import { buildWindowContext } from "./windows";
import type {
  ComplianceRow,
  Group,
  Placement,
  PlanResult,
  RuleSettings,
  SchedulerInput,
  ServiceRequirement,
  Unplaced,
  UnplacedReason,
} from "./types";

/** Every provider named anywhere in the Minutes sheet, in first-seen order. */
export function providerNames(input: SchedulerInput): string[] {
  const seen = new Map<string, string>();
  for (const requirement of input.requirements) {
    for (const provider of requirement.providers) {
      const key = normalizeKey(provider);
      if (!seen.has(key)) seen.set(key, provider);
    }
  }
  return [...seen.values()];
}

/**
 * Whoever carries the most prescriptions — the lead provider in practice, and
 * the sensible provider to open the planner on.
 */
export function leadProvider(input: SchedulerInput): string {
  const counts = new Map<string, number>();
  for (const requirement of input.requirements) {
    for (const provider of requirement.providers) {
      counts.set(provider, (counts.get(provider) ?? 0) + 1);
    }
  }
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return busiest ?? providerNames(input)[0] ?? "";
}

function servesProvider(
  requirement: ServiceRequirement,
  provider: string,
): boolean {
  const key = normalizeKey(provider);
  return requirement.providers.some((name) => normalizeKey(name) === key);
}

/** The group a student's requirement ended up in, if any. */
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

function sessionsFor(
  placements: Placement[],
  group: Group | undefined,
): Placement[] {
  if (!group) return [];
  return placements.filter((placement) => placement.groupId === group.id);
}

/**
 * Build a week for one provider: form the groups, place their sessions, then
 * report what did not fit. Prescribed minutes are never reduced to make the
 * schedule work — a shortfall is reported as a shortfall.
 */
export function buildPlan(
  input: SchedulerInput,
  provider: string,
  overrides?: Partial<RuleSettings>,
): PlanResult {
  const settings = { ...resolveRuleSettings(input, provider), ...overrides };
  const eligibility = buildEligibility(input.serviceMatches);
  const context = buildWindowContext(input, eligibility);

  const requirements = input.requirements.filter(
    (requirement) =>
      servesProvider(requirement, provider) &&
      context.studentsByKey.has(normalizeKey(requirement.student)),
  );

  const { groups, unschedulable } = buildGroups(
    requirements,
    context,
    settings,
  );
  const { placements, failures } = placeGroups(groups, context, settings);

  const noWindowReason = new Map<string, UnplacedReason>(
    unschedulable.map((candidate: Candidate) => [
      `${normalizeKey(candidate.requirement.student)}|${normalizeKey(candidate.requirement.service)}`,
      candidate.reason ?? "No eligible subject in this class",
    ]),
  );

  const compliance: ComplianceRow[] = [];
  const unplaced: Unplaced[] = [];

  for (const requirement of requirements) {
    const group = findGroup(groups, requirement);
    const sessions = sessionsFor(placements, group);
    // A group meets for its longest member's session; everyone else is only
    // credited the minutes they were actually prescribed.
    const credited = Math.min(sessions.length, requirement.sessionsPerWeek);
    const scheduledMinutes = credited * requirement.sessionLength;

    const requiredMinutes =
      requirement.minutesPerWeek ||
      requirement.sessionLength * requirement.sessionsPerWeek;
    const difference = scheduledMinutes - requiredMinutes;

    compliance.push({
      student: requirement.student,
      service: requirement.service,
      requiredMinutes,
      scheduledMinutes,
      difference,
      status:
        scheduledMinutes >= requiredMinutes
          ? "OK"
          : scheduledMinutes > 0
            ? "PARTIAL"
            : "MISSING",
    });

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
        : ((group && failures.get(group.id)) ?? {}),
    });
  }

  const seen = new Set(
    placements.flatMap((placement) =>
      placement.members.map((member) => normalizeKey(member)),
    ),
  );
  const unseenStudents = [
    ...new Set(requirements.map((requirement) => requirement.student)),
  ].filter((student) => !seen.has(normalizeKey(student)));

  return {
    provider,
    settings,
    groups,
    placements,
    unplaced,
    compliance,
    unseenStudents,
    capacity: {
      provider,
      requirementCount: requirements.length,
      studentMinutesPerWeek: requirements.reduce(
        (sum, requirement) =>
          sum +
          (requirement.minutesPerWeek ||
            requirement.sessionLength * requirement.sessionsPerWeek),
        0,
      ),
      studentSessionsPerWeek: requirements.reduce(
        (sum, requirement) => sum + requirement.sessionsPerWeek,
        0,
      ),
      groupedMinutesPerWeek: groups.reduce(
        (sum, group) => sum + group.sessionLength * group.sessionsPerWeek,
        0,
      ),
      availableMinutesPerWeek: settings.maxMinutesPerWeek,
      scheduledMinutesPerWeek: placements.reduce(
        (sum, placement) => sum + (placement.end - placement.start),
        0,
      ),
    },
  };
}
