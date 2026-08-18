#!/usr/bin/env node
/** Materialize the complete AOSP checkout pinned by packages/os/android/aosp.lock.json. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../..");
export const aospLockPath = path.join(
  repositoryRoot,
  "packages/os/android/aosp.lock.json",
);

function fail(message) {
  throw new Error(`[distro-android:bootstrap] ${message}`);
}

export function loadAospLock(filePath = aospLockPath) {
  const lock = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (
    lock.schemaVersion !== 1 ||
    typeof lock.manifestUrl !== "string" ||
    typeof lock.manifestRevision !== "string" ||
    !/^[0-9a-f]{40}$/.test(lock.manifestTagObject ?? "") ||
    !/^[0-9a-f]{40}$/.test(lock.manifestCommit ?? "")
  ) {
    fail(`invalid AOSP lock: ${filePath}`);
  }
  return lock;
}

export function parseBootstrapArgs(argv) {
  const parsed = {
    aospRoot: "",
    initOnly: false,
    jobs: Math.max(1, os.cpus().length),
    repoBin: process.env.REPO_BIN || "repo",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--aosp-root" && value) {
      parsed.aospRoot = path.resolve(value);
      index += 1;
    } else if (arg === "--jobs" && value) {
      parsed.jobs = Number.parseInt(value, 10);
      index += 1;
    } else if (arg === "--repo-bin" && value) {
      parsed.repoBin = value.includes(path.sep) ? path.resolve(value) : value;
      index += 1;
    } else if (arg === "--init-only") {
      parsed.initOnly = true;
    } else {
      fail(`unknown or incomplete argument: ${arg}`);
    }
  }
  if (!parsed.aospRoot) fail("--aosp-root is required");
  if (!Number.isSafeInteger(parsed.jobs) || parsed.jobs < 1) {
    fail("--jobs must be a positive integer");
  }
  return parsed;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return (result.stdout ?? "").trim();
}

export function assertPinnedAospCheckout(aospRoot, lock = loadAospLock()) {
  const manifests = path.join(aospRoot, ".repo/manifests");
  if (!fs.existsSync(manifests)) {
    fail(`missing repo manifest checkout: ${manifests}`);
  }
  const actual = run("git", ["rev-parse", "HEAD"], {
    cwd: manifests,
    capture: true,
  });
  if (actual !== lock.manifestCommit) {
    fail(
      `AOSP manifest mismatch: expected ${lock.manifestCommit} (${lock.manifestRevision}), got ${actual}`,
    );
  }
  return actual;
}

export function assertRemoteManifestTag(lock = loadAospLock()) {
  const output = run(
    "git",
    [
      "ls-remote",
      lock.manifestUrl,
      `refs/tags/${lock.manifestRevision}`,
      `refs/tags/${lock.manifestRevision}^{}`,
    ],
    { capture: true },
  );
  const refs = new Map(
    output.split("\n").map((line) => {
      const [hash, ref] = line.trim().split(/\s+/, 2);
      return [ref, hash];
    }),
  );
  if (
    refs.get(`refs/tags/${lock.manifestRevision}`) !== lock.manifestTagObject ||
    refs.get(`refs/tags/${lock.manifestRevision}^{}`) !== lock.manifestCommit
  ) {
    fail(`remote AOSP tag ${lock.manifestRevision} does not match the lock`);
  }
}

export function bootstrapAosp({ aospRoot, initOnly, jobs, repoBin }) {
  const lock = loadAospLock();
  fs.mkdirSync(aospRoot, { recursive: true });
  const entries = fs.readdirSync(aospRoot).filter((entry) => entry !== ".repo");
  if (!fs.existsSync(path.join(aospRoot, ".repo")) && entries.length > 0) {
    fail(
      `refusing to initialize nonempty directory without .repo: ${aospRoot}`,
    );
  }
  assertRemoteManifestTag(lock);
  run(
    repoBin,
    ["init", "-u", lock.manifestUrl, "-b", lock.manifestRevision, "--depth=1"],
    { cwd: aospRoot },
  );
  assertPinnedAospCheckout(aospRoot, lock);
  if (!initOnly) {
    run(
      repoBin,
      [
        "sync",
        "-c",
        "--no-tags",
        "--optimized-fetch",
        "--prune",
        "--fail-fast",
        `-j${jobs}`,
      ],
      { cwd: aospRoot },
    );
  }
  fs.copyFileSync(aospLockPath, path.join(aospRoot, ".elizaos-aosp-lock.json"));
  return lock;
}

if (import.meta.main) {
  const args = parseBootstrapArgs(process.argv.slice(2));
  const lock = bootstrapAosp(args);
  console.log(
    `[distro-android:bootstrap] ready ${args.aospRoot} at ${lock.manifestRevision} (${lock.manifestCommit})`,
  );
}
