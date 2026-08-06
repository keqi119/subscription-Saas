import {
  MonthlyFeeMode,
  ProductStatus,
  ProductVersionStatus,
  RecordStatus,
  SubscriptionChangePricingMode,
  SubscriptionPlanStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionExtensionPricingService } from "../src/subscription-change/subscription-extension-pricing.service";

describe("SubscriptionExtensionPricingService", () => {
  it("prices an ACTIVE current-version plan without requiring the leased vehicle to be saleable", async () => {
    const prisma = pricingPrisma();
    const service = new SubscriptionExtensionPricingService(prisma as never);

    const result = await service.calculate({
      pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
      sourceSegment: sourceSegment(),
      subscriptionPlanId: "plan-current",
      vehicle: leasedVehicle()
    });

    expect(result.monthlyFeeAmount).toBe(97_000n);
    expect(result.mileageLimitKm).toBe(1_800);
    expect(result.subscriptionPlanId).toBe("plan-current");
    expect(result.planSnapshot).toMatchObject({
      benefitPackage: {
        benefitCount: 2,
        benefitType: "WASH_CAR",
        description: "每月 2 次洗车权益"
      }
    });
    expect(prisma.vehicle.findFirst).not.toHaveBeenCalled();
  });

  it("uses the immutable source segment facts for ORIGINAL_PRICE even when old master data is inactive", async () => {
    const prisma = pricingPrisma();
    const service = new SubscriptionExtensionPricingService(prisma as never);

    const result = await service.calculate({
      pricingMode: SubscriptionChangePricingMode.ORIGINAL_PRICE,
      sourceSegment: sourceSegment(),
      vehicle: leasedVehicle()
    });

    expect(result.monthlyFeeAmount).toBe(88_000n);
    expect(result.planSnapshot).toEqual({ source: "archived-plan" });
    expect(result.priceRuleSnapshot).toMatchObject({ basis: "SOURCE_SEGMENT_SNAPSHOT" });
    expect(prisma.subscriptionPlan.findUnique).not.toHaveBeenCalled();
  });

  it("accepts a positive approved discount not exceeding the current-version baseline", async () => {
    const service = new SubscriptionExtensionPricingService(pricingPrisma() as never);

    await expect(
      service.calculate({
        discountedMonthlyFeeAmount: 90_000n,
        pricingMode: SubscriptionChangePricingMode.APPROVED_DISCOUNT,
        sourceSegment: sourceSegment(),
        subscriptionPlanId: "plan-current",
        vehicle: leasedVehicle()
      })
    ).resolves.toMatchObject({
      baselineMonthlyFeeAmount: 97_000n,
      monthlyFeeAmount: 90_000n
    });
  });

  it.each([0n, 97_001n])("rejects invalid approved-discount amount %s", async (amount) => {
    const service = new SubscriptionExtensionPricingService(pricingPrisma() as never);

    await expect(
      service.calculate({
        discountedMonthlyFeeAmount: amount,
        pricingMode: SubscriptionChangePricingMode.APPROVED_DISCOUNT,
        sourceSegment: sourceSegment(),
        subscriptionPlanId: "plan-current",
        vehicle: leasedVehicle()
      })
    ).rejects.toMatchObject({ code: "APPROVED_DISCOUNT_AMOUNT_INVALID" });
  });

  it("rejects a current plan whose vehicle package targets another model", async () => {
    const prisma = pricingPrisma({ modelDefinitionId: "model-other" });
    const service = new SubscriptionExtensionPricingService(prisma as never);

    await expect(
      service.calculate({
        pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
        sourceSegment: sourceSegment(),
        subscriptionPlanId: "plan-current",
        vehicle: leasedVehicle()
      })
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_VEHICLE_MODEL_MISMATCH" });
  });

  it("keeps a plan available through the end of its Shanghai effective date", async () => {
    const service = new SubscriptionExtensionPricingService(
      pricingPrisma({ effectiveTo: new Date("2026-08-05T00:00:00.000Z") }) as never
    );

    await expect(
      service.calculate({
        asOf: new Date("2026-08-05T15:59:59.000Z"),
        pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
        sourceSegment: sourceSegment(),
        subscriptionPlanId: "plan-current",
        vehicle: leasedVehicle()
      })
    ).resolves.toMatchObject({ monthlyFeeAmount: 97_000n });
  });

  it("calculates rate-formula money exactly without floating-point floor loss", async () => {
    const rate = { toNumber: () => 0.009, toString: () => "0.009" };
    const capRate = { toNumber: () => 0.02, toString: () => "0.02" };
    const service = new SubscriptionExtensionPricingService(
      pricingPrisma({
        monthlyFeeMode: MonthlyFeeMode.RATE_FORMULA,
        monthlyFeeRate: rate,
        vehiclePackageMonthlyFeeRate: capRate
      }) as never
    );

    const result = await service.calculate({
      pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
      sourceSegment: sourceSegment(),
      subscriptionPlanId: "plan-current",
      vehicle: leasedVehicle({ currentSalePriceAmount: 3_000n })
    });

    expect(result.monthlyFeeAmount).toBe(17_027n);
    expect(result.priceRuleSnapshot).toMatchObject({ vehicleBaseFeeAmount: "27" });
  });
});

function pricingPrisma(
  options: {
    effectiveTo?: Date | null;
    modelDefinitionId?: string;
    monthlyFeeMode?: MonthlyFeeMode;
    monthlyFeeRate?: { toNumber(): number; toString(): string };
    vehiclePackageMonthlyFeeRate?: { toNumber(): number; toString(): string };
  } = {}
) {
  const now = new Date("2026-08-05T04:00:00.000Z");
  const product = {
    deletedAt: null,
    id: "product-current",
    productType: "SUBSCRIPTION",
    status: ProductStatus.ACTIVE
  };
  const productVersion = {
    deletedAt: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: options.effectiveTo ?? null,
    id: "version-current",
    productId: product.id,
    status: ProductVersionStatus.ACTIVE
  };
  const component = {
    deletedAt: null,
    productId: product.id,
    productVersionId: productVersion.id,
    status: RecordStatus.ACTIVE
  };
  const plan = {
    baseMonthlyFeeAmount: 80_000n,
    benefitPackage: {
      ...component,
      benefitCount: 2,
      benefitType: "WASH_CAR",
      description: "每月 2 次洗车权益",
      id: "benefit-current",
      packageName: "Benefit",
      priceAmount: 2_000n
    },
    deletedAt: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    energyPackage: {
      ...component,
      id: "energy-current",
      monthlyEnergyCount: null,
      monthlyEnergyKwh: 4,
      packageName: "Energy",
      priceAmount: 5_000n
    },
    id: "plan-current",
    maxPeriodMonths: 24,
    mileagePackage: {
      ...component,
      id: "mileage-current",
      monthlyMileageKm: 1_800,
      overMileageFeeAmount: 125n,
      packageName: "Mileage",
      priceAmount: 10_000n
    },
    minPeriodMonths: 1,
    monthlyFeeMode: options.monthlyFeeMode ?? MonthlyFeeMode.FIXED_AMOUNT,
    monthlyFeeRate: options.monthlyFeeRate ?? { toNumber: () => 0.02, toString: () => "0.02" },
    planName: "Current plan",
    planNo: "PLAN-CURRENT",
    product,
    productId: product.id,
    productVersion,
    productVersionId: productVersion.id,
    status: SubscriptionPlanStatus.ACTIVE,
    vehiclePackage: {
      ...component,
      id: "vehicle-package-current",
      modelDefinitionId: options.modelDefinitionId ?? "model-et5",
      monthlyFeeRate: options.vehiclePackageMonthlyFeeRate ?? {
        toNumber: () => 0.03,
        toString: () => "0.03"
      },
      packageName: "Vehicle"
    }
  };

  return {
    subscriptionPlan: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === plan.id ? plan : null
      )
    },
    vehicle: { findFirst: vi.fn() },
    now
  };
}

function sourceSegment() {
  return {
    endDate: new Date("2026-09-02T00:00:00.000Z"),
    energyLimitCount: 2,
    energyLimitKwh: null,
    id: "segment-base",
    mileageLimitKm: 1_500,
    monthlyFeeAmount: 88_000n,
    orderId: "order-1",
    overMileageFeeAmount: 100n,
    planSnapshot: { source: "archived-plan" },
    productId: "product-old",
    productVersionId: "version-old",
    quoteSnapshot: { quoteNo: "QUO-OLD" },
    subscriptionPlanId: "plan-old"
  } as never;
}

function leasedVehicle(overrides: Record<string, unknown> = {}) {
  return {
    currentSalePriceAmount: 20_000_000n,
    id: "vehicle-1",
    modelDefinitionId: "model-et5",
    purchasePriceAmount: 18_000_000n,
    status: "LEASED",
    ...overrides
  };
}
