BEGIN;

CREATE TYPE "subscription_change_type" AS ENUM ('EXTENSION');
CREATE TYPE "subscription_change_status" AS ENUM (
  'DRAFT',
  'QUOTED',
  'CUSTOMER_CONFIRMED',
  'SIGNING_OR_PAYMENT',
  'SCHEDULED',
  'EXECUTING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
  'MANUAL_TAKEOVER'
);
CREATE TYPE "subscription_change_pricing_mode" AS ENUM (
  'CURRENT_VERSION',
  'ORIGINAL_PRICE',
  'APPROVED_DISCOUNT'
);
CREATE TYPE "subscription_change_quote_status" AS ENUM (
  'DRAFT',
  'FORMAL',
  'SUPERSEDED',
  'CUSTOMER_CONFIRMED',
  'CUSTOMER_REJECTED',
  'EXPIRED'
);
CREATE TYPE "contract_segment_type" AS ENUM ('BASE', 'EXTENSION');
CREATE TYPE "contract_segment_status" AS ENUM ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE "renewal_consideration_status" AS ENUM (
  'PENDING_DECISION',
  'RENEWAL_REQUESTED',
  'EXPIRY_CONFIRMED',
  'EXTENSION_IN_PROGRESS',
  'EXTENDED',
  'EXPIRED',
  'CANCELLED'
);
CREATE TYPE "renewal_decision" AS ENUM ('RENEW', 'EXPIRE');
CREATE TYPE "renewal_reminder_slot" AS ENUM ('D30', 'D14', 'D3');
CREATE TYPE "renewal_reminder_status" AS ENUM (
  'PENDING',
  'SENT',
  'FAILED',
  'SKIPPED_DECIDED',
  'SKIPPED_EXTENDED',
  'SKIPPED_LATE_ENROLLMENT',
  'CANCELLED'
);

ALTER TYPE "order_status" ADD VALUE 'PENDING_RETURN' BEFORE 'TERMINATED';
ALTER TYPE "lease_status" ADD VALUE 'RETURN_DUE';
ALTER TYPE "contract_template_type" ADD VALUE 'SUBSCRIPTION_EXTENSION';
ALTER TYPE "esign_signing_stage" ADD VALUE 'STAGE3_SUBSCRIPTION_EXTENSION';
ALTER TYPE "esign_document_type" ADD VALUE 'SUBSCRIPTION_EXTENSION_AGREEMENT';

ALTER TYPE "subscription_automation_job_type" ADD VALUE 'RENEWAL_CONSIDERATION_ENROLL';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'RENEWAL_REMINDER_D30';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'RENEWAL_REMINDER_D14';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'RENEWAL_REMINDER_D3';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'RENEWAL_EXPIRY_PROCESS';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'RENEWAL_RETURN_OVERDUE_D1';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'EXTENSION_SEGMENT_ACTIVATE';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'EXTENSION_BILLING_RESUME';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'EXTENSION_ENTITLEMENT_RENEW';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'EXTENSION_INSURANCE_VALIDATION';
ALTER TYPE "subscription_automation_job_type" ADD VALUE 'EXTENSION_EFFECTIVE_NOTICE';

ALTER TYPE "notification_template_type" ADD VALUE 'RENEWAL_REMINDER';
ALTER TYPE "notification_template_type" ADD VALUE 'RENEWAL_EXPIRY_RETURN';
ALTER TYPE "notification_template_type" ADD VALUE 'RENEWAL_RETURN_OVERDUE';
ALTER TYPE "notification_type" ADD VALUE 'RENEWAL_REMINDER';
ALTER TYPE "notification_type" ADD VALUE 'RENEWAL_EXPIRY_RETURN';
ALTER TYPE "notification_type" ADD VALUE 'RENEWAL_RETURN_OVERDUE';
ALTER TYPE "notification_event_type" ADD VALUE 'RENEWAL_REMINDER_D30';
ALTER TYPE "notification_event_type" ADD VALUE 'RENEWAL_REMINDER_D14';
ALTER TYPE "notification_event_type" ADD VALUE 'RENEWAL_REMINDER_D3';
ALTER TYPE "notification_event_type" ADD VALUE 'RENEWAL_EXPIRED';
ALTER TYPE "notification_event_type" ADD VALUE 'RENEWAL_RETURN_OVERDUE_D1';

CREATE TABLE "subscription_change_order" (
  "id" UUID NOT NULL,
  "change_no" VARCHAR(64) NOT NULL,
  "order_id" UUID NOT NULL,
  "change_type" "subscription_change_type" NOT NULL DEFAULT 'EXTENSION',
  "status" "subscription_change_status" NOT NULL DEFAULT 'DRAFT',
  "source_segment_id" UUID NOT NULL,
  "renewal_consideration_id" UUID,
  "extension_months" INTEGER NOT NULL,
  "pricing_mode" "subscription_change_pricing_mode" NOT NULL,
  "current_quote_id" UUID,
  "confirmed_quote_id" UUID,
  "contract_id" UUID,
  "target_start_date" DATE NOT NULL,
  "target_end_date" DATE NOT NULL,
  "completion_deadline_at" TIMESTAMPTZ(6) NOT NULL,
  "price_override_reason" TEXT,
  "price_override_approved_by" UUID,
  "price_override_approved_at" TIMESTAMPTZ(6),
  "cancel_reason" TEXT,
  "failure_code" VARCHAR(128),
  "failure_message" TEXT,
  "manual_takeover_reason" TEXT,
  "manual_takeover_by" UUID,
  "manual_takeover_at" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "created_by" UUID,
  "updated_by" UUID,

  CONSTRAINT "subscription_change_order_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_change_order_extension_months_positive" CHECK ("extension_months" > 0),
  CONSTRAINT "subscription_change_order_extension_dates_valid" CHECK ("target_end_date" >= "target_start_date")
);

CREATE TABLE "subscription_change_quote" (
  "id" UUID NOT NULL,
  "quote_no" VARCHAR(64) NOT NULL,
  "change_order_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" "subscription_change_quote_status" NOT NULL DEFAULT 'DRAFT',
  "pricing_mode" "subscription_change_pricing_mode" NOT NULL,
  "product_id" UUID,
  "product_version_id" UUID,
  "subscription_plan_id" UUID,
  "monthly_fee_amount" BIGINT NOT NULL,
  "deposit_amount" BIGINT NOT NULL DEFAULT 0,
  "mileage_limit_km" INTEGER NOT NULL,
  "over_mileage_fee_amount" BIGINT NOT NULL,
  "energy_limit_kwh" INTEGER,
  "energy_limit_count" INTEGER,
  "plan_snapshot" JSONB NOT NULL,
  "price_rule_snapshot" JSONB NOT NULL,
  "quote_snapshot" JSONB NOT NULL,
  "valid_until" TIMESTAMPTZ(6) NOT NULL,
  "formalized_at" TIMESTAMPTZ(6),
  "confirmed_at" TIMESTAMPTZ(6),
  "rejected_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID,

  CONSTRAINT "subscription_change_quote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_contract_segment" (
  "id" UUID NOT NULL,
  "segment_no" VARCHAR(64) NOT NULL,
  "order_id" UUID NOT NULL,
  "segment_type" "contract_segment_type" NOT NULL,
  "sequence_no" INTEGER NOT NULL,
  "status" "contract_segment_status" NOT NULL DEFAULT 'SCHEDULED',
  "start_date" DATE NOT NULL,
  "end_date" DATE NOT NULL,
  "source_contract_id" UUID,
  "source_change_order_id" UUID,
  "product_id" UUID,
  "product_version_id" UUID,
  "subscription_plan_id" UUID,
  "monthly_fee_amount" BIGINT NOT NULL,
  "mileage_limit_km" INTEGER NOT NULL,
  "over_mileage_fee_amount" BIGINT NOT NULL,
  "energy_limit_kwh" INTEGER,
  "energy_limit_count" INTEGER,
  "plan_snapshot" JSONB NOT NULL,
  "quote_snapshot" JSONB NOT NULL,
  "contract_snapshot" JSONB NOT NULL,
  "activated_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID,

  CONSTRAINT "subscription_contract_segment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_contract_segment_dates_valid" CHECK ("end_date" >= "start_date")
);

CREATE TABLE "renewal_consideration" (
  "id" UUID NOT NULL,
  "consideration_no" VARCHAR(64) NOT NULL,
  "order_id" UUID NOT NULL,
  "segment_id" UUID NOT NULL,
  "status" "renewal_consideration_status" NOT NULL DEFAULT 'PENDING_DECISION',
  "decision" "renewal_decision",
  "decided_at" TIMESTAMPTZ(6),
  "change_order_id" UUID,
  "consideration_start_at" TIMESTAMPTZ(6) NOT NULL,
  "completion_deadline_at" TIMESTAMPTZ(6) NOT NULL,
  "expired_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "created_by" UUID,
  "updated_by" UUID,

  CONSTRAINT "renewal_consideration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "renewal_reminder" (
  "id" UUID NOT NULL,
  "renewal_consideration_id" UUID NOT NULL,
  "slot" "renewal_reminder_slot" NOT NULL,
  "status" "renewal_reminder_status" NOT NULL DEFAULT 'PENDING',
  "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
  "notification_event_id" UUID,
  "sms_send_log_id" UUID,
  "template_code_snapshot" VARCHAR(128),
  "in_app_status" "notification_status",
  "sms_status" "sms_send_status",
  "channel_result" JSONB,
  "error_code" VARCHAR(128),
  "error_message" TEXT,
  "sent_at" TIMESTAMPTZ(6),
  "failed_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "renewal_reminder_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "subscription_automation_job"
  ADD COLUMN "change_order_id" UUID,
  ADD COLUMN "contract_segment_id" UUID,
  ADD COLUMN "renewal_consideration_id" UUID;

CREATE UNIQUE INDEX "subscription_change_order_change_no_key"
ON "subscription_change_order"("change_no");
CREATE UNIQUE INDEX "subscription_change_order_renewal_consideration_id_key"
ON "subscription_change_order"("renewal_consideration_id");
CREATE UNIQUE INDEX "subscription_change_order_current_quote_id_key"
ON "subscription_change_order"("current_quote_id");
CREATE UNIQUE INDEX "subscription_change_order_confirmed_quote_id_key"
ON "subscription_change_order"("confirmed_quote_id");
CREATE UNIQUE INDEX "subscription_change_order_contract_id_key"
ON "subscription_change_order"("contract_id");
CREATE UNIQUE INDEX "subscription_change_order_one_active_per_order"
ON "subscription_change_order" ("order_id")
WHERE "status" IN ('DRAFT','QUOTED','CUSTOMER_CONFIRMED','SIGNING_OR_PAYMENT','SCHEDULED','EXECUTING','MANUAL_TAKEOVER');
CREATE INDEX "subscription_change_order_order_id_created_at_idx"
ON "subscription_change_order"("order_id", "created_at");
CREATE INDEX "subscription_change_order_source_segment_id_idx"
ON "subscription_change_order"("source_segment_id");
CREATE INDEX "subscription_change_order_status_idx"
ON "subscription_change_order"("status");
CREATE INDEX "subscription_change_order_completion_deadline_at_idx"
ON "subscription_change_order"("completion_deadline_at");
CREATE INDEX "subscription_change_order_price_override_approved_by_idx"
ON "subscription_change_order"("price_override_approved_by");
CREATE INDEX "subscription_change_order_manual_takeover_by_idx"
ON "subscription_change_order"("manual_takeover_by");

CREATE UNIQUE INDEX "subscription_change_quote_quote_no_key"
ON "subscription_change_quote"("quote_no");
CREATE UNIQUE INDEX "subscription_change_quote_change_order_id_revision_key"
ON "subscription_change_quote"("change_order_id", "revision");
CREATE INDEX "subscription_change_quote_change_order_id_status_idx"
ON "subscription_change_quote"("change_order_id", "status");
CREATE INDEX "subscription_change_quote_product_id_idx"
ON "subscription_change_quote"("product_id");
CREATE INDEX "subscription_change_quote_product_version_id_idx"
ON "subscription_change_quote"("product_version_id");
CREATE INDEX "subscription_change_quote_subscription_plan_id_idx"
ON "subscription_change_quote"("subscription_plan_id");
CREATE INDEX "subscription_change_quote_valid_until_idx"
ON "subscription_change_quote"("valid_until");

CREATE UNIQUE INDEX "subscription_contract_segment_segment_no_key"
ON "subscription_contract_segment"("segment_no");
CREATE UNIQUE INDEX "subscription_contract_segment_source_change_order_id_key"
ON "subscription_contract_segment"("source_change_order_id");
CREATE UNIQUE INDEX "subscription_contract_segment_order_id_sequence_no_key"
ON "subscription_contract_segment"("order_id", "sequence_no");
CREATE UNIQUE INDEX "subscription_contract_segment_one_base_per_order"
ON "subscription_contract_segment" ("order_id")
WHERE "segment_type" = 'BASE';
CREATE UNIQUE INDEX "subscription_contract_segment_one_active_per_order"
ON "subscription_contract_segment" ("order_id")
WHERE "status" = 'ACTIVE';
CREATE INDEX "subscription_contract_segment_order_id_start_date_end_date_idx"
ON "subscription_contract_segment"("order_id", "start_date", "end_date");
CREATE INDEX "subscription_contract_segment_source_contract_id_idx"
ON "subscription_contract_segment"("source_contract_id");
CREATE INDEX "subscription_contract_segment_product_id_idx"
ON "subscription_contract_segment"("product_id");
CREATE INDEX "subscription_contract_segment_product_version_id_idx"
ON "subscription_contract_segment"("product_version_id");
CREATE INDEX "subscription_contract_segment_subscription_plan_id_idx"
ON "subscription_contract_segment"("subscription_plan_id");
CREATE INDEX "subscription_contract_segment_status_idx"
ON "subscription_contract_segment"("status");

CREATE UNIQUE INDEX "renewal_consideration_consideration_no_key"
ON "renewal_consideration"("consideration_no");
CREATE UNIQUE INDEX "renewal_consideration_segment_id_key"
ON "renewal_consideration"("segment_id");
CREATE UNIQUE INDEX "renewal_consideration_change_order_id_key"
ON "renewal_consideration"("change_order_id");
CREATE INDEX "renewal_consideration_order_id_status_idx"
ON "renewal_consideration"("order_id", "status");
CREATE INDEX "renewal_consideration_consideration_start_at_idx"
ON "renewal_consideration"("consideration_start_at");
CREATE INDEX "renewal_consideration_completion_deadline_at_idx"
ON "renewal_consideration"("completion_deadline_at");

CREATE UNIQUE INDEX "renewal_reminder_renewal_consideration_id_slot_key"
ON "renewal_reminder"("renewal_consideration_id", "slot");
CREATE INDEX "renewal_reminder_status_scheduled_at_idx"
ON "renewal_reminder"("status", "scheduled_at");
CREATE INDEX "renewal_reminder_notification_event_id_idx"
ON "renewal_reminder"("notification_event_id");
CREATE INDEX "renewal_reminder_sms_send_log_id_idx"
ON "renewal_reminder"("sms_send_log_id");

CREATE INDEX "subscription_automation_job_change_order_id_created_at_idx"
ON "subscription_automation_job"("change_order_id", "created_at");
CREATE INDEX "subscription_automation_job_contract_segment_id_created_at_idx"
ON "subscription_automation_job"("contract_segment_id", "created_at");
CREATE INDEX "subscription_automation_job_renewal_consideration_id_create_idx"
ON "subscription_automation_job"("renewal_consideration_id", "created_at");

ALTER TABLE "subscription_change_order"
ADD CONSTRAINT "subscription_change_order_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_change_order"
ADD CONSTRAINT "subscription_change_order_source_segment_id_fkey"
FOREIGN KEY ("source_segment_id") REFERENCES "subscription_contract_segment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_change_order"
ADD CONSTRAINT "subscription_change_order_renewal_consideration_id_fkey"
FOREIGN KEY ("renewal_consideration_id") REFERENCES "renewal_consideration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_change_order"
ADD CONSTRAINT "subscription_change_order_current_quote_id_fkey"
FOREIGN KEY ("current_quote_id") REFERENCES "subscription_change_quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_change_order"
ADD CONSTRAINT "subscription_change_order_confirmed_quote_id_fkey"
FOREIGN KEY ("confirmed_quote_id") REFERENCES "subscription_change_quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_change_order"
ADD CONSTRAINT "subscription_change_order_contract_id_fkey"
FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_change_order"
ADD CONSTRAINT "subscription_change_order_price_override_approved_by_fkey"
FOREIGN KEY ("price_override_approved_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_change_order"
ADD CONSTRAINT "subscription_change_order_manual_takeover_by_fkey"
FOREIGN KEY ("manual_takeover_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "subscription_change_quote"
ADD CONSTRAINT "subscription_change_quote_change_order_id_fkey"
FOREIGN KEY ("change_order_id") REFERENCES "subscription_change_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_change_quote"
ADD CONSTRAINT "subscription_change_quote_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_change_quote"
ADD CONSTRAINT "subscription_change_quote_product_version_id_fkey"
FOREIGN KEY ("product_version_id") REFERENCES "product_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_change_quote"
ADD CONSTRAINT "subscription_change_quote_subscription_plan_id_fkey"
FOREIGN KEY ("subscription_plan_id") REFERENCES "subscription_plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "subscription_contract_segment"
ADD CONSTRAINT "subscription_contract_segment_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_contract_segment"
ADD CONSTRAINT "subscription_contract_segment_source_contract_id_fkey"
FOREIGN KEY ("source_contract_id") REFERENCES "contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_contract_segment"
ADD CONSTRAINT "subscription_contract_segment_source_change_order_id_fkey"
FOREIGN KEY ("source_change_order_id") REFERENCES "subscription_change_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_contract_segment"
ADD CONSTRAINT "subscription_contract_segment_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_contract_segment"
ADD CONSTRAINT "subscription_contract_segment_product_version_id_fkey"
FOREIGN KEY ("product_version_id") REFERENCES "product_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_contract_segment"
ADD CONSTRAINT "subscription_contract_segment_subscription_plan_id_fkey"
FOREIGN KEY ("subscription_plan_id") REFERENCES "subscription_plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "renewal_consideration"
ADD CONSTRAINT "renewal_consideration_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "renewal_consideration"
ADD CONSTRAINT "renewal_consideration_segment_id_fkey"
FOREIGN KEY ("segment_id") REFERENCES "subscription_contract_segment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "renewal_consideration"
ADD CONSTRAINT "renewal_consideration_change_order_id_fkey"
FOREIGN KEY ("change_order_id") REFERENCES "subscription_change_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "renewal_reminder"
ADD CONSTRAINT "renewal_reminder_renewal_consideration_id_fkey"
FOREIGN KEY ("renewal_consideration_id") REFERENCES "renewal_consideration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "renewal_reminder"
ADD CONSTRAINT "renewal_reminder_notification_event_id_fkey"
FOREIGN KEY ("notification_event_id") REFERENCES "notification_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "renewal_reminder"
ADD CONSTRAINT "renewal_reminder_sms_send_log_id_fkey"
FOREIGN KEY ("sms_send_log_id") REFERENCES "sms_send_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "subscription_automation_job"
ADD CONSTRAINT "subscription_automation_job_change_order_id_fkey"
FOREIGN KEY ("change_order_id") REFERENCES "subscription_change_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_automation_job"
ADD CONSTRAINT "subscription_automation_job_contract_segment_id_fkey"
FOREIGN KEY ("contract_segment_id") REFERENCES "subscription_contract_segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_automation_job"
ADD CONSTRAINT "subscription_automation_job_renewal_consideration_id_fkey"
FOREIGN KEY ("renewal_consideration_id") REFERENCES "renewal_consideration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
