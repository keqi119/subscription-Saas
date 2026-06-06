CREATE TYPE "bill_type" AS ENUM ('DEPOSIT', 'FIRST_MONTHLY_FEE', 'MONTHLY_RENT', 'DAMAGE_FEE', 'OTHER');
CREATE TYPE "bill_status" AS ENUM ('PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED');
CREATE TYPE "payment_method" AS ENUM ('BANK_TRANSFER', 'WECHAT', 'ALIPAY', 'CASH', 'OTHER');
CREATE TYPE "payment_status" AS ENUM ('PENDING_CONFIRM', 'CONFIRMED', 'CANCELLED');
CREATE TYPE "deposit_transaction_type" AS ENUM ('COLLECT', 'FREEZE', 'DEDUCT', 'REFUND', 'RELEASE');
CREATE TYPE "deposit_transaction_status" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED');

CREATE TABLE "receivable_bill" (
    "id" UUID NOT NULL,
    "bill_no" VARCHAR(64) NOT NULL,
    "order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "bill_type" "bill_type" NOT NULL,
    "bill_status" "bill_status" NOT NULL DEFAULT 'PENDING',
    "amount" BIGINT NOT NULL,
    "paid_amount" BIGINT NOT NULL DEFAULT 0,
    "remaining_amount" BIGINT NOT NULL,
    "due_date" TIMESTAMPTZ(6) NOT NULL,
    "bill_period_start" DATE,
    "bill_period_end" DATE,
    "paid_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "snapshot" JSONB,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "receivable_bill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_record" (
    "id" UUID NOT NULL,
    "payment_no" VARCHAR(64) NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_amount" BIGINT NOT NULL,
    "payment_method" "payment_method" NOT NULL,
    "payment_status" "payment_status" NOT NULL DEFAULT 'CONFIRMED',
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "payer_name" VARCHAR(64),
    "payer_account" VARCHAR(128),
    "payment_proof_urls" JSONB,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_record_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_write_off" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "write_off_amount" BIGINT NOT NULL,
    "write_off_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_write_off_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "deposit_ledger" (
    "id" UUID NOT NULL,
    "ledger_no" VARCHAR(64) NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "bill_id" UUID,
    "payment_id" UUID,
    "transaction_type" "deposit_transaction_type" NOT NULL,
    "transaction_status" "deposit_transaction_status" NOT NULL DEFAULT 'CONFIRMED',
    "amount" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "deposit_ledger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receivable_bill_bill_no_key" ON "receivable_bill"("bill_no");
CREATE INDEX "receivable_bill_order_id_idx" ON "receivable_bill"("order_id");
CREATE INDEX "receivable_bill_customer_id_idx" ON "receivable_bill"("customer_id");
CREATE INDEX "receivable_bill_bill_type_idx" ON "receivable_bill"("bill_type");
CREATE INDEX "receivable_bill_bill_status_idx" ON "receivable_bill"("bill_status");
CREATE INDEX "receivable_bill_due_date_idx" ON "receivable_bill"("due_date");

CREATE UNIQUE INDEX "payment_record_payment_no_key" ON "payment_record"("payment_no");
CREATE INDEX "payment_record_customer_id_idx" ON "payment_record"("customer_id");
CREATE INDEX "payment_record_order_id_idx" ON "payment_record"("order_id");
CREATE INDEX "payment_record_payment_status_idx" ON "payment_record"("payment_status");
CREATE INDEX "payment_record_received_at_idx" ON "payment_record"("received_at");

CREATE INDEX "payment_write_off_payment_id_idx" ON "payment_write_off"("payment_id");
CREATE INDEX "payment_write_off_bill_id_idx" ON "payment_write_off"("bill_id");
CREATE INDEX "payment_write_off_order_id_idx" ON "payment_write_off"("order_id");
CREATE INDEX "payment_write_off_customer_id_idx" ON "payment_write_off"("customer_id");
CREATE INDEX "payment_write_off_write_off_at_idx" ON "payment_write_off"("write_off_at");

CREATE UNIQUE INDEX "deposit_ledger_ledger_no_key" ON "deposit_ledger"("ledger_no");
CREATE INDEX "deposit_ledger_customer_id_idx" ON "deposit_ledger"("customer_id");
CREATE INDEX "deposit_ledger_order_id_idx" ON "deposit_ledger"("order_id");
CREATE INDEX "deposit_ledger_bill_id_idx" ON "deposit_ledger"("bill_id");
CREATE INDEX "deposit_ledger_payment_id_idx" ON "deposit_ledger"("payment_id");
CREATE INDEX "deposit_ledger_transaction_type_idx" ON "deposit_ledger"("transaction_type");
CREATE INDEX "deposit_ledger_transaction_status_idx" ON "deposit_ledger"("transaction_status");
CREATE INDEX "deposit_ledger_occurred_at_idx" ON "deposit_ledger"("occurred_at");

ALTER TABLE "receivable_bill" ADD CONSTRAINT "receivable_bill_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receivable_bill" ADD CONSTRAINT "receivable_bill_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_record" ADD CONSTRAINT "payment_record_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_record" ADD CONSTRAINT "payment_record_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_write_off" ADD CONSTRAINT "payment_write_off_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment_record"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_write_off" ADD CONSTRAINT "payment_write_off_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "receivable_bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_write_off" ADD CONSTRAINT "payment_write_off_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_write_off" ADD CONSTRAINT "payment_write_off_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deposit_ledger" ADD CONSTRAINT "deposit_ledger_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deposit_ledger" ADD CONSTRAINT "deposit_ledger_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deposit_ledger" ADD CONSTRAINT "deposit_ledger_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "receivable_bill"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deposit_ledger" ADD CONSTRAINT "deposit_ledger_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment_record"("id") ON DELETE SET NULL ON UPDATE CASCADE;
