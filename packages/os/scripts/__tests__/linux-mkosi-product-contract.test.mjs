import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalArchitectures,
  canonicalEvidence,
  validateCanonicalLinuxRelease,
} from "../assert-canonical-linux-release.mjs";

const repositoryRoot = new URL("../../../../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, repositoryRoot), "utf8");
}

test("canonical Linux documentation declares the mkosi persistent workstation", async () => {
  const [readme, architecture] = await Promise.all([
    read("packages/os/linux/README.md"),
    read("packages/os/linux/docs/mkosi-v1-architecture.md"),
  ]);

  assert.match(readme, /accepted v1 product is a[\s\S]*mkosi/);
  assert.match(readme, /Tails, amnesia, Tor Privacy Mode, Cage/);
  assert.match(
    architecture,
    /persistent Debian 13 workstation assembled by mkosi/,
  );
  assert.match(
    architecture,
    /install-alongside flows for[\s\S]*Windows, macOS, and Linux/,
  );
  assert.match(architecture, /arbitrary-root `exec` method/);
  assert.match(
    architecture,
    /phone or web session may act as an authenticated remote/,
  );
});

test("release image schema accepts only raw zstd images for supported architectures", async () => {
  const schema = JSON.parse(
    await read("packages/os/release/schema/elizaos-image-manifest.schema.json"),
  );
  const properties = schema.$defs.artifact.properties;

  assert.deepEqual(properties.architecture.enum, [
    "x86_64",
    "arm64",
    "riscv64",
  ]);
  assert.equal(schema.properties.product.const, "elizaOS");
  assert.match(properties.url.pattern, /raw/);
  assert.match(properties.url.pattern, /zst/);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.ok(schema.$defs.artifact.required.includes("sha256Compressed"));
  assert.ok(schema.$defs.artifact.required.includes("sha256Expanded"));
  assert.ok(schema.$defs.artifact.required.includes("signatureUrl"));
});

test("desktop artifact contract requires one feature-complete shell on all architectures", async () => {
  const [schema, example] = await Promise.all([
    read(
      "packages/os/linux/schemas/desktop-artifact-manifest.schema.json",
    ).then(JSON.parse),
    read(
      "packages/os/linux/schemas/desktop-artifact-manifest.example.json",
    ).then(JSON.parse),
  ]);

  assert.deepEqual(schema.properties.architecture.enum, [
    "x86_64",
    "arm64",
    "riscv64",
  ]);
  assert.equal(schema.properties.shell.const, "gtk-webkit");
  assert.equal(example.shell, "gtk-webkit");
  for (const capability of schema.properties.capabilities.required) {
    assert.equal(example.capabilities[capability], true, capability);
  }
});

test("tracked candidate declares the complete signed canonical Linux set", async () => {
  const manifest = JSON.parse(
    await read("packages/os/release/v0.1.0-beta.1/manifest.json"),
  );
  assert.deepEqual(validateCanonicalLinuxRelease(manifest), []);
  assert.equal(
    manifest.artifacts.filter((artifact) => artifact.kind === "raw-image")
      .length,
    3,
  );
  assert.equal(
    manifest.artifacts.filter((artifact) => artifact.kind === "signature")
      .length,
    4,
  );
});

test("public release gate requires every qualified mkosi architecture and boundary", () => {
  const manifest = {
    release: { version: "1.0.0" },
    artifacts: [
      ...canonicalArchitectures.flatMap((architecture) => {
        const filename = `elizaos-1.0.0-${architecture}.raw.zst`;
        const source = { artifact: `linux-${architecture}` };
        return [
          {
            id: `linux-${architecture}`,
            kind: "raw-image",
            status: "candidate",
            target: { platform: "linux", architecture },
            filename,
            source: { ...source, pattern: "*.raw.zst" },
            validation: { requiredEvidence: canonicalEvidence },
          },
          {
            id: `linux-${architecture}-signature`,
            kind: "signature",
            status: "candidate",
            target: { platform: "linux", architecture },
            filename: `${filename}.sig`,
            source: { ...source, pattern: "*.raw.zst.sig" },
            validation: {
              requiredEvidence: [
                "ed25519-signature",
                "image-release-verified",
              ],
            },
          },
          {
            id: `linux-${architecture}-sbom`,
            kind: "sbom",
            status: "candidate",
            target: { platform: "linux", architecture },
            filename: `elizaos-1.0.0-${architecture}.spdx.json`,
            source: { ...source, pattern: "*.spdx.json" },
            validation: { requiredEvidence: ["syft-sbom"] },
          },
        ];
      }),
      {
        id: "linux-image-release-manifest",
        kind: "release-metadata",
        status: "candidate",
        target: { platform: "linux", architecture: "all" },
        filename: "elizaos-1.0.0-images.json",
        source: { artifact: "linux-metadata", pattern: "*.json" },
        validation: {
          requiredEvidence: ["ed25519-signature", "image-release-verified"],
        },
      },
      {
        id: "linux-image-release-manifest-signature",
        kind: "signature",
        status: "candidate",
        target: { platform: "linux", architecture: "all" },
        filename: "elizaos-1.0.0-images.json.sig",
        source: { artifact: "linux-metadata", pattern: "*.json.sig" },
        validation: {
          requiredEvidence: ["ed25519-signature", "image-release-verified"],
        },
      },
    ],
  };
  assert.deepEqual(validateCanonicalLinuxRelease(manifest), []);
  manifest.artifacts.find((artifact) => artifact.kind === "raw-image").validation.requiredEvidence = canonicalEvidence.slice(1);
  assert.match(
    validateCanonicalLinuxRelease(manifest).join("\n"),
    /must require mkosi-release-build evidence/,
  );
});

test("public release gate rejects legacy ISO candidates", () => {
  const errors = validateCanonicalLinuxRelease({
    release: { version: "1.0.0" },
    artifacts: [
      {
        id: "legacy",
        kind: "raw-image",
        status: "candidate",
        target: { platform: "linux", architecture: "amd64" },
        filename: "elizaos-live-amd64.iso",
        source: { artifact: "legacy", pattern: "*.iso" },
        validation: { requiredEvidence: [] },
      },
    ],
  });
  assert.ok(errors.some((error) => error.includes("x86_64 raw image")));
  assert.ok(errors.some((error) => error.includes("retired ISO")));
});
