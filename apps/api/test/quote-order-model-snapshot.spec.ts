import { VehicleModel } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { buildQuoteOrderModelDisplay } from "../src/common/vehicle-model-snapshot";

describe("quote/order model snapshot display helper", () => {
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
      modelDefinitionId: "snapshot-model",
      modelDisplayName: "Current ET5 Name",
      modelDisplaySource: "RUNTIME_MODEL_DEFINITION"
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
      modelDefinitionId: null,
      modelDisplayName: VehicleModel.ET7,
      modelDisplaySource: "LEGACY_SNAPSHOT"
    });
  });

  it("uses runtime vehicle model only when no snapshot data exists", () => {
    expect(
      buildQuoteOrderModelDisplay({
        vehicleModel: VehicleModel.ES6
      })
    ).toEqual({
      legacyVehicleModel: VehicleModel.ES6,
      modelDefinitionId: null,
      modelDisplayName: VehicleModel.ES6,
      modelDisplaySource: "LEGACY_VEHICLE_MODEL"
    });
  });
});
