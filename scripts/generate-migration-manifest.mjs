/** Generates the content-addressed provenance record for the initial repository split. */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const rows = execFileSync("git", ["ls-files", "-s", "-z"])
  .toString()
  .split("\0")
  .filter(Boolean);
const files = [];

for (const row of rows) {
  const match = row.match(/^(\d+) ([0-9a-f]+) \d+\t(.+)$/s);
  if (!match) throw new Error(`Invalid index row: ${row}`);
  const [, mode, object, path] = match;
  if (path === "MIGRATION_MANIFEST.json") continue;
  if (mode === "160000") {
    files.push({ path, type: "gitlink", commit: object });
    continue;
  }

  const stat = fs.lstatSync(path);
  const bytes = stat.isSymbolicLink()
    ? Buffer.from(fs.readlinkSync(path))
    : fs.readFileSync(path);
  files.push({
    path,
    type: stat.isSymbolicLink() ? "symlink" : "file",
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  });
}

const manifest = {
  schema: "elizaos.os.migration/v1",
  sourceRepository: "https://github.com/elizaOS/eliza",
  sourceBaselineCommit: "069b3e9a1468c2cd1130792795481c0680f297ab",
  preparedAgainstCommit: "5f255cc1c2eccb3a7733ad6b866c6dec61a838b7",
  targetRepository: "https://github.com/elizaOS/os",
  mappings: [
    { source: "packages/os/**", target: "packages/os/**" },
    {
      source: "packages/app-core/packaging/debian/**",
      target: "packages/os/linux/packaging/debian/**",
    },
    {
      source: "packages/app-core/scripts/bun-riscv64/**",
      target: "packages/os/toolchains/bun-riscv64/**",
    },
    {
      source:
        "packages/app-core/scripts/aosp/{deploy-pixel,smoke-cuttlefish,lib,variant-config-schema}",
      target: "scripts/aosp/**",
    },
    {
      source:
        "packages/native/cmake/toolchain-{android-riscv64,riscv64-linux-gnu,riscv64-linux-musl}.cmake",
      target: "packages/os/toolchains/cmake/**",
    },
    {
      source: "OS/AOSP/Debian workflows and support scripts",
      target: ".github/** and packages/scripts/**",
    },
  ],
  files,
};

fs.writeFileSync(
  "MIGRATION_MANIFEST.json",
  `${JSON.stringify(manifest, null, 2)}\n`,
);
