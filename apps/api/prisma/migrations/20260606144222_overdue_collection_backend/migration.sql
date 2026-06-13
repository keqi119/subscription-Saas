-- CreateEnum
CREATE TYPE "collection_level" AS ENUM ('D1', 'D2', 'D3', 'D4', 'D5');

-- CreateEnum
CREATE TYPE "collection_case_status" AS ENUM ('ACTIVE', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "collection_action_type" AS ENUM ('REMINDER', 'FOLLOW_UP', 'PROMISE_TO_PAY', 'CUSTOMER_DISPUTE', 'ESCALATION', 'CLOSE');

-- CreateEnum
CREATE TYPE "contact_method" AS ENUM ('PHONE', 'SMS', 'WECHAT', 'EMAIL', 'OFFLINE', 'SYSTEM', 'OTHER');

-- CreateEnum
CREATE TYPE "collection_action_result" AS ENUM ('SUCCESS', 'NO_ANSWER', 'CUSTOMER_PROMISED', 'CUSTOMER_REFUSED', 'DISPUTED', 'INVALID_CONTACT', 'OTHER');

-- CreateTable
CREATE TABLE "collection_case" (
    "id" UUID NOT NULL,
    "case_no" VARCHAR(64) NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "case_status" "collection_case_status" NOT NULL DEFAULT 'ACTIVE',
    "collection_level" "collection_level" NOT NULL,
    "total_overdue_amount" BIGINT NOT NULL,
    "max_overdue_days" INTEGER NOT NULL,
    "latest_due_date" TIMESTAMPTZ(6) NOT NULL,
    "assigned_to" UUID,
    "next_follow_up_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "close_reason" TEXT,
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "collection_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_case_bill" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "overdue_amount" BIGINT NOT NULL,
    "overdue_days" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "collection_case_bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_action" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "action_type" "collection_action_type" NOT NULL,
    "contact_method" "contact_method" NOT NULL,
    "action_result" "collection_action_result" NOT NULL,
    "content" TEXT,
    "promised_pay_at" DATE,
    "promised_amount" BIGINT,
    "next_follow_up_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "collection_action_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "collection_case_case_no_key" ON "collection_case"("case_no");

-- CreateIndex
CREATE INDEX "collection_case_customer_id_idx" ON "collection_case"("customer_id");

-- CreateIndex
CREATE INDEX "collection_case_order_id_idx" ON "collection_case"("order_id");

-- CreateIndex
CREATE INDEX "collection_case_case_status_idx" ON "collection_case"("case_status");

-- CreateIndex
CREATE INDEX "collection_case_collection_level_idx" ON "collection_case"("collection_level");

-- CreateIndex
CREATE INDEX "collection_case_assigned_to_idx" ON "collection_case"("assigned_to");

-- CreateIndex
CREATE INDEX "collection_case_next_follow_up_at_idx" ON "collection_case"("next_follow_up_at");

-- CreateIndex
CREATE INDEX "collection_case_bill_case_id_idx" ON "collection_case_bill"("case_id");

-- CreateIndex
CREATE INDEX "collection_case_bill_bill_id_idx" ON "collection_case_bill"("bill_id");

-- CreateIndex
CREATE INDEX "collection_case_bill_order_id_idx" ON "collection_case_bill"("order_id");

-- CreateIndex
CREATE INDEX "collection_case_bill_customer_id_idx" ON "collection_case_bill"("customer_id");

-- CreateIndex
CREATE INDEX "collection_action_case_id_idx" ON "collection_action"("case_id");

-- CreateIndex
CREATE INDEX "collection_action_customer_id_idx" ON "collection_action"("customer_id");

-- CreateIndex
CREATE INDEX "collection_action_order_id_idx" ON "collection_action"("order_id");

-- CreateIndex
CREATE INDEX "collection_action_action_type_idx" ON "collection_action"("action_type");

-- CreateIndex
CREATE INDEX "collection_action_created_at_idx" ON "collection_action"("created_at");

-- AddForeignKey
ALTER TABLE "collection_case" ADD CONSTRAINT "collection_case_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_case" ADD CONSTRAINT "collection_case_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_case_bill" ADD CONSTRAINT "collection_case_bill_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "collection_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_case_bill" ADD CONSTRAINT "collection_case_bill_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_case_bill" ADD CONSTRAINT "collection_case_bill_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_action" ADD CONSTRAINT "collection_action_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "collection_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_action" ADD CONSTRAINT "collection_action_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_action" ADD CONSTRAINT "collection_action_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
