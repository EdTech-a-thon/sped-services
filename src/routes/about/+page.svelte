<script lang="ts">
  import edtechathonLogo from "$lib/assets/logo.svg";
  import participants from "$lib/assets/2026participants.jpg";
</script>

<svelte:head>
  <title>About · Service Scheduler</title>
  <meta
    name="description"
    content="Service Scheduler is a free tool from the EdTech-a-thon, a community of builders making free tools for classrooms."
  />
</svelte:head>

<main class="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
  <h1 class="mb-2 text-2xl font-bold">About</h1>
  <p class="mb-6 text-sm text-slate-600">
    A scheduling tool built for the teachers and specialists who share students.
  </p>

  <section class="mb-6 rounded-lg bg-white p-5 ring-1 ring-slate-200">
    <div class="mb-2 flex items-center gap-3">
      <img src={edtechathonLogo} alt="" class="h-10 w-10 shrink-0" />
      <h2 class="text-lg font-semibold">From the EdTech-a-thon</h2>
    </div>
    <p class="text-sm leading-relaxed text-slate-700">
      Service Scheduler is a project from the
      <a
        href="https://edtechathon.com"
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium text-amber-700 underline-offset-4 hover:underline"
      >
        EdTech-a-thon
      </a>, a community of builders making free tools for classrooms. Learn more
      about who we are and what else we're building at
      <a
        href="https://edtechathon.com"
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium text-amber-700 underline-offset-4 hover:underline"
      >
        edtechathon.com
      </a>.
    </p>

    <figure
      class="mx-auto mt-6 w-full max-w-lg -rotate-1 rounded-sm bg-white p-3 pb-6 shadow-lg ring-1 ring-slate-200"
    >
      <img
        src={participants}
        alt="Participants of the 2026 EdTech-a-thon"
        class="w-full bg-slate-100"
      />
      <figcaption class="handwriting pt-5 text-center text-lg text-slate-700">
        EdTech-a-thon 2026
      </figcaption>
    </figure>
  </section>

  <section class="mb-6 rounded-lg bg-white p-5 ring-1 ring-slate-200">
    <h2 class="mb-2 text-lg font-semibold">Our promise</h2>
    <ul class="space-y-2 text-sm leading-relaxed text-slate-700">
      <li><span class="font-semibold">Zero paywalls.</span></li>
      <li><span class="font-semibold">Zero ads.</span></li>
      <li>
        <span class="font-semibold">Zero tracking of personal data.</span>
      </li>
    </ul>
  </section>

  <section class="mb-6 rounded-lg bg-white p-5 ring-1 ring-slate-200">
    <h2 class="mb-2 text-lg font-semibold">Feedback & ideas</h2>
    <p class="mb-3 text-sm leading-relaxed text-slate-700">
      We'd love to hear from you. Tell us what's working, what's not, or pitch
      us an idea for a tool you wish existed. We're here to help.
    </p>
    <a
      href="mailto:directors@edtechathon.com?subject=service%20scheduler%20feedback"
      class="inline-block rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-amber-50 ring-1 ring-slate-800 hover:bg-slate-700"
    >
      Email directors@edtechathon.com
    </a>
  </section>
</main>
