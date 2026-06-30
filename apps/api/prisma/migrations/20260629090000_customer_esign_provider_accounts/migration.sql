-- CreateEnum
CREATE TYPE "esign_provider_account_type" AS ENUM ('PERSONAL', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "esign_provider_account_status" AS ENUM ('PENDING', 'REGISTERED', 'FAILED', 'DISABLED');

-- CreateEnum
CREATE TYPE "esign_real_name_status" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "esign_provider_account_source" AS ENUM ('SYSTEM_REGISTER', 'MANUAL');

-- CreateTable
CREATE TABLE "customer_esign_provider_account" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "provider" "esign_provider_type" NOT NULL,
    "account_type" "esign_provider_account_type" NOT NULL DEFAULT 'PERSONAL',
    "source" "esign_provider_account_source" NOT NULL DEFAULT 'SYSTEM_REGISTER',
    "provider_open_id" VARCHAR(96) NOT NULL,
    "provider_customer_id" VARCHAR(128),
    "registration_status" "esign_provider_account_status" NOT NULL DEFAULT 'PENDING',
    "real_name_status" "esign_real_name_status" NOT NULL DEFAULT 'UNVERIFIED',
    "verification_serial_no" VARCHAR(128),
    "verification_transaction_no" VARCHAR(128),
    "verified_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(128),
    "last_error_message" TEXT,
    "provider_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customer_esign_provider_account_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_esign_provider_account_provider_customer_id_account_type_key"
  ON "customer_esign_provider_account"("provider", "customer_id", "account_type");

-- CreateIndex
CREATE UNIQUE INDEX "customer_esign_provider_account_provider_provider_open_id_key"
  ON "customer_esign_provider_account"("provider", "provider_open_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_esign_provider_account_provider_provider_customer_id_key"
  ON "customer_esign_provider_account"("provider", "provider_customer_id");

-- CreateIndex
CREATE INDEX "customer_esign_provider_account_customer_id_idx" ON "customer_esign_provider_account"("customer_id");

-- CreateIndex
CREATE INDEX "customer_esign_provider_account_provider_idx" ON "customer_esign_provider_account"("provider");

-- CreateIndex
CREATE INDEX "customer_esign_provider_account_registration_status_idx" ON "customer_esign_provider_account"("registration_status");

-- CreateIndex
CREATE INDEX "customer_esign_provider_account_real_name_status_idx" ON "customer_esign_provider_account"("real_name_status");

-- AddForeignKey
ALTER TABLE "customer_esign_provider_account"
  ADD CONSTRAINT "customer_esign_provider_account_customer_id_fkey"
  FOREIGN KEY ("customer_id")
  REFERENCES "customer"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
