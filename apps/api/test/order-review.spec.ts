import {
  ApplicationStatus,
  BusinessType,
  CustomerGrade,
  DepositStatus,
  OrderReviewStatus,
  OrderSource,
  OrderStatus,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  QuoteStatus,
  RecordStatus,
  SalePriceStatus,
  SubscriptionPlanStatus,
  VehicleModel,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { OrderService } from "../src/order/order.service";

describe("customer self-service order review workflow", () => {
  it("returns pending customer self-service orders in review queue", async () => {
    const harness = createReviewHarness();

    const rows = await harness.service.listReviewQueue(harness.user) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orderStatus).toBe(OrderStatus.PENDING_REVIEW);
    expect(harness.prisma.subscriptionOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderSource: OrderSource.CUSTOMER_SELF_SERVICE,
          orderStatus: { in: [OrderStatus.PENDING_REVIEW, OrderStatus.PENDING_CUSTOMER_CONFIRMATION] }
        })
      })
    );
  });

  it("does not include sales-assisted orders in the review queue", async () => {
    const harness = createReviewHarness({ orderSource: OrderSource.SALES_ASSISTED });

    await harness.service.listReviewQueue(harness.user);

    expect(harness.prisma.subscriptionOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderSource: OrderSource.CUSTOMER_SELF_SERVICE
        })
      })
    );
  });

  it("approves credit review and writes customer grade plus deposit", async () => {
    const harness = createReviewHarness();

    const order = await harness.service.reviewOrder(
      harness.orderId,
      "credit",
      {
        action: OrderReviewStatus.APPROVED,
        comment: "客户资质通过",
        customerGrade: CustomerGrade.A
      },
      harness.user,
      harness.context
    ) as Record<string, unknown>;

    expect(order.creditReviewStatus).toBe(OrderReviewStatus.APPROVED);
    expect(order.reviewComment).toBe("客户资质通过");
    expect(order.depositStatus).toBe(DepositStatus.CONFIRMED);
    expect(order.finalDepositAmount).toBe(500000);
    expect(harness.state.customerGrade).toBe(CustomerGrade.A);
    expect(harness.state.depositAmount).toBe(500000n);
    expect(harness.tx.subscriptionQuote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          depositAmount: 500000n,
          depositRuleSnapshot: expect.objectContaining({
            customerGrade: CustomerGrade.A,
            depositAmount: 500000
          })
        })
      })
    );
  });

  it("rejects credit review and releases the review-reserved vehicle", async () => {
    const harness = createReviewHarness();

    const order = await harness.service.reviewOrder(
      harness.orderId,
      "credit",
      { comment: "资质不通过", status: OrderReviewStatus.REJECTED },
      harness.user,
      harness.context
    ) as Record<string, unknown>;

    expect(order.creditReviewStatus).toBe(OrderReviewStatus.REJECTED);
    expect(order.orderStatus).toBe(OrderStatus.REJECTED);
    expect(order.reviewComment).toBe("资质不通过");
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
  });

  it("rejects product review and releases the review-reserved vehicle", async () => {
    const harness = createReviewHarness();

    const order = await harness.service.reviewOrder(
      harness.orderId,
      "product",
      { remark: "套餐不匹配", status: OrderReviewStatus.REJECTED },
      harness.user,
      harness.context
    ) as Record<string, unknown>;

    expect(order.productReviewStatus).toBe(OrderReviewStatus.REJECTED);
    expect(order.orderStatus).toBe(OrderStatus.REJECTED);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
    expect(harness.tx.vehicle.update).toHaveBeenCalledWith({
      data: { status: VehicleStatus.AVAILABLE, updatedBy: harness.user.id },
      where: { id: harness.vehicleId }
    });
  });

  it("rejects vehicle review and releases the review-reserved vehicle", async () => {
    const harness = createReviewHarness();

    const order = await harness.service.reviewOrder(
      harness.orderId,
      "vehicle",
      { comment: "库存异常", status: OrderReviewStatus.REJECTED },
      harness.user,
      harness.context
    ) as Record<string, unknown>;

    expect(order.vehicleReviewStatus).toBe(OrderReviewStatus.REJECTED);
    expect(order.orderStatus).toBe(OrderStatus.REJECTED);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
  });

  it("moves to pending customer confirmation after all reviews are approved", async () => {
    const harness = createReviewHarness({
      creditReviewStatus: OrderReviewStatus.APPROVED,
      productReviewStatus: OrderReviewStatus.APPROVED
    });

    const order = await harness.service.reviewOrder(
      harness.orderId,
      "vehicle",
      { status: OrderReviewStatus.APPROVED },
      harness.user,
      harness.context
    ) as Record<string, unknown>;

    expect(order.vehicleReviewStatus).toBe(OrderReviewStatus.APPROVED);
    expect(order.orderStatus).toBe(OrderStatus.PENDING_CUSTOMER_CONFIRMATION);
  });

  it("finalizes the plan only after all reviews and deposit are confirmed", async () => {
    const harness = createReviewHarness({
      creditReviewStatus: OrderReviewStatus.APPROVED,
      depositAmount: 500000n,
      depositStatus: DepositStatus.CONFIRMED,
      finalDepositAmount: 500000n,
      orderStatus: OrderStatus.PENDING_CUSTOMER_CONFIRMATION,
      productReviewStatus: OrderReviewStatus.APPROVED,
      vehicleReviewStatus: OrderReviewStatus.APPROVED
    });

    const order = await harness.service.finalizePlan(
      harness.orderId,
      harness.user,
      harness.context
    ) as Record<string, unknown>;

    expect(order.orderStatus).toBe(OrderStatus.PENDING_CUSTOMER_CONFIRMATION);
    expect(order.finalPlanSnapshot).toEqual(
      expect.objectContaining({
        finalDepositAmount: 500000,
        orderId: harness.orderId,
        vehicleId: harness.vehicleId
      })
    );
  });

  it("customer-confirm enters pending contract and reserves the vehicle", async () => {
    const harness = createReviewHarness({
      creditReviewStatus: OrderReviewStatus.APPROVED,
      orderStatus: OrderStatus.PENDING_CUSTOMER_CONFIRMATION,
      productReviewStatus: OrderReviewStatus.APPROVED,
      vehicleReviewStatus: OrderReviewStatus.APPROVED
    });

    const order = await harness.service.confirmCustomerOrder(
      harness.orderId,
      harness.user,
      harness.context
    ) as Record<string, unknown>;

    expect(order.orderStatus).toBe(OrderStatus.PENDING_CONTRACT);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.RESERVED);
    expect(order.customerConfirmedAt).toEqual(expect.any(String));
    expect(order.finalPlanConfirmedAt).toEqual(expect.any(String));
    expect(harness.state.customerConfirmedAt).toBeInstanceOf(Date);
    expect(harness.state.finalPlanConfirmedAt).toBeInstanceOf(Date);
    expect(harness.tx.subscriptionQuote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: QuoteStatus.CONFIRMED })
      })
    );
  });

  it("rejects A-line review APIs for sales-assisted orders", async () => {
    const harness = createReviewHarness({
      orderSource: OrderSource.SALES_ASSISTED,
      orderStatus: OrderStatus.PENDING_CONTRACT
    });

    await expect(
      harness.service.reviewOrder(
        harness.orderId,
        "vehicle",
        { status: OrderReviewStatus.APPROVED },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("仅客户自助订单可以使用 A 线审核流程");

    expect(harness.tx.subscriptionOrder.update).not.toHaveBeenCalled();
  });

  it("restricts review sections by reviewer role", async () => {
    const harness = createReviewHarness();
    const riskUser = { ...harness.user, roles: ["RC"] };
    const assetUser = { ...harness.user, roles: ["AS"] };

    await expect(
      harness.service.reviewOrder(
        harness.orderId,
        "product",
        { status: OrderReviewStatus.APPROVED },
        riskUser,
        harness.context
      )
    ).rejects.toThrow("当前角色无权执行该审核环节。");

    await expect(
      harness.service.reviewOrder(
        harness.orderId,
        "credit",
        { customerGrade: CustomerGrade.A, status: OrderReviewStatus.APPROVED },
        assetUser,
        harness.context
      )
    ).rejects.toThrow("当前角色无权执行该审核环节。");

    expect(harness.tx.subscriptionOrder.update).not.toHaveBeenCalled();
  });
});

function createReviewHarness(overrides: Partial<ReviewState> = {}) {
  const now = new Date("2026-06-04T12:00:00.000Z");
  const orderId = "order-1";
  const quoteId = "quote-1";
  const vehicleId = "vehicle-1";
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: ["ADMIN"],
    username: "admin"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const state: ReviewState = {
    creditReviewStatus: OrderReviewStatus.PENDING,
    customerConfirmedAt: null,
    customerGrade: null,
    depositAmount: 0n,
    depositStatus: DepositStatus.PENDING_CONFIRM,
    finalDepositAmount: null,
    finalPlanConfirmedAt: null,
    finalPlanSnapshot: null,
    occupiedByOtherOrderCount: 0,
    orderSource: OrderSource.CUSTOMER_SELF_SERVICE,
    orderStatus: OrderStatus.PENDING_REVIEW,
    productReviewStatus: OrderReviewStatus.PENDING,
    reviewComment: null,
    vehicleReviewStatus: OrderReviewStatus.PENDING,
    vehicleSalePriceStatus: SalePriceStatus.EFFECTIVE,
    vehicleStatus: VehicleStatus.REVIEW_RESERVED,
    ...overrides
  };

  const tx = {
    customer: {
      findUnique: vi.fn(async () => buildCustomer(state, now)),
      update: vi.fn(async ({ data }) => {
        state.customerGrade = data.grade;
        return buildCustomer(state, now);
      })
    },
    depositRule: {
      findFirst: vi.fn(async () => ({
        createdAt: now,
        createdBy: user.id,
        defaultRate: 0.05,
        deletedAt: null,
        depositAmount: 500000n,
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
      count: vi.fn(async () => state.occupiedByOtherOrderCount),
      update: vi.fn(async ({ data }) => {
        applyOrderData(state, data);
        return buildOrder(state, now, orderId, quoteId, vehicleId);
      })
    },
    subscriptionQuote: {
      findUnique: vi.fn(async () => buildQuote(state, now, quoteId)),
      update: vi.fn(async ({ data }) => {
        if (data.depositAmount !== undefined) {
          state.depositAmount = data.depositAmount;
        }
        return buildQuote(state, now, quoteId);
      })
    },
    vehicle: {
      findUnique: vi.fn(async () => buildVehicle(state, now, vehicleId)),
      update: vi.fn(async ({ data }) => {
        state.vehicleStatus = data.status;
        return buildVehicle(state, now, vehicleId);
      })
    }
  };
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    subscriptionOrder: {
      findMany: vi.fn(async () => [buildOrder(state, now, orderId, quoteId, vehicleId)]),
      findUnique: vi.fn(async () => buildOrder(state, now, orderId, quoteId, vehicleId)),
      update: vi.fn(async ({ data }) => {
        applyOrderData(state, data);
        return buildOrder(state, now, orderId, quoteId, vehicleId);
      })
    }
  };
  const auditService = { write: vi.fn(async () => undefined) };
  const service = new OrderService(auditService as never, prisma as never);

  return { auditService, context, orderId, prisma, service, state, tx, user, vehicleId };
}

interface ReviewState {
  creditReviewStatus: OrderReviewStatus;
  customerConfirmedAt: Date | null;
  customerGrade: CustomerGrade | null;
  depositAmount: bigint;
  depositStatus: DepositStatus;
  finalDepositAmount: bigint | null;
  finalPlanConfirmedAt: Date | null;
  finalPlanSnapshot: Record<string, unknown> | null;
  occupiedByOtherOrderCount: number;
  orderSource: OrderSource;
  orderStatus: OrderStatus;
  productReviewStatus: OrderReviewStatus;
  reviewComment: string | null;
  vehicleReviewStatus: OrderReviewStatus;
  vehicleSalePriceStatus: SalePriceStatus;
  vehicleStatus: VehicleStatus;
}

function applyOrderData(state: ReviewState, data: Record<string, unknown>) {
  if (data.creditReviewStatus) state.creditReviewStatus = data.creditReviewStatus as OrderReviewStatus;
  if (data.customerConfirmedAt) state.customerConfirmedAt = data.customerConfirmedAt as Date;
  if (data.depositAmount !== undefined) state.depositAmount = data.depositAmount as bigint;
  if (data.depositStatus) state.depositStatus = data.depositStatus as DepositStatus;
  if (data.finalDepositAmount !== undefined) state.finalDepositAmount = data.finalDepositAmount as bigint | null;
  if (data.finalPlanConfirmedAt) state.finalPlanConfirmedAt = data.finalPlanConfirmedAt as Date;
  if (data.finalPlanSnapshot) state.finalPlanSnapshot = data.finalPlanSnapshot as Record<string, unknown>;
  if (data.orderStatus) state.orderStatus = data.orderStatus as OrderStatus;
  if (data.productReviewStatus) state.productReviewStatus = data.productReviewStatus as OrderReviewStatus;
  if (data.reviewComment !== undefined) state.reviewComment = data.reviewComment as string | null;
  if (data.vehicleReviewStatus) state.vehicleReviewStatus = data.vehicleReviewStatus as OrderReviewStatus;
}

function buildOrder(state: ReviewState, now: Date, orderId: string, quoteId: string, vehicleId: string) {
  return {
    actualDeliveryAt: null,
    application: {
      applicationNo: "APP202606040001",
      id: "application-1",
      salesUserId: "user-1",
      status: ApplicationStatus.SUBMITTED
    },
    applicationId: "application-1",
    businessType: BusinessType.SUBSCRIPTION,
    changes: [],
    contract: null,
    contractId: null,
    contracts: [],
    createdAt: now,
    createdBy: "user-1",
    creditReviewStatus: state.creditReviewStatus,
    customer: { grade: state.customerGrade, id: "customer-1", mobile: "13800000000", name: "测试客户" },
    customerConfirmedAt: state.customerConfirmedAt,
    customerId: "customer-1",
    customerSelectedSnapshot: {},
    deletedAt: null,
    depositAmount: state.depositAmount,
    depositStatus: state.depositStatus,
    endDate: null,
    energyLimitCount: null,
    energyLimitKwh: null,
    finalDepositAmount: state.finalDepositAmount,
    finalPlanConfirmedAt: state.finalPlanConfirmedAt,
    finalPlanSnapshot: state.finalPlanSnapshot,
    id: orderId,
    mileageLimitKm: 1500,
    monthlyFeeAmount: 520000n,
    orderNo: "ORD202606040001",
    orderSource: state.orderSource,
    orderStatus: state.orderStatus,
    overMileageFeeAmount: 100n,
    periodMonths: 12,
    productId: "product-1",
    productReviewStatus: state.productReviewStatus,
    productVersion: { product: { productType: BusinessType.SUBSCRIPTION, status: ProductStatus.ACTIVE } },
    productVersionId: "product-version-1",
    quote: { id: quoteId, quoteNo: "QUO202606040001", status: QuoteStatus.DRAFT },
    quoteId,
    quoteSnapshot: {},
    riskResult: null,
    riskResultId: null,
    reviewComment: state.reviewComment,
    startDate: null,
    updatedAt: now,
    updatedBy: "user-1",
    vehicle: buildVehicle(state, now, vehicleId),
    vehicleId,
    vehicleModel: VehicleModel.ET5,
    vehiclePurchasePriceAmount: 18000000n,
    vehicleReviewStatus: state.vehicleReviewStatus
  };
}

function buildCustomer(state: ReviewState, now: Date) {
  return {
    createdAt: now,
    createdBy: "user-1",
    customerNo: "CUS202606040001",
    customerType: "PERSONAL",
    deletedAt: null,
    grade: state.customerGrade,
    id: "customer-1",
    mobile: "13800000000",
    name: "测试客户",
    ownerUserId: null,
    riskScore: null,
    sourceChannel: null,
    status: "PENDING_APPLICATION",
    updatedAt: now,
    updatedBy: "user-1"
  };
}

function buildQuote(state: ReviewState, now: Date, quoteId: string) {
  return {
    createdAt: now,
    deletedAt: null,
    depositAmount: state.depositAmount,
    depositRuleSnapshot: null,
    id: quoteId,
    quoteNo: "QUO202606040001",
    status: QuoteStatus.DRAFT,
    subscriptionPlan: buildSubscriptionPlan(now),
    updatedAt: now
  };
}

function buildVehicle(state: ReviewState, now: Date, vehicleId: string) {
  return {
    brand: "NIO",
    createdAt: now,
    currentSalePriceAmount: 20000000n,
    deletedAt: null,
    id: vehicleId,
    model: "ET5",
    plateNo: "沪A00001",
    purchasePriceAmount: 18000000n,
    salePriceStatus: state.vehicleSalePriceStatus,
    status: state.vehicleStatus,
    updatedAt: now,
    vehicleModel: VehicleModel.ET5,
    vehicleNo: "VEH202606040001",
    vin: "VIN202606040001"
  };
}

function buildSubscriptionPlan(now: Date) {
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
    benefitPackage: null,
    benefitPackageId: null,
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    energyPackage: { ...packageBase, id: "energy-package-1" },
    energyPackageId: "energy-package-1",
    id: "plan-1",
    mileagePackage: { ...packageBase, id: "mileage-package-1" },
    mileagePackageId: "mileage-package-1",
    product,
    productId: product.id,
    productVersion,
    productVersionId: productVersion.id,
    status: SubscriptionPlanStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    vehiclePackage: {
      ...packageBase,
      id: "vehicle-package-1",
      vehicleModel: VehicleModel.ET5
    },
    vehiclePackageId: "vehicle-package-1"
  };
}
