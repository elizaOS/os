/**
 * Contract tests for verify-grizzly-artifacts.mjs: attestation must fail
 * closed whenever the staged product output disagrees with the prepare stamp,
 * and the flash-host check must refuse any image whose bytes differ from the
 * attested build.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "../../../..");
const script = join(
  repositoryRoot,
  "scripts/distro-android/verify-grizzly-artifacts.mjs",
);

function run(args: string[]) {
  return spawnSync("node", [script, ...args], { encoding: "utf8" });
}

const STOCK_FSTAB_DATA_LINE =
  "/dev/block/by-name/userdata /data f2fs noatime,nosuid,nodev " +
  "latemount,wait,check,quota,formattable,fileencryption=aes-256-xts," +
  "metadata_encryption=aes-256-xts,keydirectory=/metadata/vold/metadata_encryption\n";

function scaffoldAospRoot(options: {
  stamp?: Record<string, unknown> | null;
  backendLine?: string;
  graphiteLine?: string;
  eglLine?: string;
  fstabLine?: string;
  probeRc?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "elizaos-grizzly-attest-"));
  const productDir = join(root, "out/target/product/grizzly");
  const vendorDir = join(productDir, "vendor");
  mkdirSync(join(vendorDir, "etc/init/hw"), { recursive: true });
  const stampDir = join(root, "vendor/google_devices/grizzly");
  mkdirSync(stampDir, { recursive: true });
  if (options.stamp !== null) {
    writeFileSync(
      join(stampDir, ".elizaos-prepare-stamp.json"),
      JSON.stringify(
        options.stamp ?? {
          renderengineBackend: null,
          renderengineGraphite: true,
          eglSelection: null,
          earlyBootProbes: false,
          conservativeF2fs: false,
        },
      ),
    );
  }
  const propLines = [
    options.backendLine ?? "",
    options.graphiteLine ?? "debug.renderengine.graphite=true",
    options.eglLine ?? "persist.graphics.egl=angle",
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(join(vendorDir, "build.prop"), `${propLines}\n`);
  writeFileSync(
    join(vendorDir, "etc/fstab.malibu"),
    options.fstabLine ?? STOCK_FSTAB_DATA_LINE,
  );
  if (options.probeRc) {
    writeFileSync(
      join(vendorDir, "etc/init/hw/init.elizaos-debug.rc"),
      'on post-fs\n    write /dev/kmsg "elizaos-init: post-fs reached"\n',
    );
  }
  const requiredImages = [
    "boot.img",
    "init_boot.img",
    "dtbo.img",
    "vendor_kernel_boot.img",
    "pvmfw.img",
    "vendor_boot.img",
    "vbmeta.img",
    "system.img",
    "system_ext.img",
    "product.img",
    "vendor.img",
    "vendor_dlkm.img",
    "system_dlkm.img",
    "system_other.img",
    "super_empty.img",
  ];
  for (const image of requiredImages) {
    writeFileSync(join(productDir, image), image === "vendor.img" ? "vendor-image-bytes" : `${image}-bytes`);
  }
  return { root, productDir };
}

describe("verify-grizzly-artifacts attest", () => {
  test("attests a coherent build and writes the sha256 manifest", () => {
    const { root, productDir } = scaffoldAospRoot({});
    try {
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(0);
      const manifest = JSON.parse(
        require("node:fs").readFileSync(
          join(productDir, "grizzly-artifacts.json"),
          "utf8",
        ),
      );
      expect(manifest.device).toBe("grizzly");
      expect(manifest.prepareStamp.conservativeF2fs).toBe(false);
      const expected = createHash("sha256")
        .update("vendor-image-bytes")
        .digest("hex");
      expect(manifest.images["vendor.img"].sha256).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when there is no prepare stamp", () => {
    const { root } = scaffoldAospRoot({ stamp: null });
    try {
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("prepare stamp missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when the staged backend contradicts the stamp (the skiavk-that-was-GL bug)", () => {
    const { root } = scaffoldAospRoot({
      stamp: {
        renderengineBackend: "skiavkthreaded",
        renderengineGraphite: false,
        earlyBootProbes: false,
        conservativeF2fs: false,
      },
      graphiteLine: "debug.renderengine.graphite=false",
      // staged image has no backend override at all
    });
    try {
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("would not run the intended renderer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when stock fstab stance lost the factory encryption contract", () => {
    const { root } = scaffoldAospRoot({
      fstabLine:
        "/dev/block/by-name/userdata /data f2fs noatime latemount,wait,check\n",
    });
    try {
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("factory encryption contract");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when the native-EGL stamp still stages the ANGLE selection", () => {
    const { root } = scaffoldAospRoot({
      stamp: {
        renderengineBackend: "skiaglthreaded",
        renderengineGraphite: false,
        eglSelection: "native",
        earlyBootProbes: false,
        conservativeF2fs: false,
      },
      backendLine: "debug.renderengine.backend=skiaglthreaded",
      graphiteLine: "debug.renderengine.graphite=false",
      // eglLine defaults to the stock ANGLE selection — the mismatch
    });
    try {
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("still routes through ANGLE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when probes are staged but the stamp says probes are off", () => {
    const { root } = scaffoldAospRoot({ probeRc: true });
    try {
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("earlyBootProbes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("verify-grizzly-artifacts check", () => {
  test("verifies matching images and refuses tampered bytes", () => {
    const { root, productDir } = scaffoldAospRoot({});
    const artifactDir = mkdtempSync(join(tmpdir(), "elizaos-grizzly-check-"));
    try {
      expect(run(["attest", "--aosp-root", root]).status).toBe(0);
      const manifestPath = join(productDir, "grizzly-artifacts.json");
      const manifest = JSON.parse(require("node:fs").readFileSync(manifestPath, "utf8"));
      for (const image of Object.keys(manifest.images)) {
        writeFileSync(join(artifactDir, image), require("node:fs").readFileSync(join(productDir, image)));
      }
      const ok = run([
        "check",
        "--manifest",
        manifestPath,
        "--artifact-dir",
        artifactDir,
      ]);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("safe to flash");

      writeFileSync(join(artifactDir, "vendor.img"), "DIFFERENT-bytes");
      const tampered = run([
        "check",
        "--manifest",
        manifestPath,
        "--artifact-dir",
        artifactDir,
      ]);
      expect(tampered.status).toBe(1);
      expect(tampered.stderr).toContain("NOT the attested build");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  test("refuses an artifact dir missing an attested image", () => {
    const { root, productDir } = scaffoldAospRoot({});
    const artifactDir = mkdtempSync(join(tmpdir(), "elizaos-grizzly-miss-"));
    try {
      expect(run(["attest", "--aosp-root", root]).status).toBe(0);
      writeFileSync(join(artifactDir, "system.img"), "system-image-bytes");
      const result = run([
        "check",
        "--manifest",
        join(productDir, "grizzly-artifacts.json"),
        "--artifact-dir",
        artifactDir,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing from artifact dir");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  test("refuses unsafe manifest image paths before reading outside the artifact dir", () => {
    const { root, productDir } = scaffoldAospRoot({});
    const artifactDir = mkdtempSync(join(tmpdir(), "elizaos-grizzly-unsafe-"));
    try {
      expect(run(["attest", "--aosp-root", root]).status).toBe(0);
      const manifestPath = join(productDir, "grizzly-artifacts.json");
      const manifest = JSON.parse(
        require("node:fs").readFileSync(manifestPath, "utf8"),
      );
      manifest.images = { "../outside.img": manifest.images["system.img"] };
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      const result = run([
        "check",
        "--manifest",
        manifestPath,
        "--artifact-dir",
        artifactDir,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unsafe");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
});
