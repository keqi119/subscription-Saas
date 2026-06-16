import {
  ApplicationSource,
  ApplicationStatus,
  DepositStatus,
  MaterialStatus,
  MonthlyFeeMode,
  OrderReviewStatus,
  PlanConfirmStatus,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  RecordStatus,
  SalePriceStatus,
  SubscriptionPlanStatus,
  UserStatus,
  VehicleBatteryUsageType,
  VehicleModel,
  VehicleStatus
} from "@prisma/client";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { PortalApplicationService } from "../src/portal/portal-application.service";
import { PortalCatalogService } from "../src/portal/portal-catalog.service";

describe("PortalCatalogService", () => {
  it("lists public vehicles without internal asset fields", async () => {
    const prisma = createCatalogPrisma();
    const service = new PortalCatalogService(prisma as never);

    const rows = await service.listVehicles();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      available: true,
      brand: "NIO",
      displayName: "NIO ES6 ES6 2025款",
      statusLabel: "可申请"
    });
    expect(rows[0]).not.toHaveProperty("purchasePriceAmount");
    expect(rows[0]).not.toHaveProperty("vin");
    expect(rows[0]).not.toHaveProperty("plateNo");
    expect(rows[0]).not.toHaveProperty("currentSalePriceAmount");
  });

  it("returns active subscription plans for a public vehicle", async () => {
    const prisma = createCatalogPrisma();
    const service = new PortalCatalogService(prisma as never);

    const detail = await service.getVehicle("vehicle-1");

    expect(detail.subscriptionPlans).toHaveLength(1);
    expect(detail.subscriptionPlans[0]).toEqual(
      expect.objectContaining({
        canSubmit: true,
        depositDescription: "押金金额将根据审核结果最终确认。",
        monthlyFeeAmount: 735000,
        planId: "plan-1",
        planName: "安心订阅 12 个月"
      })
    );
  });
});

describe("PortalApplicationService", () => {
  it("creates a self-service application for the current customer without returning order data", async () => {
    const { customerService, prisma, service } = createPortalApplicationFixture();

    const result = await service.createApplication(
      {
        subscriptionPeriodMonths: 12,
        subscriptionPlanId: "plan-1",
        vehicleId: "vehicle-1"
      },
      currentCustomer("customer-1"),
      requestContext()
    );

    expect(customerService.createSelfServiceApplication).toHaveBeenCalledWith(
      {
        customerId: "customer-1",
        periodMonths: 12,
        subscriptionPlanId: "plan-1",
        vehicleId: "vehicle-1"
      },
      expect.objectContaining({ id: "user-1" }),
      requestContext()
    );
    expect(result).toEqual(
      expect.objectContaining({
        applicationId: "application-created",
        depositStatus: DepositStatus.PENDING_CONFIRM,
        status: ApplicationStatus.SUBMITTED
      })
    );
    expect(result).not.toHaveProperty("orderId");
    expect(prisma.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "portal_self_service_application",
        operatorId: "account-1"
      })
    );
  });

  it("only returns applications owned by the current customer", async () => {
    const { service } = createPortalApplicationFixture();

    await expect(service.getApplication("application-1", currentCustomer("customer-other"))).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("uploads materials through StorageService and does not expose object storage URLs", async () => {
    const { service, storageService } = createPortalApplicationFixture();

    const result = await service.uploadMaterial(
      "application-1",
      { materialType: "ID_CARD" },
      [
        {
          buffer: Buffer.from("hello"),
          mimetype: "text/plain",
          originalname: "id-card.txt",
          size: 5
        }
      ],
      currentCustomer("customer-1"),
      requestContext()
    );

    expect(storageService.putApplicationMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: "application-1", originalName: "id-card.txt" })
    );
    expect(result.files[0]).toEqual(
      expect.objectContaining({
        fileName: "id-card.txt",
        previewUrl: "/api/portal/applications/application-1/materials/material-file-1/preview"
      })
    );
    expect(result.files[0]).not.toHaveProperty("objectKey");
    expect(result.files[0]).not.toHaveProperty("bucket");
  });

  it("blocks material upload to another customer's application", async () => {
    const { service, storageService } = createPortalApplicationFixture();

    await expect(
      service.uploadMaterial(
        "application-1",
        { materialType: "ID_CARD" },
        [
          {
            buffer: Buffer.from("hello"),
            mimetype: "text/plain",
            originalname: "id-card.txt",
            size: 5
          }
        ],
        currentCustomer("customer-other"),
        requestContext()
      )
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(storageService.putApplicationMaterial).not.toHaveBeenCalled();
  });

  it("streams material previews only for the owning customer", async () => {
    const { service, storageService } = createPortalApplicationFixture();

    const preview = await service.previewMaterialFile(
      "application-1",
      "material-file-1",
      currentCustomer("customer-1")
    );

    expect(preview.filename).toBe("id-card.txt");
    expect(storageService.getObject).toHaveBeenCalledWith("application-materials", "materials/application-1/file.txt");

    await expect(
      service.previewMaterialFile("application-1", "material-file-1", currentCustomer("customer-other"))
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("cancels only mutable customer-owned applications", async () => {
    const { customerService, prisma, service } = createPortalApplicationFixture();

    const result = await service.cancelApplication("application-1", currentCustomer("customer-1"), requestContext());

    expect(customerService.cancelApplication).toHaveBeenCalledWith(
      "application-1",
      { comment: "客户从门户取消申请。" },
      expect.objectContaining({ id: "user-1" }),
      requestContext()
    );
    expect(result.status).toBe(ApplicationStatus.CANCELLED);
    expect(prisma.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "portal_self_service_application",
        operatorId: "account-1"
      })
    );
  });

  it("rejects customer cancellation after approval", async () => {
    const { service } = createPortalApplicationFixture({
      application: { status: ApplicationStatus.APPROVED }
    });

    await expect(
      service.cancelApplication("application-1", currentCustomer("customer-1"), requestContext())
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

function createCatalogPrisma() {
  return {
    subscriptionPlan: {
      findMany: vi.fn(async () => [createPlan()])
    },
    vehicle: {
      findFirst: vi.fn(async () => createVehicle()),
      findMany: vi.fn(async () => [createVehicle()])
    }
  };
}

function createPortalApplicationFixture(overrides: { application?: Record<string, unknown> } = {}) {
  const application = createApplication(overrides.application);
  const users = [createUser()];
  const tx = createPortalTransaction(application);
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    application: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id !== application.id || where.customerId !== application.customerId) {
          return null;
        }
        return application;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.customerId === application.customerId ? [application] : []
      )
    },
    applicationMaterialFile: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const applicationFilter = where.application as { customerId?: string } | undefined;
        if (
          where.id !== "material-file-1" ||
          where.applicationId !== application.id ||
          applicationFilter?.customerId !== application.customerId
        ) {
          return null;
        }
        return {
          file: {
            bucket: "application-materials",
            objectKey: "materials/application-1/file.txt"
          },
          fileName: "id-card.txt",
          mimeType: "text/plain",
          sizeBytes: 5n
        };
      })
    },
    auditLog: vi.fn(),
    customer: {
      findFirst: vi.fn(async () => ({ ownerUserId: "user-1" }))
    },
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
        users.find((user) => !where.id || user.id === where.id) ?? null
      )
    }
  };
  const auditService = {
    write: vi.fn(async (input: unknown) => prisma.auditLog(input))
  };
  const configService = {
    get: vi.fn(() => undefined)
  };
  const customerService = {
    cancelApplication: vi.fn(async () => {
      (application as { status: ApplicationStatus }).status = ApplicationStatus.CANCELLED;
      return application;
    }),
    createSelfServiceApplication: vi.fn(async () => ({
      applicationId: "application-created",
      applicationNo: "APP202606160001",
      depositStatus: DepositStatus.PENDING_CONFIRM,
      message: "申请已提交",
      status: ApplicationStatus.SUBMITTED,
      vehicleStatus: VehicleStatus.REVIEW_RESERVED
    }))
  };
  const storageService = {
    getObject: vi.fn(async () => ({
      contentLength: 5,
      contentType: "text/plain",
      stream: Readable.from(["hello"])
    })),
    putApplicationMaterial: vi.fn(async () => ({
      bucket: "application-materials",
      objectKey: "materials/application-1/file.txt",
      stored: { driver: "local", key: "materials/application-1/file.txt", size: 5 }
    }))
  };

  const service = new PortalApplicationService(
    auditService as never,
    configService as never,
    customerService as never,
    prisma as never,
    storageService as never
  );

  return { application, auditService, customerService, prisma, service, storageService, tx };
}

function createPortalTransaction(application: ReturnType<typeof createApplication>) {
  const materialGroup = {
    createdAt: new Date("2026-06-16T10:00:00.000Z"),
    createdBy: "user-1",
    deletedAt: null,
    files: [
      {
        applicationId: application.id,
        createdAt: new Date("2026-06-16T10:00:00.000Z"),
        createdBy: "user-1",
        deletedAt: null,
        deletedBy: null,
        deleteReason: null,
        file: {
          bucket: "application-materials",
          id: "file-1",
          objectKey: "materials/application-1/file.txt",
          originalName: "id-card.txt"
        },
        fileId: "file-1",
        fileName: "id-card.txt",
        id: "material-file-1",
        isDeleted: false,
        materialGroupId: "material-group-1",
        materialType: "ID_CARD",
        mimeType: "text/plain",
        sizeBytes: 5n,
        updatedAt: new Date("2026-06-16T10:00:00.000Z"),
        updatedBy: "user-1",
        uploadedAt: new Date("2026-06-16T10:00:00.000Z"),
        uploadedBy: "user-1"
      }
    ],
    id: "material-group-1",
    materialName: "身份证",
    materialType: "ID_CARD",
    required: true,
    reviewComment: null,
    reviewedAt: null,
    reviewedBy: null,
    reviewStatus: MaterialStatus.PENDING,
    updatedAt: new Date("2026-06-16T10:00:00.000Z"),
    updatedBy: "user-1"
  };

  return {
    applicationActionLog: {
      create: vi.fn(async () => ({}))
    },
    applicationMaterialFile: {
      create: vi.fn(async () => materialGroup.files[0])
    },
    applicationMaterialGroup: {
      findUniqueOrThrow: vi.fn(async () => materialGroup),
      upsert: vi.fn(async () => materialGroup)
    },
    fileObject: {
      create: vi.fn(async () => ({
        bucket: "application-materials",
        id: "file-1",
        objectKey: "materials/application-1/file.txt",
        originalName: "id-card.txt"
      }))
    }
  };
}

function createApplication(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-16T10:00:00.000Z");
  return {
    applicationNo: "APP202606160001",
    applicationSource: ApplicationSource.SELF_SERVICE,
    approvedAt: null,
    createdAt: now,
    createdBy: "user-1",
    creditReviewComment: null,
    creditReviewStatus: OrderReviewStatus.PENDING,
    customerId: "customer-1",
    customerSelectedSnapshot: null,
    deletedAt: null,
    depositRuleId: null,
    depositRuleSnapshot: null,
    depositStatus: DepositStatus.PENDING_CONFIRM,
    finalDepositAmount: null,
    finalPeriodMonths: null,
    finalPlanConfirmedAt: null,
    finalPlanSnapshot: null,
    finalQuoteSnapshot: null,
    finalSubscriptionPlanId: null,
    finalVehicleBaseFeeAmount: null,
    finalVehicleId: null,
    id: "application-1",
    intentPeriodMonths: 12,
    intentSnapshot: {
      depositDescription: "押金金额将根据审核结果最终确认。",
      packageSnapshot: {
        pricing: { monthlyFeeAmount: 735000 },
        subscriptionPlan: { planName: "安心订阅 12 个月" }
      },
      periodMonths: 12,
      subscriptionPlanId: "plan-1",
      vehicleId: "vehicle-1",
      vehicleSnapshot: {
        assetLocation: "上海",
        batteryCapacityKwh: 75,
        batteryUsageType: VehicleBatteryUsageType.BUYOUT,
        batteryUsageTypeLabel: "电池买断",
        brand: "NIO",
        currentMileageKm: 12000,
        plateNo: "沪A12345",
        series: "ES6",
        vehicleModel: VehicleModel.ES6,
        vin: "VIN1234567890"
      }
    },
    intentSubscriptionPlanId: "plan-1",
    intentVehicleBaseFeeAmount: 700000n,
    intentVehicleId: "vehicle-1",
    intendedModel: VehicleModel.ES6,
    intendedPeriodMonths: 12,
    materialGroups: [],
    materialReviewStatus: OrderReviewStatus.PENDING,
    orders: [],
    planConfirmStatus: PlanConfirmStatus.PENDING,
    productReviewStatus: OrderReviewStatus.PENDING,
    rejectedReason: null,
    salesUser: { id: "user-1", name: "Admin", username: "admin" },
    salesUserId: "user-1",
    softReservationExpiresAt: null,
    softReservedAt: now,
    softReservedVehicleId: "vehicle-1",
    status: ApplicationStatus.SUBMITTED,
    submittedAt: now,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleReviewStatus: OrderReviewStatus.PENDING,
    ...overrides
  };
}

function createVehicle() {
  const now = new Date("2026-06-16T10:00:00.000Z");
  return {
    acquisitionMode: "OWNED_CASH",
    assetLocation: "上海",
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: now,
    createdBy: "user-1",
    currentMileageKm: 12000,
    currentSalePriceAmount: 20000000n,
    currentSalePriceInitializedAt: now,
    currentSalePriceReviewedAt: now,
    deletedAt: null,
    id: "vehicle-1",
    insuranceEndDate: null,
    insuranceStartDate: null,
    latestRegistrationDate: null,
    model: "ES6",
    modelYear: 2025,
    nextSalePriceReviewAt: null,
    plateNo: "沪A12345",
    purchaseDate: null,
    purchasePriceAmount: 26000000n,
    registrationDate: null,
    remark: null,
    salePriceReinitRequiredAt: null,
    salePriceStatus: SalePriceStatus.EFFECTIVE,
    series: "ES6",
    status: VehicleStatus.AVAILABLE,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleModel: VehicleModel.ES6,
    vehicleNo: "VH001",
    vin: "VIN1234567890"
  };
}

function createPlan() {
  const now = new Date("2026-06-16T10:00:00.000Z");
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
    benefitPackage: {
      benefitCount: 1,
      benefitType: "POINTS",
      deletedAt: null,
      description: "基础权益",
      id: "benefit-package-1",
      packageName: "基础权益包",
      priceAmount: 5000n,
      productId: "product-1",
      productVersionId: "version-1",
      status: RecordStatus.ACTIVE
    },
    benefitPackageId: "benefit-package-1",
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
    planNo: "PLAN001",
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

function createUser() {
  return {
    id: "user-1",
    name: "Admin",
    status: UserStatus.ACTIVE,
    username: "admin"
  };
}

function currentCustomer(customerId: string) {
  return {
    accountStatus: "ACTIVE" as const,
    customerAccountId: "account-1",
    customerId,
    phone: "13800000000"
  };
}

function requestContext() {
  return {
    ipAddress: "127.0.0.1",
    userAgent: "vitest"
  };
}
