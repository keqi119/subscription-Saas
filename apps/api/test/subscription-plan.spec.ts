import {
  ApplicationStatus,
  BenefitType,
  CustomerGrade,
  MonthlyFeeMode,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  QuoteStatus,
  RecordStatus,
  RiskResultDecision,
  SalePriceStatus,
  SubscriptionPlanStatus,
  VehicleStatus,
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

    const plan = await service.createSubscriptionPlan(
      createPlanDto(),
      user,
      context
    );

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

    await expect(
      service.createSubscriptionPlan(createPlanDto(), user, context)
    ).rejects.toThrow("所选订阅组件不属于同一个产品版本");
  });

  it("rejects activating a subscription plan while related packages are inactive", async () => {
    const inactivePlan = makeSubscriptionPlan({
      vehiclePackage: makeVehiclePackage({ status: RecordStatus.INACTIVE })
    });
    const { service } = makeService({ plan: inactivePlan });

    await expect(
      service.setSubscriptionPlanStatus("plan-1", SubscriptionPlanStatus.ACTIVE, user, context)
    ).rejects.toThrow("请先启用套餐关联的车辆使用费、里程包、补能包和权益包");
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
    expect(prisma.productVersion.findUnique).toHaveBeenCalled();
    expect("findFirst" in prisma.productPriceRule).toBe(false);
  });

  it("rejects activating product versions without an active subscription plan", async () => {
    const { service } = makeService({ activePlan: null });

    await expect(service.activateVersion("version-1", user, context)).rejects.toThrow(
      "请先配置并启用至少一个订阅套餐后再激活产品版本"
    );
  });

  it("returns available subscription plans for approved applications", async () => {
    const { service } = makeService({
      plans: [makeSubscriptionPlan({ status: SubscriptionPlanStatus.ACTIVE })]
    });

    await expect(service.listAvailableSubscriptionPlans("application-1", user)).resolves.toMatchObject([
      {
        monthlyFeeCapRate: 0.035,
        monthlyFeeRate: 0.035,
        planName: "ET5 standard 12 months",
        productName: "Subscription",
        subscriptionPlanId: "plan-1",
        vehicleModel: VehicleModel.ET5
      }
    ]);
  });

  it("rejects available plan lookup and quote creation for non-approved applications", async () => {
    const draftApplication = makeApplication({ status: ApplicationStatus.DRAFT });
    const { service } = makeService({ application: draftApplication });

    await expect(service.listAvailableSubscriptionPlans("application-1", user)).rejects.toThrow(
      "只有审批通过的进件可以获取可报价套餐"
    );
    await expect(
      service.createQuote(
        "application-1",
        {
          periodMonths: 12,
          subscriptionPlanId: "plan-1",
          vehicleBaseFeeAmount: 420000,
          vehicleId: "vehicle-asset-1"
        },
        user,
        context
      )
    ).rejects.toThrow();
  });

  it("creates quotes from subscriptionPlanId and stores package and deposit snapshots", async () => {
    const { prisma, service } = makeService();

    const quote = await service.createQuote(
        "application-1",
        {
        periodMonths: 12,
        subscriptionPlanId: "plan-1",
        vehicleBaseFeeAmount: 420000,
        vehicleId: "vehicle-asset-1"
      },
      user,
      context
    );

    expect(quote).toMatchObject({
      monthlyFeeCapAmount: 420000,
      subscriptionPlanId: "plan-1",
      vehicleBaseFeeAmount: 420000,
      vehicleId: "vehicle-asset-1",
      vehiclePackageId: "vehicle-1"
    });
    expect(prisma.subscriptionQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          depositRuleSnapshot: expect.any(Object),
          energyPackageId: "energy-1",
          mileagePackageId: "mileage-1",
          monthlyFeeCapAmount: BigInt(420000),
          monthlyFeeAmount: BigInt(420000),
          packageSnapshot: expect.any(Object),
          productVersionId: "version-1",
          subscriptionPlanId: "plan-1",
          vehicleBaseFeeAmount: BigInt(420000),
          vehicleBaseFeeCapAmount: BigInt(420000),
          vehicleId: "vehicle-asset-1",
          vehiclePurchasePriceAmount: BigInt(10000000),
          vehicleSalePriceAmount: BigInt(12000000),
          vehicleSnapshot: expect.any(Object),
          vehiclePackageId: "vehicle-1"
        })
      })
    );
  });

  it("requires vehicleId for subscription plan quote creation", async () => {
    const { service } = makeService();

    await expect(
      service.createQuote(
        "application-1",
        {
          periodMonths: 12,
          subscriptionPlanId: "plan-1",
          vehicleBaseFeeAmount: 420000
        },
        user,
        context
      )
    ).rejects.toThrow("报价必须选择具体车辆");
  });

  it("rejects legacy purchase price and monthly fee fields for subscription plan quote creation", async () => {
    const { service } = makeService();

    await expect(
      service.createQuote(
        "application-1",
        {
          monthlyFeeAmount: 420000,
          periodMonths: 12,
          subscriptionPlanId: "plan-1",
          vehicleBaseFeeAmount: 420000,
          vehicleId: "vehicle-asset-1",
          vehiclePurchasePriceAmount: 12000000
        },
        user,
        context
      )
    ).rejects.toThrow("订阅套餐报价不再接收");
  });

  it("rejects quote creation when vehicle base fee exceeds the vehicle package cap", async () => {
    const { service } = makeService();

    await expect(
      service.createQuote(
        "application-1",
        {
          periodMonths: 12,
          subscriptionPlanId: "plan-1",
          vehicleBaseFeeAmount: 420001,
          vehicleId: "vehicle-asset-1"
        },
        user,
        context
      )
    ).rejects.toThrow("车辆基础费超过车型包系数允许上限");
  });

  it("allows package monthly fee total to exceed the vehicle base fee cap", async () => {
    const plan = makeSubscriptionPlan({
      benefitPackage: makeBenefitPackage({ priceAmount: BigInt(20000) }),
      energyPackage: makeEnergyPackage({ priceAmount: BigInt(50000) }),
      mileagePackage: makeMileagePackage({ priceAmount: BigInt(30000) })
    });
    const { prisma, service } = makeService({ plan });

    await service.createQuote(
      "application-1",
      {
        periodMonths: 12,
        subscriptionPlanId: "plan-1",
        vehicleBaseFeeAmount: 420000,
        vehicleId: "vehicle-asset-1"
      },
      user,
      context
    );

    expect(prisma.subscriptionQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          monthlyFeeAmount: BigInt(520000),
          vehicleBaseFeeCapAmount: BigInt(420000)
        })
      })
    );
  });

  it("rejects subscription plans that do not match selected vehicle model", async () => {
    const { service } = makeService({ vehicle: makeVehicle({ vehicleModel: VehicleModel.ET7 }) });

    await expect(
      service.createQuote(
        "application-1",
        {
          periodMonths: 12,
          subscriptionPlanId: "plan-1",
          vehicleBaseFeeAmount: 420000,
          vehicleId: "vehicle-asset-1"
        },
        user,
        context
      )
    ).rejects.toThrow("所选套餐不适用于该车型");
  });

  it("keeps old quotes without subscriptionPlanId readable and confirmable", async () => {
    const oldQuote = makeQuote({
      subscriptionPlan: null,
      subscriptionPlanId: null
    });
    const confirmedQuote = makeQuote({
      confirmedAt: now,
      confirmedBy: "user-1",
      status: QuoteStatus.CONFIRMED,
      subscriptionPlan: null,
      subscriptionPlanId: null
    });
    const { prisma, service } = makeService({ quote: oldQuote });
    prisma.subscriptionQuote.update.mockResolvedValueOnce(confirmedQuote);

    await expect(service.getQuote("quote-1", user)).resolves.toMatchObject({
      id: "quote-1",
      subscriptionPlanId: null
    });
    await expect(service.confirmQuote("quote-1", user, context)).resolves.toMatchObject({
      status: QuoteStatus.CONFIRMED,
      subscriptionPlanId: null
    });
  });
});

function makeService(seed: Partial<MockSeed> = {}) {
  const audit = { write: vi.fn().mockResolvedValue(undefined) };
  const plan = seed.plan ?? makeSubscriptionPlan();
  const quote = seed.quote ?? makeQuote({ subscriptionPlan: plan, subscriptionPlanId: plan.id });
  const prisma = {
    $transaction: vi.fn(),
    application: {
      findUnique: vi.fn().mockResolvedValue(seed.application ?? makeApplication())
    },
    benefitPackage: {
      findUnique: vi.fn().mockResolvedValue(seed.benefitPackage ?? makeBenefitPackage())
    },
    depositRule: {
      findFirst: vi.fn().mockResolvedValue(seed.depositRule ?? makeDepositRule())
    },
    energyPackage: {
      findUnique: vi.fn().mockResolvedValue(seed.energyPackage ?? makeEnergyPackage())
    },
    mileagePackage: {
      findUnique: vi.fn().mockResolvedValue(seed.mileagePackage ?? makeMileagePackage())
    },
    product: {
      findUnique: vi.fn().mockResolvedValue(seed.product ?? product)
    },
    productPriceRule: {
      findMany: vi.fn()
    },
    productVersion: {
      findUnique: vi.fn().mockResolvedValue(seed.version ?? version),
      update: vi.fn().mockResolvedValue({ ...version, status: ProductVersionStatus.ACTIVE }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 })
    },
    subscriptionPlan: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve(makeSubscriptionPlan(data))),
      findFirst: vi.fn().mockResolvedValue(seed.activePlan === undefined ? plan : seed.activePlan),
      findMany: vi.fn().mockResolvedValue(seed.plans ?? []),
      findUnique: vi.fn().mockResolvedValue(plan),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve(makeSubscriptionPlan({ ...plan, ...data })))
    },
    subscriptionQuote: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve(makeQuote({ ...data, subscriptionPlan: plan }))),
      findUnique: vi.fn().mockResolvedValue(quote),
      update: vi.fn().mockResolvedValue(makeQuote({ ...quote, status: QuoteStatus.CONFIRMED }))
    },
    vehicle: {
      findUnique: vi.fn().mockResolvedValue(seed.vehicle ?? makeVehicle()),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve(makeVehicle({ ...data })))
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

function makeApplication(overrides: Record<string, unknown> = {}) {
  return {
    applicationNo: "APP2026060200001",
    customer: {
      grade: CustomerGrade.A,
      id: "customer-1",
      mobile: "13800000000",
      name: "Customer"
    },
    customerId: "customer-1",
    deletedAt: null,
    id: "application-1",
    riskResults: [
      {
        createdAt: now,
        deletedAt: null,
        id: "risk-1",
        result: RiskResultDecision.APPROVED
      }
    ],
    salesUserId: "user-1",
    status: ApplicationStatus.APPROVED,
    ...overrides
  };
}

function makeDepositRule(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: now,
    createdBy: "user-1",
    customerRatio: null,
    defaultRate: new Prisma.Decimal("0.08"),
    deletedAt: null,
    depositAmount: BigInt(500000),
    effectiveFrom: now,
    effectiveTo: null,
    grade: CustomerGrade.A,
    id: "deposit-rule-1",
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    ...overrides
  };
}

function makeVehicle(overrides: Record<string, unknown> = {}) {
  return {
    assetLocation: "Shanghai",
    brand: "NIO",
    createdAt: now,
    createdBy: "user-1",
    currentMileageKm: 30000,
    currentSalePriceAmount: BigInt(12000000),
    currentSalePriceInitializedAt: now,
    currentSalePriceReviewedAt: now,
    deletedAt: null,
    id: "vehicle-asset-1",
    insuranceEndDate: null,
    insuranceStartDate: null,
    model: null,
    modelYear: null,
    nextSalePriceReviewAt: now,
    plateNo: "沪A12345",
    purchaseDate: null,
    purchasePriceAmount: BigInt(10000000),
    registrationDate: null,
    remark: null,
    salePriceStatus: SalePriceStatus.EFFECTIVE,
    series: "ET5",
    status: VehicleStatus.AVAILABLE,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleModel: VehicleModel.ET5,
    vehicleNo: "VEH2026060200001",
    vin: "VIN0001",
    ...overrides
  };
}

function makeQuote(overrides: Record<string, unknown> = {}) {
  const subscriptionPlan =
    overrides.subscriptionPlan === null
      ? null
      : ((overrides.subscriptionPlan as ReturnType<typeof makeSubscriptionPlan>) ?? makeSubscriptionPlan());
  return {
    application: { applicationNo: "APP2026060200001", id: "application-1", salesUserId: "user-1", status: ApplicationStatus.APPROVED },
    applicationId: "application-1",
    benefitPackage: subscriptionPlan?.benefitPackage ?? null,
    benefitPackageId: subscriptionPlan?.benefitPackageId ?? null,
    cancelledAt: null,
    confirmedAt: null,
    confirmedBy: null,
    confirmer: null,
    createdAt: now,
    createdBy: "user-1",
    customer: { grade: CustomerGrade.A, id: "customer-1", mobile: "13800000000", name: "Customer" },
    customerId: "customer-1",
    deletedAt: null,
    depositAmount: BigInt(500000),
    depositRuleSnapshot: null,
    energyLimitCount: 8,
    energyLimitKwh: 300,
    energyPackage: subscriptionPlan?.energyPackage ?? null,
    energyPackageId: subscriptionPlan?.energyPackageId ?? null,
    energyPackagePriceAmount: null,
    expiredAt: null,
    benefitPackagePriceAmount: null,
    id: "quote-1",
    mileageLimitKm: 1500,
    mileagePackage: subscriptionPlan?.mileagePackage ?? null,
    mileagePackageId: subscriptionPlan?.mileagePackageId ?? null,
    mileagePackagePriceAmount: null,
    monthlyFeeAmount: BigInt(420000),
    monthlyFeeCapAmount: BigInt(420000),
    monthlyFeeRate: new Prisma.Decimal("0.035"),
    order: null,
    overMileageFeeAmount: BigInt(100),
    packageSnapshot: null,
    periodMonths: 12,
    productId: "product-1",
    productVersion: { ...version, status: ProductVersionStatus.ACTIVE },
    productVersionId: "version-1",
    quoteNo: "QUO2026060200001",
    riskResult: { id: "risk-1" },
    riskResultId: "risk-1",
    status: QuoteStatus.DRAFT,
    subscriptionPlan,
    subscriptionPlanId: subscriptionPlan?.id ?? null,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleModel: VehicleModel.ET5,
    vehicle: null,
    vehicleBaseFeeAmount: null,
    vehicleBaseFeeCapAmount: null,
    vehicleId: null,
    vehiclePackage: subscriptionPlan?.vehiclePackage ?? null,
    vehiclePackageId: subscriptionPlan?.vehiclePackageId ?? null,
    vehiclePurchasePriceAmount: BigInt(12000000),
    vehicleSalePriceAmount: null,
    vehicleSnapshot: null,
    ...overrides
  };
}

interface MockSeed {
  activePlan: ReturnType<typeof makeSubscriptionPlan> | null;
  application: ReturnType<typeof makeApplication>;
  benefitPackage: ReturnType<typeof makeBenefitPackage>;
  depositRule: ReturnType<typeof makeDepositRule>;
  energyPackage: ReturnType<typeof makeEnergyPackage>;
  mileagePackage: ReturnType<typeof makeMileagePackage>;
  plan: ReturnType<typeof makeSubscriptionPlan>;
  plans: ReturnType<typeof makeSubscriptionPlan>[];
  product: typeof product;
  quote: ReturnType<typeof makeQuote>;
  vehicle: ReturnType<typeof makeVehicle>;
  vehiclePackage: ReturnType<typeof makeVehiclePackage>;
  version: typeof version;
}
