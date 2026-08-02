import {
  BillStatus,
  EntitlementGrantStatus,
  EntitlementType,
  EntitlementUnit,
  OrderMileageReviewStatus,
  OrderStatus,
  Prisma,
  VehicleMileageSourceType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MileageReviewSettlementService } from "../src/mileage-review/mileage-review-settlement.service";

describe("mileage review settlement", () => {
  it("atomically consumes allowance, updates mileage, bills overage, and schedules the next cycle", async () => {
    const harness = createHarness();

    const result = await harness.service.settleReview({
      confirmedAt: harness.confirmedAt,
      expectedLockVersion: 3,
      idempotencyKey: "confirm-review-1",
      reviewId: "review-1",
      userId: "user-1"
    });

    expect(harness.tx.orderEntitlementUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        externalRefNo: "mileage-review:review-1:v1",
        usedAmount: new Prisma.Decimal(1_500)
      })
    });
    expect(harness.tx.orderEntitlementGrant.findFirst).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      where: expect.objectContaining({
        grantPeriodEnd: { gte: new Date("2026-09-29T00:00:00.000Z") },
        grantPeriodStart: { lte: new Date("2026-08-31T00:00:00.000Z") },
        status: {
          in: [
            EntitlementGrantStatus.ACTIVE,
            EntitlementGrantStatus.EXHAUSTED,
            EntitlementGrantStatus.EXPIRED
          ]
        }
      })
    });
    expect(harness.tx.orderEntitlementGrant.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        remainingAmount: new Prisma.Decimal(0),
        status: EntitlementGrantStatus.EXHAUSTED,
        usedAmount: new Prisma.Decimal(1_500)
      }),
      where: { id: "grant-1" }
    });
    expect(harness.vehicleMileageService.appendConfirmedReading).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        mileageKm: 3_000,
        sourceRecordId: "review-1:v1",
        sourceType: VehicleMileageSourceType.MONTHLY_REVIEW
      })
    );
    expect(harness.tx.receivableBill.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amount: 50_000n,
        billStatus: BillStatus.PENDING,
        dueDate: new Date("2026-10-05T04:30:00.000Z"),
        remainingAmount: 50_000n,
        sourceKey: "over-mileage:review-1:v1"
      })
    });
    expect(harness.tx.orderMileageReview.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        allowanceKm: 1_500,
        consumedAllowanceKm: 1_500,
        mileageReadingId: "reading-2",
        overMileageAmount: 50_000n,
        overMileageBillId: "bill-1",
        overMileageKm: 500,
        status: OrderMileageReviewStatus.CONFIRMED
      }),
      where: { id: "review-1" }
    });
    expect(harness.tx.orderMileageReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          baselineMileageKm: 3_000,
          baselineReadingId: "reading-2",
          cycleNo: 2,
          status: OrderMileageReviewStatus.SCHEDULED
        })
      })
    );
    expect(result.status).toBe(OrderMileageReviewStatus.CONFIRMED);
  });

  it("does not create a zero-value usage or bill when no mileage was consumed", async () => {
    const harness = createHarness({ submittedMileageKm: 1_000 });

    await harness.service.settleReview({
      confirmedAt: harness.confirmedAt,
      expectedLockVersion: 3,
      idempotencyKey: "confirm-review-1-zero",
      reviewId: "review-1",
      userId: "user-1"
    });

    expect(harness.tx.orderEntitlementUsage.create).not.toHaveBeenCalled();
    expect(harness.tx.receivableBill.create).not.toHaveBeenCalled();
    expect(harness.tx.orderMileageReview.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        consumedAllowanceKm: 0,
        entitlementUsageId: null,
        overMileageAmount: 0n,
        overMileageBillId: null,
        overMileageKm: 0
      }),
      where: { id: "review-1" }
    });
  });

  it("confirms positive overage without a bill when the configured rate is zero", async () => {
    const harness = createHarness({ overMileageFeeAmount: 0n });

    await harness.service.settleReview({
      confirmedAt: harness.confirmedAt,
      expectedLockVersion: 3,
      idempotencyKey: "confirm-review-zero-rate",
      reviewId: "review-1",
      userId: "user-1"
    });

    expect(harness.tx.receivableBill.create).not.toHaveBeenCalled();
    expect(harness.tx.orderMileageReview.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        overMileageAmount: 0n,
        overMileageBillId: null,
        overMileageFeeAmount: 0n,
        overMileageKm: 500
      }),
      where: { id: "review-1" }
    });
  });

  it("returns the already-confirmed result for the same idempotency key without duplicate side effects", async () => {
    const harness = createHarness({
      calculationSnapshot: { confirmation: { idempotencyKey: "same-key" } },
      status: OrderMileageReviewStatus.CONFIRMED
    });

    const result = await harness.service.settleReview({
      confirmedAt: harness.confirmedAt,
      expectedLockVersion: 3,
      idempotencyKey: "same-key",
      reviewId: "review-1",
      userId: "user-1"
    });

    expect(result.status).toBe(OrderMileageReviewStatus.CONFIRMED);
    expect(harness.vehicleMileageService.appendConfirmedReading).not.toHaveBeenCalled();
    expect(harness.tx.receivableBill.create).not.toHaveBeenCalled();
    expect(harness.tx.orderMileageReview.update).not.toHaveBeenCalled();
  });

  it("does not continue after a failed mileage ledger write", async () => {
    const harness = createHarness();
    harness.vehicleMileageService.appendConfirmedReading.mockRejectedValueOnce(
      new Error("ledger unavailable")
    );

    await expect(
      harness.service.settleReview({
        confirmedAt: harness.confirmedAt,
        expectedLockVersion: 3,
        idempotencyKey: "failed-confirm",
        reviewId: "review-1",
        userId: "user-1"
      })
    ).rejects.toThrow("ledger unavailable");

    expect(harness.tx.receivableBill.create).not.toHaveBeenCalled();
    expect(harness.tx.orderMileageReview.update).not.toHaveBeenCalled();
  });

  it("rejects a reading timestamp that could poison future mileage ordering", async () => {
    const harness = createHarness({
      readingAt: new Date("2099-01-01T00:00:00.000Z")
    });

    await expect(
      harness.service.settleReview({
        confirmedAt: harness.confirmedAt,
        expectedLockVersion: 3,
        idempotencyKey: "future-reading",
        reviewId: "review-1",
        userId: "user-1"
      })
    ).rejects.toThrow("outside the allowed review window");

    expect(harness.vehicleMileageService.appendConfirmedReading).not.toHaveBeenCalled();
  });
});

function createHarness(
  overrides: {
    calculationSnapshot?: Record<string, unknown>;
    overMileageFeeAmount?: bigint;
    readingAt?: Date;
    status?: OrderMileageReviewStatus;
    submittedMileageKm?: number;
  } = {}
) {
  const confirmedAt = new Date("2026-09-30T04:30:00.000Z");
  const review = {
    baselineMileageKm: 1_000,
    baselineReadingId: "reading-1",
    baselineReading: { recordedAt: new Date("2026-08-31T04:30:00.000Z") },
    calculationSnapshot: overrides.calculationSnapshot ?? {},
    cycleNo: 1,
    deletedAt: null,
    dueAt: new Date("2026-10-01T04:30:00.000Z"),
    evidence: [{ deletedAt: null, file: { mimeType: "image/jpeg" }, id: "ev-1" }],
    id: "review-1",
    lockVersion: 3,
    order: {
      actualDeliveryAt: new Date("2026-08-31T04:30:00.000Z"),
      customerId: "customer-1",
      id: "order-1",
      mileageLimitKm: 1_500,
      orderNo: "ORD-1",
      orderStatus: OrderStatus.ACTIVE,
      overMileageFeeAmount: overrides.overMileageFeeAmount ?? 100n,
      periodMonths: 12
    },
    orderId: "order-1",
    periodEnd: new Date("2026-09-30T04:29:59.999Z"),
    periodStart: new Date("2026-08-31T04:30:00.000Z"),
    readingAt: overrides.readingAt ?? confirmedAt,
    status: overrides.status ?? OrderMileageReviewStatus.PENDING_REVIEW,
    scheduledReviewAt: new Date("2026-09-30T04:30:00.000Z"),
    submittedMileageKm: overrides.submittedMileageKm ?? 3_000,
    vehicleId: "vehicle-1",
    version: 1
  };
  const confirmedReview = {
    ...review,
    status: OrderMileageReviewStatus.CONFIRMED
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: review.id }]),
    orderEntitlementAccount: {
      create: vi.fn(),
      findFirst: vi.fn(async () => ({ id: "account-1" }))
    },
    orderEntitlementGrant: {
      create: vi.fn(),
      findFirst: vi.fn(async () => ({
        accountId: "account-1",
        entitlementName: "月里程额度",
        entitlementType: EntitlementType.MILEAGE,
        id: "grant-1",
        remainingAmount: new Prisma.Decimal(1_500),
        status: EntitlementGrantStatus.ACTIVE,
        totalAmount: new Prisma.Decimal(1_500),
        unit: EntitlementUnit.KM,
        usedAmount: new Prisma.Decimal(0)
      })),
      update: vi.fn()
    },
    orderEntitlementUsage: {
      create: vi.fn(async () => ({ id: "usage-1" })),
      findFirst: vi.fn(async () => null)
    },
    orderMileageReview: {
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({ id: "review-2" })),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn().mockResolvedValueOnce(review).mockResolvedValue(confirmedReview),
      findUniqueOrThrow: vi.fn(async () => confirmedReview),
      update: vi.fn(async () => confirmedReview)
    },
    receivableBill: {
      create: vi.fn(async () => ({ id: "bill-1" })),
      findUnique: vi.fn(async () => null)
    }
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx))
  };
  const vehicleMileageService = {
    appendConfirmedReading: vi.fn(async () => ({ id: "reading-2" }))
  };

  return {
    confirmedAt,
    service: new MileageReviewSettlementService(prisma as never, vehicleMileageService as never),
    tx,
    vehicleMileageService
  };
}
