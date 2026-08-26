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
          keymasterNonblocking: false,
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
  mkdirSync(join(productDir, "system/etc/init/hw"), { recursive: true });
  mkdirSync(join(productDir, "system/lib64"), { recursive: true });
  writeFileSync(join(productDir, "system/lib64/libEGL_angle.so"), "angle-elf");
  writeFileSync(
    join(productDir, "system/etc/init/hw/init.rc"),
    "on post-fs-data\n    exec - system system -- /system/bin/vdc keymaster earlyBootEnded\n",
  );
  if (options.probeRc) {
    writeFileSync(
      join(vendorDir, "etc/init/hw/init.elizaos-debug.rc"),
      'on post-fs\n    write /dev/kmsg "elizaos-init: post-fs reached"\n',
    );
  }
  // The complete flash chain: attesting a partial build is refused outright,
  // so the scaffold must stage every image a real grizzly dist produces.
  for (const image of [
    "boot.img",
    "init_boot.img",
    "dtbo.img",
    "vendor_kernel_boot.img",
    "pvmfw.img",
    "vendor_boot.img",
  ])
    writeFileSync(join(productDir, image), `${image}-bytes`);
  writeFileSync(join(productDir, "system.img"), "system-image-bytes");
  writeFileSync(join(productDir, "system_ext.img"), "system-ext-image-bytes");
  writeFileSync(join(productDir, "product.img"), "product-image-bytes");
  writeFileSync(join(productDir, "vendor.img"), "vendor-image-bytes");
  writeFileSync(join(productDir, "vendor_dlkm.img"), "vendor-dlkm-image-bytes");
  writeFileSync(join(productDir, "system_dlkm.img"), "system-dlkm-image-bytes");
  writeFileSync(join(productDir, "vbmeta.img"), "vbmeta-image-bytes");
  writeFileSync(
    join(productDir, "system_other.img"),
    "system-other-image-bytes",
  );
  writeFileSync(join(productDir, "super_empty.img"), "super-empty-image-bytes");
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

function copyAttestedImages(productDir: string, artifactDir: string) {
  const manifest = JSON.parse(
    require("node:fs").readFileSync(
      join(productDir, "grizzly-artifacts.json"),
      "utf8",
    ),
  );
  for (const name of Object.keys(manifest.images)) {
    require("node:fs").copyFileSync(
      join(productDir, name),
      join(artifactDir, name),
    );
  }
}

describe("verify-grizzly-artifacts check", () => {
  test("verifies matching images and refuses tampered bytes", () => {
    const { root, productDir } = scaffoldAospRoot({});
    const artifactDir = mkdtempSync(join(tmpdir(), "elizaos-grizzly-check-"));
    try {
      expect(run(["attest", "--aosp-root", root]).status).toBe(0);
      const manifestPath = join(productDir, "grizzly-artifacts.json");
      copyAttestedImages(productDir, artifactDir);
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

  test("refuses to attest a partial build", () => {
    const { root, productDir } = scaffoldAospRoot({});
    try {
      rmSync(join(productDir, "vendor.img"));
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("core images missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses unattested stray images beside the attested set", () => {
    const { root, productDir } = scaffoldAospRoot({});
    const artifactDir = mkdtempSync(join(tmpdir(), "elizaos-grizzly-stray-"));
    try {
      expect(run(["attest", "--aosp-root", root]).status).toBe(0);
      copyAttestedImages(productDir, artifactDir);
      writeFileSync(join(artifactDir, "stray.img"), "week-old-stray-bytes");
      const result = run([
        "check",
        "--manifest",
        join(productDir, "grizzly-artifacts.json"),
        "--artifact-dir",
        artifactDir,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("does not attest");
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
