import type { AospBuild } from "../backend/types";

export const FIXTURE_BUILDS: AospBuild[] = [
  {
    id: "fixture-android-caiman",
    label: "Fixture Android build",
    version: "0.0.0-test",
    channel: "beta",
    targetDevice: "caiman",
    architecture: "arm64-v8a",
    publishedAt: "2026-01-01T00:00:00.000Z",
    manifestUrl: "https://example.invalid/android/manifest.json",
    sizeBytes: 8 * 1024 ** 3,
  },
  {
    id: "fixture-android-bluejay",
    label: "Fixture Android build for Pixel 6a",
    version: "0.0.0-test",
    channel: "beta",
    targetDevice: "bluejay",
    architecture: "arm64-v8a",
    publishedAt: "2026-01-01T00:00:00.000Z",
    manifestUrl: "https://example.invalid/android/bluejay/manifest.json",
    sizeBytes: 8 * 1024 ** 3,
  },
];
