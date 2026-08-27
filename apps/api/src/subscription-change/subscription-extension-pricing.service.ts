import { HttpStatus, Injectable } from "@nestjs/common";
import {
  MonthlyFeeMode,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  RecordStatus,
  SubscriptionChangePricingMode,
  SubscriptionPlanStatus
} from "@prisma/client";

import { vehiclePackageSupportsModel } from "../common/vehicle-package-membership";
import { PrismaService } from "../prisma/prisma.service";
import { SubscriptionChangeError } from "./subscription-change.errors";
import { ExtensionPricingInput, ExtensionQuotePreview } from "./subscription-change.types";

const currentPlanInclude = Prisma.validator<Prisma.SubscriptionPlanInclude>()({
  benefitPackage: true,
  energyPackage: true,
  mileagePackage: true,
  product: true,
  productVersion: true,
  vehiclePackage: { include: { modelMembers: { select: { modelDefinitionId: true } } } }
});

type CurrentPlan = Prisma.SubscriptionPlanGetPayload<{ include: typeof currentPlanInclude }>;
type BaseExtensionQuotePreview = Omit<
  ExtensionQuotePreview,
  "pricingMode" | "targetEndDate" | "targetStartDate"
>;

@Injectable()
export class SubscriptionExtensionPricingService {
  constructor(private readonly prisma: PrismaService) {}

  async calculate(input: ExtensionPricingInput): Promise<ExtensionQuotePreview> {
    if (input.pricingMode === SubscriptionChangePricingMode.ORIGINAL_PRICE) {
      return withPricingContext(input, originalPrice(input));
    }

    const baseline = await this.calculateCurrentVersion(input);
    if (input.pricingMode === SubscriptionChangePricingMode.CURRENT_VERSION) {
      return withPricingContext(input, baseline);
    }

    const discounted = input.discountedMonthlyFeeAmount;
    if (discounted === undefined || discounted <= 0n || discounted > baseline.monthlyFeeAmount) {
      throw new SubscriptionChangeError(
        "APPROVED_DISCOUNT_AMOUNT_INVALID",
        "Discounted monthly fee must be greater than zero and no greater than the current-version baseline.",
        HttpStatus.BAD_REQUEST
      );
    }

    return withPricingContext(input, {
      ...baseline,
      baselineMonthlyFeeAmount: baseline.monthlyFeeAmount,
      monthlyFeeAmount: discounted,
      priceRuleSnapshot: jsonValue({
        baselineMonthlyFeeAmount: baseline.monthlyFeeAmount,
        basis: "APPROVED_DISCOUNT",
        discountedMonthlyFeeAmount: discounted,
        currentVersionRule: baseline.priceRuleSnapshot
      }),
      quoteSnapshot: jsonValue({
        ...jsonObject(baseline.quoteSnapshot),
        baselineMonthlyFeeAmount: baseline.monthlyFeeAmount,
        monthlyFeeAmount: discounted,
        pricingMode: SubscriptionChangePricingMode.APPROVED_DISCOUNT
      })
    });
  }

  private async calculateCurrentVersion(
    input: ExtensionPricingInput
  ): Promise<BaseExtensionQuotePreview> {
    if (!input.subscriptionPlanId) {
      throw new SubscriptionChangeError(
        "SUBSCRIPTION_PLAN_REQUIRED",
        "A current subscription plan is required for current-version pricing.",
        HttpStatus.BAD_REQUEST
      );
    }

    const plan = await this.prisma.subscriptionPlan.findUnique({
      include: currentPlanInclude,
      where: { id: input.subscriptionPlanId }
    });
    if (!plan || !isCurrentPlanAvailable(plan, input.asOf ?? new Date())) {
      throw new SubscriptionChangeError(
        "SUBSCRIPTION_PLAN_NOT_AVAILABLE",
        "The selected subscription plan is not currently available.",
        HttpStatus.BAD_REQUEST
      );
    }
    if (!vehiclePackageSupportsModel(plan.vehiclePackage, input.vehicle.modelDefinitionId)) {
      throw new SubscriptionChangeError(
        "SUBSCRIPTION_PLAN_VEHICLE_MODEL_MISMATCH",
        "The selected subscription plan does not apply to the leased vehicle model.",
        HttpStatus.BAD_REQUEST
      );
    }
    if (
      input.extensionMonths !== undefined &&
      (input.extensionMonths < plan.minPeriodMonths || input.extensionMonths > plan.maxPeriodMonths)
    ) {
      throw new SubscriptionChangeError(
        "EXTENSION_MONTHS_OUTSIDE_PLAN_RANGE",
        "Extension months are outside the selected plan range.",
        HttpStatus.BAD_REQUEST
      );
    }

    const salePrice = input.vehicle.currentSalePriceAmount;
    if (!salePrice || salePrice <= 0n) {
      throw new SubscriptionChangeError(
        "VEHICLE_SALE_PRICE_MISSING",
        "The leased vehicle requires an initialized sale price for current-version pricing.",
        HttpStatus.BAD_REQUEST
      );
    }

    const vehicleBase = calculateVehicleBase(plan, salePrice, input.requestedVehicleBaseFeeAmount);
    const mileagePrice = plan.mileagePackage.priceAmount;
    const energyPrice = plan.energyPackage.priceAmount;
    const benefitPrice = plan.benefitPackage?.priceAmount ?? 0n;
    const monthlyFeeAmount = vehicleBase.amount + mileagePrice + energyPrice + benefitPrice;
    const planSnapshot = jsonValue({
      benefitPackage: snapshotPackage(plan.benefitPackage),
      energyPackage: snapshotPackage(plan.energyPackage),
      mileagePackage: snapshotPackage(plan.mileagePackage),
      product: {
        id: plan.product.id,
        status: plan.product.status
      },
      productVersion: {
        id: plan.productVersion.id,
        status: plan.productVersion.status
      },
      subscriptionPlan: {
        id: plan.id,
        maxPeriodMonths: plan.maxPeriodMonths,
        minPeriodMonths: plan.minPeriodMonths,
        monthlyFeeMode: plan.monthlyFeeMode,
        planName: plan.planName,
        planNo: plan.planNo
      },
      vehiclePackage: snapshotPackage(plan.vehiclePackage)
    });
    const priceRuleSnapshot = jsonValue({
      basis: "CURRENT_VERSION",
      benefitPackagePriceAmount: benefitPrice,
      energyPackagePriceAmount: energyPrice,
      mileagePackagePriceAmount: mileagePrice,
      vehicleBaseFeeAmount: vehicleBase.amount,
      vehicleBaseFeeCapAmount: vehicleBase.cap,
      vehicleBaseFeeMode: plan.monthlyFeeMode,
      vehicleSalePriceAmount: salePrice
    });

    return {
      energyLimitCount: plan.energyPackage.monthlyEnergyCount,
      energyLimitKwh: plan.energyPackage.monthlyEnergyKwh,
      mileageLimitKm: plan.mileagePackage.monthlyMileageKm,
      monthlyFeeAmount,
      overMileageFeeAmount: plan.mileagePackage.overMileageFeeAmount,
      planSnapshot,
      priceRuleSnapshot,
      productId: plan.productId,
      productVersionId: plan.productVersionId,
      quoteSnapshot: jsonValue({
        monthlyFeeAmount,
        planSnapshot,
        priceRuleSnapshot,
        pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION
      }),
      subscriptionPlanId: plan.id
    };
  }
}

function originalPrice(input: ExtensionPricingInput): BaseExtensionQuotePreview {
  const source = input.sourceSegment;
  return {
    energyLimitCount: source.energyLimitCount,
    energyLimitKwh: source.energyLimitKwh,
    mileageLimitKm: source.mileageLimitKm,
    monthlyFeeAmount: source.monthlyFeeAmount,
    overMileageFeeAmount: source.overMileageFeeAmount,
    planSnapshot: source.planSnapshot as Prisma.InputJsonValue,
    priceRuleSnapshot: jsonValue({
      basis: "SOURCE_SEGMENT_SNAPSHOT",
      sourceSegmentId: source.id,
      sourceSubscriptionPlanId: source.subscriptionPlanId
    }),
    productId: source.productId,
    productVersionId: source.productVersionId,
    quoteSnapshot: jsonValue({
      monthlyFeeAmount: source.monthlyFeeAmount,
      pricingMode: SubscriptionChangePricingMode.ORIGINAL_PRICE,
      sourceQuoteSnapshot: source.quoteSnapshot,
      sourceSegmentId: source.id
    }),
    subscriptionPlanId: source.subscriptionPlanId
  };
}

function isCurrentPlanAvailable(plan: CurrentPlan, now: Date) {
  const businessDate = shanghaiBusinessDate(now);
  const components: Array<{
    deletedAt: Date | null;
    productId: string;
    productVersionId: string;
    status: RecordStatus;
  }> = [plan.vehiclePackage, plan.mileagePackage, plan.energyPackage];
  if (plan.benefitPackage) components.push(plan.benefitPackage);
  return (
    !plan.deletedAt &&
    plan.status === SubscriptionPlanStatus.ACTIVE &&
    plan.effectiveFrom <= businessDate &&
    (!plan.effectiveTo || plan.effectiveTo >= businessDate) &&
    !plan.product.deletedAt &&
    plan.product.status === ProductStatus.ACTIVE &&
    plan.product.productType === ProductType.SUBSCRIPTION &&
    !plan.productVersion.deletedAt &&
    plan.productVersion.status === ProductVersionStatus.ACTIVE &&
    plan.productVersion.effectiveFrom <= businessDate &&
    (!plan.productVersion.effectiveTo || plan.productVersion.effectiveTo >= businessDate) &&
    components.every(
      (component) =>
        !component.deletedAt &&
        component.status === RecordStatus.ACTIVE &&
        component.productId === plan.productId &&
        component.productVersionId === plan.productVersionId
    )
  );
}

function withPricingContext(
  input: ExtensionPricingInput,
  preview: BaseExtensionQuotePreview
): ExtensionQuotePreview {
  const targetStartDate = addUtcDays(input.sourceSegment.endDate, 1);
  const targetEndDate = addUtcDays(
    addCalendarMonths(targetStartDate, input.extensionMonths ?? 0),
    -1
  );
  return {
    ...preview,
    pricingMode: input.pricingMode,
    targetEndDate,
    targetStartDate
  };
}

function shanghaiBusinessDate(value: Date) {
  const shanghai = new Date(value.getTime() + 8 * 3_600_000);
  return new Date(
    Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate())
  );
}

function addUtcDays(value: Date, days: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function addCalendarMonths(value: Date, months: number) {
  const year = value.getUTCFullYear();
  const monthIndex = value.getUTCMonth() + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(value.getUTCDate(), lastDay)));
}

function calculateVehicleBase(plan: CurrentPlan, salePrice: bigint, requestedAmount?: bigint) {
  const packageRate = decimalRate(plan.vehiclePackage.monthlyFeeRate);
  if (!packageRate || !packageRate.isFinite() || packageRate.lte(0)) {
    throw new SubscriptionChangeError(
      "VEHICLE_BASE_FEE_CAP_RATE_INVALID",
      "Vehicle package monthly-fee cap rate must be positive.",
      HttpStatus.BAD_REQUEST
    );
  }
  const cap = multiplyMoneyByRateFloor(salePrice, packageRate);
  let amount: bigint;
  switch (plan.monthlyFeeMode) {
    case MonthlyFeeMode.FIXED_AMOUNT:
      amount = plan.baseMonthlyFeeAmount ?? 0n;
      break;
    case MonthlyFeeMode.RATE_FORMULA: {
      const rate = decimalRate(plan.monthlyFeeRate ?? plan.vehiclePackage.monthlyFeeRate);
      if (!rate || !rate.isFinite() || rate.lte(0) || rate.gt(packageRate)) {
        throw new SubscriptionChangeError(
          "VEHICLE_BASE_FEE_RATE_INVALID",
          "Vehicle base monthly-fee rate must be positive and within the vehicle-package cap rate.",
          HttpStatus.BAD_REQUEST
        );
      }
      amount = multiplyMoneyByRateFloor(salePrice, rate);
      break;
    }
    case MonthlyFeeMode.MANUAL_QUOTE:
      amount = requestedAmount ?? 0n;
      break;
    default:
      amount = 0n;
  }
  if (amount <= 0n || amount > cap) {
    throw new SubscriptionChangeError(
      "VEHICLE_BASE_FEE_INVALID",
      "Vehicle base monthly fee must be positive and within the vehicle-package cap.",
      HttpStatus.BAD_REQUEST
    );
  }
  return { amount, cap };
}

function decimalRate(value: unknown) {
  try {
    const text =
      value && typeof value === "object" && "toString" in value
        ? (value as { toString(): string }).toString()
        : String(value);
    return new Prisma.Decimal(text);
  } catch {
    return null;
  }
}

function multiplyMoneyByRateFloor(amount: bigint, rate: Prisma.Decimal) {
  return BigInt(new Prisma.Decimal(amount.toString()).mul(rate).floor().toFixed(0));
}

function snapshotPackage(value: null | Record<string, unknown>) {
  if (!value) return null;
  const allowed = [
    "id",
    "benefitCount",
    "benefitType",
    "description",
    "packageName",
    "packageNo",
    "priceAmount",
    "monthlyMileageKm",
    "overMileageFeeAmount",
    "monthlyEnergyKwh",
    "monthlyEnergyCount",
    "modelDefinitionId"
  ];
  return Object.fromEntries(allowed.filter((key) => key in value).map((key) => [key, value[key]]));
}

function jsonObject(value: Prisma.InputJsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item))
  ) as Prisma.InputJsonValue;
}
