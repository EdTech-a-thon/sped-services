<script lang="ts">
  import { onMount } from "svelte";
  import { asset } from "$app/paths";
  import PlanWeek from "$lib/components/PlanWeek.svelte";
  import { buildPlanExport, planFileName } from "$lib/scheduling/export";
  import {
    loadExcelJS,
    parseWorkbook,
    WorkbookError,
  } from "$lib/scheduling/parse";
  import { buildPlan, leadProvider, providerNames } from "$lib/scheduling/plan";
  import { SPEECH_RULES } from "$lib/scheduling/rules";
  import { loadWorkbook, saveWorkbook } from "$lib/scheduling/storage";
  import { TEMPLATE_FILE_NAME, TEMPLATE_PATH } from "$lib/scheduling/template";
  import { formatRange } from "$lib/scheduling/time";
  import type {
    Group,
    RuleSettings,
    SchedulerInput,
  } from "$lib/scheduling/types";

  /** The knobs worth exposing; the rest of RuleSettings is not a plain number. */
  const TUNABLE: { key: keyof RuleSettings; label: string; step: number }[] = [
    { key: "maxGroupSize", label: "Max group size", step: 1 },
    { key: "preferredGroupSize", label: "Preferred group size", step: 1 },
    { key: "gradeDeltaGenEd", label: "Grade span", step: 1 },
    { key: "sessionLengthDelta", label: "Session length span (min)", step: 5 },
    { key: "pullOutTransitionMinutes", label: "Transition (min)", step: 1 },
    { key: "maxMinutesPerDay", label: "Provider minutes/day", step: 15 },
    { key: "maxMinutesPerWeek", label: "Provider minutes/week", step: 15 },
  ];

  let input = $state<SchedulerInput | null>(null);
  let fileBytes = $state<ArrayBuffer | null>(null);
  let provider = $state("");
  let overrides = $state<Partial<RuleSettings>>({});
  let selectedGroupId = $state<string | null>(null);
  let errorMessage = $state("");
  let busy = $state(false);
  let dragging = $state(false);
  let fileInput: HTMLInputElement | null = $state(null);

  const providers = $derived(input ? providerNames(input) : []);
  const plan = $derived(
    input && provider ? buildPlan(input, provider, overrides) : null,
  );
  const selected = $derived(
    plan?.groups.find((group) => group.id === selectedGroupId) ?? null,
  );

  const placedCount = (group: Group) =>
    plan?.placements.filter((placement) => placement.groupId === group.id)
      .length ?? 0;

  const percent = $derived(
    plan && plan.capacity.availableMinutesPerWeek
      ? Math.round(
          (100 * plan.capacity.groupedMinutesPerWeek) /
            plan.capacity.availableMinutesPerWeek,
        )
      : 0,
  );

  async function readFile(
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
      provider = leadProvider(parsed);
      overrides = {};
      selectedGroupId = null;
      if (!saved) saveWorkbook(fileName, bytes);
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

  async function download() {
    if (!input || !plan) return;
    busy = true;
    try {
      const blob = await buildPlanExport(input, plan, fileBytes ?? undefined);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = planFileName(input.fileName, plan.provider);
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

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      errorMessage = `"${file.name}" is not an .xlsx file. Export your Google Sheet as Microsoft Excel (.xlsx) first.`;
      return;
    }
    await readFile(await file.arrayBuffer(), file.name, false);
  }

  function setOverride(key: keyof RuleSettings, value: string) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) overrides = { ...overrides, [key]: parsed };
  }

  onMount(() => {
    void loadExcelJS().catch(() => {});
    const stored = loadWorkbook();
    if (stored) void readFile(stored.bytes, stored.fileName, true);
  });
</script>

<svelte:head>
  <title>Plan a provider's week · Service Scheduler</title>
  <meta
    name="description"
    content="Form service groups and place their sessions across the week for one provider."
  />
</svelte:head>

<main class="mx-auto w-full max-w-6xl flex-1 px-4 py-10">
  <h1 class="text-3xl font-semibold text-slate-900">Plan a provider's week</h1>
  <p class="mt-2 max-w-2xl text-slate-600">
    Groups students by service and finds legal times for each group to meet.
    Click a group to see every time it could legally meet. Nothing here reduces
    a student's prescribed minutes — whatever will not fit is reported instead.
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
          bind:this={fileInput}
          type="file"
          accept=".xlsx"
          class="sr-only"
          onchange={(event) => handleFile(event.currentTarget.files?.[0])}
        />
      </label>
      <p class="mx-auto mt-6 max-w-lg text-sm text-slate-500">
        Planning also needs the <strong>Minutes</strong>,
        <strong>Service Matches</strong>, <strong>Subject</strong> and
        <strong>Staff</strong> sheets.
      </p>
      <p class="mt-2 text-sm text-slate-500">
        <a
          href={asset(TEMPLATE_PATH)}
          download={TEMPLATE_FILE_NAME}
          class="font-medium text-green-800 underline hover:text-green-900"
        >
          Download the template
        </a>
      </p>
    </div>
    {#if busy}
      <p class="mt-4 text-center text-slate-500">Reading workbook…</p>
    {/if}
  {:else if plan}
    <section
      class="mt-6 flex flex-wrap items-end justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4"
    >
      <label class="text-sm text-slate-600">
        <span class="block font-medium text-slate-700">Provider</span>
        <select
          bind:value={provider}
          onchange={() => (selectedGroupId = null)}
          class="mt-1 rounded-lg border border-slate-300 px-3 py-1.5"
        >
          {#each providers as name (name)}
            <option value={name}>{name}</option>
          {/each}
        </select>
      </label>
      <p class="text-sm text-slate-500">
        {input.fileName} · {plan.capacity.requirementCount} prescriptions · {plan
          .groups.length} groups · {plan.placements.length} sessions placed
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

    <section
      class="mt-4 rounded-xl border px-5 py-4 {percent > 100
        ? 'border-amber-300 bg-amber-50'
        : 'border-slate-200 bg-white'}"
    >
      <h2 class="font-semibold text-slate-900">
        Demand vs capacity: {percent}%
      </h2>
      <p class="mt-1 text-sm text-slate-700">
        {plan.capacity.studentMinutesPerWeek} prescribed student-minutes a week over
        {plan.capacity.studentSessionsPerWeek} student-sessions. Grouped as tightly
        as the rules allow that still needs
        <strong>{plan.capacity.groupedMinutesPerWeek} minutes</strong>
        of {plan.provider}'s time against
        <strong>{plan.capacity.availableMinutesPerWeek} available</strong>
        (rule 8). {plan.capacity.scheduledMinutesPerWeek} minutes were actually placed.
      </p>
      {#if percent > 100}
        <p class="mt-2 text-sm text-amber-900">
          More is prescribed than one provider can deliver, so this schedule is
          partial by arithmetic, not by choice. The shortfall is listed below.
        </p>
      {/if}
    </section>

    {#if input.warnings.length}
      <details
        class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900"
      >
        <summary class="cursor-pointer font-medium">
          {input.warnings.length} things to check in your workbook
        </summary>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-sm">
          {#each input.warnings as warning (warning)}
            <li>{warning}</li>
          {/each}
        </ul>
      </details>
    {/if}

    <div class="mt-6 grid gap-6 lg:grid-cols-[22rem_1fr]">
      <section>
        <h2 class="font-semibold text-slate-900">
          Groups ({plan.groups.length})
        </h2>
        <p class="mt-1 text-sm text-slate-500">
          Click a group to highlight every time it could legally meet.
        </p>
        <ul class="mt-3 space-y-2">
          {#each plan.groups as group (group.id)}
            {@const placed = placedCount(group)}
            <li>
              <button
                type="button"
                onclick={() =>
                  (selectedGroupId =
                    selectedGroupId === group.id ? null : group.id)}
                aria-pressed={selectedGroupId === group.id}
                class="w-full rounded-lg border px-3 py-2 text-left transition-colors {selectedGroupId ===
                group.id
                  ? 'border-green-700 bg-green-50'
                  : 'border-slate-200 bg-white hover:bg-slate-50'}"
              >
                <span class="flex items-baseline justify-between gap-2">
                  <span class="font-medium text-slate-900">{group.service}</span
                  >
                  <span
                    class="text-sm {placed < group.sessionsPerWeek
                      ? 'text-amber-700'
                      : 'text-slate-500'}"
                  >
                    {placed}/{group.sessionsPerWeek} placed
                  </span>
                </span>
                <span class="mt-0.5 block text-sm text-slate-600">
                  {group.members.join(", ")}
                </span>
                <span class="mt-0.5 block text-xs text-slate-500">
                  {group.groupType} · {group.model} · {group.sessionLength} min ·
                  {group.sharedWindows.length} legal windows
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </section>

      <section>
        <h2 class="font-semibold text-slate-900">
          {plan.provider}'s week
          {#if selected}
            <span class="font-normal text-slate-500">
              — showing legal times for {selected.service} ({selected.members.join(
                ", ",
              )})
            </span>
          {/if}
        </h2>
        <ul
          class="mt-2 mb-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-slate-600"
        >
          <li class="flex items-center gap-2">
            <span class="h-4 w-4 shrink-0 rounded bg-[#b7e1cd]"></span>
            Scheduled session
          </li>
          <li class="flex items-center gap-2">
            <span class="h-4 w-4 shrink-0 rounded bg-green-700"></span>
            Selected group
          </li>
          <li class="flex items-center gap-2">
            <span class="h-4 w-4 shrink-0 rounded bg-amber-100"></span>
            Legal for the selected group
          </li>
        </ul>
        <PlanWeek
          {plan}
          {selected}
          startMinutes={7 * 60 + 30}
          endMinutes={15 * 60}
          slotMinutes={15}
        />
      </section>
    </div>

    {#if plan.unplaced.length}
      <section class="mt-8">
        <h2 class="font-semibold text-slate-900">
          Not scheduled ({plan.unplaced.length})
        </h2>
        <p class="mt-1 text-sm text-slate-500">
          Prescribed minutes that did not fit. They are reported, not reduced.
        </p>
        <div class="mt-3 overflow-x-auto rounded-xl border border-slate-200">
          <table class="w-full border-collapse bg-white text-sm">
            <thead class="bg-slate-50 text-left text-slate-600">
              <tr>
                <th class="px-3 py-2 font-medium">Student</th>
                <th class="px-3 py-2 font-medium">Service</th>
                <th class="px-3 py-2 font-medium">Short by</th>
                <th class="px-3 py-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {#each plan.unplaced as row (row.student + row.service)}
                <tr class="border-t border-slate-100">
                  <td class="px-3 py-2">{row.student}</td>
                  <td class="px-3 py-2">{row.service}</td>
                  <td class="px-3 py-2 whitespace-nowrap">
                    {row.missingSessions} sessions · {row.missingMinutes} min
                  </td>
                  <td class="px-3 py-2 text-slate-600">
                    {Object.keys(row.reasons).join("; ")}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

    <section class="mt-8">
      <h2 class="font-semibold text-slate-900">Rule settings</h2>
      <p class="mt-1 text-sm text-slate-500">
        Defaults, overridden by anything the Rules sheet fills in. Change one to
        replan immediately.
      </p>
      <div class="mt-3 flex flex-wrap gap-4">
        {#each TUNABLE as knob (knob.key)}
          <label class="text-sm text-slate-600">
            <span class="block font-medium text-slate-700">{knob.label}</span>
            <input
              type="number"
              step={knob.step}
              min="0"
              value={plan.settings[knob.key] as number}
              onchange={(event) =>
                setOverride(knob.key, event.currentTarget.value)}
              class="mt-1 w-32 rounded-lg border border-slate-300 px-3 py-1.5"
            />
          </label>
        {/each}
      </div>

      <details
        class="mt-4 rounded-lg border border-slate-200 bg-white px-4 py-3"
      >
        <summary class="cursor-pointer font-medium text-slate-800">
          Which rules this plan applies
        </summary>
        <ul class="mt-2 space-y-1 text-sm">
          {#each SPEECH_RULES as rule (rule.row)}
            <li class={rule.enforced ? "text-slate-700" : "text-slate-400"}>
              {rule.enforced ? "✓" : "—"}
              {rule.summary}
              {#if !rule.enforced}<span class="italic">
                  (not applied yet)</span
                >{/if}
            </li>
          {/each}
        </ul>
        <p class="mt-3 text-sm text-slate-500">
          Only the Speech rules are modelled. The Staff, Instruction and
          Compliance sections of the Rules sheet — parapro coverage, when lunch
          and break may fall, co-teach classroom assignment — are not checked,
          so this is a draft to review, not a compliance guarantee.
        </p>
      </details>
    </section>

    {#if plan.unseenStudents.length}
      <p
        class="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      >
        Rule 13 says the lead provider sees every student every week.
        {plan.provider} never meets: {plan.unseenStudents.join(", ")}.
      </p>
    {/if}

    <section class="mt-8">
      <h2 class="font-semibold text-slate-900">Compliance</h2>
      <div class="mt-3 overflow-x-auto rounded-xl border border-slate-200">
        <table class="w-full border-collapse bg-white text-sm">
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
                <td class="px-3 py-2">{row.student}</td>
                <td class="px-3 py-2">{row.service}</td>
                <td class="px-3 py-2">{row.requiredMinutes}</td>
                <td class="px-3 py-2">{row.scheduledMinutes}</td>
                <td class="px-3 py-2">{row.difference}</td>
                <td
                  class="px-3 py-2 {row.status === 'OK'
                    ? 'text-green-800'
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

    {#if selected}
      <section class="mt-8">
        <h2 class="font-semibold text-slate-900">
          Legal times for {selected.service} — {selected.members.join(", ")}
        </h2>
        <ul class="mt-2 grid gap-1 text-sm text-slate-700 sm:grid-cols-2">
          {#each selected.sharedWindows as window (window.day + window.start)}
            <li>
              <strong>{window.day}</strong>
              {formatRange(window.start, window.end)}
              <span class="text-slate-500">— {window.subjects.join(", ")}</span>
            </li>
          {:else}
            <li class="text-slate-500">No time this group can all meet.</li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</main>
