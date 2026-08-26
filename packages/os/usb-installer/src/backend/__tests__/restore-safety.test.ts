import { describe, expect, it } from "vitest";
import { assertRestoreTargetAllowed } from "../restore-safety";
import type { RemovableDrive, RestoreRequest } from "../types";

const drive: RemovableDrive = {
  id: "sdb",
  name: "USB",
  devicePath: "/dev/sdb",
  sizeBytes: 16 * 1024 ** 3,
  bus: "usb",
  platform: "linux",
  safety: "safe-removable",
  stableId: "linux:serial-1",
};

const request: RestoreRequest = {
  driveId: drive.id,
  acknowledgeDataLoss: true,
  expectedDrive: {
    devicePath: drive.devicePath,
    sizeBytes: drive.sizeBytes,
    stableId: drive.stableId as string,
  },
};

const { stableId: _stableId, ...driveWithoutStableIdentity } = drive;

describe("restore target safety", () => {
  it("accepts only an exact stable safe-removable Linux identity", () => {
    expect(() => assertRestoreTargetAllowed(request, drive)).not.toThrow();
  });

  it.each([
    [{ ...drive, safety: "blocked-system" as const }, "safe removable"],
    [{ ...drive, safety: "unknown" as const }, "safe removable"],
    [{ ...drive, platform: "darwin" as const }, "only on Linux"],
    [driveWithoutStableIdentity, "no stable serial"],
    [{ ...drive, devicePath: "/dev/sdc" }, "changed before restore"],
    [{ ...drive, sizeBytes: drive.sizeBytes + 1 }, "changed before restore"],
    [{ ...drive, stableId: "linux:serial-2" }, "changed before restore"],
  ])("blocks unsafe or changed target %#", (candidate, message) => {
    expect(() => assertRestoreTargetAllowed(request, candidate)).toThrow(
      message,
    );
  });

  it("requires a fresh destructive acknowledgement", () => {
    expect(() =>
      assertRestoreTargetAllowed(
        { ...request, acknowledgeDataLoss: false },
        drive,
      ),
    ).toThrow("acknowledgement");
  });
});
