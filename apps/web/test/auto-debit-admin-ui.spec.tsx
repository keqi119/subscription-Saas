import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  HistoricalAutoDebitPanel,
  OrderAutoDebitTracePanel,
  type AdminAutoDebitAttempt,
  type AdminPaymentMandate
} from "../src/app/billing/monthly-rent/historical-auto-debit-panel";
import {
  MODULE_LABELS,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS
} from "../src/constants/labels";

describe("historical auto-debit Admin views", () => {
  it("renders historical mandate and attempt facts without mutation controls", () => {
    const html = renderToStaticMarkup(
      <HistoricalAutoDebitPanel
        attempts={[attempt({ status: "UNKNOWN" })]}
        loading={false}
        mandates={[mandate({ status: "ACTIVE" })]}
      />
    );

    expect(html).toContain("历史自动扣款（已停用）");
    expect(html).toContain("MDT20260804000001");
    expect(html).toContain("DBT20260902000001");
    expect(html).not.toMatch(/人工扣款|查询结果|同步授权|关闭授权|设置模拟结果/);
  });

  it("does not call retired mutation endpoints", () => {
    const monthlyRentSource = readFileSync(
      fileURLToPath(new URL("../src/app/billing/monthly-rent/page.tsx", import.meta.url)),
      "utf8"
    );

    expect(monthlyRentSource).toContain("筛选授权状态");
    expect(monthlyRentSource).toContain("筛选扣款状态");
    expect(monthlyRentSource).toContain("刷新历史记录");
    expect(monthlyRentSource).toContain("未分配收款");
    expect(monthlyRentSource).not.toContain("刷新自动扣款");
    expect(monthlyRentSource).not.toMatch(
      /attempts\/\$\{attempt\.id\}\/query|bills\/\$\{attempt\.billId\}\/debit|mandates\/\$\{mandate\.id\}\/(sync|revoke)|mock\/attempts/
    );
  });

  it("describes retained permissions as historical query and audit access", () => {
    expect(MODULE_LABELS.auto_debit).toBe("历史自动扣款");
    expect(PERMISSION_LABELS).toMatchObject({
      "auto_debit:execute": "查询历史扣款记录",
      "auto_debit:manage": "审计历史支付授权",
      "auto_debit:view": "查看历史自动扣款"
    });
    const descriptions = [
      PERMISSION_DESCRIPTIONS["auto_debit:execute"],
      PERMISSION_DESCRIPTIONS["auto_debit:manage"],
      PERMISSION_DESCRIPTIONS["auto_debit:view"]
    ].join(" ");
    expect(descriptions).toContain("历史");
    expect(descriptions).not.toMatch(/发起|执行|重试|同步|暂停|解除|撤销/);
  });

  it("traces historical facts through payment and write-off evidence", () => {
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

    expect(html).toContain("历史自动扣款结算追踪（已停用）");
    expect(html).toContain("Mandate");
    expect(html).toContain("Attempt");
    expect(html).toContain("PaymentOrder");
    expect(html).toContain("PaymentRecord");
    expect(html).toContain("WriteOff 1 笔");
    expect(html).toContain("查看历史自动扣款记录");
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
