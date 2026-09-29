# Configurable artifact paths

Fork-only. Lets each project choose where the skills keep its files (glossary, ADRs, local issues, and more) while installing with the standard `npx skills` CLI. Nothing here edits upstream files, which keeps merges from upstream conflict-free.

The fork-only files are:

- [`skills/fork/configure-artifact-paths/`](../skills/fork/configure-artifact-paths/SKILL.md): the user-invoked skill, with the renderer in `scripts/`.
- `installer/`: this README, the upstream-sync guard and the tests.
- `.github/workflows/installer.yml`: runs the tests and the guard.

## Using it in a project

```sh
npx skills@latest add graitools/custom-mattpocock-skills     # pick configure-artifact-paths along with the others
```

Then, in any agent, run `/configure-artifact-paths`. The agent shows every path with its default, asks which to override, and applies them. It runs `scripts/configure.mjs` from the installed skill, so it needs Node 18.3+ in the project and nothing else.

Run `/configure-artifact-paths` again after every `npx skills add` or `npx skills update`: those put the upstream text back into the skills they touch. Until then, the `Artifact locations` table in `AGENTS.md` tells agents which paths win. For CI:

```sh
node .agents/skills/configure-artifact-paths/scripts/configure.mjs check
```

It fails when a skill still has the upstream paths, was edited by hand, or when the config changed without being applied.

### What it writes (commit all of it)

| Path | What |
|---|---|
| `.agents/skill-paths.json` | The chosen paths. |
| `.agents/skills/<name>/` | The skills `npx skills` installed, rewritten in place. `.claude/skills/` links to them in symlink mode; in copy mode each copy is rewritten. |
| `.agents/skill-paths/originals/<name>/*.orig` | The upstream text of each file it changed, so a later run can start from it. |
| `.agents/skill-paths.lock.json` | The applied config and a hash of each skill before and after. |
| `AGENTS.md` | A generated `Artifact locations` block between `mattpocock-skills:paths` markers. The rest of the file is yours. |
| `CLAUDE.md` | An `@AGENTS.md` line, so Claude Code reads `AGENTS.md` too. |

Only skills that `skills-lock.json` lists with the same source as `configure-artifact-paths` are touched. A skill that was edited by hand is left alone (the script stops and names it) unless you pass `--force`.

### How it tells what it is looking at

`npx skills` copies skills verbatim and records a hash of each (`computedHash` in `skills-lock.json`). The script computes the same hash, so for each installed skill it knows whether it is:

- **original**: matches `skills-lock.json` (fresh install or update). Rendered directly.
- **configured**: matches its own lock. The original is rebuilt from the `.orig` files and rendered again.
- **modified**: matches neither. Left alone unless forced.

### The paths

| Key | Default | Relative to | Used by |
|---|---|---|---|
| `glossary` | `CONTEXT.md` | each context root | domain-modeling, grill-with-docs, tdd, triage, and most engineering skills |
| `contextMap` | `CONTEXT-MAP.md` | repo root | domain-modeling, setup, wait-what |
| `adrDir` | `docs/adr` | each context root | domain-modeling, improve-codebase-architecture, setup |
| `skillsConfigDir` | `docs/agents` | repo root | setup-matt-pocock-skills, code-review |
| `localTrackerDir` | `.scratch` | repo root | the local issue tracker: to-spec, to-tickets, wayfinder, code-review |
| `outOfScopeDir` | `.out-of-scope` | repo root | triage |
| `teachDir` | `.` | repo root | teach (the whole workspace: `MISSION.md`, `lessons/`, ...) |
| `researchDir` | `null` | repo root | research |
| `handoffDir` | `null` | repo root | handoff |
| `prototypeDir` | `null` | repo root | prototype (standalone prototypes only; UI routes still follow the app's routing) |
| `wizardDir` | `null` | repo root | wizard |

"Each context root" is the repo root in a single-context project, and each context folder (e.g. `src/ordering/`) in a multi-context one. `null` keeps the skill's own convention (for `handoffDir`, the OS temp directory).

When paths change and artifacts already exist at the old ones, `apply` stops and lists them: `--migrate` moves them (with `git mv` when tracked, including per-context copies) and rewrites references in `AGENTS.md`, `CLAUDE.md`, the context map and the files in `skillsConfigDir`; `--skip-migration` leaves them. A changed `teachDir` is reported, not moved.

## Keeping the fork in sync with upstream

```sh
git remote add upstream https://github.com/mattpocock/skills   # once
git fetch upstream
git merge upstream/main
node --test installer/test/*.test.mjs && node installer/guard.mjs
```

Merge rather than rebase: `main` is published.

The guard renders every skill (except `deprecated/`) with every path set to a sentinel value and fails when:

- **a rule matched nothing**: upstream reworded the sentence that rule targets. Update its text in [rules.mjs](../skills/fork/configure-artifact-paths/scripts/lib/rules.mjs).
- **a default path survived**: upstream added a reference in a form the rules do not cover (a new tree layout, a new folder). Add or extend a rule.

## How rendering works

Most references are plain tokens (`CONTEXT.md`, `docs/adr`, `.scratch`, ...) replaced wherever they appear, including inside per-context paths like `src/<context>/docs/adr/`. Skills with no fixed path (research, handoff, prototype, wizard, teach) get a targeted sentence rewrite, applied only when the key is set. One rule is not about paths: it makes `/setup-matt-pocock-skills` write its `## Agent skills` block to `AGENTS.md`, since Codex does not read `CLAUDE.md`.

Rules first replace matches with placeholders and only then substitute values, so a configured value is never rewritten by a later rule. With the default config, every skill renders byte-identical to upstream except `setup-matt-pocock-skills/SKILL.md`.
