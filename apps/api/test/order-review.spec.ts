import {
  ApplicationStatus,
  BusinessType,
  CustomerGrade,
  DepositStatus,
  OrderReviewStatus,
  OrderSource,
  OrderStatus,
  ProductStatus,
  QuoteStatus,
  RecordStatus,
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
          orderStatus: OrderStatus.PENDING_REVIEW
        })
      })
    );
  });

  it("approves credit review and writes customer grade plus deposit", async () => {
    const harness = createReviewHarness();

    const order = await harness.service.reviewOrder(
      harness.orderId,
      "credit",
      { customerGrade: CustomerGrade.A, status: OrderReviewStatus.APPROVED },
      harness.user,
      harness.context
    ) as Record<string, unknown>;

    expect(order.creditReviewStatus).toBe(OrderReviewStatus.APPROVED);
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

  it("rejects any review and releases the review-reserved vehicle", async () => {
    const harness = createReviewHarness();

    const order = await harness.service.reviewOrder(
      harness.orderId,
      "product",
      { remark: "套餐不匹配", status: OrderReviewStatus.REJECTED },
      harness.user,
      harness.context
    ) as Record<string, unknown>;

    expect(order.orderStatus).toBe(OrderStatus.REJECTED);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
    expect(harness.tx.vehicle.update).toHaveBeenCalledWith({
      data: { status: VehicleStatus.AVAILABLE, updatedBy: harness.user.id },
      where: { id: harness.vehicleId }
    });
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
    customerGrade: null,
    depositAmount: 0n,
    depositStatus: DepositStatus.PENDING_CONFIRM,
    finalDepositAmount: null,
    orderSource: OrderSource.CUSTOMER_SELF_SERVICE,
    orderStatus: OrderStatus.PENDING_REVIEW,
    productReviewStatus: OrderReviewStatus.PENDING,
    vehicleReviewStatus: OrderReviewStatus.PENDING,
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
  customerGrade: CustomerGrade | null;
  depositAmount: bigint;
  depositStatus: DepositStatus;
  finalDepositAmount: bigint | null;
  orderSource: OrderSource;
  orderStatus: OrderStatus;
  productReviewStatus: OrderReviewStatus;
  vehicleReviewStatus: OrderReviewStatus;
  vehicleStatus: VehicleStatus;
}

function applyOrderData(state: ReviewState, data: Record<string, unknown>) {
  if (data.creditReviewStatus) state.creditReviewStatus = data.creditReviewStatus as OrderReviewStatus;
  if (data.depositAmount !== undefined) state.depositAmount = data.depositAmount as bigint;
  if (data.depositStatus) state.depositStatus = data.depositStatus as DepositStatus;
  if (data.finalDepositAmount !== undefined) state.finalDepositAmount = data.finalDepositAmount as bigint | null;
  if (data.orderStatus) state.orderStatus = data.orderStatus as OrderStatus;
  if (data.productReviewStatus) state.productReviewStatus = data.productReviewStatus as OrderReviewStatus;
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
    customerConfirmedAt: null,
    customerId: "customer-1",
    customerSelectedSnapshot: {},
    deletedAt: null,
    depositAmount: state.depositAmount,
    depositStatus: state.depositStatus,
    endDate: null,
    energyLimitCount: null,
    energyLimitKwh: null,
    finalDepositAmount: state.finalDepositAmount,
    finalPlanConfirmedAt: null,
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
    status: state.vehicleStatus,
    updatedAt: now,
    vehicleModel: VehicleModel.ET5,
    vehicleNo: "VEH202606040001",
    vin: "VIN202606040001"
  };
}
