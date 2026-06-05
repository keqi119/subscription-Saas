-- Add values used by the return-to-pool vehicle flow while keeping the existing RENTED value.
ALTER TYPE "vehicle_status" ADD VALUE IF NOT EXISTS 'LEASED';
ALTER TYPE "vehicle_status" ADD VALUE IF NOT EXISTS 'RETURNED';

-- Tracks whether a vehicle that left the available pool must be reinitialized before re-entering.
ALTER TABLE "vehicle" ADD COLUMN "sale_price_reinit_required_at" TIMESTAMPTZ(6);

CREATE INDEX "vehicle_sale_price_reinit_required_at_idx" ON "vehicle"("sale_price_reinit_required_at");
