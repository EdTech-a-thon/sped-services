import { normalizeKey } from "./parse";
import { isPullable } from "./permissions";
import { isParapro, type TeamSettings } from "./teamRules";
import type { WindowContext } from "./windows";
import {
  DAYS,
  type CoverageGap,
  type Day,
  type StaffEvent,
  type StaffMember,
  type Window,
} from "./types";

/** How finely a lunch or break may be nudged. */
const STEP_MINUTES = 5;

export interface CoverageResult {
  events: StaffEvent[];
  gaps: CoverageGap[];
}

export interface Span {
  start: number;
  end: number;
}

function overlaps(a: Span, start: number, end: number): boolean {
  return a.start < end && a.end > start;
}

/**
 * How much schedulable time a slot would eat: the classroom minutes inside it
 * that some service is allowed to displace, summed over every class.
 *
 * This is what steers lunch towards Recess, Specials and the class's own lunch —
 * blocks no service may touch, so a staff member sitting them out costs the
 * schedule nothing.
 */
function pullableLoad(
  day: Day,
  start: number,
  end: number,
  context: WindowContext,
): number {
  let total = 0;
  for (const schedule of Object.values(context.classes)) {
    for (const block of schedule[day]) {
      if (!isPullable(block, context.eligibility)) continue;
      const overlap = Math.min(block.end, end) - Math.max(block.start, start);
      if (overlap > 0) total += overlap;
    }
  }
  return total;
}

/** The same load across the whole week, for a slot repeated every day. */
function weeklyLoad(
  start: number,
  end: number,
  context: WindowContext,
): number {
  return DAYS.reduce(
    (sum, day) => sum + pullableLoad(day, start, end, context),
    0,
  );
}

/* ---------- parapros ---------- */

/**
 * Parapro lunches and breaks, placed once and repeated Monday to Friday.
 *
 * One time all week is both what the Staff sheet describes (rule 12: the same
 * availability every day) and what a person actually wants. The slot is chosen
 * to consume as little schedulable time as possible, and to avoid the times
 * colleagues have already taken — the SLC teacher's own lunch depends on some
 * parapro being free, so spreading them out is not just courtesy.
 */
export function placeParaproCoverage(
  staff: StaffMember[],
  context: WindowContext,
  settings: TeamSettings,
  /** Windows each person is the only possible provider for, keyed by staff key. */
  critical: Map<string, Window[]> = new Map(),
): CoverageResult {
  const events: StaffEvent[] = [];
  const gaps: CoverageGap[] = [];
  /** Times already claimed by a colleague, for the stagger penalty. */
  const taken: Span[] = [];

  for (const member of staff.filter(isParapro)) {
    const dayStart = member.startMinutes;
    const dayEnd = member.endMinutes;
    if (dayStart == null || dayEnd == null) continue;

    const mustTeach = critical.get(normalizeKey(member.name)) ?? [];

    /** This person's own claims, which lunch and break must not overlap. */
    const mine: Span[] = [];

    const kinds: { kind: "Lunch" | "Break"; minutes: number | null }[] = [
      { kind: "Lunch", minutes: member.lunchMinutes },
      { kind: "Break", minutes: member.breakMinutes },
    ];

    for (const { kind, minutes } of kinds) {
      if (!minutes) continue;

      // Rule 4 constrains the break to the middle of the day. Lunch may sit
      // anywhere in the shift; rule 5's 11:30-1:30 is a preference, scored below.
      const earliest =
        kind === "Break"
          ? dayStart + settings.paraBreakMinAfterStart
          : dayStart;
      const latest =
        kind === "Break" ? dayEnd - settings.paraBreakMinBeforeEnd : dayEnd;

      let best: { start: number; score: number; violates: string[] } | null =
        null;

      for (
        let start = earliest;
        start + minutes <= latest;
        start += STEP_MINUTES
      ) {
        const end = start + minutes;
        if (mine.some((span) => overlaps(span, start, end))) continue;

        const violates: string[] = [];
        const outsideWindow =
          kind === "Lunch" &&
          (start < settings.paraLunchStart || start > settings.paraLunchEnd);
        if (outsideWindow) violates.push("para-lunch-window");

        const clash = taken.filter((span) => overlaps(span, start, end)).length;
        // Eating through the only window one of your own groups could ever meet
        // in costs that group its entire week, so it outweighs everything else.
        const blocks = mustTeach.filter((window) =>
          overlaps(window, start, end),
        ).length;

        // Lower is better: sole-provider windows lost, then schedulable minutes,
        // then colleagues doubled up on, then the soft lunch window.
        const score =
          blocks * 5_000 +
          weeklyLoad(start, end, context) +
          clash * 120 +
          (outsideWindow ? 600 : 0);

        if (!best || score < best.score) best = { start, score, violates };
      }

      if (!best) {
        for (const day of DAYS) {
          gaps.push({
            staff: member.name,
            day,
            kind,
            minutes,
            reason:
              kind === "Break"
                ? "No time left between the first and last hour of the day"
                : "No free time in the working day",
          });
        }
        continue;
      }

      const span = { start: best.start, end: best.start + minutes };
      mine.push(span);
      taken.push(span);
      for (const day of DAYS) {
        events.push({
          staff: member.name,
          day,
          kind,
          start: span.start,
          end: span.end,
          violates: best.violates,
        });
      }
    }
  }

  return { events, gaps };
}

/* ---------- the SLC teacher ---------- */

export interface SlcCoverageInput {
  member: StaffMember;
  /** When the SLC room is in use that day — the teacher's own and her parapros'. */
  slcBusy: Map<Day, Span[]>;
  /** When each parapro is unavailable to cover, keyed by day. */
  paraBusy: Map<string, Map<Day, Span[]>>;
  paraNames: string[];
}

/**
 * The SLC teacher's lunch and break.
 *
 * Rules 7 and 8 say both must happen "when students are in GE and with a
 * parapro". That is two tests: nothing at all may be running in the SLC room —
 * if it were, her students would be there rather than in general education, and
 * a parapro-led group would lose the supervision rule 2 demands — and at least
 * one parapro must be free to hold the room.
 *
 * Placed per day rather than once for the week, because it has to fit around
 * sessions that differ day to day. Rule 6 allows the break to arrive in pieces,
 * which is what makes it placeable at all on a full day.
 */
export function placeSlcCoverage(
  input: SlcCoverageInput,
  context: WindowContext,
  settings: TeamSettings,
): CoverageResult {
  const { member, slcBusy, paraBusy, paraNames } = input;
  const events: StaffEvent[] = [];
  const gaps: CoverageGap[] = [];

  const dayStart = member.startMinutes;
  const dayEnd = member.endMinutes;
  if (dayStart == null || dayEnd == null) return { events, gaps };

  const covered = (day: Day, start: number, end: number) =>
    paraNames.some(
      (name) =>
        !(paraBusy.get(name)?.get(day) ?? []).some((span) =>
          overlaps(span, start, end),
        ),
    );

  for (const day of DAYS) {
    const busy = [...(slcBusy.get(day) ?? [])];

    const wants: {
      kind: "Lunch" | "Break";
      minutes: number;
      chunks: number;
    }[] = [];
    if (member.lunchMinutes) {
      wants.push({ kind: "Lunch", minutes: member.lunchMinutes, chunks: 1 });
    }
    if (member.breakMinutes) {
      wants.push({
        kind: "Break",
        minutes: member.breakMinutes,
        chunks: Math.max(1, Math.floor(settings.slcBreakChunks)),
      });
    }

    for (const want of wants) {
      let owed = want.minutes;

      // Longest piece first: a single unbroken break is better than two halves,
      // so only split when the day leaves no room for the whole thing.
      for (let piece = 0; piece < want.chunks && owed > 0; piece++) {
        const remaining = want.chunks - piece;
        const length =
          piece === want.chunks - 1 ? owed : Math.ceil(owed / remaining);

        let best: { start: number; score: number } | null = null;
        for (
          let start = dayStart;
          start + length <= dayEnd;
          start += STEP_MINUTES
        ) {
          const end = start + length;
          if (busy.some((span) => overlaps(span, start, end))) continue;
          if (!covered(day, start, end)) continue;

          // Nothing on the sheet times the SLC teacher's lunch, but a lunch at
          // half past two is not a lunch. The parapros' window is the school's
          // own answer to when lunch happens, so borrow it as a preference.
          const outsideWindow =
            want.kind === "Lunch" &&
            (start < settings.paraLunchStart || start > settings.paraLunchEnd);

          const score =
            pullableLoad(day, start, end, context) + (outsideWindow ? 600 : 0);
          if (!best || score < best.score) best = { start, score };
        }

        if (!best) break;

        const span = { start: best.start, end: best.start + length };
        busy.push(span);
        events.push({
          staff: member.name,
          day,
          kind: want.kind,
          start: span.start,
          end: span.end,
          violates: [],
        });
        owed -= length;
      }

      if (owed > 0) {
        gaps.push({
          staff: member.name,
          day,
          kind: want.kind,
          minutes: owed,
          reason:
            "No stretch of the day is both free of SLC-room sessions and covered by a parapro",
        });
      }
    }
  }

  return { events, gaps };
}
