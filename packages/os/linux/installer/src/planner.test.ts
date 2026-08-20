import { describe, expect, it } from "vitest";
import {
  createDiskConfirmationToken,
  createInstallPlan,
  validateDiskInventory,
} from "./planner";
import type {
  DiskInventory,
  InstallRequest,
  PartitionInventory,
} from "./types";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function disk(overrides: Partial<DiskInventory> = {}): DiskInventory {
  return {
    stableId: "nvme-serial-123",
    path: "/dev/nvme0n1",
    hardwareIdentity: {
      serial: "S3Z9NB0K123456",
      wwn: "eui.002538b221aabbcc",
      firmwarePath: "/sys/devices/pci0000:00/0000:00:04.0/nvme/nvme0",
      gptDiskGuid: "56f01c36-1e33-4b83-8ec6-f7a0e3c4af2e",
    },
    sizeBytes: 512 * GIB,
    logicalSectorBytes: 512,
    partitionTable: "gpt",
    currentBootSource: false,
    firmware: "uefi",
    partitions: [
      {
        id: "esp",
        startBytes: MIB,
        endBytes: 513 * MIB,
        role: "esp",
        filesystem: "fat32",
        encryption: "none",
      },
      {
        id: "host-os",
        startBytes: 513 * MIB,
        endBytes: 300 * GIB,
        role: "os",
        filesystem: "ntfs",
        osFamily: "windows",
        encryption: "none",
      },
    ],
    freeExtents: [{ id: "free-1", startBytes: 300 * GIB, endBytes: 511 * GIB }],
    ...overrides,
  };
}

function partition(index: number): PartitionInventory {
  const value = disk().partitions[index];
  if (!value) throw new Error(`Missing test partition ${index}.`);
  return value;
}

function request(
  target: DiskInventory,
  overrides: Partial<InstallRequest> = {},
): InstallRequest {
  return {
    mode: "alongside",
    targetStableId: target.stableId,
    expectedSizeBytes: target.sizeBytes,
    confirmationToken: createDiskConfirmationToken(target),
    freeExtentId: "free-1",
    ...overrides,
  };
}

describe("elizaOS internal-disk installer planner", () => {
  it("creates a deterministic, non-executable erase plan bound to disk identity", () => {
    const target = disk({ freeExtents: [] });
    const input = request(target, {
      mode: "erase-disk",
      freeExtentId: undefined,
    });
    const first = createInstallPlan(input, target);
    const second = createInstallPlan(input, target);

    expect(first).toEqual(second);
    expect(first.planId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.executable).toBe(false);
    expect(first.actions[0]).toMatchObject({
      type: "erase-partition-table",
      destructive: true,
    });
    expect(first.preservedPartitionIds).toEqual([]);
    expect(first.target.hardwareIdentity).toEqual(target.hardwareIdentity);
    expect(first.target.logicalSectorBytes).toBe(512);
  });

  it.each([
    ["Windows", { filesystem: "ntfs", osFamily: "windows" }],
    ["macOS on Intel", { filesystem: "apfs", osFamily: "macos" }],
    ["Linux", { filesystem: "ext4", osFamily: "linux" }],
  ] as const)(
    "plans alongside %s only inside verified free space",
    (_name, host) => {
      const target = disk({
        firmware: host.osFamily === "macos" ? "apple-intel-efi" : "uefi",
        partitions: [
          partition(0),
          { ...partition(1), ...host } as PartitionInventory,
        ],
      });
      const plan = createInstallPlan(request(target), target);

      expect(plan.preservedPartitionIds).toEqual(["esp", "host-os"]);
      expect(
        plan.actions.some((action) => action.type === "erase-partition-table"),
      ).toBe(false);
      expect(plan.actions).toContainEqual({
        type: "reuse-esp",
        partitionId: "esp",
        destructive: false,
      });
      expect(
        plan.partitions
          .filter((part) => !part.reusePartitionId)
          .every((part) => part.startBytes >= 300 * GIB),
      ).toBe(true);
      expect(plan.compatibility.preparationRequiredInExistingOs).toBe(
        host.osFamily === "macos",
      );
    },
  );

  it("plans a verified Windows NTFS shrink but keeps the plan non-executable", () => {
    const target = disk({
      partitions: [
        partition(0),
        {
          ...partition(1),
          endBytes: 500 * GIB,
          resize: {
            filesystemHealthy: true,
            mounted: false,
            minimumBytes: 200 * GIB,
            bitlocker: "suspended",
            hibernated: false,
            dirty: false,
          },
        },
      ],
      freeExtents: [],
    });
    const plan = createInstallPlan(
      request(target, {
        freeExtentId: undefined,
        shrinkPartitionId: "host-os",
      }),
      target,
    );

    expect(plan.actions[0]).toMatchObject({
      type: "shrink-partition",
      partitionId: "host-os",
    });
    expect(plan.compatibility.automaticShrinkSupported).toBe(true);
    expect(plan.executable).toBe(false);
  });

  it.each([
    ["BitLocker", { encryption: "bitlocker" as const }],
    [
      "FileVault",
      {
        encryption: "filevault" as const,
        filesystem: "apfs" as const,
        osFamily: "macos" as const,
      },
    ],
    [
      "LUKS",
      {
        encryption: "luks" as const,
        filesystem: "ext4" as const,
        osFamily: "linux" as const,
      },
    ],
  ])(
    "blocks automatic shrinking of %s-encrypted partitions",
    (_name, override) => {
      const target = disk({
        firmware:
          "osFamily" in override && override.osFamily === "macos"
            ? "apple-intel-efi"
            : "uefi",
        partitions: [
          partition(0),
          {
            ...partition(1),
            ...override,
            endBytes: 500 * GIB,
            resize: {
              filesystemHealthy: true,
              mounted: false,
              minimumBytes: 200 * GIB,
              hibernated: false,
              dirty: false,
            },
          },
        ],
        freeExtents: [],
      });
      expect(() =>
        createInstallPlan(
          request(target, {
            freeExtentId: undefined,
            shrinkPartitionId: "host-os",
          }),
          target,
        ),
      ).toThrow(/Encrypted|APFS/);
    },
  );

  it.each([
    ["hibernated", { hibernated: true, dirty: false }],
    ["dirty", { hibernated: false, dirty: true }],
    [
      "unhealthy",
      { hibernated: false, dirty: false, filesystemHealthy: false },
    ],
  ])(
    "blocks a %s Windows filesystem before planning a shrink",
    (_name, evidenceOverride) => {
      const target = disk({
        partitions: [
          partition(0),
          {
            ...partition(1),
            endBytes: 500 * GIB,
            resize: {
              filesystemHealthy: true,
              mounted: false,
              minimumBytes: 200 * GIB,
              bitlocker: "off",
              ...evidenceOverride,
            },
          },
        ],
        freeExtents: [],
      });
      expect(() =>
        createInstallPlan(
          request(target, {
            freeExtentId: undefined,
            shrinkPartitionId: "host-os",
          }),
          target,
        ),
      ).toThrow();
    },
  );

  it("blocks generic Apple Silicon alongside claims", () => {
    const target = disk({ firmware: "apple-silicon" });
    expect(() => createInstallPlan(request(target), target)).toThrow(
      "Asahi/m1n1",
    );
  });

  it("rejects stale identity, current boot media, and overlapping inventory", () => {
    const target = disk();
    expect(() =>
      createInstallPlan(
        { ...request(target), expectedSizeBytes: target.sizeBytes + 1 },
        target,
      ),
    ).toThrow("identity changed");
    expect(() =>
      createInstallPlan(request({ ...target, currentBootSource: true }), {
        ...target,
        currentBootSource: true,
      }),
    ).toThrow("booted the installer");
    expect(() =>
      validateDiskInventory({
        ...target,
        freeExtents: [
          { id: "overlap", startBytes: 200 * GIB, endBytes: 400 * GIB },
        ],
      }),
    ).toThrow("Overlapping");
  });

  it("invalidates owner confirmation when the reviewed partition layout changes", () => {
    const reviewed = disk();
    const reviewedRequest = request(reviewed);
    const changed = disk({
      partitions: [partition(0), { ...partition(1), endBytes: 299 * GIB }],
    });
    expect(() => createInstallPlan(reviewedRequest, changed)).toThrow(
      "confirmation token is missing or stale",
    );
  });

  it("binds plans to serial, WWN, firmware path, sector size, and GPT GUID", () => {
    const target = disk();
    const reviewed = createInstallPlan(request(target), target);

    for (const changed of [
      disk({
        hardwareIdentity: {
          ...target.hardwareIdentity,
          serial: "S3Z9NB0K654321",
        },
      }),
      disk({
        hardwareIdentity: {
          ...target.hardwareIdentity,
          wwn: "eui.002538b221ddeeff",
        },
      }),
      disk({
        hardwareIdentity: {
          ...target.hardwareIdentity,
          firmwarePath: "/sys/devices/pci0000:00/0000:00:05.0/nvme/nvme0",
        },
      }),
      disk({ logicalSectorBytes: 4096 }),
      disk({
        hardwareIdentity: {
          ...target.hardwareIdentity,
          gptDiskGuid: "11385e1d-df71-4d61-93cd-13f272f15e7a",
        },
      }),
    ]) {
      expect(createInstallPlan(request(changed), changed).planId).not.toBe(
        reviewed.planId,
      );
    }
  });

  it("rejects unknown runtime inventory enum values and malformed probe evidence", () => {
    expect(() =>
      validateDiskInventory({
        ...disk(),
        firmware: "invented" as DiskInventory["firmware"],
      }),
    ).toThrow("firmware inventory");
    expect(() =>
      validateDiskInventory({
        ...disk(),
        hardwareIdentity: { ...disk().hardwareIdentity, serial: "" },
      }),
    ).toThrow("hardware identity");
    expect(() =>
      validateDiskInventory({
        ...disk(),
        hardwareIdentity: { ...disk().hardwareIdentity, gptDiskGuid: "bad" },
      }),
    ).toThrow("hardware identity");
    expect(() =>
      validateDiskInventory({
        ...disk(),
        partitions: [
          partition(0),
          {
            ...partition(1),
            resize: {
              filesystemHealthy: true,
              mounted: false,
              minimumBytes: 1.5,
            },
          },
        ],
      }),
    ).toThrow("minimumBytes");
  });
});
