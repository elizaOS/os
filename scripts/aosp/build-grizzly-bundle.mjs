#!/usr/bin/env node
/** Build and collect the complete Pixel 11 Pro flash handoff bundle. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertGeneratedVendorTree,
  assertPinnedAospCheckout,
  loadAospLock,
} from "../distro-android/bootstrap-aosp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../..");
const defaultLockPath = path.join(
  repositoryRoot,
  "packages/os/android/pixel11pro.lock.json",
);

export const REQUIRED_GRIZZLY_ARTIFACTS = Object.freeze([
  "boot.img",
  "init_boot.img",
  "dtbo.img",
  "vendor_kernel_boot.img",
  "pvmfw.img",
  "vendor_boot.img",
  "vbmeta.img",
  "system.img",
  "system_dlkm.img",
  "system_ext.img",
  "product.img",
  "vendor.img",
  "vendor_dlkm.img",
  "system_other.img",
  "super_empty.img",
  "android-info.txt",
  "fastboot-info.txt",
]);
export const REQUIRED_APK_PROVENANCE = Object.freeze([
  "assets/agent/android-agent-runtime-provenance.json",
  "META-INF/eliza/aosp-build-provenance.json",
]);

function fail(message) {
  throw new Error(`[grizzly-bundle] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed${
        result.error
          ? `: ${result.error.message}`
          : ` with exit ${result.status}`
      }${result.stderr ? `\n${result.stderr}` : ""}`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

export function sha256File(filename) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filename));
  return hash.digest("hex");
}

export function assertRegularFile(filename, label = filename) {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    fail(`${label} must be a non-empty regular file: ${filename}`);
  }
  return stat;
}

function assertImageFilename(filename, command) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.img$/.test(filename) ||
    path.basename(filename) !== filename
  ) {
    fail(`unsafe image filename ${JSON.stringify(filename)} in ${command}`);
  }
  return filename;
}

export function parseFastbootInfoArtifacts(contents) {
  const artifacts = new Set();
  let version = null;
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/);
    const command = tokens.shift();
    if (command === "version") {
      if (tokens.length !== 1 || !/^\d+(?:\.\d+)?$/.test(tokens[0])) {
        fail(`invalid fastboot-info version line: ${line}`);
      }
      if (version !== null) fail("fastboot-info contains multiple versions");
      version = Number(tokens[0]);
      if (version > 1) {
        fail(`fastboot-info version ${tokens[0]} is newer than supported 1`);
      }
      continue;
    }
    if (command === "flash") {
      const positional = tokens.filter((token) => {
        if (token === "--apply-vbmeta" || token === "--slot-other") {
          return false;
        }
        if (token.startsWith("--")) {
          fail(`unsupported fastboot flash flag ${token} in ${line}`);
        }
        return true;
      });
      if (positional.length < 1 || positional.length > 2) {
        fail(`invalid fastboot flash command: ${line}`);
      }
      const [partition, explicitFilename] = positional;
      artifacts.add(
        assertImageFilename(explicitFilename ?? `${partition}.img`, line),
      );
      continue;
    }
    if (command === "update-super") {
      if (tokens.length !== 0) fail(`invalid update-super command: ${line}`);
      artifacts.add("super_empty.img");
      continue;
    }
    if (command === "reboot") {
      if (tokens.length > 1) fail(`invalid reboot command: ${line}`);
      continue;
    }
    if (command === "if-wipe") {
      if (tokens.length !== 2 || tokens[0] !== "erase") {
        fail(`invalid if-wipe command: ${line}`);
      }
      continue;
    }
    if (command === "erase") {
      if (tokens.length !== 1) fail(`invalid erase command: ${line}`);
      continue;
    }
    fail(`unsupported fastboot-info command: ${line}`);
  }
  if (version === null) fail("fastboot-info is missing its version");
  return [...artifacts];
}

export function assertSafeFlashMetadata({ androidInfo, fastbootInfo }) {
  if (!/^require board=grizzly$/m.test(androidInfo)) {
    fail("android-info.txt must require board=grizzly");
  }
  parseFastbootInfoArtifacts(fastbootInfo);
  const commands = fastbootInfo
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const rebootFastbootIndexes = commands.flatMap((line, index) =>
    line === "reboot fastboot" ? [index] : [],
  );
  const updateSuperIndexes = commands.flatMap((line, index) =>
    line === "update-super" ? [index] : [],
  );
  if (rebootFastbootIndexes.length !== 1 || updateSuperIndexes.length !== 1) {
    fail("fastboot-info must contain one reboot fastboot and one update-super");
  }
  const rebootFastbootIndex = rebootFastbootIndexes[0];
  const updateSuperIndex = updateSuperIndexes[0];
  if (rebootFastbootIndex >= updateSuperIndex) {
    fail("reboot fastboot must precede update-super");
  }
  const dynamicPartitions = new Set([
    "system",
    "system_dlkm",
    "system_ext",
    "product",
    "vendor",
    "vendor_dlkm",
    "system_other",
  ]);
  for (const [index, line] of commands.entries()) {
    const tokens = line.split(/\s+/);
    if (
      tokens[0] === "erase" &&
      (tokens[1] === "userdata" || tokens[1] === "metadata")
    ) {
      fail("fastboot-info must not erase userdata or metadata unconditionally");
    }
    if (tokens[0] !== "flash") continue;
    const positional = tokens
      .slice(1)
      .filter((token) => !token.startsWith("--"));
    if (dynamicPartitions.has(positional[0]) && index < updateSuperIndex) {
      fail(
        `fastboot-info attempts to flash ${positional[0]} before update-super`,
      );
    }
  }
  return { rebootFastbootIndex, updateSuperIndex };
}

export function collectGrizzlyArtifacts({ productOut, bundleDir }) {
  for (const filename of REQUIRED_GRIZZLY_ARTIFACTS) {
    assertRegularFile(
      path.join(productOut, filename),
      `required build artifact ${filename}`,
    );
  }
  const fastbootInfo = path.join(productOut, "fastboot-info.txt");
  const fastbootArtifacts = parseFastbootInfoArtifacts(
    fs.readFileSync(fastbootInfo, "utf8"),
  );
  const filenames = [
    ...new Set([...REQUIRED_GRIZZLY_ARTIFACTS, ...fastbootArtifacts]),
  ];
  const sources = filenames.map((filename) => {
    const source = path.join(productOut, filename);
    return {
      filename,
      source,
      stat: assertRegularFile(source, `required build artifact ${filename}`),
    };
  });

  fs.mkdirSync(bundleDir, { recursive: true });
  if (fs.readdirSync(bundleDir).length > 0) {
    fail(`bundle directory must be empty: ${bundleDir}`);
  }
  return sources.map(({ filename, source, stat }) => {
    const destination = path.join(bundleDir, filename);
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    const copied = assertRegularFile(
      destination,
      `copied artifact ${filename}`,
    );
    const sourceDigest = sha256File(source);
    const destinationDigest = sha256File(destination);
    if (copied.size !== stat.size || destinationDigest !== sourceDigest) {
      fail(`copy verification failed for ${filename}`);
    }
    return { filename, sizeBytes: copied.size, sha256: destinationDigest };
  });
}

export function assertApkProvenanceEntries(entries) {
  const entrySet = new Set(entries);
  const missing = REQUIRED_APK_PROVENANCE.filter(
    (entry) => !entrySet.has(entry),
  );
  if (missing.length > 0) {
    fail(`privileged APK is missing provenance: ${missing.join(", ")}`);
  }
  return [...REQUIRED_APK_PROVENANCE];
}

export function parseArgs(argv) {
  const args = {
    aospRoot: null,
    outputDir: null,
    jobs: Math.max(1, os.cpus().length),
    skipBuild: false,
    lockPath: defaultLockPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith("--")) fail(`${flag} requires a value`);
      return next;
    };
    if (flag === "--aosp-root") args.aospRoot = path.resolve(value());
    else if (flag === "--output-dir") args.outputDir = path.resolve(value());
    else if (flag === "--lock") args.lockPath = path.resolve(value());
    else if (flag === "--jobs") args.jobs = Number(value());
    else if (flag === "--skip-build") args.skipBuild = true;
    else fail(`unknown argument: ${flag}`);
  }
  if (!args.aospRoot) fail("--aosp-root is required");
  if (!args.outputDir) fail("--output-dir is required");
  if (!Number.isSafeInteger(args.jobs) || args.jobs < 1 || args.jobs > 256) {
    fail("--jobs must be an integer from 1 through 256");
  }
  return args;
}

function sourceDate() {
  const value = process.env.SOURCE_DATE_EPOCH;
  if (!value || !/^\d+$/.test(value)) {
    fail("SOURCE_DATE_EPOCH is required for a reproducible bundle timestamp");
  }
  const milliseconds = Number(value) * 1000;
  const date = new Date(milliseconds);
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(date.valueOf())) {
    fail("SOURCE_DATE_EPOCH is out of range");
  }
  return date.toISOString();
}

function cleanGitCommit(root, label) {
  const commit = run("git", ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  });
  const status = run("git", ["status", "--porcelain"], {
    cwd: root,
    capture: true,
  });
  if (status) fail(`${label} checkout is dirty; refusing ambiguous provenance`);
  return commit;
}

function assertOutputOutsideSource(outputDir, sourceRoot, label) {
  const relative = path.relative(sourceRoot, outputDir);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  ) {
    fail(`output directory must be outside the ${label} checkout`);
  }
}

function captureBuilderEnvironment({ aospRoot, outRoot, repoLauncher }) {
  const toolVersions = Object.fromEntries(
    [
      ["git", "git", ["--version"]],
      ["java", "java", ["-version"]],
      ["python", "python3", ["--version"]],
      ["go", "go", ["version"]],
      ["rust", "rustc", ["--version"]],
      ["bun", "bun", ["--version"]],
      ["node", "node", ["--version"]],
      ["adb", "adb", ["version"]],
      ["fastboot", "fastboot", ["--version"]],
      ["repo", repoLauncher, ["version"]],
    ].map(([name, command, args]) => [
      name,
      run(command, args, { capture: true }),
    ]),
  );
  return {
    osRelease: fs.readFileSync("/etc/os-release", "utf8").trim(),
    kernel: run("uname", ["-srvmo"], { capture: true }),
    cpu: {
      logicalCount: os.cpus().length,
      model: os.cpus()[0]?.model ?? "unknown",
    },
    memoryBytes: os.totalmem(),
    buildFilesystem: run(
      "df",
      ["-B1", "--output=source,fstype,size,avail,target", aospRoot],
      { capture: true },
    ),
    limits: run("bash", ["-lc", "ulimit -a"], { capture: true }),
    toolVersions,
    cachePaths: {
      aospRoot,
      outRoot,
      sisoCacheDir: process.env.SISO_CACHE_DIR?.trim() || null,
      remoteBuildCacheDir: process.env.RBE_cache_dir?.trim() || null,
    },
  };
}

function readApkProvenance(apk, entry, elizaCommit) {
  const contents = run("unzip", ["-p", apk, entry], { capture: true });
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    fail(`${entry} is not valid JSON: ${error.message}`);
  }
  if (
    entry === "META-INF/eliza/aosp-build-provenance.json" &&
    parsed.git_revision !== elizaCommit
  ) {
    fail(
      `privileged APK source ${parsed.git_revision ?? "missing"} does not match Eliza ${elizaCommit}`,
    );
  }
  return {
    entry,
    schema: parsed.schema ?? null,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const generatedAt = sourceDate();
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("Pixel 11 Pro bundles require a Linux x86_64 builder");
  }
  const lock = loadAospLock(args.lockPath);
  if (lock.device?.codename !== "grizzly") fail("lock is not for grizzly");
  assertPinnedAospCheckout(args.aospRoot, lock);
  assertGeneratedVendorTree(args.aospRoot, lock);
  const elizaRootValue = process.env.ELIZAOS_ELIZA_ROOT?.trim();
  if (!elizaRootValue) fail("ELIZAOS_ELIZA_ROOT is required");
  const elizaRoot = path.resolve(elizaRootValue);
  assertOutputOutsideSource(args.outputDir, repositoryRoot, "elizaOS/os");
  assertOutputOutsideSource(args.outputDir, elizaRoot, "elizaOS/eliza");
  assertOutputOutsideSource(args.outputDir, args.aospRoot, "AOSP");
  const osCommit = cleanGitCommit(repositoryRoot, "elizaOS/os");
  const elizaCommit = cleanGitCommit(elizaRoot, "elizaOS/eliza");
  fs.mkdirSync(args.outputDir, { recursive: true });
  if (fs.readdirSync(args.outputDir).length > 0) {
    fail(`output directory must be empty: ${args.outputDir}`);
  }

  const configuredOut = process.env.OUT_DIR?.trim() || "out";
  const outRoot = path.isAbsolute(configuredOut)
    ? configuredOut
    : path.resolve(args.aospRoot, configuredOut);
  const productOut = path.join(outRoot, "target/product/grizzly");
  const hostBin = path.join(outRoot, "host/linux-x86/bin");
  const repoLauncher = path.join(args.aospRoot, ".repo/repo/repo");
  assertRegularFile(repoLauncher, "AOSP repo launcher");
  const builderEnvironment = captureBuilderEnvironment({
    aospRoot: args.aospRoot,
    outRoot,
    repoLauncher,
  });
  if (!args.skipBuild) {
    run(
      "bash",
      [
        "-lc",
        `source build/envsetup.sh && lunch eliza_grizzly_phone-trunk_staging-userdebug && m -j${args.jobs} dist host_init_verifier checkvintf`,
      ],
      { cwd: args.aospRoot },
    );
  }

  const apk = path.join(productOut, "system/priv-app/Eliza/Eliza.apk");
  const apkStat = assertRegularFile(apk, "platform privileged Eliza APK");
  const apkEntries = run("unzip", ["-Z1", apk], { capture: true }).split("\n");
  const requiredProvenanceEntries = assertApkProvenanceEntries(apkEntries);
  const apkProvenance = requiredProvenanceEntries.map((entry) =>
    readApkProvenance(apk, entry, elizaCommit),
  );
  const avbtool = path.join(hostBin, "avbtool");
  assertRegularFile(avbtool, "built avbtool");

  const bundleDir = path.join(args.outputDir, "flash");
  const artifacts = collectGrizzlyArtifacts({ productOut, bundleDir });
  const flashMetadata = assertSafeFlashMetadata({
    androidInfo: fs.readFileSync(
      path.join(bundleDir, "android-info.txt"),
      "utf8",
    ),
    fastbootInfo: fs.readFileSync(
      path.join(bundleDir, "fastboot-info.txt"),
      "utf8",
    ),
  });
  const verifiedVbmetaImages = artifacts
    .map(({ filename }) => filename)
    .filter((filename) => /^vbmeta(?:_[A-Za-z0-9._+-]+)?\.img$/.test(filename));
  for (const filename of verifiedVbmetaImages) {
    run(avbtool, ["info_image", "--image", path.join(bundleDir, filename)]);
  }

  const sourceManifest = path.join(args.outputDir, "aosp-source-manifest.xml");
  run(repoLauncher, ["manifest", "-r", "-o", sourceManifest], {
    cwd: args.aospRoot,
  });
  assertRegularFile(sourceManifest, "resolved AOSP source manifest");
  if (
    cleanGitCommit(repositoryRoot, "elizaOS/os") !== osCommit ||
    cleanGitCommit(elizaRoot, "elizaOS/eliza") !== elizaCommit
  ) {
    fail("a source commit changed while the bundle was being produced");
  }
  const buildFingerprintPath = path.join(productOut, "system/build.prop");
  assertRegularFile(buildFingerprintPath, "built system properties");
  const buildFingerprint = fs
    .readFileSync(buildFingerprintPath, "utf8")
    .split("\n")
    .find((line) => line.startsWith("ro.build.fingerprint="))
    ?.slice("ro.build.fingerprint=".length);
  if (!buildFingerprint?.startsWith(lock.device.expectedFingerprintPrefix)) {
    fail("built fingerprint does not match the locked grizzly prefix");
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt,
    target: {
      targetId: lock.device.targetId,
      codename: lock.device.codename,
      productName: lock.device.productName,
      stockBuildId: lock.device.buildId,
      buildFingerprint,
    },
    sources: {
      osCommit,
      elizaCommit,
      lockFile: path.relative(repositoryRoot, args.lockPath),
      lockSha256: sha256File(args.lockPath),
      aospManifest: path.basename(sourceManifest),
      aospManifestSha256: sha256File(sourceManifest),
    },
    privilegedApk: {
      path: "system/priv-app/Eliza/Eliza.apk",
      sizeBytes: apkStat.size,
      sha256: sha256File(apk),
      provenance: apkProvenance,
    },
    builderEnvironment,
    artifacts,
    verification: {
      completedBuildTargets: ["dist", "host_init_verifier", "checkvintf"],
      avbInfoVerified: verifiedVbmetaImages,
      flashMetadata,
      physicalDevice: "pending",
    },
  };
  const manifestPath = path.join(
    args.outputDir,
    "grizzly-bundle-manifest.json",
  );
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  fs.writeFileSync(
    path.join(args.outputDir, "SHA256SUMS"),
    [
      ...artifacts.map(
        ({ filename, sha256 }) => `${sha256}  flash/${filename}`,
      ),
      `${sha256File(sourceManifest)}  ${path.basename(sourceManifest)}`,
      `${sha256File(manifestPath)}  ${path.basename(manifestPath)}`,
      "",
    ].join("\n"),
    { flag: "wx" },
  );
  process.stdout.write(`[grizzly-bundle] complete: ${args.outputDir}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
