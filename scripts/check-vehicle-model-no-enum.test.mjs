import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

import { assertVehicleModelEnumRemoved } from "./check-vehicle-model-no-enum.mjs";

test("accepts string compatibility fields without Prisma enum dependencies", () => {
  assert.doesNotThrow(() =>
    assertVehicleModelEnumRemoved(
      `
        model Vehicle {
          vehicleModel String? @map("vehicle_model") @db.VarChar(64)
        }
      `,
      [
        {
          content: 'export type VehicleSummary = { vehicleModel?: string | null };',
          path: "apps/api/src/vehicle/vehicle.service.ts"
        }
      ]
    )
  );
});

test("rejects a Prisma VehicleModel enum block", () => {
  assertDependency(
    `
      enum VehicleModel {
        ET5
      }
    `,
    [],
    { category: "SCHEMA_ENUM_BLOCK", path: "apps/api/prisma/schema.prisma" }
  );
});

test("rejects a Prisma field typed as VehicleModel", () => {
  assertDependency(
    `
      model Vehicle {
        vehicleModel VehicleModel? @map("vehicle_model")
      }
    `,
    [],
    { category: "SCHEMA_ENUM_FIELD", path: "apps/api/prisma/schema.prisma" }
  );
});

test("rejects a runtime Prisma VehicleModel import", () => {
  assertDependency(
    "model Vehicle { vehicleModel String? }",
    [
      {
        content: 'import { Prisma, VehicleModel } from "@prisma/client";',
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    ],
    { category: "PRISMA_VEHICLE_MODEL_IMPORT", path: "apps/api/src/vehicle/vehicle.service.ts" }
  );
});

test("release check runs the no-enum guard directly without a package script", () => {
  const releaseCheck = readFileSync(resolve("scripts/release-check.mjs"), "utf8");

  assert.match(
    releaseCheck,
    /\["VehicleModel no-enum guard", "node", \["scripts\/check-vehicle-model-no-enum\.mjs"\]\]/
  );
  assert.match(
    releaseCheck,
    /\["VehicleModel no-enum guard tests", "node", \["--test", "scripts\/check-vehicle-model-no-enum\.test\.mjs"\]\]/
  );
  assert.doesNotMatch(releaseCheck, /vehicle-model:enum-freeze/);
});

function assertDependency(schemaText, runtimeFiles, expectedDependency) {
  assert.throws(
    () => assertVehicleModelEnumRemoved(schemaText, runtimeFiles),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.deepEqual(error.dependencies, [expectedDependency]);
      return true;
    }
  );
}
