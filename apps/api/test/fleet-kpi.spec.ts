import { BillType, PaymentStatus, ServiceCasePriority, ServiceCaseType, VehicleDepreciationRecordStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { FleetKpiCalculator } from "../src/fleet-ops/economics/fleet-kpi.calculator";
import { FleetKpiService } from "../src/fleet-ops/economics/fleet-kpi.service";
import {
  EconomicTimelineState,
  type FleetEconomicInput,
  type FleetKpiVehicleInput
} from "../src/fleet-ops/economics/economics.types";
import { TIMELINE_CURRENT_STATUS_PROJECTED_WARNING } from "../src/fleet-ops/timeline/vehicle-timeline.types";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-07-05T00:00:00.000Z");

describe("FleetKpiCalculator", () => {
  it("computes per-vehicle economic KPIs from realized revenue, costs, downtime, ROI, and ROE", () => {
    const report = new FleetKpiCalculator().calculate(fleetInput());
    const vehicle = report.vehicles.find((row) => row.vehicleId === "vehicle-1")!;

    expect(vehicle.utilization).toMatchObject({
      leasedDays: 2,
      operatingDays: 5,
      utilizationRate: 0.4
    });
    expect(vehicle.attribution).toMatchObject({
      leaseRevenue: 1000,
      penaltyRevenue: 150,
      writeOffImpact: -100
    });
    expect(vehicle.economics.revenue).toBe(1150);
    expect(vehicle.downtime.breakdown).toEqual({
      IDLE: 1,
      MAINTENANCE: 0,
      RESERVED: 1,
      SERVICE: 1
    });
    expect(vehicle.downtime.totalDowntimeDays).toBe(3);
    expect(vehicle.downtime.downtimeCost).toBeGreaterThan(0);
    expect(vehicle.economics.cost).toBeGreaterThan(200);
    expect(vehicle.economics.netIncome).toBe(vehicle.economics.revenue + vehicle.attribution.writeOffImpact - vehicle.economics.cost);
    expect(vehicle.economics.roi).toBeCloseTo(vehicle.economics.netIncome / 10000, 6);
    expect(vehicle.economics.roe).toBeCloseTo(vehicle.economics.netIncome / 8000, 6);
    expect(vehicle.confidence.band).toBe("HIGH");
  });

  it("aggregates fleet-level metrics deterministically across vehicles", () => {
    const first = new FleetKpiCalculator().calculate(fleetInput());
    const second = new FleetKpiCalculator().calculate(fleetInput());

    expect(first).toEqual(second);
    expect(first.fleet.vehicleCount).toBe(2);
    expect(first.fleet.revenue).toBe(1150);
    expect(first.fleet.downtimeDays).toBeGreaterThan(3);
    expect(first.fleet.roi).toBeCloseTo(first.fleet.netIncome / 15000, 6);
    expect(first.fleet.roe).toBeCloseTo(first.fleet.netIncome / 13000, 6);
  });

  it("does not count deposits, cancelled payments, or payments without vehicle attribution as revenue", () => {
    const report = new FleetKpiCalculator().calculate({
      ...fleetInput(),
      paymentRecords: [
        payment({ amount: 500, billType: BillType.DEPOSIT }),
        payment({ amount: 600, id: "payment-pending", paymentStatus: PaymentStatus.PENDING_CONFIRM }),
        payment({ amount: 700, paymentStatus: PaymentStatus.CANCELLED }),
        payment({ amount: 900, id: "payment-unassigned", vehicleId: null })
      ]
    });
    const vehicle = report.vehicles.find((row) => row.vehicleId === "vehicle-1")!;

    expect(vehicle.economics.revenue).toBe(0);
    expect(vehicle.attribution.leaseRevenue).toBe(0);
    expect(vehicle.attribution).toMatchObject({
      depositExcludedRevenue: 500,
      unassignedRevenue: 900
    });
    expect(vehicle.warnings).toEqual(
      expect.arrayContaining([
        "DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE",
        "NON_CONFIRMED_PAYMENT_EXCLUDED",
        "UNASSIGNED_PAYMENT_EXCLUDED"
      ])
    );
    expect(vehicle.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "payment_record", sourceId: "payment-1" }),
        expect.objectContaining({ source: "payment_record", sourceId: "payment-unassigned" })
      ])
    );
    expect(vehicle.confidence.band).toBe("LOW");
  });

  it("aggregates ROI and ROE from fleet totals rather than averaging vehicle ratios", () => {
    const report = new FleetKpiCalculator().calculate({
      ...fleetInput(),
      depreciationRecords: [],
      paymentRecords: [
        payment({ amount: 1000, id: "payment-small", vehicleId: "vehicle-1" }),
        payment({ amount: 10000, id: "payment-large", vehicleId: "vehicle-2" })
      ],
      timelines: {
        "vehicle-1": [day("2026-07-01", EconomicTimelineState.LEASED)],
        "vehicle-2": [day("2026-07-01", EconomicTimelineState.LEASED)]
      },
      vehicles: [
        vehicleInput({ equityBase: 1000, investedCapital: 1000, vehicleId: "vehicle-1" }),
        vehicleInput({ equityBase: 100000, investedCapital: 100000, vehicleId: "vehicle-2" })
      ],
      writeOffAdjustments: []
    });

    const simpleAverageRoi =
      report.vehicles.reduce((total, vehicle) => total + vehicle.economics.roi, 0) / report.vehicles.length;
    const simpleAverageRoe =
      report.vehicles.reduce((total, vehicle) => total + vehicle.economics.roe, 0) / report.vehicles.length;

    expect(report.fleet.roi).toBeCloseTo(report.fleet.netIncome / 101000, 6);
    expect(report.fleet.roe).toBeCloseTo(report.fleet.netIncome / 101000, 6);
    expect(report.fleet.roi).not.toBeCloseTo(simpleAverageRoi, 6);
    expect(report.fleet.roe).not.toBeCloseTo(simpleAverageRoe, 6);
    expect(report.fleet.denominatorEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "denominator", reason: expect.stringContaining("total invested capital") }),
        expect.objectContaining({ source: "denominator", reason: expect.stringContaining("total equity base") })
      ])
    );
  });

  it("propagates projected timeline fallback warnings into economics confidence", () => {
    const fallbackInput = {
      ...fleetInput(),
      timelines: {
        "vehicle-1": [
          day("2026-07-01", EconomicTimelineState.LEASED, {
            confidence: 45,
            sourceEvents: ["vehicle:vehicle-1"],
            warnings: [TIMELINE_CURRENT_STATUS_PROJECTED_WARNING]
          })
        ],
        "vehicle-2": []
      }
    };
    const cleanInput = {
      ...fallbackInput,
      timelines: {
        "vehicle-1": [day("2026-07-01", EconomicTimelineState.LEASED)],
        "vehicle-2": []
      }
    };

    const fallbackVehicle = new FleetKpiCalculator().calculate(fallbackInput).vehicles[0]!;
    const cleanVehicle = new FleetKpiCalculator().calculate(cleanInput).vehicles[0]!;

    expect(fallbackVehicle.warnings).toEqual(expect.arrayContaining([TIMELINE_CURRENT_STATUS_PROJECTED_WARNING]));
    expect(fallbackVehicle.confidence.score).toBeLessThan(cleanVehicle.confidence.score);
  });
});

describe("FleetKpiService", () => {
  it("orchestrates PR-1 and PR-2 outputs with existing sources without write operations", async () => {
    const prisma = createPrismaHarness();
    const operationalStateService = {
      resolveVehicleOperationalState: vi.fn(async () => ({
        confidenceScore: 90,
        vehicleId: "vehicle-1"
      }))
    };
    const timelineService = {
      getVehicleTimeline: vi.fn(async () => timelineDays())
    };
    const service = new FleetKpiService(prisma as never, operationalStateService as never, timelineService as never);

    const report = await service.getFleetKpis(["vehicle-1"], from, to);

    expect(report.vehicles).toHaveLength(1);
    expect(report.vehicles[0]!.vehicleId).toBe("vehicle-1");
    expect(operationalStateService.resolveVehicleOperationalState).toHaveBeenCalledWith("vehicle-1", to);
    expect(timelineService.getVehicleTimeline).toHaveBeenCalledWith("vehicle-1", from, to);
    expect(prisma.paymentRecord.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.receivableBill.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.depositLedger.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.vehicleDepreciationRecord.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.serviceCase.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
    expect(prisma.paymentRecord.create).not.toHaveBeenCalled();
  });
});

function fleetInput(): FleetEconomicInput {
  return {
    from,
    operationalStates: [
      { confidenceScore: 90, vehicleId: "vehicle-1" },
      { confidenceScore: 45, vehicleId: "vehicle-2" }
    ],
    paymentRecords: [
      payment({ amount: 1000, billType: BillType.MONTHLY_RENT }),
      payment({ amount: 300, billType: BillType.DEPOSIT, id: "payment-deposit" }),
      payment({ amount: 150, billType: BillType.DAMAGE_FEE, id: "payment-penalty" }),
      payment({ amount: 999, id: "payment-cancelled", paymentStatus: PaymentStatus.CANCELLED }),
      payment({ amount: 888, id: "payment-unassigned", vehicleId: null })
    ],
    serviceCases: [
      {
        caseType: ServiceCaseType.RESCUE_REQUEST,
        id: "service-case-1",
        priority: ServiceCasePriority.HIGH,
        vehicleId: "vehicle-1"
      }
    ],
    timelines: {
      "vehicle-1": timelineDays(),
      "vehicle-2": availableTimelineDays()
    },
    to,
    vehicles: [
      vehicleInput({ equityBase: 8000, investedCapital: 10000, vehicleId: "vehicle-1" }),
      vehicleInput({ equityBase: 5000, investedCapital: 5000, vehicleId: "vehicle-2" })
    ],
    depreciationRecords: [
      {
        amount: 200,
        recordStatus: VehicleDepreciationRecordStatus.CONFIRMED,
        vehicleId: "vehicle-1"
      }
    ],
    writeOffAdjustments: [
      {
        amount: 100,
        vehicleId: "vehicle-1"
      }
    ]
  };
}

function vehicleInput(overrides: Partial<FleetKpiVehicleInput> = {}): FleetKpiVehicleInput {
  return {
    equityBase: 8000,
    investedCapital: 10000,
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function payment(overrides: Partial<FleetEconomicInput["paymentRecords"][number]> = {}) {
  return {
    amount: 1000,
    billType: BillType.MONTHLY_RENT,
    id: "payment-1",
    paymentStatus: PaymentStatus.CONFIRMED,
    receivedAt: new Date("2026-07-02T12:00:00.000Z"),
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function timelineDays() {
  return [
    day("2026-07-01", EconomicTimelineState.LEASED),
    day("2026-07-02", EconomicTimelineState.SERVICE_BLOCKED),
    day("2026-07-03", EconomicTimelineState.LEASED),
    day("2026-07-04", EconomicTimelineState.RESERVED),
    day("2026-07-05", EconomicTimelineState.AVAILABLE)
  ];
}

function availableTimelineDays() {
  return [
    day("2026-07-01", EconomicTimelineState.AVAILABLE),
    day("2026-07-02", EconomicTimelineState.AVAILABLE),
    day("2026-07-03", EconomicTimelineState.AVAILABLE),
    day("2026-07-04", EconomicTimelineState.AVAILABLE),
    day("2026-07-05", EconomicTimelineState.AVAILABLE)
  ];
}

function day(
  date: string,
  state: EconomicTimelineState,
  overrides: Partial<FleetEconomicInput["timelines"][string][number]> = {}
) {
  return { confidence: 90, date, sourceEvents: [], state, ...overrides };
}

function createPrismaHarness() {
  return {
    paymentRecord: {
      create: vi.fn(),
      findMany: vi.fn(async () => [
        {
          id: "payment-1",
          paymentAmount: 1000n,
          paymentStatus: PaymentStatus.CONFIRMED,
          receivedAt: new Date("2026-07-02T12:00:00.000Z"),
          order: { vehicleId: "vehicle-1" },
          writeOffs: [
            {
              bill: { billType: BillType.MONTHLY_RENT },
              writeOffAmount: 1000n
            }
          ]
        }
      ])
    },
    serviceCase: {
      findMany: vi.fn(async () => [
        {
          caseType: ServiceCaseType.RESCUE_REQUEST,
          id: "service-case-1",
          priority: ServiceCasePriority.HIGH,
          vehicleId: "vehicle-1"
        }
      ])
    },
    receivableBill: {
      findMany: vi.fn(async () => [])
    },
    depositLedger: {
      findMany: vi.fn(async () => [])
    },
    vehicle: {
      findMany: vi.fn(async () => [
        {
          id: "vehicle-1",
          purchasePriceAmount: 10000n
        }
      ]),
      update: vi.fn()
    },
    vehicleDepreciationRecord: {
      findMany: vi.fn(async () => [
        {
          depreciationAmount: 200n,
          recordStatus: VehicleDepreciationRecordStatus.CONFIRMED,
          vehicleId: "vehicle-1"
        }
      ])
    }
  };
}
