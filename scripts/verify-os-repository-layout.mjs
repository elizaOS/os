#!/usr/bin/env node
/**
 * Enforces the standalone OS repository's side of the ownership boundary.
 * Distribution sources stay under packages/os, while application and native
 * runtime source trees are consumed from elizaOS/eliza rather than copied here.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

const forbiddenPrefixes = [
  "packages/app-core/",
  "packages/native/",
  "plugins/",
  ".github/actions/setup-bun-workspace/",
];
const forbidden = tracked.filter((entry) =>
  forbiddenPrefixes.some((prefix) => entry.startsWith(prefix)),
);
if (forbidden.length > 0) {
  throw new Error(
    `Application-owned source is tracked in elizaOS/os:\n${forbidden.map((entry) => `- ${entry}`).join("\n")}`,
  );
}

const requiredPrefixes = [
  "packages/os/android/",
  "packages/os/linux/",
  "packages/os/toolchains/bun-riscv64/",
  ".github/workflows/elizaos-cuttlefish.yml",
  ".github/workflows/build-linux-iso.yml",
  ".github/workflows/build-debian-package.yml",
];
for (const prefix of requiredPrefixes) {
  if (!tracked.some((entry) => entry.startsWith(prefix))) {
    throw new Error(`Required OS ownership path is missing: ${prefix}`);
  }
}

const agents = fs.readFileSync(path.join(repositoryRoot, "AGENTS.md"), "utf8");
const claude = fs.readFileSync(path.join(repositoryRoot, "CLAUDE.md"), "utf8");
if (agents !== claude) {
  throw new Error("AGENTS.md and CLAUDE.md must remain identical.");
}

const staleOwnershipReferences = [
  [".gitignore", /packages\/app-core\/scripts\/bun-riscv64/],
  ["AGENTS.md", /packages\/app-core\/packaging\/debian/],
  ["CLAUDE.md", /packages\/app-core\/packaging\/debian/],
];
const stale = staleOwnershipReferences.flatMap(([entry, pattern]) => {
  const contents = fs.readFileSync(path.join(repositoryRoot, entry), "utf8");
  return pattern.test(contents) ? [`${entry}: ${pattern}`] : [];
});
if (stale.length > 0) {
  throw new Error(
    `Pre-migration ownership paths remain in elizaOS/os metadata:\n${stale.map((entry) => `- ${entry}`).join("\n")}`,
  );
}

console.log(`OS repository layout passed: ${tracked.length} tracked paths.`);
