BEGIN;

CREATE TYPE "subscription_journey_status" AS ENUM (
  'RUNNING',
  'WAITING_CUSTOMER',
  'WAITING_MANUAL',
  'RETRY_SCHEDULED',
  'PAUSED',
  'EXCEPTION',
  'COMPLETED',
  'CANCELLED'
);

CREATE TYPE "subscription_journey_step_code" AS ENUM (
  'APPLICATION_VALIDATION',
  'FINAL_PLAN_DECISION',
  'CUSTOMER_PLAN_CONFIRMATION',
  'FINAL_VEHICLE_ALLOCATION',
  'ORDER_AND_CONTRACT_CREATION',
  'FADADA_SIGNING_AND_ARCHIVE',
  'INITIAL_BILLING',
  'CUSTOMER_JSAPI_PAYMENT',
  'HANDOVER_AND_STAGE2_CREATION',
  'DELIVERY_EVIDENCE_DECISION',
  'AUTHORITATIVE_ACTIVATION'
);

CREATE TYPE "subscription_journey_step_status" AS ENUM (
  'PENDING',
  'RUNNING',
  'WAITING_CUSTOMER',
  'WAITING_MANUAL',
  'RETRY_SCHEDULED',
  'EXCEPTION',
  'COMPLETED',
  'SKIPPED',
  'CANCELLED'
);

CREATE TYPE "subscription_journey_manual_task_type" AS ENUM (
  'FINAL_PLAN_DECISION',
  'FINAL_VEHICLE_ALLOCATION',
  'DELIVERY_EVIDENCE_DECISION'
);

CREATE TYPE "subscription_journey_manual_task_status" AS ENUM (
  'OPEN',
  'COMPLETED',
  'CANCELLED'
);

CREATE TYPE "subscription_journey_manual_decision" AS ENUM (
  'APPROVED',
  'REJECTED'
);

CREATE TYPE "subscription_journey_job_type" AS ENUM (
  'VALIDATE_APPLICATION',
  'CREATE_ORDER_AND_CONTRACT',
  'START_FADADA_SIGNING',
  'RECONCILE_FADADA_SIGNING',
  'GENERATE_INITIAL_BILLS',
  'EVALUATE_PAYMENT_SETTLEMENT',
  'CREATE_HANDOVER',
  'ACTIVATE_SUBSCRIPTION',
  'DISPATCH_NOTIFICATION'
);

CREATE TYPE "subscription_journey_job_status" AS ENUM (
  'PENDING',
  'PROCESSING',
  'RETRY_SCHEDULED',
  'COMPLETED',
  'DEAD_LETTER',
  'CANCELLED'
);

CREATE TYPE "subscription_journey_event_type" AS ENUM (
  'JOURNEY_STARTED',
  'STEP_STARTED',
  'STEP_WAITING_CUSTOMER',
  'STEP_WAITING_MANUAL',
  'STEP_COMPLETED',
  'STEP_RETRY_SCHEDULED',
  'STEP_EXCEPTION',
  'MANUAL_TASK_DECIDED',
  'DOMAIN_FACT_OBSERVED',
  'JOURNEY_PAUSED',
  'JOURNEY_RESUMED',
  'JOURNEY_CANCELLED',
  'JOURNEY_COMPLETED',
  'EXCEPTION_RESOLVED'
);

CREATE TYPE "subscription_journey_exception_status" AS ENUM (
  'OPEN',
  'ACKNOWLEDGED',
  'RESOLVED'
);

CREATE TYPE "subscription_journey_outbox_status" AS ENUM (
  'PENDING',
  'PROCESSING',
  'DELIVERED',
  'DEAD_LETTER',
  'CANCELLED'
);

ALTER TABLE "application"
ADD COLUMN "final_plan_revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "customer_confirmed_plan_revision" INTEGER;

CREATE TABLE "subscription_journey" (
  "id" TEXT NOT NULL,
  "application_id" UUID NOT NULL,
  "order_id" UUID,
  "status" "subscription_journey_status" NOT NULL DEFAULT 'RUNNING',
  "current_step_code" "subscription_journey_step_code" NOT NULL,
  "current_step_status" "subscription_journey_step_status" NOT NULL DEFAULT 'PENDING',
  "paused_from_status" "subscription_journey_status",
  "version" INTEGER NOT NULL DEFAULT 0,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "subscription_journey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_journey_step" (
  "id" TEXT NOT NULL,
  "journey_id" TEXT NOT NULL,
  "code" "subscription_journey_step_code" NOT NULL,
  "status" "subscription_journey_step_status" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "started_at" TIMESTAMPTZ(6),
  "waiting_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "last_error_code" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "subscription_journey_step_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_journey_job" (
  "id" TEXT NOT NULL,
  "journey_id" TEXT NOT NULL,
  "step_id" TEXT NOT NULL,
  "job_type" "subscription_journey_job_type" NOT NULL,
  "status" "subscription_journey_job_status" NOT NULL DEFAULT 'PENDING',
  "source_key" VARCHAR(128) NOT NULL,
  "payload" JSONB,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" VARCHAR(128),
  "lease_expires_at" TIMESTAMPTZ(6),
  "last_error_code" VARCHAR(64),
  "last_error_message" TEXT,
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "subscription_journey_job_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_journey_manual_task" (
  "id" TEXT NOT NULL,
  "journey_id" TEXT NOT NULL,
  "step_id" TEXT NOT NULL,
  "task_type" "subscription_journey_manual_task_type" NOT NULL,
  "status" "subscription_journey_manual_task_status" NOT NULL DEFAULT 'OPEN',
  "decision" "subscription_journey_manual_decision",
  "input_snapshot" JSONB NOT NULL,
  "decided_by" UUID,
  "decision_notes" TEXT,
  "decided_at" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "subscription_journey_manual_task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_journey_event" (
  "id" TEXT NOT NULL,
  "journey_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_key" VARCHAR(128) NOT NULL,
  "event_type" "subscription_journey_event_type" NOT NULL,
  "actor_type" VARCHAR(64),
  "actor_id" VARCHAR(128),
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "subscription_journey_event_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_journey_exception" (
  "id" TEXT NOT NULL,
  "journey_id" TEXT NOT NULL,
  "step_id" TEXT NOT NULL,
  "job_id" TEXT,
  "status" "subscription_journey_exception_status" NOT NULL DEFAULT 'OPEN',
  "code" VARCHAR(64) NOT NULL,
  "message" TEXT NOT NULL,
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "occurrence_count" INTEGER NOT NULL DEFAULT 1,
  "first_occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledged_by" UUID,
  "acknowledged_at" TIMESTAMPTZ(6),
  "resolved_by" UUID,
  "resolved_at" TIMESTAMPTZ(6),
  "resolution_notes" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "subscription_journey_exception_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_journey_outbox" (
  "id" TEXT NOT NULL,
  "journey_id" TEXT,
  "aggregate_type" VARCHAR(64) NOT NULL,
  "aggregate_id" VARCHAR(128) NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "event_key" VARCHAR(128) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "subscription_journey_outbox_status" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" VARCHAR(128),
  "lease_expires_at" TIMESTAMPTZ(6),
  "last_error_code" VARCHAR(64),
  "last_error_message" TEXT,
  "delivered_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "subscription_journey_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subscription_journey_application_id_key"
ON "subscription_journey" ("application_id");

CREATE UNIQUE INDEX "subscription_journey_order_id_key"
ON "subscription_journey" ("order_id")
WHERE "order_id" IS NOT NULL;

CREATE INDEX "subscription_journey_status_step_idx"
ON "subscription_journey" ("status", "current_step_code", "current_step_status");

CREATE INDEX "subscription_journey_order_id_idx"
ON "subscription_journey" ("order_id");

CREATE UNIQUE INDEX "subscription_journey_step_code_key"
ON "subscription_journey_step" ("journey_id", "code");

CREATE INDEX "subscription_journey_step_status_idx"
ON "subscription_journey_step" ("journey_id", "status");

CREATE UNIQUE INDEX "subscription_journey_job_source_key_key"
ON "subscription_journey_job" ("source_key");

CREATE INDEX "subscription_journey_job_claim_idx"
ON "subscription_journey_job" ("status", "available_at", "lease_expires_at");

CREATE INDEX "subscription_journey_job_status_idx"
ON "subscription_journey_job" ("journey_id", "status");

CREATE INDEX "subscription_journey_job_step_id_idx"
ON "subscription_journey_job" ("step_id");

CREATE UNIQUE INDEX "subscription_journey_open_manual_task_key"
ON "subscription_journey_manual_task" ("journey_id", "task_type")
WHERE "status" = 'OPEN';

CREATE INDEX "subscription_journey_manual_task_status_idx"
ON "subscription_journey_manual_task" ("journey_id", "status", "task_type");

CREATE INDEX "subscription_journey_manual_task_step_id_idx"
ON "subscription_journey_manual_task" ("step_id");

CREATE UNIQUE INDEX "subscription_journey_event_event_key_key"
ON "subscription_journey_event" ("event_key");

CREATE UNIQUE INDEX "subscription_journey_event_sequence_key"
ON "subscription_journey_event" ("journey_id", "sequence");

CREATE INDEX "subscription_journey_event_created_at_idx"
ON "subscription_journey_event" ("journey_id", "created_at");

CREATE INDEX "subscription_journey_exception_status_idx"
ON "subscription_journey_exception" ("journey_id", "status", "last_occurred_at");

CREATE INDEX "subscription_journey_exception_step_id_idx"
ON "subscription_journey_exception" ("step_id");

CREATE INDEX "subscription_journey_exception_job_id_idx"
ON "subscription_journey_exception" ("job_id");

CREATE UNIQUE INDEX "subscription_journey_outbox_event_key_key"
ON "subscription_journey_outbox" ("event_key");

CREATE INDEX "subscription_journey_outbox_claim_idx"
ON "subscription_journey_outbox" ("status", "available_at", "lease_expires_at");

CREATE INDEX "subscription_journey_outbox_journey_status_idx"
ON "subscription_journey_outbox" ("journey_id", "status");

CREATE INDEX "subscription_journey_outbox_aggregate_idx"
ON "subscription_journey_outbox" ("aggregate_type", "aggregate_id");

ALTER TABLE "subscription_journey"
ADD CONSTRAINT "subscription_journey_application_id_fkey"
FOREIGN KEY ("application_id") REFERENCES "application"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_journey"
ADD CONSTRAINT "subscription_journey_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "subscription_journey_step"
ADD CONSTRAINT "subscription_journey_step_journey_id_fkey"
FOREIGN KEY ("journey_id") REFERENCES "subscription_journey"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_journey_job"
ADD CONSTRAINT "subscription_journey_job_journey_id_fkey"
FOREIGN KEY ("journey_id") REFERENCES "subscription_journey"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_journey_job"
ADD CONSTRAINT "subscription_journey_job_step_id_fkey"
FOREIGN KEY ("step_id") REFERENCES "subscription_journey_step"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_journey_manual_task"
ADD CONSTRAINT "subscription_journey_manual_task_journey_id_fkey"
FOREIGN KEY ("journey_id") REFERENCES "subscription_journey"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_journey_manual_task"
ADD CONSTRAINT "subscription_journey_manual_task_step_id_fkey"
FOREIGN KEY ("step_id") REFERENCES "subscription_journey_step"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_journey_event"
ADD CONSTRAINT "subscription_journey_event_journey_id_fkey"
FOREIGN KEY ("journey_id") REFERENCES "subscription_journey"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_journey_exception"
ADD CONSTRAINT "subscription_journey_exception_journey_id_fkey"
FOREIGN KEY ("journey_id") REFERENCES "subscription_journey"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_journey_exception"
ADD CONSTRAINT "subscription_journey_exception_step_id_fkey"
FOREIGN KEY ("step_id") REFERENCES "subscription_journey_step"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_journey_exception"
ADD CONSTRAINT "subscription_journey_exception_job_id_fkey"
FOREIGN KEY ("job_id") REFERENCES "subscription_journey_job"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "subscription_journey_outbox"
ADD CONSTRAINT "subscription_journey_outbox_journey_id_fkey"
FOREIGN KEY ("journey_id") REFERENCES "subscription_journey"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
