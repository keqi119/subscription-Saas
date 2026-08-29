CREATE TYPE "contract_charge_clause_status" AS ENUM (
  'EXECUTABLE', 'MANUAL_CLAUSE_REVIEW_REQUIRED'
);

CREATE TABLE "contract_charge_clause_snapshot" (
  "id" UUID NOT NULL,
  "contract_id" UUID NOT NULL,
  "clause_code" VARCHAR(64) NOT NULL,
  "clause_version" INTEGER NOT NULL,
  "status" "contract_charge_clause_status" NOT NULL DEFAULT 'EXECUTABLE',
  "charge_type" VARCHAR(64) NOT NULL,
  "unit" VARCHAR(32) NOT NULL,
  "pricing_snapshot" JSONB NOT NULL,
  "evidence_requirement_snapshot" JSONB NOT NULL,
  "exemption_snapshot" JSONB NOT NULL,
  "source_text_locator" VARCHAR(255) NOT NULL,
  "source_text_hash" VARCHAR(64) NOT NULL,
  "compilation_hash" VARCHAR(64) NOT NULL,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contract_charge_clause_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contract_charge_clause_contract_code_version_key" UNIQUE ("contract_id", "clause_code", "clause_version"),
  CONSTRAINT "contract_charge_clause_hash_check" CHECK (
    "source_text_hash" ~ '^[0-9a-f]{64}$' AND "compilation_hash" ~ '^[0-9a-f]{64}$'
  )
);

ALTER TABLE "contract_charge_clause_snapshot"
  ADD CONSTRAINT "contract_charge_clause_contract_fkey" FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "contract_charge_clause_actor_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;
CREATE INDEX "contract_charge_clause_contract_status_idx" ON "contract_charge_clause_snapshot"("contract_id", "status");
CREATE TRIGGER "contract_charge_clause_snapshot_append_only"
  BEFORE UPDATE OR DELETE ON "contract_charge_clause_snapshot"
  FOR EACH ROW EXECUTE FUNCTION "stage1_return_append_only_guard"();
