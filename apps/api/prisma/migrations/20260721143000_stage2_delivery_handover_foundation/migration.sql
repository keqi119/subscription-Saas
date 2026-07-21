-- AlterEnum
ALTER TYPE "contract_template_type" ADD VALUE 'DELIVERY_HANDOVER';

-- CreateEnum
CREATE TYPE "delivery_handover_status" AS ENUM (
  'DRAFT',
  'SOURCE_GENERATED',
  'PENDING_CUSTOMER_SIGNATURE',
  'PENDING_PLATFORM_SEAL',
  'SIGNED',
  'ARCHIVED',
  'FAILED',
  'CANCELLED'
);

-- CreateEnum
CREATE TYPE "delivery_handover_archive_status" AS ENUM (
  'NOT_STARTED',
  'PENDING',
  'ARCHIVED',
  'FAILED'
);

-- CreateTable
CREATE TABLE "vehicle_delivery_handover" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "vehicle_delivery_id" UUID,
    "stage1_contract_id" UUID NOT NULL,
    "handover_contract_id" UUID,
    "handover_esign_task_id" UUID,
    "source_document_file_id" UUID,
    "source_object_key" VARCHAR(512),
    "signed_document_file_id" UUID,
    "signed_object_key" VARCHAR(512),
    "status" "delivery_handover_status" NOT NULL DEFAULT 'DRAFT',
    "archive_status" "delivery_handover_archive_status" NOT NULL DEFAULT 'NOT_STARTED',
    "customer_signed_at" TIMESTAMPTZ(6),
    "platform_signed_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "metadata" JSONB,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_delivery_handover_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_delivery_handover_handover_contract_id_key"
  ON "vehicle_delivery_handover"("handover_contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_delivery_handover_handover_esign_task_id_key"
  ON "vehicle_delivery_handover"("handover_esign_task_id");

-- CreateIndex
CREATE INDEX "vehicle_delivery_handover_order_id_idx" ON "vehicle_delivery_handover"("order_id");

-- CreateIndex
CREATE INDEX "vehicle_delivery_handover_vehicle_delivery_id_idx" ON "vehicle_delivery_handover"("vehicle_delivery_id");

-- CreateIndex
CREATE INDEX "vehicle_delivery_handover_stage1_contract_id_idx" ON "vehicle_delivery_handover"("stage1_contract_id");

-- CreateIndex
CREATE INDEX "vehicle_delivery_handover_status_idx" ON "vehicle_delivery_handover"("status");

-- CreateIndex
CREATE INDEX "vehicle_delivery_handover_archive_status_idx" ON "vehicle_delivery_handover"("archive_status");

-- CreateIndex
CREATE INDEX "vehicle_delivery_handover_completed_at_idx" ON "vehicle_delivery_handover"("completed_at");

-- CreateIndex
CREATE INDEX "vehicle_delivery_handover_archived_at_idx" ON "vehicle_delivery_handover"("archived_at");

-- AddForeignKey
ALTER TABLE "vehicle_delivery_handover"
  ADD CONSTRAINT "vehicle_delivery_handover_order_id_fkey"
  FOREIGN KEY ("order_id")
  REFERENCES "subscription_order"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_delivery_handover"
  ADD CONSTRAINT "vehicle_delivery_handover_vehicle_delivery_id_fkey"
  FOREIGN KEY ("vehicle_delivery_id")
  REFERENCES "vehicle_delivery"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_delivery_handover"
  ADD CONSTRAINT "vehicle_delivery_handover_stage1_contract_id_fkey"
  FOREIGN KEY ("stage1_contract_id")
  REFERENCES "contract"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_delivery_handover"
  ADD CONSTRAINT "vehicle_delivery_handover_handover_contract_id_fkey"
  FOREIGN KEY ("handover_contract_id")
  REFERENCES "contract"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_delivery_handover"
  ADD CONSTRAINT "vehicle_delivery_handover_handover_esign_task_id_fkey"
  FOREIGN KEY ("handover_esign_task_id")
  REFERENCES "contract_esign_task"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
