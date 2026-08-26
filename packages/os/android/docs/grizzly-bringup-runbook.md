# Pixel 11 Pro (grizzly) bring-up runbook

Status: device hangs at the static G logo with no adb when booting our images.
This runbook is the deterministic debug and verification plan: ranked
hypotheses, the decision tree that spends each phone-interaction cycle on the
experiment that eliminates the most hypothesis mass, and the tooling contract
that makes every flash attributable.

Companion tooling:

- `scripts/distro-android/grizzly-evidence.mjs` — capture evidence from any
  device state (`make evidence-grizzly`). Run it after EVERY boot attempt.
- `scripts/distro-android/verify-grizzly-artifacts.mjs` — attest images on the
  build host, verify sha256 on the flash host before fastboot. No unattested
  image is ever flashed again.
- `scripts/distro-android/prepare-grizzly.mjs` — probe/renderer/fstab stances
  are opt-in env vars recorded in a prepare stamp; `build-aosp.mjs` fails
  closed when the tree and env disagree.

## Symptom model — read this before proposing a fix

"Static G logo, no adb, no reboot, for minutes" is a narrow signature. These
failure classes REBOOT (to bootloader or recovery) rather than hang, so they
are ruled DOWN (not out) unless the screen was misread:

- SELinux policy compile failure → `InitFatalReboot` → bootloader loop.
- First-stage mount / dm-verity mismatch → `InitFatalReboot` → loop.
- Bootloader-level AVB rejection → visible error screen / drop to fastboot.
- Plain FBE mount failure → usually escalates to recovery's "Can't load
  Android system" prompt.

Watch the screen across a full 2 minutes to distinguish "static" from a fast
reboot loop (splash re-draws). `fastboot getvar all` before/after helps: a
climbing `slot-retry-count` means loop, not hang.

Failure classes that DO match a silent hang with no adb:

1. Second-stage init never executes (ELF page-size mismatch — see H1).
2. init alive but wedged before `post-fs-data` (apexd, vold, a `wait_for_prop`
   nothing satisfies). adbd cannot exist before apexd activates the
   `com.android.adbd` APEX, so "no adb" says nothing past this point.
3. init fully wedged inside `mount_all` (userdata contract mismatch).

## Ranked hypotheses (2026-08-26)

### H1 — CD1A device branch ≠ android-17.0.0_r1 platform (structural)

The only public Android 17 tag is `android-17.0.0_r1` = **CP2A.260605.016**.
The device shipped on **CD1A.260714.001.A9**, a Pixel-11 device branch Google
has NOT pushed to AOSP; per GrapheneOS it may only be rolled into 17 QPR2 or
Android 18. GrapheneOS — with complete grizzly vendor extraction at our
exact pins — still marks 11th-gen devices "[temporary] excluded" from
buildable targets and says:

- "Pixel 11 moved to post-quantum-secure cryptography for verified boot and
  added it for hardware keystores. We need to figure out if it shipped in
  AOSP already." (grapheneos.social/@GrapheneOS/117140338099164698)
- "We don't know if it will be feasible to support 11th gen Pixels prior to
  Android 17 QPR2 or even Android 18."
- Pixel 10a precedent: quirky device branches not matching standard AOSP
  releases caused "a lot of issues … due to mismatches."

Consequence: our CP2A-platform system against CD1A vendor/firmware can be
missing platform-side counterparts (keystore/AVB PQ support, HAL versions,
device-branch init changes) with no fix available on our side. This
hypothesis is not directly falsifiable by another flash — it is bounded by
evidence: pstore/UART output from Cycle 1 tells us HOW FAR init gets; if
early init dies inside stock-vendor components on any system image we can
produce (including the GSI cross-check), this is the answer, and the plan
becomes (a) mine pstore for the specific missing contract and patch it
platform-side, or (b) wait for the CD1A-era platform drop, tracking
GrapheneOS adevtool branch `17`.

### H2 — apexd failure or wedge

adbd lives in the `com.android.adbd` APEX; apexd runs at post-fs-data. An
APEX set mismatched against stock vendor (vendor APEXes on Android 17), or an
apexd crash, gives "init alive, no adb, no UI, no reboot" exactly. Evidence
channel: our kmsg phase markers — if pstore shows `post-fs-data reached` but
nothing after, apexd territory. Compare our system APEX list against the
Android 17 GSI's.

### H3 — userdata/metadata encryption contract (previous prime suspect)

The unconditional fstab rewrite that dropped `fileencryption=` /
`metadata_encryption=` / `keydirectory=` is now opt-in
(`ELIZAOS_GRIZZLY_CONSERVATIVE_F2FS=1`) and default builds keep the stock
fstab. Two live sub-risks remain:

- Stale `/metadata`: `fastboot -w` does NOT wipe /metadata. Stock-created
  `/metadata/vold/metadata_encryption` state against our system-side vold can
  wedge `mount_all`. Fix experiment: `fastboot erase metadata` + `fastboot -w`
  together (destroys stock /data irrecoverably — intended during bring-up).
- 16 KiB interaction: if the kernel is 16 KiB-page, f2fs REQUIRES block size
  == page size, so userdata must be formatted 16 KiB. Host-side `fastboot -w`
  formats with platform-tools' `make_f2fs` — verify platform-tools ≥ 35.x and
  that it honors the device's reported block size; otherwise format from the
  device (recovery factory reset), never from the host.

### H4 — init .rc bootstrap divergence

Android 17 consolidated early triggers (e.g. single `load-bpf-programs`).
The probe file is imported separately, gated by `ro.debuggable=1`, and linted.
It adds only marker writes: stock module-readiness waits, secure-storage
ordering, USB triggers, and canonical init phases remain unchanged. No `start
adbd` is attempted before apexd.

### H5 — sepolicy version claim

`normalizeGeneratedVintf` rewrites the vendor manifest sepolicy version
202604 → 202704 so `assemble_vintf` passes at build time. The vendor CIL is
still 202604-vintage; at boot init selects the compat mapping by this
declared version. If the hang were a policy failure we would expect a reboot
loop, not a hang — but a wrong compat selection can also surface as denials
that wedge early services. Preferred fix: keep the true 202604 version and
make the build accept it (Android 17 system ships compat mappings for prior
versions); treat the current rewrite as provisional.

### H6 — SurfaceFlinger / RenderEngine (DOWNGRADED, with a proven target)

Both renderer tombstone experiments were confounded (`graphite=true` routes
to GraphiteVk regardless of the backend property; the first "Vulkan" image
actually packaged GL). More importantly: a SurfaceFlinger crash leaves adbd
alive — it cannot explain "no adb". Do not spend reboots here until pstore
shows init passing `boot` with markers intact and adb absent anyway.

When graphics DOES become the frontier, the only community-proven custom-ROM
config on PowerVR Pixels is LineageOS laguna (Pixel 10):
**`debug.renderengine.backend=skiaglthreaded` on the native PowerVR EGL
(`ro.hardware.egl=powervr`), Graphite off, ANGLE installed but not forced.**
PowerVR ships a native GLES/EGL driver — it is not Vulkan-only. Stock
grizzly runs Graphite + `persist.graphics.egl=angle`; the Lineage stance is
the fallback experiment if stock-config SurfaceFlinger crashes on our build.
Renderer A/B experiments are only meaningful via
`ELIZAOS_GRIZZLY_RENDERENGINE_BACKEND` / `_GRAPHITE` (and an EGL-selection
override if we add one) with the prepare-stamp + attestation chain proving
what was flashed.

### Ruled out

- **16 KiB page size**: stock grizzly reports
  `ro.product.build.16k_page.enabled = false` (vendor_state grizzly.json) —
  the device runs 4 KiB pages. GrapheneOS's `PRODUCT_NO_BIONIC_PAGE_SIZE_MACRO`
  in the malibu config is page-agnostic hygiene, not evidence of a 16 KiB
  kernel. The attestation ELF-alignment check stays (cheap, future-proofs
  QPR 16 KiB migrations); the `getconf PAGE_SIZE` evidence capture stays as
  confirmation.

## Decision tree — maximum information per reboot cycle

Every cycle: flash only attested images (`verify-grizzly-artifacts.mjs
check`), pin the slot (`--slot a` now also plans `--set-active=a`), and run
`make evidence-grizzly` after every state change.

**Cycle 0 — free, no reboot:**

- In bootloader: `fastboot oem list-oem-cmds`, `fastboot oem last_dmesg`
  (both now captured by `grizzly-evidence.mjs`). `last_dmesg` after a forced
  reboot out of the hang can name the culprit outright with no cable and no
  recovery.
- From any shell ever obtained: `getconf PAGE_SIZE` (auto-captured;
  expected 4096 per stock `ro.product.build.16k_page.enabled=false`).
- On the flash host: `--android-info` preflight against stock requirements —
  `version-bootloader=spacecraft-17.4-15938155`,
  `version-baseband=a900a-MP_260716-260716-M-15880348`,
  `partition-exists=vendor_kernel_boot` (from the adevtool vendor-skel
  `firmware/android-info.txt`). A stale bootloader/baseband invalidates
  every later conclusion.

**Cycle 1 — evidence conversion (one reboot):**
`fastboot oem uart enable`, reproduce the hang; or without the SBU cable:
force-reboot out of the hang, immediately `fastboot oem last_dmesg`, then
boot to recovery and pull `/sys/fs/pstore/console-ramoops-0` (evidence
script captures it). Read the kmsg phase markers:

- No `elizaos-init: early-init reached` → failure before vendor init parses
  (page size, first-stage). H1.
- Markers stop at `post-fs` / `mount_all --late` → userdata contract. H3.
- Markers stop at `post-fs-data` → apexd. H2.
- All markers present incl. `boot reached`, still no adb → adbd APEX / USB
  config. H2/H4.
- Tombstone with `Client API: OpenGL_ES` AND adb was alive → only then H6.

**Cycle 2 — bisection via GSI (one flash-free boot):**
Boot the official Android 17 GSI through DSU Loader (Settings → Developer
options) on STOCK firmware — no flashing, no metadata risk.

- GSI boots → device side is fine; fault is inside our system image (APEX
  set, sepolicy content, init edits, our prebuilts). Diff our image vs GSI.
- GSI hangs the same way → strong H1 confirmation: the android-17.0.0_r1
  (CP2A) platform generation cannot drive CD1A vendor/firmware, and there is
  NO public AOSP tag matching CD1A (the device branch is unpublished — see
  H1). The GSI officially validates only through Pixel 10. In that world,
  stop iterating system-side fixes and work the H1 plan.

**Cycle 3 — encryption-state reset (one flash):**
`fastboot erase metadata` + `fastboot -w` + attested images. Boots → H3
confirmed; encode `erase metadata` into the installer flow for
stance-changing flashes.

**Cycle 4 — partition bisection:**
Attested build but substitute stock `system_ext`/`product` (then vice versa)
to isolate which of our partitions kills boot. Confirm `fastboot getvar all`
partition inventory against the stock flash-all set (missing/new partitions,
`vbmeta_system`/`vbmeta_vendor` coverage).

## Determinism contract (what must never happen again)

1. **No unattested flash.** The build host runs `verify-grizzly-artifacts.mjs
   attest` (fails closed on stamp/staging mismatch, stale image mtimes,
   misaligned ELFs) and ships `grizzly-artifacts.json`; the flash host runs
   `check` before fastboot. The "skiavkthreaded image that was actually GL"
   class of error dies here.
2. **No ambiguous slot.** `--slot` implies `--set-active`; evidence capture
   records `current-slot` + retry counters every time.
3. **No stance drift.** Probe/renderer/fstab stances live only in
   `ELIZAOS_GRIZZLY_*` env vars, recorded in the prepare stamp, enforced by
   `assertPreparedTreeMatchesEnv` at build and printed by the attestation
   check at flash time.
4. **No evidence loss.** Every boot attempt ends with `make evidence-grizzly`
   into `reports/grizzly-evidence/<timestamp>/`. Absence of a surface is
   recorded, never inferred.
5. **No fabricated conclusions.** A probe that could not run (marker file
   lacking sepolicy, adbd before apexd) is non-evidence — the probe design
   must prove its own delivery channel (kmsg → pstore is the only trusted
   early channel).

## External state (2026-08-26)

- **Nobody has publicly booted AOSP on grizzly.** GrapheneOS is furthest
  along — full 11th-gen adevtool configs (`bbc05913`, 2026-08-16), vendor
  skeletons (`91763c1f`) and vendor_state (`afd6a0c9`, both 2026-08-22) at
  exactly our pins — and still commented 11th-gen out of their buildable
  device list (`b396d943`) citing the CD1A/QPR2 platform gap and
  post-quantum verified-boot/keystore crypto (see H1). No LineageOS, CalyxOS,
  XDA, or independent grizzly tree exists. Watch: `GrapheneOS/adevtool`
  branch `17`, `GrapheneOS/vendor_state`, forum thread
  discuss.grapheneos.org/d/41350, os-issue-tracker #8518, and a future
  `device_google_spacecraft-kernels_6.12` repo.
- 11th-gen codenames: cubs = Pixel 11, **grizzly = Pixel 11 Pro**,
  kodiak = Pixel 11 Pro XL, yogi = Pixel 11 Pro Fold. Gen-10:
  rango/mustang/blazer/frankel. Titan-M3 firmware codename "epic".
  Gen-11 fastboot `MAX_DOWNLOAD_SIZE` doubled to 0x20000000 (512 MiB).
- Kernel: platform "spacecraft", Linux 6.12; source not yet published
  anywhere (GrapheneOS must request it via Google's opensource form; arrives
  as a history-less tarball). The stock factory kernel + stock boot chain is
  therefore the only kernel strategy; factory build `CD1A.260714.001.A9` is
  pinned in `pixel11pro.lock.json`.
- Boot chain intel from rooting threads: Magisk/KernelSU patch `init_boot`,
  APatch patches `boot` (same as gen-8+); cross-device/cross-build
  `init_boot` gives "device is corrupt" loops — never mix builds.
- Stock grizzly facts (vendor_state grizzly.json): `ro.board.platform=malibu`,
  `ro.product.first_api_level=37`, 64-bit-only zygote, erofs system
  partitions, 4 KiB pages, `/dev/pvrsrvkm` + `pvrsrvkm.ko` (PowerVR CXTP),
  `ro.hwui.use_vulkan=true`, Graphite + ANGLE selected via sysprops. Pixel 10
  Lineage precedent for encryption props:
  `ro.crypto.volume.options=aes-256-xts:aes-256-hctr2`,
  `ro.crypto.metadata_init_delete_all_keys.enabled=true`.
- GPU: GL reaches the device through ANGLE on stock, but a native PowerVR
  EGL/GLES driver exists (`ro.hardware.egl=powervr` on Lineage laguna). The
  EGL loader has no fallback if `persist.graphics.egl=angle` with ANGLE
  absent; the prepare step fails closed on that combination.

## After first boot

1. Re-generate the tree with probes OFF (default env) and prove a clean boot
   from a probe-free attested build — probes are diagnostic, not shippable.
2. Re-verify that stock module/storage ordering remains unchanged (H4).
3. Replace the sepolicy 202704 claim with a real 202604 compat path (H5).
4. Eliza launcher validation: `deploy-pixel.mjs` resolves the APK from
   `out/target/product/grizzly` (device dir, not product name) — then
   `adb shell cmd package resolve-activity -c android.intent.category.HOME`
   must resolve to `ai.elizaos.app`, and a HOME-press screenshot goes into
   the evidence bundle.
5. Record flash/boot evidence bundle per `hardware-targets.json` before any
   installer eligibility change.
