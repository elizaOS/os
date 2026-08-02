/** Guards the standalone repository's OS release writer and recovery boundaries. */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
}

interface WorkflowJob {
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

describe("OS release workflow authority", () => {
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
    const source = readFileSync(
      workflowPath("elizaos-os-release.yml"),
      "utf8",
    );
    const provisionIndex = source.indexOf(
      "- name: Provision ripgrep for Linux metadata validation",
    );
    const validationIndex = source.indexOf(
      "- name: Validate Linux live USB metadata",
    );

    expect(provisionIndex).toBeGreaterThan(0);
    expect(validationIndex).toBeGreaterThan(provisionIndex);
    expect(source).toContain("version=15.1.0");
    expect(source).toContain("X64) target=x86_64-unknown-linux-musl");
    expect(source).toContain("ARM64) target=aarch64-unknown-linux-gnu");
    expect(source).toContain('sha256sum --check "${archive}.sha256"');
    expect(source).toContain('echo "${bin_dir}" >> "${GITHUB_PATH}"');
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
      namedStep(
        workflow,
        "Download and verify the captured release asset set",
      ).run,
    ).toContain("release-asset-inventory.mjs verify");
    expect(
      namedStep(workflow, "Open the draft checksum recovery pull request").run,
    ).toContain("gh pr create");
    expect(source).not.toContain("workflow_call:");
  });
});
