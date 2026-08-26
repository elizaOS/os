// Implements platform-specific USB installer backend safety behavior.
import type {
  ElizaOsImage,
  InstallerStepId,
  RemovableDrive,
  RestoreCapability,
  RestoreExecutionTerminal,
  RestorePlan,
  RestoreReceipt,
  RestoreRequest,
  RestoreStepId,
  UsbInstallerBackend,
  WritePlan,
  WriteRequest,
} from "./types";

// Use the Vite proxy prefix when running in the browser dev server,
// so all requests go through /api/* → localhost:3742 — no CORS needed.
const SERVER = "/api";

export class HttpUsbInstallerBackend implements UsbInstallerBackend {
  async listRemovableDrives(): Promise<RemovableDrive[]> {
    const res = await fetch(`${SERVER}/drives`);
    if (!res.ok) throw await backendError(res);
    return res.json() as Promise<RemovableDrive[]>;
  }

  async listImages(): Promise<ElizaOsImage[]> {
    const res = await fetch(`${SERVER}/images`);
    if (!res.ok) throw await backendError(res);
    return res.json() as Promise<ElizaOsImage[]>;
  }

  async createWritePlan(request: WriteRequest): Promise<WritePlan> {
    const res = await fetch(`${SERVER}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) throw await backendError(res);
    return res.json() as Promise<WritePlan>;
  }

  async executeWritePlan(
    plan: WritePlan,
    onProgress: (stepId: InstallerStepId, progress: number) => void,
  ): Promise<void> {
    if (!plan.planId) {
      throw new Error("Write plan is missing a server plan id.");
    }

    const res = await fetch(`${SERVER}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: plan.planId }),
    });
    if (!res.ok) throw await backendError(res);
    if (!res.body) throw new Error("Backend response did not include a body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let terminal: SseTerminal | null = null;

    const acceptMessage = (message: string) => {
      if (terminal) {
        throw new Error("Backend sent an event after a terminal event.");
      }
      const event = parseSseMessage(message, onProgress);
      if (!event) {
        return;
      }
      terminal = event;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      pending += decoder.decode(value, { stream: true });
      const messages = pending.split(/\n\n/);
      pending = messages.pop() ?? "";

      for (const message of messages) {
        if (message.trim()) acceptMessage(message);
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) {
      throw new Error("Backend event stream ended with a truncated SSE event.");
    }
    const finalTerminal = terminal as SseTerminal | null;
    if (!finalTerminal) {
      throw new Error("Backend event stream ended without a terminal event.");
    }
    if (finalTerminal.kind !== "done") throw finalTerminal.error;
  }

  async cancelWritePlan(plan: WritePlan): Promise<void> {
    if (!plan.planId) {
      throw new Error("Write plan is missing a server plan id.");
    }

    const res = await fetch(`${SERVER}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: plan.planId }),
    });
    if (!res.ok) throw await backendError(res);
  }

  async getRestoreCapability(): Promise<RestoreCapability> {
    const res = await fetch(`${SERVER}/restore/capability`);
    if (!res.ok) throw await backendError(res);
    return res.json() as Promise<RestoreCapability>;
  }

  async createRestorePlan(request: RestoreRequest): Promise<RestorePlan> {
    const res = await fetch(`${SERVER}/restore/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) throw await backendError(res);
    return res.json() as Promise<RestorePlan>;
  }

  async executeRestorePlan(
    plan: RestorePlan,
    onProgress: (stepId: RestoreStepId, progress: number) => void,
  ): Promise<RestoreReceipt> {
    if (!plan.planId) {
      throw new Error("Restore plan is missing a server plan id.");
    }
    const res = await fetch(`${SERVER}/restore/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: plan.planId }),
    });
    if (!res.ok) throw await backendError(res);
    if (!res.body)
      throw new Error("Backend restore response did not include a body.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let terminal: RestoreExecutionTerminal | undefined;
    const acceptMessage = (message: string) => {
      if (terminal) {
        throw new Error(
          "Restore backend emitted an event after its terminal result.",
        );
      }
      terminal = parseRestoreSseMessage(message, onProgress) ?? undefined;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const messages = pending.split(/\n\n/);
      pending = messages.pop() ?? "";
      for (const message of messages) {
        if (message.trim()) acceptMessage(message);
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) {
      throw new Error(
        "Restore backend event stream ended with a truncated SSE event.",
      );
    }
    if (!terminal) {
      throw new Error(
        "Restore backend closed without a durable terminal result. Rescan the drive before retrying.",
      );
    }
    if (terminal.kind === "restore-failed") {
      const error = new Error(terminal.error);
      error.name = terminal.name;
      throw error;
    }
    return terminal.receipt;
  }
}

function parseRestoreSseMessage(
  message: string,
  onProgress: (stepId: RestoreStepId, progress: number) => void,
): RestoreExecutionTerminal | null {
  const lines = message.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1 || !lines[0]?.startsWith("data: ")) {
    throw new Error("Restore backend sent a malformed SSE event envelope.");
  }
  let value: unknown;
  try {
    value = JSON.parse(lines[0].slice(6));
  } catch {
    throw new Error("Restore backend sent malformed JSON.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Restore backend sent an invalid SSE payload.");
  }
  const data = value as Record<string, unknown>;
  if (data.terminal !== undefined) {
    return parseRestoreTerminal(data.terminal);
  }
  if (
    typeof data.stepId === "string" &&
    restoreSteps.has(data.stepId as RestoreStepId) &&
    typeof data.progress === "number" &&
    Number.isFinite(data.progress) &&
    data.progress >= 0 &&
    data.progress <= 1
  ) {
    onProgress(data.stepId as RestoreStepId, data.progress);
    return null;
  }
  throw new Error(
    "Restore backend sent an invalid progress or terminal event.",
  );
}

const restoreSteps = new Set<RestoreStepId>([
  "unmount",
  "wipe",
  "partition",
  "format",
  "verify",
  "complete",
]);

function parseRestoreTerminal(value: unknown): RestoreExecutionTerminal {
  if (!value || typeof value !== "object") {
    throw new Error("Restore backend emitted an invalid terminal result.");
  }
  const terminal = value as Record<string, unknown>;
  if (terminal.kind === "restore-failed") {
    if (
      typeof terminal.error !== "string" ||
      terminal.error.length === 0 ||
      typeof terminal.name !== "string" ||
      terminal.name.length === 0
    ) {
      throw new Error("Restore backend emitted an invalid failure result.");
    }
    return {
      kind: "restore-failed",
      error: terminal.error,
      name: terminal.name,
    };
  }
  if (terminal.kind !== "restore-complete") {
    throw new Error("Restore backend emitted an unknown terminal result.");
  }
  if (!terminal.receipt || typeof terminal.receipt !== "object") {
    throw new Error("Restore backend emitted an invalid completion receipt.");
  }
  const receipt = terminal.receipt as Record<string, unknown>;
  if (
    receipt.status !== "complete" ||
    typeof receipt.driveId !== "string" ||
    receipt.driveId.length === 0 ||
    typeof receipt.devicePath !== "string" ||
    !receipt.devicePath.startsWith("/dev/") ||
    typeof receipt.stableId !== "string" ||
    receipt.stableId.length === 0 ||
    receipt.filesystem !== "exfat" ||
    receipt.label !== "ELIZAOS-USB"
  ) {
    throw new Error("Restore backend emitted an invalid completion receipt.");
  }
  return {
    kind: "restore-complete",
    receipt: receipt as unknown as RestoreReceipt,
  };
}

async function backendError(res: Response): Promise<Error> {
  try {
    const data = (await res.json()) as { error?: string; name?: string };
    const err = new Error(data.error ?? `Backend error: ${res.status}`);
    err.name = data.name ?? "BackendError";
    return err;
  } catch {
    return new Error(`Backend error: ${res.status}`);
  }
}

type SseTerminal =
  | { kind: "done" }
  | { kind: "error" | "cancelled"; error: Error };

const installerSteps = new Set<InstallerStepId>([
  "resolve-image",
  "checksum",
  "write",
  "verify",
  "complete",
]);

function parseSseMessage(
  message: string,
  onProgress: (stepId: InstallerStepId, progress: number) => void,
): SseTerminal | null {
  const lines = message.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1 || !lines[0]?.startsWith("data: ")) {
    throw new Error("Backend sent a malformed SSE event envelope.");
  }
  let value: unknown;
  try {
    value = JSON.parse(lines[0].slice(6));
  } catch {
    throw new Error("Backend sent malformed JSON in an SSE event.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Backend SSE data must be a JSON object.");
  }
  const data = value as Record<string, unknown>;
  const keys = Object.keys(data).sort();
  const hasDone = data.done === true;
  const hasCancellation = data.cancelled === true;
  const hasError = typeof data.error === "string" && data.error.length > 0;

  if (hasDone) {
    if (hasCancellation || hasError || keys.join(",") !== "done") {
      throw new Error("Backend sent contradictory done terminal semantics.");
    }
    return { kind: "done" };
  }
  if (hasCancellation) {
    if (
      !hasError ||
      (data.name !== undefined && typeof data.name !== "string") ||
      keys.some((key) => !["cancelled", "error", "name"].includes(key))
    ) {
      throw new Error(
        "Backend sent malformed cancellation terminal semantics.",
      );
    }
    const error = new Error(data.error as string);
    error.name =
      typeof data.name === "string" ? data.name : "WriteCancelledError";
    return { kind: "cancelled", error };
  }
  if (hasError) {
    if (
      (data.name !== undefined && typeof data.name !== "string") ||
      keys.some((key) => !["error", "name"].includes(key))
    ) {
      throw new Error("Backend sent malformed error terminal semantics.");
    }
    const error = new Error(data.error as string);
    error.name = typeof data.name === "string" ? data.name : "BackendError";
    return { kind: "error", error };
  }
  if (
    keys.join(",") !== "progress,stepId" ||
    typeof data.stepId !== "string" ||
    !installerSteps.has(data.stepId as InstallerStepId) ||
    typeof data.progress !== "number" ||
    !Number.isFinite(data.progress) ||
    data.progress < 0 ||
    data.progress > 1
  ) {
    throw new Error("Backend sent malformed progress event semantics.");
  }
  onProgress(data.stepId as InstallerStepId, data.progress);
  return null;
}
