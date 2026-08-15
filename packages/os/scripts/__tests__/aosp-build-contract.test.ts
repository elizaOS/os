/** Verifies Android build-host and clean-checkout front-door contracts. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs as parseDeployArgs,
  resolveBuiltPrivilegedApk,
} from "../../../../scripts/aosp/deploy-pixel.mjs";
import { parseSmokeArgs } from "../../../../scripts/aosp/smoke-cuttlefish.mjs";
import { assertBuildHost } from "../../../../scripts/distro-android/build-aosp.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));

describe("AOSP build contracts", () => {
  test("the Make front door rebuilds the privileged APK", () => {
    const makefile = readFileSync(
      join(repositoryRoot, "packages/os/android/Makefile"),
      "utf8",
    );

    expect(makefile).toContain("--rebuild-privileged-apk");
    expect(makefile).toContain("ELIZA_BUN_RISCV64_OPTIONAL=1");
    expect(makefile).toContain("filter riscv64,$(ARCH)");
    expect(makefile).toContain("native-inference");
    expect(makefile).toContain("$(HERE)/../../..");
    expect(makefile).not.toContain("$(HERE)/../../../..");
    expect(makefile).toContain("android-arm64-vulkan-fused");
    expect(makefile).toContain("android-x86_64-cpu-fused");
    expect(makefile).toContain("android-riscv64-cpu-fused");
    expect(makefile).toContain("--assets-dir");
    expect(makefile).toContain("ELIZA_MTP_ANDROID_LIBDIR");
    expect(makefile).toContain("ELIZA_MTP_ANDROID_LIBDIR_X86_64");
    expect(makefile).toContain("ELIZA_MTP_ANDROID_LIBDIR_RISCV64");
  });

  test("Pixel deployment uses the OS brand contract accepted by build-aosp", () => {
    const deploySource = readFileSync(
      join(repositoryRoot, "scripts/aosp/deploy-pixel.mjs"),
      "utf8",
    );
    const parsed = parseDeployArgs([
      "--brand-config",
      "scripts/distro-android/brand.eliza-tegu.json",
      "--dry-run",
    ]);

    expect(parsed.brandConfig).toBe(
      "scripts/distro-android/brand.eliza-tegu.json",
    );
    expect(deploySource).not.toContain('"--skip-libllama", // step 1');
    expect(deploySource).not.toContain('aospArgs.push("--app-config"');
    expect(deploySource).toContain('"--brand-config"');
    expect(deploySource).toContain('"android-arm64-vulkan-fused"');
    expect(deploySource).toContain("ELIZA_BUN_RISCV64_OPTIONAL");
    expect(deploySource).toContain("ELIZA_MTP_ANDROID_LIBDIR");
    expect(deploySource).toContain("ELIZA_MTP_ANDROID_LIBDIR_X86_64");
    expect(deploySource).toContain("ELIZA_MTP_ANDROID_LIBDIR_RISCV64");

    const teguBrand = JSON.parse(
      readFileSync(
        join(repositoryRoot, "scripts/distro-android/brand.eliza-tegu.json"),
        "utf8",
      ),
    );
    expect(teguBrand.cuttlefishMakefile).toBe("eliza_tegu_phone.mk");
    expect(teguBrand.aospDeviceTreePaths).toEqual([
      "vendor/eliza/products/eliza_pixel_phone.mk",
      "device/google/tegu/aosp_tegu.mk",
    ]);
  });

  test("device smoke accepts an OS-owned package identity", () => {
    expect(
      parseSmokeArgs([
        "--package-name",
        "ai.elizaos.app",
        "--app-name",
        "Eliza",
        "--expected-abi",
        "arm64-v8a",
      ]),
    ).toMatchObject({
      packageName: "ai.elizaos.app",
      appName: "Eliza",
      expectedAbi: "arm64-v8a",
    });
  });

  test("Pixel deployment selects only the product platform-signed APK", () => {
    expect(
      resolveBuiltPrivilegedApk({
        aospRoot: "/aosp",
        productName: "eliza_tegu_phone",
        env: {},
      }),
    ).toBe(
      "/aosp/out/target/product/eliza_tegu_phone/system/priv-app/Eliza/Eliza.apk",
    );
    expect(
      resolveBuiltPrivilegedApk({
        aospRoot: "/aosp",
        productName: "eliza_tegu_phone",
        env: { OUT_DIR: "/build/aosp-out" },
      }),
    ).toBe(
      "/build/aosp-out/target/product/eliza_tegu_phone/system/priv-app/Eliza/Eliza.apk",
    );

    const deploySource = readFileSync(
      join(repositoryRoot, "scripts/aosp/deploy-pixel.mjs"),
      "utf8",
    );
    expect(deploySource).not.toContain('"find",');
    expect(deploySource).toContain(
      "unsigned vendor input cannot be sideloaded",
    );
  });

  test("Cuttlefish pins application and native-runtime build inputs", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/elizaos-cuttlefish.yml"),
      "utf8",
    );

    expect(workflow).toContain(
      'default: "53da01c6d02c022e3a3593cf9b92633ff5b1c6d6"',
    );
    expect(workflow).toContain("Provision pinned Zig 0.13");
    expect(workflow).toContain("ndk;29.0.13113456");
    expect(workflow).toContain(
      "d45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea",
    );
    expect(workflow).toContain("Build fused Android inference libraries");
    expect(workflow).toContain("bun-riscv64-sha256");
    expect(workflow).toContain("ELIZA_BUN_RISCV64_OPTIONAL=1");
    expect(workflow).toContain("ELIZA_MTP_ANDROID_LIBDIR_X86_64");
    expect(workflow).toContain("ELIZA_MTP_ANDROID_LIBDIR_RISCV64");
  });

  test("source-only AOSP builds do not require KVM", () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    expect(() =>
      assertBuildHost({
        brand: { distroName: "elizaOS", productName: "eliza_cf_x86_64_phone" },
        launch: false,
        kvmPath: "/definitely/missing/kvm",
      }),
    ).not.toThrow();
  });

  test("riscv64 Cuttlefish uses TCG and does not require KVM", () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    expect(() =>
      assertBuildHost({
        brand: { distroName: "elizaOS", productName: "eliza_cf_riscv64_phone" },
        launch: true,
        kvmPath: "/definitely/missing/kvm",
      }),
    ).not.toThrow();
  });

  test("accelerated Cuttlefish launch fails closed without KVM", () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    expect(() =>
      assertBuildHost({
        brand: { distroName: "elizaOS", productName: "eliza_cf_x86_64_phone" },
        launch: true,
        kvmPath: "/definitely/missing/kvm",
      }),
    ).toThrow("Cuttlefish launch requires /dev/kvm");
  });
});
