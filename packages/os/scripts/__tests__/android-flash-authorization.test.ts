import { describe, expect, test } from "bun:test";
import { authorizeManifest } from "../../../../packages/os/android/installer/scripts/authorize-flash.mjs";

const baseManifest = {
  releaseId: "fixture",
  supportedDevices: [
    {
      targetId: "pixel9a-tegu",
      codename: "tegu",
      tier: "lab-validated",
      rollbackSupported: true,
    },
  ],
  artifacts: [
    { partition: "boot", filename: "boot.img" },
    { partition: "super", filename: "super.img" },
  ],
};

const baseInventory = {
  targets: [
    {
      id: "pixel9a-tegu",
      codename: "tegu",
      installerEligibility: "eligible",
    },
  ],
};

describe("Android flash authorization", () => {
  test("authorizes one exact lab-validated target", () => {
    expect(
      authorizeManifest(baseManifest, ["boot.img", "super.img"], baseInventory),
    ).toEqual({ codename: "tegu", releaseId: "fixture" });
  });

  test("candidate and blocked devices cannot authorize a flash", () => {
    for (const tier of ["candidate", "manual", "blocked"]) {
      const manifest = structuredClone(baseManifest);
      manifest.supportedDevices[0].tier = tier;
      expect(() =>
        authorizeManifest(manifest, ["boot.img", "super.img"], baseInventory),
      ).toThrow("exactly one lab-validated device");
    }
  });

  test("unlisted images and ambiguous mappings fail closed", () => {
    expect(() =>
      authorizeManifest(
        baseManifest,
        ["boot.img", "super.img", "vendor.img"],
        baseInventory,
      ),
    ).toThrow("unlisted images");
    const manifest = structuredClone(baseManifest);
    manifest.artifacts[0].filename = "renamed.img";
    expect(() =>
      authorizeManifest(manifest, ["renamed.img", "super.img"], baseInventory),
    ).toThrow("partition/filename mappings");
  });

  test("rollback support is mandatory", () => {
    const manifest = structuredClone(baseManifest);
    manifest.supportedDevices[0].rollbackSupported = false;
    expect(() =>
      authorizeManifest(manifest, ["boot.img", "super.img"], baseInventory),
    ).toThrow("rollback support");
  });

  test("unlisted, mismatched, and inventory-blocked hardware cannot authorize", () => {
    const unknown = structuredClone(baseManifest);
    unknown.supportedDevices[0].targetId = "unknown-device";
    expect(() =>
      authorizeManifest(unknown, ["boot.img", "super.img"], baseInventory),
    ).toThrow("not in the hardware inventory");

    const mismatch = structuredClone(baseManifest);
    mismatch.supportedDevices[0].codename = "TLP301";
    expect(() =>
      authorizeManifest(mismatch, ["boot.img", "super.img"], baseInventory),
    ).toThrow("does not match inventory");

    const blockedInventory = structuredClone(baseInventory);
    blockedInventory.targets[0].installerEligibility =
      "blocked-until-physical-evidence";
    expect(() =>
      authorizeManifest(
        baseManifest,
        ["boot.img", "super.img"],
        blockedInventory,
      ),
    ).toThrow("not installer-eligible");
  });
});
