-- Keep current/latest/same-case FINAL authority while allowing the published
-- financial plan to outlive operational completion. Legacy settlement still
-- requires SETTLED when no operational completion has been recorded.
CREATE OR REPLACE FUNCTION "enforce_subscription_closure_case_deferred_settlement"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    latest_revision_id UUID;
    current_revision_id UUID;
    current_status "public"."subscription_closure_status";
    current_type "public"."subscription_closure_settlement_type";
    current_stage "public"."subscription_closure_settlement_stage";
    current_case_id UUID;
    current_operational_completed_at TIMESTAMPTZ;
BEGIN
    SELECT closure_case."current_settlement_revision_id", closure_case."status",
           closure_case."operational_completed_at"
    INTO current_revision_id, current_status, current_operational_completed_at
    FROM "public"."subscription_closure_case" closure_case
    WHERE closure_case."id" = NEW."id";

    SELECT "id" INTO latest_revision_id
    FROM "public"."subscription_closure_settlement_revision"
    WHERE "closure_case_id" = NEW."id"
    ORDER BY "revision_number" DESC
    LIMIT 1;

    IF latest_revision_id IS NOT NULL AND current_revision_id IS DISTINCT FROM latest_revision_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_settlement_current_deferred_chk', MESSAGE = 'case current settlement must point to its latest settlement revision';
    END IF;

    IF current_status IN ('COMPLETED', 'TERMINATED') THEN
        SELECT "closure_case_id", "settlement_type", "stage"
        INTO current_case_id, current_type, current_stage
        FROM "public"."subscription_closure_settlement_revision"
        WHERE "id" = current_revision_id;

        IF current_revision_id IS NULL
            OR current_case_id IS DISTINCT FROM NEW."id"
            OR current_type IS DISTINCT FROM 'FINAL'
            OR (
                current_stage IS DISTINCT FROM 'SETTLED'
                AND (current_stage IS DISTINCT FROM 'FINALIZED' OR current_operational_completed_at IS NULL)
            ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_terminal_settlement_deferred_chk', MESSAGE = 'terminal closure requires its current FINAL settlement at SETTLED stage or FINALIZED stage after operational completion';
        END IF;
    END IF;

    RETURN NULL;
END;
$$;
