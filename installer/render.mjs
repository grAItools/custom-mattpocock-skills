// Reads skills from this repo and renders them for a given set of paths.
// Pure with respect to the target project: nothing here writes to disk.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES, substitutePlaceholders } from "./rules.mjs";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Buckets a project may install from. `deprecated/` is never installable.
const BUCKETS = ["engineering", "productivity", "in-progress", "misc"];
const TEXT_EXTENSIONS = new Set([".md", ".yaml", ".yml", ".sh", ".txt", ".json", ".html"]);

export function isText(file) {
  const dot = file.lastIndexOf(".");
  return dot !== -1 && TEXT_EXTENSIONS.has(file.slice(dot));
}

// name -> absolute skill folder, for every installable skill.
export function listSkills(repoRoot = REPO_ROOT) {
  const skills = new Map();
  for (const bucket of BUCKETS) {
    const bucketDir = join(repoRoot, "skills", bucket);
    let entries;
    try {
      entries = readdirSync(bucketDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(bucketDir, entry.name);
      try {
        statSync(join(dir, "SKILL.md"));
      } catch {
        continue;
      }
      skills.set(entry.name, dir);
    }
  }
  return skills;
}

// The promoted set, as shipped by upstream's Claude Code plugin manifest.
export function promotedSkillNames(repoRoot = REPO_ROOT) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "plugin.json"), "utf8"));
  return manifest.skills.map((p) => basename(p));
}

export function resolveSkillSet(extraSkills, repoRoot = REPO_ROOT) {
  const all = listSkills(repoRoot);
  const names = [...new Set([...promotedSkillNames(repoRoot), ...extraSkills])].sort();
  const missing = names.filter((n) => !all.has(n));
  if (missing.length) {
    throw new Error(`unknown skill(s): ${missing.join(", ")}`);
  }
  return names.map((name) => ({ name, dir: all.get(name) }));
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

// Renders one skill. Returns { files: [{ rel, content: Buffer, mode }],
// counts: { ruleId: matches } }.
export function renderSkill(name, dir, paths) {
  const counts = {};
  const files = [];
  for (const full of walk(dir)) {
    const rel = relative(dir, full).split(sep).join("/");
    const mode = statSync(full).mode & 0o777;
    const raw = readFileSync(full);
    if (!isText(rel)) {
      files.push({ rel, content: raw, mode });
      continue;
    }
    let text = raw.toString("utf8");
    for (const rule of RULES) {
      if (rule.skills && !rule.skills.includes(name)) continue;
      if (rule.files && !rule.files.includes(rel)) continue;
      if (rule.when && !rule.when(paths)) continue;
      const result = rule.apply(text);
      text = result.text;
      counts[rule.id] = (counts[rule.id] ?? 0) + result.count;
    }
    files.push({ rel, content: Buffer.from(substitutePlaceholders(text, paths), "utf8"), mode });
  }
  return { files, counts };
}
