import { expect, test } from "vitest";

import {
  convergeVehicleModelDefinition,
  upsertCanonicalProductPriceRule
} from "./seed-vehicle-model.mjs";

test("updates an existing canonical model definition by modelCode", async () => {
  const mock = createStatefulPrismaMock({
    definitions: [
      {
        displayName: "Old ET5",
        id: "definition-et5",
        modelCode: "NIO_ET5"
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
      modelCode: "NIO_ET5"
    }
  ]);
});

test("creates one canonical definition and remains idempotent", async () => {
  const mock = createStatefulPrismaMock();

  await convergeVehicleModelDefinition(mock.prisma, definitionSeedInput());
  await convergeVehicleModelDefinition(mock.prisma, definitionSeedInput());

  expect(mock.calls.vehicleModelDefinition.create).toBe(1);
  expect(mock.calls.vehicleModelDefinition.update).toBe(1);
  expect(mock.state.definitions).toHaveLength(1);
  expect(mock.state.definitions[0].modelCode).toBe("NIO_ET5");
});

test("upserts a price rule by product version and model definition", async () => {
  const mock = createStatefulPrismaMock({
    priceRules: [
      {
        id: "price-rule-et5",
        modelDefinitionId: "definition-et5",
        monthlyFeeRate: "0.035000",
        productVersionId: "product-version-1"
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
    }
  });

  expect(mock.calls.productPriceRule.create).toBe(0);
  expect(mock.calls.productPriceRule.update).toBe(1);
  expect(mock.state.priceRules[0].modelDefinitionId).toBe("definition-et5");
  expect(mock.state.priceRules[0].monthlyFeeRate).toBe("0.040000");
});

function definitionSeedInput() {
  return {
    createData: {
      brand: "NIO",
      displayName: "ET5",
      enabled: true
    },
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
      async upsert({ create, update, where }) {
        const existing = state.definitions.find(
          (row) => row.modelCode === where.modelCode
        );

        if (existing) {
          calls.vehicleModelDefinition.update += 1;
          Object.assign(existing, update);
          return structuredClone(existing);
        }

        calls.vehicleModelDefinition.create += 1;
        const created = {
          id: `definition-${state.definitions.length + 1}`,
          ...create
        };
        state.definitions.push(created);
        return structuredClone(created);
      }
    }
  };

  return { calls, prisma, state };
}
