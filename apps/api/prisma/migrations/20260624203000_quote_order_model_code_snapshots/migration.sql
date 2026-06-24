ALTER TABLE "subscription_quote"
  ADD COLUMN "legacy_vehicle_model_code_snapshot" VARCHAR(64);

ALTER TABLE "subscription_order"
  ADD COLUMN "legacy_vehicle_model_code_snapshot" VARCHAR(64);
