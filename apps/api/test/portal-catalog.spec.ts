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
  VehicleConditionItemArea,
  VehicleConditionItemResult,
  VehicleConditionItemSeverity,
  VehicleConditionItemType,
  VehicleConditionReportStatus,
  VehicleListingConditionGrade,
  VehicleListingMediaCategory,
  VehicleListingStatus,
  VehicleStatus
} from "@prisma/client";
import { NotFoundException } from "@nestjs/common";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { PortalCatalogService } from "../src/portal/portal-catalog.service";

const VehicleModel = {
  ES6: "ES6",
  ET5: "ET5"
} as const;

describe("PortalCatalogService enhanced vehicle listing", () => {
  it("returns enhanced list fields without internal asset fields", async () => {
    const { service } = createHarness();

    const rows = await service.listVehicles();

    expect(rows[0]).toMatchObject({
      batteryHealthPercent: 91,
      conditionGrade: VehicleListingConditionGrade.B,
      coverImageUrl: "/api/portal/catalog/vehicles/vehicle-1/media/media-cover/preview",
      displayName: "ES6 长续航现车",
      hasMajorAccident: false,
      monthlyFeeFromAmount: 690000
    });
    expect(rows[0]).not.toHaveProperty("purchasePriceAmount");
    expect(rows[0]).not.toHaveProperty("currentSalePriceAmount");
    expect(rows[0]).not.toHaveProperty("vin");
    expect(rows[0]).not.toHaveProperty("plateNo");
    expect(JSON.stringify(rows[0])).not.toContain("private-bucket");
    expect(JSON.stringify(rows[0])).not.toContain("vehicle-listings/");
  });

  it("returns detail gallery, condition, battery, FAQ, and configured visible plans", async () => {
    const { service } = createHarness();

    const detail = await service.getVehicle("vehicle-1");

    expect(detail.gallery).toHaveLength(1);
    expect(detail.condition).toMatchObject({
      grade: VehicleListingConditionGrade.B,
      hasFireDamage: false,
      hasFloodDamage: false,
      hasMajorAccident: false,
      knownDefectsSummary: "右前门轻微划痕"
    });
    expect(detail.battery).toMatchObject({
      healthPercent: 91,
      estimatedRangeKm: 480
    });
    expect(detail.subscriptionPlans).toHaveLength(1);
    expect(detail.subscriptionPlans[0]).toMatchObject({
      monthlyFeeAmount: 690000,
      planId: "plan-1",
      recommended: true
    });
    expect(detail.faq[0]).toMatchObject({ question: "这台车是新车还是二手车？" });
    expect(JSON.stringify(detail)).not.toContain("purchasePriceAmount");
    expect(JSON.stringify(detail)).not.toContain("currentSalePriceAmount");
    expect(JSON.stringify(detail)).not.toContain("private-bucket");
    expect(JSON.stringify(detail)).not.toContain("VIN1234567890");
    expect(JSON.stringify(detail)).not.toContain("沪A12345");
  });

  it("uses latest published condition report in detail and exposes a redacted customer report", async () => {
    const vehicle = createVehicle({ conditionReports: [createConditionReport()] });
    const { service } = createHarness({ vehicle });

    const detail = await service.getVehicle("vehicle-1");

    expect(detail.condition).toMatchObject({
      grade: VehicleListingConditionGrade.A,
      knownDefectsSummary: "右前门：轻微划痕",
      summary: "正式报告客户摘要"
    });
    expect(detail.battery).toMatchObject({
      cycleCount: 320,
      healthPercent: 92,
      warrantyUntil: new Date("2028-01-01T00:00:00.000Z")
    });
    expect(detail.conditionReportSummary).toMatchObject({
      overallGrade: VehicleListingConditionGrade.A,
      reportNo: "VCR-20260621-0001"
    });

    const report = await service.getVehicleConditionReport("vehicle-1");
    expect(report).toMatchObject({
      accident: {
        hasMajorAccident: false
      },
      battery: {
        cycleCount: 320,
        healthPercent: 92
      },
      reportNo: "VCR-20260621-0001"
    });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.media).toHaveLength(1);
    expect(report.items[0]?.media[0]).toMatchObject({
      id: "media-cover",
      previewUrl: "/api/portal/catalog/vehicles/vehicle-1/media/media-cover/preview"
    });
    expect(JSON.stringify(report)).not.toContain("private-bucket");
    expect(JSON.stringify(report)).not.toContain("vehicle-listings/");
    expect(JSON.stringify(report)).not.toContain("createdBy");
    expect(JSON.stringify(report)).not.toContain("updatedBy");
    expect(JSON.stringify(report)).not.toContain("deletedAt");
  });

  it("does not expose draft or archived condition reports through Portal", async () => {
    const vehicle = createVehicle({
      conditionReports: [
        createConditionReport({
          customerVisible: false,
          reportStatus: VehicleConditionReportStatus.ARCHIVED
        })
      ]
    });
    const { service } = createHarness({ vehicle });

    const detail = await service.getVehicle("vehicle-1");

    expect(detail.conditionReportSummary).toBeNull();
    expect(detail.condition.summary).toBe("车况良好");
    await expect(service.getVehicleConditionReport("vehicle-1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("falls back to active plans when listing plans are not configured", async () => {
    const vehicle = createVehicle({
      listingProfile: {
        ...createListingProfile(),
        plans: []
      }
    });
    const { service } = createHarness({ vehicle });

    const detail = await service.getVehicle("vehicle-1");

    expect(detail.subscriptionPlans).toHaveLength(2);
    expect(detail.subscriptionPlans.map((plan) => plan.planId)).toEqual(["plan-1", "plan-2"]);
  });

  it("keeps catalog fallback when no listing profile exists", async () => {
    const vehicle = createVehicle({ listingProfile: null });
    const { service } = createHarness({ vehicle });

    const rows = await service.listVehicles();

    expect(rows[0]).toMatchObject({
      coverImageUrl: null,
      displayName: "NIO ES6 ES6 2025款"
    });
  });

  it("returns model definition display fields for catalog vehicles", async () => {
    const definition = createModelDefinition({
      customerDisplayName: "乐道 ES6",
      displayName: "ES6 主数据",
      id: "model-es6",
      legacyVehicleModel: VehicleModel.ES6,
      modelCode: "NIO_ES6"
    });
    const vehicle = createVehicle({
      modelDefinition: definition,
      modelDefinitionId: definition.id
    });
    const { service } = createHarness({ vehicle });

    const rows = await service.listVehicles();
    const detail = await service.getVehicle("vehicle-1");

    expect(rows[0]).toMatchObject({
      customerModelDisplayName: "NIO ES6 乐道 ES6 2025款",
      modelDefinition: {
        displayName: "ES6 主数据",
        id: definition.id,
        modelCode: "NIO_ES6"
      },
      modelDefinitionId: definition.id,
      modelDisplayName: "ES6 主数据"
    });
    expect(rows[0]?.modelDefinition).not.toHaveProperty("enabled");
    expect(rows[0]?.modelDefinition).not.toHaveProperty("legacyVehicleModel");
    expect(rows[0]?.modelDefinition).not.toHaveProperty("portalVisible");
    expect(detail.vehicle).toMatchObject({
      modelCode: "NIO_ES6",
      modelDefinitionId: definition.id,
      modelDisplayName: "ES6 主数据"
    });
  });

  it("filters catalog vehicles by modelDefinitionId only", async () => {
    const definition = createModelDefinition({
      id: "model-es6",
      legacyVehicleModel: VehicleModel.ES6,
      modelCode: "NIO_ES6"
    });
    const { service } = createHarness({
      modelDefinitions: [definition],
      vehicles: [
        createVehicle({ id: "vehicle-master", modelDefinition: definition, modelDefinitionId: definition.id }),
        createVehicle({
          id: "vehicle-et5",
          modelDefinition: createModelDefinition({
            id: "model-et5",
            modelCode: "NIO_ET5"
          }),
          modelDefinitionId: "model-et5"
        })
      ]
    });

    const byDefinition = await service.listVehicles({ modelDefinitionId: definition.id });

    expect(byDefinition.map((row) => row.id)).toEqual(["vehicle-master"]);
  });

  it("returns an arbitrary canonical model without an enum mapping", async () => {
    const definition = createModelDefinition({
      id: "model-x-2027",
      legacyVehicleModel: null,
      modelCode: "MODEL_X_2027"
    });
    const { service } = createHarness({
      modelDefinitions: [definition],
      vehicles: [
        createVehicle({
          id: "vehicle-model-x",
          modelDefinition: definition,
          modelDefinitionId: definition.id
        }),
        createVehicle({
          id: "vehicle-other",
          modelDefinition: createModelDefinition({
            id: "model-et5",
            modelCode: "NIO_ET5"
          }),
          modelDefinitionId: "model-et5"
        })
      ]
    });

    const rows = await service.listVehicles({ modelDefinitionId: definition.id });

    expect(rows.map((row) => row.id)).toEqual(["vehicle-model-x"]);
    expect(rows[0]).toMatchObject({
      modelCode: "MODEL_X_2027",
      modelDefinitionId: definition.id
    });
  });

  it("matches a vehicle and package by canonical modelDefinitionId", async () => {
    const definition = createModelDefinition({
      id: "model-et5",
      legacyVehicleModel: VehicleModel.ET5,
      modelCode: "NIO_ET5"
    });
    const plan = createPlan("plan-et5", {
      vehiclePackage: {
        ...createPlan("plan-template").vehiclePackage,
        modelDefinition: definition,
        modelDefinitionId: definition.id
      }
    });
    const vehicle = createVehicle({
      listingProfile: null,
      modelDefinition: definition,
      modelDefinitionId: definition.id
    });
    const { service } = createHarness({
      modelDefinitions: [definition],
      plans: [plan],
      vehicle
    });

    const rows = await service.listVehicleSubscriptionPlans(vehicle.id);

    expect(rows.map((row) => row.planId)).toEqual([plan.id]);
  });

  it("lists only enabled portal-visible model definitions for filters", async () => {
    const visible = createModelDefinition({ id: "model-visible", modelCode: "VISIBLE" });
    const disabled = createModelDefinition({ enabled: false, id: "model-disabled", modelCode: "DISABLED" });
    const hidden = createModelDefinition({ id: "model-hidden", modelCode: "HIDDEN", portalVisible: false });
    const { service } = createHarness({ modelDefinitions: [visible, disabled, hidden] });

    const rows = await service.listModelDefinitions();

    expect(rows).toEqual([
      {
        customerDisplayName: visible.customerDisplayName,
        displayName: visible.displayName,
        id: visible.id,
        modelCode: visible.modelCode
      }
    ]);
  });

  it("streams only customer-visible published media", async () => {
    const { service, storageService } = createHarness();

    const preview = await service.previewVehicleMedia("vehicle-1", "media-cover");

    expect(preview.filename).toBe("cover.jpg");
    expect(storageService.getVehicleListingMediaStream).toHaveBeenCalledWith(
      "private-bucket",
      "vehicle-listings/vehicle-1/2026/cover.jpg"
    );
    await expect(service.previewVehicleMedia("vehicle-1", "media-hidden")).rejects.toBeInstanceOf(NotFoundException);
  });
});

function createHarness(
  seed: {
    modelDefinitions?: ReturnType<typeof createModelDefinition>[];
    plans?: ReturnType<typeof createPlan>[];
    vehicle?: ReturnType<typeof createVehicle>;
    vehicles?: ReturnType<typeof createVehicle>[];
  } = {}
) {
  const vehicles = seed.vehicles ?? [seed.vehicle ?? createVehicle()];
  const modelDefinitions = seed.modelDefinitions ?? [createModelDefinition()];
  const plans = seed.plans ?? [
    createPlan("plan-1"),
    createPlan("plan-2", { planName: "灵活订阅 24 个月" })
  ];
  const prisma = {
    subscriptionPlan: {
      findMany: vi.fn(async () => plans)
    },
    vehicle: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        filterCatalogVehicles(vehicles, where)[0] ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        filterCatalogVehicles(vehicles, where)
      )
    },
    vehicleModelDefinition: {
      findFirst: vi.fn(async ({ where }: {
        where: {
          deletedAt?: null;
          id?: string;
          legacyVehicleModel?: string;
          modelCode?: string;
        };
      }) =>
        modelDefinitions.find(
          (definition) =>
            (!where.id || definition.id === where.id) &&
            (!where.modelCode || definition.modelCode === where.modelCode) &&
            (!where.legacyVehicleModel || definition.legacyVehicleModel === where.legacyVehicleModel) &&
            (where.deletedAt !== null || definition.deletedAt === null)
        ) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: { deletedAt?: null; enabled?: boolean; portalVisible?: boolean } }) =>
        modelDefinitions
          .filter((definition) => where.deletedAt !== null || definition.deletedAt === null)
          .filter((definition) => where.enabled === undefined || definition.enabled === where.enabled)
          .filter((definition) => where.portalVisible === undefined || definition.portalVisible === where.portalVisible)
          .map((definition) => ({
            customerDisplayName: definition.customerDisplayName,
            displayName: definition.displayName,
            id: definition.id,
            modelCode: definition.modelCode
          }))
      )
    },
    vehicleListingMedia: {
      findFirst: vi.fn(async ({ where }: { where: { customerVisible?: boolean; id?: string; vehicleId?: string } }) => {
        const vehicle = vehicles.find((item) => item.id === where.vehicleId);
        const media = vehicle?.listingProfile?.media.find((item) => item.id === where.id);
        if (!vehicle || !media || media.vehicleId !== where.vehicleId || media.customerVisible !== where.customerVisible) {
          return null;
        }
        return {
          ...media,
          listingProfile: vehicle.listingProfile
        };
      }),
      findMany: vi.fn(async ({ where }: { where: { customerVisible?: boolean; id?: { in: string[] }; vehicleId?: string } }) =>
        (vehicles.find((item) => item.id === where.vehicleId)?.listingProfile?.media ?? []).filter(
          (item) =>
            item.vehicleId === where.vehicleId &&
            item.customerVisible === where.customerVisible &&
            !item.deletedAt &&
            (!where.id?.in || where.id.in.includes(item.id))
        )
      )
    }
  };
  const storageService = {
    getVehicleListingMediaStream: vi.fn(async () => ({
      contentLength: 5,
      contentType: "image/jpeg",
      stream: Readable.from(["hello"])
    }))
  };

  return {
    prisma,
    service: new PortalCatalogService(prisma as never, storageService as never),
    storageService
  };
}

function filterCatalogVehicles(
  vehicles: ReturnType<typeof createVehicle>[],
  where: Record<string, unknown>
) {
  return vehicles.filter((vehicle) => {
    if (where.id && vehicle.id !== where.id) {
      return false;
    }
    if (
      where.modelDefinitionId &&
      vehicle.modelDefinitionId !== where.modelDefinitionId
    ) {
      return false;
    }
    const modelOr = where.OR as Array<{
      modelDefinitionId?: string | null;
      vehicleModel?: string | { in?: string[] };
    }> | undefined;
    if (modelOr?.length) {
      return modelOr.some((condition) => {
        if (condition.modelDefinitionId !== undefined && vehicle.modelDefinitionId !== condition.modelDefinitionId) {
          return false;
        }
        if (condition.vehicleModel !== undefined) {
          if (typeof condition.vehicleModel === "string" && vehicle.vehicleModel !== condition.vehicleModel) {
            return false;
          }
          if (
            typeof condition.vehicleModel === "object" &&
            condition.vehicleModel.in &&
            !condition.vehicleModel.in.includes(vehicle.vehicleModel)
          ) {
            return false;
          }
        }
        return true;
      });
    }
    return true;
  });
}

function createModelDefinition(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-21T10:00:00.000Z");
  return {
    brand: "NIO",
    createdAt: now,
    createdBy: "user-1",
    customerDisplayName: null,
    deletedAt: null,
    displayName: "ES6",
    enabled: true,
    id: "model-es6",
    modelCode: "NIO_ES6",
    modelName: "ES6",
    portalVisible: true,
    series: "ES6",
    sortOrder: 0,
    updatedAt: now,
    updatedBy: "user-1",
    ...overrides
  };
}

function createVehicle(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-21T10:00:00.000Z");
  return {
    acquisitionMode: "OWNED_CASH",
    assetLocation: "上海",
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: now,
    createdBy: "user-1",
    conditionReports: [],
    currentMileageKm: 12000,
    currentSalePriceAmount: 20000000n,
    currentSalePriceInitializedAt: now,
    currentSalePriceReviewedAt: now,
    deletedAt: null,
    id: "vehicle-1",
    latestRegistrationDate: null,
    listingProfile: createListingProfile(),
    model: "ES6",
    modelDefinition: createModelDefinition(),
    modelDefinitionId: "model-es6",
    modelYear: 2025,
    nextSalePriceReviewAt: null,
    plateNo: "沪A12345",
    purchaseDate: null,
    purchasePriceAmount: 26000000n,
    registrationDate: new Date("2025-01-10T00:00:00.000Z"),
    remark: null,
    salePriceReinitRequiredAt: null,
    salePriceStatus: SalePriceStatus.EFFECTIVE,
    series: "ES6",
    status: VehicleStatus.AVAILABLE,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleNo: "VH001",
    vin: "VIN1234567890",
    ...overrides
  };
}

function createListingProfile() {
  const now = new Date("2026-06-21T10:00:00.000Z");
  return {
    applicationNotice: "提交后进入审核。",
    batteryHealthCheckedAt: new Date("2026-06-01T00:00:00.000Z"),
    batteryHealthPercent: new Prisma.Decimal(91),
    batteryRemark: "续航受环境影响",
    conditionGrade: VehicleListingConditionGrade.B,
    conditionSummary: "车况良好",
    createdAt: now,
    createdBy: "user-1",
    customerTags: ["现车", "长续航"],
    deletedAt: null,
    displayName: "ES6 长续航现车",
    estimatedRangeKm: 480,
    faqSnapshot: [{ answer: "二手车。", question: "这台车是新车还是二手车？" }],
    feeDescription: "押金审核后确认。",
    hasFireDamage: false,
    hasFloodDamage: false,
    hasMajorAccident: false,
    hasStructuralDamage: false,
    highlightSummary: "一车一况已维护",
    id: "listing-profile-1",
    knownDefectsSummary: "右前门轻微划痕",
    listingStatus: VehicleListingStatus.PUBLISHED,
    media: [
      {
        bucket: "private-bucket",
        caption: "外观封面",
        createdAt: now,
        customerVisible: true,
        deletedAt: null,
        fileName: "cover.jpg",
        fileSize: 5,
        id: "media-cover",
        isCover: true,
        listingProfileId: "listing-profile-1",
        mediaCategory: VehicleListingMediaCategory.COVER,
        mimeType: "image/jpeg",
        objectKey: "vehicle-listings/vehicle-1/2026/cover.jpg",
        originalName: "cover.jpg",
        sortOrder: 0,
        updatedAt: now,
        uploadedBy: "user-1",
        vehicleId: "vehicle-1"
      },
      {
        bucket: "private-bucket",
        caption: "隐藏图",
        createdAt: now,
        customerVisible: false,
        deletedAt: null,
        fileName: "hidden.jpg",
        fileSize: 5,
        id: "media-hidden",
        isCover: false,
        listingProfileId: "listing-profile-1",
        mediaCategory: VehicleListingMediaCategory.EXTERIOR,
        mimeType: "image/jpeg",
        objectKey: "vehicle-listings/vehicle-1/2026/hidden.jpg",
        originalName: "hidden.jpg",
        sortOrder: 1,
        updatedAt: now,
        uploadedBy: "user-1",
        vehicleId: "vehicle-1"
      }
    ],
    plans: [
      {
        createdAt: now,
        deletedAt: null,
        displayMonthlyFeeAmount: 690000n,
        displayRemark: null,
        id: "listing-plan-1",
        listingProfileId: "listing-profile-1",
        recommended: true,
        sortOrder: 0,
        subscriptionPlan: createPlan("plan-1"),
        subscriptionPlanId: "plan-1",
        updatedAt: now,
        vehicleId: "vehicle-1",
        visible: true
      },
      {
        createdAt: now,
        deletedAt: null,
        displayMonthlyFeeAmount: null,
        displayRemark: null,
        id: "listing-plan-2",
        listingProfileId: "listing-profile-1",
        recommended: false,
        sortOrder: 1,
        subscriptionPlan: createPlan("plan-2"),
        subscriptionPlanId: "plan-2",
        updatedAt: now,
        vehicleId: "vehicle-1",
        visible: false
      }
    ],
    portalVisible: true,
    publishedAt: now,
    sellingPoints: ["一车一况", "电池健康度已维护"],
    serviceHighlights: ["账单线上查看"],
    shortTitle: "ES6 长续航",
    sortOrder: 0,
    subtitle: "上海现车",
    unpublishedAt: null,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleId: "vehicle-1"
  };
}

function createConditionReport(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-21T10:00:00.000Z");
  return {
    archivedAt: null,
    batteryCheckedAt: new Date("2026-06-01T00:00:00.000Z"),
    batteryCycleCount: 320,
    batteryEstimatedRangeKm: 490,
    batteryHealthPercent: new Prisma.Decimal(92),
    batteryRemark: "电池状态稳定",
    batteryWarrantyUntil: new Date("2028-01-01T00:00:00.000Z"),
    brakeSummary: "制动正常",
    chassisSummary: "底盘正常",
    createdAt: now,
    createdBy: "user-1",
    customerSummary: "正式报告客户摘要",
    customerVisible: true,
    deletedAt: null,
    exteriorSummary: "外观有轻微划痕",
    glassLightSummary: "玻璃灯光正常",
    hasFireDamage: false,
    hasFloodDamage: false,
    hasMajorAccident: false,
    hasStructuralDamage: false,
    id: "condition-report-1",
    inspectionDate: new Date("2026-06-21T00:00:00.000Z"),
    inspectorName: "Inspector",
    inspectorOrg: "内部检测",
    interiorSummary: "内饰整洁",
    items: [
      {
        affectsSafety: false,
        area: VehicleConditionItemArea.EXTERIOR,
        createdAt: now,
        customerVisible: true,
        deletedAt: null,
        description: "右前门有轻微划痕，不影响安全。",
        id: "condition-item-1",
        itemType: VehicleConditionItemType.DEFECT,
        mediaIds: ["media-cover"],
        partName: "右前门",
        repairRequired: false,
        reportId: "condition-report-1",
        result: VehicleConditionItemResult.ATTENTION,
        severity: VehicleConditionItemSeverity.MINOR,
        sortOrder: 0,
        title: "轻微划痕",
        updatedAt: now
      },
      {
        affectsSafety: false,
        area: VehicleConditionItemArea.INTERIOR,
        createdAt: now,
        customerVisible: false,
        deletedAt: null,
        description: "后台可见备注",
        id: "condition-item-hidden",
        itemType: VehicleConditionItemType.CHECK,
        mediaIds: [],
        partName: "内饰",
        repairRequired: false,
        reportId: "condition-report-1",
        result: VehicleConditionItemResult.NORMAL,
        severity: VehicleConditionItemSeverity.MINOR,
        sortOrder: 1,
        title: "隐藏项",
        updatedAt: now
      }
    ],
    odometerKm: 12000,
    overallGrade: VehicleListingConditionGrade.A,
    publishedAt: now,
    repairSuggestion: "交付前复核外观。",
    reportNo: "VCR-20260621-0001",
    reportStatus: VehicleConditionReportStatus.PUBLISHED,
    safetyConclusion: "未见影响安全的问题。",
    summary: "正式检测报告摘要",
    tireSummary: "轮胎正常",
    updatedAt: now,
    updatedBy: "user-1",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function createPlan(id: string, overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-21T10:00:00.000Z");
  const product = {
    deletedAt: null,
    id: "product-1",
    productType: ProductType.SUBSCRIPTION,
    status: ProductStatus.ACTIVE
  };
  const productVersion = {
    deletedAt: null,
    id: "version-1",
    productId: "product-1",
    status: ProductVersionStatus.ACTIVE
  };

  return {
    baseMonthlyFeeAmount: null,
    benefitPackage: null,
    benefitPackageId: null,
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    energyPackage: {
      deletedAt: null,
      id: "energy-package-1",
      monthlyEnergyCount: null,
      monthlyEnergyKwh: 100,
      packageName: "补能包",
      priceAmount: 20000n,
      productId: "product-1",
      productVersionId: "version-1",
      serviceDescription: null,
      status: RecordStatus.ACTIVE
    },
    energyPackageId: "energy-package-1",
    id,
    maxPeriodMonths: 24,
    mileagePackage: {
      deletedAt: null,
      id: "mileage-package-1",
      monthlyMileageKm: 1500,
      overMileageFeeAmount: 100n,
      packageName: "1500 公里",
      priceAmount: 10000n,
      productId: "product-1",
      productVersionId: "version-1",
      status: RecordStatus.ACTIVE
    },
    mileagePackageId: "mileage-package-1",
    minPeriodMonths: 12,
    monthlyFeeCapRate: null,
    monthlyFeeMode: MonthlyFeeMode.RATE_FORMULA,
    monthlyFeeRate: new Prisma.Decimal("0.035"),
    planName: "安心订阅 12 个月",
    planNo: id.toUpperCase(),
    product,
    productId: "product-1",
    productVersion,
    productVersionId: "version-1",
    remark: null,
    status: SubscriptionPlanStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    vehiclePackage: {
      deletedAt: null,
      id: "vehicle-package-1",
      modelDefinition: createModelDefinition(),
      modelDefinitionId: "model-es6",
      monthlyFeeRate: new Prisma.Decimal("0.04"),
      packageName: "ES6 基础车包",
      productId: "product-1",
      productVersionId: "version-1",
      status: RecordStatus.ACTIVE
    },
    vehiclePackageId: "vehicle-package-1",
    ...overrides
  };
}
