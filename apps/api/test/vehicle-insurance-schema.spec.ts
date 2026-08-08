import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("vehicle insurance policy schema", () => {
  it("defines and migrates the NOT_EFFECTIVE policy status", () => {
    const schema = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
    const labels = fs.readFileSync(path.resolve(__dirname, "../../web/src/constants/labels.ts"), "utf8");
    const migrationPath = path.resolve(
      __dirname,
      "../prisma/migrations/20260724143000_vehicle_insurance_not_effective_status/migration.sql"
    );
    const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, "utf8") : "";

    expect(schema).toMatch(/enum VehicleInsurancePolicyStatus[\s\S]*NOT_EFFECTIVE/);
    expect(migration).not.toBe("");
    expect(migration).toContain(
      "ALTER TYPE \"vehicle_insurance_policy_status\" ADD VALUE IF NOT EXISTS 'NOT_EFFECTIVE'"
    );
    expect(labels).toContain('NOT_EFFECTIVE: "未生效"');
  });

  it("removes legacy vehicle insurance dates with a guarded migration", () => {
    const schema = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
    const migrationPath = path.resolve(
      __dirname,
      "../prisma/migrations/20260724150000_vehicle_insurance_policy_source_of_truth/migration.sql"
    );
    const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, "utf8") : "";

    expect(schema).not.toContain(["insurance", "StartDate"].join(""));
    expect(schema).not.toContain(["insurance", "EndDate"].join(""));
    expect(migration).toContain('DROP COLUMN "insurance_start_date"');
    expect(migration).toContain('DROP COLUMN "insurance_end_date"');
    expect(migration).toContain("RAISE EXCEPTION");
  });

  it("uses a migration-owned partial unique index for active policy numbers", () => {
    const schema = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
    const migrationPath = path.resolve(
      __dirname,
      "../prisma/migrations/20260808190000_vehicle_insurance_policy_active_uniqueness/migration.sql"
    );
    const migration = fs.existsSync(migrationPath)
      ? fs.readFileSync(migrationPath, "utf8")
      : "";

    expect(schema).not.toContain("@@unique([vehicleId, policyNo])");
    expect(schema).toContain("vehicle_insurance_policy_active_vehicle_policy_no_key");
    expect(migration).toContain("duplicate active vehicle insurance policy numbers");
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "vehicle_insurance_policy_active_vehicle_policy_no_key"'
    );
    expect(migration).toContain('WHERE "deleted_at" IS NULL');
  });
});
