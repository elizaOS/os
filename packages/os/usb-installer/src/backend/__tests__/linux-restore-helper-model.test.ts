import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  destructiveToolTarget,
  RESTORE_MUTATION_CHILD_POLICY,
  RESTORE_MUTATION_ORCHESTRATION,
  RESTORE_MUTATION_TOOLS,
  RESTORE_PARTITION_OPEN_FLAGS,
  RESTORE_WHOLE_DEVICE_OPEN_FLAGS,
  type RestoreBlockIdentity,
  RestoreMutationSequence,
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

  it("keeps the candidate mutation argv absolute, constant, and FD-only", () => {
    for (const invocation of Object.values(RESTORE_MUTATION_TOOLS)) {
      expect(invocation.executable.startsWith("/")).toBe(true);
      for (const argument of invocation.argv) {
        expect(argument).not.toMatch(/^\/dev\//);
      }
    }
    expect(RESTORE_MUTATION_TOOLS["create-gpt"].argv).toContain(
      "/proc/self/fd/3",
    );
    expect(RESTORE_MUTATION_TOOLS["format-exfat"].argv).toContain(
      "/proc/self/fd/4",
    );
    expect(RESTORE_MUTATION_CHILD_POLICY).toEqual({
      environment: { LANG: "C", LC_ALL: "C", PATH: "/nonexistent" },
      standardInput: "null",
      timeoutMs: 15_000,
      killSignal: "SIGKILL",
      maxOutputBytesPerStream: 256 * 1024,
    });
  });

  it("revalidates and checks cancellation around every bounded child", () => {
    const validators = {
      "run-create-gpt": "validate-whole",
      "run-verify-gpt": "validate-whole",
      "run-settle-udev": "validate-whole",
      "run-format-exfat": "validate-whole-and-partition",
      "run-verify-exfat": "validate-whole-and-partition",
    } as const;

    const runBoundaries = RESTORE_MUTATION_ORCHESTRATION.filter((step) =>
      step.startsWith("run-"),
    );
    expect(runBoundaries).toEqual(Object.keys(validators));

    for (const [runStep, validator] of Object.entries(validators)) {
      const child = RESTORE_MUTATION_ORCHESTRATION.indexOf(
        runStep as (typeof RESTORE_MUTATION_ORCHESTRATION)[number],
      );
      expect(RESTORE_MUTATION_ORCHESTRATION[child - 2]).toBe(validator);
      expect(RESTORE_MUTATION_ORCHESTRATION[child - 1]).toBe("check-cancel");
      expect(RESTORE_MUTATION_ORCHESTRATION[child + 1]).toBe(validator);
      expect(RESTORE_MUTATION_ORCHESTRATION[child + 2]).toBe("check-cancel");
    }
  });

  it("never reports success for cancellation or failure after consumption", () => {
    const beforeMutation = new RestoreMutationSequence();
    expect(beforeMutation.terminate("cancelled")).toEqual({
      status: "cancelled",
      mediaState: "untouched",
      lastCompletedStep: "authorized",
    });

    const partial = new RestoreMutationSequence();
    partial.advance("plan-consumed");
    partial.advance("gpt-created");
    expect(partial.terminate("cancelled")).toEqual({
      status: "cancelled",
      mediaState: "incomplete",
      lastCompletedStep: "gpt-created",
    });

    const failed = new RestoreMutationSequence();
    failed.advance("plan-consumed");
    expect(failed.terminate("failed")).toMatchObject({
      status: "failed",
      mediaState: "incomplete",
    });
    expect(() => failed.advance("gpt-created")).toThrow(/terminal/);
  });

  it("fails closed at every boundary after durable plan consumption", () => {
    const steps = [
      "plan-consumed",
      "gpt-created",
      "gpt-verified",
      "kernel-reread",
      "udev-settled",
      "partition-retained",
      "exfat-formatted",
      "exfat-verified",
    ] as const;

    for (const [terminalIndex, terminalStep] of steps.entries()) {
      const sequence = new RestoreMutationSequence();
      for (const step of steps.slice(0, terminalIndex + 1)) {
        sequence.advance(step);
      }
      expect(sequence.terminate("failed")).toEqual({
        status: "failed",
        mediaState: "incomplete",
        lastCompletedStep: terminalStep,
      });
      expect(sequence.result()).not.toEqual({ status: "complete" });
    }
  });

  it("requires every verification and retention boundary before completion", () => {
    const sequence = new RestoreMutationSequence();
    expect(() => sequence.advance("gpt-created")).toThrow(/out of order/);
    for (const step of [
      "plan-consumed",
      "gpt-created",
      "gpt-verified",
      "kernel-reread",
      "udev-settled",
      "partition-retained",
      "exfat-formatted",
      "exfat-verified",
      "complete",
    ] as const) {
      sequence.advance(step);
    }
    expect(sequence.result()).toEqual({ status: "complete" });
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

const fdToolsPresent = Object.values(RESTORE_MUTATION_TOOLS).every((tool) =>
  existsSync(tool.executable),
);

describe.runIf(process.platform === "linux" && fdToolsPresent)(
  "Linux Restore candidate utility FD qualification",
  () => {
    it("creates and verifies GPT and exFAT through only inherited FDs", () => {
      const directory = mkdtempSync(
        join(tmpdir(), "elizaos-restore-fd-tools-"),
      );
      const wholePath = join(directory, "whole.img");
      const partitionPath = join(directory, "partition.img");
      const whole = openSync(wholePath, "w+");
      const partitionFd = openSync(partitionPath, "w+");
      ftruncateSync(whole, 64 * 1024 * 1024);
      ftruncateSync(partitionFd, 62 * 1024 * 1024);
      const invoke = (
        name: keyof typeof RESTORE_MUTATION_TOOLS,
      ): ReturnType<typeof spawnSync> => {
        const tool = RESTORE_MUTATION_TOOLS[name];
        const result = spawnSync(tool.executable, tool.argv.slice(1), {
          argv0: tool.argv[0],
          env: RESTORE_MUTATION_CHILD_POLICY.environment,
          stdio: [
            "ignore",
            "pipe",
            "pipe",
            tool.inheritedFds.includes(3) ? whole : "ignore",
            tool.inheritedFds.includes(4) ? partitionFd : "ignore",
          ],
          timeout: RESTORE_MUTATION_CHILD_POLICY.timeoutMs,
          killSignal: RESTORE_MUTATION_CHILD_POLICY.killSignal,
          maxBuffer: RESTORE_MUTATION_CHILD_POLICY.maxOutputBytesPerStream,
        });
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, result.stderr.toString()).toBe(0);
        return result;
      };

      try {
        invoke("create-gpt");
        invoke("verify-gpt");
        invoke("settle-udev");
        invoke("format-exfat");
        const verification = invoke("verify-exfat");
        expect(verification.stdout.toString()).toContain("clean");
      } finally {
        closeSync(partitionFd);
        closeSync(whole);
        rmSync(directory, { recursive: true });
      }
    });
  },
);
