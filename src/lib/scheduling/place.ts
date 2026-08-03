import { normalizeKey } from "./parse";
import type { WindowContext } from "./windows";
import {
  DAYS,
  emptyClassSchedule,
  type Day,
  type Group,
  type Placement,
  type RuleSettings,
  type UnplacedReason,
  type Window,
} from "./types";

/** How finely a session may be nudged inside its window. */
const STEP_MINUTES = 5;

interface Busy {
  start: number;
  end: number;
  /** Where the provider is: a class key for push-in, "sped" for pull-out. */
  location: string;
}

export interface PlacementResult {
  placements: Placement[];
  /** Why sessions were dropped, keyed by group id. */
  failures: Map<string, Partial<Record<UnplacedReason, number>>>;
}

function overlaps(a: Busy, start: number, end: number): boolean {
  return a.start < end && a.end > start;
}

/**
 * Rule 10: pull-out needs transition time either side, because students walk to
 * the SPED room and back. Rule 9 exempts push-in that stays in the same
 * classroom — nobody moves, so no gap is needed.
 */
function clashes(
  busy: Busy[],
  start: number,
  end: number,
  location: string,
  transition: number,
): boolean {
  return busy.some((entry) => {
    const sameRoom = entry.location === location && location !== "sped";
    const gap = sameRoom ? 0 : transition;
    return overlaps(entry, start - gap, end + gap);
  });
}

function record(
  failures: Map<string, Partial<Record<UnplacedReason, number>>>,
  groupId: string,
  reason: UnplacedReason,
) {
  const counts = failures.get(groupId) ?? {};
  counts[reason] = (counts[reason] ?? 0) + 1;
  failures.set(groupId, counts);
}

/** The classroom subject a placement displaces, read off the first member. */
function subjectAt(
  group: Group,
  day: Day,
  start: number,
  end: number,
  context: WindowContext,
): string {
  const student = context.studentsByKey.get(normalizeKey(group.members[0]));
  if (!student) return "";
  const schedule = context.classes[student.classKey] ?? emptyClassSchedule();
  const names = schedule[day]
    .filter((block) => block.start < end && block.end > start)
    .map((block) => block.subject);
  return [...new Set(names)].join(" / ");
}

/**
 * Place every group's sessions.
 *
 * Greedy and most-constrained-first, following the ranking the Rules sheet
 * spells out in row 14: spread across days first, then transition time, then
 * service needs, grade, session length and group size. Nothing here reduces a
 * student's prescribed minutes — a session that will not fit is dropped and
 * reported.
 */
export function placeGroups(
  groups: Group[],
  context: WindowContext,
  settings: RuleSettings,
): PlacementResult {
  const placements: Placement[] = [];
  const failures = new Map<string, Partial<Record<UnplacedReason, number>>>();

  const providerBusy = new Map<Day, Busy[]>();
  const studentBusy = new Map<string, Busy[]>();
  const providerMinutes = new Map<Day, number>();
  for (const day of DAYS) {
    providerBusy.set(day, []);
    providerMinutes.set(day, 0);
  }

  // Outside providers already own part of each student's week.
  for (const [key, sessions] of context.bookings) {
    studentBusy.set(
      key,
      sessions.map((session) => ({
        start: session.start,
        end: session.end,
        location: "outside",
      })),
    );
  }

  const studentKey = (name: string, day: Day) => `${normalizeKey(name)}|${day}`;

  const ordered = [...groups].sort(
    (a, b) =>
      new Set(a.sharedWindows.map((w) => w.day)).size -
        new Set(b.sharedWindows.map((w) => w.day)).size ||
      b.sessionsPerWeek - a.sessionsPerWeek ||
      b.sessionLength - a.sessionLength,
  );

  let weekMinutes = 0;

  // Round-robin rather than filling each group before starting the next. The
  // eligible windows are heavily contested — every Writing pull-out in the
  // school competes for one Science/Social Studies block a day — so taking
  // turns is what stops the longest groups from starving every other one, and
  // it is what gives rule 13 (see every student weekly) a chance.
  const state = ordered.map((group) => ({
    group,
    location:
      group.model === "Push-In" ? groupLocation(group, context) : "sped",
    usedDays: new Set<Day>(),
    placed: 0,
    exhausted: false,
  }));
  const rounds = Math.max(0, ...ordered.map((group) => group.sessionsPerWeek));

  for (let round = 0; round < rounds; round++) {
    for (const entry of state) {
      const { group, location, usedDays } = entry;
      if (entry.exhausted || entry.placed >= group.sessionsPerWeek) continue;

      let best: { window: Window; start: number; score: number } | null = null;

      for (const window of group.sharedWindows) {
        const latest = window.end - group.sessionLength;
        for (let start = window.start; start <= latest; start += STEP_MINUTES) {
          const end = start + group.sessionLength;

          if (weekMinutes + group.sessionLength > settings.maxMinutesPerWeek) {
            record(failures, group.id, "Provider minute cap reached");
            continue;
          }
          const dayMinutes = providerMinutes.get(window.day) ?? 0;
          if (dayMinutes + group.sessionLength > settings.maxMinutesPerDay) {
            record(failures, group.id, "Provider minute cap reached");
            continue;
          }
          if (
            clashes(
              providerBusy.get(window.day) ?? [],
              start,
              end,
              location,
              settings.pullOutTransitionMinutes,
            )
          ) {
            record(failures, group.id, "Provider already busy");
            continue;
          }

          const memberClash = group.members.some((member) =>
            (studentBusy.get(studentKey(member, window.day)) ?? []).some(
              (busy) => overlaps(busy, start, end),
            ),
          );
          if (memberClash) {
            record(
              failures,
              group.id,
              "Student already receiving another service",
            );
            continue;
          }

          // Rule 2: spread a group's sessions across the week. Soft, because a
          // group needing more sessions than there are days cannot obey it.
          const score =
            (usedDays.has(window.day) ? 0 : 10_000) -
            DAYS.indexOf(window.day) * 10 -
            start / 100;
          if (!best || score > best.score) {
            best = { window, start, score };
          }
        }
      }

      // The week only ever gets fuller, so a group that cannot fit now will not
      // fit in a later round either.
      if (!best) {
        entry.exhausted = true;
        continue;
      }

      const end = best.start + group.sessionLength;
      placements.push({
        groupId: group.id,
        service: group.service,
        model: group.model,
        members: group.members,
        day: best.window.day,
        start: best.start,
        end,
        subject: subjectAt(group, best.window.day, best.start, end, context),
      });

      entry.placed += 1;
      usedDays.add(best.window.day);
      providerBusy
        .get(best.window.day)
        ?.push({ start: best.start, end, location });
      providerMinutes.set(
        best.window.day,
        (providerMinutes.get(best.window.day) ?? 0) + group.sessionLength,
      );
      weekMinutes += group.sessionLength;

      for (const member of group.members) {
        const key = studentKey(member, best.window.day);
        const list = studentBusy.get(key) ?? [];
        list.push({ start: best.start, end, location });
        studentBusy.set(key, list);
      }
    }
  }

  return { placements, failures };
}

/** Push-in happens in the members' own room, which is only stable if they share one. */
function groupLocation(group: Group, context: WindowContext): string {
  const keys = new Set(
    group.members
      .map(
        (member) => context.studentsByKey.get(normalizeKey(member))?.classKey,
      )
      .filter(Boolean) as string[],
  );
  return keys.size === 1 ? [...keys][0] : "sped";
}
