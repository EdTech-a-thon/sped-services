<script lang="ts">
  import {
    boundaries,
    columnPx,
    heightPx,
    labelLines,
    overlaps,
    topPx,
  } from "$lib/scheduling/calendar";
  import type { GroupPreview } from "$lib/scheduling/explain";
  import { formatRange, formatTime } from "$lib/scheduling/time";
  import {
    DAYS,
    emptyClassSchedule,
    type ClassSchedule,
    type Day,
    type ServiceSession,
    type Student,
  } from "$lib/scheduling/types";

  interface Props {
    preview: GroupPreview;
    /** The student the week belongs to — the one whose row was clicked. */
    student: Student;
    /** Their classroom timetable, for naming what a session would displace. */
    schedule: ClassSchedule | undefined;
    /** Their existing OT/PT/Resource sessions. */
    bookings: ServiceSession[];
    startMinutes: number;
    endMinutes: number;
  }

  let {
    preview,
    student,
    schedule,
    bookings,
    startMinutes,
    endMinutes,
  }: Props = $props();

  const timetable = $derived(schedule ?? emptyClassSchedule());
  const height = $derived(columnPx(startMinutes, endMinutes));
  const labels = $derived(labelLines(startMinutes, endMinutes));

  type Kind = "shared" | "short" | "own" | "booked" | "blocked" | "empty";

  interface Segment {
    start: number;
    end: number;
    kind: Kind;
    label: string;
    title: string;
  }

  /**
   * Nothing here overlaps, so instead of layering the day it is cut at every
   * edge and each stretch is drawn once, at exactly its own length. A 10-minute
   * gap between two bookings is a 10-minute block, not a whole row.
   */
  function segmentsFor(day: Day): Segment[] {
    const blocks = timetable[day];
    const booked = bookings.filter((session) => session.day === day);
    const own = preview.ownWindows.filter((window) => window.day === day);
    const shared = preview.sharedWindows.filter((window) => window.day === day);
    const short = preview.tooShort.filter((window) => window.day === day);

    const edges = boundaries(startMinutes, endMinutes, [
      ...blocks,
      ...booked,
      ...own,
      ...shared,
      ...short,
    ]);

    const cut: Segment[] = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const span = { start: edges[i], end: edges[i + 1] };
      const subjects = [
        ...new Set(
          blocks.filter((block) => overlaps(block, span)).map((b) => b.subject),
        ),
      ].join(" / ");
      const during = subjects ? ` · during ${subjects}` : "";

      // Most restrictive first, so a stretch never looks freer than it is.
      const clash = booked.find((session) => overlaps(session, span));
      if (clash) {
        cut.push({
          ...span,
          kind: "booked",
          label: clash.service,
          title: `${student.name} is with ${clash.service} · ${formatRange(clash.start, clash.end)}`,
        });
        continue;
      }
      if (shared.some((window) => overlaps(window, span))) {
        cut.push({
          ...span,
          kind: "shared",
          label: subjects,
          title: `All ${preview.members.length} free${during}`,
        });
        continue;
      }
      if (short.some((window) => overlaps(window, span))) {
        cut.push({
          ...span,
          kind: "short",
          label: subjects,
          title: `All free, but the window is shorter than ${preview.sessionLength} min${during}`,
        });
        continue;
      }
      if (own.some((window) => overlaps(window, span))) {
        cut.push({
          ...span,
          kind: "own",
          label: subjects,
          title:
            preview.members.length > 1
              ? `${student.name} is free, but not everyone selected${during}`
              : `${student.name} could be served here${during}`,
        });
        continue;
      }
      cut.push({
        ...span,
        kind: subjects ? "blocked" : "empty",
        label: subjects,
        title: subjects
          ? `${subjects} — no service may displace this`
          : "Nothing scheduled",
      });
    }

    // Neighbours that say the same thing are one block, not a stack of slivers.
    const merged: Segment[] = [];
    for (const segment of cut) {
      const last = merged[merged.length - 1];
      if (last && last.kind === segment.kind && last.label === segment.label) {
        last.end = segment.end;
        continue;
      }
      merged.push({ ...segment });
    }
    return merged.filter((segment) => segment.kind !== "empty");
  }

  // Shares the palette with the availability grid and the Excel export.
  const KIND_CLASS: Record<Kind, string> = {
    shared: "bg-green-700 text-white font-medium",
    short: "bg-green-200 text-green-900",
    own: "bg-amber-100 text-amber-900",
    booked: "bg-[#f4c7c3] text-slate-700 italic",
    blocked: "bg-slate-50 text-slate-400",
    empty: "",
  };

  const COLUMNS = "grid-cols-[4.75rem_repeat(5,minmax(0,1fr))]";
</script>

<div
  class="max-h-[75vh] overflow-auto rounded-xl border border-slate-200 bg-white"
>
  <div class="min-w-[46rem]">
    <div
      class="sticky top-0 z-40 grid {COLUMNS} border-b border-slate-200 bg-slate-50"
    >
      <div class="px-2 py-2 text-xs font-medium text-slate-500">Time</div>
      {#each DAYS as day (day)}
        <div
          class="border-l border-slate-200 px-2 py-2 text-sm font-medium text-slate-700"
        >
          {day}
        </div>
      {/each}
    </div>

    <div class="grid {COLUMNS}">
      <div class="relative" style="height:{height}px">
        {#each labels as minutes (minutes)}
          <div
            class="absolute right-2 text-xs whitespace-nowrap text-slate-400"
            style="top:{topPx(minutes, startMinutes)}px"
          >
            {formatTime(minutes)}
          </div>
        {/each}
      </div>

      {#each DAYS as day (day)}
        <div
          class="relative border-l border-slate-200"
          style="height:{height}px"
        >
          {#each labels as minutes (minutes)}
            <div
              class="pointer-events-none absolute inset-x-0 border-t {minutes %
                60 ===
              0
                ? 'border-slate-200'
                : 'border-slate-100'}"
              style="top:{topPx(minutes, startMinutes)}px"
            ></div>
          {/each}

          {#each segmentsFor(day) as segment (segment.start)}
            <div
              title={segment.title}
              style="top:{topPx(
                segment.start,
                startMinutes,
              )}px;height:{heightPx(segment)}px"
              class="absolute inset-x-0.5 overflow-hidden rounded-md px-1.5 py-0.5 text-[11px] leading-tight {KIND_CLASS[
                segment.kind
              ]}"
            >
              {#if heightPx(segment) >= 18}
                <span class="block truncate">{segment.label}</span>
              {/if}
              <span class="sr-only">{segment.title}</span>
            </div>
          {/each}
        </div>
      {/each}
    </div>
  </div>
</div>
