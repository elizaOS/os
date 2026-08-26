# Pixel 11 Pro build-lane handoff

This is the operator contract for the `grizzly` build lane. A successful build
is not hardware qualification; keep the target at candidate tier until the
physical-device matrix in `hardware-validation.md` is retained for the exact
bundle digest.

## Persistent builder

Use a dedicated Linux x86_64 host with at least 32 physical cores, 128 GB RAM,
and 1.5 TB of fast local storage (64 cores, 256 GB RAM, and 2 TB NVMe are
preferred). Connect the phone through reliable USB 3 and install udev rules
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
make -C packages/os/android prepare-grizzly \
  AOSP_GRIZZLY_ROOT=/work/aosp-grizzly

export SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)"
make -C packages/os/android bundle-grizzly \
  AOSP_GRIZZLY_ROOT=/work/aosp-grizzly \
  ELIZAOS_ELIZA_ROOT=/work/eliza \
  BUNDLE_DIR=/work/bundles/grizzly-"$(git rev-parse --short=12 HEAD)"
```

The bundle front door rebuilds and stages the privileged Eliza APK, completes
the full AOSP `dist` build while building `host_init_verifier` and `checkvintf`,
verifies AVB metadata, and refuses dirty source trees or any missing flash
input. It writes a resolved repo manifest, the exact OS and Eliza commits, the
locked build identity, APK provenance by digest, per-file hashes and sizes, and
the builder OS/kernel/capacity/tool/cache facts in the manifest. It then emits
`SHA256SUMS`. Run a second isolated build with the same inputs and compare every
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
