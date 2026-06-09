-- CreateEnum
CREATE TYPE "revenue_right_assignment_type" AS ENUM ('PLEDGE', 'TRANSFER', 'SPV_POOL', 'REVENUE_SHARE', 'OTHER');

-- CreateEnum
CREATE TYPE "revenue_right_assignment_status" AS ENUM ('ACTIVE', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "revenue_right_target_type" AS ENUM ('VEHICLE', 'ORDER', 'RECEIVABLE_BILL', 'VEHICLE_POOL');

-- CreateEnum
CREATE TYPE "revenue_right_assignee_type" AS ENUM ('FINANCIER', 'SPV', 'MANAGED_OWNER', 'LESSOR', 'PLATFORM', 'OTHER');

-- CreateEnum
CREATE TYPE "revenue_share_rule_type" AS ENUM ('REVENUE_SHARE', 'FIXED_RENT', 'MIXED');

-- CreateEnum
CREATE TYPE "revenue_share_rule_status" AS ENUM ('ACTIVE', 'INACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "revenue_share_basis" AS ENUM ('RENTAL_PAID', 'OPERATING_REVENUE', 'GROSS_RECEIVABLE', 'MANUAL');

-- CreateEnum
CREATE TYPE "revenue_share_settlement_cycle" AS ENUM ('MONTHLY', 'QUARTERLY', 'ON_RETURN', 'MANUAL');

-- CreateTable
CREATE TABLE "revenue_right_assignment" (
    "id" UUID NOT NULL,
    "assignment_no" VARCHAR(64) NOT NULL,
    "assignment_type" "revenue_right_assignment_type" NOT NULL,
    "assignment_status" "revenue_right_assignment_status" NOT NULL DEFAULT 'ACTIVE',
    "target_type" "revenue_right_target_type" NOT NULL,
    "vehicle_id" UUID,
    "order_id" UUID,
    "bill_id" UUID,
    "financing_instrument_id" UUID,
    "assignee_type" "revenue_right_assignee_type" NOT NULL,
    "assignee_name" VARCHAR(128),
    "priority" INTEGER,
    "share_ratio_bps" INTEGER,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "released_at" DATE,
    "release_reason" TEXT,
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "revenue_right_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_share_rule" (
    "id" UUID NOT NULL,
    "rule_no" VARCHAR(64) NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "rule_type" "revenue_share_rule_type" NOT NULL,
    "rule_status" "revenue_share_rule_status" NOT NULL DEFAULT 'ACTIVE',
    "share_basis" "revenue_share_basis" NOT NULL,
    "owner_name" VARCHAR(128),
    "owner_contact" VARCHAR(128),
    "owner_share_bps" INTEGER,
    "platform_share_bps" INTEGER,
    "fixed_monthly_amount" BIGINT,
    "minimum_guarantee_amount" BIGINT,
    "settlement_cycle" "revenue_share_settlement_cycle" NOT NULL DEFAULT 'MONTHLY',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "revenue_share_rule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "revenue_right_assignment_assignment_no_key" ON "revenue_right_assignment"("assignment_no");

-- CreateIndex
CREATE INDEX "revenue_right_assignment_assignment_type_idx" ON "revenue_right_assignment"("assignment_type");

-- CreateIndex
CREATE INDEX "revenue_right_assignment_assignment_status_idx" ON "revenue_right_assignment"("assignment_status");

-- CreateIndex
CREATE INDEX "revenue_right_assignment_target_type_idx" ON "revenue_right_assignment"("target_type");

-- CreateIndex
CREATE INDEX "revenue_right_assignment_vehicle_id_idx" ON "revenue_right_assignment"("vehicle_id");

-- CreateIndex
CREATE INDEX "revenue_right_assignment_order_id_idx" ON "revenue_right_assignment"("order_id");

-- CreateIndex
CREATE INDEX "revenue_right_assignment_bill_id_idx" ON "revenue_right_assignment"("bill_id");

-- CreateIndex
CREATE INDEX "revenue_right_assignment_financing_instrument_id_idx" ON "revenue_right_assignment"("financing_instrument_id");

-- CreateIndex
CREATE INDEX "revenue_right_assignment_deleted_at_idx" ON "revenue_right_assignment"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_share_rule_rule_no_key" ON "revenue_share_rule"("rule_no");

-- CreateIndex
CREATE INDEX "revenue_share_rule_vehicle_id_idx" ON "revenue_share_rule"("vehicle_id");

-- CreateIndex
CREATE INDEX "revenue_share_rule_rule_type_idx" ON "revenue_share_rule"("rule_type");

-- CreateIndex
CREATE INDEX "revenue_share_rule_rule_status_idx" ON "revenue_share_rule"("rule_status");

-- CreateIndex
CREATE INDEX "revenue_share_rule_effective_from_idx" ON "revenue_share_rule"("effective_from");

-- CreateIndex
CREATE INDEX "revenue_share_rule_deleted_at_idx" ON "revenue_share_rule"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_share_rule_active_vehicle_key" ON "revenue_share_rule"("vehicle_id") WHERE "deleted_at" IS NULL AND "rule_status" = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "revenue_right_assignment" ADD CONSTRAINT "revenue_right_assignment_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_right_assignment" ADD CONSTRAINT "revenue_right_assignment_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_right_assignment" ADD CONSTRAINT "revenue_right_assignment_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "receivable_bill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_right_assignment" ADD CONSTRAINT "revenue_right_assignment_financing_instrument_id_fkey" FOREIGN KEY ("financing_instrument_id") REFERENCES "financing_instrument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_share_rule" ADD CONSTRAINT "revenue_share_rule_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
