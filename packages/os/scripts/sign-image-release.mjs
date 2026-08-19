#!/usr/bin/env node
// Deterministically signs the exact three-architecture canonical raw.zst set
// and its byte-exact discovery manifest. Private material is read only from an
// environment variable and is never serialized by this tool.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { lstat, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, sha256File } from "./os-release-lib.mjs";

const architectures = ["x86_64", "arm64", "riscv64"];
const privateKeyEnvironment =
  "ELIZAOS_RELEASE_ED25519_PRIVATE_KEY_PKCS8_BASE64";

function canonicalBase64(value, label) {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error(`${label} must be canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${label} must be canonical base64`);
  }
  return decoded;
}

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

async function nonemptyRegularFile(filePath) {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) {
    throw new Error(
      `release input is not a nonempty regular file: ${filePath}`,
    );
  }
  return stats;
}

async function atomicWrite(filePath, bytes) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o644 });
  await rename(temporary, filePath);
}

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
const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
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
const publicKeyFingerprint = createHash("sha256")
  .update(publicKeyDer)
  .digest("hex");

const minimumDeviceBytes = Number(args["min-device-bytes"] ?? 32_000_000_000);
if (
  !Number.isSafeInteger(minimumDeviceBytes) ||
  minimumDeviceBytes < 32_000_000_000
) {
  throw new Error(
    "--min-device-bytes must be a safe integer of at least 32000000000",
  );
}

const artifacts = [];
for (const architecture of architectures) {
  const basename = `elizaos-${args.version}-${architecture}.raw.zst`;
  const compressedPath = path.join(root, basename);
  const expandedPath = path.join(root, basename.slice(0, -4));
  const [compressedStats, expandedStats] = await Promise.all([
    nonemptyRegularFile(compressedPath),
    nonemptyRegularFile(expandedPath),
  ]);
  if (expandedStats.size < compressedStats.size) {
    throw new Error(
      `${architecture} expanded image is smaller than compressed bytes`,
    );
  }
  if (minimumDeviceBytes < expandedStats.size) {
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
    compressedSize: compressedStats.size,
    expandedSize: expandedStats.size,
    sha256Compressed: await sha256File(compressedPath),
    sha256Expanded: await sha256File(expandedPath),
    signatureUrl: `${url}.sig`,
    minDeviceBytes: minimumDeviceBytes,
    publishedAt,
  };
  if (artifact.sha256Compressed === artifact.sha256Expanded) {
    throw new Error(
      `${architecture} compressed and expanded digests are identical`,
    );
  }
  await atomicWrite(
    `${compressedPath}.sig`,
    sign(null, artifactSignaturePayload(artifact), privateKey),
  );
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

const manifestBytes = Buffer.from(
  `${JSON.stringify({ schemaVersion: 1, product: "elizaOS", artifacts }, null, 2)}\n`,
  "utf8",
);
await atomicWrite(output, manifestBytes);
await atomicWrite(`${output}.sig`, sign(null, manifestBytes, privateKey));
process.stdout.write(
  `${JSON.stringify({ manifest: output, publicKeySpkiBase64: publicKeyDer.toString("base64"), publicKeyFingerprint })}\n`,
);
