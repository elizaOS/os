import { describe, expect, it } from "vitest";
import {
  isSgdiskRedundancyVerified,
  parseLinuxBootAncestorPaths,
  parseLinuxLsblkInventory,
  parseLinuxRootBlockSource,
} from "./linux-inventory";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function serializedInventory(
  overrides: Record<string, unknown> = {},
  partitionOverrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    blockdevices: [
      {
        path: "/dev/vda",
        kname: "/dev/vda",
        pkname: null,
        type: "disk",
        size: 128 * GIB,
        "log-sec": 512,
        pttype: "gpt",
        ptuuid: "b5afe67e-7ed7-4f10-99bd-efb8173c53ce",
        fstype: null,
        mountpoints: [null],
        parttype: null,
        partuuid: null,
        partlabel: null,
        start: null,
        serial: "QEMU-DISK-0001",
        wwn: "0x5000c50012345678",
        ro: false,
        rm: false,
        ...overrides,
      },
      {
        path: "/dev/vda1",
        kname: "/dev/vda1",
        pkname: "/dev/vda",
        type: "part",
        size: 512 * MIB,
        "log-sec": 512,
        pttype: "gpt",
        ptuuid: "b5afe67e-7ed7-4f10-99bd-efb8173c53ce",
        fstype: "vfat",
        mountpoints: [null],
        parttype: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b",
        partuuid: "b27e2419-9e58-416e-a921-d8d51a443692",
        partlabel: "EFI System Partition",
        start: 2048,
        serial: null,
        wwn: null,
        ro: false,
        rm: false,
      },
      {
        path: "/dev/vda2",
        kname: "/dev/vda2",
        pkname: "/dev/vda",
        type: "part",
        size: 40 * GIB,
        "log-sec": 512,
        pttype: "gpt",
        ptuuid: "b5afe67e-7ed7-4f10-99bd-efb8173c53ce",
        fstype: "ext4",
        mountpoints: [null],
        parttype: "0fc63daf-8483-4772-8e79-3d69d8477de4",
        partuuid: "f498a3cd-f27a-4548-afb0-51ef5b2f0084",
        partlabel: "host-root",
        start: 1_050_624,
        serial: null,
        wwn: null,
        ro: false,
        rm: false,
        ...partitionOverrides,
      },
    ],
  });
}

function parse(
  serialized = serializedInventory(),
  partitionTableVerified = true,
  gptRedundancyVerified = true,
  bootAncestorPaths: readonly string[] = [],
  bootAncestryResolved = true,
) {
  return parseLinuxLsblkInventory({
    stableId: "virtio-QEMU-DISK-0001",
    stablePath: "/dev/disk/by-id/virtio-QEMU-DISK-0001",
    devicePath: "/dev/vda",
    firmwarePath: "/devices/pci0000:00/0000:00:04.0/virtio2/block/vda",
    firmware: "uefi",
    serialized,
    partitionTableVerified,
    gptRedundancyVerified,
    bootAncestorPaths,
    bootAncestryResolved,
  });
}

describe("Linux read-only disk inventory parser", () => {
  it("resolves root block sources and complete inverse ancestry", () => {
    expect(
      parseLinuxRootBlockSource(
        JSON.stringify({
          filesystems: [{ source: "/dev/mapper/cryptroot[/@]", target: "/" }],
        }),
      ),
    ).toBe("/dev/mapper/cryptroot");
    expect(
      parseLinuxRootBlockSource(
        JSON.stringify({
          filesystems: [{ source: "overlay", target: "/" }],
        }),
      ),
    ).toBeUndefined();
    expect(
      parseLinuxBootAncestorPaths(
        JSON.stringify({
          blockdevices: [
            { path: "/dev/mapper/cryptroot", type: "crypt" },
            { path: "/dev/md0", type: "raid1" },
            { path: "/dev/nvme1n1p2", type: "part" },
            { path: "/dev/nvme1n1", type: "disk" },
            { path: "/dev/nvme0n1p2", type: "part" },
            { path: "/dev/nvme0n1", type: "disk" },
          ],
        }),
        "/dev/mapper/cryptroot",
      ),
    ).toEqual([
      "/dev/mapper/cryptroot",
      "/dev/md0",
      "/dev/nvme0n1",
      "/dev/nvme0n1p2",
      "/dev/nvme1n1",
      "/dev/nvme1n1p2",
    ]);
    expect(() =>
      parseLinuxBootAncestorPaths(
        JSON.stringify({ blockdevices: [] }),
        "/dev/mapper/cryptroot",
      ),
    ).toThrow(/incomplete/);
    expect(() =>
      parseLinuxBootAncestorPaths(
        JSON.stringify({
          blockdevices: [{ path: "/dev/../etc/passwd", type: "disk" }],
        }),
        "/dev/mapper/cryptroot",
      ),
    ).toThrow(/invalid/);
    expect(() =>
      parseLinuxBootAncestorPaths(
        JSON.stringify({
          blockdevices: [{ path: "/dev/mapper/cryptroot", type: "crypt" }],
        }),
        "/dev/mapper/cryptroot",
      ),
    ).toThrow(/incomplete/);
  });

  it("rejects sgdisk reports that recover corruption despite exit zero", () => {
    expect(
      isSgdiskRedundancyVerified({
        exitCode: 0,
        stdout:
          "No problems found. 67517 free sectors available in 2 segments.\n",
        stderr: "",
      }),
    ).toBe(true);
    expect(
      isSgdiskRedundancyVerified({
        exitCode: 0,
        stdout: [
          "Caution: invalid backup GPT header, but valid main header; regenerating backup header from main header.",
          "Warning! One or more CRCs don't match. You should repair the disk!",
          "Main header: OK",
          "Backup header: ERROR",
          "No problems found. 67517 free sectors available in 2 segments.",
        ].join("\n"),
        stderr: "",
      }),
    ).toBe(false);
    expect(
      isSgdiskRedundancyVerified({
        exitCode: 0,
        stdout:
          "Problem: main and backup partition tables do not match.\nNo problems found.\n",
        stderr: "",
      }),
    ).toBe(false);
    expect(
      isSgdiskRedundancyVerified({
        exitCode: 0,
        stdout: "No problems found. 1 free sector available.\n",
        stderr: "Warning: mismatched main and backup data.\n",
      }),
    ).toBe(false);
    expect(
      isSgdiskRedundancyVerified({
        exitCode: 2,
        stdout: "No problems found. 1 free sector available.\n",
        stderr: "",
      }),
    ).toBe(false);
  });

  it("binds whole-disk hardware identity, GPT IDs, boundaries, and free extents", () => {
    const inventory = parse();

    expect(inventory.hardwareIdentity).toEqual({
      serial: "QEMU-DISK-0001",
      wwn: "0x5000c50012345678",
      firmwarePath: "/devices/pci0000:00/0000:00:04.0/virtio2/block/vda",
      gptDiskGuid: "b5afe67e-7ed7-4f10-99bd-efb8173c53ce",
    });
    expect(inventory.logicalSectorBytes).toBe(512);
    expect(inventory.gptRedundancyVerified).toBe(true);
    expect(inventory.bootAncestryResolved).toBe(true);
    expect(inventory.partitions).toHaveLength(2);
    expect(inventory.partitions[0]).toMatchObject({
      id: "b27e2419-9e58-416e-a921-d8d51a443692",
      startBytes: MIB,
      endBytes: 513 * MIB,
      mounted: false,
      role: "esp",
      filesystem: "fat32",
    });
    expect(inventory.partitions[1]).toMatchObject({
      mounted: false,
      role: "data",
      filesystem: "ext4",
      encryption: "none",
    });
    expect(inventory.freeExtents).toEqual([
      {
        id: `free-${40 * GIB + 513 * MIB}-${128 * GIB - MIB}`,
        startBytes: 40 * GIB + 513 * MIB,
        endBytes: 128 * GIB - MIB,
      },
    ]);
    expect(inventory.currentBootSource).toBe(false);
    expect(inventory.protectedReason).toBeUndefined();
  });

  it("marks root-backed, read-only, removable, and unverified disks as protected", () => {
    const rootBacked = parse(serializedInventory({}, { mountpoints: ["/"] }));
    expect(rootBacked.currentBootSource).toBe(true);
    expect(rootBacked.partitions[1]?.mounted).toBe(true);
    expect(rootBacked.protectedReason).toMatch(/mounted partition/);
    expect(parse(serializedInventory({ ro: true })).protectedReason).toMatch(
      /read-only/,
    );
    expect(parse(serializedInventory({ rm: true })).protectedReason).toMatch(
      /removable/,
    );
    expect(parse(serializedInventory(), false).protectedReason).toMatch(
      /verification failed/,
    );
    expect(parse(serializedInventory(), true, false).protectedReason).toMatch(
      /GPT main\/backup/,
    );
    expect(
      parse(serializedInventory(), true, true, [], false).protectedReason,
    ).toMatch(/boot-device ancestry/);
    expect(
      parse(serializedInventory(), true, true, ["/dev/vda"], true)
        .currentBootSource,
    ).toBe(true);
    const directRoot = parse(
      serializedInventory({}, { mountpoints: ["/"] }),
      true,
      true,
      [],
      false,
    );
    expect(directRoot.bootAncestryResolved).toBe(true);
    expect(directRoot.currentBootSource).toBe(true);
  });

  it("propagates a stacked descendant mount to its containing partition", () => {
    const document = JSON.parse(serializedInventory()) as {
      blockdevices: Array<Record<string, unknown>>;
    };
    document.blockdevices.push({
      path: "/dev/mapper/vg-data",
      kname: "/dev/dm-0",
      pkname: "/dev/vda2",
      type: "lvm",
      mountpoints: ["/srv/data"],
    });

    const inventory = parse(JSON.stringify(document));
    expect(inventory.partitions[1]?.mounted).toBe(true);
    expect(inventory.currentBootSource).toBe(false);
    expect(inventory.protectedReason).toMatch(/stacked descendant/);
  });

  it("does not require partition-table verification for an empty disk", () => {
    const empty = JSON.parse(
      serializedInventory({ pttype: null, ptuuid: null }),
    ) as { blockdevices: Array<Record<string, unknown>> };
    empty.blockdevices.splice(1);
    expect(parse(JSON.stringify(empty), false).protectedReason).toBeUndefined();
  });

  it("protects unknown partition tables and firmware modes", () => {
    expect(
      parse(serializedInventory({ pttype: "mystery", ptuuid: null }))
        .protectedReason,
    ).toMatch(/unknown/);
    expect(
      parseLinuxLsblkInventory({
        stableId: "virtio-QEMU-DISK-0001",
        stablePath: "/dev/disk/by-id/virtio-QEMU-DISK-0001",
        devicePath: "/dev/vda",
        firmwarePath: "/devices/pci0000:00/0000:00:04.0/virtio2/block/vda",
        firmware: "unknown",
        serialized: serializedInventory(),
        partitionTableVerified: true,
        gptRedundancyVerified: true,
        bootAncestorPaths: [],
        bootAncestryResolved: true,
      }).protectedReason,
    ).toMatch(/Firmware/);
  });

  it("keeps LUKS and unknown filesystems out of automatic shrink claims", () => {
    const encrypted = parse(serializedInventory({}, { fstype: "crypto_LUKS" }))
      .partitions[1];
    expect(encrypted).toMatchObject({
      filesystem: "unknown",
      role: "unknown",
      encryption: "luks",
    });
    expect(encrypted?.resize).toBeUndefined();
    const unknown = parse(serializedInventory({}, { fstype: null }))
      .partitions[1];
    expect(unknown?.encryption).toBe("unknown");
  });

  it.each([
    ["missing serial", { serial: null }, {}],
    ["invalid GPT GUID", { ptuuid: "not-a-guid" }, {}],
    ["fractional sector size", { "log-sec": 512.5 }, {}],
    ["missing PARTUUID", {}, { partuuid: null }],
    ["invalid GPT PARTUUID", {}, { partuuid: "12345678-01" }],
    ["fractional partition start", {}, { start: 1.5 }],
  ])("rejects %s", (_name, diskOverrides, partitionOverrides) => {
    expect(() =>
      parse(serializedInventory(diskOverrides, partitionOverrides)),
    ).toThrow();
  });

  it("rejects ambiguous multi-disk output", () => {
    const parsed = JSON.parse(serializedInventory()) as {
      blockdevices: Array<Record<string, unknown>>;
    };
    parsed.blockdevices.push({ ...parsed.blockdevices[0], path: "/dev/vdb" });
    expect(() => parse(JSON.stringify(parsed))).toThrow(
      /exactly one whole disk/,
    );
  });

  it("rejects canonical device-path changes and foreign partitions", () => {
    expect(() => parse(serializedInventory({ path: "/dev/vdb" }))).toThrow(
      /path changed/,
    );
    expect(() =>
      parse(serializedInventory({}, { pkname: "/dev/vdb" })),
    ).toThrow(/another disk/);
  });
});
