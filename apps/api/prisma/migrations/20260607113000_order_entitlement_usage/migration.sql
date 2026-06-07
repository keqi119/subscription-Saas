CREATE TYPE "entitlement_usage_status" AS ENUM ('CONFIRMED', 'CANCELLED');

CREATE TYPE "entitlement_usage_source" AS ENUM ('MANUAL', 'SYSTEM', 'THIRD_PARTY');

CREATE TABLE "order_entitlement_usage" (
    "id" UUID NOT NULL,
    "usage_no" VARCHAR(64) NOT NULL,
    "account_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "entitlement_type" "entitlement_type" NOT NULL,
    "entitlement_name" VARCHAR(128) NOT NULL,
    "used_amount" DECIMAL(12, 2) NOT NULL,
    "unit" "entitlement_unit" NOT NULL,
    "usage_status" "entitlement_usage_status" NOT NULL DEFAULT 'CONFIRMED',
    "usage_source" "entitlement_usage_source" NOT NULL DEFAULT 'MANUAL',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "external_ref_no" VARCHAR(128),
    "scenario" VARCHAR(128),
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "order_entitlement_usage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_entitlement_usage_usage_no_key" ON "order_entitlement_usage"("usage_no");

CREATE UNIQUE INDEX "order_entitlement_usage_active_external_ref_key"
    ON "order_entitlement_usage"("grant_id", "external_ref_no")
    WHERE "deleted_at" IS NULL AND "external_ref_no" IS NOT NULL AND "usage_status" <> 'CANCELLED';

CREATE INDEX "order_entitlement_usage_account_id_idx" ON "order_entitlement_usage"("account_id");
CREATE INDEX "order_entitlement_usage_grant_id_idx" ON "order_entitlement_usage"("grant_id");
CREATE INDEX "order_entitlement_usage_order_id_idx" ON "order_entitlement_usage"("order_id");
CREATE INDEX "order_entitlement_usage_customer_id_idx" ON "order_entitlement_usage"("customer_id");
CREATE INDEX "order_entitlement_usage_entitlement_type_idx" ON "order_entitlement_usage"("entitlement_type");
CREATE INDEX "order_entitlement_usage_usage_status_idx" ON "order_entitlement_usage"("usage_status");
CREATE INDEX "order_entitlement_usage_usage_source_idx" ON "order_entitlement_usage"("usage_source");
CREATE INDEX "order_entitlement_usage_occurred_at_idx" ON "order_entitlement_usage"("occurred_at");
CREATE INDEX "order_entitlement_usage_external_ref_no_idx" ON "order_entitlement_usage"("external_ref_no");

ALTER TABLE "order_entitlement_usage"
    ADD CONSTRAINT "order_entitlement_usage_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "order_entitlement_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_entitlement_usage"
    ADD CONSTRAINT "order_entitlement_usage_grant_id_fkey"
    FOREIGN KEY ("grant_id") REFERENCES "order_entitlement_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_entitlement_usage"
    ADD CONSTRAINT "order_entitlement_usage_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_entitlement_usage"
    ADD CONSTRAINT "order_entitlement_usage_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
