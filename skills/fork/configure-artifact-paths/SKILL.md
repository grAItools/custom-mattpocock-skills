---
name: configure-artifact-paths
description: "Choose where the skills keep this project's files (glossary, ADRs, local issues, and more), then rewrite the installed skills to use those folders. Run after every `npx skills add` or `npx skills update`."
disable-model-invocation: true
---

# Configure Artifact Paths

The skills installed from this repo name default locations for the files they write (`CONTEXT.md`, `docs/adr/`, `.scratch/`, ...). This skill lets the user pick other locations and rewrites the installed skills in place so every agent reads the chosen paths.

All the work is done by `scripts/configure.mjs` in this skill's folder (the folder holding this `SKILL.md`, usually `.agents/skills/configure-artifact-paths/`). Run it with `node` from the project root. It needs Node 18.3 or later and nothing else. Below, `configure.mjs` means that script.

Never edit the installed skills or the generated `Artifact locations` block in `AGENTS.md` by hand: the script owns them.

## Process

### 1. Read the current state

Run `node <skill folder>/scripts/configure.mjs status`. It prints JSON with:

- `paths`: for each key, the configured `value`, its `default`, a `label`, what it is `relativeTo`, and whether it is `optional` (optional keys default to `null`, meaning "keep the skill's own convention").
- `appliedPaths`: the paths the skills were last rewritten with, or `null` if never.
- `skills`: each installed skill from this repo and the `state` of each copy: `configured` (matches the lock), `original` (fresh from `npx skills`, still on default paths), `modified` (edited by hand), or `broken`.

If it fails because `skills-lock.json` or this skill is missing from it, tell the user to install the skills into this project with `npx skills add` first, and stop.

### 2. Show the paths and ask for overrides

Present one table: key, what it is (the label), current value, default. Mark optional keys and say that `null` keeps the skill's own convention. Say that "per context" paths (`glossary`, `adrDir`) are relative to each context root, which is the repo root unless the project has several bounded contexts.

Then ask once: which paths should change? The user answers with `key=value` pairs, or accepts the table as it is. Accept `default` to restore a default and `null` to clear an optional key. Repeat only if the user wants another change.

Mention any copy whose state is `modified` or `broken` now, since step 4 will stop on it.

### 3. Save

Run `node <skill folder>/scripts/configure.mjs set key=value ...` with the user's changes. It validates each value (relative paths only; glossary and context map must be `.md` files) and saves `.agents/skill-paths.json`. On an error, show it and ask for a corrected value. Skip this step when nothing changed.

### 4. Apply

Run `node <skill folder>/scripts/configure.mjs apply`. It rewrites the installed skills, keeps the original text of each changed file under `.agents/skill-paths/originals/`, writes the `Artifact locations` table into `AGENTS.md`, adds an `@AGENTS.md` line to `CLAUDE.md` (so Claude Code reads it), and writes `.agents/skill-paths.lock.json`.

It stops, changing nothing, in two cases. Show the user what it printed and ask:

- **Existing artifacts at the old locations** (paths changed since the last apply): move them (`--migrate`, which uses `git mv` for tracked files and updates references in `AGENTS.md`, `CLAUDE.md`, the context map and the setup config) or leave them (`--skip-migration`)? Re-run `apply` with the chosen flag.
- **A skill whose original text cannot be recovered** (edited by hand): reinstall it with the `npx skills add` command the message shows and re-run `apply`, or re-run with `--force` to take its current text as the original.

### 5. Finish

Tell the user:

- Which paths are now in effect.
- To commit `.agents/`, `.claude/` (if present), `AGENTS.md`, `CLAUDE.md` and `skills-lock.json` together.
- `npx skills add` and `npx skills update` put the default paths back into the skills they touch: run `/configure-artifact-paths` again after either.
- For CI: `node .agents/skills/configure-artifact-paths/scripts/configure.mjs check` fails whenever the installed skills do not match the configured paths.
- If they have not configured their issue tracker yet, to run `/setup-matt-pocock-skills` next.
