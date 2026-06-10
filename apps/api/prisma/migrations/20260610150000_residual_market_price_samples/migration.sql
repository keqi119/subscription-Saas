CREATE TYPE "market_price_import_status" AS ENUM ('COMPLETED', 'PARTIAL_FAILED', 'FAILED');

CREATE TYPE "market_price_source" AS ENUM ('MANUAL', 'CSV_IMPORT', 'INTERNAL_DISPOSAL', 'DEALER_QUOTE', 'AUCTION', 'USED_CAR_PLATFORM', 'OTHER');

CREATE TYPE "market_price_type" AS ENUM ('LISTING', 'TRANSACTION', 'AUCTION', 'DEALER_QUOTE', 'INTERNAL_SALE', 'ESTIMATE');

CREATE TYPE "market_seller_type" AS ENUM ('INDIVIDUAL', 'DEALER', 'PLATFORM', 'AUCTION_HOUSE', 'INTERNAL', 'UNKNOWN');

CREATE TYPE "market_price_observation_status" AS ENUM ('ACTIVE', 'IGNORED', 'VOIDED');

CREATE TABLE "market_price_import_batch" (
    "id" UUID NOT NULL,
    "batch_no" VARCHAR(64) NOT NULL,
    "source" "market_price_source" NOT NULL,
    "file_name" VARCHAR(255),
    "imported_by" UUID,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "imported_rows" INTEGER NOT NULL DEFAULT 0,
    "skipped_rows" INTEGER NOT NULL DEFAULT 0,
    "failed_rows" INTEGER NOT NULL DEFAULT 0,
    "import_status" "market_price_import_status" NOT NULL DEFAULT 'COMPLETED',
    "remark" TEXT,
    "error_snapshot" JSONB,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "market_price_import_batch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vehicle_market_price_observation" (
    "id" UUID NOT NULL,
    "observation_no" VARCHAR(64) NOT NULL,
    "batch_id" UUID,
    "source" "market_price_source" NOT NULL,
    "source_listing_id" VARCHAR(128),
    "observed_at" DATE NOT NULL,
    "brand" VARCHAR(64) NOT NULL,
    "series" VARCHAR(64),
    "model" VARCHAR(64) NOT NULL,
    "model_year" INTEGER,
    "trim" VARCHAR(128),
    "battery_capacity_kwh" DECIMAL(8,2),
    "battery_usage_type" "vehicle_battery_usage_type",
    "mileage_km" INTEGER,
    "registration_date" DATE,
    "vehicle_age_months" INTEGER,
    "province" VARCHAR(64),
    "city" VARCHAR(64),
    "price_type" "market_price_type" NOT NULL,
    "price_amount" BIGINT NOT NULL,
    "listing_price_amount" BIGINT,
    "transaction_price_amount" BIGINT,
    "listing_days" INTEGER,
    "seller_type" "market_seller_type",
    "condition_grade" VARCHAR(64),
    "battery_health_percent" DECIMAL(5,2),
    "accident_flag" BOOLEAN,
    "source_url_hash" VARCHAR(128),
    "dedupe_key" VARCHAR(512) NOT NULL,
    "confidence_score" INTEGER,
    "observation_status" "market_price_observation_status" NOT NULL DEFAULT 'ACTIVE',
    "raw_snapshot" JSONB,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_market_price_observation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "market_price_import_batch_batch_no_key" ON "market_price_import_batch"("batch_no");

CREATE INDEX "market_price_import_batch_source_idx" ON "market_price_import_batch"("source");

CREATE INDEX "market_price_import_batch_import_status_idx" ON "market_price_import_batch"("import_status");

CREATE INDEX "market_price_import_batch_created_at_idx" ON "market_price_import_batch"("created_at");

CREATE UNIQUE INDEX "vehicle_market_price_observation_observation_no_key" ON "vehicle_market_price_observation"("observation_no");

CREATE INDEX "vehicle_market_price_observation_source_idx" ON "vehicle_market_price_observation"("source");

CREATE INDEX "vehicle_market_price_observation_observed_at_idx" ON "vehicle_market_price_observation"("observed_at");

CREATE INDEX "vehicle_market_price_observation_brand_series_model_idx" ON "vehicle_market_price_observation"("brand", "series", "model");

CREATE INDEX "vehicle_market_price_observation_model_year_idx" ON "vehicle_market_price_observation"("model_year");

CREATE INDEX "vehicle_market_price_observation_city_idx" ON "vehicle_market_price_observation"("city");

CREATE INDEX "vehicle_market_price_observation_price_type_idx" ON "vehicle_market_price_observation"("price_type");

CREATE INDEX "vehicle_market_price_observation_observation_status_idx" ON "vehicle_market_price_observation"("observation_status");

CREATE INDEX "vehicle_market_price_observation_dedupe_key_idx" ON "vehicle_market_price_observation"("dedupe_key");

CREATE UNIQUE INDEX "vehicle_market_price_observation_active_dedupe_unique" ON "vehicle_market_price_observation"("dedupe_key") WHERE "deleted_at" IS NULL AND "observation_status" = 'ACTIVE';

ALTER TABLE "vehicle_market_price_observation" ADD CONSTRAINT "vehicle_market_price_observation_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "market_price_import_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
