import assert from "node:assert/strict";
import test from "node:test";

import {
  assertApplyAllowed,
  buildLowRiskTablePlan,
  hasBlockingIssues,
  parseBackfillMode,
  summarizeBackfill
} from "./model-definition-backfill-core.mjs";

const definitions = [
  { enabled: true, id: "definition-et5", legacyVehicleModel: "ET5" },
  { enabled: true, id: "definition-et7", legacyVehicleModel: "ET7" }
];

test("defaults to dry-run mode", () => {
  assert.equal(parseBackfillMode([]), "dry-run");
});

test("requires MODEL_DEFINITION_BACKFILL_APPLY=1 for apply mode", () => {
  assert.throws(
    () => assertApplyAllowed({ env: {}, mode: "apply" }),
    /Backfill apply requires MODEL_DEFINITION_BACKFILL_APPLY=1/
  );
});

test("requires explicit production override for production apply", () => {
  assert.throws(
    () =>
      assertApplyAllowed({
        env: { MODEL_DEFINITION_BACKFILL_APPLY: "1", NODE_ENV: "production" },
        mode: "apply"
      }),
    /Production backfill requires backup and manual approval/
  );

  assert.doesNotThrow(() =>
    assertApplyAllowed({
      env: {
        ALLOW_PRODUCTION_MODEL_DEFINITION_BACKFILL: "1",
        MODEL_DEFINITION_BACKFILL_APPLY: "1",
        NODE_ENV: "production"
      },
      mode: "apply"
    })
  );
});

test("plans updates only for records missing modelDefinitionId", () => {
  const plan = buildLowRiskTablePlan({
    definitions,
    records: [
      { id: "vehicle-1", modelDefinitionId: null, vehicleModel: "ET5" },
      { id: "vehicle-2", modelDefinitionId: "definition-et7", vehicleModel: "ET7" }
    ],
    tableName: "Vehicle"
  });

  assert.deepEqual(plan.updates, [{ id: "vehicle-1", modelDefinitionId: "definition-et5", vehicleModel: "ET5" }]);
  assert.equal(plan.skippedExisting, 1);
  assert.equal(plan.matched, 1);
  assert.equal(plan.unresolved.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

test("reports unresolved records and duplicate mapping conflicts", () => {
  const plan = buildLowRiskTablePlan({
    definitions: [...definitions, { enabled: true, id: "definition-et5-duplicate", legacyVehicleModel: "ET5" }],
    records: [
      { id: "vehicle-1", modelDefinitionId: null, vehicleModel: "ET5" },
      { id: "vehicle-2", modelDefinitionId: null, vehicleModel: "ES9" }
    ],
    tableName: "Vehicle"
  });

  assert.equal(plan.matched, 0);
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(hasBlockingIssues({ vehicle: plan }), true);
});

test("summarizes blocking issues across backfill tables", () => {
  const cleanPlan = buildLowRiskTablePlan({
    definitions,
    records: [{ id: "vehicle-1", modelDefinitionId: null, vehicleModel: "ET5" }],
    tableName: "Vehicle"
  });
  const blockedPlan = buildLowRiskTablePlan({
    definitions,
    records: [{ id: "rule-1", modelDefinitionId: null, vehicleModel: "ES9" }],
    tableName: "ProductPriceRule"
  });

  const summary = summarizeBackfill({ productPriceRule: blockedPlan, vehicle: cleanPlan });

  assert.deepEqual(summary, {
    conflicts: 0,
    matched: 1,
    skippedExisting: 0,
    total: 2,
    unresolved: 1,
    updated: 0
  });
});
