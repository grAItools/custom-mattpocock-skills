#!/usr/bin/env node
// Upstream-sync guard. Renders every installable skill with every path set to
// a sentinel value and fails when:
//   - a rule matched nothing (upstream reworded or removed its target), or
//   - a default path survived rendering (upstream added a reference the
//     rules do not cover).
// Run it after every merge from upstream; CI runs it on every push.

import { LEFTOVER_PATTERNS, RULES } from "./rules.mjs";
import { isText, listSkills, renderSkill } from "./render.mjs";
import { validateConfig } from "./paths.mjs";

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

export function runGuard() {
  const totals = Object.fromEntries(RULES.map((r) => [r.id, 0]));
  const leftovers = [];
  for (const [name, dir] of listSkills()) {
    const { files, counts } = renderSkill(name, dir, SENTINEL_PATHS);
    for (const [id, n] of Object.entries(counts)) totals[id] += n;
    for (const { rel, content } of files) {
      if (!isText(rel)) continue;
      const lines = content.toString("utf8").split("\n");
      lines.forEach((line, i) => {
        for (const pattern of LEFTOVER_PATTERNS) {
          const match = line.match(new RegExp(pattern.source, pattern.flags.replace("g", "")));
          if (match) leftovers.push(`${name}/${rel}:${i + 1}: ${match[0]}`);
        }
      });
    }
  }
  const unmatched = Object.entries(totals)
    .filter(([, n]) => n === 0)
    .map(([id]) => id);
  return { unmatched, leftovers, totals };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { unmatched, leftovers } = runGuard();
  for (const id of unmatched) {
    console.error(`rule "${id}" matched nothing: upstream changed its target text; update installer/rules.mjs`);
  }
  for (const l of leftovers) {
    console.error(`default path survived rendering: ${l}; add a rule in installer/rules.mjs`);
  }
  if (unmatched.length || leftovers.length) process.exit(1);
  console.log("guard: every rule matched and no default path survived rendering");
}
