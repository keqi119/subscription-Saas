-- CreateEnum
CREATE TYPE "vehicle_status" AS ENUM ('DRAFT', 'IN_PREPARATION', 'AVAILABLE', 'RESERVED', 'RENTED', 'MAINTENANCE', 'RETIRED');

-- CreateEnum
CREATE TYPE "sale_price_status" AS ENUM ('PENDING_INITIALIZE', 'EFFECTIVE', 'REVIEW_DUE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "vehicle_sale_price_review_type" AS ENUM ('INITIAL_POOL', 'QUARTERLY_REVIEW', 'RETURN_REINIT', 'MANUAL_ADJUST');

-- CreateTable
CREATE TABLE "vehicle" (
    "id" UUID NOT NULL,
    "vehicle_no" VARCHAR(64) NOT NULL,
    "vin" VARCHAR(64),
    "plate_no" VARCHAR(32),
    "brand" VARCHAR(64) NOT NULL,
    "series" VARCHAR(64),
    "model" VARCHAR(64),
    "model_year" INTEGER,
    "vehicle_model" "vehicle_model",
    "purchase_price_amount" BIGINT NOT NULL,
    "purchase_date" DATE,
    "current_sale_price_amount" BIGINT,
    "current_sale_price_initialized_at" TIMESTAMPTZ(6),
    "current_sale_price_reviewed_at" TIMESTAMPTZ(6),
    "next_sale_price_review_at" DATE,
    "sale_price_status" "sale_price_status" NOT NULL DEFAULT 'PENDING_INITIALIZE',
    "registration_date" DATE,
    "insurance_start_date" DATE,
    "insurance_end_date" DATE,
    "status" "vehicle_status" NOT NULL DEFAULT 'DRAFT',
    "current_mileage_km" INTEGER NOT NULL DEFAULT 0,
    "asset_location" VARCHAR(128),
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_sale_price_history" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "before_sale_price_amount" BIGINT,
    "after_sale_price_amount" BIGINT NOT NULL,
    "review_type" "vehicle_sale_price_review_type" NOT NULL,
    "review_quarter" VARCHAR(16),
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "reason" TEXT NOT NULL,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "vehicle_sale_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_vehicle_no_key" ON "vehicle"("vehicle_no");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_vin_key" ON "vehicle"("vin");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_plate_no_key" ON "vehicle"("plate_no");

-- CreateIndex
CREATE INDEX "vehicle_vehicle_model_idx" ON "vehicle"("vehicle_model");

-- CreateIndex
CREATE INDEX "vehicle_status_idx" ON "vehicle"("status");

-- CreateIndex
CREATE INDEX "vehicle_sale_price_status_idx" ON "vehicle"("sale_price_status");

-- CreateIndex
CREATE INDEX "vehicle_next_sale_price_review_at_idx" ON "vehicle"("next_sale_price_review_at");

-- CreateIndex
CREATE INDEX "vehicle_sale_price_history_vehicle_id_idx" ON "vehicle_sale_price_history"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_sale_price_history_review_type_idx" ON "vehicle_sale_price_history"("review_type");

-- CreateIndex
CREATE INDEX "vehicle_sale_price_history_effective_from_effective_to_idx" ON "vehicle_sale_price_history"("effective_from", "effective_to");

-- AddForeignKey
ALTER TABLE "vehicle_sale_price_history" ADD CONSTRAINT "vehicle_sale_price_history_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
