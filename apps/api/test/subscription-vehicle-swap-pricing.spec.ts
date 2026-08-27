import { SubscriptionChangePricingMode } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionVehicleSwapPricingService } from "../src/subscription-change/subscription-vehicle-swap-pricing.service";

describe("SubscriptionVehicleSwapPricingService", () => {
  it("keeps signed commercial terms for an original-package member", async () => {
    const harness = pricingHarness({
      sourceMemberIds: ["model-et5", "model-es6"]
    });

    const result = await harness.service.calculate(
      pricingInput({ targetModelDefinitionId: "model-es6" })
    );

    expect(result).toMatchObject({
      classification: "PACKAGE_INCLUDED",
      depositAmount: 300_000n,
      depositDeltaAmount: 0n,
      mileageLimitDeltaKm: 0,
      monthlyFeeAmount: 88_000n,
      monthlyFeeDeltaAmount: 0n,
      pricingMode: SubscriptionChangePricingMode.ORIGINAL_PRICE,
      targetSubscriptionPlanId: "plan-source"
    });
    expect(result.commercialSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.extensionPricing.calculate).not.toHaveBeenCalled();
  });

  it("quotes target-plan commercial deltas for an out-of-package swap", async () => {
    const harness = pricingHarness({
      currentVersionPricing: {
        energyLimitCount: 8,
        energyLimitKwh: null,
        mileageLimitKm: 2_000,
        monthlyFeeAmount: 105_000n,
        overMileageFeeAmount: 130n,
        planSnapshot: { plan: "target" },
        priceRuleSnapshot: { basis: "CURRENT_VERSION" },
        productId: "product-target",
        productVersionId: "version-target",
        quoteSnapshot: { monthlyFeeAmount: "105000" },
        subscriptionPlanId: "plan-target"
      }
    });

    const result = await harness.service.calculate(
      pricingInput({
        targetSubscriptionPlanId: "plan-target",
        targetVehiclePackageId: "package-target"
      })
    );

    expect(result).toMatchObject({
      classification: "OUT_OF_PACKAGE",
      depositDeltaAmount: 0n,
      energyLimitCountDelta: 4,
      mileageLimitDeltaKm: 500,
      monthlyFeeAmount: 105_000n,
      monthlyFeeDeltaAmount: 17_000n,
      pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
      targetSubscriptionPlanId: "plan-target"
    });
    expect(harness.extensionPricing.calculate).toHaveBeenCalledWith(
      expect.objectContaining({
        pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
        subscriptionPlanId: "plan-target",
        vehicle: expect.objectContaining({ id: "vehicle-target" })
      })
    );
  });

  it("rejects a target vehicle outside the selected original package membership", async () => {
    const harness = pricingHarness({ sourceMemberIds: ["model-et5"] });

    await expect(
      harness.service.calculate(pricingInput({ targetModelDefinitionId: "model-es6" }))
    ).rejects.toMatchObject({ code: "TARGET_VEHICLE_MODEL_NOT_IN_PACKAGE" });
    expect(harness.extensionPricing.calculate).not.toHaveBeenCalled();
  });
});

function pricingHarness(
  options: {
    currentVersionPricing?: Record<string, unknown>;
    sourceMemberIds?: string[];
  } = {}
) {
  const prisma = {
    subscriptionPlan: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "plan-source"
          ? {
              id: "plan-source",
              vehiclePackage: {
                id: "package-source",
                modelMembers: (options.sourceMemberIds ?? ["model-et5"]).map(
                  (modelDefinitionId) => ({ modelDefinitionId })
                )
              },
              vehiclePackageId: "package-source"
            }
          : where.id === "plan-target"
            ? {
                id: "plan-target",
                vehiclePackage: {
                  id: "package-target",
                  modelMembers: [{ modelDefinitionId: "model-et5" }]
                },
                vehiclePackageId: "package-target"
              }
            : null
      )
    }
  };
  const extensionPricing = {
    calculate: vi.fn(async () => ({
      energyLimitCount: 8,
      energyLimitKwh: null,
      mileageLimitKm: 2_000,
      monthlyFeeAmount: 105_000n,
      overMileageFeeAmount: 130n,
      planSnapshot: { plan: "target" },
      priceRuleSnapshot: { basis: "CURRENT_VERSION" },
      pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
      productId: "product-target",
      productVersionId: "version-target",
      quoteSnapshot: { monthlyFeeAmount: "105000" },
      subscriptionPlanId: "plan-target",
      targetEndDate: new Date("2026-09-01T00:00:00.000Z"),
      targetStartDate: new Date("2026-09-01T00:00:00.000Z"),
      ...options.currentVersionPricing
    }))
  };
  return {
    extensionPricing,
    service: new SubscriptionVehicleSwapPricingService(prisma as never, extensionPricing as never)
  };
}

function pricingInput(overrides: Record<string, unknown> = {}) {
  const targetModelDefinitionId =
    (overrides.targetModelDefinitionId as string | undefined) ?? "model-et5";
  const inputOverrides = { ...overrides };
  delete inputOverrides.targetModelDefinitionId;
  return {
    currentDepositAmount: 300_000n,
    plannedSwapAt: new Date("2026-09-15T02:00:00.000Z"),
    sourceSegment: {
      energyLimitCount: 4,
      energyLimitKwh: null,
      id: "segment-source",
      mileageLimitKm: 1_500,
      monthlyFeeAmount: 88_000n,
      overMileageFeeAmount: 100n,
      planSnapshot: { plan: "source" },
      productId: "product-source",
      productVersionId: "version-source",
      quoteSnapshot: { quote: "source" },
      subscriptionPlanId: "plan-source"
    },
    sourceVehicle: {
      currentSalePriceAmount: 18_000_000n,
      id: "vehicle-source",
      modelDefinitionId: "model-et5",
      purchasePriceAmount: 18_000_000n,
      status: "LEASED"
    },
    targetSubscriptionPlanId: "plan-source",
    targetVehicle: {
      currentSalePriceAmount: 20_000_000n,
      id: "vehicle-target",
      modelDefinitionId: targetModelDefinitionId,
      purchasePriceAmount: 20_000_000n,
      status: "AVAILABLE"
    },
    targetVehiclePackageId: "package-source",
    ...inputOverrides
  } as never;
}
