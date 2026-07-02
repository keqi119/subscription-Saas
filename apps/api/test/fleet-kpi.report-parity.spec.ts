import { BillType, PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { FleetKpiCalculator } from "../src/fleet-ops/economics/fleet-kpi.calculator";
import { EconomicTimelineState, type FleetEconomicInput } from "../src/fleet-ops/economics/economics.types";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-07-31T23:59:59.999Z");

describe("Fleet KPI ReportService semantic parity", () => {
  it("matches ReportService operating revenue categories without including deposits", () => {
    const report = new FleetKpiCalculator().calculate(inputWithPayments());
    const vehicle = report.vehicles[0]!;

    expect(vehicle.attribution).toMatchObject({
      depositExcludedRevenue: 500,
      leaseRevenue: 1100,
      penaltyRevenue: 350,
      writeOffImpact: 0
    });
    expect(vehicle.economics.revenue).toBe(1450);
    expect(vehicle.cashflow?.actual).toMatchObject({
      deposit: 500,
      operating: 1450
    });
    expect(vehicle.reportParity).toMatchObject({
      depositIncludedInOperatingRevenue: false,
      operatingRevenueBillTypes: [
        BillType.FIRST_MONTHLY_FEE,
        BillType.MONTHLY_RENT,
        BillType.DAMAGE_FEE,
        BillType.OTHER
      ]
    });
  });

  it("documents return denominator semantics and avoids simple-average fleet ROI/ROE", () => {
    const report = new FleetKpiCalculator().calculate({
      ...inputWithPayments(),
      paymentRecords: [
        payment({ amount: 1000, id: "payment-small", vehicleId: "vehicle-1" }),
        payment({ amount: 10000, id: "payment-large", vehicleId: "vehicle-2" })
      ],
      timelines: {
        "vehicle-1": [day("2026-07-01")],
        "vehicle-2": [day("2026-07-01")]
      },
      vehicles: [
        { equityBase: 1000, investedCapital: 1000, vehicleId: "vehicle-1" },
        { equityBase: 100000, investedCapital: 100000, vehicleId: "vehicle-2" }
      ]
    });
    const averageVehicleRoi =
      report.vehicles.reduce((total, vehicle) => total + vehicle.economics.roi, 0) / report.vehicles.length;
    const averageVehicleRoe =
      report.vehicles.reduce((total, vehicle) => total + vehicle.economics.roe, 0) / report.vehicles.length;

    expect(report.fleet.roi).toBeCloseTo(report.fleet.netIncome / 101000, 6);
    expect(report.fleet.roe).toBeCloseTo(report.fleet.netIncome / 101000, 6);
    expect(report.fleet.roi).not.toBeCloseTo(averageVehicleRoi, 6);
    expect(report.fleet.roe).not.toBeCloseTo(averageVehicleRoe, 6);
    expect(report.fleet.denominatorEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "fleet ROI = total net income / total invested capital" }),
        expect.objectContaining({ reason: "fleet ROE = total platform net income / total equity base" })
      ])
    );
  });
});

function inputWithPayments(): FleetEconomicInput {
  return {
    depreciationRecords: [],
    from,
    operationalStates: [{ confidenceScore: 95, vehicleId: "vehicle-1" }],
    paymentRecords: [
      payment({ amount: 600, billType: BillType.FIRST_MONTHLY_FEE, id: "payment-first-month" }),
      payment({ amount: 500, billType: BillType.MONTHLY_RENT, id: "payment-monthly" }),
      payment({ amount: 300, billType: BillType.DAMAGE_FEE, id: "payment-damage" }),
      payment({ amount: 50, billType: BillType.OTHER, id: "payment-other" }),
      payment({ amount: 500, billType: BillType.DEPOSIT, id: "payment-deposit" })
    ],
    serviceCases: [],
    timelines: {
      "vehicle-1": [day("2026-07-01")]
    },
    to,
    vehicles: [{ equityBase: 8000, investedCapital: 10000, vehicleId: "vehicle-1" }],
    writeOffAdjustments: []
  };
}

function payment(overrides: Partial<FleetEconomicInput["paymentRecords"][number]> = {}) {
  return {
    amount: 1000,
    billType: BillType.MONTHLY_RENT,
    id: "payment-1",
    paymentStatus: PaymentStatus.CONFIRMED,
    receivedAt: new Date("2026-07-04T00:00:00.000Z"),
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function day(date: string) {
  return {
    confidence: 95,
    date,
    sourceEvents: ["lease:lease-1"],
    state: EconomicTimelineState.LEASED
  };
}
