import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("vehicle insurance coverage UI", () => {
  it("renders separate compulsory and commercial periods in the asset ledger", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/app/vehicles/page.tsx"),
      "utf8"
    );

    expect(source).toContain("交强险");
    expect(source).toContain("商业险");
    expect(source).toContain("formatInsuranceCoverage(record.insuranceCoverage)");
    expect(source).toContain("coverage.compulsoryTraffic");
    expect(source).toContain("coverage.commercial");
  });

  it("separates policy coverage from manual delivery verification", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/app/orders/[id]/page.tsx"),
      "utf8"
    );

    expect(source).toContain("交强险期限覆盖");
    expect(source).toContain("商业险期限覆盖");
    expect(source).toContain("保险人工核验");

    const manualGuidance = source.indexOf('reason.includes("保险人工核验")');
    const policyGuidance = source.indexOf('reason.includes("交强险")');
    expect(manualGuidance).toBeGreaterThan(-1);
    expect(policyGuidance).toBeGreaterThan(manualGuidance);
  });
});
