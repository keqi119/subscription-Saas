ALTER TYPE "esign_document_type" ADD VALUE 'RETURN_MANIFEST';
ALTER TYPE "esign_signing_stage" ADD VALUE 'STAGE6_RETURN_MANIFEST';
ALTER TYPE "esign_slot_id" ADD VALUE 'RETURN_MANIFEST_CUSTOMER';
ALTER TYPE "esign_slot_id" ADD VALUE 'RETURN_MANIFEST_PLATFORM';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'CLOSURE_RETURN_MANIFEST_ESIGN';

ALTER TABLE "contract_esign_callback_log"
  ADD COLUMN "operation_key" VARCHAR(255);

CREATE UNIQUE INDEX "contract_esign_callback_log_provider_operation_key_key"
  ON "contract_esign_callback_log"("provider", "operation_key")
  WHERE "operation_key" IS NOT NULL;

CREATE UNIQUE INDEX "contract_esign_task_return_manifest_case_key"
  ON "contract_esign_task"("source_type", "source_id")
  WHERE "deleted_at" IS NULL
    AND "document_type" = 'RETURN_MANIFEST';
