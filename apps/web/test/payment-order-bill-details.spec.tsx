import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  formatPortalMoney,
  PaymentOrderBillDetails
} from "../src/app/portal/payment-orders/[id]/payment-order-bill-details";
import type { PortalPaymentOrderItem } from "../src/lib/portal-types";

const item: PortalPaymentOrderItem = {
  amount: 12_345,
  billId: "bill_first_month",
  billNo: "BIL20260731173757TDWH",
  billStatus: "PENDING",
  billType: "FIRST_MONTHLY_FEE",
  dueDate: "2026-08-01",
  id: "payment_item_1",
  orderNo: "ORD20260731173351SMF2",
  paidAmount: 0,
  remainingAmount: 6_789
};

describe("PaymentOrderBillDetails", () => {
  it("renders complete desktop and mobile bill views from the same item", () => {
    const html = renderToStaticMarkup(<PaymentOrderBillDetails items={[item]} />);
    const desktop = subtreeBefore(html, "payment-order-bills-desktop", "payment-order-bills-mobile");
    const mobile = subtreeAfter(html, "payment-order-bills-mobile");
    const expectedValues = [
      "BIL20260731173757TDWH",
      "首期月费",
      "待收款",
      "123.45 元",
      "67.89 元",
      "2026-08-01 00:00"
    ];

    for (const subtree of [desktop, mobile]) {
      for (const value of expectedValues) {
        expect(subtree).toContain(value);
      }
    }
  });

  it("shows an accessible mobile empty state when there are no bills", () => {
    const html = renderToStaticMarkup(<PaymentOrderBillDetails items={[]} />);
    const desktop = subtreeBefore(html, "payment-order-bills-desktop", "payment-order-bills-mobile");
    const mobile = subtreeAfter(html, "payment-order-bills-mobile");

    expect(desktop).toMatch(/No data|暂无数据/);
    expect(mobile).toContain('role="status"');
    expect(mobile).toContain("暂无账单明细");
  });

  it("formats one cent without losing precision", () => {
    expect(formatPortalMoney(1)).toBe("0.01 元");
  });
});

function subtreeBefore(html: string, startTestId: string, endTestId: string) {
  const start = html.indexOf(`data-testid="${startTestId}"`);
  const end = html.indexOf(`data-testid="${endTestId}"`);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function subtreeAfter(html: string, startTestId: string) {
  const start = html.indexOf(`data-testid="${startTestId}"`);

  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start);
}
