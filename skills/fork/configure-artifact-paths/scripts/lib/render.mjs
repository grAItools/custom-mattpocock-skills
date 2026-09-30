// Renders one skill's files for a set of paths. Pure: no disk access.

import { RULES, substitutePlaceholders } from "./rules.mjs";

const utf8 = new TextDecoder("utf-8", { fatal: true });

// Every file that decodes as UTF-8 is text, whatever its extension, so a
// helper script upstream adds is rendered (and guarded) like the prose.
export function isText(content) {
  if (content.includes(0)) return false;
  try {
    utf8.decode(content);
    return true;
  } catch {
    return false;
  }
}

// files: [{ rel, content: Buffer }]. Returns { files, counts } where files
// has the same shape and counts maps each file to { ruleId: matches } for
// every rule that ran on it.
export function renderFiles(name, files, paths) {
  const counts = {};
  const out = files.map((file) => {
    if (!isText(file.content)) return file;
    let text = file.content.toString("utf8");
    // Rules marked `post` run after the values are in, e.g. to realign
    // text whose width changed.
    const run = (post) => {
      for (const rule of RULES) {
        if (Boolean(rule.post) !== post) continue;
        if (rule.skills && !rule.skills.includes(name)) continue;
        if (rule.exceptSkills?.includes(name)) continue;
        if (rule.files && !rule.files.includes(file.rel)) continue;
        if (rule.when && !rule.when(paths)) continue;
        const result = rule.apply(text);
        text = result.text;
        counts[file.rel] ??= {};
        counts[file.rel][rule.id] = (counts[file.rel][rule.id] ?? 0) + result.count;
      }
    };
    run(false);
    text = substitutePlaceholders(text, paths);
    run(true);
    return { ...file, content: Buffer.from(text, "utf8") };
  });
  return { files: out, counts };
}
