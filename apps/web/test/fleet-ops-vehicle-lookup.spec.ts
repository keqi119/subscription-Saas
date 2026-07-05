import { describe, expect, it } from "vitest";

import {
  buildFleetOpsLookupOptionLabel,
  buildFleetOpsVehicleSelectionSummary,
  validateFleetOpsLookupQuery
} from "../src/lib/fleet-ops-view-model";

describe("fleet ops vehicle lookup view model", () => {
  const item = {
    brand: "Tesla",
    model: "Model Y",
    modelYear: 2025,
    plateMasked: "*****45",
    statusLabel: "AVAILABLE",
    vehicleId: "00000000-0000-4000-8000-000000000001",
    vehicleNo: "VEH-DEMO-001",
    vinSuffix: "000001"
  };

  it("validates lookup input without allowing broad one-character searches", () => {
    expect(validateFleetOpsLookupQuery("  VEH-DEMO-001  ")).toEqual({ query: "VEH-DEMO-001", valid: true });
    expect(validateFleetOpsLookupQuery("A")).toEqual({
      reason: "请输入至少 2 个字符，或输入完整内部车辆 ID。",
      valid: false
    });
    expect(validateFleetOpsLookupQuery("00000000-0000-4000-8000-000000000001")).toEqual({
      query: "00000000-0000-4000-8000-000000000001",
      valid: true
    });
  });

  it("formats safe lookup labels without full VIN or plate", () => {
    const label = buildFleetOpsLookupOptionLabel(item);

    expect(label).toContain("VEH-DEMO-001");
    expect(label).toContain("*****45");
    expect(label).toContain("VIN后6位 000001");
    expect(label).toContain("Tesla / Model Y / 2025");
    expect(label).toContain("AVAILABLE");
    expect(label).not.toContain("TESTVINES60000001");
    expect(label).not.toContain("沪A12345");
  });

  it("builds selected vehicle summary from the safe lookup item", () => {
    expect(buildFleetOpsVehicleSelectionSummary(item)).toBe(
      "VEH-DEMO-001 / *****45 / VIN后6位 000001 / Tesla / Model Y / 2025"
    );
  });
});
