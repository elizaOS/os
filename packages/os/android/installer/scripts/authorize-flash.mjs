#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultHardwareInventory = join(
  here,
  "..",
  "..",
  "hardware-targets.json",
);

function fail(message) {
  throw new Error(`[android-flash] ${message}`);
}

export function authorizeManifest(manifest, artifactFilenames, inventory) {
  if (!Array.isArray(manifest.supportedDevices)) {
    fail("manifest has no supportedDevices array");
  }
  if (!Array.isArray(inventory?.targets)) {
    fail("hardware inventory has no targets array");
  }
  const inventoryById = new Map(
    inventory.targets.map((target) => [target.id, target]),
  );
  for (const device of manifest.supportedDevices) {
    const target = inventoryById.get(device.targetId);
    if (!target) {
      fail(
        `manifest target ${device.targetId ?? "(missing)"} is not in the hardware inventory`,
      );
    }
    if (target.codename !== device.codename) {
      fail(
        `manifest target ${device.targetId} codename ${device.codename} does not match inventory ${target.codename}`,
      );
    }
  }
  const eligible = manifest.supportedDevices.filter(
    (device) => device.tier === "lab-validated",
  );
  if (eligible.length !== 1) {
    fail(
      `exactly one lab-validated device is required; found ${eligible.length}`,
    );
  }
  const device = eligible[0];
  const target = inventoryById.get(device.targetId);
  if (target.installerEligibility !== "eligible") {
    fail(
      `${device.targetId} is not installer-eligible (${target.installerEligibility ?? "unspecified"})`,
    );
  }
  if (device.rollbackSupported !== true) {
    fail(
      `${device.codename} is not authorized without verified rollback support`,
    );
  }
  const declared = new Set(
    (manifest.artifacts ?? []).map((artifact) => artifact.filename),
  );
  const extras = artifactFilenames.filter(
    (filename) => !declared.has(filename),
  );
  if (extras.length > 0) {
    fail(`artifact directory contains unlisted images: ${extras.join(", ")}`);
  }
  const unsafeMappings = (manifest.artifacts ?? []).filter(
    (artifact) => artifact.filename !== `${artifact.partition}.img`,
  );
  if (unsafeMappings.length > 0) {
    fail(
      `partition/filename mappings must be exact: ${unsafeMappings
        .map((artifact) => `${artifact.partition}=${artifact.filename}`)
        .join(", ")}`,
    );
  }
  return { codename: device.codename, releaseId: manifest.releaseId };
}

function parseArgs(argv) {
  const options = { manifest: "", artifactDir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") options.manifest = resolve(argv[++index] ?? "");
    else if (arg === "--artifact-dir")
      options.artifactDir = resolve(argv[++index] ?? "");
    else fail(`unknown argument ${arg}`);
  }
  if (!options.manifest || !options.artifactDir) {
    fail("--manifest and --artifact-dir are required");
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const validator = spawnSync(
    process.execPath,
    [
      join(here, "validate-release-manifest.mjs"),
      options.manifest,
      "--artifact-dir",
      options.artifactDir,
    ],
    { encoding: "utf8" },
  );
  if (validator.error || validator.status !== 0) {
    fail(
      `manifest or artifact integrity validation failed:\n${validator.stderr || validator.stdout}`,
    );
  }
  const manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
  const inventory = JSON.parse(readFileSync(defaultHardwareInventory, "utf8"));
  const images = readdirSync(options.artifactDir).filter((name) =>
    name.endsWith(".img"),
  );
  const authorization = authorizeManifest(manifest, images, inventory);
  process.stdout.write(`${authorization.codename}\n`);
  return authorization;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
