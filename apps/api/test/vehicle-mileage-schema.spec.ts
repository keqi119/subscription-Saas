import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const apiRoot = join(__dirname, "..");
const schema = readFileSync(join(apiRoot, "prisma/schema.prisma"), "utf8");
const migrationPath = join(
  apiRoot,
  "prisma/migrations/20260802100000_vehicle_mileage_readings/migration.sql"
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

function prismaBlock(kind: "enum" | "model", name: string) {
  const match = schema.match(new RegExp(`${kind} ${name} \\{([\\s\\S]*?)\\n\\}`));
  expect(match, `missing ${kind} ${name}`).not.toBeNull();
  return match![1]!;
}

describe("vehicle mileage ledger schema", () => {
  it("defines immutable mileage source and status enums", () => {
    expect(prismaBlock("enum", "VehicleMileageSourceType")).toContain(
      "VEHICLE_INITIALIZATION"
    );
    expect(prismaBlock("enum", "VehicleMileageSourceType")).toContain("LEGACY_MIGRATION");
    expect(prismaBlock("enum", "VehicleMileageSourceType")).toContain("DELIVERY_BASELINE");
    expect(prismaBlock("enum", "VehicleMileageSourceType")).toContain("MONTHLY_REVIEW");
    expect(prismaBlock("enum", "VehicleMileageSourceType")).toContain("RETURN_CONFIRMATION");
    expect(prismaBlock("enum", "VehicleMileageSourceType")).toContain("MANUAL_CORRECTION");
    expect(prismaBlock("enum", "VehicleMileageReadingStatus")).toContain("ACTIVE");
    expect(prismaBlock("enum", "VehicleMileageReadingStatus")).toContain("VOIDED");
  });

  it("defines the append-only reading model and owner relations", () => {
    const reading = prismaBlock("model", "VehicleMileageReading");
    const vehicle = prismaBlock("model", "Vehicle");
    const order = prismaBlock("model", "SubscriptionOrder");

    expect(reading).toContain("vehicleId");
    expect(reading).toContain("orderId");
    expect(reading).toContain("sourceType");
    expect(reading).toContain("sourceRecordId");
    expect(reading).toContain("recordedAt");
    expect(reading).toContain("mileageKm");
    expect(reading).toContain("previousReadingId");
    expect(reading).toContain("deltaKm");
    expect(reading).toContain("evidenceSnapshot");
    expect(reading).toContain("confirmedBy");
    expect(reading).toContain("voidedBy");
    expect(reading).toContain("@@unique([sourceType, sourceRecordId])");
    expect(reading).toContain("@@index([vehicleId, status, recordedAt])");
    expect(reading).toContain("@@index([orderId, recordedAt])");
    expect(vehicle).toContain("mileageReadings");
    expect(order).toContain("mileageReadings");
  });

  it("creates and idempotently backfills legacy readings without updating vehicles", () => {
    expect(migration).not.toBe("");
    expect(migration).toContain('CREATE TYPE "vehicle_mileage_source_type"');
    expect(migration).toContain('CREATE TABLE "vehicle_mileage_reading"');
    expect(migration).toContain("LEGACY_MIGRATION");
    expect(migration).toContain('v."current_mileage_km"');
    expect(migration).toContain("ON CONFLICT");
    expect(migration).not.toMatch(/UPDATE\s+"vehicle"\s+SET\s+"current_mileage_km"/i);
  });
});
