import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizeInstallPlan,
  executeAuthorizedInstallPlan,
  type InstallExecutionDependencies,
  type InstallJournal,
  InstallRecoveryRequiredError,
} from "./executor";
import {
  createDiskConfirmationToken,
  createDiskInventoryFingerprint,
  createInstallPlan,
} from "./planner";
import type {
  DiskInventory,
  InstallAuthorization,
  InstallerAction,
  InstallJournalEntry,
  InstallRequest,
} from "./types";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const NOW = new Date("2026-08-20T04:00:00.000Z");

function disk(overrides: Partial<DiskInventory> = {}): DiskInventory {
  return {
    stableId: "wwn-0x5000c50012345678",
    path: "/dev/disk/by-id/wwn-0x5000c50012345678",
    hardwareIdentity: {
      serial: "Z4D3ABCD",
      wwn: "0x5000c50012345678",
      firmwarePath:
        "/sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0",
      gptDiskGuid: "f73cab3d-5f8c-43e6-9092-00fef09bd497",
    },
    sizeBytes: 256 * GIB,
    logicalSectorBytes: 4096,
    partitionTable: "gpt",
    currentBootSource: false,
    firmware: "uefi",
    partitions: [
      {
        id: "old-root",
        startBytes: MIB,
        endBytes: 128 * GIB,
        role: "os",
        filesystem: "ext4",
        osFamily: "linux",
        encryption: "none",
      },
    ],
    freeExtents: [{ id: "free", startBytes: 128 * GIB, endBytes: 255 * GIB }],
    ...overrides,
  };
}

function reviewedPlan(target: DiskInventory) {
  const request: InstallRequest = {
    mode: "erase-disk",
    targetStableId: target.stableId,
    expectedSizeBytes: target.sizeBytes,
    confirmationToken: createDiskConfirmationToken(target),
  };
  return { request, plan: createInstallPlan(request, target) };
}

function authorization(
  target: DiskInventory,
  planId: string,
): InstallAuthorization {
  return {
    planId,
    inventoryFingerprint: createDiskInventoryFingerprint(target),
    ownerId: "local-owner-1000",
    issuedAt: "2026-08-20T03:55:00.000Z",
    expiresAt: "2026-08-20T04:05:00.000Z",
    nonce: "approval-123",
    credential: "signed-local-owner-approval",
  };
}

class MemoryJournal implements InstallJournal {
  readonly entries: InstallJournalEntry[] = [];

  async read(planId: string): Promise<InstallJournalEntry[]> {
    return this.entries
      .filter((entry) => entry.planId === planId)
      .map((entry) => ({ ...entry }));
  }

  async append(entry: InstallJournalEntry): Promise<void> {
    this.entries.push({ ...entry });
  }
}

function digestAction(action: InstallerAction): string {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

function rehashJournal(entries: InstallJournalEntry[]): void {
  let previousDigest: string | null = null;
  for (const [sequence, entry] of entries.entries()) {
    const body = {
      ...entry,
      sequence,
      previousDigest,
      digest: undefined,
    };
    delete body.digest;
    entry.sequence = sequence;
    entry.previousDigest = previousDigest;
    entry.digest = createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex");
    previousDigest = entry.digest;
  }
}

function requiredJournalEntry(
  entries: InstallJournalEntry[],
  index: number,
): InstallJournalEntry {
  const entry = entries[index];
  if (!entry) throw new Error(`Test journal entry ${index} is missing.`);
  return entry;
}

function dependencies(
  target: DiskInventory,
  overrides: Partial<InstallExecutionDependencies> = {},
): InstallExecutionDependencies & { journal: MemoryJournal } {
  const journal = new MemoryJournal();
  const activeJournal = overrides.journal ?? journal;
  return {
    inventory: { inspect: async () => structuredClone(target) },
    authorization: { verify: async () => true },
    operations: {
      backupPartitionTable: async (inventory) => ({
        stableId: inventory.stableId,
        storageStableId: "installer-media-123",
        location: "/run/elizaos-installer/recovery/gpt.bin",
        sha256: "a".repeat(64),
      }),
      verifyPartitionTableBackup: async () => true,
      apply: async (action) => ({
        receiptId: `receipt-${action.type}`,
        actionDigest: digestAction(action),
      }),
    },
    now: () => NOW,
    ...overrides,
    journal: activeJournal,
  } as InstallExecutionDependencies & { journal: MemoryJournal };
}

describe("privileged installer execution boundary", () => {
  it("authorizes an exact reviewed plan against a fresh inventory", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);

    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    expect(authorized.executable).toBe(true);
    expect(authorized.planId).toBe(plan.planId);
    expect(authorized.authorization.ownerId).toBe("local-owner-1000");
  });

  it("rejects inventory drift before authorization", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const changed = disk({ sizeBytes: 257 * GIB });

    await expect(
      authorizeInstallPlan(
        request,
        plan,
        authorization(target, plan.planId),
        dependencies(changed),
      ),
    ).rejects.toThrow(/identity changed|stale/);
  });

  it.each([
    ["serial", { serial: "Z4D3EFGH" }],
    ["WWN", { wwn: "0x5000c50087654321" }],
    ["firmware path", { firmwarePath: "/sys/devices/virtual/block/loop7" }],
    ["GPT disk GUID", { gptDiskGuid: "1539e59f-943e-47cb-b0b9-6e6175818029" }],
  ])("rejects %s drift before authorization", async (_name, identityChange) => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const changed = disk({
      hardwareIdentity: { ...target.hardwareIdentity, ...identityChange },
    });

    await expect(
      authorizeInstallPlan(
        request,
        plan,
        authorization(target, plan.planId),
        dependencies(changed),
      ),
    ).rejects.toThrow(/identity changed|stale/);
  });

  it("backs up GPT, journals every action, and returns durable completion", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);
    let appliedCount = 0;
    deps.operations.apply = async (action) => {
      appliedCount += 1;
      return {
        receiptId: `receipt-${action.type}`,
        actionDigest: digestAction(action),
      };
    };
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    const result = await executeAuthorizedInstallPlan(authorized, deps);

    expect(result.completedActions).toBe(plan.actions.length);
    expect(deps.journal.entries[0]?.event).toBe("authorized");
    expect(deps.journal.entries[1]?.event).toBe(
      "partition-table-backup-verified",
    );
    expect(
      deps.journal.entries.filter((entry) => entry.event === "action-started"),
    ).toHaveLength(plan.actions.length);
    expect(
      deps.journal.entries.filter(
        (entry) => entry.event === "action-completed",
      ),
    ).toHaveLength(plan.actions.length);
    expect(deps.journal.entries.at(-1)?.event).toBe("execution-completed");

    const resumed = await executeAuthorizedInstallPlan(authorized, deps);
    expect(resumed).toEqual(result);
    expect(appliedCount).toBe(plan.actions.length);
  });

  it("fails closed when the journal cannot durably persist a checkpoint", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const volatileJournal: InstallJournal = {
      read: async () => [],
      append: async () => {},
    };
    const deps = dependencies(target, { journal: volatileJournal });
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
  });

  it("rejects a GPT backup stored on the disk being destroyed", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);
    deps.operations.backupPartitionTable = async (inventory) => ({
      stableId: inventory.stableId,
      storageStableId: inventory.stableId,
      location: "/target/recovery/gpt.bin",
      sha256: "b".repeat(64),
    });
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toThrow(/backup verification failed/);
  });

  it("re-verifies owner authorization before every mutation", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);
    let verificationCount = 0;
    let appliedCount = 0;
    deps.authorization.verify = async () => {
      verificationCount += 1;
      return verificationCount < 4;
    };
    deps.operations.apply = async (action) => {
      appliedCount += 1;
      return {
        receiptId: `receipt-${action.type}`,
        actionDigest: digestAction(action),
      };
    };
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toThrow(/authorization expired or failed/);
    expect(appliedCount).toBe(1);
  });

  it("requires recovery after an action starts without a completion receipt", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    let attempts = 0;
    const deps = dependencies(target);
    deps.operations.apply = async () => {
      attempts += 1;
      throw new Error("injected power loss");
    };
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toThrow("injected power loss");
    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
    expect(attempts).toBe(1);
  });

  it.each([
    [
      "completion before its action start",
      (entries: InstallJournalEntry[]) => {
        const started = requiredJournalEntry(entries, 2);
        const completed = requiredJournalEntry(entries, 3);
        entries[2] = completed;
        entries[3] = started;
      },
    ],
    [
      "a duplicate partition-table backup",
      (entries: InstallJournalEntry[]) => {
        entries[2] = { ...requiredJournalEntry(entries, 1) };
      },
    ],
    [
      "a mismatched action digest",
      (entries: InstallJournalEntry[]) => {
        requiredJournalEntry(entries, 3).actionDigest = "f".repeat(64);
      },
    ],
    [
      "an action receipt on a start checkpoint",
      (entries: InstallJournalEntry[]) => {
        requiredJournalEntry(entries, 2).receiptId = "impossible-early-receipt";
      },
    ],
    [
      "a record after terminal completion",
      (entries: InstallJournalEntry[]) => {
        entries.push({ ...requiredJournalEntry(entries, 0) });
      },
    ],
    [
      "a decreasing checkpoint timestamp",
      (entries: InstallJournalEntry[]) => {
        requiredJournalEntry(entries, 2).timestamp = "2026-08-20T03:59:59.000Z";
      },
    ],
  ])("rejects a validly rehashed journal with %s", async (_name, mutate) => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );
    await executeAuthorizedInstallPlan(authorized, deps);
    mutate(deps.journal.entries);
    rehashJournal(deps.journal.entries);

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
  });

  it("rejects a plan body changed after review", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const tampered = {
      ...plan,
      target: { ...plan.target, path: "/dev/sda" },
    };

    await expect(
      authorizeInstallPlan(
        request,
        tampered,
        authorization(target, plan.planId),
        dependencies(target),
      ),
    ).rejects.toThrow(/digest/);
  });
});
