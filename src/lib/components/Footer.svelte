<script lang="ts">
  import { resolve } from "$app/paths";
  import edtechathonLogo from "$lib/assets/logo.svg";
</script>

<footer
  class="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-center gap-x-4 gap-y-2 px-4 pb-4 text-center"
>
  <a
    href="https://edtechathon.com"
    target="_blank"
    rel="noopener noreferrer"
    class="flex items-center gap-2 text-sm text-slate-500 hover:text-amber-700"
  >
    <img src={edtechathonLogo} alt="" class="h-6 w-6" />
    Built by the EdTech-a-thon
  </a>
  <a
    href={resolve("/about")}
    class="text-sm text-slate-500 hover:text-amber-700">about</a
  >
  <a
    href={resolve("/privacy")}
    class="text-sm text-slate-500 hover:text-amber-700">privacy</a
  >
</footer>
