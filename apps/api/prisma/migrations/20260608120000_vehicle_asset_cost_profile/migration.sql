-- CreateEnum
CREATE TYPE "vehicle_asset_cost_profile_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "vehicle_depreciation_method" AS ENUM ('STRAIGHT_LINE', 'NONE', 'MANUAL');

-- CreateTable
CREATE TABLE "vehicle_asset_cost_profile" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "profile_status" "vehicle_asset_cost_profile_status" NOT NULL DEFAULT 'ACTIVE',
    "depreciation_method" "vehicle_depreciation_method" NOT NULL,
    "depreciation_start_date" DATE NOT NULL,
    "useful_life_months" INTEGER NOT NULL,
    "residual_value_amount" BIGINT NOT NULL,
    "capital_cost_rate_bps" INTEGER,
    "annual_insurance_cost_amount" BIGINT,
    "annual_maintenance_reserve_amount" BIGINT,
    "other_monthly_cost_amount" BIGINT,
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_asset_cost_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_asset_cost_profile_vehicle_id_idx" ON "vehicle_asset_cost_profile"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_asset_cost_profile_vehicle_id_profile_status_idx" ON "vehicle_asset_cost_profile"("vehicle_id", "profile_status");

-- CreateIndex
CREATE INDEX "vehicle_asset_cost_profile_profile_status_idx" ON "vehicle_asset_cost_profile"("profile_status");

-- CreateIndex
CREATE INDEX "vehicle_asset_cost_profile_deleted_at_idx" ON "vehicle_asset_cost_profile"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_asset_cost_profile_active_vehicle_key" ON "vehicle_asset_cost_profile"("vehicle_id") WHERE "deleted_at" IS NULL AND "profile_status" = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "vehicle_asset_cost_profile" ADD CONSTRAINT "vehicle_asset_cost_profile_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
