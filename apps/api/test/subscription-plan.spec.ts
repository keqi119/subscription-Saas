import {
  ApplicationSource,
  ApplicationStatus,
  BenefitType,
  CustomerGrade,
  DepositStatus,
  MonthlyFeeMode,
  OrderReviewStatus,
  PlanConfirmStatus,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  QuoteStatus,
  RecordStatus,
  RiskResultDecision,
  SalePriceStatus,
  SubscriptionPlanStatus,
  VehicleBatteryUsageType,
  VehicleStatus,
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
  status: ProductVersionStatus.APPROVED as ProductVersionStatus,
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
    expect(prisma.productPriceRule.findFirst).not.toHaveBeenCalled();
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
        monthlyFeeMode: MonthlyFeeMode.MANUAL_QUOTE,
        monthlyFeeModeLabel: "现场报价",
        monthlyFeeRate: 0.035,
        planName: "ET5 standard 12 months",
        productName: "Subscription",
        subscriptionPlanId: "plan-1",
        modelCode: "NIO_ET5"
      }
    ]);
  });

  it("discovers canonical plans for an assisted vehicle", async () => {
    const modelDefinition = makeModelDefinition();
    const canonicalPackage = makeVehiclePackage({
      modelDefinition,
      modelDefinitionId: modelDefinition.id
    });
    const { prisma, service } = makeService({
      plans: [makeSubscriptionPlan({ vehiclePackage: canonicalPackage })],
      vehicle: makeVehicle({
        modelDefinition,
        modelDefinitionId: modelDefinition.id
      })
    });

    await expect(
      service.listAvailableSubscriptionPlans("application-1", user, "vehicle-asset-1")
    ).resolves.toMatchObject([
      {
        modelCode: "NIO_ET5",
        subscriptionPlanId: "plan-1",
      }
    ]);
    expect(prisma.subscriptionPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ vehiclePackage: expect.anything() })
      })
    );
    expect(prisma.vehicle.findUnique).toHaveBeenCalledWith({
      include: { modelDefinition: { select: expect.any(Object) } },
      where: { id: "vehicle-asset-1" }
    });
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

  it("allows assisted applications to create quotes before product vehicle and final plan review", async () => {
    const assistedApplication = makeApplication({
      applicationSource: ApplicationSource.SALES_ASSISTED,
      creditReviewStatus: OrderReviewStatus.APPROVED,
      depositStatus: DepositStatus.CONFIRMED,
      finalSubscriptionPlanId: null,
      finalVehicleId: null,
      materialReviewStatus: OrderReviewStatus.APPROVED,
      planConfirmStatus: PlanConfirmStatus.PENDING,
      productReviewStatus: OrderReviewStatus.PENDING,
      vehicleReviewStatus: OrderReviewStatus.PENDING
    });
    const { service } = makeService({ application: assistedApplication });

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
    ).resolves.toMatchObject({
      subscriptionPlanId: "plan-1",
      vehicleId: "vehicle-asset-1"
    });
  });

  it("routes self-service applications away from the assisted quote endpoint", async () => {
    const selfServiceApplication = makeApplication({
      applicationSource: ApplicationSource.SELF_SERVICE
    });
    const { service } = makeService({ application: selfServiceApplication });

    await expect(service.listAvailableSubscriptionPlans("application-1", user)).rejects.toThrow(
      "客户自助进件请使用确认最终方案 / 生成正式订单流程。"
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
    ).rejects.toThrow("客户自助进件请使用确认最终方案 / 生成正式订单流程。");
  });

  it("creates quotes from subscriptionPlanId and stores package and deposit snapshots", async () => {
    const modelDefinition = makeModelDefinition();
    const { prisma, service } = makeService({
      vehicle: makeVehicle({
        modelDefinition,
        modelDefinitionId: modelDefinition.id
      })
    });

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
          modelCodeSnapshot: "NIO_ET5",
          modelDefinitionIdSnapshot: "model-et5",
          modelDisplayNameSnapshot: "NIO ET5",
          vehiclePurchasePriceAmount: BigInt(10000000),
          vehicleSalePriceAmount: BigInt(12000000),
          vehicleSnapshot: expect.objectContaining({
            batteryCapacityKwh: 75,
            batteryUsageType: VehicleBatteryUsageType.BUYOUT,
            batteryUsageTypeLabel: "电池买断"
          }),
          vehiclePackageId: "vehicle-1"
        })
      })
    );
  });

  it("resolves direct price-rule quotes to modelDefinitionId before querying ProductPriceRule", async () => {
    const modelDefinition = makeModelDefinition({ id: "model-et5" });
    const priceRule = makePriceRule({ modelDefinition, modelDefinitionId: modelDefinition.id });
    const { prisma, service } = makeService({
      modelDefinitions: [modelDefinition],
      priceRule,
      version: { ...version, status: ProductVersionStatus.ACTIVE }
    });

    await service.createQuote(
      "application-1",
      {
        monthlyFeeAmount: 420000,
        modelDefinitionId: modelDefinition.id,
        periodMonths: 12,
        productVersionId: "version-1",
        vehiclePurchasePriceAmount: 12000000
      },
      user,
      context
    );

    expect(prisma.vehicleModelDefinition.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: modelDefinition.id }
      })
    );
    expect(prisma.productPriceRule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          modelDefinitionId: modelDefinition.id,
          productVersionId: "version-1"
        })
      })
    );
    expect(prisma.subscriptionQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelCodeSnapshot: modelDefinition.modelCode,
          modelDefinitionIdSnapshot: modelDefinition.id,
          modelDisplayNameSnapshot: modelDefinition.displayName
        })
      })
    );
  });

  it("quote response exposes snapshot display metadata before runtime vehicle display", async () => {
    const runtimeDefinition = makeModelDefinition({ displayName: "Runtime ET5", id: "runtime-model" });
    const { service } = makeService({
      quote: makeQuote({
        modelCodeSnapshot: "NIO_ET5",
        modelDefinitionIdSnapshot: "snapshot-model",
        modelDisplayNameSnapshot: "Frozen ET5",
        vehicle: makeVehicle({
          modelDefinition: runtimeDefinition,
          modelDefinitionId: runtimeDefinition.id
        })
      })
    });

    const quote = (await service.getQuote("quote-1", user)) as {
      modelCodeSnapshot: string;
      modelDefinitionIdSnapshot: string;
      modelDisplayName: string;
      modelDisplaySource: string;
    };

    expect(quote).toMatchObject({
      modelCodeSnapshot: "NIO_ET5",
      modelDefinitionIdSnapshot: "snapshot-model",
      modelDisplayName: "Frozen ET5",
      modelDisplaySource: "SNAPSHOT"
    });
  });

  it("uses fixed amount subscription plan pricing and ignores submitted vehicle base fee", async () => {
    const plan = makeSubscriptionPlan({
      baseMonthlyFeeAmount: BigInt(360000),
      monthlyFeeMode: MonthlyFeeMode.FIXED_AMOUNT
    });
    const { prisma, service } = makeService({ plan });

    await service.createQuote(
      "application-1",
      {
        periodMonths: 12,
        subscriptionPlanId: "plan-1",
        vehicleBaseFeeAmount: 123456,
        vehicleId: "vehicle-asset-1"
      },
      user,
      context
    );

    expect(prisma.subscriptionQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          monthlyFeeAmount: BigInt(360000),
          packageSnapshot: expect.objectContaining({
            pricing: expect.objectContaining({
              benefitPackagePriceAmount: 0,
              currentSalePriceAmount: 12000000,
              energyPackagePriceAmount: 0,
              fixedRate: null,
              mileagePackagePriceAmount: 0,
              monthlyFeeAmount: 360000,
              vehicleBaseFeeAmount: 360000,
              vehicleBaseFeeCapAmount: 420000,
              vehicleBaseFeeMode: MonthlyFeeMode.FIXED_AMOUNT,
              vehicleBaseFeeModeLabel: "固定金额"
            }),
            vehicleBaseFeeAmount: 360000,
            vehicleBaseFeeCapAmount: 420000,
            vehicleBaseFeeMode: MonthlyFeeMode.FIXED_AMOUNT,
            vehicleBaseFeeModeLabel: "固定金额"
          }),
          vehicleBaseFeeAmount: BigInt(360000),
          vehicleBaseFeeCapAmount: BigInt(420000)
        })
      })
    );
  });

  it("uses fixed rate subscription plan pricing from the current vehicle sale price", async () => {
    const plan = makeSubscriptionPlan({
      monthlyFeeMode: MonthlyFeeMode.RATE_FORMULA,
      monthlyFeeRate: new Prisma.Decimal("0.02")
    });
    const { prisma, service } = makeService({ plan });

    await service.createQuote(
      "application-1",
      {
        periodMonths: 12,
        subscriptionPlanId: "plan-1",
        vehicleBaseFeeAmount: 123456,
        vehicleId: "vehicle-asset-1"
      },
      user,
      context
    );

    expect(prisma.subscriptionQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          monthlyFeeAmount: BigInt(240000),
          packageSnapshot: expect.objectContaining({
            pricing: expect.objectContaining({
              fixedRate: 0.02,
              monthlyFeeAmount: 240000,
              vehicleBaseFeeAmount: 240000,
              vehicleBaseFeeCapAmount: 420000,
              vehicleBaseFeeMode: MonthlyFeeMode.RATE_FORMULA,
              vehicleBaseFeeModeLabel: "固定费率"
            })
          }),
          vehicleBaseFeeAmount: BigInt(240000),
          vehicleBaseFeeCapAmount: BigInt(420000)
        })
      })
    );
  });

  it("requires vehicle base fee for manual quote subscription plans", async () => {
    const { service } = makeService();

    await expect(
      service.createQuote(
        "application-1",
        {
          periodMonths: 12,
          subscriptionPlanId: "plan-1",
          vehicleId: "vehicle-asset-1"
        },
        user,
        context
      )
    ).rejects.toThrow("车辆基础费报价必须大于 0");
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

  it("rejects fixed amount subscription plan pricing above the vehicle base fee cap", async () => {
    const plan = makeSubscriptionPlan({
      baseMonthlyFeeAmount: BigInt(420001),
      monthlyFeeMode: MonthlyFeeMode.FIXED_AMOUNT
    });
    const { service } = makeService({ plan });

    await expect(
      service.createQuote(
        "application-1",
        {
          periodMonths: 12,
          subscriptionPlanId: "plan-1",
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
    const et7Definition = makeModelDefinition({
      displayName: "NIO ET7",
      id: "model-et7",
      modelCode: "NIO_ET7"
    });
    const { service } = makeService({
      vehicle: makeVehicle({
        modelDefinition: et7Definition,
        modelDefinitionId: et7Definition.id
      })
    });

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

  it("reserves the vehicle when confirming a vehicle based quote", async () => {
    const quote = makeQuote({
      vehicle: makeVehicle(),
      vehicleId: "vehicle-asset-1",
      vehicleSnapshot: { vehicleNo: "VEH2026060200001" }
    });
    const { prisma, service } = makeService({ quote });

    await service.confirmQuote("quote-1", user, context);

    expect(prisma.vehicle.update).toHaveBeenCalledWith({
      data: { status: VehicleStatus.RESERVED, updatedBy: user.id },
      where: { id: "vehicle-asset-1" }
    });
    expect(prisma.subscriptionQuote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          modelCodeSnapshot: expect.anything(),
          modelDefinitionIdSnapshot: expect.anything(),
          modelDisplayNameSnapshot: expect.anything()
        })
      })
    );
  });

  it("rejects confirming a vehicle based quote when the vehicle is unavailable", async () => {
    const quote = makeQuote({
      vehicle: makeVehicle({ status: VehicleStatus.RESERVED }),
      vehicleId: "vehicle-asset-1",
      vehicleSnapshot: { vehicleNo: "VEH2026060200001" }
    });
    const { prisma, service } = makeService({
      quote,
      vehicle: makeVehicle({ status: VehicleStatus.RESERVED })
    });

    await expect(service.confirmQuote("quote-1", user, context)).rejects.toThrow(
      "所选车辆已不可租用"
    );
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
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
      findFirst: vi.fn().mockResolvedValue(seed.priceRule ?? makePriceRule()),
      findMany: vi.fn()
    },
    productVersion: {
      findUnique: vi.fn().mockResolvedValue(seed.version ?? version),
      update: vi.fn().mockResolvedValue({ ...version, status: ProductVersionStatus.ACTIVE }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 })
    },
    subscriptionPlan: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve(makeSubscriptionPlan(data))),
      findFirst: vi.fn().mockResolvedValue(seed.activePlan === undefined ? plan : seed.activePlan),
      findMany: vi.fn().mockResolvedValue(seed.plans ?? []),
      findUnique: vi.fn().mockResolvedValue(plan),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve(makeSubscriptionPlan({ ...plan, ...data })))
    },
    subscriptionQuote: {
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
    },
    vehicleModelDefinition: {
      findFirst: vi.fn(async ({ where }: {
        where: {
          id?: string;
        };
      }) =>
        (seed.modelDefinitions ?? [makeModelDefinition()]).find(
          (definition) =>
            (where.id === undefined || definition.id === where.id) &&
            definition.deletedAt === null
        ) ?? null
      )
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
  const modelDefinition = makeModelDefinition();
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
    modelDefinition,
    modelDefinitionId: modelDefinition.id,
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
  const modelDefinition = makeModelDefinition();
  return {
    assetLocation: "Shanghai",
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: now,
    createdBy: "user-1",
    currentMileageKm: 30000,
    currentSalePriceAmount: BigInt(12000000),
    currentSalePriceInitializedAt: now,
    currentSalePriceReviewedAt: now,
    deletedAt: null,
    id: "vehicle-asset-1",
    model: null,
    modelDefinition,
    modelDefinitionId: modelDefinition.id,
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
    vehicleNo: "VEH2026060200001",
    vin: "VIN0001",
    ...overrides
  };
}

function makeModelDefinition(overrides: Record<string, unknown> = {}) {
  return {
    deletedAt: null,
    displayName: "NIO ET5",
    enabled: true,
    id: "model-et5",
    modelCode: "NIO_ET5",
    ...overrides
  };
}

function makePriceRule(overrides: Record<string, unknown> = {}) {
  const modelDefinition = makeModelDefinition();
  return {
    baseMileageKm: 1500,
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    energyLimitCount: 8,
    energyLimitKwh: 300,
    id: "rule-1",
    maxPeriodMonths: 36,
    minPeriodMonths: 12,
    modelDefinition,
    modelDefinitionId: modelDefinition.id,
    monthlyFeeRate: new Prisma.Decimal("0.035"),
    overMileageFeeAmount: BigInt(100),
    productVersion: { ...version, product },
    productVersionId: "version-1",
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
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
    modelCodeSnapshot: "NIO_ET5",
    modelDefinitionIdSnapshot: "model-et5",
    modelDisplayNameSnapshot: "NIO ET5",
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
  modelDefinitions: ReturnType<typeof makeModelDefinition>[];
  priceRule: ReturnType<typeof makePriceRule>;
  product: typeof product;
  quote: ReturnType<typeof makeQuote>;
  vehicle: ReturnType<typeof makeVehicle>;
  vehiclePackage: ReturnType<typeof makeVehiclePackage>;
  version: typeof version;
}
