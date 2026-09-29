#!/usr/bin/env node
// Applies the project's artifact paths to the skills installed by
// `npx skills add`. Driven by the configure-artifact-paths skill; also usable
// by hand and in CI. Node 18.3+, no dependencies.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { apply, check, setPaths, status } from "./lib/project.mjs";

const USAGE = `usage: node configure.mjs <command> [--project DIR] [options]

commands:
  status              print the configured paths, their defaults, and the
                      state of each installed skill, as JSON
  set KEY=VALUE ...   validate and save paths to .agents/skill-paths.json
                      (VALUE "default" restores the default, "null" clears
                      an optional path)
  apply               rewrite the installed skills with the saved paths and
                      update AGENTS.md, CLAUDE.md and the lock file
  check               exit 1 if the installed skills do not match the saved
                      paths (for CI)

apply options:
  --migrate           move existing artifacts from the previously applied paths
  --skip-migration    leave existing artifacts at the previously applied paths
  --force             treat skills edited by hand as the original text
  --dry-run           print what would change, write nothing

  --project DIR       project root (default: current directory)`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string" },
      migrate: { type: "boolean" },
      "skip-migration": { type: "boolean" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

const { values: args, positionals } = parsed;
const [command, ...rest] = positionals;
if (args.help || !command) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 2);
}
const root = resolve(args.project ?? ".");

try {
  switch (command) {
    case "status":
      console.log(JSON.stringify(status(root), null, 2));
      break;
    case "set":
      if (!rest.length) throw new Error("set needs at least one KEY=VALUE");
      console.log(JSON.stringify(setPaths(root, rest), null, 2));
      break;
    case "apply": {
      const lock = apply(root, {
        migrate: args.migrate,
        skipMigration: args["skip-migration"],
        force: args.force,
        dryRun: args["dry-run"],
      });
      const n = Object.keys(lock.copies).length;
      console.log(`${args["dry-run"] ? "would apply" : "applied"} the paths to ${n} installed skill cop${n === 1 ? "y" : "ies"}`);
      break;
    }
    case "check": {
      const problems = check(root);
      if (problems.length) {
        console.error("installed skills do not match the configured paths:");
        for (const p of problems) console.error(`  ${p}`);
        process.exit(1);
      }
      console.log("installed skills match the configured paths");
      break;
    }
    default:
      throw new Error(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
