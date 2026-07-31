<script lang="ts">
  import { onMount } from "svelte";
  import { asset } from "$app/paths";
  import ScheduleGrid from "$lib/components/ScheduleGrid.svelte";
  import { buildSchedule, defaultSettings } from "$lib/scheduling/build";
  import { buildExport, exportFileName } from "$lib/scheduling/export";
  import {
    loadExcelJS,
    parseWorkbook,
    WorkbookError,
  } from "$lib/scheduling/parse";
  import {
    clearStorage,
    loadSettings,
    loadWorkbook,
    saveSettings,
    saveWorkbook,
  } from "$lib/scheduling/storage";
  import { TEMPLATE_FILE_NAME, TEMPLATE_PATH } from "$lib/scheduling/template";
  import { fromTimeInput, toTimeInput } from "$lib/scheduling/time";
  import {
    DAYS,
    type Day,
    type GridSettings,
    type SchedulerInput,
  } from "$lib/scheduling/types";

  const SLOT_CHOICES = [10, 15, 20, 30, 60];

  let input = $state<SchedulerInput | null>(null);
  let fileBytes = $state<ArrayBuffer | null>(null);
  let settings = $state<GridSettings>({
    startMinutes: 7 * 60 + 30,
    endMinutes: 15 * 60,
    slotMinutes: 15,
  });
  let activeDay = $state<Day>("Monday");
  let errorMessage = $state("");
  let busy = $state(false);
  let dragging = $state(false);
  let restored = $state(false);
  let offlineReady = $state(false);
  let fileInput: HTMLInputElement | null = $state(null);

  const result = $derived(input ? buildSchedule(input, settings) : null);
  const activeGrid = $derived(
    result?.grids.find((grid) => grid.day === activeDay) ?? null,
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
      restored = saved;
      settings = (saved && loadSettings()) || defaultSettings(parsed);
      if (!saved) saveWorkbook(fileName, bytes);
    } catch (error) {
      input = null;
      fileBytes = null;
      // Anything that is not a WorkbookError came from deep inside the parser,
      // so show something a teacher can act on instead of the raw message.
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
    await readFile(await file.arrayBuffer(), file.name, false);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    void handleFile(event.dataTransfer?.files?.[0]);
  }

  async function download() {
    if (!result || !input) return;
    busy = true;
    try {
      const blob = await buildExport(result, fileBytes ?? undefined);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFileName(input.fileName);
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

  function startOver() {
    clearStorage();
    input = null;
    fileBytes = null;
    errorMessage = "";
    restored = false;
    if (fileInput) fileInput.value = "";
  }

  function updateTime(field: "startMinutes" | "endMinutes", value: string) {
    const minutes = fromTimeInput(value);
    if (minutes != null) settings = { ...settings, [field]: minutes };
  }

  $effect(() => {
    if (input) saveSettings(settings);
  });

  onMount(() => {
    // Pull the spreadsheet reader down now, while there is probably still a
    // connection, rather than at the moment a workbook is dropped.
    void loadExcelJS().catch(() => {});

    if (navigator.serviceWorker) {
      void navigator.serviceWorker.ready.then(() => (offlineReady = true));
    }

    const stored = loadWorkbook();
    if (stored) void readFile(stored.bytes, stored.fileName, true);
  });
</script>

<svelte:head>
  <title>Build schedules · Service Scheduler</title>
  <meta
    name="description"
    content="Upload your scheduling workbook and build the weekly service grids in your browser."
  />
</svelte:head>

<main class="mx-auto w-full max-w-6xl flex-1 px-4 py-10">
  <h1 class="text-3xl font-semibold text-slate-900">Build schedules</h1>
  <p class="mt-2 max-w-2xl text-slate-600">
    Upload your scheduling workbook to see, day by day, when each student can be
    pulled for services. Everything runs in this browser tab — your file is
    never uploaded anywhere.
  </p>

  {#if offlineReady}
    <p class="mt-2 text-sm text-slate-500">
      This page is saved on this computer and keeps working without internet.
    </p>
  {/if}

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
      ondrop={onDrop}
      class="mt-6 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors {dragging
        ? 'border-green-600 bg-green-50'
        : 'border-slate-300 bg-white'}"
    >
      <p class="text-lg font-medium text-slate-800">
        Drop your <code class="rounded bg-slate-100 px-1 py-0.5">.xlsx</code> workbook
        here
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
        The workbook needs a <strong>Students</strong> sheet, one sheet per class
        matching the class names, and a sheet per service (OT, PT, Resource…) laid
        out in day columns.
      </p>
      <p class="mt-2 text-sm text-slate-500">
        Don't have one yet?
        <a
          href={asset(TEMPLATE_PATH)}
          download={TEMPLATE_FILE_NAME}
          class="font-medium text-green-800 underline hover:text-green-900"
        >
          Download the template
        </a>
        and fill it in.
      </p>
    </div>
    {#if busy}
      <p class="mt-4 text-center text-slate-500">Reading workbook…</p>
    {/if}
  {:else if result}
    <section
      class="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4"
    >
      <div>
        <p class="font-medium text-slate-900">{input.fileName}</p>
        <p class="text-sm text-slate-500">
          {input.students.length} students · {Object.keys(input.classes).length} classes
          {#if input.serviceNames.length}
            · {input.serviceNames.join(", ")}
          {/if}
          {#if restored}
            <span class="text-slate-400">· restored from this browser</span>
          {/if}
        </p>
      </div>
      <div class="flex gap-2">
        <button
          type="button"
          onclick={download}
          disabled={busy}
          class="rounded-lg bg-green-800 px-4 py-2 font-medium text-white hover:bg-green-900 disabled:opacity-50"
        >
          Export to Excel
        </button>
        <button
          type="button"
          onclick={startOver}
          class="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
        >
          Start over
        </button>
      </div>
    </section>

    {#if input.warnings.length}
      <details
        class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900"
      >
        <summary class="cursor-pointer font-medium">
          {input.warnings.length}
          {input.warnings.length === 1 ? "thing" : "things"} to check in your workbook
        </summary>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-sm">
          {#each input.warnings as warning (warning)}
            <li>{warning}</li>
          {/each}
        </ul>
      </details>
    {/if}

    <section class="mt-6 flex flex-wrap items-end gap-5">
      <label class="text-sm text-slate-600">
        <span class="block font-medium text-slate-700">Day starts</span>
        <input
          type="time"
          value={toTimeInput(settings.startMinutes)}
          onchange={(event) =>
            updateTime("startMinutes", event.currentTarget.value)}
          class="mt-1 rounded-lg border border-slate-300 px-3 py-1.5"
        />
      </label>
      <label class="text-sm text-slate-600">
        <span class="block font-medium text-slate-700">Day ends</span>
        <input
          type="time"
          value={toTimeInput(settings.endMinutes)}
          onchange={(event) =>
            updateTime("endMinutes", event.currentTarget.value)}
          class="mt-1 rounded-lg border border-slate-300 px-3 py-1.5"
        />
      </label>
      <label class="text-sm text-slate-600">
        <span class="block font-medium text-slate-700">Row length</span>
        <select
          bind:value={settings.slotMinutes}
          class="mt-1 rounded-lg border border-slate-300 px-3 py-1.5"
        >
          {#each SLOT_CHOICES as minutes (minutes)}
            <option value={minutes}>{minutes} minutes</option>
          {/each}
        </select>
      </label>

      <ul class="flex flex-wrap gap-x-4 gap-y-2 text-sm text-slate-600">
        <li class="flex items-center gap-2">
          <span
            class="h-4 w-4 shrink-0 rounded border border-slate-300 bg-[#b7e1cd]"
          ></span>
          Can be pulled
        </li>
        <li class="flex items-center gap-2">
          <span
            class="h-4 w-4 shrink-0 rounded border border-slate-300 bg-[#f4c7c3]"
          ></span>
          Keep in class
        </li>
        <li class="flex items-center gap-2">
          <span
            class="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-slate-300 bg-[#f4c7c3] text-[10px] italic"
            >i</span
          >
          Already with a provider
        </li>
      </ul>
    </section>

    <div class="mt-5 flex flex-wrap gap-1 border-b border-slate-200">
      {#each DAYS as day (day)}
        <button
          type="button"
          onclick={() => (activeDay = day)}
          class="-mb-px border-b-2 px-4 py-2 font-medium {activeDay === day
            ? 'border-green-800 text-green-900'
            : 'border-transparent text-slate-500 hover:text-slate-800'}"
        >
          {day}
        </button>
      {/each}
    </div>

    <div class="mt-4">
      {#if activeGrid && activeGrid.slots.length}
        <ScheduleGrid grid={activeGrid} students={result.students} />
      {:else}
        <p
          class="rounded-lg border border-slate-200 bg-white px-4 py-6 text-slate-600"
        >
          No time slots to show. Check that the day starts before it ends.
        </p>
      {/if}
    </div>
  {/if}
</main>
