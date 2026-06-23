ALTER TABLE "vehicle_package" ADD COLUMN "model_definition_id" UUID;

ALTER TABLE "product_price_rule" ADD COLUMN "model_definition_id" UUID;

CREATE INDEX "vehicle_package_model_definition_id_idx" ON "vehicle_package"("model_definition_id");

CREATE INDEX "product_price_rule_model_definition_id_idx" ON "product_price_rule"("model_definition_id");

ALTER TABLE "vehicle_package"
  ADD CONSTRAINT "vehicle_package_model_definition_id_fkey"
  FOREIGN KEY ("model_definition_id")
  REFERENCES "vehicle_model_definition"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "product_price_rule"
  ADD CONSTRAINT "product_price_rule_model_definition_id_fkey"
  FOREIGN KEY ("model_definition_id")
  REFERENCES "vehicle_model_definition"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
