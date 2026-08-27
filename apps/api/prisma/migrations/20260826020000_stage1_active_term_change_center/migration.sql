ALTER TYPE "subscription_change_type" ADD VALUE 'VEHICLE_SWAP';
ALTER TYPE "subscription_change_type" ADD VALUE 'EARLY_TERMINATION';
ALTER TYPE "subscription_change_type" ADD VALUE 'MANAGED_OTHER';

ALTER TABLE "subscription_change_order"
  ALTER COLUMN "source_segment_id" DROP NOT NULL,
  ALTER COLUMN "extension_months" DROP NOT NULL,
  ALTER COLUMN "pricing_mode" DROP NOT NULL,
  ALTER COLUMN "target_start_date" DROP NOT NULL,
  ALTER COLUMN "target_end_date" DROP NOT NULL;

DROP INDEX "subscription_change_order_one_active_per_order";
CREATE UNIQUE INDEX "subscription_change_order_one_active_per_order"
ON "subscription_change_order" ("order_id")
WHERE "status" IN (
  'DRAFT',
  'QUOTED',
  'CUSTOMER_CONFIRMED',
  'SIGNING_OR_PAYMENT',
  'SCHEDULED',
  'EXECUTING',
  'MANUAL_TAKEOVER'
);

CREATE TABLE "subscription_extension_change_detail" (
  "id" UUID NOT NULL,
  "change_order_id" UUID NOT NULL,
  "source_segment_id" UUID NOT NULL,
  "extension_months" INTEGER NOT NULL,
  "pricing_mode" "subscription_change_pricing_mode" NOT NULL,
  "target_start_date" DATE NOT NULL,
  "target_end_date" DATE NOT NULL,
  "price_override_reason" TEXT,
  "price_override_approved_by" UUID,
  "price_override_approved_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "subscription_extension_change_detail_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_extension_change_detail_months_positive"
    CHECK ("extension_months" > 0),
  CONSTRAINT "subscription_extension_change_detail_dates_valid"
    CHECK ("target_end_date" >= "target_start_date")
);

CREATE TABLE "subscription_vehicle_swap_change_detail" (
  "id" UUID NOT NULL,
  "change_order_id" UUID NOT NULL,
  "source_vehicle_id" UUID NOT NULL,
  "target_vehicle_id" UUID NOT NULL,
  "target_subscription_plan_id" UUID NOT NULL,
  "target_vehicle_package_id" UUID NOT NULL,
  "planned_swap_at" TIMESTAMPTZ(6) NOT NULL,
  "actual_swap_at" TIMESTAMPTZ(6),
  "inbound_work_order_id" UUID,
  "outbound_work_order_id" UUID,
  "commercial_snapshot" JSONB NOT NULL,
  "commercial_snapshot_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "subscription_vehicle_swap_change_detail_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_vehicle_swap_change_detail_distinct_vehicles"
    CHECK ("source_vehicle_id" <> "target_vehicle_id"),
  CONSTRAINT "subscription_vehicle_swap_change_detail_hash_format"
    CHECK ("commercial_snapshot_hash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "subscription_early_termination_change_detail" (
  "id" UUID NOT NULL,
  "change_order_id" UUID NOT NULL,
  "effective_date" DATE NOT NULL,
  "reason_snapshot" JSONB NOT NULL,
  "estimated_settlement_revision" INTEGER,
  "agreement_contract_id" UUID,
  "closure_case_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "subscription_early_termination_change_detail_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_early_termination_revision_nonnegative"
    CHECK (
      "estimated_settlement_revision" IS NULL
      OR "estimated_settlement_revision" >= 0
    )
);

CREATE TABLE "subscription_managed_other_change_detail" (
  "id" UUID NOT NULL,
  "change_order_id" UUID NOT NULL,
  "reason" TEXT NOT NULL,
  "effective_date" DATE NOT NULL,
  "evidence_snapshot" JSONB NOT NULL,
  "approved_operation_snapshot" JSONB NOT NULL,
  "before_snapshot" JSONB NOT NULL,
  "after_snapshot" JSONB,
  "supplement_contract_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "subscription_managed_other_change_detail_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_managed_other_change_detail_reason_required"
    CHECK (length(btrim("reason")) > 0)
);

CREATE UNIQUE INDEX "subscription_extension_change_detail_change_order_id_key"
ON "subscription_extension_change_detail"("change_order_id");
CREATE INDEX "subscription_extension_change_detail_source_segment_id_idx"
ON "subscription_extension_change_detail"("source_segment_id");
CREATE INDEX "subscription_extension_change_detail_price_approver_idx"
ON "subscription_extension_change_detail"("price_override_approved_by");

CREATE UNIQUE INDEX "subscription_vehicle_swap_change_detail_change_order_id_key"
ON "subscription_vehicle_swap_change_detail"("change_order_id");
CREATE UNIQUE INDEX "subscription_vehicle_swap_change_detail_inbound_work_order_id_key"
ON "subscription_vehicle_swap_change_detail"("inbound_work_order_id");
CREATE UNIQUE INDEX "subscription_vehicle_swap_change_detail_outbound_work_order_id_key"
ON "subscription_vehicle_swap_change_detail"("outbound_work_order_id");
CREATE INDEX "subscription_vehicle_swap_change_detail_source_vehicle_id_idx"
ON "subscription_vehicle_swap_change_detail"("source_vehicle_id");
CREATE INDEX "subscription_vehicle_swap_change_detail_target_vehicle_id_idx"
ON "subscription_vehicle_swap_change_detail"("target_vehicle_id");
CREATE INDEX "subscription_vehicle_swap_change_detail_target_plan_id_idx"
ON "subscription_vehicle_swap_change_detail"("target_subscription_plan_id");
CREATE INDEX "subscription_vehicle_swap_change_detail_target_package_id_idx"
ON "subscription_vehicle_swap_change_detail"("target_vehicle_package_id");
CREATE INDEX "subscription_vehicle_swap_change_detail_planned_swap_at_idx"
ON "subscription_vehicle_swap_change_detail"("planned_swap_at");

CREATE UNIQUE INDEX "subscription_early_termination_detail_change_order_id_key"
ON "subscription_early_termination_change_detail"("change_order_id");
CREATE UNIQUE INDEX "subscription_early_termination_detail_agreement_id_key"
ON "subscription_early_termination_change_detail"("agreement_contract_id");
CREATE UNIQUE INDEX "subscription_early_termination_detail_closure_case_id_key"
ON "subscription_early_termination_change_detail"("closure_case_id");
CREATE INDEX "subscription_early_termination_detail_effective_date_idx"
ON "subscription_early_termination_change_detail"("effective_date");

CREATE UNIQUE INDEX "subscription_managed_other_detail_change_order_id_key"
ON "subscription_managed_other_change_detail"("change_order_id");
CREATE UNIQUE INDEX "subscription_managed_other_detail_supplement_id_key"
ON "subscription_managed_other_change_detail"("supplement_contract_id");
CREATE INDEX "subscription_managed_other_detail_effective_date_idx"
ON "subscription_managed_other_change_detail"("effective_date");

ALTER TABLE "subscription_extension_change_detail"
ADD CONSTRAINT "subscription_extension_detail_change_order_id_fkey"
FOREIGN KEY ("change_order_id") REFERENCES "subscription_change_order"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_extension_change_detail"
ADD CONSTRAINT "subscription_extension_detail_source_segment_id_fkey"
FOREIGN KEY ("source_segment_id") REFERENCES "subscription_contract_segment"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_extension_change_detail"
ADD CONSTRAINT "subscription_extension_detail_price_approver_fkey"
FOREIGN KEY ("price_override_approved_by") REFERENCES "user"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "subscription_vehicle_swap_change_detail"
ADD CONSTRAINT "subscription_vehicle_swap_detail_change_order_id_fkey"
FOREIGN KEY ("change_order_id") REFERENCES "subscription_change_order"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_vehicle_swap_change_detail"
ADD CONSTRAINT "subscription_vehicle_swap_detail_source_vehicle_id_fkey"
FOREIGN KEY ("source_vehicle_id") REFERENCES "vehicle"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_vehicle_swap_change_detail"
ADD CONSTRAINT "subscription_vehicle_swap_detail_target_vehicle_id_fkey"
FOREIGN KEY ("target_vehicle_id") REFERENCES "vehicle"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_vehicle_swap_change_detail"
ADD CONSTRAINT "subscription_vehicle_swap_detail_target_plan_id_fkey"
FOREIGN KEY ("target_subscription_plan_id") REFERENCES "subscription_plan"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_vehicle_swap_change_detail"
ADD CONSTRAINT "subscription_vehicle_swap_detail_target_package_id_fkey"
FOREIGN KEY ("target_vehicle_package_id") REFERENCES "vehicle_package"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_vehicle_swap_change_detail"
ADD CONSTRAINT "subscription_vehicle_swap_detail_inbound_work_order_id_fkey"
FOREIGN KEY ("inbound_work_order_id") REFERENCES "asset_work_order"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_vehicle_swap_change_detail"
ADD CONSTRAINT "subscription_vehicle_swap_detail_outbound_work_order_id_fkey"
FOREIGN KEY ("outbound_work_order_id") REFERENCES "asset_work_order"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_early_termination_change_detail"
ADD CONSTRAINT "subscription_early_termination_detail_change_order_id_fkey"
FOREIGN KEY ("change_order_id") REFERENCES "subscription_change_order"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_early_termination_change_detail"
ADD CONSTRAINT "subscription_early_termination_detail_agreement_id_fkey"
FOREIGN KEY ("agreement_contract_id") REFERENCES "contract"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_early_termination_change_detail"
ADD CONSTRAINT "subscription_early_termination_detail_closure_case_id_fkey"
FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_managed_other_change_detail"
ADD CONSTRAINT "subscription_managed_other_detail_change_order_id_fkey"
FOREIGN KEY ("change_order_id") REFERENCES "subscription_change_order"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_managed_other_change_detail"
ADD CONSTRAINT "subscription_managed_other_detail_supplement_id_fkey"
FOREIGN KEY ("supplement_contract_id") REFERENCES "contract"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "subscription_extension_change_detail" (
  "id",
  "change_order_id",
  "source_segment_id",
  "extension_months",
  "pricing_mode",
  "target_start_date",
  "target_end_date",
  "price_override_reason",
  "price_override_approved_by",
  "price_override_approved_at",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  "id",
  "source_segment_id",
  "extension_months",
  "pricing_mode",
  "target_start_date",
  "target_end_date",
  "price_override_reason",
  "price_override_approved_by",
  "price_override_approved_at",
  "created_at",
  "updated_at"
FROM "subscription_change_order"
WHERE "change_type" = 'EXTENSION';

CREATE FUNCTION "assert_subscription_change_detail_shape"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  change_id UUID;
  root_type TEXT;
  detail_count INTEGER;
  detail_type TEXT;
BEGIN
  IF TG_TABLE_NAME = 'subscription_change_order' THEN
    change_id := COALESCE(NEW."id", OLD."id");
  ELSE
    change_id := COALESCE(NEW."change_order_id", OLD."change_order_id");
  END IF;

  SELECT "change_type"::text
  INTO root_type
  FROM "subscription_change_order"
  WHERE "id" = change_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*), min(candidate."detail_type")
  INTO detail_count, detail_type
  FROM (
    SELECT 'EXTENSION'::text AS "detail_type"
    FROM "subscription_extension_change_detail"
    WHERE "change_order_id" = change_id
    UNION ALL
    SELECT 'VEHICLE_SWAP'::text
    FROM "subscription_vehicle_swap_change_detail"
    WHERE "change_order_id" = change_id
    UNION ALL
    SELECT 'EARLY_TERMINATION'::text
    FROM "subscription_early_termination_change_detail"
    WHERE "change_order_id" = change_id
    UNION ALL
    SELECT 'MANAGED_OTHER'::text
    FROM "subscription_managed_other_change_detail"
    WHERE "change_order_id" = change_id
  ) AS candidate;

  IF detail_count <> 1 OR detail_type <> root_type THEN
    RAISE EXCEPTION
      'subscription_change_detail_shape: change % expects %, found % detail row(s) of type %',
      change_id,
      root_type,
      detail_count,
      COALESCE(detail_type, 'NONE')
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_change_order_detail_shape"
AFTER INSERT OR UPDATE OF "change_type" ON "subscription_change_order"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_subscription_change_detail_shape"();

CREATE CONSTRAINT TRIGGER "subscription_extension_detail_shape"
AFTER INSERT OR UPDATE OR DELETE ON "subscription_extension_change_detail"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_subscription_change_detail_shape"();

CREATE CONSTRAINT TRIGGER "subscription_vehicle_swap_detail_shape"
AFTER INSERT OR UPDATE OR DELETE ON "subscription_vehicle_swap_change_detail"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_subscription_change_detail_shape"();

CREATE CONSTRAINT TRIGGER "subscription_early_termination_detail_shape"
AFTER INSERT OR UPDATE OR DELETE ON "subscription_early_termination_change_detail"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_subscription_change_detail_shape"();

CREATE CONSTRAINT TRIGGER "subscription_managed_other_detail_shape"
AFTER INSERT OR UPDATE OR DELETE ON "subscription_managed_other_change_detail"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_subscription_change_detail_shape"();

CREATE FUNCTION "prevent_subscription_change_detail_reassignment"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."change_order_id" <> OLD."change_order_id" THEN
    RAISE EXCEPTION 'subscription change detail cannot be reassigned'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_extension_detail_no_reassignment"
BEFORE UPDATE ON "subscription_extension_change_detail"
FOR EACH ROW EXECUTE FUNCTION "prevent_subscription_change_detail_reassignment"();
CREATE TRIGGER "subscription_vehicle_swap_detail_no_reassignment"
BEFORE UPDATE ON "subscription_vehicle_swap_change_detail"
FOR EACH ROW EXECUTE FUNCTION "prevent_subscription_change_detail_reassignment"();
CREATE TRIGGER "subscription_early_termination_detail_no_reassignment"
BEFORE UPDATE ON "subscription_early_termination_change_detail"
FOR EACH ROW EXECUTE FUNCTION "prevent_subscription_change_detail_reassignment"();
CREATE TRIGGER "subscription_managed_other_detail_no_reassignment"
BEFORE UPDATE ON "subscription_managed_other_change_detail"
FOR EACH ROW EXECUTE FUNCTION "prevent_subscription_change_detail_reassignment"();
