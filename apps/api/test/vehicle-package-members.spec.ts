import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { vehiclePackageSupportsModel } from "../src/common/vehicle-package-membership";

const repoRoot = join(__dirname, "..", "..", "..");
const schemaPath = join(repoRoot, "apps", "api", "prisma", "schema.prisma");
const migrationPath = join(
  repoRoot,
  "apps",
  "api",
  "prisma",
  "migrations",
  "20260826021000_stage1_vehicle_package_members",
  "migration.sql"
);

describe("versioned vehicle-package model membership schema", () => {
  it("declares a version-bound member relation with duplicate prevention", () => {
    const schema = readFileSync(schemaPath, "utf8");

    expect(schema).toContain("model VehiclePackageModelMember {");
    expect(schema).toMatch(/modelMembers\s+VehiclePackageModelMember\[\]/);
    expect(schema).toMatch(/vehiclePackageMembers\s+VehiclePackageModelMember\[\]/);
    expect(schema).toContain(
      '@@unique([vehiclePackageId, modelDefinitionId], map: "vehicle_package_model_member_package_model_key")'
    );
  });

  it("backfills every legacy primary model and prevents member reassignment", () => {
    expect(existsSync(migrationPath)).toBe(true);
    if (!existsSync(migrationPath)) return;

    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain('CREATE TABLE "vehicle_package_model_member"');
    expect(migration).toMatch(/SELECT[\s\S]*"id",[\s\S]*"model_definition_id"/);
    expect(migration).toContain('FROM "vehicle_package"');
    expect(migration).toContain("prevent_vehicle_package_model_member_reassignment");
  });
});

describe("vehicle-package model eligibility", () => {
  it("uses version-bound members instead of the legacy primary field", () => {
    const vehiclePackage = {
      modelDefinitionId: "legacy-primary",
      modelMembers: [{ modelDefinitionId: "model-et5" }, { modelDefinitionId: "model-es6" }]
    };

    expect(vehiclePackageSupportsModel(vehiclePackage, "model-es6")).toBe(true);
    expect(vehiclePackageSupportsModel(vehiclePackage, "legacy-primary")).toBe(false);
  });

  it("does not silently fall back when membership backfill is missing", () => {
    expect(
      vehiclePackageSupportsModel(
        { modelDefinitionId: "legacy-primary", modelMembers: [] },
        "legacy-primary"
      )
    ).toBe(false);
  });
});
