-- CreateEnum
CREATE TYPE "esign_provider_type" AS ENUM ('MOCK', 'FADADA', 'ESIGN', 'TENCENT_ESIGN', 'OTHER');

-- CreateEnum
CREATE TYPE "esign_task_status" AS ENUM ('CREATED', 'WAITING_CUSTOMER', 'SIGNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "esign_signer_type" AS ENUM ('CUSTOMER', 'PLATFORM');

-- CreateEnum
CREATE TYPE "esign_signer_status" AS ENUM ('PENDING', 'SIGNING', 'SIGNED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "contract_esign_task" (
    "id" UUID NOT NULL,
    "task_no" VARCHAR(64) NOT NULL,
    "contract_id" UUID NOT NULL,
    "order_id" UUID,
    "customer_id" UUID,
    "provider" "esign_provider_type" NOT NULL,
    "task_status" "esign_task_status" NOT NULL DEFAULT 'CREATED',
    "provider_task_id" VARCHAR(128),
    "provider_envelope_id" VARCHAR(128),
    "sign_url" TEXT,
    "sign_url_expires_at" TIMESTAMPTZ(6),
    "document_name" VARCHAR(255),
    "document_object_key" VARCHAR(512),
    "signed_document_object_key" VARCHAR(512),
    "evidence_object_key" VARCHAR(512),
    "request_snapshot" JSONB,
    "response_snapshot" JSONB,
    "callback_snapshot" JSONB,
    "error_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),

    CONSTRAINT "contract_esign_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_esign_signer" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "signer_type" "esign_signer_type" NOT NULL,
    "signer_name" VARCHAR(128),
    "signer_phone" VARCHAR(32),
    "signer_id_no_masked" VARCHAR(64),
    "customer_id" UUID,
    "signer_status" "esign_signer_status" NOT NULL DEFAULT 'PENDING',
    "provider_signer_id" VARCHAR(128),
    "sign_url" TEXT,
    "sign_url_expires_at" TIMESTAMPTZ(6),
    "signed_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "reject_reason" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "contract_esign_signer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_esign_callback_log" (
    "id" UUID NOT NULL,
    "task_id" UUID,
    "provider" "esign_provider_type" NOT NULL,
    "event_type" VARCHAR(128),
    "provider_task_id" VARCHAR(128),
    "payload" JSONB,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "handled" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handled_at" TIMESTAMPTZ(6),

    CONSTRAINT "contract_esign_callback_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contract_esign_task_task_no_key" ON "contract_esign_task"("task_no");

-- CreateIndex
CREATE INDEX "contract_esign_task_contract_id_idx" ON "contract_esign_task"("contract_id");

-- CreateIndex
CREATE INDEX "contract_esign_task_order_id_idx" ON "contract_esign_task"("order_id");

-- CreateIndex
CREATE INDEX "contract_esign_task_customer_id_idx" ON "contract_esign_task"("customer_id");

-- CreateIndex
CREATE INDEX "contract_esign_task_provider_idx" ON "contract_esign_task"("provider");

-- CreateIndex
CREATE INDEX "contract_esign_task_task_status_idx" ON "contract_esign_task"("task_status");

-- CreateIndex
CREATE INDEX "contract_esign_signer_task_id_idx" ON "contract_esign_signer"("task_id");

-- CreateIndex
CREATE INDEX "contract_esign_signer_customer_id_idx" ON "contract_esign_signer"("customer_id");

-- CreateIndex
CREATE INDEX "contract_esign_signer_signer_status_idx" ON "contract_esign_signer"("signer_status");

-- CreateIndex
CREATE INDEX "contract_esign_callback_log_task_id_idx" ON "contract_esign_callback_log"("task_id");

-- CreateIndex
CREATE INDEX "contract_esign_callback_log_provider_idx" ON "contract_esign_callback_log"("provider");

-- CreateIndex
CREATE INDEX "contract_esign_callback_log_provider_task_id_idx" ON "contract_esign_callback_log"("provider_task_id");

-- CreateIndex
CREATE INDEX "contract_esign_callback_log_event_type_idx" ON "contract_esign_callback_log"("event_type");

-- CreateIndex
CREATE INDEX "contract_esign_callback_log_received_at_idx" ON "contract_esign_callback_log"("received_at");

-- AddForeignKey
ALTER TABLE "contract_esign_task" ADD CONSTRAINT "contract_esign_task_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_esign_signer" ADD CONSTRAINT "contract_esign_signer_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "contract_esign_task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_esign_callback_log" ADD CONSTRAINT "contract_esign_callback_log_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "contract_esign_task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
