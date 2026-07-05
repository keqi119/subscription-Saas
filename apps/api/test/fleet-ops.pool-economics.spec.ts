import { describe, expect, it, vi } from "vitest";

import { FleetOpsPoolAggregatorService } from "../src/fleet-ops/fleet-ops.pool-aggregator.service";
import type { FleetOpsResolvedScope } from "../src/fleet-ops/fleet-ops.pool-read-model";

const range = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-05T00:00:00.000Z")
};

const scope: FleetOpsResolvedScope = {
  scope: { type: "ALL" },
  vehicleIds: ["vehicle-a", "vehicle-b"],
  vehicles: [
    { brand: "NIO", model: "ES6", status: "AVAILABLE", vehicleId: "vehicle-a", vehicleNo: "VEH-A" },
    { brand: "NIO", model: "ET5", status: "LEASED", vehicleId: "vehicle-b", vehicleNo: "VEH-B" }
  ],
  warnings: []
};

describe("Fleet Ops pool economics aggregation", () => {
  it("uses total-based ROI/ROE and keeps deposits separate from operating revenue", async () => {
    const kpiService = {
      getFleetKpis: vi.fn().mockResolvedValue({
        fleet: {
          cashflow: {
            actual: { deposit: 5000, operating: 3000, unassigned: 200 },
            evidence: [{ reason: "cashflow summary", source: "payment_record", sourceId: "pay-1" }],
            planned: { deposit: 1000, operating: 4000 },
            warnings: ["DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"],
            writeOff: { appliedDeposit: 100, appliedOperating: 50, unlinked: 25 }
          },
          cost: 800,
          denominatorEvidence: [
            { amount: 10000, reason: "fleet ROI = total net income / total invested capital", source: "denominator", sourceId: "fleet:invested_capital" },
            { amount: 5000, reason: "fleet ROE = total platform net income / total equity base", source: "denominator", sourceId: "fleet:equity_base" }
          ],
          netIncome: 2200,
          revenue: 3000,
          roe: 0.44,
          roi: 0.22,
          vehicleCount: 2,
          warnings: ["DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"]
        },
        vehicles: [
          {
            cashflow: { actual: { deposit: 5000, operating: 3000 }, evidence: [], planned: { deposit: 1000, operating: 4000 }, warnings: [], writeOff: { appliedDeposit: 0, appliedOperating: 0, unlinked: 0 } },
            confidence: { band: "HIGH", score: 90 },
            denominatorEvidence: [{ reason: "denominator", source: "denominator", sourceId: "vehicle-a" }],
            economics: { cost: 100, netIncome: 900, revenue: 1000, roe: 0.9, roi: 0.9 },
            evidence: [{ reason: "economic evidence", source: "payment_record", sourceId: "pay-a" }],
            vehicleId: "vehicle-a",
            warnings: []
          },
          {
            confidence: { band: "LOW", score: 40 },
            denominatorEvidence: [{ reason: "denominator", source: "denominator", sourceId: "vehicle-b" }],
            economics: { cost: 700, netIncome: 1300, revenue: 2000, roe: 0.1, roi: 0.1 },
            evidence: [{ reason: "economic evidence", source: "payment_record", sourceId: "pay-b" }],
            vehicleId: "vehicle-b",
            warnings: []
          }
        ]
      })
    };
    const riskService = { getFleetRisk: vi.fn().mockResolvedValue({ fleet: {}, vehicles: [] }) };

    const result = await new FleetOpsPoolAggregatorService(kpiService as never, riskService as never).buildOverview(scope, range, {
      topN: 10
    });

    expect(result.kpis.roi).toBe(0.22);
    expect(result.kpis.roe).toBe(0.44);
    expect(result.kpis.roi).not.toBe(0.5);
    expect(result.cashflow.actualOperating).toBe(3000);
    expect(result.cashflow.actualDeposit).toBe(5000);
    expect(result.cashflow.plannedOperating).toBe(4000);
    expect(result.cashflow.plannedDeposit).toBe(1000);
    expect(result.kpis.denominatorEvidenceCount).toBe(2);
    expect(result.warnings).toContain("DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE");
  });
});
