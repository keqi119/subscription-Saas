-- CreateEnum
CREATE TYPE "vehicle_handover_type" AS ENUM (
  'DELIVERY_OUTBOUND',
  'RETURN_INBOUND'
);

-- CreateEnum
CREATE TYPE "vehicle_handover_operator_type" AS ENUM (
  'INTERNAL',
  'EXTERNAL'
);

-- CreateEnum
CREATE TYPE "vehicle_handover_work_order_status" AS ENUM (
  'DRAFT',
  'ASSIGNED',
  'FIELD_IN_PROGRESS',
  'EVIDENCE_SUBMITTED',
  'CUSTOMER_REVIEWING',
  'CUSTOMER_OBJECTED',
  'CUSTOMER_CONFIRMED',
  'SIGNING',
  'CUSTOMER_SIGNED',
  'PLATFORM_SEALED',
  'FIELD_COMPLETED',
  'OPS_REVIEW_PENDING',
  'OPS_REVIEWED',
  'VOIDED',
  'FAILED',
  'CANCELLED'
);

-- CreateEnum
CREATE TYPE "vehicle_handover_ops_review_status" AS ENUM (
  'NOT_REQUIRED',
  'PENDING',
  'APPROVED',
  'REJECTED'
);

-- CreateTable
CREATE TABLE "vehicle_handover_work_order" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "vehicle_delivery_id" UUID,
    "handover_id" UUID,
    "handover_type" "vehicle_handover_type" NOT NULL,
    "status" "vehicle_handover_work_order_status" NOT NULL DEFAULT 'DRAFT',
    "operator_type" "vehicle_handover_operator_type" NOT NULL DEFAULT 'INTERNAL',
    "assigned_internal_user_id" UUID,
    "external_operator_name" VARCHAR(64),
    "external_operator_phone" VARCHAR(32),
    "external_operator_organization" VARCHAR(128),
    "access_token_hash" VARCHAR(128),
    "access_token_expires_at" TIMESTAMPTZ(6),
    "access_token_revoked_at" TIMESTAMPTZ(6),
    "first_accessed_at" TIMESTAMPTZ(6),
    "last_accessed_at" TIMESTAMPTZ(6),
    "field_started_at" TIMESTAMPTZ(6),
    "field_submitted_at" TIMESTAMPTZ(6),
    "customer_review_started_at" TIMESTAMPTZ(6),
    "customer_confirmed_at" TIMESTAMPTZ(6),
    "customer_objected_at" TIMESTAMPTZ(6),
    "customer_objection_reason" TEXT,
    "field_completed_at" TIMESTAMPTZ(6),
    "ops_review_status" "vehicle_handover_ops_review_status" NOT NULL DEFAULT 'NOT_REQUIRED',
    "ops_reviewed_by" UUID,
    "ops_reviewed_at" TIMESTAMPTZ(6),
    "ops_review_notes" TEXT,
    "delivery_location" VARCHAR(255),
    "scheduled_at" TIMESTAMPTZ(6),
    "handover_mileage_km" INTEGER,
    "energy_level_text" VARCHAR(64),
    "fuel_level_text" VARCHAR(64),
    "accessory_checklist" JSONB,
    "damage_declared" BOOLEAN,
    "no_visible_damage_declared" BOOLEAN,
    "field_notes" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicle_handover_work_order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_handover_work_order_access_token_hash_key"
  ON "vehicle_handover_work_order"("access_token_hash");

-- CreateIndex
CREATE INDEX "vehicle_handover_work_order_order_id_idx" ON "vehicle_handover_work_order"("order_id");

-- CreateIndex
CREATE INDEX "vehicle_handover_work_order_vehicle_delivery_id_idx" ON "vehicle_handover_work_order"("vehicle_delivery_id");

-- CreateIndex
CREATE INDEX "vehicle_handover_work_order_handover_id_idx" ON "vehicle_handover_work_order"("handover_id");

-- CreateIndex
CREATE INDEX "vehicle_handover_work_order_handover_type_idx" ON "vehicle_handover_work_order"("handover_type");

-- CreateIndex
CREATE INDEX "vehicle_handover_work_order_status_idx" ON "vehicle_handover_work_order"("status");

-- CreateIndex
CREATE INDEX "vehicle_handover_work_order_operator_type_idx" ON "vehicle_handover_work_order"("operator_type");

-- CreateIndex
CREATE INDEX "vehicle_handover_work_order_assigned_internal_user_id_idx"
  ON "vehicle_handover_work_order"("assigned_internal_user_id");

-- CreateIndex
CREATE INDEX "vehicle_handover_work_order_access_token_expires_at_idx"
  ON "vehicle_handover_work_order"("access_token_expires_at");

-- CreateIndex
CREATE INDEX "vehicle_handover_work_order_ops_review_status_idx"
  ON "vehicle_handover_work_order"("ops_review_status");

-- CreateIndex
CREATE INDEX "vehicle_handover_work_order_ops_reviewed_by_idx"
  ON "vehicle_handover_work_order"("ops_reviewed_by");

-- AddForeignKey
ALTER TABLE "vehicle_handover_work_order"
  ADD CONSTRAINT "vehicle_handover_work_order_order_id_fkey"
  FOREIGN KEY ("order_id")
  REFERENCES "subscription_order"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_handover_work_order"
  ADD CONSTRAINT "vehicle_handover_work_order_vehicle_delivery_id_fkey"
  FOREIGN KEY ("vehicle_delivery_id")
  REFERENCES "vehicle_delivery"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_handover_work_order"
  ADD CONSTRAINT "vehicle_handover_work_order_handover_id_fkey"
  FOREIGN KEY ("handover_id")
  REFERENCES "vehicle_delivery_handover"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_handover_work_order"
  ADD CONSTRAINT "vehicle_handover_work_order_assigned_internal_user_id_fkey"
  FOREIGN KEY ("assigned_internal_user_id")
  REFERENCES "user"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_handover_work_order"
  ADD CONSTRAINT "vehicle_handover_work_order_ops_reviewed_by_fkey"
  FOREIGN KEY ("ops_reviewed_by")
  REFERENCES "user"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
