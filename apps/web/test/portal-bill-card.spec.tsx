import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PortalBillCard } from "../src/app/portal/bills/portal-bill-card";
import type { PortalBillListItem } from "../src/lib/portal-types";

const payableBill: PortalBillListItem = {
  amount: 1,
  billId: "bill-1",
  billNo: "BIL20260802072556VWU2",
  billStatus: "PENDING",
  billType: "FIRST_MONTHLY_FEE",
  canPay: true,
  dueDate: "2026-08-02T00:00:00.000Z",
  orderId: "order-1",
  orderNo: "ORD20260802071556GFEY",
  orderStatus: "PENDING_PAYMENT",
  paidAmount: 0,
  periodEnd: null,
  periodStart: null,
  remainingAmount: 1
};

describe("PortalBillCard", () => {
  it("keeps long bill and order identifiers in dedicated mobile-safe regions", () => {
    const html = renderToStaticMarkup(
      <PortalBillCard bill={payableBill} onDetails={vi.fn()} onPay={vi.fn()} paying={false} />
    );

    expect(html).toContain('data-testid="portal-bill-card"');
    expect(html).toContain('data-testid="portal-bill-number"');
    expect(html).toContain('data-testid="portal-bill-order-number"');
    expect(html).toContain('data-testid="portal-bill-actions"');
    expect(html).toContain("BIL20260802072556VWU2");
    expect(html).toContain("ORD20260802071556GFEY");
    expect(html).toContain("应付");
    expect(html).toContain("0.01 元");
    expect(html).toContain("首期月费");
    expect(html).toContain("待收款");
    expect(html).toContain("去支付");
    expect(html).toContain("查看详情");
  });

  it("omits payment action for a bill that cannot be paid", () => {
    const html = renderToStaticMarkup(
      <PortalBillCard
        bill={{ ...payableBill, billStatus: "PAID", canPay: false, remainingAmount: 0 }}
        onDetails={vi.fn()}
        onPay={vi.fn()}
        paying={false}
      />
    );

    expect(html).not.toContain("去支付");
    expect(html).toContain("查看详情");
    expect(html).toContain("已收款");
  });

  it("keeps active payment without any auto-debit copy", () => {
    const html = renderToStaticMarkup(
      <PortalBillCard bill={payableBill} onDetails={vi.fn()} onPay={vi.fn()} paying={false} />
    );

    expect(html).toContain("去支付");
    expect(html).not.toMatch(/自动扣款|授权|扣款结果/);
  });
});
