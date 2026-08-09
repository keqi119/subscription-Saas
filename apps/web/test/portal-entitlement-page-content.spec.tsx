import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PortalEntitlementPageContent } from "../src/app/portal/entitlements/entitlement-page-content";
import type { PortalEntitlementGrant } from "../src/lib/portal-types";

describe("portal entitlement page content", () => {
  it("shows a visible loading state", () => {
    const html = renderToStaticMarkup(
      <PortalEntitlementPageContent
        error={null}
        grants={[]}
        loading
        onRetry={() => undefined}
        usages={[]}
      />
    );

    expect(html).toContain("正在加载权益");
  });

  it("shows the error and a retry action", () => {
    const html = renderToStaticMarkup(
      <PortalEntitlementPageContent
        error="权益读取失败"
        grants={[]}
        loading={false}
        onRetry={() => undefined}
        todayKey="2026-08-09"
        usages={[]}
      />
    );

    expect(html).toContain("权益读取失败");
    expect(html).toContain("重新加载");
  });

  it("renders the entitlement overview only after complete data is available", () => {
    const html = renderToStaticMarkup(
      <PortalEntitlementPageContent
        error={null}
        grants={[grantFixture()]}
        loading={false}
        onRetry={() => undefined}
        usages={[]}
      />
    );

    expect(html).toContain("当前可用额度");
    expect(html).toContain("220 kWh");
    expect(html).toContain("核销记录");
  });
});

function grantFixture(): PortalEntitlementGrant {
  return {
    entitlementType: "ENERGY",
    grantId: "grant-1",
    grantNo: "ENT202608090001",
    latestUsageAt: null,
    name: "补能额度",
    orderId: "order-1",
    orderNo: "ORD202608090001",
    remainingAmount: 220,
    remark: null,
    source: "ORDER_START",
    status: "ACTIVE",
    totalAmount: 300,
    unit: "KWH",
    usedAmount: 80,
    validFrom: "2026-08-01",
    validTo: "2026-08-31"
  };
}
