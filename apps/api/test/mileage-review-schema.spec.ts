import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const apiRoot = join(__dirname, "..");
const schema = readFileSync(join(apiRoot, "prisma/schema.prisma"), "utf8");
const migrationPath = join(
  apiRoot,
  "prisma/migrations/20260802130000_monthly_mileage_reviews/migration.sql"
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

function prismaBlock(kind: "enum" | "model", name: string) {
  const match = schema.match(new RegExp(`${kind} ${name} \\{([\\s\\S]*?)\\n\\}`));
  expect(match, `missing ${kind} ${name}`).not.toBeNull();
  return match![1]!;
}

describe("monthly mileage review persistence contract", () => {
  it("defines the approved workflow and submission-source enums", () => {
    expect(prismaBlock("enum", "OrderMileageReviewStatus")).toContain("SCHEDULED");
    expect(prismaBlock("enum", "OrderMileageReviewStatus")).toContain(
      "PENDING_SUBMISSION"
    );
    expect(prismaBlock("enum", "OrderMileageReviewStatus")).toContain(
      "PENDING_REVIEW"
    );
    expect(prismaBlock("enum", "OrderMileageReviewStatus")).toContain("RETURNED");
    expect(prismaBlock("enum", "OrderMileageReviewStatus")).toContain("CONFIRMED");
    expect(prismaBlock("enum", "OrderMileageReviewStatus")).toContain("VOIDED");
    expect(prismaBlock("enum", "MileageReviewSubmissionSource")).toContain("PORTAL");
    expect(prismaBlock("enum", "MileageReviewSubmissionSource")).toContain("ADMIN");
    expect(prismaBlock("enum", "BillType")).toContain("OVER_MILEAGE");
  });

  it("persists review scheduling, submission, settlement, and audit state", () => {
    const review = prismaBlock("model", "OrderMileageReview");

    for (const field of [
      "orderId",
      "vehicleId",
      "cycleNo",
      "version",
      "periodStart",
      "periodEnd",
      "scheduledReviewAt",
      "dueAt",
      "status",
      "baselineReadingId",
      "baselineMileageKm",
      "submittedMileageKm",
      "readingAt",
      "submissionSource",
      "submittedByCustomerId",
      "submittedByUserId",
      "submittedAt",
      "reviewedBy",
      "reviewedAt",
      "reviewNote",
      "allowanceKm",
      "consumedAllowanceKm",
      "overMileageKm",
      "overMileageFeeAmount",
      "overMileageAmount",
      "mileageReadingId",
      "entitlementGrantId",
      "entitlementUsageId",
      "overMileageBillId",
      "voidedBy",
      "voidedAt",
      "voidReason",
      "calculationSnapshot",
      "lockVersion",
      "deletedAt"
    ]) {
      expect(review, `missing review field ${field}`).toContain(field);
    }

    expect(review).toContain("lockVersion");
    expect(review).toContain("@default(0)");
    expect(review).toContain("@@unique([orderId, cycleNo, version])");
    expect(review).toContain("mileageReadingId");
    expect(review).toContain("@unique");
    expect(review).toContain("entitlementUsageId");
    expect(review).toContain("overMileageBillId");
  });

  it("persists soft-deletable private-file evidence and source ownership", () => {
    const evidence = prismaBlock("model", "OrderMileageReviewEvidence");

    expect(evidence).toContain("reviewId");
    expect(evidence).toContain("fileId");
    expect(evidence).toContain("submissionSource");
    expect(evidence).toContain("uploadedByCustomerId");
    expect(evidence).toContain("uploadedByUserId");
    expect(evidence).toContain("capturedAt");
    expect(evidence).toContain("metadata");
    expect(evidence).toContain("deletedAt");
    expect(evidence).toContain("@@index([reviewId, deletedAt])");
    expect(evidence).toContain("@@index([fileId])");
    expect(evidence).toContain("@@index([submissionSource])");
  });

  it("connects review records to every owning aggregate", () => {
    expect(prismaBlock("model", "SubscriptionOrder")).toContain("mileageReviews");
    expect(prismaBlock("model", "Vehicle")).toContain("mileageReviews");
    expect(prismaBlock("model", "VehicleMileageReading")).toContain(
      "baselineForMileageReviews"
    );
    expect(prismaBlock("model", "VehicleMileageReading")).toContain("mileageReview");
    expect(prismaBlock("model", "OrderEntitlementGrant")).toContain("mileageReviews");
    expect(prismaBlock("model", "OrderEntitlementUsage")).toContain("mileageReview");
    expect(prismaBlock("model", "ReceivableBill")).toContain("mileageReview");
    expect(prismaBlock("model", "FileObject")).toContain("mileageReviewEvidence");
    expect(prismaBlock("model", "Customer")).toContain("submittedMileageReviews");
    expect(prismaBlock("model", "Customer")).toContain("mileageReviewEvidence");
    expect(prismaBlock("model", "User")).toContain("submittedMileageReviews");
    expect(prismaBlock("model", "User")).toContain("reviewedMileageReviews");
    expect(prismaBlock("model", "User")).toContain("voidedMileageReviews");
    expect(prismaBlock("model", "User")).toContain("mileageReviewEvidence");
  });

  it("enforces one active version and one active file link at the database layer", () => {
    expect(migration).not.toBe("");
    expect(migration).toContain('ALTER TYPE "bill_type" ADD VALUE \'OVER_MILEAGE\'');
    expect(migration).toContain('CREATE TABLE "order_mileage_review"');
    expect(migration).toContain('CREATE TABLE "order_mileage_review_evidence"');
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "order_mileage_review_active_cycle_key"[\s\S]+WHERE "status" <> 'VOIDED' AND "deleted_at" IS NULL/
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "order_mileage_review_evidence_active_file_key"[\s\S]+WHERE "deleted_at" IS NULL/
    );
    expect(migration).toContain(
      '"period_start" TIMESTAMPTZ(6) NOT NULL'
    );
    expect(migration).toContain('"over_mileage_amount" BIGINT');
    expect(migration).toContain('"metadata" JSONB');
    expect(migration).toContain(
      'REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE'
    );
  });
});
