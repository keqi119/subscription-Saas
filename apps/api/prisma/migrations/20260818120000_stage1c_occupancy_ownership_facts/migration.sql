-- PostgreSQL range exclusion constraints on UUID equality require btree_gist.
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateEnum
CREATE TYPE "asset_owner_type" AS ENUM ('PLATFORM', 'EXTERNAL_COMPANY');

-- CreateEnum
CREATE TYPE "asset_owner_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "vehicle_ownership_period_start_reason" AS ENUM ('INITIAL_ACQUISITION', 'OWNERSHIP_TRANSFER', 'BACKFILL', 'MANUAL_REPAIR');

-- CreateEnum
CREATE TYPE "vehicle_ownership_period_end_reason" AS ENUM ('OWNERSHIP_TRANSFER', 'DISPOSAL', 'BACKFILL', 'MANUAL_REPAIR');

-- CreateEnum
CREATE TYPE "vehicle_subscription_period_start_reason" AS ENUM ('LEASE_ACTIVATED', 'DELIVERY_CONFIRMED', 'VEHICLE_SWAP', 'BACKFILL', 'MANUAL_REPAIR');

-- CreateEnum
CREATE TYPE "vehicle_subscription_period_end_reason" AS ENUM ('RETURN_CONFIRMED', 'RECOVERY_CONFIRMED', 'VEHICLE_SWAP', 'NORMAL_COMPLETION', 'EARLY_TERMINATION', 'BACKFILL', 'MANUAL_REPAIR');

-- CreateTable
CREATE TABLE "asset_owner" (
    "id" UUID NOT NULL,
    "owner_no" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "legal_name" VARCHAR(128),
    "registration_identifier" VARCHAR(128),
    "owner_type" "asset_owner_type" NOT NULL,
    "status" "asset_owner_status" NOT NULL DEFAULT 'ACTIVE',
    "onboarding_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "asset_owner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_ownership_period" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "asset_owner_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "start_reason" "vehicle_ownership_period_start_reason" NOT NULL,
    "end_reason" "vehicle_ownership_period_end_reason",
    "start_source_type" VARCHAR(64) NOT NULL,
    "start_source_id" UUID NOT NULL,
    "start_source_key" VARCHAR(255) NOT NULL,
    "end_source_type" VARCHAR(64),
    "end_source_id" UUID,
    "end_source_key" VARCHAR(255),
    "start_snapshot" JSONB NOT NULL,
    "end_snapshot" JSONB,
    "start_confirmed_by" UUID,
    "start_confirmed_at" TIMESTAMPTZ(6),
    "end_confirmed_by" UUID,
    "end_confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,

    CONSTRAINT "vehicle_ownership_period_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "vehicle_ownership_period_end_after_start_chk"
        CHECK ("ended_at" IS NULL OR "ended_at" > "started_at")
);

-- CreateTable
CREATE TABLE "vehicle_subscription_period" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "contract_id" UUID,
    "contract_segment_id" UUID,
    "customer_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "start_reason" "vehicle_subscription_period_start_reason" NOT NULL,
    "end_reason" "vehicle_subscription_period_end_reason",
    "start_source_type" VARCHAR(64) NOT NULL,
    "start_source_id" UUID NOT NULL,
    "start_source_key" VARCHAR(255) NOT NULL,
    "end_source_type" VARCHAR(64),
    "end_source_id" UUID,
    "end_source_key" VARCHAR(255),
    "start_snapshot" JSONB NOT NULL,
    "end_snapshot" JSONB,
    "start_confirmed_by" UUID,
    "start_confirmed_at" TIMESTAMPTZ(6),
    "end_confirmed_by" UUID,
    "end_confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,

    CONSTRAINT "vehicle_subscription_period_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "vehicle_subscription_period_end_after_start_chk"
        CHECK ("ended_at" IS NULL OR "ended_at" > "started_at")
);

-- CreateIndex
CREATE UNIQUE INDEX "asset_owner_owner_no_key" ON "asset_owner"("owner_no");
CREATE INDEX "asset_owner_owner_type_idx" ON "asset_owner"("owner_type");
CREATE INDEX "asset_owner_status_idx" ON "asset_owner"("status");
CREATE INDEX "asset_owner_created_by_idx" ON "asset_owner"("created_by");
CREATE INDEX "asset_owner_updated_by_idx" ON "asset_owner"("updated_by");

CREATE INDEX "vehicle_ownership_period_vehicle_started_at_idx" ON "vehicle_ownership_period"("vehicle_id", "started_at");
CREATE INDEX "vehicle_ownership_period_owner_started_at_idx" ON "vehicle_ownership_period"("asset_owner_id", "started_at");
CREATE INDEX "vehicle_ownership_period_start_confirmed_by_idx" ON "vehicle_ownership_period"("start_confirmed_by");
CREATE INDEX "vehicle_ownership_period_end_confirmed_by_idx" ON "vehicle_ownership_period"("end_confirmed_by");
CREATE INDEX "vehicle_ownership_period_created_by_idx" ON "vehicle_ownership_period"("created_by");
CREATE UNIQUE INDEX "vehicle_ownership_period_start_source_key" ON "vehicle_ownership_period"("start_source_type", "start_source_id", "start_source_key");
CREATE UNIQUE INDEX "vehicle_ownership_period_end_source_key" ON "vehicle_ownership_period"("end_source_type", "end_source_id", "end_source_key");

CREATE INDEX "vehicle_subscription_period_vehicle_started_at_idx" ON "vehicle_subscription_period"("vehicle_id", "started_at");
CREATE INDEX "vehicle_subscription_period_order_started_at_idx" ON "vehicle_subscription_period"("order_id", "started_at");
CREATE INDEX "vehicle_subscription_period_contract_id_idx" ON "vehicle_subscription_period"("contract_id");
CREATE INDEX "vehicle_subscription_period_contract_segment_id_idx" ON "vehicle_subscription_period"("contract_segment_id");
CREATE INDEX "vehicle_subscription_period_customer_started_at_idx" ON "vehicle_subscription_period"("customer_id", "started_at");
CREATE INDEX "vehicle_subscription_period_start_confirmed_by_idx" ON "vehicle_subscription_period"("start_confirmed_by");
CREATE INDEX "vehicle_subscription_period_end_confirmed_by_idx" ON "vehicle_subscription_period"("end_confirmed_by");
CREATE INDEX "vehicle_subscription_period_created_by_idx" ON "vehicle_subscription_period"("created_by");
CREATE UNIQUE INDEX "vehicle_subscription_period_start_source_key" ON "vehicle_subscription_period"("start_source_type", "start_source_id", "start_source_key");
CREATE UNIQUE INDEX "vehicle_subscription_period_end_source_key" ON "vehicle_subscription_period"("end_source_type", "end_source_id", "end_source_key");

-- A period is current while ended_at is NULL. These indexes are the
-- concurrency authority for exactly one current period per aggregate.
CREATE UNIQUE INDEX "vehicle_ownership_period_one_open_per_vehicle_uidx"
    ON "vehicle_ownership_period"("vehicle_id")
    WHERE "ended_at" IS NULL;
CREATE UNIQUE INDEX "vehicle_subscription_period_one_open_per_vehicle_uidx"
    ON "vehicle_subscription_period"("vehicle_id")
    WHERE "ended_at" IS NULL;
CREATE UNIQUE INDEX "vehicle_subscription_period_one_open_per_order_uidx"
    ON "vehicle_subscription_period"("order_id")
    WHERE "ended_at" IS NULL;

-- Half-open ranges allow adjacent periods while rejecting every overlap.
ALTER TABLE "vehicle_ownership_period"
    ADD CONSTRAINT "vehicle_ownership_period_no_overlap_excl"
    EXCLUDE USING GIST (
        "vehicle_id" WITH =,
        tstzrange("started_at", COALESCE("ended_at", 'infinity'::timestamptz), '[)') WITH &&
    );
ALTER TABLE "vehicle_subscription_period"
    ADD CONSTRAINT "vehicle_subscription_period_no_overlap_excl"
    EXCLUDE USING GIST (
        "vehicle_id" WITH =,
        tstzrange("started_at", COALESCE("ended_at", 'infinity'::timestamptz), '[)') WITH &&
    );

-- AddForeignKey
ALTER TABLE "asset_owner" ADD CONSTRAINT "asset_owner_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_owner" ADD CONSTRAINT "asset_owner_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "vehicle_ownership_period" ADD CONSTRAINT "vehicle_ownership_period_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_ownership_period" ADD CONSTRAINT "vehicle_ownership_period_asset_owner_id_fkey" FOREIGN KEY ("asset_owner_id") REFERENCES "asset_owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_ownership_period" ADD CONSTRAINT "vehicle_ownership_period_start_confirmed_by_fkey" FOREIGN KEY ("start_confirmed_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_ownership_period" ADD CONSTRAINT "vehicle_ownership_period_end_confirmed_by_fkey" FOREIGN KEY ("end_confirmed_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_ownership_period" ADD CONSTRAINT "vehicle_ownership_period_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "vehicle_subscription_period" ADD CONSTRAINT "vehicle_subscription_period_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_subscription_period" ADD CONSTRAINT "vehicle_subscription_period_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_subscription_period" ADD CONSTRAINT "vehicle_subscription_period_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_subscription_period" ADD CONSTRAINT "vehicle_subscription_period_contract_segment_id_fkey" FOREIGN KEY ("contract_segment_id") REFERENCES "subscription_contract_segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_subscription_period" ADD CONSTRAINT "vehicle_subscription_period_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_subscription_period" ADD CONSTRAINT "vehicle_subscription_period_start_confirmed_by_fkey" FOREIGN KEY ("start_confirmed_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_subscription_period" ADD CONSTRAINT "vehicle_subscription_period_end_confirmed_by_fkey" FOREIGN KEY ("end_confirmed_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_subscription_period" ADD CONSTRAINT "vehicle_subscription_period_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
