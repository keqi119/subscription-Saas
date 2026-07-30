import assert from "node:assert/strict";
import test from "node:test";

import {
  assertVehicleModelStringCodeGovernance
} from "./check-vehicle-model-enum-freeze.mjs";

test("keeps the legacy enum-freeze entry point as a no-enum compatibility wrapper", () => {
  assert.doesNotThrow(() =>
    assertVehicleModelStringCodeGovernance(
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

test("legacy enum-freeze entry point rejects a restored Prisma enum dependency", () => {
  assert.throws(
    () =>
      assertVehicleModelStringCodeGovernance(
        `
          enum VehicleModel {
            ET5
          }
        `,
        []
      ),
    /VehicleModel enum dependencies remain/
  );
});
