ALTER TABLE "billing_schedule"
  ADD COLUMN "service_end_date" DATE;

ALTER TABLE "subscription_closure_case"
  ADD COLUMN "retired_at" TIMESTAMPTZ(6),
  ADD COLUMN "retired_by" UUID;

DROP INDEX "subscription_closure_case_order_id_key";

CREATE INDEX "subscription_closure_case_order_id_idx"
  ON "subscription_closure_case"("order_id");

CREATE UNIQUE INDEX "subscription_closure_case_order_id_key"
  ON "subscription_closure_case"("order_id")
  WHERE "retired_at" IS NULL;

CREATE INDEX "subscription_closure_case_retired_by_idx"
  ON "subscription_closure_case"("retired_by");

ALTER TABLE "subscription_closure_case"
  ADD CONSTRAINT "subscription_closure_case_retired_shape_chk"
  CHECK (
    (
      "retired_at" IS NULL
      AND "retired_by" IS NULL
    )
    OR
    (
      "retired_at" IS NOT NULL
      AND "retired_by" IS NOT NULL
      AND "closure_type" = 'EARLY_TERMINATION'
      AND "status" = 'CANCELLED'
      AND "vehicle_return_id" IS NULL
      AND "return_handover_work_order_id" IS NULL
      AND "return_asset_work_order_id" IS NULL
      AND "recovery_asset_work_order_id" IS NULL
      AND "reconditioning_asset_work_order_id" IS NULL
      AND "physical_controlled_at" IS NULL
      AND "settled_at" IS NULL
      AND "current_settlement_revision_id" IS NULL
    )
  );

ALTER TABLE "subscription_closure_case"
  ADD CONSTRAINT "subscription_closure_case_retired_by_fkey"
  FOREIGN KEY ("retired_by") REFERENCES "user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
