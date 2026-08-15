/** Guards the standalone repository's OS release writer and recovery boundaries. */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface WorkflowStep {
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  env?: Record<string, string>;
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
  test("standalone verification owns its Bun and Eliza source inputs", () => {
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
    const sourceCheckout = namedJobStep(
      workflow,
      "linux-static-smoke",
      "Checkout application source",
    );
    const linuxBunSetup = namedJobStep(
      workflow,
      "linux-static-smoke",
      "Setup Bun from packageManager",
    );
    const linuxNodeSetup = namedJobStep(
      workflow,
      "linux-static-smoke",
      "Setup Node 24",
    );
    const ripgrepSetup = namedJobStep(
      workflow,
      "linux-static-smoke",
      "Provision ripgrep for Linux static smoke",
    );
    const linuxJob = workflow.jobs?.["linux-static-smoke"];
    const linuxSteps = linuxJob?.steps ?? [];

    expect(packageMetadata.packageManager).toBe("bun@1.3.14");
    expect(packageMetadata.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
    expect(packageMetadata.engines?.node).toBe(">=24.0.0");
    expect(verifyNodeSetup.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    expect(linuxNodeSetup.uses).toBe(verifyNodeSetup.uses);
    expect(verifyNodeSetup.with?.["node-version"]).toBe("24");
    expect(linuxNodeSetup.with?.["node-version"]).toBe("24");
    expect(verifyBunSetup.uses).toMatch(/^oven-sh\/setup-bun@[0-9a-f]{40}$/);
    expect(linuxBunSetup.uses).toBe(verifyBunSetup.uses);
    expect(verifyBunSetup.with?.["bun-version-file"]).toBe("package.json");
    expect(linuxBunSetup.with?.["bun-version-file"]).toBe("package.json");
    expect(sourceCheckout.with).toMatchObject({
      repository: "elizaOS/eliza",
      ref: "f6d8f8ee7f3006693113bbc313979724e603b355",
      path: ".eliza-source",
    });
    expect(linuxJob?.env?.ELIZAOS_ELIZA_ROOT).toMatch(
      /github\.workspace.*\.eliza-source/,
    );
    expect(ripgrepSetup.shell).toBe("bash");
    expect(ripgrepSetup.run).toBe(ripgrepProvisioner);
    const ripgrepIndex = linuxSteps.indexOf(ripgrepSetup);
    const verifyLinuxIndex = linuxSteps.findIndex(
      (step) => step.run === "bun run verify:linux",
    );
    expect(ripgrepIndex).toBeGreaterThan(-1);
    expect(verifyLinuxIndex).toBeGreaterThan(ripgrepIndex);

    const cuttlefish = parseWorkflow("elizaos-cuttlefish.yml");
    const cuttlefishBunSetup = Object.values(cuttlefish.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.uses === verifyBunSetup.uses);
    expect(cuttlefishBunSetup?.with?.["bun-version-file"]).toBe(
      ".eliza-source/package.json",
    );
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

  test("release validation provisions ripgrep before Linux metadata checks", () => {
    const workflow = parseWorkflow("elizaos-os-release.yml");
    const steps = workflow.jobs?.["validate-os-release"]?.steps ?? [];
    const provision = namedJobStep(
      workflow,
      "validate-os-release",
      "Provision ripgrep for Linux metadata validation",
    );
    const validation = namedJobStep(
      workflow,
      "validate-os-release",
      "Validate Linux live USB metadata",
    );

    expect(provision.run).toBe(ripgrepProvisioner);
    expect(steps.indexOf(provision)).toBeGreaterThan(-1);
    expect(steps.indexOf(validation)).toBeGreaterThan(steps.indexOf(provision));
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
