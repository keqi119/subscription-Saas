import {
  MonthlyFeeMode,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  RecordStatus,
  SubscriptionPlanStatus,
  VehicleBatteryUsageType,
  VehicleListingConditionGrade,
  VehicleListingMediaCategory,
  VehicleListingStatus,
  VehicleStatus
} from "@prisma/client";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { VehicleModel } from "./helpers/vehicle-model-codes";

import { VehicleListingService } from "../src/vehicle/vehicle-listing.service";

describe("VehicleListingService", () => {
  it("upserts, publishes, and unpublishes a listing profile", async () => {
    const { prisma, service, user } = createHarness();

    const saved = await service.upsertListingProfile(
      "vehicle-1",
      {
        batteryHealthPercent: 91,
        conditionGrade: VehicleListingConditionGrade.B,
        displayName: "ES6 长续航现车",
        portalVisible: false,
        sellingPoints: ["一车一况"]
      },
      user
    );

    expect(saved).toMatchObject({
      batteryHealthPercent: 91,
      conditionGrade: VehicleListingConditionGrade.B,
      displayName: "ES6 长续航现车"
    });
    expect(prisma.vehicleListingProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          createdBy: user.id,
          vehicleId: "vehicle-1"
        }),
        update: expect.objectContaining({
          updatedBy: user.id
        })
      })
    );

    const published = await service.publishListingProfile("vehicle-1", user);
    expect(published).toMatchObject({ listingStatus: VehicleListingStatus.PUBLISHED, portalVisible: true });

    const unpublished = await service.unpublishListingProfile("vehicle-1", user);
    expect(unpublished).toMatchObject({ listingStatus: VehicleListingStatus.UNPUBLISHED, portalVisible: false });
  });

  it("uploads listing media through private storage and can set cover", async () => {
    const { prisma, service, storageService, user } = createHarness();

    const media = await service.uploadMedia(
      "vehicle-1",
      { isCover: true, mediaCategory: VehicleListingMediaCategory.COVER },
      [
        {
          buffer: Buffer.from("image"),
          mimetype: "image/jpeg",
          originalname: "cover.jpg",
          size: 5
        }
      ],
      user
    );

    expect(storageService.putVehicleListingMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        originalName: "cover.jpg",
        vehicleId: "vehicle-1"
      })
    );
    expect(prisma.vehicleListingMedia.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { isCover: false }
      })
    );
    expect(media).toMatchObject({
      bucket: "private-bucket",
      isCover: true,
      mediaCategory: VehicleListingMediaCategory.COVER,
      objectKey: "vehicle-listings/vehicle-1/2026/cover.jpg"
    });
  });

  it("rejects video uploads in the first vehicle listing media version", async () => {
    const { service, storageService, user } = createHarness();

    await expect(
      service.uploadMedia(
        "vehicle-1",
        { mediaCategory: VehicleListingMediaCategory.OTHER },
        [
          {
            buffer: Buffer.from("video"),
            mimetype: "video/mp4",
            originalname: "walkaround.mp4",
            size: 5
          }
        ],
        user
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storageService.putVehicleListingMedia).not.toHaveBeenCalled();
  });

  it("saves listing plan configuration for active matching plans only", async () => {
    const { service, tx, user } = createHarness();

    const result = await service.putListingPlans(
      "vehicle-1",
      {
        plans: [
          {
            displayMonthlyFeeAmount: 690000,
            recommended: true,
            sortOrder: 0,
            subscriptionPlanId: "plan-1",
            visible: true
          }
        ]
      },
      user
    );

    expect(tx.vehicleListingPlan.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          displayMonthlyFeeAmount: 690000n,
          listingProfileId: "listing-profile-1",
          subscriptionPlanId: "plan-1",
          vehicleId: "vehicle-1",
          visible: true
        })
      })
    );
    expect(result.availablePlans).toHaveLength(1);
  });
});

function createHarness() {
  const vehicle = createVehicle();
  const plan = createPlan();
  const profile = createProfile();
  const media = createMedia();
  const tx = {
    vehicleListingPlan: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async () => ({ ...createListingPlan(), displayMonthlyFeeAmount: 690000n }))
    }
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    subscriptionPlan: {
      findMany: vi.fn(async () => [plan])
    },
    vehicle: {
      findFirst: vi.fn(async () => vehicle)
    },
    vehicleListingMedia: {
      create: vi.fn(async () => media),
      findFirst: vi.fn(async () => media),
      findMany: vi.fn(async () => [media]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...media, ...data })),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    vehicleListingPlan: {
      findMany: vi.fn(async () => [createListingPlan()]),
      updateMany: vi.fn(async () => ({ count: 0 }))
    },
    vehicleListingProfile: {
      findUnique: vi.fn(async () => profile),
      updateMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async ({ create, update }: { create?: Record<string, unknown>; update?: Record<string, unknown> }) => ({
        ...profile,
        ...create,
        ...update
      }))
    }
  };
  const storageService = {
    getVehicleListingMediaStream: vi.fn(),
    putVehicleListingMedia: vi.fn(async () => ({
      bucket: "private-bucket",
      objectKey: "vehicle-listings/vehicle-1/2026/cover.jpg",
      stored: {
        driver: "local" as const,
        key: "application-materials/vehicle-listings/vehicle-1/2026/cover.jpg",
        size: 5
      }
    }))
  };
  const service = new VehicleListingService(prisma as never, storageService as never);
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: ["vehicle:manage"],
    roles: [],
    username: "admin"
  };

  return { media, plan, prisma, service, storageService, tx, user, vehicle };
}

function createVehicle() {
  const now = new Date("2026-06-21T10:00:00.000Z");
  return {
    assetLocation: "上海",
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: now,
    currentMileageKm: 12000,
    currentSalePriceAmount: 20000000n,
    deletedAt: null,
    id: "vehicle-1",
    model: "ES6",
    modelYear: 2025,
    purchasePriceAmount: 26000000n,
    salePriceStatus: "EFFECTIVE",
    series: "ES6",
    status: VehicleStatus.AVAILABLE,
    updatedAt: now,
    vehicleModel: VehicleModel.ES6,
    vehicleNo: "VH001"
  };
}

function createProfile() {
  const now = new Date("2026-06-21T10:00:00.000Z");
  return {
    applicationNotice: null,
    batteryHealthCheckedAt: null,
    batteryHealthPercent: new Prisma.Decimal(91),
    batteryRemark: null,
    conditionGrade: VehicleListingConditionGrade.B,
    conditionSummary: null,
    createdAt: now,
    createdBy: "user-1",
    customerTags: null,
    deletedAt: null,
    displayName: "ES6 长续航现车",
    estimatedRangeKm: null,
    faqSnapshot: null,
    feeDescription: null,
    hasFireDamage: false,
    hasFloodDamage: false,
    hasMajorAccident: false,
    hasStructuralDamage: false,
    highlightSummary: null,
    id: "listing-profile-1",
    knownDefectsSummary: null,
    listingStatus: VehicleListingStatus.DRAFT,
    media: [],
    plans: [],
    portalVisible: false,
    publishedAt: null,
    sellingPoints: ["一车一况"],
    serviceHighlights: null,
    shortTitle: null,
    sortOrder: 0,
    subtitle: null,
    unpublishedAt: null,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleId: "vehicle-1"
  };
}

function createMedia() {
  const now = new Date("2026-06-21T10:00:00.000Z");
  return {
    bucket: "private-bucket",
    caption: null,
    createdAt: now,
    customerVisible: true,
    deletedAt: null,
    fileName: "cover.jpg",
    fileSize: 5,
    id: "media-1",
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
  };
}

function createListingPlan() {
  const now = new Date("2026-06-21T10:00:00.000Z");
  return {
    createdAt: now,
    deletedAt: null,
    displayMonthlyFeeAmount: 690000n,
    displayRemark: null,
    id: "listing-plan-1",
    listingProfileId: "listing-profile-1",
    recommended: true,
    sortOrder: 0,
    subscriptionPlan: {
      id: "plan-1",
      planName: "安心订阅 12 个月",
      planNo: "PLAN-1",
      status: SubscriptionPlanStatus.ACTIVE
    },
    subscriptionPlanId: "plan-1",
    updatedAt: now,
    vehicleId: "vehicle-1",
    visible: true
  };
}

function createPlan() {
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
    id: "plan-1",
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
    planNo: "PLAN-1",
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
      monthlyFeeRate: new Prisma.Decimal("0.04"),
      packageName: "ES6 基础车包",
      productId: "product-1",
      productVersionId: "version-1",
      status: RecordStatus.ACTIVE,
      vehicleModel: VehicleModel.ES6
    },
    vehiclePackageId: "vehicle-package-1"
  };
}
