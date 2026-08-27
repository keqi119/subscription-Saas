import { describe, expect, it } from "vitest";

import {
  canonicalJourneyJson,
  commercialPlanHash,
  commercialPlanSnapshot,
  sameJourneyJson
} from "../src/subscription-journey/subscription-journey-json";

describe("subscription journey canonical JSON", () => {
  it("normalizes object keys recursively while preserving array order", () => {
    const value = canonicalJourneyJson({
      z: [{ second: 2, first: 1 }, "tail"],
      a: { beta: true, alpha: null }
    });

    expect(JSON.stringify(value)).toBe(
      '{"a":{"alpha":null,"beta":true},"z":[{"first":1,"second":2},"tail"]}'
    );
    expect(sameJourneyJson({ nested: { b: 2, a: 1 } }, { nested: { a: 1, b: 2 } })).toBe(
      true
    );
    expect(sameJourneyJson(["first", "second"], ["second", "first"])).toBe(false);
    expect(canonicalJourneyJson(null)).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["undefined property", { invalid: undefined }],
    ["bigint", 1n],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["Date", new Date("2026-08-26T00:00:00.000Z")],
    ["function", () => undefined]
  ])("rejects unsupported JSON value: %s", (_label, value) => {
    expect(() => canonicalJourneyJson(value)).toThrow(/valid JSON/i);
  });
});

describe("subscription journey commercial-plan hashing", () => {
  it("produces the same stable sha256 hash after PostgreSQL JSONB key reordering", () => {
    const left = commercialFixture();
    const right = {
      ...left,
      pricing: { depositAmount: 300_000, monthlyFeeAmount: 4_999 },
      packageSnapshot: {
        mileagePackage: { monthlyLimitKm: 2_000, packageVersion: 3 },
        energyPackage: { monthlyEnergyKwh: 300, packageVersion: 2 }
      }
    };

    expect(commercialPlanHash(left)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(commercialPlanHash(right)).toBe(commercialPlanHash(left));
  });

  it.each([
    ["price", { pricing: { depositAmount: 300_000, monthlyFeeAmount: 5_000 } }],
    ["period", { periodMonths: 24 }],
    ["package", { subscriptionPlanId: "plan-2" }],
    ["entitlement", { entitlementSnapshot: { monthlyEnergyKwh: 301 } }],
    ["deposit", { depositAmount: 300_001 }],
    ["vehicle", { vehicleId: "vehicle-2" }],
    ["effective date", { effectiveDate: "2026-10-01" }],
    ["contract version", { contractVersionId: "contract-version-2" }]
  ])("detects a real commercial change: %s", (_label, change) => {
    expect(commercialPlanHash({ ...commercialFixture(), ...change })).not.toBe(
      commercialPlanHash(commercialFixture())
    );
  });

  it("excludes workflow timestamps, audit fields, and internal soft-lock state", () => {
    const snapshot = commercialPlanSnapshot({
      ...commercialFixture(),
      finalPlanConfirmedAt: "2026-08-26T12:00:00.000Z",
      softReservedVehicleId: "internal-lock",
      updatedBy: "operator-1"
    });

    expect(snapshot).not.toHaveProperty("finalPlanConfirmedAt");
    expect(snapshot).not.toHaveProperty("softReservedVehicleId");
    expect(snapshot).not.toHaveProperty("updatedBy");
  });
});

function commercialFixture() {
  return {
    contractVersionId: "contract-version-1",
    depositAmount: 300_000,
    effectiveDate: "2026-09-01",
    entitlementSnapshot: { monthlyEnergyKwh: 300 },
    packageSnapshot: {
      energyPackage: { packageVersion: 2, monthlyEnergyKwh: 300 },
      mileagePackage: { packageVersion: 3, monthlyLimitKm: 2_000 }
    },
    periodMonths: 12,
    pricing: { monthlyFeeAmount: 4_999, depositAmount: 300_000 },
    subscriptionPlan: { planVersion: 4, planNo: "PLAN-1" },
    subscriptionPlanId: "plan-1",
    vehicleId: "vehicle-1",
    vehicleSnapshot: { model: "ET5", plateNo: "沪A00001", vin: "VIN-1" }
  };
}
