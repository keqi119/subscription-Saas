CREATE TYPE "billing_schedule_status" AS ENUM (
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED'
);

CREATE TYPE "subscription_automation_job_type" AS ENUM (
  'GENERATE_MONTHLY_RENT_BILL',
  'SEND_BILL_DUE_NOTICE',
  'MARK_BILL_OVERDUE',
  'SEND_BILL_OVERDUE_NOTICE'
);

CREATE TYPE "subscription_automation_job_status" AS ENUM (
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'DEAD_LETTER',
  'CANCELLED'
);

ALTER TABLE "receivable_bill"
ADD COLUMN "source_key" VARCHAR(256);

CREATE TABLE "billing_schedule" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "status" "billing_schedule_status" NOT NULL DEFAULT 'ACTIVE',
  "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
  "next_cycle_no" INTEGER NOT NULL,
  "next_period_start" DATE NOT NULL,
  "next_period_end" DATE NOT NULL,
  "next_generate_at" TIMESTAMPTZ(6) NOT NULL,
  "last_generated_bill_id" UUID,
  "last_generated_at" TIMESTAMPTZ(6),
  "pause_reason" VARCHAR(255),
  "completed_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "billing_schedule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_automation_job" (
  "id" UUID NOT NULL,
  "billing_schedule_id" UUID,
  "order_id" UUID,
  "bill_id" UUID,
  "job_type" "subscription_automation_job_type" NOT NULL,
  "job_status" "subscription_automation_job_status" NOT NULL DEFAULT 'PENDING',
  "idempotency_key" VARCHAR(256) NOT NULL,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 6,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ(6),
  "payload" JSONB,
  "result_snapshot" JSONB,
  "last_error_code" VARCHAR(128),
  "last_error_message" VARCHAR(512),
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "subscription_automation_job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receivable_bill_source_key_key"
ON "receivable_bill"("source_key");

CREATE UNIQUE INDEX "billing_schedule_order_id_key"
ON "billing_schedule"("order_id");

CREATE INDEX "billing_schedule_status_next_generate_at_idx"
ON "billing_schedule"("status", "next_generate_at");

CREATE INDEX "billing_schedule_last_generated_bill_id_idx"
ON "billing_schedule"("last_generated_bill_id");

CREATE UNIQUE INDEX "subscription_automation_job_idempotency_key_key"
ON "subscription_automation_job"("idempotency_key");

CREATE INDEX "subscription_automation_job_job_status_available_at_idx"
ON "subscription_automation_job"("job_status", "available_at");

CREATE INDEX "subscription_automation_job_billing_schedule_id_created_at_idx"
ON "subscription_automation_job"("billing_schedule_id", "created_at");

CREATE INDEX "subscription_automation_job_order_id_created_at_idx"
ON "subscription_automation_job"("order_id", "created_at");

CREATE INDEX "subscription_automation_job_bill_id_created_at_idx"
ON "subscription_automation_job"("bill_id", "created_at");

CREATE INDEX "subscription_automation_job_lease_expires_at_idx"
ON "subscription_automation_job"("lease_expires_at");

ALTER TABLE "billing_schedule"
ADD CONSTRAINT "billing_schedule_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_schedule"
ADD CONSTRAINT "billing_schedule_last_generated_bill_id_fkey"
FOREIGN KEY ("last_generated_bill_id") REFERENCES "receivable_bill"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "subscription_automation_job"
ADD CONSTRAINT "subscription_automation_job_billing_schedule_id_fkey"
FOREIGN KEY ("billing_schedule_id") REFERENCES "billing_schedule"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "subscription_automation_job"
ADD CONSTRAINT "subscription_automation_job_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "subscription_automation_job"
ADD CONSTRAINT "subscription_automation_job_bill_id_fkey"
FOREIGN KEY ("bill_id") REFERENCES "receivable_bill"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
