// Exercises USB installer browser flows and screenshot quality gates.
import type { Page, Route } from "@playwright/test";

export const mockDrive = {
  id: "fake-usb",
  name: "elizaOS Test USB",
  devicePath: "/dev/sdz",
  sizeBytes: 16 * 1024 ** 3,
  bus: "usb",
  platform: "linux",
  safety: "safe-removable",
  stableId: "linux:playwright-usb",
  description: "Playwright mock removable drive",
};

export const mockImage = {
  id: "elizaos-stable",
  label: "elizaOS Live",
  version: "2026.05.19",
  channel: "stable",
  architecture: "x86_64",
  buildId: "playwright",
  publishedAt: "2026-05-19T00:00:00.000Z",
  url: "https://download.elizaos.ai/elizaos-live.iso",
  checksumSha256:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  sizeBytes: 4 * 1024 ** 3,
  minUsbSizeBytes: 8 * 1024 ** 3,
  manifestVersion: 1,
};

export interface MockInstallerApiCalls {
  planRequests: unknown[];
  executeRequests: unknown[];
  restorePlanRequests: unknown[];
  restoreExecuteRequests: unknown[];
}

export async function mockInstallerApi(
  page: Page,
  options: { writeFailure?: boolean } = {},
): Promise<MockInstallerApiCalls> {
  const calls: MockInstallerApiCalls = {
    planRequests: [],
    executeRequests: [],
    restorePlanRequests: [],
    restoreExecuteRequests: [],
  };

  await page.route("**/api/drives", async (route) => {
    await route.fulfill({ json: [mockDrive] });
  });

  await page.route("**/api/images", async (route) => {
    await route.fulfill({ json: [mockImage] });
  });

  await page.route("**/api/restore/capability", async (route) => {
    await route.fulfill({
      json: {
        supported: true,
        platform: "linux",
        filesystem: "exfat",
        reason: "Playwright restore capability",
      },
    });
  });

  await page.route("**/api/restore/plan", async (route) => {
    const request = route.request().postDataJSON();
    calls.restorePlanRequests.push(request);
    await route.fulfill({
      json: {
        planId: "playwright-restore-plan-id",
        request,
        drive: mockDrive,
        filesystem: "exfat",
        label: "ELIZAOS-USB",
        steps: ["unmount", "wipe", "partition", "format", "verify", "complete"],
      },
    });
  });

  await page.route("**/api/restore/execute", async (route) => {
    calls.restoreExecuteRequests.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        'data: {"stepId":"unmount","progress":1}',
        'data: {"stepId":"wipe","progress":1}',
        'data: {"stepId":"partition","progress":1}',
        'data: {"stepId":"format","progress":1}',
        'data: {"stepId":"verify","progress":1}',
        'data: {"stepId":"complete","progress":1}',
        'data: {"terminal":{"kind":"restore-complete","receipt":{"status":"complete","driveId":"fake-usb","devicePath":"/dev/sdz","stableId":"linux:playwright-usb","filesystem":"exfat","label":"ELIZAOS-USB"}}}',
        "",
      ].join("\n\n"),
    });
  });

  await page.route("**/api/plan", async (route) => {
    const request = route.request().postDataJSON();
    calls.planRequests.push(request);
    await route.fulfill({
      json: {
        planId: request.dryRun ? undefined : "playwright-plan-id",
        request,
        drive: mockDrive,
        image: mockImage,
        privilegedWriteImplemented: true,
        steps: [
          {
            id: "resolve-image",
            label: "Resolve image",
            status: request.dryRun ? "complete" : "pending",
            detail: request.dryRun
              ? "Dry-run complete; no bytes were written."
              : "Waiting to start.",
          },
          {
            id: "checksum",
            label: "Validate checksum",
            status: request.dryRun ? "complete" : "pending",
            detail: request.dryRun
              ? "Dry-run complete; no bytes were written."
              : "Waiting to start.",
          },
          {
            id: "write",
            label: "Write image",
            status: request.dryRun ? "complete" : "pending",
            detail: request.dryRun
              ? "Dry-run complete; no bytes were written."
              : "Waiting to start.",
          },
          {
            id: "verify",
            label: "Verify media",
            status: request.dryRun ? "complete" : "pending",
            detail: request.dryRun
              ? "Dry-run complete; no bytes were written."
              : "Waiting to start.",
          },
          {
            id: "complete",
            label: "Complete",
            status: request.dryRun ? "complete" : "pending",
            detail: request.dryRun
              ? "Dry-run complete; no bytes were written."
              : "Waiting to start.",
          },
        ],
      },
    });
  });

  await page.route("**/api/execute", async (route: Route) => {
    calls.executeRequests.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: "text/event-stream",
      body: options.writeFailure
        ? [
            'data: {"stepId":"write","progress":0.5}',
            'data: {"name":"WriteIncompleteError","error":"Write interrupted; media is incomplete."}',
            "",
          ].join("\n\n")
        : [
            'data: {"stepId":"resolve-image","progress":1}',
            'data: {"stepId":"checksum","progress":1}',
            'data: {"stepId":"write","progress":1}',
            'data: {"stepId":"verify","progress":1}',
            'data: {"stepId":"complete","progress":1}',
            'data: {"done":true}',
            "",
          ].join("\n\n"),
    });
  });

  return calls;
}
