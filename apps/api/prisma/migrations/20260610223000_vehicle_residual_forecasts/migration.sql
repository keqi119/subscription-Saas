CREATE TYPE "vehicle_residual_forecast_status" AS ENUM ('GENERATED', 'ADOPTED', 'ARCHIVED', 'VOIDED');

CREATE TYPE "vehicle_residual_forecast_method" AS ENUM ('CURVE_STATISTICAL', 'MANUAL', 'ML_MODEL');

CREATE TYPE "residual_forecast_interpolation_method" AS ENUM ('EXACT', 'LINEAR_INTERPOLATION', 'UNSUPPORTED_OUT_OF_RANGE');

CREATE TYPE "vehicle_residual_forecast_point_status" AS ENUM ('GENERATED', 'ADOPTED', 'UNSUPPORTED');

CREATE TABLE "vehicle_residual_forecast" (
    "id" UUID NOT NULL,
    "forecast_no" VARCHAR(64) NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "curve_id" UUID NOT NULL,
    "forecast_status" "vehicle_residual_forecast_status" NOT NULL DEFAULT 'GENERATED',
    "forecast_method" "vehicle_residual_forecast_method" NOT NULL DEFAULT 'CURVE_STATISTICAL',
    "as_of_date" DATE NOT NULL,
    "vehicle_age_months" INTEGER,
    "current_mileage_km" INTEGER,
    "brand" VARCHAR(64),
    "series" VARCHAR(64),
    "model" VARCHAR(64),
    "model_year" INTEGER,
    "trim" VARCHAR(128),
    "battery_capacity_kwh" DECIMAL(8,2),
    "battery_usage_type" "vehicle_battery_usage_type",
    "purchase_price_amount" BIGINT,
    "current_sale_price_amount" BIGINT,
    "curve_snapshot" JSONB,
    "vehicle_snapshot" JSONB,
    "input_snapshot" JSONB,
    "metrics" JSONB,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_residual_forecast_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vehicle_residual_forecast_point" (
    "id" UUID NOT NULL,
    "forecast_id" UUID NOT NULL,
    "horizon_month" INTEGER NOT NULL,
    "target_date" DATE NOT NULL,
    "target_age_month" INTEGER,
    "matched_curve_point_age_month" INTEGER,
    "interpolation_method" "residual_forecast_interpolation_method",
    "predicted_residual_amount" BIGINT,
    "predicted_residual_rate_bps" INTEGER,
    "lower_bound_amount" BIGINT,
    "upper_bound_amount" BIGINT,
    "confidence_score" INTEGER,
    "point_status" "vehicle_residual_forecast_point_status" NOT NULL DEFAULT 'GENERATED',
    "adopted_residual_amount" BIGINT,
    "adopted_by" UUID,
    "adopted_at" TIMESTAMPTZ(6),
    "adopt_remark" TEXT,
    "point_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicle_residual_forecast_point_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vehicle_residual_forecast_forecast_no_key" ON "vehicle_residual_forecast"("forecast_no");

CREATE INDEX "vehicle_residual_forecast_vehicle_id_idx" ON "vehicle_residual_forecast"("vehicle_id");

CREATE INDEX "vehicle_residual_forecast_curve_id_idx" ON "vehicle_residual_forecast"("curve_id");

CREATE INDEX "vehicle_residual_forecast_forecast_status_idx" ON "vehicle_residual_forecast"("forecast_status");

CREATE INDEX "vehicle_residual_forecast_as_of_date_idx" ON "vehicle_residual_forecast"("as_of_date");

CREATE INDEX "vehicle_residual_forecast_point_forecast_id_idx" ON "vehicle_residual_forecast_point"("forecast_id");

CREATE INDEX "vehicle_residual_forecast_point_horizon_month_idx" ON "vehicle_residual_forecast_point"("horizon_month");

CREATE INDEX "vehicle_residual_forecast_point_target_age_month_idx" ON "vehicle_residual_forecast_point"("target_age_month");

ALTER TABLE "vehicle_residual_forecast" ADD CONSTRAINT "vehicle_residual_forecast_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vehicle_residual_forecast" ADD CONSTRAINT "vehicle_residual_forecast_curve_id_fkey" FOREIGN KEY ("curve_id") REFERENCES "vehicle_residual_curve"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vehicle_residual_forecast_point" ADD CONSTRAINT "vehicle_residual_forecast_point_forecast_id_fkey" FOREIGN KEY ("forecast_id") REFERENCES "vehicle_residual_forecast"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
