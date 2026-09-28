#!/usr/bin/env node
// Installs this repo's skills into a project, with the project's artifact
// paths baked in. See installer/README.md.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { check, install } from "./project.mjs";

const USAGE = `usage: node installer/install.mjs [--project DIR] [options]

Renders the skills with the paths in DIR/.agents/skill-paths.json (created
with the upstream defaults if missing) and installs them into DIR.

options:
  --project DIR     target project (default: current directory)
  --dry-run         print what would change, write nothing
  --migrate         move existing artifacts when paths changed since the last install
  --skip-migration  install even though artifacts remain at old locations
  --force           replace skill folders this installer did not create
  --claude-copy     copy skills into .claude/skills instead of symlinking (Windows)
  --check           verify the project against its lock file; exit 1 on drift
  -h, --help        show this help`;

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      project: { type: "string" },
      "dry-run": { type: "boolean" },
      migrate: { type: "boolean" },
      "skip-migration": { type: "boolean" },
      force: { type: "boolean" },
      "claude-copy": { type: "boolean" },
      check: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  }));
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const root = resolve(args.project ?? ".");

try {
  if (args.check) {
    const problems = check(root);
    if (problems.length) {
      console.error(`skills install is out of date in ${root}:`);
      for (const p of problems) console.error(`  ${p}`);
      process.exit(1);
    }
    console.log(`skills install in ${root} matches its lock file`);
  } else {
    const lock = install(root, {
      dryRun: args["dry-run"],
      migrate: args.migrate,
      skipMigration: args["skip-migration"],
      force: args.force,
      claudeCopy: args["claude-copy"],
    });
    const count = Object.keys(lock.skills).length;
    console.log(`${args["dry-run"] ? "would install" : "installed"} ${count} skills into ${root}`);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
