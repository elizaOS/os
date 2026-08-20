import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { InstallInventoryProvider } from "./executor";
import { validateDiskInventory } from "./planner";
import type { DiskInventory, Filesystem, PartitionInventory } from "./types";

const execFileAsync = promisify(execFile);
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,254}$/;
const MIB = 1024 ** 2;
const ESP_GUID = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b";
const GPT_GUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MBR_PARTUUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{2}$/;
const LSBLK = "/usr/bin/lsblk";
const UDEVADM = "/usr/bin/udevadm";
const SFDISK = "/usr/sbin/sfdisk";
const SGDISK = "/usr/sbin/sgdisk";

interface LsblkDevice {
  path?: unknown;
  kname?: unknown;
  pkname?: unknown;
  type?: unknown;
  size?: unknown;
  "log-sec"?: unknown;
  pttype?: unknown;
  ptuuid?: unknown;
  fstype?: unknown;
  mountpoints?: unknown;
  parttype?: unknown;
  partuuid?: unknown;
  partlabel?: unknown;
  start?: unknown;
  serial?: unknown;
  wwn?: unknown;
  ro?: unknown;
  rm?: unknown;
  children?: unknown;
}

interface LsblkDocument {
  blockdevices?: unknown;
}

export interface LinuxInventoryCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface LinuxInventoryCommandRunner {
  run(
    command: string,
    args: readonly string[],
  ): Promise<LinuxInventoryCommandResult>;
}

const SGDISK_FAILURE_PATTERN =
  /\b(?:warning|caution|error|corrupt|damaged|invalid|mismatch(?:ed)?|problems?)\b|\b(?:doesn't|does not|don't|do not)\s+match\b/i;

export function isSgdiskRedundancyVerified(
  result: LinuxInventoryCommandResult,
): boolean {
  const report = `${result.stdout}\n${result.stderr}`;
  const cleanReport = report.replace(/\bNo problems found\./g, "");
  return (
    result.exitCode === 0 &&
    /\bNo problems found\./.test(report) &&
    !SGDISK_FAILURE_PATTERN.test(cleanReport)
  );
}

class ExecFileCommandRunner implements LinuxInventoryCommandRunner {
  async run(
    command: string,
    args: readonly string[],
  ): Promise<LinuxInventoryCommandResult> {
    try {
      const result = await execFileAsync(command, [...args], {
        encoding: "utf8",
        env: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        },
        maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failed = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      return {
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? failed.message,
        exitCode: typeof failed.code === "number" ? failed.code : 127,
      };
    }
  }
}

function requiredString(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Linux inventory ${name} is missing.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Linux inventory ${name} is not a non-negative safe integer.`,
    );
  }
  return value;
}

function booleanColumn(name: string, value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new Error(
    `Linux inventory ${name} must be an explicit boolean column.`,
  );
}

function flattenDevices(devices: unknown): LsblkDevice[] {
  if (!Array.isArray(devices)) {
    throw new Error("Linux inventory lsblk document has no device array.");
  }
  const flattened: LsblkDevice[] = [];
  for (const value of devices) {
    if (typeof value !== "object" || value === null) {
      throw new Error("Linux inventory lsblk device is not an object.");
    }
    const device = value as LsblkDevice;
    flattened.push(device);
    if (device.children !== undefined) {
      flattened.push(...flattenDevices(device.children));
    }
  }
  return flattened;
}

function filesystem(value: unknown): Filesystem {
  switch (optionalString(value)?.toLowerCase()) {
    case "vfat":
    case "fat":
    case "fat32":
      return "fat32";
    case "ntfs":
      return "ntfs";
    case "apfs":
      return "apfs";
    case "ext4":
      return "ext4";
    case "btrfs":
      return "btrfs";
    case "xfs":
      return "xfs";
    case "swap":
      return "swap";
    default:
      return "unknown";
  }
}

function mounts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Linux inventory mountpoints must be an array.");
  }
  return value.filter((item): item is string => typeof item === "string");
}

function partitionRole(device: LsblkDevice): PartitionInventory["role"] {
  if (optionalString(device.parttype)?.toLowerCase() === ESP_GUID) return "esp";
  if (optionalString(device.partlabel)?.toLowerCase().includes("recovery")) {
    return "recovery";
  }
  return filesystem(device.fstype) === "unknown" ? "unknown" : "data";
}

function partition(
  device: LsblkDevice,
  sectorBytes: number,
  partitionTable: DiskInventory["partitionTable"],
): PartitionInventory {
  const id = requiredString(
    "partition PARTUUID",
    device.partuuid,
  ).toLowerCase();
  if (
    (partitionTable === "gpt" && !GPT_GUID_PATTERN.test(id)) ||
    (partitionTable === "mbr" && !MBR_PARTUUID_PATTERN.test(id)) ||
    partitionTable === "none"
  ) {
    throw new Error(
      `Linux inventory partition ${id} is inconsistent with the partition table.`,
    );
  }
  const startSectors = safeInteger(`partition ${id} START`, device.start);
  const sizeBytes = safeInteger(`partition ${id} SIZE`, device.size);
  const startBytes = startSectors * sectorBytes;
  const endBytes = startBytes + sizeBytes;
  if (!Number.isSafeInteger(startBytes) || !Number.isSafeInteger(endBytes)) {
    throw new Error(
      `Linux inventory partition ${id} exceeds safe integer bounds.`,
    );
  }
  const detectedFilesystem = filesystem(device.fstype);
  return {
    id,
    startBytes,
    endBytes,
    role: partitionRole(device),
    filesystem: detectedFilesystem,
    encryption:
      optionalString(device.fstype)?.toLowerCase() === "crypto_luks"
        ? "luks"
        : detectedFilesystem === "unknown" || detectedFilesystem === "apfs"
          ? "unknown"
          : "none",
  };
}

function freeExtents(
  sizeBytes: number,
  partitions: PartitionInventory[],
): DiskInventory["freeExtents"] {
  const result: DiskInventory["freeExtents"] = [];
  let cursor = MIB;
  for (const item of [...partitions].sort(
    (left, right) => left.startBytes - right.startBytes,
  )) {
    if (item.startBytes > cursor) {
      result.push({
        id: `free-${cursor}-${item.startBytes}`,
        startBytes: cursor,
        endBytes: item.startBytes,
      });
    }
    cursor = Math.max(cursor, item.endBytes);
  }
  const safeEnd = Math.floor((sizeBytes - MIB) / MIB) * MIB;
  if (safeEnd > cursor) {
    result.push({
      id: `free-${cursor}-${safeEnd}`,
      startBytes: cursor,
      endBytes: safeEnd,
    });
  }
  return result;
}

export function parseLinuxLsblkInventory(options: {
  stableId: string;
  stablePath: string;
  devicePath: string;
  firmwarePath: string;
  firmware: DiskInventory["firmware"];
  serialized: string;
  partitionTableVerified: boolean;
  gptRedundancyVerified: boolean;
}): DiskInventory {
  let document: LsblkDocument;
  try {
    document = JSON.parse(options.serialized) as LsblkDocument;
  } catch {
    throw new Error("Linux inventory lsblk output is not valid JSON.");
  }
  const devices = flattenDevices(document.blockdevices);
  const disks = devices.filter((device) => device.type === "disk");
  if (disks.length !== 1) {
    throw new Error("Linux inventory must resolve exactly one whole disk.");
  }
  const disk = disks[0] as LsblkDevice;
  const diskPath = requiredString("whole-disk path", disk.path);
  if (diskPath !== options.devicePath) {
    throw new Error("Linux inventory whole-disk path changed during probing.");
  }
  const diskKernelName = requiredString("whole-disk kernel name", disk.kname);
  const sectorBytes = safeInteger("logical sector size", disk["log-sec"]);
  const sizeBytes = safeInteger("disk size", disk.size);
  const table = optionalString(disk.pttype)?.toLowerCase();
  const partitionTable: DiskInventory["partitionTable"] =
    table === "gpt" || table === "dos"
      ? table === "dos"
        ? "mbr"
        : "gpt"
      : table === undefined
        ? "none"
        : "unknown";
  const partitionDevices = devices.filter((device) => device.type === "part");
  for (const device of partitionDevices) {
    if (requiredString("partition parent", device.pkname) !== diskKernelName) {
      throw new Error(
        "Linux inventory contains a partition from another disk.",
      );
    }
  }
  const partitions = partitionDevices.map((device) =>
    partition(device, sectorBytes, partitionTable),
  );
  const serial = requiredString("disk serial", disk.serial);
  const wwn = optionalString(disk.wwn);
  const readOnly = booleanColumn("read-only", disk.ro);
  const removable = booleanColumn("removable", disk.rm);
  const protectedReason =
    partitionTable === "unknown"
      ? "Partition-table type is unknown."
      : partitionTable !== "none" && !options.partitionTableVerified
        ? "Partition-table verification failed."
        : partitionTable === "gpt" && !options.gptRedundancyVerified
          ? "GPT main/backup redundancy verification failed."
          : options.firmware === "unknown"
            ? "Firmware mode is unknown."
            : readOnly
              ? "Target disk is read-only."
              : removable
                ? "Target disk is removable media."
                : undefined;
  const inventory: DiskInventory = {
    stableId: options.stableId,
    path: options.stablePath,
    hardwareIdentity: {
      serial,
      ...(wwn ? { wwn } : {}),
      firmwarePath: options.firmwarePath,
      ...(partitionTable === "gpt"
        ? {
            gptDiskGuid: requiredString(
              "GPT disk GUID",
              disk.ptuuid,
            ).toLowerCase(),
          }
        : {}),
    },
    sizeBytes,
    logicalSectorBytes: sectorBytes,
    partitionTable,
    ...(partitionTable === "gpt"
      ? { gptRedundancyVerified: options.gptRedundancyVerified }
      : {}),
    currentBootSource: devices.some((device) =>
      mounts(device.mountpoints).includes("/"),
    ),
    firmware: options.firmware,
    ...(protectedReason ? { protectedReason } : {}),
    partitions,
    freeExtents: freeExtents(sizeBytes, partitions),
  };
  validateDiskInventory(inventory);
  return inventory;
}

export interface LinuxInstallInventoryProviderOptions {
  runner?: LinuxInventoryCommandRunner;
  byIdDirectory?: string;
  firmware?: DiskInventory["firmware"];
}

export class LinuxInstallInventoryProvider implements InstallInventoryProvider {
  private readonly runner: LinuxInventoryCommandRunner;
  private readonly byIdDirectory: string;
  private readonly firmware: DiskInventory["firmware"];

  constructor(options: LinuxInstallInventoryProviderOptions = {}) {
    this.runner = options.runner ?? new ExecFileCommandRunner();
    this.byIdDirectory = options.byIdDirectory ?? "/dev/disk/by-id";
    this.firmware = options.firmware ?? "unknown";
  }

  async inspect(stableId: string): Promise<DiskInventory> {
    if (!STABLE_ID_PATTERN.test(stableId) || /-part\d+$/i.test(stableId)) {
      throw new Error(
        "Linux inventory stable ID is not a whole-disk identifier.",
      );
    }
    const stablePath = join(this.byIdDirectory, stableId);
    const link = await lstat(stablePath);
    if (!link.isSymbolicLink()) {
      throw new Error("Linux inventory stable ID is not a device symlink.");
    }
    const devicePath = await realpath(stablePath);
    if (
      !devicePath.startsWith("/dev/") ||
      !(await stat(devicePath)).isBlockDevice()
    ) {
      throw new Error(
        "Linux inventory stable ID does not resolve to a block device.",
      );
    }
    const [lsblk, firmwarePath, verification, gptVerification] =
      await Promise.all([
        this.runner.run(LSBLK, [
          "--json",
          "--bytes",
          "--paths",
          "--output",
          "PATH,KNAME,PKNAME,TYPE,SIZE,LOG-SEC,PTTYPE,PTUUID,FSTYPE,MOUNTPOINTS,PARTTYPE,PARTUUID,PARTLABEL,START,SERIAL,WWN,RO,RM",
          devicePath,
        ]),
        this.runner.run(UDEVADM, [
          "info",
          "--query=path",
          `--name=${devicePath}`,
        ]),
        this.runner.run(SFDISK, ["--verify", devicePath]),
        this.runner.run(SGDISK, ["--verify", devicePath]),
      ]);
    if (lsblk.exitCode !== 0 || firmwarePath.exitCode !== 0) {
      throw new Error("Linux inventory read-only probes failed.");
    }
    if ((await realpath(stablePath)) !== devicePath) {
      throw new Error("Linux inventory stable ID changed during probing.");
    }
    return parseLinuxLsblkInventory({
      stableId,
      stablePath,
      devicePath,
      firmwarePath: requiredString("firmware path", firmwarePath.stdout),
      firmware: this.firmware,
      serialized: lsblk.stdout,
      partitionTableVerified: verification.exitCode === 0,
      gptRedundancyVerified: isSgdiskRedundancyVerified(gptVerification),
    });
  }
}
