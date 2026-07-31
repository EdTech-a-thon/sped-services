# EdTech-a-thon Agent Instructions

This project was created as a prototype during the 3-day "EdTech-a-thon" event by a team with varying technical expertise. Now we want to host it long-term.

### Default Web App Tech Stack

- Runtime: Bun
- Package manager: Bun
- Language: Typescript
- Build tool: Vite-based tooling
- Linter: ESLint (for JS/TS projects)
- Formatter: Prettier (for JS/TS projects; by default, create a blank prettier config file that does not modify any settings)
- Framework: SvelteKit if using Svelte or Astro if not
- UI Library: Svelte
- UI / Styling: Tailwind CSS
- UI Rendering Method: Prefer DOM elements over canvas when possible for the sake of accessibility, using canvas only when it is unreasonable not to
- Data & Persistence: Follow this hierarchy — no data, then `localStorage`, then Supabase only if real accounts or shared persistence are strictly necessary
