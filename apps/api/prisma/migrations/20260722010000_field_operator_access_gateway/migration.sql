-- AlterEnum
ALTER TYPE "customer_verification_code_purpose"
  ADD VALUE IF NOT EXISTS 'FIELD_HANDOVER_LOGIN';

-- CreateEnum
CREATE TYPE "field_operator_otp_purpose" AS ENUM (
  'FIELD_HANDOVER_LOGIN'
);

-- CreateEnum
CREATE TYPE "field_operator_audit_event_type" AS ENUM (
  'OTP_REQUESTED',
  'OTP_VERIFIED',
  'LOGIN_SUCCEEDED',
  'LOGIN_FAILED',
  'SESSION_REVOKED',
  'TASK_LIST_VIEWED',
  'TASK_VIEWED',
  'ACTION_FORBIDDEN'
);

-- CreateTable
CREATE TABLE "field_operator_otp" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "purpose" "field_operator_otp_purpose" NOT NULL,
    "code_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_sent_at" TIMESTAMPTZ(6),
    "ip_hash" VARCHAR(128),
    "user_agent_hash" VARCHAR(128),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "field_operator_otp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_operator_session" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "operator_type" "vehicle_handover_operator_type",
    "session_token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "last_seen_at" TIMESTAMPTZ(6),
    "wechat_open_id" VARCHAR(128),
    "wechat_union_id" VARCHAR(128),
    "ip_hash" VARCHAR(128),
    "user_agent_hash" VARCHAR(128),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "field_operator_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_operator_audit_log" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(32),
    "session_id" UUID,
    "work_order_id" UUID,
    "event_type" "field_operator_audit_event_type" NOT NULL,
    "ip_hash" VARCHAR(128),
    "user_agent_hash" VARCHAR(128),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_operator_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "field_operator_otp_phone_idx" ON "field_operator_otp"("phone");

-- CreateIndex
CREATE INDEX "field_operator_otp_purpose_idx" ON "field_operator_otp"("purpose");

-- CreateIndex
CREATE INDEX "field_operator_otp_expires_at_idx" ON "field_operator_otp"("expires_at");

-- CreateIndex
CREATE INDEX "field_operator_otp_consumed_at_idx" ON "field_operator_otp"("consumed_at");

-- CreateIndex
CREATE INDEX "field_operator_otp_last_sent_at_idx" ON "field_operator_otp"("last_sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "field_operator_session_session_token_hash_key"
  ON "field_operator_session"("session_token_hash");

-- CreateIndex
CREATE INDEX "field_operator_session_phone_idx" ON "field_operator_session"("phone");

-- CreateIndex
CREATE INDEX "field_operator_session_operator_type_idx" ON "field_operator_session"("operator_type");

-- CreateIndex
CREATE INDEX "field_operator_session_expires_at_idx" ON "field_operator_session"("expires_at");

-- CreateIndex
CREATE INDEX "field_operator_session_revoked_at_idx" ON "field_operator_session"("revoked_at");

-- CreateIndex
CREATE INDEX "field_operator_session_last_seen_at_idx" ON "field_operator_session"("last_seen_at");

-- CreateIndex
CREATE INDEX "field_operator_session_wechat_open_id_idx" ON "field_operator_session"("wechat_open_id");

-- CreateIndex
CREATE INDEX "field_operator_audit_log_phone_idx" ON "field_operator_audit_log"("phone");

-- CreateIndex
CREATE INDEX "field_operator_audit_log_session_id_idx" ON "field_operator_audit_log"("session_id");

-- CreateIndex
CREATE INDEX "field_operator_audit_log_work_order_id_idx" ON "field_operator_audit_log"("work_order_id");

-- CreateIndex
CREATE INDEX "field_operator_audit_log_event_type_idx" ON "field_operator_audit_log"("event_type");

-- CreateIndex
CREATE INDEX "field_operator_audit_log_created_at_idx" ON "field_operator_audit_log"("created_at");
