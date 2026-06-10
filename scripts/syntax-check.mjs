#!/usr/bin/env node
// `node --check` over every .mjs in the repo (skills, lib, scripts, test).
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const files = readdirSync(repoRoot, { recursive: true, withFileTypes: true })
  .filter(
    (e) =>
      e.isFile() &&
      e.name.endsWith(".mjs") &&
      !e.parentPath.includes("node_modules") &&
      !e.parentPath.includes(".git"),
  )
  .map((e) => join(e.parentPath, e.name));

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (e) {
    failed += 1;
    console.error(`SYNTAX ERROR: ${file}\n${e.stderr}`);
  }
}

if (failed > 0) process.exit(1);
console.error(`OK: ${files.length} .mjs files parse.`);
