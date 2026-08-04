BEGIN;

ALTER TYPE "subscription_automation_job_type" ADD VALUE 'SUBMIT_BILL_DEBIT';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'QUERY_DEBIT_ATTEMPT';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'SEND_DEBIT_FAILURE_NOTICE';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'SYNC_PAYMENT_MANDATE';

ALTER TYPE "payment_channel" ADD VALUE 'WECHAT_AUTO_DEBIT';
ALTER TYPE "notification_template_type" ADD VALUE 'AUTO_DEBIT_FAILURE';
ALTER TYPE "notification_type" ADD VALUE 'AUTO_DEBIT_FAILURE';
ALTER TYPE "notification_event_type" ADD VALUE 'AUTO_DEBIT_FAILED';

CREATE TYPE "payment_mandate_status" AS ENUM (
  'PENDING',
  'ACTIVE',
  'SUSPENDED',
  'REVOKED',
  'EXPIRED',
  'FAILED'
);

CREATE TYPE "debit_attempt_status" AS ENUM (
  'CREATED',
  'SUBMITTING',
  'PROCESSING',
  'UNKNOWN',
  'SUCCEEDED',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
  'CANCELLED'
);

CREATE TYPE "debit_retry_slot" AS ENUM (
  'DUE',
  'D1',
  'D3',
  'MANUAL'
);

CREATE TABLE "payment_mandate" (
  "id" UUID NOT NULL,
  "mandate_no" VARCHAR(64) NOT NULL,
  "customer_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "provider" "payment_provider_type" NOT NULL,
  "provider_mandate_id" VARCHAR(128),
  "provider_template_id" VARCHAR(128),
  "provider_mode" VARCHAR(64) NOT NULL,
  "status" "payment_mandate_status" NOT NULL DEFAULT 'PENDING',
  "signed_at" TIMESTAMPTZ(6),
  "effective_at" TIMESTAMPTZ(6),
  "suspended_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6),
  "last_synced_at" TIMESTAMPTZ(6),
  "request_snapshot" JSONB,
  "response_snapshot" JSONB,
  "callback_snapshot" JSONB,
  "error_snapshot" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "created_by" UUID,
  "updated_by" UUID,

  CONSTRAINT "payment_mandate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "debit_attempt" (
  "id" UUID NOT NULL,
  "debit_attempt_no" VARCHAR(64) NOT NULL,
  "mandate_id" UUID NOT NULL,
  "bill_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "payment_order_id" UUID NOT NULL,
  "retry_slot" "debit_retry_slot" NOT NULL,
  "status" "debit_attempt_status" NOT NULL DEFAULT 'CREATED',
  "requested_amount" BIGINT NOT NULL,
  "confirmed_amount" BIGINT NOT NULL DEFAULT 0,
  "idempotency_key" VARCHAR(256) NOT NULL,
  "provider_out_trade_no" VARCHAR(128) NOT NULL,
  "provider_transaction_id" VARCHAR(128),
  "submitted_at" TIMESTAMPTZ(6),
  "accepted_at" TIMESTAMPTZ(6),
  "resolved_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "request_snapshot" JSONB,
  "response_snapshot" JSONB,
  "callback_snapshot" JSONB,
  "error_snapshot" JSONB,
  "last_error_code" VARCHAR(128),
  "last_error_message" VARCHAR(512),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "created_by" UUID,
  "updated_by" UUID,

  CONSTRAINT "debit_attempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "debit_attempt_requested_amount_check" CHECK ("requested_amount" > 0),
  CONSTRAINT "debit_attempt_confirmed_amount_check" CHECK ("confirmed_amount" >= 0)
);

CREATE UNIQUE INDEX "payment_mandate_mandate_no_key"
ON "payment_mandate"("mandate_no");

CREATE UNIQUE INDEX "payment_mandate_one_open_per_order_key"
ON "payment_mandate"("order_id")
WHERE "status" IN ('PENDING', 'ACTIVE', 'SUSPENDED');

CREATE UNIQUE INDEX "payment_mandate_provider_mandate_id_key"
ON "payment_mandate"("provider", "provider_mandate_id")
WHERE "provider_mandate_id" IS NOT NULL;

CREATE INDEX "payment_mandate_customer_id_created_at_idx"
ON "payment_mandate"("customer_id", "created_at");

CREATE INDEX "payment_mandate_order_id_status_idx"
ON "payment_mandate"("order_id", "status");

CREATE INDEX "payment_mandate_provider_provider_mandate_id_idx"
ON "payment_mandate"("provider", "provider_mandate_id");

CREATE INDEX "payment_mandate_status_last_synced_at_idx"
ON "payment_mandate"("status", "last_synced_at");

CREATE UNIQUE INDEX "debit_attempt_debit_attempt_no_key"
ON "debit_attempt"("debit_attempt_no");

CREATE UNIQUE INDEX "debit_attempt_payment_order_id_key"
ON "debit_attempt"("payment_order_id");

CREATE UNIQUE INDEX "debit_attempt_idempotency_key_key"
ON "debit_attempt"("idempotency_key");

CREATE UNIQUE INDEX "debit_attempt_provider_out_trade_no_key"
ON "debit_attempt"("provider_out_trade_no");

CREATE INDEX "debit_attempt_mandate_id_status_idx"
ON "debit_attempt"("mandate_id", "status");

CREATE INDEX "debit_attempt_bill_id_status_idx"
ON "debit_attempt"("bill_id", "status");

CREATE INDEX "debit_attempt_order_id_created_at_idx"
ON "debit_attempt"("order_id", "created_at");

CREATE INDEX "debit_attempt_customer_id_created_at_idx"
ON "debit_attempt"("customer_id", "created_at");

CREATE INDEX "debit_attempt_status_created_at_idx"
ON "debit_attempt"("status", "created_at");

CREATE INDEX "debit_attempt_provider_transaction_id_idx"
ON "debit_attempt"("provider_transaction_id");

ALTER TABLE "payment_mandate"
ADD CONSTRAINT "payment_mandate_customer_id_fkey"
FOREIGN KEY ("customer_id") REFERENCES "customer"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_mandate"
ADD CONSTRAINT "payment_mandate_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "debit_attempt"
ADD CONSTRAINT "debit_attempt_mandate_id_fkey"
FOREIGN KEY ("mandate_id") REFERENCES "payment_mandate"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "debit_attempt"
ADD CONSTRAINT "debit_attempt_bill_id_fkey"
FOREIGN KEY ("bill_id") REFERENCES "receivable_bill"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "debit_attempt"
ADD CONSTRAINT "debit_attempt_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "debit_attempt"
ADD CONSTRAINT "debit_attempt_customer_id_fkey"
FOREIGN KEY ("customer_id") REFERENCES "customer"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "debit_attempt"
ADD CONSTRAINT "debit_attempt_payment_order_id_fkey"
FOREIGN KEY ("payment_order_id") REFERENCES "payment_order"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
