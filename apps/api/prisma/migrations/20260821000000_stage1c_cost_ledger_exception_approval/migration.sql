-- Stage 1C-C immutable cost ledger, snapshot-bound exception approvals, and command receipts.
CREATE TYPE "vehicle_cost_entry_kind" AS ENUM ('ORIGINAL', 'REVERSAL');
CREATE TYPE "vehicle_cost_action_type" AS ENUM ('ACTUAL_COST', 'RESPONSIBILITY_CONFIRMED', 'RECOVERY_EXPOSURE', 'RECOVERY_RECEIVED', 'WAIVER', 'WRITE_OFF');
CREATE TYPE "vehicle_cost_category" AS ENUM ('DAMAGE', 'CLEANING', 'REPAIR', 'MAINTENANCE', 'EXCESS_MILEAGE', 'VIOLATION', 'TOWING', 'INSURANCE', 'BAAS', 'DEPRECIATION', 'OTHER');
CREATE TYPE "vehicle_cost_responsible_party_type" AS ENUM ('CUSTOMER', 'INSURER', 'SUPPLIER', 'ASSET_OWNER', 'PLATFORM', 'OTHER');
CREATE TYPE "business_exception_type" AS ENUM ('VEHICLE_REGISTRATION_DOCUMENT_MISSING', 'HANDOVER_EVIDENCE_EXCEPTION', 'SETTLEMENT_WAIVER', 'SETTLEMENT_WRITE_OFF', 'RECOVERY_EXECUTION_APPROVAL');
CREATE TYPE "business_exception_subject_type" AS ENUM ('VEHICLE', 'ORDER', 'CONTRACT', 'ASSET_WORK_ORDER', 'HANDOVER_WORK_ORDER', 'SETTLEMENT_CASE', 'RECOVERY_CASE');
CREATE TYPE "business_exception_approval_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');
CREATE TYPE "business_exception_decision" AS ENUM ('APPROVED', 'REJECTED');
CREATE TYPE "asset_accounting_command_type" AS ENUM ('COST_APPEND', 'COST_REVERSE', 'EXCEPTION_REQUEST', 'EXCEPTION_DECIDE', 'EXCEPTION_EXPIRE');

CREATE TABLE "vehicle_cost_ledger_entry" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "order_id" UUID,
    "contract_id" UUID,
    "customer_id" UUID,
    "asset_owner_id" UUID,
    "work_order_id" UUID,
    "evidence_id" UUID,
    "asset_owner_snapshot" JSONB,
    "evidence_snapshot" JSONB,
    "responsibility_snapshot" JSONB NOT NULL,
    "entry_kind" "vehicle_cost_entry_kind" NOT NULL,
    "action_type" "vehicle_cost_action_type" NOT NULL,
    "cost_category" "vehicle_cost_category" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "responsible_party_type" "vehicle_cost_responsible_party_type" NOT NULL,
    "responsible_party_id" UUID,
    "occurred_on" DATE NOT NULL,
    "accounting_period" VARCHAR(7) NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6) NOT NULL,
    "confirmed_by" UUID,
    "reversal_of_entry_id" UUID,
    "source_type" VARCHAR(64) NOT NULL,
    "source_id" UUID NOT NULL,
    "source_key" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_cost_ledger_entry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "vehicle_cost_ledger_entry_amount_nonzero_chk" CHECK ("amount_cents" <> 0),
    CONSTRAINT "vehicle_cost_ledger_entry_kind_amount_shape_chk" CHECK (
        ("entry_kind" = 'ORIGINAL' AND "amount_cents" > 0 AND "reversal_of_entry_id" IS NULL)
        OR ("entry_kind" = 'REVERSAL' AND "amount_cents" < 0 AND "reversal_of_entry_id" IS NOT NULL)
    ),
    CONSTRAINT "vehicle_cost_ledger_entry_accounting_period_chk" CHECK ("accounting_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT "vehicle_cost_ledger_entry_source_key_not_blank_chk" CHECK (btrim("source_type") <> '' AND btrim("source_key") <> '')
);

CREATE TABLE "business_exception_approval" (
    "id" UUID NOT NULL,
    "approval_no" VARCHAR(64) NOT NULL,
    "exception_type" "business_exception_type" NOT NULL,
    "subject_type" "business_exception_subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "subject_field" VARCHAR(128) NOT NULL,
    "subject_snapshot" JSONB NOT NULL,
    "subject_snapshot_hash" VARCHAR(64) NOT NULL,
    "request_reason" TEXT NOT NULL,
    "request_evidence_snapshot" JSONB,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "request_source_type" VARCHAR(64) NOT NULL,
    "request_source_id" UUID NOT NULL,
    "request_source_key" VARCHAR(255) NOT NULL,
    "status" "business_exception_approval_status" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 0,
    "decision" "business_exception_decision",
    "decision_comment" TEXT,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "expiry_reason" TEXT,
    "expired_by" UUID,
    "expired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_exception_approval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "business_exception_approval_snapshot_hash_chk" CHECK ("subject_snapshot_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "business_exception_approval_request_source_key_not_blank_chk" CHECK (btrim("request_source_type") <> '' AND btrim("request_source_key") <> ''),
    CONSTRAINT "business_exception_approval_version_nonnegative_chk" CHECK ("version" >= 0),
    CONSTRAINT "business_exception_approval_status_shape_chk" CHECK (
        ("status" = 'PENDING' AND "decision" IS NULL AND "decided_by" IS NULL AND "decided_at" IS NULL AND "expiry_reason" IS NULL AND "expired_by" IS NULL AND "expired_at" IS NULL)
        OR ("status" = 'APPROVED' AND "decision" = 'APPROVED' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "expiry_reason" IS NULL AND "expired_by" IS NULL AND "expired_at" IS NULL)
        OR ("status" = 'REJECTED' AND "decision" = 'REJECTED' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "expiry_reason" IS NULL AND "expired_by" IS NULL AND "expired_at" IS NULL)
        OR ("status" = 'EXPIRED' AND "expiry_reason" IS NOT NULL AND "expired_by" IS NOT NULL AND "expired_at" IS NOT NULL AND (
            ("decision" IS NULL AND "decision_comment" IS NULL AND "decided_by" IS NULL AND "decided_at" IS NULL)
            OR ("decision" = 'APPROVED' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
        ))
    )
);

CREATE TABLE "asset_accounting_command_receipt" (
    "id" UUID NOT NULL,
    "source_type" VARCHAR(64) NOT NULL,
    "source_id" UUID NOT NULL,
    "source_key" VARCHAR(255) NOT NULL,
    "command_type" "asset_accounting_command_type" NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "payload_snapshot" JSONB NOT NULL,
    "outcome_snapshot" JSONB NOT NULL,
    "cost_entry_id" UUID,
    "approval_id" UUID,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_accounting_command_receipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "asset_accounting_command_receipt_payload_hash_chk" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "asset_accounting_command_receipt_source_key_not_blank_chk" CHECK (btrim("source_type") <> '' AND btrim("source_key") <> ''),
    CONSTRAINT "asset_accounting_command_receipt_target_shape_chk" CHECK (
        ("cost_entry_id" IS NOT NULL AND "approval_id" IS NULL)
        OR ("cost_entry_id" IS NULL AND "approval_id" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "business_exception_approval_approval_no_key" ON "business_exception_approval"("approval_no");
CREATE INDEX "vehicle_cost_ledger_entry_vehicle_occurred_on_idx" ON "vehicle_cost_ledger_entry"("vehicle_id", "occurred_on");
CREATE INDEX "vehicle_cost_ledger_entry_order_id_idx" ON "vehicle_cost_ledger_entry"("order_id");
CREATE INDEX "vehicle_cost_ledger_entry_contract_id_idx" ON "vehicle_cost_ledger_entry"("contract_id");
CREATE INDEX "vehicle_cost_ledger_entry_customer_id_idx" ON "vehicle_cost_ledger_entry"("customer_id");
CREATE INDEX "vehicle_cost_ledger_entry_asset_owner_id_idx" ON "vehicle_cost_ledger_entry"("asset_owner_id");
CREATE INDEX "vehicle_cost_ledger_entry_work_order_id_idx" ON "vehicle_cost_ledger_entry"("work_order_id");
CREATE INDEX "vehicle_cost_ledger_entry_source_key_idx" ON "vehicle_cost_ledger_entry"("source_type", "source_id", "source_key");
CREATE UNIQUE INDEX "vehicle_cost_ledger_entry_reversal_of_entry_id_key" ON "vehicle_cost_ledger_entry"("reversal_of_entry_id")
    WHERE "reversal_of_entry_id" IS NOT NULL;
CREATE INDEX "business_exception_approval_subject_idx" ON "business_exception_approval"("subject_type", "subject_id", "subject_field");
CREATE INDEX "business_exception_approval_status_idx" ON "business_exception_approval"("status");
CREATE UNIQUE INDEX "business_exception_approval_live_subject_field_snapshot_key" ON "business_exception_approval"("subject_type", "subject_id", "subject_field", "subject_snapshot_hash")
    WHERE "status" IN ('PENDING', 'APPROVED');
CREATE UNIQUE INDEX "asset_accounting_command_receipt_source_key" ON "asset_accounting_command_receipt"("source_type", "source_id", "source_key");
CREATE INDEX "asset_accounting_command_receipt_cost_entry_id_idx" ON "asset_accounting_command_receipt"("cost_entry_id");
CREATE INDEX "asset_accounting_command_receipt_approval_id_idx" ON "asset_accounting_command_receipt"("approval_id");

ALTER TABLE "vehicle_cost_ledger_entry" ADD CONSTRAINT "vehicle_cost_ledger_entry_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_cost_ledger_entry" ADD CONSTRAINT "vehicle_cost_ledger_entry_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_cost_ledger_entry" ADD CONSTRAINT "vehicle_cost_ledger_entry_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_cost_ledger_entry" ADD CONSTRAINT "vehicle_cost_ledger_entry_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_cost_ledger_entry" ADD CONSTRAINT "vehicle_cost_ledger_entry_asset_owner_id_fkey" FOREIGN KEY ("asset_owner_id") REFERENCES "asset_owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_cost_ledger_entry" ADD CONSTRAINT "vehicle_cost_ledger_entry_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "asset_work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_cost_ledger_entry" ADD CONSTRAINT "vehicle_cost_ledger_entry_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "asset_work_order_evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_cost_ledger_entry" ADD CONSTRAINT "vehicle_cost_ledger_entry_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_cost_ledger_entry" ADD CONSTRAINT "vehicle_cost_ledger_entry_reversal_of_entry_id_fkey" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "vehicle_cost_ledger_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "business_exception_approval" ADD CONSTRAINT "business_exception_approval_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "business_exception_approval" ADD CONSTRAINT "business_exception_approval_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "business_exception_approval" ADD CONSTRAINT "business_exception_approval_expired_by_fkey" FOREIGN KEY ("expired_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "asset_accounting_command_receipt" ADD CONSTRAINT "asset_accounting_command_receipt_cost_entry_id_fkey" FOREIGN KEY ("cost_entry_id") REFERENCES "vehicle_cost_ledger_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_accounting_command_receipt" ADD CONSTRAINT "asset_accounting_command_receipt_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "business_exception_approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_accounting_command_receipt" ADD CONSTRAINT "asset_accounting_command_receipt_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "enforce_vehicle_cost_ledger_reversal"() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    original "vehicle_cost_ledger_entry"%ROWTYPE;
BEGIN
    IF NEW."entry_kind" <> 'REVERSAL' THEN
        RETURN NEW;
    END IF;

    SELECT * INTO original
    FROM "vehicle_cost_ledger_entry"
    WHERE "id" = NEW."reversal_of_entry_id"
    FOR KEY SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'vehicle_cost_ledger_entry_reversal_target_fkey', MESSAGE = 'reversal target does not exist';
    END IF;

    IF original."entry_kind" = 'REVERSAL' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'vehicle_cost_ledger_entry_reverse_of_reversal_chk', MESSAGE = 'a reversal cannot target another reversal';
    END IF;

    IF NEW."amount_cents" <> -original."amount_cents" THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'vehicle_cost_ledger_entry_reversal_amount_chk', MESSAGE = 'reversal amount must be the exact opposite of the original';
    END IF;

    IF ROW(
        NEW."vehicle_id", NEW."order_id", NEW."contract_id", NEW."customer_id",
        NEW."asset_owner_id", NEW."work_order_id", NEW."action_type", NEW."cost_category",
        NEW."responsible_party_type", NEW."responsible_party_id", NEW."asset_owner_snapshot",
        NEW."evidence_id", NEW."evidence_snapshot", NEW."responsibility_snapshot"
    ) IS DISTINCT FROM ROW(
        original."vehicle_id", original."order_id", original."contract_id", original."customer_id",
        original."asset_owner_id", original."work_order_id", original."action_type", original."cost_category",
        original."responsible_party_type", original."responsible_party_id", original."asset_owner_snapshot",
        original."evidence_id", original."evidence_snapshot", original."responsibility_snapshot"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'vehicle_cost_ledger_entry_reversal_reference_chk', MESSAGE = 'reversal must preserve the original accounting and authority references';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION "reject_asset_accounting_append_only_mutation"() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = format('%I is append-only', TG_TABLE_NAME);
END;
$$;

CREATE FUNCTION "enforce_business_exception_approval_transition"() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'business_exception_approval cannot be deleted';
    END IF;

    IF ROW(
        NEW."id", NEW."approval_no", NEW."exception_type", NEW."subject_type", NEW."subject_id",
        NEW."subject_field", NEW."subject_snapshot", NEW."subject_snapshot_hash", NEW."request_reason",
        NEW."request_evidence_snapshot", NEW."requested_by", NEW."requested_at", NEW."request_source_type",
        NEW."request_source_id", NEW."request_source_key", NEW."created_at"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."approval_no", OLD."exception_type", OLD."subject_type", OLD."subject_id",
        OLD."subject_field", OLD."subject_snapshot", OLD."subject_snapshot_hash", OLD."request_reason",
        OLD."request_evidence_snapshot", OLD."requested_by", OLD."requested_at", OLD."request_source_type",
        OLD."request_source_id", OLD."request_source_key", OLD."created_at"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'business_exception_approval request facts are immutable';
    END IF;

    IF NOT (
        (OLD."status" = 'PENDING' AND NEW."status" IN ('APPROVED', 'REJECTED', 'EXPIRED'))
        OR (OLD."status" = 'APPROVED' AND NEW."status" = 'EXPIRED')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'business_exception_approval has an invalid status transition';
    END IF;

    IF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'business_exception_approval version must increment by one';
    END IF;

    IF OLD."status" = 'APPROVED' AND ROW(
        NEW."decision", NEW."decision_comment", NEW."decided_by", NEW."decided_at"
    ) IS DISTINCT FROM ROW(
        OLD."decision", OLD."decision_comment", OLD."decided_by", OLD."decided_at"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'business_exception_approval decision facts are immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "vehicle_cost_ledger_entry_reversal_integrity"
    BEFORE INSERT ON "vehicle_cost_ledger_entry"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_vehicle_cost_ledger_reversal"();

CREATE TRIGGER "vehicle_cost_ledger_entry_append_only"
    BEFORE UPDATE OR DELETE ON "vehicle_cost_ledger_entry"
    FOR EACH ROW
    EXECUTE FUNCTION "reject_asset_accounting_append_only_mutation"();

CREATE TRIGGER "asset_accounting_command_receipt_append_only"
    BEFORE UPDATE OR DELETE ON "asset_accounting_command_receipt"
    FOR EACH ROW
    EXECUTE FUNCTION "reject_asset_accounting_append_only_mutation"();

CREATE TRIGGER "business_exception_approval_transition_only"
    BEFORE UPDATE OR DELETE ON "business_exception_approval"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_business_exception_approval_transition"();
