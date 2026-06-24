import {
  ApplicationMaterialType,
  ApplicationSource,
  ApplicationStatus,
  CustomerGrade,
  CustomerStatus,
  DepositStatus,
  MaterialStatus,
  MonthlyFeeMode,
  OrderReviewStatus,
  OrderSource,
  OrderStatus,
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
  VehicleModel,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { CustomerService } from "../src/customer/customer.service";

interface ApprovalRiskInput {
  applicationId: string;
  approvedAt: Date;
  customerId: string;
  grade: CustomerGrade;
  maxVehiclePurchasePriceAmount?: number;
  operatorId: string;
  remark?: string;
  riskScore?: number;
}

describe("application self-service review APIs", () => {
  it("returns self-service pending applications in the review queue", async () => {
    const harness = createApplicationReviewHarness();

    const queue = await harness.service.listApplicationReviewQueue(harness.user);

    expect(queue).toHaveLength(1);
    expect(queue[0]).toEqual(
      expect.objectContaining({
        applicationSource: ApplicationSource.SELF_SERVICE,
        id: harness.application.id,
        materialReviewStatus: OrderReviewStatus.PENDING
      })
    );
    expect(harness.prisma.application.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          applicationSource: ApplicationSource.SELF_SERVICE,
          orders: { none: { deletedAt: null } }
        })
      })
    );
  });

  it("approves material review status", async () => {
    const harness = createApplicationReviewHarness();

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "material",
      { action: OrderReviewStatus.APPROVED, comment: "材料齐全" },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({ materialReviewStatus: OrderReviewStatus.APPROVED })
    );
    expect(harness.state.application.materialReviewStatus).toBe(OrderReviewStatus.APPROVED);
  });

  it("approves credit review and confirms deposit by customer grade", async () => {
    const harness = createApplicationReviewHarness();

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "credit",
      {
        action: OrderReviewStatus.APPROVED,
        comment: "资质通过",
        customerGrade: CustomerGrade.A
      },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        creditReviewStatus: OrderReviewStatus.APPROVED,
        customerGrade: CustomerGrade.A,
        depositStatus: DepositStatus.CONFIRMED,
        finalDepositAmount: 300000
      })
    );
    expect(harness.state.customer.grade).toBe(CustomerGrade.A);
    expect(harness.state.application.depositRuleSnapshot).toEqual(
      expect.objectContaining({
        depositAmount: 300000,
        status: DepositStatus.CONFIRMED
      })
    );
  });

  it("saves rating, score, vehicle price, deposit, and comments through the shared approval flow", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        materialGroups: approvedRequiredMaterialGroups(new Date("2026-06-05T10:00:00.000Z")),
        materialReviewStatus: OrderReviewStatus.APPROVED
      }
    });

    const application = await harness.service.approveApplication(
      harness.application.id,
      {
        comment: "资质通过",
        grade: CustomerGrade.B,
        maxVehiclePurchasePriceAmount: 26000000,
        riskScore: 720
      },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        creditReviewComment: "资质通过",
        creditReviewStatus: OrderReviewStatus.APPROVED,
        customerGrade: CustomerGrade.B,
        depositStatus: DepositStatus.CONFIRMED,
        finalDepositAmount: 300000
      })
    );
    expect(harness.state.customer).toEqual(
      expect.objectContaining({
        grade: CustomerGrade.B,
        riskScore: 720,
        status: CustomerStatus.APPROVED
      })
    );
    expect(harness.state.application.depositRuleSnapshot).toEqual(
      expect.objectContaining({
        defaultRate: 0.1,
        depositAmount: 300000,
        grade: CustomerGrade.B,
        maxVehiclePurchasePriceAmount: 26000000,
        riskScore: 720,
        status: DepositStatus.CONFIRMED
      })
    );
    expect(harness.riskService.createApprovalRiskResult).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        grade: CustomerGrade.B,
        maxVehiclePurchasePriceAmount: 26000000,
        remark: "资质通过",
        riskScore: 720
      })
    );
  });

  it("rejects credit review and releases the review-reserved vehicle", async () => {
    const harness = createApplicationReviewHarness();

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "credit",
      { action: OrderReviewStatus.REJECTED, comment: "资质未通过" },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        creditReviewStatus: OrderReviewStatus.REJECTED,
        status: ApplicationStatus.REJECTED
      })
    );
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
  });

  it("approves product review and writes final plan fields", async () => {
    const harness = createApplicationReviewHarness();

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "product",
      { action: OrderReviewStatus.APPROVED, comment: "产品匹配" },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        finalPeriodMonths: 12,
        finalSubscriptionPlanId: harness.plan.id,
        finalVehicleBaseFeeAmount: 700000,
        finalVehicleId: harness.vehicle.id,
        productReviewStatus: OrderReviewStatus.APPROVED
      })
    );
  });

  it("rejects product review and releases the review-reserved vehicle", async () => {
    const harness = createApplicationReviewHarness();

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "product",
      { action: OrderReviewStatus.REJECTED, comment: "产品不匹配" },
      harness.user,
      harness.context
    );

    expect(application.productReviewStatus).toBe(OrderReviewStatus.REJECTED);
    expect(application.status).toBe(ApplicationStatus.REJECTED);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
  });

  it("approves vehicle review and keeps the vehicle review-reserved", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        finalSubscriptionPlanId: "plan-1",
        productReviewStatus: OrderReviewStatus.APPROVED
      }
    });

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "vehicle",
      { action: OrderReviewStatus.APPROVED, comment: "库存通过" },
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        finalVehicleId: harness.vehicle.id,
        vehicleReviewStatus: OrderReviewStatus.APPROVED
      })
    );
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.REVIEW_RESERVED);
  });

  it("rejects vehicle review and releases the review-reserved vehicle", async () => {
    const harness = createApplicationReviewHarness();

    const application = await harness.service.reviewApplication(
      harness.application.id,
      "vehicle",
      { action: OrderReviewStatus.REJECTED, comment: "库存不足" },
      harness.user,
      harness.context
    );

    expect(application.vehicleReviewStatus).toBe(OrderReviewStatus.REJECTED);
    expect(application.status).toBe(ApplicationStatus.REJECTED);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
  });

  it("finalizes after material and credit approval, then auto-approves product and vehicle reviews", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        creditReviewStatus: OrderReviewStatus.APPROVED,
        depositStatus: DepositStatus.CONFIRMED,
        finalDepositAmount: 300000n,
        materialReviewStatus: OrderReviewStatus.APPROVED,
        productReviewStatus: OrderReviewStatus.PENDING,
        vehicleReviewStatus: OrderReviewStatus.PENDING
      }
    });

    const application = await harness.service.finalizeApplicationPlan(
      harness.application.id,
      harness.user,
      harness.context
    );

    expect(application).toEqual(
      expect.objectContaining({
        finalPlanSnapshot: expect.objectContaining({
          depositAmount: 300000,
          finalPlanConfirmedAt: null,
          planConfirmStatus: PlanConfirmStatus.PENDING,
          subscriptionPlanId: harness.plan.id,
          vehicleId: harness.vehicle.id
        }),
        finalPlanConfirmedAt: null,
        planConfirmStatus: PlanConfirmStatus.PENDING,
        productReviewStatus: OrderReviewStatus.APPROVED,
        status: ApplicationStatus.APPROVED
      })
    );
    expect(application.vehicleReviewStatus).toBe(OrderReviewStatus.APPROVED);
  });

  it("rejects finalizing when the selected plan is inactive", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToFinalizeApplication(),
      plan: { status: SubscriptionPlanStatus.INACTIVE }
    });

    await expect(
      harness.service.finalizeApplicationPlan(
        harness.application.id,
        harness.user,
        harness.context
      )
    ).rejects.toThrow("所选订阅套餐当前不可用");

    expect(harness.state.application.productReviewStatus).toBe(OrderReviewStatus.PENDING);
    expect(harness.state.application.vehicleReviewStatus).toBe(OrderReviewStatus.PENDING);
  });

  it("rejects finalizing when the vehicle is no longer review-reserved by the application", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToFinalizeApplication(),
      vehicle: { status: VehicleStatus.AVAILABLE }
    });

    await expect(
      harness.service.finalizeApplicationPlan(
        harness.application.id,
        harness.user,
        harness.context
      )
    ).rejects.toThrow("当前车辆不再处于审核占用状态，请重新选择车辆。");

    expect(harness.state.application.productReviewStatus).toBe(OrderReviewStatus.PENDING);
    expect(harness.state.application.vehicleReviewStatus).toBe(OrderReviewStatus.PENDING);
  });

  it("creates an official quote and order, then locks the vehicle as reserved", async () => {
    const harness = createApplicationReviewHarness({
      application: readyToCreateOrderApplication(),
      vehicle: {
        modelDefinition: { displayName: "NIO ET5 Final Plan" },
        modelDefinitionId: "model-et5"
      }
    });

    const result = await harness.service.createOrderFromApplication(
      harness.application.id,
      harness.user,
      harness.context
    );

    expect(result).toEqual(
      expect.objectContaining({
        orderId: "order-1",
        orderStatus: OrderStatus.PENDING_CONTRACT,
        quoteId: "quote-1",
        vehicleStatus: VehicleStatus.RESERVED
      })
    );
    expect(harness.tx.subscriptionQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          depositAmount: 300000n,
          legacyVehicleModelSnapshot: VehicleModel.ET5,
          modelDefinitionIdSnapshot: "model-et5",
          modelDisplayNameSnapshot: "NIO ET5 Final Plan",
          status: QuoteStatus.CONFIRMED,
          subscriptionPlanId: harness.plan.id,
          vehicleId: harness.vehicle.id
        })
      })
    );
    expect(harness.tx.subscriptionOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          depositAmount: 300000n,
          finalDepositAmount: 300000n,
          legacyVehicleModelSnapshot: VehicleModel.ET5,
          modelDefinitionIdSnapshot: "model-et5",
          modelDisplayNameSnapshot: "NIO ET5 Final Plan",
          orderSource: OrderSource.CUSTOMER_SELF_SERVICE,
          orderStatus: OrderStatus.PENDING_CONTRACT,
          quoteId: "quote-1",
          vehicleId: harness.vehicle.id
        })
      })
    );
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.RESERVED);
  });

  it("disallows duplicate order creation for an application", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        ...readyToCreateOrderApplication(),
        orders: [
          {
            deletedAt: null,
            id: "order-existing",
            orderNo: "ORD202606050001",
            orderStatus: OrderStatus.PENDING_CONTRACT
          }
        ]
      }
    });

    await expect(
      harness.service.createOrderFromApplication(
        harness.application.id,
        harness.user,
        harness.context
      )
    ).rejects.toThrow("该进件已生成订单，请勿重复处理。");

    expect(harness.tx.subscriptionOrder.create).not.toHaveBeenCalled();
  });

  it("keeps sales-assisted applications out of the self-service review queue", async () => {
    const harness = createApplicationReviewHarness({
      application: {
        applicationSource: ApplicationSource.SALES_ASSISTED
      }
    });

    await harness.service.listApplicationReviewQueue(harness.user);

    expect(harness.prisma.application.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          applicationSource: ApplicationSource.SELF_SERVICE
        })
      })
    );
  });
});

function createApplicationReviewHarness(overrides: {
  application?: Record<string, unknown>;
  plan?: Record<string, unknown> & { vehiclePackage?: Record<string, unknown> };
  vehicle?: Record<string, unknown>;
} = {}) {
  const now = new Date("2026-06-05T10:00:00.000Z");
  const user = {
    id: "00000000-0000-4000-8000-000000000001",
    menus: [],
    name: "Admin",
    permissions: ["application:review", "order:create", "quote:create"],
    roles: ["ADMIN"],
    username: "admin"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const state: {
    application: ReturnType<typeof makeApplication>;
    customer: ReturnType<typeof makeCustomer>;
    vehicleStatus: VehicleStatus;
  } = {
    application: makeApplication(now, overrides.application),
    customer: makeCustomer(now),
    vehicleStatus: VehicleStatus.REVIEW_RESERVED
  };
  const vehicle = makeVehicle(now, { status: state.vehicleStatus, ...overrides.vehicle });
  state.vehicleStatus = vehicle.status;
  const plan = makePlan(now, overrides.plan);

  const tx = {
    application: {
      findUniqueOrThrow: vi.fn(async () => state.application),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.application = makeApplication(now, { ...state.application, ...data });
        return state.application;
      })
    },
    applicationActionLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: "application-action-1"
      }))
    },
    customer: {
      findUnique: vi.fn(async () => state.customer),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.customer = { ...state.customer, ...data };
        return state.customer;
      })
    },
    depositRule: {
      findFirst: vi.fn(async () => ({
        createdAt: now,
        createdBy: user.id,
        customerRatio: null,
        defaultRate: new Prisma.Decimal("0.100000"),
        deletedAt: null,
        depositAmount: 300000n,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
        grade: CustomerGrade.A,
        id: "deposit-rule-1",
        status: RecordStatus.ACTIVE,
        updatedAt: now,
        updatedBy: user.id
      }))
    },
    subscriptionOrder: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        createdAt: now,
        deletedAt: null,
        id: "order-1",
        orderNo: "ORD202606050001",
        updatedAt: now
      }))
    },
    subscriptionPlan: {
      findUnique: vi.fn(async () => plan)
    },
    subscriptionQuote: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        createdAt: now,
        deletedAt: null,
        id: "quote-1",
        quoteNo: "QUO202606050001",
        updatedAt: now
      }))
    },
    vehicle: {
      findUnique: vi.fn(async () => ({ ...vehicle, status: state.vehicleStatus })),
      findUniqueOrThrow: vi.fn(async () => ({ ...vehicle, status: state.vehicleStatus })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.vehicleStatus = data.status as VehicleStatus;
        return { ...vehicle, status: state.vehicleStatus, updatedBy: data.updatedBy };
      }),
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        if (state.vehicleStatus !== where.status) {
          return { count: 0 };
        }
        state.vehicleStatus = data.status as VehicleStatus;
        return { count: 1 };
      })
    }
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    application: {
      findMany: vi.fn(async () =>
        state.application.applicationSource === ApplicationSource.SELF_SERVICE
          ? [state.application]
          : []
      ),
      findUnique: vi.fn(async () => state.application)
    }
  };
  const auditService = { write: vi.fn(async () => undefined) };
  const riskService = {
    createApprovalRiskResult: vi.fn(async (_tx: typeof tx, input: ApprovalRiskInput) => ({
      applicationId: input.applicationId,
      approvedAt: input.approvedAt,
      approvedBy: input.operatorId,
      approvedDepositAmount: 300000n,
      approver: {
        id: user.id,
        name: user.name,
        username: user.username
      },
      createdAt: now,
      customerId: input.customerId,
      defaultRate: new Prisma.Decimal("0.100000"),
      grade: input.grade,
      id: "risk-result-1",
      maxVehiclePurchasePriceAmount:
        input.maxVehiclePurchasePriceAmount === undefined
          ? null
          : BigInt(input.maxVehiclePurchasePriceAmount),
      remark: input.remark ?? null,
      result: RiskResultDecision.APPROVED,
      score: input.riskScore ?? null,
      updatedAt: now
    }))
  };
  const service = new CustomerService(
    auditService as never,
    prisma as never,
    riskService as never,
    {} as never
  );

  return {
    application: state.application,
    auditService,
    context,
    plan,
    prisma,
    riskService,
    service,
    state,
    tx,
    user,
    vehicle
  };
}

function readyToFinalizeApplication() {
  return {
    creditReviewStatus: OrderReviewStatus.APPROVED,
    customerGrade: CustomerGrade.A,
    depositRuleId: "deposit-rule-1",
    depositRuleSnapshot: { depositAmount: 300000 },
    depositStatus: DepositStatus.CONFIRMED,
    finalDepositAmount: 300000n,
    materialReviewStatus: OrderReviewStatus.APPROVED,
    productReviewStatus: OrderReviewStatus.PENDING,
    vehicleReviewStatus: OrderReviewStatus.PENDING
  };
}

function approvedRequiredMaterialGroups(now: Date) {
  const operator = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Admin",
    username: "admin"
  };

  return [
    ApplicationMaterialType.ID_CARD,
    ApplicationMaterialType.DRIVER_LICENSE,
    ApplicationMaterialType.CREDIT_AUTH
  ].map((materialType, index) => {
    const id = `material-group-${index + 1}`;

    return {
      applicationId: "application-1",
      createdAt: now,
      createdBy: operator.id,
      deletedAt: null,
      files: [
        {
          applicationId: "application-1",
          createdAt: now,
          createdBy: operator.id,
          deletedAt: null,
          deleteReason: null,
          deleter: null,
          fileId: `file-${index + 1}`,
          fileName: `material-${index + 1}.png`,
          id: `material-file-${index + 1}`,
          isDeleted: false,
          materialGroupId: id,
          materialType,
          mimeType: "image/png",
          sizeBytes: 1024n,
          updatedAt: now,
          updatedBy: operator.id,
          uploadedAt: now,
          uploadedBy: operator.id,
          uploader: operator
        }
      ],
      id,
      materialName: null,
      materialType,
      required: true,
      reviewComment: "已通过",
      reviewedAt: now,
      reviewedBy: operator.id,
      reviewer: operator,
      reviewStatus: MaterialStatus.APPROVED,
      updatedAt: now,
      updatedBy: operator.id
    };
  });
}

function readyToCreateOrderApplication() {
  return {
    approvedAt: new Date("2026-06-05T10:30:00.000Z"),
    creditReviewStatus: OrderReviewStatus.APPROVED,
    customerGrade: CustomerGrade.A,
    depositRuleId: "deposit-rule-1",
    depositRuleSnapshot: { depositAmount: 300000 },
    depositStatus: DepositStatus.CONFIRMED,
    finalDepositAmount: 300000n,
    finalPeriodMonths: 12,
    finalPlanConfirmedAt: new Date("2026-06-05T10:40:00.000Z"),
    finalPlanSnapshot: {
      depositAmount: 300000,
      subscriptionPlanId: "plan-1",
      vehicleId: "vehicle-1"
    },
    finalSubscriptionPlanId: "plan-1",
    finalVehicleBaseFeeAmount: 700000n,
    finalVehicleId: "vehicle-1",
    materialReviewStatus: OrderReviewStatus.APPROVED,
    planConfirmStatus: PlanConfirmStatus.CONFIRMED,
    productReviewStatus: OrderReviewStatus.APPROVED,
    status: ApplicationStatus.APPROVED,
    vehicleReviewStatus: OrderReviewStatus.APPROVED
  };
}

function makeApplication(now: Date, overrides: Record<string, unknown> = {}) {
  return {
    actionLogs: [],
    applicationNo: "APP202606050001",
    applicationSource: ApplicationSource.SELF_SERVICE,
    approvedAt: null,
    createdAt: now,
    createdBy: "00000000-0000-4000-8000-000000000001",
    creditReviewComment: null,
    creditReviewStatus: OrderReviewStatus.PENDING,
    customer: makeCustomerForApplication(),
    customerGrade: null,
    customerId: "customer-1",
    customerSelectedSnapshot: {
      periodMonths: 12,
      subscriptionPlanId: "plan-1",
      vehicleId: "vehicle-1"
    },
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
      periodMonths: 12,
      subscriptionPlanId: "plan-1",
      vehicleId: "vehicle-1"
    },
    intentSubscriptionPlanId: "plan-1",
    intentVehicleBaseFeeAmount: 700000n,
    intentVehicleId: "vehicle-1",
    intendedModel: VehicleModel.ET5,
    intendedPeriodMonths: 12,
    materialGroups: [],
    materialReviewStatus: OrderReviewStatus.PENDING,
    materials: [],
    orders: [],
    planConfirmStatus: PlanConfirmStatus.PENDING,
    productReviewStatus: OrderReviewStatus.PENDING,
    rejectedReason: null,
    riskResults: [],
    salesUser: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Admin",
      username: "admin"
    },
    salesUserId: "00000000-0000-4000-8000-000000000001",
    softReservationExpiresAt: new Date("2026-06-06T10:00:00.000Z"),
    softReservedAt: now,
    softReservedVehicleId: "vehicle-1",
    status: ApplicationStatus.SUBMITTED,
    submittedAt: now,
    updatedAt: now,
    updatedBy: "00000000-0000-4000-8000-000000000001",
    vehicleReviewStatus: OrderReviewStatus.PENDING,
    ...overrides
  };
}

function makeCustomer(now: Date) {
  return {
    createdAt: now,
    createdBy: "00000000-0000-4000-8000-000000000001",
    customerNo: "CUS202606050001",
    customerType: "PERSONAL",
    deletedAt: null,
    grade: null as CustomerGrade | null,
    id: "customer-1",
    mobile: "13800000000",
    name: "测试客户",
    ownerUserId: null,
    riskScore: null,
    sourceChannel: null,
    status: CustomerStatus.PENDING_APPLICATION,
    updatedAt: now,
    updatedBy: "00000000-0000-4000-8000-000000000001"
  };
}

function makeCustomerForApplication() {
  return {
    customerNo: "CUS202606050001",
    id: "customer-1",
    identity: null,
    mobile: "13800000000",
    name: "测试客户",
    ownerUserId: null,
    profile: null,
    sourceChannel: null,
    status: CustomerStatus.PENDING_APPLICATION
  };
}

function makeVehicle(now: Date, overrides: Record<string, unknown> = {}) {
  return {
    assetLocation: "上海",
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: now,
    createdBy: "00000000-0000-4000-8000-000000000001",
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
    status: VehicleStatus.REVIEW_RESERVED,
    updatedAt: now,
    updatedBy: "00000000-0000-4000-8000-000000000001",
    vehicleModel: VehicleModel.ET5,
    vehicleNo: "VEH202606050001",
    vin: "VIN202606050001",
    ...overrides
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
    createdBy: "00000000-0000-4000-8000-000000000001",
    deletedAt: null,
    product,
    productId: product.id,
    productVersion,
    productVersionId: productVersion.id,
    remark: null,
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "00000000-0000-4000-8000-000000000001"
  };

  return {
    baseMonthlyFeeAmount: null,
    benefitPackage: null,
    benefitPackageId: null,
    createdAt: now,
    createdBy: "00000000-0000-4000-8000-000000000001",
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
    updatedBy: "00000000-0000-4000-8000-000000000001",
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
