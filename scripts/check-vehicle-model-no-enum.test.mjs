import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertVehicleModelEnumRemoved } from "./check-vehicle-model-no-enum.mjs";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

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

test("rejects a Prisma list field typed as VehicleModel", () => {
  assertDependency(
    `
      model VehicleModelCollection {
        models VehicleModel[]
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

test("rejects a real Prisma namespace VehicleModel dependency", () => {
  assertDependency(
    "model Vehicle { vehicleModel String? }",
    [
      {
        content:
          'import * as PrismaClient from "@prisma/client";\nexport type LegacyModel = PrismaClient.VehicleModel;',
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    ],
    { category: "PRISMA_VEHICLE_MODEL_NAMESPACE", path: "apps/api/src/vehicle/vehicle.service.ts" }
  );
});

test("ignores Prisma VehicleModel imports inside JavaScript and TypeScript comments", () => {
  assert.doesNotThrow(() =>
    assertVehicleModelEnumRemoved("model Vehicle { vehicleModel String? }", [
      {
        content: [
          '// import { VehicleModel } from "@prisma/client";',
          '/* import * as PrismaClient from "@prisma/client";',
          "type LegacyModel = PrismaClient.VehicleModel; */",
          "export const vehicleModel = null;"
        ].join("\n"),
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    ])
  );
});

test("ignores Prisma VehicleModel imports inside string and template literals", () => {
  assert.doesNotThrow(() =>
    assertVehicleModelEnumRemoved("model Vehicle { vehicleModel String? }", [
      {
        content: [
          'const namedImportFixture = \'import { VehicleModel } from "@prisma/client";\';',
          'const namespaceFixture = `import * as PrismaClient from "@prisma/client";',
          "type LegacyModel = PrismaClient.VehicleModel;`;"
        ].join("\n"),
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    ])
  );
});

test("release check runs the no-enum guard directly without a package script", () => {
  const releaseCheck = readFileSync(resolve(currentDirectory, "release-check.mjs"), "utf8");

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
