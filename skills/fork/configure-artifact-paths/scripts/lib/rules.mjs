// The rewrite rules that turn upstream skill text into project-specific text.
//
// Rendering runs in two phases so a substituted value is never rewritten by a
// later rule (e.g. an ADR folder configured as `docs/adr-log` must survive):
//   1. every rule replaces what it matches with placeholders `@@key@@`;
//   2. placeholders are swapped for the configured values.
//
// Each rule declares:
//   id:     stable name, reported by the guard when it stops matching.
//   skills: skill names it applies to (omit for every skill).
//   files:  skill-relative file paths it applies to (omit for every file).
//   exceptSkills: skill names it never applies to.
//   when:   predicate on the configured paths (omit to always run). Rules
//           that would be a no-op on upstream defaults skip themselves, so
//           a default config renders byte-identical skills.
//   apply:  (text) => { text, count }.
//
// When upstream rewords a sentence a rule targets, the guard
// (`installer/guard.mjs`) fails with that rule's id: update `find` below.

import { PATH_KEYS } from "./paths.mjs";

export const ph = (key) => `@@${key}@@`;
const PLACEHOLDER = /@@([A-Za-z]+)@@/g;

function literal(find, replacement) {
  return (text) => {
    const parts = text.split(find);
    return { text: parts.join(replacement), count: parts.length - 1 };
  };
}

function regex(re, replacement) {
  return (text) => {
    let count = 0;
    const out = text.replace(re, (...args) => {
      count += 1;
      return typeof replacement === "function" ? replacement(...args) : replacement;
    });
    return { text: out, count };
  };
}

const isSet = (key) => (paths) => paths[key] !== null;
const isChanged = (key) => (paths) => paths[key] !== PATH_KEYS[key].default;

// Longest tokens first. The look-behind stops matches inside longer names
// (`MY-GLOSSARY.md`), but a leading `/` is allowed so per-context paths such
// as `src/<context>/docs/adr/` are rewritten too.
export const TOKENS = [
  ["GLOSSARY-MAP.md", "contextMap"],
  ["GLOSSARY.md", "glossary"],
  ["docs/adr", "adrDir"],
  ["docs/agents", "skillsConfigDir"],
  [".scratch", "localTrackerDir"],
  [".out-of-scope", "outOfScopeDir"],
];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const TOKEN_RE = new RegExp(
  `(?<![\\w.-])(${TOKENS.map(([t]) => escape(t)).join("|")})(?![\\w-])`,
  "g",
);
const TOKEN_KEY = Object.fromEntries(TOKENS);

// /teach keeps its own `GLOSSARY.md` in its workspace (moved by teachDir,
// not by glossary), so the path tokens never apply to it.
export const TEACH = ["teach"];

// Default tokens that must not survive a render with every path changed.
export const LEFTOVER_PATTERNS = [
  { pattern: TOKEN_RE, exceptSkills: TEACH },
  { pattern: /^\W*── adr\//m },
  { pattern: /(?<![\w/@-])\.\/(learning-records|lessons|reference|assets)\// },
];

export const RULES = [
  // Directory trees draw `docs/` and `adr/` on separate lines. Collapse them
  // into one node so the token rule can rewrite it, and dedent the children.
  {
    id: "adr-tree",
    skills: ["domain-modeling"],
    files: ["SKILL.md"],
    when: isChanged("adrDir"),
    apply: regex(
      /^([├└]── )docs\/\n│   └── adr\/(.*)\n((?:│       .*\n)*)/gm,
      (_m, head, rest, children) =>
        `${head}docs/adr/${rest}\n${children.replace(/^│       /gm, "│   ")}`,
    ),
  },
  // After substitution: the `← comment` arrows in directory trees line up
  // again once paths changed width.
  {
    id: "tree-arrows",
    skills: ["domain-modeling"],
    files: ["SKILL.md"],
    post: true,
    when: (paths) => ["glossary", "contextMap", "adrDir"].some((k) => isChanged(k)(paths)),
    apply: regex(/^```\n[\s\S]*?^```$/gm, (block) => {
      const lines = block.split("\n");
      const lefts = lines.filter((l) => l.includes(" ← ")).map((l) => l.slice(0, l.indexOf(" ← ")).trimEnd());
      if (!lefts.length) return block;
      const width = Math.max(...lefts.map((l) => l.length)) + 2;
      return lines
        .map((l) => {
          const at = l.indexOf(" ← ");
          return at === -1 ? l : `${l.slice(0, at).trimEnd().padEnd(width)}${l.slice(at + 1)}`;
        })
        .join("\n");
    }),
  },
  {
    id: "tokens",
    exceptSkills: TEACH,
    apply: regex(TOKEN_RE, (_m, token) => ph(TOKEN_KEY[token])),
  },
  {
    id: "teach-workspace",
    skills: TEACH,
    files: ["SKILL.md"],
    when: isChanged("teachDir"),
    apply: literal(
      "Treat the current directory as a teaching workspace. The state of their learning is captured in this directory in several files:",
      `Treat \`${ph("teachDir")}/\` (relative to the repo root) as the teaching workspace, creating it if needed. Every workspace file this skill names (\`MISSION.md\`, \`RESOURCES.md\`, \`GLOSSARY.md\`, \`NOTES.md\`) lives inside it. The state of their learning is captured in this directory in several files:`,
    ),
  },
  {
    id: "teach-format-note",
    skills: TEACH,
    files: [
      "GLOSSARY-FORMAT.md",
      "LEARNING-RECORD-FORMAT.md",
      "MISSION-FORMAT.md",
      "RESOURCES-FORMAT.md",
    ],
    when: isChanged("teachDir"),
    // The file's own title: the first line, after any blank lines or HTML
    // comments. Never a later `# ` line, which may sit inside a template.
    apply: regex(
      /^((?:\s*\n|<!--[\s\S]*?-->\s*\n)*# .*\n)/,
      (_m, heading) =>
        `${heading}\nAll workspace paths in this file are relative to the teaching workspace, \`${ph("teachDir")}/\`.\n`,
    ),
  },
  {
    id: "teach-folders",
    skills: TEACH,
    when: isChanged("teachDir"),
    apply: regex(
      /(?<![\w/@-])\.\/(learning-records|lessons|reference|assets)\//g,
      (_m, dir) => `${ph("teachDir")}/${dir}/`,
    ),
  },
  {
    id: "research-dir",
    skills: ["research"],
    files: ["SKILL.md"],
    when: isSet("researchDir"),
    apply: literal(
      "Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.",
      `Save it under \`${ph("researchDir")}/\` (relative to the repo root), creating the folder if needed, and say where.`,
    ),
  },
  {
    id: "handoff-dir",
    skills: ["handoff"],
    files: ["SKILL.md"],
    when: isSet("handoffDir"),
    apply: literal(
      "Save to the temporary directory of the user's OS - not the current workspace.",
      `Save to \`${ph("handoffDir")}/\` (relative to the repo root), creating the folder if needed.`,
    ),
  },
  {
    id: "prototype-dir",
    skills: ["prototype"],
    files: ["SKILL.md"],
    when: isSet("prototypeDir"),
    apply: literal(
      "Locate the prototype code close to where it will actually be used (next to the module or page it's prototyping for) so context is obvious,",
      `Put a standalone prototype (such as a single-file logic demo) under \`${ph("prototypeDir")}/\` (relative to the repo root); locate any other prototype code close to where it will actually be used (next to the module or page it's prototyping for) so context is obvious,`,
    ),
  },
  {
    id: "wizard-dir",
    skills: ["wizard"],
    files: ["SKILL.md"],
    when: isSet("wizardDir"),
    apply: literal(
      "saved to a scratch or `scripts/` path",
      `saved under \`${ph("wizardDir")}/\` (relative to the repo root)`,
    ),
  },
  // Not path-driven: make /setup-matt-pocock-skills write its block where
  // every supported agent reads it. Codex only reads AGENTS.md; Claude Code
  // reads it through the `@AGENTS.md` import configure.mjs adds to CLAUDE.md.
  {
    id: "setup-instruction-file",
    skills: ["setup-matt-pocock-skills"],
    files: ["SKILL.md"],
    apply: literal(
      "**Pick the file to edit:**\n\n- If `CLAUDE.md` exists, edit it.\n- Else if `AGENTS.md` exists, edit it.\n- If neither exists, ask the user which one to create; don't pick for them.\n\nNever create `AGENTS.md` when `CLAUDE.md` already exists (or vice versa); always edit the one that's already there.",
      "**Pick the file to edit:** always `AGENTS.md`. Codex, OpenCode and oh-my-pi read it directly, and Claude Code reads it through the `@AGENTS.md` line in `CLAUDE.md`. `/configure-artifact-paths` created both files; if `CLAUDE.md` has lost that line, add it back, unless `CLAUDE.md` is a symlink to `AGENTS.md` (then it is the same file and needs no import). If `CLAUDE.md` already holds an `## Agent skills` block from an earlier setup, move it into `AGENTS.md` and delete it from `CLAUDE.md`, so there is exactly one. Keep the `## Agent skills` block out of the generated `Artifact locations` block (between the `mattpocock-skills:paths` markers).",
    ),
  },
  {
    id: "setup-instruction-file-draft",
    skills: ["setup-matt-pocock-skills"],
    files: ["SKILL.md"],
    apply: literal(
      "whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 4 for selection rules)",
      "`AGENTS.md` (see step 4)",
    ),
  },
];

export function substitutePlaceholders(text, paths) {
  return text.replace(PLACEHOLDER, (m, key) => {
    if (!(key in paths)) return m;
    return paths[key];
  });
}
