-- CreateEnum
CREATE TYPE "vehicle_handover_review_attempt_status" AS ENUM (
  'CUSTOMER_REVIEWING',
  'CUSTOMER_CONFIRMED',
  'CUSTOMER_OBJECTED',
  'RESUBMISSION_REQUESTED',
  'RESUBMITTED_PENDING_ADMIN',
  'SENT_BACK_TO_CUSTOMER_REVIEW',
  'VOIDED'
);

-- CreateEnum
CREATE TYPE "vehicle_handover_admin_review_status" AS ENUM (
  'NONE',
  'ACKNOWLEDGED',
  'RESUBMISSION_REQUESTED',
  'RESUBMITTED_PENDING_ADMIN',
  'SENT_BACK_TO_CUSTOMER_REVIEW',
  'RESOLVED',
  'VOIDED'
);

-- CreateTable
CREATE TABLE "vehicle_handover_review_attempt" (
    "id" UUID NOT NULL,
    "work_order_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "handover_id" UUID,
    "attempt_no" INTEGER NOT NULL,
    "status" "vehicle_handover_review_attempt_status" NOT NULL DEFAULT 'CUSTOMER_REVIEWING',
    "field_facts_snapshot" JSONB,
    "evidence_snapshot" JSONB,
    "field_submitted_at" TIMESTAMPTZ(6),
    "customer_review_started_at" TIMESTAMPTZ(6),
    "customer_confirmed_at" TIMESTAMPTZ(6),
    "customer_objected_at" TIMESTAMPTZ(6),
    "customer_objection_reason" TEXT,
    "customer_objection_details" TEXT,
    "admin_status" "vehicle_handover_admin_review_status",
    "admin_acknowledged_at" TIMESTAMPTZ(6),
    "admin_acknowledged_by_id" UUID,
    "resubmission_requested_at" TIMESTAMPTZ(6),
    "resubmission_requested_by_id" UUID,
    "sent_back_to_customer_review_at" TIMESTAMPTZ(6),
    "sent_back_to_customer_review_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_id" UUID,
    "admin_notes" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicle_handover_review_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_handover_review_attempt_work_order_id_attempt_no_key"
  ON "vehicle_handover_review_attempt"("work_order_id", "attempt_no");

-- CreateIndex
CREATE INDEX "vehicle_handover_review_attempt_order_id_idx" ON "vehicle_handover_review_attempt"("order_id");

-- CreateIndex
CREATE INDEX "vehicle_handover_review_attempt_handover_id_idx" ON "vehicle_handover_review_attempt"("handover_id");

-- CreateIndex
CREATE INDEX "vehicle_handover_review_attempt_status_idx" ON "vehicle_handover_review_attempt"("status");

-- CreateIndex
CREATE INDEX "vehicle_handover_review_attempt_customer_objected_at_idx"
  ON "vehicle_handover_review_attempt"("customer_objected_at");

-- CreateIndex
CREATE INDEX "vehicle_handover_review_attempt_admin_status_idx"
  ON "vehicle_handover_review_attempt"("admin_status");

-- CreateIndex
CREATE INDEX "vehicle_handover_review_attempt_admin_acknowledged_by_id_idx"
  ON "vehicle_handover_review_attempt"("admin_acknowledged_by_id");

-- CreateIndex
CREATE INDEX "vehicle_handover_review_attempt_resubmission_requested_by_id_idx"
  ON "vehicle_handover_review_attempt"("resubmission_requested_by_id");

-- CreateIndex
CREATE INDEX "vehicle_handover_review_attempt_sent_back_to_customer_review_by_id_idx"
  ON "vehicle_handover_review_attempt"("sent_back_to_customer_review_by_id");

-- CreateIndex
CREATE INDEX "vehicle_handover_review_attempt_resolved_by_id_idx"
  ON "vehicle_handover_review_attempt"("resolved_by_id");

-- AddForeignKey
ALTER TABLE "vehicle_handover_review_attempt"
  ADD CONSTRAINT "vehicle_handover_review_attempt_work_order_id_fkey"
  FOREIGN KEY ("work_order_id")
  REFERENCES "vehicle_handover_work_order"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_handover_review_attempt"
  ADD CONSTRAINT "vehicle_handover_review_attempt_order_id_fkey"
  FOREIGN KEY ("order_id")
  REFERENCES "subscription_order"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_handover_review_attempt"
  ADD CONSTRAINT "vehicle_handover_review_attempt_handover_id_fkey"
  FOREIGN KEY ("handover_id")
  REFERENCES "vehicle_delivery_handover"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_handover_review_attempt"
  ADD CONSTRAINT "vehicle_handover_review_attempt_admin_acknowledged_by_id_fkey"
  FOREIGN KEY ("admin_acknowledged_by_id")
  REFERENCES "user"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_handover_review_attempt"
  ADD CONSTRAINT "vehicle_handover_review_attempt_resubmission_requested_by_id_fkey"
  FOREIGN KEY ("resubmission_requested_by_id")
  REFERENCES "user"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_handover_review_attempt"
  ADD CONSTRAINT "vehicle_handover_review_attempt_sent_back_to_customer_review_by_id_fkey"
  FOREIGN KEY ("sent_back_to_customer_review_by_id")
  REFERENCES "user"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_handover_review_attempt"
  ADD CONSTRAINT "vehicle_handover_review_attempt_resolved_by_id_fkey"
  FOREIGN KEY ("resolved_by_id")
  REFERENCES "user"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
