CREATE FUNCTION "enforce_subscription_closure_settlement_chronology"() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    database_clock TIMESTAMPTZ := clock_timestamp();
    predecessor "public"."subscription_closure_settlement_revision"%ROWTYPE;
BEGIN
    IF NEW."created_at" > database_clock
       OR (NEW."finalized_at" IS NOT NULL AND NEW."finalized_at" > database_clock)
       OR (NEW."settled_at" IS NOT NULL AND NEW."settled_at" > database_clock)
       OR (NEW."finalized_at" IS NOT NULL AND NEW."settled_at" IS NOT NULL
           AND NEW."settled_at" < NEW."finalized_at") THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'subscription_closure_settlement_chronology_chk',
            MESSAGE = 'settlement lifecycle timestamps must be chronological and no later than the database clock';
    END IF;

    IF NEW."stage" = 'PROPOSED' THEN
        RETURN NEW;
    END IF;

    IF NEW."supersedes_revision_id" IS NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'subscription_closure_settlement_chronology_chk',
            MESSAGE = 'finalized and settled revisions require an exact predecessor';
    END IF;

    SELECT *
    INTO predecessor
    FROM "public"."subscription_closure_settlement_revision"
    WHERE "id" = NEW."supersedes_revision_id";

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'subscription_closure_settlement_chronology_chk',
            MESSAGE = 'settlement predecessor was not found';
    END IF;

    IF NEW."stage" = 'FINALIZED'
       AND (predecessor."stage" <> 'PROPOSED'
            OR NEW."finalized_at" < predecessor."created_at") THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'subscription_closure_settlement_chronology_chk',
            MESSAGE = 'finalization cannot predate its proposed predecessor';
    END IF;

    IF NEW."stage" = 'SETTLED'
       AND (predecessor."stage" <> 'FINALIZED'
            OR predecessor."finalized_at" IS NULL
            OR predecessor."finalized_by" IS NULL
            OR NEW."finalized_at" IS DISTINCT FROM predecessor."finalized_at"
            OR NEW."finalized_by" IS DISTINCT FROM predecessor."finalized_by"
            OR NEW."settled_at" < predecessor."finalized_at") THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'subscription_closure_settlement_chronology_chk',
            MESSAGE = 'settlement cannot predate or rewrite its finalized predecessor';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_closure_settlement_chronology"
    BEFORE INSERT ON "subscription_closure_settlement_revision"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_subscription_closure_settlement_chronology"();
