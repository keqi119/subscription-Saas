import {
  BillStatus,
  BillType,
  CollectionActionResult,
  CollectionActionType,
  CollectionCaseStatus
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { buildFleetOpsSnapshot } from "../src/fleet-ops/facade/fleet-ops.snapshot.builder";
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

describe("buildFleetOpsSnapshot", () => {
  it("builds the required convergence snapshot structure without mutating PR outputs", () => {
    const input = snapshotInput();
    const before = JSON.stringify(input);
    const snapshot = buildFleetOpsSnapshot(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(snapshot).toEqual(
      expect.objectContaining({
        economics: expect.objectContaining({
          cashflow: expect.objectContaining({ actual: 1200, deposit: null, planned: null }),
          cost: 250,
          revenue: 1200,
          roe: 0.12,
          roi: 0.1
        }),
        execution: expect.objectContaining({
          allowedActions: expect.any(Array),
          blockedActions: expect.any(Array),
          guardDecision: ControlDecision.ALLOW
        }),
        risk: expect.objectContaining({
          agingBucket: null,
          collectionLevel: CollectionPriorityLevel.D1,
          exposureDetail: null,
          level: CollectionPriorityLevel.D1,
          score: 15,
          signals: [RiskSignalCode.UTILIZATION_DROP_SIGNAL]
        }),
        state: expect.objectContaining({
          computedState: VehicleComputedOperationalState.AVAILABLE,
          evidence: expect.any(Array)
        }),
        system: expect.objectContaining({
          consistencyScore: expect.any(Number),
          dataFreshness: expect.objectContaining({ status: "FRESH" }),
          overallConfidence: expect.objectContaining({ score: expect.any(Number) })
        }),
        timeline: expect.objectContaining({
          events: expect.any(Array),
          summary: expect.objectContaining({
            fallbackWarningDays: 1,
            rangeDays: 3
          }),
          warnings: expect.arrayContaining([TIMELINE_CURRENT_STATUS_PROJECTED_WARNING])
        }),
        vehicleId: "vehicle-1"
      })
    );
    expect(snapshot.economics).toEqual(
      expect.objectContaining({
        attribution: expect.objectContaining({ leaseRevenue: 1200 }),
        denominatorEvidence: [],
        evidence: [],
        warnings: []
      })
    );
    expect(snapshot.execution.allowedActions.map((action) => action.actionType).sort()).toContain("VEHICLE_ALLOCATION");
    expect(snapshot.execution.blockedActions.map((action) => action.actionType).sort()).toContain("RESTRICT_VEHICLE");
  });

  it("is deterministic for identical PR outputs", () => {
    const input = snapshotInput();

    expect(buildFleetOpsSnapshot(input)).toEqual(buildFleetOpsSnapshot(input));
  });

  it("surfaces P1-H6 smoke details for economics, risk, evidence, warnings, and confidence", () => {
    const snapshot = buildFleetOpsSnapshot(richSnapshotInput());

    expect(snapshot.economics.cashflow.actualDetail).toEqual({
      deposit: 400,
      operating: 1200,
      unassigned: 0
    });
    expect(snapshot.economics.attribution).toEqual(expect.objectContaining({ depositExcludedRevenue: 400 }));
    expect(snapshot.economics.denominatorEvidence).toEqual([expect.objectContaining({ source: "denominator" })]);
    expect(snapshot.risk.exposureDetail).toEqual(expect.objectContaining({ maxOverdueDays: 6, overdueRemainingAmount: 700 }));
    expect(snapshot.risk.agingBucket).toBe(CollectionPriorityLevel.D2);
    expect(snapshot.risk.arrearsPipeline).toEqual(expect.objectContaining({ stage: "OVERDUE_WITH_ACTIVE_CASE" }));
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ECONOMICS_WARNING", message: "DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE" }),
        expect.objectContaining({ code: "RISK_WARNING", message: "FACTUAL_OVERDUE_STATUS_NOT_REFRESHED" })
      ])
    );
    expect(snapshot.system.overallConfidence).toEqual(expect.objectContaining({ reasons: expect.any(Array), score: expect.any(Number) }));
    expect(snapshot.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "deposit_ledger", sourceId: "deposit-rich" }),
        expect.objectContaining({ source: "payment_record", sourceId: "payment-rich" }),
        expect.objectContaining({ source: "receivable_bill", sourceId: "bill-rich" }),
        expect.objectContaining({ source: "collection_case", sourceId: "case-rich" }),
        expect.objectContaining({ source: "collection_action", sourceId: "action-rich" })
      ])
    );
  });

  it("marks state versus timeline conflicts without resolving them", () => {
    const snapshot = buildFleetOpsSnapshot({
      ...snapshotInput(),
      timeline: [
        timelineDay({
          date: "2026-07-01",
          sourceEvents: ["lease:lease-1", "vehicle:vehicle-1"],
          state: TimelineState.LEASED
        })
      ]
    });

    expect(snapshot.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "STATE_AVAILABLE_WITH_LEASE_TIMELINE",
          reason: "PR-1 state is AVAILABLE while PR-2 timeline contains leased days.",
          severity: "HIGH"
        })
      ])
    );
    expect(snapshot.state.computedState).toBe(VehicleComputedOperationalState.AVAILABLE);
    expect(snapshot.timeline.events[0]!.state).toBe(TimelineState.LEASED);
  });
});

function snapshotInput() {
  return {
    economics: {
      attribution: { leaseRevenue: 1200, penaltyRevenue: 0, writeOffImpact: 0 },
      confidence: { band: "HIGH" as const, score: 90 },
      downtime: {
        breakdown: { IDLE: 0, MAINTENANCE: 0, RESERVED: 0, SERVICE: 0 },
        downtimeCost: 0,
        totalDowntimeDays: 0
      },
      economics: { cost: 250, netIncome: 950, revenue: 1200, roe: 0.12, roi: 0.1 },
      utilization: { leasedDays: 2, operatingDays: 3, utilizationRate: 0.666667 },
      vehicleId: "vehicle-1"
    },
    from,
    generatedAt,
    risk: {
      collectionLevel: CollectionPriorityLevel.D1,
      confidence: 80,
      controlDecision: ControlDecision.ALLOW,
      exposureScore: 10,
      reasons: ["Risk signals within normal control tolerance."],
      riskScore: 15,
      signals: [RiskSignalCode.UTILIZATION_DROP_SIGNAL],
      vehicleId: "vehicle-1"
    },
    state: {
      asOf: to,
      computedState: VehicleComputedOperationalState.AVAILABLE,
      confidenceBand: VehicleOperationalConfidenceBand.HIGH,
      confidenceScore: 92,
      conflicts: [],
      primaryEvidence: {
        fields: { status: "AVAILABLE" },
        reason: "Vehicle status is available.",
        recordedAt: new Date("2026-07-03T09:00:00.000Z"),
        source: "VEHICLE" as const,
        sourceId: "vehicle-1"
      },
      supportingEvidence: [],
      vehicleId: "vehicle-1",
      warnings: []
    },
    timeline: [
      timelineDay({
        date: "2026-07-01",
        sourceEvents: ["vehicle:vehicle-1"],
        warnings: [TIMELINE_CURRENT_STATUS_PROJECTED_WARNING]
      }),
      timelineDay({ date: "2026-07-02", sourceEvents: ["order:order-1"], state: TimelineState.RESERVED }),
      timelineDay({ date: "2026-07-03", sourceEvents: ["vehicle:vehicle-1"] })
    ],
    to,
    vehicleId: "vehicle-1"
  };
}

function richSnapshotInput() {
  return {
    ...snapshotInput(),
    economics: {
      attribution: {
        depositExcludedRevenue: 400,
        ignoredRevenue: 0,
        leaseRevenue: 1200,
        penaltyRevenue: 0,
        recognizedPaymentCount: 1,
        unassignedRevenue: 0,
        writeOffImpact: 0
      },
      cashflow: {
        actual: { deposit: 400, operating: 1200, unassigned: 0 },
        evidence: [
          {
            amount: 1200,
            reason: "confirmed rent payment contributes actual operating cashflow",
            source: "payment_record" as const,
            sourceId: "payment-rich"
          },
          {
            amount: 400,
            reason: "deposit cashflow is separate from operating revenue",
            source: "deposit_ledger" as const,
            sourceId: "deposit-rich"
          }
        ],
        planned: { deposit: 0, operating: 1200 },
        warnings: ["DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"],
        writeOff: { appliedDeposit: 0, appliedOperating: 100, unlinked: 0 }
      },
      confidence: { band: "MEDIUM" as const, reasons: ["deposit exclusion evidence retained"], score: 74 },
      denominatorEvidence: [
        {
          reason: "invested capital supplied by vehicle cost profile",
          source: "denominator" as const,
          sourceId: "vehicle-1"
        }
      ],
      downtime: {
        breakdown: { IDLE: 0, MAINTENANCE: 0, RESERVED: 0, SERVICE: 0 },
        downtimeCost: 0,
        totalDowntimeDays: 0,
        trace: []
      },
      economics: { cost: 250, netIncome: 950, revenue: 1200, roe: 0.12, roi: 0.1 },
      evidence: [
        {
          amount: 1200,
          reason: "confirmed payment contributes realized operating revenue",
          source: "payment_record" as const,
          sourceId: "payment-rich"
        }
      ],
      reportParity: {
        depositIncludedInOperatingRevenue: false as const,
        operatingRevenueBillTypes: [BillType.MONTHLY_RENT, BillType.DAMAGE_FEE]
      },
      utilization: { leasedDays: 2, operatingDays: 3, utilizationRate: 0.666667 },
      vehicleId: "vehicle-1",
      warnings: ["DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"]
    },
    risk: {
      agingBucket: CollectionPriorityLevel.D2,
      arrearsPipeline: {
        actionRefs: [
          {
            actionId: "action-rich",
            actionType: CollectionActionType.PROMISE_TO_PAY,
            result: CollectionActionResult.CUSTOMER_PROMISED
          }
        ],
        billRefs: [
          {
            billId: "bill-rich",
            dueDate: new Date("2026-06-27T00:00:00.000Z"),
            overdueDays: 6,
            paidAmount: 300,
            remainingAmount: 700,
            sourceStatus: BillStatus.PENDING
          }
        ],
        caseRefs: [
          {
            caseId: "case-rich",
            caseStatus: CollectionCaseStatus.ACTIVE,
            collectionLevel: CollectionPriorityLevel.D2
          }
        ],
        evidence: [
          {
            reason: "collection case is supporting evidence only",
            source: "collection_case" as const,
            sourceId: "case-rich"
          },
          {
            reason: "collection action records promise to pay",
            source: "collection_action" as const,
            sourceId: "action-rich"
          }
        ],
        paymentRefs: [{ paymentId: "payment-rich" }],
        promiseToPayRefs: [
          {
            actionId: "action-rich",
            promisedAmount: 700,
            promisedPayAt: new Date("2026-07-05T00:00:00.000Z")
          }
        ],
        stage: "OVERDUE_WITH_ACTIVE_CASE" as const,
        vehicleId: "vehicle-1",
        warnings: [
          {
            code: "FACTUAL_OVERDUE_STATUS_NOT_REFRESHED",
            message: "Bill is factually overdue although status has not refreshed.",
            sourceId: "bill-rich"
          }
        ],
        writeOffRefs: []
      },
      collectionLevel: CollectionPriorityLevel.D2,
      confidence: 68,
      controlDecision: ControlDecision.WARN,
      evidence: [
        {
          amount: 700,
          reason: "remaining amount drives overdue exposure",
          source: "receivable_bill" as const,
          sourceId: "bill-rich"
        }
      ],
      exposureDetail: {
        evidence: [
          {
            amount: 700,
            reason: "remaining amount drives overdue exposure",
            source: "receivable_bill" as const,
            sourceId: "bill-rich"
          }
        ],
        maxOverdueDays: 6,
        overdueAmount: 700,
        overdueBillCount: 1,
        overdueBillRefs: [
          {
            billId: "bill-rich",
            dueDate: new Date("2026-06-27T00:00:00.000Z"),
            overdueDays: 6,
            paidAmount: 300,
            remainingAmount: 700,
            sourceStatus: BillStatus.PENDING
          }
        ],
        overdueRemainingAmount: 700,
        partialPaymentCount: 1,
        partialPaymentEvidence: [
          {
            amount: 300,
            reason: "partial payment reduced exposure",
            source: "payment_record" as const,
            sourceId: "payment-rich"
          }
        ],
        score: 18,
        unpaidAmount: 700,
        warnings: [
          {
            code: "FACTUAL_OVERDUE_STATUS_NOT_REFRESHED",
            message: "Bill is factually overdue although status has not refreshed.",
            sourceId: "bill-rich"
          }
        ],
        writeOffEvidence: []
      },
      exposureScore: 18,
      reasons: ["Overdue exposure requires collection review."],
      riskScore: 44,
      signals: [RiskSignalCode.OVERDUE_SIGNAL],
      vehicleId: "vehicle-1",
      warnings: [
        {
          code: "FACTUAL_OVERDUE_STATUS_NOT_REFRESHED",
          message: "Bill is factually overdue although status has not refreshed.",
          sourceId: "bill-rich"
        }
      ]
    }
  };
}

function timelineDay(overrides: Partial<TimelineDay> = {}): TimelineDay {
  return {
    ...timelineDayShape(),
    ...overrides
  };
}

function timelineDayShape(): TimelineDay {
  return {
    confidence: 80,
    conflicts: [],
    date: "2026-07-01",
    sourceEvents: ["vehicle:vehicle-1"],
    state: TimelineState.AVAILABLE,
    warnings: []
  };
}
