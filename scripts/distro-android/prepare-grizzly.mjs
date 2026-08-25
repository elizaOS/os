#!/usr/bin/env node
/** Generate the Pixel 11 Pro vendor/device module from pinned stock inputs. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertGeneratedVendorTree,
  assertPinnedAospCheckout,
  loadAospLock,
  materializeExternalProjects,
  materializeLockedSourceOverlays,
  verifyLockedArtifact,
} from "./bootstrap-aosp.mjs";
import { withSisoCompatibility } from "./siso-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../..");
const defaultLockPath = path.join(
  repositoryRoot,
  "packages/os/android/pixel11pro.lock.json",
);

function fail(message) {
  throw new Error(`[distro-android:grizzly] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}

export function parseArgs(argv) {
  const options = {
    aospRoot: "",
    lockPath: defaultLockPath,
    skipInstall: false,
    skipRollbackDownload: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--aosp-root" && value) {
      options.aospRoot = path.resolve(value);
      index += 1;
    } else if (argument === "--lock" && value) {
      options.lockPath = path.resolve(value);
      index += 1;
    } else if (argument === "--skip-install") {
      options.skipInstall = true;
    } else if (argument === "--skip-rollback-download") {
      options.skipRollbackDownload = true;
    } else {
      fail(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!options.aospRoot) fail("--aosp-root is required");
  return options;
}

function downloadLockedArtifact(contract, destination) {
  if (fs.existsSync(destination)) return;
  const partial = `${destination}.partial`;
  console.log(
    `[distro-android:grizzly] downloading ${contract.filename}; this download is governed by Google's Pixel factory-image terms`,
  );
  run("curl", [
    "--location",
    "--fail",
    "--retry",
    "5",
    "--continue-at",
    "-",
    "--output",
    partial,
    contract.url,
  ]);
}

export async function prepareGrizzly({
  aospRoot,
  lockPath,
  skipInstall = false,
  skipRollbackDownload = false,
}) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("Pixel 11 Pro vendor generation requires a Linux x86_64 builder");
  }
  if (!fs.existsSync(path.join(aospRoot, "build/envsetup.sh"))) {
    fail(`${aospRoot} is not a complete AOSP checkout`);
  }
  const lock = loadAospLock(lockPath);
  if (lock.device?.codename !== "grizzly" || !lock.generatedVendor) {
    fail(`${lockPath} is not a Pixel 11 Pro generated-vendor lock`);
  }
  materializeExternalProjects(aospRoot, lock);
  assertPinnedAospCheckout(aospRoot, lock);
  const overlayResult = await materializeLockedSourceOverlays(aospRoot, lock);
  const overlayStamp = JSON.stringify(
    overlayResult.overlays.map(({ path: overlayPath, sha256 }) => ({
      path: overlayPath,
      sha256,
    })),
  );
  const overlayStampPath = path.join(
    aospRoot,
    "out_adevtool_deps/.elizaos-source-overlay-stamp.json",
  );
  const existingOverlayStamp = fs.existsSync(overlayStampPath)
    ? fs.readFileSync(overlayStampPath, "utf8")
    : "";
  if (overlayResult.changed || existingOverlayStamp !== overlayStamp) {
    // adevtool's host tools are compiled from the AOSP tree. Invalidate only
    // its disposable dependency output when a source overlay changes.
    fs.rmSync(path.join(aospRoot, "out_adevtool_deps"), {
      recursive: true,
      force: true,
    });
  }

  const adevtoolRoot = path.join(aospRoot, "vendor/adevtool");
  if (!skipInstall) {
    run("corepack", ["yarn", "install", "--frozen-lockfile"], {
      cwd: adevtoolRoot,
    });
  }

  const [commandName, ...commandArguments] = lock.generatedVendor.command;
  const command =
    commandName === "adevtool"
      ? path.join(adevtoolRoot, "bin/run")
      : commandName;
  run(command, commandArguments, {
    cwd: aospRoot,
    env: withSisoCompatibility(),
  });
  fs.mkdirSync(path.dirname(overlayStampPath), { recursive: true });
  fs.writeFileSync(overlayStampPath, overlayStamp);
  const files = assertGeneratedVendorTree(aospRoot, lock);

  const downloadRoot = path.join(adevtoolRoot, "dl");
  const referenceImage = path.join(
    downloadRoot,
    lock.referenceFactoryImage.filename,
  );
  await verifyLockedArtifact(lock.referenceFactoryImage, referenceImage, {
    label: "Pixel 11 Pro reference factory image",
  });
  if (!skipRollbackDownload) {
    fs.mkdirSync(downloadRoot, { recursive: true });
    const rollbackImage = path.join(
      downloadRoot,
      lock.rollbackFactoryImage.filename,
    );
    downloadLockedArtifact(lock.rollbackFactoryImage, rollbackImage);
    const partial = `${rollbackImage}.partial`;
    if (!fs.existsSync(rollbackImage) && fs.existsSync(partial)) {
      await verifyLockedArtifact(lock.rollbackFactoryImage, partial, {
        enforceFilename: false,
        label: "Pixel 11 Pro rollback factory image",
      });
      fs.renameSync(partial, rollbackImage);
    }
    await verifyLockedArtifact(lock.rollbackFactoryImage, rollbackImage, {
      label: "Pixel 11 Pro rollback factory image",
    });
  }
  console.log(
    `[distro-android:grizzly] generated and verified ${files.length} required Pixel 11 Pro vendor files`,
  );
  return { lock, files };
}

if (import.meta.main) {
  await prepareGrizzly(parseArgs(process.argv.slice(2)));
}
