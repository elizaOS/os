# AOSP device toolkit

These scripts deploy and smoke-test elizaOS AOSP images. Image orchestration is
canonical in `scripts/distro-android/`; the Android application, its native
inference compiler, and model staging remain in `elizaOS/eliza` under
`packages/app-core/scripts/aosp/`.

Set `ELIZAOS_ELIZA_ROOT` to an application-source checkout. CI checks out that
repository at `.eliza-source` and uses it as the default dependency boundary.

## Variant config

Add an `aosp` block to your host app's `app.config.ts`:

```ts
import type { AppConfig } from "@elizaos/app-core";

export default {
  appName: "Acme",
  appId: "com.acmecorp.acme",
  // ... other AppConfig fields ...

  aosp: {
    productLunch: "acme_cf_x86_64_phone-trunk_staging-userdebug",
    vendorDir: "acme",
    variantName: "AcmeOS",
    productName: "acme",
    packageName: "com.acmecorp.acme",
    appName: "Acme",
    commonMk: "vendor/acme/acme_common.mk",
    modelSourceLabel: "acme-download",
    bootanimationAssetDir: "os/android/vendor/acme/bootanimation",
  },
} satisfies AppConfig;
```

See `AospVariantConfig` in
`eliza/packages/app-core/src/config/app-config.ts` for the full
schema. Forks without an `aosp:` block don't ship an AOSP image; the
toolkit is inert.

## Scripts

| Script | What it does |
|---|---|
| `smoke-cuttlefish.mjs` | End-to-end agent smoke: APK installed, service starts, `/api/health` 200, bearer-token chat round-trip. |
| `cuttlefish-native-inference-smoke.sh` | Cross-compile retained application kernels and verify them on a running x86_64 Cuttlefish image. |
| `deploy-pixel.mjs` | Invoke the application compiler, build the OS image, and deploy to a connected Pixel/dev board. |

Each script accepts `--app-config <PATH>` to override
`apps/app/app.config.ts` for tests.

## Hardware requirements

- AOSP build: Linux x86_64, KVM, ≥30 GB RAM, ≥ 600 GB free disk.
- Application payload compilation: use the toolchain documented by the checked
  out `elizaOS/eliza` revision.
- Cuttlefish runtime: cuttlefish host package (`cvd`), `/dev/kvm`.
- Boot validation: `adb` on PATH or under `$ANDROID_HOME/platform-tools/`.
