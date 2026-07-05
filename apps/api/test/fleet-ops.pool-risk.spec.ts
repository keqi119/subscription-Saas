import { describe, expect, it, vi } from "vitest";

import { FleetOpsPoolAggregatorService } from "../src/fleet-ops/fleet-ops.pool-aggregator.service";
import type { FleetOpsResolvedScope } from "../src/fleet-ops/fleet-ops.pool-read-model";

const range = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-05T00:00:00.000Z")
};

const scope: FleetOpsResolvedScope = {
  scope: { type: "ALL" },
  vehicleIds: ["vehicle-a", "vehicle-b", "vehicle-c"],
  vehicles: [
    { status: "AVAILABLE", vehicleId: "vehicle-a", vehicleNo: "VEH-A" },
    { status: "LEASED", vehicleId: "vehicle-b", vehicleNo: "VEH-B" },
    { status: "MAINTENANCE", vehicleId: "vehicle-c", vehicleNo: "VEH-C" }
  ],
  warnings: []
};

describe("Fleet Ops pool risk aggregation", () => {
  it("aggregates overdue exposure and D1-D5 distribution from existing risk outputs", async () => {
    const kpiService = {
      getFleetKpis: vi.fn().mockResolvedValue({
        fleet: { cost: 0, netIncome: 0, revenue: 0, roe: 0, roi: 0, vehicleCount: 3 },
        vehicles: []
      })
    };
    const riskService = {
      getFleetRisk: vi.fn().mockResolvedValue({
        fleet: { averageRiskScore: 50, vehicleCount: 3 },
        vehicles: [
          {
            agingBucket: "D1",
            collectionLevel: "D1",
            confidence: 80,
            exposureDetail: {
              evidence: [],
              maxOverdueDays: 2,
              overdueBillCount: 1,
              overdueBillRefs: [{ billId: "bill-a", dueDate: new Date("2026-07-03T00:00:00.000Z"), overdueDays: 2, paidAmount: 0, remainingAmount: 100, sourceStatus: "PENDING" }],
              overdueRemainingAmount: 100,
              warnings: []
            },
            riskScore: 40,
            vehicleId: "vehicle-a",
            warnings: []
          },
          {
            agingBucket: "D5",
            collectionLevel: "D5",
            confidence: 55,
            exposureDetail: {
              evidence: [],
              maxOverdueDays: 35,
              overdueBillCount: 2,
              overdueBillRefs: [
                { billId: "bill-b1", dueDate: new Date("2026-05-01T00:00:00.000Z"), overdueDays: 35, paidAmount: 0, remainingAmount: 600, sourceStatus: "PENDING" },
                { billId: "bill-b2", dueDate: new Date("2026-05-02T00:00:00.000Z"), overdueDays: 34, paidAmount: 0, remainingAmount: 400, sourceStatus: "OVERDUE" }
              ],
              overdueRemainingAmount: 1000,
              warnings: [{ code: "FACTUAL_OVERDUE_STATUS_NOT_REFRESHED", sourceId: "bill-b1" }]
            },
            riskScore: 90,
            vehicleId: "vehicle-b",
            warnings: []
          },
          {
            agingBucket: "NONE",
            collectionLevel: "NONE",
            confidence: 90,
            exposureDetail: {
              evidence: [],
              maxOverdueDays: 0,
              overdueBillCount: 0,
              overdueBillRefs: [],
              overdueRemainingAmount: 0,
              warnings: []
            },
            riskScore: 10,
            vehicleId: "vehicle-c",
            warnings: []
          }
        ]
      })
    };

    const result = await new FleetOpsPoolAggregatorService(kpiService as never, riskService as never).buildOverview(scope, range, {
      topN: 2
    });

    expect(result.risk.overdueAmount).toBe(1100);
    expect(result.risk.overdueBillCount).toBe(3);
    expect(result.risk.overdueVehicleCount).toBe(2);
    expect(result.risk.maxOverdueDays).toBe(35);
    expect(result.risk.agingDistribution).toEqual({ D1: 1, D2: 0, D3: 0, D4: 0, D5: 1, NONE: 1 });
    expect(result.anomalies.highestOverdue).toEqual([
      expect.objectContaining({ overdueRemainingAmount: 1000, vehicleId: "vehicle-b" }),
      expect.objectContaining({ overdueRemainingAmount: 100, vehicleId: "vehicle-a" })
    ]);
    expect(result.anomalies.highestRisk[0]).toEqual(expect.objectContaining({ riskScore: 90, vehicleId: "vehicle-b" }));
  });
});
