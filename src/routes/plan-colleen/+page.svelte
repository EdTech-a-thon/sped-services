<script lang="ts">
  import { onMount } from "svelte";
  import TeamWeek from "$lib/components/TeamWeek.svelte";
  import {
    buildTeamPlanExport,
    teamPlanFileName,
  } from "$lib/scheduling/export";
  import {
    loadExcelJS,
    normalizeKey,
    parseWorkbook,
    WorkbookError,
  } from "$lib/scheduling/parse";
  import { loadWorkbook, saveWorkbook } from "$lib/scheduling/storage";
  import { buildTeamPlan, type TeamPlanResult } from "$lib/scheduling/team";
  import {
    isCoTeacher,
    isParapro,
    isSlcTeacher,
    type RuleSection,
    type TeamSettings,
  } from "$lib/scheduling/teamRules";
  import { formatRange, formatTime } from "$lib/scheduling/time";
  import type { SchedulerInput } from "$lib/scheduling/types";

  /** The knobs worth exposing; every other setting is prose, not a number. */
  const TUNABLE: { key: keyof TeamSettings; label: string; step: number }[] = [
    { key: "paraMaxGroupSize", label: "Parapro group size", step: 1 },
    { key: "maxGroupSize", label: "Max group size", step: 1 },
    { key: "sessionLengthDelta", label: "Session length span (min)", step: 5 },
    { key: "pullOutTransitionMinutes", label: "Transition (min)", step: 1 },
    { key: "slcBreakChunks", label: "SLC break chunks", step: 1 },
  ];

  const SECTIONS: RuleSection[] = ["Staff", "Instruction", "Compliance"];

  const ENFORCEMENT_LABEL = {
    hard: "Enforced",
    soft: "Preferred, and reported when missed",
    structural: "Cannot be broken by construction",
    unmodelled: "Not checked",
  };
  const ENFORCEMENT_CLASS = {
    hard: "text-green-700",
    soft: "text-amber-700",
    structural: "text-slate-500",
    unmodelled: "text-red-700",
  };

  const DAY_START = 7 * 60 + 30;
  const DAY_END = 15 * 60;

  let input = $state<SchedulerInput | null>(null);
  let fileBytes = $state<ArrayBuffer | null>(null);
  let overrides = $state<Partial<TeamSettings>>({});
  let focus = $state<string[]>([]);
  let errorMessage = $state("");
  let busy = $state(false);
  let dragging = $state(false);

  const plan = $derived<TeamPlanResult | null>(
    input ? buildTeamPlan(input, overrides) : null,
  );

  /**
   * Demand against capacity. The team total is the reassuring number and on its
   * own it lies: one person can be booked solid while the team looks half idle,
   * and it is that person who decides what fits. So the busiest individual is
   * what the panel leads with.
   */
  const demand = $derived.by(() => {
    if (!plan) return null;
    const scheduled = plan.placements.reduce(
      (sum, entry) => sum + (entry.end - entry.start),
      0,
    );

    // What each person is actually asked for, before grouping collapses it.
    const prescribedFor = (name: string) =>
      (input?.requirements ?? [])
        .filter(
          (requirement) =>
            normalizeKey(requirement.leadProvider) === normalizeKey(name),
        )
        .reduce(
          (sum, requirement) =>
            sum +
            (requirement.minutesPerWeek ||
              requirement.sessionLength * requirement.sessionsPerWeek),
          0,
        );

    const busiest = [...plan.load]
      .map((row) => ({
        name: row.staff.name,
        prescribed: prescribedFor(row.staff.name),
        available: row.availableMinutes,
        booked: row.scheduledMinutes,
      }))
      .sort(
        (a, b) =>
          b.prescribed / (b.available || 1) - a.prescribed / (a.available || 1),
      )[0];

    return {
      scheduled,
      busiest,
      busiestPercent: busiest?.available
        ? Math.round((100 * busiest.prescribed) / busiest.available)
        : 0,
    };
  });

  const met = $derived(
    plan?.compliance.filter((row) => row.status === "OK").length ?? 0,
  );

  function roleLabel(name: string): string {
    const member = plan?.staff.find(
      (candidate) => normalizeKey(candidate.name) === normalizeKey(name),
    );
    if (!member) return "";
    if (isSlcTeacher(member)) return "SLC teacher";
    if (isCoTeacher(member)) return "Co-teacher";
    if (isParapro(member)) return "Parapro";
    return member.role;
  }

  function toggleFocus(name: string) {
    focus = focus.includes(name)
      ? focus.filter((other) => other !== name)
      : [...focus, name];
  }

  /** Monday's lunch and break, which is every day's for everyone but the SLC teacher. */
  function coverageSummary(staffName: string): string {
    if (!plan) return "";
    const events = plan.coverage
      .filter(
        (event) =>
          normalizeKey(event.staff) === normalizeKey(staffName) &&
          event.day === "Monday",
      )
      .sort((a, b) => a.start - b.start);
    if (!events.length) return "—";
    return events
      .map((event) => `${event.kind} ${formatRange(event.start, event.end)}`)
      .join(", ");
  }

  async function readWorkbook(
    bytes: ArrayBuffer,
    fileName: string,
    saved: boolean,
  ) {
    busy = true;
    errorMessage = "";
    try {
      const parsed = await parseWorkbook(new Blob([bytes]), fileName);
      input = parsed;
      fileBytes = bytes;
      overrides = {};
      focus = [];
      if (!saved) saveWorkbook(fileName, bytes, "team");
    } catch (error) {
      input = null;
      fileBytes = null;
      errorMessage =
        error instanceof WorkbookError
          ? error.message
          : "That file could not be read. Make sure it is an .xlsx workbook saved from Excel or Google Sheets.";
    } finally {
      busy = false;
    }
  }

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      errorMessage = `"${file.name}" is not an .xlsx file. Export your Google Sheet as Microsoft Excel (.xlsx) first.`;
      return;
    }
    await readWorkbook(await file.arrayBuffer(), file.name, false);
  }

  async function download() {
    if (!input || !plan) return;
    busy = true;
    try {
      const blob = await buildTeamPlanExport(
        input,
        plan,
        fileBytes ?? undefined,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = teamPlanFileName(input.fileName);
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      errorMessage =
        error instanceof WorkbookError
          ? error.message
          : "The workbook could not be exported. Try re-uploading it.";
    } finally {
      busy = false;
    }
  }

  function setOverride(key: keyof TeamSettings, value: string) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) overrides = { ...overrides, [key]: parsed };
  }

  onMount(() => {
    void loadExcelJS().catch(() => {});
    const stored = loadWorkbook("team");
    if (stored) void readWorkbook(stored.bytes, stored.fileName, true);
  });
</script>

<svelte:head>
  <title>Plan the whole team's week · Service Scheduler</title>
  <meta
    name="description"
    content="Schedule every provider, parapro and co-teacher in one week, lunches and breaks included."
  />
</svelte:head>

<main class="mx-auto w-full max-w-[92rem] flex-1 px-4 py-10">
  <h1 class="text-3xl font-semibold text-slate-900">
    Plan the whole team's week
  </h1>
  <p class="mt-2 max-w-3xl text-slate-600">
    Schedules every member of staff against every other one — the SLC teacher,
    the co-teachers and the parapros — and places their lunches and breaks too.
    Each prescription's named lead provider takes one session of it personally
    every week; the repeats go to a parapro wherever the sheet allows it, and a
    parapro only leads while the SLC teacher is in the room. Nothing here
    reduces a student's prescribed minutes; whatever will not fit is reported
    instead.
  </p>

  {#if errorMessage}
    <p
      role="alert"
      class="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800"
    >
      {errorMessage}
    </p>
  {/if}

  {#if !input}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      ondragover={(event) => {
        event.preventDefault();
        dragging = true;
      }}
      ondragleave={() => (dragging = false)}
      ondrop={(event) => {
        event.preventDefault();
        dragging = false;
        void handleFile(event.dataTransfer?.files?.[0]);
      }}
      class="mt-6 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors {dragging
        ? 'border-green-600 bg-green-50'
        : 'border-slate-300 bg-white'}"
    >
      <p class="text-lg font-medium text-slate-800">
        Drop your <code class="rounded bg-slate-100 px-1 py-0.5">.xlsx</code>
        workbook here
      </p>
      <p class="mt-1 text-sm text-slate-500">or</p>
      <label
        class="mt-3 inline-block cursor-pointer rounded-lg bg-green-800 px-5 py-2.5 font-medium text-white hover:bg-green-900"
      >
        Choose a file
        <input
          type="file"
          accept=".xlsx"
          class="sr-only"
          onchange={(event) => handleFile(event.currentTarget.files?.[0])}
        />
      </label>
      <p class="mx-auto mt-6 max-w-xl text-sm text-slate-500">
        Team planning needs the <strong>Minutes</strong> sheet to name a
        <strong>Lead Provider</strong>, and the <strong>Staff</strong> sheet to
        give each person their hours, lunch and break. The
        <strong>Rules</strong>
        sheet's Staff, Instruction and Compliance blocks are read too.
      </p>
    </div>
    {#if busy}
      <p class="mt-4 text-center text-slate-500">Reading workbook…</p>
    {/if}
  {:else if plan}
    <section
      class="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4"
    >
      <p class="text-sm text-slate-500">
        {input.fileName} · {plan.staff.length} staff · {plan.compliance.length} prescriptions
        · {plan.groups.length} groups · {plan.placements.length} sessions placed
      </p>
      <button
        type="button"
        onclick={download}
        disabled={busy}
        class="rounded-lg bg-green-800 px-4 py-2 font-medium text-white hover:bg-green-900 disabled:opacity-50"
      >
        Export to Excel
      </button>
    </section>

    {#if demand}
      <section
        class="mt-4 rounded-xl border px-5 py-4 {demand.busiestPercent > 100
          ? 'border-red-200 bg-red-50'
          : 'border-slate-200 bg-white'}"
      >
        <h2 class="font-semibold text-slate-900">Demand against capacity</h2>
        {#if demand.busiest && demand.busiestPercent > 100}
          <p class="mt-1 text-sm text-slate-700">
            <strong>{demand.busiest.name}</strong> is named lead provider on
            <strong>{demand.busiest.prescribed} minutes</strong> of
            prescriptions a week and can work
            <strong>{demand.busiest.available}</strong> — {demand.busiestPercent}%
            of one person. Grouping students together absorbs some of that, but
            not all of it, and no rearranging of the week can.
          </p>
        {:else if demand.busiest}
          <p class="mt-1 text-sm text-slate-700">
            The busiest person is <strong>{demand.busiest.name}</strong>, named
            lead on {demand.busiest.prescribed} minutes of prescriptions a week against
            {demand.busiest.available} they can work — {demand.busiestPercent}%.
          </p>
        {/if}
        <p class="mt-2 text-sm text-slate-600">
          {demand.scheduled} minutes were placed across the team, and
          <strong>{met} of {plan.compliance.length}</strong> prescriptions are
          fully met.
          {#if met < plan.compliance.length}
            The rest are listed under <em>Not scheduled</em> below, with the reason
            each one would not fit. Prescribed minutes were left alone.
          {/if}
        </p>
      </section>
    {/if}

    <section class="mt-4 rounded-xl border border-slate-200 bg-white px-5 py-4">
      <div class="flex flex-wrap items-baseline justify-between gap-3">
        <h2 class="font-semibold text-slate-900">The rules being applied</h2>
        <button
          type="button"
          onclick={() => (overrides = {})}
          class="text-sm text-green-800 underline hover:text-green-900"
        >
          Reset to the workbook's values
        </button>
      </div>

      <div class="mt-3 flex flex-wrap gap-4">
        {#each TUNABLE as knob (knob.key)}
          <label class="text-sm text-slate-600">
            <span class="block font-medium text-slate-700">{knob.label}</span>
            <input
              type="number"
              step={knob.step}
              value={plan.settings[knob.key] as number}
              onchange={(event) =>
                setOverride(knob.key, event.currentTarget.value)}
              class="mt-1 w-32 rounded-lg border border-slate-300 px-3 py-1.5"
            />
          </label>
        {/each}
      </div>

      <details class="mt-4">
        <summary class="cursor-pointer text-sm font-medium text-slate-700">
          Every rule on the Rules sheet, and how it is handled
        </summary>
        {#each SECTIONS as section (section)}
          <h3 class="mt-4 text-sm font-semibold text-slate-800">
            {section} rules
          </h3>
          <ul class="mt-1 space-y-1.5 text-sm">
            {#each plan.rules.filter((rule) => rule.section === section) as rule (rule.id)}
              <li class="flex gap-2">
                <span
                  class="mt-0.5 shrink-0 rounded px-1.5 text-xs font-medium {rule.hardness ===
                  'Hard'
                    ? 'bg-slate-200 text-slate-700'
                    : 'bg-amber-100 text-amber-800'}"
                >
                  {rule.hardness}
                </span>
                <span class="text-slate-700">
                  {rule.summary}
                  {#if !rule.onSheet}
                    <span class="text-slate-400 italic">
                      (not on this workbook's Rules sheet)
                    </span>
                  {/if}
                  <span
                    class="block text-xs {ENFORCEMENT_CLASS[rule.enforcement]}"
                  >
                    {ENFORCEMENT_LABEL[rule.enforcement]} — {rule.detail}
                  </span>
                </span>
              </li>
            {/each}
          </ul>
        {/each}

        {#if plan.unmodelledRules.length}
          <h3 class="mt-4 text-sm font-semibold text-red-800">
            Not checked by this planner
          </h3>
          <ul class="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600">
            {#each plan.unmodelledRules as text (text)}
              <li>{text}</li>
            {/each}
          </ul>
          <p class="mt-1 text-xs text-slate-500">
            These name particular students. Check them by hand against the week
            below.
          </p>
        {/if}
      </details>
    </section>

    {#if input.warnings.length}
      <details
        class="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4"
      >
        <summary class="cursor-pointer font-medium text-amber-900">
          {input.warnings.length} things to check in the workbook
        </summary>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
          {#each input.warnings as warning (warning)}
            <li>{warning}</li>
          {/each}
        </ul>
      </details>
    {/if}

    <section class="mt-8">
      <h2 class="font-semibold text-slate-900">Staff</h2>
      <p class="mt-1 text-sm text-slate-500">
        Click a name to pick them out of the week below.
      </p>
      <div
        class="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white"
      >
        <table class="w-full min-w-[52rem] text-sm">
          <thead class="bg-slate-50 text-left text-slate-600">
            <tr>
              <th class="px-3 py-2 font-medium">Staff</th>
              <th class="px-3 py-2 font-medium">Role</th>
              <th class="px-3 py-2 font-medium">Hours</th>
              <th class="px-3 py-2 font-medium">Leads</th>
              <th class="px-3 py-2 font-medium">Sessions</th>
              <th class="px-3 py-2 font-medium">Booked / available</th>
              <th class="px-3 py-2 font-medium">Lunch and break</th>
            </tr>
          </thead>
          <tbody>
            {#each plan.load as row (row.staff.name)}
              <tr
                class="border-t border-slate-100 {focus.includes(row.staff.name)
                  ? 'bg-green-50'
                  : ''}"
              >
                <td class="px-3 py-2">
                  <button
                    type="button"
                    onclick={() => toggleFocus(row.staff.name)}
                    class="font-medium text-green-900 underline-offset-2 hover:underline"
                  >
                    {row.staff.name}
                  </button>
                </td>
                <td class="px-3 py-2 text-slate-600"
                  >{roleLabel(row.staff.name)}</td
                >
                <td class="px-3 py-2 text-slate-600">
                  {row.staff.startMinutes != null &&
                  row.staff.endMinutes != null
                    ? formatRange(row.staff.startMinutes, row.staff.endMinutes)
                    : "—"}
                </td>
                <td class="px-3 py-2 text-slate-600">
                  {row.leadRequirements} prescriptions
                </td>
                <td class="px-3 py-2 text-slate-600">{row.sessions}</td>
                <td class="px-3 py-2 text-slate-600">
                  {row.scheduledMinutes} / {row.availableMinutes} min
                </td>
                <td
                  class="px-3 py-2 {coverageSummary(row.staff.name) === '—' &&
                  (row.staff.lunchMinutes || row.staff.breakMinutes)
                    ? 'text-red-700'
                    : 'text-slate-600'}"
                >
                  {row.staff.lunchMinutes || row.staff.breakMinutes
                    ? coverageSummary(row.staff.name)
                    : "none scheduled"}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="mt-8">
      <div class="flex flex-wrap items-baseline justify-between gap-3">
        <h2 class="font-semibold text-slate-900">The week</h2>
        {#if focus.length}
          <button
            type="button"
            onclick={() => (focus = [])}
            class="text-sm text-green-800 underline hover:text-green-900"
          >
            Show everyone
          </button>
        {/if}
      </div>
      <div
        class="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-600"
      >
        <span class="flex items-center gap-1.5">
          <span class="inline-block h-3 w-3 rounded bg-green-700"></span> SLC teacher
        </span>
        <span class="flex items-center gap-1.5">
          <span class="inline-block h-3 w-3 rounded bg-sky-700"></span> Co-teacher
        </span>
        <span class="flex items-center gap-1.5">
          <span class="inline-block h-3 w-3 rounded bg-amber-600"></span> Parapro
        </span>
        <span class="flex items-center gap-1.5">
          <span
            class="inline-block h-3 w-3 rounded border border-dashed border-slate-400 bg-slate-100"
          ></span>
          Lunch or break
        </span>
        <span>★ marks the lead provider's own session</span>
      </div>
      <div class="mt-3">
        <TeamWeek
          placements={plan.placements}
          coverage={plan.coverage}
          staff={plan.staff}
          {focus}
          startMinutes={DAY_START}
          endMinutes={DAY_END}
        />
      </div>
    </section>

    {#if plan.violations.length}
      <section class="mt-8">
        <h2 class="font-semibold text-slate-900">
          Rules that had to bend ({plan.violations.length})
        </h2>
        <ul class="mt-3 space-y-1.5 text-sm text-slate-700">
          {#each plan.violations as violation, index (violation.ruleId + index)}
            <li
              class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
            >
              <span class="font-medium">{violation.summary}</span>
              <span class="block text-slate-600">{violation.detail}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if plan.unplaced.length}
      <section class="mt-8">
        <h2 class="font-semibold text-slate-900">
          Not scheduled ({plan.unplaced.length})
        </h2>
        <p class="mt-1 text-sm text-slate-500">
          These minutes are still owed. They were reported rather than reduced.
        </p>
        <div
          class="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white"
        >
          <table class="w-full min-w-[48rem] text-sm">
            <thead class="bg-slate-50 text-left text-slate-600">
              <tr>
                <th class="px-3 py-2 font-medium">Student</th>
                <th class="px-3 py-2 font-medium">Service</th>
                <th class="px-3 py-2 font-medium">Model</th>
                <th class="px-3 py-2 font-medium">Short by</th>
                <th class="px-3 py-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {#each plan.unplaced as row (row.student + row.service)}
                <tr class="border-t border-slate-100">
                  <td class="px-3 py-2 font-medium text-slate-800"
                    >{row.student}</td
                  >
                  <td class="px-3 py-2 text-slate-600">{row.service}</td>
                  <td class="px-3 py-2 text-slate-600">{row.model}</td>
                  <td class="px-3 py-2 text-slate-600">
                    {row.missingSessions} sessions · {row.missingMinutes} min
                  </td>
                  <td class="px-3 py-2 text-slate-600">
                    {Object.entries(row.reasons)
                      .sort((a, b) => b[1] - a[1])
                      .map(([reason]) => reason)
                      .join("; ") || "no reason recorded"}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

    {#if plan.leadGaps.length}
      <section class="mt-8">
        <h2 class="font-semibold text-slate-900">
          Lead providers who never met their student ({plan.leadGaps.length})
        </h2>
        <p class="mt-1 text-sm text-slate-500">
          The lead provider named on the Minutes sheet has to take one session
          of each prescription every week. These did not fit.
        </p>
        <ul class="mt-3 flex flex-wrap gap-2 text-sm">
          {#each plan.leadGaps as gap (gap.student + gap.service)}
            <li
              class="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-red-900"
            >
              {gap.leadProvider} · {gap.student} · {gap.service}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section class="mt-8">
      <h2 class="font-semibold text-slate-900">Compliance</h2>
      <div
        class="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white"
      >
        <table class="w-full min-w-[44rem] text-sm">
          <thead class="bg-slate-50 text-left text-slate-600">
            <tr>
              <th class="px-3 py-2 font-medium">Student</th>
              <th class="px-3 py-2 font-medium">Service</th>
              <th class="px-3 py-2 font-medium">Required</th>
              <th class="px-3 py-2 font-medium">Scheduled</th>
              <th class="px-3 py-2 font-medium">Difference</th>
              <th class="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {#each plan.compliance as row (row.student + row.service)}
              <tr class="border-t border-slate-100">
                <td class="px-3 py-2 font-medium text-slate-800"
                  >{row.student}</td
                >
                <td class="px-3 py-2 text-slate-600">{row.service}</td>
                <td class="px-3 py-2 text-slate-600">{row.requiredMinutes}</td>
                <td class="px-3 py-2 text-slate-600">{row.scheduledMinutes}</td>
                <td class="px-3 py-2 text-slate-600">{row.difference}</td>
                <td
                  class="px-3 py-2 font-medium {row.status === 'OK'
                    ? 'text-green-700'
                    : row.status === 'PARTIAL'
                      ? 'text-amber-700'
                      : 'text-red-700'}"
                >
                  {row.status}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <p class="mt-8 text-sm text-slate-500">
      The school day is drawn from {formatTime(DAY_START)} to {formatTime(
        DAY_END,
      )}. Your file never leaves this computer.
    </p>
  {/if}
</main>
