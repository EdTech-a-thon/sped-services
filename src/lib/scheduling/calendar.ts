/**
 * Geometry for the week calendars.
 *
 * The grid draws and labels a line every 15 minutes, but nothing is snapped to
 * those lines: a session that runs 8:20-8:30 sits exactly there, between two of
 * them. Times land on five-minute boundaries, the same step `place.ts` searches
 * on, so an event's height is always its real duration.
 *
 * This replaced a fixed-row table, where every event had to occupy a whole row
 * and long labels wrapped and shoved the rows out of alignment.
 */

export const SNAP_MINUTES = 5;
export const LABEL_MINUTES = 15;
/** 15 minutes reads as 36px — room for a service name over its members. */
export const PIXELS_PER_MINUTE = 2.4;

export interface Span {
  start: number;
  end: number;
}

export const overlaps = (a: Span, b: Span) =>
  a.start < b.end && a.end > b.start;

export const snap = (minutes: number) =>
  Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;

/** Distance from the top of the day column, in pixels. */
export function topPx(minutes: number, dayStart: number): number {
  return (snap(minutes) - dayStart) * PIXELS_PER_MINUTE;
}

/** An event is never drawn thinner than a hairline, however short it is. */
export function heightPx(span: Span): number {
  return Math.max((snap(span.end) - snap(span.start)) * PIXELS_PER_MINUTE, 2);
}

export function columnPx(dayStart: number, dayEnd: number): number {
  return (dayEnd - dayStart) * PIXELS_PER_MINUTE;
}

/** Every labelled line, from the first whole quarter hour onwards. */
export function labelLines(dayStart: number, dayEnd: number): number[] {
  const lines: number[] = [];
  const first = Math.ceil(dayStart / LABEL_MINUTES) * LABEL_MINUTES;
  for (let time = first; time <= dayEnd; time += LABEL_MINUTES) {
    lines.push(time);
  }
  return lines;
}

export interface Lane<T> {
  event: T;
  /** Which column of its overlapping cluster this event sits in. */
  lane: number;
  /** How many columns the cluster needs. */
  of: number;
}

/**
 * Side-by-side lanes for events that overlap in time.
 *
 * The planner will not double-book a provider, so in practice every cluster is
 * one lane wide — but a workbook edited by hand can still produce a clash, and
 * silently drawing one session on top of another would hide it.
 */
export function lanes<T extends Span>(events: T[]): Lane<T>[] {
  const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end);
  const placed: Lane<T>[] = [];
  let cluster: Lane<T>[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const of = cluster.reduce((max, item) => Math.max(max, item.lane + 1), 1);
    for (const item of cluster) placed.push({ ...item, of });
    cluster = [];
  };

  for (const event of sorted) {
    if (event.start >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    const taken = new Set(
      cluster
        .filter((item) => overlaps(item.event, event))
        .map((item) => item.lane),
    );
    let lane = 0;
    while (taken.has(lane)) lane++;
    cluster.push({ event, lane, of: 1 });
    clusterEnd = Math.max(clusterEnd, event.end);
  }
  flush();

  return placed;
}

/**
 * Every distinct edge in `spans`, clamped to the day — the cut points for
 * splitting a day into stretches that are uniform all the way through.
 */
export function boundaries(
  dayStart: number,
  dayEnd: number,
  spans: Span[],
): number[] {
  const edges = new Set<number>([dayStart, dayEnd]);
  for (const span of spans) {
    if (span.start > dayStart && span.start < dayEnd)
      edges.add(snap(span.start));
    if (span.end > dayStart && span.end < dayEnd) edges.add(snap(span.end));
  }
  return [...edges].sort((a, b) => a - b);
}
