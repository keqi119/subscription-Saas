import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  formatPortalMoney,
  PaymentOrderBillDetails
} from "../src/app/portal/payment-orders/[id]/payment-order-bill-details";
import type { PortalPaymentOrderItem } from "../src/lib/portal-types";

const item: PortalPaymentOrderItem = {
  amount: 1,
  billId: "bill_first_month",
  billNo: "BIL20260731173757TDWH",
  billStatus: "PENDING",
  billType: "FIRST_MONTHLY_FEE",
  dueDate: "2026-08-01T01:37:00.000Z",
  id: "payment_item_1",
  orderNo: "ORD20260731173351SMF2",
  paidAmount: 0,
  remainingAmount: 1
};

describe("PaymentOrderBillDetails", () => {
  it("renders complete desktop and mobile bill views from the same item", () => {
    const html = renderToStaticMarkup(<PaymentOrderBillDetails items={[item]} />);

    expect(html).toContain('data-testid="payment-order-bills-desktop"');
    expect(html).toContain('data-testid="payment-order-bills-mobile"');
    for (const text of ["账单编号", "类型", "状态", "应付", "待付", "到期日"]) {
      expect(html).toContain(text);
    }
    expect(html.match(/BIL20260731173757TDWH/g)).toHaveLength(2);
    expect(html).toContain("首期月费");
    expect(html).toContain("待收款");
  });

  it("formats one cent without losing precision", () => {
    expect(formatPortalMoney(1)).toBe("0.01 元");
  });
});
