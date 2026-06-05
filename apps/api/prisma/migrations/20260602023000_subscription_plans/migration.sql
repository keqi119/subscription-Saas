-- CreateEnum
CREATE TYPE "subscription_plan_status" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "monthly_fee_mode" AS ENUM ('MANUAL_QUOTE', 'FIXED_AMOUNT', 'RATE_FORMULA');

-- AlterTable
ALTER TABLE "subscription_quote" ADD COLUMN     "subscription_plan_id" UUID,
ADD COLUMN     "deposit_rule_snapshot" JSONB,
ADD COLUMN     "monthly_fee_cap_amount" BIGINT;

-- CreateTable
CREATE TABLE "subscription_plan" (
    "id" UUID NOT NULL,
    "plan_no" VARCHAR(64) NOT NULL,
    "plan_name" VARCHAR(128) NOT NULL,
    "product_id" UUID NOT NULL,
    "product_version_id" UUID NOT NULL,
    "vehicle_package_id" UUID NOT NULL,
    "mileage_package_id" UUID NOT NULL,
    "energy_package_id" UUID NOT NULL,
    "benefit_package_id" UUID,
    "monthly_fee_mode" "monthly_fee_mode" NOT NULL DEFAULT 'MANUAL_QUOTE',
    "base_monthly_fee_amount" BIGINT,
    "monthly_fee_rate" DECIMAL(8,6) NOT NULL DEFAULT 0.035000,
    "monthly_fee_cap_rate" DECIMAL(8,6),
    "min_period_months" INTEGER NOT NULL,
    "max_period_months" INTEGER NOT NULL,
    "status" "subscription_plan_status" NOT NULL DEFAULT 'DRAFT',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "subscription_plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plan_plan_no_key" ON "subscription_plan"("plan_no");

-- CreateIndex
CREATE INDEX "subscription_plan_product_id_idx" ON "subscription_plan"("product_id");

-- CreateIndex
CREATE INDEX "subscription_plan_product_version_id_idx" ON "subscription_plan"("product_version_id");

-- CreateIndex
CREATE INDEX "subscription_plan_vehicle_package_id_idx" ON "subscription_plan"("vehicle_package_id");

-- CreateIndex
CREATE INDEX "subscription_plan_mileage_package_id_idx" ON "subscription_plan"("mileage_package_id");

-- CreateIndex
CREATE INDEX "subscription_plan_energy_package_id_idx" ON "subscription_plan"("energy_package_id");

-- CreateIndex
CREATE INDEX "subscription_plan_benefit_package_id_idx" ON "subscription_plan"("benefit_package_id");

-- CreateIndex
CREATE INDEX "subscription_plan_status_idx" ON "subscription_plan"("status");

-- CreateIndex
CREATE INDEX "subscription_plan_effective_from_effective_to_idx" ON "subscription_plan"("effective_from", "effective_to");

-- CreateIndex
CREATE INDEX "subscription_quote_subscription_plan_id_idx" ON "subscription_quote"("subscription_plan_id");

-- AddForeignKey
ALTER TABLE "subscription_plan" ADD CONSTRAINT "subscription_plan_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_plan" ADD CONSTRAINT "subscription_plan_product_version_id_fkey" FOREIGN KEY ("product_version_id") REFERENCES "product_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_plan" ADD CONSTRAINT "subscription_plan_vehicle_package_id_fkey" FOREIGN KEY ("vehicle_package_id") REFERENCES "vehicle_package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_plan" ADD CONSTRAINT "subscription_plan_mileage_package_id_fkey" FOREIGN KEY ("mileage_package_id") REFERENCES "mileage_package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_plan" ADD CONSTRAINT "subscription_plan_energy_package_id_fkey" FOREIGN KEY ("energy_package_id") REFERENCES "energy_package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_plan" ADD CONSTRAINT "subscription_plan_benefit_package_id_fkey" FOREIGN KEY ("benefit_package_id") REFERENCES "benefit_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_quote" ADD CONSTRAINT "subscription_quote_subscription_plan_id_fkey" FOREIGN KEY ("subscription_plan_id") REFERENCES "subscription_plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
