import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const enumStringFields = [
  { field: "vehicleModel", model: "VehiclePackage", type: "String" },
  { field: "vehicleModel", model: "ProductPriceRule", type: "String" },
  { field: "vehicleModel", model: "Vehicle", type: "String?" },
  { field: "legacyVehicleModel", model: "VehicleModelDefinition", type: "String?" },
  { field: "vehicleModel", model: "SubscriptionQuote", type: "String" },
  { field: "legacyVehicleModelSnapshot", model: "SubscriptionQuote", type: "String?" },
  { field: "vehicleModel", model: "SubscriptionOrder", type: "String" },
  { field: "legacyVehicleModelSnapshot", model: "SubscriptionOrder", type: "String?" }
];

const enumColumnConversions = [
  { column: "vehicle_model", table: "vehicle_package" },
  { column: "vehicle_model", table: "product_price_rule" },
  { column: "vehicle_model", table: "vehicle" },
  { column: "legacy_vehicle_model", table: "vehicle_model_definition" },
  { column: "vehicle_model", table: "subscription_quote" },
  { column: "legacy_vehicle_model_snapshot", table: "subscription_quote" },
  { column: "vehicle_model", table: "subscription_order" },
  { column: "legacy_vehicle_model_snapshot", table: "subscription_order" }
];

describe("VehicleModel enum string schema contract", () => {
  it("ignores VehicleModel enum examples inside Prisma comments", () => {
    const commentedExamples = `
      // enum VehicleModel {
      //   ET5
      // }
      /*
       * enum VehicleModel {
       *   ES6
       * }
       */
    `;

    expect(stripPrismaComments(commentedExamples)).not.toMatch(/\benum\s+VehicleModel\s*\{/);
  });

  it("removes the Prisma VehicleModel enum", () => {
    const schema = stripPrismaComments(readSchema());

    expect(schema).not.toMatch(/\benum\s+VehicleModel\s*\{/);
  });

  it("represents every former enum field as a string compatibility field", () => {
    const schema = readSchema();

    for (const expected of enumStringFields) {
      expect(extractModel(schema, expected.model)).toMatch(
        new RegExp(`^\\s*${expected.field}\\s+${escapeRegExp(expected.type)}(?:\\s|$)`, "m")
      );
    }
  });

  it("casts all former enum columns before dropping the PostgreSQL enum", () => {
    const migration = readEnumToStringMigration();
    const dropTypeIndex = migration.indexOf('DROP TYPE "vehicle_model"');

    expect(dropTypeIndex).toBeGreaterThanOrEqual(0);

    for (const conversion of enumColumnConversions) {
      const cast = `ALTER TABLE "${conversion.table}"\n  ALTER COLUMN "${conversion.column}" TYPE VARCHAR(64)\n  USING "${conversion.column}"::text;`;
      const castIndex = migration.indexOf(cast);

      expect(castIndex).toBeGreaterThanOrEqual(0);
      expect(castIndex).toBeLessThan(dropTypeIndex);
    }
  });

  it("wraps every enum conversion and enum drop in one explicit transaction", () => {
    const migration = readEnumToStringMigration().trim();

    expect(migration).toMatch(/^BEGIN;\s/);
    expect(migration).toMatch(/\sCOMMIT;$/);
    expect(migration.indexOf("BEGIN;")).toBeLessThan(
      migration.indexOf('ALTER TABLE "vehicle_package"')
    );
    expect(migration.indexOf('DROP TYPE "vehicle_model"')).toBeLessThan(
      migration.lastIndexOf("COMMIT;")
    );
  });
});

function readSchema() {
  return fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
}

function stripPrismaComments(schema: string) {
  return schema.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readEnumToStringMigration() {
  const migrationPath = path.resolve(
    __dirname,
    "../prisma/migrations/20260724170000_vehicle_model_enum_to_string/migration.sql"
  );

  return fs.readFileSync(migrationPath, "utf8");
}

function extractModel(schema: string, modelName: string) {
  const match = schema.match(new RegExp(`\\bmodel\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"));

  if (!match) {
    throw new Error(`Prisma model ${modelName} was not found.`);
  }

  return match[1];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
