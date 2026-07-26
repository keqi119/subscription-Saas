-- CreateEnum
CREATE TYPE "esign_signing_stage" AS ENUM (
  'STAGE1_SUBSCRIPTION_CONTRACT',
  'STAGE2_DELIVERY_HANDOVER'
);

-- CreateEnum
CREATE TYPE "esign_document_type" AS ENUM (
  'SUBSCRIPTION_CONTRACT',
  'CONTRACT_BODY',
  'ATTACHMENT1_SUBSCRIPTION_PLAN',
  'DELIVERY_HANDOVER'
);

-- CreateEnum
CREATE TYPE "esign_slot_id" AS ENUM (
  'STAGE1_BODY_CUSTOMER',
  'STAGE1_BODY_PLATFORM',
  'STAGE1_ATTACHMENT1_CUSTOMER',
  'STAGE1_ATTACHMENT1_PLATFORM',
  'STAGE2_HANDOVER_CUSTOMER',
  'STAGE2_HANDOVER_PLATFORM'
);

-- CreateEnum
CREATE TYPE "esign_provider_action_type" AS ENUM (
  'CUSTOMER_MANUAL_SIGN',
  'PLATFORM_AUTO_SEAL'
);

-- AlterTable
ALTER TABLE "contract_esign_task"
  ADD COLUMN "signing_stage" "esign_signing_stage" DEFAULT 'STAGE1_SUBSCRIPTION_CONTRACT',
  ADD COLUMN "document_type" "esign_document_type" DEFAULT 'SUBSCRIPTION_CONTRACT';

-- Backfill existing Stage 1 tasks before enforcing required typed fields.
UPDATE "contract_esign_task"
SET "signing_stage" = 'STAGE1_SUBSCRIPTION_CONTRACT',
    "document_type" = 'SUBSCRIPTION_CONTRACT';

-- AlterTable
ALTER TABLE "contract_esign_task"
  ALTER COLUMN "signing_stage" SET NOT NULL,
  ALTER COLUMN "document_type" SET NOT NULL;

-- AlterTable
ALTER TABLE "contract_esign_signer"
  ADD COLUMN "slot_id" "esign_slot_id",
  ADD COLUMN "document_type" "esign_document_type",
  ADD COLUMN "provider_action_type" "esign_provider_action_type",
  ADD COLUMN "required" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "provider_transaction_id" VARCHAR(32),
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_attempt_at" TIMESTAMPTZ(6),
  ADD COLUMN "next_retry_at" TIMESTAMPTZ(6),
  ADD COLUMN "last_error_code" VARCHAR(128),
  ADD COLUMN "last_error_message" TEXT,
  ADD COLUMN "claim_expires_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "contract_esign_callback_log"
  ADD COLUMN "provider_transaction_id" VARCHAR(32),
  ADD COLUMN "payload_hash" CHAR(64);

-- AlterTable
ALTER TABLE "vehicle_delivery_handover"
  ADD COLUMN "source_pdf_hash" CHAR(64),
  ADD COLUMN "signed_pdf_hash" CHAR(64),
  ADD COLUMN "manifest_hash" CHAR(64),
  ADD COLUMN "artifact_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "archive_retry_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "archive_last_attempt_at" TIMESTAMPTZ(6),
  ADD COLUMN "archive_last_error" TEXT;

-- CreateIndex
CREATE INDEX "contract_esign_task_signing_stage_task_status_idx"
  ON "contract_esign_task"("signing_stage", "task_status");

-- CreateIndex
CREATE INDEX "contract_esign_signer_provider_transaction_id_idx"
  ON "contract_esign_signer"("provider_transaction_id");

-- Stage 1 deliberately allows one provider action to cover both the contract
-- body and Attachment 1. Stage 2 keeps one transaction per typed signer.
CREATE UNIQUE INDEX "contract_esign_signer_stage2_provider_transaction_id_key"
  ON "contract_esign_signer"("provider_transaction_id")
  WHERE "provider_transaction_id" IS NOT NULL
    AND "deleted_at" IS NULL
    AND "slot_id" IN ('STAGE2_HANDOVER_CUSTOMER', 'STAGE2_HANDOVER_PLATFORM');

-- CreateIndex
CREATE UNIQUE INDEX "contract_esign_signer_task_id_slot_id_key"
  ON "contract_esign_signer"("task_id", "slot_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_esign_callback_log_provider_payload_hash_key"
  ON "contract_esign_callback_log"("provider", "payload_hash");
