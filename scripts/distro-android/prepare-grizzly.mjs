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

// The generated Pixel makefile carries the factory image's BUILD_ID guard.
// Android 17's product configuration owns BUILD_ID as a readonly value and
// uses a different source-tree release ID, so preserving the guard as a
// warning is required for a custom AOSP build. The original guard text stays
// in the file (and in the lock contract) for provenance and reviewability.
function normalizeGeneratedBuildIdGuard(aospRoot) {
  const makefilePath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/grizzly.mk",
  );
  if (!fs.existsSync(makefilePath)) return;
  const contents = fs.readFileSync(makefilePath, "utf8");
  const strictError =
    "  $(error BUILD_ID: expected CD1A.260714.001.A9, got $(BUILD_ID))";
  const warning =
    "  $(warning BUILD_ID: factory CD1A.260714.001.A9; using AOSP $(BUILD_ID))";
  if (!contents.includes(strictError) || contents.includes(warning)) return;
  fs.writeFileSync(makefilePath, contents.replace(strictError, warning));
}

// Android 17's root dexpreopt check resolves the Malibu provider by its local
// module name. adevtool emits the provider in a private Soong namespace, which
// makes it invisible to the root namespace. Add a narrow global shim rather
// than flattening every proprietary module (some names, such as `health`, also
// exist in Cuttlefish).
function normalizeGeneratedProprietaryNamespace(aospRoot) {
  const proprietaryBpPath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/proprietary/Android.bp",
  );
  if (!fs.existsSync(proprietaryBpPath)) return;
  const contents = fs.readFileSync(proprietaryBpPath, "utf8");
  const flattenedMarker =
    "// elizaOS: expose grizzly proprietary modules globally\n";
  if (contents.includes(flattenedMarker)) {
    fs.writeFileSync(
      proprietaryBpPath,
      contents.replace(flattenedMarker, "soong_namespace {}\n"),
    );
  }
  const normalizedProprietary = fs.readFileSync(proprietaryBpPath, "utf8");
  const malibuModule =
    /\ndex_import \{\n {4}name: "malibu-plugin-provider",[\s\S]*?\n\}\n/;
  if (malibuModule.test(normalizedProprietary)) {
    fs.writeFileSync(
      proprietaryBpPath,
      normalizedProprietary.replace(malibuModule, "\n"),
    );
  }

  const shimDir = path.join(aospRoot, "vendor/google_devices/grizzly");
  const staleShimDir = path.join(shimDir, "malibu-plugin-provider");
  fs.rmSync(staleShimDir, { recursive: true, force: true });
  fs.writeFileSync(
    path.join(shimDir, "Android.bp"),
    `dex_import {
    name: "malibu-plugin-provider",
    owner: "google_devices",
    jars: [ "proprietary/system_ext/framework/malibu-plugin-provider.jar" ],
    system_ext_specific: true,
}

// Android 17 already declares the preload-copy domain in
// system/sepolicy/private/preloads_copy.te. The generated Pixel policy
// carries the same two public declarations, which checkpolicy rejects as
// duplicate types when the grizzly system_ext policy is assembled. Remove
// only those generated duplicates; all generated allow rules and exec labels
// remain intact.
function normalizeGeneratedSePolicy(aospRoot) {
  const typesPath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/sepolicy/system_ext/public/types.te",
  );
  if (!fs.existsSync(typesPath)) return;
  const contents = fs.readFileSync(typesPath, "utf8");
  const normalized = contents
    .replace(/^type preloads_copy, domain, coredomain;\n/gm, "")
    .replace(
      /^type preloads_copy_exec, file_type, exec_type, system_file_type;\n/gm,
      "",
    );
  if (normalized !== contents) fs.writeFileSync(typesPath, normalized);
}
`,
  );

  const makefilePath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/grizzly.mk",
  );
  if (fs.existsSync(makefilePath)) {
    const makefile = fs.readFileSync(makefilePath, "utf8");
    const namespaceLine = "    vendor/google_devices/grizzly \\\n";
    if (!makefile.includes(namespaceLine)) {
      fs.writeFileSync(
        makefilePath,
        makefile.replace(
          "PRODUCT_SOONG_NAMESPACES += \\\n",
          `PRODUCT_SOONG_NAMESPACES += \\\n${namespaceLine}`,
        ),
      );
    }
  }
}

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
  const generatedRoot = path.join(aospRoot, "vendor/google_devices/grizzly");
  let generatedTreeComplete = false;
  if (fs.existsSync(generatedRoot)) {
    try {
      normalizeGeneratedBuildIdGuard(aospRoot);
      normalizeGeneratedProprietaryNamespace(aospRoot);
      normalizeGeneratedSePolicy(aospRoot);
      assertGeneratedVendorTree(aospRoot, lock);
      generatedTreeComplete = true;
    } catch {
      // A failed adevtool run can leave a partial tree that is unsafe to
      // merge into on retry. Remove only this generated device directory.
      fs.rmSync(generatedRoot, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.dirname(overlayStampPath), { recursive: true });
  fs.writeFileSync(overlayStampPath, overlayStamp);

  if (!generatedTreeComplete) {
    const [commandName, ...commandArguments] = lock.generatedVendor.command;
    const command =
      commandName === "adevtool"
        ? path.join(adevtoolRoot, "bin/run")
        : commandName;
    run(command, commandArguments, {
      cwd: aospRoot,
      env: withSisoCompatibility(),
    });
    normalizeGeneratedBuildIdGuard(aospRoot);
    normalizeGeneratedProprietaryNamespace(aospRoot);
    normalizeGeneratedSePolicy(aospRoot);
  }
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
