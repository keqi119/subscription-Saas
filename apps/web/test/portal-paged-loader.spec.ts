import { describe, expect, it } from "vitest";

import {
  fetchAllPortalPages,
  loadPortalEntitlementPageData,
  portalPagedPath,
  type PortalPageFetcher
} from "../src/app/portal/entitlements/portal-paged-loader";
import type {
  PortalEntitlementGrant,
  PortalEntitlementUsage,
  PortalPagedResponse
} from "../src/lib/portal-types";

describe("portal paged loader", () => {
  it("adds paging parameters to plain and filtered relative paths", () => {
    expect(portalPagedPath("/portal/entitlements", 1, 100)).toBe(
      "/portal/entitlements?page=1&pageSize=100"
    );
    expect(portalPagedPath("/portal/entitlements?orderId=order-1", 2, 100)).toBe(
      "/portal/entitlements?orderId=order-1&page=2&pageSize=100"
    );
  });

  it("overwrites stale paging parameters without dropping other filters", () => {
    expect(
      portalPagedPath(
        "/portal/entitlements?orderId=order-1&page=9&pageSize=5&status=ACTIVE",
        3,
        100
      )
    ).toBe("/portal/entitlements?orderId=order-1&page=3&pageSize=100&status=ACTIVE");
  });

  it("stops after one page when the reported total is already loaded", async () => {
    const calls: string[] = [];
    const fetcher = numberFetcher(calls, {
      1: { items: [1, 2], total: 2 }
    });

    await expect(fetchAllPortalPages("/portal/entitlements", fetcher)).resolves.toEqual([1, 2]);
    expect(calls).toEqual(["/portal/entitlements?page=1&pageSize=100"]);
  });

  it("loads every page and preserves filters on follow-up calls", async () => {
    const calls: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_value, index) => index + 1);
    const fetcher = numberFetcher(calls, {
      1: { items: firstPage, total: 102 },
      2: { items: [101, 102], total: 102 }
    });

    const rows = await fetchAllPortalPages("/portal/entitlements?orderId=order-1", fetcher);

    expect(rows).toHaveLength(102);
    expect(rows.at(-1)).toBe(102);
    expect(calls).toEqual([
      "/portal/entitlements?orderId=order-1&page=1&pageSize=100",
      "/portal/entitlements?orderId=order-1&page=2&pageSize=100"
    ]);
  });

  it("rejects an incomplete empty page instead of looping forever", async () => {
    const fetcher = numberFetcher([], {
      1: { items: Array.from({ length: 100 }, (_value, index) => index), total: 102 },
      2: { items: [], total: 102 }
    });

    await expect(fetchAllPortalPages("/portal/entitlements", fetcher)).rejects.toThrow(
      "PORTAL_PAGINATION_INCOMPLETE"
    );
  });

  it("propagates a follow-up page failure unchanged", async () => {
    const expectedError = new Error("page two failed");
    const fetcher: PortalPageFetcher = async <T>(path: string) => {
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
      if (page === 2) {
        throw expectedError;
      }
      return {
        items: Array.from({ length: 100 }, (_value, index) => index) as T[],
        page: 1,
        pageSize: 100,
        total: 102
      };
    };

    await expect(fetchAllPortalPages("/portal/entitlements", fetcher)).rejects.toBe(expectedError);
  });

  it("loads complete grant and usage collections with the same order filter", async () => {
    const calls: string[] = [];
    const grant = grantFixture();
    const usage = usageFixture();
    const fetcher: PortalPageFetcher = async <T>(path: string) => {
      calls.push(path);
      const response: PortalPagedResponse<PortalEntitlementGrant | PortalEntitlementUsage> = {
        items: path.startsWith("/portal/entitlements/usages") ? [usage] : [grant],
        page: 1,
        pageSize: 100,
        total: 1
      };
      return response as PortalPagedResponse<T>;
    };

    await expect(loadPortalEntitlementPageData("order 1", fetcher)).resolves.toEqual({
      grants: [grant],
      usages: [usage]
    });
    expect(calls).toEqual([
      "/portal/entitlements?orderId=order+1&page=1&pageSize=100",
      "/portal/entitlements/usages?orderId=order+1&page=1&pageSize=100"
    ]);
  });
});

function numberFetcher(
  calls: string[],
  pages: Record<number, { items: number[]; total: number }>
): PortalPageFetcher {
  return async <T>(path: string) => {
    calls.push(path);
    const searchParams = new URLSearchParams(path.split("?")[1]);
    const page = Number(searchParams.get("page"));
    const pageSize = Number(searchParams.get("pageSize"));
    const response = pages[page];

    if (!response) {
      throw new Error(`Unexpected page ${page}`);
    }

    return {
      items: response.items as T[],
      page,
      pageSize,
      total: response.total
    };
  };
}

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

function usageFixture(): PortalEntitlementUsage {
  return {
    amount: 80,
    entitlementType: "ENERGY",
    externalRefNo: null,
    grantId: "grant-1",
    grantName: "补能额度",
    grantNo: "ENT202608090001",
    occurredAt: "2026-08-08T10:30:00.000Z",
    orderId: "order-1",
    orderNo: "ORD202608090001",
    remark: null,
    source: "SYSTEM",
    status: "CONFIRMED",
    unit: "KWH",
    usageId: "usage-1",
    usageNo: "USE202608080001"
  };
}
