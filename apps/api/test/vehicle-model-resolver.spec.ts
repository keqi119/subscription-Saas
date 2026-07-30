import { describe, expect, it } from "vitest";

import {
  resolveVehicleModel,
  vehicleModelReadPathMatches,
  VehicleModelLegacyAdapter
} from "../src/common/vehicle-model-resolver";
import { vehicleModelUsageTracker } from "../src/common/vehicle-model-usage-tracker";

const VehicleModel = {
  ES6: "ES6",
  ET5: "ET5"
} as const;

describe("VehicleModelResolver", () => {
  it("derives a new compatibility code from the selected model definition", () => {
    expect(
      resolveVehicleModel({
        modelDefinition: {
          displayName: "Model X 2027",
          id: "model-x-2027",
          modelCode: "MODEL_X_2027"
        },
        modelDefinitionId: "model-x-2027"
      })
    ).toEqual({
      legacyVehicleModel: "MODEL_X_2027",
      legacyVehicleModelCode: "MODEL_X_2027",
      modelDefinitionId: "model-x-2027",
      modelDisplayName: "Model X 2027",
      source: "MODEL_DEFINITION"
    });
  });

  it("uses modelDefinitionId as the primary model identity", () => {
    expect(
      resolveVehicleModel({
        modelDefinition: {
          displayName: "NIO ET5 Touring",
          id: "model-et5t",
          modelCode: "NIO_ET5T"
        },
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

  it("matches canonical and legacy codes from the same model definition", () => {
    expect(
      vehicleModelReadPathMatches(
        {
          modelDefinition: {
            displayName: "NIO ET5",
            id: "model-et5",
            legacyVehicleModel: "ET5",
            modelCode: "NIO_ET5"
          },
          vehicleModel: "ET5"
        },
        { vehicleModel: "NIO_ET5" }
      )
    ).toBe(true);
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
  it("uses modelCode for new writes resolved by modelDefinitionId", async () => {
    const prisma = {
      vehicleModelDefinition: {
        findFirst: async ({ where }: { where: { id?: string } }) =>
          where.id === "model-x-2027"
            ? {
                deletedAt: null,
                displayName: "Model X 2027",
                enabled: true,
                id: "model-x-2027",
                legacyVehicleModel: null,
                modelCode: "MODEL_X_2027"
              }
            : null
      }
    };

    await expect(
      VehicleModelLegacyAdapter.resolveModelDefinitionInput(prisma as never, {
        modelDefinitionId: "model-x-2027"
      })
    ).resolves.toMatchObject({
      legacyVehicleModel: "MODEL_X_2027",
      legacyVehicleModelCode: "MODEL_X_2027",
      modelDefinitionId: "model-x-2027"
    });
  });

  it("resolves a new compatibility code through an exact modelCode lookup", async () => {
    const calls: unknown[] = [];
    const prisma = {
      vehicleModelDefinition: {
        findFirst: async ({ where }: { where: { modelCode?: string; legacyVehicleModel?: string } }) => {
          calls.push(where);
          return where.modelCode === "MODEL_X_2027"
            ? {
                deletedAt: null,
                displayName: "Model X 2027",
                enabled: true,
                id: "model-x-2027",
                legacyVehicleModel: null,
                modelCode: "MODEL_X_2027"
              }
            : null;
        }
      }
    };

    await expect(
      VehicleModelLegacyAdapter.resolveModelDefinitionInput(prisma as never, {
        vehicleModel: "MODEL_X_2027"
      })
    ).resolves.toMatchObject({
      legacyVehicleModel: "MODEL_X_2027",
      modelDefinitionId: "model-x-2027"
    });
    expect(calls).toEqual([{ deletedAt: null, modelCode: "MODEL_X_2027" }]);
  });

  it("falls back to legacy lookup only after exact modelCode lookup misses", async () => {
    const calls: unknown[] = [];
    const prisma = {
      vehicleModelDefinition: {
        findFirst: async ({ where }: { where: { modelCode?: string; legacyVehicleModel?: string } }) => {
          calls.push(where);
          return where.legacyVehicleModel === VehicleModel.ET5
            ? {
                deletedAt: null,
                displayName: "NIO ET5",
                enabled: true,
                id: "model-et5",
                legacyVehicleModel: VehicleModel.ET5,
                modelCode: "NIO_ET5"
              }
            : null;
        }
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
      legacyVehicleModel: "NIO_ET5",
      legacyVehicleModelCode: "NIO_ET5",
      modelDefinitionId: "model-et5"
    });
    expect(calls).toEqual([
      { deletedAt: null, modelCode: VehicleModel.ET5 },
      { deletedAt: null, legacyVehicleModel: VehicleModel.ET5 }
    ]);
    expect(vehicleModelUsageTracker.report()).toMatchObject({
      businessDecisionUsageCount: 1,
      fallbackUsageCount: 1
    });
  });
});
