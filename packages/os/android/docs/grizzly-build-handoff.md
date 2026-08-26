# Pixel 11 Pro build-lane handoff

This is the operator contract for the `grizzly` build lane. A successful build
is not hardware qualification; keep the target at candidate tier until the
physical-device matrix in `hardware-validation.md` is retained for the exact
bundle digest.

## Persistent builder

Use a dedicated Linux x86_64 host with at least 32 physical cores, 128 GiB RAM,
1.5 TB of fast local storage, and 600 GiB free at bundle start (64 cores,
256 GiB RAM, and 2 TB NVMe are preferred). Connect the phone through reliable
USB 3 and install udev rules
that grant the build operator access to `adb` and `fastboot` without running the
build as root.

Record the distribution image, kernel, CPU, RAM, storage model, filesystem,
OpenJDK 21, Python, Go, Rust, Bun, Node, repo, Git/Git LFS, adb/fastboot,
avbtool, EROFS tooling, and AOSP host-package versions alongside the retained
evidence. Raise file-descriptor and process limits for the build user, enable
time synchronization, and keep `out/` plus Siso/Soong caches on the local
NVMe. Back up only reproducible cache data. Signing keys, device credentials,
factory images, generated proprietary files, and build outputs must remain
outside Git.

Suggested persistent layout:

```text
/work/elizaos-os       release repository
/work/eliza            pinned application checkout
/work/aosp-grizzly     repo checkout and persistent out/
/work/bundles          immutable handoff bundles
/work/cache            downloaded source/tool caches
```

Capture host facts before the first build and after any toolchain change:

```bash
uname -a
cat /etc/os-release
lscpu
free -h
lsblk -o NAME,MODEL,SERIAL,SIZE,ROTA,TYPE,FSTYPE,MOUNTPOINTS
ulimit -a
java -version
python3 --version
go version
rustc --version
bun --version
node --version
adb version
fastboot --version
```

## Reproducible checkout and bundle

Open changes against `develop`, sync the branch before final verification, and
use the immutable locks in this repository. Do not substitute a newer factory
image, AOSP tag, `adevtool`, vendor-state commit, or application artifact.

```bash
bun install --frozen-lockfile
bun run verify

make -C packages/os/android bootstrap-grizzly \
  AOSP_GRIZZLY_ROOT=/work/aosp-grizzly
make -C packages/os/android preflight-grizzly \
  AOSP_GRIZZLY_ROOT=/work/aosp-grizzly
make -C packages/os/android prepare-grizzly \
  AOSP_GRIZZLY_ROOT=/work/aosp-grizzly

export SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)"
make -C packages/os/android bundle-grizzly \
  AOSP_GRIZZLY_ROOT=/work/aosp-grizzly \
  ELIZAOS_ELIZA_ROOT=/work/eliza \
  BUNDLE_DIR=/work/bundles/grizzly-"$(git rev-parse --short=12 HEAD)"
```

The bundle front door rebuilds and stages the privileged Eliza APK, completes
the complete `droidcore`/`dist` image set while running explicit
`host_init_verifier` and `check-vintf-all` gates and building `apksigner`,
`aapt2`, and `avbtool`. It retains a successful command receipt for every gate
and the corresponding product-output receipts, verifies
every referenced AVB image, validates the complete dynamic-super flash plan,
and rejects an unconditional userdata or metadata erase. The APK must contain
both application provenance records exactly once, match the pinned Eliza
commit, have the expected package name, and be signed by the platform
certificate in the checked-out AOSP tree.

The collector deliberately does not execute the mutable `repo` implementation.
Instead, it records and compares a deterministic pre/post snapshot containing
the manifest and repo-implementation commits plus every path and HEAD from
`.repo/project.list`, while rejecting unlocked project changes. It also
compares the locked overlays, generated Google vendor tree, synced elizaOS
vendor tree, OS commit, and Eliza commit. Large build inputs are copied from
stable non-symlink file descriptors into private staging before verification;
source or cross-file-set drift aborts the handoff. Output must be a new path
outside all three source trees under an operator-owned, non-shared canonical
parent. The complete bundle is written to a private same-filesystem staging
directory, verified and recursively synced, then published without replacing
an existing path. Failures remove only that verified staging identity rather
than leaving a partial bundle.

The manifest records the locked build identity, resolved AOSP project snapshot,
privileged-APK source and signing provenance, per-file hashes and sizes,
required host receipts, parsed flash plan, and builder
OS/kernel/capacity/tool/cache facts. `SHA256SUMS` covers every retained file.
Run a second isolated build with the same inputs and compare every
flash-artifact checksum before promotion. Environment evidence is expected to
differ when the isolated builder differs; unexplained artifact drift is a
release failure.

Production signing happens offline after this unsigned bundle passes host and
device qualification. Sign the exact `SHA256SUMS` bytes; never copy a private
key onto the builder or into CI.

## Flash and retained evidence

Before any destructive operation, verify the signed checksum file and capture
the phone serial, `fastboot getvar product`, bootloader version, active slot,
boot reason, lock state, and current stock-build identity. Keep the verified A9
factory archive available as the recovery path.

Pixel 11 uses dynamic partitions. Drive flashing from the bundled
`fastboot-info.txt`/flashall flow, including `reboot fastboot` and
`update-super`; do not use `fastboot flash system`. Do not erase userdata or
metadata unless the approved test plan explicitly requires it. Record every
command, exit status, pre/post device identity, and image digest.

After normal boot reaches `adb device`, retain post-fs-data/init markers,
properties, verified-boot and slot state, package/role ownership, screenshots,
logcat, and SELinux review. Run deterministic local text inference and the
retained-fixture ASR/TTS voice round trip, then complete every hardware,
recovery, reboot, OTA, and rollback item in `hardware-validation.md`. Remove
temporary init checkpoint probes and rebuild before promotion once the boot
stall is explained.
