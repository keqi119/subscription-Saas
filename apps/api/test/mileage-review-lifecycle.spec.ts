import {
  OrderMileageReviewStatus,
  VehicleMileageReadingStatus,
  VehicleMileageSourceType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MileageReviewRepository } from "../src/mileage-review/mileage-review.repository";
import {
  MileageReviewService,
  deriveOverdue
} from "../src/mileage-review/mileage-review.service";

describe("monthly mileage review lifecycle", () => {
  it("creates the first scheduled cycle from the delivery reading", async () => {
    const harness = createHarness();

    const review = await harness.service.createFirstReview(harness.tx as never, {
      actualDeliveryAt: new Date("2026-08-31T04:30:00.000Z"),
      actorId: "user-1",
      deliveryReadingId: "reading-1",
      orderId: "order-1",
      vehicleId: "vehicle-1"
    });

    expect(review).toMatchObject({
      baselineMileageKm: 28_500,
      baselineReadingId: "reading-1",
      cycleNo: 1,
      orderId: "order-1",
      periodStart: new Date("2026-08-31T04:30:00.000Z"),
      periodEnd: new Date("2026-09-30T04:29:59.999Z"),
      scheduledReviewAt: new Date("2026-09-30T04:30:00.000Z"),
      dueAt: new Date("2026-10-01T04:30:00.000Z"),
      status: OrderMileageReviewStatus.SCHEDULED,
      vehicleId: "vehicle-1",
      version: 1
    });
    expect(harness.lastCreate?.calculationSnapshot).toEqual({
      cycle: {
        actualDeliveryAt: "2026-08-31T04:30:00.000Z",
        timezone: "Asia/Shanghai"
      },
      source: {
        deliveryReadingId: "reading-1",
        type: VehicleMileageSourceType.DELIVERY_BASELINE
      }
    });
  });

  it("is idempotent when delivery orchestration retries the first-cycle write", async () => {
    const harness = createHarness();
    const input = {
      actualDeliveryAt: new Date("2026-08-31T04:30:00.000Z"),
      actorId: "user-1",
      deliveryReadingId: "reading-1",
      orderId: "order-1",
      vehicleId: "vehicle-1"
    };

    const first = await harness.service.createFirstReview(harness.tx as never, input);
    const retry = await harness.service.createFirstReview(harness.tx as never, input);

    expect(retry.id).toBe(first.id);
    expect(harness.reviews).toHaveLength(1);
  });

  it("rejects a baseline that is not the matching active delivery reading", async () => {
    const harness = createHarness();
    harness.reading.sourceType = VehicleMileageSourceType.RETURN_CONFIRMATION;

    await expect(
      harness.service.createFirstReview(harness.tx as never, {
        actualDeliveryAt: new Date("2026-08-31T04:30:00.000Z"),
        actorId: "user-1",
        deliveryReadingId: "reading-1",
        orderId: "order-1",
        vehicleId: "vehicle-1"
      })
    ).rejects.toThrow("Delivery baseline mileage reading is invalid.");
    expect(harness.reviews).toHaveLength(0);
  });

  it("does not mutate a scheduled review before its boundary", async () => {
    const harness = createHarness();
    await harness.service.createFirstReview(harness.tx as never, {
      actualDeliveryAt: new Date("2026-08-31T04:30:00.000Z"),
      actorId: "user-1",
      deliveryReadingId: "reading-1",
      orderId: "order-1",
      vehicleId: "vehicle-1"
    });

    const result = await harness.service.activateDueReviews(
      new Date("2026-09-30T04:29:59.999Z")
    );

    expect(result).toEqual({ activatedCount: 0 });
    expect(harness.reviews[0]?.status).toBe(OrderMileageReviewStatus.SCHEDULED);
    expect(harness.reviews[0]?.submittedMileageKm).toBeNull();
    expect(harness.reviews[0]?.allowanceKm).toBeNull();
    expect(harness.reviews[0]?.overMileageAmount).toBeNull();
  });

  it("activates due tasks without estimating mileage, consuming allowance, or billing", async () => {
    const harness = createHarness();
    await harness.service.createFirstReview(harness.tx as never, {
      actualDeliveryAt: new Date("2026-08-31T04:30:00.000Z"),
      actorId: "user-1",
      deliveryReadingId: "reading-1",
      orderId: "order-1",
      vehicleId: "vehicle-1"
    });

    const result = await harness.service.activateDueReviews(
      new Date("2026-09-30T04:30:00.000Z")
    );

    expect(result).toEqual({ activatedCount: 1 });
    expect(harness.reviews[0]).toMatchObject({
      allowanceKm: null,
      entitlementUsageId: null,
      mileageReadingId: null,
      overMileageAmount: null,
      overMileageBillId: null,
      status: OrderMileageReviewStatus.PENDING_SUBMISSION,
      submittedMileageKm: null
    });
  });

  it("derives overdue only for pending submission after the due instant", () => {
    const dueAt = new Date("2026-10-01T04:30:00.000Z");

    expect(
      deriveOverdue(
        { dueAt, status: OrderMileageReviewStatus.PENDING_SUBMISSION },
        dueAt
      )
    ).toBe(false);
    expect(
      deriveOverdue(
        { dueAt, status: OrderMileageReviewStatus.PENDING_SUBMISSION },
        new Date(dueAt.getTime() + 1)
      )
    ).toBe(true);
    expect(
      deriveOverdue(
        { dueAt, status: OrderMileageReviewStatus.RETURNED },
        new Date(dueAt.getTime() + 1)
      )
    ).toBe(false);
  });
});

function createHarness() {
  const reviews: Array<Record<string, unknown>> = [];
  const reading: {
    id: string;
    mileageKm: number;
    orderId: string;
    sourceType: VehicleMileageSourceType;
    status: VehicleMileageReadingStatus;
    vehicleId: string;
  } = {
    id: "reading-1",
    mileageKm: 28_500,
    orderId: "order-1",
    sourceType: VehicleMileageSourceType.DELIVERY_BASELINE,
    status: VehicleMileageReadingStatus.ACTIVE,
    vehicleId: "vehicle-1"
  };
  let lastCreate: Record<string, unknown> | null = null;
  const delegates = {
    orderMileageReview: {
      updateMany: vi.fn(async ({ data, where }: Record<string, any>) => {
        let count = 0;
        for (const review of reviews) {
          const scheduledReviewAt = review.scheduledReviewAt as Date;
          if (
            review.deletedAt === null &&
            review.status === where.status &&
            scheduledReviewAt <= where.scheduledReviewAt.lte
          ) {
            review.status = data.status;
            review.lockVersion = Number(review.lockVersion) + data.lockVersion.increment;
            count += 1;
          }
        }
        return { count };
      }),
      upsert: vi.fn(async ({ create, where }: Record<string, any>) => {
        const key = where.orderId_cycleNo_version;
        const existing = reviews.find(
          (review) =>
            review.orderId === key.orderId &&
            review.cycleNo === key.cycleNo &&
            review.version === key.version
        );
        if (existing) {
          return existing;
        }
        lastCreate = create;
        const next = {
          ...create,
          allowanceKm: null,
          deletedAt: null,
          entitlementUsageId: null,
          id: `review-${reviews.length + 1}`,
          lockVersion: 0,
          mileageReadingId: null,
          overMileageAmount: null,
          overMileageBillId: null,
          submittedMileageKm: null
        };
        reviews.push(next);
        return next;
      })
    },
    vehicleMileageReading: {
      findUnique: vi.fn(async ({ where }: Record<string, any>) =>
        where.id === reading.id ? reading : null
      )
    }
  };
  const prisma = delegates;
  const repository = new MileageReviewRepository(prisma as never);
  const service = new MileageReviewService(prisma as never, repository);

  return {
    get lastCreate() {
      return lastCreate;
    },
    prisma,
    reading,
    reviews,
    service,
    tx: delegates
  };
}
