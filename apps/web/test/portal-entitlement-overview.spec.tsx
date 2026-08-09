import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PortalEntitlementOverview,
  PortalEntitlementTypePanel
} from "../src/app/portal/entitlements/entitlement-overview";
import type { PortalEntitlementGrant, PortalEntitlementUsage } from "../src/lib/portal-types";

describe("portal entitlement overview", () => {
  it("renders the fixed entitlement tabs with counts", () => {
    const html = renderToStaticMarkup(
      <PortalEntitlementOverview
        grants={[
          grantFixture({ entitlementType: "BENEFIT", grantId: "benefit-1" }),
          grantFixture({ entitlementType: "BENEFIT", grantId: "benefit-2" }),
          grantFixture({ entitlementType: "ENERGY", grantId: "energy-1" })
        ]}
        todayKey="2026-08-09"
        usages={[]}
      />
    );

    expect(html).toContain("服务权益");
    expect(html).toContain("补能权益");
    expect(html).toContain("里程权益");
    expect(html).toContain('data-testid="entitlement-tab-count-BENEFIT">2');
    expect(html).toContain('data-testid="entitlement-tab-count-ENERGY">1');
    expect(html).toContain('data-testid="entitlement-tab-count-MILEAGE">0');
  });

  it("renders option-B allowance cards with status and period semantics", () => {
    const html = renderToStaticMarkup(
      <PortalEntitlementTypePanel
        grants={[
          grantFixture({
            grantId: "active",
            name: "本期洗车权益",
            remainingAmount: 7,
            totalAmount: 10,
            usedAmount: 3
          }),
          grantFixture({
            grantId: "expired",
            name: "往期洗车权益",
            remainingAmount: 0,
            status: "EXPIRED",
            totalAmount: 8,
            usedAmount: 8,
            validFrom: "2026-07-01",
            validTo: "2026-07-31"
          }),
          grantFixture({
            grantId: "exhausted",
            name: "本期已用尽权益",
            remainingAmount: 0,
            status: "EXHAUSTED",
            totalAmount: 5,
            usedAmount: 5,
            validFrom: "2026-08-01",
            validTo: "2026-08-31"
          })
        ]}
        todayKey="2026-08-09"
        type="BENEFIT"
        usages={[]}
      />
    );

    expect(html.indexOf("本期洗车权益")).toBeLessThan(html.indexOf("往期洗车权益"));
    expect(html).toContain("当期初始额度");
    expect(html).toContain("10 次");
    expect(html).toContain("已核销额度");
    expect(html).toContain("3 次");
    expect(html).toContain("当前可用额度");
    expect(html).toContain("7 次");
    expect(html).toContain('data-status="ACTIVE"');
    expect(html).toContain('data-period="CURRENT"');
    expect(html).toContain('data-status="EXPIRED"');
    expect(html).toContain('data-period="HISTORICAL"');
    expect(html).toContain('data-progress="30"');
    expect(html).toContain('data-progress="100"');

    const expiredCard = html.match(/<article[^>]*data-status="EXPIRED"[^>]*>/)?.[0];
    const exhaustedCard = html.match(/<article[^>]*data-status="EXHAUSTED"[^>]*>/)?.[0];
    expect(expiredCard).toContain("unavailableCard");
    expect(exhaustedCard).not.toContain("unavailableCard");
  });

  it("uses non-numeric wording for text entitlements and filters usage by type", () => {
    const html = renderToStaticMarkup(
      <PortalEntitlementTypePanel
        grants={[
          grantFixture({
            grantId: "text",
            name: "代驾服务",
            remainingAmount: null,
            status: "EXHAUSTED",
            totalAmount: null,
            unit: "TEXT",
            usedAmount: null
          })
        ]}
        todayKey="2026-08-09"
        type="BENEFIT"
        usages={[
          usageFixture({ entitlementType: "BENEFIT", grantName: "服务权益核销" }),
          usageFixture({ entitlementType: "ENERGY", grantName: "补能权益核销", usageId: "usage-2" })
        ]}
      />
    );

    expect(html).toContain("已发放");
    expect(html).toContain("不适用");
    expect(html).toContain("不可用");
    expect(html).not.toContain(">可使用<");
    expect(html).not.toContain("data-progress=");
    expect(html).toContain("服务权益核销");
    expect(html).not.toContain("补能权益核销");
  });

  it("uses two desktop columns and one mobile column", () => {
    const css = readFileSync(
      resolve(__dirname, "../src/app/portal/entitlements/entitlement-overview.module.css"),
      "utf8"
    );

    expect(css).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)/);
    expect(css).toMatch(/grid-template-columns:\s*1fr/);
    expect(css).toMatch(/\.unavailableCard\s*\{[\s\S]*background/);
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).not.toContain("overflow-x: scroll");
  });
});

function grantFixture(overrides: Partial<PortalEntitlementGrant> = {}): PortalEntitlementGrant {
  return {
    entitlementType: "BENEFIT",
    grantId: "grant-1",
    grantNo: "ENT202608090001",
    latestUsageAt: null,
    name: "洗车权益",
    orderId: "order-1",
    orderNo: "ORD202608090001",
    remainingAmount: 10,
    remark: null,
    source: "ORDER_START",
    status: "ACTIVE",
    totalAmount: 10,
    unit: "TIMES",
    usedAmount: 0,
    validFrom: "2026-08-01",
    validTo: "2026-08-31",
    ...overrides
  };
}

function usageFixture(overrides: Partial<PortalEntitlementUsage> = {}): PortalEntitlementUsage {
  return {
    amount: 1,
    entitlementType: "BENEFIT",
    externalRefNo: null,
    grantId: "grant-1",
    grantName: "洗车权益",
    grantNo: "ENT202608090001",
    occurredAt: "2026-08-08T10:30:00.000Z",
    orderId: "order-1",
    orderNo: "ORD202608090001",
    remark: null,
    source: "SYSTEM",
    status: "CONFIRMED",
    unit: "TIMES",
    usageId: "usage-1",
    usageNo: "USE202608080001",
    ...overrides
  };
}
