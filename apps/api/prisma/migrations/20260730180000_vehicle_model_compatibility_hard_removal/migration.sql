BEGIN;

ALTER TABLE "subscription_quote"
  RENAME COLUMN "legacy_vehicle_model_code_snapshot" TO "model_code_snapshot";

ALTER TABLE "subscription_order"
  RENAME COLUMN "legacy_vehicle_model_code_snapshot" TO "model_code_snapshot";

ALTER TABLE "vehicle_package" DROP COLUMN "vehicle_model";
ALTER TABLE "product_price_rule" DROP COLUMN "vehicle_model";
ALTER TABLE "vehicle" DROP COLUMN "vehicle_model";
ALTER TABLE "vehicle_model_definition" DROP COLUMN "legacy_vehicle_model";
ALTER TABLE "subscription_quote" DROP COLUMN "vehicle_model";
ALTER TABLE "subscription_quote" DROP COLUMN "legacy_vehicle_model_snapshot";
ALTER TABLE "subscription_order" DROP COLUMN "vehicle_model";
ALTER TABLE "subscription_order" DROP COLUMN "legacy_vehicle_model_snapshot";

ALTER TABLE "vehicle" ALTER COLUMN "model_definition_id" SET NOT NULL;
ALTER TABLE "vehicle_package" ALTER COLUMN "model_definition_id" SET NOT NULL;
ALTER TABLE "product_price_rule" ALTER COLUMN "model_definition_id" SET NOT NULL;
ALTER TABLE "subscription_quote" ALTER COLUMN "model_definition_id_snapshot" SET NOT NULL;
ALTER TABLE "subscription_quote" ALTER COLUMN "model_code_snapshot" SET NOT NULL;
ALTER TABLE "subscription_quote" ALTER COLUMN "model_display_name_snapshot" SET NOT NULL;
ALTER TABLE "subscription_order" ALTER COLUMN "model_definition_id_snapshot" SET NOT NULL;
ALTER TABLE "subscription_order" ALTER COLUMN "model_code_snapshot" SET NOT NULL;
ALTER TABLE "subscription_order" ALTER COLUMN "model_display_name_snapshot" SET NOT NULL;

COMMIT;
