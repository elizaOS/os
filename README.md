# elizaOS OS

This repository owns elizaOS operating-system distributions. It is the
canonical home for the AOSP fork, the Debian-based live distribution,
installers, platform image tooling, and OS release automation.

## Repository layout

```text
packages/os/         OS source preserved at its original monorepo path
  android/           AOSP vendor tree, products, policy, and system UI
  linux/             Canonical Debian live images and package builds
  setup/             AOSP flashing application
  usb-installer/     Cross-platform USB imaging application
  homepage/          OS product and release site
  release/           Signed release manifests and schemas
  scripts/           Build, validation, and release orchestration
scripts/aosp/        AOSP compilation and staging helpers
scripts/distro-android/ Brand-aware AOSP orchestration
```

The framework, Android/iOS applications, native bridges, native plugins, and
local inference remain in [`elizaOS/eliza`](https://github.com/elizaOS/eliza).
Published application artifacts and `@elizaos/*` packages are the dependency
boundary consumed by OS image builds.

## Development

```bash
bun install
bun run build
bun run typecheck
bun run test
bun run verify:linux
```

Platform image builds require their native toolchains. See
`packages/os/android/README.md` and `packages/os/linux/README.md` for the AOSP,
Cuttlefish, Docker, QEMU, and live-build requirements. Set
`ELIZAOS_ELIZA_ROOT` to an `elizaOS/eliza` checkout when an image build consumes
application or native-plugin sources.

## Migration provenance

The initial split was produced from `elizaOS/eliza` commit
`069b3e9a1468c2cd1130792795481c0680f297ab`. `MIGRATION_MANIFEST.json` records
the source paths and content hashes used for the handoff.
