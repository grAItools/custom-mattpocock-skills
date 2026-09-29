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
  return trimmed;
}

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
  return { paths };
}
