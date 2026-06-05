-- CreateEnum
CREATE TYPE "application_source" AS ENUM ('SELF_SERVICE', 'SALES_ASSISTED');

-- CreateEnum
CREATE TYPE "plan_confirm_status" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- AlterTable
ALTER TABLE "application" ADD COLUMN     "application_source" "application_source" NOT NULL DEFAULT 'SALES_ASSISTED',
ADD COLUMN     "credit_review_comment" TEXT,
ADD COLUMN     "credit_review_status" "order_review_status" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "customer_grade" "customer_grade",
ADD COLUMN     "customer_selected_snapshot" JSONB,
ADD COLUMN     "deposit_rule_id" UUID,
ADD COLUMN     "deposit_rule_snapshot" JSONB,
ADD COLUMN     "deposit_status" "deposit_status" NOT NULL DEFAULT 'PENDING_CONFIRM',
ADD COLUMN     "final_deposit_amount" BIGINT,
ADD COLUMN     "final_period_months" INTEGER,
ADD COLUMN     "final_plan_confirmed_at" TIMESTAMPTZ(6),
ADD COLUMN     "final_plan_snapshot" JSONB,
ADD COLUMN     "final_quote_snapshot" JSONB,
ADD COLUMN     "final_subscription_plan_id" UUID,
ADD COLUMN     "final_vehicle_base_fee_amount" BIGINT,
ADD COLUMN     "final_vehicle_id" UUID,
ADD COLUMN     "intent_period_months" INTEGER,
ADD COLUMN     "intent_snapshot" JSONB,
ADD COLUMN     "intent_subscription_plan_id" UUID,
ADD COLUMN     "intent_vehicle_base_fee_amount" BIGINT,
ADD COLUMN     "intent_vehicle_id" UUID,
ADD COLUMN     "material_review_status" "order_review_status" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "plan_confirm_status" "plan_confirm_status" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "product_review_status" "order_review_status" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "soft_reservation_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "soft_reserved_at" TIMESTAMPTZ(6),
ADD COLUMN     "soft_reserved_vehicle_id" UUID,
ADD COLUMN     "vehicle_review_status" "order_review_status" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "application_application_source_idx" ON "application"("application_source");

-- CreateIndex
CREATE INDEX "application_intent_vehicle_id_idx" ON "application"("intent_vehicle_id");

-- CreateIndex
CREATE INDEX "application_intent_subscription_plan_id_idx" ON "application"("intent_subscription_plan_id");

-- CreateIndex
CREATE INDEX "application_final_vehicle_id_idx" ON "application"("final_vehicle_id");

-- CreateIndex
CREATE INDEX "application_final_subscription_plan_id_idx" ON "application"("final_subscription_plan_id");

-- CreateIndex
CREATE INDEX "application_deposit_status_idx" ON "application"("deposit_status");

-- CreateIndex
CREATE INDEX "application_plan_confirm_status_idx" ON "application"("plan_confirm_status");

-- CreateIndex
CREATE INDEX "application_deposit_rule_id_idx" ON "application"("deposit_rule_id");

-- CreateIndex
CREATE INDEX "application_soft_reserved_vehicle_id_idx" ON "application"("soft_reserved_vehicle_id");
