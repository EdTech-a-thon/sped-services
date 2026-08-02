<script lang="ts">
  import type { CellStatus, DayGrid, Student } from "$lib/scheduling/types";

  let { grid, students }: { grid: DayGrid; students: Student[] } = $props();

  // Kept in step with the fill colours written into the exported workbook.
  const CELL_CLASS: Record<CellStatus, string> = {
    available: "bg-[#b7e1cd] text-slate-900",
    unavailable: "bg-[#f4c7c3] text-slate-900",
    booked: "bg-[#f4c7c3] text-slate-900 italic",
    empty: "text-slate-400",
  };

  const CELL_TITLE: Record<CellStatus, string> = {
    available: "Available to pull",
    unavailable: "Do not pull",
    booked: "Already with another provider",
    empty: "Nothing scheduled",
  };
</script>

<!-- `relative` matters: the screen-reader-only spans in the cells are absolutely
     positioned, and without a positioned ancestor here they escape this box and
     stretch the whole page's scroll area to the width of the table. -->
<div
  class="relative max-h-[70vh] overflow-auto rounded-lg border border-slate-200"
>
  <table class="w-max border-collapse text-sm">
    <thead>
      <tr>
        <th
          scope="col"
          class="sticky top-0 left-0 z-20 w-40 min-w-40 border-r border-b border-slate-300 bg-white px-3 py-2 text-left font-semibold text-slate-700"
        >
          Time
        </th>
        {#each students as student (student.name)}
          <th
            scope="col"
            class="sticky top-0 z-10 w-32 min-w-32 border-r border-b border-slate-300 bg-white px-3 py-2 text-left font-semibold text-slate-700"
          >
            {student.name}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each grid.slots as slot, row (slot.start)}
        <tr>
          <th
            scope="row"
            class="sticky left-0 z-10 border-r border-b border-slate-200 bg-white px-3 py-1.5 text-left font-normal whitespace-nowrap text-slate-600"
          >
            {slot.label}
          </th>
          {#each grid.rows[row] as cell, column (students[column].name)}
            <td
              title="{CELL_TITLE[cell.status]}{cell.label
                ? ` — ${cell.label}`
                : ''}"
              class="border-r border-b border-slate-200 px-3 py-1.5 {CELL_CLASS[
                cell.status
              ]}"
            >
              <span class="sr-only">{CELL_TITLE[cell.status]}: </span>
              {cell.label || "—"}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
