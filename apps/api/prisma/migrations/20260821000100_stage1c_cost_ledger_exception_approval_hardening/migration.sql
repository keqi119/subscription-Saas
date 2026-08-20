-- Forward-only hardening for the already-applied Stage 1C-C persistence facts.
ALTER TABLE "public"."vehicle_cost_ledger_entry"
    ALTER COLUMN "confirmed_by" SET NOT NULL;

ALTER TABLE "public"."business_exception_approval"
    DROP CONSTRAINT "business_exception_approval_status_shape_chk";

ALTER TABLE "public"."business_exception_approval"
    ADD CONSTRAINT "business_exception_approval_status_shape_chk" CHECK (
        ("status" = 'PENDING' AND "decision" IS NULL AND "decision_comment" IS NULL AND "decided_by" IS NULL AND "decided_at" IS NULL AND "expiry_reason" IS NULL AND "expired_by" IS NULL AND "expired_at" IS NULL)
        OR ("status" = 'APPROVED' AND "decision" = 'APPROVED' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "expiry_reason" IS NULL AND "expired_by" IS NULL AND "expired_at" IS NULL)
        OR ("status" = 'REJECTED' AND "decision" = 'REJECTED' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "expiry_reason" IS NULL AND "expired_by" IS NULL AND "expired_at" IS NULL)
        OR ("status" = 'EXPIRED' AND "expiry_reason" IS NOT NULL AND "expired_by" IS NOT NULL AND "expired_at" IS NOT NULL AND (
            ("decision" IS NULL AND "decision_comment" IS NULL AND "decided_by" IS NULL AND "decided_at" IS NULL)
            OR ("decision" = 'APPROVED' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
        ))
    );

CREATE OR REPLACE FUNCTION "public"."enforce_vehicle_cost_ledger_reversal"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    original "public"."vehicle_cost_ledger_entry"%ROWTYPE;
BEGIN
    IF NEW."entry_kind" <> 'REVERSAL' THEN
        RETURN NEW;
    END IF;

    SELECT * INTO original
    FROM "public"."vehicle_cost_ledger_entry"
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

CREATE OR REPLACE FUNCTION "public"."reject_asset_accounting_append_only_mutation"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = format('%I is append-only', TG_TABLE_NAME);
END;
$$;

CREATE OR REPLACE FUNCTION "public"."enforce_business_exception_approval_transition"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT (
            NEW."status" = 'PENDING' AND NEW."version" = 0
            AND NEW."decision" IS NULL AND NEW."decision_comment" IS NULL
            AND NEW."decided_by" IS NULL AND NEW."decided_at" IS NULL
            AND NEW."expiry_reason" IS NULL AND NEW."expired_by" IS NULL AND NEW."expired_at" IS NULL
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'business_exception_approval must be inserted as a new pending request';
        END IF;

        RETURN NEW;
    END IF;

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

DROP TRIGGER "vehicle_cost_ledger_entry_reversal_integrity" ON "public"."vehicle_cost_ledger_entry";
CREATE TRIGGER "vehicle_cost_ledger_entry_reversal_integrity"
    BEFORE INSERT ON "public"."vehicle_cost_ledger_entry"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."enforce_vehicle_cost_ledger_reversal"();

DROP TRIGGER "vehicle_cost_ledger_entry_append_only" ON "public"."vehicle_cost_ledger_entry";
CREATE TRIGGER "vehicle_cost_ledger_entry_append_only"
    BEFORE UPDATE OR DELETE ON "public"."vehicle_cost_ledger_entry"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."reject_asset_accounting_append_only_mutation"();

DROP TRIGGER "asset_accounting_command_receipt_append_only" ON "public"."asset_accounting_command_receipt";
CREATE TRIGGER "asset_accounting_command_receipt_append_only"
    BEFORE UPDATE OR DELETE ON "public"."asset_accounting_command_receipt"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."reject_asset_accounting_append_only_mutation"();

DROP TRIGGER "business_exception_approval_transition_only" ON "public"."business_exception_approval";
CREATE TRIGGER "business_exception_approval_transition_only"
    BEFORE INSERT OR UPDATE OR DELETE ON "public"."business_exception_approval"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."enforce_business_exception_approval_transition"();
