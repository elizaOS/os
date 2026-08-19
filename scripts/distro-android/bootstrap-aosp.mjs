#!/usr/bin/env node
/** Materialize the complete AOSP checkout pinned by packages/os/android/aosp.lock.json. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  const safeRelativePath = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..");
  if (lock.device !== undefined) {
    const device = lock.device;
    if (
      typeof device?.targetId !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(device.targetId) ||
      typeof device?.codename !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(device.codename) ||
      typeof device?.buildId !== "string" ||
      device.buildId.length === 0 ||
      typeof device?.productBrand !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(device.productBrand) ||
      typeof device?.productName !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(device.productName) ||
      device.expectedFingerprintPrefix !==
        `${device.productBrand}/${device.productName}/${device.codename}:`
    ) {
      fail(`invalid device contract in AOSP lock: ${filePath}`);
    }
  }
  if (lock.projects !== undefined) {
    if (!Array.isArray(lock.projects) || lock.projects.length === 0) {
      fail(`invalid projects in AOSP lock: ${filePath}`);
    }
    const seen = new Set();
    for (const project of lock.projects) {
      if (
        !safeRelativePath(project?.path) ||
        !safeRelativePath(project?.name) ||
        !/^[0-9a-f]{40}$/.test(project?.tagObject ?? "") ||
        !/^[0-9a-f]{40}$/.test(project?.commit ?? "") ||
        seen.has(project.path)
      ) {
        fail(`invalid locked project in ${filePath}`);
      }
      seen.add(project.path);
    }
  }
  for (const requiredPath of lock.requiredSourceFiles ?? []) {
    if (!safeRelativePath(requiredPath)) {
      fail(`invalid requiredSourceFiles entry in ${filePath}`);
    }
  }
  if (lock.proprietaryArchive !== undefined) {
    const archive = lock.proprietaryArchive;
    if (
      typeof archive.filename !== "string" ||
      path.basename(archive.filename) !== archive.filename ||
      typeof archive.url !== "string" ||
      !archive.url.startsWith("https://") ||
      !Number.isSafeInteger(archive.sizeBytes) ||
      archive.sizeBytes <= 0 ||
      !/^[0-9a-f]{64}$/.test(archive.sha256 ?? "") ||
      archive.sha256 === "0".repeat(64) ||
      !Array.isArray(archive.requiredExtractedFiles) ||
      archive.requiredExtractedFiles.length === 0 ||
      archive.requiredExtractedFiles.some(
        (requiredPath) => !safeRelativePath(requiredPath),
      )
    ) {
      fail(`invalid proprietaryArchive in ${filePath}`);
    }
  }
  return lock;
}

export function parseBootstrapArgs(argv) {
  const parsed = {
    aospRoot: "",
    initOnly: false,
    jobs: Math.max(1, os.cpus().length),
    repoBin: process.env.REPO_BIN || "repo",
    lockPath: aospLockPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--aosp-root" && value) {
      parsed.aospRoot = path.resolve(value);
      index += 1;
    } else if (arg === "--jobs" && value) {
      if (!/^\d+$/.test(value)) fail("--jobs must be a positive integer");
      parsed.jobs = Number(value);
      index += 1;
    } else if (arg === "--repo-bin" && value) {
      parsed.repoBin = value.includes(path.sep) ? path.resolve(value) : value;
      index += 1;
    } else if (arg === "--lock" && value) {
      parsed.lockPath = path.resolve(value);
      index += 1;
    } else if (arg === "--init-only") {
      parsed.initOnly = true;
    } else {
      fail(`unknown or incomplete argument: ${arg}`);
    }
  }
  if (!parsed.aospRoot) fail("--aosp-root is required");
  if (
    !Number.isSafeInteger(parsed.jobs) ||
    parsed.jobs < 1 ||
    parsed.jobs > 256
  ) {
    fail("--jobs must be an integer from 1 through 256");
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

export function assertPinnedAospCheckout(
  aospRoot,
  lock = loadAospLock(),
  { requireProjects = true } = {},
) {
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
  if (requireProjects) {
    for (const project of lock.projects ?? []) {
      const projectRoot = path.join(aospRoot, project.path);
      if (!fs.existsSync(projectRoot)) {
        fail(`missing locked AOSP project: ${project.path}`);
      }
      const projectHead = run("git", ["rev-parse", "HEAD"], {
        cwd: projectRoot,
        capture: true,
      });
      if (projectHead !== project.commit) {
        fail(
          `AOSP project mismatch for ${project.path}: expected ${project.commit}, got ${projectHead}`,
        );
      }
    }
    for (const requiredPath of lock.requiredSourceFiles ?? []) {
      if (!fs.existsSync(path.join(aospRoot, requiredPath))) {
        fail(`missing required AOSP source path: ${requiredPath}`);
      }
    }
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
  for (const project of lock.projects ?? []) {
    const projectUrl = `https://android.googlesource.com/${project.name}`;
    const projectOutput = run(
      "git",
      [
        "ls-remote",
        projectUrl,
        `refs/tags/${lock.manifestRevision}`,
        `refs/tags/${lock.manifestRevision}^{}`,
      ],
      { capture: true },
    );
    const projectRefs = new Map(
      projectOutput.split("\n").map((line) => {
        const [hash, ref] = line.trim().split(/\s+/, 2);
        return [ref, hash];
      }),
    );
    if (
      projectRefs.get(`refs/tags/${lock.manifestRevision}`) !==
        project.tagObject ||
      projectRefs.get(`refs/tags/${lock.manifestRevision}^{}`) !==
        project.commit
    ) {
      fail(
        `remote AOSP project tag ${project.name}@${lock.manifestRevision} does not match the lock`,
      );
    }
  }
}

export async function verifyProprietaryArchive(lock, archivePath) {
  const contract = lock.proprietaryArchive;
  if (!contract) fail("selected AOSP lock has no proprietary archive contract");
  const resolved = path.resolve(archivePath);
  if (!fs.existsSync(resolved))
    fail(`proprietary archive is missing: ${resolved}`);
  if (path.basename(resolved) !== contract.filename) {
    fail(`proprietary archive filename must be ${contract.filename}`);
  }
  const sizeBytes = fs.statSync(resolved).size;
  if (sizeBytes !== contract.sizeBytes) {
    fail(
      `proprietary archive size ${sizeBytes} does not match locked ${contract.sizeBytes}`,
    );
  }
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = fs.createReadStream(resolved);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  const sha256 = hash.digest("hex");
  if (sha256 !== contract.sha256) {
    fail(
      `proprietary archive SHA-256 ${sha256} does not match locked ${contract.sha256}`,
    );
  }
  return { path: resolved, sizeBytes, sha256 };
}

export function assertExtractedVendorTree(aospRoot, lock) {
  const contract = lock.proprietaryArchive;
  if (!contract) fail("selected AOSP lock has no proprietary archive contract");
  const missing = contract.requiredExtractedFiles.filter(
    (requiredPath) => !fs.existsSync(path.join(aospRoot, requiredPath)),
  );
  if (missing.length > 0) {
    fail(`licensed vendor extraction is incomplete: ${missing.join(", ")}`);
  }
  return contract.requiredExtractedFiles;
}

export function bootstrapAosp({
  aospRoot,
  initOnly,
  jobs,
  repoBin,
  lockPath = aospLockPath,
}) {
  const lock = loadAospLock(lockPath);
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
  assertPinnedAospCheckout(aospRoot, lock, { requireProjects: false });
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
    assertPinnedAospCheckout(aospRoot, lock);
  }
  fs.copyFileSync(lockPath, path.join(aospRoot, ".elizaos-aosp-lock.json"));
  return lock;
}

if (import.meta.main) {
  const args = parseBootstrapArgs(process.argv.slice(2));
  const lock = bootstrapAosp(args);
  console.log(
    `[distro-android:bootstrap] ready ${args.aospRoot} at ${lock.manifestRevision} (${lock.manifestCommit})`,
  );
}
