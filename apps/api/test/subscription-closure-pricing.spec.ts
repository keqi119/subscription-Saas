import { describe, expect, it } from "vitest";

import {
  acceptedDisputeRepricingDeltaItemIds,
  governedChargeFactsForDeltaItem,
  priceClosureCharge
} from "../src/subscription-closure/subscription-closure-pricing.service";

describe("closure contract pricing", () => {
  it("detects an accepted dispute even when pricing moves to a successor settlement", () => {
    expect(
      acceptedDisputeRepricingDeltaItemIds(
        ["delta-accepted", "delta-chargeable"],
        ["delta-accepted"]
      )
    ).toEqual(["delta-accepted"]);
    expect(
      acceptedDisputeRepricingDeltaItemIds(["delta-chargeable"], ["delta-accepted"])
    ).toEqual([]);
  });

  it("derives charge types and quantities from authoritative delta facts", () => {
    expect(
      governedChargeFactsForDeltaItem({
        itemCode: "MILEAGE",
        quantityDifference: 3200,
        responsibility: "CUSTOMER",
        wearClassification: "MANUAL_REVIEW"
      })
    ).toEqual({ chargeType: "OVER_MILEAGE", quantity: 3200 });
    expect(
      governedChargeFactsForDeltaItem({
        itemCode: "KEY",
        quantityDifference: -1,
        responsibility: "CUSTOMER",
        wearClassification: "MISSING"
      })
    ).toEqual({ chargeType: "MISSING_KEY", quantity: 1 });
    expect(
      governedChargeFactsForDeltaItem({
        itemCode: "VEHICLE_EXTERIOR",
        quantityDifference: 0,
        responsibility: "CUSTOMER",
        wearClassification: "NEW_DAMAGE"
      })
    ).toEqual({ chargeType: "DAMAGE_VEHICLE_EXTERIOR", quantity: 1 });
  });

  it("prices from the immutable clause with integer-cent rounding", () => {
    expect(
      priceClosureCharge({
        chargeType: "MISSING_KEY",
        clause: {
          clauseCode: "MISSING_KEY",
          pricingSnapshot: { capCents: 30000, unitPriceCents: 12000 },
          status: "EXECUTABLE"
        },
        evidenceIds: ["evidence-1"],
        quantity: 3
      })
    ).toMatchObject({ amountCents: 30000n, status: "FINAL", unitPriceCents: 12000n });
  });

  it("creates an exception rather than using a default price", () => {
    expect(
      priceClosureCharge({
        chargeType: "DAMAGE",
        clause: null,
        evidenceIds: ["evidence-1"],
        quantity: 1
      })
    ).toMatchObject({ amountCents: 0n, status: "PRICING_EXCEPTION" });
  });

  it("requires governed evidence for a customer-responsible charge", () => {
    expect(() =>
      priceClosureCharge({
        chargeType: "DAMAGE",
        clause: {
          clauseCode: "DAMAGE",
          pricingSnapshot: { unitPriceCents: 50000 },
          status: "EXECUTABLE"
        },
        evidenceIds: [],
        quantity: 1
      })
    ).toThrow("GOVERNED_EVIDENCE_REQUIRED");
  });

  it("only prices mileage above the immutable included quantity", () => {
    expect(
      priceClosureCharge({
        chargeType: "OVER_MILEAGE",
        clause: {
          clauseCode: "OVER_MILEAGE",
          pricingSnapshot: { includedQuantity: 18_000, unitPriceCents: 125 },
          status: "EXECUTABLE"
        },
        evidenceIds: ["evidence-1"],
        quantity: 19_250
      })
    ).toMatchObject({ amountCents: 156250n, status: "FINAL", unitPriceCents: 125n });
  });

  it("prices final mileage as a true-up after prior valid mileage bills", () => {
    expect(
      priceClosureCharge({
        chargeType: "OVER_MILEAGE",
        clause: {
          clauseCode: "OVER_MILEAGE",
          pricingSnapshot: { includedQuantity: 18_000, unitPriceCents: 100 },
          status: "EXECUTABLE"
        },
        evidenceIds: ["return-mileage"],
        priorBilledAmountCents: 50_000n,
        priorBillIds: ["monthly-mileage-bill"],
        quantity: 19_000
      })
    ).toMatchObject({ amountCents: 50_000n, status: "FINAL" });
  });
});
