#!/usr/bin/env node
// Vendors lib/cc-skill-lib.mjs into every skill directory.
//
// Why vendoring instead of imports or symlinks: the `skills` CLI installs
// each skill directory standalone (only the SKILL.md's directory is
// copied), so a runner can't import from outside its own directory after
// installation. Symlinks don't survive git checkouts on Windows. So each
// skill ships its own copy, and this script + the CI `--check` keep the
// copies identical to the source of truth.
//
// Usage:
//   node scripts/sync-lib.mjs            # rewrite the vendored copies
//   node scripts/sync-lib.mjs --check    # exit 1 if any copy is stale

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB_NAME = "cc-skill-lib.mjs";
const sourcePath = join(repoRoot, "lib", LIB_NAME);

const BANNER = `// VENDORED COPY — DO NOT EDIT.
// Source of truth: lib/${LIB_NAME} (this repo). Edit that file, then run
// \`node scripts/sync-lib.mjs\` to refresh every skill's copy.

`;

const expected = BANNER + readFileSync(sourcePath, "utf8");

const skillDirs = readdirSync(join(repoRoot, "skills"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(repoRoot, "skills", e.name))
  .filter((dir) => existsSync(join(dir, "SKILL.md")));

const checkOnly = process.argv.includes("--check");
let stale = 0;

for (const dir of skillDirs) {
  const target = join(dir, LIB_NAME);
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (current === expected) continue;
  stale += 1;
  if (checkOnly) {
    console.error(`STALE: ${target}`);
  } else {
    writeFileSync(target, expected);
    console.error(`synced: ${target}`);
  }
}

if (checkOnly && stale > 0) {
  console.error(
    `\n${stale} vendored cop${stale === 1 ? "y is" : "ies are"} out of sync. Run: node scripts/sync-lib.mjs`,
  );
  process.exit(1);
}
console.error(
  checkOnly
    ? `OK: ${skillDirs.length} vendored copies in sync.`
    : `Done: ${skillDirs.length} skill dirs processed, ${stale} updated.`,
);
