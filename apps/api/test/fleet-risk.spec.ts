import {
  BillStatus,
  BillType,
  LeaseStatus,
  OrderStatus,
  PaymentStatus,
  ServiceCasePriority,
  ServiceCaseStatus,
  ServiceCaseType,
  VehicleConditionItemResult,
  VehicleConditionItemSeverity,
  VehicleConditionReportStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { FleetKpiService } from "../src/fleet-ops/economics/fleet-kpi.service";
import { EconomicTimelineState, type FleetKpiReport } from "../src/fleet-ops/economics/economics.types";
import { FleetRiskCalculator } from "../src/fleet-ops/risk/fleet-risk.calculator";
import { FleetRiskService } from "../src/fleet-ops/risk/fleet-risk.service";
import { ControlGuardEngine } from "../src/fleet-ops/risk/control-guard.engine";
import {
  CollectionPriorityLevel,
  ControlDecision,
  RiskSignalCode,
  type FleetRiskInput
} from "../src/fleet-ops/risk/risk.types";
import { TIMELINE_CURRENT_STATUS_PROJECTED_WARNING } from "../src/fleet-ops/timeline/vehicle-timeline.types";
import { VehicleTimelineService } from "../src/fleet-ops/timeline/vehicle-timeline.service";
import { VehicleComputedOperationalState } from "../src/fleet-ops/vehicle-operational-state.types";
import { VehicleOperationalStateService } from "../src/fleet-ops/vehicle-operational-state.service";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-07-05T00:00:00.000Z");

describe("FleetRiskCalculator", () => {
  it("computes weighted D5 BLOCK risk from overdue exposure, severe service, and asset collapse signals", () => {
    const report = new FleetRiskCalculator().calculate(highRiskInput());
    const vehicle = report.vehicles.find((row) => row.vehicleId === "vehicle-1")!;

    expect(vehicle).toEqual(
      expect.objectContaining({
        collectionLevel: CollectionPriorityLevel.D5,
        confidence: 35,
        controlDecision: ControlDecision.BLOCK,
        exposureScore: 100,
        riskScore: 99,
        vehicleId: "vehicle-1"
      })
    );
    expect(vehicle.signals).toEqual(
      expect.arrayContaining([
        RiskSignalCode.OVERDUE_SIGNAL,
        RiskSignalCode.TIMELINE_CONFLICT_SIGNAL,
        RiskSignalCode.ROI_COLLAPSE_SIGNAL,
        RiskSignalCode.UTILIZATION_DROP_SIGNAL,
        RiskSignalCode.CONDITION_DEGRADATION_SIGNAL,
        RiskSignalCode.PAYMENT_INCONSISTENCY_SIGNAL
      ])
    );
    expect(vehicle.reasons).toEqual(
      expect.arrayContaining([
        "High overdue exposure requires intervention.",
        "Active lease has severe service or condition risk.",
        "Critical condition report is paired with unresolved service case."
      ])
    );
  });

  it("keeps stable, low-exposure vehicles at D1 ALLOW and produces deterministic output", () => {
    const first = new FleetRiskCalculator().calculate(healthyRiskInput());
    const second = new FleetRiskCalculator().calculate(healthyRiskInput());
    const vehicle = first.vehicles[0]!;

    expect(first).toEqual(second);
    expect(vehicle.collectionLevel).toBe(CollectionPriorityLevel.NONE);
    expect(vehicle.agingBucket).toBe(CollectionPriorityLevel.NONE);
    expect(vehicle.controlDecision).toBe(ControlDecision.ALLOW);
    expect(vehicle.riskScore).toBeLessThan(25);
    expect(vehicle.exposureScore).toBe(0);
    expect(vehicle.confidence).toBe(90);
  });

  it("provides allocation, lease activation, and order guard decisions from risk snapshots", () => {
    const report = new FleetRiskCalculator().calculate(highRiskInput());
    const guard = new ControlGuardEngine(report.vehicles, {
      leases: [{ leaseId: "lease-1", vehicleId: "vehicle-1" }],
      orders: [{ orderId: "order-1", vehicleId: "vehicle-1" }]
    });

    expect(guard.canAllocateVehicle("vehicle-1")).toEqual(
      expect.objectContaining({
        allowed: false,
        riskSnapshot: report.vehicles[0]
      })
    );
    expect(guard.canActivateLease("lease-1").allowed).toBe(false);
    expect(guard.canProceedWithOrder("order-1").allowed).toBe(false);
  });

  it("propagates PR-2 timeline and PR-3 economics warnings into risk output", () => {
    const input = healthyRiskInput();
    input.timelines["vehicle-2"] = [day("2026-07-01", EconomicTimelineState.LEASED, ["vehicle-status-fallback"], 0, [TIMELINE_CURRENT_STATUS_PROJECTED_WARNING])];
    input.fleetKpis.vehicles[0] = {
      ...input.fleetKpis.vehicles[0]!,
      warnings: ["UNASSIGNED_PAYMENT_EXCLUDED"]
    };

    const vehicle = new FleetRiskCalculator().calculate(input).vehicles[0]!;

    expect(vehicle.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: TIMELINE_CURRENT_STATUS_PROJECTED_WARNING }),
        expect.objectContaining({ code: "UNASSIGNED_PAYMENT_EXCLUDED" })
      ])
    );
    expect(vehicle.signals).toEqual(expect.arrayContaining([RiskSignalCode.ECONOMIC_WARNING_SIGNAL, RiskSignalCode.TIMELINE_CONFLICT_SIGNAL]));
    expect(vehicle.confidence).toBeLessThan(90);
  });
});

describe("FleetRiskService", () => {
  it("orchestrates PR outputs and core sources read-only without write operations", async () => {
    const prisma = createPrismaHarness();
    const operationalStateService = {
      resolveVehicleOperationalState: vi.fn(async () => operationalState())
    };
    const timelineService = {
      getVehicleTimeline: vi.fn(async () => timelineDays())
    };
    const kpiService = {
      getFleetKpis: vi.fn(async () => kpiReport())
    };
    const service = new FleetRiskService(
      prisma as never,
      operationalStateService as unknown as VehicleOperationalStateService,
      timelineService as unknown as VehicleTimelineService,
      kpiService as unknown as FleetKpiService
    );

    const report = await service.getFleetRisk(["vehicle-1"], from, to);

    expect(report.vehicles).toHaveLength(1);
    expect(operationalStateService.resolveVehicleOperationalState).toHaveBeenCalledWith("vehicle-1", to);
    expect(timelineService.getVehicleTimeline).toHaveBeenCalledWith("vehicle-1", from, to);
    expect(kpiService.getFleetKpis).toHaveBeenCalledWith(["vehicle-1"], from, to);
    expect(prisma.receivableBill.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.paymentRecord.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.collectionCase.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.lease.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.subscriptionOrder.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.serviceCase.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.vehicleConditionReport.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.receivableBill.update).not.toHaveBeenCalled();
    expect(prisma.paymentRecord.create).not.toHaveBeenCalled();
    expect(prisma.lease.update).not.toHaveBeenCalled();
  });
});

function highRiskInput(): FleetRiskInput {
  return {
    asOf: to,
    conditionReports: [criticalConditionReport()],
    fleetKpis: kpiReport(),
    leases: [{ id: "lease-1", status: LeaseStatus.ACTIVE, vehicleId: "vehicle-1" }],
    operationalStates: [operationalState()],
    orders: [{ id: "order-1", orderStatus: OrderStatus.ACTIVE, vehicleId: "vehicle-1" }],
    paymentRecords: [
      paymentRecord({ amount: 400, id: "payment-1" }),
      paymentRecord({ amount: 100, id: "payment-2" })
    ],
    receivableBills: [
      receivableBill({ dueDate: new Date("2026-06-01T00:00:00.000Z"), id: "bill-overdue", remainingAmount: 10000 }),
      receivableBill({
        billStatus: BillStatus.PARTIALLY_PAID,
        dueDate: new Date("2026-06-25T00:00:00.000Z"),
        id: "bill-partial",
        remainingAmount: 2000
      })
    ],
    serviceCases: [urgentServiceCase()],
    timelines: { "vehicle-1": timelineDays() },
    vehicleIds: ["vehicle-1"]
  };
}

function healthyRiskInput(): FleetRiskInput {
  return {
    asOf: to,
    conditionReports: [],
    fleetKpis: healthyKpiReport(),
    leases: [{ id: "lease-2", status: LeaseStatus.ACTIVE, vehicleId: "vehicle-2" }],
    operationalStates: [
      {
        computedState: VehicleComputedOperationalState.LEASED_ACTIVE,
        confidenceScore: 95,
        vehicleId: "vehicle-2"
      }
    ],
    orders: [{ id: "order-2", orderStatus: OrderStatus.ACTIVE, vehicleId: "vehicle-2" }],
    paymentRecords: [paymentRecord({ amount: 1200, id: "payment-healthy", vehicleId: "vehicle-2" })],
    receivableBills: [],
    serviceCases: [],
    timelines: {
      "vehicle-2": [
        day("2026-07-01", EconomicTimelineState.LEASED),
        day("2026-07-02", EconomicTimelineState.LEASED),
        day("2026-07-03", EconomicTimelineState.LEASED),
        day("2026-07-04", EconomicTimelineState.LEASED),
        day("2026-07-05", EconomicTimelineState.LEASED)
      ]
    },
    vehicleIds: ["vehicle-2"]
  };
}

function operationalState() {
  return {
    computedState: VehicleComputedOperationalState.LEASED_ACTIVE,
    confidenceScore: 82,
    vehicleId: "vehicle-1"
  };
}

function timelineDays() {
  return [
    day("2026-07-01", EconomicTimelineState.LEASED),
    day("2026-07-02", EconomicTimelineState.SERVICE_BLOCKED, ["service-case-1"], 1),
    day("2026-07-03", EconomicTimelineState.RESERVED, ["order-1"], 1),
    day("2026-07-04", EconomicTimelineState.AVAILABLE),
    day("2026-07-05", EconomicTimelineState.SERVICE_BLOCKED, ["service-case-1"], 1)
  ];
}

function day(date: string, state: EconomicTimelineState, sourceEvents: string[] = [], conflictCount = 0, warnings: string[] = []) {
  return {
    confidence: conflictCount > 0 ? 55 : 90,
    conflicts: Array.from({ length: conflictCount }, (_, index) => ({ id: `conflict-${date}-${index}` })),
    date,
    sourceEvents,
    state,
    warnings
  };
}

function kpiReport(): FleetKpiReport {
  return {
    fleet: {
      cost: 1500,
      downtimeCost: 800,
      downtimeDays: 4,
      leasedDays: 1,
      netIncome: -2500,
      operatingDays: 5,
      revenue: 1000,
      roe: -0.31,
      roi: -0.25,
      utilizationRate: 0.1,
      vehicleCount: 1
    },
    vehicles: [
      {
        attribution: {
          leaseRevenue: 1000,
          penaltyRevenue: 0,
          writeOffImpact: -300
        },
        confidence: {
          band: "MEDIUM",
          score: 65
        },
        downtime: {
          breakdown: {
            IDLE: 1,
            MAINTENANCE: 0,
            RESERVED: 1,
            SERVICE: 2
          },
          downtimeCost: 800,
          totalDowntimeDays: 4
        },
        economics: {
          cost: 1500,
          netIncome: -2500,
          revenue: 1000,
          roe: -0.31,
          roi: -0.25
        },
        utilization: {
          leasedDays: 1,
          operatingDays: 5,
          utilizationRate: 0.1
        },
        vehicleId: "vehicle-1"
      }
    ]
  };
}

function healthyKpiReport(): FleetKpiReport {
  return {
    fleet: {
      cost: 300,
      downtimeCost: 0,
      downtimeDays: 0,
      leasedDays: 5,
      netIncome: 900,
      operatingDays: 5,
      revenue: 1200,
      roe: 0.09,
      roi: 0.08,
      utilizationRate: 1,
      vehicleCount: 1
    },
    vehicles: [
      {
        attribution: {
          leaseRevenue: 1200,
          penaltyRevenue: 0,
          writeOffImpact: 0
        },
        confidence: {
          band: "HIGH",
          score: 92
        },
        downtime: {
          breakdown: {
            IDLE: 0,
            MAINTENANCE: 0,
            RESERVED: 0,
            SERVICE: 0
          },
          downtimeCost: 0,
          totalDowntimeDays: 0
        },
        economics: {
          cost: 300,
          netIncome: 900,
          revenue: 1200,
          roe: 0.09,
          roi: 0.08
        },
        utilization: {
          leasedDays: 5,
          operatingDays: 5,
          utilizationRate: 1
        },
        vehicleId: "vehicle-2"
      }
    ]
  };
}

function receivableBill(overrides: Partial<FleetRiskInput["receivableBills"][number]> = {}) {
  return {
    amount: 10000,
    billStatus: BillStatus.OVERDUE,
    billType: BillType.MONTHLY_RENT,
    dueDate: new Date("2026-06-01T00:00:00.000Z"),
    id: "bill-1",
    paidAmount: 0,
    remainingAmount: 10000,
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function paymentRecord(overrides: Partial<FleetRiskInput["paymentRecords"][number]> = {}) {
  return {
    amount: 400,
    id: "payment-1",
    paymentStatus: PaymentStatus.CONFIRMED,
    receivedAt: new Date("2026-07-01T00:00:00.000Z"),
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function urgentServiceCase() {
  return {
    caseStatus: ServiceCaseStatus.IN_PROGRESS,
    caseType: ServiceCaseType.RESCUE_REQUEST,
    closedAt: null,
    id: "service-case-1",
    priority: ServiceCasePriority.URGENT,
    resolvedAt: null,
    vehicleId: "vehicle-1"
  };
}

function criticalConditionReport() {
  return {
    id: "condition-report-1",
    items: [
      {
        affectsSafety: true,
        id: "condition-item-1",
        repairRequired: true,
        result: VehicleConditionItemResult.ABNORMAL,
        severity: VehicleConditionItemSeverity.SAFETY_CRITICAL
      }
    ],
    publishedAt: new Date("2026-07-03T00:00:00.000Z"),
    reportStatus: VehicleConditionReportStatus.PUBLISHED,
    vehicleId: "vehicle-1"
  };
}

function createPrismaHarness() {
  return {
    lease: {
      findMany: vi.fn(async () => [{ id: "lease-1", order: { vehicleId: "vehicle-1" }, status: LeaseStatus.ACTIVE }]),
      update: vi.fn()
    },
    paymentRecord: {
      create: vi.fn(),
      findMany: vi.fn(async () => [
        {
          id: "payment-1",
          order: { vehicleId: "vehicle-1" },
          paymentAmount: 400n,
          paymentStatus: PaymentStatus.CONFIRMED,
          receivedAt: new Date("2026-07-01T00:00:00.000Z")
        }
      ])
    },
    receivableBill: {
      findMany: vi.fn(async () => [
        {
          amount: 10000n,
          billStatus: BillStatus.OVERDUE,
          billType: BillType.MONTHLY_RENT,
          dueDate: new Date("2026-06-01T00:00:00.000Z"),
          id: "bill-1",
          order: { vehicleId: "vehicle-1" },
          paidAmount: 0n,
          remainingAmount: 10000n,
          writeOffs: []
        }
      ]),
      update: vi.fn()
    },
    collectionCase: {
      findMany: vi.fn(async () => [])
    },
    serviceCase: {
      findMany: vi.fn(async () => [urgentServiceCase()])
    },
    subscriptionOrder: {
      findMany: vi.fn(async () => [{ id: "order-1", orderStatus: OrderStatus.ACTIVE, vehicleId: "vehicle-1" }])
    },
    vehicleConditionReport: {
      findMany: vi.fn(async () => [criticalConditionReport()])
    }
  };
}
