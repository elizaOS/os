import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    publicKey: publicKeyDer.toString("base64"),
    publicKeyFingerprint: createHash("sha256")
      .update(publicKeyDer)
      .digest("hex"),
  };
}

async function signRelease(paths, overrides = {}) {
  return execFileAsync(
    process.execPath,
    [
      "packages/os/scripts/sign-image-release.mjs",
      "--artifact-root",
      overrides.artifactRoot ?? paths.root,
      "--version",
      overrides.version ?? "1.2.3-beta.4",
      "--channel",
      overrides.channel ?? "beta",
      "--sequence",
      overrides.sequence ?? "42",
      "--expires",
      overrides.expires ?? "2099-01-01T00:00:00.000Z",
      "--base-url",
      overrides.baseUrl ??
        "https://download.elizaos.ai/os/releases/v1.2.3-beta.4/",
      "--output",
      overrides.output ?? paths.manifest,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SOURCE_DATE_EPOCH: "1700000000",
        ELIZAOS_RELEASE_ED25519_PRIVATE_KEY_PKCS8_BASE64: paths.privateKey,
        ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64: paths.publicKey,
        ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256:
          paths.publicKeyFingerprint,
        ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S:
          paths.revokedKeyFingerprints ?? "",
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
        ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256:
          paths.publicKeyFingerprint,
        ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S:
          paths.revokedKeyFingerprints ?? "",
      },
    },
  );
}

function artifactSignaturePath(paths, architecture) {
  return path.join(
    paths.root,
    `elizaos-1.2.3-beta.4-${architecture}.raw.zst.sig`,
  );
}

async function assertNoNewReleaseOutputs(paths, ignored = new Set()) {
  for (const filePath of [
    paths.manifest,
    `${paths.manifest}.sig`,
    ...architectures.map((architecture) =>
      artifactSignaturePath(paths, architecture),
    ),
  ]) {
    if (ignored.has(filePath)) continue;
    await assert.rejects(lstat(filePath), /ENOENT/);
  }
  assert.deepEqual(
    (await readdir(paths.root)).filter((name) => name.endsWith(".tmp")),
    [],
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

test("canonical image verification rejects an unknown public key fingerprint", async () => {
  const paths = await fixture();
  await signRelease(paths);
  const unknown = await fixture();
  paths.publicKeyFingerprint = unknown.publicKeyFingerprint;
  await assert.rejects(
    verifyRelease(paths),
    /does not match the independently pinned SPKI SHA-256/,
  );
});

test("canonical image verification requires an independent fingerprint pin", async () => {
  const paths = await fixture();
  await signRelease(paths);
  delete paths.publicKeyFingerprint;
  await assert.rejects(
    verifyRelease(paths),
    /PUBLIC_KEY_SPKI_SHA256 must be a nonzero lowercase SHA-256 digest/,
  );
});

test("canonical image verification rejects a revoked release key", async () => {
  const paths = await fixture();
  await signRelease(paths);
  paths.revokedKeyFingerprints = paths.publicKeyFingerprint;
  await assert.rejects(verifyRelease(paths), /verification key is revoked/);
});

test("signing refuses a stale private key after active-key rotation before writing output", async () => {
  const paths = await fixture();
  const rotated = await fixture();
  paths.publicKey = rotated.publicKey;
  paths.publicKeyFingerprint = rotated.publicKeyFingerprint;
  await assert.rejects(
    signRelease(paths, {
      artifactRoot: path.join(paths.root, "inaccessible"),
      channel: "invalid",
      output: path.join(paths.root, "inaccessible", "manifest.json"),
    }),
    /private key does not match the independently pinned active public key/,
  );
  await assertNoNewReleaseOutputs(paths);
});

test("signing refuses a revoked active key before writing output", async () => {
  const paths = await fixture();
  paths.revokedKeyFingerprints = paths.publicKeyFingerprint;
  await assert.rejects(
    signRelease(paths, {
      artifactRoot: path.join(paths.root, "inaccessible"),
      channel: "invalid",
      output: path.join(paths.root, "inaccessible", "manifest.json"),
    }),
    /verification key is revoked/,
  );
  await assertNoNewReleaseOutputs(paths);
});

test("signing rejects linked output before writing or following the link", async () => {
  const paths = await fixture();
  const victim = path.join(paths.root, "must-not-be-overwritten");
  const linkedSignature = artifactSignaturePath(paths, architectures[0]);
  await writeFile(victim, "original-victim-bytes\n");
  await symlink(victim, linkedSignature);
  await assert.rejects(signRelease(paths), /output is linked/);
  assert.equal(await readFile(victim, "utf8"), "original-victim-bytes\n");
  assert.equal((await lstat(linkedSignature)).isSymbolicLink(), true);
  await assertNoNewReleaseOutputs(paths, new Set([linkedSignature]));
});

test("signing never follows a pre-created predictable temporary symlink", async () => {
  const paths = await fixture();
  const victim = path.join(paths.root, "temporary-link-victim");
  const legacyTemporary = `${artifactSignaturePath(paths, architectures[0])}.tmp`;
  await writeFile(victim, "original-victim-bytes\n");
  await symlink(victim, legacyTemporary);
  await signRelease(paths);
  assert.equal(await readFile(victim, "utf8"), "original-victim-bytes\n");
  assert.equal((await lstat(legacyTemporary)).isSymbolicLink(), true);
  assert.equal(
    (await readdir(paths.root)).some(
      (name) =>
        name.endsWith(".tmp") && name !== path.basename(legacyTemporary),
    ),
    false,
  );
  await verifyRelease(paths);
});

test("signing rejects an output path that aliases an image input", async () => {
  const paths = await fixture();
  const compressed = path.join(
    paths.root,
    "elizaos-1.2.3-beta.4-x86_64.raw.zst",
  );
  const original = await readFile(compressed);
  await assert.rejects(
    signRelease(paths, { output: compressed }),
    /output aliases an image input/,
  );
  assert.deepEqual(await readFile(compressed), original);
  await assertNoNewReleaseOutputs(paths);
});

test("signing rejects a hard-linked output alias without touching inputs", async () => {
  const paths = await fixture();
  const compressed = path.join(
    paths.root,
    "elizaos-1.2.3-beta.4-x86_64.raw.zst",
  );
  const original = await readFile(compressed);
  await link(compressed, paths.manifest);
  await assert.rejects(signRelease(paths), /output hard-links an image input/);
  assert.deepEqual(await readFile(compressed), original);
  assert.deepEqual(await readFile(paths.manifest), original);
  await assertNoNewReleaseOutputs(paths, new Set([paths.manifest]));
});

test("signing rejects manifest and artifact signature path aliases", async () => {
  const paths = await fixture();
  const signature = artifactSignaturePath(paths, architectures[0]);
  await assert.rejects(
    signRelease(paths, { output: signature }),
    /output paths alias each other/,
  );
  await assertNoNewReleaseOutputs(paths);
});

test("canonical image signing rejects incomplete architecture sets", async () => {
  const paths = await fixture();
  await writeFile(
    path.join(paths.root, "elizaos-1.2.3-beta.4-riscv64.raw"),
    "",
  );
  await assert.rejects(signRelease(paths), /nonempty regular file/);
});
