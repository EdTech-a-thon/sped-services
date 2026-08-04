import { isCompatible } from "./explain";
import { normalizeKey } from "./parse";
import {
  buildWeekWindows,
  intersectWindows,
  type WindowContext,
} from "./windows";
import type {
  Candidate,
  Group,
  RuleSettings,
  ServiceRequirement,
  Window,
} from "./types";

export type { Candidate };

function partitionKey(requirement: ServiceRequirement): string {
  // Reading MTSS is prescribed as both Small Group and Whole Group, so the
  // group type has to be part of the key or the two would merge.
  return `${normalizeKey(requirement.service)}|${requirement.model}|${requirement.groupType}`;
}

function totalMinutes(windows: Window[]): number {
  return windows.reduce((sum, window) => sum + (window.end - window.start), 0);
}

function distinctDays(windows: Window[]): number {
  return new Set(windows.map((window) => window.day)).size;
}

/**
 * How good a fit is this candidate for this group? Higher is better. Shared
 * time is what makes a group real, so it dominates; same-classroom (rule 5) and
 * closeness in session length only break ties.
 */
function score(group: Candidate[], candidate: Candidate): number {
  const shared = intersectWindows([
    ...group.map((member) => member.windows),
    candidate.windows,
  ]);
  if (!shared.length) return -1;

  const sameRoom = group.filter(
    (member) => member.student.classKey === candidate.student.classKey,
  ).length;
  const lengthGap = Math.max(
    ...group.map((member) =>
      Math.abs(
        member.requirement.sessionLength - candidate.requirement.sessionLength,
      ),
    ),
  );

  return (
    distinctDays(shared) * 1000 +
    totalMinutes(shared) +
    sameRoom * 50 -
    lengthGap * 5
  );
}

/**
 * An extra admission test, for callers with rules the shared checks do not
 * cover. Team planning uses it for the co-teach classroom and the parapro group
 * cap; `/plan` passes nothing and behaves exactly as before.
 */
export type ExtraCheck = (
  group: Candidate[],
  candidate: Candidate,
  settings: RuleSettings,
) => boolean;

/**
 * Build the groups for one provider.
 *
 * Grouping and time-finding cannot be separated: two students can match on
 * service, grade and session length and still never share a free minute. So
 * candidates are only admitted to a group when the group's shared window
 * survives, and the best-scoring home wins.
 */
export function buildGroups(
  requirements: ServiceRequirement[],
  context: WindowContext,
  settings: RuleSettings,
  extraChecks: ExtraCheck[] = [],
): { groups: Group[]; unschedulable: Candidate[] } {
  const candidates: Candidate[] = [];
  const unschedulable: Candidate[] = [];

  for (const requirement of requirements) {
    const student = context.studentsByKey.get(
      normalizeKey(requirement.student),
    );
    if (!student) continue;
    const { windows, reason } = buildWeekWindows(requirement, context);
    const candidate = { requirement, student, windows, reason };
    if (windows.length) candidates.push(candidate);
    else unschedulable.push(candidate);
  }

  const partitions = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = partitionKey(candidate.requirement);
    const list = partitions.get(key);
    if (list) list.push(candidate);
    else partitions.set(key, [candidate]);
  }

  const groups: Group[] = [];

  for (const [key, members] of partitions) {
    // Hardest to place first: fewest options, then longest session.
    const ordered = [...members].sort(
      (a, b) =>
        distinctDays(a.windows) - distinctDays(b.windows) ||
        b.requirement.sessionLength - a.requirement.sessionLength ||
        (a.student.grade ?? 0) - (b.student.grade ?? 0),
    );

    const built: Candidate[][] = [];
    for (const candidate of ordered) {
      let best: { group: Candidate[]; score: number } | null = null;
      for (const group of built) {
        if (!isCompatible(group, candidate, settings)) continue;
        if (!extraChecks.every((check) => check(group, candidate, settings))) {
          continue;
        }
        const value = score(group, candidate);
        if (value < 0) continue;
        if (!best || value > best.score) best = { group, score: value };
      }
      if (best) best.group.push(candidate);
      else built.push([candidate]);
    }

    built.forEach((group, index) => {
      const first = group[0].requirement;
      groups.push({
        id: `${key}#${index + 1}`,
        service: first.service,
        model: first.model,
        groupType: first.groupType,
        members: group.map((member) => member.student.name),
        // The group meets for the longest session anyone in it needs; shorter
        // prescriptions are credited only their own minutes.
        sessionLength: Math.max(
          ...group.map((member) => member.requirement.sessionLength),
        ),
        sessionsPerWeek: Math.max(
          ...group.map((member) => member.requirement.sessionsPerWeek),
        ),
        sharedWindows: intersectWindows(group.map((member) => member.windows)),
      });
    });
  }

  return { groups, unschedulable };
}
