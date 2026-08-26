/**
 * Executable safety model for the native Linux Restore helper. This is not a
 * device inventory implementation and never authorizes a restore. It captures
 * the FD/identity invariants that the native boundary and its adversarial tests
 * must preserve while the UI capability remains disabled.
 */
export interface RestoreBlockIdentity {
  major: bigint;
  minor: bigint;
  diskseq: bigint;
  sizeBytes: bigint;
}

export interface RestorePartitionIdentity extends RestoreBlockIdentity {
  partitionNumber: 1;
  parentMajor: bigint;
  parentMinor: bigint;
}

export interface HeldRestoreTarget {
  readonly fdSlot: 3;
  readonly identity: RestoreBlockIdentity;
}

export interface HeldRestorePartition {
  readonly fdSlot: 4;
  readonly identity: RestorePartitionIdentity;
}

export const RESTORE_WHOLE_DEVICE_OPEN_FLAGS = [
  "O_RDWR",
  "O_CLOEXEC",
  "O_NOFOLLOW",
  "O_EXCL",
] as const;

/**
 * The retained whole-device claim is the exclusive claim for the operation.
 * A partition of that disk must not request a second O_EXCL claim with a
 * distinct file holder: Linux rejects that combination with EBUSY.
 */
export const RESTORE_PARTITION_OPEN_FLAGS = [
  "O_RDWR",
  "O_CLOEXEC",
  "O_NOFOLLOW",
] as const;

export class RestorePlanUseRegistry {
  readonly #used = new Set<string>();
  readonly #bootId: string;

  constructor(bootId: string) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)) {
      throw new Error("Restore boot identifier is not canonical.");
    }
    this.#bootId = bootId;
  }

  consume(planId: string, bootId: string): void {
    if (!/^[a-f0-9]{32}$/.test(planId)) {
      throw new Error("Restore plan identifier is not canonical.");
    }
    if (bootId !== this.#bootId) {
      throw new Error("Restore plan belongs to a different system boot.");
    }
    if (this.#used.has(planId)) {
      throw new Error("Restore plan was already consumed.");
    }
    this.#used.add(planId);
  }
}

export interface RestoreFdQualificationProbe {
  readonly executable: "/usr/bin/stat";
  readonly argv: readonly ["stat", "--format=%t:%T", `/proc/self/fd/${3 | 4}`];
  readonly inheritedFd: 3 | 4;
}

/**
 * Returns the only process shape currently modeled for a retained Restore FD.
 * It is deliberately a non-mutating qualification probe, not a restore tool.
 * No shell, PATH lookup, caller-supplied argv, or device pathname is accepted.
 */
export function restoreFdQualificationProbe(
  held: HeldRestoreTarget | HeldRestorePartition,
): RestoreFdQualificationProbe {
  const target = destructiveToolTarget(held);
  return {
    executable: "/usr/bin/stat",
    argv: ["stat", "--format=%t:%T", target],
    inheritedFd: held.fdSlot,
  };
}

function assertSameIdentity(
  actual: RestoreBlockIdentity,
  expected: RestoreBlockIdentity,
  subject: string,
): void {
  if (
    actual.major !== expected.major ||
    actual.minor !== expected.minor ||
    actual.diskseq !== expected.diskseq ||
    actual.sizeBytes !== expected.sizeBytes
  ) {
    throw new Error(`${subject} identity changed; restore is blocked.`);
  }
}

export function retainRestoreTarget(
  openedIdentity: RestoreBlockIdentity,
  authorizedIdentity: RestoreBlockIdentity,
): HeldRestoreTarget {
  assertSameIdentity(openedIdentity, authorizedIdentity, "Whole-device");
  return { fdSlot: 3, identity: { ...openedIdentity } };
}

export function retainRestorePartition(
  target: HeldRestoreTarget,
  openedPartition: RestorePartitionIdentity,
): HeldRestorePartition {
  if (
    openedPartition.partitionNumber !== 1 ||
    openedPartition.parentMajor !== target.identity.major ||
    openedPartition.parentMinor !== target.identity.minor ||
    openedPartition.diskseq !== target.identity.diskseq
  ) {
    throw new Error(
      "New partition is not bound to the retained whole-device identity.",
    );
  }
  return { fdSlot: 4, identity: { ...openedPartition } };
}

export function destructiveToolTarget(
  held: HeldRestoreTarget | HeldRestorePartition,
): `/proc/self/fd/${3 | 4}` {
  return `/proc/self/fd/${held.fdSlot}`;
}
