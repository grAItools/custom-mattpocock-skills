// Applies a project's artifact paths to the skills `npx skills add` installed
// from this repo, in place.
//
// `npx skills` copies skills verbatim and re-copies them on update, so each
// installed copy is either:
//   - original: matches the hash `npx skills` recorded in skills-lock.json
//     (fresh install or update), or
//   - configured: matches the hash in our lock file. The original is then
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
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CONFIG_FILE, LOCK_FILE, ORIGINALS_DIR, PATH_KEYS, defaultPaths, normalizePath, validateConfig } from "./paths.mjs";
import { renderFiles } from "./render.mjs";

export const SELF = "configure-artifact-paths";
export const SKILLS_LOCK = "skills-lock.json";
const BLOCK_START = "<!-- mattpocock-skills:paths:start -->";
const BLOCK_END = "<!-- mattpocock-skills:paths:end -->";
const IMPORT_LINE = "@AGENTS.md";
const ORIG_SUFFIX = ".orig";

// Project-level skill folders `npx skills` writes to (skills 1.7.0 agent
// table). Hidden top-level `.<agent>/skills/` folders are found generically;
// these are the others. A copy in a non-hidden folder is only managed when
// its hash is recognised, so a project's own `skills/` folder is never
// mistaken for an install.
const NESTED_SKILL_BASES = [".posit/assistant/skills", ".tabnine/agent/skills"];
const PLAIN_SKILL_BASES = ["skills", "agent/skills", "data/skills"];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rel = (root, p) => relative(root, p).split(sep).join("/");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isInside = (child, parent) => child !== parent && child.startsWith(`${parent}${sep}`);

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
        files.push({ rel: rel(dir, full), content: readFileSync(full) });
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
    // `default` and `null` are keywords; `./default` names a folder.
    paths[key] = value === "default" ? PATH_KEYS[key].default : normalizePath(key, value === "null" ? null : value);
  }
  const next = validateConfig({ paths });
  writeConfig(root, next);
  return next;
}

export function loadLock(root) {
  const file = join(root, LOCK_FILE);
  if (!existsSync(file)) return null;
  const lock = readJson(file);
  return lock.copies ? lock : null;
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
    .map(([name, e]) => ({ name, source: e.source ?? null, computedHash: e.computedHash ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Real (non-symlink) folders that may hold an installed copy of `name`: the
// shared `.agents/skills/<name>`, plus agent folders when installed in copy
// mode. Symlinked agent folders point at the shared copy and need no work.
function candidateCopies(root, name) {
  const bases = new Set([".agents/skills", ...NESTED_SKILL_BASES]);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(".") && entry.name !== ".git") bases.add(`${entry.name}/skills`);
  }
  // A skills folder that is itself a symlink (`.claude/skills` ->
  // `.agents/skills`) reaches the same copy twice: keep the first.
  const found = [];
  const seen = new Set();
  for (const [list, plain] of [[bases, false], [PLAIN_SKILL_BASES, true]]) {
    for (const base of list) {
      const dir = join(root, ...base.split("/"), name);
      if (!isKind(dir, "dir") || !existsSync(join(dir, "SKILL.md"))) continue;
      const real = realpathSync(dir);
      if (seen.has(real)) continue;
      seen.add(real);
      found.push({ dir, plain });
    }
  }
  return found;
}

function originalsDir(root, key) {
  return join(root, ORIGINALS_DIR, ...key.split("/"));
}

// The installed files with every file we changed swapped back for its saved
// original, or null when a saved original is missing.
function withOriginals(root, key, current, entry) {
  const dir = originalsDir(root, key);
  const byRel = new Map(current.map((f) => [f.rel, f]));
  for (const r of entry.changed) {
    const saved = join(dir, ...(r + ORIG_SUFFIX).split("/"));
    if (!existsSync(saved)) return null;
    byRel.set(r, { rel: r, content: readFileSync(saved) });
  }
  return [...byRel.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

// Classifies one installed copy and recovers its original files.
//   configured: rendered by us and untouched since.
//   original:   straight from `npx skills`.
//   modified:   edited after install or render. `rebuilt` is the best
//               reconstruction: our saved originals for the files we
//               changed, the current text for everything else.
//   broken:     rendered by us, but saved originals are missing or edited.
export function inspectCopy(root, skill, dir, lock) {
  const key = rel(root, dir);
  const current = readSkillDir(dir);
  const hash = folderHash(current);
  const entry = lock?.copies?.[key];
  if (entry && hash === entry.renderedHash) {
    const original = withOriginals(root, key, current, entry);
    if (original && folderHash(original) === entry.originalHash) {
      return { key, state: "configured", current, original };
    }
    return { key, state: "broken", current, original: null };
  }
  if (skill.computedHash && hash === skill.computedHash) {
    return { key, state: "original", current, original: current };
  }
  if (entry) {
    const rebuilt = withOriginals(root, key, current, entry);
    return rebuilt
      ? { key, state: "modified", current, original: null, rebuilt, entry }
      : { key, state: "broken", current, original: null };
  }
  return { key, state: "modified", current, original: null, rebuilt: current };
}

// Installed copies of the managed skills with their state.
function inspectAll(root, skills, lock) {
  const copies = [];
  const missing = [];
  for (const skill of skills) {
    const found = candidateCopies(root, skill.name)
      .map(({ dir, plain }) => ({ plain, ...inspectCopy(root, skill, dir, lock), skill, dir }))
      .filter((c) => !c.plain || c.state === "configured" || c.state === "original" || lock?.copies?.[c.key]);
    if (!found.length) missing.push(skill.name);
    copies.push(...found);
  }
  return { copies, missing };
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

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// The file a path names, following a symlink even when its target is
// missing (a dangling `CLAUDE.md -> AGENTS.md` still names AGENTS.md).
function targetOf(path) {
  const real = realpathOrNull(path);
  if (real) return real;
  try {
    if (lstatSync(path).isSymbolicLink()) return resolve(dirname(path), readlinkSync(path));
  } catch {}
  return resolve(path);
}

// AGENTS.md gets the generated block; CLAUDE.md gets an `@AGENTS.md` import
// so Claude Code reads it too. When one is a symlink to the other there is a
// single file: it gets the block and no (self-)import.
export function instructionFiles(root, paths) {
  const agentsPath = join(root, "AGENTS.md");
  const claudePath = join(root, "CLAUDE.md");
  const agentsTarget = targetOf(agentsPath);
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  if (agentsTarget === targetOf(claudePath)) {
    const text = read(agentsTarget);
    return [{ path: agentsTarget, before: text, after: upsertBlock(text, managedBlock(paths)) }];
  }
  const agents = read(agentsPath);
  const claude = read(claudePath);
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

// Path-shaped text in Markdown: code spans and link targets. References are
// only ever rewritten inside these, never in prose.
const PATH_SPANS = /`([^`\n]+)`|\]\(([^)\s]+)\)/g;

function mapSpans(text, fn) {
  return text.replace(PATH_SPANS, (m, code, link) =>
    code !== undefined ? `\`${fn(code)}\`` : `](${fn(link)})`,
  );
}

// Context roots: the repo root plus the folders the context map points
// into. Upstream defines a multi-context project by the presence of that
// map, so without one the repo root is the only context. `mapFile` is where
// the map is now; its links are relative to `oldPaths.contextMap`, where it
// was written (they only move with it once re-based).
function contextRoots(root, oldPaths, mapFile = join(root, oldPaths.contextMap)) {
  const roots = new Set([root]);
  if (!isKind(mapFile, "file")) return [...roots];
  const base = dirname(join(root, oldPaths.contextMap));
  const suffixes = [oldPaths.glossary, oldPaths.adrDir];
  mapSpans(readFileSync(mapFile, "utf8"), (span) => {
    const target = span.replace(/#.*$/, "").replace(/\/+$/, "");
    for (const suffix of suffixes) {
      if (target === suffix || target.endsWith(`/${suffix}`)) {
        const ctx = resolve(base, target.slice(0, target.length - suffix.length) || ".");
        if (ctx === root || isInside(ctx, root)) roots.add(ctx);
      }
    }
    return span;
  });
  return [...roots];
}

// Re-bases the relative link targets of a Markdown file moving from folder
// `fromDir` to folder `toDir`, so they keep pointing at the same files.
function rebaseLinks(text, fromDir, toDir) {
  if (fromDir === toDir) return text;
  return text.replace(/\]\(([^)\s]+)\)/g, (m, target) => {
    if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return m;
    const [path, hash = ""] = target.split(/(?=#)/);
    let next = relative(toDir, resolve(fromDir, path)).split(sep).join("/") || ".";
    if (!next.startsWith("../") && next !== ".") next = `./${next}`;
    return `](${next}${path.endsWith("/") ? "/" : ""}${hash})`;
  });
}

// Moves needed to bring existing artifacts from `oldPaths` to `newPaths`.
// `problems` block a migration; `manual` are left for the user to move.
export function planMigration(root, oldPaths, newPaths) {
  const moves = [];
  const problems = [];
  const manual = [];
  const contexts = contextRoots(root, oldPaths);
  for (const [key, spec] of Object.entries(PATH_KEYS)) {
    const from = oldPaths[key];
    const to = newPaths[key];
    if (from === to || from === null || to === null) continue;
    if (key === "teachDir") {
      if (existsSync(join(root, from === "." ? "MISSION.md" : from))) {
        manual.push(`the teaching workspace (${from === "." ? "the repo root" : `${from}/`} -> ${to === "." ? "the repo root" : `${to}/`})`);
      }
      continue;
    }
    for (const base of spec.scope === "context" ? contexts : [root]) {
      const src = join(base, from);
      if (!isKind(src, spec.kind)) continue;
      const dest = join(base, to);
      if (isInside(dest, src)) {
        problems.push(`${rel(root, src)} -> ${rel(root, dest)}: cannot move a folder into itself; move it by hand`);
      } else if (exists(dest)) {
        problems.push(`${rel(root, src)} -> ${rel(root, dest)}: destination already exists`);
      } else {
        moves.push({ src, dest });
      }
    }
  }
  // Every move must stand on its own: no shared destinations and no move
  // inside another one's source or destination.
  for (const a of moves) {
    for (const b of moves) {
      if (a === b) continue;
      const clash =
        a.dest === b.dest || isInside(a.src, b.src) || isInside(a.dest, b.src) || isInside(a.src, b.dest) || isInside(a.dest, b.dest);
      if (clash && moves.indexOf(a) < moves.indexOf(b)) {
        problems.push(
          `${rel(root, a.src)} -> ${rel(root, a.dest)} overlaps ${rel(root, b.src)} -> ${rel(root, b.dest)}: change one path at a time`,
        );
      }
    }
  }
  return { moves, problems, manual };
}

// Rewrites old paths to new ones inside one path-shaped span, in a single
// pass so a new value is never rewritten again by a later key. A path must
// start the span (optionally after `./`), or, for the per-context glossary
// and ADR folder, follow one of the known context folders
// (`src/ordering/CONTEXT.md`, also behind `../`). It must end the span or be
// followed by `/` or `#`, so `issues` never matches inside `issues-log`.
function referenceRewriter(oldPaths, newPaths, contextPrefixes) {
  const keys = Object.keys(PATH_KEYS)
    .filter((k) => k !== "teachDir" && oldPaths[k] !== newPaths[k] && oldPaths[k] !== null && newPaths[k] !== null)
    .sort((a, b) => oldPaths[b].length - oldPaths[a].length);
  if (!keys.length) return null;
  const alternation = keys
    .map((k) => {
      const before =
        PATH_KEYS[k].scope === "context" && contextPrefixes.length
          ? `(?<=^|^\\.\\/|^(?:\\.\\/|(?:\\.\\.\\/)*)(?:${contextPrefixes.map(escapeRe).join("|")})\\/)`
          : "(?<=^|^\\.\\/)";
      return `${before}(${escapeRe(oldPaths[k])})(?=$|[/#])`;
    })
    .join("|");
  const re = new RegExp(alternation, "g");
  return (span) =>
    span.replace(re, (...args) => {
      const i = args.slice(1, keys.length + 1).findIndex((g) => g !== undefined);
      return newPaths[keys[i]];
    });
}

function changedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push(`- ${a[i] ?? ""}`, `+ ${b[i] ?? ""}`);
  }
  return out;
}

// References to moved paths in the files known to hold them: the
// instruction files, the context map (at its old or new location), and the
// config written by /setup-matt-pocock-skills. Each rewrite carries the
// changed lines so the user sees exactly what will change.
export function planReferenceRewrites(root, oldPaths, newPaths) {
  // The map may already have moved (re-planning after --migrate): read both.
  const contexts = new Set([
    ...contextRoots(root, oldPaths),
    ...contextRoots(root, oldPaths, join(root, newPaths.contextMap)),
  ]);
  const contextPrefixes = [...contexts].filter((c) => c !== root).map((c) => rel(root, c));
  const rewrite = referenceRewriter(oldPaths, newPaths, contextPrefixes) ?? ((span) => span);
  const oldMapDir = dirname(join(root, oldPaths.contextMap));
  const newMapDir = dirname(join(root, newPaths.contextMap));
  const mapFiles = new Set([join(root, oldPaths.contextMap), join(root, newPaths.contextMap)].map(realpathOrNull));
  const candidates = [
    join(root, "AGENTS.md"),
    join(root, "CLAUDE.md"),
    join(root, oldPaths.contextMap),
    join(root, newPaths.contextMap),
  ];
  for (const dir of [join(root, oldPaths.skillsConfigDir), join(root, newPaths.skillsConfigDir)]) {
    if (isKind(dir, "dir")) {
      for (const f of readdirSync(dir)) if (f.endsWith(".md")) candidates.push(join(dir, f));
    }
  }
  const rewrites = [];
  const seen = new Set();
  for (const file of candidates) {
    const real = realpathOrNull(file);
    if (!real || seen.has(real) || !isKind(real, "file")) continue;
    seen.add(real);
    const before = readFileSync(real, "utf8");
    // The generated block is rebuilt from the config anyway: leave it out.
    const start = before.indexOf(BLOCK_START);
    const end = before.indexOf(BLOCK_END);
    const [head, block, tail] =
      start !== -1 && end > start
        ? [before.slice(0, start), before.slice(start, end), before.slice(end)]
        : [before, "", ""];
    // The context map's links were written for its old folder.
    const rebase = (t) => (mapFiles.has(real) ? rebaseLinks(t, oldMapDir, newMapDir) : t);
    const after = mapSpans(rebase(head), rewrite) + block + mapSpans(rebase(tail), rewrite);
    if (after !== before) rewrites.push({ file, after, lines: changedLines(before, after) });
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
  const skills = managedSkills(root);
  const { copies } = inspectAll(root, skills, lock);
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
    skills: skills.map(({ name }) => ({
      name,
      copies: copies.filter((c) => c.skill.name === name).map((c) => ({ dir: c.key, state: c.state })),
    })),
  };
}

// ---------------------------------------------------------------- apply

export function apply(root, opts = {}) {
  const { dryRun = false, migrate = false, skipMigration = false, force = false, log = console.log } = opts;
  if (migrate && skipMigration) throw new Error("--migrate and --skip-migration cannot be used together");
  const act = (msg, fn) => {
    log(`${dryRun ? "[dry-run] " : ""}${msg}`);
    if (!dryRun) fn();
  };

  const { exists: configExists, config } = loadConfig(root);
  const lock = loadLock(root);
  const skills = managedSkills(root);
  const { copies, missing } = inspectAll(root, skills, lock);
  for (const name of missing) log(`skip ${name}: listed in ${SKILLS_LOCK} but not installed`);

  // Recover every copy's original text before touching anything.
  const blocked = [];
  for (const c of copies) {
    if (c.original) continue;
    if (c.state === "broken" || !force) {
      blocked.push(
        c.state === "broken"
          ? `${c.key}: its saved originals under ${ORIGINALS_DIR} are missing or edited; reinstall it:`
          : `${c.key}: edited since it was installed; reinstall it, or pass --force:`,
        `    npx skills add ${c.skill.source ?? "<source>"} --skill ${c.skill.name} --agent <the agents you installed for> -y${c.key.startsWith(".agents/") ? "" : " --copy"}`,
      );
      continue;
    }
    // Files we rendered come back from their saved originals, so hand edits
    // to them are lost: say which.
    if (c.entry) {
      const lost = c.entry.changed.filter((r) => {
        const now = c.current.find((f) => f.rel === r);
        const orig = c.rebuilt.find((f) => f.rel === r);
        const expected = renderFiles(c.skill.name, [orig], lock.config.paths).files[0];
        return !now || !now.content.equals(expected.content);
      });
      if (lost.length) log(`warning: --force drops edits to ${lost.map((r) => `${c.key}/${r}`).join(", ")}`);
    }
    c.original = c.rebuilt;
  }
  if (blocked.length) {
    throw new Error(
      `cannot recover the original text of:\n  ${blocked.join("\n  ")}\nreinstall with the commands shown, repeating the --agent (and --copy) flags of the original install, then re-run apply`,
    );
  }

  // Artifacts at the previously applied locations. Before the first apply the
  // skills used the upstream defaults, so those are the previous locations.
  const oldPaths = lock?.config?.paths ?? defaultPaths();
  if (!sameJson(oldPaths, config.paths)) {
    const { moves, problems, manual } = planMigration(root, oldPaths, config.paths);
    const rewrites = planReferenceRewrites(root, oldPaths, config.paths);
    if (migrate) {
      if (problems.length) throw new Error(`cannot migrate:\n  ${problems.join("\n  ")}`);
      const done = [];
      try {
        for (const m of moves) {
          act(`move ${rel(root, m.src)} -> ${rel(root, m.dest)}`, () => moveArtifact(root, m.src, m.dest));
          done.push(m);
        }
      } catch (err) {
        const moved = done.map((m) => `${rel(root, m.src)} -> ${rel(root, m.dest)}`);
        throw new Error(
          `migration stopped: ${err.message}\nalready moved:\n  ${moved.join("\n  ") || "(nothing)"}\nmove those back, or finish by hand and re-run with --skip-migration`,
        );
      }
      const final = dryRun ? rewrites : planReferenceRewrites(root, oldPaths, config.paths);
      for (const r of final) {
        act(`update path references in ${rel(root, r.file)}`, () => writeFileSync(r.file, r.after));
      }
      for (const m of manual) log(`warning: move ${m} by hand`);
    } else if (!skipMigration && (moves.length || rewrites.length || problems.length || manual.length)) {
      const lines = [
        ...moves.map((m) => `move ${rel(root, m.src)} -> ${rel(root, m.dest)}`),
        ...rewrites.flatMap((r) => [`update references in ${rel(root, r.file)}:`, ...r.lines.map((l) => `    ${l}`)]),
        ...manual.map((m) => `move ${m} by hand`),
        ...problems.map((p) => `cannot migrate: ${p}`),
      ];
      throw new Error(
        `paths changed, and existing artifacts still use the previous locations:\n  ${lines.join("\n  ")}\nre-run with --migrate to move them, or --skip-migration to leave them where they are`,
      );
    }
  }

  if (!configExists) act(`write ${CONFIG_FILE}`, () => writeConfig(root, config));

  const lockCopies = {};
  for (const c of copies) {
    const { files: rendered } = renderFiles(c.skill.name, c.original, config.paths);
    const byRel = new Map(c.original.map((f) => [f.rel, f.content]));
    const changed = rendered.filter((f) => !f.content.equals(byRel.get(f.rel))).map((f) => f.rel);
    const currentByRel = new Map(c.current.map((f) => [f.rel, f.content]));
    const toWrite = rendered.filter((f) => !f.content.equals(currentByRel.get(f.rel)));
    if (toWrite.length) {
      act(`render ${c.key} (${toWrite.length} file${toWrite.length === 1 ? "" : "s"})`, () => {
        for (const f of toWrite) writeFileSync(join(c.dir, ...f.rel.split("/")), f.content);
      });
    }
    lockCopies[c.key] = {
      skill: c.skill.name,
      originalHash: folderHash(c.original),
      renderedHash: folderHash(rendered),
      changed,
    };
    // Rewrite the saved originals only when they differ from what is there.
    const origDir = originalsDir(root, c.key);
    const saved = existsSync(origDir) ? readSkillDir(origDir) : [];
    const wanted = changed.map((r) => ({ rel: r + ORIG_SUFFIX, content: byRel.get(r) }));
    if (folderHash(saved) !== folderHash(wanted) || saved.length !== wanted.length) {
      act(`save originals of ${c.key} (${changed.length} file${changed.length === 1 ? "" : "s"})`, () => {
        rmSync(origDir, { recursive: true, force: true });
        for (const w of wanted) {
          const out = join(origDir, ...w.rel.split("/"));
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, w.content);
        }
      });
    }
  }

  // Forget copies that are gone (e.g. `npx skills remove`).
  for (const key of Object.keys(lock?.copies ?? {})) {
    if (!lockCopies[key]) {
      act(`forget ${key}`, () => rmSync(originalsDir(root, key), { recursive: true, force: true }));
    }
  }

  for (const f of instructionFiles(root, config.paths)) {
    if (f.before !== f.after) act(`update ${rel(root, f.path)}`, () => writeFileSync(f.path, f.after));
  }

  const nextLock = { version: 2, generatedBy: `${SELF}/scripts/configure.mjs`, config, copies: lockCopies };
  if (!sameJson(nextLock, lock)) {
    act(`write ${LOCK_FILE}`, () => {
      mkdirSync(dirname(join(root, LOCK_FILE)), { recursive: true });
      writeFileSync(join(root, LOCK_FILE), `${JSON.stringify(nextLock, null, 2)}\n`);
    });
  }
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
  const { copies } = inspectAll(root, managedSkills(root), lock);
  for (const c of copies) {
    if (c.state === "configured") continue;
    if (c.state === "original") {
      problems.push(`${c.key} has the upstream paths (installed or updated by \`npx skills\`): run /configure-artifact-paths`);
    } else if (c.state === "broken") {
      problems.push(`${c.key}: its saved originals under ${ORIGINALS_DIR} are missing or edited`);
    } else {
      problems.push(`${c.key} was edited by hand`);
    }
  }
  for (const f of instructionFiles(root, lock.config.paths)) {
    if (f.before !== f.after) problems.push(`${rel(root, f.path)} is missing the generated content: run /configure-artifact-paths`);
  }
  return problems;
}
