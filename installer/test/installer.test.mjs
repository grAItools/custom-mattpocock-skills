import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSkills, readSkill, runGuard } from "../guard.mjs";
import { CONFIG_FILE, LOCK_FILE, defaultPaths, validateConfig } from "../../skills/fork/configure-artifact-paths/scripts/lib/paths.mjs";
import { renderFiles } from "../../skills/fork/configure-artifact-paths/scripts/lib/render.mjs";
import { SELF, apply, check, folderHash, planMigration, setPaths, status } from "../../skills/fork/configure-artifact-paths/scripts/lib/project.mjs";

const quiet = () => {};
const SOURCE = "grAItools/custom-mattpocock-skills";
const SELF_DIR = new URL("../../skills/fork/configure-artifact-paths", import.meta.url).pathname;
const ALL = listSkills();
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const renderOne = (name, rel, paths) =>
  renderFiles(name, readSkill(ALL.get(name)), paths).files.find((f) => f.rel === rel).content.toString("utf8");

// What `npx skills add <source>` leaves behind: canonical copies in
// .agents/skills, Claude Code links (or copies), and skills-lock.json.
// `copies` adds copy-mode installs for other agent folders.
function skillsAdd(root, names, { mode = "symlink", source = SOURCE, copies = [] } = {}) {
  const lockPath = join(root, "skills-lock.json");
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : { version: 1, skills: {} };
  for (const name of names) {
    const src = name === SELF ? SELF_DIR : ALL.get(name);
    const dest = join(root, ".agents/skills", name);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    const claude = join(root, ".claude/skills", name);
    rmSync(claude, { recursive: true, force: true });
    mkdirSync(join(root, ".claude/skills"), { recursive: true });
    if (mode === "copy") cpSync(src, claude, { recursive: true });
    else symlinkSync(`../../.agents/skills/${name}`, claude, "dir");
    for (const base of copies) {
      rmSync(join(root, base, name), { recursive: true, force: true });
      cpSync(src, join(root, base, name), { recursive: true });
    }
    lock.skills[name] = { source, sourceType: "github", computedHash: folderHash(readSkill(src)) };
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));
}

const SOME = ["domain-modeling", "setup-matt-pocock-skills", "to-tickets", "research", "tdd"];
function project(opts) {
  const root = mkdtempSync(join(tmpdir(), "configure-paths-"));
  skillsAdd(root, [SELF, ...SOME], opts);
  return root;
}

const CUSTOM = {
  glossary: "docs/domain/GLOSSARY.md",
  contextMap: "docs/domain/CONTEXT-MAP.md",
  adrDir: "docs/architecture/decisions",
  skillsConfigDir: ".agents/config",
  localTrackerDir: "work",
  outOfScopeDir: "docs/rejected",
  researchDir: "docs/research",
};
const asArgs = (paths) => Object.entries(paths).map(([k, v]) => `${k}=${v}`);

// ---------------------------------------------------------------- config

test("config: fills defaults and normalizes", () => {
  const { paths } = validateConfig({ paths: { adrDir: "./docs/decisions/" } });
  assert.equal(paths.adrDir, "docs/decisions");
  assert.equal(paths.glossary, "CONTEXT.md");
  assert.equal(paths.researchDir, null);
});

test("config: rejects unsafe or malformed values", () => {
  for (const paths of [
    { adrDir: "../elsewhere" },
    { adrDir: "/abs" },
    { adrDir: "a//b" },
    { adrDir: "." },
    { glossary: "GLOSSARY.txt" },
    { glossary: null },
    { nope: "x" },
    { adrDir: "has space" },
    { localTrackerDir: ".git/issues" },
    { localTrackerDir: "node_modules/x" },
    { adrDir: ".agents/skills/x" },
    { adrDir: ".claude/skills" },
    { adrDir: ".tabnine/agent/skills/x" },
    { adrDir: ".agents/skill-paths/originals" },
    { glossary: "AGENTS.md" },
    { glossary: "CLAUDE.md" },
    { glossary: "docs/G.md", contextMap: "docs/G.md" },
    { adrDir: "docs/x", localTrackerDir: "docs/x" },
  ]) {
    assert.throws(() => validateConfig({ paths }), undefined, JSON.stringify(paths));
  }
  assert.throws(() => validateConfig({ paths: {}, extra: 1 }));
});

test("set: validates, supports default and null", () => {
  const root = project();
  setPaths(root, ["adrDir=decisions/", "researchDir=notes"]);
  assert.deepEqual(JSON.parse(read(root, CONFIG_FILE)).paths.adrDir, "decisions");
  setPaths(root, ["adrDir=default", "researchDir=null"]);
  const { paths } = JSON.parse(read(root, CONFIG_FILE));
  assert.equal(paths.adrDir, "docs/adr");
  assert.equal(paths.researchDir, null);
  assert.throws(() => setPaths(root, ["glossary=null"]));
  assert.throws(() => setPaths(root, ["bogus=x"]), /unknown path key/);
  assert.throws(() => setPaths(root, ["adrDir"]), /key=value/);
});

// ---------------------------------------------------------------- render

test("render: default paths reproduce upstream except the instruction-file rule", () => {
  const changed = [];
  for (const [name, dir] of ALL) {
    const original = readSkill(dir);
    const { files } = renderFiles(name, original, defaultPaths());
    files.forEach((f, i) => {
      if (!f.content.equals(original[i].content)) changed.push(`${name}/${f.rel}`);
    });
  }
  assert.deepEqual(changed, ["setup-matt-pocock-skills/SKILL.md"]);
});

test("render: custom paths reach every reference", () => {
  const paths = validateConfig({ paths: CUSTOM }).paths;
  assert.match(renderOne("domain-modeling", "ADR-FORMAT.md", paths), /ADRs live in `docs\/architecture\/decisions\/`/);
  const domain = renderOne("setup-matt-pocock-skills", "domain.md", paths);
  assert.match(domain, /`src\/<context>\/docs\/architecture\/decisions\/`/);
  assert.match(domain, /\*\*`docs\/domain\/GLOSSARY\.md`\*\* at the repo root/);
  assert.match(renderOne("to-tickets", "SKILL.md", paths), /`work\/<feature-slug>\/issues\/<NN>-<slug>\.md`/);
  assert.match(renderOne("code-review", "SKILL.md", paths), /`\.agents\/config\/issue-tracker\.md`/);
  assert.match(renderOne("research", "SKILL.md", paths), /Save it under `docs\/research\/`/);
  assert.match(renderOne("triage", "OUT-OF-SCOPE.md", paths), /`docs\/rejected\/`/);
});

test("render: a substituted value is never rewritten again", () => {
  const paths = validateConfig({ paths: { glossary: "docs/adr/CONTEXT.md", adrDir: "docs/adr-log" } }).paths;
  assert.match(renderOne("domain-modeling", "ADR-FORMAT.md", paths), /ADRs live in `docs\/adr-log\/`/);
  const skill = renderOne("domain-modeling", "SKILL.md", paths);
  assert.match(skill, /`docs\/adr\/CONTEXT\.md`/);
  assert.doesNotMatch(skill, /docs\/adr-log\/CONTEXT\.md|docs\/adr-log-log/);
});

test("guard: passes on the current skills", () => {
  const { unmatched, leftovers } = runGuard();
  assert.deepEqual(unmatched, []);
  assert.deepEqual(leftovers, []);
});

// ---------------------------------------------------------------- apply

test("apply: rewrites installed skills in place and writes the project files", () => {
  const root = project();
  writeFileSync(join(root, "CLAUDE.md"), "# Project\n\nExisting notes.\n");
  assert.ok(status(root).skills.every((s) => s.copies.every((c) => c.state === "original")));

  setPaths(root, asArgs(CUSTOM));
  apply(root, { log: quiet });

  assert.match(read(root, ".agents/skills/domain-modeling/ADR-FORMAT.md"), /docs\/architecture\/decisions\//);
  assert.match(read(root, ".claude/skills/domain-modeling/ADR-FORMAT.md"), /docs\/architecture\/decisions\//, "via the symlink");
  assert.equal(
    read(root, ".agents/skill-paths/originals/.agents/skills/domain-modeling/ADR-FORMAT.md.orig"),
    readFileSync(join(ALL.get("domain-modeling"), "ADR-FORMAT.md"), "utf8"),
  );
  assert.match(read(root, `.agents/skills/${SELF}/scripts/lib/paths.mjs`), /default: "CONTEXT\.md"/, "never rewrites itself");
  assert.match(read(root, "CLAUDE.md"), /Existing notes\.\n\n@AGENTS\.md\n$/);
  assert.match(read(root, "AGENTS.md"), /\| `docs\/architecture\/decisions\/` \|/);
  assert.match(read(root, "AGENTS.md"), /\| `docs\/research\/` \|/);
  assert.doesNotMatch(read(root, "AGENTS.md"), /handoff/i);
  assert.ok(JSON.parse(read(root, LOCK_FILE)).copies[".agents/skills/domain-modeling"]);
  assert.deepEqual(check(root), []);
  assert.ok(status(root).skills.every((s) => s.copies.every((c) => c.state === "configured")));

  const before = read(root, "AGENTS.md");
  apply(root, { log: quiet });
  assert.equal(read(root, "AGENTS.md"), before, "idempotent");
  assert.deepEqual(check(root), []);
});

test("apply: reconfiguring starts from the original text, not the previous render", () => {
  const root = project();
  setPaths(root, asArgs(CUSTOM));
  apply(root, { log: quiet });
  setPaths(root, ["adrDir=decisions", "researchDir=null"]);
  apply(root, { log: quiet });
  const adr = read(root, ".agents/skills/domain-modeling/ADR-FORMAT.md");
  assert.match(adr, /ADRs live in `decisions\/`/);
  assert.doesNotMatch(adr, /architecture/);
  assert.match(read(root, ".agents/skills/research/SKILL.md"), /match the existing convention/);

  // Back to the defaults: identical to upstream apart from the AGENTS.md rule.
  for (const k of Object.keys(CUSTOM)) setPaths(root, [`${k}=default`]);
  apply(root, { log: quiet });
  for (const name of SOME) {
    for (const f of readSkill(ALL.get(name))) {
      if (name === "setup-matt-pocock-skills" && f.rel === "SKILL.md") continue;
      assert.equal(read(root, `.agents/skills/${name}/${f.rel}`), f.content.toString("utf8"), `${name}/${f.rel}`);
    }
  }
  assert.ok(!existsSync(join(root, ".agents/skill-paths/originals/.agents/skills/domain-modeling")));
});

test("apply: re-renders skills that npx skills update put back", () => {
  const root = project();
  setPaths(root, asArgs(CUSTOM));
  apply(root, { log: quiet });
  skillsAdd(root, ["domain-modeling"]);
  assert.ok(check(root).some((p) => p.includes("domain-modeling has the upstream paths")));
  apply(root, { log: quiet });
  assert.match(read(root, ".agents/skills/domain-modeling/ADR-FORMAT.md"), /docs\/architecture\/decisions\//);
  assert.deepEqual(check(root), []);
});

test("apply: refuses hand-edited skills unless forced", () => {
  const root = project();
  apply(root, { log: quiet });
  writeFileSync(join(root, ".agents/skills/tdd/SKILL.md"), "edited docs/adr/");
  assert.ok(check(root).some((p) => p.includes("tdd was edited by hand")));
  assert.throws(() => apply(root, { log: quiet }), /cannot recover the original text/);
  setPaths(root, ["adrDir=decisions"]);
  apply(root, { log: quiet, force: true });
  assert.equal(read(root, ".agents/skills/tdd/SKILL.md"), "edited decisions/");
});

test("apply: leaves skills from other sources alone", () => {
  const root = project();
  skillsAdd(root, ["triage"], { source: "someone/else" });
  setPaths(root, ["outOfScopeDir=docs/rejected"]);
  apply(root, { log: quiet });
  assert.match(read(root, ".agents/skills/triage/OUT-OF-SCOPE.md"), /`\.out-of-scope\/`/);
});

test("apply: renders every copy in copy mode", () => {
  const root = project({ mode: "copy" });
  setPaths(root, ["localTrackerDir=work"]);
  apply(root, { log: quiet });
  for (const base of [".agents", ".claude"]) {
    assert.match(read(root, `${base}/skills/to-tickets/SKILL.md`), /`work\/<feature-slug>/, base);
  }
  assert.deepEqual(check(root), []);
});

test("apply --dry-run: writes nothing", () => {
  const root = project();
  setPaths(root, ["localTrackerDir=work"]);
  apply(root, { log: quiet, dryRun: true });
  assert.ok(!existsSync(join(root, LOCK_FILE)));
  assert.ok(!existsSync(join(root, "AGENTS.md")));
  assert.match(read(root, ".agents/skills/to-tickets/SKILL.md"), /\.scratch\//);
});

test("apply: needs skills-lock.json listing this skill", () => {
  const root = mkdtempSync(join(tmpdir(), "configure-paths-"));
  assert.throws(() => apply(root, { log: quiet }), /skills-lock\.json not found/);
  writeFileSync(join(root, "skills-lock.json"), JSON.stringify({ version: 1, skills: {} }));
  assert.throws(() => apply(root, { log: quiet }), /not listed in skills-lock\.json/);
});

// ---------------------------------------------------------------- migration

test("apply --migrate: moves artifacts and rewrites references", () => {
  const root = project();
  execFileSync("git", ["init", "-q", root]);
  apply(root, { log: quiet });
  writeFileSync(join(root, "CONTEXT.md"), "# Glossary\n");
  mkdirSync(join(root, "src/ordering/docs/adr"), { recursive: true });
  writeFileSync(join(root, "src/ordering/CONTEXT.md"), "# Ordering\n");
  writeFileSync(join(root, "src/ordering/docs/adr/0001-x.md"), "# X\n");
  writeFileSync(join(root, "CONTEXT-MAP.md"), "- [Ordering](./src/ordering/CONTEXT.md)\n");
  mkdirSync(join(root, "docs/agents"), { recursive: true });
  writeFileSync(join(root, "docs/agents/domain.md"), "Read `CONTEXT.md` and `docs/adr/`.\n");
  writeFileSync(join(root, "AGENTS.md"), `${read(root, "AGENTS.md")}\nSee \`docs/agents/domain.md\`.\n`);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);

  setPaths(root, ["glossary=GLOSSARY.md", "adrDir=decisions", "skillsConfigDir=.agents/config"]);
  assert.throws(() => apply(root, { log: quiet }), /--migrate/);
  assert.ok(existsSync(join(root, "CONTEXT.md")), "does not move without --migrate");
  assert.equal(JSON.parse(read(root, LOCK_FILE)).config.paths.glossary, "CONTEXT.md", "keeps the old lock");

  apply(root, { log: quiet, migrate: true });
  assert.ok(existsSync(join(root, "GLOSSARY.md")));
  assert.ok(existsSync(join(root, "src/ordering/GLOSSARY.md")));
  assert.ok(existsSync(join(root, "src/ordering/decisions/0001-x.md")));
  assert.ok(!existsSync(join(root, "src/ordering/docs/adr")));
  assert.equal(read(root, "CONTEXT-MAP.md"), "- [Ordering](./src/ordering/GLOSSARY.md)\n");
  assert.equal(read(root, ".agents/config/domain.md"), "Read `GLOSSARY.md` and `decisions/`.\n");
  assert.match(read(root, "AGENTS.md"), /See `\.agents\/config\/domain\.md`/);
  const staged = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  assert.match(staged, /^R {2}CONTEXT\.md -> GLOSSARY\.md$/m, "tracked files move with git mv");
  assert.deepEqual(check(root), []);
});

test("apply --skip-migration: leaves artifacts in place", () => {
  const root = project();
  apply(root, { log: quiet });
  writeFileSync(join(root, "CONTEXT.md"), "# Glossary\n");
  setPaths(root, ["glossary=GLOSSARY.md"]);
  apply(root, { log: quiet, skipMigration: true });
  assert.ok(existsSync(join(root, "CONTEXT.md")));
  assert.deepEqual(check(root), []);
});

// ---------------------------------------------------------------- review regressions

test("hash: matches the computedHash npx skills 1.7.0 recorded for a fixture", () => {
  // Pinned from `npx skills@1.7.0 add installer/test/fixtures/hash-skill`.
  const fixture = new URL("./fixtures/hash-skill", import.meta.url).pathname;
  assert.equal(folderHash(readSkill(fixture)), "796783aa8785fc3900f287b3cdc7c2dc5be8caa487525f22f4fbe23bc4229cd1");
});

test("first apply: artifacts at the upstream defaults count as the previous locations", () => {
  const root = project();
  writeFileSync(join(root, "CONTEXT.md"), "# Glossary\n");
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  writeFileSync(join(root, "docs/adr/0001-x.md"), "# X\n");
  mkdirSync(join(root, "docs/agents"), { recursive: true });
  writeFileSync(join(root, "docs/agents/issue-tracker.md"), "# Tracker\n");
  writeFileSync(join(root, "CLAUDE.md"), "## Agent skills\n\nSee `docs/agents/issue-tracker.md`.\n");
  setPaths(root, ["glossary=GLOSSARY.md", "adrDir=decisions", "skillsConfigDir=agent-config"]);

  assert.throws(() => apply(root, { log: quiet }), /--migrate/);
  assert.ok(!existsSync(join(root, LOCK_FILE)), "nothing applied");
  apply(root, { log: quiet, migrate: true });
  assert.ok(existsSync(join(root, "GLOSSARY.md")));
  assert.ok(existsSync(join(root, "decisions/0001-x.md")));
  assert.ok(existsSync(join(root, "agent-config/issue-tracker.md")));
  assert.match(read(root, "CLAUDE.md"), /See `agent-config\/issue-tracker\.md`/);
  assert.deepEqual(check(root), []);
});

test("--force on a configured skill starts from the saved originals", () => {
  const root = project();
  skillsAdd(root, ["teach"]);
  setPaths(root, ["adrDir=adr", "teachDir=learn"]);
  apply(root, { log: quiet });
  const skillPath = join(root, ".agents/skills/domain-modeling/SKILL.md");
  writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}\nHand edit.\n`);
  writeFileSync(join(root, ".agents/skills/teach/NOTES.md"), "hand-added file\n");
  assert.throws(() => apply(root, { log: quiet }), /pass --force/);

  const logs = [];
  apply(root, { log: (m) => logs.push(m), force: true, skipMigration: true });
  assert.ok(logs.some((l) => l.includes("--force drops edits to .agents/skills/domain-modeling/SKILL.md")));
  setPaths(root, ["adrDir=architecture/decisions", "teachDir=learning"]);
  apply(root, { log: quiet, skipMigration: true });
  assert.match(read(root, ".agents/skills/domain-modeling/SKILL.md"), /architecture\/decisions\//);
  const mission = read(root, ".agents/skills/teach/MISSION-FORMAT.md");
  assert.equal(mission.match(/relative to the teaching workspace/g).length, 1);
  assert.match(mission, /`learning\/`/);
  assert.equal(read(root, ".agents/skills/teach/NOTES.md"), "hand-added file\n", "edits outside rendered files survive");
  assert.deepEqual(check(root), []);
});

test("--force cannot recover a configured skill whose originals are gone", () => {
  const root = project();
  setPaths(root, ["adrDir=adr"]);
  apply(root, { log: quiet });
  rmSync(join(root, ".agents/skill-paths/originals/.agents/skills/domain-modeling"), { recursive: true });
  writeFileSync(join(root, ".agents/skills/domain-modeling/extra.md"), "x");
  assert.throws(() => apply(root, { log: quiet, force: true }), /saved originals .* missing/);
});

test("CLAUDE.md symlinked to AGENTS.md gets the block once and no self-import", () => {
  const root = project();
  writeFileSync(join(root, "AGENTS.md"), "# Project\n");
  symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
  apply(root, { log: quiet });
  const text = read(root, "AGENTS.md");
  assert.match(text, /## Artifact locations/);
  assert.doesNotMatch(text, /@AGENTS\.md/);
  assert.ok(lstatSync(join(root, "CLAUDE.md")).isSymbolicLink());
  assert.deepEqual(check(root), []);
});

test("migration problems stop apply without --migrate", () => {
  const root = project();
  skillsAdd(root, ["teach"]);
  apply(root, { log: quiet });
  writeFileSync(join(root, "MISSION.md"), "# Mission\n");
  setPaths(root, ["teachDir=learning"]);
  assert.throws(() => apply(root, { log: quiet }), /teaching workspace .* by hand/);
  apply(root, { log: quiet, skipMigration: true });

  mkdirSync(join(root, "docs/adr"), { recursive: true });
  mkdirSync(join(root, "decisions"), { recursive: true });
  setPaths(root, ["adrDir=decisions"]);
  assert.throws(() => apply(root, { log: quiet }), /destination already exists/);
  assert.throws(() => apply(root, { log: quiet, migrate: true }), /destination already exists/);
});

test("migration refuses nested or overlapping moves before moving anything", () => {
  const root = project();
  apply(root, { log: quiet });
  mkdirSync(join(root, ".scratch/feature"), { recursive: true });
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  setPaths(root, ["localTrackerDir=.scratch/tracker", "adrDir=decisions"]);
  assert.throws(() => apply(root, { log: quiet, migrate: true }), /into itself/);
  assert.ok(existsSync(join(root, "docs/adr")), "the valid move did not run either");

  assert.throws(
    () => setPaths(root, ["localTrackerDir=default", "adrDir=docs/adr/archive", "glossary=docs/adr/archive/G.md"]),
    /is inside/,
  );

  // A lock from before that validation can still hold overlapping paths.
  const old = { ...defaultPaths(), glossary: "docs/adr/G.md" };
  writeFileSync(join(root, "docs/adr/G.md"), "# G\n");
  const { problems } = planMigration(root, old, { ...old, glossary: "G.md", adrDir: "decisions" });
  assert.ok(problems.some((p) => p.includes("overlaps")), problems.join("\n"));
});

test("migration rewrites references in one pass", () => {
  const root = project();
  apply(root, { log: quiet });
  writeFileSync(join(root, "CLAUDE.md"), `${read(root, "CLAUDE.md")}\nGlossary: \`CONTEXT.md\`.\n`);
  setPaths(root, ["glossary=docs/agents/GLOSSARY.md", "skillsConfigDir=config/agents"]);
  apply(root, { log: quiet, migrate: true });
  assert.match(read(root, "CLAUDE.md"), /Glossary: `docs\/agents\/GLOSSARY\.md`/);
});

test("dry-run migration lists a context map that moves", () => {
  const root = project();
  apply(root, { log: quiet });
  writeFileSync(join(root, "CONTEXT-MAP.md"), "- [Ordering](./src/ordering/CONTEXT.md)\n");
  setPaths(root, ["contextMap=domain/MAP.md", "glossary=GLOSSARY.md"]);
  const logs = [];
  apply(root, { log: (m) => logs.push(m), migrate: true, dryRun: true });
  assert.ok(logs.some((l) => l.includes("update path references in CONTEXT-MAP.md")), logs.join("\n"));
  apply(root, { log: quiet, migrate: true });
  assert.equal(read(root, "domain/MAP.md"), "- [Ordering](../src/ordering/GLOSSARY.md)\n", "re-based for its new folder");
});

test("copies in nested agent folders are rendered; a project's own skills/ folder is not", () => {
  const root = project({ copies: [".tabnine/agent/skills"] });
  mkdirSync(join(root, "skills/to-tickets"), { recursive: true });
  writeFileSync(join(root, "skills/to-tickets/SKILL.md"), "Project doc about `.scratch/`.\n");
  setPaths(root, ["localTrackerDir=work"]);
  apply(root, { log: quiet });
  assert.match(read(root, ".tabnine/agent/skills/to-tickets/SKILL.md"), /`work\/<feature-slug>/);
  assert.equal(read(root, "skills/to-tickets/SKILL.md"), "Project doc about `.scratch/`.\n");
  assert.deepEqual(check(root), []);
});

test("each copy is tracked on its own", () => {
  const root = project({ mode: "copy" });
  setPaths(root, ["localTrackerDir=work"]);
  apply(root, { log: quiet });
  // `npx skills` refreshes only the shared copy; the Claude copy stays rendered.
  cpSync(ALL.get("to-tickets"), join(root, ".agents/skills/to-tickets"), { recursive: true });
  assert.deepEqual(
    status(root).skills.find((s) => s.name === "to-tickets").copies.map((c) => c.state).sort(),
    ["configured", "original"],
  );
  apply(root, { log: quiet });
  assert.deepEqual(check(root), []);
});

test("re-apply with nothing to do writes and reports nothing", () => {
  const root = project();
  setPaths(root, ["localTrackerDir=work"]);
  apply(root, { log: quiet });
  const logs = [];
  apply(root, { log: (m) => logs.push(m) });
  assert.deepEqual(logs, []);
});

test("guard: flags a rule that stops matching in one of its files", () => {
  const tmp = mkdtempSync(join(tmpdir(), "guard-"));
  cpSync(ALL.get("teach"), tmp, { recursive: true });
  const file = join(tmp, "MISSION-FORMAT.md");
  writeFileSync(file, readFileSync(file, "utf8").replace(/^# .*\n/m, ""));
  const { unmatched } = runGuard(new Map([...ALL, ["teach", tmp]]));
  assert.deepEqual(unmatched, ["teach-format-note in teach/MISSION-FORMAT.md"]);
});

test("cli: status, set, apply and check run end to end", () => {
  const root = project();
  const cli = join(SELF_DIR, "scripts/configure.mjs");
  const run = (...args) => execFileSync("node", [cli, ...args, "--project", root], { encoding: "utf8" });
  assert.equal(JSON.parse(run("status")).paths.adrDir.default, "docs/adr");
  run("set", "adrDir=decisions");
  assert.match(run("apply"), /applied the paths to \d+ installed skill copies/);
  assert.match(run("check"), /match the configured paths/);
  writeFileSync(join(root, ".agents/skills/tdd/SKILL.md"), "edited");
  assert.throws(() => run("check"), (err) => err.status === 1 && /edited by hand/.test(err.stderr));
});

// ---------------------------------------------------------------- second review

test("migration rewrites only path-shaped references, from a non-default value", () => {
  const root = project();
  setPaths(root, ["localTrackerDir=issues", "adrDir=decisions"]);
  apply(root, { log: quiet });
  mkdirSync(join(root, "issues"), { recursive: true });
  mkdirSync(join(root, "docs/agents"), { recursive: true });
  const config = [
    "Implementation issues are one file per ticket at `issues/<feature-slug>/issues/<NN>-<slug>.md`.",
    "Past decisions live in `decisions/` ([index](../../decisions/README.md), [local](decisions/README.md)); see `other/decisions/`.",
    "",
  ].join("\n");
  writeFileSync(join(root, "docs/agents/issue-tracker.md"), config);
  setPaths(root, ["localTrackerDir=work/issues", "adrDir=docs/decisions"]);
  assert.throws(
    () => apply(root, { log: quiet }),
    (err) => /\+ Implementation issues are one file per ticket at `work\/issues\/<feature-slug>\/issues\//.test(err.message),
  );
  apply(root, { log: quiet, migrate: true });
  assert.equal(
    read(root, "docs/agents/issue-tracker.md"),
    [
      "Implementation issues are one file per ticket at `work/issues/<feature-slug>/issues/<NN>-<slug>.md`.",
      "Past decisions live in `docs/decisions/` ([index](../decisions/README.md), [local](decisions/README.md)); see `other/decisions/`.",
      "",
    ].join("\n"),
  );
});

test("migration looks for per-context artifacts only where the context map points", () => {
  const root = project();
  apply(root, { log: quiet });
  for (const dir of ["src/ordering", "third_party/lib", "build/docs/adr"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "src/ordering/CONTEXT.md"), "# Ordering\n");
  writeFileSync(join(root, "third_party/lib/CONTEXT.md"), "# Vendored\n");
  setPaths(root, ["glossary=GLOSSARY.md", "adrDir=decisions"]);
  apply(root, { log: quiet, skipMigration: true });
  assert.ok(existsSync(join(root, "third_party/lib/CONTEXT.md")), "no map: single context, nothing below the root");

  const root2 = project();
  apply(root2, { log: quiet });
  for (const dir of ["src/ordering/docs/adr", "third_party/lib"]) mkdirSync(join(root2, dir), { recursive: true });
  writeFileSync(join(root2, "src/ordering/CONTEXT.md"), "# Ordering\n");
  writeFileSync(join(root2, "third_party/lib/CONTEXT.md"), "# Vendored\n");
  writeFileSync(join(root2, "CONTEXT-MAP.md"), "- [Ordering](./src/ordering/CONTEXT.md)\n");
  setPaths(root2, ["glossary=GLOSSARY.md", "adrDir=decisions"]);
  apply(root2, { log: quiet, migrate: true });
  assert.ok(existsSync(join(root2, "src/ordering/GLOSSARY.md")));
  assert.ok(existsSync(join(root2, "src/ordering/decisions")));
  assert.ok(existsSync(join(root2, "third_party/lib/CONTEXT.md")), "vendored copy untouched");
});

test("a dangling CLAUDE.md -> AGENTS.md symlink still means one file", () => {
  const root = project();
  symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
  apply(root, { log: quiet });
  const text = read(root, "AGENTS.md");
  assert.match(text, /## Artifact locations/);
  assert.doesNotMatch(text, /@AGENTS\.md/);
  assert.deepEqual(check(root), []);
});

test("a symlinked skills folder is not counted as a second copy", () => {
  const root = mkdtempSync(join(tmpdir(), "configure-paths-"));
  skillsAdd(root, [SELF, "to-tickets"]);
  rmSync(join(root, ".claude/skills"), { recursive: true });
  symlinkSync("../.agents/skills", join(root, ".claude/skills"), "dir");
  setPaths(root, ["localTrackerDir=work"]);
  const lock = apply(root, { log: quiet });
  assert.deepEqual(Object.keys(lock.copies), [".agents/skills/to-tickets"]);
});

test("reserved names are case-insensitive; ./default is a literal folder; flags conflict", () => {
  for (const paths of [{ localTrackerDir: ".GIT/x" }, { adrDir: "Node_Modules/x" }, { glossary: "agents.md" }, { adrDir: ".Claude/Skills" }]) {
    assert.throws(() => validateConfig({ paths }), undefined, JSON.stringify(paths));
  }
  const root = project();
  setPaths(root, ["localTrackerDir=./default"]);
  assert.equal(JSON.parse(read(root, CONFIG_FILE)).paths.localTrackerDir, "default");
  assert.throws(() => apply(root, { log: quiet, migrate: true, skipMigration: true }), /cannot be used together/);
});

test("the reinstall hint names the source and the agent flags", () => {
  const root = project({ mode: "copy" });
  apply(root, { log: quiet });
  writeFileSync(join(root, ".claude/skills/tdd/SKILL.md"), "edited");
  assert.throws(
    () => apply(root, { log: quiet }),
    (err) =>
      err.message.includes(`npx skills add ${SOURCE} --skill tdd --agent <the agents you installed for> -y --copy`) &&
      err.message.includes("repeating the --agent (and --copy) flags"),
  );
});

// Drives the real `skills` CLI. Needs network; opt in with REAL_SKILLS_CLI=1.
test("real npx skills: install, configure, reinstall, re-apply", { skip: !process.env.REAL_SKILLS_CLI }, () => {
  const repo = new URL("../..", import.meta.url).pathname;
  const root = mkdtempSync(join(tmpdir(), "configure-paths-real-"));
  const env = { ...process.env, DISABLE_TELEMETRY: "1" };
  const skills = (...args) =>
    execFileSync("npx", ["-y", "skills@1.7.0", "add", repo, "-y", "--agent", "claude-code", "codex", "opencode", ...args], {
      cwd: root,
      env,
      stdio: "ignore",
    });
  execFileSync("git", ["init", "-q", root]);
  skills("--skill", SELF, "domain-modeling", "to-tickets");
  assert.ok(status(root).skills.every((s) => s.copies.every((c) => c.state === "original")), "hashes match the CLI");
  setPaths(root, ["adrDir=decisions", "localTrackerDir=work"]);
  apply(root, { log: quiet });
  assert.deepEqual(check(root), []);
  skills("--skill", "domain-modeling");
  assert.ok(check(root).some((p) => p.includes("domain-modeling has the upstream paths")));
  apply(root, { log: quiet });
  assert.deepEqual(check(root), []);
  assert.match(read(root, ".claude/skills/domain-modeling/ADR-FORMAT.md"), /`decisions\/`/);
});

test("links to root artifacts stay correct when the context map moves or sits in a folder", () => {
  const root = project();
  apply(root, { log: quiet });
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  mkdirSync(join(root, ".scratch/feat"), { recursive: true });
  mkdirSync(join(root, "src/ordering"), { recursive: true });
  writeFileSync(join(root, "CONTEXT.md"), "# G\n");
  writeFileSync(join(root, "src/ordering/CONTEXT.md"), "# O\n");
  writeFileSync(join(root, ".scratch/feat/spec.md"), "# S\n");
  writeFileSync(
    join(root, "CONTEXT-MAP.md"),
    "- [root](./CONTEXT.md) [adr](./docs/adr/) [work](.scratch/feat/spec.md) [ordering](./src/ordering/CONTEXT.md) [site](https://x.y/docs/adr/)\n",
  );
  setPaths(root, ["glossary=docs/GLOSSARY.md", "contextMap=docs/MAP.md", "adrDir=docs/decisions", "localTrackerDir=work"]);
  apply(root, { log: quiet, migrate: true });
  assert.equal(
    read(root, "docs/MAP.md"),
    "- [root](./GLOSSARY.md) [adr](./decisions/) [work](../work/feat/spec.md) [ordering](../src/ordering/docs/GLOSSARY.md) [site](https://x.y/docs/adr/)\n",
  );
  for (const target of ["docs/GLOSSARY.md", "docs/decisions", "work/feat/spec.md", "src/ordering/docs/GLOSSARY.md"]) {
    assert.ok(existsSync(join(root, target)), target);
  }

  // The map stays in docs/; the glossary moves again.
  setPaths(root, ["glossary=domain/GLOSSARY.md"]);
  apply(root, { log: quiet, migrate: true });
  assert.match(read(root, "docs/MAP.md"), /\[root\]\(\.\.\/domain\/GLOSSARY\.md\)/);
  assert.match(read(root, "docs/MAP.md"), /\[ordering\]\(\.\.\/src\/ordering\/domain\/GLOSSARY\.md\)/);
  assert.ok(existsSync(join(root, "src/ordering/domain/GLOSSARY.md")));
});

// ---------------------------------------------------------------- third review

test("a lock from before a path key existed treats the key as its default", () => {
  const root = project();
  setPaths(root, ["adrDir=decisions"]);
  apply(root, { log: quiet });
  const lock = JSON.parse(read(root, LOCK_FILE));
  delete lock.config.paths.outOfScopeDir;
  lock.config.paths.retiredKey = "old";
  writeFileSync(join(root, LOCK_FILE), JSON.stringify(lock));
  assert.deepEqual(check(root), []);
  apply(root, { log: quiet });
  assert.deepEqual(check(root), []);
});

test("render: files of any extension are rendered when they are text", () => {
  const files = [
    { rel: "scripts/new.ts", content: Buffer.from('const dir = ".scratch/issues";\n') },
    { rel: "logo.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]) },
  ];
  const { files: out } = renderFiles("x", files, validateConfig({ paths: { localTrackerDir: "work" } }).paths);
  assert.equal(out[0].content.toString(), 'const dir = "work/issues";\n');
  assert.ok(out[1].content.equals(files[1].content));
});

test("render: setup moves an existing Agent skills block out of CLAUDE.md", () => {
  assert.match(renderOne("setup-matt-pocock-skills", "SKILL.md", defaultPaths()), /move it into `AGENTS\.md` and delete it from `CLAUDE\.md`/);
});

test("render: tree comments stay aligned", () => {
  const paths = validateConfig({ paths: { adrDir: "docs/architecture/decisions", glossary: "docs/domain/GLOSSARY.md" } }).paths;
  const arrows = renderOne("domain-modeling", "SKILL.md", paths)
    .split("\n")
    .filter((l) => l.includes(" ← "))
    .map((l) => l.indexOf("←"));
  assert.equal(new Set(arrows).size, 1, `arrow columns: ${arrows}`);
});

test("config: nested paths and agent home folders are refused", () => {
  for (const paths of [
    { adrDir: "docs" },
    { glossary: "docs/adr/GLOSSARY.md" },
    { localTrackerDir: ".agents" },
    { localTrackerDir: ".Claude" },
    { researchDir: "learning/research", teachDir: "learning" },
  ]) {
    assert.throws(() => validateConfig({ paths }), /inside|agent's own folder/, JSON.stringify(paths));
  }
  assert.doesNotThrow(() => validateConfig({ paths: { skillsConfigDir: ".agents/config", glossary: "GLOSSARY.md" } }));
});

test("config: teach workspace collisions only matter when /teach is installed", () => {
  const root = project();
  setPaths(root, ["glossary=GLOSSARY.md"]);
  skillsAdd(root, ["teach"]);
  assert.throws(() => apply(root, { log: quiet }), /collides with the \/teach workspace's GLOSSARY\.md/);
  setPaths(root, ["teachDir=learning"]);
  apply(root, { log: quiet });
});

test("a migration stopped halfway finishes with --migrate", () => {
  const root = project();
  apply(root, { log: quiet });
  writeFileSync(join(root, "CONTEXT.md"), "# G\n");
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), `${read(root, "CLAUDE.md")}\nSee \`CONTEXT.md\` and \`docs/adr/\`.\n`);
  setPaths(root, ["glossary=GLOSSARY.md", "adrDir=decisions"]);
  // As if the run died after its first move.
  execFileSync("mv", [join(root, "CONTEXT.md"), join(root, "GLOSSARY.md")]);
  apply(root, { log: quiet, migrate: true });
  assert.ok(existsSync(join(root, "decisions")));
  assert.match(read(root, "CLAUDE.md"), /See `GLOSSARY\.md` and `decisions\/`\./);
  assert.deepEqual(check(root), []);
});

test("AGENTS.md table leaves /teach out while its workspace is the default", () => {
  const root = project();
  apply(root, { log: quiet });
  assert.doesNotMatch(read(root, "AGENTS.md"), /Teaching workspace/);
  setPaths(root, ["teachDir=learning"]);
  apply(root, { log: quiet });
  assert.match(read(root, "AGENTS.md"), /\| Teaching workspace \(\/teach\) \| `learning\/` \|/);
});

test("real npx skills --copy: every copy is rendered and re-rendered", { skip: !process.env.REAL_SKILLS_CLI }, () => {
  const repo = new URL("../..", import.meta.url).pathname;
  const root = mkdtempSync(join(tmpdir(), "configure-paths-real-copy-"));
  const skills = (...args) =>
    execFileSync("npx", ["-y", "skills@1.7.0", "add", repo, "-y", "--copy", ...args], {
      cwd: root,
      env: { ...process.env, DISABLE_TELEMETRY: "1" },
      stdio: "ignore",
    });
  execFileSync("git", ["init", "-q", root]);
  skills("--agent", "claude-code", "codex", "--skill", SELF, "to-tickets");
  setPaths(root, ["localTrackerDir=work"]);
  apply(root, { log: quiet });
  assert.deepEqual(check(root), []);
  skills("--agent", "claude-code", "--skill", "to-tickets");
  assert.ok(check(root).some((p) => p.includes(".claude/skills/to-tickets has the upstream paths")));
  apply(root, { log: quiet });
  assert.deepEqual(check(root), []);
  for (const base of [".agents", ".claude"]) assert.match(read(root, `${base}/skills/to-tickets/SKILL.md`), /`work\//);
});
