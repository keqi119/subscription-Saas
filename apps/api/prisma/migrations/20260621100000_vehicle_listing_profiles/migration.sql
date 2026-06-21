-- CreateEnum
CREATE TYPE "vehicle_listing_status" AS ENUM ('DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "vehicle_listing_condition_grade" AS ENUM ('S', 'A', 'B', 'C', 'D', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "vehicle_listing_media_category" AS ENUM ('COVER', 'EXTERIOR', 'INTERIOR', 'DASHBOARD', 'CENTRAL_CONTROL', 'TIRE', 'CHARGING_PORT', 'DEFECT', 'INSPECTION_REPORT', 'BATTERY', 'OTHER');

-- CreateTable
CREATE TABLE "vehicle_listing_profile" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "listing_status" "vehicle_listing_status" NOT NULL DEFAULT 'DRAFT',
    "portal_visible" BOOLEAN NOT NULL DEFAULT false,
    "display_name" VARCHAR(128),
    "short_title" VARCHAR(128),
    "subtitle" VARCHAR(256),
    "selling_points" JSONB,
    "customer_tags" JSONB,
    "highlight_summary" TEXT,
    "condition_grade" "vehicle_listing_condition_grade",
    "condition_summary" TEXT,
    "has_major_accident" BOOLEAN,
    "has_flood_damage" BOOLEAN,
    "has_fire_damage" BOOLEAN,
    "has_structural_damage" BOOLEAN,
    "known_defects_summary" TEXT,
    "battery_health_percent" DECIMAL(5,2),
    "battery_health_checked_at" DATE,
    "estimated_range_km" INTEGER,
    "battery_remark" TEXT,
    "service_highlights" JSONB,
    "fee_description" TEXT,
    "application_notice" TEXT,
    "faq_snapshot" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMPTZ(6),
    "unpublished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_listing_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_listing_media" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "listing_profile_id" UUID,
    "file_name" VARCHAR(256) NOT NULL,
    "original_name" VARCHAR(256),
    "mime_type" VARCHAR(128),
    "file_size" INTEGER,
    "bucket" VARCHAR(256),
    "object_key" VARCHAR(512),
    "media_category" "vehicle_listing_media_category" NOT NULL,
    "caption" VARCHAR(256),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_cover" BOOLEAN NOT NULL DEFAULT false,
    "customer_visible" BOOLEAN NOT NULL DEFAULT true,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_listing_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_listing_plan" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "listing_profile_id" UUID,
    "subscription_plan_id" UUID NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "display_monthly_fee_amount" BIGINT,
    "display_remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_listing_plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_listing_profile_vehicle_id_key" ON "vehicle_listing_profile"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_listing_profile_listing_status_idx" ON "vehicle_listing_profile"("listing_status");

-- CreateIndex
CREATE INDEX "vehicle_listing_profile_portal_visible_idx" ON "vehicle_listing_profile"("portal_visible");

-- CreateIndex
CREATE INDEX "vehicle_listing_profile_sort_order_idx" ON "vehicle_listing_profile"("sort_order");

-- CreateIndex
CREATE INDEX "vehicle_listing_media_vehicle_id_idx" ON "vehicle_listing_media"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_listing_media_listing_profile_id_idx" ON "vehicle_listing_media"("listing_profile_id");

-- CreateIndex
CREATE INDEX "vehicle_listing_media_media_category_idx" ON "vehicle_listing_media"("media_category");

-- CreateIndex
CREATE INDEX "vehicle_listing_media_customer_visible_idx" ON "vehicle_listing_media"("customer_visible");

-- CreateIndex
CREATE INDEX "vehicle_listing_media_sort_order_idx" ON "vehicle_listing_media"("sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_listing_plan_vehicle_id_subscription_plan_id_key" ON "vehicle_listing_plan"("vehicle_id", "subscription_plan_id");

-- CreateIndex
CREATE INDEX "vehicle_listing_plan_vehicle_id_idx" ON "vehicle_listing_plan"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_listing_plan_listing_profile_id_idx" ON "vehicle_listing_plan"("listing_profile_id");

-- CreateIndex
CREATE INDEX "vehicle_listing_plan_subscription_plan_id_idx" ON "vehicle_listing_plan"("subscription_plan_id");

-- CreateIndex
CREATE INDEX "vehicle_listing_plan_visible_idx" ON "vehicle_listing_plan"("visible");

-- CreateIndex
CREATE INDEX "vehicle_listing_plan_recommended_idx" ON "vehicle_listing_plan"("recommended");

-- AddForeignKey
ALTER TABLE "vehicle_listing_profile" ADD CONSTRAINT "vehicle_listing_profile_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_listing_media" ADD CONSTRAINT "vehicle_listing_media_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_listing_media" ADD CONSTRAINT "vehicle_listing_media_listing_profile_id_fkey" FOREIGN KEY ("listing_profile_id") REFERENCES "vehicle_listing_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_listing_plan" ADD CONSTRAINT "vehicle_listing_plan_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_listing_plan" ADD CONSTRAINT "vehicle_listing_plan_listing_profile_id_fkey" FOREIGN KEY ("listing_profile_id") REFERENCES "vehicle_listing_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_listing_plan" ADD CONSTRAINT "vehicle_listing_plan_subscription_plan_id_fkey" FOREIGN KEY ("subscription_plan_id") REFERENCES "subscription_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
