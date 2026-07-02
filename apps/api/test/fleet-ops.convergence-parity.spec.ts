import {
  BillStatus,
  BillType,
  CollectionActionResult,
  CollectionActionType,
  CollectionCaseStatus
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { EconomicTimelineState } from "../src/fleet-ops/economics/economics.types";
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

describe("FleetOps convergence snapshot parity", () => {
  it("preserves P1-H3 economics details and P1-H4 collection risk details without mutating PR outputs", () => {
    const input = snapshotInput();
    const before = JSON.stringify(input);

    const snapshot = buildFleetOpsSnapshot(input);
    const economics = snapshot.economics;
    const risk = snapshot.risk;

    expect(JSON.stringify(input)).toBe(before);
    expect(economics.cashflow.actualDetail).toEqual({
      deposit: 400,
      operating: 1200,
      unassigned: 250
    });
    expect(economics.cashflow.plannedDetail).toEqual({
      deposit: 300,
      operating: 1500
    });
    expect(economics.cashflow.writeOff).toEqual({
      appliedDeposit: 0,
      appliedOperating: 100,
      unlinked: 25
    });
    expect(economics.attribution).toMatchObject({
      depositExcludedRevenue: 400,
      leaseRevenue: 1200,
      unassignedRevenue: 250
    });
    expect(economics.denominatorEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "invested capital supplied by vehicle cost profile",
          source: "denominator",
          sourceId: "vehicle-1"
        })
      ])
    );
    expect(economics.reportParity).toEqual({
      depositIncludedInOperatingRevenue: false,
      operatingRevenueBillTypes: [BillType.MONTHLY_RENT, BillType.DAMAGE_FEE]
    });
    expect(economics.warnings).toEqual(
      expect.arrayContaining([
        "DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE",
        "UNASSIGNED_PAYMENT_EXCLUDED",
        TIMELINE_CURRENT_STATUS_PROJECTED_WARNING
      ])
    );
    expect(economics.downtimeTrace).toEqual([
      expect.objectContaining({
        date: "2026-07-02",
        sourceEvents: ["service:svc-1"]
      })
    ]);

    expect(risk.collectionLevel).toBe(CollectionPriorityLevel.D2);
    expect(risk.agingBucket).toBe(CollectionPriorityLevel.D2);
    expect(risk.exposureDetail).toMatchObject({
      maxOverdueDays: 6,
      overdueBillCount: 1,
      overdueRemainingAmount: 700
    });
    expect(risk.overdueBillRefs).toEqual([
      expect.objectContaining({
        billId: "bill-1",
        overdueDays: 6,
        remainingAmount: 700
      })
    ]);
    expect(risk.arrearsPipeline).toMatchObject({
      stage: "OVERDUE_WITH_ACTIVE_CASE",
      vehicleId: "vehicle-1"
    });
    expect(risk.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "FACTUAL_OVERDUE_STATUS_NOT_REFRESHED" }),
        expect.objectContaining({ code: "UNASSIGNED_PAYMENT_EXCLUDED" })
      ])
    );

    expect(snapshot.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "payment_record", sourceId: "payment-1" }),
        expect.objectContaining({ source: "payment_write_off", sourceId: "writeoff-1" }),
        expect.objectContaining({ source: "receivable_bill", sourceId: "bill-1" }),
        expect.objectContaining({ source: "deposit_ledger", sourceId: "deposit-1" }),
        expect.objectContaining({ source: "denominator", sourceId: "vehicle-1" }),
        expect.objectContaining({ source: "collection_case", sourceId: "case-1" }),
        expect.objectContaining({ source: "collection_action", sourceId: "action-1" })
      ])
    );
    expect(sourceEvidenceTypes(snapshot.evidence)).toEqual(
      expect.arrayContaining([
        "collection_action:arrears_action",
        "collection_case:arrears_case",
        "deposit_ledger:deposit_ledger",
        "denominator:denominator",
        "payment_record:arrears_payment",
        "payment_record:payment_record",
        "payment_write_off:payment_write_off",
        "payment_write_off:write_off_allocation",
        "receivable_bill:arrears_bill",
        "receivable_bill:overdue_bill"
      ])
    );
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ECONOMICS_WARNING",
          message: "UNASSIGNED_PAYMENT_EXCLUDED"
        }),
        expect.objectContaining({
          code: "RISK_WARNING",
          message: "FACTUAL_OVERDUE_STATUS_NOT_REFRESHED"
        })
      ])
    );
  });
});

function snapshotInput() {
  return {
    economics: {
      attribution: {
        depositExcludedRevenue: 400,
        ignoredRevenue: 0,
        leaseRevenue: 1200,
        penaltyRevenue: 0,
        recognizedPaymentCount: 1,
        unassignedRevenue: 250,
        writeOffImpact: 100
      },
      cashflow: {
        actual: {
          deposit: 400,
          operating: 1200,
          unassigned: 250
        },
        evidence: [
          {
            amount: 1200,
            reason: "confirmed payment received date contributes actual operating cashflow",
            source: "payment_record" as const,
            sourceId: "payment-1"
          },
          {
            amount: 100,
            reason: "payment write-off allocation contributes actual cashflow without counting the parent payment twice",
            source: "payment_write_off" as const,
            sourceId: "writeoff-1"
          },
          {
            amount: 1500,
            reason: "receivable due date contributes planned operating cashflow only",
            source: "receivable_bill" as const,
            sourceId: "bill-1"
          },
          {
            amount: 400,
            reason: "deposit ledger cashflow is separate from operating revenue",
            source: "deposit_ledger" as const,
            sourceId: "deposit-1"
          }
        ],
        planned: {
          deposit: 300,
          operating: 1500
        },
        warnings: [
          "DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE",
          "UNASSIGNED_PAYMENT_EXCLUDED",
          "WRITE_OFF_WITHOUT_CLEAR_BILL_LINKAGE"
        ],
        writeOff: {
          appliedDeposit: 0,
          appliedOperating: 100,
          unlinked: 25
        }
      },
      confidence: {
        band: "MEDIUM" as const,
        reasons: ["timeline fallback reduced confidence"],
        score: 72
      },
      denominatorEvidence: [
        {
          reason: "invested capital supplied by vehicle cost profile",
          source: "denominator" as const,
          sourceId: "vehicle-1"
        }
      ],
      downtime: {
        breakdown: { IDLE: 0, MAINTENANCE: 1, RESERVED: 0, SERVICE: 0 },
        downtimeCost: 75,
        totalDowntimeDays: 1,
        trace: [
          {
            cost: 75,
            date: "2026-07-02",
            sourceEvents: ["service:svc-1"],
            state: EconomicTimelineState.MAINTENANCE
          }
        ]
      },
      economics: {
        cost: 250,
        netIncome: 1050,
        revenue: 1200,
        roe: 0.12,
        roi: 0.1
      },
      evidence: [
        {
          amount: 1200,
          reason: "confirmed payment contributes realized operating revenue",
          source: "payment_record" as const,
          sourceId: "payment-1"
        }
      ],
      reportParity: {
        depositIncludedInOperatingRevenue: false as const,
        operatingRevenueBillTypes: [BillType.MONTHLY_RENT, BillType.DAMAGE_FEE]
      },
      utilization: {
        economicUtilizationSource: "timeline_leased_days_with_revenue_support" as const,
        leasedDays: 2,
        operatingDays: 3,
        timelineWarningCount: 1,
        utilizationRate: 0.666667
      },
      vehicleId: "vehicle-1",
      warnings: [
        "DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE",
        "UNASSIGNED_PAYMENT_EXCLUDED",
        TIMELINE_CURRENT_STATUS_PROJECTED_WARNING
      ]
    },
    from,
    generatedAt,
    risk: {
      agingBucket: CollectionPriorityLevel.D2,
      arrearsPipeline: {
        actionRefs: [
          {
            actionId: "action-1",
            actionType: CollectionActionType.PROMISE_TO_PAY,
            result: CollectionActionResult.CUSTOMER_PROMISED
          }
        ],
        billRefs: [
          {
            billId: "bill-1",
            dueDate: new Date("2026-06-27T00:00:00.000Z"),
            overdueDays: 6,
            paidAmount: 300,
            remainingAmount: 700,
            sourceStatus: BillStatus.PENDING
          }
        ],
        caseRefs: [
          {
            caseId: "case-1",
            caseStatus: CollectionCaseStatus.ACTIVE,
            collectionLevel: CollectionPriorityLevel.D2
          }
        ],
        evidence: [
          {
            reason: "collection case is supporting evidence only",
            source: "collection_case" as const,
            sourceId: "case-1"
          },
          {
            reason: "collection action records promise to pay",
            source: "collection_action" as const,
            sourceId: "action-1"
          }
        ],
        paymentRefs: [{ paymentId: "payment-1" }],
        promiseToPayRefs: [
          {
            actionId: "action-1",
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
            sourceId: "bill-1"
          }
        ],
        writeOffRefs: [
          {
            amount: 100,
            billId: "bill-1",
            id: "writeoff-1",
            paymentId: "payment-1",
            writeOffAt: new Date("2026-07-03T00:00:00.000Z")
          }
        ]
      },
      collectionLevel: CollectionPriorityLevel.D2,
      confidence: 68,
      controlDecision: ControlDecision.WARN,
      evidence: [
        {
          amount: 700,
          reason: "remaining amount drives overdue exposure",
          source: "receivable_bill" as const,
          sourceId: "bill-1"
        }
      ],
      exposureDetail: {
        evidence: [
          {
            amount: 700,
            reason: "remaining amount drives overdue exposure",
            source: "receivable_bill" as const,
            sourceId: "bill-1"
          }
        ],
        maxOverdueDays: 6,
        overdueAmount: 700,
        overdueBillCount: 1,
        overdueBillRefs: [
          {
            billId: "bill-1",
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
            sourceId: "payment-1"
          }
        ],
        score: 18,
        unpaidAmount: 700,
        warnings: [
          {
            code: "FACTUAL_OVERDUE_STATUS_NOT_REFRESHED",
            message: "Bill is factually overdue although status has not refreshed.",
            sourceId: "bill-1"
          }
        ],
        writeOffEvidence: [
          {
            amount: 100,
            billId: "bill-1",
            id: "writeoff-1",
            paymentId: "payment-1",
            writeOffAt: new Date("2026-07-03T00:00:00.000Z")
          }
        ]
      },
      exposureScore: 18,
      reasons: ["Overdue exposure requires collection review."],
      riskScore: 44,
      signals: [RiskSignalCode.OVERDUE_SIGNAL, RiskSignalCode.ECONOMIC_WARNING_SIGNAL],
      vehicleId: "vehicle-1",
      warnings: [
        {
          code: "FACTUAL_OVERDUE_STATUS_NOT_REFRESHED",
          message: "Bill is factually overdue although status has not refreshed.",
          sourceId: "bill-1"
        },
        {
          code: "UNASSIGNED_PAYMENT_EXCLUDED",
          message: "Economic warning propagated into risk confidence."
        }
      ]
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
      timelineDay({
        date: "2026-07-02",
        sourceEvents: ["service:svc-1"],
        state: TimelineState.MAINTENANCE
      }),
      timelineDay({
        date: "2026-07-03",
        sourceEvents: ["payment_record:payment-1"]
      })
    ],
    to,
    vehicleId: "vehicle-1"
  };
}

function timelineDay(overrides: Partial<TimelineDay> = {}): TimelineDay {
  return {
    confidence: 70,
    conflicts: [],
    date: "2026-07-01",
    sourceEvents: ["vehicle:vehicle-1"],
    state: TimelineState.AVAILABLE,
    warnings: [],
    ...overrides
  };
}

function sourceEvidenceTypes(evidence: Array<{ evidenceType?: string; source: string }>) {
  return evidence.map((item) => `${item.source}:${item.evidenceType ?? "summary"}`).sort();
}
