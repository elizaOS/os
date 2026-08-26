#!/usr/bin/env node
// Deterministically signs the exact three-architecture canonical raw.zst set
// and its byte-exact discovery manifest. Private material is read only from an
// environment variable and is never serialized by this tool.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { constants, writeSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./os-release-lib.mjs";
import {
  canonicalBase64,
  loadReleaseKeyPolicy,
} from "./release-key-policy.mjs";

const architectures = ["x86_64", "arm64", "riscv64"];
const privateKeyEnvironment =
  "ELIZAOS_RELEASE_ED25519_PRIVATE_KEY_PKCS8_BASE64";

function canonicalTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function artifactSignaturePayload(artifact) {
  return Buffer.from(
    [
      "elizaOS-artifact-v1",
      artifact.url,
      artifact.architecture,
      String(artifact.sequence),
      String(artifact.compressedSize),
      String(artifact.expandedSize),
      artifact.sha256Compressed,
      artifact.sha256Expanded,
      "",
    ].join("\n"),
    "utf8",
  );
}

function inodeIdentity(stats) {
  return `${stats.dev}:${stats.ino}`;
}

function sameFileState(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameStableFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function sameDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

async function trustedArtifactDirectory(root) {
  const [pathStats, canonical] = await Promise.all([
    lstat(root, { bigint: true }),
    realpath(root),
  ]);
  if (pathStats.isSymbolicLink()) {
    throw new Error(
      "--artifact-root must be a signer-owned, non-symlink, non-group/world-writable directory",
    );
  }
  let handle;
  let parentHandle;
  try {
    handle = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const stats = await handle.stat({ bigint: true });
    if (
      !sameDirectoryIdentity(pathStats, stats) ||
      !stats.isDirectory() ||
      pathStats.isSymbolicLink() ||
      canonical !== root ||
      stats.uid !== BigInt(process.geteuid()) ||
      (stats.mode & 0o22n) !== 0n
    ) {
      throw new Error(
        "--artifact-root must be a signer-owned, non-symlink, non-group/world-writable directory",
      );
    }
    const parentPath = path.dirname(root);
    parentHandle = await open(
      parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const [parentPathStats, parentStats] = await Promise.all([
      lstat(parentPath, { bigint: true }),
      parentHandle.stat({ bigint: true }),
    ]);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw new Error("--artifact-root parent must be a non-symlink directory");
    }
    if (!sameDirectoryIdentity(parentPathStats, parentStats)) {
      throw new Error("--artifact-root parent changed during inspection");
    }
    if (
      (parentStats.mode & 0o22n) !== 0n &&
      (parentStats.mode & 0o1000n) === 0n
    ) {
      throw new Error(
        "--artifact-root parent must not permit unprotected directory replacement",
      );
    }
    return { handle, stats, parentHandle, parentPath, parentStats };
  } catch (error) {
    await Promise.all([
      handle?.close().catch(() => {}),
      parentHandle?.close().catch(() => {}),
    ]);
    throw error;
  }
}

async function validateArtifactDirectory(root, trusted) {
  const [stats, handleStats, parentStats, parentHandleStats, canonical] =
    await Promise.all([
      lstat(root, { bigint: true }),
      trusted.handle.stat({ bigint: true }),
      lstat(trusted.parentPath, { bigint: true }),
      trusted.parentHandle.stat({ bigint: true }),
      realpath(root),
    ]);
  if (
    !sameDirectoryIdentity(stats, trusted.stats) ||
    !sameDirectoryIdentity(handleStats, trusted.stats) ||
    !sameDirectoryIdentity(parentStats, trusted.parentStats) ||
    !sameDirectoryIdentity(parentHandleStats, trusted.parentStats) ||
    canonical !== root ||
    !stats.isDirectory() ||
    stats.uid !== trusted.stats.uid ||
    (stats.mode & 0o22n) !== 0n
  ) {
    throw new Error("artifact root or its parent changed during signing");
  }
}

async function openInput(filePath) {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stats = await handle.stat({ bigint: true });
    if (
      !stats.isFile() ||
      stats.nlink !== 1n ||
      stats.size === 0n ||
      stats.uid !== BigInt(process.geteuid()) ||
      (stats.mode & 0o22n) !== 0n
    ) {
      throw new Error(
        `release input is not a private nonempty regular file: ${filePath}`,
      );
    }
    return { filePath, handle, stats };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function hashInput(input) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0n;
  while (position < input.stats.size) {
    const length = Number(
      input.stats.size - position > BigInt(buffer.length)
        ? BigInt(buffer.length)
        : input.stats.size - position,
    );
    const { bytesRead } = await input.handle.read(
      buffer,
      0,
      length,
      Number(position),
    );
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += BigInt(bytesRead);
  }
  const after = await input.handle.stat({ bigint: true });
  if (position !== input.stats.size || !sameFileState(input.stats, after)) {
    throw new Error(`release input changed while hashing: ${input.filePath}`);
  }
  return hash.digest("hex");
}

async function validateInput(input) {
  const [handleStats, pathStats] = await Promise.all([
    input.handle.stat({ bigint: true }),
    lstat(input.filePath, { bigint: true }),
  ]);
  if (
    !sameFileState(input.stats, handleStats) ||
    !sameFileState(input.stats, pathStats) ||
    !pathStats.isFile() ||
    pathStats.isSymbolicLink()
  ) {
    throw new Error(
      `release input changed after inspection: ${input.filePath}`,
    );
  }
}

async function testCheckpoint(name) {
  const hookDirectory = Reflect.get(
    process.env,
    "ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY",
  );
  const selected = Reflect.get(process.env, "ELIZAOS_RELEASE_TEST_CHECKPOINT");
  if (process.env.NODE_ENV !== "test" || !hookDirectory || selected !== name) {
    return;
  }
  await writeFile(path.join(hookDirectory, `${name}.ready`), "ready\n", {
    flag: "wx",
  });
  const resume = path.join(hookDirectory, `${name}.resume`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await lstat(resume);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out at test checkpoint ${name}`);
}

async function optionalLstat(filePath, options) {
  try {
    return await lstat(filePath, options);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function validateOutputPaths(inputFiles, outputFiles) {
  const inputPaths = new Set(inputFiles.map(({ filePath }) => filePath));
  const inputInodes = new Set(
    inputFiles.map(({ stats }) => inodeIdentity(stats)),
  );
  const outputPaths = new Set();
  const outputInodes = new Set();
  const existing = new Map();
  for (const filePath of outputFiles) {
    if (inputPaths.has(filePath)) {
      throw new Error(`release output aliases an image input: ${filePath}`);
    }
    if (outputPaths.has(filePath)) {
      throw new Error(`release output paths alias each other: ${filePath}`);
    }
    outputPaths.add(filePath);
    const stats = await optionalLstat(filePath, { bigint: true });
    existing.set(filePath, stats);
    if (!stats) continue;
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(
        `release output is linked or not a regular file: ${filePath}`,
      );
    }
    if (
      stats.nlink !== 1n ||
      stats.uid !== BigInt(process.geteuid()) ||
      (stats.mode & 0o22n) !== 0n
    ) {
      throw new Error(
        `release output is not a signer-owned private file: ${filePath}`,
      );
    }
    const identity = inodeIdentity(stats);
    if (inputInodes.has(identity)) {
      throw new Error(`release output hard-links an image input: ${filePath}`);
    }
    if (outputInodes.has(identity)) {
      throw new Error(`release outputs hard-link each other: ${filePath}`);
    }
    outputInodes.add(identity);
  }
  return existing;
}

async function createPrivateStage(root) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const stagePath = path.join(
      root,
      `.elizaos-release-stage-${randomBytes(16).toString("hex")}`,
    );
    try {
      await mkdir(stagePath, { mode: 0o700 });
      const handle = await open(
        stagePath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const [pathStats, stats] = await Promise.all([
        lstat(stagePath, { bigint: true }),
        handle.stat({ bigint: true }),
      ]);
      if (
        !sameDirectoryIdentity(pathStats, stats) ||
        !stats.isDirectory() ||
        pathStats.isSymbolicLink() ||
        stats.uid !== BigInt(process.geteuid()) ||
        (stats.mode & 0o777n) !== 0o700n
      ) {
        await handle.close();
        throw new Error("release staging directory is not private");
      }
      return { path: stagePath, handle, stats };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not allocate a private release staging directory");
}

async function validateStage(stage) {
  const [stats, handleStats] = await Promise.all([
    lstat(stage.path, { bigint: true }),
    stage.handle.stat({ bigint: true }),
  ]);
  if (
    !sameDirectoryIdentity(stats, stage.stats) ||
    !sameDirectoryIdentity(handleStats, stage.stats) ||
    !stats.isDirectory() ||
    stats.uid !== stage.stats.uid ||
    (stats.mode & 0o777n) !== 0o700n
  ) {
    throw new Error("release staging directory changed during signing");
  }
}

async function readStagedBytes(staged) {
  if (staged.stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`staged release output is too large: ${staged.filePath}`);
  }
  const bytes = Buffer.alloc(Number(staged.stats.size));
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await staged.handle.read(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== bytes.length) {
    throw new Error(`staged release output was truncated: ${staged.filePath}`);
  }
  await validateStagedOutput(staged);
  return bytes;
}

async function verifyStagedRelease(stagedOutputs, artifacts, publicKey) {
  const bytes = [];
  for (const staged of stagedOutputs) {
    const stagedBytes = await readStagedBytes(staged);
    if (!stagedBytes.equals(staged.bytes)) {
      throw new Error(
        `staged release output bytes changed: ${staged.filePath}`,
      );
    }
    bytes.push(stagedBytes);
  }
  for (let index = 0; index < artifacts.length; index += 1) {
    if (
      !verify(
        null,
        artifactSignaturePayload(artifacts[index]),
        publicKey,
        bytes[index],
      )
    ) {
      throw new Error("staged artifact signature verification failed");
    }
  }
  const manifestIndex = artifacts.length;
  if (
    !verify(null, bytes[manifestIndex], publicKey, bytes[manifestIndex + 1])
  ) {
    throw new Error("staged manifest signature verification failed");
  }
}

async function stageOutput(stage, index, filePath, bytes) {
  const stagedPath = path.join(stage.path, `output-${index}`);
  const handle = await open(
    stagedPath,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o644,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error("staged release output is not a private regular file");
    }
    await handle.writeFile(bytes);
    await handle.sync();
    const stats = await handle.stat({ bigint: true });
    if (
      !stats.isFile() ||
      stats.nlink !== 1n ||
      stats.size !== BigInt(bytes.length)
    ) {
      throw new Error("staged release output changed while writing");
    }
    return { filePath, stagedPath, bytes, handle, stats };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function validateStagedOutput(staged) {
  const [handleStats, pathStats] = await Promise.all([
    staged.handle.stat({ bigint: true }),
    lstat(staged.stagedPath, { bigint: true }),
  ]);
  if (
    !sameFileState(staged.stats, handleStats) ||
    !sameFileState(staged.stats, pathStats) ||
    !pathStats.isFile() ||
    pathStats.isSymbolicLink()
  ) {
    throw new Error(`staged release output changed: ${staged.filePath}`);
  }
}

async function validateExistingOutputs(stagedOutputs, existingOutputs) {
  for (const staged of stagedOutputs) {
    const expected = existingOutputs.get(staged.filePath);
    const current = await optionalLstat(staged.filePath, { bigint: true });
    if (
      (!expected && current) ||
      (expected && (!current || !sameFileState(expected, current)))
    ) {
      throw new Error(
        `release output changed after preflight: ${staged.filePath}`,
      );
    }
  }
}

async function promoteReleaseSet(
  stage,
  stagedOutputs,
  existingOutputs,
  validateBeforeCommit,
) {
  const backups = [];
  const promoted = [];
  try {
    await validateStage(stage);
    await validateExistingOutputs(stagedOutputs, existingOutputs);
    for (let index = 0; index < stagedOutputs.length; index += 1) {
      const staged = stagedOutputs[index];
      const existing = existingOutputs.get(staged.filePath);
      if (!existing) continue;
      const backupPath = path.join(stage.path, `backup-${index}`);
      await link(staged.filePath, backupPath);
      const backupStats = await lstat(backupPath, { bigint: true });
      backups.push({
        filePath: staged.filePath,
        backupPath,
        stats: backupStats,
      });
      const currentStats = await lstat(staged.filePath, { bigint: true });
      if (
        !sameStableFileIdentity(existing, backupStats) ||
        !sameStableFileIdentity(existing, currentStats)
      ) {
        throw new Error(
          `release output changed during backup: ${staged.filePath}`,
        );
      }
      await unlink(staged.filePath);
    }
    for (const staged of stagedOutputs) {
      await validateStage(stage);
      await validateStagedOutput(staged);
      await link(staged.stagedPath, staged.filePath);
      promoted.push(staged);
      const promotedStats = await lstat(staged.filePath, { bigint: true });
      if (!sameStableFileIdentity(staged.stats, promotedStats)) {
        throw new Error(
          `release output changed during promotion: ${staged.filePath}`,
        );
      }
      await unlink(staged.stagedPath);
      const failAfter = Number(
        Reflect.get(process.env, "ELIZAOS_RELEASE_TEST_FAIL_PROMOTION_AFTER") ??
          0,
      );
      if (
        process.env.NODE_ENV === "test" &&
        Number.isInteger(failAfter) &&
        failAfter === promoted.length
      ) {
        throw new Error("injected release-set promotion failure");
      }
    }
    await validateBeforeCommit();
  } catch (error) {
    const rollbackErrors = [];
    for (const staged of [...promoted].reverse()) {
      try {
        const current = await optionalLstat(staged.filePath, { bigint: true });
        if (
          !current ||
          inodeIdentity(current) !== inodeIdentity(staged.stats)
        ) {
          throw new Error(`promoted output changed: ${staged.filePath}`);
        }
        await unlink(staged.filePath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const backup of backups.reverse()) {
      try {
        const occupied = await optionalLstat(backup.filePath, { bigint: true });
        if (occupied) {
          if (!sameStableFileIdentity(backup.stats, occupied)) {
            throw new Error(
              `cannot restore occupied output: ${backup.filePath}`,
            );
          }
          await unlink(backup.backupPath);
          continue;
        }
        const current = await lstat(backup.backupPath, { bigint: true });
        if (!sameStableFileIdentity(backup.stats, current)) {
          throw new Error(`release backup changed: ${backup.filePath}`);
        }
        await link(backup.backupPath, backup.filePath);
        await unlink(backup.backupPath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "release-set promotion and rollback failed",
      );
    }
    throw error;
  }
  for (const backup of backups) await unlink(backup.backupPath);
}

async function cleanupStage(stage) {
  if (!stage) return;
  try {
    const current = await optionalLstat(stage.path, { bigint: true });
    if (!current) return;
    if (
      inodeIdentity(current) !== inodeIdentity(stage.stats) ||
      !current.isDirectory()
    ) {
      throw new Error("refusing to clean a replaced release staging directory");
    }
    for (const name of await readdir(stage.path)) {
      const entry = path.join(stage.path, name);
      const stats = await lstat(entry);
      if (!stats.isFile() && !stats.isSymbolicLink()) {
        throw new Error("release staging directory contains an unsafe entry");
      }
      await unlink(entry);
    }
  } finally {
    await stage.handle.close().catch(() => {});
  }
  await rmdir(stage.path);
}

// Validate the independently controlled public trust policy and bind the
// private key to it before parsing release metadata, inspecting image inputs,
// or considering any output path.
const activePolicy = loadReleaseKeyPolicy();
const keyBytes = canonicalBase64(
  process.env[privateKeyEnvironment],
  privateKeyEnvironment,
);
const privateKey = createPrivateKey({
  key: keyBytes,
  format: "der",
  type: "pkcs8",
});
if (privateKey.asymmetricKeyType !== "ed25519") {
  throw new Error("release signing key must be an Ed25519 PKCS#8 private key");
}
const publicKey = createPublicKey(privateKey);
const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
if (!publicKeyDer.equals(activePolicy.publicKeyDer)) {
  throw new Error(
    "release signing private key does not match the independently pinned active public key",
  );
}
const publicKeyFingerprint = activePolicy.publicKeyFingerprint;

const args = parseArgs(process.argv.slice(2));
const required = [
  "artifact-root",
  "version",
  "channel",
  "sequence",
  "expires",
  "base-url",
  "output",
];
const missing = required.filter((name) => !args[name]);
if (missing.length > 0) {
  throw new Error(
    `missing required arguments: ${missing.map((name) => `--${name}`).join(", ")}`,
  );
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(args.version)) {
  throw new Error(
    "--version must be a semantic release version without v prefix",
  );
}
if (!["stable", "beta", "nightly"].includes(args.channel)) {
  throw new Error("--channel must be stable, beta, or nightly");
}
if (!/^[1-9][0-9]*$/.test(args.sequence)) {
  throw new Error("--sequence must be a positive integer");
}
const sequence = Number(args.sequence);
if (!Number.isSafeInteger(sequence)) {
  throw new Error("--sequence exceeds the safe integer range");
}
const expires = canonicalTimestamp(args.expires, "--expires");
if (Date.parse(expires) <= Date.now()) {
  throw new Error("--expires must be in the future");
}
const sourceDateEpoch = Reflect.get(process.env, "SOURCE_DATE_EPOCH");
if (!sourceDateEpoch || !/^[0-9]+$/.test(sourceDateEpoch)) {
  throw new Error(
    "SOURCE_DATE_EPOCH must be a numeric reproducible-build input",
  );
}
const publishedAt = new Date(Number(sourceDateEpoch) * 1000).toISOString();
if (!Number.isFinite(Date.parse(publishedAt))) {
  throw new Error("SOURCE_DATE_EPOCH is outside the supported date range");
}
const baseUrl = new URL(args["base-url"]);
if (baseUrl.protocol !== "https:") {
  throw new Error("--base-url must use HTTPS");
}
const root = path.resolve(args["artifact-root"]);
const output = path.resolve(args.output);
if (path.dirname(output) !== root) {
  throw new Error("--output must be a direct child of --artifact-root");
}
const minimumDeviceBytes = Number(args["min-device-bytes"] ?? 32_000_000_000);
if (
  !Number.isSafeInteger(minimumDeviceBytes) ||
  minimumDeviceBytes < 32_000_000_000
) {
  throw new Error(
    "--min-device-bytes must be a safe integer of at least 32000000000",
  );
}

const trustedRoot = await trustedArtifactDirectory(root);
const artifacts = [];
const inputFiles = [];
const artifactSignaturePaths = [];
let stage;
const stagedOutputs = [];
let summary;
try {
  for (const architecture of architectures) {
    const basename = `elizaos-${args.version}-${architecture}.raw.zst`;
    const compressedPath = path.join(root, basename);
    const expandedPath = path.join(root, basename.slice(0, -4));
    const compressed = await openInput(compressedPath);
    inputFiles.push(compressed);
    const expanded = await openInput(expandedPath);
    inputFiles.push(expanded);
  }
  await testCheckpoint("inputs-opened");

  for (let index = 0; index < architectures.length; index += 1) {
    const architecture = architectures[index];
    const basename = `elizaos-${args.version}-${architecture}.raw.zst`;
    const compressed = inputFiles[index * 2];
    const expanded = inputFiles[index * 2 + 1];
    if (expanded.stats.size < compressed.stats.size) {
      throw new Error(
        `${architecture} expanded image is smaller than compressed bytes`,
      );
    }
    if (
      expanded.stats.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      compressed.stats.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error(
        `${architecture} image size exceeds the safe integer range`,
      );
    }
    if (BigInt(minimumDeviceBytes) < expanded.stats.size) {
      throw new Error(`${architecture} image exceeds --min-device-bytes`);
    }
    const url = new URL(basename, `${baseUrl.href.replace(/\/$/, "")}/`).href;
    const artifact = {
      schemaVersion: 1,
      product: "elizaOS",
      version: args.version,
      channel: args.channel,
      sequence,
      expires,
      architecture,
      url,
      compressedSize: Number(compressed.stats.size),
      expandedSize: Number(expanded.stats.size),
      sha256Compressed: await hashInput(compressed),
      sha256Expanded: await hashInput(expanded),
      signatureUrl: `${url}.sig`,
      minDeviceBytes: minimumDeviceBytes,
      publishedAt,
    };
    if (artifact.sha256Compressed === artifact.sha256Expanded) {
      throw new Error(
        `${architecture} compressed and expanded digests are identical`,
      );
    }
    artifactSignaturePaths.push(`${compressed.filePath}.sig`);
    artifacts.push(artifact);
  }

  const expectedInputs = new Set(
    architectures.flatMap((architecture) => {
      const basename = `elizaos-${args.version}-${architecture}.raw.zst`;
      return [basename, basename.slice(0, -4)];
    }),
  );
  const unexpectedImages = (await readdir(root)).filter(
    (name) =>
      (name.endsWith(".raw") || name.endsWith(".raw.zst")) &&
      !expectedInputs.has(name),
  );
  if (unexpectedImages.length > 0) {
    throw new Error(
      `artifact root contains unexpected images: ${unexpectedImages.join(", ")}`,
    );
  }

  await validateArtifactDirectory(root, trustedRoot);
  for (const input of inputFiles) await validateInput(input);
  const outputFiles = [...artifactSignaturePaths, output, `${output}.sig`];
  const existingOutputs = await validateOutputPaths(inputFiles, outputFiles);
  const manifestBytes = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, product: "elizaOS", artifacts }, null, 2)}\n`,
    "utf8",
  );
  const outputBytes = [
    ...artifacts.map((artifact) =>
      sign(null, artifactSignaturePayload(artifact), privateKey),
    ),
    manifestBytes,
    sign(null, manifestBytes, privateKey),
  ];
  for (let index = 0; index < artifacts.length; index += 1) {
    if (
      !verify(
        null,
        artifactSignaturePayload(artifacts[index]),
        publicKey,
        outputBytes[index],
      )
    ) {
      throw new Error("internal artifact signature verification failed");
    }
  }
  if (!verify(null, manifestBytes, publicKey, outputBytes.at(-1))) {
    throw new Error("internal manifest signature verification failed");
  }

  stage = await createPrivateStage(root);
  for (let index = 0; index < outputFiles.length; index += 1) {
    stagedOutputs.push(
      await stageOutput(stage, index, outputFiles[index], outputBytes[index]),
    );
  }
  await verifyStagedRelease(stagedOutputs, artifacts, publicKey);
  await testCheckpoint("outputs-staged");
  await validateArtifactDirectory(root, trustedRoot);
  for (const input of inputFiles) await validateInput(input);
  await promoteReleaseSet(stage, stagedOutputs, existingOutputs, async () => {
    await testCheckpoint("outputs-promoted");
    await validateArtifactDirectory(root, trustedRoot);
    for (const input of inputFiles) await validateInput(input);
    await validateStage(stage);
    for (const staged of stagedOutputs) {
      const [handleStats, outputStats] = await Promise.all([
        staged.handle.stat({ bigint: true }),
        lstat(staged.filePath, { bigint: true }),
      ]);
      if (
        !sameStableFileIdentity(staged.stats, handleStats) ||
        !sameStableFileIdentity(staged.stats, outputStats)
      ) {
        throw new Error(
          `promoted release output changed before commit: ${staged.filePath}`,
        );
      }
    }
  });
  summary = {
    manifest: output,
    publicKeySpkiBase64: publicKeyDer.toString("base64"),
    publicKeyFingerprint,
  };
} finally {
  try {
    await Promise.all([
      ...inputFiles.map((input) => input.handle.close().catch(() => {})),
      ...stagedOutputs.map((staged) => staged.handle.close().catch(() => {})),
    ]);
    await cleanupStage(stage);
  } finally {
    await Promise.all([
      trustedRoot.handle.close().catch(() => {}),
      trustedRoot.parentHandle.close().catch(() => {}),
    ]);
  }
}
writeSync(1, `${JSON.stringify(summary)}\n`);
