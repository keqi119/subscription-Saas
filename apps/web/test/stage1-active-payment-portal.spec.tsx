import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PortalBillCard } from "../src/app/portal/bills/portal-bill-card";
import type { PortalBillListItem } from "../src/lib/portal-types";

const webRoot = join(__dirname, "..");

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

describe("Stage 1 active-payment Portal baseline", () => {
  it("removes delegated debit from the portal journey", () => {
    const portalHomeSource = read("src/app/portal/page.tsx");
    const billsSource = read("src/app/portal/bills/page.tsx");
    const billDetailSource = read("src/app/portal/bills/[id]/page.tsx");

    expect(portalHomeSource).not.toContain('/portal/auto-debit"');
    expect(billsSource).not.toMatch(
      /getPortalAutoDebit|getPortalPaymentMandates|getPortalDebitAttempts/
    );
    expect(billDetailSource).not.toMatch(/PortalAutoDebitStatusCard|getPortalAutoDebit/);
    expect(billsSource).toContain("账单提醒 + 主动支付");
  });

  it("keeps active payment on payable bills", () => {
    const html = renderToStaticMarkup(
      <PortalBillCard bill={payableBill} onDetails={vi.fn()} onPay={vi.fn()} paying={false} />
    );

    expect(html).toContain("去支付");
    expect(html).not.toMatch(/自动扣款|授权|扣款结果/);
  });

  it("redirects legacy auto-debit pages to bills", () => {
    const autoDebitPageSource = read("src/app/portal/auto-debit/page.tsx");
    const autoDebitDetailSource = read("src/app/portal/auto-debit/[id]/page.tsx");

    expect(autoDebitPageSource).toContain('redirect("/portal/bills")');
    expect(autoDebitDetailSource).toContain('redirect("/portal/bills")');
  });
});

function read(file: string) {
  return readFileSync(join(webRoot, file), "utf8");
}
