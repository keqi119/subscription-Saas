import assert from "node:assert/strict";
import { test } from "node:test";

import { buildProductPriceRuleConstraintReadinessReport } from "./product-price-rule-constraint-readiness-core.mjs";

test("reports ready when product price rules have unique modelDefinitionId scopes", () => {
  const report = buildProductPriceRuleConstraintReadinessReport({
    rules: [
      {
        id: "rule-et5",
        modelDefinition: { id: "model-et5", legacyVehicleModel: "ET5" },
        modelDefinitionId: "model-et5",
        productVersionId: "version-1",
        vehicleModel: "ET5"
      },
      {
        id: "rule-es6",
        modelDefinition: { id: "model-es6", legacyVehicleModel: "ES6" },
        modelDefinitionId: "model-es6",
        productVersionId: "version-1",
        vehicleModel: "ES6"
      }
    ]
  });

  assert.equal(report.ready, true);
  assert.deepEqual(report.summary, {
    duplicateModelDefinitionScopes: 0,
    legacyMappingMismatches: 0,
    missingModelDefinitionId: 0,
    totalRules: 2
  });
});

test("blocks migration when modelDefinitionId is missing", () => {
  const report = buildProductPriceRuleConstraintReadinessReport({
    rules: [
      {
        id: "legacy-rule",
        modelDefinition: null,
        modelDefinitionId: null,
        productVersionId: "version-1",
        vehicleModel: "ET5"
      }
    ]
  });

  assert.equal(report.ready, false);
  assert.deepEqual(report.missingModelDefinitionId.map((item) => item.id), ["legacy-rule"]);
});

test("blocks migration when productVersionId and modelDefinitionId would duplicate", () => {
  const report = buildProductPriceRuleConstraintReadinessReport({
    rules: [
      {
        id: "rule-1",
        modelDefinition: { id: "model-et5", legacyVehicleModel: "ET5" },
        modelDefinitionId: "model-et5",
        productVersionId: "version-1",
        vehicleModel: "ET5"
      },
      {
        id: "rule-2",
        modelDefinition: { id: "model-et5", legacyVehicleModel: "ET5" },
        modelDefinitionId: "model-et5",
        productVersionId: "version-1",
        vehicleModel: "ET5"
      }
    ]
  });

  assert.equal(report.ready, false);
  assert.equal(report.duplicateModelDefinitionScopes.length, 1);
  assert.deepEqual(report.duplicateModelDefinitionScopes[0].ruleIds, ["rule-1", "rule-2"]);
});

test("blocks migration when legacy vehicleModel disagrees with modelDefinition mapping", () => {
  const report = buildProductPriceRuleConstraintReadinessReport({
    rules: [
      {
        id: "mismatched-rule",
        modelDefinition: { id: "model-et5", legacyVehicleModel: "ET5" },
        modelDefinitionId: "model-et5",
        productVersionId: "version-1",
        vehicleModel: "ES6"
      }
    ]
  });

  assert.equal(report.ready, false);
  assert.deepEqual(report.legacyMappingMismatches.map((item) => item.id), ["mismatched-rule"]);
});
