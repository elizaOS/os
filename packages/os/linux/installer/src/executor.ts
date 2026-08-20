import { createHash } from "node:crypto";
import {
  createDiskInventoryFingerprint,
  createInstallPlan,
  validateDiskInventory,
} from "./planner";
import type {
  AuthorizedInstallPlan,
  DiskInventory,
  InstallAuthorization,
  InstallerAction,
  InstallerActionReceipt,
  InstallJournalEntry,
  InstallPlan,
  InstallRequest,
  PartitionTableBackup,
} from "./types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function actionDigest(action: InstallerAction): string {
  return sha256(JSON.stringify(action));
}

function planDigest(plan: InstallPlan | AuthorizedInstallPlan): string {
  const { planId: _planId, executable: _executable, ...body } = plan;
  if ("authorization" in body) {
    const { authorization: _authorization, ...authorizedBody } = body;
    return sha256(JSON.stringify({ ...authorizedBody, executable: false }));
  }
  return sha256(JSON.stringify({ ...body, executable: false }));
}

function assertIsoDate(name: string, value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${name} must be an exact ISO-8601 timestamp.`);
  }
  return parsed;
}

function assertPlanIntegrity(plan: InstallPlan | AuthorizedInstallPlan): void {
  if (!SHA256_PATTERN.test(plan.planId) || planDigest(plan) !== plan.planId) {
    throw new Error("Install plan digest does not match its canonical body.");
  }
}

function assertAuthorizationShape(authorization: InstallAuthorization): {
  issuedAt: number;
  expiresAt: number;
} {
  if (
    !SHA256_PATTERN.test(authorization.planId) ||
    !SHA256_PATTERN.test(authorization.inventoryFingerprint) ||
    !authorization.ownerId.trim() ||
    !authorization.nonce.trim() ||
    !authorization.credential.trim()
  ) {
    throw new Error(
      "Owner authorization identity, binding, nonce, and credential are required.",
    );
  }
  return {
    issuedAt: assertIsoDate("authorization.issuedAt", authorization.issuedAt),
    expiresAt: assertIsoDate(
      "authorization.expiresAt",
      authorization.expiresAt,
    ),
  };
}

function authorizationDigest(authorization: InstallAuthorization): string {
  return sha256(JSON.stringify(authorization));
}

function assertTargetIdentity(
  plan: InstallPlan | AuthorizedInstallPlan,
  inventory: DiskInventory,
): void {
  validateDiskInventory(inventory);
  if (
    inventory.stableId !== plan.target.stableId ||
    inventory.path !== plan.target.path ||
    inventory.sizeBytes !== plan.target.sizeBytes
  ) {
    throw new Error("Target disk identity changed after plan authorization.");
  }
  if (inventory.currentBootSource) {
    throw new Error("Refusing to mutate the disk that booted the installer.");
  }
  if (inventory.protectedReason) {
    throw new Error(`Target disk is protected: ${inventory.protectedReason}`);
  }
}

export interface InstallInventoryProvider {
  inspect(stableId: string): Promise<DiskInventory>;
}

export interface OwnerAuthorizationVerifier {
  verify(authorization: InstallAuthorization): Promise<boolean>;
}

export interface InstallJournal {
  read(planId: string): Promise<InstallJournalEntry[]>;
  append(entry: InstallJournalEntry): Promise<void>;
}

export interface PrivilegedInstallOperations {
  backupPartitionTable(inventory: DiskInventory): Promise<PartitionTableBackup>;
  verifyPartitionTableBackup(
    backup: PartitionTableBackup,
    inventory: DiskInventory,
  ): Promise<boolean>;
  apply(
    action: InstallerAction,
    inventory: DiskInventory,
  ): Promise<InstallerActionReceipt>;
}

export interface InstallExecutionDependencies {
  inventory: InstallInventoryProvider;
  authorization: OwnerAuthorizationVerifier;
  journal: InstallJournal;
  operations: PrivilegedInstallOperations;
  now?: () => Date;
}

export interface InstallExecutionResult {
  planId: string;
  completedActions: number;
  finalInventoryFingerprint: string;
}

export class InstallRecoveryRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallRecoveryRequiredError";
  }
}

export async function authorizeInstallPlan(
  request: InstallRequest,
  plan: InstallPlan,
  authorization: InstallAuthorization,
  dependencies: Pick<
    InstallExecutionDependencies,
    "inventory" | "authorization" | "now"
  >,
): Promise<AuthorizedInstallPlan> {
  assertPlanIntegrity(plan);
  if (plan.executable !== false) {
    throw new Error("Only a non-executable reviewed plan can be authorized.");
  }
  const inventory = await dependencies.inventory.inspect(plan.target.stableId);
  assertTargetIdentity(plan, inventory);
  const recreated = createInstallPlan(request, inventory);
  if (recreated.planId !== plan.planId) {
    throw new Error(
      "Install plan is stale against the current disk inventory.",
    );
  }
  const fingerprint = createDiskInventoryFingerprint(inventory);
  if (
    authorization.planId !== plan.planId ||
    authorization.inventoryFingerprint !== fingerprint
  ) {
    throw new Error(
      "Owner authorization is not bound to this plan and inventory.",
    );
  }
  const { issuedAt, expiresAt } = assertAuthorizationShape(authorization);
  const now = (dependencies.now ?? (() => new Date()))().getTime();
  if (issuedAt > now || expiresAt <= now || expiresAt <= issuedAt) {
    throw new Error("Owner authorization is not currently valid.");
  }
  if (!(await dependencies.authorization.verify(authorization))) {
    throw new Error("Owner authorization credential verification failed.");
  }
  return { ...plan, executable: true, authorization };
}

function journalEntryDigest(
  entry: Omit<InstallJournalEntry, "digest">,
): string {
  return sha256(JSON.stringify(entry));
}

function validateJournal(planId: string, entries: InstallJournalEntry[]): void {
  let previousDigest: string | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (
      entry.schemaVersion !== 1 ||
      entry.planId !== planId ||
      entry.sequence !== index ||
      entry.previousDigest !== previousDigest
    ) {
      throw new InstallRecoveryRequiredError(
        "Install journal sequence or identity is invalid.",
      );
    }
    const { digest, ...body } = entry;
    if (!SHA256_PATTERN.test(digest) || journalEntryDigest(body) !== digest) {
      throw new InstallRecoveryRequiredError(
        "Install journal digest chain verification failed.",
      );
    }
    previousDigest = digest;
  }
}

async function appendDurably(
  journal: InstallJournal,
  planId: string,
  entries: InstallJournalEntry[],
  body: Omit<
    InstallJournalEntry,
    "schemaVersion" | "planId" | "sequence" | "previousDigest" | "digest"
  >,
): Promise<InstallJournalEntry[]> {
  const unsigned = {
    schemaVersion: 1 as const,
    planId,
    sequence: entries.length,
    ...body,
    previousDigest: entries.at(-1)?.digest ?? null,
  };
  const entry = { ...unsigned, digest: journalEntryDigest(unsigned) };
  await journal.append(entry);
  const persisted = await journal.read(planId);
  validateJournal(planId, persisted);
  if (persisted.at(-1)?.digest !== entry.digest) {
    throw new InstallRecoveryRequiredError(
      "Install journal append was not durably observed.",
    );
  }
  return persisted;
}

function completedActionCount(
  plan: AuthorizedInstallPlan,
  entries: InstallJournalEntry[],
): number {
  const completed = entries.filter(
    (entry) => entry.event === "action-completed",
  );
  for (let index = 0; index < completed.length; index += 1) {
    const entry = completed[index];
    if (
      entry.actionIndex !== index ||
      entry.actionDigest !==
        actionDigest(plan.actions[index] as InstallerAction)
    ) {
      throw new InstallRecoveryRequiredError(
        "Install journal action history is not a completed plan prefix.",
      );
    }
  }
  const started = entries.filter((entry) => entry.event === "action-started");
  if (started.length !== completed.length) {
    throw new InstallRecoveryRequiredError(
      "An install action started without a durable completion receipt.",
    );
  }
  for (let index = 0; index < started.length; index += 1) {
    const entry = started[index];
    if (
      entry.actionIndex !== index ||
      entry.actionDigest !==
        actionDigest(plan.actions[index] as InstallerAction)
    ) {
      throw new InstallRecoveryRequiredError(
        "Install journal start history is not a planned action prefix.",
      );
    }
  }
  if (entries.some((entry) => entry.event === "execution-failed")) {
    throw new InstallRecoveryRequiredError(
      "The prior install attempt failed and requires explicit recovery.",
    );
  }
  return completed.length;
}

export async function executeAuthorizedInstallPlan(
  plan: AuthorizedInstallPlan,
  dependencies: InstallExecutionDependencies,
): Promise<InstallExecutionResult> {
  assertPlanIntegrity(plan);
  if (plan.executable !== true) {
    throw new Error("Install plan has not been authorized for execution.");
  }
  if (plan.authorization.planId !== plan.planId) {
    throw new Error("Owner authorization is bound to a different plan.");
  }
  assertAuthorizationShape(plan.authorization);
  const now = dependencies.now ?? (() => new Date());
  if (
    assertIsoDate("authorization.expiresAt", plan.authorization.expiresAt) <=
      now().getTime() ||
    !(await dependencies.authorization.verify(plan.authorization))
  ) {
    throw new Error("Owner authorization expired or failed re-verification.");
  }

  let entries = await dependencies.journal.read(plan.planId);
  validateJournal(plan.planId, entries);
  if (
    entries.length > 0 &&
    (entries[0]?.event !== "authorized" ||
      entries[0].inventoryFingerprint !==
        plan.authorization.inventoryFingerprint ||
      entries[0].receiptId !== authorizationDigest(plan.authorization))
  ) {
    throw new InstallRecoveryRequiredError(
      "Install journal is not rooted in this owner authorization.",
    );
  }
  let inventory = await dependencies.inventory.inspect(plan.target.stableId);
  assertTargetIdentity(plan, inventory);
  let fingerprint = createDiskInventoryFingerprint(inventory);

  if (entries.length === 0) {
    if (fingerprint !== plan.authorization.inventoryFingerprint) {
      throw new Error("Disk inventory drifted before execution began.");
    }
    entries = await appendDurably(dependencies.journal, plan.planId, entries, {
      event: "authorized",
      timestamp: now().toISOString(),
      inventoryFingerprint: fingerprint,
      receiptId: authorizationDigest(plan.authorization),
    });
    const backup =
      await dependencies.operations.backupPartitionTable(inventory);
    if (
      backup.stableId !== inventory.stableId ||
      !backup.storageStableId.trim() ||
      backup.storageStableId === inventory.stableId ||
      !backup.location.trim() ||
      !SHA256_PATTERN.test(backup.sha256) ||
      !(await dependencies.operations.verifyPartitionTableBackup(
        backup,
        inventory,
      ))
    ) {
      throw new Error("Partition-table backup verification failed.");
    }
    entries = await appendDurably(dependencies.journal, plan.planId, entries, {
      event: "partition-table-backup-verified",
      timestamp: now().toISOString(),
      inventoryFingerprint: fingerprint,
      receiptId: backup.sha256,
    });
  } else if (
    !entries.some((entry) => entry.event === "partition-table-backup-verified")
  ) {
    throw new InstallRecoveryRequiredError(
      "Install journal exists without a verified partition-table backup.",
    );
  }

  const completed = completedActionCount(plan, entries);
  let expectedFingerprint =
    [...entries]
      .reverse()
      .find(
        (entry) =>
          entry.event === "action-completed" ||
          entry.event === "partition-table-backup-verified",
      )?.inventoryFingerprint ?? plan.authorization.inventoryFingerprint;
  if (fingerprint !== expectedFingerprint) {
    throw new InstallRecoveryRequiredError(
      "Disk inventory differs from the last durable install checkpoint.",
    );
  }
  if (entries.some((entry) => entry.event === "execution-completed")) {
    if (completed !== plan.actions.length) {
      throw new InstallRecoveryRequiredError(
        "Install journal completed before every planned action finished.",
      );
    }
    return {
      planId: plan.planId,
      completedActions: completed,
      finalInventoryFingerprint: fingerprint,
    };
  }

  for (let index = completed; index < plan.actions.length; index += 1) {
    const action = plan.actions[index] as InstallerAction;
    inventory = await dependencies.inventory.inspect(plan.target.stableId);
    assertTargetIdentity(plan, inventory);
    fingerprint = createDiskInventoryFingerprint(inventory);
    if (fingerprint !== expectedFingerprint) {
      throw new InstallRecoveryRequiredError(
        "Disk inventory drifted immediately before a privileged action.",
      );
    }
    if (
      assertIsoDate("authorization.expiresAt", plan.authorization.expiresAt) <=
        now().getTime() ||
      !(await dependencies.authorization.verify(plan.authorization))
    ) {
      throw new Error(
        "Owner authorization expired or failed immediately before mutation.",
      );
    }
    const digest = actionDigest(action);
    entries = await appendDurably(dependencies.journal, plan.planId, entries, {
      event: "action-started",
      timestamp: now().toISOString(),
      inventoryFingerprint: fingerprint,
      actionIndex: index,
      actionDigest: digest,
    });
    try {
      const receipt = await dependencies.operations.apply(action, inventory);
      if (!receipt.receiptId.trim() || receipt.actionDigest !== digest) {
        throw new Error(
          "Privileged operation returned an invalid action receipt.",
        );
      }
      inventory = await dependencies.inventory.inspect(plan.target.stableId);
      assertTargetIdentity(plan, inventory);
      fingerprint = createDiskInventoryFingerprint(inventory);
      expectedFingerprint = fingerprint;
      entries = await appendDurably(
        dependencies.journal,
        plan.planId,
        entries,
        {
          event: "action-completed",
          timestamp: now().toISOString(),
          inventoryFingerprint: fingerprint,
          actionIndex: index,
          actionDigest: digest,
          receiptId: receipt.receiptId,
        },
      );
    } catch (error) {
      await appendDurably(dependencies.journal, plan.planId, entries, {
        event: "execution-failed",
        timestamp: now().toISOString(),
        inventoryFingerprint: fingerprint,
        actionIndex: index,
        actionDigest: digest,
      });
      throw error;
    }
  }

  entries = await appendDurably(dependencies.journal, plan.planId, entries, {
    event: "execution-completed",
    timestamp: now().toISOString(),
    inventoryFingerprint: fingerprint,
  });
  return {
    planId: plan.planId,
    completedActions: plan.actions.length,
    finalInventoryFingerprint: fingerprint,
  };
}
