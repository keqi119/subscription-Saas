-- CreateEnum
CREATE TYPE "asset_work_order_type" AS ENUM ('DELIVERY_OUTBOUND', 'RETURN_INBOUND', 'SWAP_OUTBOUND', 'SWAP_INBOUND', 'RECOVERY', 'RECONDITIONING', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "asset_work_order_status" AS ENUM ('PENDING', 'IN_PROGRESS', 'WAITING_EXTERNAL', 'PENDING_ACCEPTANCE', 'PENDING_COST_CONFIRMATION', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "asset_work_order_priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "asset_work_order_event_type" AS ENUM ('CREATED', 'ASSIGNED', 'STARTED', 'WAITING_EXTERNAL', 'RESUMED', 'EVIDENCE_ATTACHED', 'SUBMITTED_FOR_ACCEPTANCE', 'ACCEPTED', 'COST_CONFIRMED', 'PHYSICAL_CONTROL_CONFIRMED', 'INSPECTION_RECORDED', 'RESTRICTION_CREATED', 'RESTRICTION_RELEASED', 'CLOSED', 'CANCELLED', 'NOTE_ADDED');

-- CreateEnum
CREATE TYPE "asset_work_order_evidence_action" AS ENUM ('ATTACH', 'SUPERSEDE', 'REMOVE');

-- CreateEnum
CREATE TYPE "asset_work_order_evidence_type" AS ENUM ('PHOTO', 'VIDEO', 'DOCUMENT', 'SIGNATURE', 'LOCATION_PROOF', 'THIRD_PARTY_RECEIPT', 'INSPECTION_REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_operational_restriction_type" AS ENUM ('RETURN_INSPECTION_PENDING', 'REINSPECTION_PENDING', 'RECONDITIONING_PENDING', 'MAINTENANCE_OR_ACCIDENT', 'RECOVERY_IN_PROGRESS', 'LEGAL_HOLD', 'EVIDENCE_EXCEPTION', 'OWNERSHIP_EXCEPTION', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_operational_restriction_severity" AS ENUM ('ADVISORY', 'BLOCKING');

-- CreateEnum
CREATE TYPE "vehicle_operational_restriction_scope" AS ENUM ('ALLOCATION', 'DELIVERY', 'CUSTOMER_USE', 'INVENTORY_RELEASE');

-- CreateEnum
CREATE TYPE "vehicle_operational_restriction_status" AS ENUM ('ACTIVE', 'RELEASED', 'VOIDED');

-- CreateTable
CREATE TABLE "asset_work_order" (
    "id" UUID NOT NULL,
    "work_order_no" VARCHAR(64) NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "order_id" UUID,
    "contract_id" UUID,
    "customer_id" UUID,
    "asset_owner_id" UUID,
    "related_work_order_id" UUID,
    "work_order_type" "asset_work_order_type" NOT NULL,
    "status" "asset_work_order_status" NOT NULL DEFAULT 'PENDING',
    "priority" "asset_work_order_priority" NOT NULL DEFAULT 'NORMAL',
    "cost_confirmation_required" BOOLEAN NOT NULL DEFAULT false,
    "assigned_user_id" UUID,
    "scheduled_at" TIMESTAMPTZ(6),
    "sla_due_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "cost_confirmed_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "description" TEXT,
    "solution" TEXT,
    "close_reason" TEXT,
    "create_source_type" VARCHAR(64) NOT NULL,
    "create_source_id" UUID NOT NULL,
    "create_source_key" VARCHAR(255) NOT NULL,
    "authority_snapshot" JSONB NOT NULL,
    "metadata" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "asset_work_order_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "asset_work_order_version_nonnegative_chk" CHECK ("version" >= 0)
);

-- CreateTable
CREATE TABLE "asset_work_order_event" (
    "id" UUID NOT NULL,
    "work_order_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_type" "asset_work_order_event_type" NOT NULL,
    "before_status" "asset_work_order_status",
    "after_status" "asset_work_order_status",
    "actor_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_type" VARCHAR(64) NOT NULL,
    "source_id" UUID NOT NULL,
    "source_key" VARCHAR(255) NOT NULL,
    "detail_snapshot" JSONB NOT NULL,

    CONSTRAINT "asset_work_order_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "asset_work_order_event_sequence_positive_chk" CHECK ("sequence" > 0),
    CONSTRAINT "asset_work_order_event_occurred_not_future_chk" CHECK ("occurred_at" <= "recorded_at")
);

-- CreateTable
CREATE TABLE "asset_work_order_evidence" (
    "id" UUID NOT NULL,
    "work_order_id" UUID NOT NULL,
    "event_id" UUID,
    "action" "asset_work_order_evidence_action" NOT NULL,
    "evidence_type" "asset_work_order_evidence_type" NOT NULL,
    "file_id" UUID,
    "supersedes_evidence_id" UUID,
    "file_bucket" VARCHAR(64),
    "file_object_key" VARCHAR(255),
    "file_size_bytes" BIGINT,
    "file_mime_type" VARCHAR(128),
    "content_sha256" VARCHAR(64),
    "captured_at" TIMESTAMPTZ(6),
    "capture_metadata" JSONB,
    "source_type" VARCHAR(64) NOT NULL,
    "source_id" UUID NOT NULL,
    "source_key" VARCHAR(255) NOT NULL,
    "actor_id" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_work_order_evidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "asset_work_order_evidence_sha256_chk" CHECK ("content_sha256" IS NULL OR "content_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "asset_work_order_evidence_action_shape_chk" CHECK (
        ("action" = 'REMOVE' AND "file_id" IS NULL AND "content_sha256" IS NULL AND "supersedes_evidence_id" IS NOT NULL)
        OR ("action" = 'ATTACH' AND "file_id" IS NOT NULL AND "content_sha256" IS NOT NULL AND "supersedes_evidence_id" IS NULL)
        OR ("action" = 'SUPERSEDE' AND "file_id" IS NOT NULL AND "content_sha256" IS NOT NULL AND "supersedes_evidence_id" IS NOT NULL)
    ),
    CONSTRAINT "asset_work_order_evidence_file_snapshot_shape_chk" CHECK (
        ("file_id" IS NULL AND "file_bucket" IS NULL AND "file_object_key" IS NULL AND "file_size_bytes" IS NULL AND "file_mime_type" IS NULL)
        OR ("file_id" IS NOT NULL AND "file_bucket" IS NOT NULL AND "file_object_key" IS NOT NULL AND "file_size_bytes" IS NOT NULL)
    ),
    CONSTRAINT "asset_work_order_evidence_file_size_nonnegative_chk" CHECK ("file_size_bytes" IS NULL OR "file_size_bytes" >= 0)
);

-- CreateTable
CREATE TABLE "vehicle_operational_restriction" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "work_order_id" UUID,
    "restriction_type" "vehicle_operational_restriction_type" NOT NULL,
    "severity" "vehicle_operational_restriction_severity" NOT NULL,
    "scopes" "vehicle_operational_restriction_scope"[] NOT NULL,
    "status" "vehicle_operational_restriction_status" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "conditions_snapshot" JSONB NOT NULL,
    "evidence_snapshot" JSONB,
    "start_source_type" VARCHAR(64) NOT NULL,
    "start_source_id" UUID NOT NULL,
    "start_source_key" VARCHAR(255) NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "released_by" UUID,
    "release_reason" TEXT,
    "release_snapshot" JSONB,
    "release_source_type" VARCHAR(64),
    "release_source_id" UUID,
    "release_source_key" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "vehicle_operational_restriction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "vehicle_operational_restriction_scopes_not_empty_chk" CHECK (cardinality("scopes") > 0),
    CONSTRAINT "vehicle_operational_restriction_release_after_start_chk" CHECK ("released_at" IS NULL OR "released_at" >= "started_at"),
    CONSTRAINT "vehicle_operational_restriction_release_tuple_chk" CHECK (
        ("status" = 'ACTIVE' AND "released_at" IS NULL AND "released_by" IS NULL AND "release_reason" IS NULL AND "release_snapshot" IS NULL AND "release_source_type" IS NULL AND "release_source_id" IS NULL AND "release_source_key" IS NULL)
        OR ("status" IN ('RELEASED', 'VOIDED') AND "released_at" IS NOT NULL AND "released_by" IS NOT NULL AND "release_reason" IS NOT NULL AND "release_snapshot" IS NOT NULL AND "release_source_type" IS NOT NULL AND "release_source_id" IS NOT NULL AND "release_source_key" IS NOT NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "asset_work_order_work_order_no_key" ON "asset_work_order"("work_order_no");
CREATE UNIQUE INDEX "asset_work_order_create_source_key" ON "asset_work_order"("create_source_type", "create_source_id", "create_source_key");
CREATE INDEX "asset_work_order_vehicle_status_idx" ON "asset_work_order"("vehicle_id", "status");
CREATE INDEX "asset_work_order_order_id_idx" ON "asset_work_order"("order_id");
CREATE INDEX "asset_work_order_contract_id_idx" ON "asset_work_order"("contract_id");
CREATE INDEX "asset_work_order_customer_id_idx" ON "asset_work_order"("customer_id");
CREATE INDEX "asset_work_order_asset_owner_id_idx" ON "asset_work_order"("asset_owner_id");
CREATE INDEX "asset_work_order_related_work_order_id_idx" ON "asset_work_order"("related_work_order_id");
CREATE INDEX "asset_work_order_assignee_sla_idx" ON "asset_work_order"("assigned_user_id", "sla_due_at");
CREATE INDEX "asset_work_order_status_sla_idx" ON "asset_work_order"("status", "sla_due_at");
CREATE INDEX "asset_work_order_created_by_idx" ON "asset_work_order"("created_by");
CREATE INDEX "asset_work_order_updated_by_idx" ON "asset_work_order"("updated_by");

CREATE UNIQUE INDEX "asset_work_order_event_work_order_sequence_key" ON "asset_work_order_event"("work_order_id", "sequence");
CREATE UNIQUE INDEX "asset_work_order_event_source_key" ON "asset_work_order_event"("source_type", "source_id", "source_key");
CREATE INDEX "asset_work_order_event_work_order_timeline_idx" ON "asset_work_order_event"("work_order_id", "occurred_at", "sequence");
CREATE INDEX "asset_work_order_event_type_recorded_at_idx" ON "asset_work_order_event"("event_type", "recorded_at");
CREATE INDEX "asset_work_order_event_actor_id_idx" ON "asset_work_order_event"("actor_id");

CREATE UNIQUE INDEX "asset_work_order_evidence_source_key" ON "asset_work_order_evidence"("source_type", "source_id", "source_key");
CREATE UNIQUE INDEX "asset_work_order_evidence_supersedes_evidence_id_key" ON "asset_work_order_evidence"("supersedes_evidence_id");
CREATE INDEX "asset_work_order_evidence_work_order_recorded_at_idx" ON "asset_work_order_evidence"("work_order_id", "recorded_at");
CREATE INDEX "asset_work_order_evidence_event_id_idx" ON "asset_work_order_evidence"("event_id");
CREATE INDEX "asset_work_order_evidence_file_id_idx" ON "asset_work_order_evidence"("file_id");
CREATE INDEX "asset_work_order_evidence_actor_id_idx" ON "asset_work_order_evidence"("actor_id");

CREATE UNIQUE INDEX "vehicle_operational_restriction_start_source_key" ON "vehicle_operational_restriction"("start_source_type", "start_source_id", "start_source_key");
CREATE UNIQUE INDEX "vehicle_operational_restriction_release_source_key" ON "vehicle_operational_restriction"("release_source_type", "release_source_id", "release_source_key");
CREATE INDEX "vehicle_operational_restriction_vehicle_status_idx" ON "vehicle_operational_restriction"("vehicle_id", "status");
CREATE INDEX "vehicle_operational_restriction_work_order_id_idx" ON "vehicle_operational_restriction"("work_order_id");
CREATE INDEX "vehicle_operational_restriction_type_status_idx" ON "vehicle_operational_restriction"("restriction_type", "status");
CREATE INDEX "vehicle_operational_restriction_released_by_idx" ON "vehicle_operational_restriction"("released_by");
CREATE INDEX "vehicle_operational_restriction_created_by_idx" ON "vehicle_operational_restriction"("created_by");
CREATE INDEX "vehicle_operational_restriction_updated_by_idx" ON "vehicle_operational_restriction"("updated_by");
CREATE INDEX "vehicle_operational_restriction_active_vehicle_idx" ON "vehicle_operational_restriction"("vehicle_id", "severity")
    WHERE "status" = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "asset_work_order" ADD CONSTRAINT "asset_work_order_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_work_order" ADD CONSTRAINT "asset_work_order_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_work_order" ADD CONSTRAINT "asset_work_order_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_work_order" ADD CONSTRAINT "asset_work_order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_work_order" ADD CONSTRAINT "asset_work_order_asset_owner_id_fkey" FOREIGN KEY ("asset_owner_id") REFERENCES "asset_owner"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_work_order" ADD CONSTRAINT "asset_work_order_related_work_order_id_fkey" FOREIGN KEY ("related_work_order_id") REFERENCES "asset_work_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_work_order" ADD CONSTRAINT "asset_work_order_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_work_order" ADD CONSTRAINT "asset_work_order_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_work_order" ADD CONSTRAINT "asset_work_order_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "asset_work_order_event" ADD CONSTRAINT "asset_work_order_event_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "asset_work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_work_order_event" ADD CONSTRAINT "asset_work_order_event_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "asset_work_order_evidence" ADD CONSTRAINT "asset_work_order_evidence_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "asset_work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_work_order_evidence" ADD CONSTRAINT "asset_work_order_evidence_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "asset_work_order_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_work_order_evidence" ADD CONSTRAINT "asset_work_order_evidence_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_work_order_evidence" ADD CONSTRAINT "asset_work_order_evidence_supersedes_evidence_id_fkey" FOREIGN KEY ("supersedes_evidence_id") REFERENCES "asset_work_order_evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_work_order_evidence" ADD CONSTRAINT "asset_work_order_evidence_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "vehicle_operational_restriction" ADD CONSTRAINT "vehicle_operational_restriction_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_operational_restriction" ADD CONSTRAINT "vehicle_operational_restriction_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "asset_work_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_operational_restriction" ADD CONSTRAINT "vehicle_operational_restriction_released_by_fkey" FOREIGN KEY ("released_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_operational_restriction" ADD CONSTRAINT "vehicle_operational_restriction_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_operational_restriction" ADD CONSTRAINT "vehicle_operational_restriction_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Event and evidence rows are immutable audit facts.
CREATE FUNCTION "reject_asset_operation_append_only_mutation"() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = format('%I is append-only', TG_TABLE_NAME);
END;
$$;

CREATE TRIGGER "asset_work_order_event_append_only"
    BEFORE UPDATE OR DELETE ON "asset_work_order_event"
    FOR EACH ROW
    EXECUTE FUNCTION "reject_asset_operation_append_only_mutation"();

CREATE TRIGGER "asset_work_order_evidence_append_only"
    BEFORE UPDATE OR DELETE ON "asset_work_order_evidence"
    FOR EACH ROW
    EXECUTE FUNCTION "reject_asset_operation_append_only_mutation"();

-- Restriction start facts are immutable, and an ACTIVE row can be released once.
CREATE FUNCTION "enforce_vehicle_operational_restriction_release"() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'vehicle_operational_restriction cannot be deleted';
    END IF;

    IF OLD."status" <> 'ACTIVE' OR NEW."status" = 'ACTIVE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'vehicle_operational_restriction can be released only once';
    END IF;

    IF ROW(
        NEW."id", NEW."vehicle_id", NEW."work_order_id", NEW."restriction_type",
        NEW."severity", NEW."scopes", NEW."started_at", NEW."conditions_snapshot",
        NEW."evidence_snapshot", NEW."start_source_type", NEW."start_source_id",
        NEW."start_source_key", NEW."created_at", NEW."created_by"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."vehicle_id", OLD."work_order_id", OLD."restriction_type",
        OLD."severity", OLD."scopes", OLD."started_at", OLD."conditions_snapshot",
        OLD."evidence_snapshot", OLD."start_source_type", OLD."start_source_id",
        OLD."start_source_key", OLD."created_at", OLD."created_by"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'vehicle_operational_restriction start facts are immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "vehicle_operational_restriction_release_only"
    BEFORE UPDATE OR DELETE ON "vehicle_operational_restriction"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_vehicle_operational_restriction_release"();
