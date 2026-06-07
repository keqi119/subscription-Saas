CREATE TYPE "entitlement_account_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE "entitlement_type" AS ENUM ('MILEAGE', 'ENERGY', 'BENEFIT');
CREATE TYPE "entitlement_unit" AS ENUM ('KM', 'KWH', 'TIMES', 'ITEM', 'TEXT');
CREATE TYPE "entitlement_grant_source" AS ENUM ('ORDER_START', 'MONTHLY_RENEWAL', 'MANUAL_ADJUST');
CREATE TYPE "entitlement_grant_status" AS ENUM ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'CANCELLED');

CREATE TABLE "order_entitlement_account" (
    "id" UUID NOT NULL,
    "account_no" VARCHAR(64) NOT NULL,
    "order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "subscription_plan_id" UUID,
    "account_status" "entitlement_account_status" NOT NULL DEFAULT 'ACTIVE',
    "period_start" DATE NOT NULL,
    "period_end" DATE,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "order_entitlement_account_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_entitlement_grant" (
    "id" UUID NOT NULL,
    "grant_no" VARCHAR(64) NOT NULL,
    "account_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "entitlement_type" "entitlement_type" NOT NULL,
    "entitlement_name" VARCHAR(128) NOT NULL,
    "total_amount" DECIMAL(12,2),
    "used_amount" DECIMAL(12,2) DEFAULT 0,
    "remaining_amount" DECIMAL(12,2),
    "unit" "entitlement_unit" NOT NULL,
    "grant_source" "entitlement_grant_source" NOT NULL DEFAULT 'ORDER_START',
    "grant_period_start" DATE NOT NULL,
    "grant_period_end" DATE,
    "status" "entitlement_grant_status" NOT NULL DEFAULT 'ACTIVE',
    "snapshot" JSONB,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "order_entitlement_grant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_entitlement_account_account_no_key" ON "order_entitlement_account"("account_no");
CREATE UNIQUE INDEX "order_entitlement_account_active_order_key" ON "order_entitlement_account"("order_id") WHERE "deleted_at" IS NULL AND "account_status" = 'ACTIVE';
CREATE INDEX "order_entitlement_account_order_id_idx" ON "order_entitlement_account"("order_id");
CREATE INDEX "order_entitlement_account_customer_id_idx" ON "order_entitlement_account"("customer_id");
CREATE INDEX "order_entitlement_account_subscription_plan_id_idx" ON "order_entitlement_account"("subscription_plan_id");
CREATE INDEX "order_entitlement_account_account_status_idx" ON "order_entitlement_account"("account_status");
CREATE INDEX "order_entitlement_account_period_start_period_end_idx" ON "order_entitlement_account"("period_start", "period_end");

CREATE UNIQUE INDEX "order_entitlement_grant_grant_no_key" ON "order_entitlement_grant"("grant_no");
CREATE INDEX "order_entitlement_grant_account_id_idx" ON "order_entitlement_grant"("account_id");
CREATE INDEX "order_entitlement_grant_order_id_idx" ON "order_entitlement_grant"("order_id");
CREATE INDEX "order_entitlement_grant_customer_id_idx" ON "order_entitlement_grant"("customer_id");
CREATE INDEX "order_entitlement_grant_entitlement_type_idx" ON "order_entitlement_grant"("entitlement_type");
CREATE INDEX "order_entitlement_grant_grant_source_idx" ON "order_entitlement_grant"("grant_source");
CREATE INDEX "order_entitlement_grant_status_idx" ON "order_entitlement_grant"("status");
CREATE INDEX "order_entitlement_grant_grant_period_start_grant_period_end_idx" ON "order_entitlement_grant"("grant_period_start", "grant_period_end");

ALTER TABLE "order_entitlement_account" ADD CONSTRAINT "order_entitlement_account_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_entitlement_account" ADD CONSTRAINT "order_entitlement_account_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_entitlement_account" ADD CONSTRAINT "order_entitlement_account_subscription_plan_id_fkey" FOREIGN KEY ("subscription_plan_id") REFERENCES "subscription_plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "order_entitlement_grant" ADD CONSTRAINT "order_entitlement_grant_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "order_entitlement_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_entitlement_grant" ADD CONSTRAINT "order_entitlement_grant_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_entitlement_grant" ADD CONSTRAINT "order_entitlement_grant_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
