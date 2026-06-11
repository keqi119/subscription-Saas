CREATE TYPE "residual_model_run_type" AS ENUM ('STATISTICAL_BASELINE', 'ML_TRAINING', 'ML_INFERENCE', 'MANUAL_IMPORT', 'EXTERNAL_MODEL');

CREATE TYPE "residual_model_run_status" AS ENUM ('CREATED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

CREATE TYPE "residual_model_algorithm" AS ENUM ('STATISTICAL_MEDIAN', 'LINEAR_REGRESSION', 'RANDOM_FOREST', 'GRADIENT_BOOSTING', 'XGBOOST', 'LIGHTGBM', 'CATBOOST', 'CUSTOM', 'EXTERNAL', 'UNKNOWN');

CREATE TYPE "residual_model_target_type" AS ENUM ('RESIDUAL_CURVE', 'VEHICLE_FORECAST', 'CURVE_AND_FORECAST', 'MARKET_PRICE');

CREATE TYPE "residual_model_run_output_type" AS ENUM ('RESIDUAL_CURVE', 'VEHICLE_FORECAST', 'METRIC_REPORT', 'OTHER');

CREATE TYPE "residual_model_run_output_status" AS ENUM ('ACTIVE', 'VOIDED');

CREATE TABLE "residual_model_run" (
    "id" UUID NOT NULL,
    "run_no" VARCHAR(64) NOT NULL,
    "run_name" VARCHAR(128),
    "run_type" "residual_model_run_type" NOT NULL,
    "run_status" "residual_model_run_status" NOT NULL DEFAULT 'CREATED',
    "model_name" VARCHAR(128),
    "model_version" VARCHAR(64),
    "model_provider" VARCHAR(64),
    "algorithm" "residual_model_algorithm",
    "target_type" "residual_model_target_type" NOT NULL,
    "target_brand" VARCHAR(64),
    "target_series" VARCHAR(64),
    "target_model" VARCHAR(64),
    "target_model_year" INTEGER,
    "target_trim" VARCHAR(128),
    "target_battery_capacity_kwh" DECIMAL(8,2),
    "target_battery_usage_type" "vehicle_battery_usage_type",
    "training_data_start_date" DATE,
    "training_data_end_date" DATE,
    "sample_count" INTEGER,
    "feature_snapshot" JSONB,
    "parameter_snapshot" JSONB,
    "filter_snapshot" JSONB,
    "metrics_snapshot" JSONB,
    "output_snapshot" JSONB,
    "error_snapshot" JSONB,
    "artifact_uri" VARCHAR(512),
    "remark" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "residual_model_run_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "residual_model_run_output" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "output_type" "residual_model_run_output_type" NOT NULL,
    "output_status" "residual_model_run_output_status" NOT NULL DEFAULT 'ACTIVE',
    "curve_id" UUID,
    "forecast_id" UUID,
    "vehicle_id" UUID,
    "output_no" VARCHAR(64),
    "output_snapshot" JSONB,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "residual_model_run_output_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "residual_model_run_run_no_key" ON "residual_model_run"("run_no");

CREATE INDEX "residual_model_run_run_type_idx" ON "residual_model_run"("run_type");

CREATE INDEX "residual_model_run_run_status_idx" ON "residual_model_run"("run_status");

CREATE INDEX "residual_model_run_target_type_idx" ON "residual_model_run"("target_type");

CREATE INDEX "residual_model_run_model_version_idx" ON "residual_model_run"("model_version");

CREATE INDEX "residual_model_run_target_brand_target_series_target_model_idx" ON "residual_model_run"("target_brand", "target_series", "target_model");

CREATE INDEX "residual_model_run_created_at_idx" ON "residual_model_run"("created_at");

CREATE INDEX "residual_model_run_output_run_id_idx" ON "residual_model_run_output"("run_id");

CREATE INDEX "residual_model_run_output_output_type_idx" ON "residual_model_run_output"("output_type");

CREATE INDEX "residual_model_run_output_output_status_idx" ON "residual_model_run_output"("output_status");

CREATE INDEX "residual_model_run_output_curve_id_idx" ON "residual_model_run_output"("curve_id");

CREATE INDEX "residual_model_run_output_forecast_id_idx" ON "residual_model_run_output"("forecast_id");

CREATE INDEX "residual_model_run_output_vehicle_id_idx" ON "residual_model_run_output"("vehicle_id");

ALTER TABLE "residual_model_run_output" ADD CONSTRAINT "residual_model_run_output_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "residual_model_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "residual_model_run_output" ADD CONSTRAINT "residual_model_run_output_curve_id_fkey" FOREIGN KEY ("curve_id") REFERENCES "vehicle_residual_curve"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "residual_model_run_output" ADD CONSTRAINT "residual_model_run_output_forecast_id_fkey" FOREIGN KEY ("forecast_id") REFERENCES "vehicle_residual_forecast"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "residual_model_run_output" ADD CONSTRAINT "residual_model_run_output_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
