import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PAYMENT_SUMMARY_STATUS_LABELS,
  SUBSCRIPTION_CHANGE_STATUS_LABELS,
  labelOf
} from "../src/constants/labels";

const repoRoot = join(__dirname, "..", "..", "..");

describe("Portal order status labels", () => {
  it("defines every Portal payment and subscription-change label", () => {
    expect(PAYMENT_SUMMARY_STATUS_LABELS).toEqual({
      NONE: "暂无账单",
      OVERDUE: "已逾期",
      PAID: "已结清",
      PARTIALLY_PAID: "部分支付",
      PENDING: "待支付"
    });
    expect(SUBSCRIPTION_CHANGE_STATUS_LABELS).toEqual({
      CANCELLED: "已取消",
      COMPLETED: "已完成",
      CUSTOMER_CONFIRMED: "客户已确认报价",
      DRAFT: "草稿",
      EXECUTING: "生效处理中",
      FAILED: "处理失败",
      MANUAL_TAKEOVER: "人工接管",
      QUOTED: "已正式报价",
      SCHEDULED: "已签约待生效",
      SIGNING_OR_PAYMENT: "签约处理中"
    });
    expect(labelOf(PAYMENT_SUMMARY_STATUS_LABELS, "FUTURE_STATE")).toBe(
      "FUTURE_STATE"
    );
    expect(labelOf(SUBSCRIPTION_CHANGE_STATUS_LABELS, "FUTURE_STATE")).toBe(
      "FUTURE_STATE"
    );
  });

  it("localizes payment summary states in the order list and detail", () => {
    const listSource = read("apps/web/src/app/portal/orders/page.tsx");
    const detailSource = read("apps/web/src/app/portal/orders/[id]/page.tsx");
    const changeDetailSource = read(
      "apps/web/src/app/portal/subscription-changes/[id]/page.tsx"
    );

    expect(listSource).toContain("PAYMENT_SUMMARY_STATUS_LABELS");
    expect(detailSource).toContain("PAYMENT_SUMMARY_STATUS_LABELS");
    expect(listSource).not.toContain("labelOf(STATUS_LABELS, order.paymentStatus)");
    expect(detailSource).not.toContain("labelOf(STATUS_LABELS, order.paymentStatus)");
    expect(detailSource).toContain("SUBSCRIPTION_CHANGE_STATUS_LABELS");
    expect(detailSource).not.toContain("order.activeSubscriptionChange.status}</Typography.Text>");
    expect(changeDetailSource).toContain("SUBSCRIPTION_CHANGE_STATUS_LABELS");
    expect(changeDetailSource).not.toContain("{change.status}");
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
