-- CreateEnum
CREATE TYPE "vehicle_condition_report_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "vehicle_condition_item_area" AS ENUM ('EXTERIOR', 'INTERIOR', 'BATTERY', 'TIRE', 'BRAKE', 'CHASSIS', 'GLASS_LIGHT', 'ELECTRONICS', 'CHARGING', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_condition_item_type" AS ENUM ('DEFECT', 'CHECK', 'REPAIR_RECOMMENDATION', 'BATTERY_CHECK', 'SAFETY_CHECK', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_condition_item_severity" AS ENUM ('MINOR', 'MODERATE', 'MAJOR', 'SAFETY_CRITICAL');

-- CreateEnum
CREATE TYPE "vehicle_condition_item_result" AS ENUM ('NORMAL', 'ATTENTION', 'ABNORMAL', 'REPAIRED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "vehicle_condition_report" (
    "id" UUID NOT NULL,
    "report_no" VARCHAR(64) NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "report_status" "vehicle_condition_report_status" NOT NULL DEFAULT 'DRAFT',
    "customer_visible" BOOLEAN NOT NULL DEFAULT false,
    "inspection_date" DATE,
    "inspector_name" VARCHAR(128),
    "inspector_org" VARCHAR(128),
    "odometer_km" INTEGER,
    "overall_grade" "vehicle_listing_condition_grade",
    "summary" TEXT,
    "has_major_accident" BOOLEAN,
    "has_flood_damage" BOOLEAN,
    "has_fire_damage" BOOLEAN,
    "has_structural_damage" BOOLEAN,
    "exterior_summary" TEXT,
    "interior_summary" TEXT,
    "chassis_summary" TEXT,
    "tire_summary" TEXT,
    "brake_summary" TEXT,
    "glass_light_summary" TEXT,
    "battery_health_percent" DECIMAL(5,2),
    "battery_cycle_count" INTEGER,
    "battery_checked_at" DATE,
    "battery_estimated_range_km" INTEGER,
    "battery_warranty_until" DATE,
    "battery_remark" TEXT,
    "safety_conclusion" TEXT,
    "repair_suggestion" TEXT,
    "customer_summary" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_condition_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_condition_report_item" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "area" "vehicle_condition_item_area" NOT NULL,
    "item_type" "vehicle_condition_item_type" NOT NULL,
    "severity" "vehicle_condition_item_severity" NOT NULL DEFAULT 'MINOR',
    "result" "vehicle_condition_item_result" NOT NULL DEFAULT 'UNKNOWN',
    "part_name" VARCHAR(128),
    "title" VARCHAR(256),
    "description" TEXT,
    "affects_safety" BOOLEAN NOT NULL DEFAULT false,
    "repair_required" BOOLEAN NOT NULL DEFAULT false,
    "customer_visible" BOOLEAN NOT NULL DEFAULT true,
    "media_ids" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_condition_report_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_condition_report_report_no_key" ON "vehicle_condition_report"("report_no");

-- CreateIndex
CREATE INDEX "vehicle_condition_report_vehicle_id_idx" ON "vehicle_condition_report"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_condition_report_report_status_idx" ON "vehicle_condition_report"("report_status");

-- CreateIndex
CREATE INDEX "vehicle_condition_report_customer_visible_idx" ON "vehicle_condition_report"("customer_visible");

-- CreateIndex
CREATE INDEX "vehicle_condition_report_inspection_date_idx" ON "vehicle_condition_report"("inspection_date");

-- CreateIndex
CREATE INDEX "vehicle_condition_report_item_report_id_idx" ON "vehicle_condition_report_item"("report_id");

-- CreateIndex
CREATE INDEX "vehicle_condition_report_item_area_idx" ON "vehicle_condition_report_item"("area");

-- CreateIndex
CREATE INDEX "vehicle_condition_report_item_item_type_idx" ON "vehicle_condition_report_item"("item_type");

-- CreateIndex
CREATE INDEX "vehicle_condition_report_item_severity_idx" ON "vehicle_condition_report_item"("severity");

-- CreateIndex
CREATE INDEX "vehicle_condition_report_item_customer_visible_idx" ON "vehicle_condition_report_item"("customer_visible");

-- CreateIndex
CREATE INDEX "vehicle_condition_report_item_sort_order_idx" ON "vehicle_condition_report_item"("sort_order");

-- AddForeignKey
ALTER TABLE "vehicle_condition_report" ADD CONSTRAINT "vehicle_condition_report_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_condition_report_item" ADD CONSTRAINT "vehicle_condition_report_item_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "vehicle_condition_report"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
