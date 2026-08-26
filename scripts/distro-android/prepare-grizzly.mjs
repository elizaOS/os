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
  const withAdbDefault = normalized.replace(
    /on boot\n {4}# Use USB Gadget HAL\n {4}setprop sys\.usb\.configfs 1/,
    "on boot\n    # Use USB Gadget HAL\n    setprop sys.usb.controller a210000.dwc3\n    setprop sys.usb.configfs 1\n    # Keep the unlocked userdebug bring-up reachable before framework USB policy.\n    setprop persist.sys.usb.config adb\n    setprop sys.usb.config adb",
  );
  if (withAdbDefault !== contents) {
    fs.chmodSync(filePath, 0o644);
    fs.writeFileSync(filePath, withAdbDefault);
  }
}

// The extracted stock grizzly init waits synchronously for every proprietary
// kernel module before proceeding through early-boot.  During bring-up a
// missing optional module must not strand init (and therefore USB/adbd) on the
// splash screen; the module loader remains started asynchronously below.
function normalizeGeneratedEarlyBootModuleWait(aospRoot) {
  const filePath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/proprietary/vendor/etc/init/hw/init.grizzly.rc",
  );
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, "utf8");
  const normalized = contents.replace(
    /on early-boot\n {4}# Wait for insmod_sh to finish all common modules\n {4}wait_for_prop vendor\.common\.modules\.ready 1\n {4}start insmod_sh_grizzly/,
    "on early-boot\n    # elizaOS: keep bring-up non-blocking when an optional module is absent\n    start insmod_sh_grizzly",
  );
  const withMarker = normalized
    .replace(
      /^# grizzly specific init\.rc$/m,
      "# grizzly specific init.rc\nimport /vendor/etc/init/hw/init.elizaos-debug.rc",
    )
    .replace(
      /^on early-boot/m,
      "on early-init\n    # elizaOS: prove vendor init reached the earliest normal-boot phase\n    write /metadata/elizaos_vendor_init.marker 1\n    setprop sys.usb.controller a210000.dwc3\n    setprop sys.usb.configfs 1\n    setprop persist.sys.usb.config adb\n    setprop sys.usb.config adb\n    # elizaOS: expose a root debug shell before vendor post-fs-data actions\n    start adbd\n\non early-boot",
    );
  if (withMarker !== contents) {
    fs.chmodSync(filePath, 0o644);
    fs.writeFileSync(filePath, withMarker);
  }
}

function normalizeGeneratedDebugInit(aospRoot) {
  const filePath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/proprietary/vendor/etc/init/hw/init.elizaos-debug.rc",
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const contents = `# elizaOS bring-up ordering probe; remove after normal boot is proven.\n\non post-fs\n    write /metadata/elizaos_debug_postfs.marker 1\n    setprop sys.usb.controller a210000.dwc3\n    setprop sys.usb.config adb\n    start adbd\n\non post-fs-data\n    write /metadata/elizaos_debug_postfs_data.marker 1\n`;
  fs.chmodSync(filePath, 0o644);
  fs.writeFileSync(filePath, contents);
}

function normalizeGeneratedModuleWaits(aospRoot) {
  const relativePaths = [
    "vendor/google_devices/grizzly/proprietary/vendor/etc/init/hw/init.malibu.rc",
    "vendor/google_devices/grizzly/proprietary/vendor/etc/init/hw/init.modem.rc",
    "vendor/google_devices/grizzly/proprietary/vendor/etc/init/dump_power.rc",
  ];
  for (const relativePath of relativePaths) {
    const filePath = path.join(aospRoot, relativePath);
    if (!fs.existsSync(filePath)) continue;
    const contents = fs.readFileSync(filePath, "utf8");
    const normalized = contents.replace(
      /^\s*wait_for_prop vendor\.common\.modules\.ready 1\s*$/gm,
      "    # elizaOS: do not block boot on optional module readiness",
    );
    if (normalized !== contents) {
      fs.chmodSync(filePath, 0o644);
      fs.writeFileSync(filePath, normalized);
    }
  }
}

// The stock storage proxy action waits synchronously for the secure-storage
// SCSI node.  On an unlocked bring-up device that node can be late (or absent)
// while the rest of init is healthy; blocking post-fs here prevents bootanim,
// framework startup, and normal-boot ADB from ever becoming observable.  Keep
// the service start, but let its own retry/error handling deal with readiness.
function normalizeGeneratedStorageProxyWait(aospRoot) {
  const filePath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/proprietary/vendor/etc/init/hw/init.malibu.rc",
  );
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, "utf8");
  const normalized = contents.replace(
    /^ {4}wait \/dev\/sg1\n {4}start storageproxyd$/m,
    "    # elizaOS: do not block post-fs on optional secure-storage enumeration\n    start storageproxyd",
  );
  if (normalized !== contents) {
    fs.chmodSync(filePath, 0o644);
    fs.writeFileSync(filePath, normalized);
  }
}

function normalizeGeneratedInitPhaseMarkers(aospRoot) {
  const filePath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/proprietary/vendor/etc/init/hw/init.malibu.rc",
  );
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, "utf8");
  const normalized = contents
    .replace(
      /^on post-fs$/m,
      "on post-fs\n    write /metadata/elizaos_postfs.marker 1",
    )
    .replace(
      /^on post-fs-data$/m,
      "on post-fs-data\n    write /metadata/elizaos_postfs_data.marker 1",
    )
    .replace(
      /^on late-fs$/m,
      "on late-fs\n    write /metadata/elizaos_latefs.marker 1",
    )
    .replace(
      /^ {4}mount_all --late$/m,
      "    mount_all --late\n    write /metadata/elizaos_latefs_done.marker 1\n    # elizaOS: continue init even if fs_mgr does not emit the next event\n    trigger post-fs-data",
    )
    .replace(
      /^on post-fs\n {4}write \/metadata\/elizaos_bootanim\.marker 1$/m,
      "on post-fs\n    write /metadata/elizaos_bootanim.marker 1\n    # elizaOS: expose ADB before vendor post-fs-data actions\n    start adbd\n    setprop sys.usb.controller a210000.dwc3\n    setprop sys.usb.config adb",
    )
    .replace(/^on boot$/m, "on boot\n    write /metadata/elizaos_boot.marker 1")
    .replace(
      /^on property:vendor\.common\.modules\.ready=1$/m,
      "on post-fs\n    write /metadata/elizaos_bootanim.marker 1",
    );
  if (normalized !== contents) {
    fs.chmodSync(filePath, 0o644);
    fs.writeFileSync(filePath, normalized);
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
      normalizeGeneratedVintf(aospRoot);
      normalizeGeneratedF2fsMountOptions(aospRoot);
      normalizeGeneratedUsbConfigfs(aospRoot);
      normalizeGeneratedEarlyBootModuleWait(aospRoot);
      normalizeGeneratedDebugInit(aospRoot);
      normalizeGeneratedModuleWaits(aospRoot);
      normalizeGeneratedStorageProxyWait(aospRoot);
      normalizeGeneratedInitPhaseMarkers(aospRoot);
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
    normalizeGeneratedEarlyBootModuleWait(aospRoot);
    normalizeGeneratedDebugInit(aospRoot);
    normalizeGeneratedModuleWaits(aospRoot);
    normalizeGeneratedStorageProxyWait(aospRoot);
    normalizeGeneratedInitPhaseMarkers(aospRoot);
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
