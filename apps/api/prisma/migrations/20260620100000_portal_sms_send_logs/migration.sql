-- CreateEnum
CREATE TYPE "sms_provider_type" AS ENUM ('MOCK', 'ALIYUN');

-- CreateEnum
CREATE TYPE "sms_send_status" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "sms_send_log" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "phone_masked" VARCHAR(32),
    "purpose" "customer_verification_code_purpose" NOT NULL,
    "provider" "sms_provider_type" NOT NULL,
    "send_status" "sms_send_status" NOT NULL,
    "provider_message_id" VARCHAR(128),
    "provider_request_id" VARCHAR(128),
    "provider_response" JSONB,
    "error_code" VARCHAR(128),
    "error_message" TEXT,
    "verification_code_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_send_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sms_send_log_phone_idx" ON "sms_send_log"("phone");

-- CreateIndex
CREATE INDEX "sms_send_log_purpose_idx" ON "sms_send_log"("purpose");

-- CreateIndex
CREATE INDEX "sms_send_log_provider_idx" ON "sms_send_log"("provider");

-- CreateIndex
CREATE INDEX "sms_send_log_send_status_idx" ON "sms_send_log"("send_status");

-- CreateIndex
CREATE INDEX "sms_send_log_created_at_idx" ON "sms_send_log"("created_at");
