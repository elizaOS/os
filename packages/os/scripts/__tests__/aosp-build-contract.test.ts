/** Verifies Android build-host and clean-checkout front-door contracts. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPhysicalTargetContract,
  parseArgs as parseDeployArgs,
  resolveBuiltPrivilegedApk,
} from "../../../../scripts/aosp/deploy-pixel.mjs";
import { parseSmokeArgs } from "../../../../scripts/aosp/smoke-cuttlefish.mjs";
import {
  assertExtractedVendorTree,
  loadAospLock,
  parseBootstrapArgs,
  verifyProprietaryArchive,
} from "../../../../scripts/distro-android/bootstrap-aosp.mjs";
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
    expect(makefile).toContain("android-arm64-cpu-fused");
    expect(makefile).not.toContain("android-arm64-vulkan-fused");
    expect(makefile).toContain("android-x86_64-cpu-fused");
    expect(makefile).toContain("android-riscv64-cpu-fused");
    expect(makefile).toContain("--assets-dir");
    expect(makefile).toContain("bootstrap-aosp.mjs");
    expect(makefile).toContain("provision-repo.sh");
    expect(makefile).toContain('--repo-bin "$(REPO_LAUNCHER)"');
    expect(makefile).toContain("stage-elizavoice-lib.mjs");
    expect(makefile).not.toContain("ELIZA_MTP_ANDROID_LIBDIR");
  });

  test("the full AOSP checkout has an immutable bootstrap lock", () => {
    expect(loadAospLock()).toEqual({
      schemaVersion: 1,
      manifestUrl: "https://android.googlesource.com/platform/manifest",
      manifestRevision: "android-17.0.0_r1",
      manifestTagObject: "7a9e46ba6ed424f922a3457f4964e67e0b966201",
      manifestCommit: "5bc9a7ce1cd78dd53613bbfd0ebf506e1e4adb0f",
    });
    expect(
      parseBootstrapArgs([
        "--aosp-root",
        "/tmp/aosp",
        "--jobs",
        "3",
        "--repo-bin",
        "repo",
        "--init-only",
      ]),
    ).toMatchObject({
      aospRoot: "/tmp/aosp",
      jobs: 3,
      initOnly: true,
      repoBin: "repo",
    });
    expect(() =>
      parseBootstrapArgs(["--aosp-root", "/tmp/aosp", "--jobs", "0"]),
    ).toThrow("--jobs must be an integer from 1 through 256");
    expect(() =>
      parseBootstrapArgs(["--aosp-root", "/tmp/aosp", "--jobs", "2x"]),
    ).toThrow("--jobs must be a positive integer");

    const repoProvisioner = readFileSync(
      join(repositoryRoot, "scripts/distro-android/provision-repo.sh"),
      "utf8",
    );
    expect(repoProvisioner).toContain(
      'repo_url="https://storage.googleapis.com/git-repo-downloads/repo"',
    );
    expect(repoProvisioner).toContain(
      'repo_sha256="1211b57b57e4122a9c546295a59b37d24068f1164d0e87bef096d5323c413e4f"',
    );
  });

  test("licensed Pixel vendor inputs are verified by bytes, digest, and extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "elizaos-pixel-contract-"));
    try {
      const bytes = Buffer.from("licensed vendor fixture");
      const filename = "vendor-fixture.tgz";
      const archivePath = join(root, filename);
      await writeFile(archivePath, bytes);
      const requiredPath = "vendor/google_devices/tegu/Android.bp";
      const lock = {
        proprietaryArchive: {
          filename,
          sizeBytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          requiredExtractedFiles: [requiredPath],
        },
      };

      await expect(
        verifyProprietaryArchive(lock, archivePath),
      ).resolves.toMatchObject({
        sizeBytes: bytes.byteLength,
        sha256: lock.proprietaryArchive.sha256,
      });
      expect(() => assertExtractedVendorTree(root, lock)).toThrow(
        "licensed vendor extraction is incomplete",
      );
      await mkdir(join(root, "vendor/google_devices/tegu"), {
        recursive: true,
      });
      await writeFile(join(root, requiredPath), "// fixture");
      expect(assertExtractedVendorTree(root, lock)).toEqual([requiredPath]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the AOSP product does not ship the unwired SystemUI bridge scaffold", () => {
    const common = readFileSync(
      join(repositoryRoot, "packages/os/android/vendor/eliza/eliza_common.mk"),
      "utf8",
    );
    expect(common).not.toContain("ElizaSystemBridge");
    expect(common).not.toContain("ai.elizaos.system.bridge");
    expect(
      existsSync(
        join(repositoryRoot, "packages/os/android/system-ui/package.json"),
      ),
    ).toBe(false);
  });

  test("the AOSP product does not ship placeholder confidential-compute claims", () => {
    const vendorRoot = join(repositoryRoot, "packages/os/android/vendor/eliza");
    const common = readFileSync(join(vendorRoot, "eliza_common.mk"), "utf8");
    const init = readFileSync(join(vendorRoot, "init/init.eliza.rc"), "utf8");

    for (const deadClaim of [
      "eliza_pvm_mgr",
      "tee-measurements.json",
      "tee-policy.json",
    ]) {
      expect(common).not.toContain(deadClaim);
      expect(init).not.toContain(deadClaim);
    }
    expect(existsSync(join(vendorRoot, "pvm_mgr"))).toBe(false);
    expect(existsSync(join(vendorRoot, "tee"))).toBe(false);
    expect(existsSync(join(vendorRoot, "sepolicy/eliza_pvm_mgr.te"))).toBe(
      false,
    );
  });

  test("the product menu exposes only source-pinned physical targets", () => {
    const products = readFileSync(
      join(
        repositoryRoot,
        "packages/os/android/vendor/eliza/AndroidProducts.mk",
      ),
      "utf8",
    );
    for (const absentTarget of [
      "openagent",
      "oriole",
      "panther",
      "shiba",
      "caiman",
    ]) {
      expect(products).not.toContain(absentTarget);
    }
    expect(products).toContain("eliza_tegu_phone");
    expect(
      existsSync(join(repositoryRoot, "packages/os/android/pixel9a.lock.json")),
    ).toBe(true);
    const inventory = JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/os/android/hardware-targets.json"),
        "utf8",
      ),
    ) as {
      targets: Array<{
        targetId: string;
        sourceStatus: string;
        installerEligible: boolean;
      }>;
    };
    expect(inventory.targets).toContainEqual(
      expect.objectContaining({
        targetId: "pixel9a-tegu",
        sourceStatus: "pinned",
        installerEligible: false,
      }),
    );
    const pixelLock = JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/os/android/pixel9a.lock.json"),
        "utf8",
      ),
    ) as {
      device: {
        productBrand: string;
        productName: string;
        codename: string;
        expectedFingerprintPrefix: string;
      };
    };
    const pixelProduct = readFileSync(
      join(
        repositoryRoot,
        "packages/os/android/vendor/eliza/products/eliza_tegu_phone.mk",
      ),
      "utf8",
    );
    const commonProduct = readFileSync(
      join(repositoryRoot, "packages/os/android/vendor/eliza/eliza_common.mk"),
      "utf8",
    );
    expect(pixelProduct).toContain(
      `PRODUCT_NAME := ${pixelLock.device.productName}`,
    );
    expect(pixelProduct).toContain(
      `PRODUCT_DEVICE := ${pixelLock.device.codename}`,
    );
    expect(commonProduct).toContain(
      `PRODUCT_BRAND := ${pixelLock.device.productBrand}`,
    );
    expect(commonProduct).toContain("PRODUCT_MANUFACTURER := elizaOS");
    expect(pixelProduct).not.toContain("PRODUCT_BRAND :=");
    expect(pixelProduct).not.toContain("PRODUCT_MANUFACTURER :=");
    expect(pixelLock.device.expectedFingerprintPrefix).toBe(
      `${pixelLock.device.productBrand}/${pixelLock.device.productName}/${pixelLock.device.codename}:`,
    );
    expect(
      existsSync(
        join(repositoryRoot, "scripts/distro-android/brand.openagent.json"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          repositoryRoot,
          "packages/os/android/vendor/eliza/products/eliza_openagent_ai_soc_phone.mk",
        ),
      ),
    ).toBe(false);
  });

  test("Pixel deployment uses the OS brand contract accepted by build-aosp", () => {
    const deploySource = readFileSync(
      join(repositoryRoot, "scripts/aosp/deploy-pixel.mjs"),
      "utf8",
    );
    const parsed = parseDeployArgs([
      "--brand-config",
      "/tmp/device-owner-supplied-brand.json",
      "--dry-run",
    ]);

    expect(parsed.brandConfig).toBe("/tmp/device-owner-supplied-brand.json");
    expect(deploySource).not.toContain('"--skip-libllama", // step 1');
    expect(deploySource).not.toContain('aospArgs.push("--app-config"');
    expect(deploySource).toContain('"--brand-config"');
    expect(deploySource).toContain('"android-arm64-cpu-fused"');
    expect(deploySource).not.toContain('"android-arm64-vulkan-fused"');
    expect(deploySource).toContain("ELIZA_BUN_RISCV64_OPTIONAL");
    expect(deploySource).toContain("stage-elizavoice-lib.mjs");
    expect(deploySource).not.toContain("ELIZA_MTP_ANDROID_LIBDIR");
    expect(deploySource).toContain("/api/asr/local-inference");
    expect(deploySource).toContain("/api/tts/local-inference");
    expect(deploySource).toContain('a === "--voice-only"');
    expect(deploySource).toContain('["forward", "tcp:0", "tcp:31337"]');
    expect(deploySource).not.toContain("/api/local-inference/voice-smoke");

    expect(
      loadPhysicalTargetContract(
        { aospLockPath: "packages/os/android/pixel9a.lock.json" },
        repositoryRoot,
      ),
    ).toMatchObject({
      targetId: "pixel9a-tegu",
      codename: "tegu",
      expectedFingerprintPrefix: "elizaOS/eliza_tegu_phone/tegu:",
    });
    expect(() =>
      loadPhysicalTargetContract(
        { aospLockPath: "../outside.json" },
        repositoryRoot,
      ),
    ).toThrow("physical target lock escapes");
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
        productName: "eliza_cf_arm64_phone",
        env: {},
      }),
    ).toBe(
      "/aosp/out/target/product/eliza_cf_arm64_phone/system/priv-app/Eliza/Eliza.apk",
    );
    expect(
      resolveBuiltPrivilegedApk({
        aospRoot: "/aosp",
        productName: "eliza_cf_arm64_phone",
        env: { OUT_DIR: "/build/aosp-out" },
      }),
    ).toBe(
      "/build/aosp-out/target/product/eliza_cf_arm64_phone/system/priv-app/Eliza/Eliza.apk",
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
    const sourceLock = JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/os/release/eliza-source.lock.json"),
        "utf8",
      ),
    ) as { commit: string };

    expect(sourceLock.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(workflow).toContain("read-eliza-source-lock.mjs --github-output");
    expect(workflow).toContain("Provision pinned Zig 0.13");
    expect(workflow).toContain('ANDROID_NDK_VERSION: "29.0.13113456"');
    expect(workflow).toContain("provision-zig-linux-x64.sh");
    expect(workflow).toContain("android-assistant-verify.mjs");
    expect(workflow).toContain(
      "Prove full WAV to ASR to agent to TTS round trip",
    );
    expect(workflow).toContain("--require-device --require-engine --json");
    expect(workflow).toContain("cuttlefish-android-validation");
    expect(workflow).toContain("Build fused Android inference libraries");
    expect(workflow).toContain("Verify fused Android inference artifacts");
    expect(workflow).toContain("verify-native-runtime.mjs");
    expect(workflow).toContain("Verify immutable Cuttlefish AOSP source lock");
    expect(workflow).toContain("verify-source-lock.mjs");
    expect(workflow).toContain("bun-riscv64-sha256");
    expect(workflow).toContain("ELIZA_BUN_RISCV64_OPTIONAL");
    expect(workflow).toContain("ELIZA_MTP_ANDROID_LIBDIR");
  });

  test("riscv64 QJL uses Zig-supported variable-length vector flags", () => {
    const driver = readFileSync(
      join(repositoryRoot, "scripts/build-riscv64-artifacts.sh"),
      "utf8",
    );

    expect(driver).toContain(
      'QJL_RVV="-DQJL_RVV_COMPILE_OPTIONS=-mcpu=generic_rv64+v+m+a+f+d+c"',
    );
    expect(driver).not.toContain(
      "QJL_RVV_COMPILE_OPTIONS=-mcpu=sifive_x280",
    );
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
