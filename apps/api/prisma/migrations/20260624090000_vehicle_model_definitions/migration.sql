CREATE TABLE "vehicle_model_definition" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "model_code" VARCHAR(64) NOT NULL,
  "legacy_vehicle_model" "vehicle_model",
  "brand" VARCHAR(64) NOT NULL,
  "series" VARCHAR(64),
  "model_name" VARCHAR(128) NOT NULL,
  "model_year" INTEGER,
  "variant_name" VARCHAR(128),
  "display_name" VARCHAR(128) NOT NULL,
  "customer_display_name" VARCHAR(128),
  "energy_type" VARCHAR(64),
  "body_type" VARCHAR(64),
  "seat_count" INTEGER,
  "drive_type" VARCHAR(64),
  "battery_capacity_kwh" DECIMAL(8,2),
  "official_range_km" INTEGER,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "portal_visible" BOOLEAN NOT NULL DEFAULT false,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "remark" TEXT,
  "snapshot" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "created_by" UUID,
  "updated_by" UUID,
  "deleted_at" TIMESTAMPTZ(6),

  CONSTRAINT "vehicle_model_definition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vehicle_model_definition_model_code_key" ON "vehicle_model_definition"("model_code");
CREATE UNIQUE INDEX "vehicle_model_definition_legacy_vehicle_model_key" ON "vehicle_model_definition"("legacy_vehicle_model");
CREATE INDEX "vehicle_model_definition_model_code_idx" ON "vehicle_model_definition"("model_code");
CREATE INDEX "vehicle_model_definition_legacy_vehicle_model_idx" ON "vehicle_model_definition"("legacy_vehicle_model");
CREATE INDEX "vehicle_model_definition_brand_idx" ON "vehicle_model_definition"("brand");
CREATE INDEX "vehicle_model_definition_series_idx" ON "vehicle_model_definition"("series");
CREATE INDEX "vehicle_model_definition_enabled_idx" ON "vehicle_model_definition"("enabled");
CREATE INDEX "vehicle_model_definition_portal_visible_idx" ON "vehicle_model_definition"("portal_visible");
CREATE INDEX "vehicle_model_definition_sort_order_idx" ON "vehicle_model_definition"("sort_order");
