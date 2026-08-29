import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertNoVehicleModelCompatibility } from "./check-vehicle-model-no-compatibility.mjs";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

test("accepts canonical model identity and snapshot fields", () => {
  const report = assertNoVehicleModelCompatibility({
    runtimeFiles: [
      {
        content:
          "export interface VehicleSummary { modelDefinitionId: string; modelCode: string; modelDisplayName: string; }",
        path: "apps/api/src/vehicle/vehicle.service.ts"
      },
      {
        content:
          "export const snapshot = { modelDefinitionIdSnapshot: id, modelCodeSnapshot: code, modelDisplayNameSnapshot: name };",
        path: "apps/api/src/order/order.service.ts"
      }
    ],
    schemaText: canonicalSchema()
  });

  assert.deepEqual(report.violations, []);
});

test("rejects a DTO vehicleModel property", () => {
  assertViolation(
    "export class CreateVehicleDto { vehicleModel?: string; }",
    "apps/api/src/vehicle/dto/vehicle.dto.ts",
    "VEHICLE_MODEL_COMPATIBILITY_IDENTIFIER"
  );
});

test("rejects a legacy response mapping", () => {
  assertViolation(
    "export const response = { legacyVehicleModel: definition.modelCode };",
    "apps/api/src/vehicle-model-definition/vehicle-model-definition.service.ts",
    "LEGACY_VEHICLE_MODEL_IDENTIFIER"
  );
});

test("rejects a Prisma legacy snapshot select", () => {
  assertViolation(
    "export const select = { legacyVehicleModelSnapshot: true };",
    "apps/api/src/report/report.service.ts",
    "LEGACY_VEHICLE_MODEL_SNAPSHOT_IDENTIFIER"
  );
});

test("rejects a CSV compatibility header", () => {
  assertViolation(
    'export const headers = ["legacyVehicleModelCodeSnapshot"];',
    "apps/api/src/report/report.service.ts",
    "LEGACY_VEHICLE_MODEL_CODE_SNAPSHOT_IDENTIFIER"
  );
});

test("rejects a runtime Prisma VehicleModel import", () => {
  assertViolation(
    'import { VehicleModel } from "@prisma/client";',
    "apps/api/src/vehicle/vehicle.service.ts",
    "RUNTIME_VEHICLE_MODEL_TYPE"
  );
});

test("ignores removed-field names in comments", () => {
  const report = assertNoVehicleModelCompatibility({
    runtimeFiles: [
      {
        content: [
          "// vehicleModel",
          "/* legacyVehicleModel legacyVehicleModelSnapshot legacyVehicleModelCodeSnapshot */",
          "export const modelCode = 'NIO_ET5';"
        ].join("\n"),
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    ],
    schemaText: canonicalSchema()
  });

  assert.deepEqual(report.violations, []);
});

test("release check runs the compatibility guard and its tests", () => {
  const releaseCheck = readFileSync(resolve(currentDirectory, "release-check.mjs"), "utf8");

  assert.match(
    releaseCheck,
    /\[\s*"VehicleModel no-compatibility guard"\s*,\s*"node"\s*,\s*\[\s*"scripts\/check-vehicle-model-no-compatibility\.mjs"\s*\]\s*\]/
  );
  assert.match(
    releaseCheck,
    /\[\s*"VehicleModel no-compatibility guard tests"\s*,\s*"node"\s*,\s*\[\s*"--test"\s*,\s*"scripts\/check-vehicle-model-no-compatibility\.test\.mjs"\s*\]\s*\]/
  );
});

function assertViolation(content, path, category) {
  const report = assertNoVehicleModelCompatibility({
    runtimeFiles: [{ content, path }],
    schemaText: canonicalSchema()
  });

  assert.deepEqual(report.violations, [{ category, path }]);
}

function canonicalSchema() {
  return `
    model Vehicle {
      modelDefinitionId String @map("model_definition_id") @db.Uuid
    }

    model SubscriptionOrder {
      modelDefinitionIdSnapshot String @map("model_definition_id_snapshot") @db.Uuid
      modelCodeSnapshot String @map("model_code_snapshot") @db.VarChar(64)
      modelDisplayNameSnapshot String @map("model_display_name_snapshot") @db.VarChar(128)
    }
  `;
}
