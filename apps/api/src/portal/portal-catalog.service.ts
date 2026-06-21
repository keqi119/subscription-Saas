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
  VehicleConditionItemType,
  VehicleConditionReportStatus,
  VehicleListingStatus,
  VehicleStatus
} from "@prisma/client";
import type { Readable } from "node:stream";

import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { PortalVehicleCatalogQueryDto } from "./portal-catalog.dto";

export interface PortalCatalogMediaPreview {
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
  stream: Readable;
}

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

const portalVehicleInclude = {
  listingProfile: {
    include: {
      media: {
        orderBy: [{ isCover: "desc" as const }, { sortOrder: "asc" as const }, { createdAt: "asc" as const }],
        where: {
          customerVisible: true,
          deletedAt: null
        }
      },
      plans: {
        include: {
          subscriptionPlan: {
            include: portalSubscriptionPlanInclude
          }
        },
        orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }],
        where: {
          deletedAt: null
        }
      }
    }
  },
  conditionReports: {
    include: {
      items: {
        orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }],
        where: {
          customerVisible: true,
          deletedAt: null
        }
      }
    },
    orderBy: [{ inspectionDate: "desc" as const }, { createdAt: "desc" as const }],
    take: 1,
    where: {
      customerVisible: true,
      deletedAt: null,
      reportStatus: VehicleConditionReportStatus.PUBLISHED
    }
  }
} satisfies Prisma.VehicleInclude;

type PortalSubscriptionPlan = Prisma.SubscriptionPlanGetPayload<{
  include: typeof portalSubscriptionPlanInclude;
}>;

type PortalVehicle = Prisma.VehicleGetPayload<{
  include: typeof portalVehicleInclude;
}>;

type PortalListingProfile = NonNullable<PortalVehicle["listingProfile"]>;
type PortalListingPlan = PortalListingProfile["plans"][number];
type PortalListingMedia = PortalListingProfile["media"][number];
type PortalConditionReport = PortalVehicle["conditionReports"][number];

interface PortalPlanOption {
  listingPlan?: PortalListingPlan;
  plan: PortalSubscriptionPlan;
}

@Injectable()
export class PortalCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService?: StorageService
  ) {}

  async listVehicles(query: PortalVehicleCatalogQueryDto = {}) {
    const vehicles = await this.prisma.vehicle.findMany({
      include: portalVehicleInclude,
      orderBy: { createdAt: "desc" },
      where: catalogVehicleWhere(query)
    });

    return Promise.all(
      vehicles.map(async (vehicle) => {
        const plans = await this.findCustomerPlansForVehicle(vehicle);
        return toPortalVehicleListItem(vehicle, plans);
      })
    );
  }

  async getVehicle(id: string) {
    const vehicle = await this.findAvailableVehicle(id);
    const plans = await this.findCustomerPlansForVehicle(vehicle);

    return {
      ...toPortalVehicleDetail(vehicle, plans),
      subscriptionPlans: plans.map((plan) => toPortalSubscriptionPlanView(plan.plan, vehicle, plan.listingPlan))
    };
  }

  async listSubscriptionPlans() {
    const plans = await this.findAvailablePlans();
    return plans.map((plan) => toPortalSubscriptionPlanView(plan));
  }

  async listVehicleSubscriptionPlans(vehicleId: string) {
    const vehicle = await this.findAvailableVehicle(vehicleId);
    const plans = await this.findCustomerPlansForVehicle(vehicle);
    return plans.map((plan) => toPortalSubscriptionPlanView(plan.plan, vehicle, plan.listingPlan));
  }

  async previewVehicleMedia(vehicleId: string, mediaId: string): Promise<PortalCatalogMediaPreview> {
    if (!this.storageService) {
      throw new NotFoundException("vehicle media storage is not available");
    }

    await this.findAvailableVehicle(vehicleId);
    const media = await this.prisma.vehicleListingMedia.findFirst({
      include: {
        listingProfile: true
      },
      where: {
        customerVisible: true,
        deletedAt: null,
        id: mediaId,
        vehicleId
      }
    });

    if (!media || !isProfileCustomerVisible(media.listingProfile) || !media.bucket || !media.objectKey) {
      throw new NotFoundException("vehicle media is not available");
    }

    const downloaded = await this.storageService.getVehicleListingMediaStream(media.bucket, media.objectKey);
    return {
      filename: media.originalName ?? media.fileName,
      mimeType: downloaded.contentType ?? media.mimeType,
      sizeBytes: downloaded.contentLength ?? media.fileSize ?? 0,
      stream: downloaded.stream
    };
  }

  async getVehicleConditionReport(vehicleId: string) {
    const vehicle = await this.findAvailableVehicle(vehicleId);
    const report = latestConditionReport(vehicle);
    if (!report) {
      throw new NotFoundException("vehicle condition report is not available");
    }

    const mediaById = await this.findVisibleMediaById(vehicleId, conditionReportMediaIds(report));
    return toPortalConditionReportView(vehicle, report, mediaById);
  }

  private async findVisibleMediaById(vehicleId: string, mediaIds: string[]) {
    if (mediaIds.length === 0) {
      return new Map<string, PortalListingMedia>();
    }

    const rows = await this.prisma.vehicleListingMedia.findMany({
      where: {
        customerVisible: true,
        deletedAt: null,
        id: { in: mediaIds },
        vehicleId
      }
    });

    return new Map(rows.map((media) => [media.id, media as PortalListingMedia]));
  }

  private async findAvailableVehicle(id: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      include: portalVehicleInclude,
      where: catalogVehicleWhere({}, id)
    });

    if (!vehicle) {
      throw new NotFoundException("商品车辆不存在或暂不可申请。");
    }

    return vehicle;
  }

  private async findCustomerPlansForVehicle(vehicle: PortalVehicle): Promise<PortalPlanOption[]> {
    const profile = customerVisibleProfile(vehicle.listingProfile);
    const configuredPlans = (profile?.plans ?? [])
      .filter((listingPlan) => listingPlan.visible)
      .filter((listingPlan) => isPlanAvailableForVehicle(listingPlan.subscriptionPlan, vehicle))
      .map((listingPlan) => ({
        listingPlan,
        plan: listingPlan.subscriptionPlan
      }));

    if (configuredPlans.length > 0) {
      return configuredPlans;
    }

    const fallbackPlans = await this.findAvailablePlansForVehicle(vehicle);
    return fallbackPlans.map((plan) => ({ plan }));
  }

  private async findAvailablePlansForVehicle(vehicle: Pick<PortalVehicle, "vehicleModel">) {
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

function catalogVehicleWhere(
  query: PortalVehicleCatalogQueryDto = {},
  id?: string
): Prisma.VehicleWhereInput {
  return {
    currentSalePriceAmount: { gt: 0 },
    deletedAt: null,
    id,
    salePriceStatus: SalePriceStatus.EFFECTIVE,
    status: VehicleStatus.AVAILABLE,
    ...(query.brand ? { brand: { contains: query.brand, mode: "insensitive" } } : {}),
    ...(query.series ? { series: { contains: query.series, mode: "insensitive" } } : {}),
    ...(query.model ? { model: { contains: query.model, mode: "insensitive" } } : {}),
    ...(query.city ? { assetLocation: { contains: query.city, mode: "insensitive" } } : {}),
    ...(requirePublishedCatalog()
      ? {
          listingProfile: {
            is: {
              deletedAt: null,
              listingStatus: VehicleListingStatus.PUBLISHED,
              portalVisible: true
            }
          }
        }
      : {})
  };
}

function toPortalVehicleListItem(vehicle: PortalVehicle, plans: PortalPlanOption[] = []) {
  const profile = customerVisibleProfile(vehicle.listingProfile);
  const gallery = buildGallery(vehicle, profile);
  const cover = gallery.find((item) => item.isCover) ?? gallery[0] ?? null;
  const customerTags = stringArray(profile?.customerTags);
  const sellingPoints = stringArray(profile?.sellingPoints);

  return {
    available: true,
    batteryCapacityKwh: decimalToNumber(vehicle.batteryCapacityKwh),
    batteryHealthCheckedAt: profile?.batteryHealthCheckedAt ?? null,
    batteryHealthPercent: decimalToNumber(profile?.batteryHealthPercent ?? null),
    batteryUsageType: vehicle.batteryUsageType,
    batteryUsageTypeLabel: VEHICLE_BATTERY_USAGE_TYPE_LABELS[vehicle.batteryUsageType],
    brand: vehicle.brand,
    city: vehicle.assetLocation,
    conditionGrade: profile?.conditionGrade ?? null,
    conditionSummary: profile?.conditionSummary ?? null,
    coverImageUrl: cover?.previewUrl ?? null,
    currentMileageKm: vehicle.currentMileageKm,
    customerTags,
    displayName: profile?.displayName ?? profile?.shortTitle ?? buildVehicleDisplayName(vehicle),
    estimatedRangeKm: profile?.estimatedRangeKm ?? null,
    gallery,
    hasFireDamage: profile?.hasFireDamage ?? null,
    hasFloodDamage: profile?.hasFloodDamage ?? null,
    hasMajorAccident: profile?.hasMajorAccident ?? null,
    id: vehicle.id,
    mileageKm: vehicle.currentMileageKm,
    model: vehicle.model,
    modelYear: vehicle.modelYear,
    monthlyFeeFromAmount: monthlyFeeFrom(plans, vehicle),
    registrationDate: vehicle.registrationDate,
    sellingPoints,
    series: vehicle.series,
    shortTitle: profile?.shortTitle ?? null,
    statusLabel: "可申请",
    subtitle: profile?.subtitle ?? null,
    tags: buildVehicleTags(vehicle, customerTags, profile)
  };
}

function toPortalVehicleDetail(vehicle: PortalVehicle, plans: PortalPlanOption[] = []) {
  const listItem = toPortalVehicleListItem(vehicle, plans);
  const profile = customerVisibleProfile(vehicle.listingProfile);
  const report = latestConditionReport(vehicle);
  const condition = buildConditionView(profile, report);
  const battery = buildBatteryView(vehicle, profile, report);

  return {
    ...listItem,
    applicationNotice: profile?.applicationNotice ?? DEFAULT_APPLICATION_NOTICE,
    applicationProcess: DEFAULT_APPLICATION_PROCESS,
    battery,
    condition,
    conditionReportSummary: report ? toConditionReportSummary(report) : null,
    coreHighlights: buildCoreHighlights(vehicle, profile),
    depositNotice: "押金金额将根据审核结果最终确认。",
    faq: faqArray(profile?.faqSnapshot),
    feeDescription: profile?.feeDescription ?? DEFAULT_FEE_DESCRIPTION,
    serviceHighlights: stringArray(profile?.serviceHighlights, DEFAULT_SERVICE_HIGHLIGHTS),
    submitButtonText: "提交审核",
    vehicle: {
      batteryCapacityKwh: decimalToNumber(vehicle.batteryCapacityKwh),
      brand: vehicle.brand,
      city: vehicle.assetLocation,
      currentMileageKm: vehicle.currentMileageKm,
      displayName: listItem.displayName,
      id: vehicle.id,
      model: vehicle.model,
      modelYear: vehicle.modelYear,
      registrationDate: vehicle.registrationDate,
      series: vehicle.series
    },
    vehicleHistorySummary: buildVehicleHistorySummary(condition)
  };
}

function toPortalSubscriptionPlanView(
  plan: PortalSubscriptionPlan,
  vehicle?: PortalVehicle,
  listingPlan?: PortalListingPlan
) {
  const pricing = vehicle ? calculateEstimatedMonthlyFee(plan, vehicle, listingPlan) : null;
  const packageSummary = [
    plan.vehiclePackage.packageName,
    plan.mileagePackage.packageName,
    plan.energyPackage.packageName,
    plan.benefitPackage?.packageName
  ].filter(Boolean) as string[];
  const canSubmit = Boolean(vehicle && pricing?.monthlyFeeAmount !== null);
  const monthlyFeeDescription =
    listingPlan?.displayRemark ??
    (pricing?.monthlyFeeAmount !== null && pricing?.monthlyFeeAmount !== undefined
      ? `预估月租 ${formatMoney(pricing.monthlyFeeAmount)} / 月，最终以审核方案为准`
      : "需后台审核后确认月租");

  return {
    benefitDescription: describeBenefitPackage(plan),
    canSubmit,
    depositDescription: "押金金额将根据审核结果最终确认。",
    displayRemark: listingPlan?.displayRemark ?? null,
    effectiveFrom: formatDateOnly(plan.effectiveFrom),
    effectiveTo: plan.effectiveTo ? formatDateOnly(plan.effectiveTo) : null,
    energyDescription: describeEnergyPackage(plan),
    mileageDescription: describeMileagePackage(plan),
    monthlyFeeAmount: pricing?.monthlyFeeAmount ?? null,
    monthlyFeeDescription,
    packageSummary,
    periodOptions: buildPeriodOptions(plan.minPeriodMonths, plan.maxPeriodMonths),
    planId: plan.id,
    planName: plan.planName,
    planNo: plan.planNo,
    recommended: listingPlan?.recommended ?? false,
    sortOrder: listingPlan?.sortOrder ?? 0,
    subscriptionPeriodMonths: plan.minPeriodMonths,
    subscriptionPeriodRange: {
      max: plan.maxPeriodMonths,
      min: plan.minPeriodMonths
    }
  };
}

function calculateEstimatedMonthlyFee(
  plan: PortalSubscriptionPlan,
  vehicle: PortalVehicle,
  listingPlan?: PortalListingPlan
) {
  if (listingPlan?.displayMonthlyFeeAmount !== null && listingPlan?.displayMonthlyFeeAmount !== undefined) {
    return { monthlyFeeAmount: Number(listingPlan.displayMonthlyFeeAmount) };
  }

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

function isPlanAvailableForVehicle(plan: PortalSubscriptionPlan, vehicle: Pick<PortalVehicle, "vehicleModel">) {
  return isPortalSubscriptionPlanAvailable(plan) && plan.vehiclePackage.vehicleModel === vehicle.vehicleModel;
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

function buildGallery(vehicle: PortalVehicle, profile: PortalListingProfile | null) {
  return (profile?.media ?? [])
    .filter((media) => media.customerVisible && !media.deletedAt)
    .map((media) => ({
      caption: media.caption,
      category: media.mediaCategory,
      id: media.id,
      isCover: media.isCover,
      previewUrl: buildMediaPreviewUrl(vehicle.id, media),
      sortOrder: media.sortOrder
    }));
}

function latestConditionReport(vehicle: PortalVehicle) {
  return (
    (vehicle.conditionReports ?? []).find(
      (report) =>
        report.customerVisible &&
        !report.deletedAt &&
        report.reportStatus === VehicleConditionReportStatus.PUBLISHED
    ) ?? null
  );
}

function buildConditionView(profile: PortalListingProfile | null, report: PortalConditionReport | null) {
  return {
    grade: report?.overallGrade ?? profile?.conditionGrade ?? null,
    hasFireDamage: report?.hasFireDamage ?? profile?.hasFireDamage ?? null,
    hasFloodDamage: report?.hasFloodDamage ?? profile?.hasFloodDamage ?? null,
    hasMajorAccident: report?.hasMajorAccident ?? profile?.hasMajorAccident ?? null,
    hasStructuralDamage: report?.hasStructuralDamage ?? profile?.hasStructuralDamage ?? null,
    knownDefectsSummary: report ? buildReportDefectSummary(report) : profile?.knownDefectsSummary ?? null,
    summary: report?.customerSummary ?? report?.summary ?? profile?.conditionSummary ?? null
  };
}

function buildBatteryView(
  vehicle: PortalVehicle,
  profile: PortalListingProfile | null,
  report: PortalConditionReport | null
) {
  return {
    capacityKwh: decimalToNumber(vehicle.batteryCapacityKwh),
    checkedAt: report?.batteryCheckedAt ?? profile?.batteryHealthCheckedAt ?? null,
    cycleCount: report?.batteryCycleCount ?? null,
    estimatedRangeKm: report?.batteryEstimatedRangeKm ?? profile?.estimatedRangeKm ?? null,
    healthPercent: decimalToNumber(report?.batteryHealthPercent ?? profile?.batteryHealthPercent ?? null),
    remark: report?.batteryRemark ?? profile?.batteryRemark ?? null,
    usageType: vehicle.batteryUsageType,
    usageTypeLabel: VEHICLE_BATTERY_USAGE_TYPE_LABELS[vehicle.batteryUsageType],
    warrantyUntil: report?.batteryWarrantyUntil ?? null
  };
}

function toConditionReportSummary(report: PortalConditionReport) {
  return {
    defectSummary: buildReportDefectSummary(report),
    id: report.id,
    inspectionDate: report.inspectionDate,
    inspectorName: report.inspectorName,
    inspectorOrg: report.inspectorOrg,
    itemCount: report.items.length,
    overallGrade: report.overallGrade,
    reportNo: report.reportNo,
    summary: report.customerSummary ?? report.summary
  };
}

function toPortalConditionReportView(
  vehicle: PortalVehicle,
  report: PortalConditionReport,
  mediaById: Map<string, PortalListingMedia>
) {
  return {
    accident: {
      hasFireDamage: report.hasFireDamage,
      hasFloodDamage: report.hasFloodDamage,
      hasMajorAccident: report.hasMajorAccident,
      hasStructuralDamage: report.hasStructuralDamage
    },
    battery: {
      checkedAt: report.batteryCheckedAt,
      cycleCount: report.batteryCycleCount,
      estimatedRangeKm: report.batteryEstimatedRangeKm,
      healthPercent: decimalToNumber(report.batteryHealthPercent),
      remark: report.batteryRemark,
      warrantyUntil: report.batteryWarrantyUntil
    },
    customerSummary: report.customerSummary,
    inspectionDate: report.inspectionDate,
    inspectorName: report.inspectorName,
    inspectorOrg: report.inspectorOrg,
    items: report.items
      .filter((item) => item.customerVisible && !item.deletedAt)
      .map((item) => ({
        affectsSafety: item.affectsSafety,
        area: item.area,
        description: item.description,
        id: item.id,
        itemType: item.itemType,
        media: mediaIds(item).flatMap((mediaId) => {
          const media = mediaById.get(mediaId);
          return media
            ? [
                {
                  caption: media.caption,
                  category: media.mediaCategory,
                  id: media.id,
                  previewUrl: buildMediaPreviewUrl(vehicle.id, media)
                }
              ]
            : [];
        }),
        partName: item.partName,
        repairRequired: item.repairRequired,
        result: item.result,
        severity: item.severity,
        sortOrder: item.sortOrder,
        title: item.title
      })),
    odometerKm: report.odometerKm,
    overallGrade: report.overallGrade,
    repairSuggestion: report.repairSuggestion,
    reportNo: report.reportNo,
    safetyConclusion: report.safetyConclusion,
    sections: {
      brakeSummary: report.brakeSummary,
      chassisSummary: report.chassisSummary,
      exteriorSummary: report.exteriorSummary,
      glassLightSummary: report.glassLightSummary,
      interiorSummary: report.interiorSummary,
      tireSummary: report.tireSummary
    },
    summary: report.summary,
    vehicle: {
      brand: vehicle.brand,
      city: vehicle.assetLocation,
      displayName: buildVehicleDisplayName(vehicle),
      id: vehicle.id,
      model: vehicle.model,
      modelYear: vehicle.modelYear,
      series: vehicle.series
    }
  };
}

function conditionReportMediaIds(report: PortalConditionReport) {
  return Array.from(new Set(report.items.flatMap(mediaIds)));
}

function mediaIds(item: PortalConditionReport["items"][number]) {
  return stringArray(item.mediaIds);
}

function buildReportDefectSummary(report: PortalConditionReport) {
  const defects = report.items
    .filter((item) => item.customerVisible && !item.deletedAt)
    .filter((item) => item.itemType === VehicleConditionItemType.DEFECT)
    .map((item) => [item.partName, item.title].filter(Boolean).join("："))
    .filter(Boolean);

  return defects.length > 0 ? defects.join("；") : null;
}

function buildMediaPreviewUrl(vehicleId: string, media: Pick<PortalListingMedia, "id">) {
  return `/api/portal/catalog/vehicles/${vehicleId}/media/${media.id}/preview`;
}

function buildVehicleDisplayName(vehicle: Pick<PortalVehicle, "brand" | "model" | "modelYear" | "series">) {
  return [vehicle.brand, vehicle.series, vehicle.model, vehicle.modelYear ? `${vehicle.modelYear}款` : null]
    .filter(Boolean)
    .join(" ");
}

function buildVehicleTags(
  vehicle: PortalVehicle,
  customerTags: string[],
  profile: PortalListingProfile | null
) {
  return [
    ...customerTags,
    profile?.conditionGrade ? `车况 ${profile.conditionGrade}` : null,
    vehicle.modelYear ? `${vehicle.modelYear}款` : null,
    vehicle.batteryCapacityKwh ? `${decimalToNumber(vehicle.batteryCapacityKwh)} kWh` : null,
    VEHICLE_BATTERY_USAGE_TYPE_LABELS[vehicle.batteryUsageType],
    vehicle.assetLocation
  ].filter(Boolean) as string[];
}

function buildCoreHighlights(vehicle: PortalVehicle, profile: PortalListingProfile | null) {
  const highlights = [
    profile?.highlightSummary,
    vehicle.modelYear ? `${vehicle.modelYear}款` : null,
    vehicle.registrationDate ? `上牌 ${formatDateOnly(vehicle.registrationDate)}` : null,
    `${vehicle.currentMileageKm.toLocaleString("zh-CN")} km`,
    profile?.conditionGrade ? `车况 ${profile.conditionGrade}` : null,
    profile?.batteryHealthPercent ? `电池健康度 ${decimalToNumber(profile.batteryHealthPercent)}%` : null
  ].filter(Boolean) as string[];

  return Array.from(new Set(highlights));
}

function buildVehicleHistorySummary(condition: {
  hasFireDamage: boolean | null;
  hasFloodDamage: boolean | null;
  hasMajorAccident: boolean | null;
  hasStructuralDamage: boolean | null;
}) {
  const risks = [
    condition.hasMajorAccident ? "重大事故" : null,
    condition.hasFloodDamage ? "水泡" : null,
    condition.hasFireDamage ? "火烧" : null,
    condition.hasStructuralDamage ? "结构件损伤" : null
  ].filter(Boolean);

  return risks.length > 0 ? `已标记：${risks.join("、")}` : "后台未标记重大事故、水泡、火烧或结构件损伤。";
}

function monthlyFeeFrom(plans: PortalPlanOption[], vehicle: PortalVehicle) {
  const amounts = plans
    .map((item) => calculateEstimatedMonthlyFee(item.plan, vehicle, item.listingPlan).monthlyFeeAmount)
    .filter((amount): amount is number => amount !== null);
  return amounts.length > 0 ? Math.min(...amounts) : null;
}

function customerVisibleProfile(profile: PortalVehicle["listingProfile"]): PortalListingProfile | null {
  return profile && isProfileCustomerVisible(profile) ? profile : null;
}

function isProfileCustomerVisible(
  profile:
    | {
        deletedAt: Date | null;
        listingStatus: VehicleListingStatus;
        portalVisible: boolean;
      }
    | null
    | undefined
) {
  return Boolean(
    profile &&
      !profile.deletedAt &&
      profile.portalVisible &&
      profile.listingStatus === VehicleListingStatus.PUBLISHED
  );
}

function stringArray(value: unknown, fallback: string[] = []) {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const rows = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return rows.length > 0 ? rows : fallback;
}

function faqArray(value: unknown) {
  if (!Array.isArray(value)) {
    return DEFAULT_FAQ;
  }
  const rows = value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const question = typeof record.question === "string" ? record.question : null;
      const answer = typeof record.answer === "string" ? record.answer : null;
      return question && answer ? { answer, question } : null;
    })
    .filter((item): item is { answer: string; question: string } => Boolean(item));
  return rows.length > 0 ? rows : DEFAULT_FAQ;
}

function requirePublishedCatalog() {
  return process.env.PORTAL_CATALOG_REQUIRE_PUBLISHED === "true";
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

const DEFAULT_FEE_DESCRIPTION = [
  "月租以最终审核方案为准。",
  "押金审核后确认。",
  "首期费用 = 押金 + 首期月租。",
  "额外费用可能包括超里程、损伤、违章、救援等。"
].join("\n");

const DEFAULT_APPLICATION_NOTICE = "提交审核后，平台会根据材料、车辆可用性和订阅方案确认最终方案。";

const DEFAULT_APPLICATION_PROCESS = [
  "提交审核",
  "上传材料",
  "平台审核",
  "确认最终方案",
  "电子签约",
  "支付押金 / 首期费用",
  "安排交付",
  "开始订阅"
];

const DEFAULT_SERVICE_HIGHLIGHTS = ["合同期内账单线上查看", "事故报案与救援可在 Portal 提交", "押金与权益信息线上可查"];

const DEFAULT_FAQ = [
  {
    answer: "平台车辆以二手车和运营整备车辆为主，具体以本页展示和最终审核方案为准。",
    question: "这台车是新车还是二手车？"
  },
  {
    answer: "押金会结合客户资质、车辆价值、订阅期和风控结果确认，因此需要审核后给出。",
    question: "押金为什么审核后确认？"
  },
  {
    answer: "后台会维护一车一况摘要、瑕疵说明和图片。完整检测报告将在后续阶段增强。",
    question: "车况如何保证？"
  },
  {
    answer: "电池健康度来自平台维护的检测或评估记录，续航会受温度、路况、驾驶习惯影响。",
    question: "电池健康度怎么看？"
  },
  {
    answer: "可在客户 Portal 提交事故报案，平台会按工单流程跟进。",
    question: "发生事故怎么办？"
  },
  {
    answer: "可在客户 Portal 提交救援申请，平台客服会跟进处理。",
    question: "救援如何申请？"
  },
  {
    answer: "账单可在客户 Portal 查看并按支持的支付方式处理。",
    question: "账单如何支付？"
  }
];
