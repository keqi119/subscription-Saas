-- Correct document-family projections and make successor/current invariants atomic at commit.

DROP INDEX "subscription_closure_document_revision_case_revision_key";

CREATE UNIQUE INDEX "subscription_closure_document_family_revision_key"
    ON "subscription_closure_document_revision"("closure_case_id", "document_type", "revision_number");

CREATE TABLE "subscription_closure_current_document" (
    "closure_case_id" UUID NOT NULL,
    "document_type" "subscription_closure_document_type" NOT NULL,
    "document_revision_id" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "subscription_closure_current_document_pkey" PRIMARY KEY ("closure_case_id", "document_type")
);

CREATE UNIQUE INDEX "subscription_closure_current_document_revision_id_key"
    ON "subscription_closure_current_document"("document_revision_id");
CREATE INDEX "subscription_closure_current_document_updated_by_idx"
    ON "subscription_closure_current_document"("updated_by");

ALTER TABLE "subscription_closure_current_document"
    ADD CONSTRAINT "subscription_closure_current_document_closure_case_id_fkey"
    FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "subscription_closure_current_document_document_revision_id_fkey"
    FOREIGN KEY ("document_revision_id") REFERENCES "subscription_closure_document_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "subscription_closure_current_document_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "subscription_closure_current_document" (
    "closure_case_id", "document_type", "document_revision_id", "updated_by", "updated_at"
)
SELECT DISTINCT ON (revision."closure_case_id", revision."document_type")
    revision."closure_case_id",
    revision."document_type",
    revision."id",
    revision."generated_by",
    revision."created_at"
FROM "subscription_closure_document_revision" revision
ORDER BY revision."closure_case_id", revision."document_type", revision."revision_number" DESC;

CREATE OR REPLACE FUNCTION "enforce_subscription_closure_document_revision_chain"() RETURNS TRIGGER
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

    IF NOT FOUND
        OR previous_revision."closure_case_id" IS DISTINCT FROM NEW."closure_case_id"
        OR previous_revision."document_type" IS DISTINCT FROM NEW."document_type"
        OR previous_revision."revision_number" IS DISTINCT FROM NEW."revision_number" - 1 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_document_revision_chain_chk', MESSAGE = 'document predecessor must be the immediately prior revision in the same closure case and document family';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_subscription_closure_current_document_authority"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    revision_case_id UUID;
    revision_type "public"."subscription_closure_document_type";
    pointed_revision_number INTEGER;
    maximum_revision INTEGER;
BEGIN
    SELECT revision."closure_case_id", revision."document_type", revision."revision_number"
    INTO revision_case_id, revision_type, pointed_revision_number
    FROM "public"."subscription_closure_document_revision" revision
    WHERE revision."id" = NEW."document_revision_id"
    FOR KEY SHARE;

    SELECT max(revision."revision_number") INTO maximum_revision
    FROM "public"."subscription_closure_document_revision" revision
    WHERE revision."closure_case_id" = NEW."closure_case_id"
      AND revision."document_type" = NEW."document_type";

    IF revision_case_id IS DISTINCT FROM NEW."closure_case_id"
        OR revision_type IS DISTINCT FROM NEW."document_type"
        OR pointed_revision_number IS DISTINCT FROM maximum_revision THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_document_current_revision_family_chk', MESSAGE = 'current document must point to the latest revision in the same case and document family';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_subscription_closure_document_current_deferred"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    affected_case_id UUID;
    affected_document_type "public"."subscription_closure_document_type";
    latest_revision_id UUID;
    current_revision_id UUID;
BEGIN
    IF TG_TABLE_NAME = 'subscription_closure_document_revision' OR TG_OP <> 'DELETE' THEN
        affected_case_id := NEW."closure_case_id";
        affected_document_type := NEW."document_type";
    ELSE
        affected_case_id := OLD."closure_case_id";
        affected_document_type := OLD."document_type";
    END IF;

    SELECT "id" INTO latest_revision_id
    FROM "public"."subscription_closure_document_revision"
    WHERE "closure_case_id" = affected_case_id
      AND "document_type" = affected_document_type
    ORDER BY "revision_number" DESC
    LIMIT 1;

    SELECT "document_revision_id" INTO current_revision_id
    FROM "public"."subscription_closure_current_document"
    WHERE "closure_case_id" = affected_case_id
      AND "document_type" = affected_document_type;

    IF latest_revision_id IS NOT NULL AND current_revision_id IS DISTINCT FROM latest_revision_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_document_current_deferred_chk', MESSAGE = 'every document successor must atomically become the current revision for its family';
    END IF;

    RETURN NULL;
END;
$$;

CREATE TRIGGER "subscription_closure_current_document_authority"
    BEFORE INSERT OR UPDATE ON "subscription_closure_current_document"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_subscription_closure_current_document_authority"();

CREATE CONSTRAINT TRIGGER "subscription_closure_document_revision_current_deferred"
    AFTER INSERT ON "subscription_closure_document_revision"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_subscription_closure_document_current_deferred"();

CREATE CONSTRAINT TRIGGER "subscription_closure_document_current_deferred"
    AFTER INSERT OR UPDATE OR DELETE ON "subscription_closure_current_document"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_subscription_closure_document_current_deferred"();

CREATE FUNCTION "enforce_subscription_closure_settlement_current_deferred"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    latest_revision_id UUID;
    current_revision_id UUID;
BEGIN
    SELECT "id" INTO latest_revision_id
    FROM "public"."subscription_closure_settlement_revision"
    WHERE "closure_case_id" = NEW."closure_case_id"
    ORDER BY "revision_number" DESC
    LIMIT 1;

    SELECT "current_settlement_revision_id" INTO current_revision_id
    FROM "public"."subscription_closure_case"
    WHERE "id" = NEW."closure_case_id";

    IF current_revision_id IS DISTINCT FROM latest_revision_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_settlement_current_deferred_chk', MESSAGE = 'every settlement successor must atomically become the case current settlement revision';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_closure_settlement_revision_current_deferred"
    AFTER INSERT ON "subscription_closure_settlement_revision"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_subscription_closure_settlement_current_deferred"();

CREATE OR REPLACE FUNCTION "enforce_subscription_closure_current_revision_integrity"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    pointed_case_id UUID;
    pointed_revision INTEGER;
    maximum_revision INTEGER;
BEGIN
    IF NEW."current_document_revision_id" IS NOT NULL THEN
        SELECT "closure_case_id" INTO pointed_case_id
        FROM "public"."subscription_closure_document_revision"
        WHERE "id" = NEW."current_document_revision_id"
        FOR KEY SHARE;
        IF pointed_case_id IS DISTINCT FROM NEW."id" THEN
            RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_case_current_document_case_chk', MESSAGE = 'legacy current document revision must belong to the same closure case';
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

CREATE FUNCTION "enforce_subscription_closure_case_deferred_settlement"() RETURNS TRIGGER
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
BEGIN
    SELECT closure_case."current_settlement_revision_id", closure_case."status"
    INTO current_revision_id, current_status
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
            OR current_stage IS DISTINCT FROM 'SETTLED' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_terminal_settlement_deferred_chk', MESSAGE = 'terminal closure requires the case current FINAL settlement revision at SETTLED stage';
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_closure_case_settlement_deferred"
    AFTER INSERT OR UPDATE ON "subscription_closure_case"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_subscription_closure_case_deferred_settlement"();

CREATE FUNCTION "enforce_subscription_closure_case_authority"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "public"."subscription_order" governed_order
        WHERE governed_order."id" = NEW."order_id"
          AND governed_order."customer_id" = NEW."customer_id"
          AND governed_order."vehicle_id" = NEW."vehicle_id"
          AND governed_order."contract_id" = NEW."contract_id"
    ) OR NOT EXISTS (
        SELECT 1 FROM "public"."contract" governed_contract
        WHERE governed_contract."id" = NEW."contract_id"
          AND governed_contract."order_id" = NEW."order_id"
          AND governed_contract."customer_id" = NEW."customer_id"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_case_authority_chk', MESSAGE = 'closure order, vehicle, customer, and contract authorities must agree';
    END IF;

    IF NEW."vehicle_return_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "public"."vehicle_return" governed_return
        WHERE governed_return."id" = NEW."vehicle_return_id"
          AND governed_return."order_id" = NEW."order_id"
          AND governed_return."vehicle_id" = NEW."vehicle_id"
          AND governed_return."customer_id" = NEW."customer_id"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_case_authority_chk', MESSAGE = 'closure vehicle return must belong to the governed order, vehicle, and customer';
    END IF;

    IF NEW."return_handover_work_order_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "public"."vehicle_handover_work_order" governed_handover
        WHERE governed_handover."id" = NEW."return_handover_work_order_id"
          AND governed_handover."order_id" = NEW."order_id"
          AND governed_handover."handover_type" = 'RETURN_INBOUND'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_case_authority_chk', MESSAGE = 'closure return handover must be RETURN_INBOUND for the governed order';
    END IF;

    IF NEW."return_asset_work_order_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "public"."asset_work_order" governed_work_order
        WHERE governed_work_order."id" = NEW."return_asset_work_order_id"
          AND governed_work_order."order_id" = NEW."order_id"
          AND governed_work_order."vehicle_id" = NEW."vehicle_id"
          AND governed_work_order."contract_id" = NEW."contract_id"
          AND governed_work_order."customer_id" = NEW."customer_id"
          AND governed_work_order."work_order_type" = 'RETURN_INBOUND'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_case_authority_chk', MESSAGE = 'closure return work order authority mismatch';
    END IF;

    IF NEW."recovery_asset_work_order_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "public"."asset_work_order" governed_work_order
        WHERE governed_work_order."id" = NEW."recovery_asset_work_order_id"
          AND governed_work_order."order_id" = NEW."order_id"
          AND governed_work_order."vehicle_id" = NEW."vehicle_id"
          AND governed_work_order."contract_id" = NEW."contract_id"
          AND governed_work_order."customer_id" = NEW."customer_id"
          AND governed_work_order."work_order_type" = 'RECOVERY'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_case_authority_chk', MESSAGE = 'closure recovery work order authority mismatch';
    END IF;

    IF NEW."reconditioning_asset_work_order_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "public"."asset_work_order" governed_work_order
        WHERE governed_work_order."id" = NEW."reconditioning_asset_work_order_id"
          AND governed_work_order."order_id" = NEW."order_id"
          AND governed_work_order."vehicle_id" = NEW."vehicle_id"
          AND governed_work_order."contract_id" = NEW."contract_id"
          AND governed_work_order."customer_id" = NEW."customer_id"
          AND governed_work_order."work_order_type" = 'RECONDITIONING'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'subscription_closure_case_authority_chk', MESSAGE = 'closure reconditioning work order authority mismatch';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_closure_case_authority"
    BEFORE INSERT OR UPDATE ON "subscription_closure_case"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_subscription_closure_case_authority"();
