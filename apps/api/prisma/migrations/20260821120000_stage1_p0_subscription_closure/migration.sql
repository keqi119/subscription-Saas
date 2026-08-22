-- Stage 1 P0 subscription closure, immutable documents, settlement revisions, and command receipts.
ALTER TYPE "order_status" ADD VALUE 'RETURNED_PENDING_SETTLEMENT' AFTER 'PENDING_RETURN';
ALTER TYPE "contract_status" ADD VALUE 'COMPLETED' AFTER 'ARCHIVED';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'CLOSURE_RECOVERY_ASSESSMENT_D7';

CREATE TYPE "subscription_closure_type" AS ENUM ('NORMAL_COMPLETION', 'EARLY_TERMINATION');
CREATE TYPE "subscription_closure_physical_control_mode" AS ENUM ('VOLUNTARY_RETURN', 'RECOVERY');
CREATE TYPE "subscription_closure_final_disposition" AS ENUM ('COMPLETE', 'TERMINATE');
CREATE TYPE "subscription_closure_status" AS ENUM (
    'PREPARING_RETURN',
    'RECOVERY_ASSESSMENT_PENDING',
    'RECOVERY_APPROVAL_PENDING',
    'RECOVERY_APPROVED',
    'RECOVERY_IN_PROGRESS',
    'VEHICLE_SECURED',
    'RETURN_INSPECTION',
    'RECONDITIONING',
    'PENDING_SETTLEMENT',
    'COMPLETED',
    'TERMINATED',
    'REJECTED',
    'PAUSED',
    'CANCELLED',
    'MANUAL_TAKEOVER'
);
CREATE TYPE "subscription_closure_event_type" AS ENUM (
    'CASE_CREATED',
    'STATUS_TRANSITIONED',
    'RECOVERY_ESCALATED',
    'DOCUMENT_REVISION_CREATED',
    'SETTLEMENT_REVISION_CREATED',
    'PHYSICAL_CONTROL_CONFIRMED',
    'INSPECTION_RECORDED',
    'INVENTORY_RELEASED',
    'NOTE_ADDED'
);
CREATE TYPE "subscription_closure_document_type" AS ENUM ('RETURN_MANIFEST', 'EARLY_TERMINATION_AGREEMENT', 'RECOVERY_AUTHORITY');
CREATE TYPE "subscription_closure_document_stage" AS ENUM ('GENERATED', 'SIGNED', 'ARCHIVED');
CREATE TYPE "subscription_closure_settlement_type" AS ENUM ('ESTIMATE', 'FINAL');
CREATE TYPE "subscription_closure_settlement_stage" AS ENUM ('PROPOSED', 'FINALIZED', 'SETTLED');
CREATE TYPE "subscription_closure_command_type" AS ENUM (
    'CREATE_CASE',
    'PREPARE_RETURN',
    'CREATE_DOCUMENT_REVISION',
    'TRANSITION_CASE',
    'ESCALATE_RECOVERY',
    'CONFIRM_PHYSICAL_CONTROL',
    'RECORD_INSPECTION',
    'CREATE_SETTLEMENT_REVISION',
    'COMPLETE_CLOSURE'
);

CREATE TABLE "subscription_closure_case" (
    "id" UUID NOT NULL,
    "case_no" VARCHAR(64) NOT NULL,
    "order_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "vehicle_return_id" UUID,
    "return_handover_work_order_id" UUID,
    "return_asset_work_order_id" UUID,
    "recovery_asset_work_order_id" UUID,
    "reconditioning_asset_work_order_id" UUID,
    "closure_type" "subscription_closure_type" NOT NULL,
    "physical_control_mode" "subscription_closure_physical_control_mode" NOT NULL,
    "final_disposition" "subscription_closure_final_disposition" NOT NULL,
    "status" "subscription_closure_status" NOT NULL,
    "authority_snapshot" JSONB NOT NULL,
    "authority_snapshot_hash" VARCHAR(64) NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "physical_controlled_at" TIMESTAMPTZ(6),
    "settled_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "current_document_revision_id" UUID,
    "current_settlement_revision_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "create_source_type" VARCHAR(64) NOT NULL,
    "create_source_id" UUID NOT NULL,
    "create_source_key" VARCHAR(255) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscription_closure_case_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_closure_case_intent_shape_chk" CHECK (
        ("closure_type" = 'NORMAL_COMPLETION' AND (
            ("physical_control_mode" = 'VOLUNTARY_RETURN' AND "final_disposition" = 'COMPLETE')
            OR ("physical_control_mode" = 'RECOVERY' AND "final_disposition" = 'TERMINATE')
        ))
        OR ("closure_type" = 'EARLY_TERMINATION' AND "final_disposition" = 'TERMINATE')
    ),
    CONSTRAINT "subscription_closure_case_recovery_status_shape_chk" CHECK (
        "physical_control_mode" = 'RECOVERY'
        OR "status" NOT IN (
            'RECOVERY_ASSESSMENT_PENDING', 'RECOVERY_APPROVAL_PENDING', 'RECOVERY_APPROVED',
            'RECOVERY_IN_PROGRESS', 'VEHICLE_SECURED'
        )
    ),
    CONSTRAINT "subscription_closure_case_terminal_shape_chk" CHECK (
        ("status" = 'COMPLETED' AND "final_disposition" = 'COMPLETE' AND "settled_at" IS NOT NULL AND "closed_at" IS NOT NULL)
        OR ("status" = 'TERMINATED' AND "final_disposition" = 'TERMINATE' AND "settled_at" IS NOT NULL AND "closed_at" IS NOT NULL)
        OR ("status" IN ('REJECTED', 'CANCELLED') AND "closed_at" IS NOT NULL)
        OR ("status" NOT IN ('COMPLETED', 'TERMINATED', 'REJECTED', 'CANCELLED') AND "closed_at" IS NULL)
    ),
    CONSTRAINT "subscription_closure_case_physical_control_shape_chk" CHECK (
        ("status" IN ('VEHICLE_SECURED', 'RETURN_INSPECTION', 'RECONDITIONING', 'PENDING_SETTLEMENT', 'COMPLETED', 'TERMINATED') AND "physical_controlled_at" IS NOT NULL)
        OR ("status" IN ('PREPARING_RETURN', 'RECOVERY_ASSESSMENT_PENDING', 'RECOVERY_APPROVAL_PENDING', 'RECOVERY_APPROVED', 'RECOVERY_IN_PROGRESS') AND "physical_controlled_at" IS NULL)
        OR "status" IN ('REJECTED', 'PAUSED', 'CANCELLED', 'MANUAL_TAKEOVER')
    ),
    CONSTRAINT "subscription_closure_case_authority_hash_chk" CHECK ("authority_snapshot_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "subscription_closure_case_version_nonnegative_chk" CHECK ("version" >= 0),
    CONSTRAINT "subscription_closure_case_source_key_not_blank_chk" CHECK (btrim("create_source_type") <> '' AND btrim("create_source_key") <> '')
);

CREATE TABLE "subscription_closure_event" (
    "id" UUID NOT NULL,
    "closure_case_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_type" "subscription_closure_event_type" NOT NULL,
    "before_status" "subscription_closure_status",
    "after_status" "subscription_closure_status" NOT NULL,
    "actor_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_type" VARCHAR(64) NOT NULL,
    "source_id" UUID NOT NULL,
    "source_key" VARCHAR(255) NOT NULL,
    "detail_snapshot" JSONB NOT NULL,

    CONSTRAINT "subscription_closure_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_closure_event_sequence_positive_chk" CHECK ("sequence" > 0),
    CONSTRAINT "subscription_closure_event_source_key_not_blank_chk" CHECK (btrim("source_type") <> '' AND btrim("source_key") <> ''),
    CONSTRAINT "subscription_closure_event_status_shape_chk" CHECK (
        ("event_type" = 'CASE_CREATED' AND "before_status" IS NULL)
        OR ("event_type" <> 'CASE_CREATED' AND "before_status" IS NOT NULL)
    )
);

CREATE TABLE "subscription_closure_document_revision" (
    "id" UUID NOT NULL,
    "closure_case_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "document_type" "subscription_closure_document_type" NOT NULL,
    "stage" "subscription_closure_document_stage" NOT NULL,
    "document_snapshot" JSONB NOT NULL,
    "document_snapshot_hash" VARCHAR(64) NOT NULL,
    "vehicle_return_id" UUID,
    "handover_work_order_id" UUID,
    "contract_esign_task_id" UUID NOT NULL,
    "source_file_id" UUID NOT NULL,
    "source_file_hash" VARCHAR(64) NOT NULL,
    "signed_file_id" UUID,
    "signed_file_hash" VARCHAR(64),
    "supersedes_revision_id" UUID,
    "source_type" VARCHAR(64) NOT NULL,
    "source_id" UUID NOT NULL,
    "source_key" VARCHAR(255) NOT NULL,
    "generated_by" UUID NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "archived_by" UUID,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_closure_document_revision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_closure_document_revision_number_positive_chk" CHECK ("revision_number" > 0),
    CONSTRAINT "subscription_closure_document_hashes_chk" CHECK (
        "document_snapshot_hash" ~ '^[0-9a-f]{64}$'
        AND "source_file_hash" ~ '^[0-9a-f]{64}$'
        AND ("signed_file_hash" IS NULL OR "signed_file_hash" ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT "subscription_closure_document_stage_shape_chk" CHECK (
        ("stage" = 'GENERATED' AND "signed_file_id" IS NULL AND "signed_file_hash" IS NULL AND "signed_by" IS NULL AND "signed_at" IS NULL AND "archived_by" IS NULL AND "archived_at" IS NULL)
        OR ("stage" = 'SIGNED' AND "signed_file_id" IS NOT NULL AND "signed_file_hash" IS NOT NULL AND "signed_by" IS NOT NULL AND "signed_at" IS NOT NULL AND "archived_by" IS NULL AND "archived_at" IS NULL)
        OR ("stage" = 'ARCHIVED' AND "signed_file_id" IS NOT NULL AND "signed_file_hash" IS NOT NULL AND "signed_by" IS NOT NULL AND "signed_at" IS NOT NULL AND "archived_by" IS NOT NULL AND "archived_at" IS NOT NULL)
    ),
    CONSTRAINT "subscription_closure_document_type_shape_chk" CHECK (
        ("document_type" = 'RETURN_MANIFEST' AND "vehicle_return_id" IS NOT NULL AND "handover_work_order_id" IS NOT NULL)
        OR ("document_type" IN ('EARLY_TERMINATION_AGREEMENT', 'RECOVERY_AUTHORITY') AND "vehicle_return_id" IS NULL AND "handover_work_order_id" IS NULL)
    ),
    CONSTRAINT "subscription_closure_document_source_key_not_blank_chk" CHECK (btrim("source_type") <> '' AND btrim("source_key") <> '')
);

CREATE TABLE "subscription_closure_settlement_revision" (
    "id" UUID NOT NULL,
    "closure_case_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "settlement_type" "subscription_closure_settlement_type" NOT NULL,
    "stage" "subscription_closure_settlement_stage" NOT NULL,
    "ledger_input_snapshot" JSONB NOT NULL,
    "bill_input_snapshot" JSONB NOT NULL,
    "deposit_input_snapshot" JSONB NOT NULL,
    "responsibility_snapshot" JSONB NOT NULL,
    "waiver_approval_id" UUID,
    "write_off_approval_id" UUID,
    "input_snapshot_hash" VARCHAR(64) NOT NULL,
    "cost_total_cents" BIGINT NOT NULL,
    "receivable_total_cents" BIGINT NOT NULL,
    "paid_total_cents" BIGINT NOT NULL,
    "write_off_total_cents" BIGINT NOT NULL,
    "waiver_total_cents" BIGINT NOT NULL,
    "deposit_applied_cents" BIGINT NOT NULL,
    "deposit_refund_cents" BIGINT NOT NULL,
    "amount_due_cents" BIGINT NOT NULL,
    "amount_refundable_cents" BIGINT NOT NULL,
    "result_snapshot" JSONB NOT NULL,
    "result_hash" VARCHAR(64) NOT NULL,
    "supersedes_revision_id" UUID,
    "source_type" VARCHAR(64) NOT NULL,
    "source_id" UUID NOT NULL,
    "source_key" VARCHAR(255) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_by" UUID,
    "finalized_at" TIMESTAMPTZ(6),
    "settled_by" UUID,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "subscription_closure_settlement_revision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_closure_settlement_revision_number_positive_chk" CHECK ("revision_number" > 0),
    CONSTRAINT "subscription_closure_settlement_hashes_chk" CHECK ("input_snapshot_hash" ~ '^[0-9a-f]{64}$' AND "result_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "subscription_closure_settlement_stage_shape_chk" CHECK (
        ("stage" = 'PROPOSED' AND "finalized_by" IS NULL AND "finalized_at" IS NULL AND "settled_by" IS NULL AND "settled_at" IS NULL)
        OR ("settlement_type" = 'FINAL' AND "stage" = 'FINALIZED' AND "finalized_by" IS NOT NULL AND "finalized_at" IS NOT NULL AND "settled_by" IS NULL AND "settled_at" IS NULL)
        OR ("settlement_type" = 'FINAL' AND "stage" = 'SETTLED' AND "finalized_by" IS NOT NULL AND "finalized_at" IS NOT NULL AND "settled_by" IS NOT NULL AND "settled_at" IS NOT NULL)
    ),
    CONSTRAINT "subscription_closure_settlement_amounts_nonnegative_chk" CHECK (
        "cost_total_cents" >= 0 AND "receivable_total_cents" >= 0 AND "paid_total_cents" >= 0
        AND "write_off_total_cents" >= 0 AND "waiver_total_cents" >= 0
        AND "deposit_applied_cents" >= 0 AND "deposit_refund_cents" >= 0
        AND "amount_due_cents" >= 0 AND "amount_refundable_cents" >= 0
    ),
    CONSTRAINT "subscription_closure_settlement_approval_shape_chk" CHECK (
        (("waiver_total_cents" = 0 AND "waiver_approval_id" IS NULL) OR ("waiver_total_cents" > 0 AND "waiver_approval_id" IS NOT NULL))
        AND (("write_off_total_cents" = 0 AND "write_off_approval_id" IS NULL) OR ("write_off_total_cents" > 0 AND "write_off_approval_id" IS NOT NULL))
    ),
    CONSTRAINT "subscription_closure_settlement_source_key_not_blank_chk" CHECK (btrim("source_type") <> '' AND btrim("source_key") <> '')
);

CREATE TABLE "subscription_closure_command_receipt" (
    "id" UUID NOT NULL,
    "closure_case_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "source_type" VARCHAR(64) NOT NULL,
    "source_id" UUID NOT NULL,
    "source_key" VARCHAR(255) NOT NULL,
    "command_type" "subscription_closure_command_type" NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "payload_snapshot" JSONB NOT NULL,
    "outcome_snapshot" JSONB NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_closure_command_receipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_closure_command_receipt_hash_chk" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "subscription_closure_command_receipt_target_shape_chk" CHECK ("closure_case_id" IS NOT NULL AND "event_id" IS NOT NULL),
    CONSTRAINT "subscription_closure_command_receipt_source_key_not_blank_chk" CHECK (btrim("source_type") <> '' AND btrim("source_key") <> '')
);

CREATE UNIQUE INDEX "subscription_closure_case_case_no_key" ON "subscription_closure_case"("case_no");
CREATE UNIQUE INDEX "subscription_closure_case_order_id_key" ON "subscription_closure_case"("order_id");
CREATE UNIQUE INDEX "subscription_closure_case_vehicle_return_id_key" ON "subscription_closure_case"("vehicle_return_id");
CREATE UNIQUE INDEX "subscription_closure_case_return_handover_work_order_id_key" ON "subscription_closure_case"("return_handover_work_order_id");
CREATE UNIQUE INDEX "subscription_closure_case_current_document_revision_id_key" ON "subscription_closure_case"("current_document_revision_id");
CREATE UNIQUE INDEX "subscription_closure_case_current_settlement_revision_id_key" ON "subscription_closure_case"("current_settlement_revision_id");
CREATE UNIQUE INDEX "subscription_closure_case_create_source_key" ON "subscription_closure_case"("create_source_type", "create_source_id", "create_source_key");
CREATE INDEX "subscription_closure_case_vehicle_id_idx" ON "subscription_closure_case"("vehicle_id");
CREATE INDEX "subscription_closure_case_customer_id_idx" ON "subscription_closure_case"("customer_id");
CREATE INDEX "subscription_closure_case_contract_id_idx" ON "subscription_closure_case"("contract_id");
CREATE INDEX "subscription_closure_case_status_idx" ON "subscription_closure_case"("status");

CREATE UNIQUE INDEX "subscription_closure_event_case_sequence_key" ON "subscription_closure_event"("closure_case_id", "sequence");
CREATE UNIQUE INDEX "subscription_closure_event_source_key" ON "subscription_closure_event"("source_type", "source_id", "source_key");
CREATE INDEX "subscription_closure_event_case_occurred_at_idx" ON "subscription_closure_event"("closure_case_id", "occurred_at");

CREATE UNIQUE INDEX "subscription_closure_document_revision_case_revision_key" ON "subscription_closure_document_revision"("closure_case_id", "revision_number");
CREATE UNIQUE INDEX "subscription_closure_document_supersedes_key" ON "subscription_closure_document_revision"("supersedes_revision_id");
CREATE UNIQUE INDEX "subscription_closure_document_revision_source_key" ON "subscription_closure_document_revision"("source_type", "source_id", "source_key");
CREATE INDEX "subscription_closure_document_revision_vehicle_return_id_idx" ON "subscription_closure_document_revision"("vehicle_return_id");
CREATE INDEX "subscription_closure_document_handover_idx" ON "subscription_closure_document_revision"("handover_work_order_id");
CREATE INDEX "subscription_closure_document_esign_task_idx" ON "subscription_closure_document_revision"("contract_esign_task_id");
CREATE INDEX "subscription_closure_document_revision_source_file_id_idx" ON "subscription_closure_document_revision"("source_file_id");
CREATE INDEX "subscription_closure_document_revision_signed_file_id_idx" ON "subscription_closure_document_revision"("signed_file_id");

CREATE UNIQUE INDEX "subscription_closure_settlement_revision_case_revision_key" ON "subscription_closure_settlement_revision"("closure_case_id", "revision_number");
CREATE UNIQUE INDEX "subscription_closure_settlement_supersedes_key" ON "subscription_closure_settlement_revision"("supersedes_revision_id");
CREATE UNIQUE INDEX "subscription_closure_settlement_revision_source_key" ON "subscription_closure_settlement_revision"("source_type", "source_id", "source_key");
CREATE INDEX "subscription_closure_settlement_revision_waiver_approval_id_idx" ON "subscription_closure_settlement_revision"("waiver_approval_id");
CREATE INDEX "subscription_closure_settlement_write_off_approval_idx" ON "subscription_closure_settlement_revision"("write_off_approval_id");

CREATE UNIQUE INDEX "subscription_closure_command_receipt_event_id_key" ON "subscription_closure_command_receipt"("event_id");
CREATE UNIQUE INDEX "subscription_closure_command_receipt_source_key" ON "subscription_closure_command_receipt"("source_type", "source_id", "source_key");
CREATE INDEX "subscription_closure_command_receipt_case_id_idx" ON "subscription_closure_command_receipt"("closure_case_id");

ALTER TABLE "subscription_closure_case" ADD CONSTRAINT "subscription_closure_case_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_case" ADD CONSTRAINT "subscription_closure_case_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_case" ADD CONSTRAINT "subscription_closure_case_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_case" ADD CONSTRAINT "subscription_closure_case_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_case" ADD CONSTRAINT "subscription_closure_case_vehicle_return_id_fkey" FOREIGN KEY ("vehicle_return_id") REFERENCES "vehicle_return"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_case" ADD CONSTRAINT "subscription_closure_case_return_handover_work_order_id_fkey" FOREIGN KEY ("return_handover_work_order_id") REFERENCES "vehicle_handover_work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_case" ADD CONSTRAINT "subscription_closure_case_return_asset_work_order_id_fkey" FOREIGN KEY ("return_asset_work_order_id") REFERENCES "asset_work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_case" ADD CONSTRAINT "subscription_closure_case_recovery_asset_work_order_id_fkey" FOREIGN KEY ("recovery_asset_work_order_id") REFERENCES "asset_work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_case" ADD CONSTRAINT "subscription_closure_case_reconditioning_asset_work_order_id_fkey" FOREIGN KEY ("reconditioning_asset_work_order_id") REFERENCES "asset_work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_case" ADD CONSTRAINT "subscription_closure_case_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_case" ADD CONSTRAINT "subscription_closure_case_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_closure_event" ADD CONSTRAINT "subscription_closure_event_closure_case_id_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_event" ADD CONSTRAINT "subscription_closure_event_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_closure_document_revision" ADD CONSTRAINT "subscription_closure_document_revision_closure_case_id_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_document_revision" ADD CONSTRAINT "subscription_closure_document_revision_vehicle_return_id_fkey" FOREIGN KEY ("vehicle_return_id") REFERENCES "vehicle_return"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_document_revision" ADD CONSTRAINT "subscription_closure_document_revision_handover_work_order_id_fkey" FOREIGN KEY ("handover_work_order_id") REFERENCES "vehicle_handover_work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_document_revision" ADD CONSTRAINT "subscription_closure_document_revision_contract_esign_task_id_fkey" FOREIGN KEY ("contract_esign_task_id") REFERENCES "contract_esign_task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_document_revision" ADD CONSTRAINT "subscription_closure_document_revision_source_file_id_fkey" FOREIGN KEY ("source_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_document_revision" ADD CONSTRAINT "subscription_closure_document_revision_signed_file_id_fkey" FOREIGN KEY ("signed_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_document_revision" ADD CONSTRAINT "subscription_closure_document_revision_supersedes_revision_id_fkey" FOREIGN KEY ("supersedes_revision_id") REFERENCES "subscription_closure_document_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_document_revision" ADD CONSTRAINT "subscription_closure_document_revision_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_document_revision" ADD CONSTRAINT "subscription_closure_document_revision_signed_by_fkey" FOREIGN KEY ("signed_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_document_revision" ADD CONSTRAINT "subscription_closure_document_revision_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_closure_settlement_revision" ADD CONSTRAINT "subscription_closure_settlement_revision_closure_case_id_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_settlement_revision" ADD CONSTRAINT "subscription_closure_settlement_revision_waiver_approval_id_fkey" FOREIGN KEY ("waiver_approval_id") REFERENCES "business_exception_approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_settlement_revision" ADD CONSTRAINT "subscription_closure_settlement_revision_write_off_approval_id_fkey" FOREIGN KEY ("write_off_approval_id") REFERENCES "business_exception_approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_settlement_revision" ADD CONSTRAINT "subscription_closure_settlement_revision_supersedes_revision_id_fkey" FOREIGN KEY ("supersedes_revision_id") REFERENCES "subscription_closure_settlement_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_settlement_revision" ADD CONSTRAINT "subscription_closure_settlement_revision_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_settlement_revision" ADD CONSTRAINT "subscription_closure_settlement_revision_finalized_by_fkey" FOREIGN KEY ("finalized_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_settlement_revision" ADD CONSTRAINT "subscription_closure_settlement_revision_settled_by_fkey" FOREIGN KEY ("settled_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_closure_command_receipt" ADD CONSTRAINT "subscription_closure_command_receipt_closure_case_id_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_command_receipt" ADD CONSTRAINT "subscription_closure_command_receipt_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "subscription_closure_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_command_receipt" ADD CONSTRAINT "subscription_closure_command_receipt_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_closure_case" ADD CONSTRAINT "subscription_closure_case_current_document_revision_id_fkey" FOREIGN KEY ("current_document_revision_id") REFERENCES "subscription_closure_document_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_closure_case" ADD CONSTRAINT "subscription_closure_case_current_settlement_revision_id_fkey" FOREIGN KEY ("current_settlement_revision_id") REFERENCES "subscription_closure_settlement_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "reject_subscription_closure_append_only_mutation"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = format('%I is append-only', TG_TABLE_NAME);
END;
$$;

CREATE FUNCTION "enforce_subscription_closure_case_immutable_initiation"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF ROW(
        NEW."id", NEW."case_no", NEW."order_id", NEW."vehicle_id", NEW."customer_id", NEW."contract_id",
        NEW."closure_type", NEW."authority_snapshot", NEW."authority_snapshot_hash", NEW."effective_at",
        NEW."create_source_type", NEW."create_source_id", NEW."create_source_key", NEW."created_by", NEW."created_at"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."case_no", OLD."order_id", OLD."vehicle_id", OLD."customer_id", OLD."contract_id",
        OLD."closure_type", OLD."authority_snapshot", OLD."authority_snapshot_hash", OLD."effective_at",
        OLD."create_source_type", OLD."create_source_id", OLD."create_source_key", OLD."created_by", OLD."created_at"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'subscription closure initiation intent is immutable';
    END IF;

    IF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'subscription closure version must increment by one';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_subscription_closure_document_revision_chain"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    previous_revision "public"."subscription_closure_document_revision"%ROWTYPE;
BEGIN
    IF NEW."revision_number" = 1 THEN
        IF NEW."supersedes_revision_id" IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_document_revision_chain_chk', MESSAGE = 'first document revision cannot supersede another revision';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."supersedes_revision_id" IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_document_revision_chain_chk', MESSAGE = 'successor document revision requires a predecessor';
    END IF;

    SELECT * INTO previous_revision
    FROM "public"."subscription_closure_document_revision"
    WHERE "id" = NEW."supersedes_revision_id"
    FOR KEY SHARE;

    IF NOT FOUND OR previous_revision."closure_case_id" <> NEW."closure_case_id" OR previous_revision."revision_number" <> NEW."revision_number" - 1 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_document_revision_chain_chk', MESSAGE = 'document revision predecessor must be the immediately prior revision in the same closure case';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_subscription_closure_settlement_revision_chain"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    previous_revision "public"."subscription_closure_settlement_revision"%ROWTYPE;
BEGIN
    IF NEW."revision_number" = 1 THEN
        IF NEW."supersedes_revision_id" IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_settlement_revision_chain_chk', MESSAGE = 'first settlement revision cannot supersede another revision';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."supersedes_revision_id" IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_settlement_revision_chain_chk', MESSAGE = 'successor settlement revision requires a predecessor';
    END IF;

    SELECT * INTO previous_revision
    FROM "public"."subscription_closure_settlement_revision"
    WHERE "id" = NEW."supersedes_revision_id"
    FOR KEY SHARE;

    IF NOT FOUND OR previous_revision."closure_case_id" <> NEW."closure_case_id" OR previous_revision."revision_number" <> NEW."revision_number" - 1 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_settlement_revision_chain_chk', MESSAGE = 'settlement revision predecessor must be the immediately prior revision in the same closure case';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_subscription_closure_document_authority"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    closure_case "public"."subscription_closure_case"%ROWTYPE;
    vehicle_return "public"."vehicle_return"%ROWTYPE;
    handover_order "public"."vehicle_handover_work_order"%ROWTYPE;
    esign_task "public"."contract_esign_task"%ROWTYPE;
BEGIN
    SELECT * INTO closure_case FROM "public"."subscription_closure_case" WHERE "id" = NEW."closure_case_id" FOR KEY SHARE;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    SELECT * INTO esign_task FROM "public"."contract_esign_task" WHERE "id" = NEW."contract_esign_task_id" FOR KEY SHARE;
    IF FOUND AND (esign_task."contract_id" <> closure_case."contract_id" OR esign_task."order_id" IS DISTINCT FROM closure_case."order_id") THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_document_esign_authority_chk', MESSAGE = 'closure document e-sign task must belong to the closure contract and order';
    END IF;

    IF NEW."document_type" = 'RETURN_MANIFEST' THEN
        SELECT * INTO vehicle_return FROM "public"."vehicle_return" WHERE "id" = NEW."vehicle_return_id" FOR KEY SHARE;
        SELECT * INTO handover_order FROM "public"."vehicle_handover_work_order" WHERE "id" = NEW."handover_work_order_id" FOR KEY SHARE;
        IF closure_case."vehicle_return_id" IS DISTINCT FROM NEW."vehicle_return_id"
            OR closure_case."return_handover_work_order_id" IS DISTINCT FROM NEW."handover_work_order_id"
            OR vehicle_return."order_id" IS DISTINCT FROM closure_case."order_id"
            OR vehicle_return."vehicle_id" IS DISTINCT FROM closure_case."vehicle_id"
            OR handover_order."order_id" IS DISTINCT FROM closure_case."order_id"
            OR handover_order."handover_type" <> 'RETURN_INBOUND' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_document_return_authority_chk', MESSAGE = 'return manifest authorities must match the closure return and governed inbound handover';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_subscription_closure_current_revision_integrity"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    pointed_case_id UUID;
    pointed_revision INTEGER;
    maximum_revision INTEGER;
BEGIN
    IF NEW."current_document_revision_id" IS NOT NULL THEN
        SELECT "closure_case_id", "revision_number" INTO pointed_case_id, pointed_revision
        FROM "public"."subscription_closure_document_revision"
        WHERE "id" = NEW."current_document_revision_id"
        FOR KEY SHARE;
        SELECT max("revision_number") INTO maximum_revision
        FROM "public"."subscription_closure_document_revision"
        WHERE "closure_case_id" = NEW."id";
        IF pointed_case_id IS DISTINCT FROM NEW."id" OR pointed_revision IS DISTINCT FROM maximum_revision THEN
            RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_case_current_document_case_chk', MESSAGE = 'current document revision must be the latest revision in the same closure case';
        END IF;
    END IF;

    IF NEW."current_settlement_revision_id" IS NOT NULL THEN
        SELECT "closure_case_id", "revision_number" INTO pointed_case_id, pointed_revision
        FROM "public"."subscription_closure_settlement_revision"
        WHERE "id" = NEW."current_settlement_revision_id"
        FOR KEY SHARE;
        SELECT max("revision_number") INTO maximum_revision
        FROM "public"."subscription_closure_settlement_revision"
        WHERE "closure_case_id" = NEW."id";
        IF pointed_case_id IS DISTINCT FROM NEW."id" OR pointed_revision IS DISTINCT FROM maximum_revision THEN
            RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_case_current_settlement_case_chk', MESSAGE = 'current settlement revision must be the latest revision in the same closure case';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_subscription_closure_receipt_integrity"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    event_case_id UUID;
BEGIN
    SELECT "closure_case_id" INTO event_case_id
    FROM "public"."subscription_closure_event"
    WHERE "id" = NEW."event_id"
    FOR KEY SHARE;
    IF event_case_id IS DISTINCT FROM NEW."closure_case_id" THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_command_receipt_event_case_chk', MESSAGE = 'command receipt event must belong to the same closure case';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_closure_case_immutable_initiation"
    BEFORE UPDATE ON "subscription_closure_case"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_subscription_closure_case_immutable_initiation"();

CREATE TRIGGER "subscription_closure_case_current_revision_integrity"
    BEFORE INSERT OR UPDATE ON "subscription_closure_case"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_subscription_closure_current_revision_integrity"();

CREATE TRIGGER "subscription_closure_event_append_only"
    BEFORE UPDATE OR DELETE ON "subscription_closure_event"
    FOR EACH ROW
    EXECUTE FUNCTION "reject_subscription_closure_append_only_mutation"();

CREATE TRIGGER "subscription_closure_document_revision_append_only"
    BEFORE UPDATE OR DELETE ON "subscription_closure_document_revision"
    FOR EACH ROW
    EXECUTE FUNCTION "reject_subscription_closure_append_only_mutation"();

CREATE TRIGGER "subscription_closure_settlement_revision_append_only"
    BEFORE UPDATE OR DELETE ON "subscription_closure_settlement_revision"
    FOR EACH ROW
    EXECUTE FUNCTION "reject_subscription_closure_append_only_mutation"();

CREATE TRIGGER "subscription_closure_command_receipt_append_only"
    BEFORE UPDATE OR DELETE ON "subscription_closure_command_receipt"
    FOR EACH ROW
    EXECUTE FUNCTION "reject_subscription_closure_append_only_mutation"();

CREATE TRIGGER "subscription_closure_document_revision_chain"
    BEFORE INSERT ON "subscription_closure_document_revision"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_subscription_closure_document_revision_chain"();

CREATE TRIGGER "subscription_closure_document_authority"
    BEFORE INSERT ON "subscription_closure_document_revision"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_subscription_closure_document_authority"();

CREATE TRIGGER "subscription_closure_settlement_revision_chain"
    BEFORE INSERT ON "subscription_closure_settlement_revision"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_subscription_closure_settlement_revision_chain"();

CREATE TRIGGER "subscription_closure_command_receipt_integrity"
    BEFORE INSERT ON "subscription_closure_command_receipt"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_subscription_closure_receipt_integrity"();
