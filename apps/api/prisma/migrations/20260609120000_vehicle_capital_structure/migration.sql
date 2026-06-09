-- CreateEnum
CREATE TYPE "vehicle_acquisition_mode" AS ENUM ('OWNED_CASH', 'OWNED_FINANCED', 'LONG_TERM_LEASED', 'MANAGED_REVENUE_SHARE');

-- CreateEnum
CREATE TYPE "vehicle_capital_event_type" AS ENUM ('INITIAL_EQUITY_PURCHASE', 'ADD_DEBT_FINANCING', 'REFINANCE', 'EARLY_SETTLEMENT', 'FINANCING_RELEASE', 'LEASE_IN', 'LEASE_TERMINATION', 'MANAGED_IN', 'MANAGED_TERMINATION', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_capital_event_status" AS ENUM ('ACTIVE', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "financing_instrument_type" AS ENUM ('FINANCE_LEASE', 'BANK_AUTO_LOAN', 'BANK_PROJECT_LOAN', 'PERSONAL_LOAN', 'RECEIVABLE_PLEDGE', 'ABS_OR_SPV', 'OTHER');

-- CreateEnum
CREATE TYPE "financing_instrument_status" AS ENUM ('ACTIVE', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "financing_repayment_method" AS ENUM ('INTEREST_ONLY', 'EQUAL_PRINCIPAL_INTEREST', 'EQUAL_PRINCIPAL', 'BULLET', 'MANUAL');

-- CreateEnum
CREATE TYPE "financing_collateral_type" AS ENUM ('VEHICLE', 'VEHICLE_POOL', 'ORDER_RECEIVABLE', 'BILL_RECEIVABLE', 'MIXED', 'NONE', 'OTHER');

-- CreateEnum
CREATE TYPE "financing_allocation_status" AS ENUM ('ACTIVE', 'RELEASED', 'CANCELLED');

-- AlterTable
ALTER TABLE "vehicle" ADD COLUMN "acquisition_mode" "vehicle_acquisition_mode" NOT NULL DEFAULT 'OWNED_CASH';

-- CreateTable
CREATE TABLE "financing_instrument" (
    "id" UUID NOT NULL,
    "instrument_no" VARCHAR(64) NOT NULL,
    "instrument_type" "financing_instrument_type" NOT NULL,
    "instrument_status" "financing_instrument_status" NOT NULL DEFAULT 'ACTIVE',
    "lender_name" VARCHAR(128),
    "contract_no" VARCHAR(128),
    "principal_amount" BIGINT NOT NULL,
    "annual_rate_bps" INTEGER,
    "start_date" DATE NOT NULL,
    "maturity_date" DATE,
    "term_months" INTEGER,
    "repayment_method" "financing_repayment_method",
    "collateral_type" "financing_collateral_type",
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "financing_instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_capital_event" (
    "id" UUID NOT NULL,
    "event_no" VARCHAR(64) NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "event_type" "vehicle_capital_event_type" NOT NULL,
    "event_status" "vehicle_capital_event_status" NOT NULL DEFAULT 'ACTIVE',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "acquisition_mode" "vehicle_acquisition_mode",
    "financing_instrument_id" UUID,
    "equity_capital_amount" BIGINT,
    "debt_principal_amount" BIGINT,
    "external_owner_name" VARCHAR(128),
    "lessor_name" VARCHAR(128),
    "managed_owner_name" VARCHAR(128),
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_capital_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financing_instrument_vehicle" (
    "id" UUID NOT NULL,
    "allocation_no" VARCHAR(64) NOT NULL,
    "instrument_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "allocated_principal_amount" BIGINT NOT NULL,
    "allocation_ratio_bps" INTEGER,
    "allocation_status" "financing_allocation_status" NOT NULL DEFAULT 'ACTIVE',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "financing_instrument_vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "financing_instrument_instrument_no_key" ON "financing_instrument"("instrument_no");

-- CreateIndex
CREATE INDEX "financing_instrument_instrument_type_idx" ON "financing_instrument"("instrument_type");

-- CreateIndex
CREATE INDEX "financing_instrument_instrument_status_idx" ON "financing_instrument"("instrument_status");

-- CreateIndex
CREATE INDEX "financing_instrument_start_date_idx" ON "financing_instrument"("start_date");

-- CreateIndex
CREATE INDEX "financing_instrument_deleted_at_idx" ON "financing_instrument"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_capital_event_event_no_key" ON "vehicle_capital_event"("event_no");

-- CreateIndex
CREATE INDEX "vehicle_capital_event_vehicle_id_idx" ON "vehicle_capital_event"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_capital_event_event_type_idx" ON "vehicle_capital_event"("event_type");

-- CreateIndex
CREATE INDEX "vehicle_capital_event_event_status_idx" ON "vehicle_capital_event"("event_status");

-- CreateIndex
CREATE INDEX "vehicle_capital_event_effective_from_idx" ON "vehicle_capital_event"("effective_from");

-- CreateIndex
CREATE INDEX "vehicle_capital_event_financing_instrument_id_idx" ON "vehicle_capital_event"("financing_instrument_id");

-- CreateIndex
CREATE INDEX "vehicle_capital_event_deleted_at_idx" ON "vehicle_capital_event"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "financing_instrument_vehicle_allocation_no_key" ON "financing_instrument_vehicle"("allocation_no");

-- CreateIndex
CREATE INDEX "financing_instrument_vehicle_instrument_id_idx" ON "financing_instrument_vehicle"("instrument_id");

-- CreateIndex
CREATE INDEX "financing_instrument_vehicle_vehicle_id_idx" ON "financing_instrument_vehicle"("vehicle_id");

-- CreateIndex
CREATE INDEX "financing_instrument_vehicle_allocation_status_idx" ON "financing_instrument_vehicle"("allocation_status");

-- CreateIndex
CREATE INDEX "financing_instrument_vehicle_effective_from_idx" ON "financing_instrument_vehicle"("effective_from");

-- CreateIndex
CREATE INDEX "financing_instrument_vehicle_deleted_at_idx" ON "financing_instrument_vehicle"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "financing_instrument_vehicle_active_instrument_vehicle_key" ON "financing_instrument_vehicle"("instrument_id", "vehicle_id") WHERE "deleted_at" IS NULL AND "allocation_status" = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "vehicle_capital_event" ADD CONSTRAINT "vehicle_capital_event_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_capital_event" ADD CONSTRAINT "vehicle_capital_event_financing_instrument_id_fkey" FOREIGN KEY ("financing_instrument_id") REFERENCES "financing_instrument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financing_instrument_vehicle" ADD CONSTRAINT "financing_instrument_vehicle_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "financing_instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financing_instrument_vehicle" ADD CONSTRAINT "financing_instrument_vehicle_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
