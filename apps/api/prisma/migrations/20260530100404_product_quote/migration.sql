-- CreateEnum
CREATE TYPE "product_type" AS ENUM ('SUBSCRIPTION', 'RENT_TO_OWN');

-- CreateEnum
CREATE TYPE "product_status" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "product_version_status" AS ENUM ('DRAFT', 'APPROVED', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "quote_status" AS ENUM ('DRAFT', 'CONFIRMED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "vehicle_model" AS ENUM ('ET5', 'ET7', 'ES6');

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "product_no" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "product_type" "product_type" NOT NULL DEFAULT 'SUBSCRIPTION',
    "status" "product_status" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_version" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "version_no" VARCHAR(32) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "status" "product_version_status" NOT NULL DEFAULT 'DRAFT',
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "product_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_price_rule" (
    "id" UUID NOT NULL,
    "product_version_id" UUID NOT NULL,
    "vehicle_model" "vehicle_model" NOT NULL,
    "monthly_fee_rate" DECIMAL(8,6) NOT NULL DEFAULT 0.035000,
    "min_period_months" INTEGER NOT NULL,
    "max_period_months" INTEGER NOT NULL,
    "base_mileage_km" INTEGER NOT NULL,
    "over_mileage_fee_amount" BIGINT NOT NULL,
    "energy_limit_kwh" INTEGER,
    "energy_limit_count" INTEGER,
    "status" "record_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "product_price_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_quote" (
    "id" UUID NOT NULL,
    "quote_no" VARCHAR(64) NOT NULL,
    "application_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "risk_result_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_version_id" UUID NOT NULL,
    "vehicle_model" "vehicle_model" NOT NULL,
    "vehicle_purchase_price_amount" BIGINT NOT NULL,
    "monthly_fee_rate" DECIMAL(8,6) NOT NULL,
    "monthly_fee_amount" BIGINT NOT NULL,
    "deposit_amount" BIGINT NOT NULL,
    "period_months" INTEGER NOT NULL,
    "mileage_limit_km" INTEGER NOT NULL,
    "over_mileage_fee_amount" BIGINT NOT NULL,
    "energy_limit_kwh" INTEGER,
    "energy_limit_count" INTEGER,
    "status" "quote_status" NOT NULL DEFAULT 'DRAFT',
    "confirmed_at" TIMESTAMPTZ(6),
    "confirmed_by" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "expired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "subscription_quote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_product_no_key" ON "product"("product_no");

-- CreateIndex
CREATE INDEX "product_product_type_idx" ON "product"("product_type");

-- CreateIndex
CREATE INDEX "product_status_idx" ON "product"("status");

-- CreateIndex
CREATE INDEX "product_version_product_id_idx" ON "product_version"("product_id");

-- CreateIndex
CREATE INDEX "product_version_status_idx" ON "product_version"("status");

-- CreateIndex
CREATE INDEX "product_version_effective_from_effective_to_idx" ON "product_version"("effective_from", "effective_to");

-- CreateIndex
CREATE INDEX "product_version_approved_by_idx" ON "product_version"("approved_by");

-- CreateIndex
CREATE UNIQUE INDEX "product_version_product_id_version_no_key" ON "product_version"("product_id", "version_no");

-- CreateIndex
CREATE INDEX "product_price_rule_product_version_id_idx" ON "product_price_rule"("product_version_id");

-- CreateIndex
CREATE INDEX "product_price_rule_vehicle_model_idx" ON "product_price_rule"("vehicle_model");

-- CreateIndex
CREATE INDEX "product_price_rule_status_idx" ON "product_price_rule"("status");

-- CreateIndex
CREATE UNIQUE INDEX "product_price_rule_product_version_id_vehicle_model_key" ON "product_price_rule"("product_version_id", "vehicle_model");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_quote_quote_no_key" ON "subscription_quote"("quote_no");

-- CreateIndex
CREATE INDEX "subscription_quote_application_id_idx" ON "subscription_quote"("application_id");

-- CreateIndex
CREATE INDEX "subscription_quote_customer_id_idx" ON "subscription_quote"("customer_id");

-- CreateIndex
CREATE INDEX "subscription_quote_risk_result_id_idx" ON "subscription_quote"("risk_result_id");

-- CreateIndex
CREATE INDEX "subscription_quote_product_id_idx" ON "subscription_quote"("product_id");

-- CreateIndex
CREATE INDEX "subscription_quote_product_version_id_idx" ON "subscription_quote"("product_version_id");

-- CreateIndex
CREATE INDEX "subscription_quote_vehicle_model_idx" ON "subscription_quote"("vehicle_model");

-- CreateIndex
CREATE INDEX "subscription_quote_status_idx" ON "subscription_quote"("status");

-- CreateIndex
CREATE INDEX "subscription_quote_confirmed_by_idx" ON "subscription_quote"("confirmed_by");

-- AddForeignKey
ALTER TABLE "product_version" ADD CONSTRAINT "product_version_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_version" ADD CONSTRAINT "product_version_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price_rule" ADD CONSTRAINT "product_price_rule_product_version_id_fkey" FOREIGN KEY ("product_version_id") REFERENCES "product_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_quote" ADD CONSTRAINT "subscription_quote_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_quote" ADD CONSTRAINT "subscription_quote_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_quote" ADD CONSTRAINT "subscription_quote_risk_result_id_fkey" FOREIGN KEY ("risk_result_id") REFERENCES "risk_result"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_quote" ADD CONSTRAINT "subscription_quote_product_version_id_fkey" FOREIGN KEY ("product_version_id") REFERENCES "product_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_quote" ADD CONSTRAINT "subscription_quote_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
