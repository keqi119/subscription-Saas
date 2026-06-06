-- CreateEnum
CREATE TYPE "vehicle_return_status" AS ENUM ('PENDING', 'READY', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "vehicle_return_type" AS ENUM ('NORMAL_RETURN', 'EARLY_TERMINATION');

-- CreateEnum
CREATE TYPE "vehicle_damage_type" AS ENUM ('EXTERIOR', 'INTERIOR', 'BATTERY', 'TIRE', 'GLASS', 'CHASSIS', 'EQUIPMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_damage_level" AS ENUM ('MINOR', 'MEDIUM', 'SEVERE');

-- CreateEnum
CREATE TYPE "vehicle_damage_responsible_party" AS ENUM ('CUSTOMER', 'PLATFORM', 'THIRD_PARTY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "vehicle_return_damage_status" AS ENUM ('RECORDED', 'CONFIRMED', 'WAIVED', 'SETTLED');

-- AlterTable
ALTER TABLE "subscription_order" ADD COLUMN     "actual_return_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "vehicle_return" (
    "id" UUID NOT NULL,
    "return_no" VARCHAR(64) NOT NULL,
    "order_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "return_type" "vehicle_return_type" NOT NULL DEFAULT 'NORMAL_RETURN',
    "return_status" "vehicle_return_status" NOT NULL DEFAULT 'PENDING',
    "scheduled_at" TIMESTAMPTZ(6),
    "return_location" VARCHAR(255),
    "returned_at" TIMESTAMPTZ(6),
    "return_mileage_km" INTEGER,
    "keys_returned_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "charging_equipment_returned_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "vehicle_documents_returned_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "customer_items_cleared_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "exterior_checked_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "interior_checked_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "battery_checked_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "mileage_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "violation_checked_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "cleaning_required" BOOLEAN NOT NULL DEFAULT false,
    "maintenance_required" BOOLEAN NOT NULL DEFAULT false,
    "damage_found" BOOLEAN NOT NULL DEFAULT false,
    "checklist_snapshot" JSONB,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_return_damage" (
    "id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "damage_type" "vehicle_damage_type" NOT NULL,
    "damage_level" "vehicle_damage_level" NOT NULL,
    "description" TEXT NOT NULL,
    "estimated_repair_amount" BIGINT,
    "responsible_party" "vehicle_damage_responsible_party" NOT NULL DEFAULT 'UNKNOWN',
    "photo_urls" JSONB,
    "status" "vehicle_return_damage_status" NOT NULL DEFAULT 'RECORDED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_return_damage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_return_return_no_key" ON "vehicle_return"("return_no");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_return_order_id_key" ON "vehicle_return"("order_id");

-- CreateIndex
CREATE INDEX "vehicle_return_vehicle_id_idx" ON "vehicle_return"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_return_customer_id_idx" ON "vehicle_return"("customer_id");

-- CreateIndex
CREATE INDEX "vehicle_return_return_status_idx" ON "vehicle_return"("return_status");

-- CreateIndex
CREATE INDEX "vehicle_return_return_type_idx" ON "vehicle_return"("return_type");

-- CreateIndex
CREATE INDEX "vehicle_return_scheduled_at_idx" ON "vehicle_return"("scheduled_at");

-- CreateIndex
CREATE INDEX "vehicle_return_returned_at_idx" ON "vehicle_return"("returned_at");

-- CreateIndex
CREATE INDEX "vehicle_return_damage_return_id_idx" ON "vehicle_return_damage"("return_id");

-- CreateIndex
CREATE INDEX "vehicle_return_damage_vehicle_id_idx" ON "vehicle_return_damage"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_return_damage_order_id_idx" ON "vehicle_return_damage"("order_id");

-- CreateIndex
CREATE INDEX "vehicle_return_damage_damage_type_idx" ON "vehicle_return_damage"("damage_type");

-- CreateIndex
CREATE INDEX "vehicle_return_damage_damage_level_idx" ON "vehicle_return_damage"("damage_level");

-- CreateIndex
CREATE INDEX "vehicle_return_damage_status_idx" ON "vehicle_return_damage"("status");

-- AddForeignKey
ALTER TABLE "vehicle_return" ADD CONSTRAINT "vehicle_return_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_return" ADD CONSTRAINT "vehicle_return_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_return" ADD CONSTRAINT "vehicle_return_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_return_damage" ADD CONSTRAINT "vehicle_return_damage_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "vehicle_return"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_return_damage" ADD CONSTRAINT "vehicle_return_damage_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_return_damage" ADD CONSTRAINT "vehicle_return_damage_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
