-- Forward-only correction: reversals retain the original occurrence date and accounting period.
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
        NEW."asset_owner_id", NEW."work_order_id", NEW."occurred_on", NEW."accounting_period",
        NEW."action_type", NEW."cost_category", NEW."responsible_party_type", NEW."responsible_party_id",
        NEW."asset_owner_snapshot", NEW."evidence_id", NEW."evidence_snapshot", NEW."responsibility_snapshot"
    ) IS DISTINCT FROM ROW(
        original."vehicle_id", original."order_id", original."contract_id", original."customer_id",
        original."asset_owner_id", original."work_order_id", original."occurred_on", original."accounting_period",
        original."action_type", original."cost_category", original."responsible_party_type", original."responsible_party_id",
        original."asset_owner_snapshot", original."evidence_id", original."evidence_snapshot", original."responsibility_snapshot"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'vehicle_cost_ledger_entry_reversal_reference_chk', MESSAGE = 'reversal must preserve the original accounting and authority references';
    END IF;

    RETURN NEW;
END;
$$;
