import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));

test("physical Android target inventory stays fail-closed", () => {
  const inventory = JSON.parse(
    readFileSync(
      `${repositoryRoot}/packages/os/android/hardware-targets.json`,
      "utf8",
    ),
  );
  const products = readFileSync(
    `${repositoryRoot}/packages/os/android/vendor/eliza/AndroidProducts.mk`,
    "utf8",
  );
  const pixel = inventory.targets.find((target) => target.codename === "tegu");
  const lightPhone = inventory.targets.find(
    (target) => target.codename === "TLP301",
  );

  expect(pixel).toMatchObject({
    status: "source-locked-candidate",
    lunchProduct: "eliza_tegu_phone",
    installerEligibility: "blocked-until-physical-evidence",
  });
  expect(pixel.missingBoundaries).toContainEqual(
    expect.stringContaining("active Gemma ASR artifact"),
  );
  expect(products).toContain("eliza_tegu_phone-trunk_staging-userdebug");
  expect(lightPhone).toMatchObject({
    status: "blocked-no-authoritative-os-inputs",
    lunchProduct: null,
    sourceProfile: null,
    forbiddenAliases: ["tegu"],
    installerEligibility: "blocked",
  });
  expect(products).not.toMatch(/TLP301|light[_-]?phone/i);
});
