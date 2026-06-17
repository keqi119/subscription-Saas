-- CreateEnum
CREATE TYPE "payment_provider_type" AS ENUM ('MOCK', 'WECHAT_PAY', 'ALIPAY', 'BANK_TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "payment_channel" AS ENUM ('MOCK', 'WECHAT_JSAPI', 'WECHAT_H5', 'ALIPAY_H5', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "payment_order_status" AS ENUM ('CREATED', 'PENDING', 'PAID', 'FAILED', 'CLOSED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "payment_order" (
    "id" UUID NOT NULL,
    "payment_order_no" VARCHAR(64) NOT NULL,
    "customer_id" UUID,
    "order_id" UUID,
    "payment_record_id" UUID,
    "provider" "payment_provider_type" NOT NULL,
    "payment_channel" "payment_channel" NOT NULL,
    "payment_status" "payment_order_status" NOT NULL DEFAULT 'CREATED',
    "amount" BIGINT NOT NULL,
    "paid_amount" BIGINT NOT NULL DEFAULT 0,
    "subject" VARCHAR(255),
    "description" TEXT,
    "provider_trade_no" VARCHAR(128),
    "provider_prepay_id" VARCHAR(128),
    "provider_transaction_id" VARCHAR(128),
    "cashier_url" TEXT,
    "cashier_url_expires_at" TIMESTAMPTZ(6),
    "client_ip" VARCHAR(64),
    "user_agent" VARCHAR(255),
    "request_snapshot" JSONB,
    "response_snapshot" JSONB,
    "callback_snapshot" JSONB,
    "error_snapshot" JSONB,
    "paid_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "expired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_order_item" (
    "id" UUID NOT NULL,
    "payment_order_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_order_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_callback_log" (
    "id" UUID NOT NULL,
    "payment_order_id" UUID,
    "provider" "payment_provider_type" NOT NULL,
    "event_type" VARCHAR(128),
    "provider_trade_no" VARCHAR(128),
    "provider_transaction_id" VARCHAR(128),
    "payload" JSONB,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "handled" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handled_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_callback_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_order_payment_order_no_key" ON "payment_order"("payment_order_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_order_payment_record_id_key" ON "payment_order"("payment_record_id");

-- CreateIndex
CREATE INDEX "payment_order_customer_id_idx" ON "payment_order"("customer_id");

-- CreateIndex
CREATE INDEX "payment_order_order_id_idx" ON "payment_order"("order_id");

-- CreateIndex
CREATE INDEX "payment_order_provider_idx" ON "payment_order"("provider");

-- CreateIndex
CREATE INDEX "payment_order_payment_channel_idx" ON "payment_order"("payment_channel");

-- CreateIndex
CREATE INDEX "payment_order_payment_status_idx" ON "payment_order"("payment_status");

-- CreateIndex
CREATE INDEX "payment_order_provider_transaction_id_idx" ON "payment_order"("provider_transaction_id");

-- CreateIndex
CREATE INDEX "payment_order_created_at_idx" ON "payment_order"("created_at");

-- CreateIndex
CREATE INDEX "payment_order_item_payment_order_id_idx" ON "payment_order_item"("payment_order_id");

-- CreateIndex
CREATE INDEX "payment_order_item_bill_id_idx" ON "payment_order_item"("bill_id");

-- CreateIndex
CREATE INDEX "payment_callback_log_payment_order_id_idx" ON "payment_callback_log"("payment_order_id");

-- CreateIndex
CREATE INDEX "payment_callback_log_provider_idx" ON "payment_callback_log"("provider");

-- CreateIndex
CREATE INDEX "payment_callback_log_provider_trade_no_idx" ON "payment_callback_log"("provider_trade_no");

-- CreateIndex
CREATE INDEX "payment_callback_log_provider_transaction_id_idx" ON "payment_callback_log"("provider_transaction_id");

-- CreateIndex
CREATE INDEX "payment_callback_log_event_type_idx" ON "payment_callback_log"("event_type");

-- CreateIndex
CREATE INDEX "payment_callback_log_received_at_idx" ON "payment_callback_log"("received_at");

-- AddForeignKey
ALTER TABLE "payment_order" ADD CONSTRAINT "payment_order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_order" ADD CONSTRAINT "payment_order_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_order" ADD CONSTRAINT "payment_order_payment_record_id_fkey" FOREIGN KEY ("payment_record_id") REFERENCES "payment_record"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_order_item" ADD CONSTRAINT "payment_order_item_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_order_item" ADD CONSTRAINT "payment_order_item_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "receivable_bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_callback_log" ADD CONSTRAINT "payment_callback_log_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
