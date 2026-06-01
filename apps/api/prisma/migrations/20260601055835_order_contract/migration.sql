-- CreateEnum
CREATE TYPE "business_type" AS ENUM ('SUBSCRIPTION', 'RENT_TO_OWN');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('PENDING_CONTRACT', 'PENDING_SIGN', 'PENDING_PAYMENT', 'PENDING_VEHICLE', 'PENDING_DELIVERY', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "contract_status" AS ENUM ('DRAFT', 'GENERATED', 'SIGNING', 'SIGNED', 'ARCHIVED', 'TERMINATED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "contract_version_status" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "contract_template_type" AS ENUM ('SUBSCRIPTION_STANDARD');

-- CreateEnum
CREATE TYPE "order_change_type" AS ENUM ('PLAN_CHANGE', 'RESTRUCTURE', 'VEHICLE_SWAP', 'EXTENSION', 'TERMINATION', 'CANCEL_ORDER', 'BUYOUT', 'EARLY_SETTLEMENT', 'OWNERSHIP_TRANSFER');

-- CreateEnum
CREATE TYPE "order_change_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "subscription_order" (
    "id" UUID NOT NULL,
    "order_no" VARCHAR(64) NOT NULL,
    "business_type" "business_type" NOT NULL DEFAULT 'SUBSCRIPTION',
    "customer_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "risk_result_id" UUID NOT NULL,
    "contract_id" UUID,
    "vehicle_id" UUID,
    "product_id" UUID NOT NULL,
    "product_version_id" UUID NOT NULL,
    "vehicle_model" "vehicle_model" NOT NULL,
    "vehicle_purchase_price_amount" BIGINT NOT NULL,
    "monthly_fee_amount" BIGINT NOT NULL,
    "deposit_amount" BIGINT NOT NULL,
    "period_months" INTEGER NOT NULL,
    "mileage_limit_km" INTEGER NOT NULL,
    "over_mileage_fee_amount" BIGINT NOT NULL,
    "energy_limit_kwh" INTEGER,
    "energy_limit_count" INTEGER,
    "quote_snapshot" JSONB NOT NULL,
    "order_status" "order_status" NOT NULL DEFAULT 'PENDING_CONTRACT',
    "start_date" DATE,
    "end_date" DATE,
    "actual_delivery_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "subscription_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_version" (
    "id" UUID NOT NULL,
    "template_name" VARCHAR(128) NOT NULL,
    "version_no" VARCHAR(32) NOT NULL,
    "business_type" "business_type" NOT NULL DEFAULT 'SUBSCRIPTION',
    "template_type" "contract_template_type" NOT NULL DEFAULT 'SUBSCRIPTION_STANDARD',
    "content_template" TEXT NOT NULL,
    "file_id" UUID,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "status" "contract_version_status" NOT NULL DEFAULT 'DRAFT',
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "contract_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract" (
    "id" UUID NOT NULL,
    "contract_no" VARCHAR(64) NOT NULL,
    "order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "business_type" "business_type" NOT NULL DEFAULT 'SUBSCRIPTION',
    "contract_version_id" UUID NOT NULL,
    "contract_title" VARCHAR(128) NOT NULL,
    "contract_snapshot" JSONB NOT NULL,
    "status" "contract_status" NOT NULL DEFAULT 'GENERATED',
    "signed_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "file_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_change" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "change_type" "order_change_type" NOT NULL,
    "before_snapshot" JSONB,
    "after_snapshot" JSONB,
    "reason" TEXT NOT NULL,
    "status" "order_change_status" NOT NULL DEFAULT 'PENDING',
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "order_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_order_order_no_key" ON "subscription_order"("order_no");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_order_quote_id_key" ON "subscription_order"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_order_contract_id_key" ON "subscription_order"("contract_id");

-- CreateIndex
CREATE INDEX "subscription_order_business_type_idx" ON "subscription_order"("business_type");

-- CreateIndex
CREATE INDEX "subscription_order_customer_id_idx" ON "subscription_order"("customer_id");

-- CreateIndex
CREATE INDEX "subscription_order_application_id_idx" ON "subscription_order"("application_id");

-- CreateIndex
CREATE INDEX "subscription_order_risk_result_id_idx" ON "subscription_order"("risk_result_id");

-- CreateIndex
CREATE INDEX "subscription_order_product_id_idx" ON "subscription_order"("product_id");

-- CreateIndex
CREATE INDEX "subscription_order_product_version_id_idx" ON "subscription_order"("product_version_id");

-- CreateIndex
CREATE INDEX "subscription_order_vehicle_model_idx" ON "subscription_order"("vehicle_model");

-- CreateIndex
CREATE INDEX "subscription_order_order_status_idx" ON "subscription_order"("order_status");

-- CreateIndex
CREATE INDEX "contract_version_business_type_idx" ON "contract_version"("business_type");

-- CreateIndex
CREATE INDEX "contract_version_status_idx" ON "contract_version"("status");

-- CreateIndex
CREATE INDEX "contract_version_effective_from_effective_to_idx" ON "contract_version"("effective_from", "effective_to");

-- CreateIndex
CREATE INDEX "contract_version_approved_by_idx" ON "contract_version"("approved_by");

-- CreateIndex
CREATE UNIQUE INDEX "contract_version_template_name_version_no_key" ON "contract_version"("template_name", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "contract_contract_no_key" ON "contract"("contract_no");

-- CreateIndex
CREATE INDEX "contract_order_id_idx" ON "contract"("order_id");

-- CreateIndex
CREATE INDEX "contract_customer_id_idx" ON "contract"("customer_id");

-- CreateIndex
CREATE INDEX "contract_business_type_idx" ON "contract"("business_type");

-- CreateIndex
CREATE INDEX "contract_contract_version_id_idx" ON "contract"("contract_version_id");

-- CreateIndex
CREATE INDEX "contract_status_idx" ON "contract"("status");

-- CreateIndex
CREATE INDEX "order_change_order_id_idx" ON "order_change"("order_id");

-- CreateIndex
CREATE INDEX "order_change_change_type_idx" ON "order_change"("change_type");

-- CreateIndex
CREATE INDEX "order_change_status_idx" ON "order_change"("status");

-- CreateIndex
CREATE INDEX "order_change_approved_by_idx" ON "order_change"("approved_by");

-- AddForeignKey
ALTER TABLE "subscription_order" ADD CONSTRAINT "subscription_order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_order" ADD CONSTRAINT "subscription_order_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_order" ADD CONSTRAINT "subscription_order_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "subscription_quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_order" ADD CONSTRAINT "subscription_order_risk_result_id_fkey" FOREIGN KEY ("risk_result_id") REFERENCES "risk_result"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_order" ADD CONSTRAINT "subscription_order_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_order" ADD CONSTRAINT "subscription_order_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_order" ADD CONSTRAINT "subscription_order_product_version_id_fkey" FOREIGN KEY ("product_version_id") REFERENCES "product_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_version" ADD CONSTRAINT "contract_version_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract" ADD CONSTRAINT "contract_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract" ADD CONSTRAINT "contract_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract" ADD CONSTRAINT "contract_contract_version_id_fkey" FOREIGN KEY ("contract_version_id") REFERENCES "contract_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_change" ADD CONSTRAINT "order_change_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_change" ADD CONSTRAINT "order_change_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
