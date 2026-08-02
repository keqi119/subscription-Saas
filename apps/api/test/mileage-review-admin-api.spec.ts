import { Readable } from "node:stream";

import {
  MileageReviewSubmissionSource,
  OrderMileageReviewStatus
} from "@prisma/client";
import { PermissionCode, SYSTEM_MENUS } from "@subscription-saas/shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  REQUIRED_PERMISSIONS_KEY
} from "../src/auth/auth.decorators";
import { MileageReviewController } from "../src/mileage-review/mileage-review.controller";
import { MileageReviewService } from "../src/mileage-review/mileage-review.service";

describe("admin mileage review API", () => {
  it("defines separate permissions and protects every workflow action", () => {
    expect(PermissionCode.MILEAGE_REVIEW_VIEW).toBe("mileage_review:view");
    expect(PermissionCode.MILEAGE_REVIEW_SUBMIT).toBe("mileage_review:submit");
    expect(PermissionCode.MILEAGE_REVIEW_CONFIRM).toBe("mileage_review:confirm");
    expect(PermissionCode.MILEAGE_REVIEW_RETURN).toBe("mileage_review:return");
    expect(PermissionCode.MILEAGE_REVIEW_VOID).toBe("mileage_review:void");

    expect(permissionFor("listReviews")).toEqual([PermissionCode.MILEAGE_REVIEW_VIEW]);
    expect(permissionFor("getReview")).toEqual([PermissionCode.MILEAGE_REVIEW_VIEW]);
    expect(permissionFor("saveAdminDraft")).toEqual([
      PermissionCode.MILEAGE_REVIEW_SUBMIT
    ]);
    expect(permissionFor("attachEvidence")).toEqual([
      PermissionCode.MILEAGE_REVIEW_SUBMIT
    ]);
    expect(permissionFor("submitReview")).toEqual([
      PermissionCode.MILEAGE_REVIEW_SUBMIT
    ]);
    expect(permissionFor("returnReview")).toEqual([
      PermissionCode.MILEAGE_REVIEW_RETURN
    ]);
    expect(permissionFor("confirmReview")).toEqual([
      PermissionCode.MILEAGE_REVIEW_CONFIRM
    ]);
    expect(permissionFor("voidAndReopenReview")).toEqual([
      PermissionCode.MILEAGE_REVIEW_VOID
    ]);
  });

  it("registers the queue under order center and seeds its access rows", () => {
    const orders = SYSTEM_MENUS.find((menu) => menu.code === "orders");
    expect(orders?.children).toContainEqual(
      expect.objectContaining({
        code: "orders.mileage_reviews",
        path: "/mileage-reviews",
        permissionCode: PermissionCode.MILEAGE_REVIEW_VIEW
      })
    );

    const seed = readFileSync(resolve(process.cwd(), "prisma/seed.mjs"), "utf8");
    for (const permission of [
      "mileage_review:view",
      "mileage_review:submit",
      "mileage_review:confirm",
      "mileage_review:return",
      "mileage_review:void"
    ]) {
      expect(seed).toContain(permission);
    }
    expect(seed).toContain("orders.mileage_reviews");
  });

  it("saves an admin draft with optimistic locking and source ownership", async () => {
    const harness = createHarness();

    const result = await harness.service.saveAdminDraft(
      "review-1",
      {
        lockVersion: 0,
        readingAt: "2026-09-30T04:20:00.000Z",
        submittedMileageKm: 29_100
      },
      harness.user
    );

    expect(result).toMatchObject({
      lockVersion: 1,
      readingAt: "2026-09-30T04:20:00.000Z",
      submissionSource: MileageReviewSubmissionSource.ADMIN,
      submittedByUserId: harness.user.id,
      submittedMileageKm: 29_100
    });
    await expect(
      harness.service.saveAdminDraft(
        "review-1",
        {
          lockVersion: 0,
          readingAt: "2026-09-30T04:20:00.000Z",
          submittedMileageKm: 29_200
        },
        harness.user
      )
    ).rejects.toThrow("Mileage review was changed by another request.");
  });

  it("accepts only owned, readable private images and never exposes storage keys", async () => {
    const harness = createHarness();

    await expect(
      harness.service.attachEvidence(
        "review-1",
        { fileId: "pdf-1", lockVersion: 0 },
        harness.user
      )
    ).rejects.toThrow("Mileage review evidence must be an image.");

    harness.files[0]!.uploadedBy = "user-2";
    await expect(
      harness.service.attachEvidence(
        "review-1",
        { fileId: "image-1", lockVersion: 0 },
        harness.user
      )
    ).rejects.toThrow("Evidence file is not owned by the current operator.");

    harness.files[0]!.uploadedBy = harness.user.id;
    const result = await harness.service.attachEvidence(
      "review-1",
      {
        capturedAt: "2026-09-30T04:19:00.000Z",
        fileId: "image-1",
        lockVersion: 0,
        metadata: { captureMode: "camera", gps: null }
      },
      harness.user
    );

    expect(result.lockVersion).toBe(1);
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        downloadUrl:
          "/api/mileage-reviews/review-1/evidence/evidence-1/download",
        mimeType: "image/jpeg",
        previewUrl:
          "/api/mileage-reviews/review-1/evidence/evidence-1/preview"
      })
    );
    expect(JSON.stringify(result)).not.toContain("application-materials");
    expect(JSON.stringify(result)).not.toContain("private/image-1.jpg");

    harness.storageService.getObject.mockRejectedValueOnce(
      new Error("object missing")
    );
    harness.review.lockVersion = 2;
    await expect(
      harness.service.attachEvidence(
        "review-1",
        { fileId: "image-2", lockVersion: 2 },
        harness.user
      )
    ).rejects.toThrow("Evidence file cannot be read from private storage.");
  });

  it("requires evidence before submit and supports return for correction", async () => {
    const harness = createHarness();
    await harness.service.saveAdminDraft(
      "review-1",
      {
        lockVersion: 0,
        readingAt: "2026-09-30T04:20:00.000Z",
        submittedMileageKm: 29_100
      },
      harness.user
    );

    await expect(
      harness.service.submitReview(
        "review-1",
        { lockVersion: 1 },
        harness.user
      )
    ).rejects.toThrow("At least one readable image evidence file is required.");

    await harness.service.attachEvidence(
      "review-1",
      { fileId: "image-1", lockVersion: 1 },
      harness.user
    );
    const submitted = await harness.service.submitReview(
      "review-1",
      { lockVersion: 2 },
      harness.user
    );
    expect(submitted).toMatchObject({
      lockVersion: 3,
      status: OrderMileageReviewStatus.PENDING_REVIEW,
      submissionSource: MileageReviewSubmissionSource.ADMIN,
      submittedByUserId: harness.user.id
    });

    const returned = await harness.service.returnReview(
      "review-1",
      { lockVersion: 3, reason: "仪表盘数字不清晰" },
      harness.user
    );
    expect(returned).toMatchObject({
      lockVersion: 4,
      reviewNote: "仪表盘数字不清晰",
      reviewedBy: harness.user.id,
      status: OrderMileageReviewStatus.RETURNED
    });
  });
});

function permissionFor(method: keyof MileageReviewController) {
  return Reflect.getMetadata(
    REQUIRED_PERMISSIONS_KEY,
    MileageReviewController.prototype[method]
  );
}

function createHarness() {
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: ["ADMIN"],
    username: "admin"
  };
  const files = [
    {
      bucket: "application-materials",
      id: "image-1",
      mimeType: "image/jpeg",
      objectKey: "private/image-1.jpg",
      originalName: "odometer.jpg",
      sizeBytes: 1024n,
      uploadedBy: user.id
    },
    {
      bucket: "application-materials",
      id: "image-2",
      mimeType: "image/png",
      objectKey: "private/image-2.png",
      originalName: "odometer-2.png",
      sizeBytes: 2048n,
      uploadedBy: user.id
    },
    {
      bucket: "application-materials",
      id: "pdf-1",
      mimeType: "application/pdf",
      objectKey: "private/file.pdf",
      originalName: "file.pdf",
      sizeBytes: 512n,
      uploadedBy: user.id
    }
  ];
  const review: Record<string, unknown> & {
    evidence: Array<Record<string, unknown>>;
    id: string;
    lockVersion: number;
    status: OrderMileageReviewStatus;
  } = {
    baselineMileageKm: 28_500,
    cycleNo: 1,
    deletedAt: null,
    dueAt: new Date("2026-10-01T04:30:00.000Z"),
    evidence: [],
    id: "review-1",
    lockVersion: 0,
    order: { id: "order-1", orderNo: "ORD-1" },
    orderId: "order-1",
    readingAt: null,
    reviewNote: null,
    reviewedAt: null,
    reviewedBy: null,
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
    attachEvidence: vi.fn(
      async ({ data, expectedLockVersion }: {
        data: Record<string, unknown> & { fileId: string };
        expectedLockVersion: number;
      }) => {
        assertVersion(expectedLockVersion);
        evidenceSequence += 1;
        review.evidence.push({
          ...data,
          deletedAt: null,
          file: files.find((file) => file.id === data.fileId),
          id: `evidence-${evidenceSequence}`
        });
        review.lockVersion += 1;
        return review;
      }
    ),
    findById: vi.fn(async (id: string) => (id === review.id ? review : null)),
    findFile: vi.fn(async (id: string) => files.find((file) => file.id === id) ?? null),
    list: vi.fn(async () => ({ items: [review], total: 1 })),
    softDeleteEvidence: vi.fn(),
    updateReview: vi.fn(
      async ({ data, expectedLockVersion, expectedStatuses }: {
        data: Record<string, unknown>;
        expectedLockVersion: number;
        expectedStatuses: OrderMileageReviewStatus[];
      }) => {
        assertVersion(expectedLockVersion);
        if (!expectedStatuses.includes(review.status)) {
          throw new Error("invalid status");
        }
        Object.assign(review, data);
        review.lockVersion += 1;
        return review;
      }
    )
  };
  const storageService = {
    getObject: vi.fn(async () => ({
      contentLength: 1024,
      contentType: "image/jpeg",
      stream: Readable.from(Buffer.from("image"))
    }))
  };
  const service = new MileageReviewService(
    {} as never,
    repository as never,
    storageService as never
  );

  return {
    files,
    repository,
    review,
    service,
    storageService,
    user
  };

  function assertVersion(expected: number) {
    if (review.lockVersion !== expected) {
      throw new Error("Mileage review was changed by another request.");
    }
  }
}
