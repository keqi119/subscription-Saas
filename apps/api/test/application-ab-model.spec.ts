import {
  ApplicationSource,
  CustomerGrade,
  DepositStatus,
  OrderReviewStatus,
  PlanConfirmStatus,
  Prisma,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it } from "vitest";

describe("A/B application intake model schema", () => {
  it("keeps sales-assisted application create input compatible by default", () => {
    const salesAssistedInput = {
      applicationNo: "APP202606050001",
      customerId: "customer-1",
      intendedModel: "ET5",
      intendedPeriodMonths: 12,
      salesUserId: "user-1"
    } satisfies Prisma.ApplicationUncheckedCreateInput;

    expect("applicationSource" in salesAssistedInput).toBe(false);
    expect("intentSnapshot" in salesAssistedInput).toBe(false);
    expect("finalDepositAmount" in salesAssistedInput).toBe(false);
  });

  it("allows self-service applications to store customer intent and pending review state", () => {
    const submittedAt = new Date("2026-06-05T10:00:00.000Z");
    const selfServiceInput = {
      applicationNo: "APP202606050002",
      applicationSource: ApplicationSource.SELF_SERVICE,
      creditReviewStatus: OrderReviewStatus.PENDING,
      customerId: "customer-2",
      customerSelectedSnapshot: {
        depositDescription: "押金审核后确认",
        periodMonths: 12,
        subscriptionPlanId: "plan-1",
        vehicleId: "vehicle-1"
      },
      depositStatus: DepositStatus.PENDING_CONFIRM,
      finalDepositAmount: null,
      intentPeriodMonths: 12,
      intentSnapshot: {
        selectedAt: submittedAt.toISOString(),
        subscriptionPlanId: "plan-1",
        vehicleBaseFeeAmount: 520000,
        vehicleId: "vehicle-1"
      },
      intentSubscriptionPlanId: "plan-1",
      intentVehicleBaseFeeAmount: 520000n,
      intentVehicleId: "vehicle-1",
      materialReviewStatus: OrderReviewStatus.PENDING,
      planConfirmStatus: PlanConfirmStatus.PENDING,
      productReviewStatus: OrderReviewStatus.PENDING,
      salesUserId: "user-2",
      softReservedAt: submittedAt,
      softReservedVehicleId: "vehicle-1",
      vehicleReviewStatus: OrderReviewStatus.PENDING
    } satisfies Prisma.ApplicationUncheckedCreateInput;

    expect(selfServiceInput.applicationSource).toBe(ApplicationSource.SELF_SERVICE);
    expect(selfServiceInput.intentVehicleId).toBe("vehicle-1");
    expect(selfServiceInput.intentSubscriptionPlanId).toBe("plan-1");
    expect(selfServiceInput.intentVehicleBaseFeeAmount).toBe(520000n);
    expect(selfServiceInput.depositStatus).toBe(DepositStatus.PENDING_CONFIRM);
    expect(selfServiceInput.finalDepositAmount).toBeNull();
    expect(selfServiceInput.customerSelectedSnapshot).toEqual(
      expect.objectContaining({ subscriptionPlanId: "plan-1" })
    );
  });

  it("allows final plan, deposit, and credit review fields to be stored before order creation", () => {
    const finalPlanInput = {
      applicationNo: "APP202606050003",
      applicationSource: ApplicationSource.SELF_SERVICE,
      creditReviewComment: "客户资质通过",
      creditReviewStatus: OrderReviewStatus.APPROVED,
      customerGrade: CustomerGrade.A,
      customerId: "customer-3",
      depositRuleId: "deposit-rule-1",
      depositRuleSnapshot: {
        depositAmount: 500000,
        grade: CustomerGrade.A
      },
      depositStatus: DepositStatus.CONFIRMED,
      finalDepositAmount: 500000n,
      finalPeriodMonths: 12,
      finalPlanConfirmedAt: new Date("2026-06-05T11:00:00.000Z"),
      finalPlanSnapshot: {
        depositAmount: 500000,
        subscriptionPlanId: "plan-2",
        vehicleId: "vehicle-2"
      },
      finalQuoteSnapshot: {
        monthlyFeeAmount: 820000,
        quoteNo: "QUO202606050001"
      },
      finalSubscriptionPlanId: "plan-2",
      finalVehicleBaseFeeAmount: 530000n,
      finalVehicleId: "vehicle-2",
      planConfirmStatus: PlanConfirmStatus.CONFIRMED,
      salesUserId: "user-3"
    } satisfies Prisma.ApplicationUncheckedCreateInput;

    expect(finalPlanInput.planConfirmStatus).toBe(PlanConfirmStatus.CONFIRMED);
    expect(finalPlanInput.depositStatus).toBe(DepositStatus.CONFIRMED);
    expect(finalPlanInput.finalDepositAmount).toBe(500000n);
    expect(finalPlanInput.finalPlanSnapshot).toEqual(
      expect.objectContaining({ vehicleId: "vehicle-2" })
    );
  });

  it("exposes application source, final-plan, review, deposit, and vehicle hold enums", () => {
    expect(Object.values(ApplicationSource)).toEqual(["SELF_SERVICE", "SALES_ASSISTED"]);
    expect(Object.values(PlanConfirmStatus)).toEqual(["PENDING", "CONFIRMED", "REJECTED"]);
    expect(Object.values(OrderReviewStatus)).toEqual([
      "PENDING",
      "APPROVED",
      "REJECTED",
      "NEED_MORE_INFO"
    ]);
    expect(DepositStatus.PENDING_CONFIRM).toBe("PENDING_CONFIRM");
    expect(VehicleStatus.REVIEW_RESERVED).toBe("REVIEW_RESERVED");
  });
});
