-- CreateEnum
CREATE TYPE "vehicle_insurance_policy_type" AS ENUM ('COMPULSORY_TRAFFIC', 'COMMERCIAL', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_insurance_policy_status" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED', 'PENDING_RENEWAL', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "vehicle_insurance_coverage_type" AS ENUM ('COMPULSORY_TRAFFIC', 'VEHICLE_DAMAGE', 'THIRD_PARTY_LIABILITY', 'VEHICLE_PERSONNEL', 'MEDICAL_OUTSIDE', 'ADDITIONAL', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_document_type" AS ENUM ('VEHICLE_LICENSE', 'COMPULSORY_INSURANCE_POLICY', 'COMMERCIAL_INSURANCE_POLICY', 'INSPECTION_CERTIFICATE', 'VEHICLE_AUTHORIZATION', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_document_status" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "insurance_claim_status" AS ENUM ('DRAFT', 'SUBMITTED', 'ACCEPTED', 'IN_PROGRESS', 'SETTLED', 'REJECTED', 'CLOSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "vehicle_insurance_policy" (
    "id" UUID NOT NULL,
    "policy_no" VARCHAR(128) NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "policy_type" "vehicle_insurance_policy_type" NOT NULL,
    "policy_status" "vehicle_insurance_policy_status" NOT NULL DEFAULT 'ACTIVE',
    "insurer_name" VARCHAR(128),
    "policy_holder_name" VARCHAR(128),
    "insured_name" VARCHAR(128),
    "effective_from" DATE NOT NULL,
    "effective_to" DATE NOT NULL,
    "renewal_reminder_at" TIMESTAMPTZ(6),
    "premium_amount" BIGINT,
    "insured_amount" BIGINT,
    "currency" VARCHAR(16) DEFAULT 'CNY',
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_insurance_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_insurance_coverage" (
    "id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "coverage_type" "vehicle_insurance_coverage_type" NOT NULL,
    "coverage_name" VARCHAR(128),
    "insured_amount" BIGINT,
    "deductible_amount" BIGINT,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_insurance_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_document" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "policy_id" UUID,
    "document_type" "vehicle_document_type" NOT NULL,
    "document_status" "vehicle_document_status" NOT NULL DEFAULT 'ACTIVE',
    "file_name" VARCHAR(255) NOT NULL,
    "original_name" VARCHAR(255),
    "mime_type" VARCHAR(128),
    "file_size" INTEGER,
    "bucket" VARCHAR(256),
    "object_key" VARCHAR(512),
    "title" VARCHAR(128),
    "description" TEXT,
    "effective_from" DATE,
    "effective_to" DATE,
    "customer_visible" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_claim" (
    "id" UUID NOT NULL,
    "claim_no" VARCHAR(64) NOT NULL,
    "service_case_id" UUID,
    "policy_id" UUID,
    "vehicle_id" UUID NOT NULL,
    "order_id" UUID,
    "customer_id" UUID,
    "claim_status" "insurance_claim_status" NOT NULL DEFAULT 'DRAFT',
    "insurer_claim_no" VARCHAR(128),
    "accident_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "estimated_amount" BIGINT,
    "approved_amount" BIGINT,
    "paid_amount" BIGINT,
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "insurance_claim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_insurance_policy_vehicle_id_policy_no_key" ON "vehicle_insurance_policy"("vehicle_id", "policy_no");

-- CreateIndex
CREATE INDEX "vehicle_insurance_policy_vehicle_id_idx" ON "vehicle_insurance_policy"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_insurance_policy_policy_type_idx" ON "vehicle_insurance_policy"("policy_type");

-- CreateIndex
CREATE INDEX "vehicle_insurance_policy_policy_status_idx" ON "vehicle_insurance_policy"("policy_status");

-- CreateIndex
CREATE INDEX "vehicle_insurance_policy_effective_from_idx" ON "vehicle_insurance_policy"("effective_from");

-- CreateIndex
CREATE INDEX "vehicle_insurance_policy_effective_to_idx" ON "vehicle_insurance_policy"("effective_to");

-- CreateIndex
CREATE INDEX "vehicle_insurance_coverage_policy_id_idx" ON "vehicle_insurance_coverage"("policy_id");

-- CreateIndex
CREATE INDEX "vehicle_insurance_coverage_coverage_type_idx" ON "vehicle_insurance_coverage"("coverage_type");

-- CreateIndex
CREATE INDEX "vehicle_document_vehicle_id_idx" ON "vehicle_document"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_document_policy_id_idx" ON "vehicle_document"("policy_id");

-- CreateIndex
CREATE INDEX "vehicle_document_document_type_idx" ON "vehicle_document"("document_type");

-- CreateIndex
CREATE INDEX "vehicle_document_document_status_idx" ON "vehicle_document"("document_status");

-- CreateIndex
CREATE INDEX "vehicle_document_customer_visible_idx" ON "vehicle_document"("customer_visible");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_claim_claim_no_key" ON "insurance_claim"("claim_no");

-- CreateIndex
CREATE INDEX "insurance_claim_service_case_id_idx" ON "insurance_claim"("service_case_id");

-- CreateIndex
CREATE INDEX "insurance_claim_policy_id_idx" ON "insurance_claim"("policy_id");

-- CreateIndex
CREATE INDEX "insurance_claim_vehicle_id_idx" ON "insurance_claim"("vehicle_id");

-- CreateIndex
CREATE INDEX "insurance_claim_order_id_idx" ON "insurance_claim"("order_id");

-- CreateIndex
CREATE INDEX "insurance_claim_customer_id_idx" ON "insurance_claim"("customer_id");

-- CreateIndex
CREATE INDEX "insurance_claim_claim_status_idx" ON "insurance_claim"("claim_status");

-- AddForeignKey
ALTER TABLE "vehicle_insurance_policy" ADD CONSTRAINT "vehicle_insurance_policy_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_insurance_coverage" ADD CONSTRAINT "vehicle_insurance_coverage_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "vehicle_insurance_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_document" ADD CONSTRAINT "vehicle_document_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_document" ADD CONSTRAINT "vehicle_document_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "vehicle_insurance_policy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claim" ADD CONSTRAINT "insurance_claim_service_case_id_fkey" FOREIGN KEY ("service_case_id") REFERENCES "service_case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claim" ADD CONSTRAINT "insurance_claim_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "vehicle_insurance_policy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claim" ADD CONSTRAINT "insurance_claim_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claim" ADD CONSTRAINT "insurance_claim_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claim" ADD CONSTRAINT "insurance_claim_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
