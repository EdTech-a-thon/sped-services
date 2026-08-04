<script lang="ts">
  import { onMount } from "svelte";
  import { asset } from "$app/paths";
  import PlanWeek from "$lib/components/PlanWeek.svelte";
  import RequirementWeek from "$lib/components/RequirementWeek.svelte";
  import {
    buildCandidatePool,
    candidateKey,
    findPartners,
    gradeName,
    previewGroup,
  } from "$lib/scheduling/explain";
  import { buildPlanExport, planFileName } from "$lib/scheduling/export";
  import {
    loadExcelJS,
    normalizeKey,
    parseWorkbook,
    WorkbookError,
  } from "$lib/scheduling/parse";
  import { buildPlan, leadProvider, providerNames } from "$lib/scheduling/plan";
  import { SPEECH_RULES } from "$lib/scheduling/rules";
  import { loadWorkbook, saveWorkbook } from "$lib/scheduling/storage";
  import { TEMPLATE_FILE_NAME, TEMPLATE_PATH } from "$lib/scheduling/template";
  import { formatRange } from "$lib/scheduling/time";
  import type {
    Candidate,
    Group,
    RuleSettings,
    SchedulerInput,
  } from "$lib/scheduling/types";

  /**
   * The knobs worth exposing; the rest of RuleSettings is not a plain number.
   * `rule` cross-references the Rules sheet row the knob comes from, so the
   * inputs and the rule list below them read as one thing.
   */
  const TUNABLE: {
    key: keyof RuleSettings;
    label: string;
    step: number;
    rule: number;
  }[] = [
    { key: "maxGroupSize", label: "Max group size", step: 1, rule: 7 },
    {
      key: "preferredGroupSize",
      label: "Preferred group size",
      step: 1,
      rule: 7,
    },
    { key: "gradeDeltaGenEd", label: "Grade span", step: 1, rule: 3 },
    {
      key: "sessionLengthDelta",
      label: "Session length span (min)",
      step: 5,
      rule: 11,
    },
    {
      key: "pullOutTransitionMinutes",
      label: "Transition (min)",
      step: 1,
      rule: 10,
    },
    {
      key: "maxMinutesPerDay",
      label: "Provider minutes/day",
      step: 15,
      rule: 8,
    },
    {
      key: "maxMinutesPerWeek",
      label: "Provider minutes/week",
      step: 15,
      rule: 8,
    },
  ];

  const CHECK_MARK = { pass: "✓", fail: "✗", warn: "!", "n/a": "—" };
  const CHECK_CLASS = {
    pass: "text-green-700",
    fail: "text-red-700",
    warn: "text-amber-700",
    "n/a": "text-slate-400",
  };

  let input = $state<SchedulerInput | null>(null);
  let fileBytes = $state<ArrayBuffer | null>(null);
  let provider = $state("");
  let overrides = $state<Partial<RuleSettings>>({});
  let selectedGroupId = $state<string | null>(null);
  let errorMessage = $state("");
  let busy = $state(false);
  let dragging = $state(false);
  let fileInput: HTMLInputElement | null = $state(null);

  // The explorer: which student is open, which of their prescriptions is in
  // focus, and who has been checked as a possible groupmate.
  let expandedStudent = $state<string | null>(null);
  let focusKey = $state<string | null>(null);
  let partnerKeys = $state<string[]>([]);

  const providers = $derived(input ? providerNames(input) : []);
  const plan = $derived(
    input && provider ? buildPlan(input, provider, overrides) : null,
  );
  const selected = $derived(
    plan?.groups.find((group) => group.id === selectedGroupId) ?? null,
  );

  /**
   * Every prescription in the workbook with its legal times, from the same
   * search the planner uses. Not filtered to the selected provider: a student
   * nobody shared can serve should say so rather than quietly disappear.
   */
  const pool = $derived(input ? buildCandidatePool(input) : []);
  const focus = $derived(
    pool.find((candidate) => candidateKey(candidate) === focusKey) ?? null,
  );
  const chosen = $derived(
    pool.filter((candidate) => partnerKeys.includes(candidateKey(candidate))),
  );
  const partners = $derived(
    focus && plan ? findPartners(focus, chosen, pool, plan.settings) : [],
  );
  const preview = $derived(focus ? previewGroup(focus, chosen) : null);
  /** Checked students a rule change has since made ineligible. */
  const brokenChoices = $derived(
    partners.filter(
      (partner) =>
        !partner.eligible &&
        partnerKeys.includes(candidateKey(partner.candidate)),
    ),
  );

  const prescriptionsFor = (name: string): Candidate[] =>
    pool.filter(
      (candidate) =>
        normalizeKey(candidate.student.name) === normalizeKey(name),
    );

  const bookingsFor = (name: string) =>
    input?.services.filter(
      (session) => normalizeKey(session.student) === normalizeKey(name),
    ) ?? [];

  /** The group the auto-planner actually put this prescription in, if any. */
  const plannerGroup = $derived.by(() => {
    if (!focus || !plan) return null;
    return (
      plan.groups.find(
        (group) =>
          normalizeKey(group.service) ===
            normalizeKey(focus.requirement.service) &&
          group.model === focus.requirement.model &&
          group.groupType === focus.requirement.groupType &&
          group.members.some(
            (member) =>
              normalizeKey(member) === normalizeKey(focus.student.name),
          ),
      ) ?? null
    );
  });

  function focusOn(candidate: Candidate) {
    const key = candidateKey(candidate);
    focusKey = focusKey === key ? null : key;
    // A different prescription means a different group; start it empty.
    partnerKeys = [];
  }

  function togglePartner(key: string) {
    partnerKeys = partnerKeys.includes(key)
      ? partnerKeys.filter((other) => other !== key)
      : [...partnerKeys, key];
  }

  /** Preselect whoever the planner grouped with this student. */
  function usePlannerGroup() {
    const group = plannerGroup;
    if (!group) return;
    partnerKeys = partners
      .filter((partner) =>
        group.members.some(
          (member) =>
            normalizeKey(member) ===
            normalizeKey(partner.candidate.student.name),
        ),
      )
      .map((partner) => candidateKey(partner.candidate));
  }

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
      expandedStudent = null;
      focusKey = null;
      partnerKeys = [];
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

<!-- Wider than the other pages: the explorer puts three columns and a five-day
     calendar side by side, and at 6xl the calendar loses Thursday and Friday. -->
<main class="mx-auto w-full max-w-[92rem] flex-1 px-4 py-10">
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

    <section class="mt-4 rounded-xl border border-slate-200 bg-white px-5 py-4">
      <div class="flex flex-wrap items-baseline justify-between gap-3">
        <h2 class="font-semibold text-slate-900">The rules being applied</h2>
        <button
          type="button"
          onclick={() => (overrides = {})}
          disabled={!Object.keys(overrides).length}
          class="rounded-lg border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          Reset to workbook values
        </button>
      </div>
      <p class="mt-1 text-sm text-slate-500">
        Defaults, overridden by anything the Rules sheet fills in. Change one
        and everything below — the groups, and who may join whom — updates
        immediately.
      </p>
      <div class="mt-3 flex flex-wrap gap-4">
        {#each TUNABLE as knob (knob.key)}
          <label class="text-sm text-slate-600">
            <span class="block font-medium text-slate-700">
              {knob.label}
              <span class="font-normal text-slate-400">· rule {knob.rule}</span>
            </span>
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

      <details class="mt-4 rounded-lg border border-slate-200 px-4 py-3">
        <summary class="cursor-pointer font-medium text-slate-800">
          All {SPEECH_RULES.length} rules, and which are enforced
        </summary>
        <ul class="mt-2 space-y-1 text-sm">
          {#each SPEECH_RULES as rule (rule.row)}
            <li class={rule.enforced ? "text-slate-700" : "text-slate-400"}>
              <span class="text-slate-400">{rule.row}.</span>
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

    <section class="mt-8">
      <h2 class="font-semibold text-slate-900">Explore a student</h2>
      <p class="mt-1 max-w-3xl text-sm text-slate-500">
        Pick a student, then one of their prescribed minutes rows. You get every
        other student who could share that group — eligible or not, each with
        the rule that decides it — and a calendar of the times the service could
        be delivered. Tick a name to narrow the calendar to when they are both
        free.
      </p>

      <div class="mt-4 grid gap-4 lg:grid-cols-[14rem_22rem_minmax(0,1fr)]">
        <div class="rounded-xl border border-slate-200 bg-white">
          <h3
            class="border-b border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700"
          >
            Students
          </h3>
          <ul class="max-h-[70vh] overflow-auto py-1">
            {#each input.students as student (student.name)}
              {@const rows = prescriptionsFor(student.name)}
              <li>
                <button
                  type="button"
                  onclick={() =>
                    (expandedStudent =
                      expandedStudent === student.name ? null : student.name)}
                  aria-expanded={expandedStudent === student.name}
                  class="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left hover:bg-slate-50"
                >
                  <span class="font-medium text-slate-800">{student.name}</span>
                  <span class="text-xs whitespace-nowrap text-slate-500">
                    {gradeName(student.grade)} · {rows.length}
                  </span>
                </button>
                {#if expandedStudent === student.name}
                  <ul class="ml-3 border-l-2 border-slate-200 pb-1 pl-2">
                    {#each rows as row (candidateKey(row))}
                      {@const key = candidateKey(row)}
                      <li>
                        <button
                          type="button"
                          onclick={() => focusOn(row)}
                          aria-pressed={focusKey === key}
                          class="w-full rounded-md px-2 py-1 text-left text-sm {focusKey ===
                          key
                            ? 'bg-green-50 ring-1 ring-green-700'
                            : 'hover:bg-slate-50'}"
                        >
                          <span class="block font-medium text-slate-800">
                            {row.requirement.service}
                          </span>
                          <span class="block text-xs text-slate-500">
                            {row.requirement.minutesPerWeek} min/wk ·
                            {row.requirement.sessionLength} min ×
                            {row.requirement.sessionsPerWeek}
                          </span>
                          <span class="block text-xs text-slate-400">
                            {row.requirement.groupType} · {row.requirement
                              .model}
                          </span>
                        </button>
                      </li>
                    {:else}
                      <li class="px-2 py-1 text-xs text-slate-400">
                        No rows on the Minutes sheet.
                      </li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ul>
        </div>

        {#if focus && preview}
          {@const enough = preview.distinctDays >= preview.sessionsPerWeek}
          <div class="rounded-xl border border-slate-200 bg-white">
            <h3
              class="border-b border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700"
            >
              Who could join {focus.student.name} for {focus.requirement
                .service}
            </h3>
            <p class="px-3 pt-2 text-xs text-slate-500">
              {preview.members.length} of {plan.settings.maxGroupSize} selected ·
              {preview.sessionLength} min ·
              {focus.requirement.groupType} · {focus.requirement.model}
            </p>
            {#if plannerGroup}
              <p
                class="mx-3 mt-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-600"
              >
                {#if plannerGroup.members.length > 1}
                  The planner grouped this with
                  <strong>
                    {plannerGroup.members
                      .filter((member) => member !== focus.student.name)
                      .join(", ")}
                  </strong>.
                  <button
                    type="button"
                    onclick={usePlannerGroup}
                    class="font-medium text-green-800 underline hover:text-green-900"
                  >
                    Select them
                  </button>
                {:else}
                  The planner left this as a group of one.
                {/if}
              </p>
            {/if}
            {#if brokenChoices.length}
              <p
                class="mx-3 mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-900"
              >
                {brokenChoices
                  .map((partner) => partner.candidate.student.name)
                  .join(", ")} no longer fit under the current rules. Untick them
                or loosen the rule above.
              </p>
            {/if}
            <ul class="max-h-[60vh] overflow-auto p-2">
              {#each partners as partner (candidateKey(partner.candidate))}
                {@const key = candidateKey(partner.candidate)}
                {@const checked = partnerKeys.includes(key)}
                <li
                  class="mt-1 rounded-lg border px-2 py-1.5 {checked
                    ? 'border-green-700 bg-green-50'
                    : partner.eligible
                      ? 'border-slate-200'
                      : 'border-slate-100 bg-slate-50'}"
                >
                  <label class="flex items-start gap-2">
                    <input
                      type="checkbox"
                      {checked}
                      disabled={!partner.eligible && !checked}
                      onchange={() => togglePartner(key)}
                      class="mt-1 disabled:opacity-40"
                    />
                    <span class="min-w-0 flex-1">
                      <span class="flex items-baseline justify-between gap-2">
                        <span
                          class="font-medium {partner.eligible
                            ? 'text-slate-900'
                            : 'text-slate-500'}"
                        >
                          {partner.candidate.student.name}
                        </span>
                        <span class="text-xs whitespace-nowrap text-slate-500">
                          {partner.candidate.requirement.sessionLength} min ×
                          {partner.candidate.requirement.sessionsPerWeek}
                        </span>
                      </span>
                      <span class="block text-xs text-slate-500">
                        {gradeName(partner.candidate.student.grade)} ·
                        {partner.candidate.student.className}
                      </span>
                      {#if partner.eligible}
                        <span class="block text-xs text-green-800">
                          Can group — {partner.sharedWindows.length} shared window{partner
                            .sharedWindows.length === 1
                            ? ""
                            : "s"}
                        </span>
                      {:else}
                        {#each partner.blockers as blocker (blocker.label)}
                          <span class="block text-xs text-red-700">
                            {blocker.label}: {blocker.detail}
                            {#if blocker.rule}<span class="text-slate-400"
                                >(rule {blocker.rule})</span
                              >{/if}
                          </span>
                        {/each}
                      {/if}
                    </span>
                  </label>
                  <details class="mt-1 pl-6">
                    <summary
                      class="cursor-pointer text-xs text-slate-500 hover:text-slate-700"
                    >
                      Every rule checked
                    </summary>
                    <ul class="mt-1 space-y-0.5">
                      {#each partner.checks as check (check.label)}
                        <li class="text-xs {CHECK_CLASS[check.status]}">
                          {CHECK_MARK[check.status]}
                          <strong class="font-medium">{check.label}</strong> —
                          {check.detail}
                        </li>
                      {/each}
                    </ul>
                  </details>
                </li>
              {:else}
                <li class="px-2 py-3 text-sm text-slate-500">
                  Nobody else is prescribed {focus.requirement.service}, so this
                  is a group of one.
                </li>
              {/each}
            </ul>
          </div>

          <div>
            <p class="text-sm text-slate-700">
              <strong>
                {preview.members
                  .map((member) => member.student.name)
                  .join(" + ")}
              </strong>
              · {preview.sessionLength} min ·
              {preview.sharedWindows.length} usable window{preview.sharedWindows
                .length === 1
                ? ""
                : "s"} across {preview.distinctDays} day{preview.distinctDays ===
              1
                ? ""
                : "s"}.
              <span class={enough ? "text-slate-500" : "text-amber-700"}>
                Needs {preview.sessionsPerWeek} sessions a week on different days
                (rule 2){enough ? "." : " — not enough distinct days."}
              </span>
            </p>
            <ul
              class="mt-2 mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-600"
            >
              <li class="flex items-center gap-2">
                <span class="h-4 w-4 shrink-0 rounded bg-green-700"></span>
                {preview.members.length > 1
                  ? "Everyone selected is free"
                  : `${focus.student.name} could be served here`}
              </li>
              <li class="flex items-center gap-2">
                <span class="h-4 w-4 shrink-0 rounded bg-green-200"></span>
                Free, but too short
              </li>
              {#if preview.members.length > 1}
                <li class="flex items-center gap-2">
                  <span class="h-4 w-4 shrink-0 rounded bg-amber-100"></span>
                  Only {focus.student.name} is free
                </li>
              {/if}
              <li class="flex items-center gap-2">
                <span class="h-4 w-4 shrink-0 rounded bg-[#f4c7c3]"></span>
                Booked elsewhere
              </li>
              <li class="flex items-center gap-2">
                <span class="h-4 w-4 shrink-0 rounded bg-slate-100"></span>
                Cannot be pulled
              </li>
            </ul>
            <RequirementWeek
              {preview}
              student={focus.student}
              schedule={input.classes[focus.student.classKey]}
              bookings={bookingsFor(focus.student.name)}
              startMinutes={7 * 60 + 30}
              endMinutes={15 * 60}
            />
            <ul class="mt-3 grid gap-1 text-sm text-slate-700 sm:grid-cols-2">
              {#each preview.sharedWindows as window (window.day + window.start)}
                <li>
                  <strong>{window.day}</strong>
                  {formatRange(window.start, window.end)}
                  <span class="text-slate-500">
                    — {window.subjects.join(", ")}
                  </span>
                </li>
              {:else}
                <li class="text-slate-500">
                  No time this selection can all meet for
                  {preview.sessionLength} minutes.
                </li>
              {/each}
            </ul>
          </div>
        {:else}
          <p
            class="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-sm text-slate-500 lg:col-span-2"
          >
            Pick a student on the left, then one of their prescriptions, to see
            who could join them and when.
          </p>
        {/if}
      </div>
    </section>

    <div class="mt-8 grid gap-6 lg:grid-cols-[22rem_1fr]">
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
          <li class="flex items-center gap-2">
            <span class="relative h-4 w-4 shrink-0 rounded bg-[#b7e1cd]">
              <span class="absolute inset-0 rounded bg-amber-300/55"></span>
            </span>
            Legal, but another group has it
          </li>
        </ul>
        <PlanWeek
          {plan}
          {selected}
          startMinutes={7 * 60 + 30}
          endMinutes={15 * 60}
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
