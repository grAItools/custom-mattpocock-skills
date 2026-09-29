// Renders one skill's files for a set of paths. Pure: no disk access.

import { RULES, substitutePlaceholders } from "./rules.mjs";

const TEXT_EXTENSIONS = new Set([".md", ".yaml", ".yml", ".sh", ".txt", ".json", ".html"]);

export function isText(rel) {
  const dot = rel.lastIndexOf(".");
  return dot !== -1 && TEXT_EXTENSIONS.has(rel.slice(dot));
}

// files: [{ rel, content: Buffer }]. Returns { files, counts } where files
// has the same shape and counts maps each file to { ruleId: matches } for
// every rule that ran on it.
export function renderFiles(name, files, paths) {
  const counts = {};
  const out = files.map((file) => {
    if (!isText(file.rel)) return file;
    let text = file.content.toString("utf8");
    for (const rule of RULES) {
      if (rule.skills && !rule.skills.includes(name)) continue;
      if (rule.files && !rule.files.includes(file.rel)) continue;
      if (rule.when && !rule.when(paths)) continue;
      const result = rule.apply(text);
      text = result.text;
      counts[file.rel] ??= {};
      counts[file.rel][rule.id] = (counts[file.rel][rule.id] ?? 0) + result.count;
    }
    return { ...file, content: Buffer.from(substitutePlaceholders(text, paths), "utf8") };
  });
  return { files: out, counts };
}
