# Fork

Skills that exist only in this fork (`grAItools/custom-mattpocock-skills`), not upstream. Besides this folder, the fork-only files are `installer/`, `.github/workflows/installer.yml` and `.github/workflows/upstream-sync.yml`, plus a one-line guard in the upstream `release.yml`; see [installer/README.md](../../installer/README.md). That keeps merges from upstream conflict-free in practice.

- **[configure-artifact-paths](./configure-artifact-paths/SKILL.md)** (user-invoked): Choose where the skills keep this project's files (glossary, ADRs, local issues, and more), then rewrite the installed skills to use those folders. Run after every `npx skills add` or `npx skills update`.

These skills are deliberately left out of the `ask-matt` router, the top-level `README.md` and `.claude-plugin/plugin.json` (which the repo's `CLAUDE.md` asks of user-reachable skills): editing those upstream files would make every merge from upstream conflict. `npx skills add` lists them under "General".
