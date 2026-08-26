#!/usr/bin/env node

/**
 * verify-grizzly-artifacts.mjs — deterministic image↔intent verification for
 * Pixel 11 Pro (grizzly) bring-up.
 *
 * Motivation: a full flash cycle was lost when a vendor.img believed to carry
 * debug.renderengine.backend=skiavkthreaded actually packaged the GL backend —
 * the tree was edited after the image was built. Every flash must be provable:
 * the image content, the prepare stamp it was built under, and the bytes that
 * reach fastboot must be one attested chain.
 *
 * Two modes:
 *
 * 1. Attest (build host, after `m`):
 *      node verify-grizzly-artifacts.mjs attest \
 *        --aosp-root "$HOME/aosp-grizzly" [--out grizzly-artifacts.json]
 *    Verifies the staged product output against the prepare stamp
 *    (.elizaos-prepare-stamp.json), fails closed on any mismatch, then writes
 *    a manifest with sha256 of every image so the flash host can prove it is
 *    flashing exactly what was attested. Copy the manifest alongside the
 *    images.
 *
 * 2. Check (flash host, before fastboot):
 *      node verify-grizzly-artifacts.mjs check \
 *        --manifest grizzly-artifacts.json --artifact-dir ./images
 *    Recomputes sha256 of each local image named in the manifest and refuses
 *    on any mismatch or absence. Prints the attested stamp so the operator
 *    knows exactly which renderer/probe/fstab stance is about to be flashed.
 *
 * Checks performed by attest (all fail closed unless noted):
 *  - prepare stamp exists and is parseable
 *  - staged vendor/build.prop renderengine lines match the stamp
 *    (backend override present iff stamp requests one, graphite value equal)
 *  - staged vendor fstab userdata stance matches the stamp
 *    (conservativeF2fs=false ⇒ stock encryption options intact)
 *  - probe init rc staged iff earlyBootProbes in the stamp
 *  - every image is newer than the newest relevant staged input (a stale
 *    image is exactly the failure this tool exists to prevent)
 *  - ELF max page-size alignment of staged system/vendor binaries we add
 *    (16 KiB kernels reject 4 KiB-aligned ELFs; warn-only when no readelf)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PRODUCT_DEVICE = "grizzly";
const STAMP_RELATIVE_PATH =
  "vendor/google_devices/grizzly/.elizaos-prepare-stamp.json";
// Partitions we build and flash for grizzly bring-up. The core set must all
// exist — a missing core image means the build is incomplete and attesting a
// partial set is exactly the stale-mix hazard this tool exists to prevent.
const REQUIRED_ATTESTED_IMAGES = [
  // The boot chain is not optional on grizzly. A vendor/system-only
  // attestation can still be paired with stale boot or vendor_boot bytes and
  // reproduce the device's vendor_boot AVB failure. Keep this list aligned
  // with build-grizzly-bundle.mjs' flash handoff contract.
  "boot.img",
  "init_boot.img",
  "dtbo.img",
  "vendor_kernel_boot.img",
  "pvmfw.img",
  "vendor_boot.img",
  "vbmeta.img",
  "system.img",
  "system_ext.img",
  "product.img",
  "vendor.img",
  "vendor_dlkm.img",
  "system_dlkm.img",
  "system_other.img",
  "super_empty.img",
];
// Attested when present: chained vbmeta split varies by board config, and the
// boot chain is stock (factory kernel) but still ships in the flash set — its
// bytes must be pinned so the flash host proves one coherent generation.
// vendor_boot additionally carries the vendor_ramdisk fstab, so it is
// promoted to required whenever the conservative-f2fs stance is stamped.
const OPTIONAL_ATTESTED_IMAGES = ["vbmeta_system.img", "vbmeta_vendor.img"];

function fail(message) {
  console.error(`[verify-grizzly-artifacts] ERROR: ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`[verify-grizzly-artifacts] WARN: ${message}`);
}

function info(message) {
  console.log(`[verify-grizzly-artifacts] ${message}`);
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const args = { mode };
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    const value = rest[index + 1];
    switch (key) {
      case "--aosp-root":
      case "--out":
      case "--manifest":
      case "--artifact-dir":
        if (!value) fail(`${key} requires a value`);
        args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] =
          path.resolve(value);
        index += 1;
        break;
      default:
        fail(`unknown argument: ${key}`);
    }
  }
  if (mode !== "attest" && mode !== "check") {
    fail("first argument must be `attest` or `check` (see file header)");
  }
  return args;
}

function newestMtimeUnder(dir, filterRegex = null) {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (!filterRegex || filterRegex.test(full)) {
        // lstat: staged AOSP trees contain dangling/absolute symlinks (odm,
        // module links); following them would abort attestation on ENOENT.
        try {
          const mtime = fs.lstatSync(full).mtimeMs;
          if (mtime > newest) newest = mtime;
        } catch {
          // A file that vanished mid-walk cannot be newer evidence.
        }
      }
    }
  }
  return newest;
}

function readStamp(aospRoot) {
  const stampPath = path.join(aospRoot, STAMP_RELATIVE_PATH);
  if (!fs.existsSync(stampPath)) {
    fail(
      `prepare stamp missing (${STAMP_RELATIVE_PATH}); run prepare-grizzly before attesting`,
    );
  }
  return JSON.parse(fs.readFileSync(stampPath, "utf8"));
}

function productOutDir(aospRoot) {
  const configured = process.env.OUT_DIR?.trim() || "out";
  const outRoot = path.isAbsolute(configured)
    ? configured
    : path.join(aospRoot, configured);
  return path.join(outRoot, "target", "product", PRODUCT_DEVICE);
}

// Recent AOSP builds remove the unpacked `vendor/` and `system/` staging
// directories after packaging. Read the final ext4 images when those trees
// are absent; otherwise the attestation would verify a directory that is not
// actually what fastboot receives.
function readImageEntry(aospRoot, imagePath, entryPath) {
  if (!fs.existsSync(imagePath)) return null;
  const simg2img = path.join(
    aospRoot,
    "out/host/linux-x86/bin/simg2img",
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grizzly-attest-"));
  const rawPath = path.join(tempDir, "image.raw");
  try {
    let debugfsImage = imagePath;
    if (fs.existsSync(simg2img)) {
      const header = fs.readFileSync(imagePath).subarray(0, 4);
      if (header.equals(Buffer.from([0x3a, 0xff, 0x26, 0xed]))) {
        execFileSync(simg2img, [imagePath, rawPath], { stdio: "ignore" });
        debugfsImage = rawPath;
      }
    }
    return execFileSync("debugfs", ["-R", `cat ${entryPath}`, debugfsImage], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function imageEntryExists(aospRoot, imagePath, entryPath) {
  if (!fs.existsSync(imagePath)) return false;
  const simg2img = path.join(
    aospRoot,
    "out/host/linux-x86/bin/simg2img",
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grizzly-attest-"));
  const rawPath = path.join(tempDir, "image.raw");
  try {
    let debugfsImage = imagePath;
    if (fs.existsSync(simg2img)) {
      const header = fs.readFileSync(imagePath).subarray(0, 4);
      if (header.equals(Buffer.from([0x3a, 0xff, 0x26, 0xed]))) {
        execFileSync(simg2img, [imagePath, rawPath], { stdio: "ignore" });
        debugfsImage = rawPath;
      }
    }
    execFileSync("debugfs", ["-R", `stat ${entryPath}`, debugfsImage], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// The staged vendor/build.prop is what vendor.img is packaged from; verifying
// it (rather than the source tree) catches the built-before-edited hazard.
function assertStagedRenderEngine(productDir, stagedVendorDir, stamp) {
  const buildProp = path.join(stagedVendorDir, "build.prop");
  const contents = fs.existsSync(buildProp)
    ? fs.readFileSync(buildProp, "utf8")
    : readImageEntry(
        path.resolve(productDir, "../../../../"),
        path.join(productDir, "vendor.img"),
        "/build.prop",
      );
  if (contents === null) {
    fail(`staged vendor build.prop missing from tree and vendor.img: ${buildProp}`);
  }
  const backendMatch = contents.match(/^debug\.renderengine\.backend=(\S+)$/m);
  const stagedBackend = backendMatch ? backendMatch[1] : null;
  if (stagedBackend !== (stamp.renderengineBackend ?? null)) {
    fail(
      `staged vendor build.prop backend=${JSON.stringify(stagedBackend)} but prepare stamp says ${JSON.stringify(stamp.renderengineBackend)}; the image would not run the intended renderer — rebuild after re-running prepare-grizzly`,
    );
  }
  const graphiteMatch = contents.match(
    /^debug\.renderengine\.graphite=(true|false)$/m,
  );
  if (!graphiteMatch) {
    fail("staged vendor build.prop has no debug.renderengine.graphite line");
  }
  const stagedGraphite = graphiteMatch[1] === "true";
  if (stagedGraphite !== stamp.renderengineGraphite) {
    fail(
      `staged vendor build.prop graphite=${stagedGraphite} but prepare stamp says ${stamp.renderengineGraphite}; rebuild after re-running prepare-grizzly`,
    );
  }
  const stagedAngle = /^persist\.graphics\.egl=angle$/m.test(contents);
  if (stamp.eglSelection === "native" && stagedAngle) {
    fail(
      "prepare stamp selects the native PowerVR EGL driver but the staged vendor build.prop still routes through ANGLE; rebuild after re-running prepare-grizzly",
    );
  }
  if (stamp.eglSelection !== "native" && !stagedAngle) {
    fail(
      "staged vendor build.prop lost the stock persist.graphics.egl=angle selection without a native-EGL stamp; the image does not match any declared stance",
    );
  }
  if (stamp.eglSelection !== "native") {
    const angleCandidates = [
      path.join(stagedVendorDir, "..", "system", "lib64", "libEGL_angle.so"),
      path.join(productDir, "system", "lib64", "libEGL_angle.so"),
      path.join(productDir, "product", "priv-app", "ANGLE", "ANGLE.apk"),
    ];
    const stagedAngle = angleCandidates.some((candidate) => fs.existsSync(candidate));
    const imageAngle = imageEntryExists(
      path.resolve(productDir, "../../../../"),
      path.join(productDir, "system.img"),
      "/lib64/libEGL_angle.so",
    );
    if (!stagedAngle && !imageAngle) {
      fail(
        "stock ANGLE EGL stance selected but no staged libEGL_angle.so or ANGLE.apk exists; rebuild the AOSP ANGLE component before flashing",
      );
    }
  }
  info(
    `staged renderengine verified: backend=${stagedBackend ?? "(stock)"} graphite=${stagedGraphite} egl=${stamp.eglSelection ?? "(stock angle)"}`,
  );
}

function assertOneFstabStance(fstabPath, stamp, label) {
  const contents = fs.readFileSync(fstabPath, "utf8");
  const userdataLine = contents
    .split("\n")
    .find((line) => /\s\/data\s/.test(line) && !line.trim().startsWith("#"));
  if (!userdataLine) fail(`staged ${label} fstab has no /data entry`);
  const rewritten = /elizaos/i.test(contents);
  if (stamp.conservativeF2fs !== rewritten) {
    fail(
      `staged ${label} fstab stance (rewritten=${rewritten}) does not match prepare stamp (conservativeF2fs=${stamp.conservativeF2fs}); rebuild after re-running prepare-grizzly`,
    );
  }
  if (!stamp.conservativeF2fs) {
    for (const required of ["fileencryption=", "metadata_encryption="]) {
      if (!userdataLine.includes(required)) {
        fail(
          `stock fstab stance selected but staged ${label} /data entry lacks ${required} — the factory encryption contract is broken: ${userdataLine.trim()}`,
        );
      }
    }
  }
}

function assertStagedFstab(productDir, stagedVendorDir, stamp) {
  const fstab = path.join(stagedVendorDir, "etc", "fstab.malibu");
  if (fs.existsSync(fstab)) {
    assertOneFstabStance(fstab, stamp, "vendor");
  } else {
    const imageFstab = readImageEntry(
      path.resolve(productDir, "../../../../"),
      path.join(productDir, "vendor.img"),
      "/etc/fstab.malibu",
    );
    if (imageFstab === null) fail(`staged vendor fstab missing from tree and vendor.img: ${fstab}`);
    const temp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grizzly-fstab-")), "fstab");
    try {
      fs.writeFileSync(temp, imageFstab);
      assertOneFstabStance(temp, stamp, "vendor image");
    } finally {
      fs.rmSync(path.dirname(temp), { recursive: true, force: true });
    }
  }
  // The same fstab ships in vendor_boot's vendor_ramdisk; first-stage init
  // reads that copy, so a stance split between the two partitions is the
  // exact unattributable mount wedge this tool exists to prevent.
  const ramdiskCandidates = [
    path.join(productDir, "vendor_ramdisk", "system", "etc", "fstab.malibu"),
    path.join(productDir, "vendor_ramdisk", "etc", "fstab.malibu"),
    path.join(
      productDir,
      "vendor_ramdisk",
      "first_stage_ramdisk",
      "fstab.malibu",
    ),
  ];
  const stagedRamdiskFstab = ramdiskCandidates.find((candidate) =>
    fs.existsSync(candidate),
  );
  if (stagedRamdiskFstab) {
    assertOneFstabStance(stagedRamdiskFstab, stamp, "vendor_ramdisk");
  } else {
    warn(
      "no staged vendor_ramdisk fstab found to verify; confirm vendor_boot.img carries the same /data stance as vendor.img",
    );
  }
  info(
    `staged fstab stance verified (conservativeF2fs=${stamp.conservativeF2fs})`,
  );
}

function assertStagedProbes(aospRoot, productDir, stagedVendorDir, stamp) {
  const probeRc = path.join(
    stagedVendorDir,
    "etc",
    "init",
    "hw",
    "init.elizaos-debug.rc",
  );
  const staged =
    fs.existsSync(probeRc) ||
    readImageEntry(
      aospRoot,
      path.join(productDir, "vendor.img"),
      "/etc/init/hw/init.elizaos-debug.rc",
    ) !== null;
  if (staged !== stamp.earlyBootProbes) {
    fail(
      `probe init rc staged=${staged} but prepare stamp earlyBootProbes=${stamp.earlyBootProbes}; rebuild after re-running prepare-grizzly`,
    );
  }
  info(`staged bring-up probes verified (enabled=${stamp.earlyBootProbes})`);
}

function assertStagedKeymaster(productDir, stamp) {
  const initPath = path.join(
    productDir,
    "system",
    "etc",
    "init",
    "hw",
    "init.rc",
  );
  const contents = fs.existsSync(initPath)
    ? fs.readFileSync(initPath, "utf8")
    : readImageEntry(
        path.resolve(productDir, "../../../../"),
        path.join(productDir, "system.img"),
        "/etc/init/hw/init.rc",
      );
  if (contents === null) fail(`staged system init.rc missing from tree and system.img: ${initPath}`);
  const nonblocking =
    /# elizaOS: diagnostic non-blocking keymaster notification\n[ \t]*exec_background - system system -- \/system\/bin\/vdc keymaster earlyBootEnded/m.test(
      contents,
    );
  const expected = stamp.keymasterNonblocking === true;
  if (nonblocking !== expected) {
    fail(
      `staged system init keymaster mode=${nonblocking} but prepare stamp says keymasterNonblocking=${expected}; rebuild after re-running prepare-grizzly`,
    );
  }
  if (
    !nonblocking &&
    /exec_background - system system -- \/system\/bin\/vdc keymaster earlyBootEnded/m.test(
      contents,
    )
  ) {
    fail(
      "staged system init.rc uses unmarked exec_background for keymaster; refuse an ambiguous diagnostic image",
    );
  }
  info(`staged keymaster init verified (nonblocking=${nonblocking})`);
}

// 16 KiB page-size kernels refuse to map ELFs whose LOAD segments are aligned
// below 16384. Stock vendor blobs are Google's problem; the binaries WE add
// (Eliza app JNI, inference runtimes) are ours. Uses llvm-readelf from the
// AOSP host toolchain when present.
function checkElfAlignment(aospRoot, stagedProductDir) {
  const readelfCandidates = [
    path.join(
      aospRoot,
      "prebuilts/clang/host/linux-x86/llvm-binutils-stable/llvm-readelf",
    ),
  ];
  const readelf = readelfCandidates.find((candidate) =>
    fs.existsSync(candidate),
  );
  if (!readelf) {
    warn(
      "llvm-readelf not found; skipping 16KiB ELF alignment check — run it manually with system/extras/tools/check_elf_alignment.sh",
    );
    return;
  }
  const targets = [];
  const elizaApp = path.join(stagedProductDir, "system", "priv-app", "Eliza");
  const stack = [elizaApp];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".so")) targets.push(full);
    }
  }
  let misaligned = 0;
  for (const target of targets) {
    let output;
    try {
      output = execFileSync(readelf, ["-l", target], { encoding: "utf8" });
    } catch {
      continue;
    }
    for (const line of output.split("\n")) {
      if (!line.trimStart().startsWith("LOAD")) continue;
      const align = line.trim().split(/\s+/).at(-1);
      const value = Number.parseInt(align, 16);
      if (Number.isFinite(value) && value < 16384) {
        misaligned += 1;
        warn(`ELF LOAD alignment ${align} < 0x4000: ${target}`);
        break;
      }
    }
  }
  if (misaligned > 0) {
    fail(
      `${misaligned} of our shipped ELF(s) are aligned below 16KiB; on a 16KiB-page kernel these fail to load. Rebuild them with -Wl,-z,max-page-size=16384.`,
    );
  }
  info(
    `ELF 16KiB alignment verified for ${targets.length} shipped librarie(s)`,
  );
}

function attest({ aospRoot, out }) {
  if (!aospRoot) fail("attest requires --aosp-root");
  const stamp = readStamp(aospRoot);
  const productDir = productOutDir(aospRoot);
  if (!fs.existsSync(productDir)) {
    fail(`product out dir missing: ${productDir}; build first`);
  }
  const stagedVendorDir = path.join(productDir, "vendor");
  assertStagedRenderEngine(productDir, stagedVendorDir, stamp);
  assertStagedFstab(productDir, stagedVendorDir, stamp);
  assertStagedProbes(aospRoot, productDir, stagedVendorDir, stamp);
  assertStagedKeymaster(productDir, stamp);
  checkElfAlignment(aospRoot, productDir);

  // The conservative-f2fs stance ships inside vendor_boot's vendor_ramdisk;
  // an attestation that omits vendor_boot in that stance cannot prove the
  // first-stage and vendor fstabs agree.
  const requiredImages = stamp.conservativeF2fs
    ? [...REQUIRED_ATTESTED_IMAGES, "vendor_boot.img"]
    : REQUIRED_ATTESTED_IMAGES;
  const missingRequired = requiredImages.filter(
    (name) => !fs.existsSync(path.join(productDir, name)),
  );
  if (missingRequired.length > 0) {
    fail(
      `core images missing from ${productDir}: ${missingRequired.join(", ")} — attesting a partial set is exactly the stale-mix hazard this tool prevents; rebuild first`,
    );
  }

  // An image older than any file staged into it is definitionally stale.
  // (fail-closed: an incremental build that restats a staged file without
  // rebuilding the image reads as stale — rebuild rather than rationalize.)
  for (const [imageName, stagedDir] of [
    ["vendor.img", stagedVendorDir],
    ["system.img", path.join(productDir, "system")],
  ]) {
    if (!fs.existsSync(stagedDir)) continue;
    const imagePath = path.join(productDir, imageName);
    const imageMtime = fs.statSync(imagePath).mtimeMs;
    const newestStaged = newestMtimeUnder(stagedDir);
    if (newestStaged > imageMtime) {
      fail(
        `${imageName} is older than its staged tree (image ${new Date(imageMtime).toISOString()} < staged ${new Date(newestStaged).toISOString()}); rebuild before attesting`,
      );
    }
  }

  const images = {};
  for (const name of [...requiredImages, ...OPTIONAL_ATTESTED_IMAGES]) {
    const imagePath = path.join(productDir, name);
    if (!fs.existsSync(imagePath)) {
      if (!requiredImages.includes(name)) {
        // Chained-vbmeta split and boot-chain packaging vary by board config.
        warn(`optional image absent, not attested: ${name}`);
      }
      continue;
    }
    const stat = fs.statSync(imagePath);
    images[name] = {
      sha256: sha256File(imagePath),
      size: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
    };
    info(`attested ${name} sha256=${images[name].sha256.slice(0, 16)}…`);
  }
  const manifest = {
    schemaVersion: 1,
    device: PRODUCT_DEVICE,
    attestedAt: new Date().toISOString(),
    prepareStamp: stamp,
    images,
  };
  const outPath = out ?? path.join(productDir, "grizzly-artifacts.json");
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  info(`wrote attestation manifest: ${outPath}`);
  info(
    "copy this manifest with the images; on the flash host run the `check` mode before fastboot",
  );
}

function check({ manifest: manifestPath, artifactDir }) {
  if (!manifestPath || !artifactDir) {
    fail("check requires --manifest and --artifact-dir");
  }
  if (!fs.existsSync(manifestPath))
    fail(`manifest does not exist: ${manifestPath}`);
  if (!fs.existsSync(artifactDir) || !fs.statSync(artifactDir).isDirectory()) {
    fail(`artifact dir does not exist or is not a directory: ${artifactDir}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`manifest is not valid JSON: ${error.message}`);
  }
  if (manifest.device !== PRODUCT_DEVICE) {
    fail(`manifest device is ${manifest.device}, expected ${PRODUCT_DEVICE}`);
  }
  const names = Object.keys(manifest.images ?? {});
  if (names.length === 0) fail("manifest attests no images");
  let checked = 0;
  for (const name of names) {
    if (path.basename(name) !== name || !/^[a-z0-9_]+\.img$/.test(name)) {
      fail(`manifest image name is unsafe: ${name}`);
    }
    const expected = manifest.images[name]?.sha256;
    if (!/^[a-f0-9]{64}$/.test(expected ?? "")) {
      fail(`manifest image ${name} has an invalid sha256`);
    }
    const local = path.join(artifactDir, name);
    if (!fs.existsSync(local)) {
      fail(
        `attested image missing from artifact dir: ${name} — flashing a partial set silently mixes build generations`,
      );
    }
    const actual = sha256File(local);
    if (actual !== expected) {
      fail(
        `${name} sha256 mismatch: local ${actual} vs attested ${expected} — this is NOT the attested build`,
      );
    }
    checked += 1;
  }
  // A stray unattested image beside the attested set is exactly the mixed
  // build-generation the installer would happily flash by filename.
  const unattested = fs
    .readdirSync(artifactDir)
    .filter((name) => name.endsWith(".img") && !names.includes(name));
  if (unattested.length > 0) {
    fail(
      `artifact dir contains images the manifest does not attest: ${unattested.join(", ")} — remove them or re-attest; a filename-driven flash would mix build generations`,
    );
  }
  info(
    `verified ${checked} image(s) against attestation from ${manifest.attestedAt}`,
  );
  info(`attested prepare stamp: ${JSON.stringify(manifest.prepareStamp)}`);
  info("images are exactly the attested build; safe to flash");
}

const args = parseArgs(process.argv.slice(2));
if (args.mode === "attest") attest(args);
else check(args);
