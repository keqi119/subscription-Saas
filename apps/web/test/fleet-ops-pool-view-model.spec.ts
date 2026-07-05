import { describe, expect, it } from "vitest";

import {
  buildFleetOpsVehicleDrilldownHref,
  formatFleetOpsAgingBucketLabel,
  formatFleetOpsConfidenceBandLabel,
  formatFleetOpsDepositTreatmentNote,
  formatFleetOpsMoney,
  formatFleetOpsRatio,
  formatFleetOpsRoeLabel,
  formatFleetOpsRoiLabel,
  mapFleetOpsAnomalyRows,
  mapFleetOpsPoolRows,
  mapFleetOpsScopedVehicleRows
} from "../src/lib/fleet-ops-view-model";

describe("fleet ops pool view model", () => {
  it("formats KPI money and ratio values for pool/cohort summaries", () => {
    expect(formatFleetOpsMoney(123456)).toBe("1,234.56 元");
    expect(formatFleetOpsMoney(null)).toBe("-");
    expect(formatFleetOpsRatio(0.1234)).toBe("12.34%");
    expect(formatFleetOpsRoiLabel()).toContain("总额口径");
    expect(formatFleetOpsRoeLabel()).toContain("非单车简单平均");
  });

  it("keeps deposit copy separate from operating revenue", () => {
    expect(formatFleetOpsDepositTreatmentNote()).toBe("押金已单列，不计入经营收入");
  });

  it("formats risk, aging, and confidence labels", () => {
    expect(formatFleetOpsAgingBucketLabel("D1")).toBe("D1 1-3 天");
    expect(formatFleetOpsAgingBucketLabel("D5")).toBe("D5 30 天以上");
    expect(formatFleetOpsConfidenceBandLabel("LOW")).toBe("低置信");
    expect(formatFleetOpsConfidenceBandLabel("UNKNOWN")).toBe("未知");
  });

  it("maps anomaly rows and builds passive drilldown links", () => {
    const rows = mapFleetOpsAnomalyRows([
      {
        collectionLevel: "D2",
        confidence: 25,
        overdueRemainingAmount: 70000,
        riskScore: 88,
        roi: -0.1,
        vehicleId: "vehicle-1",
        vehicleNo: "VEH-001"
      }
    ]);

    expect(rows[0]).toEqual(
      expect.objectContaining({
        drilldownHref: "/fleet-ops?vehicleId=vehicle-1",
        riskScore: 88,
        vehicleLabel: "VEH-001"
      })
    );
    expect(buildFleetOpsVehicleDrilldownHref("vehicle/with space")).toBe("/fleet-ops?vehicleId=vehicle%2Fwith%20space");
  });

  it("maps pool and scoped vehicle rows for readonly tables", () => {
    expect(
      mapFleetOpsPoolRows([
        {
          activeVehicleCount: 3,
          poolId: "pool-1",
          poolName: "运营池",
          poolNo: "POOL-001",
          poolStatus: "ACTIVE",
          poolType: "OPERATION"
        }
      ])[0]
    ).toEqual(expect.objectContaining({ detailHref: "/fleet-ops/pools/pool-1", poolLabel: "POOL-001 / 运营池" }));

    expect(
      mapFleetOpsScopedVehicleRows([
        {
          brand: "NIO",
          model: "ES6",
          modelYear: 2026,
          status: "AVAILABLE",
          vehicleId: "vehicle-1",
          vehicleNo: "VEH-001"
        }
      ])[0]
    ).toEqual(expect.objectContaining({ drilldownHref: "/fleet-ops?vehicleId=vehicle-1", modelLabel: "NIO / ES6 / 2026" }));
  });
});
