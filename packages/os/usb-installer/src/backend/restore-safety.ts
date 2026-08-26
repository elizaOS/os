import type { RemovableDrive, RestoreRequest, RestoreStepId } from "./types";

export const RESTORE_STEPS: readonly RestoreStepId[] = [
  "unmount",
  "wipe",
  "partition",
  "format",
  "verify",
  "complete",
];

export function assertRestoreTargetAllowed(
  request: RestoreRequest,
  drive: RemovableDrive,
): void {
  if (!request.acknowledgeDataLoss) {
    throw new Error(
      "Data-loss acknowledgement is required before restoring media.",
    );
  }
  if (drive.platform !== "linux") {
    throw new Error("Restore USB is currently supported only on Linux.");
  }
  if (drive.safety !== "safe-removable") {
    throw new Error("Restore USB blocked: target is not safe removable media.");
  }
  if (!drive.stableId) {
    throw new Error(
      "Restore USB blocked: target has no stable serial or WWN identity.",
    );
  }

  const expected = request.expectedDrive;
  if (!expected || typeof expected.stableId !== "string") {
    throw new Error(
      "Restore USB blocked: a stable target identity confirmation is required.",
    );
  }
  if (
    expected.devicePath !== drive.devicePath ||
    expected.sizeBytes !== drive.sizeBytes ||
    expected.stableId !== drive.stableId
  ) {
    throw new Error(
      "Selected drive changed before restore. Rescan and create a new restore plan.",
    );
  }
}
