import { expect, test } from "vitest";

import {
  convergeVehicleModelDefinition,
  upsertCanonicalProductPriceRule
} from "./seed-vehicle-model.mjs";

test("converges a prior ET5 definition to NIO_ET5 without attempting a duplicate insert", async () => {
  const mock = createStatefulPrismaMock({
    definitions: [
      {
        id: "definition-et5",
        legacyVehicleModel: "ET5",
        modelCode: "ET5"
      }
    ]
  });

  await convergeVehicleModelDefinition(mock.prisma, definitionSeedInput());

  expect(mock.calls.vehicleModelDefinition.create).toBe(0);
  expect(mock.calls.vehicleModelDefinition.update).toBe(1);
  expect(mock.state.definitions).toEqual([
    {
      brand: "NIO",
      deletedAt: null,
      displayName: "ET5",
      enabled: true,
      id: "definition-et5",
      legacyVehicleModel: "ET5",
      modelCode: "NIO_ET5"
    }
  ]);
});

test("creates a canonical NIO_ET5 definition when no matching definition exists", async () => {
  const mock = createStatefulPrismaMock();

  await convergeVehicleModelDefinition(mock.prisma, definitionSeedInput());
  await convergeVehicleModelDefinition(mock.prisma, definitionSeedInput());

  expect(mock.calls.vehicleModelDefinition.create).toBe(1);
  expect(mock.calls.vehicleModelDefinition.update).toBe(1);
  expect(mock.state.definitions).toHaveLength(1);
  expect(mock.state.definitions[0].modelCode).toBe("NIO_ET5");
  expect(mock.state.definitions[0].legacyVehicleModel).toBe("ET5");
});

test("updates an existing ProductPriceRule compatibility code to NIO_ET5", async () => {
  const mock = createStatefulPrismaMock({
    priceRules: [
      {
        id: "price-rule-et5",
        modelDefinitionId: "definition-et5",
        productVersionId: "product-version-1",
        vehicleModel: "ET5"
      }
    ]
  });

  await upsertCanonicalProductPriceRule(mock.prisma, {
    createData: {
      id: "unused-create-id",
      monthlyFeeRate: "0.035000"
    },
    modelDefinitionId: "definition-et5",
    productVersionId: "product-version-1",
    updateData: {
      monthlyFeeRate: "0.040000"
    },
    vehicleModel: "NIO_ET5"
  });

  expect(mock.calls.productPriceRule.create).toBe(0);
  expect(mock.calls.productPriceRule.update).toBe(1);
  expect(mock.state.priceRules[0].vehicleModel).toBe("NIO_ET5");
  expect(mock.state.priceRules[0].monthlyFeeRate).toBe("0.040000");
});

function definitionSeedInput() {
  return {
    createData: {
      brand: "NIO",
      displayName: "ET5",
      enabled: true
    },
    legacyVehicleModel: "ET5",
    modelCode: "NIO_ET5",
    updateData: {
      brand: "NIO",
      displayName: "ET5",
      enabled: true
    }
  };
}

function createStatefulPrismaMock({ definitions = [], priceRules = [] } = {}) {
  const state = {
    definitions: structuredClone(definitions),
    priceRules: structuredClone(priceRules)
  };
  const calls = {
    productPriceRule: { create: 0, update: 0 },
    vehicleModelDefinition: { create: 0, update: 0 }
  };

  const prisma = {
    productPriceRule: {
      async upsert({ create, update, where }) {
        const key = where.productVersionId_modelDefinitionId;
        const existing = state.priceRules.find(
          (row) =>
            row.productVersionId === key.productVersionId &&
            row.modelDefinitionId === key.modelDefinitionId
        );

        if (existing) {
          calls.productPriceRule.update += 1;
          Object.assign(existing, update);
          return structuredClone(existing);
        }

        calls.productPriceRule.create += 1;
        const created = { id: `price-rule-${state.priceRules.length + 1}`, ...create };
        state.priceRules.push(created);
        return structuredClone(created);
      }
    },
    vehicleModelDefinition: {
      async create({ data }) {
        calls.vehicleModelDefinition.create += 1;
        if (
          state.definitions.some(
            (row) =>
              row.modelCode === data.modelCode ||
              (data.legacyVehicleModel && row.legacyVehicleModel === data.legacyVehicleModel)
          )
        ) {
          throw new Error("duplicate vehicle model definition");
        }
        const created = { id: `definition-${state.definitions.length + 1}`, ...data };
        state.definitions.push(created);
        return structuredClone(created);
      },
      async findMany({ where }) {
        const aliases = where.OR;
        return state.definitions
          .filter((row) =>
            aliases.some((alias) =>
              alias.modelCode
                ? row.modelCode === alias.modelCode
                : row.legacyVehicleModel === alias.legacyVehicleModel
            )
          )
          .map((row) => structuredClone(row));
      },
      async update({ data, where }) {
        calls.vehicleModelDefinition.update += 1;
        const existing = state.definitions.find((row) => row.id === where.id);
        if (!existing) {
          throw new Error(`missing definition ${where.id}`);
        }
        Object.assign(existing, data);
        return structuredClone(existing);
      }
    }
  };

  return { calls, prisma, state };
}
