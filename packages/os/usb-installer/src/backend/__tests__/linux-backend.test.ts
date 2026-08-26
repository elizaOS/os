// Exercises USB installer backend safety and platform behavior.
import { describe, expect, it } from "vitest";
import {
  LsblkParseError,
  NoPrivilegeEscalatorError,
  RestoreVerificationError,
  UnmountFailedError,
  WriteIncompleteError,
} from "../errors";
import {
  type ExecFileResult,
  findPrivilegeEscalator,
  LinuxUsbInstallerBackend,
} from "../linux-backend";

describe("findPrivilegeEscalator", () => {
  const env = {} as NodeJS.ProcessEnv;

  it("prefers pkexec when present", async () => {
    const result = await findPrivilegeEscalator(env, {
      hasCommand: async (cmd) => cmd === "pkexec",
      sudoNonInteractiveOk: async () => false,
    });
    expect(result).toEqual({ command: "pkexec", argsPrefix: [] });
  });

  it("falls back to sudo -n when sudo creds are cached", async () => {
    const result = await findPrivilegeEscalator(env, {
      hasCommand: async (cmd) => cmd === "sudo",
      sudoNonInteractiveOk: async () => true,
    });
    expect(result).toEqual({ command: "sudo", argsPrefix: ["-n"] });
  });

  it("does not select interactive sudo unless ELIZA_USB_ALLOW_SUDO=1", async () => {
    await expect(
      findPrivilegeEscalator(env, {
        hasCommand: async (cmd) => cmd === "sudo",
        sudoNonInteractiveOk: async () => false,
      }),
    ).rejects.toBeInstanceOf(NoPrivilegeEscalatorError);
  });

  it("uses interactive sudo when explicitly enabled", async () => {
    const result = await findPrivilegeEscalator(
      { ELIZA_USB_ALLOW_SUDO: "1" } as NodeJS.ProcessEnv,
      {
        hasCommand: async (cmd) => cmd === "sudo",
        sudoNonInteractiveOk: async () => false,
      },
    );
    expect(result).toEqual({ command: "sudo", argsPrefix: [] });
  });

  it("falls back to kdesu", async () => {
    const result = await findPrivilegeEscalator(env, {
      hasCommand: async (cmd) => cmd === "kdesu",
      sudoNonInteractiveOk: async () => false,
    });
    expect(result.command).toBe("kdesu");
  });

  it("falls back to doas", async () => {
    const result = await findPrivilegeEscalator(env, {
      hasCommand: async (cmd) => cmd === "doas",
      sudoNonInteractiveOk: async () => false,
    });
    expect(result).toEqual({ command: "doas", argsPrefix: [] });
  });

  it("throws NoPrivilegeEscalatorError with install hints when nothing is available", async () => {
    try {
      await findPrivilegeEscalator(env, {
        hasCommand: async () => false,
        sudoNonInteractiveOk: async () => false,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoPrivilegeEscalatorError);
      expect((err as Error).message).toMatch(/pkexec/);
      expect((err as Error).message).toMatch(/kdesu/);
      expect((err as Error).message).toMatch(/doas/);
    }
  });
});

describe("LinuxUsbInstallerBackend.listRemovableDrives", () => {
  function makeBackend(stdout: string) {
    return new LinuxUsbInstallerBackend({
      execFile: async (
        command: string,
        args: readonly string[],
      ): Promise<ExecFileResult> => {
        expect(command).toBe("lsblk");
        expect(args).toContain(
          "NAME,SIZE,TYPE,RM,MODEL,SERIAL,WWN,TRAN,HOTPLUG,MOUNTPOINTS",
        );
        return { stdout, stderr: "" };
      },
    });
  }

  function makeBackendWithSystemDiskNames(
    stdout: string,
    currentSystemDiskNames: Set<string>,
  ) {
    return new LinuxUsbInstallerBackend({
      execFile: async (
        command: string,
        args: readonly string[],
      ): Promise<ExecFileResult> => {
        expect(command).toBe("lsblk");
        expect(args).toContain(
          "NAME,SIZE,TYPE,RM,MODEL,SERIAL,WWN,TRAN,HOTPLUG,MOUNTPOINTS",
        );
        return { stdout, stderr: "" };
      },
      currentSystemDiskNames: async () => currentSystemDiskNames,
    });
  }

  it("blocks a removable disk when it is the current live/root disk", async () => {
    const backend = makeBackend(
      JSON.stringify({
        blockdevices: [
          {
            name: "sdb",
            size: String(16 * 1024 ** 3),
            type: "disk",
            rm: true,
            model: "Live USB",
            tran: "usb",
            hotplug: true,
            children: [
              {
                name: "sdb1",
                type: "part",
                mountpoints: ["/run/live/medium"],
              },
            ],
          },
        ],
      }),
    );

    const [drive] = await backend.listRemovableDrives();

    expect(drive).toMatchObject({
      id: "sdb",
      safety: "blocked-system",
      description: expect.stringContaining(
        "current system mount: /run/live/medium",
      ),
    });
  });

  it("blocks a removable disk when mountinfo identifies it as the current system disk", async () => {
    const backend = makeBackendWithSystemDiskNames(
      JSON.stringify({
        blockdevices: [
          {
            name: "sdb",
            size: String(16 * 1024 ** 3),
            type: "disk",
            rm: true,
            model: "Live USB",
            tran: "usb",
            hotplug: true,
            children: [
              {
                name: "sdb1",
                type: "part",
                mountpoints: ["/media/amnesia/ELIZAOS"],
              },
            ],
          },
        ],
      }),
      new Set(["sdb"]),
    );

    const [drive] = await backend.listRemovableDrives();

    expect(drive).toMatchObject({
      id: "sdb",
      safety: "blocked-system",
      description: expect.stringContaining("current system device"),
    });
  });

  it("allows a normal removable disk mounted under the user media path", async () => {
    const backend = makeBackend(
      JSON.stringify({
        blockdevices: [
          {
            name: "sdc",
            size: String(16 * 1024 ** 3),
            type: "disk",
            rm: true,
            model: "Target USB",
            serial: "USB-SERIAL-123",
            tran: "usb",
            hotplug: true,
            children: [
              {
                name: "sdc1",
                type: "part",
                mountpoints: ["/media/nubs/ELIZAOS"],
              },
            ],
          },
        ],
      }),
    );

    const [drive] = await backend.listRemovableDrives();

    expect(drive).toMatchObject({
      id: "sdc",
      safety: "safe-removable",
      stableId: "linux:USB-SERIAL-123",
    });
  });
});

describe("typed Linux errors", () => {
  it("UnmountFailedError carries device path + stderr", () => {
    const e = new UnmountFailedError("/dev/sdb1", "target is busy");
    expect(e.devicePath).toBe("/dev/sdb1");
    expect(e.stderr).toBe("target is busy");
    expect(e.message).toContain("/dev/sdb1");
    expect(e.message).toContain("busy");
  });

  it("WriteIncompleteError reports expected vs actual bytes", () => {
    const e = new WriteIncompleteError(1000, 500);
    expect(e.expectedBytes).toBe(1000);
    expect(e.actualBytes).toBe(500);
  });

  it("LsblkParseError truncates stdout snippet and preserves cause", () => {
    const cause = new SyntaxError("Unexpected token");
    const e = new LsblkParseError("a".repeat(800), cause);
    expect(e.stdoutSnippet.length).toBe(500);
    expect(e.message).toContain("Unexpected token");
  });
});

describe("Linux Restore USB", () => {
  const inventory = (serial = "RESTORE-SERIAL") =>
    JSON.stringify({
      blockdevices: [
        {
          name: "sdb",
          size: String(16 * 1024 ** 3),
          type: "disk",
          rm: true,
          model: "Restore USB",
          serial,
          wwn: null,
          tran: "usb",
          hotplug: true,
          mountpoints: [],
        },
      ],
    });

  function restoreBackend(
    finalFilesystem = "exfat",
    options: { mountsClear?: boolean } = {},
  ) {
    const elevated: string[][] = [];
    let layoutCalls = 0;
    const backend = new LinuxUsbInstallerBackend({
      currentSystemDiskNames: async () => new Set(),
      restoreCommandExists: async () => true,
      findEscalator: async () => ({ command: "sudo", argsPrefix: ["-n"] }),
      execFile: async (command, args) => {
        if (command === "sudo") {
          elevated.push([...args]);
          return { stdout: "", stderr: "" };
        }
        expect(command).toBe("lsblk");
        if (args.includes("--bytes")) {
          return { stdout: inventory(), stderr: "" };
        }
        if (args.includes("--fs")) {
          return {
            stdout: JSON.stringify({
              blockdevices: [
                {
                  name: "sdb",
                  path: "/dev/sdb",
                  type: "disk",
                  children: [
                    {
                      name: "sdb1",
                      path: "/dev/sdb1",
                      type: "part",
                      pkname: "sdb",
                      fstype: finalFilesystem,
                      label: "ELIZAOS-USB",
                    },
                  ],
                },
              ],
            }),
            stderr: "",
          };
        }
        layoutCalls += 1;
        return {
          stdout: JSON.stringify({
            blockdevices: [
              {
                name: "sdb",
                path: "/dev/sdb",
                type: "disk",
                children: [
                  {
                    name: "sdb1",
                    path: "/dev/sdb1",
                    type: "part",
                    pkname: "sdb",
                    mountpoints:
                      layoutCalls === 1 || options.mountsClear === false
                        ? ["/media/test/ELIZAOS"]
                        : [null],
                  },
                ],
              },
            ],
          }),
          stderr: "",
        };
      },
    });
    return { backend, elevated };
  }

  it("reports unavailable when a required formatting tool is missing", async () => {
    const backend = new LinuxUsbInstallerBackend({
      restoreCommandExists: async (command) => command !== "mkfs.exfat",
      findEscalator: async () => ({ command: "sudo", argsPrefix: ["-n"] }),
    });
    await expect(backend.getRestoreCapability()).resolves.toMatchObject({
      supported: false,
      filesystem: null,
      reason: expect.stringContaining("mkfs.exfat"),
    });
  });

  it("rebuilds one GPT/exFAT volume and verifies it after a durable sync", async () => {
    const { backend, elevated } = restoreBackend();
    const [drive] = await backend.listRemovableDrives();
    const plan = await backend.createRestorePlan({
      driveId: drive?.id as string,
      acknowledgeDataLoss: true,
      expectedDrive: {
        devicePath: drive?.devicePath as string,
        sizeBytes: drive?.sizeBytes as number,
        stableId: drive?.stableId as string,
      },
    });
    const progress: string[] = [];
    const receipt = await backend.executeRestorePlan(plan, (step, value) => {
      if (value === 1) progress.push(step);
    });

    expect(elevated).toEqual([
      ["-n", "umount", "/dev/sdb1"],
      ["-n", "wipefs", "--all", "/dev/sdb"],
      [
        "-n",
        "parted",
        "--script",
        "--align",
        "optimal",
        "/dev/sdb",
        "mklabel",
        "gpt",
        "mkpart",
        "ELIZAOS-DATA",
        "1MiB",
        "100%",
      ],
      ["-n", "partprobe", "/dev/sdb"],
      ["-n", "udevadm", "settle", "--timeout=30"],
      ["-n", "mkfs.exfat", "-n", "ELIZAOS-USB", "/dev/sdb1"],
      ["-n", "sync", "/dev/sdb"],
    ]);
    expect(progress).toEqual([
      "unmount",
      "wipe",
      "partition",
      "format",
      "verify",
      "complete",
    ]);
    expect(receipt).toMatchObject({
      status: "complete",
      stableId: "linux:RESTORE-SERIAL",
      filesystem: "exfat",
      label: "ELIZAOS-USB",
    });
  });

  it("never emits a completion receipt when final filesystem verification fails", async () => {
    const { backend } = restoreBackend("ext4");
    const [drive] = await backend.listRemovableDrives();
    const plan = await backend.createRestorePlan({
      driveId: drive?.id as string,
      acknowledgeDataLoss: true,
      expectedDrive: {
        devicePath: drive?.devicePath as string,
        sizeBytes: drive?.sizeBytes as number,
        stableId: drive?.stableId as string,
      },
    });
    await expect(
      backend.executeRestorePlan(plan, () => undefined),
    ).rejects.toBeInstanceOf(RestoreVerificationError);
  });

  it("fails before wiping when the target remains mounted", async () => {
    const { backend, elevated } = restoreBackend("exfat", {
      mountsClear: false,
    });
    const [drive] = await backend.listRemovableDrives();
    const plan = await backend.createRestorePlan({
      driveId: drive?.id as string,
      acknowledgeDataLoss: true,
      expectedDrive: {
        devicePath: drive?.devicePath as string,
        sizeBytes: drive?.sizeBytes as number,
        stableId: drive?.stableId as string,
      },
    });
    await expect(
      backend.executeRestorePlan(plan, () => undefined),
    ).rejects.toThrow("still has mounted filesystems");
    expect(elevated).toEqual([["-n", "umount", "/dev/sdb1"]]);
  });
});
