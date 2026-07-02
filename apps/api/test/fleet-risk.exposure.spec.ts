import { BillStatus, BillType, CollectionActionResult, CollectionActionType, CollectionCaseStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { ArrearsPipelineModel } from "../src/fleet-ops/risk/arrears-pipeline.model";
import { ExposureModel } from "../src/fleet-ops/risk/exposure.model";
import { CollectionPriorityLevel, type FleetRiskInput, type RiskCollectionCaseInput, type RiskReceivableBill } from "../src/fleet-ops/risk/risk.types";

const asOf = new Date("2026-07-05T00:00:00.000Z");

describe("ExposureModel", () => {
  it("uses overdue remaining amount instead of original bill amount", () => {
    const exposure = new ExposureModel().calculate("vehicle-1", inputWithBills([bill({ amount: 1000, remainingAmount: 250 })]), 1000);

    expect(exposure.overdueAmount).toBe(250);
    expect(exposure.overdueRemainingAmount).toBe(250);
    expect(exposure.overdueBillCount).toBe(1);
    expect(exposure.overdueBillRefs).toEqual([expect.objectContaining({ billId: "bill-1", remainingAmount: 250 })]);
  });

  it("does not double count write-off evidence as current exposure", () => {
    const exposure = new ExposureModel().calculate(
      "vehicle-1",
      inputWithBills([
        bill({
          amount: 1000,
          paidAmount: 600,
          remainingAmount: 400,
          writeOffs: [{ amount: 300, billId: "bill-1", id: "writeoff-1", paymentId: "payment-1", writeOffAt: asOf }]
        })
      ]),
      1000
    );

    expect(exposure.overdueRemainingAmount).toBe(400);
    expect(exposure.writeOffEvidence).toEqual([expect.objectContaining({ amount: 300, id: "writeoff-1" })]);
  });
});

describe("ArrearsPipelineModel", () => {
  it("keeps bills as overdue truth when a closed collection case still has open remaining amount", () => {
    const overdueBill = bill({ remainingAmount: 400 });
    const overdueFacts = new ExposureModel().calculate("vehicle-1", inputWithBills([overdueBill]), 1000).overdueBillRefs;
    const pipeline = new ArrearsPipelineModel().build({
      asOf,
      collectionCases: [
        collectionCase({
          bills: [{ billId: "bill-1", overdueAmount: 1000, overdueDays: 3 }],
          caseStatus: CollectionCaseStatus.CLOSED
        })
      ],
      overdueFacts,
      payments: [],
      vehicleId: "vehicle-1"
    });

    expect(pipeline.stage).toBe("OVERDUE_WITH_STALE_CASE");
    expect(pipeline.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CLOSED_COLLECTION_CASE_WITH_OPEN_OVERDUE_BILL"
        })
      ])
    );
  });

  it("surfaces collection actions and breached promise-to-pay evidence without mutating cases", () => {
    const pipeline = new ArrearsPipelineModel().build({
      asOf,
      collectionCases: [
        collectionCase({
          actions: [
            {
              actionResult: CollectionActionResult.CUSTOMER_PROMISED,
              actionType: CollectionActionType.PROMISE_TO_PAY,
              caseId: "case-1",
              id: "action-promise",
              promisedAmount: 300,
              promisedPayAt: new Date("2026-07-01T00:00:00.000Z")
            }
          ]
        })
      ],
      overdueFacts: [overdueRef()],
      payments: [],
      vehicleId: "vehicle-1"
    });

    expect(pipeline.actionRefs).toEqual([expect.objectContaining({ actionId: "action-promise" })]);
    expect(pipeline.promiseToPayRefs).toEqual([expect.objectContaining({ actionId: "action-promise" })]);
    expect(pipeline.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PROMISE_TO_PAY_BREACHED" })]));
  });
});

function inputWithBills(receivableBills: RiskReceivableBill[]): FleetRiskInput {
  return {
    asOf,
    collectionCases: [],
    conditionReports: [],
    fleetKpis: {
      fleet: {
        cost: 0,
        downtimeCost: 0,
        downtimeDays: 0,
        leasedDays: 0,
        netIncome: 0,
        operatingDays: 0,
        revenue: 0,
        roe: 0,
        roi: 0,
        utilizationRate: 0,
        vehicleCount: 1
      },
      vehicles: []
    },
    leases: [],
    operationalStates: [],
    orders: [],
    paymentRecords: [],
    receivableBills,
    serviceCases: [],
    timelines: {},
    vehicleIds: ["vehicle-1"]
  };
}

function bill(overrides: Partial<RiskReceivableBill> = {}): RiskReceivableBill {
  return {
    amount: 1000,
    billStatus: BillStatus.OVERDUE,
    billType: BillType.MONTHLY_RENT,
    dueDate: new Date("2026-07-01T00:00:00.000Z"),
    id: "bill-1",
    paidAmount: 0,
    remainingAmount: 1000,
    vehicleId: "vehicle-1",
    writeOffs: [],
    ...overrides
  };
}

function collectionCase(overrides: Partial<RiskCollectionCaseInput> = {}): RiskCollectionCaseInput {
  return {
    actions: [],
    bills: [],
    caseStatus: CollectionCaseStatus.ACTIVE,
    collectionLevel: CollectionPriorityLevel.D1,
    id: "case-1",
    maxOverdueDays: 4,
    orderId: "order-1",
    totalOverdueAmount: 400,
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function overdueRef() {
  return {
    billId: "bill-1",
    dueDate: new Date("2026-07-01T00:00:00.000Z"),
    overdueDays: 4,
    paidAmount: 0,
    remainingAmount: 400,
    sourceStatus: BillStatus.OVERDUE
  };
}
