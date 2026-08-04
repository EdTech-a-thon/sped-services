<script lang="ts">
  import {
    columnPx,
    heightPx,
    labelLines,
    lanes,
    topPx,
    LABEL_MINUTES,
  } from "$lib/scheduling/calendar";
  import { normalizeKey } from "$lib/scheduling/parse";
  import type { TeamPlacement } from "$lib/scheduling/teamPlace";
  import {
    isCoTeacher,
    isParapro,
    isSlcTeacher,
  } from "$lib/scheduling/teamRules";
  import { formatRange, formatTime } from "$lib/scheduling/time";
  import {
    DAYS,
    type Day,
    type StaffEvent,
    type StaffMember,
  } from "$lib/scheduling/types";

  interface Props {
    placements: TeamPlacement[];
    coverage: StaffEvent[];
    staff: StaffMember[];
    /** Staff names to draw solid; everyone else is dimmed. Empty means everyone. */
    focus: string[];
    startMinutes: number;
    endMinutes: number;
  }

  let { placements, coverage, staff, focus, startMinutes, endMinutes }: Props =
    $props();

  const height = $derived(columnPx(startMinutes, endMinutes));
  const labels = $derived(labelLines(startMinutes, endMinutes));

  const focusKeys = $derived(new Set(focus.map(normalizeKey)));
  const inFocus = (name: string) =>
    focusKeys.size === 0 || focusKeys.has(normalizeKey(name));

  const byName = $derived(
    new Map(staff.map((member) => [normalizeKey(member.name), member])),
  );

  /** Colour by what the person is, so a week reads as roles before names. */
  function roleClass(name: string): string {
    const member = byName.get(normalizeKey(name));
    if (!member) return "bg-slate-500";
    if (isSlcTeacher(member)) return "bg-green-700";
    if (isCoTeacher(member)) return "bg-sky-700";
    if (isParapro(member)) return "bg-amber-600";
    return "bg-slate-500";
  }

  const sessionsFor = (day: Day) =>
    lanes(placements.filter((placement) => placement.day === day));
  const coverageFor = (day: Day) =>
    lanes(coverage.filter((event) => event.day === day));

  const style = (span: { start: number; end: number }, lane = 0, of = 1) =>
    `top:${topPx(span.start, startMinutes)}px;height:${heightPx(span)}px;` +
    `left:calc(${(100 * lane) / of}% + 1px);width:calc(${100 / of}% - 2px)`;

  const roomForTwoLines = (span: { start: number; end: number }) =>
    heightPx(span) >= 30;

  const describe = (placement: TeamPlacement) =>
    `${placement.staff} · ${placement.service} · ${placement.members.join(", ")} · ` +
    `${formatRange(placement.start, placement.end)}` +
    (placement.supportStaff.length
      ? ` · supported by ${placement.supportStaff.join(", ")}`
      : "") +
    (placement.subject ? ` · during ${placement.subject}` : "") +
    (placement.isLeadSession ? " · lead provider session" : "");

  const COLUMNS = "grid-cols-[4.75rem_repeat(5,minmax(0,1fr))]";
</script>

{#snippet sessionLabel(event: TeamPlacement)}
  {#if roomForTwoLines(event)}
    <span class="block truncate font-medium">
      {event.staff}{event.isLeadSession ? " ★" : ""}
    </span>
    <span class="block truncate opacity-85">{event.service}</span>
  {:else}
    <span class="block truncate">
      <span class="font-medium">{event.staff}</span>
      <span class="opacity-85"> - {event.service}</span>
    </span>
  {/if}
{/snippet}

<div
  class="max-h-[75vh] overflow-auto rounded-xl border border-slate-200 bg-white"
>
  <div class="min-w-[52rem]">
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

          <!-- Lunch and break sit under the sessions: they are the shape of the
               day rather than something happening in it. -->
          {#each coverageFor(day) as { event, lane, of } (event.staff + event.kind + event.start)}
            <div
              title="{event.staff} · {event.kind} · {formatRange(
                event.start,
                event.end,
              )}{event.violates.length
                ? ' · outside the preferred window'
                : ''}"
              style={style(event, lane, of)}
              class="absolute z-10 overflow-hidden rounded border border-dashed
                     border-slate-400 bg-slate-100 px-1 text-[10px] leading-tight
                     text-slate-600 {inFocus(event.staff) ? '' : 'opacity-25'}"
            >
              <span class="block truncate">{event.staff} {event.kind}</span>
            </div>
          {/each}

          {#each sessionsFor(day) as { event, lane, of } (event.groupId + event.staff + event.start)}
            <div
              title={describe(event)}
              style={style(event, lane, of)}
              class="absolute z-20 overflow-hidden rounded-md px-1.5 py-0.5
                     text-[11px] leading-tight text-white {roleClass(
                event.staff,
              )} {inFocus(event.staff) ? '' : 'opacity-20'}"
            >
              {@render sessionLabel(event)}
            </div>
          {/each}
        </div>
      {/each}
    </div>
  </div>
</div>

<p class="sr-only">
  Times are placed to the minute; the lines are every {LABEL_MINUTES} minutes. A star
  marks the session the lead provider takes personally.
</p>
