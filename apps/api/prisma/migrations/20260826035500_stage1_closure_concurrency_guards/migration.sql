CREATE UNIQUE INDEX "subscription_closure_charge_line_revision_delta_status_key"
  ON "subscription_closure_charge_line"("settlement_revision_id", "delta_item_id", "status");

CREATE UNIQUE INDEX "subscription_closure_customer_response_settlement_key"
  ON "subscription_closure_customer_response"("settlement_revision_id");
