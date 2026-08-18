#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const linuxRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = path.resolve(
  process.env.ELIZAOS_ELIZA_ROOT ?? path.join(linuxRoot, "../../../.eliza-source"),
);
const lockPath = path.resolve(
  process.env.ELIZAOS_ELIZA_SOURCE_LOCK ??
    path.join(linuxRoot, "eliza-source.lock.json"),
);

function fail(message) {
  console.error(`eliza source lock: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(lockPath)) fail(`missing lock file: ${lockPath}`);
if (!fs.existsSync(path.join(sourceRoot, ".git"))) {
  fail(`not a Git checkout: ${sourceRoot}`);
}

let lock;
try {
  lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
} catch (error) {
  fail(`invalid JSON in ${lockPath}: ${error.message}`);
}

if (lock.schema !== "eliza.os.tails.app-source-lock.v1") {
  fail(`unsupported schema: ${lock.schema ?? "missing"}`);
}
if (lock.repository !== "https://github.com/elizaOS/eliza") {
  fail(`unexpected repository: ${lock.repository ?? "missing"}`);
}
if (!/^[0-9a-f]{40}$/.test(lock.commit ?? "")) {
  fail("commit must be a lowercase 40-character Git SHA");
}

const actual = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: sourceRoot,
  encoding: "utf8",
}).trim();
if (actual !== lock.commit) {
  fail(`checkout mismatch: expected ${lock.commit}, got ${actual}`);
}

console.log(`eliza source lock passed: ${actual}`);
