import type {
  InstallExecutionDependencies,
  InstallExecutionResult,
  OwnerAuthorizationVerifier,
} from "./executor";
import { authorizeInstallPlan, executeAuthorizedInstallPlan } from "./executor";
import {
  createDiskExecutionIdentity,
  createDiskInventoryFingerprint,
} from "./planner";
import type {
  InstallAuthorization,
  InstallPlan,
  InstallRequest,
} from "./types";

const MAX_IPC_REQUEST_BYTES = 1024 * 1024;

export interface LocalInstallPeerProcessIdentity {
  /** Informational only; authorization must be based on livenessToken. */
  pid: number;
  /**
   * Adapter-owned, non-reusable process handle, such as a pidfd or a tuple
   * containing PID plus verified process start time. Never decoded from JSON.
   */
  livenessToken: object;
}

export interface LocalInstallPeerCredentials {
  transport: "unix";
  uid: number;
  gid: number;
  process: LocalInstallPeerProcessIdentity;
}

export interface ActiveOwnerSession {
  ownerId: string;
  uid: number;
  sessionId: string;
  active: boolean;
  locked: boolean;
}

/**
 * This adapter is part of the trusted service, not request data. Implementors
 * must obtain the active session from logind (or an equivalent OS authority)
 * and resolve membership with the adapter-owned non-reusable process token.
 */
export interface ActiveOwnerSessionProvider {
  /**
   * Return a single authoritative snapshot only when this live, non-reusable
   * process identity belongs to the reported active owner session.
   */
  inspectForProcess(
    process: LocalInstallPeerProcessIdentity,
  ): Promise<ActiveOwnerSession | null>;
}

export interface InstallAuthorizationReplayStore {
  claim(authorization: InstallAuthorization): Promise<boolean>;
}

export interface InstallTargetSerializer {
  runExclusive<T>(
    physicalIdentity: string,
    kernelDeviceIdentity: string | undefined,
    planId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface LocalInstallExecutionRequest {
  schemaVersion: 1;
  operation: "execute-reviewed-plan";
  request: InstallRequest;
  plan: InstallPlan;
  authorization: InstallAuthorization;
}

export interface PrivilegedInstallServiceDependencies
  extends InstallExecutionDependencies {
  activeOwner: ActiveOwnerSessionProvider;
  replay: InstallAuthorizationReplayStore;
  targets: InstallTargetSerializer;
}

function assertExactKeys(
  name: string,
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${name} contains missing or unsupported fields.`);
  }
}

function assertRequiredAndOptionalKeys(
  name: string,
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${name} contains missing or unsupported fields.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIpcRequest(input: unknown): LocalInstallExecutionRequest {
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new Error("Installer IPC request must be JSON-serializable data.");
  }
  if (
    encoded === undefined ||
    Buffer.byteLength(encoded, "utf8") > MAX_IPC_REQUEST_BYTES
  ) {
    throw new Error("Installer IPC request exceeds the bounded request size.");
  }
  const value: unknown = JSON.parse(encoded);
  if (!isRecord(value)) {
    throw new Error("Installer IPC request must be an object.");
  }
  assertExactKeys("Installer IPC request", value, [
    "schemaVersion",
    "operation",
    "request",
    "plan",
    "authorization",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.operation !== "execute-reviewed-plan" ||
    !isRecord(value.request) ||
    !isRecord(value.plan) ||
    !isRecord(value.authorization)
  ) {
    throw new Error("Installer IPC request has an unsupported shape.");
  }
  assertRequiredAndOptionalKeys(
    "Installer request",
    value.request,
    ["mode", "targetStableId", "expectedSizeBytes", "confirmationToken"],
    ["freeExtentId", "shrinkPartitionId"],
  );
  assertExactKeys("Installer plan", value.plan, [
    "schemaVersion",
    "planId",
    "mode",
    "target",
    "preservedPartitionIds",
    "partitions",
    "actions",
    "warnings",
    "compatibility",
    "executable",
  ]);
  assertExactKeys("Installer authorization", value.authorization, [
    "planId",
    "inventoryFingerprint",
    "ownerId",
    "issuedAt",
    "expiresAt",
    "nonce",
    "credential",
  ]);
  for (const [name, maximum] of [
    ["ownerId", 256],
    ["nonce", 256],
    ["credential", 64 * 1024],
  ] as const) {
    const field = value.authorization[name];
    if (
      typeof field !== "string" ||
      !field.trim() ||
      field.includes("\0") ||
      Buffer.byteLength(field, "utf8") > maximum
    ) {
      throw new Error(
        `Installer authorization ${name} is invalid or oversized.`,
      );
    }
  }
  return value as unknown as LocalInstallExecutionRequest;
}

/**
 * Parse exactly one adapter frame, enforcing the raw byte limit before JSON
 * decoding. A production socket adapter must frame one request per connection,
 * reject trailing frames/bytes, call this parser, and never accept a connected
 * descriptor transferred from another process.
 */
export function parseLocalInstallExecutionFrame(
  frame: Uint8Array | string,
): LocalInstallExecutionRequest {
  const bytes =
    typeof frame === "string" ? Buffer.from(frame, "utf8") : Buffer.from(frame);
  if (bytes.length === 0 || bytes.length > MAX_IPC_REQUEST_BYTES) {
    throw new Error("Installer IPC frame exceeds the bounded request size.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Installer IPC frame is not valid JSON.");
  }
  return parseIpcRequest(decoded);
}

function assertPeerShape(peer: LocalInstallPeerCredentials): void {
  if (
    peer.transport !== "unix" ||
    !Number.isSafeInteger(peer.uid) ||
    peer.uid <= 0 ||
    !Number.isSafeInteger(peer.gid) ||
    peer.gid < 0 ||
    !isRecord(peer.process) ||
    !Number.isSafeInteger(peer.process.pid) ||
    peer.process.pid <= 0 ||
    typeof peer.process.livenessToken !== "object" ||
    peer.process.livenessToken === null
  ) {
    throw new Error(
      "Installer requests require kernel-authenticated non-root Unix peer credentials.",
    );
  }
}

async function assertActiveOwnerCaller(
  peer: LocalInstallPeerCredentials,
  authorization: InstallAuthorization,
  sessions: ActiveOwnerSessionProvider,
): Promise<void> {
  const owner = await sessions.inspectForProcess(peer.process);
  if (
    owner === null ||
    !owner.active ||
    owner.locked ||
    !owner.ownerId.trim() ||
    !owner.sessionId.trim() ||
    owner.uid !== peer.uid ||
    owner.ownerId !== authorization.ownerId
  ) {
    throw new Error(
      "Installer caller is not the active unlocked owner session authorized by this credential.",
    );
  }
}

/**
 * Root-side core for a parsed request from a bounded local IPC adapter. It has
 * no socket implementation and accepts no command, argv, device path, or
 * operation name from the caller beyond the single typed plan operation. The
 * adapter must use parseLocalInstallExecutionFrame before calling execute.
 */
export class PrivilegedInstallService {
  readonly dependencies: PrivilegedInstallServiceDependencies;

  constructor(dependencies: PrivilegedInstallServiceDependencies) {
    this.dependencies = dependencies;
  }

  async execute(
    input: unknown,
    peer: LocalInstallPeerCredentials,
  ): Promise<InstallExecutionResult> {
    if (process.geteuid?.() !== 0) {
      throw new Error("Privileged installer service must run as root.");
    }
    assertPeerShape(peer);
    const message = parseIpcRequest(input);
    await assertActiveOwnerCaller(
      peer,
      message.authorization,
      this.dependencies.activeOwner,
    );

    const ownerBoundVerifier: OwnerAuthorizationVerifier = {
      verify: async (authorization) => {
        try {
          await assertActiveOwnerCaller(
            peer,
            authorization,
            this.dependencies.activeOwner,
          );
        } catch {
          return false;
        }
        return this.dependencies.authorization.verify(authorization);
      },
    };
    const executionDependencies: InstallExecutionDependencies = {
      inventory: this.dependencies.inventory,
      authorization: ownerBoundVerifier,
      journal: this.dependencies.journal,
      operations: this.dependencies.operations,
      beforePrivilegedMutation: async () => {
        await assertActiveOwnerCaller(
          peer,
          message.authorization,
          this.dependencies.activeOwner,
        );
      },
      now: this.dependencies.now,
    };
    // Validate the complete plan and credential before consuming replay state
    // or taking a durable target lock. Execution independently repeats the
    // inventory and authorization checks after the lock is held.
    const authorized = await authorizeInstallPlan(
      message.request,
      message.plan,
      message.authorization,
      executionDependencies,
    );
    if (!(await this.dependencies.replay.claim(message.authorization))) {
      throw new Error("Installer owner authorization nonce was already used.");
    }
    const executionInventory = await this.dependencies.inventory.inspect(
      authorized.target.stableId,
    );
    if (
      createDiskInventoryFingerprint(executionInventory) !==
      message.authorization.inventoryFingerprint
    ) {
      throw new Error(
        "Installer target changed before its physical execution lock was acquired.",
      );
    }
    const physicalIdentity = createDiskExecutionIdentity(executionInventory);
    return this.dependencies.targets.runExclusive(
      physicalIdentity,
      executionInventory.kernelDeviceIdentity,
      authorized.planId,
      () => executeAuthorizedInstallPlan(authorized, executionDependencies),
    );
  }
}
