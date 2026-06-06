import {
  BusinessType,
  DepositStatus,
  OrderReviewStatus,
  OrderSource,
  OrderStatus,
  Prisma,
  VehicleModel,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it } from "vitest";

describe("A/B order status model schema", () => {
  it("keeps sales-assisted legacy order create input compatible", () => {
    const legacyOrderInput = {
      applicationId: "application-1",
      businessType: BusinessType.SUBSCRIPTION,
      customerId: "customer-1",
      depositAmount: 500000n,
      mileageLimitKm: 1500,
      monthlyFeeAmount: 300000n,
      orderNo: "ORD202606040001",
      orderStatus: OrderStatus.PENDING_CONTRACT,
      overMileageFeeAmount: 100n,
      periodMonths: 12,
      productId: "product-1",
      productVersionId: "product-version-1",
      quoteId: "quote-1",
      quoteSnapshot: { quoteNo: "QUO202606040001" },
      riskResultId: "risk-result-1",
      vehicleModel: VehicleModel.ET5,
      vehiclePurchasePriceAmount: 10000000n
    } satisfies Prisma.SubscriptionOrderUncheckedCreateInput;

    expect(legacyOrderInput.orderStatus).toBe(OrderStatus.PENDING_CONTRACT);
    expect("orderSource" in legacyOrderInput).toBe(false);
    expect("creditReviewStatus" in legacyOrderInput).toBe(false);
    expect("depositStatus" in legacyOrderInput).toBe(false);
  });

  it("allows customer self-service orders to store pending review and pending deposit states", () => {
    const customerOrderInput = {
      applicationId: "application-2",
      businessType: BusinessType.SUBSCRIPTION,
      creditReviewStatus: OrderReviewStatus.PENDING,
      customerId: "customer-2",
      customerSelectedSnapshot: {
        selectedAt: "2026-06-04T10:00:00.000Z",
        subscriptionPlanId: "plan-1",
        vehicleId: "vehicle-1"
      },
      depositAmount: 0n,
      depositStatus: DepositStatus.PENDING_CONFIRM,
      finalDepositAmount: null,
      finalPlanSnapshot: {
        depositStatus: DepositStatus.PENDING_CONFIRM,
        subscriptionPlanId: "plan-1",
        vehicleId: "vehicle-1"
      },
      mileageLimitKm: 1500,
      monthlyFeeAmount: 300000n,
      orderNo: "ORD202606040002",
      orderSource: OrderSource.CUSTOMER_SELF_SERVICE,
      orderStatus: OrderStatus.PENDING_REVIEW,
      overMileageFeeAmount: 100n,
      periodMonths: 12,
      productId: "product-1",
      productReviewStatus: OrderReviewStatus.PENDING,
      productVersionId: "product-version-1",
      quoteId: "quote-2",
      quoteSnapshot: { intent: true, subscriptionPlanId: "plan-1" },
      riskResultId: "risk-result-2",
      reviewComment: "Initial customer intent pending back-office review.",
      vehicleModel: VehicleModel.ET5,
      vehiclePurchasePriceAmount: 10000000n,
      vehicleReviewStatus: OrderReviewStatus.PENDING
    } satisfies Prisma.SubscriptionOrderUncheckedCreateInput;

    expect(customerOrderInput.orderSource).toBe(OrderSource.CUSTOMER_SELF_SERVICE);
    expect(customerOrderInput.orderStatus).toBe(OrderStatus.PENDING_REVIEW);
    expect(customerOrderInput.creditReviewStatus).toBe(OrderReviewStatus.PENDING);
    expect(customerOrderInput.productReviewStatus).toBe(OrderReviewStatus.PENDING);
    expect(customerOrderInput.vehicleReviewStatus).toBe(OrderReviewStatus.PENDING);
    expect(customerOrderInput.depositStatus).toBe(DepositStatus.PENDING_CONFIRM);
    expect(customerOrderInput.finalDepositAmount).toBeNull();
    expect(customerOrderInput.finalPlanSnapshot).toEqual(
      expect.objectContaining({ subscriptionPlanId: "plan-1" })
    );
    expect(customerOrderInput.reviewComment).toBe(
      "Initial customer intent pending back-office review."
    );
  });

  it("exposes review, deposit, order, and vehicle status enum values", () => {
    expect(Object.values(OrderReviewStatus)).toEqual([
      "PENDING",
      "APPROVED",
      "REJECTED",
      "NEED_MORE_INFO"
    ]);
    expect(Object.values(DepositStatus)).toEqual([
      "PENDING_CONFIRM",
      "CONFIRMED",
      "WAIVED",
      "REJECTED"
    ]);
    expect(OrderStatus.PENDING_CUSTOMER_CONFIRMATION).toBe(
      "PENDING_CUSTOMER_CONFIRMATION"
    );
    expect(OrderStatus.REJECTED).toBe("REJECTED");
    expect(VehicleStatus.REVIEW_RESERVED).toBe("REVIEW_RESERVED");
  });
});
