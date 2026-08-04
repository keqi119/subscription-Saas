import { describe, expect, it } from "vitest";

import { buildPortalAutoDebitView, nextRetryAt } from "../src/lib/portal-auto-debit-view-model";
import type {
  PortalBillListItem,
  PortalDebitAttempt,
  PortalPaymentMandate
} from "../src/lib/portal-types";

describe("portal auto debit view model", () => {
  it("shows a closed product state without exposing mock controls", () => {
    const view = buildPortalAutoDebitView({
      availability: { enabled: false, provider: null }
    });

    expect(view).toMatchObject({
      canEnroll: false,
      canPay: true,
      state: "DISABLED",
      title: "自动扣款暂未开通"
    });
    expect(JSON.stringify(view)).not.toMatch(/mock|nextResult|providerSnapshot/i);
  });

  it("offers enrollment and active-payment fallback before authorization", () => {
    expect(
      buildPortalAutoDebitView({
        availability: { enabled: true, provider: "WECHAT_AUTO_DEBIT" },
        bill: payableBill
      })
    ).toMatchObject({
      canEnroll: true,
      canPay: true,
      state: "NOT_ENROLLED"
    });
  });

  it("shows the next debit date for an active mandate", () => {
    expect(
      buildPortalAutoDebitView({
        availability: { enabled: true, provider: "WECHAT_AUTO_DEBIT" },
        bill: payableBill,
        mandate: activeMandate
      })
    ).toMatchObject({
      canRevoke: true,
      nextActionAt: "2026-09-02T00:00:00.000Z",
      state: "ACTIVE",
      title: "自动扣款已开通"
    });
  });

  it("keeps active payment available while the provider result is uncertain", () => {
    const view = buildPortalAutoDebitView({
      availability: { enabled: true, provider: "WECHAT_AUTO_DEBIT" },
      attempt: attempt("UNKNOWN", "DUE"),
      bill: payableBill,
      mandate: activeMandate
    });

    expect(view).toMatchObject({
      canPay: true,
      state: "PROCESSING",
      title: "扣款结果确认中"
    });
  });

  it("derives the next D+1 and D+3 retry times from the bill due date", () => {
    expect(nextRetryAt(payableBill.dueDate, "DUE")).toBe("2026-09-03T01:00:00.000Z");
    expect(nextRetryAt(payableBill.dueDate, "D1")).toBe("2026-09-05T01:00:00.000Z");
    expect(nextRetryAt(payableBill.dueDate, "D3")).toBeNull();
  });

  it("distinguishes retryable and final failures while preserving payment fallback", () => {
    expect(
      buildPortalAutoDebitView({
        availability: { enabled: true, provider: "WECHAT_AUTO_DEBIT" },
        attempt: attempt("FAILED_RETRYABLE", "DUE"),
        bill: payableBill,
        mandate: activeMandate
      })
    ).toMatchObject({
      canPay: true,
      nextActionAt: "2026-09-03T01:00:00.000Z",
      state: "RETRY_SCHEDULED"
    });
    expect(
      buildPortalAutoDebitView({
        availability: { enabled: true, provider: "WECHAT_AUTO_DEBIT" },
        attempt: attempt("FAILED_FINAL", "D3"),
        bill: payableBill,
        mandate: activeMandate
      })
    ).toMatchObject({
      canPay: true,
      nextActionAt: null,
      state: "FAILED_FINAL"
    });
  });
});

const payableBill: PortalBillListItem = {
  amount: 100,
  billId: "bill-1",
  billNo: "BIL20260902000001",
  billStatus: "PENDING",
  billType: "MONTHLY_RENT",
  canPay: true,
  dueDate: "2026-09-02T00:00:00.000Z",
  orderId: "order-1",
  orderNo: "ORD20260802071556GFEY",
  orderStatus: "ACTIVE",
  paidAmount: 0,
  periodEnd: "2026-10-01",
  periodStart: "2026-09-02",
  remainingAmount: 100
};

const activeMandate: PortalPaymentMandate = {
  effectiveAt: "2026-08-05T00:00:00.000Z",
  expiresAt: null,
  id: "mandate-1",
  mandateNo: "MDT20260805000001",
  orderId: "order-1",
  provider: "MOCK",
  providerMode: "mock",
  providerReference: "********123456",
  revokedAt: null,
  signedAt: "2026-08-05T00:00:00.000Z",
  status: "ACTIVE"
};

function attempt(
  status: PortalDebitAttempt["status"],
  retrySlot: PortalDebitAttempt["retrySlot"]
): PortalDebitAttempt {
  return {
    acceptedAt: "2026-09-02T01:00:00.000Z",
    billId: "bill-1",
    confirmedAmount: "0",
    createdAt: "2026-09-02T01:00:00.000Z",
    debitAttemptNo: "DBT20260902000001",
    id: "attempt-1",
    orderId: "order-1",
    requestedAmount: "100",
    resolvedAt: status.startsWith("FAILED") ? "2026-09-02T01:01:00.000Z" : null,
    retrySlot,
    status
  };
}
