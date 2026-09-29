import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSkills, readSkill, runGuard } from "../guard.mjs";
import { CONFIG_FILE, LOCK_FILE, defaultPaths, validateConfig } from "../../skills/fork/configure-artifact-paths/scripts/lib/paths.mjs";
import { renderFiles } from "../../skills/fork/configure-artifact-paths/scripts/lib/render.mjs";
import { SELF, apply, check, folderHash, setPaths, status } from "../../skills/fork/configure-artifact-paths/scripts/lib/project.mjs";

const quiet = () => {};
const SOURCE = "grAItools/custom-mattpocock-skills";
const SELF_DIR = new URL("../../skills/fork/configure-artifact-paths", import.meta.url).pathname;
const ALL = listSkills();
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const renderOne = (name, rel, paths) =>
  renderFiles(name, readSkill(ALL.get(name)), paths).files.find((f) => f.rel === rel).content.toString("utf8");

// What `npx skills add <source>` leaves behind: canonical copies in
// .agents/skills, Claude Code links (or copies), and skills-lock.json.
function skillsAdd(root, names, { mode = "symlink", source = SOURCE } = {}) {
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
    read(root, ".agents/skill-paths/originals/domain-modeling/ADR-FORMAT.md.orig"),
    readFileSync(join(ALL.get("domain-modeling"), "ADR-FORMAT.md"), "utf8"),
  );
  assert.match(read(root, `.agents/skills/${SELF}/scripts/lib/paths.mjs`), /default: "CONTEXT\.md"/, "never rewrites itself");
  assert.match(read(root, "CLAUDE.md"), /Existing notes\.\n\n@AGENTS\.md\n$/);
  assert.match(read(root, "AGENTS.md"), /\| `docs\/architecture\/decisions\/` \|/);
  assert.match(read(root, "AGENTS.md"), /\| `docs\/research\/` \|/);
  assert.doesNotMatch(read(root, "AGENTS.md"), /handoff/i);
  assert.ok(JSON.parse(read(root, LOCK_FILE)).skills["domain-modeling"]);
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
  assert.ok(!existsSync(join(root, ".agents/skill-paths/originals/domain-modeling")));
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
