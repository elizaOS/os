import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AospFlasherBackend } from "../backend/types";
import { FlasherApp } from "../components/FlasherApp";
import { IosFlasher } from "../components/IosFlasher";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.__ELIZA_SERVER_TOKEN__;
  vi.unstubAllGlobals();
});

describe("normal-user installer states", () => {
  it("explains how to recover when an explicit iOS scan finds no device", async () => {
    window.__ELIZA_SERVER_TOKEN__ = "test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([])),
    );
    await act(async () => root.render(<IosFlasher serverUrl="/api" />));

    const checkButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Check for my device",
    );
    if (!checkButton) throw new Error("missing iOS device check button");
    await act(async () => checkButton.click());

    expect(container.textContent).toContain("No iPhone or iPad found yet");
    expect(container.textContent).toContain("unlock it, and tap Trust");
  });

  it("hides raw Android transport errors behind recovery guidance", async () => {
    const backend = {
      listConnectedDevices: vi.fn(async () => {
        throw new TypeError("GET /devices failed: HTTP 404");
      }),
      listBuilds: vi.fn(async () => []),
    } as unknown as AospFlasherBackend;

    await act(async () =>
      root.render(<FlasherApp backend={backend} embedded />),
    );

    expect(container.textContent).toContain(
      "The installer could not reach its device service",
    );
    expect(container.textContent).not.toContain("HTTP 404");
  });
});
