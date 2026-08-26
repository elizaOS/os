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
    )
    .replace(/^type system_server_startup, domain, coredomain;\n/gm, "")
    .replace(/^type system_server_startup_tmpfs, file_type;\n/gm, "");
  if (normalized !== contents) fs.writeFileSync(typesPath, normalized);
}

// The stock A9 vendor manifest advertises the previous sepolicy API level
// (202604), while Android 17's board contract builds against 202704. Keep the
// generated HAL declarations unchanged and update only the manifest's
// sepolicy version so assemble_vintf can validate the device tree.
function normalizeGeneratedVintf(aospRoot) {
  const manifestPath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/vintf/vendor/manifest.xml",
  );
  if (!fs.existsSync(manifestPath)) return;
  const contents = fs.readFileSync(manifestPath, "utf8");
  const normalized = contents.replace(
    /(<sepolicy>\s*<version>)202604(<\/version>\s*<\/sepolicy>)/,
    "$1202704$2",
  );
  if (normalized !== contents) fs.writeFileSync(manifestPath, normalized);
}

// The extracted stock Malibu fstab carries encryption/compression and large-
// device options that are not implemented by the Android 17 kernel we build
// for the generated grizzly target.  Leaving them in place makes f2fs reject
// the /data mount during first-stage init (and the phone remains on the Google
// splash with no normal-boot ADB).  Keep the stock file in the generated tree
// for provenance, but replace only its userdata entry with the conservative
// options verified against this kernel in recovery.  This is deliberately
// applied to both the vendor and recovery copies so diagnostics and normal
// boot use the same mount contract.
function normalizeGeneratedF2fsMountOptions(aospRoot) {
  const relativePaths = [
    "vendor/google_devices/grizzly/proprietary/vendor/etc/fstab.malibu",
    "vendor/google_devices/grizzly/proprietary/vendor_ramdisk/system/etc/fstab.malibu",
    "vendor/google_devices/grizzly/proprietary/recovery/system/etc/recovery.fstab",
  ];
  const userdataPattern =
    /^\/dev\/block\/platform\/3c2d0000\.ufs\/by-name\/userdata\s+\/data\s+f2fs\s+.*$/m;
  const normalizedUserdata =
    "/dev/block/platform/3c2d0000.ufs/by-name/userdata /data f2fs " +
    "noatime,nosuid,nodev,discard,reserve_root=32768,resgid=1065," +
    "fsync_mode=nobarrier,atgc,checkpoint_merge " +
    "latemount,wait,check,quota,formattable";
  for (const relativePath of relativePaths) {
    const filePath = path.join(aospRoot, relativePath);
    if (!fs.existsSync(filePath)) continue;
    const contents = fs.readFileSync(filePath, "utf8");
    const normalized = contents.replace(userdataPattern, normalizedUserdata);
    if (normalized !== contents) {
      fs.writeFileSync(
        filePath,
        `# elizaOS: use kernel-supported f2fs userdata options for grizzly\n${normalized}`,
      );
    }
  }
}

function normalizeGeneratedUsbConfigfs(aospRoot) {
  const filePath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/proprietary/vendor/etc/init/hw/init.malibu.usb.rc",
  );
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, "utf8");
  const normalized = contents.replace(
    /setprop sys\.usb\.configfs 2/g,
    "setprop sys.usb.configfs 1",
  );
  if (normalized !== contents) {
    fs.chmodSync(filePath, 0o644);
    fs.writeFileSync(filePath, normalized);
  }
}

// Google's stock Android 17 grizzly image enables SurfaceFlinger's Graphite
// Vulkan RenderEngine. The extracted proprietary PowerVR EGL implementation
// does not expose an EGL_RECORDABLE_ANDROID RGBA_8888 window+pbuffer config
// accepted by the Android 17 SkiaGL RenderEngine, while the same stock stack
// exposes a working Vulkan 1.4 device with protected-memory support. Preserve
// the stock render path through SurfaceFlinger's supported flag override; do
// not force a backend, so RenderEngine::canSupport(Vk) remains authoritative.
export function normalizeGeneratedRenderEngine(aospRoot) {
  const makefilePath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/grizzly.mk",
  );
  if (!fs.existsSync(makefilePath)) return;
  const contents = fs.readFileSync(makefilePath, "utf8");
  if (contents.includes("debug.renderengine.graphite=true")) return;
  fs.writeFileSync(
    makefilePath,
    `${contents.trimEnd()}\n\n# Match the stock Pixel 11 Pro Android 17 RenderEngine path.\nPRODUCT_SYSTEM_PROPERTIES += \\\n    debug.renderengine.graphite=true\n`,
  );
}

// Keep bring-up observability separate from the extracted stock init actions.
// The diagnostics are packaged explicitly, gated to debuggable builds, and do
// not alter module readiness, storage, or Android's canonical boot triggers.
export function stageGeneratedBringupDiagnostics(aospRoot) {
  const generatedRoot = path.join(aospRoot, "vendor/google_devices/grizzly");
  const stockInitPath = path.join(
    generatedRoot,
    "proprietary/vendor/etc/init/hw/init.grizzly.rc",
  );
  const makefilePath = path.join(generatedRoot, "grizzly.mk");
  for (const requiredPath of [stockInitPath, makefilePath]) {
    if (!fs.existsSync(requiredPath)) {
      fail(`generated bring-up diagnostics require ${requiredPath}`);
    }
  }

  const importLine = "import /vendor/etc/init/hw/init.elizaos-debug.rc";
  const stockInit = fs.readFileSync(stockInitPath, "utf8");
  if (!stockInit.includes(importLine)) {
    const normalized = stockInit.replace(
      /^# grizzly specific init\.rc$/m,
      `# grizzly specific init.rc\n${importLine}`,
    );
    if (normalized === stockInit) {
      fail("generated init.grizzly.rc is missing its expected header");
    }
    fs.chmodSync(stockInitPath, 0o644);
    fs.writeFileSync(stockInitPath, normalized);
  }

  const debugInitRelative =
    "proprietary/vendor/etc/init/hw/init.elizaos-debug.rc";
  const debugInitPath = path.join(generatedRoot, debugInitRelative);
  fs.mkdirSync(path.dirname(debugInitPath), { recursive: true });
  fs.writeFileSync(
    debugInitPath,
    `# elizaOS userdebug bring-up diagnostics; remove after hardware qualification.

on early-init && property:ro.debuggable=1
    write /metadata/elizaos_vendor_early_init.marker 1
    setprop sys.usb.controller a210000.dwc3
    setprop sys.usb.configfs 1
    setprop persist.sys.usb.config adb
    setprop sys.usb.config adb
    start adbd

on post-fs && property:ro.debuggable=1
    write /metadata/elizaos_vendor_post_fs.marker 1

on late-fs && property:ro.debuggable=1
    write /metadata/elizaos_vendor_late_fs.marker 1

on post-fs-data && property:ro.debuggable=1
    write /metadata/elizaos_vendor_post_fs_data.marker 1

on boot && property:ro.debuggable=1
    write /metadata/elizaos_vendor_boot.marker 1
`,
  );
  fs.chmodSync(debugInitPath, 0o644);

  const copyDestination =
    "$(TARGET_COPY_OUT_VENDOR)/etc/init/hw/init.elizaos-debug.rc";
  const copyEntry = `    vendor/google_devices/grizzly/${debugInitRelative}:${copyDestination}`;
  const makefile = fs.readFileSync(makefilePath, "utf8");
  if (!makefile.includes(copyDestination)) {
    fs.writeFileSync(
      makefilePath,
      `${makefile.trimEnd()}\n\n# elizaOS userdebug bring-up diagnostics\nPRODUCT_COPY_FILES += \\\n${copyEntry}\n`,
    );
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
  if (result.status !== 0) {
    if (result.error) fail(`${command} failed: ${result.error.message}`);
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
      normalizeGeneratedVintf(aospRoot);
      normalizeGeneratedF2fsMountOptions(aospRoot);
      normalizeGeneratedUsbConfigfs(aospRoot);
      normalizeGeneratedRenderEngine(aospRoot);
      stageGeneratedBringupDiagnostics(aospRoot);
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
    normalizeGeneratedVintf(aospRoot);
    normalizeGeneratedF2fsMountOptions(aospRoot);
    normalizeGeneratedUsbConfigfs(aospRoot);
    normalizeGeneratedRenderEngine(aospRoot);
    stageGeneratedBringupDiagnostics(aospRoot);
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
