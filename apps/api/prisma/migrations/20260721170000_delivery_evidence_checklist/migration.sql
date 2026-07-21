-- CreateEnum
CREATE TYPE "delivery_evidence_type" AS ENUM (
  'CUSTOMER_WITH_VEHICLE_FRONT',
  'VEHICLE_FRONT',
  'VEHICLE_REAR',
  'VIN_OR_FRAME_NUMBER',
  'ODOMETER_DASHBOARD',
  'INTERIOR_REAR',
  'INTERIOR_FRONT',
  'WALKAROUND_VIDEO',
  'WHEEL_CLOSEUP_FRONT_LEFT',
  'WHEEL_CLOSEUP_FRONT_RIGHT',
  'WHEEL_CLOSEUP_REAR_LEFT',
  'WHEEL_CLOSEUP_REAR_RIGHT',
  'DAMAGE_STATIC_CLOSEUP',
  'NO_VISIBLE_DAMAGE_DECLARATION'
);

-- CreateEnum
CREATE TYPE "delivery_evidence_requirement_level" AS ENUM (
  'REQUIRED',
  'CONDITIONAL',
  'OPTIONAL'
);

-- CreateEnum
CREATE TYPE "delivery_evidence_status" AS ENUM (
  'NOT_STARTED',
  'UPLOADED',
  'APPROVED',
  'REJECTED'
);

-- CreateEnum
CREATE TYPE "delivery_evidence_review_status" AS ENUM (
  'NOT_STARTED',
  'PENDING',
  'APPROVED',
  'REJECTED'
);

-- CreateEnum
CREATE TYPE "delivery_evidence_media_type" AS ENUM (
  'PHOTO',
  'VIDEO'
);

-- CreateTable
CREATE TABLE "vehicle_delivery_evidence_item" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "vehicle_delivery_id" UUID,
    "handover_id" UUID,
    "evidence_type" "delivery_evidence_type" NOT NULL,
    "requirement_level" "delivery_evidence_requirement_level" NOT NULL,
    "status" "delivery_evidence_status" NOT NULL DEFAULT 'NOT_STARTED',
    "review_status" "delivery_evidence_review_status" NOT NULL DEFAULT 'NOT_STARTED',
    "title" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "is_conditional" BOOLEAN NOT NULL DEFAULT false,
    "allows_multiple" BOOLEAN NOT NULL DEFAULT false,
    "condition_key" VARCHAR(64),
    "condition_value" VARCHAR(64),
    "declared_no_damage" BOOLEAN,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicle_delivery_evidence_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_delivery_evidence_file" (
    "id" UUID NOT NULL,
    "evidence_item_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "object_key" VARCHAR(512),
    "media_type" "delivery_evidence_media_type" NOT NULL,
    "uploaded_by" UUID,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicle_delivery_evidence_file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_delivery_evidence_item_order_id_idx" ON "vehicle_delivery_evidence_item"("order_id");

-- CreateIndex
CREATE INDEX "vehicle_delivery_evidence_item_vehicle_delivery_id_idx" ON "vehicle_delivery_evidence_item"("vehicle_delivery_id");

-- CreateIndex
CREATE INDEX "vehicle_delivery_evidence_item_handover_id_idx" ON "vehicle_delivery_evidence_item"("handover_id");

-- CreateIndex
CREATE INDEX "vehicle_delivery_evidence_item_evidence_type_idx" ON "vehicle_delivery_evidence_item"("evidence_type");

-- CreateIndex
CREATE INDEX "vehicle_delivery_evidence_item_requirement_level_idx" ON "vehicle_delivery_evidence_item"("requirement_level");

-- CreateIndex
CREATE INDEX "vehicle_delivery_evidence_item_status_idx" ON "vehicle_delivery_evidence_item"("status");

-- CreateIndex
CREATE INDEX "vehicle_delivery_evidence_item_review_status_idx" ON "vehicle_delivery_evidence_item"("review_status");

-- CreateIndex
CREATE INDEX "vehicle_delivery_evidence_item_reviewed_by_idx" ON "vehicle_delivery_evidence_item"("reviewed_by");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_delivery_evidence_file_evidence_item_id_file_id_key"
  ON "vehicle_delivery_evidence_file"("evidence_item_id", "file_id");

-- CreateIndex
CREATE INDEX "vehicle_delivery_evidence_file_evidence_item_id_idx" ON "vehicle_delivery_evidence_file"("evidence_item_id");

-- CreateIndex
CREATE INDEX "vehicle_delivery_evidence_file_file_id_idx" ON "vehicle_delivery_evidence_file"("file_id");

-- CreateIndex
CREATE INDEX "vehicle_delivery_evidence_file_media_type_idx" ON "vehicle_delivery_evidence_file"("media_type");

-- CreateIndex
CREATE INDEX "vehicle_delivery_evidence_file_uploaded_by_idx" ON "vehicle_delivery_evidence_file"("uploaded_by");

-- AddForeignKey
ALTER TABLE "vehicle_delivery_evidence_item"
  ADD CONSTRAINT "vehicle_delivery_evidence_item_order_id_fkey"
  FOREIGN KEY ("order_id")
  REFERENCES "subscription_order"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_delivery_evidence_item"
  ADD CONSTRAINT "vehicle_delivery_evidence_item_vehicle_delivery_id_fkey"
  FOREIGN KEY ("vehicle_delivery_id")
  REFERENCES "vehicle_delivery"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_delivery_evidence_item"
  ADD CONSTRAINT "vehicle_delivery_evidence_item_handover_id_fkey"
  FOREIGN KEY ("handover_id")
  REFERENCES "vehicle_delivery_handover"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_delivery_evidence_item"
  ADD CONSTRAINT "vehicle_delivery_evidence_item_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by")
  REFERENCES "user"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_delivery_evidence_file"
  ADD CONSTRAINT "vehicle_delivery_evidence_file_evidence_item_id_fkey"
  FOREIGN KEY ("evidence_item_id")
  REFERENCES "vehicle_delivery_evidence_item"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_delivery_evidence_file"
  ADD CONSTRAINT "vehicle_delivery_evidence_file_file_id_fkey"
  FOREIGN KEY ("file_id")
  REFERENCES "file_object"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_delivery_evidence_file"
  ADD CONSTRAINT "vehicle_delivery_evidence_file_uploaded_by_fkey"
  FOREIGN KEY ("uploaded_by")
  REFERENCES "user"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
