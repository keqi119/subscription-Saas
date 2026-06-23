-- CreateEnum
CREATE TYPE "vehicle_depreciation_policy_status" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "vehicle_depreciation_basis_source" AS ENUM ('PURCHASE_COST', 'MANUAL', 'ASSET_COST_PROFILE', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_depreciation_schedule_status" AS ENUM ('SCHEDULED', 'CONFIRMED', 'VOIDED', 'LOCKED');

-- CreateEnum
CREATE TYPE "vehicle_depreciation_record_status" AS ENUM ('DRAFT', 'CONFIRMED', 'VOIDED', 'LOCKED');

-- CreateEnum
CREATE TYPE "vehicle_depreciation_record_source" AS ENUM ('SCHEDULED', 'MANUAL', 'ADJUSTMENT', 'IMPORTED');

-- CreateTable
CREATE TABLE "vehicle_depreciation_policy" (
    "id" UUID NOT NULL,
    "policy_no" VARCHAR(64) NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "asset_cost_profile_id" UUID,
    "policy_status" "vehicle_depreciation_policy_status" NOT NULL DEFAULT 'DRAFT',
    "depreciation_method" "vehicle_depreciation_method" NOT NULL,
    "basis_source" "vehicle_depreciation_basis_source" NOT NULL DEFAULT 'PURCHASE_COST',
    "depreciation_basis_amount" BIGINT NOT NULL,
    "residual_value_amount" BIGINT NOT NULL DEFAULT 0,
    "useful_life_months" INTEGER,
    "depreciation_start_date" DATE NOT NULL,
    "depreciation_end_date" DATE,
    "monthly_depreciation_amount" BIGINT,
    "currency" VARCHAR(16) DEFAULT 'CNY',
    "remark" TEXT,
    "snapshot" JSONB,
    "activated_at" TIMESTAMPTZ(6),
    "suspended_at" TIMESTAMPTZ(6),
    "terminated_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_depreciation_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_depreciation_schedule" (
    "id" UUID NOT NULL,
    "schedule_no" VARCHAR(64) NOT NULL,
    "policy_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "cost_period" VARCHAR(7) NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "scheduled_amount" BIGINT NOT NULL,
    "currency" VARCHAR(16) DEFAULT 'CNY',
    "schedule_status" "vehicle_depreciation_schedule_status" NOT NULL DEFAULT 'SCHEDULED',
    "generated_at" TIMESTAMPTZ(6),
    "confirmed_at" TIMESTAMPTZ(6),
    "voided_at" TIMESTAMPTZ(6),
    "locked_at" TIMESTAMPTZ(6),
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_depreciation_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_depreciation_record" (
    "id" UUID NOT NULL,
    "record_no" VARCHAR(64) NOT NULL,
    "policy_id" UUID NOT NULL,
    "schedule_id" UUID,
    "vehicle_id" UUID NOT NULL,
    "cost_period" VARCHAR(7) NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "depreciation_amount" BIGINT NOT NULL,
    "currency" VARCHAR(16) DEFAULT 'CNY',
    "record_status" "vehicle_depreciation_record_status" NOT NULL DEFAULT 'DRAFT',
    "record_source" "vehicle_depreciation_record_source" NOT NULL DEFAULT 'SCHEDULED',
    "confirmed_at" TIMESTAMPTZ(6),
    "voided_at" TIMESTAMPTZ(6),
    "locked_at" TIMESTAMPTZ(6),
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_depreciation_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_depreciation_policy_policy_no_key" ON "vehicle_depreciation_policy"("policy_no");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_depreciation_policy_vehicle_active_key" ON "vehicle_depreciation_policy"("vehicle_id") WHERE "deleted_at" IS NULL AND "policy_status" = 'ACTIVE';

-- CreateIndex
CREATE INDEX "vehicle_depreciation_policy_vehicle_id_idx" ON "vehicle_depreciation_policy"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_policy_policy_status_idx" ON "vehicle_depreciation_policy"("policy_status");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_policy_depreciation_method_idx" ON "vehicle_depreciation_policy"("depreciation_method");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_policy_depreciation_start_date_idx" ON "vehicle_depreciation_policy"("depreciation_start_date");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_policy_depreciation_end_date_idx" ON "vehicle_depreciation_policy"("depreciation_end_date");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_depreciation_schedule_schedule_no_key" ON "vehicle_depreciation_schedule"("schedule_no");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_depreciation_schedule_policy_id_cost_period_key" ON "vehicle_depreciation_schedule"("policy_id", "cost_period");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_schedule_vehicle_id_idx" ON "vehicle_depreciation_schedule"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_schedule_cost_period_idx" ON "vehicle_depreciation_schedule"("cost_period");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_schedule_period_start_idx" ON "vehicle_depreciation_schedule"("period_start");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_schedule_period_end_idx" ON "vehicle_depreciation_schedule"("period_end");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_schedule_schedule_status_idx" ON "vehicle_depreciation_schedule"("schedule_status");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_depreciation_record_record_no_key" ON "vehicle_depreciation_record"("record_no");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_record_policy_id_idx" ON "vehicle_depreciation_record"("policy_id");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_record_schedule_id_idx" ON "vehicle_depreciation_record"("schedule_id");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_record_vehicle_id_idx" ON "vehicle_depreciation_record"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_record_cost_period_idx" ON "vehicle_depreciation_record"("cost_period");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_record_period_start_idx" ON "vehicle_depreciation_record"("period_start");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_record_period_end_idx" ON "vehicle_depreciation_record"("period_end");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_record_record_status_idx" ON "vehicle_depreciation_record"("record_status");

-- CreateIndex
CREATE INDEX "vehicle_depreciation_record_record_source_idx" ON "vehicle_depreciation_record"("record_source");

-- AddForeignKey
ALTER TABLE "vehicle_depreciation_policy" ADD CONSTRAINT "vehicle_depreciation_policy_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_depreciation_schedule" ADD CONSTRAINT "vehicle_depreciation_schedule_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "vehicle_depreciation_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_depreciation_schedule" ADD CONSTRAINT "vehicle_depreciation_schedule_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_depreciation_record" ADD CONSTRAINT "vehicle_depreciation_record_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "vehicle_depreciation_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_depreciation_record" ADD CONSTRAINT "vehicle_depreciation_record_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "vehicle_depreciation_schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_depreciation_record" ADD CONSTRAINT "vehicle_depreciation_record_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
