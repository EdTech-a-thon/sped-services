import { normalizeKey } from "./parse";
import {
  buildDefinitionIndex,
  canServe,
  type EligibilityIndex,
} from "./permissions";
import {
  DAYS,
  emptyClassSchedule,
  type ClassBlock,
  type Day,
  type SchedulerInput,
  type ServiceRequirement,
  type ServiceSession,
  type Student,
  type UnplacedReason,
  type Window,
} from "./types";

/**
 * Everything the window search needs, built once per plan rather than per
 * requirement — the search runs for every requirement on every day.
 */
export interface WindowContext {
  eligibility: EligibilityIndex;
  definitions: ReturnType<typeof buildDefinitionIndex>;
  studentsByKey: Map<string, Student>;
  /** Outside bookings (OT/PT/Resource), keyed by "studentKey|day". */
  bookings: Map<string, ServiceSession[]>;
  classes: SchedulerInput["classes"];
}

export function buildWindowContext(
  input: SchedulerInput,
  eligibility: EligibilityIndex,
): WindowContext {
  const bookings = new Map<string, ServiceSession[]>();
  for (const session of input.services) {
    const key = `${normalizeKey(session.student)}|${session.day}`;
    const list = bookings.get(key);
    if (list) list.push(session);
    else bookings.set(key, [session]);
  }

  return {
    eligibility,
    definitions: buildDefinitionIndex(input.serviceDefinitions),
    studentsByKey: new Map(
      input.students.map((student) => [normalizeKey(student.name), student]),
    ),
    bookings,
    classes: input.classes,
  };
}

/** Merge blocks that run back to back into the longest usable stretches. */
function mergeAdjacent(blocks: ClassBlock[]): Window[] {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  const merged: Window[] = [];

  for (const block of sorted) {
    const last = merged[merged.length - 1];
    if (last && block.start <= last.end) {
      last.end = Math.max(last.end, block.end);
      if (!last.subjects.includes(block.subject)) {
        last.subjects.push(block.subject);
      }
      continue;
    }
    merged.push({
      day: block.day,
      start: block.start,
      end: block.end,
      subjects: [block.subject],
    });
  }

  return merged;
}

/** Remove the times a student is already committed elsewhere. */
function subtract(windows: Window[], busy: { start: number; end: number }[]) {
  let remaining = windows;

  for (const block of busy) {
    const next: Window[] = [];
    for (const window of remaining) {
      if (block.end <= window.start || block.start >= window.end) {
        next.push(window);
        continue;
      }
      if (block.start > window.start) {
        next.push({ ...window, end: block.start });
      }
      if (block.end < window.end) {
        next.push({ ...window, start: block.end });
      }
    }
    remaining = next;
  }

  return remaining;
}

export interface WindowSearch {
  windows: Window[];
  /** Set when the search came up empty, so the UI can say why. */
  reason: UnplacedReason | null;
}

/**
 * Every stretch of `day` this requirement could legally be delivered in.
 *
 * Transition time is deliberately not subtracted here. Rule 9 ("push-in has no
 * transition time within the same class") makes clear the transition is the
 * provider moving between locations, not the student losing minutes off each
 * end of a block, so `place.ts` enforces it as a gap between consecutive
 * sessions instead.
 */
export function buildWindows(
  requirement: ServiceRequirement,
  day: Day,
  context: WindowContext,
): WindowSearch {
  const student = context.studentsByKey.get(normalizeKey(requirement.student));
  if (!student) {
    return { windows: [], reason: "No eligible subject in this class" };
  }

  const schedule = context.classes[student.classKey] ?? emptyClassSchedule();
  const eligible = schedule[day].filter((block) =>
    canServe(block, requirement, context.eligibility, context.definitions),
  );
  if (!eligible.length) {
    return { windows: [], reason: "No eligible subject in this class" };
  }

  const merged = mergeAdjacent(eligible);
  const longest = Math.max(...merged.map((w) => w.end - w.start));
  if (longest < requirement.sessionLength) {
    return { windows: [], reason: "Session longer than any eligible block" };
  }

  const busy =
    context.bookings.get(`${normalizeKey(student.name)}|${day}`) ?? [];
  const free = subtract(merged, busy).filter(
    (window) => window.end - window.start >= requirement.sessionLength,
  );

  if (!free.length) {
    return {
      windows: [],
      reason: "Student already booked with another provider",
    };
  }
  return { windows: free, reason: null };
}

/** The same search across the whole week. */
export function buildWeekWindows(
  requirement: ServiceRequirement,
  context: WindowContext,
): WindowSearch {
  const windows: Window[] = [];
  const reasons = new Set<UnplacedReason>();

  for (const day of DAYS) {
    const search = buildWindows(requirement, day, context);
    windows.push(...search.windows);
    if (search.reason) reasons.add(search.reason);
  }

  if (windows.length) return { windows, reason: null };

  // Report the most specific explanation available: a session that fits nowhere
  // is a data problem, while a booking clash is just contention.
  const order: UnplacedReason[] = [
    "No eligible subject in this class",
    "Session longer than any eligible block",
    "Student already booked with another provider",
  ];
  const reason = order.find((candidate) => reasons.has(candidate)) ?? null;
  return { windows: [], reason };
}

/** The stretches every member of a group is simultaneously free. */
export function intersectWindows(sets: Window[][]): Window[] {
  if (!sets.length) return [];

  return sets.reduce((accumulated, current) => {
    const result: Window[] = [];
    for (const a of accumulated) {
      for (const b of current) {
        if (a.day !== b.day) continue;
        const start = Math.max(a.start, b.start);
        const end = Math.min(a.end, b.end);
        if (end <= start) continue;
        result.push({
          day: a.day,
          start,
          end,
          subjects: [...new Set([...a.subjects, ...b.subjects])],
        });
      }
    }
    return result;
  });
}
