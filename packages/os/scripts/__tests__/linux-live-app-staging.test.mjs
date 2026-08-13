/** Exercises the real live-app staging boundary against an isolated Eliza checkout. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const prepareScript = join(
  repositoryRoot,
  "packages/os/linux/scripts/prepare-elizaos-app-overlay.mjs",
);
const prepareSource = readFileSync(prepareScript, "utf8");

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function runPrepare(elizaRoot, stage, ...args) {
  return execFileSync(
    process.execPath,
    [prepareScript, "--stage", stage, ...args],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ELIZAOS_ELIZA_ROOT: elizaRoot,
        SOURCE_DATE_EPOCH: "0",
      },
      stdio: "pipe",
    },
  );
}

function createElizaSentinels(elizaRoot) {
  writeJson(join(elizaRoot, "package.json"), {
    name: "eliza-source-fixture",
    private: true,
  });
  writeJson(join(elizaRoot, "packages/app-core/package.json"), {
    name: "@elizaos/app-core",
    version: "1.0.0",
  });
  writeJson(join(elizaRoot, "plugins/plugin-health/package.json"), {
    name: "@elizaos/plugin-health",
    version: "1.0.0",
    type: "module",
  });
}

test("staging uses OS cleanup tooling and records the Eliza source identity", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "elizaos-live-staging-"));

  try {
    const elizaRoot = join(fixtureRoot, "eliza");
    const stage = join(fixtureRoot, "stage");
    createElizaSentinels(elizaRoot);
    execFileSync("git", ["init", "--quiet"], { cwd: elizaRoot });
    execFileSync("git", ["add", "."], { cwd: elizaRoot });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=OS staging test",
        "-c",
        "user.email=os-staging@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: elizaRoot },
    );

    writeJson(join(stage, "Resources/build.json"), {});
    writeJson(join(stage, "Resources/version.json"), {
      name: "fixture",
      identifier: "example.fixture",
    });
    writeJson(join(stage, "Resources/app/brand-config.json"), {});
    mkdirSync(join(stage, "Resources/app/eliza-dist/node_modules"), {
      recursive: true,
    });
    mkdirSync(join(stage, "bin"), { recursive: true });

    runPrepare(elizaRoot, stage);
    runPrepare(elizaRoot, stage, "--check");

    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: elizaRoot,
      encoding: "utf8",
    }).trim();
    const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: elizaRoot,
      encoding: "utf8",
    }).trim();
    const manifest = JSON.parse(
      readFileSync(
        join(stage, "Resources/app/elizaos-live-overlay-manifest.json"),
        "utf8",
      ),
    );
    const stagedHealth = JSON.parse(
      readFileSync(
        join(
          stage,
          "Resources/app/eliza-dist/node_modules/@elizaos/plugin-health/package.json",
        ),
        "utf8",
      ),
    );

    assert.deepEqual(manifest.source, {
      gitRoot,
      gitCommit,
      gitDirty: false,
      distroRoot: join(repositoryRoot, "packages/os/linux"),
    });
    assert.equal(stagedHealth.name, "@elizaos/plugin-health");
    assert.equal(stagedHealth.version, "1.0.0");
    assert.equal(
      readlinkSync(join(stage, "node_modules")),
      "Resources/app/eliza-dist/node_modules",
    );
    assert.equal(
      readlinkSync(join(stage, "bin/node_modules")),
      "../Resources/app/eliza-dist/node_modules",
    );

    writeFileSync(
      join(elizaRoot, "plugins/plugin-health/dirty-source-marker"),
      "dirty\n",
    );
    assert.throws(
      () => runPrepare(elizaRoot, stage, "--check"),
      (error) =>
        error?.status === 1 &&
        error.stderr
          ?.toString()
          .includes("Resources/app/elizaos-live-overlay-manifest.json"),
    );

    const nonGitRoot = join(fixtureRoot, "not-a-git-checkout");
    createElizaSentinels(nonGitRoot);
    mkdirSync(join(nonGitRoot, ".git"));
    assert.throws(
      () => runPrepare(nonGitRoot, stage, "--check"),
      /must be the root of a committed elizaOS\/eliza checkout/,
    );

    assert.match(
      prepareSource,
      /path\.join\(osRepositoryRoot, "\.eliza-source"\)/,
    );
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
