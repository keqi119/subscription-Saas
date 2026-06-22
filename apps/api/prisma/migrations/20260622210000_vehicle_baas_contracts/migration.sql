-- CreateEnum
CREATE TYPE "vehicle_baas_contract_status" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'EXPIRED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "vehicle_baas_billing_cycle" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "vehicle_baas_contract_attachment_type" AS ENUM ('CONTRACT', 'INVOICE', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_baas_cost_record_status" AS ENUM ('SCHEDULED', 'CONFIRMED', 'PAID', 'WAIVED', 'VOIDED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "vehicle_baas_cost_source" AS ENUM ('GENERATED', 'MANUAL', 'IMPORTED');

-- CreateTable
CREATE TABLE "vehicle_baas_contract" (
    "id" UUID NOT NULL,
    "contract_no" VARCHAR(128) NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "provider_name" VARCHAR(128) NOT NULL,
    "provider_contract_no" VARCHAR(128),
    "battery_package_name" VARCHAR(128),
    "battery_serial_no" VARCHAR(128),
    "contract_status" "vehicle_baas_contract_status" NOT NULL DEFAULT 'DRAFT',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "billing_cycle" "vehicle_baas_billing_cycle" NOT NULL DEFAULT 'MONTHLY',
    "rental_amount" BIGINT NOT NULL,
    "currency" VARCHAR(16) DEFAULT 'CNY',
    "payment_day_of_month" INTEGER NOT NULL,
    "grace_days" INTEGER DEFAULT 0,
    "invoice_required" BOOLEAN NOT NULL DEFAULT false,
    "tax_included" BOOLEAN NOT NULL DEFAULT true,
    "remark" TEXT,
    "snapshot" JSONB,
    "activated_at" TIMESTAMPTZ(6),
    "suspended_at" TIMESTAMPTZ(6),
    "terminated_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_baas_contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_baas_contract_attachment" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "original_name" VARCHAR(255),
    "mime_type" VARCHAR(128),
    "file_size" INTEGER,
    "bucket" VARCHAR(256),
    "object_key" VARCHAR(512),
    "attachment_type" "vehicle_baas_contract_attachment_type" NOT NULL DEFAULT 'CONTRACT',
    "title" VARCHAR(128),
    "description" TEXT,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_baas_contract_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_baas_cost_record" (
    "id" UUID NOT NULL,
    "cost_record_no" VARCHAR(64) NOT NULL,
    "contract_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "cost_period" VARCHAR(7) NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "cost_amount" BIGINT NOT NULL,
    "currency" VARCHAR(16) DEFAULT 'CNY',
    "cost_status" "vehicle_baas_cost_record_status" NOT NULL DEFAULT 'SCHEDULED',
    "cost_source" "vehicle_baas_cost_source" NOT NULL DEFAULT 'GENERATED',
    "confirmed_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "voided_at" TIMESTAMPTZ(6),
    "payment_ref_no" VARCHAR(128),
    "invoice_no" VARCHAR(128),
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_baas_cost_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_baas_contract_contract_no_key" ON "vehicle_baas_contract"("contract_no");

-- CreateIndex
CREATE INDEX "vehicle_baas_contract_vehicle_id_idx" ON "vehicle_baas_contract"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_baas_contract_contract_status_idx" ON "vehicle_baas_contract"("contract_status");

-- CreateIndex
CREATE INDEX "vehicle_baas_contract_effective_from_idx" ON "vehicle_baas_contract"("effective_from");

-- CreateIndex
CREATE INDEX "vehicle_baas_contract_effective_to_idx" ON "vehicle_baas_contract"("effective_to");

-- CreateIndex
CREATE INDEX "vehicle_baas_contract_attachment_contract_id_idx" ON "vehicle_baas_contract_attachment"("contract_id");

-- CreateIndex
CREATE INDEX "vehicle_baas_contract_attachment_attachment_type_idx" ON "vehicle_baas_contract_attachment"("attachment_type");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_baas_cost_record_cost_record_no_key" ON "vehicle_baas_cost_record"("cost_record_no");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_baas_cost_record_contract_id_cost_period_key" ON "vehicle_baas_cost_record"("contract_id", "cost_period");

-- CreateIndex
CREATE INDEX "vehicle_baas_cost_record_vehicle_id_idx" ON "vehicle_baas_cost_record"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_baas_cost_record_cost_period_idx" ON "vehicle_baas_cost_record"("cost_period");

-- CreateIndex
CREATE INDEX "vehicle_baas_cost_record_due_date_idx" ON "vehicle_baas_cost_record"("due_date");

-- CreateIndex
CREATE INDEX "vehicle_baas_cost_record_cost_status_idx" ON "vehicle_baas_cost_record"("cost_status");

-- AddForeignKey
ALTER TABLE "vehicle_baas_contract" ADD CONSTRAINT "vehicle_baas_contract_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_baas_contract_attachment" ADD CONSTRAINT "vehicle_baas_contract_attachment_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "vehicle_baas_contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_baas_cost_record" ADD CONSTRAINT "vehicle_baas_cost_record_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "vehicle_baas_contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_baas_cost_record" ADD CONSTRAINT "vehicle_baas_cost_record_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
