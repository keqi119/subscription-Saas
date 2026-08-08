import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PortalPaymentOrderRecords,
  PortalWriteOffRecords
} from "../src/app/portal/bills/[id]/bill-records";
import type { PortalBillDetail } from "../src/lib/portal-types";

describe("portal bill detail records", () => {
  it("renders payment orders and write-offs as readable mobile cards", () => {
    const html = renderToStaticMarkup(
      <>
        <PortalPaymentOrderRecords rows={[paymentOrderFixture()]} />
        <PortalWriteOffRecords rows={[writeOffFixture()]} />
      </>
    );

    expect(html).toContain('data-testid="portal-payment-order-card"');
    expect(html).toContain('data-testid="portal-write-off-card"');
    expect(html).toContain("PAY202607230736426ZLB");
    expect(html).toContain("5,400.00 元");
    expect(html).toContain("银行转账");
    expect(html).toContain("2026-07-23 18:43");
  });

  it("uses payment status labels rather than payment-order labels for write-offs", () => {
    const html = renderToStaticMarkup(<PortalWriteOffRecords rows={[writeOffFixture()]} />);

    expect(html).toContain("已确认");
    expect(html).not.toContain("CONFIRMED");
  });

  it("switches projections at 768px and wraps machine identifiers", () => {
    const css = readFileSync(
      resolve(__dirname, "../src/app/portal/bills/[id]/bill-records.module.css"),
      "utf8"
    );

    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)/);
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).not.toContain("overflow-x: scroll");
  });
});

function paymentOrderFixture(): PortalBillDetail["paymentOrders"][number] {
  return {
    amount: 540000,
    paidAmount: 540000,
    paidAt: "2026-07-23T18:43:00+08:00",
    paymentChannel: "BANK_TRANSFER",
    paymentOrderId: "payment-order-1",
    paymentOrderNo: "PAY202607230736426ZLB",
    paymentStatus: "PAID",
    provider: "BANK_TRANSFER"
  };
}

function writeOffFixture(): PortalBillDetail["writeOffs"][number] {
  return {
    paymentAmount: 540000,
    paymentId: "payment-1",
    paymentMethod: "BANK_TRANSFER",
    paymentNo: "PAY202607230736426ZLB",
    paymentStatus: "CONFIRMED",
    receivedAt: "2026-07-23T18:40:00+08:00",
    remark: null,
    writeOffAmount: 540000,
    writeOffAt: "2026-07-23T18:43:00+08:00",
    writeOffId: "write-off-1"
  };
}
