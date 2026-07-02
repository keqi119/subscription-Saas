import {
  BillStatus,
  BillType,
  CollectionActionResult,
  CollectionActionType,
  CollectionCaseStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { FleetOpsFacade } from "../src/fleet-ops/facade/fleet-ops.facade";
import { ExecutionActionType } from "../src/fleet-ops/execution/execution.types";
import { CollectionPriorityLevel, ControlDecision, RiskSignalCode } from "../src/fleet-ops/risk/risk.types";
import { TimelineState } from "../src/fleet-ops/timeline/vehicle-timeline.types";
import {
  VehicleComputedOperationalState,
  VehicleOperationalConfidenceBand
} from "../src/fleet-ops/vehicle-operational-state.types";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-07-03T00:00:00.000Z");
const generatedAt = new Date("2026-07-03T12:00:00.000Z");

describe("FleetOpsFacade convergence query", () => {
  it("aggregates PR-1 to PR-5 projections into a single FleetOpsSnapshot", async () => {
    const dependencies = createDependencies();
    const facade = new FleetOpsFacade(dependencies, () => generatedAt);

    const snapshot = await facade.query("vehicle-1", { from, generatedAt, to });

    expect(dependencies.stateService.resolveVehicleOperationalState).toHaveBeenCalledWith("vehicle-1", to);
    expect(dependencies.timelineService.getVehicleTimeline).toHaveBeenCalledWith("vehicle-1", from, to);
    expect(dependencies.kpiService.getFleetKpis).toHaveBeenCalledWith(["vehicle-1"], from, to);
    expect(dependencies.riskService.getFleetRisk).toHaveBeenCalledWith(["vehicle-1"], from, to);
    expect(snapshot).toEqual(
      expect.objectContaining({
        economics: expect.objectContaining({
          cost: 250,
          revenue: 1200,
          roe: 0.12,
          roi: 0.1
        }),
        execution: expect.objectContaining({
          allowedActions: expect.any(Array),
          blockedActions: expect.any(Array),
          guardDecision: ControlDecision.BLOCK
        }),
        risk: expect.objectContaining({
          agingBucket: CollectionPriorityLevel.D2,
          arrearsPipeline: expect.objectContaining({ stage: "OVERDUE_WITH_ACTIVE_CASE" }),
          collectionLevel: CollectionPriorityLevel.D2,
          exposureDetail: expect.objectContaining({ overdueRemainingAmount: 700 }),
          level: CollectionPriorityLevel.D2,
          score: 42,
          signals: [RiskSignalCode.OVERDUE_SIGNAL]
        }),
        state: expect.objectContaining({
          computedState: VehicleComputedOperationalState.LEASED_ACTIVE,
          confidence: expect.objectContaining({ score: 88 })
        }),
        timeline: expect.objectContaining({
          events: expect.any(Array),
          summary: expect.objectContaining({ rangeDays: 2 })
        }),
        vehicleId: "vehicle-1"
      })
    );
    expect(snapshot.execution.allowedActions.map((action) => action.actionType)).toEqual(
      expect.arrayContaining([
        ExecutionActionType.COLLECTION_ESCALATION,
        ExecutionActionType.MAINTENANCE_TRIGGER,
        ExecutionActionType.RESTRICT_VEHICLE
      ])
    );
    expect(snapshot.execution.blockedActions.map((action) => action.actionType)).toEqual(
      expect.arrayContaining([
        ExecutionActionType.LEASE_ACTIVATION,
        ExecutionActionType.VEHICLE_ALLOCATION
      ])
    );
    expect(snapshot.economics.cashflow.actualDetail).toEqual({
      deposit: 300,
      operating: 1200,
      unassigned: 0
    });
    expect(snapshot.economics.attribution).toEqual(expect.objectContaining({ depositExcludedRevenue: 300 }));
    expect(snapshot.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "deposit_ledger", sourceId: "deposit-1" }),
        expect.objectContaining({ source: "payment_record", sourceId: "payment-1" }),
        expect.objectContaining({ source: "payment_write_off", sourceId: "writeoff-1" }),
        expect.objectContaining({ source: "receivable_bill", sourceId: "bill-1" }),
        expect.objectContaining({ source: "collection_case", sourceId: "case-1" }),
        expect.objectContaining({ source: "collection_action", sourceId: "action-1" })
      ])
    );
    expect("executeAction" in facade).toBe(false);
  });

  it("does not mutate underlying PR outputs and stays deterministic", async () => {
    const dependencies = createDependencies();
    const stateOutput = await dependencies.stateService.resolveVehicleOperationalState("vehicle-1", to);
    const timelineOutput = await dependencies.timelineService.getVehicleTimeline("vehicle-1", from, to);
    const kpiOutput = await dependencies.kpiService.getFleetKpis(["vehicle-1"], from, to);
    const riskOutput = await dependencies.riskService.getFleetRisk(["vehicle-1"], from, to);
    const before = JSON.stringify({ kpiOutput, riskOutput, stateOutput, timelineOutput });
    const facade = new FleetOpsFacade(dependencies, () => generatedAt);

    const first = await facade.query("vehicle-1", { from, generatedAt, to });
    const second = await facade.query("vehicle-1", { from, generatedAt, to });

    expect(first).toEqual(second);
    expect(JSON.stringify({ kpiOutput, riskOutput, stateOutput, timelineOutput })).toBe(before);
  });

  it("supports query(vehicleId) with a deterministic injected clock", async () => {
    const dependencies = createDependencies();
    const facade = new FleetOpsFacade(dependencies, () => generatedAt);

    const snapshot = await facade.query("vehicle-1");

    expect(snapshot.generatedAt).toEqual(generatedAt);
    expect(snapshot.range).toEqual({
      from: new Date("2026-07-03T00:00:00.000Z"),
      to: generatedAt
    });
  });
});

function createDependencies() {
  return {
    kpiService: {
      getFleetKpis: vi.fn(async (_vehicleIds: string[], _from: Date, _to: Date) => {
        void _vehicleIds;
        void _from;
        void _to;

        return {
          fleet: {
            cost: 250,
            downtimeCost: 0,
            downtimeDays: 0,
            leasedDays: 2,
            netIncome: 950,
            operatingDays: 2,
            revenue: 1200,
            roe: 0.12,
            roi: 0.1,
            utilizationRate: 1,
            vehicleCount: 1
          },
            vehicles: [
            {
              attribution: {
                depositExcludedRevenue: 300,
                ignoredRevenue: 0,
                leaseRevenue: 1200,
                penaltyRevenue: 0,
                recognizedPaymentCount: 1,
                unassignedRevenue: 0,
                writeOffImpact: 100
              },
              cashflow: {
                actual: { deposit: 300, operating: 1200, unassigned: 0 },
                evidence: [
                  {
                    amount: 1200,
                    reason: "confirmed rent payment contributes actual operating cashflow",
                    source: "payment_record" as const,
                    sourceId: "payment-1"
                  },
                  {
                    amount: 300,
                    reason: "deposit ledger cashflow is separate from operating revenue",
                    source: "deposit_ledger" as const,
                    sourceId: "deposit-1"
                  },
                  {
                    amount: 100,
                    reason: "write-off allocation is preserved without double counting exposure",
                    source: "payment_write_off" as const,
                    sourceId: "writeoff-1"
                  }
                ],
                planned: { deposit: 0, operating: 1500 },
                warnings: ["DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"],
                writeOff: { appliedDeposit: 0, appliedOperating: 100, unlinked: 0 }
              },
              confidence: { band: "HIGH" as const, score: 90 },
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
                totalDowntimeDays: 0
              },
              economics: { cost: 250, netIncome: 950, revenue: 1200, roe: 0.12, roi: 0.1 },
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
              utilization: { leasedDays: 2, operatingDays: 2, utilizationRate: 1 },
              vehicleId: "vehicle-1",
              warnings: ["DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"]
            }
          ]
        };
      })
    },
    riskService: {
      getFleetRisk: vi.fn(async (_vehicleIds: string[], _from: Date, _to: Date) => {
        void _vehicleIds;
        void _from;
        void _to;

        return {
          fleet: {
            averageExposureScore: 30,
            averageRiskScore: 42,
            blockedVehicles: 0,
            vehicleCount: 1,
            warnedVehicles: 1
          },
          vehicles: [
            {
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
                warnings: [],
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
              confidence: 70,
              controlDecision: ControlDecision.BLOCK,
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
                warnings: [],
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
              exposureScore: 30,
              reasons: ["Overdue exposure requires review."],
              riskScore: 42,
              signals: [RiskSignalCode.OVERDUE_SIGNAL],
              vehicleId: "vehicle-1"
            }
          ]
        };
      })
    },
    stateService: {
      resolveVehicleOperationalState: vi.fn(async (_vehicleId: string, _asOf?: Date) => {
        void _vehicleId;
        void _asOf;

        return {
          asOf: to,
          computedState: VehicleComputedOperationalState.LEASED_ACTIVE,
          confidenceBand: VehicleOperationalConfidenceBand.HIGH,
          confidenceScore: 88,
          conflicts: [],
          primaryEvidence: {
            fields: { status: "LEASED" },
            reason: "Active lease signal.",
            recordedAt: new Date("2026-07-03T09:00:00.000Z"),
            source: "LEASE" as const,
            sourceId: "lease-1"
          },
          supportingEvidence: [],
          vehicleId: "vehicle-1",
          warnings: []
        };
      })
    },
    timelineService: {
      getVehicleTimeline: vi.fn(async (_vehicleId: string, _from: Date, _to: Date) => {
        void _vehicleId;
        void _from;
        void _to;

        return [
          {
            confidence: 85,
            conflicts: [],
            date: "2026-07-02",
            sourceEvents: ["lease:lease-1"],
            state: TimelineState.LEASED,
            warnings: []
          },
          {
            confidence: 80,
            conflicts: [],
            date: "2026-07-03",
            sourceEvents: ["lease:lease-1"],
            state: TimelineState.LEASED,
            warnings: []
          }
        ];
      })
    }
  };
}
