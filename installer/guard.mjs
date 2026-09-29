#!/usr/bin/env node
// Upstream-sync guard. Renders every skill with every path set to a sentinel
// value and fails when:
//   - a rule matched nothing (upstream reworded or removed its target), or
//   - a default path survived rendering (upstream added a reference the
//     rules do not cover).
// Run it after every merge from upstream; CI runs it on every push.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../skills/fork/configure-artifact-paths/scripts/lib/paths.mjs";
import { isText, renderFiles } from "../skills/fork/configure-artifact-paths/scripts/lib/render.mjs";
import { LEFTOVER_PATTERNS, RULES } from "../skills/fork/configure-artifact-paths/scripts/lib/rules.mjs";
import { SELF } from "../skills/fork/configure-artifact-paths/scripts/lib/project.mjs";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// `deprecated/` is not maintained, so it is not guarded either.
const BUCKETS = ["engineering", "productivity", "in-progress", "misc", "fork"];

export function listSkills(repoRoot = REPO_ROOT) {
  const skills = new Map();
  for (const bucket of BUCKETS) {
    const bucketDir = join(repoRoot, "skills", bucket);
    for (const entry of readdirSync(bucketDir, { withFileTypes: true })) {
      const dir = join(bucketDir, entry.name);
      if (entry.isDirectory() && entry.name !== SELF && statSync(join(dir, "SKILL.md"), { throwIfNoEntry: false })) {
        skills.set(entry.name, dir);
      }
    }
  }
  return skills;
}

export function readSkill(dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push({ rel: relative(dir, full).split(sep).join("/"), content: readFileSync(full) });
    }
  };
  walk(dir);
  return files;
}

export const SENTINEL_PATHS = validateConfig({
  paths: {
    glossary: "sentinel-domain/GLOSS.md",
    contextMap: "sentinel-domain/MAP.md",
    adrDir: "sentinel-decisions",
    skillsConfigDir: "sentinel-config",
    localTrackerDir: "sentinel-work",
    outOfScopeDir: "sentinel-rejected",
    teachDir: "sentinel-teach",
    researchDir: "sentinel-research",
    handoffDir: "sentinel-handoff",
    prototypeDir: "sentinel-prototypes",
    wizardDir: "sentinel-wizards",
  },
}).paths;

// Every rule must match at least once in each place it targets:
//   - rules naming files: in each of those files of each named skill;
//   - rules naming only skills: somewhere in each named skill;
//   - rules naming neither: somewhere in the whole repo.
// Summing across targets would hide a rule that broke in one file only.
function unmatchedRules(countsBySkill) {
  const unmatched = [];
  const matches = (skill, file, id) => countsBySkill.get(skill)?.[file]?.[id] ?? 0;
  const inSkill = (skill, id) =>
    Object.values(countsBySkill.get(skill) ?? {}).reduce((n, byRule) => n + (byRule[id] ?? 0), 0);
  for (const rule of RULES) {
    if (rule.skills) {
      for (const skill of rule.skills) {
        if (!countsBySkill.has(skill)) {
          unmatched.push(`${rule.id} (skill ${skill} not found)`);
        } else if (rule.files) {
          for (const file of rule.files) {
            if (!matches(skill, file, rule.id)) unmatched.push(`${rule.id} in ${skill}/${file}`);
          }
        } else if (!inSkill(skill, rule.id)) {
          unmatched.push(`${rule.id} in ${skill}`);
        }
      }
    } else if (![...countsBySkill.keys()].some((skill) => inSkill(skill, rule.id))) {
      unmatched.push(rule.id);
    }
  }
  return unmatched;
}

export function runGuard(skills = listSkills()) {
  const countsBySkill = new Map();
  const leftovers = [];
  for (const [name, dir] of skills) {
    const { files, counts } = renderFiles(name, readSkill(dir), SENTINEL_PATHS);
    countsBySkill.set(name, counts);
    for (const { rel, content } of files) {
      if (!isText(content)) continue;
      content
        .toString("utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const pattern of LEFTOVER_PATTERNS) {
            const match = line.match(new RegExp(pattern.source, pattern.flags.replace("g", "")));
            if (match) leftovers.push(`${name}/${rel}:${i + 1}: ${match[0]}`);
          }
        });
    }
  }
  return { unmatched: unmatchedRules(countsBySkill), leftovers };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { unmatched, leftovers } = runGuard();
  for (const id of unmatched) {
    console.error(`rule ${id} matched nothing: upstream changed its target text; update rules.mjs`);
  }
  for (const l of leftovers) {
    console.error(`default path survived rendering: ${l}; add a rule in rules.mjs`);
  }
  if (unmatched.length || leftovers.length) process.exit(1);
  console.log("guard: every rule matched and no default path survived rendering");
}
