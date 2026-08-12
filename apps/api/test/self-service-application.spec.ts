import {
  ApplicationSource,
  ApplicationStatus,
  CustomerStatus,
  DepositStatus,
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
  VehicleBatteryUsageType,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { CustomerService } from "../src/customer/customer.service";

describe("self-service application intake API rules", () => {
  it("creates a self-service application without quote or order and review-reserves the vehicle", async () => {
    const harness = createSelfServiceApplicationHarness();

    const response = await harness.service.createSelfServiceApplication(
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

    expect(response).toEqual(
      expect.objectContaining({
        applicationId: "application-1",
        applicationSource: ApplicationSource.SELF_SERVICE,
        depositStatus: DepositStatus.PENDING_CONFIRM,
        materialsUploadHint: "请继续上传身份证、驾驶证等资质材料。",
        message: "自助进件已提交，押金金额将在资质审核后确认。",
        status: ApplicationStatus.SUBMITTED,
        vehicleStatus: VehicleStatus.REVIEW_RESERVED
      })
    );
    expect(response.applicationNo).toMatch(/^APP/);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.REVIEW_RESERVED);
    expect(harness.tx.application.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          applicationSource: ApplicationSource.SELF_SERVICE,
          creditReviewStatus: OrderReviewStatus.PENDING,
          customerId: harness.customer.id,
          customerProfileSnapshot: expect.objectContaining({
            customerId: harness.customer.id,
            snapshotVersion: 1,
            source: "CUSTOMER_PORTAL_PROFILE"
          }),
          depositStatus: DepositStatus.PENDING_CONFIRM,
          finalDepositAmount: null,
          intentPeriodMonths: 12,
          intentSubscriptionPlanId: harness.plan.id,
          intentVehicleBaseFeeAmount: 700000n,
          intentVehicleId: harness.vehicle.id,
          materialReviewStatus: OrderReviewStatus.PENDING,
          planConfirmStatus: PlanConfirmStatus.PENDING,
          productReviewStatus: OrderReviewStatus.PENDING,
          softReservedVehicleId: harness.vehicle.id,
          status: ApplicationStatus.SUBMITTED,
          vehicleReviewStatus: OrderReviewStatus.PENDING
        })
      })
    );
    expect(harness.tx.application.create.mock.calls[0]?.[0].data.intentSnapshot).toEqual(
      expect.objectContaining({
        depositDescription: "当前选择为意向订阅方案，押金金额将根据您的资质审核结果最终确认。",
        depositStatus: DepositStatus.PENDING_CONFIRM,
        subscriptionPlanId: harness.plan.id,
        vehicleBaseFeeAmount: 700000,
        vehicleId: harness.vehicle.id,
        vehicleSnapshot: expect.objectContaining({
          batteryCapacityKwh: 75,
          batteryUsageType: VehicleBatteryUsageType.BUYOUT,
          batteryUsageTypeLabel: "电池买断"
        })
      })
    );
    expect(harness.tx.application.create.mock.calls[0]?.[0].data.customerSelectedSnapshot).toEqual(
      harness.tx.application.create.mock.calls[0]?.[0].data.intentSnapshot
    );
    expect(harness.tx.vehicle.updateMany).toHaveBeenCalledWith({
      data: { status: VehicleStatus.REVIEW_RESERVED, updatedBy: harness.user.id },
      where: {
        deletedAt: null,
        id: harness.vehicle.id,
        status: VehicleStatus.AVAILABLE
      }
    });
    expect(harness.tx.subscriptionQuote.create).not.toHaveBeenCalled();
    expect(harness.tx.subscriptionOrder.create).not.toHaveBeenCalled();
    expect(harness.journeySignal.record).toHaveBeenCalledWith(harness.tx, {
      applicationId: "application-1",
      eventKey: "application:application-1:submitted",
      payload: { source: ApplicationSource.SELF_SERVICE },
      type: "APPLICATION_SUBMITTED"
    });
    expect(harness.auditService.write).toHaveBeenCalledTimes(2);
  });

  it("uses the fixed amount configured by the plan and ignores submitted base fee", async () => {
    const harness = createSelfServiceApplicationHarness({
      plan: {
        baseMonthlyFeeAmount: 600000n,
        monthlyFeeMode: MonthlyFeeMode.FIXED_AMOUNT
      }
    });

    await harness.service.createSelfServiceApplication(
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

    expect(harness.tx.application.create.mock.calls[0]?.[0].data.intentVehicleBaseFeeAmount).toBe(600000n);
    expect(harness.tx.application.create.mock.calls[0]?.[0].data.intentSnapshot).toEqual(
      expect.objectContaining({ vehicleBaseFeeAmount: 600000 })
    );
  });

  it("rejects self-service intake when required customer application profile fields are missing", async () => {
    const harness = createSelfServiceApplicationHarness({
      customer: { identity: null }
    });

    await expect(
      harness.service.createSelfServiceApplication(
        {
          customerId: harness.customer.id,
          periodMonths: 12,
          subscriptionPlanId: harness.plan.id,
          vehicleId: harness.vehicle.id
        },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("CUSTOMER_APPLICATION_PROFILE_INCOMPLETE");

    expect(harness.tx.application.create).not.toHaveBeenCalled();
    expect(harness.tx.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it("rejects unavailable vehicles before creating an application", async () => {
    const harness = createSelfServiceApplicationHarness({
      vehicle: { status: VehicleStatus.RESERVED }
    });

    await expect(
      harness.service.createSelfServiceApplication(
        {
          customerId: harness.customer.id,
          periodMonths: 12,
          subscriptionPlanId: harness.plan.id,
          vehicleId: harness.vehicle.id
        },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("所选车辆当前不可租用，请重新选择车辆");

    expect(harness.tx.application.create).not.toHaveBeenCalled();
    expect(harness.tx.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it("rejects vehicles without an effective current sale price", async () => {
    const harness = createSelfServiceApplicationHarness({
      vehicle: { currentSalePriceAmount: null }
    });

    await expect(
      harness.service.createSelfServiceApplication(
        {
          customerId: harness.customer.id,
          periodMonths: 12,
          subscriptionPlanId: harness.plan.id,
          vehicleId: harness.vehicle.id
        },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("当前车辆销售价未初始化，无法提交自助进件");

    expect(harness.tx.application.create).not.toHaveBeenCalled();
  });

  it("rejects plans that do not match the selected vehicle model", async () => {
    const harness = createSelfServiceApplicationHarness({
      plan: {
        vehiclePackage: {
          modelDefinition: {
            displayName: "NIO ES6",
            id: "model-es6",
            modelCode: "NIO_ES6"
          },
          modelDefinitionId: "model-es6"
        }
      }
    });

    await expect(
      harness.service.createSelfServiceApplication(
        {
          customerId: harness.customer.id,
          periodMonths: 12,
          subscriptionPlanId: harness.plan.id,
          vehicleId: harness.vehicle.id
        },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("所选套餐不适用于该车辆车型");

    expect(harness.tx.application.create).not.toHaveBeenCalled();
    expect(harness.tx.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it("accepts matching canonical plan and vehicle identities", async () => {
    const modelDefinition = {
      displayName: "NIO ET5",
      id: "model-et5",
      modelCode: "NIO_ET5"
    };
    const harness = createSelfServiceApplicationHarness({
      plan: {
        vehiclePackage: {
          modelDefinition,
          modelDefinitionId: modelDefinition.id
        }
      },
      vehicle: {
        modelDefinition,
        modelDefinitionId: modelDefinition.id
      }
    });

    await expect(
      harness.service.createSelfServiceApplication(
        {
          customerId: harness.customer.id,
          periodMonths: 12,
          subscriptionPlanId: harness.plan.id,
          vehicleId: harness.vehicle.id
        },
        harness.user,
        harness.context
      )
    ).resolves.toMatchObject({ status: ApplicationStatus.SUBMITTED });
    expect(harness.prisma.subscriptionPlan.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          vehiclePackage: {
            include: expect.objectContaining({
              modelDefinition: { select: expect.any(Object) }
            })
          }
        })
      })
    );
  });

  it("rejects manual quote plans for A-line self-service intake", async () => {
    const harness = createSelfServiceApplicationHarness({
      plan: { monthlyFeeMode: MonthlyFeeMode.MANUAL_QUOTE }
    });

    await expect(
      harness.service.createSelfServiceApplication(
        {
          customerId: harness.customer.id,
          periodMonths: 12,
          subscriptionPlanId: harness.plan.id,
          vehicleId: harness.vehicle.id
        },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("该套餐需后台报价确认，暂不支持客户自助提交。");

    expect(harness.tx.application.create).not.toHaveBeenCalled();
  });
});

function createSelfServiceApplicationHarness(overrides: {
  customer?: Record<string, unknown>;
  plan?: Record<string, unknown> & { vehiclePackage?: Record<string, unknown> };
  vehicle?: Record<string, unknown>;
} = {}) {
  const now = new Date("2026-06-05T10:00:00.000Z");
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
    customerNo: "CUS202606050001",
    customerType: "PERSONAL",
    deletedAt: null,
    grade: null,
    id: "customer-1",
    identity: { idCardNo: "11010519491231002X" },
    mobile: "13800000000",
    name: "测试客户",
    ownerUserId: null,
    profile: {
      emergencyContactMobile: "13900000000",
      emergencyContactName: "王女士",
      residenceAddress: "上海市闵行区北翟路1554弄53号",
      residenceCity: "上海市",
      residenceDetail: "北翟路1554弄53号",
      residenceDistrict: "闵行区",
      residenceProvince: "上海市",
      updatedAt: now
    },
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
    model: "ET5",
    modelDefinition: {
      displayName: "NIO ET5",
      id: "model-et5",
      modelCode: "NIO_ET5"
    },
    modelDefinitionId: "model-et5",
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
    vehicleNo: "VEH202606050001",
    vin: "VIN202606050001",
    ...overrides.vehicle
  };
  state.vehicleStatus = vehicle.status as VehicleStatus;
  const plan = makePlan(now, overrides.plan);

  const tx = {
    application: {
      create: vi.fn(async ({ data }) => ({
        ...data,
        approvedAt: null,
        createdAt: now,
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
      findUniqueOrThrow: vi.fn(async () => customer),
      update: vi.fn(async ({ data }) => Object.assign(customer, data))
    },
    subscriptionOrder: {
      create: vi.fn()
    },
    subscriptionQuote: {
      create: vi.fn()
    },
    vehicle: {
      findUnique: vi.fn(async () => ({ ...vehicle, status: state.vehicleStatus })),
      findUniqueOrThrow: vi.fn(async () => ({ ...vehicle, status: state.vehicleStatus })),
      updateMany: vi.fn(async ({ data, where }) => {
        if (state.vehicleStatus !== where.status) {
          return { count: 0 };
        }
        state.vehicleStatus = data.status;
        return { count: 1 };
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
  const journeySignal = { record: vi.fn(async () => undefined) };
  const service = new CustomerService(
    auditService as never,
    prisma as never,
    {} as never,
    {} as never,
    undefined,
    journeySignal as never
  );

  return {
    auditService,
    context,
    customer,
    journeySignal,
    plan,
    prisma,
    service,
    state,
    tx,
    user,
    vehicle
  };
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
  const packageBase = {
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    product,
    productId: product.id,
    productVersion,
    productVersionId: productVersion.id,
    remark: null,
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1"
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
      modelDefinition: {
        displayName: "NIO ET5",
        id: "model-et5",
        modelCode: "NIO_ET5"
      },
      modelDefinitionId: "model-et5",
      vehicleModelName: "ET5",
      ...vehiclePackageOverrides
    },
    vehiclePackageId: "vehicle-package-1",
    ...planOverrides
  };
}
