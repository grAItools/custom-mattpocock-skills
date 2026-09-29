# Fork

Skills that exist only in this fork (`grAItools/custom-mattpocock-skills`), not upstream. Nothing outside this folder, `installer/` and `.github/workflows/installer.yml` is fork-only, which keeps merges from upstream conflict-free.

- **[configure-artifact-paths](./configure-artifact-paths/SKILL.md)** (user-invoked): Choose where the skills keep this project's files (glossary, ADRs, local issues, and more), then rewrite the installed skills to use those folders. Run after every `npx skills add` or `npx skills update`.
