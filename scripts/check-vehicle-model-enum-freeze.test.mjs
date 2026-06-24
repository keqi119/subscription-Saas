import assert from "node:assert/strict";
import test from "node:test";

import {
  compareVehicleModelValues,
  extractVehicleModelValues,
  FROZEN_VEHICLE_MODEL_VALUES
} from "./check-vehicle-model-enum-freeze.mjs";

test("extracts VehicleModel values while ignoring comments, attributes, and other enums", () => {
  const schema = `
    enum OtherEnum {
      MODEL_Y
    }

    enum VehicleModel {
      ET5
      // COMMENTED_OUT_MODEL
      ET5T @map("et5t")
      ET7
      ES6
      EC6
      ES8
      /*
       * BLOCK_COMMENT_MODEL
       */
      ET9
      ES9

      @@map("vehicle_model")
    }
  `;

  assert.deepEqual(extractVehicleModelValues(schema), FROZEN_VEHICLE_MODEL_VALUES);
});

test("reports unexpected and missing VehicleModel values", () => {
  const diff = compareVehicleModelValues(["ET5", "ET7", "ES6", "EC6", "ES8", "ET9", "ES9", "MODEL_Y"]);

  assert.deepEqual(diff.unexpectedValues, ["MODEL_Y"]);
  assert.deepEqual(diff.missingValues, ["ET5T"]);
});
