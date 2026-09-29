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

(Use the folder the skill is installed in: `.agents/skills/` for the universal install, or an agent folder such as `.claude/skills/` for a copy-mode install that only targets that agent.) It fails when a skill still has the upstream paths, was edited by hand, or when the config changed without being applied.

### What it writes (commit all of it)

| Path | What |
|---|---|
| `.agents/skill-paths.json` | The chosen paths. |
| `.agents/skills/<name>/` | The skills `npx skills` installed, rewritten in place. `.claude/skills/` links to them in symlink mode; in copy mode each copy (in any agent folder `npx skills` uses) is rewritten and tracked separately. |
| `.agents/skill-paths/originals/<copy>/*.orig` | The upstream text of each file it changed, per installed copy (e.g. `originals/.agents/skills/tdd/`), so a later run can start from it. |
| `.agents/skill-paths.lock.json` | The applied config and, per copy, a hash before and after. |
| `AGENTS.md` | A generated `Artifact locations` block between `mattpocock-skills:paths` markers. The rest of the file is yours. |
| `CLAUDE.md` | An `@AGENTS.md` line, so Claude Code reads `AGENTS.md` too. Skipped when `CLAUDE.md` is a symlink to `AGENTS.md`. |

Only skills that `skills-lock.json` lists with the same source as `configure-artifact-paths` are touched. A copy in a non-hidden folder (`skills/`, `agent/skills/`, `data/skills/`) is only touched when its hash is recognised, so a project's own `skills/` folder is never mistaken for an install. A skill that was edited by hand is left alone (the script stops and names it) unless you pass `--force`: files the script had rewritten then come back from their saved originals (their hand edits are dropped, with a warning naming them) and hand edits elsewhere are kept. When a skill must be reinstalled, the message prints the `npx skills add` command with its source; repeat the `--agent` (and `--copy`) flags of the original install.

### How it tells what it is looking at

`npx skills` copies skills verbatim and records a hash of each (`computedHash` in `skills-lock.json`). The script computes the same hash, so for each installed skill it knows whether it is:

- **original**: matches `skills-lock.json` (fresh install or update). Rendered directly.
- **configured**: matches its own lock. The original is rebuilt from the `.orig` files and rendered again.
- **modified**: matches neither. Left alone unless forced.
- **broken**: rendered by the script, but its saved originals are missing or edited. Reinstall it.

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

"Each context root" is the repo root in a single-context project, and each context folder (e.g. `src/ordering/`) in a multi-context one. `null` keeps the skill's own convention (for `handoffDir`, the OS temp directory). No path may equal or sit inside another, and `.git/`, `node_modules/`, agents' own folders (`.agents/`, `.claude/`, ...; folders below them such as `.agents/config` are fine), agent skill folders, the script's own files, `AGENTS.md`, `CLAUDE.md` and `skills-lock.json` are refused. When `/teach` is installed, no path may land on its workspace files (`GLOSSARY.md`, `MISSION.md`, `lessons/`, ...); set `teachDir` to keep them apart. The `AGENTS.md` table leaves `/teach` out while `teachDir` is the default, since upstream then uses the current directory.

When paths change and artifacts already exist at the previous ones, `apply` stops and lists them. On the first apply the previous paths are the upstream defaults, so a project already using the skills gets the same prompt. `--migrate` moves them (with `git mv` when tracked, including per-context copies) and rewrites references in `AGENTS.md`, `CLAUDE.md`, the context map and the files in `skillsConfigDir`; `--skip-migration` leaves them. References are only rewritten where they look like paths: inside code spans and link targets, at the start of the path (or after a `/` for the per-context glossary and ADR folder), and in one pass so a new path is never rewritten again. Prose is never touched, and the stop message shows every line that would change. Code spans are read as repo-relative paths. Link targets are read relative to their file: each is resolved against the folder the file was written in, rewritten, then made relative to the folder the file ends up in, so links in a context map that moves (or sits in a subfolder) keep pointing at the artifacts wherever they moved. If a move fails midway, fix the cause and re-run `--migrate`: moves already done are skipped and the reference updates still run. Per-context artifacts are looked for at the repo root and in each context the context map links to (by its glossary or ADR folder); without a context map the project is single-context. Ignored, vendored and dependency folders are never scanned. Every move is checked before any runs: a destination that already exists, a folder moved into itself, or two overlapping moves blocks `--migrate`. A changed `teachDir` is listed but always moved by hand.

## Keeping the fork in sync with upstream

```sh
git remote add upstream https://github.com/mattpocock/skills   # once
git fetch upstream
git merge upstream/main
node --test installer/test/*.test.mjs && node installer/guard.mjs
```

Merge rather than rebase: `main` is published.

The guard renders every skill (except `deprecated/`) with every path set to a sentinel value and fails when:

- **a rule matched nothing in one of its targets** (each file it names, each skill it names, or the whole repo): upstream reworded the sentence that rule targets. Update its text in [rules.mjs](../skills/fork/configure-artifact-paths/scripts/lib/rules.mjs).
- **a default path survived**: upstream added a reference to one of the known default paths in a form the rules do not cover (a new tree layout, a new sentence shape). Add or extend a rule.

When adding a key, give it the upstream default: projects whose lock predates the key are treated as having used that default. The guard only knows the default paths listed in the table above. If upstream introduces a new kind of artifact folder, or spells an existing one differently (say `docs/adrs`), the guard stays green: review upstream diffs for new paths when merging, and add a key and rules for them.

`REAL_SKILLS_CLI=1 node --test installer/test/*.test.mjs` also runs a round trip through the real `npx skills@1.7.0` (install, configure, reinstall, re-apply); CI runs it as a separate step. The test suite also pins the folder hash `npx skills` 1.7.0 recorded for `installer/test/fixtures/hash-skill` (an `internal` skill, hidden from installs). If a newer `skills` release changes its hash algorithm, that test fails: fresh installs would then show as `modified`, so update `folderHash` in `project.mjs` and re-pin the value with `INSTALL_INTERNAL_SKILLS=1 npx skills@latest add installer/test/fixtures/hash-skill` in a scratch repo.

## How rendering works

Every file of a skill that decodes as UTF-8 is rendered and guarded, whatever its extension; binary files are copied as they are. Most references are plain tokens (`CONTEXT.md`, `docs/adr`, `.scratch`, ...) replaced wherever they appear, including inside per-context paths like `src/<context>/docs/adr/`. Skills with no fixed path (research, handoff, prototype, wizard, teach) get a targeted sentence rewrite, applied only when the key is set. One rule is not about paths: it makes `/setup-matt-pocock-skills` write its `## Agent skills` block to `AGENTS.md` (moving one it finds in `CLAUDE.md`), since Codex does not read `CLAUDE.md`. Another runs after the values are in and realigns the `←` comments in directory trees.

Rules first replace matches with placeholders and only then substitute values, so a configured value is never rewritten by a later rule. With the default config, every skill renders byte-identical to upstream except `setup-matt-pocock-skills/SKILL.md`.
