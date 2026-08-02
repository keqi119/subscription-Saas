import { ConfigService } from "@nestjs/config";
import { OrderMileageReviewStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MileageReviewWorker } from "../src/mileage-review/mileage-review.worker";

describe("MileageReviewWorker", () => {
  it("does no activation or notification work when disabled", async () => {
    const harness = createHarness({ enabled: false });

    await expect(harness.worker.runOnce(harness.asOf)).resolves.toEqual({
      activatedCount: 0,
      enabled: false,
      failedNotifications: 0,
      notifiedCount: 0
    });
    expect(harness.mileageReviewService.activateDueReviews).not.toHaveBeenCalled();
    expect(harness.notificationService.notifyMileageReviewDue).not.toHaveBeenCalled();
  });

  it("activates due reviews and uses a deterministic Shanghai-local daily reminder key", async () => {
    const harness = createHarness();

    const result = await harness.worker.runOnce(harness.asOf);

    expect(harness.mileageReviewService.activateDueReviews).toHaveBeenCalledWith(harness.asOf);
    expect(harness.notificationService.notifyMileageReviewDue).toHaveBeenCalledWith({
      customerId: "customer-1",
      cycleNo: 1,
      idempotencyKey: "mileage-review:review-1:due:2026-08-03",
      orderNo: "ORD-1",
      reviewId: "review-1"
    });
    expect(result).toEqual({
      activatedCount: 1,
      enabled: true,
      failedNotifications: 0,
      notifiedCount: 1
    });
  });

  it("records notification failure without rolling back due activation", async () => {
    const harness = createHarness();
    harness.notificationService.notifyMileageReviewDue.mockRejectedValueOnce(
      new Error("provider unavailable")
    );

    await expect(harness.worker.runOnce(harness.asOf)).resolves.toEqual({
      activatedCount: 1,
      enabled: true,
      failedNotifications: 1,
      notifiedCount: 0
    });
    expect(harness.mileageReviewService.activateDueReviews).toHaveBeenCalledTimes(1);
  });

  it("notifies never-attempted reviews before retrying failed reviews and excludes today's successes", async () => {
    const harness = createHarness({
      events: [
        { aggregateId: "review-failed", eventStatus: "FAILED" },
        { aggregateId: "review-sent", eventStatus: "PROCESSED" }
      ],
      reviews: [review("review-fresh"), review("review-failed"), review("review-sent")]
    });

    await harness.worker.runOnce(harness.asOf);

    expect(
      harness.notificationService.notifyMileageReviewDue.mock.calls.map(([input]) => input.reviewId)
    ).toEqual(["review-fresh", "review-failed"]);
    expect(harness.prisma.notificationEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ eventType: "MILEAGE_REVIEW_DUE" })
      })
    );
  });
});

function createHarness(
  options: {
    enabled?: boolean;
    events?: Array<{ aggregateId: string; eventStatus: string }>;
    reviews?: ReturnType<typeof review>[];
  } = {}
) {
  const asOf = new Date("2026-08-02T16:30:00.000Z");
  const config = new ConfigService({
    MILEAGE_REVIEW_WORKER_ENABLED: options.enabled === false ? "false" : "true",
    MILEAGE_REVIEW_WORKER_POLL_INTERVAL_MS: "60000"
  });
  const mileageReviewService = {
    activateDueReviews: vi.fn(async () => ({ activatedCount: 1 }))
  };
  const notificationService = {
    notifyMileageReviewDue: vi.fn(
      async (input: {
        customerId: string;
        cycleNo: number;
        idempotencyKey: string;
        orderNo: string;
        reviewId: string;
      }) => {
        void input;
        return [];
      }
    )
  };
  const reviews = options.reviews ?? [review("review-1")];
  const prisma = {
    notificationEvent: {
      findMany: vi.fn(async () => options.events ?? [])
    },
    orderMileageReview: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in?: string[]; notIn?: string[] } } }) =>
        reviews.filter((item) => {
          if (where.id?.in && !where.id.in.includes(item.id)) {
            return false;
          }
          return !where.id?.notIn?.includes(item.id);
        })
      )
    }
  };
  return {
    asOf,
    mileageReviewService,
    notificationService,
    worker: new MileageReviewWorker(
      config,
      mileageReviewService as never,
      notificationService as never,
      prisma as never
    ),
    prisma
  };
}

function review(id: string) {
  return {
    cycleNo: 1,
    id,
    order: {
      customerId: id === "review-1" ? "customer-1" : `customer-${id}`,
      orderNo: id === "review-1" ? "ORD-1" : `ORD-${id}`
    },
    status: OrderMileageReviewStatus.PENDING_SUBMISSION
  };
}
