/** Exercises live-app staging against isolated source and binds cold desktop preparation to app ownership. */

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
const linuxJustfileSource = readFileSync(
  join(repositoryRoot, "packages/os/linux/Justfile"),
  "utf8",
);
const runtimeSupplementsScript = join(
  repositoryRoot,
  "packages/os/linux/scripts/runtime-supplements.mjs",
);
const runtimeSupplements = JSON.parse(
  readFileSync(
    join(repositoryRoot, "packages/os/linux/runtime-supplements.json"),
    "utf8",
  ),
).packages;

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
  for (const { packageName, sourcePath } of runtimeSupplements) {
    writeJson(join(elizaRoot, sourcePath, "package.json"), {
      name: packageName,
      version: "1.0.0",
      type: "module",
    });
    mkdirSync(join(elizaRoot, sourcePath, "dist"), { recursive: true });
    writeFileSync(join(elizaRoot, sourcePath, "dist/index.js"), "export {};\n");
  }
}

test("one supplemental runtime manifest owns build, staging, and validation", () => {
  assert.deepEqual(
    runtimeSupplements.map((entry) => entry.packageName),
    [
      "@elizaos/plugin-app-manager",
      "@elizaos/plugin-health",
      "@elizaos/plugin-registry",
    ],
  );

  const stalePackageName = "@elizaos/plugin-" + "calendly";
  const staleSourcePath = "plugins/plugin-" + "calendly";
  const removedRuntimePackages = [
    "@elizaos/plugin-" + "remote-manifest",
    "@elizaos/plugin-" + "worker-runtime",
  ];
  const consumers = [
    "packages/os/linux/Justfile",
    "packages/os/linux/scripts/prepare-elizaos-app-overlay.mjs",
    "packages/os/linux/scripts/static-smoke.sh",
    "packages/os/linux/scripts/validate-runtime-overlay.mjs",
  ];
  for (const relativePath of consumers) {
    const source = readFileSync(join(repositoryRoot, relativePath), "utf8");
    assert.match(source, /runtime-supplements/);
    assert.equal(source.includes(stalePackageName), false);
    assert.equal(source.includes(staleSourcePath), false);
    for (const packageName of removedRuntimePackages) {
      assert.equal(source.includes(packageName), false);
    }
  }
  const staticSmokeSource = readFileSync(
    join(repositoryRoot, "packages/os/linux/scripts/static-smoke.sh"),
    "utf8",
  );
  assert.match(staticSmokeSource, /generated\?\.optionalPluginStubs/);
  assert.equal(staticSmokeSource.includes("@elizaos/plugin-" + "mlx"), false);

  const fixtureRoot = mkdtempSync(join(tmpdir(), "elizaos-supplements-"));
  try {
    createElizaSentinels(fixtureRoot);
    rmSync(join(fixtureRoot, "plugins/plugin-registry"), {
      force: true,
      recursive: true,
    });
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [runtimeSupplementsScript, "--source-root", fixtureRoot],
          { stdio: "pipe" },
        ),
      (error) =>
        error?.status === 1 &&
        error.stderr?.toString().includes("source package is missing") &&
        error.stderr?.toString().includes("@elizaos/plugin-registry"),
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [runtimeSupplementsScript, "--source-root"],
          { stdio: "pipe" },
        ),
      (error) =>
        error?.status === 1 &&
        error.stderr?.toString().includes("--source-root requires a value"),
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [runtimeSupplementsScript, "--source-root="],
          { stdio: "pipe" },
        ),
      (error) =>
        error?.status === 1 &&
        error.stderr?.toString().includes("--source-root requires a value"),
    );
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

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
    mkdirSync(join(stage, "Resources/app/renderer"), { recursive: true });
    writeFileSync(
      join(stage, "Resources/app/renderer/index.html"),
      "<!doctype html><title>Eliza</title>\n",
    );
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
    for (const { packageName, requiredEntry } of runtimeSupplements) {
      assert.equal(
        readFileSync(
          join(
            stage,
            "Resources/app/eliza-dist/node_modules",
            packageName,
            requiredEntry,
          ),
          "utf8",
        ),
        "export {};\n",
      );
    }
    const stagedRendererHtml = readFileSync(
      join(stage, "Resources/app/renderer/index.html"),
      "utf8",
    );
    assert.match(stagedRendererHtml, /<title>elizaOS<\/title>/);
    assert.doesNotMatch(stagedRendererHtml, /<title>Eliza<\/title>/);
    const personalAssistantStub = join(
      stage,
      "Resources/app/eliza-dist/node_modules/@elizaos/plugin-personal-assistant/index.js",
    );
    execFileSync(process.execPath, ["--check", personalAssistantStub], {
      stdio: "pipe",
    });
    assert.match(
      readFileSync(personalAssistantStub, "utf8"),
      /export const personalAssistantRoutesPlugin =/,
    );
    assert.equal(
      readlinkSync(join(stage, "node_modules")),
      "Resources/app/eliza-dist/node_modules",
    );
    assert.equal(
      readlinkSync(join(stage, "bin/node_modules")),
      "../Resources/app/eliza-dist/node_modules",
    );

    const healthEntry = join(elizaRoot, "plugins/plugin-health/dist/index.js");
    rmSync(healthEntry);
    assert.throws(
      () => runPrepare(elizaRoot, stage, "--check"),
      (error) =>
        error?.status === 1 &&
        error.stderr
          ?.toString()
          .includes("@elizaos/plugin-health required runtime entry is missing"),
    );
    writeFileSync(healthEntry, "export {};\n");

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

test("cold desktop builds require Linux x64 and generate release data before Electrobun", () => {
  const releaseDataCommand =
    "node packages/app-core/scripts/write-homepage-release-data.mjs";
  const releaseDataOffset = linuxJustfileSource.indexOf(releaseDataCommand);
  let boundarySearchOffset = 0;
  const buildBoundaryOffsets = [
    `if [ ! -x "\${app_out}/bin/launcher" ]; then`,
    'case "$(uname -s):$(uname -m)" in',
    `( cd "\${eliza_root}" && bun install --frozen-lockfile --ignore-scripts )`,
    `( cd "\${eliza_root}" && bun packages/scripts/ensure-workspace-symlinks.mjs )`,
    `fi
    test -x "\${app_out}/bin/launcher"`,
  ].map((source) => {
    const offset = linuxJustfileSource.indexOf(source, boundarySearchOffset);
    boundarySearchOffset = offset + source.length;
    return offset;
  });

  assert.notEqual(releaseDataOffset, -1);
  assert.equal(linuxJustfileSource.split(releaseDataCommand).length - 1, 1);
  const workspaceLinkerCommand =
    "bun packages/scripts/ensure-workspace-symlinks.mjs";
  assert.equal(linuxJustfileSource.split(workspaceLinkerCommand).length - 1, 2);
  assert.ok(buildBoundaryOffsets.every((offset) => offset >= 0));
  assert.deepEqual(
    [...buildBoundaryOffsets].sort((left, right) => left - right),
    buildBoundaryOffsets,
  );
  assert.ok(
    buildBoundaryOffsets[3] < releaseDataOffset &&
      releaseDataOffset <
        linuxJustfileSource.indexOf(
          "bun run --cwd packages/app-core/platforms/electrobun build",
        ),
  );
  assert.match(
    linuxJustfileSource,
    /Linux:x86_64\|Linux:amd64\) ;;[\s\S]+ELIZAOS_BUILD_APP=1 requires a Linux x86_64 host/,
  );
  const standaloneBranch = linuxJustfileSource.slice(
    linuxJustfileSource.indexOf("        else\n", buildBoundaryOffsets[0]),
    linuxJustfileSource.indexOf("        fi\n", releaseDataOffset),
  );
  assert.ok(
    standaloneBranch.indexOf(workspaceLinkerCommand) <
      standaloneBranch.indexOf("setup-upstreams.mjs"),
  );
  const outerBranch = linuxJustfileSource.slice(
    linuxJustfileSource.indexOf(
      `if [ -f "\${outer_root}/package.json" ]`,
      buildBoundaryOffsets[0],
    ),
    linuxJustfileSource.indexOf("        else\n", buildBoundaryOffsets[0]),
  );
  assert.ok(
    outerBranch.lastIndexOf("bun install") <
      outerBranch.indexOf(workspaceLinkerCommand),
  );
  assert.ok(
    outerBranch.indexOf(workspaceLinkerCommand) <
      outerBranch.indexOf("setup-upstreams.mjs"),
  );
});
