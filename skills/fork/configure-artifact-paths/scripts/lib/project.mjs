// Applies a project's artifact paths to the skills `npx skills add` installed
// from this repo, in place.
//
// `npx skills` copies skills verbatim and re-copies them on update, so the
// installed text is either:
//   - original: matches the hash `npx skills` recorded in skills-lock.json
//     (fresh install or update), or
//   - rendered by us: matches the hash in our lock file. The original is then
//     the installed text with the changed files swapped for the copies we
//     kept in ORIGINALS_DIR.
// Anything else was edited by hand and is left alone unless forced.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { CONFIG_FILE, LOCK_FILE, ORIGINALS_DIR, PATH_KEYS, defaultPaths, normalizePath, validateConfig } from "./paths.mjs";
import { renderFiles } from "./render.mjs";

export const SELF = "configure-artifact-paths";
export const SKILLS_LOCK = "skills-lock.json";
const BLOCK_START = "<!-- mattpocock-skills:paths:start -->";
const BLOCK_END = "<!-- mattpocock-skills:paths:end -->";
const IMPORT_LINE = "@AGENTS.md";
const MIGRATION_SKIP_DIRS = new Set([".git", "node_modules", ".agents", ".claude", "vendor"]);
const ORIG_SUFFIX = ".orig";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rel = (root, p) => relative(root, p).split(sep).join("/");

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isKind(path, kind) {
  try {
    const st = lstatSync(path);
    return kind === "dir" ? st.isDirectory() : st.isFile();
  } catch {
    return false;
  }
}

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- files

function readSkillDir(dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git" && entry.name !== "node_modules") walk(full);
      } else if (entry.isFile()) {
        files.push({ rel: rel(dir, full), content: readFileSync(full), mode: lstatSync(full).mode & 0o777 });
      }
    }
  };
  walk(dir);
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

// Same algorithm as `npx skills` (computeSkillFolderHash), so hashes compare
// with the `computedHash` it writes to skills-lock.json.
export function folderHash(files) {
  const hash = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    hash.update(f.rel);
    hash.update(f.content);
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------- config

export function loadConfig(root) {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return { exists: false, config: validateConfig({}) };
  let raw;
  try {
    raw = readJson(file);
  } catch (err) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${err.message}`);
  }
  return { exists: true, config: validateConfig(raw) };
}

function writeConfig(root, config) {
  const file = join(root, CONFIG_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

// assignments: ["key=value", ...]. `default` restores the default; `null`
// clears an optional key.
export function setPaths(root, assignments) {
  const { config } = loadConfig(root);
  const paths = { ...config.paths };
  for (const a of assignments) {
    const eq = a.indexOf("=");
    if (eq === -1) throw new Error(`expected key=value, got ${JSON.stringify(a)}`);
    const key = a.slice(0, eq).trim();
    const value = a.slice(eq + 1).trim();
    if (!(key in PATH_KEYS)) normalizePath(key, value);
    paths[key] = value === "default" ? PATH_KEYS[key].default : normalizePath(key, value === "null" ? null : value);
  }
  const next = validateConfig({ paths });
  writeConfig(root, next);
  return next;
}

export function loadLock(root) {
  const file = join(root, LOCK_FILE);
  return existsSync(file) ? readJson(file) : null;
}

// ---------------------------------------------------------------- discovery

// The skills installed from the same source as this skill, per skills-lock.json.
export function managedSkills(root) {
  const file = join(root, SKILLS_LOCK);
  if (!existsSync(file)) {
    throw new Error(`${SKILLS_LOCK} not found in ${root}: install the skills into this project with \`npx skills add\` first`);
  }
  const lock = readJson(file);
  const self = lock.skills?.[SELF];
  if (!self) {
    throw new Error(`${SELF} is not listed in ${SKILLS_LOCK}: install it with \`npx skills add\` in this project first`);
  }
  const source = (self.sourceUrl ?? self.source ?? "").toLowerCase();
  return Object.entries(lock.skills)
    .filter(([name, e]) => name !== SELF && (e.sourceUrl ?? e.source ?? "").toLowerCase() === source)
    .map(([name, e]) => ({ name, computedHash: e.computedHash ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Real (non-symlink) folders holding an installed copy of `name`: the shared
// `.agents/skills/<name>`, plus agent folders when installed in copy mode.
// Symlinked agent folders point at the shared copy and need no work.
export function skillCopies(root, name) {
  const bases = new Set([".agents"]);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // Agent folders are hidden top-level folders (`.claude`, `.pi`, ...).
    if (entry.isDirectory() && entry.name.startsWith(".") && entry.name !== ".git") bases.add(entry.name);
  }
  const copies = [];
  for (const base of bases) {
    const dir = join(root, base, "skills", name);
    if (isKind(dir, "dir") && existsSync(join(dir, "SKILL.md"))) copies.push(dir);
  }
  return copies;
}

function originalsFor(root, name, current, entry) {
  const dir = join(root, ORIGINALS_DIR, name);
  const byRel = new Map(current.map((f) => [f.rel, f]));
  for (const r of entry.changed) {
    const saved = join(dir, r + ORIG_SUFFIX);
    if (!existsSync(saved)) return null;
    byRel.set(r, { ...byRel.get(r), rel: r, content: readFileSync(saved) });
  }
  return [...byRel.values()];
}

// Classifies one installed copy and recovers its original files.
export function inspectCopy(root, skill, dir, lock) {
  const current = readSkillDir(dir);
  const hash = folderHash(current);
  const entry = lock?.skills?.[skill.name];
  if (entry && hash === entry.renderedHash) {
    const original = originalsFor(root, skill.name, current, entry);
    if (original && folderHash(original) === entry.originalHash) {
      return { state: "configured", current, original };
    }
    return { state: "broken", current, original: null };
  }
  if (skill.computedHash && hash === skill.computedHash) {
    return { state: "original", current, original: current };
  }
  return { state: "modified", current, original: null };
}

// ---------------------------------------------------------------- AGENTS.md

export function managedBlock(paths) {
  const rows = Object.entries(PATH_KEYS)
    .filter(([key]) => paths[key] !== null)
    .map(([key, spec]) => {
      const where = spec.scope === "context" ? " (per context)" : "";
      const value = paths[key] === "." ? "the repo root" : `\`${paths[key]}${spec.kind === "dir" ? "/" : ""}\``;
      return `| ${spec.label}${where} | ${value} |`;
    });
  return [
    BLOCK_START,
    "## Artifact locations",
    "",
    `Generated by \`/configure-artifact-paths\` from \`${CONFIG_FILE}\`: change paths by running that skill again, not by editing this block. "Per context" paths are relative to each context root, which is the repo root in a single-context project; every other path is relative to the repo root.`,
    "",
    "If an installed skill names a different location for one of these artifacts (for example right after `npx skills add` or `npx skills update` replaced it), use the path in this table and tell the user to run `/configure-artifact-paths`.",
    "",
    "| Artifact | Path |",
    "|---|---|",
    ...rows,
    BLOCK_END,
  ].join("\n");
}

function upsertBlock(text, block) {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start !== -1 && end > start) {
    return text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
  }
  const base = text.replace(/\s*$/, "");
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

const hasImport = (text) => text.split(/\r?\n/).some((line) => line.trim() === IMPORT_LINE);

export function instructionFiles(root, paths) {
  const agentsPath = join(root, "AGENTS.md");
  const claudePath = join(root, "CLAUDE.md");
  const agents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  const claude = existsSync(claudePath) ? readFileSync(claudePath, "utf8") : "";
  const nextClaude = hasImport(claude)
    ? claude
    : claude.trim()
      ? `${claude.replace(/\s*$/, "")}\n\n${IMPORT_LINE}\n`
      : `${IMPORT_LINE}\n`;
  return [
    { path: agentsPath, before: agents, after: upsertBlock(agents, managedBlock(paths)) },
    { path: claudePath, before: claude, after: nextClaude },
  ];
}

// ---------------------------------------------------------------- migration

function walkDirs(dir, out) {
  out.push(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !MIGRATION_SKIP_DIRS.has(entry.name)) walkDirs(join(dir, entry.name), out);
  }
  return out;
}

// Moves needed to bring existing artifacts from `oldPaths` to `newPaths`.
export function planMigration(root, oldPaths, newPaths) {
  const moves = [];
  const problems = [];
  const contextRoots = walkDirs(root, []);
  for (const [key, spec] of Object.entries(PATH_KEYS)) {
    const from = oldPaths[key];
    const to = newPaths[key];
    if (from === to || from === null || to === null) continue;
    if (key === "teachDir") {
      if (existsSync(join(root, from === "." ? "MISSION.md" : from))) {
        problems.push(`teachDir changed (${from} -> ${to}): move the teaching workspace by hand`);
      }
      continue;
    }
    for (const base of spec.scope === "context" ? contextRoots : [root]) {
      const src = join(base, from);
      if (!isKind(src, spec.kind)) continue;
      const dest = join(base, to);
      if (exists(dest)) {
        problems.push(`${rel(root, src)} -> ${rel(root, dest)}: destination already exists`);
        continue;
      }
      moves.push({ src, dest });
    }
  }
  return { moves, problems };
}

function pathTokenRegex(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-])`, "g");
}

// References to moved paths in the files known to hold them: the
// instruction files, the context map, and the config written by
// /setup-matt-pocock-skills.
export function planReferenceRewrites(root, oldPaths, newPaths) {
  const candidates = [join(root, "AGENTS.md"), join(root, "CLAUDE.md"), join(root, newPaths.contextMap)];
  for (const dir of [join(root, newPaths.skillsConfigDir), join(root, oldPaths.skillsConfigDir)]) {
    if (isKind(dir, "dir")) {
      for (const f of readdirSync(dir)) if (f.endsWith(".md")) candidates.push(join(dir, f));
    }
  }
  const changed = Object.keys(PATH_KEYS).filter(
    (k) => k !== "teachDir" && oldPaths[k] !== newPaths[k] && oldPaths[k] !== null && newPaths[k] !== null,
  );
  const rewrites = [];
  for (const file of new Set(candidates)) {
    if (!isKind(file, "file")) continue;
    const before = readFileSync(file, "utf8");
    // The generated block is rebuilt from the config anyway: leave it out.
    const start = before.indexOf(BLOCK_START);
    const end = before.indexOf(BLOCK_END);
    const [head, block, tail] =
      start !== -1 && end > start
        ? [before.slice(0, start), before.slice(start, end), before.slice(end)]
        : [before, "", ""];
    const rewrite = (text) => changed.reduce((t, key) => t.replace(pathTokenRegex(oldPaths[key]), newPaths[key]), text);
    const after = rewrite(head) + block + rewrite(tail);
    if (after !== before) rewrites.push({ file, after });
  }
  return rewrites;
}

function moveArtifact(root, src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  if (git(root, ["ls-files", "--", rel(root, src)])) {
    execFileSync("git", ["-C", root, "mv", rel(root, src), rel(root, dest)], { stdio: "ignore" });
  } else {
    renameSync(src, dest);
  }
}

// ---------------------------------------------------------------- status

// A read-only snapshot for the agent to present to the user.
export function status(root) {
  const { exists: configExists, config } = loadConfig(root);
  const lock = loadLock(root);
  const skills = managedSkills(root).map((skill) => {
    const copies = skillCopies(root, skill.name).map((dir) => ({
      dir: rel(root, dir),
      state: inspectCopy(root, skill, dir, lock).state,
    }));
    return { name: skill.name, copies };
  });
  const defaults = defaultPaths();
  return {
    configFile: CONFIG_FILE,
    configExists,
    appliedPaths: lock?.config?.paths ?? null,
    paths: Object.fromEntries(
      Object.entries(PATH_KEYS).map(([key, spec]) => [
        key,
        {
          value: config.paths[key],
          default: defaults[key],
          label: spec.label,
          relativeTo: spec.scope === "context" ? "each context root" : "repo root",
          optional: spec.default === null,
        },
      ]),
    ),
    skills,
  };
}

// ---------------------------------------------------------------- apply

export function apply(root, opts = {}) {
  const { dryRun = false, migrate = false, skipMigration = false, force = false, log = console.log } = opts;
  const act = (msg, fn) => {
    log(`${dryRun ? "[dry-run] " : ""}${msg}`);
    if (!dryRun) fn();
  };

  const { exists: configExists, config } = loadConfig(root);
  const lock = loadLock(root);
  const skills = managedSkills(root);

  // Recover every copy's original text before touching anything.
  const work = [];
  const blocked = [];
  for (const skill of skills) {
    const copies = skillCopies(root, skill.name);
    if (!copies.length) {
      log(`skip ${skill.name}: listed in ${SKILLS_LOCK} but not installed`);
      continue;
    }
    for (const dir of copies) {
      const info = inspectCopy(root, skill, dir, lock);
      if (!info.original) {
        if (!force) {
          blocked.push(`${rel(root, dir)} (${info.state === "broken" ? `missing originals under ${ORIGINALS_DIR}` : "edited since it was installed"})`);
          continue;
        }
        info.original = info.current;
      }
      work.push({ skill, dir, ...info });
    }
  }
  if (blocked.length) {
    throw new Error(
      `cannot recover the original text of:\n  ${blocked.join("\n  ")}\nreinstall them with \`npx skills add <source> --skill <name> -y\`, or pass --force to treat their current text as the original`,
    );
  }

  // Artifacts at the previously applied locations.
  const oldPaths = lock?.config?.paths;
  if (oldPaths && !sameJson(oldPaths, config.paths)) {
    const { moves, problems } = planMigration(root, oldPaths, config.paths);
    const rewrites = planReferenceRewrites(root, oldPaths, config.paths);
    if (migrate) {
      if (problems.length) throw new Error(`cannot migrate:\n  ${problems.join("\n  ")}`);
      for (const m of moves) {
        act(`move ${rel(root, m.src)} -> ${rel(root, m.dest)}`, () => moveArtifact(root, m.src, m.dest));
      }
      const final = dryRun ? rewrites : planReferenceRewrites(root, oldPaths, config.paths);
      for (const r of final) {
        act(`update path references in ${rel(root, r.file)}`, () => writeFileSync(r.file, r.after));
      }
    } else if ((moves.length || rewrites.length) && !skipMigration) {
      const lines = [
        ...moves.map((m) => `${rel(root, m.src)} -> ${rel(root, m.dest)}`),
        ...rewrites.map((r) => `references in ${rel(root, r.file)}`),
      ];
      throw new Error(
        `paths changed since they were last applied, and existing artifacts still use the old locations:\n  ${lines.join("\n  ")}\nre-run with --migrate to move them, or --skip-migration to leave them where they are`,
      );
    }
  }

  if (!configExists) act(`write ${CONFIG_FILE}`, () => writeConfig(root, config));

  const lockSkills = {};
  for (const { skill, dir, current, original } of work) {
    const { files: rendered } = renderFiles(skill.name, original, config.paths);
    const byRel = new Map(original.map((f) => [f.rel, f.content]));
    const changed = rendered.filter((f) => !f.content.equals(byRel.get(f.rel))).map((f) => f.rel);
    const currentByRel = new Map(current.map((f) => [f.rel, f.content]));
    const toWrite = rendered.filter((f) => !f.content.equals(currentByRel.get(f.rel)));
    if (toWrite.length) {
      act(`render ${rel(root, dir)} (${toWrite.length} file${toWrite.length === 1 ? "" : "s"})`, () => {
        for (const f of toWrite) writeFileSync(join(dir, ...f.rel.split("/")), f.content);
      });
    }
    lockSkills[skill.name] = {
      originalHash: folderHash(original),
      renderedHash: folderHash(rendered),
      changed,
    };
    const origDir = join(root, ORIGINALS_DIR, skill.name);
    act(`keep originals of ${skill.name} (${changed.length})`, () => {
      rmSync(origDir, { recursive: true, force: true });
      for (const r of changed) {
        const out = join(origDir, ...(r + ORIG_SUFFIX).split("/"));
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, byRel.get(r));
      }
    });
  }

  // Forget skills that were removed with `npx skills remove`.
  for (const name of Object.keys(lock?.skills ?? {})) {
    if (!lockSkills[name]) {
      act(`forget ${name}`, () => rmSync(join(root, ORIGINALS_DIR, name), { recursive: true, force: true }));
    }
  }

  for (const f of instructionFiles(root, config.paths)) {
    if (f.before !== f.after) act(`update ${rel(root, f.path)}`, () => writeFileSync(f.path, f.after));
  }

  const nextLock = { generatedBy: `${SELF}/scripts/configure.mjs`, config, skills: lockSkills };
  act(`write ${LOCK_FILE}`, () => {
    mkdirSync(dirname(join(root, LOCK_FILE)), { recursive: true });
    writeFileSync(join(root, LOCK_FILE), `${JSON.stringify(nextLock, null, 2)}\n`);
  });
  return nextLock;
}

// ---------------------------------------------------------------- check

// For the project's CI. Returns a list of problems; empty means the
// installed skills match the configured paths.
export function check(root) {
  const lock = loadLock(root);
  if (!lock) return [`${LOCK_FILE} not found: run /configure-artifact-paths`];
  const problems = [];
  let config;
  try {
    config = loadConfig(root).config;
  } catch (err) {
    return [err.message];
  }
  if (!sameJson(config, lock.config)) {
    problems.push(`${CONFIG_FILE} changed since the paths were applied: run /configure-artifact-paths`);
  }
  for (const skill of managedSkills(root)) {
    for (const dir of skillCopies(root, skill.name)) {
      const { state } = inspectCopy(root, skill, dir, lock);
      if (state === "configured") continue;
      if (state === "original") {
        problems.push(`${rel(root, dir)} has the upstream paths (installed or updated by \`npx skills\`): run /configure-artifact-paths`);
      } else if (state === "broken") {
        problems.push(`${rel(root, dir)}: its originals under ${ORIGINALS_DIR} are missing or edited`);
      } else {
        problems.push(`${rel(root, dir)} was edited by hand`);
      }
    }
  }
  for (const f of instructionFiles(root, lock.config.paths)) {
    if (f.before !== f.after) problems.push(`${rel(root, f.path)} is missing the generated content: run /configure-artifact-paths`);
  }
  return problems;
}
