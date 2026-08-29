CREATE TYPE "subscription_closure_customer_response_status" AS ENUM (
  'PENDING', 'ACCEPTED', 'PARTIALLY_DISPUTED', 'DISPUTED', 'NO_RESPONSE'
);
CREATE TYPE "subscription_closure_dispute_status" AS ENUM (
  'OPEN', 'ACCEPTED_BY_PLATFORM', 'REJECTED_BY_PLATFORM', 'WITHDRAWN', 'SUPERSEDED'
);

CREATE TABLE "subscription_closure_customer_response" (
  "id" UUID NOT NULL,
  "closure_case_id" UUID NOT NULL,
  "settlement_revision_id" UUID NOT NULL,
  "settlement_hash" VARCHAR(64) NOT NULL,
  "status" "subscription_closure_customer_response_status" NOT NULL,
  "response_snapshot" JSONB NOT NULL,
  "notification_snapshot" JSONB NOT NULL,
  "responded_by_customer_id" UUID,
  "responded_at" TIMESTAMPTZ(6) NOT NULL,
  "source_type" VARCHAR(64) NOT NULL,
  "source_id" UUID NOT NULL,
  "source_key" VARCHAR(255) NOT NULL,
  "supersedes_response_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_closure_customer_response_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_closure_customer_response_source_key" UNIQUE ("source_type", "source_id", "source_key"),
  CONSTRAINT "subscription_closure_customer_response_supersedes_key" UNIQUE ("supersedes_response_id"),
  CONSTRAINT "subscription_closure_customer_response_hash_check" CHECK ("settlement_hash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "subscription_closure_charge_dispute" (
  "id" UUID NOT NULL,
  "closure_case_id" UUID NOT NULL,
  "customer_response_id" UUID NOT NULL,
  "charge_line_id" UUID NOT NULL,
  "status" "subscription_closure_dispute_status" NOT NULL DEFAULT 'OPEN',
  "customer_reason" TEXT NOT NULL,
  "customer_evidence_snapshot" JSONB NOT NULL,
  "platform_decision_snapshot" JSONB,
  "decided_by" UUID,
  "decided_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_closure_charge_dispute_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_closure_charge_dispute_response_line_key" UNIQUE ("customer_response_id", "charge_line_id")
);

ALTER TABLE "subscription_closure_customer_response"
  ADD CONSTRAINT "subscription_closure_customer_response_case_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_customer_response_settlement_fkey" FOREIGN KEY ("settlement_revision_id") REFERENCES "subscription_closure_settlement_revision"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_customer_response_customer_fkey" FOREIGN KEY ("responded_by_customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_customer_response_supersedes_fkey" FOREIGN KEY ("supersedes_response_id") REFERENCES "subscription_closure_customer_response"("id") ON DELETE RESTRICT;
ALTER TABLE "subscription_closure_charge_dispute"
  ADD CONSTRAINT "subscription_closure_charge_dispute_case_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_charge_dispute_response_fkey" FOREIGN KEY ("customer_response_id") REFERENCES "subscription_closure_customer_response"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_charge_dispute_line_fkey" FOREIGN KEY ("charge_line_id") REFERENCES "subscription_closure_charge_line"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_charge_dispute_actor_fkey" FOREIGN KEY ("decided_by") REFERENCES "user"("id") ON DELETE RESTRICT;
CREATE INDEX "subscription_closure_customer_response_case_idx" ON "subscription_closure_customer_response"("closure_case_id", "responded_at");
CREATE INDEX "subscription_closure_charge_dispute_case_status_idx" ON "subscription_closure_charge_dispute"("closure_case_id", "status");
CREATE TRIGGER "subscription_closure_customer_response_append_only"
  BEFORE UPDATE OR DELETE ON "subscription_closure_customer_response"
  FOR EACH ROW EXECUTE FUNCTION "stage1_return_append_only_guard"();
CREATE TRIGGER "subscription_closure_charge_dispute_append_only"
  BEFORE UPDATE OR DELETE ON "subscription_closure_charge_dispute"
  FOR EACH ROW EXECUTE FUNCTION "stage1_return_append_only_guard"();
