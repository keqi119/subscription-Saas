import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma, SubscriptionChangePricingMode } from "@prisma/client";
import { createHash } from "node:crypto";

import { vehiclePackageSupportsModel } from "../common/vehicle-package-membership";
import { PrismaService } from "../prisma/prisma.service";
import { SubscriptionChangeError } from "./subscription-change.errors";
import { VehicleSwapPricingInput, VehicleSwapQuotePreview } from "./subscription-change.types";
import { SubscriptionExtensionPricingService } from "./subscription-extension-pricing.service";

const planMembershipSelect = Prisma.validator<Prisma.SubscriptionPlanSelect>()({
  id: true,
  vehiclePackage: {
    select: {
      id: true,
      modelMembers: { select: { modelDefinitionId: true } }
    }
  },
  vehiclePackageId: true
});

@Injectable()
export class SubscriptionVehicleSwapPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly extensionPricing: SubscriptionExtensionPricingService
  ) {}

  async calculate(input: VehicleSwapPricingInput): Promise<VehicleSwapQuotePreview> {
    const [sourcePlan, targetPlan] = await Promise.all([
      input.sourceSegment.subscriptionPlanId
        ? this.prisma.subscriptionPlan.findUnique({
            select: planMembershipSelect,
            where: { id: input.sourceSegment.subscriptionPlanId }
          })
        : Promise.resolve(null),
      this.prisma.subscriptionPlan.findUnique({
        select: planMembershipSelect,
        where: { id: input.targetSubscriptionPlanId }
      })
    ]);

    if (!targetPlan) {
      throw new SubscriptionChangeError(
        "TARGET_SUBSCRIPTION_PLAN_NOT_FOUND",
        "The target subscription plan was not found.",
        HttpStatus.NOT_FOUND
      );
    }
    if (targetPlan.vehiclePackageId !== input.targetVehiclePackageId) {
      throw new SubscriptionChangeError(
        "TARGET_SUBSCRIPTION_PLAN_CHANGED",
        "The target subscription plan no longer belongs to the selected vehicle package."
      );
    }
    if (
      !vehiclePackageSupportsModel(targetPlan.vehiclePackage, input.targetVehicle.modelDefinitionId)
    ) {
      throw new SubscriptionChangeError(
        "TARGET_VEHICLE_MODEL_NOT_IN_PACKAGE",
        "The target vehicle model is not a member of the selected vehicle package.",
        HttpStatus.BAD_REQUEST
      );
    }

    const packageIncluded =
      sourcePlan !== null &&
      sourcePlan.id === input.targetSubscriptionPlanId &&
      sourcePlan.vehiclePackageId === input.targetVehiclePackageId;
    const targetCommercials = packageIncluded
      ? sourceCommercials(input)
      : {
          ...(await this.extensionPricing.calculate({
            asOf: input.plannedSwapAt,
            pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
            sourceSegment: input.sourceSegment,
            subscriptionPlanId: input.targetSubscriptionPlanId,
            vehicle: input.targetVehicle
          })),
          depositAmount: input.currentDepositAmount
        };
    const classification = packageIncluded ? "PACKAGE_INCLUDED" : "OUT_OF_PACKAGE";
    const pricingMode = packageIncluded
      ? SubscriptionChangePricingMode.ORIGINAL_PRICE
      : SubscriptionChangePricingMode.CURRENT_VERSION;
    const commercialSnapshot = jsonValue({
      classification,
      deltas: {
        depositAmount: money(targetCommercials.depositAmount - input.currentDepositAmount),
        energyLimitCount: nullableDelta(
          targetCommercials.energyLimitCount,
          input.sourceSegment.energyLimitCount
        ),
        energyLimitKwh: nullableDelta(
          targetCommercials.energyLimitKwh,
          input.sourceSegment.energyLimitKwh
        ),
        mileageLimitKm: targetCommercials.mileageLimitKm - input.sourceSegment.mileageLimitKm,
        monthlyFeeAmount: money(
          targetCommercials.monthlyFeeAmount - input.sourceSegment.monthlyFeeAmount
        )
      },
      plannedSwapAt: input.plannedSwapAt.toISOString(),
      schemaVersion: 1,
      source: {
        depositAmount: money(input.currentDepositAmount),
        segmentId: input.sourceSegment.id,
        subscriptionPlanId: input.sourceSegment.subscriptionPlanId,
        vehicleId: input.sourceVehicle.id
      },
      target: {
        depositAmount: money(targetCommercials.depositAmount),
        subscriptionPlanId: input.targetSubscriptionPlanId,
        vehicleId: input.targetVehicle.id,
        vehiclePackageId: input.targetVehiclePackageId
      }
    });
    const commercialSnapshotHash = stableHash(commercialSnapshot);

    return {
      classification,
      commercialSnapshot,
      commercialSnapshotHash,
      depositAmount: targetCommercials.depositAmount,
      depositDeltaAmount: targetCommercials.depositAmount - input.currentDepositAmount,
      energyLimitCount: targetCommercials.energyLimitCount,
      energyLimitCountDelta: nullableDelta(
        targetCommercials.energyLimitCount,
        input.sourceSegment.energyLimitCount
      ),
      energyLimitKwh: targetCommercials.energyLimitKwh,
      energyLimitKwhDelta: nullableDelta(
        targetCommercials.energyLimitKwh,
        input.sourceSegment.energyLimitKwh
      ),
      mileageLimitDeltaKm: targetCommercials.mileageLimitKm - input.sourceSegment.mileageLimitKm,
      mileageLimitKm: targetCommercials.mileageLimitKm,
      monthlyFeeAmount: targetCommercials.monthlyFeeAmount,
      monthlyFeeDeltaAmount:
        targetCommercials.monthlyFeeAmount - input.sourceSegment.monthlyFeeAmount,
      overMileageFeeAmount: targetCommercials.overMileageFeeAmount,
      planSnapshot: targetCommercials.planSnapshot,
      priceRuleSnapshot: targetCommercials.priceRuleSnapshot,
      pricingMode,
      productId: targetCommercials.productId,
      productVersionId: targetCommercials.productVersionId,
      quoteSnapshot: jsonValue({
        commercialSnapshot,
        commercialSnapshotHash,
        pricingMode,
        targetPricing: targetCommercials.quoteSnapshot
      }),
      targetSubscriptionPlanId: input.targetSubscriptionPlanId,
      targetVehiclePackageId: input.targetVehiclePackageId
    };
  }
}

function sourceCommercials(input: VehicleSwapPricingInput) {
  return {
    depositAmount: input.currentDepositAmount,
    energyLimitCount: input.sourceSegment.energyLimitCount,
    energyLimitKwh: input.sourceSegment.energyLimitKwh,
    mileageLimitKm: input.sourceSegment.mileageLimitKm,
    monthlyFeeAmount: input.sourceSegment.monthlyFeeAmount,
    overMileageFeeAmount: input.sourceSegment.overMileageFeeAmount,
    planSnapshot: input.sourceSegment.planSnapshot as Prisma.InputJsonValue,
    priceRuleSnapshot: jsonValue({
      basis: "SOURCE_SEGMENT_PACKAGE_INCLUDED",
      sourceSegmentId: input.sourceSegment.id
    }),
    productId: input.sourceSegment.productId,
    productVersionId: input.sourceSegment.productVersionId,
    quoteSnapshot: jsonValue({
      basis: "SOURCE_SEGMENT_PACKAGE_INCLUDED",
      sourceQuoteSnapshot: input.sourceSegment.quoteSnapshot,
      sourceSegmentId: input.sourceSegment.id
    })
  };
}

function nullableDelta(target: number | null, source: number | null) {
  return target === null || source === null ? null : target - source;
}

function money(value: bigint) {
  return value.toString();
}

function stableHash(value: Prisma.InputJsonValue) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
