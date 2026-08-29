ALTER TABLE "subscription_closure_charge_line"
  DROP CONSTRAINT "subscription_closure_charge_line_revision_code_key";

ALTER TABLE "subscription_closure_charge_line"
  ADD CONSTRAINT "subscription_closure_charge_line_revision_code_status_key"
  UNIQUE ("settlement_revision_id", "line_code", "status");
