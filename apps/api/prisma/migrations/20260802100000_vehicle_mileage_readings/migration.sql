-- CreateEnum
CREATE TYPE "vehicle_mileage_source_type" AS ENUM (
  'VEHICLE_INITIALIZATION',
  'LEGACY_MIGRATION',
  'DELIVERY_BASELINE',
  'MONTHLY_REVIEW',
  'RETURN_CONFIRMATION',
  'MANUAL_CORRECTION'
);

-- CreateEnum
CREATE TYPE "vehicle_mileage_reading_status" AS ENUM ('ACTIVE', 'VOIDED');

-- CreateTable
CREATE TABLE "vehicle_mileage_reading" (
  "id" UUID NOT NULL,
  "vehicle_id" UUID NOT NULL,
  "order_id" UUID,
  "source_type" "vehicle_mileage_source_type" NOT NULL,
  "source_record_id" VARCHAR(128) NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL,
  "mileage_km" INTEGER NOT NULL,
  "previous_reading_id" UUID,
  "delta_km" INTEGER NOT NULL,
  "status" "vehicle_mileage_reading_status" NOT NULL DEFAULT 'ACTIVE',
  "evidence_snapshot" JSONB,
  "confirmed_by" UUID,
  "confirmed_at" TIMESTAMPTZ(6),
  "voided_by" UUID,
  "voided_at" TIMESTAMPTZ(6),
  "void_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID,
  "updated_by" UUID,

  CONSTRAINT "vehicle_mileage_reading_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vehicle_mileage_reading_mileage_nonnegative" CHECK ("mileage_km" >= 0),
  CONSTRAINT "vehicle_mileage_reading_delta_nonnegative" CHECK ("delta_km" >= 0),
  CONSTRAINT "vehicle_mileage_reading_void_state" CHECK (
    ("status" = 'ACTIVE' AND "voided_at" IS NULL AND "voided_by" IS NULL) OR
    ("status" = 'VOIDED' AND "voided_at" IS NOT NULL)
  )
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_mileage_reading_source_type_source_record_id_key"
  ON "vehicle_mileage_reading"("source_type", "source_record_id");
CREATE INDEX "vehicle_mileage_reading_vehicle_id_status_recorded_at_idx"
  ON "vehicle_mileage_reading"("vehicle_id", "status", "recorded_at");
CREATE INDEX "vehicle_mileage_reading_order_id_recorded_at_idx"
  ON "vehicle_mileage_reading"("order_id", "recorded_at");
CREATE INDEX "vehicle_mileage_reading_previous_reading_id_idx"
  ON "vehicle_mileage_reading"("previous_reading_id");
CREATE INDEX "vehicle_mileage_reading_confirmed_by_idx"
  ON "vehicle_mileage_reading"("confirmed_by");
CREATE INDEX "vehicle_mileage_reading_voided_by_idx"
  ON "vehicle_mileage_reading"("voided_by");

-- AddForeignKey
ALTER TABLE "vehicle_mileage_reading"
  ADD CONSTRAINT "vehicle_mileage_reading_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_mileage_reading"
  ADD CONSTRAINT "vehicle_mileage_reading_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_mileage_reading"
  ADD CONSTRAINT "vehicle_mileage_reading_previous_reading_id_fkey"
  FOREIGN KEY ("previous_reading_id") REFERENCES "vehicle_mileage_reading"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_mileage_reading"
  ADD CONSTRAINT "vehicle_mileage_reading_confirmed_by_fkey"
  FOREIGN KEY ("confirmed_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_mileage_reading"
  ADD CONSTRAINT "vehicle_mileage_reading_voided_by_fkey"
  FOREIGN KEY ("voided_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill one immutable starting point per historical vehicle without changing vehicle.current_mileage_km.
INSERT INTO "vehicle_mileage_reading" (
  "id",
  "vehicle_id",
  "source_type",
  "source_record_id",
  "recorded_at",
  "mileage_km",
  "delta_km",
  "status",
  "evidence_snapshot",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  v."id",
  'LEGACY_MIGRATION',
  v."id"::text,
  COALESCE(v."updated_at", v."created_at"),
  v."current_mileage_km",
  v."current_mileage_km",
  'ACTIVE',
  jsonb_build_object('migration', '20260802100000_vehicle_mileage_readings'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "vehicle" v
WHERE v."deleted_at" IS NULL
ON CONFLICT ("source_type", "source_record_id") DO NOTHING;
