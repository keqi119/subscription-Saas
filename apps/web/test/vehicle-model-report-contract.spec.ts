import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const runtimeFiles = [
  "apps/web/src/app/reports/page.tsx",
  "apps/web/src/app/reports/asset-profitability/page.tsx",
  "apps/web/src/app/residual-market/page.tsx",
  "apps/web/src/app/vehicle-valuation-reviews/page.tsx"
];

describe("canonical vehicle model report contracts", () => {
  const sources = runtimeFiles.map((file) => readFileSync(join(repoRoot, file), "utf8"));

  it("removes legacy model properties and labels from report-facing pages", () => {
    for (const source of sources) {
      expect(source).not.toMatch(/\bvehicleModel\??:/);
      expect(source).not.toMatch(/\.vehicleModel\b/);
      expect(source).not.toContain("legacyVehicleModel");
      expect(source).not.toContain("legacy 车型");
    }
  });

  it("keeps canonical model filters and display fields visible", () => {
    expect(sources[0]).toContain("modelDefinitionId");
    expect(sources[0]).toContain("modelCode");
    expect(sources[0]).toContain("modelDisplayName");
    expect(sources[1]).toContain("modelDefinitionOptions");
    expect(sources[2]).toContain('name="modelDefinitionId"');
    expect(sources[3]).toContain("modelDefinition?.modelCode");
  });
});
