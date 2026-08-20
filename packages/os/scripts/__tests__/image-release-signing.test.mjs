import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);
const architectures = ["x86_64", "arm64", "riscv64"];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "elizaos-image-signing-"));
  await mkdir(root, { recursive: true });
  for (const architecture of architectures) {
    const base = path.join(root, `elizaos-1.2.3-beta.4-${architecture}.raw`);
    await writeFile(base, `expanded-${architecture}-bytes\n`);
    await writeFile(`${base}.zst`, `zstd-${architecture}\n`);
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

async function signRelease(paths) {
  return execFileAsync(
    process.execPath,
    [
      "packages/os/scripts/sign-image-release.mjs",
      "--artifact-root",
      paths.root,
      "--version",
      "1.2.3-beta.4",
      "--channel",
      "beta",
      "--sequence",
      "42",
      "--expires",
      "2099-01-01T00:00:00.000Z",
      "--base-url",
      "https://download.elizaos.ai/os/releases/v1.2.3-beta.4/",
      "--output",
      paths.manifest,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SOURCE_DATE_EPOCH: "1700000000",
        ELIZAOS_RELEASE_ED25519_PRIVATE_KEY_PKCS8_BASE64: paths.privateKey,
      },
    },
  );
}

async function verifyRelease(paths) {
  return execFileAsync(
    process.execPath,
    [
      "packages/os/scripts/verify-image-release.mjs",
      "--manifest",
      paths.manifest,
      "--artifact-root",
      paths.root,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64: paths.publicKey,
      },
    },
  );
}

test("canonical image release signs and independently verifies exact bytes", async () => {
  const paths = await fixture();
  const first = await signRelease(paths);
  const manifestBytes = await readFile(paths.manifest);
  const manifestSignature = await readFile(`${paths.manifest}.sig`);
  const summary = JSON.parse(first.stdout);
  assert.equal(summary.publicKeySpkiBase64, paths.publicKey);
  assert.match(summary.publicKeyFingerprint, /^[a-f0-9]{64}$/);
  await verifyRelease(paths);

  await signRelease(paths);
  assert.deepEqual(await readFile(paths.manifest), manifestBytes);
  assert.deepEqual(await readFile(`${paths.manifest}.sig`), manifestSignature);
});

test("canonical image verification rejects modified compressed bytes", async () => {
  const paths = await fixture();
  await signRelease(paths);
  await writeFile(
    path.join(paths.root, "elizaos-1.2.3-beta.4-arm64.raw.zst"),
    "tampered-but-nonempty\n",
  );
  await assert.rejects(verifyRelease(paths), /wrong-sized|byte binding/);
});

test("canonical image signing rejects incomplete architecture sets", async () => {
  const paths = await fixture();
  await writeFile(
    path.join(paths.root, "elizaos-1.2.3-beta.4-riscv64.raw"),
    "",
  );
  await assert.rejects(signRelease(paths), /nonempty regular file/);
});
