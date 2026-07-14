-- CreateEnum
CREATE TYPE "esign_provider_real_name_status_source" AS ENUM ('UNKNOWN', 'CALLBACK', 'QUERY', 'MANUAL_ATTACH_PROVIDER_ID_ONLY');

-- CreateEnum
CREATE TYPE "esign_provider_cert_binding_status" AS ENUM ('UNKNOWN', 'UNBOUND', 'PENDING', 'BOUND', 'FAILED');

-- CreateEnum
CREATE TYPE "esign_provider_cert_binding_source" AS ENUM ('UNKNOWN', 'APPLY_CERT', 'QUERY_CERT', 'CALLBACK_CERT_STATUS');

-- AlterTable
ALTER TABLE "customer_esign_provider_account"
  ADD COLUMN "real_name_provider_status" VARCHAR(32),
  ADD COLUMN "real_name_provider_status_source" "esign_provider_real_name_status_source" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "real_name_provider_verified_at" TIMESTAMPTZ(6),
  ADD COLUMN "cert_binding_status" "esign_provider_cert_binding_status" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "cert_binding_source" "esign_provider_cert_binding_source" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "cert_bound_at" TIMESTAMPTZ(6),
  ADD COLUMN "cert_serial_no" VARCHAR(128),
  ADD COLUMN "provider_status_last_refreshed_at" TIMESTAMPTZ(6),
  ADD COLUMN "readiness_blocking_code" VARCHAR(128),
  ADD COLUMN "readiness_blocking_reason" TEXT;

-- CreateIndex
CREATE INDEX "customer_esign_provider_account_cert_binding_status_idx"
  ON "customer_esign_provider_account"("cert_binding_status");

-- CreateIndex
CREATE INDEX "customer_esign_provider_account_provider_status_last_refreshed_at_idx"
  ON "customer_esign_provider_account"("provider_status_last_refreshed_at");
