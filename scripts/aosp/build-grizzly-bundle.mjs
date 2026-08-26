#!/usr/bin/env node
/** Build and collect a fail-closed Pixel 11 Pro flash handoff bundle. */

import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
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

const REQUIRED_BUILD_RECEIPTS = Object.freeze([
  "host_init_verifier_output.txt",
  "obj/PACKAGING/check_vintf_all_intermediates/check_vintf_compatible.log",
  "obj/PACKAGING/check_vintf_all_intermediates/check_vintf_system.log",
  "obj/PACKAGING/check_vintf_all_intermediates/check_vintf_vendor.log",
]);

export const REQUIRED_APK_PROVENANCE = Object.freeze([
  "assets/agent/android-agent-runtime-provenance.json",
  "META-INF/eliza/aosp-build-provenance.json",
]);

const DYNAMIC_PARTITIONS = Object.freeze([
  "system",
  "system_dlkm",
  "system_ext",
  "product",
  "vendor",
  "vendor_dlkm",
  "system_other",
]);

function fail(message) {
  throw new Error(`[grizzly-bundle] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
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
  const output = options.stdoutOnly
    ? (result.stdout ?? "")
    : `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return options.raw ? output : output.trim();
}

function runWithReceipt(command, args, { cwd, receiptPath }) {
  const descriptor = fs.openSync(
    receiptPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  let result;
  try {
    fs.writeSync(
      descriptor,
      `command=${JSON.stringify([command, ...args])}\nworkingDirectory=${JSON.stringify(cwd)}\n--- output ---\n`,
    );
    result = spawnSync(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", descriptor, descriptor],
    });
    fs.writeSync(
      descriptor,
      `\n--- result ---\nexitStatus=${result.status ?? "none"}\nsignal=${result.signal ?? "none"}\n`,
    );
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed${
        result.error
          ? `: ${result.error.message}`
          : ` with exit ${result.status ?? "none"}`
      }`,
    );
  }
  return {
    filename: path.basename(receiptPath),
    sizeBytes: assertRegularFile(receiptPath, "successful build receipt").size,
    sha256: sha256File(receiptPath),
  };
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readStableFile(filename, { allowEmpty = false } = {}) {
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (!allowEmpty && before.size < 1)
    ) {
      fail(`input must be a private regular file: ${filename}`);
    }
    const contents = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const pathState = fs.lstatSync(filename);
    if (
      contents.length !== before.size ||
      !sameFile(before, after) ||
      !sameFile(before, pathState) ||
      pathState.isSymbolicLink()
    ) {
      fail(`input changed while reading: ${filename}`);
    }
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function sha256File(filename, { allowEmpty = false } = {}) {
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (!allowEmpty && before.size < 1)
    ) {
      fail(`input must be a private regular file: ${filename}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fs.fstatSync(descriptor);
    const pathState = fs.lstatSync(filename);
    if (
      position !== before.size ||
      !sameFile(before, after) ||
      !sameFile(before, pathState) ||
      pathState.isSymbolicLink()
    ) {
      fail(`input changed while hashing: ${filename}`);
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function assertRegularFile(
  filename,
  label = filename,
  allowEmpty = false,
) {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (!allowEmpty && stat.size < 1)
  ) {
    fail(
      `${label} must be a private ${allowEmpty ? "" : "non-empty "}regular file: ${filename}`,
    );
  }
  return stat;
}

function copyVerifiedFile(source, destination, label) {
  const sourceDescriptor = fs.openSync(
    source,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  let destinationDescriptor;
  try {
    const before = fs.fstatSync(sourceDescriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1) {
      fail(`${label} is not a private non-empty regular file`);
    }
    destinationDescriptor = fs.openSync(
      destination,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o644,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const bytesRead = fs.readSync(
        sourceDescriptor,
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(
          destinationDescriptor,
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    fs.fsyncSync(destinationDescriptor);
    const sourceAfter = fs.fstatSync(sourceDescriptor);
    const sourcePathState = fs.lstatSync(source);
    const destinationState = fs.fstatSync(destinationDescriptor);
    const destinationPathState = fs.lstatSync(destination);
    if (
      position !== before.size ||
      !sameFile(before, sourceAfter) ||
      !sameFile(before, sourcePathState) ||
      destinationState.size !== before.size ||
      !sameFile(destinationState, destinationPathState)
    ) {
      fail(`${label} changed or was replaced while copying`);
    }
    return { sizeBytes: before.size, sha256: hash.digest("hex") };
  } finally {
    if (destinationDescriptor !== undefined)
      fs.closeSync(destinationDescriptor);
    fs.closeSync(sourceDescriptor);
  }
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
  const commands = [];
  let version = null;
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/);
    const command = tokens.shift();
    commands.push({ command, line, tokens: [...tokens] });
    if (command === "version") {
      if (tokens.length !== 1 || tokens[0] !== "1" || version !== null) {
        fail(
          `fastboot-info must contain exactly one supported version 1 line: ${line}`,
        );
      }
      version = 1;
      continue;
    }
    if (command === "flash") {
      const flags = tokens.filter((token) => token.startsWith("--"));
      if (new Set(flags).size !== flags.length) {
        fail(`duplicate fastboot flash flag in ${line}`);
      }
      const positional = tokens.filter((token) => {
        if (token === "--apply-vbmeta" || token === "--slot-other")
          return false;
        if (token.startsWith("--")) {
          fail(`unsupported fastboot flash flag ${token} in ${line}`);
        }
        return true;
      });
      if (positional.length < 1 || positional.length > 2) {
        fail(`invalid fastboot flash command: ${line}`);
      }
      const [partition, explicitFilename] = positional;
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(partition)) {
        fail(`unsafe partition ${JSON.stringify(partition)} in ${line}`);
      }
      const filename = assertImageFilename(
        explicitFilename ?? `${partition}.img`,
        line,
      );
      artifacts.add(filename);
      Object.assign(commands.at(-1), { partition, filename, flags });
      continue;
    }
    if (command === "update-super") {
      if (tokens.length !== 0) fail(`invalid update-super command: ${line}`);
      artifacts.add("super_empty.img");
      continue;
    }
    if (command === "reboot") {
      if (
        tokens.length > 1 ||
        (tokens.length === 1 && tokens[0] !== "fastboot")
      ) {
        fail(`invalid reboot command: ${line}`);
      }
      continue;
    }
    if (command === "if-wipe") {
      if (
        tokens.length !== 2 ||
        tokens[0] !== "erase" ||
        !["cache", "userdata", "metadata"].includes(tokens[1])
      ) {
        fail(`invalid if-wipe command: ${line}`);
      }
      continue;
    }
    if (command === "erase") {
      if (
        tokens.length !== 1 ||
        !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(tokens[0])
      ) {
        fail(`invalid erase command: ${line}`);
      }
      continue;
    }
    fail(`unsupported fastboot-info command: ${line}`);
  }
  if (version === null) fail("fastboot-info is missing its version");
  if (commands[0]?.command !== "version") {
    fail("fastboot-info version must be its first command");
  }
  return { artifacts: [...artifacts], commands };
}

export function assertSafeFlashMetadata({ androidInfo, fastbootInfo }) {
  const boardRequirements = androidInfo
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("require board="));
  if (
    boardRequirements.length !== 1 ||
    boardRequirements[0] !== "require board=grizzly"
  ) {
    fail(
      "android-info.txt must contain exactly one require board=grizzly constraint",
    );
  }
  const { artifacts, commands } = parseFastbootInfoArtifacts(fastbootInfo);
  for (const filename of REQUIRED_GRIZZLY_ARTIFACTS.filter((entry) =>
    entry.endsWith(".img"),
  )) {
    if (!artifacts.includes(filename)) {
      fail(
        `fastboot-info does not reference required flash artifact ${filename}`,
      );
    }
  }
  const rebootFastbootIndexes = commands.flatMap(
    ({ command, tokens }, index) =>
      command === "reboot" && tokens.length === 1 && tokens[0] === "fastboot"
        ? [index]
        : [],
  );
  const updateSuperIndexes = commands.flatMap(({ command }, index) =>
    command === "update-super" ? [index] : [],
  );
  if (rebootFastbootIndexes.length !== 1 || updateSuperIndexes.length !== 1) {
    fail("fastboot-info must contain one reboot fastboot and one update-super");
  }
  const rebootFastbootIndex = rebootFastbootIndexes[0];
  const updateSuperIndex = updateSuperIndexes[0];
  if (rebootFastbootIndex >= updateSuperIndex) {
    fail("reboot fastboot must precede update-super");
  }
  const flashedDynamicPartitions = new Set();
  const flashedPartitions = new Set();
  for (const [index, commandEntry] of commands.entries()) {
    const { command, tokens } = commandEntry;
    if (command === "erase" && ["userdata", "metadata"].includes(tokens[0])) {
      fail("fastboot-info must not erase userdata or metadata unconditionally");
    }
    if (command !== "flash") continue;
    const { partition, filename, flags } = commandEntry;
    let logicalPartition = partition;
    if (flags.includes("--slot-other")) {
      if (partition !== "system" || filename !== "system_other.img") {
        fail(
          `fastboot-info contains an unsupported --slot-other flash: ${commandEntry.line}`,
        );
      }
      logicalPartition = "system_other";
    }
    if (
      filename !== `${logicalPartition}.img` ||
      (flags.includes("--apply-vbmeta") && logicalPartition !== "vbmeta")
    ) {
      fail(
        `fastboot-info contains an unsafe flash mapping: ${commandEntry.line}`,
      );
    }
    if (flashedPartitions.has(logicalPartition)) {
      fail(
        `fastboot-info flashes partition ${logicalPartition} more than once`,
      );
    }
    flashedPartitions.add(logicalPartition);
    const isBootChainPartition =
      [
        "boot",
        "init_boot",
        "dtbo",
        "vendor_kernel_boot",
        "pvmfw",
        "vendor_boot",
      ].includes(logicalPartition) ||
      /^vbmeta(?:_[A-Za-z0-9._+-]+)?$/.test(logicalPartition);
    if (
      !isBootChainPartition &&
      !DYNAMIC_PARTITIONS.includes(logicalPartition)
    ) {
      fail(`fastboot-info flashes unsupported partition ${logicalPartition}`);
    }
    if (isBootChainPartition && index >= rebootFastbootIndex) {
      fail(
        `fastboot-info flashes boot-chain partition ${logicalPartition} after entering fastbootd`,
      );
    }
    if (DYNAMIC_PARTITIONS.includes(logicalPartition)) {
      if (index < updateSuperIndex) {
        fail(
          `fastboot-info attempts to flash ${logicalPartition} before update-super`,
        );
      }
      flashedDynamicPartitions.add(logicalPartition);
    }
  }
  for (const partition of DYNAMIC_PARTITIONS) {
    if (!flashedDynamicPartitions.has(partition)) {
      fail(
        `fastboot-info does not flash required dynamic partition ${partition}`,
      );
    }
  }
  return { artifacts, rebootFastbootIndex, updateSuperIndex };
}

export function assertApkProvenanceEntries(entries) {
  const missing = REQUIRED_APK_PROVENANCE.filter(
    (required) => entries.filter((entry) => entry === required).length !== 1,
  );
  if (missing.length > 0) {
    fail(
      `privileged APK must contain each provenance entry exactly once: ${missing.join(", ")}`,
    );
  }
  return [...REQUIRED_APK_PROVENANCE];
}

export function collectGrizzlyArtifacts({ productOut, bundleDir }) {
  for (const filename of REQUIRED_GRIZZLY_ARTIFACTS) {
    assertRegularFile(
      path.join(productOut, filename),
      `required build artifact ${filename}`,
    );
  }
  const fastbootInfo = readStableFile(
    path.join(productOut, "fastboot-info.txt"),
  ).toString("utf8");
  const { artifacts: referencedArtifacts } =
    parseFastbootInfoArtifacts(fastbootInfo);
  const filenames = [
    ...new Set([...REQUIRED_GRIZZLY_ARTIFACTS, ...referencedArtifacts]),
  ];
  fs.mkdirSync(bundleDir, { recursive: false, mode: 0o700 });
  return filenames.map((filename) => {
    const source = path.join(productOut, filename);
    assertRegularFile(source, `required build artifact ${filename}`);
    const destination = path.join(bundleDir, filename);
    const evidence = copyVerifiedFile(
      source,
      destination,
      `required build artifact ${filename}`,
    );
    return { filename, ...evidence };
  });
}

export function parseArgs(argv) {
  const args = {
    aospRoot: null,
    outputDir: null,
    jobs: Math.max(1, os.cpus().length),
    preflightOnly: false,
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
    else if (flag === "--preflight-only") args.preflightOnly = true;
    else fail(`unknown argument: ${flag}`);
  }
  if (!args.aospRoot) fail("--aosp-root is required");
  if (!args.preflightOnly && !args.outputDir) fail("--output-dir is required");
  if (!Number.isSafeInteger(args.jobs) || args.jobs < 1 || args.jobs > 256) {
    fail("--jobs must be an integer from 1 through 256");
  }
  return args;
}

function physicalCoreCount() {
  const output = run("lscpu", ["-p=CORE,SOCKET"], { capture: true });
  return new Set(
    output
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.trim()),
  ).size;
}

export function assertBuilderCapacity({
  platform,
  architecture,
  physicalCores,
  memoryBytes,
  totalBytes,
  freeBytes,
}) {
  if (platform !== "linux" || architecture !== "x64") {
    fail("Pixel 11 Pro bundles require a Linux x86_64 builder");
  }
  if (physicalCores < 32 || memoryBytes < 128 * 1024 ** 3) {
    fail(
      `dedicated builder is undersized: ${physicalCores} physical cores/${Math.floor(memoryBytes / 1024 ** 3)} GiB RAM; require 32/128`,
    );
  }
  if (totalBytes < 1_500_000_000_000 || freeBytes < 600 * 1024 ** 3) {
    fail(
      `dedicated builder storage is undersized: ${Math.floor(totalBytes / 1_000_000_000)} GB total/${Math.floor(freeBytes / 1024 ** 3)} GiB free; require 1500 GB/600 GiB`,
    );
  }
  return { physicalCores, memoryBytes, totalBytes, freeBytes };
}

export function assertDedicatedBuilder(aospRoot) {
  if (!fs.existsSync(aospRoot)) fail(`AOSP root does not exist: ${aospRoot}`);
  const filesystem = fs.statfsSync(aospRoot);
  return assertBuilderCapacity({
    platform: process.platform,
    architecture: process.arch,
    physicalCores: physicalCoreCount(),
    memoryBytes: os.totalmem(),
    totalBytes: filesystem.blocks * filesystem.bsize,
    freeBytes: filesystem.bavail * filesystem.bsize,
  });
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
  const status = run("git", ["status", "--porcelain=v1"], {
    cwd: root,
    capture: true,
  });
  if (status) fail(`${label} checkout is dirty; refusing ambiguous provenance`);
  return commit;
}

function assertOutputOutsideSource(outputDir, sourceRoot, label) {
  const canonicalSource = fs.realpathSync(sourceRoot);
  const canonicalParent = fs.realpathSync(path.dirname(outputDir));
  const canonicalOutput = path.join(canonicalParent, path.basename(outputDir));
  const relative = path.relative(canonicalSource, canonicalOutput);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  ) {
    fail(`output directory must be outside the ${label} checkout`);
  }
}

function captureBuilderEnvironment({ aospRoot, outRoot, builder }) {
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
    ].map(([name, command, args]) => [
      name,
      run(command, args, { capture: true }),
    ]),
  );
  return {
    ...builder,
    osRelease: fs.readFileSync("/etc/os-release", "utf8").trim(),
    kernel: run("uname", ["-srvmo"], { capture: true }),
    cpu: {
      logicalCount: os.cpus().length,
      model: os.cpus()[0]?.model ?? "unknown",
    },
    buildFilesystem: run(
      "df",
      ["-B1", "--output=source,fstype,size,avail,target", aospRoot],
      { capture: true },
    ),
    storageDevices: run(
      "lsblk",
      ["-b", "-o", "NAME,MODEL,SERIAL,SIZE,ROTA,TYPE,FSTYPE,MOUNTPOINTS"],
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

function readApkProvenance(apk, entry) {
  const contents = run("unzip", ["-p", apk, entry], {
    capture: true,
    raw: true,
    stdoutOnly: true,
  });
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    fail(`${entry} is not valid JSON: ${error.message}`);
  }
  return {
    entry,
    parsed,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function extractApkEntryEvidence(apk, entry, destination) {
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  let result;
  try {
    result = spawnSync("unzip", ["-p", apk, entry], {
      encoding: "utf8",
      stdio: ["ignore", descriptor, "pipe"],
    });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (result.error || result.status !== 0) {
    fail(`could not extract APK provenance input ${entry}`);
  }
  const stat = assertRegularFile(
    destination,
    `extracted APK entry ${entry}`,
    true,
  );
  return {
    sizeBytes: stat.size,
    sha256: sha256File(destination, { allowEmpty: true }),
  };
}

function verifyApkProvenance(apk, apkEntries, elizaCommit, scratchDir) {
  const [runtime, build] = REQUIRED_APK_PROVENANCE.map((entry) =>
    readApkProvenance(apk, entry),
  );
  if (runtime.parsed?.schema !== "eliza.android_agent_runtime_provenance.v1") {
    fail("privileged APK runtime provenance has an unsupported schema");
  }
  if (
    build.parsed?.schema !== "eliza.aosp_build_provenance.v1" ||
    build.parsed.git_revision !== elizaCommit ||
    build.parsed.android_package !== "ai.elizaos.app" ||
    build.parsed.runtime_provenance_entry !== runtime.entry ||
    build.parsed.runtime_provenance_sha256 !== runtime.sha256 ||
    !identicalSnapshot(build.parsed.runtime_provenance, runtime.parsed)
  ) {
    fail(
      "privileged APK build provenance does not bind the Eliza commit, package, and embedded runtime provenance",
    );
  }
  if (
    !Array.isArray(runtime.parsed.files) ||
    runtime.parsed.files.length === 0 ||
    runtime.parsed.files.length > 10_000
  ) {
    fail("privileged APK runtime provenance must contain a bounded file set");
  }
  const seen = new Set();
  for (const [index, file] of runtime.parsed.files.entries()) {
    if (
      typeof file?.path !== "string" ||
      path.posix.normalize(file.path) !== file.path ||
      file.path.startsWith("/") ||
      (!file.path.startsWith("assets/agent/") &&
        !file.path.startsWith("lib/")) ||
      !Number.isSafeInteger(file.size_bytes) ||
      file.size_bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256 ?? "") ||
      seen.has(file.path) ||
      apkEntries.filter((entry) => entry === file.path).length !== 1
    ) {
      fail("privileged APK runtime provenance contains an invalid file entry");
    }
    seen.add(file.path);
    const extracted = path.join(scratchDir, `.apk-provenance-entry-${index}`);
    try {
      const evidence = extractApkEntryEvidence(apk, file.path, extracted);
      if (
        evidence.sizeBytes !== file.size_bytes ||
        evidence.sha256 !== file.sha256
      ) {
        fail(
          `privileged APK runtime file does not match provenance: ${file.path}`,
        );
      }
    } finally {
      fs.rmSync(extracted, { force: true });
    }
  }
  return [runtime, build].map(({ entry, parsed, sha256 }) => ({
    entry,
    schema: parsed.schema,
    sha256,
  }));
}

function certificateSha256(pemPath) {
  return new X509Certificate(readStableFile(pemPath)).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
}

function apkSignerSha256(receipt) {
  const matches = [
    ...receipt.matchAll(
      /Signer #\d+ certificate SHA-256 digest:\s*([a-fA-F0-9]{64})/g,
    ),
  ];
  if (matches.length !== 1) {
    fail("apksigner must report exactly one signing certificate");
  }
  return matches[0][1].toLowerCase();
}

function artifactSourceSnapshot(productOut, filenames) {
  return Object.fromEntries(
    filenames.map((filename) => {
      const source = path.join(productOut, filename);
      const stat = assertRegularFile(source, `build artifact ${filename}`);
      return [filename, { sizeBytes: stat.size, sha256: sha256File(source) }];
    }),
  );
}

function hashDirectoryTree(root, allowedRoot = root) {
  const canonicalAllowedRoot = fs.realpathSync(allowedRoot);
  const hash = createHash("sha256");
  const visit = (directory, prefix = "") => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      if (entry.name === ".git") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        hash.update(`d ${relative}\0`);
        visit(absolute, relative);
      } else if (stat.isFile()) {
        hash.update(
          `f ${relative} ${stat.mode & 0o777}\0${sha256File(absolute)}\0`,
        );
      } else if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(absolute);
        const targetRelative = path.relative(canonicalAllowedRoot, target);
        if (
          targetRelative === ".." ||
          targetRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(targetRelative)
        ) {
          fail(`source-tree symlink escapes the AOSP checkout: ${absolute}`);
        }
        hash.update(
          `l ${relative}\0${fs.readlinkSync(absolute)}\0${targetRelative}\0`,
        );
      } else {
        fail(`unsupported source-tree entry: ${absolute}`);
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function assertLockedOverlays(aospRoot, lock) {
  for (const overlay of lock.sourceOverlays ?? []) {
    const actual = sha256File(path.join(aospRoot, overlay.path));
    if (actual !== overlay.sha256) {
      fail(`locked source overlay drifted: ${overlay.path}`);
    }
  }
}

function parseProjectList(aospRoot, lock) {
  const projectListPath = path.join(aospRoot, ".repo/project.list");
  const listed = readStableFile(projectListPath)
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  const unique = new Set();
  for (const projectPath of listed) {
    if (
      path.isAbsolute(projectPath) ||
      projectPath === ".." ||
      projectPath.startsWith("../") ||
      projectPath.includes("\\") ||
      path.posix.normalize(projectPath) !== projectPath ||
      unique.has(projectPath)
    ) {
      fail(
        `AOSP project list contains an unsafe or duplicate path: ${projectPath}`,
      );
    }
    unique.add(projectPath);
  }
  for (const { path: projectPath } of lock.externalProjects ?? []) {
    if (
      path.isAbsolute(projectPath) ||
      projectPath === ".." ||
      projectPath.startsWith("../") ||
      projectPath.includes("\\") ||
      path.posix.normalize(projectPath) !== projectPath
    ) {
      fail(`AOSP external project has an unsafe path: ${projectPath}`);
    }
    unique.add(projectPath);
  }
  return [...unique].sort((left, right) => left.localeCompare(right, "en"));
}

function parseProjectStatus(projectPath, status, allowedPaths) {
  const records = status.split("\0");
  const result = [];
  for (let index = 0; index < records.length - 1; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== " ") {
      fail(`git reported malformed status for AOSP project ${projectPath}`);
    }
    const code = record.slice(0, 2);
    if (code.includes("R") || code.includes("C")) {
      fail(`AOSP project contains an unsupported rename/copy: ${projectPath}`);
    }
    const relativePath = record.slice(3);
    const repositoryPath = path.posix.normalize(
      path.posix.join(projectPath, relativePath),
    );
    if (
      path.isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      repositoryPath === ".." ||
      repositoryPath.startsWith("../") ||
      !allowedPaths.has(repositoryPath)
    ) {
      fail(`AOSP project contains an unlocked modification: ${repositoryPath}`);
    }
    result.push(`${code} ${repositoryPath}`);
  }
  return result;
}

function aospProjectSnapshot(aospRoot, lock) {
  const allowedPaths = new Set(
    (lock.sourceOverlays ?? []).map(({ path: overlayPath }) =>
      path.posix.normalize(overlayPath),
    ),
  );
  return parseProjectList(aospRoot, lock).map((projectPath) => {
    const projectRoot = path.join(aospRoot, projectPath);
    if (fs.realpathSync(projectRoot) !== projectRoot) {
      fail(`AOSP project path is not canonical: ${projectPath}`);
    }
    const topLevel = run("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectRoot,
      capture: true,
    });
    if (fs.realpathSync(topLevel) !== projectRoot) {
      fail(`AOSP project is not rooted at its declared path: ${projectPath}`);
    }
    const commit = run("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      capture: true,
    });
    const remotes = run("git", ["remote"], {
      cwd: projectRoot,
      capture: true,
    })
      .split("\n")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((name) => ({
        name,
        url: run("git", ["remote", "get-url", name], {
          cwd: projectRoot,
          capture: true,
        }),
      }));
    if (remotes.length === 0) {
      fail(`AOSP project has no recorded source remote: ${projectPath}`);
    }
    const status = run(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      {
        cwd: path.join(aospRoot, projectPath),
        capture: true,
        raw: true,
      },
    );
    return {
      path: projectPath,
      commit,
      remotes,
      status: parseProjectStatus(projectPath, status, allowedPaths),
    };
  });
}

function sourceSnapshot({ aospRoot, elizaRoot, lock, lockPath }) {
  assertPinnedAospCheckout(aospRoot, lock);
  assertGeneratedVendorTree(aospRoot, lock);
  assertLockedOverlays(aospRoot, lock);
  return {
    osCommit: cleanGitCommit(repositoryRoot, "elizaOS/os"),
    elizaCommit: cleanGitCommit(elizaRoot, "elizaOS/eliza"),
    lockSha256: sha256File(lockPath),
    manifestCommit: cleanGitCommit(
      path.join(aospRoot, ".repo/manifests"),
      "AOSP manifest",
    ),
    repoImplementationCommit: cleanGitCommit(
      path.join(aospRoot, ".repo/repo"),
      "repo implementation",
    ),
    aospProjects: aospProjectSnapshot(aospRoot, lock),
    generatedVendorSha256: hashDirectoryTree(
      path.join(aospRoot, "vendor/google_devices/grizzly"),
      aospRoot,
    ),
    elizaVendorSha256: hashDirectoryTree(
      path.join(aospRoot, "vendor/eliza"),
      aospRoot,
    ),
  };
}

function identicalSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function trustedOutputParent(outputDir) {
  if (fs.existsSync(outputDir)) {
    fail(`output directory must not already exist: ${outputDir}`);
  }
  const parent = path.dirname(outputDir);
  if (fs.realpathSync(parent) !== parent) {
    fail("output parent path must be canonical and contain no symlink aliases");
  }
  const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (
    !parentStat?.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.uid !== process.geteuid() ||
    (parentStat.mode & 0o22) !== 0
  ) {
    fail(
      "output parent must be signer-owned, non-symlink, and non-group/world-writable",
    );
  }
  return parent;
}

export function assertBundleOutputLocation({ outputDir, sourceRoots }) {
  const outputParent = trustedOutputParent(outputDir);
  for (const [sourceRoot, label] of sourceRoots) {
    assertOutputOutsideSource(outputDir, sourceRoot, label);
  }
  return outputParent;
}

function collectProductValidationReceipts(productOut, evidenceDir) {
  return REQUIRED_BUILD_RECEIPTS.map((relativePath) => {
    const source = path.join(productOut, relativePath);
    const stat = assertRegularFile(
      source,
      `AOSP verification receipt ${relativePath}`,
      true,
    );
    const filename = relativePath.replaceAll("/", "__");
    const destination = path.join(evidenceDir, filename);
    if (stat.size === 0) {
      writeExclusiveFile(destination, "");
      return {
        filename,
        sizeBytes: 0,
        sha256: createHash("sha256").digest("hex"),
      };
    }
    return {
      filename,
      ...copyVerifiedFile(source, destination, relativePath),
    };
  });
}

function runRequiredBuildGates({ aospRoot, jobs, evidenceDir }) {
  const shellPrefix =
    "source build/envsetup.sh && lunch eliza_grizzly_phone-trunk_staging-userdebug";
  const gates = [
    ["droidcore", "droidcore"],
    ["dist", "dist"],
    ["host-init-verifier", "host_init_verifier"],
    ["check-vintf-all", "check-vintf-all"],
    ["host-tools", "apksigner aapt2 avbtool"],
  ];
  return gates.map(([name, targets]) =>
    runWithReceipt(
      "bash",
      ["-lc", `${shellPrefix} && m -j${jobs} ${targets}`],
      {
        cwd: aospRoot,
        receiptPath: path.join(evidenceDir, `build-${name}.log`),
      },
    ),
  );
}

function toolSnapshot(tools) {
  return Object.fromEntries(
    tools.map(([tool, label]) => {
      const stat = assertRegularFile(tool, label);
      return [
        label,
        { path: tool, sizeBytes: stat.size, sha256: sha256File(tool) },
      ];
    }),
  );
}

function writeExclusiveFile(filename, contents) {
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o644,
  );
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    const descriptorState = fs.fstatSync(descriptor);
    const pathState = fs.lstatSync(filename);
    if (
      !descriptorState.isFile() ||
      descriptorState.nlink !== 1 ||
      !sameFile(descriptorState, pathState)
    ) {
      fail(`staged output was replaced while writing: ${filename}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPrivateBundleTree(root) {
  const visit = (directory) => {
    const directoryState = fs.lstatSync(directory);
    if (
      !directoryState.isDirectory() ||
      directoryState.isSymbolicLink() ||
      directoryState.uid !== process.geteuid() ||
      (directoryState.mode & 0o077) !== 0
    ) {
      fail(`bundle staging directory is not private: ${directory}`);
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const state = fs.lstatSync(absolute);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(absolute);
      } else if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        state.uid !== process.geteuid() ||
        state.nlink !== 1
      ) {
        fail(`bundle contains an unsafe entry: ${absolute}`);
      }
    }
    const descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
    try {
      if (!sameInode(directoryState, fs.fstatSync(descriptor))) {
        fail(`bundle staging directory changed while syncing: ${directory}`);
      }
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  };
  visit(root);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const builder = assertDedicatedBuilder(args.aospRoot);
  if (args.preflightOnly) {
    process.stdout.write(
      `[grizzly-bundle] builder preflight passed: ${JSON.stringify(builder)}\n`,
    );
    return;
  }
  const generatedAt = sourceDate();
  const lockBytes = readStableFile(args.lockPath);
  const lock = loadAospLock(args.lockPath);
  let stableLock;
  try {
    stableLock = JSON.parse(lockBytes);
  } catch (error) {
    fail(`grizzly source lock is not valid JSON: ${error.message}`);
  }
  if (!identicalSnapshot(lock, stableLock)) {
    fail("grizzly source lock changed while it was being loaded");
  }
  if (lock.device?.codename !== "grizzly") fail("lock is not for grizzly");
  const lockRelativePath = path.relative(repositoryRoot, args.lockPath);
  if (
    !lockRelativePath ||
    lockRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(lockRelativePath)
  ) {
    fail("the grizzly lock must be a file in the clean elizaOS/os checkout");
  }
  const elizaRootValue = process.env.ELIZAOS_ELIZA_ROOT?.trim();
  if (!elizaRootValue) fail("ELIZAOS_ELIZA_ROOT is required");
  const elizaRoot = path.resolve(elizaRootValue);
  if (fs.realpathSync(args.aospRoot) !== args.aospRoot) {
    fail("AOSP root must be a canonical path without symlink aliases");
  }
  if (fs.realpathSync(elizaRoot) !== elizaRoot) {
    fail("elizaOS/eliza root must be a canonical path without symlink aliases");
  }
  const configuredOut = process.env.OUT_DIR?.trim() || "out";
  const outRoot = path.isAbsolute(configuredOut)
    ? configuredOut
    : path.resolve(args.aospRoot, configuredOut);
  const productOut = path.join(outRoot, "target/product/grizzly");
  const hostBin = path.join(outRoot, "host/linux-x86/bin");
  const outputParent = assertBundleOutputLocation({
    outputDir: args.outputDir,
    sourceRoots: [
      [repositoryRoot, "elizaOS/os"],
      [elizaRoot, "elizaOS/eliza"],
      [args.aospRoot, "AOSP"],
    ],
  });
  const before = sourceSnapshot({
    aospRoot: args.aospRoot,
    elizaRoot,
    lock,
    lockPath: args.lockPath,
  });
  const builderEnvironment = captureBuilderEnvironment({
    aospRoot: args.aospRoot,
    outRoot,
    builder,
  });
  const staging = fs.mkdtempSync(path.join(outputParent, ".grizzly-bundle-"));
  fs.chmodSync(staging, 0o700);
  let published = false;
  let renamed = false;
  const stagingState = fs.lstatSync(staging);
  try {
    const evidenceDir = path.join(staging, "host-validation");
    fs.mkdirSync(evidenceDir, { mode: 0o700 });
    const buildGateReceipts = runRequiredBuildGates({
      aospRoot: args.aospRoot,
      jobs: args.jobs,
      evidenceDir,
    });

    const apk = path.join(productOut, "system/priv-app/Eliza/Eliza.apk");
    const stagedApk = path.join(evidenceDir, "Eliza.apk");
    const apkBefore = copyVerifiedFile(
      apk,
      stagedApk,
      "platform privileged Eliza APK",
    );
    const avbtool = path.join(hostBin, "avbtool");
    const apksigner = path.join(hostBin, "apksigner");
    const aapt2 = path.join(hostBin, "aapt2");
    const verificationTools = [
      [avbtool, "built avbtool"],
      [apksigner, "built apksigner"],
      [aapt2, "built aapt2"],
    ];
    const toolsBefore = toolSnapshot(verificationTools);
    const apkEntries = run("unzip", ["-Z1", stagedApk], {
      capture: true,
      stdoutOnly: true,
    }).split("\n");
    assertApkProvenanceEntries(apkEntries);
    const apkProvenance = verifyApkProvenance(
      stagedApk,
      apkEntries,
      before.elizaCommit,
      evidenceDir,
    );
    const apkSignatureReceipt = run(
      apksigner,
      ["verify", "--verbose", "--print-certs", stagedApk],
      { capture: true },
    );
    const apkBadgingReceipt = run(aapt2, ["dump", "badging", stagedApk], {
      capture: true,
    });
    if (!apkBadgingReceipt.includes("package: name='ai.elizaos.app'")) {
      fail("privileged APK package name is not ai.elizaos.app");
    }
    const platformCertificate = path.join(
      args.aospRoot,
      "build/make/target/product/security/platform.x509.pem",
    );
    const expectedPlatformCertificateSha256 =
      certificateSha256(platformCertificate);
    const apkCertificateSha256 = apkSignerSha256(apkSignatureReceipt);
    if (apkCertificateSha256 !== expectedPlatformCertificateSha256) {
      fail(
        "privileged APK is not signed by the checked-out AOSP platform certificate",
      );
    }
    const apkAfter = {
      sizeBytes: assertRegularFile(stagedApk, "staged privileged Eliza APK")
        .size,
      sha256: sha256File(stagedApk),
    };
    if (!identicalSnapshot(apkBefore, apkAfter)) {
      fail("privileged APK changed while provenance was being verified");
    }

    const androidInfo = readStableFile(
      path.join(productOut, "android-info.txt"),
    ).toString("utf8");
    const fastbootInfo = readStableFile(
      path.join(productOut, "fastboot-info.txt"),
    ).toString("utf8");
    const flashMetadata = assertSafeFlashMetadata({
      androidInfo,
      fastbootInfo,
    });
    const artifactFilenames = [
      ...new Set([...REQUIRED_GRIZZLY_ARTIFACTS, ...flashMetadata.artifacts]),
    ];
    const artifactsBefore = artifactSourceSnapshot(
      productOut,
      artifactFilenames,
    );
    const verifiedVbmetaImages = artifactFilenames.filter((filename) =>
      /^vbmeta(?:_[A-Za-z0-9._+-]+)?\.img$/.test(filename),
    );
    const sourceManifest = path.join(staging, "aosp-source-snapshot.json");
    writeExclusiveFile(sourceManifest, `${JSON.stringify(before, null, 2)}\n`);
    const artifacts = collectGrizzlyArtifacts({
      productOut,
      bundleDir: path.join(staging, "flash"),
    });
    if (
      !identicalSnapshot(
        artifactsBefore,
        artifactSourceSnapshot(productOut, artifactFilenames),
      )
    ) {
      fail("build artifacts changed while the bundle was being collected");
    }
    const avbReceipts = Object.fromEntries(
      verifiedVbmetaImages.map((filename) => [
        filename,
        [
          "## info_image",
          run(
            avbtool,
            ["info_image", "--image", path.join(staging, "flash", filename)],
            { capture: true },
          ),
          "## verify_image",
          run(
            avbtool,
            [
              "verify_image",
              "--image",
              path.join(staging, "flash", filename),
              ...(filename === "vbmeta.img"
                ? ["--follow_chain_partitions"]
                : []),
            ],
            { capture: true },
          ),
        ].join("\n"),
      ]),
    );
    const productValidationReceipts = collectProductValidationReceipts(
      productOut,
      evidenceDir,
    );
    writeExclusiveFile(
      path.join(staging, "host-validation/avbtool-vbmeta.txt"),
      `${Object.entries(avbReceipts)
        .map(([filename, receipt]) => `## ${filename}\n${receipt}`)
        .join("\n\n")}\n`,
    );
    writeExclusiveFile(
      path.join(staging, "host-validation/apksigner.txt"),
      `${apkSignatureReceipt}\n`,
    );
    writeExclusiveFile(
      path.join(staging, "host-validation/aapt2-badging.txt"),
      `${apkBadgingReceipt}\n`,
    );
    if (!identicalSnapshot(toolsBefore, toolSnapshot(verificationTools))) {
      fail(
        "AOSP verification tools changed while the bundle was being validated",
      );
    }

    const buildFingerprintPath = path.join(productOut, "system/build.prop");
    assertRegularFile(buildFingerprintPath, "built system properties");
    const buildFingerprint = readStableFile(buildFingerprintPath)
      .toString("utf8")
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
      builderEnvironment,
      sources: {
        osCommit: before.osCommit,
        elizaCommit: before.elizaCommit,
        lockFile: lockRelativePath,
        lockSha256: before.lockSha256,
        manifestCommit: before.manifestCommit,
        repoImplementationCommit: before.repoImplementationCommit,
        aospSourceSnapshot: path.basename(sourceManifest),
        aospSourceSnapshotSha256: sha256File(sourceManifest),
        aospProjectCount: before.aospProjects.length,
        generatedVendorSha256: before.generatedVendorSha256,
        elizaVendorSha256: before.elizaVendorSha256,
      },
      privilegedApk: {
        path: "system/priv-app/Eliza/Eliza.apk",
        retainedPath: "host-validation/Eliza.apk",
        ...apkAfter,
        packageName: "ai.elizaos.app",
        certificateSha256: apkCertificateSha256,
        provenance: apkProvenance,
      },
      artifacts,
      hostValidation: {
        buildGateReceipts,
        productValidationReceipts,
        avb: "host-validation/avbtool-vbmeta.txt",
        apkSignature: "host-validation/apksigner.txt",
        apkBadging: "host-validation/aapt2-badging.txt",
        completedBuildTargets: [
          "droidcore",
          "dist",
          "host_init_verifier",
          "check-vintf-all",
          "apksigner",
          "aapt2",
          "avbtool",
        ],
        collectionMode: "built-and-verified-in-this-invocation",
        verificationTools: toolsBefore,
        verifiedVbmetaImages,
        flashMetadata,
      },
      physicalDevice: "pending",
    };
    const manifestPath = path.join(staging, "grizzly-bundle-manifest.json");
    writeExclusiveFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const checksumEntries = [];
    const addTree = (directory, prefix = "") => {
      for (const entry of fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (relative === "SHA256SUMS") continue;
        if (entry.isDirectory()) addTree(absolute, relative);
        else if (entry.isFile()) {
          checksumEntries.push(
            `${sha256File(absolute, { allowEmpty: true })}  ${relative}`,
          );
        } else fail(`bundle contains a non-regular entry: ${relative}`);
      }
    };
    addTree(staging);
    writeExclusiveFile(
      path.join(staging, "SHA256SUMS"),
      `${checksumEntries.join("\n")}\n`,
    );
    const after = sourceSnapshot({
      aospRoot: args.aospRoot,
      elizaRoot,
      lock,
      lockPath: args.lockPath,
    });
    if (!identicalSnapshot(before, after)) {
      fail("source inputs changed while the bundle was being produced");
    }
    if (
      !identicalSnapshot(apkBefore, {
        sizeBytes: assertRegularFile(apk, "platform privileged Eliza APK").size,
        sha256: sha256File(apk),
      })
    ) {
      fail("privileged APK changed while the bundle was being produced");
    }
    assertPrivateBundleTree(staging);
    if (fs.existsSync(args.outputDir)) {
      fail(`output directory appeared before publication: ${args.outputDir}`);
    }
    const currentStagingState = fs.lstatSync(staging);
    if (!sameInode(stagingState, currentStagingState)) {
      fail("bundle staging directory changed before publication");
    }
    run("mv", [
      "--no-clobber",
      "--no-target-directory",
      staging,
      args.outputDir,
    ]);
    const outputState = fs.lstatSync(args.outputDir, { throwIfNoEntry: false });
    if (!outputState || !sameInode(stagingState, outputState)) {
      fail(
        "published bundle identity does not match its verified staging directory",
      );
    }
    renamed = true;
    const parentDescriptor = fs.openSync(
      outputParent,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
    );
    fs.fsyncSync(parentDescriptor);
    fs.closeSync(parentDescriptor);
    published = true;
    process.stdout.write(`[grizzly-bundle] complete: ${args.outputDir}\n`);
  } finally {
    if (!published) {
      const cleanupPath = renamed ? args.outputDir : staging;
      const cleanupState = fs.lstatSync(cleanupPath, { throwIfNoEntry: false });
      if (cleanupState && sameInode(stagingState, cleanupState)) {
        fs.rmSync(cleanupPath, { recursive: true, force: true });
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
