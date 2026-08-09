import { describe, expect, it } from "vitest";

import {
  entitlementProgress,
  entitlementPeriodBucket,
  groupEntitlementGrants,
  isTextEntitlement,
  isUnavailableEntitlement,
  selectDefaultEntitlementType,
  sortEntitlementGrants,
  shanghaiBusinessDateKey
} from "../src/app/portal/entitlements/entitlement-view-model";
import type { PortalEntitlementGrant } from "../src/lib/portal-types";

describe("portal entitlement view model", () => {
  it("uses the Shanghai natural day around UTC midnight", () => {
    expect(shanghaiBusinessDateKey(new Date("2026-08-08T16:30:00.000Z"))).toBe("2026-08-09");
  });

  it("classifies current, future and historical periods", () => {
    const today = "2026-08-09";

    expect(
      entitlementPeriodBucket(
        grantFixture({ validFrom: "2026-08-01", validTo: "2026-08-31" }),
        today
      )
    ).toBe("CURRENT");
    expect(
      entitlementPeriodBucket(
        grantFixture({ validFrom: "2026-08-10", validTo: "2026-09-09" }),
        today
      )
    ).toBe("FUTURE");
    expect(
      entitlementPeriodBucket(
        grantFixture({ validFrom: "2026-07-01", validTo: "2026-07-31" }),
        today
      )
    ).toBe("HISTORICAL");
  });

  it("sorts current, future and historical periods from near to far", () => {
    const rows = [
      grantFixture({ grantNo: "missing", validFrom: null, validTo: null }),
      grantFixture({ grantNo: "past-far", validFrom: "2026-06-01", validTo: "2026-06-30" }),
      grantFixture({ grantNo: "future-far", validFrom: "2026-10-01", validTo: "2026-10-31" }),
      grantFixture({ grantNo: "current-older", validFrom: "2026-08-01", validTo: "2026-08-31" }),
      grantFixture({ grantNo: "past-near", validFrom: "2026-07-01", validTo: "2026-07-31" }),
      grantFixture({ grantNo: "current-newer", validFrom: "2026-08-05", validTo: "2026-09-04" }),
      grantFixture({ grantNo: "future-near", validFrom: "2026-08-10", validTo: "2026-09-09" })
    ];

    expect(sortEntitlementGrants(rows, "2026-08-09").map((row) => row.grantNo)).toEqual([
      "current-newer",
      "current-older",
      "future-near",
      "future-far",
      "past-near",
      "past-far",
      "missing"
    ]);
  });

  it("groups known entitlement types in a fixed order and ignores unknown types", () => {
    const groups = groupEntitlementGrants(
      [
        grantFixture({ entitlementType: "MILEAGE", grantNo: "mileage" }),
        grantFixture({ entitlementType: "UNKNOWN", grantNo: "unknown" }),
        grantFixture({ entitlementType: "BENEFIT", grantNo: "benefit" }),
        grantFixture({ entitlementType: "ENERGY", grantNo: "energy" })
      ],
      "2026-08-09"
    );

    expect(Object.keys(groups)).toEqual(["BENEFIT", "ENERGY", "MILEAGE"]);
    expect(groups.BENEFIT.map((row) => row.grantNo)).toEqual(["benefit"]);
    expect(groups.ENERGY.map((row) => row.grantNo)).toEqual(["energy"]);
    expect(groups.MILEAGE.map((row) => row.grantNo)).toEqual(["mileage"]);
  });

  it("selects the first fixed type with a current active grant", () => {
    const groups = groupEntitlementGrants(
      [
        grantFixture({
          entitlementType: "BENEFIT",
          status: "ACTIVE",
          validFrom: "2026-09-01",
          validTo: "2026-09-30"
        }),
        grantFixture({ entitlementType: "ENERGY", status: "ACTIVE" }),
        grantFixture({ entitlementType: "MILEAGE", status: "ACTIVE" })
      ],
      "2026-08-09"
    );

    expect(selectDefaultEntitlementType(groups, "2026-08-09")).toBe("ENERGY");
  });

  it("falls back to the first populated fixed type, then BENEFIT", () => {
    const mileageOnly = groupEntitlementGrants(
      [grantFixture({ entitlementType: "MILEAGE", status: "EXPIRED" })],
      "2026-08-09"
    );
    const empty = groupEntitlementGrants([], "2026-08-09");

    expect(selectDefaultEntitlementType(mileageOnly, "2026-08-09")).toBe("MILEAGE");
    expect(selectDefaultEntitlementType(empty, "2026-08-09")).toBe("BENEFIT");
  });

  it("calculates numeric progress and applies exhausted and clamp rules", () => {
    expect(entitlementProgress(grantFixture({ totalAmount: 10, usedAmount: 4 }))).toBe(40);
    expect(
      entitlementProgress(grantFixture({ status: "EXHAUSTED", totalAmount: 10, usedAmount: 4 }))
    ).toBe(100);
    expect(entitlementProgress(grantFixture({ totalAmount: 10, usedAmount: 15 }))).toBe(100);
    expect(entitlementProgress(grantFixture({ totalAmount: 10, usedAmount: -2 }))).toBe(0);
  });

  it("distinguishes text and unavailable entitlements", () => {
    expect(isTextEntitlement(grantFixture({ unit: "TEXT" }))).toBe(true);
    expect(entitlementProgress(grantFixture({ unit: "TEXT" }))).toBeNull();
    expect(entitlementProgress(grantFixture({ totalAmount: null }))).toBeNull();
    expect(entitlementProgress(grantFixture({ totalAmount: 0 }))).toBeNull();
    expect(isUnavailableEntitlement(grantFixture({ status: "EXPIRED" }))).toBe(true);
    expect(isUnavailableEntitlement(grantFixture({ status: "CANCELLED" }))).toBe(true);
    expect(isUnavailableEntitlement(grantFixture({ status: "EXHAUSTED" }))).toBe(false);
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
