<script lang="ts">
  import {
    columnPx,
    heightPx,
    labelLines,
    lanes,
    topPx,
    LABEL_MINUTES,
  } from "$lib/scheduling/calendar";
  import { formatRange, formatTime } from "$lib/scheduling/time";
  import {
    DAYS,
    type Day,
    type Group,
    type PlanResult,
  } from "$lib/scheduling/types";

  interface Props {
    plan: PlanResult;
    /** When set, the week also shows every time this group could legally meet. */
    selected: Group | null;
    startMinutes: number;
    endMinutes: number;
  }

  let { plan, selected, startMinutes, endMinutes }: Props = $props();

  const height = $derived(columnPx(startMinutes, endMinutes));
  const labels = $derived(labelLines(startMinutes, endMinutes));

  const forDay = (day: Day) =>
    plan.placements.filter((placement) => placement.day === day);

  /**
   * The selected group's own sessions are drawn last, above the legal-window
   * wash, so they read as solid; everyone else's sit under it, still legible
   * but visibly claimed by someone else.
   */
  const mine = (day: Day) =>
    lanes(forDay(day).filter((p) => selected && p.groupId === selected.id));
  const others = (day: Day) =>
    lanes(forDay(day).filter((p) => !selected || p.groupId !== selected.id));

  const legalFor = (day: Day) =>
    selected?.sharedWindows.filter((window) => window.day === day) ?? [];

  const style = (span: { start: number; end: number }, lane = 0, of = 1) =>
    `top:${topPx(span.start, startMinutes)}px;height:${heightPx(span)}px;` +
    `left:calc(${(100 * lane) / of}% + 2px);width:calc(${100 / of}% - 4px)`;

  type Session = PlanResult["placements"][number];

  /** Two stacked lines need ~30px; a short session gets one line instead. */
  const roomForTwoLines = (span: { start: number; end: number }) =>
    heightPx(span) >= 30;

  const describe = (placement: Session) =>
    `${placement.service} · ${placement.members.join(", ")} · ` +
    `${formatRange(placement.start, placement.end)}` +
    (placement.subject ? ` · during ${placement.subject}` : "");

  const COLUMNS = "grid-cols-[4.75rem_repeat(5,minmax(0,1fr))]";
</script>

<!-- A session too short for two lines still names its students, run on after
     the service rather than dropped. -->
{#snippet sessionLabel(event: Session)}
  {#if roomForTwoLines(event)}
    <span class="block truncate font-medium">{event.service}</span>
    <span class="block truncate opacity-80">{event.members.join(", ")}</span>
  {:else}
    <span class="block truncate">
      <span class="font-medium">{event.service}</span>
      <span class="opacity-80"> - {event.members.join(", ")}</span>
    </span>
  {/if}
{/snippet}

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

          {#each others(day) as { event, lane, of } (event.groupId + event.start)}
            <div
              title={describe(event)}
              style={style(event, lane, of)}
              class="absolute z-10 overflow-hidden rounded-md bg-[#b7e1cd] px-1.5 py-0.5 text-[11px] leading-tight text-slate-900"
            >
              {@render sessionLabel(event)}
            </div>
          {/each}

          <!-- Laid over the sessions, not instead of them: a legal time that is
               already taken is exactly what the planner is competing with. -->
          {#each legalFor(day) as window (window.start)}
            <div
              title="{selected?.service} could meet here"
              style={style(window)}
              class="pointer-events-none absolute z-20 rounded-md bg-amber-300/45 ring-1 ring-amber-400/50 ring-inset"
            ></div>
          {/each}

          {#each mine(day) as { event, lane, of } (event.groupId + event.start)}
            <div
              title={describe(event)}
              style={style(event, lane, of)}
              class="absolute z-30 overflow-hidden rounded-md bg-green-700 px-1.5 py-0.5 text-[11px] leading-tight text-white"
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
  Times are placed to the minute; the lines are every {LABEL_MINUTES} minutes.
</p>
