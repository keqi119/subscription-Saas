import { describe, expect, it } from "vitest";

import {
  buildFleetOpsReadOnlySections,
  groupFleetOpsEvidenceBySource,
  summarizeFleetOpsSnapshot,
  validateFleetOpsDateRange
} from "../src/lib/fleet-ops-view-model";

describe("fleet ops view model", () => {
  it("builds a healthy snapshot summary with confidence and evidence counts", () => {
    const summary = summarizeFleetOpsSnapshot(healthySnapshot());

    expect(summary.vehicleId).toBe("vehicle-healthy");
    expect(summary.overallConfidenceScore).toBe(91);
    expect(summary.consistencyScore).toBe(96);
    expect(summary.warningCount).toBe(0);
    expect(summary.evidenceCount).toBe(3);
    expect(summary.state.computedState).toBe("LEASED_ACTIVE");
  });

  it("keeps deposit cashflow separate from operating revenue", () => {
    const summary = summarizeFleetOpsSnapshot(depositAndOverdueSnapshot());

    expect(summary.economics).toEqual(
      expect.objectContaining({
        actualDepositCashflow: 500,
        actualOperatingCashflow: 1200,
        depositExcludedRevenue: 500,
        revenue: 1200
      })
    );
    expect(summary.warningCodes).toContain("DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE");
  });

  it("surfaces overdue exposure, D1-D5 aging, and arrears pipeline", () => {
    const summary = summarizeFleetOpsSnapshot(depositAndOverdueSnapshot());

    expect(summary.risk).toEqual(
      expect.objectContaining({
        agingBucket: "D2",
        arrearsStage: "OVERDUE_WITH_ACTIVE_CASE",
        collectionLevel: "D2",
        overdueBillCount: 1,
        overdueRemainingAmount: 700
      })
    );
  });

  it("preserves timeline fallback warnings in the warning summary", () => {
    const summary = summarizeFleetOpsSnapshot(fallbackSnapshot());

    expect(summary.warningCodes).toContain("CURRENT_STATUS_PROJECTED_ACROSS_RANGE");
    expect(summary.timeline.fallbackWarningDays).toBe(2);
  });

  it("groups evidence by source type without collapsing source identities", () => {
    const groups = groupFleetOpsEvidenceBySource(depositAndOverdueSnapshot().evidence);

    expect(groups.map((group) => group.source)).toEqual([
      "collection_case",
      "deposit_ledger",
      "payment_record",
      "receivable_bill"
    ]);
    expect(groups.find((group) => group.source === "receivable_bill")?.items[0]).toEqual(
      expect.objectContaining({ sourceId: "bill-overdue" })
    );
  });

  it("builds read-only sections for state timeline economics risk and evidence", () => {
    expect(buildFleetOpsReadOnlySections(depositAndOverdueSnapshot()).map((section) => section.key)).toEqual([
      "overview",
      "state",
      "timeline",
      "economics",
      "risk",
      "evidence"
    ]);
  });

  it("validates client-side date ranges with the 366-day Fleet Ops limit", () => {
    expect(validateFleetOpsDateRange({ from: "2026-01-01", to: "2026-12-31" })).toEqual({
      days: 364,
      valid: true
    });

    expect(validateFleetOpsDateRange({ from: "2026-01-01", to: "2027-01-03" })).toEqual({
      days: 367,
      reason: "Fleet Ops date range must not exceed 366 days.",
      valid: false
    });
  });
});

function healthySnapshot() {
  return {
    economics: {
      cashflow: {
        actual: 1200,
        actualDetail: { deposit: 0, operating: 1200, unassigned: 0 },
        deposit: 0,
        planned: 1200,
        plannedDetail: { deposit: 0, operating: 1200 },
        warnings: [],
        writeOff: { amount: 0 }
      },
      confidence: { band: "HIGH", score: 93 },
      cost: 200,
      revenue: 1200,
      roe: 0.08,
      roi: 0.12,
      warnings: []
    },
    evidence: [
      evidence("lease", "lease-1"),
      evidence("payment_record", "payment-1"),
      evidence("timeline", "timeline-1")
    ],
    generatedAt: "2026-07-02T00:00:00.000Z",
    risk: {
      agingBucket: "NONE",
      arrearsPipeline: null,
      collectionLevel: "NONE",
      exposureDetail: { overdueBillCount: 0, overdueRemainingAmount: 0 },
      overdueBillRefs: [],
      overdueRemainingAmount: 0,
      score: 8,
      warnings: []
    },
    state: {
      computedState: "LEASED_ACTIVE",
      confidence: { band: "HIGH", score: 95 },
      conflicts: [],
      evidence: [evidence("lease", "lease-1")]
    },
    system: {
      consistencyScore: 96,
      overallConfidence: { band: "HIGH", score: 91 }
    },
    timeline: {
      events: [],
      summary: { fallbackWarningDays: 0, rangeDays: 2 },
      warnings: []
    },
    vehicleId: "vehicle-healthy",
    warnings: []
  };
}

function depositAndOverdueSnapshot() {
  return {
    ...healthySnapshot(),
    economics: {
      ...healthySnapshot().economics,
      attribution: { depositExcludedRevenue: 500, leaseRevenue: 1200 },
      cashflow: {
        actual: 1200,
        actualDetail: { deposit: 500, operating: 1200, unassigned: 0 },
        deposit: 500,
        planned: 1500,
        plannedDetail: { deposit: 500, operating: 1200 },
        warnings: ["DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"],
        writeOff: { amount: 0 }
      },
      warnings: ["DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"]
    },
    evidence: [
      evidence("collection_case", "case-overdue"),
      evidence("deposit_ledger", "deposit-ledger"),
      evidence("payment_record", "payment-rent"),
      evidence("receivable_bill", "bill-overdue")
    ],
    risk: {
      agingBucket: "D2",
      arrearsPipeline: {
        actionRefs: [{ actionId: "action-overdue" }],
        billRefs: [{ billId: "bill-overdue", overdueDays: 6, remainingAmount: 700 }],
        caseRefs: [{ caseId: "case-overdue", caseStatus: "ACTIVE", collectionLevel: "D2" }],
        evidence: [evidence("collection_case", "case-overdue")],
        stage: "OVERDUE_WITH_ACTIVE_CASE"
      },
      collectionLevel: "D2",
      exposureDetail: {
        overdueBillCount: 1,
        overdueBillRefs: [{ billId: "bill-overdue", overdueDays: 6, remainingAmount: 700 }],
        overdueRemainingAmount: 700
      },
      overdueBillRefs: [{ billId: "bill-overdue", overdueDays: 6, remainingAmount: 700 }],
      overdueRemainingAmount: 700,
      score: 55,
      warnings: []
    },
    vehicleId: "vehicle-overdue",
    warnings: ["DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"]
  };
}

function fallbackSnapshot() {
  return {
    ...healthySnapshot(),
    timeline: {
      events: [],
      summary: { fallbackWarningDays: 2, rangeDays: 2 },
      warnings: ["CURRENT_STATUS_PROJECTED_ACROSS_RANGE"]
    },
    warnings: ["CURRENT_STATUS_PROJECTED_ACROSS_RANGE"]
  };
}

function evidence(source: string, sourceId: string) {
  return {
    layers: ["SYSTEM"],
    source,
    sourceId,
    summary: `${source}:${sourceId}`
  };
}
