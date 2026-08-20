# elizaOS OS beta release manifest

The `v0.1.0-beta.1` candidate manifest lives at
`packages/os/release/v0.1.0-beta.1/manifest.json`. It is the source of truth
for the digital files that the release coordinator must build, verify, and
publish. Commercial offers and Android images are separate scopes and are not
implicitly claimed by this digital beta.

## Required distribution classes

The candidate requires all of these classes:

- signed persistent mkosi images for `x86_64`, `arm64`, and `riscv64`;
- an SPDX JSON filesystem SBOM and detached image signature for each image;
- the signed image-discovery manifest consumed by the USB Installer;
- Debian application package;
- macOS, Linux, and Windows Setup bundles;
- a Linux USB Installer bundle. The macOS and Windows implementations remain
  validation-only until they support the canonical `raw.zst` write path and
  pass physical-media qualification.

Each entry binds a GitHub Actions artifact name and a basename pattern to one
canonical public filename. `assemble-release-bundle.mjs` rejects missing,
empty, ambiguous, symlinked, or path-escaping inputs. It then copies the exact
payload, records its size and SHA-256, assigns its tag-bound GitHub Release URL,
and requires all declared evidence before producing a publishable manifest.
Evidence names cannot be supplied by the coordinator. Each producing job must
upload exactly one `*.release-evidence.json` record per manifest artifact after
its validation and attestation steps succeed. The assembler verifies that the
record binds the exact subject filename, size, and SHA-256 as well as the
coordinator repository, source commit, workflow run, and run attempt. Missing,
duplicate, stale-run, wrong-commit, or wrong-byte records fail the release.

The tracked manifest describes the intended canonical files; it does not claim
that they have been produced. Each raw image requires clean mkosi assembly,
QEMU removable-USB boot, persistent reboot, expanded-byte writer readback,
whole-disk and alongside installation, desktop acceptance, and native hardware
qualification for the exact promoted digest. The current producer deliberately
records only the boundaries it actually runs, so assembly remains blocked
until the remaining qualification lanes exist and pass.

Android becomes release scope only when a candidate manifest explicitly adds
`android-image` to `release.requiredArtifactKinds` and the release coordinator
builds and validates its portable image archive. USB-key commerce becomes
scope only when the manifest contains a validated `commerce.usbKeyPresale`
block.

## Local validation

Validate the candidate contract:

```sh
node packages/os/scripts/validate-release-manifest.mjs \
  --manifest packages/os/release/v0.1.0-beta.1/manifest.json
```

Run the manifest, assembly, checksum, and TEE tests:

```sh
node --test packages/os/scripts/__tests__/*.test.mjs
```

The public bundle is assembled only by the manual `elizaOS Full OS Release`
workflow. Run it first with `publish=false`. Publication uses the same verified
bundle and is allowed only after the protected `release` environment approves
a second run with `publish=true`.
