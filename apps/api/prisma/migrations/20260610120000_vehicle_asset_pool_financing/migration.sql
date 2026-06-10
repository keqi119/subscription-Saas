-- CreateEnum
CREATE TYPE "vehicle_asset_pool_type" AS ENUM ('FINANCING', 'OPERATION', 'ASSET_MANAGEMENT', 'REPORTING', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_asset_pool_status" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "vehicle_asset_pool_vehicle_status" AS ENUM ('ACTIVE', 'REMOVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "vehicle_pool_allocation_method" AS ENUM ('UNIFORM_PURCHASE_PRICE_COVERAGE', 'UNIFORM_CURRENT_SALE_PRICE_COVERAGE', 'EQUAL_AMOUNT', 'MANUAL_AMOUNT');

-- CreateTable
CREATE TABLE "vehicle_asset_pool" (
    "id" UUID NOT NULL,
    "pool_no" VARCHAR(64) NOT NULL,
    "pool_name" VARCHAR(128) NOT NULL,
    "pool_type" "vehicle_asset_pool_type" NOT NULL,
    "pool_status" "vehicle_asset_pool_status" NOT NULL DEFAULT 'ACTIVE',
    "purpose" TEXT,
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_asset_pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_asset_pool_vehicle" (
    "id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "membership_status" "vehicle_asset_pool_vehicle_status" NOT NULL DEFAULT 'ACTIVE',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_asset_pool_vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_asset_pool_pool_no_key" ON "vehicle_asset_pool"("pool_no");

-- CreateIndex
CREATE INDEX "vehicle_asset_pool_pool_type_idx" ON "vehicle_asset_pool"("pool_type");

-- CreateIndex
CREATE INDEX "vehicle_asset_pool_pool_status_idx" ON "vehicle_asset_pool"("pool_status");

-- CreateIndex
CREATE INDEX "vehicle_asset_pool_deleted_at_idx" ON "vehicle_asset_pool"("deleted_at");

-- CreateIndex
CREATE INDEX "vehicle_asset_pool_vehicle_pool_id_idx" ON "vehicle_asset_pool_vehicle"("pool_id");

-- CreateIndex
CREATE INDEX "vehicle_asset_pool_vehicle_vehicle_id_idx" ON "vehicle_asset_pool_vehicle"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_asset_pool_vehicle_membership_status_idx" ON "vehicle_asset_pool_vehicle"("membership_status");

-- CreateIndex
CREATE INDEX "vehicle_asset_pool_vehicle_effective_from_idx" ON "vehicle_asset_pool_vehicle"("effective_from");

-- CreateIndex
CREATE INDEX "vehicle_asset_pool_vehicle_deleted_at_idx" ON "vehicle_asset_pool_vehicle"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_asset_pool_vehicle_active_pool_vehicle_key" ON "vehicle_asset_pool_vehicle"("pool_id", "vehicle_id") WHERE "deleted_at" IS NULL AND "membership_status" = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "vehicle_asset_pool_vehicle" ADD CONSTRAINT "vehicle_asset_pool_vehicle_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vehicle_asset_pool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_asset_pool_vehicle" ADD CONSTRAINT "vehicle_asset_pool_vehicle_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
