import { Readable } from "node:stream";

import {
  MileageReviewSubmissionSource,
  OrderMileageReviewStatus,
  OrderStatus
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MileageReviewService } from "../src/mileage-review/mileage-review.service";
import { PortalMileageReviewService } from "../src/portal/portal-mileage-review.service";

describe("Portal mileage review workflow", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T04:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists and reads only reviews owned by the current customer", async () => {
    const harness = createHarness();

    const list = await harness.portalService.listReviews(harness.customer("customer-a"), {});
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ id: "review-1", orderId: "order-1" });

    await expect(
      harness.portalService.getReview("review-1", harness.customer("customer-b"))
    ).rejects.toThrow("Mileage review not found.");
  });

  it("keeps final-order history readable but makes it read-only", async () => {
    const harness = createHarness();
    harness.review.order.orderStatus = OrderStatus.COMPLETED;

    await expect(
      harness.portalService.getReview("review-1", harness.customer("customer-a"))
    ).resolves.toMatchObject({ id: "review-1" });
    await expect(
      harness.portalService.saveDraft(
        "review-1",
        {
          lockVersion: 0,
          readingAt: "2026-09-30T04:20:00.000Z",
          submittedMileageKm: 29_100
        },
        harness.customer("customer-a")
      )
    ).rejects.toThrow("Final-order mileage review history is read-only.");
  });

  it("rejects mileage regression and post-submit edits", async () => {
    const harness = createHarness();

    await expect(
      harness.portalService.saveDraft(
        "review-1",
        {
          lockVersion: 0,
          readingAt: "2026-09-30T04:20:00.000Z",
          submittedMileageKm: 28_499
        },
        harness.customer("customer-a")
      )
    ).rejects.toThrow("Submitted mileage cannot be lower");
    await expect(
      harness.portalService.saveDraft(
        "review-1",
        {
          lockVersion: 0,
          readingAt: "2099-01-01T00:00:00.000Z",
          submittedMileageKm: 29_100
        },
        harness.customer("customer-a")
      )
    ).rejects.toThrow("outside the allowed review window");
    await expect(
      harness.portalService.saveDraft(
        "review-1",
        {
          lockVersion: 0,
          readingAt: "2026-10-01T04:30:00.000Z",
          submittedMileageKm: 29_100
        },
        harness.customer("customer-a")
      )
    ).rejects.toThrow("outside the allowed review window");

    harness.review.status = OrderMileageReviewStatus.PENDING_REVIEW;
    await expect(
      harness.portalService.saveDraft(
        "review-1",
        {
          lockVersion: 0,
          readingAt: "2026-09-30T04:20:00.000Z",
          submittedMileageKm: 29_100
        },
        harness.customer("customer-a")
      )
    ).rejects.toThrow("Mileage review is not editable");
  });

  it("accepts an owned image upload and exposes only guarded Portal routes", async () => {
    const harness = createHarness();

    await expect(
      harness.portalService.uploadEvidence(
        "review-1",
        { lockVersion: 0 },
        [upload("application/pdf", "odometer.pdf")],
        harness.customer("customer-a")
      )
    ).rejects.toThrow("Mileage review evidence must be an image.");
    await expect(
      harness.portalService.uploadEvidence(
        "review-1",
        { lockVersion: 0 },
        [upload("image/svg+xml", "active.svg", Buffer.from("<svg><script/></svg>"))],
        harness.customer("customer-a")
      )
    ).rejects.toThrow("JPEG, PNG, or WebP");
    await expect(
      harness.portalService.uploadEvidence(
        "review-1",
        { lockVersion: 0 },
        [upload("image/jpeg", "spoofed.jpg", Buffer.from("<svg><script/></svg>"))],
        harness.customer("customer-a")
      )
    ).rejects.toThrow("content does not match");

    const result = await harness.portalService.uploadEvidence(
      "review-1",
      {
        capturedAt: "2026-09-30T04:19:00.000Z",
        lockVersion: 0,
        metadata: JSON.stringify({ captureMode: "camera", gps: null })
      },
      [upload("image/jpeg", "odometer.jpg")],
      harness.customer("customer-a")
    );

    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        downloadUrl: "/api/portal/mileage-reviews/review-1/evidence/evidence-1/download",
        previewUrl: "/api/portal/mileage-reviews/review-1/evidence/evidence-1/preview"
      })
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("application-materials");
    expect(serialized).not.toContain("mileage-reviews/customer-a/private.jpg");
  });

  it("requires an image, submits as Portal, and allows returned resubmission", async () => {
    const missing = createHarness();
    await missing.portalService.saveDraft(
      "review-1",
      {
        lockVersion: 0,
        readingAt: "2026-09-30T04:20:00.000Z",
        submittedMileageKm: 29_100
      },
      missing.customer("customer-a")
    );
    await expect(
      missing.portalService.submitReview(
        "review-1",
        { lockVersion: 1 },
        missing.customer("customer-a")
      )
    ).rejects.toThrow("At least one readable image evidence file is required.");

    const harness = createHarness();
    await harness.portalService.saveDraft(
      "review-1",
      {
        lockVersion: 0,
        readingAt: "2026-09-30T04:20:00.000Z",
        submittedMileageKm: 29_100
      },
      harness.customer("customer-a")
    );
    await harness.portalService.uploadEvidence(
      "review-1",
      { lockVersion: 1 },
      [upload("image/jpeg", "odometer.jpg")],
      harness.customer("customer-a")
    );
    const submitted = await harness.portalService.submitReview(
      "review-1",
      { lockVersion: 2 },
      harness.customer("customer-a")
    );
    expect(submitted).toMatchObject({
      lockVersion: 3,
      status: OrderMileageReviewStatus.PENDING_REVIEW,
      submissionSource: MileageReviewSubmissionSource.PORTAL,
      submittedByCustomerId: "customer-a",
      submittedByUserId: null
    });

    harness.review.status = OrderMileageReviewStatus.RETURNED;
    const draft = await harness.portalService.saveDraft(
      "review-1",
      {
        lockVersion: 3,
        readingAt: "2026-09-30T04:25:00.000Z",
        submittedMileageKm: 29_120
      },
      harness.customer("customer-a")
    );
    const resubmitted = await harness.portalService.submitReview(
      "review-1",
      { lockVersion: draft.lockVersion },
      harness.customer("customer-a")
    );
    expect(resubmitted).toMatchObject({
      status: OrderMileageReviewStatus.PENDING_REVIEW
    });
  });
});

function createHarness() {
  const review: Record<string, unknown> & {
    evidence: Array<Record<string, unknown>>;
    id: string;
    lockVersion: number;
    order: { customerId: string; id: string; orderNo: string; orderStatus: OrderStatus };
    status: OrderMileageReviewStatus;
  } = {
    baselineMileageKm: 28_500,
    baselineReading: { recordedAt: new Date("2026-08-31T04:30:00.000Z") },
    deletedAt: null,
    dueAt: new Date("2026-10-01T04:30:00.000Z"),
    evidence: [],
    id: "review-1",
    lockVersion: 0,
    order: {
      customerId: "customer-a",
      id: "order-1",
      orderNo: "ORD-1",
      orderStatus: OrderStatus.ACTIVE
    },
    orderId: "order-1",
    readingAt: null,
    status: OrderMileageReviewStatus.PENDING_SUBMISSION,
    submissionSource: null,
    submittedAt: null,
    submittedByCustomerId: null,
    submittedByUserId: null,
    submittedMileageKm: null,
    vehicle: { id: "vehicle-1", plateNo: "沪A12345", vehicleNo: "VEH-1" },
    vehicleId: "vehicle-1"
  };
  let evidenceSequence = 0;
  const repository = {
    attachPortalEvidence: vi.fn(
      async ({
        customerId,
        evidenceData,
        expectedLockVersion,
        fileData
      }: {
        customerId: string;
        evidenceData: Record<string, unknown>;
        expectedLockVersion: number;
        fileData: Record<string, unknown>;
      }) => {
        assertOwned(customerId, true);
        assertVersion(expectedLockVersion);
        evidenceSequence += 1;
        const file = { ...fileData, id: `file-${evidenceSequence}` };
        review.evidence.push({
          ...evidenceData,
          deletedAt: null,
          file,
          fileId: file.id,
          id: `evidence-${evidenceSequence}`
        });
        review.lockVersion += 1;
        return review;
      }
    ),
    findById: vi.fn(async () => review),
    findByIdForCustomer: vi.fn(async (id: string, customerId: string) =>
      id === review.id && review.order.customerId === customerId ? review : null
    ),
    findEvidenceForCustomer: vi.fn(),
    listForCustomer: vi.fn(async (customerId: string) => ({
      items: review.order.customerId === customerId ? [review] : [],
      total: review.order.customerId === customerId ? 1 : 0
    })),
    softDeleteEvidence: vi.fn(),
    updateReview: vi.fn(
      async ({
        customerId,
        data,
        expectedLockVersion,
        expectedStatuses,
        requireActiveOrder
      }: {
        customerId?: string;
        data: Record<string, unknown>;
        expectedLockVersion: number;
        expectedStatuses: OrderMileageReviewStatus[];
        requireActiveOrder?: boolean;
      }) => {
        if (customerId) {
          assertOwned(customerId, requireActiveOrder);
        }
        assertVersion(expectedLockVersion);
        if (!expectedStatuses.includes(review.status)) {
          throw new Error("Mileage review is not editable in its current status.");
        }
        Object.assign(review, data);
        review.lockVersion += 1;
        return review;
      }
    )
  };
  const storageService = {
    deleteObject: vi.fn(async () => undefined),
    getObject: vi.fn(async () => ({
      contentLength: 1024,
      contentType: "image/jpeg",
      stream: Readable.from(jpegBuffer())
    })),
    putMileageReviewEvidence: vi.fn(async () => ({
      bucket: "application-materials",
      objectKey: "mileage-reviews/customer-a/private.jpg",
      stored: { driver: "local", key: "private.jpg" }
    }))
  };
  const mileageReviewService = new MileageReviewService(
    {} as never,
    repository as never,
    storageService as never
  );
  const portalService = new PortalMileageReviewService(
    mileageReviewService,
    storageService as never
  );

  return {
    customer(customerId: string) {
      return {
        accountStatus: "ACTIVE",
        customerAccountId: `${customerId}-account`,
        customerId,
        phone: "13800000000"
      } as never;
    },
    mileageReviewService,
    portalService,
    repository,
    review,
    storageService
  };

  function assertOwned(customerId: string, requireActiveOrder = false) {
    if (review.order.customerId !== customerId) {
      throw new Error("Mileage review not found.");
    }
    if (requireActiveOrder && review.order.orderStatus !== OrderStatus.ACTIVE) {
      throw new Error("Final-order mileage review history is read-only.");
    }
  }

  function assertVersion(expected: number) {
    if (review.lockVersion !== expected) {
      throw new Error("Mileage review was changed by another request.");
    }
  }
}

function upload(mimetype: string, originalname: string, buffer = jpegBuffer()) {
  return { buffer, mimetype, originalname, size: buffer.length };
}

function jpegBuffer() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}
