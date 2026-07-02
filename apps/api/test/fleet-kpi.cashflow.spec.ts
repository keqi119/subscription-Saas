import { BillType, DepositTransactionStatus, DepositTransactionType, PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { CashflowModel } from "../src/fleet-ops/economics/cashflow.model";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-07-31T23:59:59.999Z");

describe("CashflowModel", () => {
  it("separates receivable planned cashflow from confirmed payment actual cashflow", () => {
    const result = new CashflowModel().calculate({
      depositLedgers: [],
      from,
      paymentRecords: [
        payment({ amount: 1000, billType: BillType.MONTHLY_RENT, id: "payment-confirmed" }),
        payment({ amount: 700, billType: BillType.DAMAGE_FEE, id: "payment-pending", paymentStatus: PaymentStatus.PENDING_CONFIRM })
      ],
      receivableBills: [
        receivable({ amount: 1200, billType: BillType.MONTHLY_RENT, id: "bill-rent" }),
        receivable({ amount: 300, billType: BillType.DEPOSIT, id: "bill-deposit" })
      ],
      to,
      vehicleId: "vehicle-1",
      writeOffAllocations: []
    });

    expect(result.planned).toMatchObject({
      deposit: 300,
      operating: 1200
    });
    expect(result.actual).toMatchObject({
      deposit: 0,
      operating: 1000,
      unassigned: 0
    });
    expect(result.warnings).toEqual(expect.arrayContaining(["NON_CONFIRMED_PAYMENT_EXCLUDED"]));
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "receivable_bill", sourceId: "bill-rent" }),
        expect.objectContaining({ source: "payment_record", sourceId: "payment-confirmed" })
      ])
    );
  });

  it("uses payment write-off allocations without double counting the parent payment amount", () => {
    const result = new CashflowModel().calculate({
      depositLedgers: [],
      from,
      paymentRecords: [payment({ amount: 1000, billType: null, id: "payment-with-writeoffs" })],
      receivableBills: [],
      to,
      vehicleId: "vehicle-1",
      writeOffAllocations: [
        writeOff({ amount: 600, billType: BillType.MONTHLY_RENT, id: "writeoff-rent", paymentId: "payment-with-writeoffs" }),
        writeOff({ amount: 400, billType: BillType.DAMAGE_FEE, id: "writeoff-damage", paymentId: "payment-with-writeoffs" })
      ]
    });

    expect(result.actual.operating).toBe(1000);
    expect(result.writeOff.appliedOperating).toBe(1000);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "payment_write_off", sourceId: "writeoff-rent" }),
        expect.objectContaining({ source: "payment_write_off", sourceId: "writeoff-damage" })
      ])
    );
  });

  it("tracks deposit cashflow separately and flags missing linkage evidence", () => {
    const result = new CashflowModel().calculate({
      depositLedgers: [
        {
          amount: 500,
          id: "deposit-ledger-1",
          occurredAt: new Date("2026-07-03T12:00:00.000Z"),
          transactionStatus: DepositTransactionStatus.CONFIRMED,
          transactionType: DepositTransactionType.COLLECT,
          vehicleId: "vehicle-1"
        }
      ],
      from,
      paymentRecords: [payment({ amount: 900, id: "payment-unassigned", vehicleId: null })],
      receivableBills: [
        receivable({ dueDate: null, id: "bill-missing-due-date" })
      ],
      to,
      vehicleId: "vehicle-1",
      writeOffAllocations: [
        writeOff({ billId: null, billType: null, id: "writeoff-missing-bill" })
      ]
    });

    expect(result.actual).toMatchObject({
      deposit: 500,
      operating: 0,
      unassigned: 900
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "MISSING_RECEIVABLE_DUE_DATE",
        "UNASSIGNED_PAYMENT_EXCLUDED",
        "WRITE_OFF_WITHOUT_CLEAR_BILL_LINKAGE",
        "DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"
      ])
    );
  });
});

function receivable(overrides: Partial<Parameters<CashflowModel["calculate"]>[0]["receivableBills"][number]> = {}) {
  return {
    amount: 1000,
    billType: BillType.MONTHLY_RENT,
    dueDate: new Date("2026-07-02T00:00:00.000Z"),
    id: "bill-1",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function payment(overrides: Partial<Parameters<CashflowModel["calculate"]>[0]["paymentRecords"][number]> = {}) {
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

function writeOff(overrides: Partial<Parameters<CashflowModel["calculate"]>[0]["writeOffAllocations"][number]> = {}) {
  return {
    amount: 1000,
    billId: "bill-1",
    billType: BillType.MONTHLY_RENT,
    id: "writeoff-1",
    paymentId: "payment-1",
    vehicleId: "vehicle-1",
    writeOffAt: new Date("2026-07-04T00:00:00.000Z"),
    ...overrides
  };
}
