import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  MonthlyFeeMode,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  RecordStatus,
  SalePriceStatus,
  SubscriptionPlanStatus,
  VehicleBatteryUsageType,
  VehicleStatus
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { PortalVehicleCatalogQueryDto } from "./portal-catalog.dto";

const portalSubscriptionPlanInclude = {
  benefitPackage: true,
  energyPackage: true,
  mileagePackage: true,
  product: {
    select: {
      deletedAt: true,
      id: true,
      productType: true,
      status: true
    }
  },
  productVersion: {
    select: {
      deletedAt: true,
      id: true,
      productId: true,
      status: true
    }
  },
  vehiclePackage: true
} satisfies Prisma.SubscriptionPlanInclude;

type PortalSubscriptionPlan = Prisma.SubscriptionPlanGetPayload<{
  include: typeof portalSubscriptionPlanInclude;
}>;

type PortalVehicle = Prisma.VehicleGetPayload<Record<string, never>>;

@Injectable()
export class PortalCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listVehicles(query: PortalVehicleCatalogQueryDto = {}) {
    const vehicles = await this.prisma.vehicle.findMany({
      orderBy: { createdAt: "desc" },
      where: {
        currentSalePriceAmount: { gt: 0 },
        deletedAt: null,
        salePriceStatus: SalePriceStatus.EFFECTIVE,
        status: VehicleStatus.AVAILABLE,
        ...(query.brand ? { brand: { contains: query.brand, mode: "insensitive" } } : {}),
        ...(query.series ? { series: { contains: query.series, mode: "insensitive" } } : {}),
        ...(query.model ? { model: { contains: query.model, mode: "insensitive" } } : {}),
        ...(query.city ? { assetLocation: { contains: query.city, mode: "insensitive" } } : {})
      }
    });

    return vehicles.map(toPortalVehicleListItem);
  }

  async getVehicle(id: string) {
    const vehicle = await this.findAvailableVehicle(id);
    const plans = await this.findAvailablePlansForVehicle(vehicle);

    return {
      ...toPortalVehicleDetail(vehicle),
      subscriptionPlans: plans.map((plan) => toPortalSubscriptionPlanView(plan, vehicle))
    };
  }

  async listSubscriptionPlans() {
    const plans = await this.findAvailablePlans();
    return plans.map((plan) => toPortalSubscriptionPlanView(plan));
  }

  async listVehicleSubscriptionPlans(vehicleId: string) {
    const vehicle = await this.findAvailableVehicle(vehicleId);
    const plans = await this.findAvailablePlansForVehicle(vehicle);
    return plans.map((plan) => toPortalSubscriptionPlanView(plan, vehicle));
  }

  private async findAvailableVehicle(id: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        currentSalePriceAmount: { gt: 0 },
        deletedAt: null,
        id,
        salePriceStatus: SalePriceStatus.EFFECTIVE,
        status: VehicleStatus.AVAILABLE
      }
    });

    if (!vehicle) {
      throw new NotFoundException("商品车辆不存在或暂不可申请。");
    }

    return vehicle;
  }

  private async findAvailablePlansForVehicle(vehicle: PortalVehicle) {
    if (!vehicle.vehicleModel) {
      return [];
    }

    return this.findAvailablePlans({
      vehiclePackage: { vehicleModel: vehicle.vehicleModel }
    });
  }

  private async findAvailablePlans(extraWhere: Prisma.SubscriptionPlanWhereInput = {}) {
    const today = new Date();
    const plans = await this.prisma.subscriptionPlan.findMany({
      include: portalSubscriptionPlanInclude,
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
        product: {
          deletedAt: null,
          productType: ProductType.SUBSCRIPTION,
          status: ProductStatus.ACTIVE
        },
        productVersion: {
          deletedAt: null,
          status: ProductVersionStatus.ACTIVE
        },
        status: SubscriptionPlanStatus.ACTIVE,
        ...extraWhere
      }
    });

    return plans.filter(isPortalSubscriptionPlanAvailable);
  }
}

function toPortalVehicleListItem(vehicle: PortalVehicle) {
  return {
    available: true,
    batteryCapacityKwh: decimalToNumber(vehicle.batteryCapacityKwh),
    batteryUsageType: vehicle.batteryUsageType,
    batteryUsageTypeLabel: VEHICLE_BATTERY_USAGE_TYPE_LABELS[vehicle.batteryUsageType],
    brand: vehicle.brand,
    city: vehicle.assetLocation,
    coverImageUrl: null,
    currentMileageKm: vehicle.currentMileageKm,
    displayName: buildVehicleDisplayName(vehicle),
    gallery: [],
    id: vehicle.id,
    model: vehicle.model,
    modelYear: vehicle.modelYear,
    series: vehicle.series,
    statusLabel: "可申请",
    tags: buildVehicleTags(vehicle)
  };
}

function toPortalVehicleDetail(vehicle: PortalVehicle) {
  return {
    ...toPortalVehicleListItem(vehicle),
    depositNotice: "押金金额将根据审核结果最终确认。",
    submitButtonText: "提交审核"
  };
}

function toPortalSubscriptionPlanView(plan: PortalSubscriptionPlan, vehicle?: PortalVehicle) {
  const pricing = vehicle ? calculateEstimatedMonthlyFee(plan, vehicle) : null;
  const packageSummary = [
    plan.vehiclePackage.packageName,
    plan.mileagePackage.packageName,
    plan.energyPackage.packageName,
    plan.benefitPackage?.packageName
  ].filter(Boolean) as string[];
  const canSubmit = Boolean(vehicle && pricing?.monthlyFeeAmount !== null);

  return {
    benefitDescription: describeBenefitPackage(plan),
    canSubmit,
    depositDescription: "押金金额将根据审核结果最终确认。",
    effectiveFrom: formatDateOnly(plan.effectiveFrom),
    effectiveTo: plan.effectiveTo ? formatDateOnly(plan.effectiveTo) : null,
    energyDescription: describeEnergyPackage(plan),
    mileageDescription: describeMileagePackage(plan),
    monthlyFeeAmount: pricing?.monthlyFeeAmount ?? null,
    monthlyFeeDescription: pricing?.monthlyFeeAmount !== null && pricing?.monthlyFeeAmount !== undefined
      ? `预估月租 ${formatMoney(pricing.monthlyFeeAmount)} / 月，最终以审核方案为准`
      : "需后台审核后确认月租",
    packageSummary,
    periodOptions: buildPeriodOptions(plan.minPeriodMonths, plan.maxPeriodMonths),
    planId: plan.id,
    planName: plan.planName,
    planNo: plan.planNo,
    subscriptionPeriodMonths: plan.minPeriodMonths,
    subscriptionPeriodRange: {
      max: plan.maxPeriodMonths,
      min: plan.minPeriodMonths
    }
  };
}

function calculateEstimatedMonthlyFee(plan: PortalSubscriptionPlan, vehicle: PortalVehicle) {
  if (!vehicle.currentSalePriceAmount || vehicle.currentSalePriceAmount <= 0n) {
    return { monthlyFeeAmount: null };
  }

  const vehicleBaseFeeAmount = calculateVehicleBaseFeeAmount(plan, vehicle.currentSalePriceAmount);
  if (vehicleBaseFeeAmount === null) {
    return { monthlyFeeAmount: null };
  }

  return {
    monthlyFeeAmount: Number(
      vehicleBaseFeeAmount +
        plan.mileagePackage.priceAmount +
        plan.energyPackage.priceAmount +
        (plan.benefitPackage?.priceAmount ?? 0n)
    )
  };
}

function calculateVehicleBaseFeeAmount(plan: PortalSubscriptionPlan, vehicleSalePriceAmount: bigint) {
  if (plan.monthlyFeeMode === MonthlyFeeMode.MANUAL_QUOTE) {
    return null;
  }

  const capRate = Number(plan.vehiclePackage.monthlyFeeRate);
  if (!Number.isFinite(capRate) || capRate <= 0) {
    return null;
  }

  const capAmount = BigInt(Math.floor(Number(vehicleSalePriceAmount) * capRate));
  let amount: bigint | null = null;

  if (plan.monthlyFeeMode === MonthlyFeeMode.FIXED_AMOUNT) {
    amount = plan.baseMonthlyFeeAmount && plan.baseMonthlyFeeAmount > 0n
      ? plan.baseMonthlyFeeAmount
      : null;
  }

  if (plan.monthlyFeeMode === MonthlyFeeMode.RATE_FORMULA) {
    const rate = Number(plan.monthlyFeeRate);
    amount = Number.isFinite(rate) && rate > 0
      ? BigInt(Math.floor(Number(vehicleSalePriceAmount) * rate))
      : null;
  }

  if (amount === null || amount > capAmount) {
    return null;
  }

  return amount;
}

function isPortalSubscriptionPlanAvailable(plan: PortalSubscriptionPlan) {
  return (
    plan.status === SubscriptionPlanStatus.ACTIVE &&
    plan.product.status === ProductStatus.ACTIVE &&
    plan.product.productType === ProductType.SUBSCRIPTION &&
    plan.productVersion.status === ProductVersionStatus.ACTIVE &&
    !plan.product.deletedAt &&
    !plan.productVersion.deletedAt &&
    packageBelongsToPlan(plan, plan.vehiclePackage) &&
    packageBelongsToPlan(plan, plan.mileagePackage) &&
    packageBelongsToPlan(plan, plan.energyPackage) &&
    (!plan.benefitPackage || packageBelongsToPlan(plan, plan.benefitPackage))
  );
}

function packageBelongsToPlan(
  plan: PortalSubscriptionPlan,
  item: { deletedAt: Date | null; productId: string; productVersionId: string; status: RecordStatus }
) {
  return (
    !item.deletedAt &&
    item.status === RecordStatus.ACTIVE &&
    item.productId === plan.productId &&
    item.productVersionId === plan.productVersionId
  );
}

function describeMileagePackage(plan: PortalSubscriptionPlan) {
  return `${plan.mileagePackage.monthlyMileageKm} 公里/月，超出 ${formatMoney(plan.mileagePackage.overMileageFeeAmount)} / 公里`;
}

function describeEnergyPackage(plan: PortalSubscriptionPlan) {
  if (plan.energyPackage.serviceDescription) {
    return plan.energyPackage.serviceDescription;
  }
  if (plan.energyPackage.monthlyEnergyKwh) {
    return `${plan.energyPackage.monthlyEnergyKwh} kWh/月`;
  }
  if (plan.energyPackage.monthlyEnergyCount) {
    return `${plan.energyPackage.monthlyEnergyCount} 次/月`;
  }
  return plan.energyPackage.packageName;
}

function describeBenefitPackage(plan: PortalSubscriptionPlan) {
  if (!plan.benefitPackage) {
    return "暂无附加权益";
  }
  if (plan.benefitPackage.description) {
    return plan.benefitPackage.description;
  }
  return plan.benefitPackage.benefitCount
    ? `${plan.benefitPackage.packageName} ${plan.benefitPackage.benefitCount} 次`
    : plan.benefitPackage.packageName;
}

function buildPeriodOptions(min: number, max: number) {
  return Array.from(new Set([min, 12, 24, 36, max].filter((value) => value >= min && value <= max))).sort(
    (left, right) => left - right
  );
}

function buildVehicleDisplayName(vehicle: Pick<PortalVehicle, "brand" | "model" | "modelYear" | "series">) {
  return [vehicle.brand, vehicle.series, vehicle.model, vehicle.modelYear ? `${vehicle.modelYear}款` : null]
    .filter(Boolean)
    .join(" ");
}

function buildVehicleTags(vehicle: PortalVehicle) {
  return [
    vehicle.modelYear ? `${vehicle.modelYear}款` : null,
    vehicle.batteryCapacityKwh ? `${decimalToNumber(vehicle.batteryCapacityKwh)} kWh` : null,
    VEHICLE_BATTERY_USAGE_TYPE_LABELS[vehicle.batteryUsageType],
    vehicle.assetLocation
  ].filter(Boolean);
}

function decimalToNumber(value: Prisma.Decimal | null) {
  return value ? value.toNumber() : null;
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatMoney(amount: bigint | number) {
  const cents = typeof amount === "bigint" ? Number(amount) : amount;
  if (!Number.isFinite(cents)) {
    throw new BadRequestException("金额格式无效。");
  }
  return `¥${(cents / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}`;
}

const VEHICLE_BATTERY_USAGE_TYPE_LABELS: Record<VehicleBatteryUsageType, string> = {
  BAAS: "BaaS / 电池租用",
  BUYOUT: "电池买断"
};
