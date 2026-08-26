#!/usr/bin/env node
// Independently verifies the canonical image manifest, exact local bytes, and
// detached Ed25519 signatures produced by sign-image-release.mjs.
import { verify } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import { parseArgs, sha256File } from "./os-release-lib.mjs";
import { loadReleaseKeyPolicy } from "./release-key-policy.mjs";

const architectures = ["x86_64", "arm64", "riscv64"];
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

async function regularFile(filePath, expectedSize) {
  const stats = await lstat(filePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size === 0 ||
    (expectedSize !== undefined && stats.size !== expectedSize)
  ) {
    throw new Error(
      `release file is missing, linked, empty, or wrong-sized: ${filePath}`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.manifest || !args["artifact-root"]) {
  throw new Error("--manifest and --artifact-root are required");
}
const manifestPath = path.resolve(args.manifest);
const root = path.resolve(args["artifact-root"]);
if (path.dirname(manifestPath) !== root) {
  throw new Error("--manifest must be a direct child of --artifact-root");
}
const { key } = loadReleaseKeyPolicy();
await regularFile(manifestPath);
await regularFile(`${manifestPath}.sig`, 64);
const manifestBytes = await readFile(manifestPath);
const manifestSignature = await readFile(`${manifestPath}.sig`);
if (
  manifestSignature.byteLength !== 64 ||
  !verify(null, manifestBytes, key, manifestSignature)
) {
  throw new Error("release manifest Ed25519 signature verification failed");
}
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const schemaPath = fileURLToPath(
  new URL(
    "../release/schema/elizaos-image-manifest.schema.json",
    import.meta.url,
  ),
);
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const schemaValidation = validateAgainstSchema(manifest, schema);
if (!schemaValidation.ok) {
  throw new Error(
    `release manifest schema validation failed:\n${schemaValidation.errors.join("\n")}`,
  );
}
if (
  manifest?.schemaVersion !== 1 ||
  manifest?.product !== "elizaOS" ||
  !Array.isArray(manifest?.artifacts) ||
  manifest.artifacts.length !== architectures.length ||
  Object.keys(manifest).some(
    (field) => !["schemaVersion", "product", "artifacts"].includes(field),
  )
) {
  throw new Error("release manifest envelope is invalid");
}
const identities = new Set();
for (const architecture of architectures) {
  const matches = manifest.artifacts.filter(
    (artifact) => artifact?.architecture === architecture,
  );
  if (matches.length !== 1) {
    throw new Error(
      `release manifest requires exactly one ${architecture} artifact`,
    );
  }
  const artifact = matches[0];
  const allowed = new Set([
    "schemaVersion",
    "product",
    "version",
    "channel",
    "sequence",
    "expires",
    "architecture",
    "url",
    "compressedSize",
    "expandedSize",
    "sha256Compressed",
    "sha256Expanded",
    "signatureUrl",
    "minDeviceBytes",
    "publishedAt",
  ]);
  if (Object.keys(artifact).some((field) => !allowed.has(field))) {
    throw new Error(`${architecture} artifact contains unknown fields`);
  }
  const url = new URL(artifact.url);
  const signatureUrl = new URL(artifact.signatureUrl);
  const basename = path.basename(url.pathname);
  const canonicalTimestamp = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
  if (
    url.protocol !== "https:" ||
    signatureUrl.protocol !== "https:" ||
    signatureUrl.href !== `${url.href}.sig` ||
    basename !== `elizaos-${artifact.version}-${architecture}.raw.zst` ||
    artifact.schemaVersion !== 1 ||
    artifact.product !== "elizaOS" ||
    typeof artifact.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(artifact.version) ||
    !["stable", "beta", "nightly"].includes(artifact.channel) ||
    !Number.isSafeInteger(artifact.sequence) ||
    artifact.sequence < 1 ||
    !canonicalTimestamp(artifact.expires) ||
    Date.parse(artifact.expires) <= Date.now() ||
    !canonicalTimestamp(artifact.publishedAt) ||
    !Number.isSafeInteger(artifact.compressedSize) ||
    artifact.compressedSize < 1 ||
    !Number.isSafeInteger(artifact.expandedSize) ||
    artifact.expandedSize < 1 ||
    typeof artifact.sha256Compressed !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256Compressed) ||
    artifact.sha256Compressed === "0".repeat(64) ||
    typeof artifact.sha256Expanded !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256Expanded) ||
    artifact.sha256Expanded === "0".repeat(64) ||
    !Number.isSafeInteger(artifact.minDeviceBytes) ||
    artifact.minDeviceBytes < 32_000_000_000
  ) {
    throw new Error(`${architecture} artifact metadata is invalid`);
  }
  identities.add(
    JSON.stringify([
      artifact.version,
      artifact.channel,
      artifact.sequence,
      artifact.expires,
      artifact.publishedAt,
    ]),
  );
  const compressedPath = path.join(root, basename);
  const expandedPath = path.join(root, basename.slice(0, -4));
  await regularFile(compressedPath, artifact.compressedSize);
  await regularFile(expandedPath, artifact.expandedSize);
  if (
    artifact.sha256Compressed !== (await sha256File(compressedPath)) ||
    artifact.sha256Expanded !== (await sha256File(expandedPath)) ||
    artifact.sha256Compressed === artifact.sha256Expanded ||
    artifact.expandedSize < artifact.compressedSize ||
    artifact.minDeviceBytes < artifact.expandedSize
  ) {
    throw new Error(`${architecture} image byte binding is invalid`);
  }
  await regularFile(`${compressedPath}.sig`, 64);
  const signature = await readFile(`${compressedPath}.sig`);
  if (
    signature.byteLength !== 64 ||
    !verify(null, artifactSignaturePayload(artifact), key, signature)
  ) {
    throw new Error(
      `${architecture} artifact Ed25519 signature verification failed`,
    );
  }
}
if (identities.size !== 1) {
  throw new Error(
    "release artifacts do not share one version/channel/sequence identity",
  );
}
console.log(`Verified canonical image release ${manifestPath}`);
