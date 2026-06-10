CREATE TYPE "vehicle_residual_curve_status" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED');

CREATE TYPE "vehicle_residual_curve_method" AS ENUM ('STATISTICAL_MEDIAN', 'MANUAL', 'ML_MODEL');

CREATE TABLE "vehicle_residual_curve" (
    "id" UUID NOT NULL,
    "curve_no" VARCHAR(64) NOT NULL,
    "curve_name" VARCHAR(128),
    "curve_status" "vehicle_residual_curve_status" NOT NULL DEFAULT 'DRAFT',
    "curve_method" "vehicle_residual_curve_method" NOT NULL DEFAULT 'STATISTICAL_MEDIAN',
    "brand" VARCHAR(64) NOT NULL,
    "series" VARCHAR(64),
    "model" VARCHAR(64) NOT NULL,
    "model_year" INTEGER,
    "trim" VARCHAR(128),
    "battery_capacity_kwh" DECIMAL(8,2),
    "battery_usage_type" "vehicle_battery_usage_type",
    "reference_price_amount" BIGINT,
    "sample_start_date" DATE,
    "sample_end_date" DATE,
    "price_types" JSONB,
    "sample_filter_snapshot" JSONB,
    "sample_count" INTEGER NOT NULL DEFAULT 0,
    "point_count" INTEGER NOT NULL DEFAULT 0,
    "confidence_score" INTEGER,
    "curve_version" VARCHAR(64),
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_from" DATE,
    "effective_to" DATE,
    "metrics" JSONB,
    "snapshot" JSONB,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_residual_curve_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vehicle_residual_curve_point" (
    "id" UUID NOT NULL,
    "curve_id" UUID NOT NULL,
    "age_month" INTEGER NOT NULL,
    "mileage_bucket_start_km" INTEGER,
    "mileage_bucket_end_km" INTEGER,
    "sample_count" INTEGER NOT NULL DEFAULT 0,
    "median_price_amount" BIGINT,
    "p25_price_amount" BIGINT,
    "p75_price_amount" BIGINT,
    "average_price_amount" BIGINT,
    "min_price_amount" BIGINT,
    "max_price_amount" BIGINT,
    "predicted_residual_amount" BIGINT,
    "predicted_residual_rate_bps" INTEGER,
    "lower_bound_amount" BIGINT,
    "upper_bound_amount" BIGINT,
    "confidence_score" INTEGER,
    "point_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicle_residual_curve_point_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vehicle_residual_curve_curve_no_key" ON "vehicle_residual_curve"("curve_no");

CREATE INDEX "vehicle_residual_curve_curve_status_idx" ON "vehicle_residual_curve"("curve_status");

CREATE INDEX "vehicle_residual_curve_curve_method_idx" ON "vehicle_residual_curve"("curve_method");

CREATE INDEX "vehicle_residual_curve_brand_series_model_idx" ON "vehicle_residual_curve"("brand", "series", "model");

CREATE INDEX "vehicle_residual_curve_model_year_idx" ON "vehicle_residual_curve"("model_year");

CREATE INDEX "vehicle_residual_curve_battery_usage_type_idx" ON "vehicle_residual_curve"("battery_usage_type");

CREATE INDEX "vehicle_residual_curve_generated_at_idx" ON "vehicle_residual_curve"("generated_at");

CREATE INDEX "vehicle_residual_curve_point_curve_id_idx" ON "vehicle_residual_curve_point"("curve_id");

CREATE INDEX "vehicle_residual_curve_point_age_month_idx" ON "vehicle_residual_curve_point"("age_month");

ALTER TABLE "vehicle_residual_curve_point" ADD CONSTRAINT "vehicle_residual_curve_point_curve_id_fkey" FOREIGN KEY ("curve_id") REFERENCES "vehicle_residual_curve"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
