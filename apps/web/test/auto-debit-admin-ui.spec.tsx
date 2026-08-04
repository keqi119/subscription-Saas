import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AutoDebitOperationsPanel,
  OrderAutoDebitTracePanel,
  type AdminAutoDebitAttempt,
  type AdminPaymentMandate
} from "../src/app/billing/monthly-rent/auto-debit-operations-panel";

describe("AutoDebitOperationsPanel", () => {
  it("wires filters, summary metrics and audited operator endpoints into monthly rent automation", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/app/billing/monthly-rent/page.tsx", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("筛选授权状态");
    expect(source).toContain("筛选扣款状态");
    expect(source).toContain("未分配收款");
    expect(source).toContain("/billing/automation/attempts/${attempt.id}/query");
    expect(source).toContain("/billing/automation/bills/${attempt.billId}/debit");
    expect(source).toContain("/billing/automation/jobs/${job.id}/cancel");
    expect(source).toContain("reason: reason.trim()");
  });

  it("offers UNKNOWN query only and gates resolved manual debit by permission", () => {
    const html = renderToStaticMarkup(
      <AutoDebitOperationsPanel
        attempts={[
          attempt({ id: "unknown", status: "UNKNOWN" }),
          attempt({ id: "failed", status: "FAILED_FINAL" })
        ]}
        canExecute
        canManage
        loading={false}
        mandates={[mandate()]}
        onManualDebit={vi.fn()}
        onMockResult={vi.fn()}
        onQueryAttempt={vi.fn()}
        onRevokeMandate={vi.fn()}
        onSyncMandate={vi.fn()}
      />
    );

    expect(html.match(/查询结果/g)).toHaveLength(1);
    expect(html.match(/人工扣款/g)).toHaveLength(1);
    expect(html).toContain("同步授权");
    expect(html).toContain("关闭授权");
    expect(html).not.toContain("设置模拟结果");
  });

  it("shows explicit Staging mock controls only for mock unresolved records", () => {
    const html = renderToStaticMarkup(
      <AutoDebitOperationsPanel
        attempts={[
          attempt({
            mandate: { mandateNo: "MDT20260804000001", providerMode: "mock" },
            status: "PROCESSING"
          })
        ]}
        canExecute
        canManage={false}
        loading={false}
        mandates={[mandate({ providerMode: "mock" })]}
        onManualDebit={vi.fn()}
        onMockResult={vi.fn()}
        onQueryAttempt={vi.fn()}
        onRevokeMandate={vi.fn()}
        onSyncMandate={vi.fn()}
      />
    );

    expect(html).toContain("STAGING MOCK，不会发生真实扣款");
    expect(html).toContain("设置模拟结果");
  });

  it("renders records read-only without operation permissions", () => {
    const html = renderToStaticMarkup(
      <AutoDebitOperationsPanel
        attempts={[attempt({ status: "FAILED_FINAL" })]}
        canExecute={false}
        canManage={false}
        loading={false}
        mandates={[mandate()]}
        onManualDebit={vi.fn()}
        onMockResult={vi.fn()}
        onQueryAttempt={vi.fn()}
        onRevokeMandate={vi.fn()}
        onSyncMandate={vi.fn()}
      />
    );

    expect(html).toContain("最终失败");
    expect(html).not.toContain("人工扣款");
    expect(html).not.toContain("同步授权");
  });

  it("traces mandate through attempt, payment order, payment record and write-off", () => {
    const html = renderToStaticMarkup(
      <OrderAutoDebitTracePanel
        attempts={[
          attempt({
            paymentOrder: {
              paymentOrderNo: "PAY20260902000001",
              paymentRecord: {
                paymentNo: "PMT20260902000001",
                paymentStatus: "CONFIRMED",
                writeOffs: [
                  {
                    billId: "bill-1",
                    writeOffAmount: "100",
                    writeOffAt: "2026-09-02T01:05:00.000Z"
                  }
                ]
              },
              paymentStatus: "PAID",
              providerTransactionId: null
            },
            status: "SUCCEEDED"
          })
        ]}
        loading={false}
        mandates={[mandate()]}
      />
    );

    expect(html).toContain("自动扣款结算追踪");
    expect(html).toContain("Mandate");
    expect(html).toContain("Attempt");
    expect(html).toContain("PaymentOrder");
    expect(html).toContain("PaymentRecord");
    expect(html).toContain("WriteOff 1 笔");
    expect(html).toContain("进入自动扣款操作台");
  });
});

function mandate(overrides: Partial<AdminPaymentMandate> = {}): AdminPaymentMandate {
  return {
    customer: { customerNo: "CUS001", name: "测试客户" },
    effectiveAt: "2026-08-04T01:00:00.000Z",
    expiresAt: null,
    id: "mandate-1",
    lastSyncedAt: "2026-08-04T01:00:00.000Z",
    mandateNo: "MDT20260804000001",
    order: { orderNo: "ORD20260802071556GFEY" },
    orderId: "order-1",
    providerMode: "wechat_auto_renew",
    revokedAt: null,
    signedAt: "2026-08-04T01:00:00.000Z",
    status: "ACTIVE",
    ...overrides
  };
}

function attempt(overrides: Partial<AdminAutoDebitAttempt> = {}): AdminAutoDebitAttempt {
  return {
    bill: { billNo: "BIL20260902000001", remainingAmount: "100" },
    billId: "bill-1",
    createdAt: "2026-09-02T01:00:00.000Z",
    customer: { customerNo: "CUS001", name: "测试客户" },
    debitAttemptNo: "DBT20260902000001",
    id: "attempt-1",
    mandate: { mandateNo: "MDT20260804000001", providerMode: "wechat_auto_renew" },
    order: { orderNo: "ORD20260802071556GFEY" },
    orderId: "order-1",
    paymentOrder: {
      paymentOrderNo: "PAY20260902000001",
      paymentStatus: "FAILED",
      providerTransactionId: null
    },
    requestedAmount: "100",
    retrySlot: "D3",
    status: "FAILED_FINAL",
    ...overrides
  };
}
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
