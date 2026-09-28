# Per-project skills installer

Fork-only tooling. It installs the skills into a project's repository with that project's artifact folders baked into the skill text, so every agent (Claude Code, OpenCode, Codex, oh-my-pi) reads literal, correct paths. Nothing here edits upstream files, which keeps merges from upstream conflict-free.

Requires Node 18.3 or later. No dependencies.

## Install into a project

```sh
git clone https://github.com/grAItools/custom-mattpocock-skills ~/src/custom-mattpocock-skills
cd ~/src/my-project
node ~/src/custom-mattpocock-skills/installer/install.mjs          # add --dry-run to preview
```

The first run writes `.agents/skill-paths.json` with the upstream defaults. Edit it, re-run the installer, and commit the result.

What the installer writes into the project (commit all of it):

| Path | What |
|---|---|
| `.agents/skill-paths.json` | Your config. The only file you edit. |
| `.agents/skills/<name>/` | Rendered skills. Codex, OpenCode and oh-my-pi read them here. |
| `.claude/skills/<name>` | Symlink to the folder above, for Claude Code. `--claude-copy` copies instead (Windows without git symlinks). |
| `AGENTS.md` | A managed `Artifact locations` block between `mattpocock-skills:paths` markers. The rest of the file is yours. |
| `CLAUDE.md` | Gets an `@AGENTS.md` line, so Claude Code loads `AGENTS.md` as well. |
| `.agents/skill-paths.lock.json` | What was installed, from which commit, with file hashes. |

Skills already in `.agents/skills/` or `.claude/skills/` that the installer did not create are left alone. If one has the same name as a skill being installed, the installer stops; `--force` replaces it.

Installed set: the promoted skills (the `skills` array of `.claude-plugin/plugin.json`), plus any names in `extraSkills` (e.g. `"pr"` from `in-progress/`).

## Config

```json
{
  "paths": {
    "glossary": "docs/domain/GLOSSARY.md",
    "contextMap": "docs/domain/CONTEXT-MAP.md",
    "adrDir": "docs/architecture/decisions",
    "skillsConfigDir": ".agents/config",
    "localTrackerDir": "work",
    "outOfScopeDir": "docs/rejected",
    "teachDir": "learning",
    "researchDir": "docs/research",
    "handoffDir": ".handoffs",
    "prototypeDir": "prototypes",
    "wizardDir": "scripts/wizards"
  },
  "extraSkills": ["pr"]
}
```

Every key is optional; a missing key keeps the upstream default.

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

"Each context root" is the repo root in a single-context project, and each context folder (e.g. `src/ordering/`) in a multi-context one, so `adrDir: "docs/decisions"` means `docs/decisions/` at the root and `src/ordering/docs/decisions/` per context. `null` keeps the skill's own convention (for `handoffDir`, the OS temp directory).

## Changing a path later

Edit the config and re-run the installer. If artifacts already exist at the old location, the installer stops and lists them:

- `--migrate` moves them (with `git mv` when tracked), including per-context copies, and rewrites references to the old paths in `AGENTS.md`, `CLAUDE.md`, the context map and the files in `skillsConfigDir`. Links elsewhere in your docs are not rewritten. A changed `teachDir` is reported but not moved.
- `--skip-migration` installs anyway and leaves them where they are.

## Updating the skills

`git pull` in the fork clone, then re-run the installer in each project and commit.

## Checking a project in CI

```sh
node path/to/custom-mattpocock-skills/installer/install.mjs --check
```

This compares the project against its lock file only, so any checkout of the fork works. It fails when a rendered skill was edited by hand, when the config changed without a re-install, or when the `AGENTS.md` block or the `@AGENTS.md` import is missing.

## Keeping the fork in sync with upstream

```sh
git remote add upstream https://github.com/mattpocock/skills   # once
git fetch upstream
git merge upstream/main
node --test installer/test/*.test.mjs && node installer/guard.mjs
```

Merge rather than rebase: `main` is published. The installer only adds files, so the merge itself does not conflict on its account.

The guard renders every skill with every path set to a sentinel value and fails when:

- **a rule matched nothing**: upstream reworded the sentence that rule targets. Update its `find` text in [rules.mjs](./rules.mjs).
- **a default path survived**: upstream added a reference in a form the rules do not cover (a new tree layout, a new folder). Add or extend a rule.

CI runs the same two commands on every push ([.github/workflows/installer.yml](../.github/workflows/installer.yml)).

## How rendering works

[rules.mjs](./rules.mjs) holds the rules. Most references are plain tokens (`CONTEXT.md`, `docs/adr`, `.scratch`, ...) replaced wherever they appear, including inside per-context paths like `src/<context>/docs/adr/`. Skills with no fixed path (research, handoff, prototype, wizard, teach) get a targeted sentence rewrite, applied only when the key is set. One rule is not about paths: it makes `/setup-matt-pocock-skills` write its `## Agent skills` block to `AGENTS.md`, since Codex does not read `CLAUDE.md`.

Rules first replace matches with placeholders and only then substitute values, so a configured value is never rewritten by a later rule. With the default config, every skill renders byte-identical to upstream except `setup-matt-pocock-skills/SKILL.md`.
