-- CreateEnum
CREATE TYPE "order_source" AS ENUM ('CUSTOMER_SELF_SERVICE', 'SALES_ASSISTED');

-- CreateEnum
CREATE TYPE "order_review_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'NEED_MORE_INFO');

-- CreateEnum
CREATE TYPE "deposit_status" AS ENUM ('PENDING_CONFIRM', 'CONFIRMED', 'WAIVED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "order_status" ADD VALUE 'PENDING_REVIEW';
ALTER TYPE "order_status" ADD VALUE 'PENDING_CUSTOMER_CONFIRMATION';
ALTER TYPE "order_status" ADD VALUE 'REJECTED';

-- AlterEnum
ALTER TYPE "vehicle_status" ADD VALUE 'REVIEW_RESERVED';

-- AlterTable
ALTER TABLE "subscription_order" ADD COLUMN     "credit_review_status" "order_review_status" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN     "customer_confirmed_at" TIMESTAMPTZ(6),
ADD COLUMN     "customer_selected_snapshot" JSONB,
ADD COLUMN     "deposit_status" "deposit_status" NOT NULL DEFAULT 'CONFIRMED',
ADD COLUMN     "final_deposit_amount" BIGINT,
ADD COLUMN     "final_plan_confirmed_at" TIMESTAMPTZ(6),
ADD COLUMN     "order_source" "order_source" NOT NULL DEFAULT 'SALES_ASSISTED',
ADD COLUMN     "product_review_status" "order_review_status" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN     "vehicle_review_status" "order_review_status" NOT NULL DEFAULT 'APPROVED';

-- CreateIndex
CREATE INDEX "subscription_order_order_source_idx" ON "subscription_order"("order_source");

-- CreateIndex
CREATE INDEX "subscription_order_credit_review_status_idx" ON "subscription_order"("credit_review_status");

-- CreateIndex
CREATE INDEX "subscription_order_product_review_status_idx" ON "subscription_order"("product_review_status");

-- CreateIndex
CREATE INDEX "subscription_order_vehicle_review_status_idx" ON "subscription_order"("vehicle_review_status");

-- CreateIndex
CREATE INDEX "subscription_order_deposit_status_idx" ON "subscription_order"("deposit_status");
