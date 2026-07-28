-- CreateEnum
CREATE TYPE "vehicle_handover_workflow_job_type" AS ENUM (
  'GENERATE_SOURCE_PDF',
  'NOTIFY_FIELD_ESIGN_READY',
  'NOTIFY_CUSTOMER_ESIGN_READY',
  'RECONCILE_CUSTOMER_SIGNATURE',
  'AUTO_SEAL_PLATFORM',
  'RECONCILE_PLATFORM_SEAL',
  'ARCHIVE_SIGNED_PDF'
);

-- CreateEnum
CREATE TYPE "vehicle_handover_workflow_job_status" AS ENUM (
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'DEAD_LETTER',
  'CANCELLED'
);

-- Extend the existing SMS purpose enum for Stage 2 business notifications.
ALTER TYPE "customer_verification_code_purpose"
  ADD VALUE IF NOT EXISTS 'FIELD_HANDOVER_ESIGN_READY';
ALTER TYPE "customer_verification_code_purpose"
  ADD VALUE IF NOT EXISTS 'CUSTOMER_HANDOVER_ESIGN_READY';

-- Fail closed around Aliyun SendSms, which has no provider idempotency contract.
ALTER TYPE "sms_send_status"
  ADD VALUE IF NOT EXISTS 'SENDING';
ALTER TYPE "sms_send_status"
  ADD VALUE IF NOT EXISTS 'UNCERTAIN';

-- Extend notification contracts without replacing legacy enum values.
ALTER TYPE "notification_template_type"
  ADD VALUE IF NOT EXISTS 'HANDOVER_ESIGN_PENDING';
ALTER TYPE "notification_template_type"
  ADD VALUE IF NOT EXISTS 'HANDOVER_ESIGN_READY';
ALTER TYPE "notification_type"
  ADD VALUE IF NOT EXISTS 'HANDOVER_ESIGN_PENDING';
ALTER TYPE "notification_type"
  ADD VALUE IF NOT EXISTS 'HANDOVER_ESIGN_READY';
ALTER TYPE "notification_event_type"
  ADD VALUE IF NOT EXISTS 'HANDOVER_ESIGN_PENDING';
ALTER TYPE "notification_event_type"
  ADD VALUE IF NOT EXISTS 'HANDOVER_ESIGN_READY';

-- Add canonical operator snapshots while retaining legacy assignment fields.
ALTER TABLE "vehicle_handover_work_order"
  ADD COLUMN "field_operator_name" VARCHAR(64),
  ADD COLUMN "field_operator_phone" VARCHAR(32);

UPDATE "vehicle_handover_work_order"
SET "field_operator_name" = "external_operator_name",
    "field_operator_phone" = "external_operator_phone"
WHERE "operator_type" = 'EXTERNAL';

UPDATE "vehicle_handover_work_order" AS "work_order"
SET "field_operator_name" = "user"."name",
    "field_operator_phone" = "user"."mobile"
FROM "user"
WHERE "work_order"."operator_type" = 'INTERNAL'
  AND "work_order"."assigned_internal_user_id" = "user"."id"
  AND "user"."status" = 'ACTIVE'::"user_status"
  AND "user"."deleted_at" IS NULL;

-- CreateTable
CREATE TABLE "vehicle_handover_workflow_job" (
  "id" UUID NOT NULL,
  "work_order_id" UUID NOT NULL,
  "handover_id" UUID,
  "esign_task_id" UUID,
  "job_type" "vehicle_handover_workflow_job_type" NOT NULL,
  "job_status" "vehicle_handover_workflow_job_status" NOT NULL DEFAULT 'PENDING',
  "idempotency_key" VARCHAR(256) NOT NULL,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ(6),
  "payload" JSONB,
  "result_snapshot" JSONB,
  "last_error_code" VARCHAR(128),
  "last_error_message" VARCHAR(512),
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "vehicle_handover_workflow_job_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "sms_send_log"
  ADD COLUMN "idempotency_key" VARCHAR(256);

-- CreateIndex
CREATE INDEX "vehicle_handover_work_order_field_operator_phone_idx"
  ON "vehicle_handover_work_order"("field_operator_phone");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_handover_workflow_job_idempotency_key_key"
  ON "vehicle_handover_workflow_job"("idempotency_key");

-- CreateIndex
CREATE INDEX "vehicle_handover_workflow_job_job_status_available_at_idx"
  ON "vehicle_handover_workflow_job"("job_status", "available_at");

-- CreateIndex
CREATE INDEX "vehicle_handover_workflow_job_work_order_id_created_at_idx"
  ON "vehicle_handover_workflow_job"("work_order_id", "created_at");

-- CreateIndex
CREATE INDEX "vehicle_handover_workflow_job_lease_expires_at_idx"
  ON "vehicle_handover_workflow_job"("lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "sms_send_log_idempotency_key_key"
  ON "sms_send_log"("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "vehicle_handover_workflow_job"
  ADD CONSTRAINT "vehicle_handover_workflow_job_work_order_id_fkey"
  FOREIGN KEY ("work_order_id")
  REFERENCES "vehicle_handover_work_order"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
