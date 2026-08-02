-- ExtendEnum
ALTER TYPE "bill_type" ADD VALUE 'OVER_MILEAGE';

-- CreateEnum
CREATE TYPE "order_mileage_review_status" AS ENUM (
  'SCHEDULED',
  'PENDING_SUBMISSION',
  'PENDING_REVIEW',
  'RETURNED',
  'CONFIRMED',
  'VOIDED'
);

-- CreateEnum
CREATE TYPE "mileage_review_submission_source" AS ENUM ('PORTAL', 'ADMIN');

-- CreateTable
CREATE TABLE "order_mileage_review" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "vehicle_id" UUID NOT NULL,
  "cycle_no" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "period_start" TIMESTAMPTZ(6) NOT NULL,
  "period_end" TIMESTAMPTZ(6) NOT NULL,
  "scheduled_review_at" TIMESTAMPTZ(6) NOT NULL,
  "due_at" TIMESTAMPTZ(6) NOT NULL,
  "status" "order_mileage_review_status" NOT NULL DEFAULT 'SCHEDULED',
  "baseline_reading_id" UUID NOT NULL,
  "baseline_mileage_km" INTEGER NOT NULL,
  "submitted_mileage_km" INTEGER,
  "reading_at" TIMESTAMPTZ(6),
  "submission_source" "mileage_review_submission_source",
  "submitted_by_customer_id" UUID,
  "submitted_by_user_id" UUID,
  "submitted_at" TIMESTAMPTZ(6),
  "reviewed_by" UUID,
  "reviewed_at" TIMESTAMPTZ(6),
  "review_note" TEXT,
  "allowance_km" INTEGER,
  "consumed_allowance_km" INTEGER,
  "over_mileage_km" INTEGER,
  "over_mileage_fee_amount" BIGINT,
  "over_mileage_amount" BIGINT,
  "mileage_reading_id" UUID,
  "entitlement_grant_id" UUID,
  "entitlement_usage_id" UUID,
  "over_mileage_bill_id" UUID,
  "voided_by" UUID,
  "voided_at" TIMESTAMPTZ(6),
  "void_reason" TEXT,
  "calculation_snapshot" JSONB,
  "lock_version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID,
  "updated_by" UUID,
  "deleted_at" TIMESTAMPTZ(6),

  CONSTRAINT "order_mileage_review_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_mileage_review_cycle_positive" CHECK ("cycle_no" > 0),
  CONSTRAINT "order_mileage_review_version_positive" CHECK ("version" > 0),
  CONSTRAINT "order_mileage_review_period_valid" CHECK (
    "period_end" > "period_start" AND
    "scheduled_review_at" >= "period_end" AND
    "due_at" > "scheduled_review_at"
  ),
  CONSTRAINT "order_mileage_review_mileage_nonnegative" CHECK (
    "baseline_mileage_km" >= 0 AND
    ("submitted_mileage_km" IS NULL OR "submitted_mileage_km" >= 0) AND
    ("allowance_km" IS NULL OR "allowance_km" >= 0) AND
    ("consumed_allowance_km" IS NULL OR "consumed_allowance_km" >= 0) AND
    ("over_mileage_km" IS NULL OR "over_mileage_km" >= 0) AND
    ("over_mileage_fee_amount" IS NULL OR "over_mileage_fee_amount" >= 0) AND
    ("over_mileage_amount" IS NULL OR "over_mileage_amount" >= 0)
  ),
  CONSTRAINT "order_mileage_review_submission_actor" CHECK (
    ("submission_source" IS NULL AND "submitted_by_customer_id" IS NULL AND "submitted_by_user_id" IS NULL) OR
    ("submission_source" = 'PORTAL' AND "submitted_by_customer_id" IS NOT NULL AND "submitted_by_user_id" IS NULL) OR
    ("submission_source" = 'ADMIN' AND "submitted_by_user_id" IS NOT NULL AND "submitted_by_customer_id" IS NULL)
  ),
  CONSTRAINT "order_mileage_review_submission_state" CHECK (
    "status" IN ('SCHEDULED', 'PENDING_SUBMISSION') OR
    (
      "submitted_mileage_km" IS NOT NULL AND
      "submitted_mileage_km" >= "baseline_mileage_km" AND
      "reading_at" IS NOT NULL AND
      "submission_source" IS NOT NULL AND
      "submitted_at" IS NOT NULL
    )
  ),
  CONSTRAINT "order_mileage_review_confirmed_state" CHECK (
    "status" <> 'CONFIRMED' OR
    (
      "reviewed_by" IS NOT NULL AND
      "reviewed_at" IS NOT NULL AND
      "allowance_km" IS NOT NULL AND
      "consumed_allowance_km" IS NOT NULL AND
      "over_mileage_km" IS NOT NULL AND
      "over_mileage_fee_amount" IS NOT NULL AND
      "over_mileage_amount" IS NOT NULL AND
      "mileage_reading_id" IS NOT NULL AND
      "entitlement_grant_id" IS NOT NULL AND
      "entitlement_usage_id" IS NOT NULL AND
      "calculation_snapshot" IS NOT NULL AND
      (
        ("over_mileage_km" > 0 AND "over_mileage_bill_id" IS NOT NULL) OR
        ("over_mileage_km" = 0 AND "over_mileage_bill_id" IS NULL)
      )
    )
  ),
  CONSTRAINT "order_mileage_review_void_state" CHECK (
    ("status" = 'VOIDED' AND "voided_by" IS NOT NULL AND "voided_at" IS NOT NULL AND "void_reason" IS NOT NULL) OR
    ("status" <> 'VOIDED' AND "voided_by" IS NULL AND "voided_at" IS NULL AND "void_reason" IS NULL)
  )
);

-- CreateTable
CREATE TABLE "order_mileage_review_evidence" (
  "id" UUID NOT NULL,
  "review_id" UUID NOT NULL,
  "file_id" UUID NOT NULL,
  "submission_source" "mileage_review_submission_source" NOT NULL,
  "uploaded_by_customer_id" UUID,
  "uploaded_by_user_id" UUID,
  "captured_at" TIMESTAMPTZ(6),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID,
  "updated_by" UUID,
  "deleted_at" TIMESTAMPTZ(6),

  CONSTRAINT "order_mileage_review_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_mileage_review_evidence_actor" CHECK (
    ("submission_source" = 'PORTAL' AND "uploaded_by_customer_id" IS NOT NULL AND "uploaded_by_user_id" IS NULL) OR
    ("submission_source" = 'ADMIN' AND "uploaded_by_user_id" IS NOT NULL AND "uploaded_by_customer_id" IS NULL)
  )
);

-- CreateIndex
CREATE UNIQUE INDEX "order_mileage_review_order_id_cycle_no_version_key"
  ON "order_mileage_review"("order_id", "cycle_no", "version");
CREATE UNIQUE INDEX "order_mileage_review_active_cycle_key"
  ON "order_mileage_review"("order_id", "cycle_no")
  WHERE "status" <> 'VOIDED' AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "order_mileage_review_mileage_reading_id_key"
  ON "order_mileage_review"("mileage_reading_id");
CREATE UNIQUE INDEX "order_mileage_review_entitlement_usage_id_key"
  ON "order_mileage_review"("entitlement_usage_id");
CREATE UNIQUE INDEX "order_mileage_review_over_mileage_bill_id_key"
  ON "order_mileage_review"("over_mileage_bill_id");
CREATE INDEX "order_mileage_review_order_id_status_scheduled_review_at_idx"
  ON "order_mileage_review"("order_id", "status", "scheduled_review_at");
CREATE INDEX "order_mileage_review_vehicle_id_status_scheduled_review_at_idx"
  ON "order_mileage_review"("vehicle_id", "status", "scheduled_review_at");
CREATE INDEX "order_mileage_review_baseline_reading_id_idx"
  ON "order_mileage_review"("baseline_reading_id");
CREATE INDEX "order_mileage_review_submitted_by_customer_id_idx"
  ON "order_mileage_review"("submitted_by_customer_id");
CREATE INDEX "order_mileage_review_submitted_by_user_id_idx"
  ON "order_mileage_review"("submitted_by_user_id");
CREATE INDEX "order_mileage_review_reviewed_by_idx"
  ON "order_mileage_review"("reviewed_by");
CREATE INDEX "order_mileage_review_entitlement_grant_id_idx"
  ON "order_mileage_review"("entitlement_grant_id");
CREATE INDEX "order_mileage_review_voided_by_idx"
  ON "order_mileage_review"("voided_by");
CREATE INDEX "order_mileage_review_status_due_at_idx"
  ON "order_mileage_review"("status", "due_at");

CREATE UNIQUE INDEX "order_mileage_review_evidence_active_file_key"
  ON "order_mileage_review_evidence"("review_id", "file_id")
  WHERE "deleted_at" IS NULL;
CREATE INDEX "order_mileage_review_evidence_review_id_deleted_at_idx"
  ON "order_mileage_review_evidence"("review_id", "deleted_at");
CREATE INDEX "order_mileage_review_evidence_file_id_idx"
  ON "order_mileage_review_evidence"("file_id");
CREATE INDEX "order_mileage_review_evidence_submission_source_idx"
  ON "order_mileage_review_evidence"("submission_source");
CREATE INDEX "order_mileage_review_evidence_uploaded_by_customer_id_idx"
  ON "order_mileage_review_evidence"("uploaded_by_customer_id");
CREATE INDEX "order_mileage_review_evidence_uploaded_by_user_id_idx"
  ON "order_mileage_review_evidence"("uploaded_by_user_id");

-- AddForeignKey
ALTER TABLE "order_mileage_review"
  ADD CONSTRAINT "order_mileage_review_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_mileage_review"
  ADD CONSTRAINT "order_mileage_review_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_mileage_review"
  ADD CONSTRAINT "order_mileage_review_baseline_reading_id_fkey"
  FOREIGN KEY ("baseline_reading_id") REFERENCES "vehicle_mileage_reading"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_mileage_review"
  ADD CONSTRAINT "order_mileage_review_submitted_by_customer_id_fkey"
  FOREIGN KEY ("submitted_by_customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_mileage_review"
  ADD CONSTRAINT "order_mileage_review_submitted_by_user_id_fkey"
  FOREIGN KEY ("submitted_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_mileage_review"
  ADD CONSTRAINT "order_mileage_review_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_mileage_review"
  ADD CONSTRAINT "order_mileage_review_mileage_reading_id_fkey"
  FOREIGN KEY ("mileage_reading_id") REFERENCES "vehicle_mileage_reading"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_mileage_review"
  ADD CONSTRAINT "order_mileage_review_entitlement_grant_id_fkey"
  FOREIGN KEY ("entitlement_grant_id") REFERENCES "order_entitlement_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_mileage_review"
  ADD CONSTRAINT "order_mileage_review_entitlement_usage_id_fkey"
  FOREIGN KEY ("entitlement_usage_id") REFERENCES "order_entitlement_usage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_mileage_review"
  ADD CONSTRAINT "order_mileage_review_over_mileage_bill_id_fkey"
  FOREIGN KEY ("over_mileage_bill_id") REFERENCES "receivable_bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_mileage_review"
  ADD CONSTRAINT "order_mileage_review_voided_by_fkey"
  FOREIGN KEY ("voided_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_mileage_review_evidence"
  ADD CONSTRAINT "order_mileage_review_evidence_review_id_fkey"
  FOREIGN KEY ("review_id") REFERENCES "order_mileage_review"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_mileage_review_evidence"
  ADD CONSTRAINT "order_mileage_review_evidence_file_id_fkey"
  FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_mileage_review_evidence"
  ADD CONSTRAINT "order_mileage_review_evidence_uploaded_by_customer_id_fkey"
  FOREIGN KEY ("uploaded_by_customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_mileage_review_evidence"
  ADD CONSTRAINT "order_mileage_review_evidence_uploaded_by_user_id_fkey"
  FOREIGN KEY ("uploaded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
