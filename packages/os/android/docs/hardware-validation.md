# Android physical validation gate

Repository-side checks cannot promote a physical device. A release becomes
installable only after the exact source lock, licensed input, signed artifacts,
device identity, and retained runtime evidence all agree.

## Pixel 9a candidate

The public-source candidate is `tegu` on `android-15.0.0_r31`, build
`BD4A.250505.003`. Verify the manually license-accepted vendor archive before
building:

```bash
node scripts/aosp/verify-source-lock.mjs \
  --profile pixel9a \
  --aosp-root "$AOSP_ROOT" \
  --vendor-archive "$ELIZA_PIXEL_VENDOR_ARCHIVE" \
  --verify-vendor-tree --json
```

Build and deploy through `scripts/aosp/deploy-pixel.mjs`. The deploy command
re-applies the assistant role and IME after install, requires the full-engine
IME ASR result, and retains inspectable adb evidence in
`out/android-evidence/` (or `$ELIZA_ANDROID_EVIDENCE_DIR`).

The arm64 release path currently uses `android-arm64-cpu-fused`. The Vulkan
variant is excluded because it did not pass the Android/bionic native-loader
boundary; it must not replace the CPU artifact until a device run proves load,
model initialization, inference, and the failure path on the exact APK.

The candidate is not currently promotable: the pinned application catalog's
active Gemma ASR release has no published GGUF asset (`missing-from-hf-repo`).
Retired pre-Gemma artifacts may be used only for compatibility diagnosis; they
must not satisfy release evidence. The voice lane fails when ASR is skipped,
so publishing and digest-pinning the active artifact is an explicit external
prerequisite rather than a silent fallback.

The Cuttlefish workflow is fail-closed on the same boundary. Its no-mock voice
self-test must pass WAV → local ASR → local agent → local TTS, and its assistant
surface verifier runs with `--require-engine`. Consequently, a selected IME or
a successful deep-link alone cannot satisfy the full-engine gate while the
Gemma artifact is unavailable.

## Pixel 11 Pro generated candidate

`grizzly` is pinned in `pixel11pro.lock.json` to Android 17 r1, stock build
`CD1A.260714.001.A9`, exact `adevtool` and `vendor_state` commits, and the stock
kernel extraction path. The connected lab phone reports the same A9 build and
bootloader after its stock update, so that exact factory image is also the
rollback source. Do not downgrade to the phone's earlier C2 build after the A9
bootloader has run. Do not unlock or flash until the A9 archive verifies and
the A9-derived elizaOS images are retained.

Generate and verify the device layer before building:

```bash
node scripts/distro-android/prepare-grizzly.mjs \
  --aosp-root "$AOSP_ROOT" \
  --lock packages/os/android/pixel11pro.lock.json
```

This is generated device support, not a claim that Google published the
missing device tree or `spacecraft` kernel source. Promotion additionally
requires an exact-build compile, bootloader/slot capture, stock rollback drill,
and every physical validation item below.

The reproducible operator handoff is produced with `make bundle-grizzly` as
documented in the package README. Before flashing, independently verify
`SHA256SUMS`, its offline release signature, and the adjacent resolved AOSP
source manifest. Use the bundled `fastboot-info.txt`/flashall flow, including
fastbootd dynamic-super updates; a standalone system partition flash is not a
supported validation path.

## Promotion matrix

Before setting a release-manifest tier to `lab-validated`, retain all of:

- clean source checkout identities and signed artifact SHA-256 values;
- boot, display, touch, Wi-Fi, Bluetooth, cellular/SIM, audio/mic, camera,
  sensors, suspend/resume, charging, and physical-button results;
- Pixel long-press-power routing to the Eliza `ROLE_ASSISTANT` holder;
- full-engine voice IME mic → local ASR → committed-text evidence;
- HOME/assistant launch, local health/chat/inference, logcat, and SELinux denial
  review, including a deliberate failure canary;
- verified boot, recovery, OTA, both-slot boot, and rollback results.

The installer independently rechecks artifact bytes and `fastboot product` and
refuses every manifest below `lab-validated`.

## Light Phone III

`TLP301` remains blocked in `hardware-targets.json`. It must not receive a
product or installer alias until the vendor or an authorized maintainer
provides the missing unlock, device-tree, kernel, proprietary-input, and
recovery boundaries and the exact retail device passes this matrix.
