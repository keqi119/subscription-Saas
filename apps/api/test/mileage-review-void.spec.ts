import {
  BillStatus,
  EntitlementGrantStatus,
  EntitlementUsageStatus,
  OrderMileageReviewStatus,
  OrderStatus,
  Prisma
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MileageReviewSettlementService } from "../src/mileage-review/mileage-review-settlement.service";

describe("mileage review void and reopen", () => {
  it("restores ledgers, cancels the unpaid bill, and creates a replacement version", async () => {
    const harness = createHarness();

    const result = await harness.service.voidAndReopenReview({
      expectedLockVersion: 4,
      reason: "仪表盘读数录入错误",
      reviewId: "review-1",
      userId: "user-1",
      voidedAt: harness.voidedAt
    });

    expect(harness.tx.orderEntitlementUsage.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        usageStatus: EntitlementUsageStatus.CANCELLED
      }),
      where: { id: "usage-1" }
    });
    expect(harness.tx.orderEntitlementGrant.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        remainingAmount: new Prisma.Decimal(1_500),
        status: EntitlementGrantStatus.ACTIVE,
        usedAmount: new Prisma.Decimal(0)
      }),
      where: { id: "grant-1" }
    });
    expect(harness.tx.receivableBill.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        billStatus: BillStatus.CANCELLED,
        cancelledAt: harness.voidedAt,
        remainingAmount: 0n
      }),
      where: { id: "bill-1" }
    });
    expect(harness.vehicleMileageService.voidReadingAndRestoreProjection).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({ readingId: "reading-2", vehicleId: "vehicle-1" })
    );
    expect(harness.tx.orderMileageReview.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ deletedAt: harness.voidedAt }),
      where: expect.objectContaining({ cycleNo: { gt: 1 }, orderId: "order-1" })
    });
    expect(harness.tx.orderMileageReview.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: OrderMileageReviewStatus.VOIDED,
        voidReason: "仪表盘读数录入错误",
        voidedAt: harness.voidedAt,
        voidedBy: "user-1"
      }),
      where: { id: "review-1" }
    });
    expect(harness.tx.orderMileageReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        baselineMileageKm: 1_000,
        baselineReadingId: "reading-1",
        cycleNo: 1,
        status: OrderMileageReviewStatus.PENDING_SUBMISSION,
        version: 2
      })
    });
    expect(result.replacementReview.id).toBe("review-1-v2");
  });

  it("refuses void when a later cycle has already been confirmed", async () => {
    const harness = createHarness({ laterConfirmedCount: 1 });

    await expect(
      harness.service.voidAndReopenReview({
        expectedLockVersion: 4,
        reason: "wrong",
        reviewId: "review-1",
        userId: "user-1"
      })
    ).rejects.toThrow("later confirmed mileage review");

    expect(harness.tx.receivableBill.update).not.toHaveBeenCalled();
    expect(harness.tx.orderMileageReview.create).not.toHaveBeenCalled();
  });

  it.each([BillStatus.PARTIALLY_PAID, BillStatus.PAID])(
    "refuses void for a %s over-mileage bill",
    async (billStatus) => {
      const harness = createHarness({ billStatus });

      await expect(
        harness.service.voidAndReopenReview({
          expectedLockVersion: 4,
          reason: "wrong",
          reviewId: "review-1",
          userId: "user-1"
        })
      ).rejects.toThrow("paid or partially paid");

      expect(harness.vehicleMileageService.voidReadingAndRestoreProjection).not.toHaveBeenCalled();
    }
  );
});

function createHarness(
  overrides: {
    billStatus?: BillStatus;
    laterConfirmedCount?: number;
  } = {}
) {
  const voidedAt = new Date("2026-10-01T01:00:00.000Z");
  const review = {
    allowanceKm: 1_500,
    baselineMileageKm: 1_000,
    baselineReadingId: "reading-1",
    calculationSnapshot: {},
    consumedAllowanceKm: 1_500,
    cycleNo: 1,
    deletedAt: null,
    dueAt: new Date("2026-10-01T04:30:00.000Z"),
    entitlementGrantId: "grant-1",
    entitlementUsageId: "usage-1",
    id: "review-1",
    lockVersion: 4,
    mileageReadingId: "reading-2",
    order: {
      actualDeliveryAt: new Date("2026-08-31T04:30:00.000Z"),
      customerId: "customer-1",
      id: "order-1",
      mileageLimitKm: 1_500,
      orderNo: "ORD-1",
      orderStatus: OrderStatus.ACTIVE,
      overMileageFeeAmount: 100n,
      periodMonths: 12
    },
    orderId: "order-1",
    overMileageBillId: "bill-1",
    periodEnd: new Date("2026-09-30T04:29:59.999Z"),
    periodStart: new Date("2026-08-31T04:30:00.000Z"),
    scheduledReviewAt: new Date("2026-09-30T04:30:00.000Z"),
    status: OrderMileageReviewStatus.CONFIRMED,
    vehicleId: "vehicle-1",
    version: 1
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: review.id }]),
    orderEntitlementGrant: {
      findUnique: vi.fn(async () => ({
        id: "grant-1",
        remainingAmount: new Prisma.Decimal(0),
        status: EntitlementGrantStatus.EXHAUSTED,
        usedAmount: new Prisma.Decimal(1_500)
      })),
      update: vi.fn()
    },
    orderEntitlementUsage: {
      findUnique: vi.fn(async () => ({
        id: "usage-1",
        usageStatus: EntitlementUsageStatus.CONFIRMED,
        usedAmount: new Prisma.Decimal(1_500)
      })),
      update: vi.fn()
    },
    orderMileageReview: {
      count: vi.fn(async () => overrides.laterConfirmedCount ?? 0),
      create: vi.fn(async () => ({ ...review, id: "review-1-v2", version: 2 })),
      findUnique: vi.fn(async () => review),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "review-1-v2" ? { ...review, id: "review-1-v2", version: 2 } : review
      ),
      update: vi.fn(async () => ({ ...review, status: OrderMileageReviewStatus.VOIDED })),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    receivableBill: {
      findUnique: vi.fn(async () => ({
        amount: 50_000n,
        billStatus: overrides.billStatus ?? BillStatus.PENDING,
        id: "bill-1",
        paidAmount: overrides.billStatus === BillStatus.PAID ? 50_000n : overrides.billStatus === BillStatus.PARTIALLY_PAID ? 10_000n : 0n,
        remainingAmount: overrides.billStatus === BillStatus.PAID ? 0n : overrides.billStatus === BillStatus.PARTIALLY_PAID ? 40_000n : 50_000n
      })),
      update: vi.fn()
    }
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx))
  };
  const vehicleMileageService = {
    appendConfirmedReading: vi.fn(),
    voidReadingAndRestoreProjection: vi.fn(async () => ({ id: "reading-1", mileageKm: 1_000 }))
  };

  return {
    service: new MileageReviewSettlementService(prisma as never, vehicleMileageService as never),
    tx,
    vehicleMileageService,
    voidedAt
  };
}
