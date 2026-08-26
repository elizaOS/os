import { describe, expect, it } from "vitest";
import {
  destructiveToolTarget,
  RESTORE_PARTITION_OPEN_FLAGS,
  RESTORE_WHOLE_DEVICE_OPEN_FLAGS,
  type RestoreBlockIdentity,
  type RestorePartitionIdentity,
  RestorePlanUseRegistry,
  restoreFdQualificationProbe,
  retainRestorePartition,
  retainRestoreTarget,
} from "../linux-restore-helper-model";

const target: RestoreBlockIdentity = {
  major: 8n,
  minor: 240n,
  diskseq: 51n,
  sizeBytes: 64n * 1024n ** 3n,
};

function partition(
  overrides: Partial<RestorePartitionIdentity> = {},
): RestorePartitionIdentity {
  return {
    major: 8n,
    minor: 241n,
    diskseq: 51n,
    sizeBytes: 64n * 1024n ** 3n - 1024n ** 2n,
    partitionNumber: 1,
    parentMajor: 8n,
    parentMinor: 240n,
    ...overrides,
  };
}

describe("Linux Restore held-FD safety model", () => {
  it("retains an identity snapshot and never returns a caller pathname", () => {
    const opened = { ...target };
    const held = retainRestoreTarget(opened, target);
    opened.diskseq = 999n;

    expect(held.identity.diskseq).toBe(51n);
    expect(destructiveToolTarget(held)).toBe("/proc/self/fd/3");
    expect(restoreFdQualificationProbe(held)).toEqual({
      executable: "/usr/bin/stat",
      argv: ["stat", "--format=%t:%T", "/proc/self/fd/3"],
      inheritedFd: 3,
    });
  });

  it.each([
    { diskseq: 52n },
    { major: 9n },
    { minor: 1n },
    { sizeBytes: target.sizeBytes + 1n },
  ])("blocks whole-device name reuse or identity drift: %o", (change) => {
    expect(() => retainRestoreTarget({ ...target, ...change }, target)).toThrow(
      /identity changed/,
    );
  });

  it("binds a new partition to the retained disk identity", () => {
    const heldTarget = retainRestoreTarget(target, target);
    const heldPartition = retainRestorePartition(heldTarget, partition());

    expect(destructiveToolTarget(heldPartition)).toBe("/proc/self/fd/4");
    expect(restoreFdQualificationProbe(heldPartition).argv[2]).toBe(
      "/proc/self/fd/4",
    );
  });

  it("uses one exclusive claim for the retained whole disk", () => {
    expect(RESTORE_WHOLE_DEVICE_OPEN_FLAGS).toContain("O_EXCL");
    expect(RESTORE_PARTITION_OPEN_FLAGS).not.toContain("O_EXCL");
  });

  it.each([
    { diskseq: 52n },
    { parentMajor: 9n },
    { parentMinor: 239n },
    { partitionNumber: 2 as 1 },
  ])(
    "blocks hot-unplug, name reuse, or wrong-parent partitions: %o",
    (change) => {
      const heldTarget = retainRestoreTarget(target, target);
      expect(() =>
        retainRestorePartition(heldTarget, partition(change)),
      ).toThrow(/not bound/);
    },
  );

  it("consumes canonical plan identifiers once", () => {
    const bootId = "01234567-89ab-cdef-0123-456789abcdef";
    const registry = new RestorePlanUseRegistry(bootId);
    const planId = "0123456789abcdef0123456789abcdef";
    registry.consume(planId, bootId);
    expect(() => registry.consume(planId, bootId)).toThrow(/already consumed/);
    expect(() => registry.consume("../not-a-plan", bootId)).toThrow(
      /not canonical/,
    );
    expect(() => new RestorePlanUseRegistry("NOT-A-BOOT-ID")).toThrow(
      /not canonical/,
    );
    expect(() =>
      new RestorePlanUseRegistry(bootId).consume(
        planId,
        "00000000-0000-0000-0000-000000000001",
      ),
    ).toThrow(/different system boot/);
  });
});
