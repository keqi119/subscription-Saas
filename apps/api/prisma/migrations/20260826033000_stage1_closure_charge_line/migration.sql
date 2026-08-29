CREATE TYPE "subscription_closure_charge_status" AS ENUM (
  'PREVIEW', 'FINAL', 'PRICING_EXCEPTION', 'SUPERSEDED'
);

CREATE TABLE "subscription_closure_charge_line" (
  "id" UUID NOT NULL,
  "closure_case_id" UUID NOT NULL,
  "settlement_revision_id" UUID NOT NULL,
  "line_code" VARCHAR(64) NOT NULL,
  "charge_type" VARCHAR(64) NOT NULL,
  "status" "subscription_closure_charge_status" NOT NULL DEFAULT 'PREVIEW',
  "delta_revision_id" UUID,
  "delta_item_id" UUID,
  "contract_id" UUID NOT NULL,
  "clause_snapshot_id" UUID,
  "quantity" DECIMAL(18,6) NOT NULL,
  "unit_price_cents" BIGINT NOT NULL,
  "amount_cents" BIGINT NOT NULL,
  "calculation_snapshot" JSONB NOT NULL,
  "calculation_hash" VARCHAR(64) NOT NULL,
  "responsibility" "vehicle_condition_responsibility" NOT NULL,
  "evidence_snapshot" JSONB NOT NULL,
  "exception_approval_id" UUID,
  "bill_id" UUID,
  "supersedes_line_id" UUID,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_closure_charge_line_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_closure_charge_line_revision_code_key" UNIQUE ("settlement_revision_id", "line_code"),
  CONSTRAINT "subscription_closure_charge_line_supersedes_key" UNIQUE ("supersedes_line_id"),
  CONSTRAINT "subscription_closure_charge_line_hash_check" CHECK ("calculation_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "subscription_closure_charge_line_amount_check" CHECK ("quantity" >= 0 AND "unit_price_cents" >= 0 AND "amount_cents" >= 0),
  CONSTRAINT "subscription_closure_charge_line_authority_check" CHECK (
    ("status" = 'PRICING_EXCEPTION' AND "clause_snapshot_id" IS NULL)
    OR ("status" <> 'PRICING_EXCEPTION' AND "clause_snapshot_id" IS NOT NULL)
  )
);

ALTER TABLE "subscription_closure_charge_line"
  ADD CONSTRAINT "subscription_closure_charge_line_case_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_charge_line_settlement_fkey" FOREIGN KEY ("settlement_revision_id") REFERENCES "subscription_closure_settlement_revision"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_charge_line_delta_revision_fkey" FOREIGN KEY ("delta_revision_id") REFERENCES "vehicle_condition_delta_revision"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_charge_line_delta_item_fkey" FOREIGN KEY ("delta_item_id") REFERENCES "vehicle_condition_delta_item"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_charge_line_contract_fkey" FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_charge_line_clause_fkey" FOREIGN KEY ("clause_snapshot_id") REFERENCES "contract_charge_clause_snapshot"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_charge_line_exception_fkey" FOREIGN KEY ("exception_approval_id") REFERENCES "business_exception_approval"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_charge_line_bill_fkey" FOREIGN KEY ("bill_id") REFERENCES "receivable_bill"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_charge_line_supersedes_fkey" FOREIGN KEY ("supersedes_line_id") REFERENCES "subscription_closure_charge_line"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_charge_line_actor_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;
CREATE INDEX "subscription_closure_charge_line_case_status_idx" ON "subscription_closure_charge_line"("closure_case_id", "status");
CREATE INDEX "subscription_closure_charge_line_bill_idx" ON "subscription_closure_charge_line"("bill_id");
CREATE TRIGGER "subscription_closure_charge_line_append_only"
  BEFORE UPDATE OR DELETE ON "subscription_closure_charge_line"
  FOR EACH ROW EXECUTE FUNCTION "stage1_return_append_only_guard"();
