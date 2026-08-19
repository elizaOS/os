# elizaOS OS CI/CD production status

Status snapshot: **locally release-gated, not yet remotely release-proven** as
of 2026-08-17. Do not cut a release until the required GitHub configuration is
present and the publish-disabled coordinator run is green with inspected
artifacts.

This repository is the release authority for OS images, installers, update
metadata, APT distribution, and their CI. Application and native-runtime source
remain owned by `elizaOS/eliza` and are consumed through the reviewed immutable
lock at `packages/os/release/eliza-source.lock.json`.

## Candidate release boundary

The checked candidate is `v0.1.0-beta.1`, described by
`packages/os/release/v0.1.0-beta.1/manifest.json`. Its current scope is a
digital beta containing:

- signed persistent mkosi images and filesystem SPDX SBOMs for `x86_64`,
  `arm64`, and `riscv64`;
- the three detached image signatures plus the signed discovery manifest;
- authenticated native Debian packages for `amd64`, `arm64`, and `riscv64`;
- signed Setup bundles for macOS, Linux, and Windows;
- a signed Linux USB Installer bundle with canonical `raw.zst` streaming and
  expanded-byte readback support;
- one manifest-bound `SHA256SUMS` file and GitHub artifact attestations.

Android images and physical USB commerce are not in this candidate. Add either
only through a reviewed manifest change backed by its real platform evidence.

## Release architecture

`elizaos-os-full-release.yml` is the sole GitHub Release writer. It is manual
and defaults to `publish=false`. Component workflows only build, validate,
attest, and upload Actions artifacts.

The coordinator performs these gates in order:

1. bind the requested tag, channel, tracked manifest, and source commit;
2. build, QEMU-qualify, sign, and independently verify all three mkosi images,
   then build Debian, Setup, and USB artifacts;
3. require every manifest-declared producer output exactly once;
4. populate and strictly validate one canonical release bundle;
5. generate deterministic checksums and verify filename, digest, size, and
   bytes agree one-to-one with the populated manifest;
6. attest the complete bundle;
7. rehearse APT signing against the current repository state and validate the
   GitHub Pages boundary without publishing it;
8. when and only when `sign=true` and `publish=true`, stage a verified draft
   GitHub Release, publish the signed APT branch and Pages deployment, then
   promote the exact draft after rechecking its tag and asset count.

Publication is protected by the `release` environment. Desktop signing and
APT credentials are mandatory for a publishing run. The signed Setup and USB
jobs conditionally bind that environment themselves, because a called reusable
workflow does not inherit the caller's environment; unsigned PR validation
does not request the environment. The administration steps are in
[os-release-admin-checklist.md](./os-release-admin-checklist.md).

## Cross-repository source and caching

All Eliza-consuming workflows read one immutable repository and commit pair
from `eliza-source.lock.json`. Source-verification jobs check out that exact
commit and recursively initialize Eliza-owned submodules; release producers
download and authenticate signed upstream artifacts bound to the same commit.
A scheduled/manual updater resolves the latest configured branch head and
opens a reviewable PR; release-time jobs never resolve a moving branch.

The lock currently resolves `elizaOS/eliza:develop` to
`5929de2162ecffa1fff069faabca65779d7dcb0f` (upstream commit timestamp
2026-08-18T04:42:14Z), which was the authenticated branch head at the latest
audit. The updater's tests assert the immutable lock shape rather than a stale
literal SHA, so future reviewed update PRs can pass CI while still forcing a
new source-qualified build.

CI caches are scoped to the inputs they accelerate:

- Bun's content-addressed download cache uses runner platform and the relevant
  frozen lockfiles, with a platform-scoped prefix fallback so a lockfile change
  reuses existing package archives and downloads only missing entries;
- Turbo caches cover source verification tasks;
- mkosi package downloads persist by immutable Debian snapshot timestamp and
  architecture, so multiple OS commits using the same snapshot reuse the same
  authenticated package bytes;
- Linux application artifacts use the Eliza commit and build inputs;
- live-build state uses the verified APT snapshot identity;
- Docker uses the GitHub Actions BuildKit cache;
- Gradle, Electrobun platform cores, VM upstreams, and RISC-V outputs have
  platform-specific caches.

The native lanes share a checksum-pinned Zig archive cache. Cuttlefish also
restores its costly fused-inference CMake state and staged libraries only on an
exact fingerprint of the Eliza commit, recursive submodule pins, native build
sources, requested target set, Zig version, Android NDK version, and workflow
revision; it deliberately has no prefix fallback that could turn stale native
bytes into a false green.

## Current verification evidence

The latest complete local source verification on 2026-08-17 passed:

- repository layout validation;
- 6 TypeScript typecheck tasks;
- 5 Biome lint tasks;
- 138 Node release/security tests with zero skips;
- 43 Bun workflow/Android contract tests;
- workflow authority/immutability contract tests;
- YAML parsing and whitespace/diff checks.

The Linux static boundary also passes the legacy live-image smoke suite, mkosi
contract lint, and 56 Python unit tests. This is source evidence only: the local
host has no mkosi binary and does not replace signed image or QEMU proof.

`actionlint` passes the complete current workflow set. The normal Linux verification job now
provisions actionlint 1.7.12 from a checksum-pinned upstream archive and runs it
as a required step, so the final workflow revision will receive a fresh lint
result on the PR head.

Setup and USB front-end builds and package tests pass locally. A macOS stable
Electrobun package reached disk-image creation, where local `hdiutil` failed
with `Device not configured`; the GitHub macOS signing/notarization job remains
the authoritative packaging boundary.

The homepage production bundle resolves its workspace-local Playwright binary,
declares the WebAuthn browser runtime dynamically imported by `@stwd/sdk`, and
pins Wrangler. Its Vite production build and 104 non-visual browser tests pass
locally, with two credential-gated live Steward tests skipped. The complete
visual run correctly fails because its macOS and Linux pixel baselines still
represent the retired four-artifact download page and older site styling.
Refresh and manually review both platform baseline sets before treating the
homepage lane as green; do not weaken or silently bypass that gate.

The USB suite passed 109 tests locally. Two block-device integration tests are
Linux-only and therefore do not run on a macOS workstation. The Linux CI lane
must execute them, including the privileged virtual-block-device test, before
release approval. The candidate manifest now requires package, browser E2E,
and virtual-block-device evidence for the Linux USB Installer.

Linux canonical `.raw.zst` execution now routes only through the signed
metadata pipeline: bounded download, descriptor-signature verification,
compressed digest verification, streaming decompression, privileged whole-disk
write, flush, and exact expanded-byte readback. The server enables this path
only for backends that explicitly advertise the complete capability. macOS and
Windows remain fail-closed so their legacy ISO writers cannot receive compressed
mkosi bytes; equivalent signed/elevated adapters and hardware evidence remain
release blockers for those platforms.

The main CI workflow now has a dedicated canonical Linux USB virtual-block job.
It creates an isolated removable `scsi_debug` device, serves a test-signed
`.raw.zst`, executes the real privileged streaming path, and independently
reads back the expanded bytes. Missing kernel-module infrastructure is a hard
failure, not a skipped or warning-only green. This workstation cannot execute
that Linux kernel boundary; the GitHub job is required evidence.

Release evidence is producer-bound rather than coordinator-declared. mkosi
assembly/QEMU, SBOM, Lintian, desktop package tests, browser/virtual-block
tests, signing, and SLSA claims are written only by their producing jobs after
the corresponding gates succeed. Every record binds the exact payload digest,
repository, source commit, workflow run, and attempt; release assembly rejects
name-only, missing, duplicate, stale, or byte-mismatched evidence.

## Remote state that still blocks a release

The most recent audited scheduled ISO run failed in the SeaBIOS/OVMF smoke
boundary after the expensive image build:
[run 31990977862](https://github.com/elizaOS/os/actions/runs/31990977862).
Its authenticated job log proves the ISO and BIOS boot completed and reached an
`amnesia` shell, but `elizaos-agent.service` never became active and
`127.0.0.1:31337` refused every health connection until timeout. The current
worktree adds Tails' VM-only remote-shell handshake and captures remote-shell
diagnostics, but that change is not boot evidence until a new Linux CI run is
green under both SeaBIOS and OVMF. The orchestration test now exercises the
remote-shell `signal_ready` and live-user probe protocol on hosts that permit
Unix-domain listening sockets; the restricted macOS workspace still exercises
the serial fallback and reports that integration boundary explicitly. Neither
local path is evidence that the ISO boots.

An authenticated repository-settings audit on 2026-08-17 found that the
required administration is not merely unconfirmed: `develop` has no branch
protection, no GitHub environments exist, GitHub Pages is disabled, Actions
cannot create pull requests, and there are no repository or environment
release secrets. GitHub currently allows all Actions but does not enforce
full-SHA pins; every checked-in external action is nevertheless pinned to a
full 40-character commit and a workflow contract now preserves that invariant.

The dead OVA and legacy ISO workflows have been removed; their source fixtures
remain only for regression tests. `build-linux-mkosi.yml` now owns the
canonical three-architecture assembly boundary: it authenticates the exact
pinned upstream GTK/WebKitGTK artifact, uses a dated Debian snapshot and
persistent package cache, QEMU-boots the expanded disk through removable USB,
generates an SPDX inventory from the read-only mounted root filesystem, signs
the complete image set, and independently verifies its discovery manifest.

That producer is intentionally only a partial qualification boundary. Its raw
image evidence records contain `mkosi-release-build`, `qemu-uefi-usb`,
`persistent-reboot`, `usb-expanded-readback`, and SLSA provenance. The virtual
USB lane writes and reads back every expanded byte, boots the same writable
disk twice, verifies first-boot home growth, and confirms a sentinel survives
the second boot. The release assembler still rejects promotion until jobs add
whole-disk and alongside installation, logged-in desktop acceptance, and
physical hardware qualification. The required protected native runner labels are
`elizaos-release-build` on x64, arm64, and riscv64 machines plus
`elizaos-release-signing` on the signing host. Those runners and their pinned
firmware directories are not configured remotely yet.

The Debian producer no longer builds missing application files from an Eliza
source checkout or labels native dependencies as `Architecture: all`. It
authenticates the same signed upstream artifact, preserves the complete payload
under `/opt/elizaos`, and emits distinct `amd64`, `arm64`, and `riscv64`
packages. APT rehearsal requires one package of the same version for every
architecture before signing repository metadata.

The pinned Eliza source also does not yet produce the required signed native
GTK/WebKitGTK artifacts named `elizaos-linux-desktop-{x86_64,arm64,riscv64}`.
The canonical workflow will fail before image assembly until an authenticated
upstream run supplies them; it cannot substitute the legacy kiosk or an
unsigned artifact.

At PR #16 head `29702105842761194fb4834fb6b9f8874d95d6c4`, OS verification
[run 32099913713](https://github.com/elizaOS/os/actions/runs/32099913713) and
release validation
[run 32099913757](https://github.com/elizaOS/os/actions/runs/32099913757)
completed successfully after an extended runner queue. Those green runs bind
only that pushed commit. The newer local fail-closed evidence, canonical-image,
USB virtual-block, and workflow-audit changes require their own PR-head runs;
do not transfer the older green status to unpushed bytes.

Before publishing, an administrator must provide or confirm:

- authenticated `elizaOS/os` Actions and artifact access;
- Actions permission to create pull requests;
- protected `develop` with the applicable required checks;
- protected `release` and `github-pages` environments;
- Pages configured to deploy through GitHub Actions;
- Apple, Windows, APT, release-image Ed25519, desktop-artifact trust, and
  cross-repository artifact credentials listed in the admin checklist;
- an approved candidate scope and tag;
- real three-architecture mkosi, Debian, installer, persistence, hardware, and
  platform-signing evidence from the coordinator rehearsal.

## Required remote sequence

1. Submit the scoped repository changes to `develop` through a PR.
2. Drive every applicable required check green; inspect failures at their real
   boundary rather than weakening or skipping them.
3. Dispatch `elizaOS Full OS Release` with:
   - the reviewed version tag;
   - a candidate manifest that passes `assert-canonical-linux-release.mjs`
     (the tracked beta candidate now declares this canonical asset set);
   - channel `beta`;
   - `sign=true`;
   - `publish=false`.
4. Download `elizaos-release-bundle` and the signed APT rehearsal. Verify
   checksums, attestations, signatures/notarization, mkosi QEMU/USB/persistence
   logs, Debian install/lintian, installer behavior, SBOM, hardware results, and
   failure-path evidence.
5. Re-run at the same reviewed commit with `sign=true` and `publish=true`. The
   coordinator stages a verified draft GitHub Release, publishes and deploys
   the signed APT repository, rechecks the exact tag and asset count, and only
   then makes the GitHub Release public.
6. From clean clients, verify the GitHub Release, Pages-hosted `InRelease`, APT
   signing fingerprint, package installation, and public download instructions.

Do not publish from an unverified working tree, substitute a floating Eliza
branch, allow missing artifacts, or turn a platform failure into
`continue-on-error` to make the release appear green.

## Deferred distribution work

The first beta deliberately does not claim true multi-architecture ISO support,
Android device support, mirrors/torrents, or confidential-compute hardware
support without their real build and boot evidence. Add those surfaces through
their own manifest records, reproducible inputs, signed metadata, and target
hardware or emulator proof.
