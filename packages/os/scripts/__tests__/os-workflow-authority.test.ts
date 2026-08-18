/** Guards the standalone repository's OS release writer and recovery boundaries. */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface WorkflowStep {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  env?: Record<string, string>;
  needs?: string | string[];
  steps?: WorkflowStep[];
  uses?: string;
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
}

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const workflowsDirectory = join(repositoryRoot, ".github", "workflows");
const automaticManifestWorkflow = "elizaos-os-full-release.yml";
const recoveryWorkflow = "update-os-release-manifest.yml";
const ripgrepProvisioner = "packages/os/scripts/provision-ripgrep.sh";

function workflowPath(name: string): string {
  return join(workflowsDirectory, name);
}

function parseWorkflow(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(workflowPath(name), "utf8")) as Workflow;
}

function workflowNames(): string[] {
  return readdirSync(workflowsDirectory)
    .filter((entry) => /\.ya?ml$/.test(entry))
    .sort();
}

function localReusableCalls(workflow: Workflow): string[] {
  return Object.values(workflow.jobs ?? {})
    .map((job) => job.uses)
    .filter((value): value is string =>
      Boolean(value?.startsWith("./.github/workflows/")),
    )
    .map((value) => value.slice("./.github/workflows/".length));
}

function namedStep(workflow: Workflow, name: string): WorkflowStep {
  const step = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step as WorkflowStep;
}

function namedJobStep(
  workflow: Workflow,
  jobName: string,
  name: string,
): WorkflowStep {
  const step = workflow.jobs?.[jobName]?.steps?.find(
    (candidate) => candidate.name === name,
  );
  expect(step).toBeDefined();
  return step as WorkflowStep;
}

describe("OS release workflow authority", () => {
  test("optional Hetzner runners are opt-in and hosted runners are the default", () => {
    const optInExpression =
      "vars.HETZNER_FLEET_ONLINE == 'true' && '[\"self-hosted\",\"hetzner-robot\"]' || '[\"ubuntu-24.04\"]'";
    const hetznerWorkflows = workflowNames().filter((name) =>
      readFileSync(workflowPath(name), "utf8").includes("HETZNER_FLEET_ONLINE"),
    );

    expect(hetznerWorkflows.length).toBeGreaterThan(0);
    for (const name of hetznerWorkflows) {
      const source = readFileSync(workflowPath(name), "utf8");
      expect(source).toContain(optInExpression);
      expect(source).not.toContain("HETZNER_FLEET_ONLINE == 'false'");
    }
  });

  test("Linux ISO release owns the canonical Debian amd64 GUI inputs", () => {
    const workflow = parseWorkflow("build-linux-iso.yml");
    const job = workflow.jobs?.["build-iso"];
    const steps = job?.steps ?? [];
    const lockResolution = namedJobStep(
      workflow,
      "build-iso",
      "Resolve locked application source",
    );
    const appCheckout = namedJobStep(
      workflow,
      "build-iso",
      "Checkout application source",
    );
    const lockVerification = namedJobStep(
      workflow,
      "build-iso",
      "Verify application checkout matches release lock",
    );
    const dependencyInstall = namedJobStep(
      workflow,
      "build-iso",
      "Install workspace dependencies from frozen lockfile",
    );
    const smoke = namedJobStep(
      workflow,
      "build-iso",
      "Smoke test ISO through SeaBIOS and OVMF",
    );
    const appLock = JSON.parse(
      readFileSync(
        join(
          repositoryRoot,
          "packages/os/linux/elizaos/app-source.lock.json",
        ),
        "utf8",
      ),
    ) as { commit?: string; repository?: string; schema?: string };

    expect(job?.env?.ELIZAOS_ARCH).toBe("amd64");
    expect(job?.env?.ELIZAOS_PROFILE).toBe("gui");
    expect(job?.env?.ELIZAOS_LINUX_VARIANT).toBe("packages/os/linux/elizaos");
    expect(steps.indexOf(lockResolution)).toBeLessThan(
      steps.indexOf(appCheckout),
    );
    expect(steps.indexOf(lockVerification)).toBeLessThan(
      steps.indexOf(dependencyInstall),
    );
    expect(appCheckout.with?.ref).toBe("${{ steps.eliza-lock.outputs.ref }}");
    expect(lockResolution.run).toContain("app-source.lock.json");
    expect(lockVerification.run).toContain("rev-parse HEAD");
    expect(steps.some((step) => step.name === "Restore live-build cache")).toBe(
      false,
    );
    expect(appLock.schema).toBe("eliza.os.linux.app-source-lock.v1");
    expect(appLock.repository).toBe("https://github.com/elizaOS/eliza");
    expect(appLock.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(smoke.env?.ELIZAOS_ISO_SMOKE_CPU_MODEL).toBe("Haswell-v4");
    expect(smoke.run).toContain("smoke-test-iso.sh");
  });

  test("verification pins Bun while Linux static checks stay source-only", () => {
    const workflow = parseWorkflow("ci.yml");
    const packageMetadata = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { engines?: { node?: string }; packageManager?: string };
    const verifyNodeSetup = namedJobStep(workflow, "verify", "Setup Node 24");
    const verifyBunSetup = namedJobStep(
      workflow,
      "verify",
      "Setup Bun from packageManager",
    );
    const linuxJob = workflow.jobs?.["linux-static-smoke"];
    const linuxSteps = linuxJob?.steps ?? [];

    expect(packageMetadata.packageManager).toBe("bun@1.3.14");
    expect(packageMetadata.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
    expect(packageMetadata.engines?.node).toBe(">=24.0.0");
    expect(verifyNodeSetup.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    expect(verifyNodeSetup.with?.["node-version"]).toBe("24");
    expect(verifyBunSetup.uses).toMatch(/^oven-sh\/setup-bun@[0-9a-f]{40}$/);
    expect(verifyBunSetup.with?.["bun-version-file"]).toBe("package.json");
    expect(linuxJob?.env).toBeUndefined();
    expect(linuxSteps).toHaveLength(2);
    expect(linuxSteps[1]?.run).toBe("make -C packages/os/linux/elizaos lint");

    const cuttlefish = parseWorkflow("elizaos-cuttlefish.yml");
    const cuttlefishBunSetup = Object.values(cuttlefish.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.uses === verifyBunSetup.uses);
    expect(cuttlefishBunSetup?.with?.["bun-version-file"]).toBe(
      ".eliza-source/package.json",
    );
  });

  test("workflows use pinned Bun and fail closed on frozen lockfiles", () => {
    for (const name of workflowNames()) {
      const source = readFileSync(workflowPath(name), "utf8");
      expect(source).not.toContain('bun-version: "canary"');
      expect(source).not.toContain("--no-frozen-lockfile");

      for (const line of source.split("\n")) {
        if (/\brun:\s*bun install\s*$/.test(line)) {
          throw new Error(`${name} contains an unfrozen Bun install: ${line}`);
        }
      }
    }
  });

  test("application-source workflows share the audited release lock", () => {
    const appLock = JSON.parse(
      readFileSync(
        join(
          repositoryRoot,
          "packages/os/linux/elizaos/app-source.lock.json",
        ),
        "utf8",
      ),
    ) as { commit?: string };
    expect(appLock.commit).toMatch(/^[0-9a-f]{40}$/);

    for (const name of [
      "build-debian-package.yml",
      "elizaos-cuttlefish.yml",
      "elizaos-os-release.yml",
      "riscv64-smoke.yml",
    ]) {
      const source = readFileSync(workflowPath(name), "utf8");
      const pinnedDefaults = [
        ...source.matchAll(/default:\s*["']?([0-9a-f]{40})["']?/g),
        ...source.matchAll(/eliza-ref \|\| '([0-9a-f]{40})'/g),
      ].map((match) => match[1]);

      expect(pinnedDefaults.length).toBeGreaterThan(0);
      expect(new Set(pinnedDefaults)).toEqual(new Set([appLock.commit]));
    }
  });

  test("every checked-in AOSP brand resolves to an OS-owned vendor tree", () => {
    const brandDirectory = join(repositoryRoot, "scripts", "distro-android");
    const configs = readdirSync(brandDirectory).filter((entry) =>
      /^brand\..+\.json$/.test(entry),
    );

    expect(configs.length).toBeGreaterThan(0);
    for (const configName of configs) {
      const config = JSON.parse(
        readFileSync(join(brandDirectory, configName), "utf8"),
      ) as { vendorDir?: string };
      expect(config.vendorDir).toMatch(/^packages\/os\/android\/vendor\//);
      expect(existsSync(join(repositoryRoot, config.vendorDir as string))).toBe(
        true,
      );
    }
  });

  test("release validation invokes the canonical Debian source gate", () => {
    const workflow = parseWorkflow("elizaos-os-release.yml");
    const validation = namedJobStep(
      workflow,
      "validate-os-release",
      "Validate canonical Debian image source",
    );

    expect(validation.run).toBe("make -C packages/os/linux/elizaos lint");
  });

  test("one checked provisioner owns the ripgrep release", () => {
    const provisionerPath = join(repositoryRoot, ripgrepProvisioner);
    const source = readFileSync(provisionerPath, "utf8");

    expect(statSync(provisionerPath).mode & 0o111).not.toBe(0);
    expect(source).toContain("version=15.1.0");
    expect(source).toContain("X64) target=x86_64-unknown-linux-musl");
    expect(source).toContain("ARM64) target=aarch64-unknown-linux-gnu");
    expect(source).toContain(`sha256sum --check "\${archive}.sha256"`);
    expect(source).toContain(`echo "\${bin_dir}" >> "\${GITHUB_PATH}"`);
  });

  test("all local reusable workflow calls resolve", () => {
    for (const callerName of workflowNames()) {
      for (const calleeName of localReusableCalls(parseWorkflow(callerName))) {
        expect(existsSync(workflowPath(calleeName))).toBe(true);
        expect(parseWorkflow(calleeName).on?.workflow_call).toBeDefined();
      }
    }
  });

  test("every workflow job dependency resolves", () => {
    for (const name of workflowNames()) {
      const workflow = parseWorkflow(name);
      const jobNames = new Set(Object.keys(workflow.jobs ?? {}));

      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        const dependencies = Array.isArray(job.needs)
          ? job.needs
          : job.needs
            ? [job.needs]
            : [];
        for (const dependency of dependencies) {
          expect(jobNames.has(dependency), `${name}:${jobName} needs ${dependency}`).toBe(
            true,
          );
        }
      }
    }
  });

  test("one automatic manifest writer is distinct from manual recovery", () => {
    const writers = workflowNames().filter((name) => {
      const source = readFileSync(workflowPath(name), "utf8");
      return /packages\/os\/scripts\/(?:update-release-manifest|generate-release-checksums)\.mjs/.test(
        source,
      );
    });
    const automaticWriters = writers.filter((name) =>
      Object.keys(parseWorkflow(name).on ?? {}).some(
        (trigger) => trigger !== "workflow_dispatch",
      ),
    );

    expect(writers).toContain(automaticManifestWorkflow);
    expect(writers).toContain(recoveryWorkflow);
    expect(automaticWriters).toEqual([automaticManifestWorkflow]);
    expect(Object.keys(parseWorkflow(recoveryWorkflow).on ?? {})).toEqual([
      "workflow_dispatch",
    ]);
  });

  test("manual recovery binds immutable identities and opens a draft PR", () => {
    const workflow = parseWorkflow(recoveryWorkflow);
    const source = readFileSync(workflowPath(recoveryWorkflow), "utf8");

    expect(workflow.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(
      namedStep(
        workflow,
        "Bind base, tag, release, manifest, and asset identities",
      ).run,
    ).toContain("release-asset-inventory.mjs capture");
    expect(
      namedStep(workflow, "Download and verify the captured release asset set")
        .run,
    ).toContain("release-asset-inventory.mjs verify");
    expect(
      namedStep(workflow, "Open the draft checksum recovery pull request").run,
    ).toContain("gh pr create");
    expect(source).not.toContain("workflow_call:");
  });
});
