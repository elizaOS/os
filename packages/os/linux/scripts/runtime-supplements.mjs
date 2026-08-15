#!/usr/bin/env node
/**
 * Loads the OS-owned runtime supplements that the desktop artifact does not
 * carry itself. Build, staging, and validation consume this one manifest so a
 * removed Eliza workspace package cannot survive as a hidden image contract.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const distroRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const runtimeSupplementsManifestPath = path.join(
  distroRoot,
  "runtime-supplements.json",
);

const supportedBuildModes = new Set(["bun-runtime-index", "package-js"]);

function fail(message) {
  throw new Error(
    `${runtimeSupplementsManifestPath}: invalid runtime supplement manifest: ${message}`,
  );
}

function assertRelativePath(value, field, packageName) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.isAbsolute(value) ||
    value === "." ||
    value !== path.posix.normalize(value) ||
    value.includes("\\") ||
    Array.from(value, (character) => character.charCodeAt(0)).some(
      (codePoint) => codePoint < 32 || codePoint === 127,
    ) ||
    value.split("/").includes("..")
  ) {
    fail(`${packageName}.${field} must be a normalized relative path`);
  }
}

export function loadRuntimeSupplements({ sourceRoot } = {}) {
  const manifest = JSON.parse(
    fs.readFileSync(runtimeSupplementsManifestPath, "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length === 0
  ) {
    fail("schemaVersion must be 1 and packages must be a non-empty array");
  }

  const packageNames = new Set();
  const sourcePaths = new Set();
  for (const entry of manifest.packages) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.packageName !== "string" ||
      !/^@elizaos\/plugin-[a-z0-9-]+$/.test(entry.packageName)
    ) {
      fail("every packageName must be an @elizaos/plugin-* package");
    }
    if (packageNames.has(entry.packageName)) {
      fail(`duplicate packageName ${entry.packageName}`);
    }
    packageNames.add(entry.packageName);

    assertRelativePath(entry.sourcePath, "sourcePath", entry.packageName);
    assertRelativePath(entry.requiredEntry, "requiredEntry", entry.packageName);
    if (sourcePaths.has(entry.sourcePath)) {
      fail(`duplicate sourcePath ${entry.sourcePath}`);
    }
    sourcePaths.add(entry.sourcePath);
    if (!supportedBuildModes.has(entry.buildMode)) {
      fail(`${entry.packageName}.buildMode is unsupported: ${entry.buildMode}`);
    }

    if (sourceRoot) {
      const packageJsonPath = path.join(
        sourceRoot,
        entry.sourcePath,
        "package.json",
      );
      if (!fs.existsSync(packageJsonPath)) {
        fail(
          `${entry.packageName} source package is missing: ${packageJsonPath}`,
        );
      }
      const sourceManifest = JSON.parse(
        fs.readFileSync(packageJsonPath, "utf8"),
      );
      if (sourceManifest.name !== entry.packageName) {
        fail(
          `${entry.packageName} source manifest declares ${String(sourceManifest.name)}`,
        );
      }
    }
  }

  return manifest.packages;
}

function parseCli(argv) {
  let format = "json";
  let sourceRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--format") {
      format = argv[index + 1];
      if (!format || format.startsWith("--")) {
        fail("--format requires a value");
      }
      index += 1;
    } else if (arg.startsWith("--format=")) {
      format = arg.slice("--format=".length);
      if (!format) fail("--format requires a value");
    } else if (arg === "--source-root") {
      sourceRoot = argv[index + 1];
      if (!sourceRoot || sourceRoot.startsWith("--")) {
        fail("--source-root requires a value");
      }
      index += 1;
    } else if (arg.startsWith("--source-root=")) {
      sourceRoot = arg.slice("--source-root=".length);
      if (!sourceRoot) fail("--source-root requires a value");
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  return { format, sourceRoot };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { format, sourceRoot } = parseCli(process.argv.slice(2));
  const packages = loadRuntimeSupplements({
    ...(sourceRoot ? { sourceRoot: path.resolve(sourceRoot) } : {}),
  });
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(packages)}\n`);
  } else if (format === "tsv") {
    for (const entry of packages) {
      process.stdout.write(
        `${entry.packageName}\t${entry.sourcePath}\t${entry.buildMode}\t${entry.requiredEntry}\n`,
      );
    }
  } else {
    fail(`unsupported output format ${format}`);
  }
}
