# Configurable artifact paths

Fork-only. Lets each project choose where the skills keep its files (glossary, ADRs, local issues, and more) while installing with the standard `npx skills` CLI, and keeps the fork in step with upstream. The fork adds files and edits a single upstream line, which keeps merges from upstream conflict-free in practice.

The fork-only files are:

- [`skills/fork/configure-artifact-paths/`](../skills/fork/configure-artifact-paths/SKILL.md): the user-invoked skill, with the renderer in `scripts/`.
- `installer/`: this README, the upstream-sync guard and the tests.
- `.github/workflows/installer.yml`: runs the tests and the guard.
- `.github/workflows/upstream-sync.yml`: merges upstream into `main` every 6 hours when everything passes (see [Upstream sync](#upstream-sync)).

The one upstream file the fork edits is `.github/workflows/release.yml`: its changesets job runs only in `mattpocock/skills` (`if: github.repository == 'mattpocock/skills'`), so the fork never opens version PRs.

## Using it in a project

```sh
npx skills@latest add graitools/custom-mattpocock-skills     # pick configure-artifact-paths along with the others
```

Then, in any agent, run `/configure-artifact-paths`. The agent shows every path with its default, asks which to override, and applies them. It runs `scripts/configure.mjs` from the installed skill, so it needs Node 18.3+ in the project and nothing else.

Run `/configure-artifact-paths` again after every `npx skills add` or `npx skills update`: those put the upstream text back into the skills they touch. Until then, the `Artifact locations` table in `AGENTS.md` tells agents which paths win. For CI:

```sh
node .agents/skills/configure-artifact-paths/scripts/configure.mjs check
```

(Use the folder the skill is installed in: `.agents/skills/` for the universal install, or an agent folder such as `.claude/skills/` for a copy-mode install that only targets that agent.) It finds the project root by itself (the nearest folder with `skills-lock.json`), and fails when a skill still has the upstream paths, was edited by hand or left unrecorded by an interrupted run, or when the config changed without being applied.

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
- **unrecorded**: rendered by the script, but not as the lock records it (a run that stopped midway, or a lost or uncommitted lock). The saved originals rebuild exactly what `npx skills` installed (checked against `computedHash`), and every file is that original or a rendering of it, so `apply` recovers it without `--force`.
- **broken**: rendered by the script, but its saved originals are missing or edited. Reinstall it.

`apply` writes in an order a stopped run can recover from: it adds saved originals, rewrites the skills, writes the lock, and only then drops saved originals nothing needs and updates `AGENTS.md`/`CLAUDE.md`. The lock is validated on load: entries naming anything outside the skill folders are refused rather than acted on.

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

When paths change and artifacts already exist at the previous ones, `apply` stops and lists them. On the first apply the previous paths are the upstream defaults, so a project already using the skills gets the same prompt. `--migrate` moves them (with `git mv` when tracked, including per-context copies) and rewrites references in `AGENTS.md`, `CLAUDE.md`, the context map and the files in `skillsConfigDir`; `--skip-migration` leaves them. References are only rewritten where they look like paths: inside code spans and link targets, at the start of the path (or after a `/` for the per-context glossary and ADR folder), and in one pass so a new path is never rewritten again. Prose is never touched, and the stop message shows every line that would change. Code spans are read as repo-relative paths. Claude Code `@path` imports in `AGENTS.md` and `CLAUDE.md` are updated too. Link targets are read relative to their file: each is resolved against the folder the file was written in, rewritten, then made relative to the folder the file ends up in, so links in a context map that moves (or sits in a subfolder) keep pointing at the artifacts wherever they moved. If a move fails midway, fix the cause and re-run `--migrate`: moves already done are skipped and the reference updates still run. Per-context artifacts are looked for at the repo root and in each context the context map links to (by its glossary or ADR folder); without a context map the project is single-context. Ignored, vendored and dependency folders are never scanned. Every move is checked before any runs: a destination that already exists, a folder moved into itself, or two overlapping moves blocks `--migrate`. A changed `teachDir` is listed but always moved by hand.

## Upstream sync

`.github/workflows/upstream-sync.yml` runs every 6 hours (and on demand from the Actions tab) and keeps `main` within a day of upstream `main`, which is what `npx skills add mattpocock/skills` installs. It has two jobs:

- **check** has no write token. It merges upstream `main` into an `upstream-sync` branch cut from `main` (a merge commit, never a rebase; a branch left open by an earlier blocked run is built on, so fixes pushed to it survive), records the merge commit, and only then runs the checks on the merged tree: the `release.yml` guard line, the tests, the guard and the real `npx skills` round trips.
- **publish** holds the GitHub App token and never executes anything from the tree. It trusts nothing `check` produced after running upstream code and re-derives it from git objects: the checked `main` must be on this repository's `main` and the upstream commit on upstream's `main` (fetched again here), the commit must be the one `check` recorded before the checks, must contain both, and every new commit must be either upstream's own or a clean merge whose tree git reproduces. Which paths the sync changes is computed from exactly what would land (the head against the checked `main`), so no shape of upstream history can hide a change. It then pushes the branch, opens or updates one PR and enables auto-merge, but only when every check passed and the sync does not change `.github/`, `installer/` or `skills/fork/`; a fix you push to the sync branch that touches those paths counts too, so such a PR waits for you to merge it. Any auto-merge left on from an earlier run is switched off before the head changes, and switched on again only for an eligible head.

**Workflow changes are never pushed.** A branch pushed to this repository runs the workflow files it contains, with this repository's secrets, so when the sync would change anything under `.github/` the workflow does not push at all: it reports the change with a compare link for you to review and merge by hand. As a backstop the App has no Workflows permission, so GitHub itself refuses any App push of commits that change workflow files. Upstream's other code does run here, in the `check` job and in `installer.yml` on the sync branch, but both have read-only tokens and no secrets, and the App's private key is only readable by jobs running on `main` (setup step 2). The `check` job runs on `main` with sudo on its runner, so never add caching to workflows here without considering that upstream code could write a cache that a job on `main` later restores. The actions in the sync workflow are pinned to commit SHAs.

It merges only onto the `main` the checks ran against: if `main` moved during the run, it switches off auto-merge and the next run merges `main` into the branch and checks again.

Everything else is reported on a single issue labelled `upstream-sync`, one comment per upstream commit and reason: a merge conflict (with upstream, or between `main` and the open sync branch), a merge that failed for another reason (such as rewritten upstream history), a failing check, an upstream change under `.github/` (not pushed), a change to `installer/` or `skills/fork/` (pushed, not auto-merged; also when the change comes from a fix pushed to the sync branch), a PR that could not be merged, or a sync PR over 24 hours old whose auto-merge was already waiting before the run (so a PR that just turned green is not reported). A run that needs attention also ends red, so GitHub notifies you. The issue is closed as soon as `main` contains upstream (confirmed by the publish job from git objects, not taken from the check job), whether the sync merged itself or you finished it by hand; a sync PR left behind is then closed too, when `main` already contains its branch or has the same tree.

### One-time setup

Until `SYNC_APP_ID` exists both jobs are skipped, so the workflow is harmless before this. In a GitHub fork, Actions start disabled: enable them first on the Actions tab, or the schedule never runs.

1. **Create a GitHub App** (Settings, Developer settings, GitHub Apps, New). No webhook. Repository permissions: *Contents*, *Pull requests* and *Issues*, all read and write. Leave *Workflows* at no access: the sync never pushes workflow changes, and without that permission GitHub refuses them anyway. Install it on this repository only.
2. **Store its credentials.** Create an environment named `upstream-sync` (Settings, Environments) with *Deployment branches and tags* limited to `main` and no required reviewers, and add a generated private key to it as the environment secret `SYNC_APP_PRIVATE_KEY`; only jobs running on `main` can then read it. Add the App ID as the repository variable `SYNC_APP_ID` (Settings, Secrets and variables, Actions). Where environments with branch policies are not available (a private repository on a free plan), a repository secret works too; the key is then protected only by upstream workflow changes never being pushed.
3. **Make workflow tokens read-only by default** (Settings, Actions, General, Workflow permissions: "Read repository contents and packages permissions"). The fork's workflows declare what they need; this covers any that do not.
4. **Allow auto-merge**: Settings, General, Pull Requests, "Allow auto-merge".
5. **Protect `main`** with a ruleset or branch protection that requires the status check "Tests and upstream-sync guard" **and requires branches to be up to date before merging** (strict). Auto-merge then waits for the check, and cannot merge the PR onto a newer `main` it was not checked against; the next run brings the branch up to date and checks again. Do **not** require an approving review: the App cannot approve, so auto-merge would wait forever (the workflow reports a sync PR still open after 24 hours). Without protection the workflow merges at once, but only onto the `main` it checked; a commit landing on `main` in the seconds between that comparison and the merge is the one gap protection closes.
6. **Let head branches be deleted after merging** (Settings, General, Pull Requests, "Automatically delete head branches"), and merge sync PRs you merge by hand with a merge commit. A squash or rebase merge leaves the old `upstream-sync` branch looking unmerged, and the next run would build on it.
7. **Run it once by hand** (Actions, Upstream sync, Run workflow) and check the run: with nothing new upstream it reports "Up to date".

Each run of the publish job shows up as a deployment to the `upstream-sync` environment. GitHub may delay scheduled runs, and in a public repository disables scheduled workflows after 60 days without activity (it emails you; re-enable it from the Actions tab). If the App token cannot be created (wrong ID or key), the run fails before it can open an issue: the red run is the only signal.

To drop a sync PR, close it **and delete the `upstream-sync` branch**; otherwise the next run builds on the branch and reopens it. The workflow sets the PR's title and body only when the upstream commit changes, so edits you make to them stay until then. The workflow always proposes the latest upstream `main`: to hold upstream back for a while, disable the workflow from the Actions tab.

### By hand

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
