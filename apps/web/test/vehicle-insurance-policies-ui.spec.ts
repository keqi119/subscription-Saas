import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("vehicle insurance policy management UI", () => {
  it("supports VIN search and dedicated vehicle identity columns", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/app/vehicle-insurance-policies/page.tsx"),
      "utf8"
    );

    expect(source).toContain("vin?: string | null");
    expect(source).toContain("vehicle.vin,");
    expect(source.match(/optionFilterProp="label"/g)).toHaveLength(2);
    expect(source).toContain('dataIndex: ["vehicle", "vin"]');
    expect(source).toContain('dataIndex: ["vehicle", "plateNo"]');
    expect(source).toContain('NOT_EFFECTIVE: "blue"');
  });
});
