import assert from "node:assert/strict";
import { test } from "node:test";

import { buildProductPriceRuleConstraintDecommissionReport } from "./product-price-rule-constraint-decommission-core.mjs";

const cleanReadiness = {
  ready: true,
  summary: {
    duplicateModelDefinitionScopes: 0,
    legacyMappingMismatches: 0,
    missingModelDefinitionId: 0,
    totalRules: 2
  }
};

test("reports ready when schema and database decommission the legacy vehicleModel unique constraint", () => {
  const report = buildProductPriceRuleConstraintDecommissionReport({
    dbIndexes: [
      { indexName: "product_price_rule_product_version_model_definition_key", indexDefinition: "CREATE UNIQUE INDEX product_price_rule_product_version_model_definition_key ON product_price_rule(product_version_id, model_definition_id)" },
      { indexName: "product_price_rule_vehicle_model_idx", indexDefinition: "CREATE INDEX product_price_rule_vehicle_model_idx ON product_price_rule(vehicle_model)" }
    ],
    readinessReport: cleanReadiness,
    schemaText: `
      model ProductPriceRule {
        productVersionId String @map("product_version_id")
        modelDefinitionId String? @map("model_definition_id")
        vehicleModel VehicleModel @map("vehicle_model")
        @@unique([productVersionId, modelDefinitionId], map: "product_price_rule_product_version_model_definition_key")
        @@index([vehicleModel])
      }
    `
  });

  assert.equal(report.ready, true);
  assert.deepEqual(report.blockers, []);
});

test("blocks when the Prisma schema still declares the legacy unique constraint", () => {
  const report = buildProductPriceRuleConstraintDecommissionReport({
    dbIndexes: [
      { indexName: "product_price_rule_product_version_model_definition_key", indexDefinition: "CREATE UNIQUE INDEX product_price_rule_product_version_model_definition_key ON product_price_rule(product_version_id, model_definition_id)" }
    ],
    readinessReport: cleanReadiness,
    schemaText: `
      model ProductPriceRule {
        productVersionId String @map("product_version_id")
        modelDefinitionId String? @map("model_definition_id")
        vehicleModel VehicleModel @map("vehicle_model")
        @@unique([productVersionId, vehicleModel])
        @@unique([productVersionId, modelDefinitionId], map: "product_price_rule_product_version_model_definition_key")
      }
    `
  });

  assert.equal(report.ready, false);
  assert.equal(report.blockers.some((blocker) => blocker.code === "LEGACY_SCHEMA_UNIQUE_PRESENT"), true);
});

test("blocks when the database legacy unique index is still present", () => {
  const report = buildProductPriceRuleConstraintDecommissionReport({
    dbIndexes: [
      { indexName: "product_price_rule_product_version_id_vehicle_model_key", indexDefinition: "CREATE UNIQUE INDEX product_price_rule_product_version_id_vehicle_model_key ON product_price_rule(product_version_id, vehicle_model)" },
      { indexName: "product_price_rule_product_version_model_definition_key", indexDefinition: "CREATE UNIQUE INDEX product_price_rule_product_version_model_definition_key ON product_price_rule(product_version_id, model_definition_id)" }
    ],
    readinessReport: cleanReadiness,
    schemaText: `
      model ProductPriceRule {
        productVersionId String @map("product_version_id")
        modelDefinitionId String? @map("model_definition_id")
        vehicleModel VehicleModel @map("vehicle_model")
        @@unique([productVersionId, modelDefinitionId], map: "product_price_rule_product_version_model_definition_key")
      }
    `
  });

  assert.equal(report.ready, false);
  assert.equal(report.blockers.some((blocker) => blocker.code === "LEGACY_DATABASE_UNIQUE_PRESENT"), true);
});

test("blocks when data readiness is not clean", () => {
  const report = buildProductPriceRuleConstraintDecommissionReport({
    dbIndexes: [
      { indexName: "product_price_rule_product_version_model_definition_key", indexDefinition: "CREATE UNIQUE INDEX product_price_rule_product_version_model_definition_key ON product_price_rule(product_version_id, model_definition_id)" }
    ],
    readinessReport: {
      ready: false,
      summary: {
        duplicateModelDefinitionScopes: 1,
        legacyMappingMismatches: 0,
        missingModelDefinitionId: 0,
        totalRules: 2
      }
    },
    schemaText: `
      model ProductPriceRule {
        productVersionId String @map("product_version_id")
        modelDefinitionId String? @map("model_definition_id")
        @@unique([productVersionId, modelDefinitionId], map: "product_price_rule_product_version_model_definition_key")
      }
    `
  });

  assert.equal(report.ready, false);
  assert.equal(report.blockers.some((blocker) => blocker.code === "DATA_READINESS_FAILED"), true);
});

test("blocks when legacy vehicleModel scopes would prevent rollback constraint restore", () => {
  const report = buildProductPriceRuleConstraintDecommissionReport({
    dbIndexes: [
      { indexName: "product_price_rule_product_version_model_definition_key", indexDefinition: "CREATE UNIQUE INDEX product_price_rule_product_version_model_definition_key ON product_price_rule(product_version_id, model_definition_id)" }
    ],
    legacyRollbackReport: {
      duplicateLegacyScopes: [
        {
          productVersionId: "version-1",
          ruleIds: ["rule-1", "rule-2"],
          vehicleModel: "ET5"
        }
      ],
      summary: {
        duplicateLegacyScopes: 1
      }
    },
    readinessReport: cleanReadiness,
    schemaText: `
      model ProductPriceRule {
        productVersionId String @map("product_version_id")
        modelDefinitionId String? @map("model_definition_id")
        vehicleModel VehicleModel @map("vehicle_model")
        @@unique([productVersionId, modelDefinitionId], map: "product_price_rule_product_version_model_definition_key")
      }
    `
  });

  assert.equal(report.ready, false);
  assert.equal(report.blockers.some((blocker) => blocker.code === "LEGACY_ROLLBACK_SCOPE_DUPLICATES"), true);
});
