import { BillStatus, BillType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { OverdueDetectorModel } from "../src/fleet-ops/risk/overdue-detector.model";
import type { RiskReceivableBill } from "../src/fleet-ops/risk/risk.types";

const asOf = new Date("2026-07-05T00:00:00.000Z");

describe("OverdueDetectorModel", () => {
  it("detects factual overdue bills without requiring BillStatus.OVERDUE", () => {
    const result = new OverdueDetectorModel().detect({
      asOf,
      bills: [
        bill({
          billStatus: BillStatus.PENDING,
          dueDate: new Date("2026-07-01T00:00:00.000Z"),
          id: "bill-pending-overdue",
          remainingAmount: 600
        })
      ],
      vehicleId: "vehicle-1"
    });

    expect(result.overdueFacts).toEqual([
      expect.objectContaining({
        billId: "bill-pending-overdue",
        overdueDays: 4,
        remainingAmount: 600,
        sourceStatus: BillStatus.PENDING
      })
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "FACTUAL_OVERDUE_STATUS_NOT_REFRESHED",
          sourceId: "bill-pending-overdue"
        })
      ])
    );
  });

  it("excludes cancelled, paid, zero-remaining, and future-due bills", () => {
    const result = new OverdueDetectorModel().detect({
      asOf,
      bills: [
        bill({ billStatus: BillStatus.CANCELLED, id: "bill-cancelled" }),
        bill({ billStatus: BillStatus.PAID, id: "bill-paid", remainingAmount: 0 }),
        bill({ id: "bill-zero", remainingAmount: 0 }),
        bill({ dueDate: new Date("2026-07-06T00:00:00.000Z"), id: "bill-future" })
      ],
      vehicleId: "vehicle-1"
    });

    expect(result.overdueFacts).toEqual([]);
  });

  it("keeps partially paid bills overdue when remaining amount is still open", () => {
    const result = new OverdueDetectorModel().detect({
      asOf,
      bills: [
        bill({
          amount: 1000,
          billStatus: BillStatus.PARTIALLY_PAID,
          id: "bill-partial",
          paidAmount: 700,
          remainingAmount: 300
        })
      ],
      vehicleId: "vehicle-1"
    });

    expect(result.overdueFacts).toEqual([
      expect.objectContaining({
        billId: "bill-partial",
        paidAmount: 700,
        remainingAmount: 300
      })
    ]);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "receivable_bill",
          sourceId: "bill-partial"
        })
      ])
    );
  });
});

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
    ...overrides
  };
}
