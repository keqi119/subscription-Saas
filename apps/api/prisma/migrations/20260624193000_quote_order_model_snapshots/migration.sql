ALTER TABLE "subscription_quote"
  ADD COLUMN "model_definition_id_snapshot" UUID,
  ADD COLUMN "model_display_name_snapshot" VARCHAR(128),
  ADD COLUMN "legacy_vehicle_model_snapshot" "vehicle_model";

ALTER TABLE "subscription_order"
  ADD COLUMN "model_definition_id_snapshot" UUID,
  ADD COLUMN "model_display_name_snapshot" VARCHAR(128),
  ADD COLUMN "legacy_vehicle_model_snapshot" "vehicle_model";
