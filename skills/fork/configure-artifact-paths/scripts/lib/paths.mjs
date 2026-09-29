// The configurable artifact locations and the validation of a project's
// `.agents/skill-paths.json`.
//
// Every path is relative. `scope` says what it is relative to:
//   - "repo":    the project root.
//   - "context": a context root. In a single-context project that is the
//                project root; in a multi-context project each context
//                (e.g. `src/ordering/`) has its own copy.
// Optional keys default to `null`, which keeps the upstream behaviour
// (the skill picks a location by convention). `label` names the artifact in
// the table written into AGENTS.md.

export const PATH_KEYS = {
  glossary: {
    default: "CONTEXT.md",
    kind: "file",
    scope: "context",
    label: "Domain glossary",
  },
  contextMap: {
    default: "CONTEXT-MAP.md",
    kind: "file",
    scope: "repo",
    label: "Context map (multi-context projects)",
  },
  adrDir: {
    default: "docs/adr",
    kind: "dir",
    scope: "context",
    label: "Architecture decision records",
  },
  skillsConfigDir: {
    default: "docs/agents",
    kind: "dir",
    scope: "repo",
    label: "Skill config written by /setup-matt-pocock-skills",
  },
  localTrackerDir: {
    default: ".scratch",
    kind: "dir",
    scope: "repo",
    label: "Local issue tracker (specs, tickets, wayfinder maps)",
  },
  outOfScopeDir: {
    default: ".out-of-scope",
    kind: "dir",
    scope: "repo",
    label: "Rejected feature requests (/triage)",
  },
  teachDir: {
    default: ".",
    kind: "dir",
    scope: "repo",
    label: "Teaching workspace (/teach)",
  },
  researchDir: {
    default: null,
    kind: "dir",
    scope: "repo",
    label: "Research notes (/research)",
  },
  handoffDir: {
    default: null,
    kind: "dir",
    scope: "repo",
    label: "Handoff documents (/handoff)",
  },
  prototypeDir: {
    default: null,
    kind: "dir",
    scope: "repo",
    label: "Standalone prototypes (/prototype)",
  },
  wizardDir: {
    default: null,
    kind: "dir",
    scope: "repo",
    label: "Setup wizard scripts (/wizard)",
  },
};

export const CONFIG_FILE = ".agents/skill-paths.json";
export const LOCK_FILE = ".agents/skill-paths.lock.json";
export const ORIGINALS_DIR = ".agents/skill-paths/originals";

export function defaultPaths() {
  return Object.fromEntries(
    Object.entries(PATH_KEYS).map(([key, spec]) => [key, spec.default]),
  );
}

const SAFE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export function normalizePath(key, value) {
  const spec = PATH_KEYS[key];
  if (!spec) {
    throw new Error(`unknown path key ${JSON.stringify(key)}; known keys: ${Object.keys(PATH_KEYS).join(", ")}`);
  }
  if (value === null) {
    if (spec.default !== null) {
      throw new Error(`paths.${key} cannot be null`);
    }
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`paths.${key} must be a string${spec.default === null ? " or null" : ""}`);
  }
  const trimmed = value.trim().replace(/^\.\/(?=.)/, "").replace(/\/+$/, "");
  if (!SAFE_PATH.test(trimmed)) {
    throw new Error(
      `paths.${key} = ${JSON.stringify(value)}: use a relative path made of letters, digits, '.', '_', '-' and '/'`,
    );
  }
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "" || s === "..")) {
    throw new Error(`paths.${key} = ${JSON.stringify(value)}: empty or '..' segments are not allowed`);
  }
  if (segments.slice(1).includes(".") || (trimmed === "." && key !== "teachDir")) {
    throw new Error(`paths.${key} = ${JSON.stringify(value)}: must name a real location, not '.'`);
  }
  if (spec.kind === "file" && !trimmed.endsWith(".md")) {
    throw new Error(`paths.${key} = ${JSON.stringify(value)}: must be a Markdown file ending in .md`);
  }
  const reserved = reservedReason(trimmed);
  if (reserved) {
    throw new Error(`paths.${key} = ${JSON.stringify(value)}: ${reserved}`);
  }
  return trimmed;
}

// Locations owned by git, package managers, the agents, or this skill.
// Top-level folders agents keep their own files in (the `npx skills` 1.7.0
// agent table, plus a few agents it does not list). A path may live below
// one (`.agents/config`), but must not be one: a tracker at `.agents` with a
// feature called `skills` would write into the installed skills.
const AGENT_HOMES = new Set(
  (
    ".adal .agent .agents .aider-desk .augment .autohand .bob .claude .codeartsdoer .codebuddy .codemaker .codestudio " +
    ".codex .commandcode .continue .cortex .crush .cursor .devin .forge .fx .gemini .github .goose .grok .hermes .iflow " +
    ".inferencesh .jazz .junie .kimchi .kiro .kode .lingma .mcpjam .minimax .moxby .mux .neovate .omp .ona .opencode " +
    ".openhands .pi .pochi .posit .qoder .qwen .reasonix .roo .rovodev .tabnine .terramind .tinycloud .trae .vibe " +
    ".windsurf .zcode .zencoder"
  ).split(" "),
);

// Files and folders /teach keeps in its workspace.
const TEACH_ENTRIES = ["MISSION.md", "RESOURCES.md", "GLOSSARY.md", "NOTES.md", "lessons", "reference", "assets", "learning-records"];

// Compared case-insensitively: macOS and Windows file systems usually are.
function reservedReason(path) {
  const p = path.toLowerCase();
  const [first] = p.split("/");
  if (first === ".git" || first === "node_modules") return `${first}/ is not a place for project documents`;
  if (/^\.[^/]+\/skills(\/|$)/.test(p) || /^\.(posit\/assistant|tabnine\/agent)\/skills(\/|$)/.test(p)) {
    return "agent skill folders are managed by `npx skills`";
  }
  if (p === ".agents/skill-paths" || p.startsWith(".agents/skill-paths/") || p.startsWith(".agents/skill-paths.")) {
    return "reserved for /configure-artifact-paths itself";
  }
  if (["agents.md", "claude.md", "skills-lock.json"].includes(p)) return "that file has another job";
  if (AGENT_HOMES.has(p)) return `${path}/ is an agent's own folder; use a folder below it or elsewhere`;
  return null;
}

const lower = (p) => p.toLowerCase();
const within = (child, parent) => parent === "." || lower(child) === lower(parent) || lower(child).startsWith(`${lower(parent)}/`);

// Returns a fully populated, normalized config. Throws with a readable
// message on anything it cannot accept.
export function validateConfig(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${CONFIG_FILE} must contain a JSON object`);
  }
  for (const key of Object.keys(raw)) {
    if (!["$schema", "paths"].includes(key)) {
      throw new Error(`unknown top-level key ${JSON.stringify(key)} in ${CONFIG_FILE}`);
    }
  }
  const rawPaths = raw.paths ?? {};
  if (typeof rawPaths !== "object" || Array.isArray(rawPaths)) {
    throw new Error(`"paths" must be an object`);
  }
  for (const key of Object.keys(rawPaths)) normalizePath(key, rawPaths[key]);
  const paths = {};
  for (const key of Object.keys(PATH_KEYS)) {
    paths[key] = normalizePath(key, key in rawPaths ? rawPaths[key] : PATH_KEYS[key].default);
  }
  // Two artifacts sharing one location, or one inside another, would
  // overwrite or confuse each other (an ADR folder's numbering scan would
  // read a glossary kept inside it).
  const set = Object.entries(paths).filter(([k, v]) => v !== null && !(k === "teachDir" && v === "."));
  for (const [i, [a, va]] of set.entries()) {
    for (const [b, vb] of set.slice(i + 1)) {
      if (lower(va) === lower(vb)) throw new Error(`paths.${a} and paths.${b} both point at ${JSON.stringify(va)}`);
      if (within(va, vb)) throw new Error(`paths.${a} (${va}) is inside paths.${b} (${vb}); keep them apart`);
      if (within(vb, va)) throw new Error(`paths.${b} (${vb}) is inside paths.${a} (${va}); keep them apart`);
    }
  }
  return { paths };
}

// When /teach is installed, no artifact may land on one of its workspace's
// own files (e.g. `glossary: "GLOSSARY.md"` with the workspace at the root).
export function checkTeachCollisions(paths) {
  for (const [key, value] of Object.entries(paths)) {
    if (key === "teachDir" || value === null) continue;
    for (const entry of TEACH_ENTRIES) {
      const taken = paths.teachDir === "." ? entry : `${paths.teachDir}/${entry}`;
      if (within(value, taken)) {
        throw new Error(
          `paths.${key} (${value}) collides with the /teach workspace's ${entry}; pick another path or set teachDir`,
        );
      }
    }
  }
}
