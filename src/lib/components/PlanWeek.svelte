<script lang="ts">
  import { formatRange, formatTime } from "$lib/scheduling/time";
  import { DAYS, type Group, type PlanResult } from "$lib/scheduling/types";

  interface Props {
    plan: PlanResult;
    /** When set, the week also shows every time this group could legally meet. */
    selected: Group | null;
    startMinutes: number;
    endMinutes: number;
    slotMinutes: number;
  }

  let { plan, selected, startMinutes, endMinutes, slotMinutes }: Props =
    $props();

  const slots = $derived.by(() => {
    const rows: { start: number; end: number }[] = [];
    for (
      let time = startMinutes;
      time < endMinutes && rows.length < 200;
      time += slotMinutes
    ) {
      rows.push({ start: time, end: Math.min(time + slotMinutes, endMinutes) });
    }
    return rows;
  });

  const overlaps = (
    a: { start: number; end: number },
    b: { start: number; end: number },
  ) => a.start < b.end && a.end > b.start;

  /**
   * One cell per day per slot. A booked session always wins over a legal-window
   * hint, so highlighting a group never hides what is already scheduled.
   */
  const cells = $derived.by(() =>
    slots.map((slot) =>
      DAYS.map((day) => {
        const placement = plan.placements.find(
          (candidate) => candidate.day === day && overlaps(candidate, slot),
        );
        const legal =
          selected?.sharedWindows.some(
            (window) => window.day === day && overlaps(window, slot),
          ) ?? false;

        if (placement) {
          return {
            kind:
              selected && placement.groupId === selected.id
                ? ("selected" as const)
                : ("session" as const),
            // Only label the row the session starts in, so a long session reads
            // as one block instead of repeating down the column.
            label: placement.start >= slot.start ? placement.service : "",
            members: placement.start >= slot.start ? placement.members : [],
            title: `${placement.service} · ${placement.members.join(", ")} · ${formatRange(placement.start, placement.end)}${placement.subject ? ` · during ${placement.subject}` : ""}`,
          };
        }
        if (legal) {
          return {
            kind: "legal" as const,
            label: "",
            members: [],
            title: `${selected?.service} could meet here`,
          };
        }
        return { kind: "empty" as const, label: "", members: [], title: "" };
      }),
    ),
  );

  const CELL_CLASS = {
    selected: "bg-green-700 text-white",
    session: "bg-[#b7e1cd] text-slate-900",
    legal: "bg-amber-100 text-amber-900",
    empty: "",
  };
</script>

<div
  class="relative max-h-[70vh] overflow-auto rounded-xl border border-slate-200 bg-white"
>
  <table class="w-full border-collapse text-sm">
    <thead>
      <tr>
        <th
          class="sticky top-0 left-0 z-20 w-28 border-b border-slate-200 bg-slate-50 px-2 py-2 text-left font-medium text-slate-600"
        >
          Time
        </th>
        {#each DAYS as day (day)}
          <th
            class="sticky top-0 z-10 border-b border-l border-slate-200 bg-slate-50 px-2 py-2 text-left font-medium text-slate-700"
          >
            {day}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each slots as slot, row (slot.start)}
        <tr>
          <th
            scope="row"
            class="sticky left-0 z-10 border-b border-slate-100 bg-white px-2 py-1 text-left font-normal whitespace-nowrap text-slate-500"
          >
            {formatTime(slot.start)}
          </th>
          {#each cells[row] as cell, column (DAYS[column])}
            <td
              title={cell.title}
              class="border-b border-l border-slate-100 px-2 py-1 align-top {CELL_CLASS[
                cell.kind
              ]}"
            >
              {#if cell.label}
                <span class="block font-medium">{cell.label}</span>
                <span class="block text-xs opacity-80"
                  >{cell.members.join(", ")}</span
                >
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
