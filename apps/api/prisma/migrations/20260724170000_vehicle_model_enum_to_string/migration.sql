BEGIN;

ALTER TABLE "vehicle_package"
  ALTER COLUMN "vehicle_model" TYPE VARCHAR(64)
  USING "vehicle_model"::text;

ALTER TABLE "product_price_rule"
  ALTER COLUMN "vehicle_model" TYPE VARCHAR(64)
  USING "vehicle_model"::text;

ALTER TABLE "vehicle"
  ALTER COLUMN "vehicle_model" TYPE VARCHAR(64)
  USING "vehicle_model"::text;

ALTER TABLE "vehicle_model_definition"
  ALTER COLUMN "legacy_vehicle_model" TYPE VARCHAR(64)
  USING "legacy_vehicle_model"::text;

ALTER TABLE "subscription_quote"
  ALTER COLUMN "vehicle_model" TYPE VARCHAR(64)
  USING "vehicle_model"::text;

ALTER TABLE "subscription_quote"
  ALTER COLUMN "legacy_vehicle_model_snapshot" TYPE VARCHAR(64)
  USING "legacy_vehicle_model_snapshot"::text;

ALTER TABLE "subscription_order"
  ALTER COLUMN "vehicle_model" TYPE VARCHAR(64)
  USING "vehicle_model"::text;

ALTER TABLE "subscription_order"
  ALTER COLUMN "legacy_vehicle_model_snapshot" TYPE VARCHAR(64)
  USING "legacy_vehicle_model_snapshot"::text;

DROP TYPE "vehicle_model";

COMMIT;
