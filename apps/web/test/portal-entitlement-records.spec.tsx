import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PortalEntitlementGrantRecords,
  PortalEntitlementUsageRecords
} from "../src/app/portal/entitlements/entitlement-records";
import type { PortalEntitlementGrant, PortalEntitlementUsage } from "../src/lib/portal-types";

describe("portal entitlement records", () => {
  it("renders grant and usage records as mobile cards from the same rows", () => {
    const html = renderToStaticMarkup(
      <>
        <PortalEntitlementGrantRecords loading={false} rows={[grantFixture()]} />
        <PortalEntitlementUsageRecords loading={false} rows={[usageFixture()]} />
      </>
    );

    expect(html).toContain('data-testid="portal-entitlement-grant-card"');
    expect(html).toContain('data-testid="portal-entitlement-usage-card"');
    expect(html).toContain("洗车权益");
    expect(html).toContain("10 次");
    expect(html).toContain("2026-08-02");
    expect(html).toContain("2026-09-01");
  });

  it("uses the text-benefit label instead of a numeric suffix", () => {
    const html = renderToStaticMarkup(
      <PortalEntitlementGrantRecords
        loading={false}
        rows={[{ ...grantFixture(), remainingAmount: null, unit: "TEXT" }]}
      />
    );

    expect(html).toContain("文本权益");
    expect(html).not.toContain("null 文本权益");
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

function grantFixture(): PortalEntitlementGrant {
  return {
    entitlementType: "BENEFIT",
    grantId: "grant-1",
    grantNo: "ENT202608020001",
    latestUsageAt: null,
    name: "洗车权益",
    orderId: "order-1",
    orderNo: "ORD202608020001",
    remainingAmount: 10,
    remark: null,
    source: "ORDER_START",
    status: "ACTIVE",
    totalAmount: 10,
    unit: "TIMES",
    usedAmount: 0,
    validFrom: "2026-08-02",
    validTo: "2026-09-01"
  };
}

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
