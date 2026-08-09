import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PortalEntitlementUsageRecords } from "../src/app/portal/entitlements/entitlement-records";
import type { PortalEntitlementUsage } from "../src/lib/portal-types";

describe("portal entitlement records", () => {
  it("renders usage records as readable mobile cards", () => {
    const html = renderToStaticMarkup(
      <PortalEntitlementUsageRecords loading={false} rows={[usageFixture()]} />
    );

    expect(html).toContain('data-testid="portal-entitlement-usage-card"');
    expect(html).toContain("洗车权益");
    expect(html).toContain("1 次");
    expect(html).toContain("2026-08-08 18:30");
  });

  it("switches to readable cards at the mobile breakpoint", () => {
    const css = readFileSync(
      resolve(__dirname, "../src/app/portal/entitlements/entitlement-records.module.css"),
      "utf8"
    );

    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)/);
    expect(css).toContain("word-break: keep-all");
    expect(css).not.toContain("overflow-x: scroll");
  });
});

function usageFixture(): PortalEntitlementUsage {
  return {
    amount: 1,
    entitlementType: "BENEFIT",
    externalRefNo: null,
    grantId: "grant-1",
    grantName: "洗车权益",
    grantNo: "ENT202608020001",
    occurredAt: "2026-08-08T10:30:00.000Z",
    orderId: "order-1",
    orderNo: "ORD202608020001",
    remark: null,
    source: "SYSTEM",
    status: "CONFIRMED",
    unit: "TIMES",
    usageId: "usage-1",
    usageNo: "USE202608080001"
  };
}
