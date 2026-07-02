import {
  BillStatus,
  BillType,
  CollectionActionResult,
  CollectionActionType,
  CollectionCaseStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import type { FleetKpiReport, FleetKpiVehicleResult, FleetKpiWarning } from "../src/fleet-ops/economics/economics.types";
import { FleetOpsFacade } from "../src/fleet-ops/facade/fleet-ops.facade";
import {
  CollectionPriorityLevel,
  ControlDecision,
  RiskSignalCode,
  type FleetRiskReport,
  type RiskExposure,
  type RiskOutput
} from "../src/fleet-ops/risk/risk.types";
import {
  TIMELINE_CURRENT_STATUS_PROJECTED_WARNING,
  type TimelineDay,
  TimelineState
} from "../src/fleet-ops/timeline/vehicle-timeline.types";
import {
  VehicleComputedOperationalState,
  VehicleOperationalConfidenceBand,
  type VehicleOperationalStateResult
} from "../src/fleet-ops/vehicle-operational-state.types";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-07-03T00:00:00.000Z");
const generatedAt = new Date("2026-07-03T12:00:00.000Z");

interface ContractScenario {
  economics: FleetKpiVehicleResult;
  risk: RiskOutput;
  state: VehicleOperationalStateResult;
  timeline: TimelineDay[];
  vehicleId: string;
}

describe("Fleet Ops E2E convergence contract", () => {
  it("preserves a healthy active lease vehicle through state, timeline, economics, risk, and snapshot", async () => {
    const { dependencies, snapshot } = await queryScenario(activeLeaseScenario());

    expect(dependencies.stateService.resolveVehicleOperationalState).toHaveBeenCalledWith("vehicle-healthy", to);
    expect(dependencies.timelineService.getVehicleTimeline).toHaveBeenCalledWith("vehicle-healthy", from, to);
    expect(dependencies.kpiService.getFleetKpis).toHaveBeenCalledWith(["vehicle-healthy"], from, to);
    expect(dependencies.riskService.getFleetRisk).toHaveBeenCalledWith(["vehicle-healthy"], from, to);
    expect(snapshot.state.computedState).toBe(VehicleComputedOperationalState.LEASED_ACTIVE);
    expect(snapshot.timeline.summary.stateCounts[TimelineState.LEASED]).toBe(3);
    expect(snapshot.economics.revenue).toBe(1500);
    expect(snapshot.risk.overdueRemainingAmount).toBe(0);
    expect(snapshot.risk.collectionLevel).toBe(CollectionPriorityLevel.D1);
    expect(snapshot.system.overallConfidence.score).toBeGreaterThanOrEqual(80);
    expect(snapshot.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "LEASE", sourceId: "lease-healthy" }),
        expect.objectContaining({ source: "payment_record", sourceId: "payment-rent" })
      ])
    );
  });

  it("keeps an idle available vehicle deterministic with visible no-revenue warning context", async () => {
    const scenario = idleAvailableScenario();
    const first = await queryScenario(scenario);
    const second = await queryScenario(scenario);

    expect(first.snapshot).toEqual(second.snapshot);
    expect(first.snapshot.state.computedState).toBe(VehicleComputedOperationalState.AVAILABLE);
    expect(first.snapshot.timeline.summary.stateCounts[TimelineState.AVAILABLE]).toBe(3);
    expect(first.snapshot.economics.revenue).toBe(0);
    expect(first.snapshot.risk.collectionLevel).toBe(CollectionPriorityLevel.D1);
    expect(first.snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ECONOMICS_WARNING",
          message: "NO_REALIZED_REVENUE"
        })
      ])
    );
  });

  it("propagates current-status timeline fallback warning into economics, risk, and convergence confidence", async () => {
    const baseline = await queryScenario(activeLeaseScenario());
    const { snapshot } = await queryScenario(currentStatusFallbackScenario());

    expect(snapshot.timeline.warnings).toContain(TIMELINE_CURRENT_STATUS_PROJECTED_WARNING);
    expect(snapshot.economics.warnings).toEqual(expect.arrayContaining([TIMELINE_CURRENT_STATUS_PROJECTED_WARNING]));
    expect(snapshot.risk.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: TIMELINE_CURRENT_STATUS_PROJECTED_WARNING })]));
    expect(snapshot.system.overallConfidence.score).toBeLessThan(baseline.snapshot.system.overallConfidence.score);
    expect(snapshot.system.overallConfidence.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("fallback evidence penalty")])
    );
    expect(snapshot.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: "VEHICLE", sourceId: "vehicle:vehicle-fallback" })]));
  });

  it("keeps deposit cashflow separate from operating rent revenue", async () => {
    const { snapshot } = await queryScenario(depositAndRentScenario());

    expect(snapshot.economics.revenue).toBe(1200);
    expect(snapshot.economics.cashflow.actualDetail).toEqual({
      deposit: 500,
      operating: 1200,
      unassigned: 0
    });
    expect(snapshot.economics.attribution).toEqual(expect.objectContaining({ depositExcludedRevenue: 500, leaseRevenue: 1200 }));
    expect(snapshot.economics.warnings).toEqual(expect.arrayContaining(["DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"]));
    expect(snapshot.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "payment_record", sourceId: "payment-rent" }),
        expect.objectContaining({ source: "deposit_ledger", sourceId: "deposit-ledger" })
      ])
    );
  });

  it("preserves refresh-independent overdue exposure and D1-D5 aging details", async () => {
    const { snapshot } = await queryScenario(overdueBillScenario());

    expect(snapshot.risk.exposureDetail).toEqual(
      expect.objectContaining({
        maxOverdueDays: 6,
        overdueBillCount: 1,
        overdueRemainingAmount: 700
      })
    );
    expect(snapshot.risk.overdueBillRefs).toEqual([
      expect.objectContaining({
        billId: "bill-overdue",
        overdueDays: 6,
        remainingAmount: 700,
        sourceStatus: BillStatus.PENDING
      })
    ]);
    expect(snapshot.risk.agingBucket).toBe(CollectionPriorityLevel.D2);
    expect(snapshot.risk.collectionLevel).toBe(CollectionPriorityLevel.D2);
    expect(snapshot.risk.arrearsPipeline).toEqual(expect.objectContaining({ stage: "OVERDUE_WITH_ACTIVE_CASE" }));
    expect(snapshot.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "receivable_bill", sourceId: "bill-overdue" }),
        expect.objectContaining({ source: "collection_case", sourceId: "case-overdue" })
      ])
    );
  });

  it("keeps partial payment and write-off evidence distinct without double counting exposure", async () => {
    const { snapshot } = await queryScenario(partialPaymentWriteOffScenario());

    expect(snapshot.risk.exposureDetail).toEqual(
      expect.objectContaining({
        overdueRemainingAmount: 400,
        partialPaymentCount: 1,
        unpaidAmount: 400
      })
    );
    expect(snapshot.risk.exposureDetail?.writeOffEvidence).toEqual([
      expect.objectContaining({ amount: 100, id: "writeoff-partial" })
    ]);
    expect(snapshot.risk.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WRITE_OFF_WITHOUT_CLEAR_BILL_LINKAGE"
        })
      ])
    );
    expect(snapshot.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "receivable_bill", sourceId: "bill-partial" }),
        expect.objectContaining({ source: "payment_record", sourceId: "payment-partial" }),
        expect.objectContaining({ source: "payment_write_off", sourceId: "writeoff-partial" })
      ])
    );
  });

  it("flags conflicting signals without resolving or mutating upstream PR outputs", async () => {
    const scenario = conflictingSignalsScenario();
    const before = JSON.stringify(scenario);
    const { facade, snapshot } = await queryScenario(scenario);

    expect(JSON.stringify(scenario)).toBe(before);
    expect(snapshot.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "STATE_AVAILABLE_WITH_LEASE_TIMELINE",
          severity: "HIGH"
        })
      ])
    );
    expect(snapshot.state.computedState).toBe(VehicleComputedOperationalState.AVAILABLE);
    expect(snapshot.timeline.events.some((event) => event.state === TimelineState.LEASED)).toBe(true);
    expect(snapshot.system.consistencyScore).toBeLessThan(100);
    expect("executeAction" in facade).toBe(false);
  });
});

async function queryScenario(scenario: ContractScenario) {
  const dependencies = createDependencies(scenario);
  const facade = new FleetOpsFacade(dependencies, () => generatedAt);
  const snapshot = await facade.query(scenario.vehicleId, { from, generatedAt, to });

  return { dependencies, facade, snapshot };
}

function createDependencies(scenario: ContractScenario) {
  return {
    kpiService: {
      getFleetKpis: vi.fn(async (): Promise<FleetKpiReport> => ({
        fleet: {
          cost: scenario.economics.economics.cost,
          downtimeCost: scenario.economics.downtime.downtimeCost,
          downtimeDays: scenario.economics.downtime.totalDowntimeDays,
          leasedDays: scenario.economics.utilization.leasedDays,
          netIncome: scenario.economics.economics.netIncome,
          operatingDays: scenario.economics.utilization.operatingDays,
          revenue: scenario.economics.economics.revenue,
          roe: scenario.economics.economics.roe,
          roi: scenario.economics.economics.roi,
          utilizationRate: scenario.economics.utilization.utilizationRate,
          vehicleCount: 1
        },
        vehicles: [scenario.economics]
      }))
    },
    riskService: {
      getFleetRisk: vi.fn(async (): Promise<FleetRiskReport> => ({
        fleet: {
          averageExposureScore: scenario.risk.exposureScore,
          averageRiskScore: scenario.risk.riskScore,
          blockedVehicles: scenario.risk.controlDecision === ControlDecision.BLOCK ? 1 : 0,
          vehicleCount: 1,
          warnedVehicles: scenario.risk.controlDecision === ControlDecision.WARN ? 1 : 0
        },
        vehicles: [scenario.risk]
      }))
    },
    stateService: {
      resolveVehicleOperationalState: vi.fn(async () => scenario.state)
    },
    timelineService: {
      getVehicleTimeline: vi.fn(async () => scenario.timeline)
    }
  };
}

function activeLeaseScenario(): ContractScenario {
  return {
    economics: economicsResult("vehicle-healthy", {
      evidence: [evidence("payment_record", "payment-rent", "confirmed rent payment contributes operating revenue", 1500)],
      leaseRevenue: 1500,
      revenue: 1500
    }),
    risk: riskResult("vehicle-healthy", { evidence: [], riskScore: 8 }),
    state: stateResult("vehicle-healthy", VehicleComputedOperationalState.LEASED_ACTIVE, "LEASE", "lease-healthy", 94),
    timeline: [
      timelineDay("2026-07-01", TimelineState.LEASED, ["lease:lease-healthy"], 90),
      timelineDay("2026-07-02", TimelineState.LEASED, ["lease:lease-healthy"], 90),
      timelineDay("2026-07-03", TimelineState.LEASED, ["lease:lease-healthy"], 90)
    ],
    vehicleId: "vehicle-healthy"
  };
}

function idleAvailableScenario(): ContractScenario {
  return {
    economics: economicsResult("vehicle-idle", {
      confidenceScore: 78,
      revenue: 0,
      warnings: ["NO_REALIZED_REVENUE"]
    }),
    risk: riskResult("vehicle-idle", { riskScore: 5 }),
    state: stateResult("vehicle-idle", VehicleComputedOperationalState.AVAILABLE, "VEHICLE", "vehicle-idle", 91),
    timeline: [
      timelineDay("2026-07-01", TimelineState.AVAILABLE, ["vehicle:vehicle-idle"], 88),
      timelineDay("2026-07-02", TimelineState.AVAILABLE, ["vehicle:vehicle-idle"], 88),
      timelineDay("2026-07-03", TimelineState.AVAILABLE, ["vehicle:vehicle-idle"], 88)
    ],
    vehicleId: "vehicle-idle"
  };
}

function currentStatusFallbackScenario(): ContractScenario {
  return {
    economics: economicsResult("vehicle-fallback", {
      confidenceBand: "MEDIUM",
      confidenceScore: 65,
      revenue: 0,
      warnings: [TIMELINE_CURRENT_STATUS_PROJECTED_WARNING, "TIMELINE_FALLBACK_CONFIDENCE_PENALTY"]
    }),
    risk: riskResult("vehicle-fallback", {
      confidence: 60,
      riskScore: 18,
      warnings: [
        {
          code: TIMELINE_CURRENT_STATUS_PROJECTED_WARNING,
          message: "Timeline fallback propagated into risk confidence."
        }
      ]
    }),
    state: stateResult("vehicle-fallback", VehicleComputedOperationalState.AVAILABLE, "VEHICLE", "vehicle-fallback", 85),
    timeline: [
      timelineDay("2026-07-01", TimelineState.AVAILABLE, ["vehicle:vehicle-fallback"], 55, [
        TIMELINE_CURRENT_STATUS_PROJECTED_WARNING
      ]),
      timelineDay("2026-07-02", TimelineState.AVAILABLE, ["vehicle:vehicle-fallback"], 55, [
        TIMELINE_CURRENT_STATUS_PROJECTED_WARNING
      ]),
      timelineDay("2026-07-03", TimelineState.AVAILABLE, ["vehicle:vehicle-fallback"], 55, [
        TIMELINE_CURRENT_STATUS_PROJECTED_WARNING
      ])
    ],
    vehicleId: "vehicle-fallback"
  };
}

function depositAndRentScenario(): ContractScenario {
  return {
    economics: economicsResult("vehicle-deposit", {
      actualDeposit: 500,
      actualOperating: 1200,
      depositExcludedRevenue: 500,
      evidence: [
        evidence("payment_record", "payment-rent", "confirmed rent payment contributes operating revenue", 1200),
        evidence("deposit_ledger", "deposit-ledger", "deposit ledger cashflow is separate from operating revenue", 500)
      ],
      leaseRevenue: 1200,
      plannedDeposit: 400,
      revenue: 1200,
      warnings: ["DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"]
    }),
    risk: riskResult("vehicle-deposit", { riskScore: 10 }),
    state: stateResult("vehicle-deposit", VehicleComputedOperationalState.LEASED_ACTIVE, "LEASE", "lease-deposit", 92),
    timeline: [timelineDay("2026-07-01", TimelineState.LEASED, ["lease:lease-deposit"], 88)],
    vehicleId: "vehicle-deposit"
  };
}

function overdueBillScenario(): ContractScenario {
  return {
    economics: economicsResult("vehicle-overdue", {
      actualOperating: 300,
      evidence: [evidence("payment_record", "payment-overdue", "partial confirmed payment reduced overdue exposure", 300)],
      leaseRevenue: 300,
      revenue: 300
    }),
    risk: riskResult("vehicle-overdue", {
      agingBucket: CollectionPriorityLevel.D2,
      arrearsPipeline: arrearsPipeline("vehicle-overdue", "bill-overdue", "case-overdue", 6, 700),
      collectionLevel: CollectionPriorityLevel.D2,
      confidence: 70,
      controlDecision: ControlDecision.WARN,
      exposureDetail: exposureDetail("bill-overdue", 6, 700, 300),
      exposureScore: 20,
      riskScore: 44,
      signals: [RiskSignalCode.OVERDUE_SIGNAL],
      warnings: [
        {
          code: "FACTUAL_OVERDUE_STATUS_NOT_REFRESHED",
          message: "Bill is factually overdue although status has not refreshed.",
          sourceId: "bill-overdue"
        }
      ]
    }),
    state: stateResult("vehicle-overdue", VehicleComputedOperationalState.LEASED_ACTIVE, "LEASE", "lease-overdue", 88),
    timeline: [timelineDay("2026-07-03", TimelineState.LEASED, ["lease:lease-overdue"], 80)],
    vehicleId: "vehicle-overdue"
  };
}

function partialPaymentWriteOffScenario(): ContractScenario {
  const exposure = exposureDetail("bill-partial", 10, 400, 600);
  exposure.partialPaymentEvidence = [riskEvidence("payment_record", "payment-partial", "partial payment reduced exposure", 600)];
  exposure.writeOffEvidence = [
    {
      amount: 100,
      billId: "bill-partial",
      id: "writeoff-partial",
      paymentId: "payment-partial",
      writeOffAt: to
    }
  ];
  exposure.warnings = [
    {
      code: "WRITE_OFF_WITHOUT_CLEAR_BILL_LINKAGE",
      message: "Write-off linkage requires review.",
      sourceId: "writeoff-partial"
    }
  ];

  return {
    economics: economicsResult("vehicle-partial", {
      actualOperating: 600,
      evidence: [
        evidence("payment_record", "payment-partial", "partial confirmed payment contributes actual cashflow", 600),
        evidence("payment_write_off", "writeoff-partial", "write-off allocation is evidence, not double-counted exposure", 100)
      ],
      leaseRevenue: 600,
      revenue: 600,
      writeOffOperating: 100,
      writeOffUnlinked: 50,
      warnings: ["WRITE_OFF_WITHOUT_CLEAR_BILL_LINKAGE"]
    }),
    risk: riskResult("vehicle-partial", {
      agingBucket: CollectionPriorityLevel.D3,
      arrearsPipeline: {
        ...arrearsPipeline("vehicle-partial", "bill-partial", "case-partial", 10, 400),
        paymentRefs: [{ paymentId: "payment-partial" }],
        warnings: exposure.warnings,
        writeOffRefs: exposure.writeOffEvidence
      },
      collectionLevel: CollectionPriorityLevel.D3,
      confidence: 65,
      exposureDetail: exposure,
      riskScore: 52,
      signals: [RiskSignalCode.OVERDUE_SIGNAL, RiskSignalCode.PAYMENT_INCONSISTENCY_SIGNAL],
      warnings: exposure.warnings
    }),
    state: stateResult("vehicle-partial", VehicleComputedOperationalState.LEASED_ACTIVE, "LEASE", "lease-partial", 86),
    timeline: [timelineDay("2026-07-03", TimelineState.LEASED, ["lease:lease-partial"], 78)],
    vehicleId: "vehicle-partial"
  };
}

function conflictingSignalsScenario(): ContractScenario {
  return {
    economics: economicsResult("vehicle-conflict", { revenue: 0, warnings: ["NO_REALIZED_REVENUE"] }),
    risk: riskResult("vehicle-conflict", { confidence: 70, riskScore: 30 }),
    state: stateResult("vehicle-conflict", VehicleComputedOperationalState.AVAILABLE, "VEHICLE", "vehicle-conflict", 88),
    timeline: [timelineDay("2026-07-03", TimelineState.LEASED, ["lease:lease-conflict", "vehicle:vehicle-conflict"], 75)],
    vehicleId: "vehicle-conflict"
  };
}

function stateResult(
  vehicleId: string,
  computedState: VehicleComputedOperationalState,
  source: VehicleOperationalStateResult["primaryEvidence"]["source"],
  sourceId: string,
  confidenceScore: number
): VehicleOperationalStateResult {
  return {
    asOf: to,
    computedState,
    confidenceBand: confidenceScore >= 80 ? VehicleOperationalConfidenceBand.HIGH : VehicleOperationalConfidenceBand.MEDIUM,
    confidenceScore,
    conflicts: [],
    primaryEvidence: {
      fields: { sourceState: computedState },
      reason: `${source} signal selected ${computedState}.`,
      recordedAt: to,
      source,
      sourceId
    },
    supportingEvidence: [],
    vehicleId,
    warnings: []
  };
}

function timelineDay(date: string, state: TimelineState, sourceEvents: string[], confidence: number, warnings: string[] = []): TimelineDay {
  return {
    confidence,
    conflicts: [],
    date,
    sourceEvents,
    state,
    warnings
  };
}

function economicsResult(
  vehicleId: string,
  options: {
    actualDeposit?: number;
    actualOperating?: number;
    confidenceBand?: "HIGH" | "MEDIUM" | "LOW";
    confidenceScore?: number;
    depositExcludedRevenue?: number;
    evidence?: FleetKpiVehicleResult["evidence"];
    leaseRevenue?: number;
    plannedDeposit?: number;
    revenue?: number;
    warnings?: FleetKpiWarning[];
    writeOffOperating?: number;
    writeOffUnlinked?: number;
  } = {}
): FleetKpiVehicleResult {
  const revenue = options.revenue ?? options.leaseRevenue ?? options.actualOperating ?? 0;
  const evidenceItems = options.evidence ?? [];

  return {
    attribution: {
      depositExcludedRevenue: options.depositExcludedRevenue ?? 0,
      ignoredRevenue: 0,
      leaseRevenue: options.leaseRevenue ?? revenue,
      penaltyRevenue: 0,
      recognizedPaymentCount: revenue > 0 ? 1 : 0,
      unassignedRevenue: 0,
      writeOffImpact: 0
    },
    cashflow: {
      actual: {
        deposit: options.actualDeposit ?? 0,
        operating: options.actualOperating ?? revenue,
        unassigned: 0
      },
      evidence: evidenceItems,
      planned: {
        deposit: options.plannedDeposit ?? 0,
        operating: revenue
      },
      warnings: options.warnings ?? [],
      writeOff: {
        appliedDeposit: 0,
        appliedOperating: options.writeOffOperating ?? 0,
        unlinked: options.writeOffUnlinked ?? 0
      }
    },
    confidence: {
      band: options.confidenceBand ?? "HIGH",
      reasons: [],
      score: options.confidenceScore ?? 90
    },
    denominatorEvidence: [evidence("denominator", vehicleId, "invested capital supplied by vehicle cost profile")],
    downtime: {
      breakdown: { IDLE: 0, MAINTENANCE: 0, RESERVED: 0, SERVICE: 0 },
      downtimeCost: 0,
      totalDowntimeDays: 0,
      trace: []
    },
    economics: {
      cost: revenue > 0 ? 250 : 0,
      netIncome: revenue > 0 ? revenue - 250 : 0,
      revenue,
      roe: revenue > 0 ? 0.12 : 0,
      roi: revenue > 0 ? 0.1 : 0
    },
    evidence: evidenceItems,
    reportParity: {
      depositIncludedInOperatingRevenue: false,
      operatingRevenueBillTypes: [BillType.MONTHLY_RENT, BillType.DAMAGE_FEE]
    },
    utilization: {
      leasedDays: revenue > 0 ? 3 : 0,
      operatingDays: 3,
      utilizationRate: revenue > 0 ? 1 : 0
    },
    vehicleId,
    warnings: options.warnings ?? []
  };
}

function riskResult(vehicleId: string, options: Partial<RiskOutput> = {}): RiskOutput {
  return {
    agingBucket: CollectionPriorityLevel.NONE,
    collectionLevel: CollectionPriorityLevel.D1,
    confidence: 90,
    controlDecision: ControlDecision.ALLOW,
    evidence: [],
    exposureDetail: exposureDetail("none", 0, 0, 0),
    exposureScore: 0,
    reasons: ["Low risk smoke fixture."],
    riskScore: 0,
    signals: [],
    vehicleId,
    warnings: [],
    ...options
  };
}

function exposureDetail(billId: string, overdueDays: number, remainingAmount: number, paidAmount: number): RiskExposure {
  return {
    evidence: remainingAmount > 0 ? [riskEvidence("receivable_bill", billId, "remaining amount drives overdue exposure", remainingAmount)] : [],
    maxOverdueDays: overdueDays,
    overdueAmount: remainingAmount,
    overdueBillCount: remainingAmount > 0 ? 1 : 0,
    overdueBillRefs:
      remainingAmount > 0
        ? [
            {
              billId,
              dueDate: new Date("2026-06-27T00:00:00.000Z"),
              overdueDays,
              paidAmount,
              remainingAmount,
              sourceStatus: BillStatus.PENDING
            }
          ]
        : [],
    overdueRemainingAmount: remainingAmount,
    partialPaymentCount: paidAmount > 0 ? 1 : 0,
    partialPaymentEvidence: paidAmount > 0 ? [riskEvidence("payment_record", "payment-partial", "partial payment reduced exposure", paidAmount)] : [],
    score: remainingAmount > 0 ? 18 : 0,
    unpaidAmount: remainingAmount,
    warnings: [],
    writeOffEvidence: []
  };
}

function arrearsPipeline(
  vehicleId: string,
  billId: string,
  caseId: string,
  overdueDays: number,
  remainingAmount: number
): NonNullable<RiskOutput["arrearsPipeline"]> {
  return {
    actionRefs: [
      {
        actionId: "action-overdue",
        actionType: CollectionActionType.PROMISE_TO_PAY,
        result: CollectionActionResult.CUSTOMER_PROMISED
      }
    ],
    billRefs: [
      {
        billId,
        dueDate: new Date("2026-06-27T00:00:00.000Z"),
        overdueDays,
        paidAmount: 0,
        remainingAmount,
        sourceStatus: BillStatus.PENDING
      }
    ],
    caseRefs: [
      {
        caseId,
        caseStatus: CollectionCaseStatus.ACTIVE,
        collectionLevel: CollectionPriorityLevel.D2
      }
    ],
    evidence: [
      riskEvidence("collection_case", caseId, "collection case supports bill-level overdue truth"),
      riskEvidence("collection_action", "action-overdue", "collection action records promise to pay")
    ],
    paymentRefs: [],
    promiseToPayRefs: [
      {
        actionId: "action-overdue",
        promisedAmount: remainingAmount,
        promisedPayAt: new Date("2026-07-05T00:00:00.000Z")
      }
    ],
    stage: "OVERDUE_WITH_ACTIVE_CASE",
    vehicleId,
    warnings: [],
    writeOffRefs: []
  };
}

function evidence(source: NonNullable<FleetKpiVehicleResult["evidence"]>[number]["source"], sourceId: string, reason: string, amount?: number) {
  return { amount, reason, source, sourceId };
}

function riskEvidence(source: NonNullable<RiskOutput["evidence"]>[number]["source"], sourceId: string, reason: string, amount?: number) {
  return { amount, reason, source, sourceId };
}
