import {
  BenefitType,
  MonthlyFeeMode,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  RecordStatus,
  SubscriptionPlanStatus,
  VehicleModel
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { ProductService } from "../src/product/product.service";

const now = new Date("2026-06-02T00:00:00.000Z");
const user = {
  id: "user-1",
  menus: [],
  name: "Admin",
  permissions: [],
  roles: ["ADMIN"],
  username: "admin"
};
const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
const product = {
  createdAt: now,
  createdBy: "user-1",
  deletedAt: null,
  description: null,
  id: "product-1",
  name: "Subscription",
  productNo: "PRD202606020001",
  productType: ProductType.SUBSCRIPTION,
  status: ProductStatus.ACTIVE,
  updatedAt: now,
  updatedBy: "user-1"
};
const version = {
  approvedAt: now,
  approvedBy: "user-1",
  approver: null,
  benefitPackages: [],
  createdAt: now,
  createdBy: "user-1",
  deletedAt: null,
  effectiveFrom: now,
  effectiveTo: null,
  energyPackages: [],
  id: "version-1",
  mileagePackages: [],
  priceRules: [],
  product,
  productId: "product-1",
  status: ProductVersionStatus.APPROVED,
  updatedAt: now,
  updatedBy: "user-1",
  vehiclePackages: [],
  versionNo: "V1.0"
};

describe("subscription plan backend flow", () => {
  it("creates a subscription plan with packages from the same product version", async () => {
    const { audit, prisma, service } = makeService();

    const plan = await service.createSubscriptionPlan(createPlanDto(), user, context);

    expect(plan).toMatchObject({
      planName: "ET5 standard 12 months",
      productId: "product-1",
      productVersionId: "version-1",
      status: SubscriptionPlanStatus.DRAFT
    });
    expect(prisma.subscriptionPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          monthlyFeeMode: MonthlyFeeMode.MANUAL_QUOTE,
          vehiclePackageId: "vehicle-1"
        })
      })
    );
    expect(audit.write).toHaveBeenCalledOnce();
  });

  it("rejects creating a subscription plan when packages cross product versions", async () => {
    const { service } = makeService({
      mileagePackage: makeMileagePackage({ productVersionId: "version-2" })
    });

    await expect(service.createSubscriptionPlan(createPlanDto(), user, context)).rejects.toThrow(/鍚屼竴涓骇鍝佺増鏈?);
  });

  it("rejects activating a subscription plan while related packages are inactive", async () => {
    const inactivePlan = makeSubscriptionPlan({
      vehiclePackage: makeVehiclePackage({ status: RecordStatus.INACTIVE })
    });
    const { service } = makeService({ plan: inactivePlan });

    await expect(
      service.setSubscriptionPlanStatus("plan-1", SubscriptionPlanStatus.ACTIVE, user, context)
    ).rejects.toThrow(/璇峰厛鍚敤濂楅鍏宠仈/);
  });

  it("activates product versions when an active subscription plan exists without price rules", async () => {
    const activeVersion = { ...version, status: ProductVersionStatus.ACTIVE };
    const { prisma, service } = makeService({
      activePlan: makeSubscriptionPlan({ status: SubscriptionPlanStatus.ACTIVE })
    });
    prisma.productVersion.update.mockResolvedValueOnce(activeVersion);

    await expect(service.activateVersion("version-1", user, context)).resolves.toMatchObject({
      id: "version-1",
      status: ProductVersionStatus.ACTIVE
    });
    expect(prisma.subscriptionPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ productVersionId: "version-1", status: SubscriptionPlanStatus.ACTIVE })
      })
    );
  });

  it("rejects activating product versions without an active subscription plan", async () => {
    const { service } = makeService({ activePlan: null });

    await expect(service.activateVersion("version-1", user, context)).rejects.toThrow(/璁㈤槄濂楅/);
  });
});

function makeService(seed: Partial<MockSeed> = {}) {
  const audit = { write: vi.fn().mockResolvedValue(undefined) };
  const plan = seed.plan ?? makeSubscriptionPlan();
  const prisma = {
    $transaction: vi.fn(),
    benefitPackage: {
      findUnique: vi.fn().mockResolvedValue(seed.benefitPackage ?? makeBenefitPackage())
    },
    energyPackage: {
      findUnique: vi.fn().mockResolvedValue(seed.energyPackage ?? makeEnergyPackage())
    },
    mileagePackage: {
      findUnique: vi.fn().mockResolvedValue(seed.mileagePackage ?? makeMileagePackage())
    },
    product: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(seed.product ?? product)
    },
    productVersion: {
      findUnique: vi.fn().mockResolvedValue(seed.version ?? version),
      update: vi.fn().mockResolvedValue({ ...version, status: ProductVersionStatus.ACTIVE }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 })
    },
    subscriptionPlan: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve(makeSubscriptionPlan({ ...data, status: data.status }))),
      findFirst: vi.fn().mockResolvedValue(seed.activePlan === undefined ? plan : seed.activePlan),
      findMany: vi.fn().mockResolvedValue(seed.plans ?? []),
      findUnique: vi.fn().mockResolvedValue(plan),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve(makeSubscriptionPlan({ ...plan, ...data })))
    },
    vehiclePackage: {
      findUnique: vi.fn().mockResolvedValue(seed.vehiclePackage ?? makeVehiclePackage())
    }
  };
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) => callback(prisma));

  return { audit, prisma, service: new ProductService(audit as never, prisma as never) };
}

function createPlanDto() {
  return {
    effectiveFrom: "2026-06-01",
    energyPackageId: "energy-1",
    maxPeriodMonths: 36,
    mileagePackageId: "mileage-1",
    minPeriodMonths: 12,
    monthlyFeeRate: 0.035,
    planName: "ET5 standard 12 months",
    productId: "product-1",
    productVersionId: "version-1",
    vehiclePackageId: "vehicle-1"
  };
}

function makeSubscriptionPlan(overrides: Record<string, unknown> = {}) {
  const vehiclePackage = (overrides.vehiclePackage as ReturnType<typeof makeVehiclePackage>) ?? makeVehiclePackage();
  const mileagePackage = (overrides.mileagePackage as ReturnType<typeof makeMileagePackage>) ?? makeMileagePackage();
  const energyPackage = (overrides.energyPackage as ReturnType<typeof makeEnergyPackage>) ?? makeEnergyPackage();
  const benefitPackage =
    overrides.benefitPackage === null
      ? null
      : ((overrides.benefitPackage as ReturnType<typeof makeBenefitPackage>) ?? makeBenefitPackage());
  return {
    baseMonthlyFeeAmount: null,
    benefitPackage,
    benefitPackageId: benefitPackage?.id ?? null,
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    effectiveFrom: now,
    effectiveTo: null,
    energyPackage,
    energyPackageId: energyPackage.id,
    id: "plan-1",
    maxPeriodMonths: 36,
    mileagePackage,
    mileagePackageId: mileagePackage.id,
    minPeriodMonths: 12,
    monthlyFeeCapRate: null,
    monthlyFeeMode: MonthlyFeeMode.MANUAL_QUOTE,
    monthlyFeeRate: new Prisma.Decimal("0.035"),
    planName: "ET5 standard 12 months",
    planNo: "PLAN2026060200001",
    product,
    productId: "product-1",
    productVersion: { ...version, status: ProductVersionStatus.ACTIVE },
    productVersionId: "version-1",
    remark: null,
    status: SubscriptionPlanStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    vehiclePackage,
    vehiclePackageId: vehiclePackage.id,
    ...overrides
  };
}

function makeVehiclePackage(overrides: Record<string, unknown> = {}) {
  return {
    brand: null,
    configName: null,
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    id: "vehicle-1",
    maxPeriodMonths: 36,
    maxPurchasePriceAmount: BigInt(18000000),
    minPeriodMonths: 12,
    minPurchasePriceAmount: BigInt(12000000),
    monthlyFeeRate: new Prisma.Decimal("0.035"),
    packageName: "ET5 standard",
    packageNo: "VPK2026060200001",
    product,
    productId: "product-1",
    productVersion: version,
    productVersionId: "version-1",
    remark: null,
    series: null,
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleModel: VehicleModel.ET5,
    vehicleModelName: null,
    ...overrides
  };
}

function makeMileagePackage(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    id: "mileage-1",
    monthlyMileageKm: 1500,
    overMileageFeeAmount: BigInt(100),
    packageName: "1500km",
    packageNo: "MPK2026060200001",
    priceAmount: BigInt(0),
    product,
    productId: "product-1",
    productVersion: version,
    productVersionId: "version-1",
    remark: null,
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    ...overrides
  };
}

function makeEnergyPackage(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    id: "energy-1",
    monthlyEnergyCount: 8,
    monthlyEnergyKwh: 300,
    packageName: "300kWh",
    packageNo: "EPK2026060200001",
    priceAmount: BigInt(0),
    product,
    productId: "product-1",
    productVersion: version,
    productVersionId: "version-1",
    remark: null,
    serviceDescription: null,
    stationScope: null,
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    ...overrides
  };
}

function makeBenefitPackage(overrides: Record<string, unknown> = {}) {
  return {
    benefitCount: 4,
    benefitType: BenefitType.WASH_CAR,
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    description: "Wash x4",
    id: "benefit-1",
    packageName: "Wash x4",
    packageNo: "BPK2026060200001",
    priceAmount: BigInt(0),
    product,
    productId: "product-1",
    productVersion: version,
    productVersionId: "version-1",
    remark: null,
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    ...overrides
  };
}

interface MockSeed {
  activePlan: ReturnType<typeof makeSubscriptionPlan> | null;
  benefitPackage: ReturnType<typeof makeBenefitPackage>;
  energyPackage: ReturnType<typeof makeEnergyPackage>;
  mileagePackage: ReturnType<typeof makeMileagePackage>;
  plan: ReturnType<typeof makeSubscriptionPlan>;
  plans: ReturnType<typeof makeSubscriptionPlan>[];
  product: typeof product;
  vehiclePackage: ReturnType<typeof makeVehiclePackage>;
  version: typeof version;
}
