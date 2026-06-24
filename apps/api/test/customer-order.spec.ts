import {
  ApplicationStatus,
  BusinessType,
  CustomerStatus,
  DepositStatus,
  MonthlyFeeMode,
  OrderReviewStatus,
  OrderSource,
  OrderStatus,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  QuoteStatus,
  RecordStatus,
  SalePriceStatus,
  SubscriptionPlanStatus,
  VehicleBatteryUsageType,
  VehicleModel,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { OrderService } from "../src/order/order.service";

describe("customer self-service order API rules", () => {
  it("creates a pending-review order for an unrated customer and review-reserves the vehicle", async () => {
    const harness = createCustomerOrderHarness({ customer: { grade: null } });

    const order = await harness.service.createCustomerOrder(
      {
        customerId: harness.customer.id,
        periodMonths: 12,
        subscriptionPlanId: harness.plan.id,
        vehicleBaseFeeAmount: 520000,
        vehicleId: harness.vehicle.id
      },
      harness.user,
      harness.context
    ) as Record<string, unknown>;

    expect(order.orderSource).toBe(OrderSource.CUSTOMER_SELF_SERVICE);
    expect(order.orderStatus).toBe(OrderStatus.PENDING_REVIEW);
    expect(order.creditReviewStatus).toBe(OrderReviewStatus.PENDING);
    expect(order.productReviewStatus).toBe(OrderReviewStatus.PENDING);
    expect(order.vehicleReviewStatus).toBe(OrderReviewStatus.PENDING);
    expect(order.depositStatus).toBe(DepositStatus.PENDING_CONFIRM);
    expect(order.finalDepositAmount).toBeNull();
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.REVIEW_RESERVED);
    expect(harness.tx.subscriptionQuote.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.subscriptionOrder.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.vehicle.update).toHaveBeenCalledWith({
      data: { status: VehicleStatus.REVIEW_RESERVED, updatedBy: harness.user.id },
      where: { id: harness.vehicle.id }
    });
    expect(harness.tx.subscriptionQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerSelectedSnapshot: expect.objectContaining({
            depositDescription: "当前选择为意向订阅方案，押金金额将根据您的资质审核结果最终确认。",
            depositStatus: DepositStatus.PENDING_CONFIRM
          }),
          depositAmount: 0n,
          depositRuleSnapshot: expect.objectContaining({
            depositDescription: "当前选择为意向订阅方案，押金金额将根据您的资质审核结果最终确认。",
            status: DepositStatus.PENDING_CONFIRM
          }),
          packageSnapshot: expect.objectContaining({
            pricing: expect.objectContaining({
              fixedRate: 0.035,
              monthlyFeeAmount: 900000,
              vehicleBaseFeeAmount: 700000,
              vehicleBaseFeeCapAmount: 700000,
              vehicleBaseFeeMode: MonthlyFeeMode.RATE_FORMULA,
              vehicleBaseFeeModeLabel: "固定费率"
            }),
            vehicleBaseFeeMode: MonthlyFeeMode.RATE_FORMULA,
            vehicleBaseFeeModeLabel: "固定费率"
          }),
          riskResultId: null,
          status: QuoteStatus.DRAFT,
          vehicleSnapshot: expect.objectContaining({
            batteryCapacityKwh: 75,
            batteryUsageType: VehicleBatteryUsageType.BUYOUT,
            batteryUsageTypeLabel: "电池买断"
          })
        })
      })
    );
    expect(harness.auditService.write).toHaveBeenCalledTimes(4);
  });

  it("uses the plan fixed amount for customer self-service fixed-amount plans", async () => {
    const harness = createCustomerOrderHarness({
      plan: {
        baseMonthlyFeeAmount: 600000n,
        monthlyFeeMode: MonthlyFeeMode.FIXED_AMOUNT
      }
    });

    await harness.service.createCustomerOrder(
      {
        customerId: harness.customer.id,
        periodMonths: 12,
        subscriptionPlanId: harness.plan.id,
        vehicleBaseFeeAmount: 123456,
        vehicleId: harness.vehicle.id
      },
      harness.user,
      harness.context
    );

    expect(harness.tx.subscriptionQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          monthlyFeeAmount: 800000n,
          packageSnapshot: expect.objectContaining({
            pricing: expect.objectContaining({
              fixedRate: null,
              monthlyFeeAmount: 800000,
              vehicleBaseFeeAmount: 600000,
              vehicleBaseFeeMode: MonthlyFeeMode.FIXED_AMOUNT
            })
          }),
          vehicleBaseFeeAmount: 600000n
        })
      })
    );
    expect(harness.tx.subscriptionOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          monthlyFeeAmount: 800000n
        })
      })
    );
  });

  it("writes model snapshots to the quote and order created by customer self-service", async () => {
    const harness = createCustomerOrderHarness({
      vehicle: {
        modelDefinition: { displayName: "NIO ET5 Snapshot" },
        modelDefinitionId: "model-et5"
      }
    });

    await harness.service.createCustomerOrder(
      {
        customerId: harness.customer.id,
        periodMonths: 12,
        subscriptionPlanId: harness.plan.id,
        vehicleBaseFeeAmount: 520000,
        vehicleId: harness.vehicle.id
      },
      harness.user,
      harness.context
    );

    const expectedSnapshot = {
      legacyVehicleModelSnapshot: VehicleModel.ET5,
      modelDefinitionIdSnapshot: "model-et5",
      modelDisplayNameSnapshot: "NIO ET5 Snapshot"
    };
    expect(harness.tx.subscriptionQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining(expectedSnapshot)
      })
    );
    expect(harness.tx.subscriptionOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining(expectedSnapshot)
      })
    );
  });

  it("rejects a subscription plan that does not match the selected vehicle model", async () => {
    const harness = createCustomerOrderHarness({
      plan: { vehiclePackage: { vehicleModel: VehicleModel.ES6 } }
    });

    await expect(
      harness.service.createCustomerOrder(
        {
          customerId: harness.customer.id,
          periodMonths: 12,
          subscriptionPlanId: harness.plan.id,
          vehicleBaseFeeAmount: 520000,
          vehicleId: harness.vehicle.id
        },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("所选套餐不适用于该车型");

    expect(harness.tx.subscriptionOrder.create).not.toHaveBeenCalled();
    expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
  });

  it("rejects unavailable vehicles", async () => {
    const harness = createCustomerOrderHarness({
      vehicle: { status: VehicleStatus.RESERVED }
    });

    await expect(
      harness.service.createCustomerOrder(
        {
          customerId: harness.customer.id,
          periodMonths: 12,
          subscriptionPlanId: harness.plan.id,
          vehicleBaseFeeAmount: 520000,
          vehicleId: harness.vehicle.id
        },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("所选车辆当前不可租用，请重新选择车辆");

    expect(harness.tx.subscriptionOrder.create).not.toHaveBeenCalled();
    expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
  });

  it("rejects fixed amount vehicle base fee above the current-sale-price cap", async () => {
    const harness = createCustomerOrderHarness({
      plan: {
        baseMonthlyFeeAmount: 900000n,
        monthlyFeeMode: MonthlyFeeMode.FIXED_AMOUNT
      }
    });

    await expect(
      harness.service.createCustomerOrder(
        {
          customerId: harness.customer.id,
          periodMonths: 12,
          subscriptionPlanId: harness.plan.id,
          vehicleId: harness.vehicle.id
        },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("车辆基础费不能超过当前车辆销售价对应的上限");

    expect(harness.tx.subscriptionOrder.create).not.toHaveBeenCalled();
    expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
  });

  it("rejects manual quote plans for customer self-service orders", async () => {
    const harness = createCustomerOrderHarness({
      plan: { monthlyFeeMode: MonthlyFeeMode.MANUAL_QUOTE }
    });

    await expect(
      harness.service.createCustomerOrder(
        {
          customerId: harness.customer.id,
          periodMonths: 12,
          subscriptionPlanId: harness.plan.id,
          vehicleBaseFeeAmount: 520000,
          vehicleId: harness.vehicle.id
        },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("该套餐需后台报价确认，暂不支持客户自助提交。");

    expect(harness.tx.subscriptionOrder.create).not.toHaveBeenCalled();
    expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
  });
});

function createCustomerOrderHarness(overrides: {
  customer?: Record<string, unknown>;
  plan?: Record<string, unknown> & { vehiclePackage?: Record<string, unknown> };
  vehicle?: Record<string, unknown>;
} = {}) {
  const now = new Date("2026-06-04T10:00:00.000Z");
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: ["ADMIN"],
    username: "admin"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const state: { vehicleStatus: VehicleStatus } = { vehicleStatus: VehicleStatus.AVAILABLE };
  const customer = {
    createdAt: now,
    createdBy: user.id,
    customerNo: "CUS202606040001",
    customerType: "PERSONAL",
    deletedAt: null,
    grade: null,
    id: "customer-1",
    mobile: "13800000000",
    name: "测试客户",
    ownerUserId: null,
    riskScore: null,
    sourceChannel: null,
    status: CustomerStatus.LEAD,
    updatedAt: now,
    updatedBy: user.id,
    ...overrides.customer
  };
  const vehicle = {
    assetLocation: "上海",
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: now,
    createdBy: user.id,
    currentMileageKm: 12000,
    currentSalePriceAmount: 20000000n,
    currentSalePriceInitializedAt: now,
    currentSalePriceReviewedAt: now,
    deletedAt: null,
    id: "vehicle-1",
    insuranceEndDate: null,
    insuranceStartDate: null,
    model: "ET5",
    modelYear: 2024,
    nextSalePriceReviewAt: null,
    plateNo: "沪A00001",
    purchaseDate: now,
    purchasePriceAmount: 18000000n,
    registrationDate: null,
    remark: null,
    salePriceReinitRequiredAt: null,
    salePriceStatus: SalePriceStatus.EFFECTIVE,
    series: "ET5",
    status: state.vehicleStatus,
    updatedAt: now,
    updatedBy: user.id,
    vehicleModel: VehicleModel.ET5,
    vehicleNo: "VEH202606040001",
    vin: "VIN202606040001",
    ...overrides.vehicle
  };
  state.vehicleStatus = vehicle.status as VehicleStatus;
  const plan = makePlan(now, overrides.plan);

  const tx = {
    application: {
      create: vi.fn(async ({ data }) => ({
        ...data,
        approvedAt: null,
        deletedAt: null,
        id: "application-1",
        rejectedReason: null,
        updatedAt: now
      }))
    },
    applicationActionLog: {
      create: vi.fn(async ({ data }) => ({ ...data, id: "application-action-1" }))
    },
    customer: {
      update: vi.fn(async ({ data }) => Object.assign(customer, data))
    },
    subscriptionOrder: {
      create: vi.fn(async ({ data }) => buildOrder(data, customer, vehicle, now))
    },
    subscriptionQuote: {
      create: vi.fn(async ({ data }) => buildQuote(data, customer, vehicle, plan, now))
    },
    vehicle: {
      findUnique: vi.fn(async () => ({ ...vehicle, status: state.vehicleStatus })),
      update: vi.fn(async ({ data }) => {
        state.vehicleStatus = data.status;
        return { ...vehicle, status: state.vehicleStatus, updatedBy: data.updatedBy };
      })
    }
  };
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    customer: { findUnique: vi.fn(async () => customer) },
    subscriptionPlan: { findUnique: vi.fn(async () => plan) },
    vehicle: { findUnique: vi.fn(async () => ({ ...vehicle, status: state.vehicleStatus })) }
  };
  const auditService = { write: vi.fn(async () => undefined) };
  const service = new OrderService(auditService as never, prisma as never);

  return { auditService, context, customer, plan, service, state, tx, user, vehicle };
}

function makePlan(now: Date, overrides: Record<string, unknown> & { vehiclePackage?: Record<string, unknown> } = {}) {
  const { vehiclePackage: vehiclePackageOverrides, ...planOverrides } = overrides;
  const product = {
    deletedAt: null,
    id: "product-1",
    name: "订阅产品",
    productNo: "PROD001",
    productType: ProductType.SUBSCRIPTION,
    status: ProductStatus.ACTIVE
  };
  const productVersion = {
    deletedAt: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    id: "product-version-1",
    productId: product.id,
    status: ProductVersionStatus.ACTIVE,
    versionNo: "V1"
  };
  const packageBase = { createdAt: now, createdBy: "user-1", deletedAt: null, product, productId: product.id, productVersion, productVersionId: productVersion.id, remark: null, status: RecordStatus.ACTIVE, updatedAt: now, updatedBy: "user-1" };

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
      ...packageBase,
      id: "energy-package-1",
      monthlyEnergyCount: 6,
      monthlyEnergyKwh: null,
      packageName: "补能包",
      packageNo: "ENE001",
      priceAmount: 80000n,
      serviceDescription: null,
      stationScope: null
    },
    energyPackageId: "energy-package-1",
    id: "plan-1",
    maxPeriodMonths: 36,
    mileagePackage: {
      ...packageBase,
      id: "mileage-package-1",
      monthlyMileageKm: 1500,
      overMileageFeeAmount: 100n,
      packageName: "里程包",
      packageNo: "MIL001",
      priceAmount: 120000n
    },
    mileagePackageId: "mileage-package-1",
    minPeriodMonths: 6,
    monthlyFeeCapRate: null,
    monthlyFeeMode: MonthlyFeeMode.RATE_FORMULA,
    monthlyFeeRate: new Prisma.Decimal("0.035"),
    planName: "12期套餐",
    planNo: "PLAN001",
    product,
    productId: product.id,
    productVersion,
    productVersionId: productVersion.id,
    remark: null,
    status: SubscriptionPlanStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    vehiclePackage: {
      ...packageBase,
      brand: "NIO",
      configName: "标准",
      id: "vehicle-package-1",
      maxPeriodMonths: 36,
      maxPurchasePriceAmount: null,
      minPeriodMonths: 6,
      minPurchasePriceAmount: null,
      monthlyFeeRate: new Prisma.Decimal("0.035"),
      packageName: "车型包",
      packageNo: "VEH001",
      series: "ET5",
      vehicleModel: VehicleModel.ET5,
      vehicleModelName: "ET5",
      ...vehiclePackageOverrides
    },
    vehiclePackageId: "vehicle-package-1",
    ...planOverrides
  };
}

function buildQuote(
  data: Record<string, unknown>,
  customer: Record<string, unknown>,
  vehicle: Record<string, unknown>,
  plan: ReturnType<typeof makePlan>,
  now: Date
) {
  return {
    ...data,
    application: { applicationNo: "APP202606040001", id: data.applicationId, salesUserId: "user-1", status: ApplicationStatus.SUBMITTED },
    cancelledAt: null,
    confirmedAt: null,
    confirmedBy: null,
    confirmer: null,
    createdAt: now,
    customer: { grade: customer.grade, id: customer.id, mobile: customer.mobile, name: customer.name },
    deletedAt: null,
    expiredAt: null,
    id: "quote-1",
    order: null,
    productVersion: { id: plan.productVersionId, product: plan.product, versionNo: plan.productVersion.versionNo },
    riskResult: null,
    subscriptionPlan: plan,
    updatedAt: now,
    vehicle
  };
}

function buildOrder(
  data: Record<string, unknown>,
  customer: Record<string, unknown>,
  vehicle: Record<string, unknown>,
  now: Date
) {
  return {
    ...data,
    actualDeliveryAt: null,
    application: { applicationNo: "APP202606040001", id: data.applicationId, salesUserId: "user-1", status: ApplicationStatus.SUBMITTED },
    changes: [],
    contract: null,
    contractId: null,
    contracts: [],
    createdAt: now,
    customer: { grade: customer.grade, id: customer.id, mobile: customer.mobile, name: customer.name },
    deletedAt: null,
    endDate: null,
    id: "order-1",
    productVersion: { id: data.productVersionId, product: { productType: BusinessType.SUBSCRIPTION, status: ProductStatus.ACTIVE } },
    quote: { id: data.quoteId, quoteNo: "QUO202606040001", status: QuoteStatus.DRAFT },
    riskResult: null,
    startDate: null,
    updatedAt: now,
    vehicle
  };
}
