CREATE TYPE "vehicle_condition_wear_classification" AS ENUM (
  'NORMAL_WEAR', 'NEW_DAMAGE', 'MISSING', 'IMPROVED', 'UNCHANGED', 'MANUAL_REVIEW'
);
CREATE TYPE "vehicle_condition_responsibility" AS ENUM (
  'CUSTOMER', 'PLATFORM', 'THIRD_PARTY', 'NORMAL_WEAR', 'UNDETERMINED'
);

ALTER TABLE "subscription_closure_case" ADD COLUMN "current_delta_revision_id" UUID;

CREATE TABLE "vehicle_condition_delta_revision" (
  "id" UUID NOT NULL,
  "closure_case_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL,
  "delivery_document_revision_id" UUID NOT NULL,
  "delivery_document_hash" VARCHAR(64) NOT NULL,
  "return_checklist_revision_id" UUID NOT NULL,
  "return_manifest_hash" VARCHAR(64) NOT NULL,
  "result_hash" VARCHAR(64) NOT NULL,
  "source_type" VARCHAR(64) NOT NULL,
  "source_id" UUID NOT NULL,
  "source_key" VARCHAR(255) NOT NULL,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersedes_revision_id" UUID,
  CONSTRAINT "vehicle_condition_delta_revision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vehicle_condition_delta_revision_case_revision_key" UNIQUE ("closure_case_id", "revision_number"),
  CONSTRAINT "vehicle_condition_delta_revision_source_key" UNIQUE ("source_type", "source_id", "source_key"),
  CONSTRAINT "vehicle_condition_delta_revision_supersedes_key" UNIQUE ("supersedes_revision_id"),
  CONSTRAINT "vehicle_condition_delta_revision_hash_check" CHECK (
    "delivery_document_hash" ~ '^[0-9a-f]{64}$' AND "return_manifest_hash" ~ '^[0-9a-f]{64}$' AND "result_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "vehicle_condition_delta_item" (
  "id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "item_code" VARCHAR(64) NOT NULL,
  "delivery_state" VARCHAR(64) NOT NULL,
  "return_state" VARCHAR(64) NOT NULL,
  "quantity_difference" INTEGER NOT NULL DEFAULT 0,
  "wear_classification" "vehicle_condition_wear_classification" NOT NULL,
  "responsibility" "vehicle_condition_responsibility" NOT NULL,
  "evidence_snapshot" JSONB NOT NULL,
  "decision_reason" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicle_condition_delta_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vehicle_condition_delta_item_revision_code_key" UNIQUE ("revision_id", "item_code")
);

ALTER TABLE "vehicle_condition_delta_revision"
  ADD CONSTRAINT "vehicle_condition_delta_revision_case_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_condition_delta_revision_delivery_fkey" FOREIGN KEY ("delivery_document_revision_id") REFERENCES "vehicle_delivery_handover"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_condition_delta_revision_checklist_fkey" FOREIGN KEY ("return_checklist_revision_id") REFERENCES "vehicle_return_checklist_revision"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_condition_delta_revision_actor_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_condition_delta_revision_supersedes_fkey" FOREIGN KEY ("supersedes_revision_id") REFERENCES "vehicle_condition_delta_revision"("id") ON DELETE RESTRICT;
ALTER TABLE "vehicle_condition_delta_item"
  ADD CONSTRAINT "vehicle_condition_delta_item_revision_fkey" FOREIGN KEY ("revision_id") REFERENCES "vehicle_condition_delta_revision"("id") ON DELETE RESTRICT;
ALTER TABLE "subscription_closure_case"
  ADD CONSTRAINT "subscription_closure_case_current_delta_revision_fkey" FOREIGN KEY ("current_delta_revision_id") REFERENCES "vehicle_condition_delta_revision"("id") ON DELETE RESTRICT;

CREATE INDEX "vehicle_condition_delta_revision_case_idx" ON "vehicle_condition_delta_revision"("closure_case_id", "created_at");

CREATE TRIGGER "vehicle_condition_delta_revision_append_only"
  BEFORE UPDATE OR DELETE ON "vehicle_condition_delta_revision"
  FOR EACH ROW EXECUTE FUNCTION "stage1_return_append_only_guard"();
CREATE TRIGGER "vehicle_condition_delta_item_append_only"
  BEFORE UPDATE OR DELETE ON "vehicle_condition_delta_item"
  FOR EACH ROW EXECUTE FUNCTION "stage1_return_append_only_guard"();
