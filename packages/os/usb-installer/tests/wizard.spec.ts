// Exercises USB installer browser flows and screenshot quality gates.
import { expect, test } from "@playwright/test";
import { mockDrive, mockInstallerApi } from "./mock-installer-api";

test("runs the guarded USB write wizard with a mocked backend", async ({
  page,
}) => {
  const calls = await mockInstallerApi(page);

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "USB installer" }),
  ).toBeVisible();
  await expect(page.getByText(mockDrive.name)).toBeVisible();

  await page.getByRole("button", { name: /Next: Select Image/i }).click();
  await expect(
    page.getByRole("heading", { name: /Select elizaOS Image/i }),
  ).toBeVisible();

  await page.getByRole("button", { name: /Next: Specs Check/i }).click();
  await expect(
    page.getByRole("heading", { name: "Specs Check" }),
  ).toBeVisible();
  await expect(page.getByText("Drive capacity")).toBeVisible();
  await expect(page.getByText("Not a system disk")).toBeVisible();

  await page.getByRole("button", { name: /Next: Confirm & Write/i }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm Write" }),
  ).toBeVisible();

  await page
    .getByLabel(/I understand the drive will be completely erased/i)
    .check();
  await page.locator(".confirm-target-row input").fill(mockDrive.devicePath);
  await expect(
    page.getByRole("button", { name: "Write to Drive" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "Write to Drive" }).click();
  await expect(
    page.getByRole("heading", { name: /Write Complete/i }),
  ).toBeVisible();

  expect(calls.planRequests).toHaveLength(1);
  expect(calls.planRequests[0]).toMatchObject({
    driveId: mockDrive.id,
    dryRun: false,
    acknowledgeDataLoss: true,
    expectedDrive: {
      devicePath: mockDrive.devicePath,
      sizeBytes: mockDrive.sizeBytes,
      name: mockDrive.name,
    },
  });
  expect(calls.executeRequests).toEqual([{ planId: "playwright-plan-id" }]);

  await page
    .getByRole("button", { name: /Restore USB for normal storage/i })
    .click();
  await expect(
    page.getByRole("heading", { name: /Restore USB for Normal Storage/i }),
  ).toBeVisible();
  await page
    .getByLabel(/I understand all data on this USB will be erased/i)
    .check();
  await page.locator(".confirm-target-row input").fill(mockDrive.devicePath);
  await page.getByRole("button", { name: /Erase and Restore USB/i }).click();
  await expect(
    page.getByRole("heading", { name: /USB Restore Complete/i }),
  ).toBeVisible();
  expect(calls.restorePlanRequests).toEqual([
    {
      driveId: mockDrive.id,
      acknowledgeDataLoss: true,
      expectedDrive: {
        devicePath: mockDrive.devicePath,
        sizeBytes: mockDrive.sizeBytes,
        name: mockDrive.name,
        stableId: mockDrive.stableId,
      },
    },
  ]);
  expect(calls.restoreExecuteRequests).toEqual([
    { planId: "playwright-restore-plan-id" },
  ]);
});

test("offers the same guarded Restore USB flow after an interrupted write", async ({
  page,
}) => {
  await mockInstallerApi(page, { writeFailure: true });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Next: Select Image/i }).click();
  await page.getByRole("button", { name: /Next: Specs Check/i }).click();
  await page.getByRole("button", { name: /Next: Confirm & Write/i }).click();
  await page
    .getByLabel(/I understand the drive will be completely erased/i)
    .check();
  await page.locator(".confirm-target-row input").fill(mockDrive.devicePath);
  await page.getByRole("button", { name: "Write to Drive" }).click();
  await expect(
    page.getByRole("heading", { name: /Write Failed/i }),
  ).toBeVisible();
  await expect(page.getByText(/media is incomplete/i)).toBeVisible();
  await page.getByRole("button", { name: "Restore USB", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Restore USB for Normal Storage/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Erase and Restore USB/i }),
  ).toBeDisabled();
});
