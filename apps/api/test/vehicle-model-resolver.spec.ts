import { VehicleModel } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  resolveVehicleModel,
  vehicleModelReadPathMatches,
  VehicleModelLegacyAdapter
} from "../src/common/vehicle-model-resolver";
import { vehicleModelUsageTracker } from "../src/common/vehicle-model-usage-tracker";

describe("VehicleModelResolver", () => {
  it("uses modelDefinitionId as the primary model identity", () => {
    expect(
      resolveVehicleModel({
        modelDefinition: { displayName: "NIO ET5 Touring", id: "model-et5t" },
        modelDefinitionId: "model-et5t",
        vehicleModel: VehicleModel.ET5
      })
    ).toEqual({
      legacyVehicleModel: VehicleModel.ET5,
      legacyVehicleModelCode: VehicleModel.ET5,
      modelDefinitionId: "model-et5t",
      modelDisplayName: "NIO ET5 Touring",
      source: "MODEL_DEFINITION"
    });
  });

  it("falls back to legacy enum only as compatibility identity", () => {
    expect(resolveVehicleModel({ vehicleModel: VehicleModel.ES6 })).toEqual({
      legacyVehicleModel: VehicleModel.ES6,
      legacyVehicleModelCode: VehicleModel.ES6,
      modelDefinitionId: null,
      modelDisplayName: VehicleModel.ES6,
      source: "LEGACY_ENUM"
    });
  });

  it("matches read paths by modelDefinitionId before legacy enum", () => {
    expect(
      vehicleModelReadPathMatches(
        { modelDefinitionId: "model-et5", vehicleModel: VehicleModel.ET5 },
        { modelDefinitionId: "model-et5", vehicleModel: VehicleModel.ES6 }
      )
    ).toBe(true);
    expect(
      vehicleModelReadPathMatches(
        { modelDefinitionId: "model-et5", vehicleModel: VehicleModel.ET5 },
        { modelDefinitionId: null, vehicleModel: VehicleModel.ET5 }
      )
    ).toBe(true);
    expect(
      vehicleModelReadPathMatches(
        { modelDefinitionId: "model-et5", vehicleModel: VehicleModel.ET5 },
        { modelDefinitionId: "model-es6", vehicleModel: VehicleModel.ET5 }
      )
    ).toBe(false);
  });

  it("uses legacy enum matching only when both sides are legacy-only", () => {
    vehicleModelUsageTracker.reset();

    expect(
      vehicleModelReadPathMatches(
        { modelDefinitionId: null, vehicleModel: VehicleModel.ET5 },
        { modelDefinitionId: null, vehicleModel: VehicleModel.ET5 },
        { businessDecision: true, module: "order", operation: "pricing.package.match" }
      )
    ).toBe(true);
    expect(vehicleModelUsageTracker.report()).toMatchObject({
      businessDecisionUsageCount: 1,
      fallbackUsageCount: 1
    });
  });
});

describe("VehicleModelLegacyAdapter", () => {
  it("resolves deprecated legacy input to modelDefinitionId", async () => {
    const prisma = {
      vehicleModelDefinition: {
        findFirst: async ({ where }: { where: { legacyVehicleModel?: VehicleModel } }) =>
          where.legacyVehicleModel === VehicleModel.ET5
            ? {
                deletedAt: null,
                displayName: "NIO ET5",
                enabled: true,
                id: "model-et5",
                legacyVehicleModel: VehicleModel.ET5,
                modelCode: "NIO_ET5"
              }
            : null
      }
    };

    vehicleModelUsageTracker.reset();

    await expect(
      VehicleModelLegacyAdapter.resolveModelDefinitionInput(prisma as never, {
        vehicleModel: VehicleModel.ET5
      }, {
        evidenceContext: {
          businessDecision: true,
          module: "product",
          operation: "quote.priceRule.resolve",
          usageKind: "PRODUCT_PRICE_RULE_INPUT"
        }
      })
    ).resolves.toMatchObject({
      legacyVehicleModel: VehicleModel.ET5,
      modelDefinitionId: "model-et5"
    });
    expect(vehicleModelUsageTracker.report()).toMatchObject({
      businessDecisionUsageCount: 1,
      fallbackUsageCount: 1
    });
  });
});
