-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('IN_APP', 'WECHAT_OFFICIAL_ACCOUNT', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "notification_template_type" AS ENUM ('APPLICATION_PROGRESS', 'MATERIAL_REQUIRED', 'FINAL_PLAN_PENDING', 'CONTRACT_PENDING', 'PAYMENT_PENDING', 'BILL_DUE', 'BILL_OVERDUE', 'SERVICE_CASE_UPDATE', 'RESCUE_UPDATE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "notification_template_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('APPLICATION_PROGRESS', 'MATERIAL_REQUIRED', 'FINAL_PLAN_PENDING', 'CONTRACT_PENDING', 'PAYMENT_PENDING', 'BILL_DUE', 'BILL_OVERDUE', 'SERVICE_CASE_UPDATE', 'RESCUE_UPDATE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED', 'READ', 'CANCELLED');

-- CreateEnum
CREATE TYPE "notification_event_type" AS ENUM ('APPLICATION_SUBMITTED', 'MATERIAL_REQUIRED', 'FINAL_PLAN_READY', 'CONTRACT_PENDING', 'PAYMENT_PENDING', 'BILL_DUE', 'BILL_OVERDUE', 'SERVICE_CASE_SUBMITTED', 'SERVICE_CASE_UPDATED', 'RESCUE_UPDATED');

-- CreateEnum
CREATE TYPE "notification_event_status" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "notification_template" (
    "id" UUID NOT NULL,
    "template_code" VARCHAR(96) NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "template_type" "notification_template_type" NOT NULL,
    "template_status" "notification_template_status" NOT NULL DEFAULT 'ACTIVE',
    "title" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "provider_template_id" VARCHAR(128),
    "content" TEXT,
    "variables" JSONB,
    "provider_config" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "notification_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_record" (
    "id" UUID NOT NULL,
    "notification_no" VARCHAR(64) NOT NULL,
    "customer_id" UUID,
    "customer_account_id" UUID,
    "recipient_phone" VARCHAR(32),
    "recipient_open_id" VARCHAR(128),
    "channel" "notification_channel" NOT NULL,
    "template_code" VARCHAR(96),
    "template_id" UUID,
    "notification_type" "notification_type" NOT NULL,
    "notification_status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "title" VARCHAR(128),
    "content" TEXT,
    "url" VARCHAR(512),
    "provider_message_id" VARCHAR(128),
    "provider_response" JSONB,
    "payload" JSONB,
    "error_message" TEXT,
    "scheduled_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "notification_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_event" (
    "id" UUID NOT NULL,
    "notification_id" UUID,
    "event_type" "notification_event_type" NOT NULL,
    "aggregate_type" VARCHAR(64),
    "aggregate_id" UUID,
    "customer_id" UUID,
    "payload" JSONB,
    "event_status" "notification_event_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_run_at" TIMESTAMPTZ(6),
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_template_template_code_key" ON "notification_template"("template_code");

-- CreateIndex
CREATE INDEX "notification_template_channel_idx" ON "notification_template"("channel");

-- CreateIndex
CREATE INDEX "notification_template_template_type_idx" ON "notification_template"("template_type");

-- CreateIndex
CREATE INDEX "notification_template_template_status_idx" ON "notification_template"("template_status");

-- CreateIndex
CREATE UNIQUE INDEX "notification_record_notification_no_key" ON "notification_record"("notification_no");

-- CreateIndex
CREATE INDEX "notification_record_customer_id_idx" ON "notification_record"("customer_id");

-- CreateIndex
CREATE INDEX "notification_record_customer_account_id_idx" ON "notification_record"("customer_account_id");

-- CreateIndex
CREATE INDEX "notification_record_channel_idx" ON "notification_record"("channel");

-- CreateIndex
CREATE INDEX "notification_record_notification_type_idx" ON "notification_record"("notification_type");

-- CreateIndex
CREATE INDEX "notification_record_notification_status_idx" ON "notification_record"("notification_status");

-- CreateIndex
CREATE INDEX "notification_record_created_at_idx" ON "notification_record"("created_at");

-- CreateIndex
CREATE INDEX "notification_event_event_type_idx" ON "notification_event"("event_type");

-- CreateIndex
CREATE INDEX "notification_event_aggregate_type_aggregate_id_idx" ON "notification_event"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "notification_event_customer_id_idx" ON "notification_event"("customer_id");

-- CreateIndex
CREATE INDEX "notification_event_event_status_idx" ON "notification_event"("event_status");

-- CreateIndex
CREATE INDEX "notification_event_next_run_at_idx" ON "notification_event"("next_run_at");

-- AddForeignKey
ALTER TABLE "notification_record" ADD CONSTRAINT "notification_record_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_record" ADD CONSTRAINT "notification_record_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "notification_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_event" ADD CONSTRAINT "notification_event_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notification_record"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_event" ADD CONSTRAINT "notification_event_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
