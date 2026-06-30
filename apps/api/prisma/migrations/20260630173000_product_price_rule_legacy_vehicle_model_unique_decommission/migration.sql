-- Stage 10X-W: decommission the legacy ProductPriceRule uniqueness guard.
-- The modelDefinitionId-based uniqueness guard was added in Stage 10X-V and remains active.
DROP INDEX "product_price_rule_product_version_id_vehicle_model_key";
