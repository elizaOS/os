import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InstallerShell } from "../components/InstallerShell";

describe("InstallerShell branding and language", () => {
  it("uses the canonical elizaOS lockup and friendly device choices", () => {
    const html = renderToStaticMarkup(
      <InstallerShell serverUrl="http://127.0.0.1:3743" />,
    );

    expect(html).toContain("./brand/logos/elizaos_logotext.svg");
    expect(html).toContain("Where do you want to use elizaOS?");
    expect(html).toContain("Computer");
    expect(html).toContain("Android phone");
    expect(html).toContain("iPhone or iPad");
    expect(html).toContain("Nothing is erased until you review");
    expect(html).not.toContain("💾");
    expect(html).not.toContain("🍎");
  });
});
