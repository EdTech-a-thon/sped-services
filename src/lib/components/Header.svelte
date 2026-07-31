<script lang="ts">
  import { resolve } from "$app/paths";
  import logo from "$lib/assets/logo.svg";
</script>

<header class="w-full border-b border-slate-200 bg-white">
  <div class="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
    <a
      href={resolve("/")}
      class="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900 hover:text-green-900"
    >
      <img src={logo} alt="" class="h-8 w-8" />
      Service Scheduler
    </a>
  </div>
</header>
