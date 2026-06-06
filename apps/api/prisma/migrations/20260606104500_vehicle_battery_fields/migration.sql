CREATE TYPE "vehicle_battery_usage_type" AS ENUM ('BUYOUT', 'BAAS');

ALTER TABLE "vehicle" ADD COLUMN     "battery_capacity_kwh" DECIMAL(6,2),
ADD COLUMN     "battery_usage_type" "vehicle_battery_usage_type" NOT NULL DEFAULT 'BUYOUT';
