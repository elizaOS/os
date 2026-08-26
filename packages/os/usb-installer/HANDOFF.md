# elizaOS USB installer — implementation and blocker ledger

Updated: 2026-08-17

This file records current repository evidence only. Historical branch names,
pull requests, test counts, and paths from the former `elizaOS/eliza`
implementation were removed because this repository is now the release boundary
for OS images and installers.

## Implemented locally

- localhost-only renderer/backend contract with expiring, server-owned write
  plans and execute-time target re-enumeration;
- Linux, macOS, and Windows removable-device classification with stable hardware
  identity where the host exposes serial/WWN/unique device-tree identity;
- canonical HTTPS `.raw.zst` release metadata for x86_64, arm64, and riscv64;
- mandatory build-pinned Ed25519 release key, exact-byte signed-manifest
  verification, signed artifact descriptors, expiry, bounds, and compressed and
  expanded hashes;
- monotonic sequence state per channel/architecture with atomic replacement and
  a cross-process lock; missing configuration, corrupt state, mixed-sequence
  manifests, and rollback fail closed;
- a target-adapter-based streaming pipeline for bounded download, signature
  verification, zstd decompression, write, sync, exact expanded-byte readback,
  cancellation, and private temporary cleanup;
- a Linux whole-device adapter that is enabled only after execute-time device
  re-enumeration and unmount, streams expanded bytes through `pkexec`, `sudo`,
  or `doas`, flushes the device, and performs an exactly bounded privileged
  readback; the legacy direct-ISO path cannot receive a `.raw.zst` artifact;
- tests use in-memory targets, ordinary temporary files, or an opt-in disposable
  Linux `scsi_debug` device. Default tests never select a real disk.
- the renderer can cancel an active server-owned plan; the server consumes each
  destructive plan exactly once, locks both stable and device-path identities,
  aborts the canonical Linux streaming pipeline, terminates and awaits its
  privileged process group, and reports cancelled media as incomplete rather
  than successful. The renderer requires exactly one complete terminal event.

Canonical `.raw.zst` execution is enabled only when a backend advertises the
streaming/readback capability. Linux is the sole enabled backend. macOS and
Windows remain rejected by `write-safety.ts`; their existing platform writers
were designed for uncompressed ISO bytes and must not receive a compressed
mkosi artifact.

## Release runtime inputs

Production packaging/runtime must provide:

- `ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64` — public Ed25519 SPKI key;
- `ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256` — independently reviewed
  lowercase SHA-256 of that canonical DER SPKI;
- `ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S` — optional sorted,
  unique comma-separated list of revoked SPKI digests;
- `ELIZAOS_RELEASE_SEQUENCE_STATE_PATH` — absolute writable state-file path for
  source/server execution or a managed packaged-app override; standalone
  packaged apps provision a per-user Application Support/state path;
- `ELIZAOS_RELEASE_MANIFEST_URL` — optional override of the official HTTPS
  manifest URL;
- `ELIZAOS_RELEASE_MANIFEST_SIGNATURE_URL` — optional distinct HTTPS detached
  signature URL; otherwise `<manifest URL>.sig` is used.

`build:app` and every `package:*` command run `verify:release-key`. The build
embeds the public key, independent fingerprint, and revocation list in the Bun
bundle, and that compiled policy wins over a runtime environment override. A
stale, substituted, or revoked key fails packaging. No private key or
development trust root belongs in this repository.

The first missing sequence-state file is initialized from a verified manifest.
Deleting or replacing that user-writable file can erase rollback history; the
production installer must place and protect it with the platform's privileged
helper or another monotonic/attested store. A leftover `.lock` directory after
an unclean crash fails closed and currently requires an explicit recovery flow.

## Issues required before physical USB release

1. Move the Linux `RawImageTarget` adapter behind a narrowly authorized signed
   privileged helper and qualify its current `pkexec`/`sudo`/`doas` transport.
   Preserve execute-time serial/WWN, size, removable-status, current-boot
   ancestry, whole-device, flush, sync, and exactly bounded readback checks.
2. Keep the packaged Bun runtime at the configured 1.3.14 and run
   `test:packaged-runtime:macos -- <artifact>` for every macOS artifact. The
   smoke extracts only to a private temp directory and reruns Ed25519, zstd,
   mock-target readback, cancellation, and rollback-state tests under the exact
   embedded runtime. Add equivalent Linux and Windows artifact smokes.
3. Add macOS and Windows signed/elevated target adapters with the same stable-ID,
   flush, cancellation, and readback guarantees. Do not reuse the legacy ISO
   command paths for canonical releases.
4. Complete partial-write recovery beyond the implemented cancellation path:
   helper crash, unplug, I/O error, full device, corrupt flash, sleep, and power
   loss must never report success; add a safe filesystem restore operation.
5. Run the Linux virtual-block test against the canonical zstd pipeline, then
   run sacrificial physical-media tests on Intel/AMD Linux, Apple Silicon macOS,
   Intel macOS where supported, and Windows.
6. Verify expanded-byte readback, GPT primary/backup headers, UEFI boot, first
   persistent expansion, recovery boot, and internal installer launch for every
   published architecture/board claim.
7. Add equivalent packaged launch smokes on Linux and Windows. The macOS app now
   starts its loopback backend, serves the renderer and API on one origin, and
   provisions an explicit per-user rollback-state path; CI still needs restart
   and non-loopback exposure assertions on every packaged platform.

## Evidence commands

```bash
bun run --cwd packages/os/usb-installer typecheck
bun run --cwd packages/os/usb-installer lint:check
bun run --cwd packages/os/usb-installer test
bun run --cwd packages/os/usb-installer build
bun run --cwd packages/os/usb-installer test:e2e
bun run --cwd packages/os/usb-installer test:linux-virtual-usb
bun run --cwd packages/os/usb-installer test:packaged-runtime:macos -- <artifact>
```

`test:linux-virtual-usb` is Linux-only, requires passwordless `sudo -n` and
`scsi_debug`, and is not a substitute for physical boot evidence.

## macOS packaged-runtime evidence (2026-08-18)

- Electrobun selected and embedded the configured Bun 1.3.14 runtime in a fresh
  stable arm64 `.app.tar.zst`; `zstd -t` passed.
- `test:packaged-runtime:macos` passed under that exact runtime, covering the
  signed release boundary, streaming zstd, bounded in-memory write/readback,
  cancellation, cleanup, monotonic sequence state, packaged static/API routing,
  and per-user runtime-state configuration: 31 tests passed.
- The full Vitest suite passed: 13 files passed, 2 skipped; 116 tests passed, 2
  skipped. Typecheck, formatting, and Vite build also passed.
- Node-hosted Playwright driving the Vite server launched by the packaged Bun
  passed all 6 desktop/mobile tests. Playwright itself is intentionally not run
  under Bun: that unsupported runner arrangement stalled browser teardown even
  when the application had reached its successful completion screen.
- The corrected packaged app launched visibly on macOS, served its renderer from
  `127.0.0.1`, and enumerated seven internal Mac disks with every one classified
  `blocked-system`. The smoke supplied a temporary explicit rollback-state path
  and never enabled raw writes or selected a device.
- The unsigned diagnostic artifact used an ephemeral public key and was moved
  out of the repository after testing; it is not a production release input.
