#!/usr/bin/env node
/**
 * grizzly-evidence.mjs — capture boot evidence from a Pixel 11 Pro in any state.
 *
 * A device stuck on the G logo produces no adb; the recoverable evidence lives
 * in the bootloader (getvar), pstore (console/pmsg ramoops from the previous
 * boot, readable from recovery after a forced reboot), and — once any shell
 * exists — logcat, dmesg, and the graphics service states. This script
 * captures whichever surfaces respond into one dated directory so every flash
 * attempt leaves an attributable record (active slot included, because the
 * bootloader silently falls back to the other slot after repeated failures).
 *
 * Usage:
 *   node scripts/distro-android/grizzly-evidence.mjs [--device SERIAL] [--out DIR]
 *
 * Every command's stdout/stderr is written verbatim, including failures —
 * "this surface did not respond" is itself evidence and is never fabricated.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function parseArgs(argv) {
  const options = { device: "", outRoot: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--device" && value) {
      options.device = value;
      index += 1;
    } else if (argument === "--out" && value) {
      options.outRoot = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`[grizzly-evidence] unknown argument: ${argument}`);
    }
  }
  return options;
}

function capture(outDir, name, command, args, { timeoutMs = 30_000 } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const status = result.error?.message ?? `exit ${result.status ?? "signal"}`;
  const body = [
    `# ${command} ${args.join(" ")}`,
    `# status: ${status}`,
    "",
    "## stdout",
    result.stdout ?? "",
    "## stderr",
    result.stderr ?? "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, `${name}.txt`), body);
  const succeeded = !result.error && result.status === 0;
  console.log(
    `[grizzly-evidence] ${succeeded ? "ok  " : "fail"} ${name} (${status})`,
  );
  return { succeeded, stdout: result.stdout ?? "" };
}

function adbArgs(device, rest) {
  return device ? ["-s", device, ...rest] : rest;
}

function fastbootArgs(device, rest) {
  return device ? ["-s", device, ...rest] : rest;
}

export function captureEvidence({ device = "", outRoot = "" } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(
    outRoot || path.join(repoRoot, "reports", "grizzly-evidence"),
    stamp,
  );
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[grizzly-evidence] writing to ${outDir}`);

  // Bootloader surface: slot state, unlock state, firmware versions.
  const fastbootDevices = capture(outDir, "fastboot-devices", "fastboot", [
    "devices",
  ]);
  if (fastbootDevices.stdout.trim()) {
    capture(
      outDir,
      "fastboot-getvar-all",
      "fastboot",
      fastbootArgs(device, ["getvar", "all"]),
    );
    // Tensor abl exposes read-only OEM debug commands; enumerate what this
    // bootloader offers, then pull the previous boot's kernel console.
    // `oem last_dmesg` after force-rebooting out of a G-logo hang is the
    // cheapest possible evidence — no serial cable, no recovery needed.
    // Unsupported commands just record their failure; that too is evidence.
    const oemCaptures = [
      ["fastboot-oem-cmds", ["oem", "list-oem-cmds"]],
      ["fastboot-oem-last-dmesg", ["oem", "last_dmesg"]],
      ["fastboot-oem-dmesg", ["oem", "dmesg"]],
      ["fastboot-oem-uart-status", ["oem", "uart", "status"]],
    ];
    for (const [name, rest] of oemCaptures) {
      capture(outDir, name, "fastboot", fastbootArgs(device, rest));
    }
  }

  // ADB surface: normal boot, recovery, or sideload all answer here.
  const adbDevices = capture(outDir, "adb-devices", "adb", ["devices", "-l"]);
  const hasAdb = /\b(device|recovery)\b/.test(
    adbDevices.stdout.split("\n").slice(1).join("\n"),
  );
  if (!hasAdb) {
    console.log(
      "[grizzly-evidence] no adb surface; bootloader evidence only. " +
        "For a hung boot: force-reboot to recovery (Power ~30s, then Vol-Down+Power) and rerun to pull pstore.",
    );
    return outDir;
  }

  const shellCaptures = [
    ["adb-state", ["get-state"]],
    // Stock reports ro.product.build.16k_page.enabled=false (4 KiB pages);
    // capture the kernel's actual page size whenever a shell answers so a
    // future QPR 16 KiB migration cannot silently invalidate that premise.
    ["page-size", ["shell", "getconf", "PAGE_SIZE"]],
    ["getprop", ["shell", "getprop"]],
    ["dmesg", ["shell", "dmesg"]],
    ["logcat", ["shell", "logcat", "-b", "all", "-d"]],
    ["pstore-list", ["shell", "ls", "-l", "/sys/fs/pstore/"]],
    // Kernel/init console of the PREVIOUS boot — the single most valuable
    // artifact for a G-logo hang (includes our elizaos-init kmsg markers).
    [
      "pstore-console-ramoops",
      ["shell", "cat", "/sys/fs/pstore/console-ramoops*"],
    ],
    ["pstore-pmsg-ramoops", ["shell", "cat", "/sys/fs/pstore/pmsg-ramoops*"]],
    [
      "init-svc-graphics",
      [
        "shell",
        "getprop | grep -E 'init\\.svc\\.(surfaceflinger|zygote|vendor|bootanim)|vendor\\.elizaos|sys\\.boot_completed|ro\\.boot\\.slot'",
      ],
    ],
    [
      "service-list-graphics",
      [
        "shell",
        "service list | grep -iE 'surface|composer|allocator|mapper' || true",
      ],
    ],
    ["modules", ["shell", "cat", "/proc/modules"]],
    ["dev-dri", ["shell", "ls", "-l", "/dev/dri"]],
    [
      "vendor-egl",
      ["shell", "ls", "-l", "/vendor/lib64/egl", "/vendor/lib64/hw"],
    ],
    ["tombstones", ["shell", "ls", "-l", "/data/tombstones"]],
    ["persisted-logd", ["shell", "ls", "-l", "/data/misc/logd"]],
    ["recovery-log", ["shell", "cat", "/tmp/recovery.log"]],
    ["mounts", ["shell", "cat", "/proc/mounts"]],
    ["metadata-markers", ["shell", "ls", "-l", "/metadata/"]],
  ];
  for (const [name, rest] of shellCaptures) {
    capture(outDir, name, "adb", adbArgs(device, rest));
  }
  return outDir;
}

if (import.meta.main) {
  captureEvidence(parseArgs(process.argv.slice(2)));
}
