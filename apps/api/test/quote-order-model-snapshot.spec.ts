import { describe, expect, it } from "vitest";

import {
  buildQuoteOrderModelDisplay,
  buildVehicleModelSnapshot
} from "../src/common/vehicle-model-snapshot";

const VehicleModel = {
  ES6: "ES6",
  ET5: "ET5",
  ET7: "ET7"
} as const;

describe("quote/order model snapshot display helper", () => {
  it("freezes a new model definition code without a legacy enum mapping", () => {
    const snapshot = buildVehicleModelSnapshot({
      modelDefinition: {
        displayName: "Model X 2027",
        id: "model-x-2027",
        modelCode: "MODEL_X_2027"
      },
      modelDefinitionId: "model-x-2027"
    });

    expect(snapshot).toEqual({
      legacyVehicleModelSnapshot: "MODEL_X_2027",
      legacyVehicleModelCodeSnapshot: "MODEL_X_2027",
      modelDefinitionIdSnapshot: "model-x-2027",
      modelDisplayNameSnapshot: "Model X 2027"
    });
    expect(buildQuoteOrderModelDisplay(snapshot)).toMatchObject({
      legacyVehicleModelCode: "MODEL_X_2027",
      modelDisplayName: "Model X 2027",
      modelDisplaySource: "SNAPSHOT"
    });
  });

  it("prefers immutable snapshot display names", () => {
    expect(
      buildQuoteOrderModelDisplay({
        legacyVehicleModelSnapshot: VehicleModel.ET5,
        modelDefinition: { displayName: "Runtime ET5", id: "runtime-model" },
        modelDefinitionId: "runtime-model",
        modelDefinitionIdSnapshot: "snapshot-model",
        modelDisplayNameSnapshot: "Frozen ET5",
        vehicleModel: VehicleModel.ES6
      })
    ).toEqual({
      legacyVehicleModel: VehicleModel.ET5,
      legacyVehicleModelCode: VehicleModel.ET5,
      modelDefinitionId: "snapshot-model",
      modelDisplayName: "Frozen ET5",
      modelDisplaySource: "SNAPSHOT"
    });
  });

  it("uses runtime lookup only when the display snapshot is missing", () => {
    expect(
      buildQuoteOrderModelDisplay({
        legacyVehicleModelSnapshot: VehicleModel.ET5,
        modelDefinition: { displayName: "Current ET5 Name", id: "snapshot-model" },
        modelDefinitionIdSnapshot: "snapshot-model",
        modelDisplayNameSnapshot: null,
        vehicleModel: VehicleModel.ES6
      })
    ).toEqual({
      legacyVehicleModel: VehicleModel.ET5,
      legacyVehicleModelCode: VehicleModel.ET5,
      modelDefinitionId: "snapshot-model",
      modelDisplayName: "Current ET5 Name",
      modelDisplaySource: "RUNTIME_MODEL_DEFINITION"
    });
  });

  it("falls back to legacy model code snapshots before enum snapshots", () => {
    expect(
      buildQuoteOrderModelDisplay({
        legacyVehicleModelCodeSnapshot: "ET5T",
        legacyVehicleModelSnapshot: VehicleModel.ET5,
        modelDisplayNameSnapshot: null,
        vehicleModel: VehicleModel.ES6
      })
    ).toEqual({
      legacyVehicleModel: VehicleModel.ET5,
      legacyVehicleModelCode: "ET5T",
      modelDefinitionId: null,
      modelDisplayName: "ET5T",
      modelDisplaySource: "SNAPSHOT_MODEL_CODE"
    });
  });

  it("falls back to legacy snapshot before runtime vehicle model", () => {
    expect(
      buildQuoteOrderModelDisplay({
        legacyVehicleModelSnapshot: VehicleModel.ET7,
        modelDisplayNameSnapshot: null,
        vehicleModel: VehicleModel.ES6
      })
    ).toEqual({
      legacyVehicleModel: VehicleModel.ET7,
      legacyVehicleModelCode: VehicleModel.ET7,
      modelDefinitionId: null,
      modelDisplayName: VehicleModel.ET7,
      modelDisplaySource: "SNAPSHOT_LEGACY_ENUM"
    });
  });

  it("uses runtime vehicle model only when no snapshot data exists", () => {
    expect(
      buildQuoteOrderModelDisplay({
        vehicleModel: VehicleModel.ES6
      })
    ).toEqual({
      legacyVehicleModel: VehicleModel.ES6,
      legacyVehicleModelCode: VehicleModel.ES6,
      modelDefinitionId: null,
      modelDisplayName: VehicleModel.ES6,
      modelDisplaySource: "LEGACY_VEHICLE_MODEL"
    });
  });
});
