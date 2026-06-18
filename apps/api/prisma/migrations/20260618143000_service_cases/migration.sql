-- CreateEnum
CREATE TYPE "service_case_type" AS ENUM ('ACCIDENT_REPORT', 'RESCUE_REQUEST', 'CUSTOMER_SUPPORT');

-- CreateEnum
CREATE TYPE "service_case_source" AS ENUM ('CUSTOMER_PORTAL', 'BACK_OFFICE');

-- CreateEnum
CREATE TYPE "service_case_status" AS ENUM ('SUBMITTED', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "service_case_priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "rescue_type" AS ENUM ('TOWING', 'JUMP_START', 'TIRE_CHANGE', 'ACCIDENT_RESCUE', 'OTHER');

-- CreateEnum
CREATE TYPE "service_case_attachment_type" AS ENUM ('IMAGE', 'DOCUMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "service_case_action_type" AS ENUM ('SUBMIT', 'ACCEPT', 'UPDATE_STATUS', 'ADD_NOTE', 'UPLOAD_ATTACHMENT', 'RESOLVE', 'CLOSE', 'CANCEL');

-- CreateEnum
CREATE TYPE "service_case_actor_type" AS ENUM ('CUSTOMER', 'STAFF', 'SYSTEM');

-- CreateTable
CREATE TABLE "service_case" (
    "id" UUID NOT NULL,
    "case_no" VARCHAR(64) NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "vehicle_id" UUID,
    "case_type" "service_case_type" NOT NULL,
    "case_source" "service_case_source" NOT NULL DEFAULT 'CUSTOMER_PORTAL',
    "case_status" "service_case_status" NOT NULL DEFAULT 'SUBMITTED',
    "priority" "service_case_priority" NOT NULL DEFAULT 'NORMAL',
    "title" VARCHAR(128),
    "description" TEXT,
    "contact_name" VARCHAR(64),
    "contact_phone" VARCHAR(32),
    "occurred_at" TIMESTAMPTZ(6),
    "location_text" VARCHAR(255),
    "latitude" DECIMAL(10,6),
    "longitude" DECIMAL(10,6),
    "accident_has_injury" BOOLEAN,
    "accident_police_reported" BOOLEAN,
    "insurance_report_no" VARCHAR(128),
    "rescue_type" "rescue_type",
    "rescue_address" VARCHAR(255),
    "assigned_to" UUID,
    "accepted_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "close_remark" TEXT,
    "cancel_reason" TEXT,
    "snapshot" JSONB,
    "customer_snapshot" JSONB,
    "order_snapshot" JSONB,
    "vehicle_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "service_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_case_attachment" (
    "id" UUID NOT NULL,
    "service_case_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "original_name" VARCHAR(255),
    "mime_type" VARCHAR(128),
    "file_size" INTEGER,
    "bucket" VARCHAR(64),
    "object_key" VARCHAR(255),
    "attachment_type" "service_case_attachment_type" NOT NULL DEFAULT 'IMAGE',
    "uploaded_by_type" "service_case_actor_type" NOT NULL,
    "uploaded_by" UUID,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "service_case_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_case_action" (
    "id" UUID NOT NULL,
    "service_case_id" UUID NOT NULL,
    "action_type" "service_case_action_type" NOT NULL,
    "actor_type" "service_case_actor_type" NOT NULL,
    "actor_id" UUID,
    "actor_name" VARCHAR(64),
    "from_status" "service_case_status",
    "to_status" "service_case_status",
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_case_action_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_case_case_no_key" ON "service_case"("case_no");

-- CreateIndex
CREATE INDEX "service_case_customer_id_idx" ON "service_case"("customer_id");

-- CreateIndex
CREATE INDEX "service_case_order_id_idx" ON "service_case"("order_id");

-- CreateIndex
CREATE INDEX "service_case_vehicle_id_idx" ON "service_case"("vehicle_id");

-- CreateIndex
CREATE INDEX "service_case_case_type_idx" ON "service_case"("case_type");

-- CreateIndex
CREATE INDEX "service_case_case_status_idx" ON "service_case"("case_status");

-- CreateIndex
CREATE INDEX "service_case_priority_idx" ON "service_case"("priority");

-- CreateIndex
CREATE INDEX "service_case_created_at_idx" ON "service_case"("created_at");

-- CreateIndex
CREATE INDEX "service_case_attachment_service_case_id_idx" ON "service_case_attachment"("service_case_id");

-- CreateIndex
CREATE INDEX "service_case_attachment_attachment_type_idx" ON "service_case_attachment"("attachment_type");

-- CreateIndex
CREATE INDEX "service_case_action_service_case_id_idx" ON "service_case_action"("service_case_id");

-- CreateIndex
CREATE INDEX "service_case_action_action_type_idx" ON "service_case_action"("action_type");

-- CreateIndex
CREATE INDEX "service_case_action_actor_type_idx" ON "service_case_action"("actor_type");

-- CreateIndex
CREATE INDEX "service_case_action_created_at_idx" ON "service_case_action"("created_at");

-- AddForeignKey
ALTER TABLE "service_case" ADD CONSTRAINT "service_case_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_case" ADD CONSTRAINT "service_case_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_case" ADD CONSTRAINT "service_case_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_case_attachment" ADD CONSTRAINT "service_case_attachment_service_case_id_fkey" FOREIGN KEY ("service_case_id") REFERENCES "service_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_case_action" ADD CONSTRAINT "service_case_action_service_case_id_fkey" FOREIGN KEY ("service_case_id") REFERENCES "service_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
