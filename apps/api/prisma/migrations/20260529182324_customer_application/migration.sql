-- CreateEnum
CREATE TYPE "customer_type" AS ENUM ('PERSONAL', 'COMPANY');

-- CreateEnum
CREATE TYPE "customer_grade" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "customer_status" AS ENUM ('LEAD', 'PENDING_APPLICATION', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVE', 'FROZEN', 'BLACKLISTED');

-- CreateEnum
CREATE TYPE "followup_type" AS ENUM ('PHONE', 'WECHAT', 'VISIT', 'OTHER');

-- CreateEnum
CREATE TYPE "application_status" AS ENUM ('DRAFT', 'SUBMITTED', 'NEED_MORE_INFO', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "application_material_type" AS ENUM ('ID_CARD', 'DRIVER_LICENSE', 'BANK_FLOW', 'WORK_PROOF', 'CREDIT_AUTH', 'OTHER');

-- CreateEnum
CREATE TYPE "material_status" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "customer_no" VARCHAR(64) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "mobile" VARCHAR(32) NOT NULL,
    "customer_type" "customer_type" NOT NULL DEFAULT 'PERSONAL',
    "source_channel" VARCHAR(64),
    "grade" "customer_grade",
    "risk_score" INTEGER,
    "status" "customer_status" NOT NULL DEFAULT 'LEAD',
    "owner_user_id" UUID,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_identity" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "id_card_no" VARCHAR(32),
    "id_card_front_file_id" UUID,
    "id_card_back_file_id" UUID,
    "driver_license_no" VARCHAR(64),
    "driver_license_file_id" UUID,
    "license_valid_until" DATE,
    "realname_verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customer_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_profile" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "occupation" VARCHAR(128),
    "company_name" VARCHAR(128),
    "monthly_income_amount" BIGINT,
    "social_security_months" INTEGER,
    "housing_fund_months" INTEGER,
    "residence_address" VARCHAR(255),
    "emergency_contact_name" VARCHAR(64),
    "emergency_contact_mobile" VARCHAR(32),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customer_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_followup" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "followup_user_id" UUID NOT NULL,
    "followup_type" "followup_type" NOT NULL DEFAULT 'PHONE',
    "content" TEXT NOT NULL,
    "next_followup_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customer_followup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application" (
    "id" UUID NOT NULL,
    "application_no" VARCHAR(64) NOT NULL,
    "customer_id" UUID NOT NULL,
    "sales_user_id" UUID NOT NULL,
    "intended_model" VARCHAR(64),
    "intended_period_months" INTEGER,
    "status" "application_status" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "rejected_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_material" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "material_type" "application_material_type" NOT NULL,
    "file_id" UUID NOT NULL,
    "status" "material_status" NOT NULL DEFAULT 'PENDING',
    "review_remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "application_material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_object" (
    "id" UUID NOT NULL,
    "bucket" VARCHAR(64) NOT NULL,
    "object_key" VARCHAR(255) NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(128),
    "size_bytes" BIGINT NOT NULL,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_object_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_customer_no_key" ON "customer"("customer_no");

-- CreateIndex
CREATE INDEX "customer_mobile_idx" ON "customer"("mobile");

-- CreateIndex
CREATE INDEX "customer_owner_user_id_idx" ON "customer"("owner_user_id");

-- CreateIndex
CREATE INDEX "customer_status_idx" ON "customer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "customer_identity_customer_id_key" ON "customer_identity"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profile_customer_id_key" ON "customer_profile"("customer_id");

-- CreateIndex
CREATE INDEX "customer_followup_customer_id_idx" ON "customer_followup"("customer_id");

-- CreateIndex
CREATE INDEX "customer_followup_followup_user_id_idx" ON "customer_followup"("followup_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_application_no_key" ON "application"("application_no");

-- CreateIndex
CREATE INDEX "application_customer_id_idx" ON "application"("customer_id");

-- CreateIndex
CREATE INDEX "application_sales_user_id_idx" ON "application"("sales_user_id");

-- CreateIndex
CREATE INDEX "application_status_idx" ON "application"("status");

-- CreateIndex
CREATE INDEX "application_material_application_id_idx" ON "application_material"("application_id");

-- CreateIndex
CREATE INDEX "application_material_file_id_idx" ON "application_material"("file_id");

-- CreateIndex
CREATE INDEX "file_object_bucket_idx" ON "file_object"("bucket");

-- CreateIndex
CREATE INDEX "file_object_uploaded_by_idx" ON "file_object"("uploaded_by");

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_identity" ADD CONSTRAINT "customer_identity_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profile" ADD CONSTRAINT "customer_profile_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_followup" ADD CONSTRAINT "customer_followup_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_followup" ADD CONSTRAINT "customer_followup_followup_user_id_fkey" FOREIGN KEY ("followup_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application" ADD CONSTRAINT "application_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application" ADD CONSTRAINT "application_sales_user_id_fkey" FOREIGN KEY ("sales_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_material" ADD CONSTRAINT "application_material_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_material" ADD CONSTRAINT "application_material_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
