import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGuard } from "../guard.mjs";
import { CONFIG_FILE, LOCK_FILE, defaultPaths, validateConfig } from "../paths.mjs";
import { check, install } from "../project.mjs";
import { listSkills, renderSkill } from "../render.mjs";

const quiet = () => {};
const tmpProject = () => mkdtempSync(join(tmpdir(), "skills-install-"));
const writeConfig = (root, paths, extra = {}) => {
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ paths, ...extra }, null, 2));
};
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const renderOne = (name, rel, paths) =>
  renderSkill(name, listSkills().get(name), paths)
    .files.find((f) => f.rel === rel)
    .content.toString("utf8");

const CUSTOM = {
  glossary: "docs/domain/GLOSSARY.md",
  contextMap: "docs/domain/CONTEXT-MAP.md",
  adrDir: "docs/architecture/decisions",
  skillsConfigDir: ".agents/config",
  localTrackerDir: "work",
  outOfScopeDir: "docs/rejected",
  researchDir: "docs/research",
};

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
  assert.throws(() => validateConfig({ extraSkills: ["Bad Name"] }));
});

test("render: default paths reproduce upstream except the instruction-file rule", () => {
  const changed = [];
  for (const [name, dir] of listSkills()) {
    for (const f of renderSkill(name, dir, defaultPaths()).files) {
      if (!f.content.equals(readFileSync(join(dir, f.rel)))) changed.push(`${name}/${f.rel}`);
    }
  }
  assert.deepEqual(changed, ["setup-matt-pocock-skills/SKILL.md"]);
});

test("render: custom paths reach every reference", () => {
  const paths = validateConfig({ paths: CUSTOM }).paths;
  const adr = renderOne("domain-modeling", "ADR-FORMAT.md", paths);
  assert.match(adr, /ADRs live in `docs\/architecture\/decisions\/`/);
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
  const text = renderOne("domain-modeling", "ADR-FORMAT.md", paths);
  assert.match(text, /ADRs live in `docs\/adr-log\/`/);
  const skill = renderOne("domain-modeling", "SKILL.md", paths);
  assert.match(skill, /`docs\/adr\/CONTEXT\.md`/);
  assert.doesNotMatch(skill, /docs\/adr-log\/CONTEXT\.md|docs\/adr-log-log/);
});

test("guard: passes on the current skills", () => {
  const { unmatched, leftovers } = runGuard();
  assert.deepEqual(unmatched, []);
  assert.deepEqual(leftovers, []);
});

test("install: writes skills, links, instruction files and lock; check passes", () => {
  const root = tmpProject();
  writeFileSync(join(root, "CLAUDE.md"), "# Project\n\nExisting notes.\n");
  writeConfig(root, CUSTOM, { extraSkills: ["pr"] });
  install(root, { log: quiet });

  const adr = read(root, ".agents/skills/domain-modeling/ADR-FORMAT.md");
  assert.match(adr, /docs\/architecture\/decisions\//);
  assert.ok(existsSync(join(root, ".agents/skills/pr/SKILL.md")));
  const link = join(root, ".claude/skills/tdd");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), "../../.agents/skills/tdd");
  assert.ok(existsSync(join(link, "SKILL.md")));

  assert.match(read(root, "CLAUDE.md"), /Existing notes\.\n\n@AGENTS\.md\n$/);
  assert.match(read(root, "AGENTS.md"), /\| `docs\/architecture\/decisions\/` \|/);
  assert.match(read(root, "AGENTS.md"), /\| `docs\/research\/` \|/);
  assert.doesNotMatch(read(root, "AGENTS.md"), /handoff/i);
  assert.ok(JSON.parse(read(root, LOCK_FILE)).skills["domain-modeling"]);
  assert.deepEqual(check(root), []);

  // Idempotent: a second run changes nothing the check can see.
  const agentsBefore = read(root, "AGENTS.md");
  install(root, { log: quiet });
  assert.equal(read(root, "AGENTS.md"), agentsBefore);
  assert.deepEqual(check(root), []);
});

test("check: reports hand edits and config changes", () => {
  const root = tmpProject();
  install(root, { log: quiet });
  assert.ok(existsSync(join(root, CONFIG_FILE)), "writes a default config");
  writeFileSync(join(root, ".agents/skills/tdd/SKILL.md"), "edited");
  writeConfig(root, { adrDir: "decisions" });
  const problems = check(root);
  assert.ok(problems.some((p) => p.includes("tdd/SKILL.md was edited by hand")));
  assert.ok(problems.some((p) => p.includes("changed since the last install")));
});

test("install: keeps foreign skill folders unless forced, removes dropped skills", () => {
  const root = tmpProject();
  mkdirSync(join(root, ".claude/skills/tdd"), { recursive: true });
  mkdirSync(join(root, ".claude/skills/my-own-skill"), { recursive: true });
  assert.throws(() => install(root, { log: quiet }), /not installed by this installer/);
  install(root, { log: quiet, force: true });
  assert.ok(existsSync(join(root, ".claude/skills/my-own-skill")));

  writeConfig(root, {}, { extraSkills: ["pr"] });
  install(root, { log: quiet });
  assert.ok(existsSync(join(root, ".agents/skills/pr")));
  writeConfig(root, {});
  install(root, { log: quiet });
  assert.ok(!existsSync(join(root, ".agents/skills/pr")));
  assert.ok(!existsSync(join(root, ".claude/skills/pr")));
});

test("install --claude-copy: copies instead of linking", () => {
  const root = tmpProject();
  install(root, { log: quiet, claudeCopy: true });
  assert.ok(lstatSync(join(root, ".claude/skills/tdd")).isDirectory());
  assert.deepEqual(check(root), []);
});

test("install --dry-run: writes nothing", () => {
  const root = tmpProject();
  install(root, { log: quiet, dryRun: true });
  assert.ok(!existsSync(join(root, ".agents")));
  assert.ok(!existsSync(join(root, "AGENTS.md")));
});

test("install --migrate: moves artifacts and rewrites references", () => {
  const root = tmpProject();
  execFileSync("git", ["init", "-q", root]);
  install(root, { log: quiet });
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

  writeConfig(root, { glossary: "GLOSSARY.md", adrDir: "decisions", skillsConfigDir: ".agents/config" });
  assert.throws(() => install(root, { log: quiet }), /--migrate/);
  assert.ok(existsSync(join(root, "CONTEXT.md")), "does not move without --migrate");
  assert.equal(JSON.parse(read(root, LOCK_FILE)).config.paths.glossary, "CONTEXT.md", "keeps the old lock");

  install(root, { log: quiet, migrate: true });
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

test("install --skip-migration: leaves artifacts in place", () => {
  const root = tmpProject();
  install(root, { log: quiet });
  writeFileSync(join(root, "CONTEXT.md"), "# Glossary\n");
  writeConfig(root, { glossary: "GLOSSARY.md" });
  install(root, { log: quiet, skipMigration: true });
  assert.ok(existsSync(join(root, "CONTEXT.md")));
  assert.deepEqual(check(root), []);
});
