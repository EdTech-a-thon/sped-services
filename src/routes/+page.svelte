<script lang="ts">
  import { asset, resolve } from "$app/paths";
  import { TEMPLATE_FILE_NAME, TEMPLATE_PATH } from "$lib/scheduling/template";
</script>

<svelte:head>
  <title>Service Scheduler</title>
  <meta
    name="description"
    content="Find the best times to pull students for special education services."
  />
</svelte:head>

<main class="flex flex-1 items-center justify-center px-6 py-16">
  <div class="max-w-xl text-center">
    <h1 class="text-4xl font-semibold text-slate-900">Service Scheduler</h1>
    <p class="mt-4 text-lg text-slate-600">
      Find the best times to pull students for special education services,
      without taking them out of the lessons they need most.
    </p>

    <div class="mt-8 flex flex-wrap justify-center gap-3">
      <a
        href={resolve("/schedule")}
        class="rounded-lg bg-green-800 px-6 py-3 font-medium text-white hover:bg-green-900"
      >
        Upload a workbook
      </a>
      <a
        href={resolve("/plan")}
        class="rounded-lg border border-green-800 bg-white px-6 py-3 font-medium text-green-900 hover:bg-green-50"
      >
        Plan a provider's week
      </a>
      <a
        href={resolve("/plan-colleen")}
        class="rounded-lg border border-green-800 bg-white px-6 py-3 font-medium text-green-900 hover:bg-green-50"
      >
        Plan the whole team's week
      </a>
      <a
        href={asset(TEMPLATE_PATH)}
        download={TEMPLATE_FILE_NAME}
        class="rounded-lg border border-slate-300 bg-white px-6 py-3 font-medium text-slate-700 hover:bg-slate-50"
      >
        Download the template
      </a>
    </div>

    <p class="mt-6 text-sm text-slate-500">
      New here? Start with the template — it has a <strong>Students</strong>
      sheet, a schedule sheet per class, and OT, PT and Resource sheets, all filled
      with example data to replace with your own.
    </p>
    <p class="mt-4 text-sm text-slate-500">
      Your file stays on your computer — nothing is ever uploaded.
    </p>
  </div>
</main>
