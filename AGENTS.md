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

<!-- edtechathon:branch-workflow -->

## Branching: Always Work on `dev`

- **All of your work happens on the `dev` branch.** This is where the project is
  already checked out, and it is the only branch you are able to push to.
- **Never switch to `main`, and never push to `main`.** It is protected, and the
  push will be rejected. If you need a separate branch for a large experiment,
  branch off `dev` and push that instead.

## Publishing the User's Work (Going Live)

Saving work and publishing work are two different things, and the difference
matters to the user:

- **Saving** (a commit and push to `dev`) happens constantly and is what keeps
  the work safe. The editing link above always shows the very latest saved work.
- **Publishing** takes a snapshot of the work and puts it on the showcase site.
  It has to be approved by an EdTech-a-thon Director, so it does not happen
  automatically.

You do not need to run any special command to request publishing. Every time you
push to `dev`, a request to publish is opened on GitHub automatically and stays
up to date with the latest work. A Director reviews and approves it.

So when the user asks to "publish", "go live", "share it", or "make it real":

1. Make sure the work is saved (commit and push to `dev`).
2. Tell them, in plain language, that the work is saved and a publish request is
   waiting for a Director — e.g. "Everything's saved, and I've asked the
   EdTech-a-thon team to publish it. Once they approve, it'll appear on the
   showcase site."
3. Don't imply it is already published, and don't give them a timeline you
   can't promise.

Never explain branches, pull requests, merges, or GitHub review to the user
unless they ask, or have shown you that they're a developer.
