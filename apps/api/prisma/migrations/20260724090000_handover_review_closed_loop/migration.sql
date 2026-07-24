CREATE TYPE "delivery_evidence_file_lifecycle_status" AS ENUM (
  'ACTIVE',
  'SUPERSEDED',
  'REMOVED'
);

CREATE TYPE "vehicle_handover_event_type" AS ENUM (
  'WORK_ORDER_CREATED',
  'INTERNAL_OPERATOR_ASSIGNED',
  'EXTERNAL_OPERATOR_ASSIGNED',
  'EXTERNAL_ACCESS_REVOKED',
  'FIELD_STARTED',
  'FIELD_FACTS_UPDATED',
  'EVIDENCE_FILE_ADDED',
  'EVIDENCE_FILE_REPLACED',
  'EVIDENCE_FILE_REMOVED',
  'NO_VISIBLE_DAMAGE_DECLARED',
  'FIELD_SUBMITTED',
  'CUSTOMER_REVIEW_STARTED',
  'CUSTOMER_CONFIRMED',
  'CUSTOMER_OBJECTED',
  'OBJECTION_ACKNOWLEDGED',
  'RESUBMISSION_REQUESTED',
  'FIELD_RESUBMITTED',
  'SENT_BACK_TO_CUSTOMER_REVIEW',
  'CUSTOMER_SIGNED',
  'PLATFORM_SEALED',
  'FIELD_COMPLETED',
  'OPS_REVIEW_UPDATED',
  'WORK_ORDER_TERMINATED'
);

CREATE TYPE "vehicle_handover_event_actor_type" AS ENUM (
  'ADMIN',
  'FIELD_OPERATOR',
  'CUSTOMER',
  'SYSTEM'
);

ALTER TABLE "vehicle_delivery_evidence_file"
  ADD COLUMN "lifecycle_actor_id" UUID,
  ADD COLUMN "lifecycle_at" TIMESTAMPTZ(6),
  ADD COLUMN "lifecycle_status" "delivery_evidence_file_lifecycle_status" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "replaced_by_id" UUID;

ALTER TABLE "vehicle_handover_work_order"
  ADD COLUMN "admin_review_status" "vehicle_handover_admin_review_status" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "review_version" INTEGER NOT NULL DEFAULT 0;

UPDATE "vehicle_handover_work_order"
SET "admin_review_status" = CASE "metadata"->>'handoverReviewAdminStatus'
  WHEN 'ACKNOWLEDGED' THEN 'ACKNOWLEDGED'::"vehicle_handover_admin_review_status"
  WHEN 'RESUBMISSION_REQUESTED' THEN 'RESUBMISSION_REQUESTED'::"vehicle_handover_admin_review_status"
  WHEN 'RESUBMITTED_PENDING_ADMIN' THEN 'RESUBMITTED_PENDING_ADMIN'::"vehicle_handover_admin_review_status"
  WHEN 'SENT_BACK_TO_CUSTOMER_REVIEW' THEN 'SENT_BACK_TO_CUSTOMER_REVIEW'::"vehicle_handover_admin_review_status"
  WHEN 'RESOLVED' THEN 'RESOLVED'::"vehicle_handover_admin_review_status"
  WHEN 'VOIDED' THEN 'VOIDED'::"vehicle_handover_admin_review_status"
  ELSE 'NONE'::"vehicle_handover_admin_review_status"
END;

CREATE TABLE "vehicle_handover_event" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "work_order_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "review_attempt_id" UUID,
  "event_type" "vehicle_handover_event_type" NOT NULL,
  "actor_type" "vehicle_handover_event_actor_type" NOT NULL,
  "actor_id" UUID,
  "actor_display" VARCHAR(128),
  "detail" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicle_handover_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vehicle_delivery_evidence_file_replaced_by_id_key"
  ON "vehicle_delivery_evidence_file"("replaced_by_id");
CREATE INDEX "vehicle_delivery_evidence_file_lifecycle_status_idx"
  ON "vehicle_delivery_evidence_file"("lifecycle_status");
CREATE INDEX "vehicle_delivery_evidence_file_lifecycle_actor_id_idx"
  ON "vehicle_delivery_evidence_file"("lifecycle_actor_id");
CREATE INDEX "vehicle_handover_event_work_order_id_created_at_idx"
  ON "vehicle_handover_event"("work_order_id", "created_at");
CREATE INDEX "vehicle_handover_event_order_id_created_at_idx"
  ON "vehicle_handover_event"("order_id", "created_at");
CREATE INDEX "vehicle_handover_event_review_attempt_id_idx"
  ON "vehicle_handover_event"("review_attempt_id");
CREATE INDEX "vehicle_handover_event_event_type_idx"
  ON "vehicle_handover_event"("event_type");
CREATE INDEX "vehicle_handover_event_actor_id_idx"
  ON "vehicle_handover_event"("actor_id");

ALTER TABLE "vehicle_handover_event"
  ADD CONSTRAINT "vehicle_handover_event_work_order_id_fkey"
  FOREIGN KEY ("work_order_id")
  REFERENCES "vehicle_handover_work_order"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "vehicle_handover_event"
  ADD CONSTRAINT "vehicle_handover_event_order_id_fkey"
  FOREIGN KEY ("order_id")
  REFERENCES "subscription_order"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "vehicle_handover_event"
  ADD CONSTRAINT "vehicle_handover_event_review_attempt_id_fkey"
  FOREIGN KEY ("review_attempt_id")
  REFERENCES "vehicle_handover_review_attempt"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "vehicle_delivery_evidence_file"
  ADD CONSTRAINT "vehicle_delivery_evidence_file_replaced_by_id_fkey"
  FOREIGN KEY ("replaced_by_id")
  REFERENCES "vehicle_delivery_evidence_file"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
