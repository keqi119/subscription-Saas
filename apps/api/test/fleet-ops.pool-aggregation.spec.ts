import { describe, expect, it, vi } from "vitest";

import { FleetOpsPoolAggregatorService } from "../src/fleet-ops/fleet-ops.pool-aggregator.service";
import type { FleetOpsResolvedScope } from "../src/fleet-ops/fleet-ops.pool-read-model";

const scope: FleetOpsResolvedScope = {
  scope: { type: "COHORT" },
  vehicleIds: ["vehicle-a", "vehicle-b"],
  vehicles: [
    { brand: "NIO", model: "ES6", status: "AVAILABLE", vehicleId: "vehicle-a", vehicleNo: "VEH-A" },
    { brand: "NIO", model: "ES8", status: "LEASED", vehicleId: "vehicle-b", vehicleNo: "VEH-B" }
  ],
  warnings: ["FLEET_OPS_FILTER_DEFERRED:riskLevel"]
};

describe("Fleet Ops pool overview aggregation", () => {
  it("builds overview summaries, distributions, top-N anomalies, and no full evidence payload", async () => {
    const kpiService = {
      getFleetKpis: vi.fn().mockResolvedValue({
        fleet: {
          cashflow: { actual: { deposit: 0, operating: 100 }, evidence: [], planned: { deposit: 0, operating: 120 }, warnings: [], writeOff: { appliedDeposit: 0, appliedOperating: 0, unlinked: 0 } },
          cost: 10,
          denominatorEvidence: [{ reason: "denominator", source: "denominator", sourceId: "fleet" }],
          netIncome: 90,
          revenue: 100,
          roe: 0.18,
          roi: 0.09,
          vehicleCount: 2,
          warnings: []
        },
        vehicles: [
          {
            cashflow: { actual: { deposit: 0, operating: 100 }, evidence: [], planned: { deposit: 0, operating: 120 }, warnings: [], writeOff: { appliedDeposit: 0, appliedOperating: 0, unlinked: 0 } },
            confidence: { band: "HIGH", score: 90 },
            denominatorEvidence: [{ reason: "denominator", source: "denominator", sourceId: "vehicle-a" }],
            economics: { cost: 10, netIncome: 90, revenue: 100, roe: 0.18, roi: 0.09 },
            evidence: [{ reason: "economic evidence", source: "payment_record", sourceId: "pay-a" }],
            vehicleId: "vehicle-a",
            warnings: []
          },
          {
            confidence: { band: "LOW", score: 25 },
            denominatorEvidence: [],
            economics: { cost: 0, netIncome: -10, revenue: 0, roe: -0.2, roi: -0.1 },
            evidence: [],
            vehicleId: "vehicle-b",
            warnings: ["ZERO_OR_MISSING_DENOMINATOR"]
          }
        ]
      })
    };
    const riskService = {
      getFleetRisk: vi.fn().mockResolvedValue({
        fleet: { averageRiskScore: 55, vehicleCount: 2 },
        vehicles: [
          { agingBucket: "NONE", collectionLevel: "NONE", confidence: 80, exposureDetail: { evidence: [], maxOverdueDays: 0, overdueBillCount: 0, overdueBillRefs: [], overdueRemainingAmount: 0, warnings: [] }, riskScore: 20, vehicleId: "vehicle-a", warnings: [] },
          { agingBucket: "D2", collectionLevel: "D2", confidence: 30, exposureDetail: { evidence: [], maxOverdueDays: 5, overdueBillCount: 1, overdueBillRefs: [], overdueRemainingAmount: 500, warnings: [] }, riskScore: 90, vehicleId: "vehicle-b", warnings: [] }
        ]
      })
    };

    const result = await new FleetOpsPoolAggregatorService(kpiService as never, riskService as never).buildOverview(
      scope,
      { from: new Date("2026-07-01T00:00:00.000Z"), to: new Date("2026-07-02T00:00:00.000Z") },
      { topN: 1 }
    );

    expect(result.scope.type).toBe("COHORT");
    expect(result.vehicleCounts.total).toBe(2);
    expect(result.distributions.vehicleStatus).toEqual({ AVAILABLE: 1, LEASED: 1 });
    expect(result.dataQuality.averageConfidence).toBeGreaterThan(0);
    expect(result.dataQuality.lowConfidenceVehicleCount).toBe(1);
    expect(result.evidenceSummary.fullEvidenceIncluded).toBe(false);
    expect(result.anomalies.lowestRoi).toHaveLength(1);
    expect(result.anomalies.lowestRoi[0]).not.toHaveProperty("evidence");
    expect(result.warnings).toContain("FLEET_OPS_FILTER_DEFERRED:riskLevel");
  });
});
