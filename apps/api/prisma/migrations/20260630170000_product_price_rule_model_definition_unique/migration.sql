-- Stage 10X-V: add the modelDefinitionId-based ProductPriceRule uniqueness guard.
-- This is additive: the legacy productVersionId + vehicleModel unique constraint remains in place.
CREATE UNIQUE INDEX "product_price_rule_product_version_model_definition_key"
ON "product_price_rule"("product_version_id", "model_definition_id");
