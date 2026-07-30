import { describe, expect, it } from "vitest";

import { buildVehicleModelSnapshot } from "../src/common/vehicle-model-snapshot";

describe("buildVehicleModelSnapshot", () => {
  it("freezes a canonical model identity for quote and order facts", () => {
    expect(
      buildVehicleModelSnapshot({
        modelCode: "MODEL_X_2027",
        modelDefinitionId: "definition-id",
        modelDisplayName: "Model X 2027"
      })
    ).toEqual({
      modelCodeSnapshot: "MODEL_X_2027",
      modelDefinitionIdSnapshot: "definition-id",
      modelDisplayNameSnapshot: "Model X 2027"
    });
  });
});
