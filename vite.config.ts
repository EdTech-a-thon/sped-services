import tailwindcss from "@tailwindcss/vite";
import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
      },

      // The whole app is prerendered to static files: workbooks are parsed in
      // the browser, so there is no server to talk to.
      // See https://svelte.dev/docs/kit/adapters for more information about adapters.
      adapter: adapter({ fallback: "404.html" }),
    }),
  ],
});
