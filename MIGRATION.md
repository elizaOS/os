# Migration contract

The repository was split from `elizaOS/eliza` so operating-system distribution
ownership has one release boundary. Android/iOS application code and its native
plugins remain in the source monorepo.

## Source ownership moved here

- `packages/os/**` → unchanged under `packages/os/**`
- AOSP device deployment, Cuttlefish smoke, and OS shim sources from
  `packages/app-core/scripts/aosp/**` → `scripts/aosp/**`
- OS-only RISC-V CMake toolchains from `packages/native/cmake/**` →
  `packages/os/toolchains/cmake/**`
- Bun RISC-V runtime source-build tooling from
  `packages/app-core/scripts/bun-riscv64/**` →
  `packages/os/toolchains/bun-riscv64/**`
- `packages/app-core/packaging/debian/**` →
  `packages/os/linux/packaging/debian/**`
- AOSP, Debian/live-image, VM-image, USB-installer, RISC-V, and OS
  release workflows → `.github/workflows/**`

Android/iOS app projects, native plugins, local inference, and the Android app
compiler/model-staging scripts remain in `elizaOS/eliza`. Those app-side
scripts consume OS-owned build artifacts through `ELIZAOS_OS_REPO_ROOT` or
explicit artifact URLs; they do not own image or distro toolchains.

The retained AOSP-named plugin files are application runtime adapters: the
Capacitor privileged bridge, computer-use input actor, and local-inference FFI
loader. `scripts/verify-eliza-source-boundary.mjs` classifies those exact paths,
requires the Android/iOS/native app trees to remain, and rejects new unreviewed
OS-named plugin or native paths. It also rejects source CI references to the
moved OS release workflows.
Source workspace metadata, ignore files, and repository guides are checked as
well, so `packages/os` cannot silently return as a local workspace or build
artifact root.

## Cross-repository ordering

1. Create `elizaOS/os` from this payload and protect `main`/`develop`.
2. Point image assembly at published application artifacts and packages from
   `elizaOS/eliza`.
3. Merge the `elizaOS/eliza` removal PR after cross-repository image inputs are proven.
4. Enable OS image/release workflows only after repository environments,
   signing identities, and release secrets have been recreated.

The content manifest is generated after verification and binds each migrated
file to the source commit and SHA-256 digest.
