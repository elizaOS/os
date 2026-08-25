/** Verifies Android build-host and clean-checkout front-door contracts. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPhysicalTargetContract,
  parseArgs as parseDeployArgs,
  resolveBuiltPrivilegedApk,
} from "../../../../scripts/aosp/deploy-pixel.mjs";
import { parseSmokeArgs } from "../../../../scripts/aosp/smoke-cuttlefish.mjs";
import {
  assertExtractedVendorTree,
  assertGeneratedVendorTree,
  loadAospLock,
  parseBootstrapArgs,
  verifyProprietaryArchive,
} from "../../../../scripts/distro-android/bootstrap-aosp.mjs";
import { assertBuildHost } from "../../../../scripts/distro-android/build-aosp.mjs";
import { parseArgs as parseGrizzlyArgs } from "../../../../scripts/distro-android/prepare-grizzly.mjs";
import { withSisoCompatibility } from "../../../../scripts/distro-android/siso-env.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));

describe("AOSP build contracts", () => {
  test("Android 17 Siso builds tolerate generated missing targets", () => {
    expect(withSisoCompatibility({})).toMatchObject({
      SISO_EXPERIMENTS: "ignore-missing-targets",
    });
    expect(
      withSisoCompatibility({ SISO_EXPERIMENTS: "oom-score-adj" }),
    ).toMatchObject({
      SISO_EXPERIMENTS: "oom-score-adj,ignore-missing-targets",
    });
    expect(
      withSisoCompatibility({
        SISO_EXPERIMENTS: "ignore-missing-targets,oom-score-adj",
      }),
    ).toMatchObject({
      SISO_EXPERIMENTS: "ignore-missing-targets,oom-score-adj",
    });
  });

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
    const bootstrapSource = readFileSync(
      join(repositoryRoot, "scripts/distro-android/bootstrap-aosp.mjs"),
      "utf8",
    );
    expect(bootstrapSource).toContain('"--retry-fetches=5"');
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
    expect(products).toContain("eliza_grizzly_phone");
    expect(
      existsSync(join(repositoryRoot, "packages/os/android/pixel9a.lock.json")),
    ).toBe(true);
    const grizzlyLockPath = join(
      repositoryRoot,
      "packages/os/android/pixel11pro.lock.json",
    );
    expect(existsSync(grizzlyLockPath)).toBe(true);
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
    expect(inventory.targets).toContainEqual(
      expect.objectContaining({
        targetId: "pixel11pro-grizzly",
        sourceStatus: "pinned-generated",
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
    const grizzlyLock = loadAospLock(grizzlyLockPath);
    expect(grizzlyLock.device).toMatchObject({
      targetId: "pixel11pro-grizzly",
      codename: "grizzly",
      buildId: "CD1A.260714.001.A9",
      productName: "eliza_grizzly_phone",
    });
    expect(grizzlyLock.externalProjects).toHaveLength(2);
    expect(grizzlyLock.sourceOverlays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "tools/aapt2/BriefPackageInfo.proto",
          sourceCommit: "b2be3bb5f88bc5833dd4f9a11b3c295259ae733f",
          baseSha256: null,
        }),
        expect.objectContaining({
          path: "tools/aapt2/cmd/Dump.cpp",
          sha256:
            "1a0414d6af278aaf138d98c53d7fee10a185a480241d037e5748eb0465055518",
        }),
      ]),
    );
    expect(grizzlyLock.referenceFactoryImage).toMatchObject({
      sizeBytes: 15363261784,
      sha256:
        "86fb81516d54a21c28487745e748aee8e36847dc400a6ab40ef2458146b0becb",
    });
    expect(grizzlyLock.rollbackFactoryImage).toMatchObject({
      buildId: "CD1A.260714.001.A9",
      sha256:
        "86fb81516d54a21c28487745e748aee8e36847dc400a6ab40ef2458146b0becb",
    });
    expect(grizzlyLock.generatedVendor?.requiredFiles).toEqual(
      expect.arrayContaining([
        "vendor/google_devices/grizzly/proprietary/Android.bp",
        "vendor/google_devices/grizzly/stock-kernel/Image.lz4",
        "vendor/google_devices/grizzly/stock-kernel/modules.load",
        "vendor/google_devices/grizzly/stock-kernel/system_dlkm.modules.load",
        "vendor/google_devices/grizzly/stock-kernel/vendor_dlkm.modules.load",
        "vendor/google_devices/grizzly/stock-kernel/vendor_kernel_boot.modules.load",
      ]),
    );
    expect(grizzlyLock.generatedVendor?.requiredArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "vendor/google_devices/grizzly/stock-kernel/Image.lz4",
          sizeBytes: 20230712,
          sha256:
            "b456e2b874e4cc2a2fd208d4c7e4bd2fd52dc29c6727fb81052d16bc8da86ae3",
        }),
        expect.objectContaining({
          path: "vendor/google_devices/grizzly/stock-kernel/dtbo.img",
          sizeBytes: 16777216,
          sha256:
            "f906ba29c87ce26fed65f206119a147f8e810dab2be500a3470639fc4eef32ce",
        }),
      ]),
    );
    const grizzlyProduct = readFileSync(
      join(
        repositoryRoot,
        "packages/os/android/vendor/eliza/products/eliza_grizzly_phone.mk",
      ),
      "utf8",
    );
    expect(grizzlyProduct).toContain("USE_STOCK_KERNEL := true");
    expect(grizzlyProduct).toContain(
      "vendor/google_devices/grizzly/grizzly.mk",
    );
    expect(grizzlyProduct).toContain("PRODUCT_NAME := eliza_grizzly_phone");
    expect(
      parseGrizzlyArgs(["--aosp-root", "/tmp/aosp-grizzly"]),
    ).toMatchObject({
      aospRoot: "/tmp/aosp-grizzly",
      lockPath: grizzlyLockPath,
      skipInstall: false,
      skipRollbackDownload: false,
    });
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

  test("generated Pixel support verifies pinned firmware text invariants", async () => {
    const root = await mkdtemp(join(tmpdir(), "elizaos-grizzly-contract-"));
    try {
      const lock = loadAospLock(
        join(repositoryRoot, "packages/os/android/pixel11pro.lock.json"),
      );
      const fixtureLock = structuredClone(lock);
      const generatedFixture = "generated fixture\n";
      fixtureLock.generatedVendor.requiredArtifacts = [
        {
          path: "vendor/google_devices/grizzly/stock-kernel/Image.lz4",
          sizeBytes: Buffer.byteLength(generatedFixture),
          sha256: createHash("sha256").update(generatedFixture).digest("hex"),
        },
      ];
      for (const requiredPath of lock.generatedVendor.requiredFiles) {
        const destination = join(root, requiredPath);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, "generated fixture\n");
      }
      for (const entry of lock.generatedVendor.requiredTextFiles) {
        await writeFile(
          join(root, entry.path),
          `${entry.includes.join("\n")}\n`,
        );
      }
      expect(assertGeneratedVendorTree(root, fixtureLock)).toHaveLength(
        lock.generatedVendor.requiredFiles.length,
      );
      const firmwareContract = lock.generatedVendor.requiredTextFiles[0];
      await writeFile(join(root, firmwareContract.path), "wrong firmware\n");
      expect(() => assertGeneratedVendorTree(root, fixtureLock)).toThrow(
        /generated vendor contract mismatch/,
      );
      await writeFile(
        join(root, firmwareContract.path),
        `${firmwareContract.includes.join("\n")}\n`,
      );
      await writeFile(
        join(root, fixtureLock.generatedVendor.requiredArtifacts[0].path),
        "wrong artifact\n",
      );
      expect(() => assertGeneratedVendorTree(root, fixtureLock)).toThrow(
        /generated vendor artifact mismatch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    expect(driver).not.toContain("QJL_RVV_COMPILE_OPTIONS=-mcpu=sifive_x280");

    const checker = readFileSync(
      join(repositoryRoot, "scripts/check-riscv64-artifacts.sh"),
      "utf8",
    );
    expect(checker).toContain('verify_artifact "$artifact" "$fork_ggml"');
    expect(checker).toContain(
      'LD_LIBRARY_PATH="$(dirname "$fork_ggml")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
    );
    expect(checker).toContain('"$(basename "$exe")" = "qjl_fork_parity"');
    expect(checker).toContain("Dynamic loading not supported");
    expect(checker).toContain(
      "qemu fork parity unavailable (static musl has no dlopen)",
    );
  });

  test("riscv64 QJL reports the static-musl dlopen boundary as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-riscv64-qjl-"));
    try {
      const elizaRoot = join(root, "eliza");
      const qjlBuild = join(
        elizaRoot,
        "packages/native/plugins/qjl-cpu/build/riscv64",
      );
      const llamaBuild = join(elizaRoot, "build/riscv64-stage/riscv64");
      const fakeBin = join(root, "bin");
      const report = join(root, "report.json");
      await Promise.all([
        mkdir(qjlBuild, { recursive: true }),
        mkdir(llamaBuild, { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
      ]);

      const parity = join(qjlBuild, "qjl_fork_parity");
      const forkLibrary = join(llamaBuild, "libggml-cpu.so");
      const fakeFile = join(fakeBin, "file");
      const fakeQemu = join(fakeBin, "qemu-riscv64-static");
      const fakeTimeout = join(fakeBin, "timeout");
      const fakeDate = join(fakeBin, "date");
      await Promise.all([
        writeFile(parity, "fake riscv64 executable\n"),
        writeFile(forkLibrary, "fake riscv64 shared library\n"),
        writeFile(
          fakeFile,
          '#!/bin/sh\necho "ELF 64-bit LSB executable, UCB RISC-V, double-float ABI"\n',
        ),
        writeFile(
          fakeQemu,
          '#!/bin/sh\necho "dlopen $2: Dynamic loading not supported" >&2\nexit 1\n',
        ),
        writeFile(fakeTimeout, '#!/bin/sh\nshift\nexec "$@"\n'),
        writeFile(
          fakeDate,
          '#!/bin/sh\nif [ "$1" = "+%s%3N" ]; then echo 1000; else exec /bin/date "$@"; fi\n',
        ),
      ]);
      await Promise.all(
        [parity, fakeFile, fakeQemu, fakeTimeout, fakeDate].map((path) =>
          chmod(path, 0o755),
        ),
      );

      const process = Bun.spawn(
        [
          "bash",
          join(repositoryRoot, "scripts/check-riscv64-artifacts.sh"),
          "--out",
          report,
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...Bun.env,
            ELIZAOS_ELIZA_ROOT: elizaRoot,
            ELIZA_RISCV64_SMOKE: "1",
            HOME: root,
            PATH: `${fakeBin}:${Bun.env.PATH ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      expect(`${stdout}\n${stderr}`).toContain("static musl has no dlopen");
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(await Bun.file(report).text());
      const parityResult = parsed.artifacts.find(
        (artifact: { path: string }) => artifact.path === parity,
      );
      expect(parityResult?.status).toBe("SKIP");
      expect(parityResult?.detail).toContain("Dynamic loading not supported");
      expect(parsed.summary.fail).toBe(0);
      expect(parsed.final_status).toBe("PASS");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

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
