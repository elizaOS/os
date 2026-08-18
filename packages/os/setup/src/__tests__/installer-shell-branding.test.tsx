import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InstallerShell } from "../components/InstallerShell";

describe("InstallerShell branding and language", () => {
  it("uses the canonical Eliza lockup and clear device choices", () => {
    const html = renderToStaticMarkup(
      <InstallerShell serverUrl="http://127.0.0.1:3743" />,
    );

    expect(html).toContain("./brand/logos/eliza_logotext.svg");
    expect(html).toContain("Install elizaOS");
    expect(html).toContain("Computer");
    expect(html).toContain("Android");
    expect(html).toContain("iPhone &amp; iPad");
    expect(html).toContain("review the exact drive");
    expect(html).not.toContain("Safe, guided setup");
    expect(html).not.toContain("💾");
    expect(html).not.toContain("🍎");
  });

  it("shares the direct backend base across Android and iOS", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/InstallerShell.tsx"),
      "utf8",
    );

    expect(source).toContain("new HttpAospFlasherBackend(serverUrl)");
    expect(source).toContain("<IosFlasher serverUrl={serverUrl}");
    expect(source).not.toMatch(/serverUrl}\/api/);
  });
});
