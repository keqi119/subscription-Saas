CREATE TABLE "subscription_closure_charge_dispute_decision" (
  "id" UUID NOT NULL,
  "closure_case_id" UUID NOT NULL,
  "dispute_id" UUID NOT NULL,
  "decision" "subscription_closure_dispute_status" NOT NULL,
  "decision_snapshot" JSONB NOT NULL,
  "evidence_snapshot" JSONB NOT NULL,
  "decided_by" UUID NOT NULL,
  "decided_at" TIMESTAMPTZ(6) NOT NULL,
  "source_type" VARCHAR(64) NOT NULL,
  "source_id" UUID NOT NULL,
  "source_key" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_closure_charge_dispute_decision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_closure_dispute_decision_dispute_key" UNIQUE ("dispute_id"),
  CONSTRAINT "subscription_closure_dispute_decision_source_key" UNIQUE ("source_type", "source_id", "source_key"),
  CONSTRAINT "subscription_closure_dispute_decision_terminal_check" CHECK (
    "decision" IN ('ACCEPTED_BY_PLATFORM', 'REJECTED_BY_PLATFORM')
  )
);

ALTER TABLE "subscription_closure_charge_dispute_decision"
  ADD CONSTRAINT "subscription_closure_dispute_decision_case_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_dispute_decision_dispute_fkey" FOREIGN KEY ("dispute_id") REFERENCES "subscription_closure_charge_dispute"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_dispute_decision_actor_fkey" FOREIGN KEY ("decided_by") REFERENCES "user"("id") ON DELETE RESTRICT;

CREATE INDEX "subscription_closure_dispute_decision_case_idx"
  ON "subscription_closure_charge_dispute_decision"("closure_case_id", "decided_at");

CREATE TRIGGER "subscription_closure_charge_dispute_decision_append_only"
  BEFORE UPDATE OR DELETE ON "subscription_closure_charge_dispute_decision"
  FOR EACH ROW EXECUTE FUNCTION "stage1_return_append_only_guard"();
