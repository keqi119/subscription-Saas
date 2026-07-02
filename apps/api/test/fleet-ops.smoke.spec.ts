import {
  BillStatus,
  BillType,
  CollectionActionResult,
  CollectionActionType,
  CollectionCaseStatus
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { buildFleetOpsSnapshot } from "../src/fleet-ops/facade/fleet-ops.snapshot.builder";
import type { FleetOpsSnapshot, FleetOpsSnapshotBuilderInput } from "../src/fleet-ops/facade/fleet-ops.snapshot.types";
import { CollectionPriorityLevel, ControlDecision, RiskSignalCode } from "../src/fleet-ops/risk/risk.types";
import {
  TIMELINE_CURRENT_STATUS_PROJECTED_WARNING,
  type TimelineDay,
  TimelineState
} from "../src/fleet-ops/timeline/vehicle-timeline.types";
import {
  VehicleComputedOperationalState,
  VehicleOperationalConfidenceBand
} from "../src/fleet-ops/vehicle-operational-state.types";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-07-03T00:00:00.000Z");
const generatedAt = new Date("2026-07-03T12:00:00.000Z");

describe("Fleet Ops snapshot smoke readiness", () => {
  it.each([
    {
      assert: (snapshot: FleetOpsSnapshot) => {
        expect(snapshot.state.computedState).toBe(VehicleComputedOperationalState.LEASED_ACTIVE);
        expect(snapshot.timeline.summary.stateCounts[TimelineState.LEASED]).toBe(3);
        expect(snapshot.economics.cashflow.actual).toBe(1500);
        expect(snapshot.risk.collectionLevel).toBe(CollectionPriorityLevel.D1);
        expect(snapshot.system.overallConfidence.score).toBeGreaterThanOrEqual(80);
      },
      input: healthyActiveLeaseInput(),
      name: "healthy active lease"
    },
    {
      assert: (snapshot: FleetOpsSnapshot) => {
        expect(snapshot.economics.cashflow.actualDetail).toEqual({ deposit: 500, operating: 1200, unassigned: 0 });
        expect(snapshot.economics.attribution).toEqual(expect.objectContaining({ depositExcludedRevenue: 500 }));
        expect(snapshot.risk.exposureDetail).toEqual(expect.objectContaining({ overdueRemainingAmount: 700 }));
        expect(snapshot.risk.agingBucket).toBe(CollectionPriorityLevel.D2);
        expect(snapshot.risk.arrearsPipeline).toEqual(expect.objectContaining({ stage: "OVERDUE_WITH_ACTIVE_CASE" }));
        expect(sourceSet(snapshot)).toEqual(
          expect.arrayContaining(["deposit_ledger", "payment_record", "receivable_bill", "collection_case", "collection_action"])
        );
      },
      input: depositAndOverdueInput(),
      name: "deposit plus overdue exposure"
    },
    {
      assert: (snapshot: FleetOpsSnapshot) => {
        expect(snapshot.timeline.warnings).toContain(TIMELINE_CURRENT_STATUS_PROJECTED_WARNING);
        expect(snapshot.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: TIMELINE_CURRENT_STATUS_PROJECTED_WARNING }),
            expect.objectContaining({ code: "ECONOMICS_WARNING" }),
            expect.objectContaining({ code: "RISK_WARNING" })
          ])
        );
        expect(snapshot.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ code: "STATE_AVAILABLE_WITH_LEASE_TIMELINE" })]));
        expect(snapshot.system.consistencyScore).toBeLessThan(100);
        expect(snapshot.system.overallConfidence.reasons).toEqual(
          expect.arrayContaining([expect.stringContaining("fallback evidence penalty")])
        );
      },
      input: fallbackConflictInput(),
      name: "fallback warning with conflicting signals"
    }
  ])("keeps public smoke contract for $name", ({ assert, input }) => {
    const before = JSON.stringify(input);
    const snapshot = buildFleetOpsSnapshot(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(snapshot.vehicleId).toBe(input.vehicleId);
    expect(snapshot.state).toEqual(expect.objectContaining({ confidence: expect.any(Object), evidence: expect.any(Array) }));
    expect(snapshot.timeline).toEqual(expect.objectContaining({ events: expect.any(Array), summary: expect.any(Object) }));
    expect(snapshot.economics).toEqual(expect.objectContaining({ cashflow: expect.any(Object), confidence: expect.any(Object) }));
    expect(snapshot.risk).toEqual(expect.objectContaining({ evidence: expect.any(Array), warnings: expect.any(Array) }));
    expect(snapshot.system).toEqual(
      expect.objectContaining({
        consistencyScore: expect.any(Number),
        dataFreshness: expect.any(Object),
        overallConfidence: expect.any(Object)
      })
    );
    expect("executeAction" in snapshot.execution).toBe(false);
    assert(snapshot);
  });
});

function healthyActiveLeaseInput(): FleetOpsSnapshotBuilderInput {
  return baseInput("smoke-healthy", {
    economics: economics("smoke-healthy", { revenue: 1500 }),
    risk: risk("smoke-healthy", { riskScore: 8 }),
    state: state("smoke-healthy", VehicleComputedOperationalState.LEASED_ACTIVE, "LEASE", "lease-smoke-healthy"),
    timeline: [
      day("2026-07-01", TimelineState.LEASED, ["lease:lease-smoke-healthy"]),
      day("2026-07-02", TimelineState.LEASED, ["lease:lease-smoke-healthy"]),
      day("2026-07-03", TimelineState.LEASED, ["lease:lease-smoke-healthy"])
    ]
  });
}

function depositAndOverdueInput(): FleetOpsSnapshotBuilderInput {
  const exposure = {
    evidence: [riskEvidence("receivable_bill", "bill-smoke", "remaining amount drives overdue exposure", 700)],
    maxOverdueDays: 6,
    overdueAmount: 700,
    overdueBillCount: 1,
    overdueBillRefs: [
      {
        billId: "bill-smoke",
        dueDate: new Date("2026-06-27T00:00:00.000Z"),
        overdueDays: 6,
        paidAmount: 300,
        remainingAmount: 700,
        sourceStatus: BillStatus.PENDING
      }
    ],
    overdueRemainingAmount: 700,
    partialPaymentCount: 1,
    partialPaymentEvidence: [riskEvidence("payment_record", "payment-smoke", "partial payment reduced exposure", 300)],
    score: 18,
    unpaidAmount: 700,
    warnings: [],
    writeOffEvidence: [
      {
        amount: 100,
        billId: "bill-smoke",
        id: "writeoff-smoke",
        paymentId: "payment-smoke",
        writeOffAt: to
      }
    ]
  };

  return baseInput("smoke-overdue", {
    economics: economics("smoke-overdue", {
      actualDeposit: 500,
      actualOperating: 1200,
      depositExcludedRevenue: 500,
      revenue: 1200,
      warnings: ["DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"]
    }),
    risk: risk("smoke-overdue", {
      agingBucket: CollectionPriorityLevel.D2,
      arrearsPipeline: {
        actionRefs: [{ actionId: "action-smoke", actionType: CollectionActionType.PROMISE_TO_PAY, result: CollectionActionResult.CUSTOMER_PROMISED }],
        billRefs: exposure.overdueBillRefs,
        caseRefs: [{ caseId: "case-smoke", caseStatus: CollectionCaseStatus.ACTIVE, collectionLevel: CollectionPriorityLevel.D2 }],
        evidence: [
          riskEvidence("collection_case", "case-smoke", "collection case supports overdue bill evidence"),
          riskEvidence("collection_action", "action-smoke", "collection action records promise to pay")
        ],
        paymentRefs: [{ paymentId: "payment-smoke" }],
        promiseToPayRefs: [{ actionId: "action-smoke", promisedAmount: 700, promisedPayAt: new Date("2026-07-05T00:00:00.000Z") }],
        stage: "OVERDUE_WITH_ACTIVE_CASE",
        vehicleId: "smoke-overdue",
        warnings: [],
        writeOffRefs: exposure.writeOffEvidence
      },
      collectionLevel: CollectionPriorityLevel.D2,
      controlDecision: ControlDecision.WARN,
      exposureDetail: exposure,
      riskScore: 42,
      signals: [RiskSignalCode.OVERDUE_SIGNAL]
    }),
    state: state("smoke-overdue", VehicleComputedOperationalState.LEASED_ACTIVE, "LEASE", "lease-smoke-overdue"),
    timeline: [day("2026-07-03", TimelineState.LEASED, ["lease:lease-smoke-overdue"])]
  });
}

function fallbackConflictInput(): FleetOpsSnapshotBuilderInput {
  return baseInput("smoke-conflict", {
    economics: economics("smoke-conflict", {
      confidenceScore: 65,
      revenue: 0,
      warnings: [TIMELINE_CURRENT_STATUS_PROJECTED_WARNING]
    }),
    risk: risk("smoke-conflict", {
      confidence: 62,
      warnings: [{ code: TIMELINE_CURRENT_STATUS_PROJECTED_WARNING, message: "Fallback propagated into risk." }]
    }),
    state: state("smoke-conflict", VehicleComputedOperationalState.AVAILABLE, "VEHICLE", "smoke-conflict"),
    timeline: [
      day("2026-07-03", TimelineState.LEASED, ["vehicle:smoke-conflict", "lease:lease-smoke-conflict"], 55, [
        TIMELINE_CURRENT_STATUS_PROJECTED_WARNING
      ])
    ]
  });
}

function baseInput(
  vehicleId: string,
  overrides: Pick<FleetOpsSnapshotBuilderInput, "economics" | "risk" | "state" | "timeline">
): FleetOpsSnapshotBuilderInput {
  return {
    from,
    generatedAt,
    to,
    vehicleId,
    ...overrides
  };
}

function state(
  vehicleId: string,
  computedState: VehicleComputedOperationalState,
  source: "LEASE" | "VEHICLE",
  sourceId: string
): FleetOpsSnapshotBuilderInput["state"] {
  return {
    asOf: to,
    computedState,
    confidenceBand: VehicleOperationalConfidenceBand.HIGH,
    confidenceScore: 90,
    conflicts: [],
    primaryEvidence: {
      fields: { computedState },
      reason: `${source} evidence selected ${computedState}.`,
      recordedAt: to,
      source,
      sourceId
    },
    supportingEvidence: [],
    vehicleId,
    warnings: []
  };
}

function day(date: string, stateValue: TimelineState, sourceEvents: string[], confidence = 88, warnings: string[] = []): TimelineDay {
  return {
    confidence,
    conflicts: [],
    date,
    sourceEvents,
    state: stateValue,
    warnings
  };
}

function economics(
  vehicleId: string,
  options: {
    actualDeposit?: number;
    actualOperating?: number;
    confidenceScore?: number;
    depositExcludedRevenue?: number;
    revenue?: number;
    warnings?: string[];
  } = {}
): FleetOpsSnapshotBuilderInput["economics"] {
  const revenue = options.revenue ?? options.actualOperating ?? 0;

  return {
    attribution: {
      depositExcludedRevenue: options.depositExcludedRevenue ?? 0,
      ignoredRevenue: 0,
      leaseRevenue: revenue,
      penaltyRevenue: 0,
      recognizedPaymentCount: revenue > 0 ? 1 : 0,
      unassignedRevenue: 0,
      writeOffImpact: 0
    },
    cashflow: {
      actual: { deposit: options.actualDeposit ?? 0, operating: options.actualOperating ?? revenue, unassigned: 0 },
      evidence: [
        kpiEvidence("payment_record", "payment-smoke", "confirmed payment contributes operating cashflow", revenue),
        kpiEvidence("deposit_ledger", "deposit-smoke", "deposit cashflow is separate from operating revenue", options.actualDeposit ?? 0)
      ],
      planned: { deposit: 0, operating: revenue },
      warnings: options.warnings ?? [],
      writeOff: { appliedDeposit: 0, appliedOperating: 100, unlinked: 0 }
    },
    confidence: { band: (options.confidenceScore ?? 90) >= 80 ? "HIGH" : "MEDIUM", reasons: [], score: options.confidenceScore ?? 90 },
    denominatorEvidence: [kpiEvidence("denominator", vehicleId, "invested capital supplied by cost profile")],
    downtime: {
      breakdown: { IDLE: 0, MAINTENANCE: 0, RESERVED: 0, SERVICE: 0 },
      downtimeCost: 0,
      totalDowntimeDays: 0,
      trace: []
    },
    economics: { cost: revenue > 0 ? 250 : 0, netIncome: revenue > 0 ? revenue - 250 : 0, revenue, roe: revenue > 0 ? 0.12 : 0, roi: revenue > 0 ? 0.1 : 0 },
    evidence: [kpiEvidence("payment_record", "payment-smoke", "confirmed payment contributes realized revenue", revenue)],
    reportParity: { depositIncludedInOperatingRevenue: false, operatingRevenueBillTypes: [BillType.MONTHLY_RENT, BillType.DAMAGE_FEE] },
    utilization: { leasedDays: revenue > 0 ? 3 : 0, operatingDays: 3, utilizationRate: revenue > 0 ? 1 : 0 },
    vehicleId,
    warnings: options.warnings ?? []
  };
}

function risk(vehicleId: string, options: Partial<NonNullable<FleetOpsSnapshotBuilderInput["risk"]>> = {}): FleetOpsSnapshotBuilderInput["risk"] {
  return {
    agingBucket: CollectionPriorityLevel.NONE,
    arrearsPipeline: {
      actionRefs: [],
      billRefs: [],
      caseRefs: [],
      evidence: [],
      paymentRefs: [],
      promiseToPayRefs: [],
      stage: "NO_OVERDUE",
      vehicleId,
      warnings: [],
      writeOffRefs: []
    },
    collectionLevel: CollectionPriorityLevel.D1,
    confidence: 90,
    controlDecision: ControlDecision.ALLOW,
    evidence: [],
    exposureDetail: {
      evidence: [],
      maxOverdueDays: 0,
      overdueAmount: 0,
      overdueBillCount: 0,
      overdueBillRefs: [],
      overdueRemainingAmount: 0,
      partialPaymentCount: 0,
      partialPaymentEvidence: [],
      score: 0,
      unpaidAmount: 0,
      warnings: [],
      writeOffEvidence: []
    },
    exposureScore: 0,
    reasons: ["Smoke fixture is low risk."],
    riskScore: 0,
    signals: [],
    vehicleId,
    warnings: [],
    ...options
  };
}

function kpiEvidence(source: "denominator" | "deposit_ledger" | "payment_record", sourceId: string, reason: string, amount?: number) {
  return { amount, reason, source, sourceId };
}

function riskEvidence(source: "collection_action" | "collection_case" | "payment_record" | "receivable_bill", sourceId: string, reason: string, amount?: number) {
  return { amount, reason, source, sourceId };
}

function sourceSet(snapshot: FleetOpsSnapshot) {
  return [...new Set(snapshot.evidence.map((item) => item.source))].sort();
}
