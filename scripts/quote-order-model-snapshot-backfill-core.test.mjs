import assert from "node:assert/strict";
import test from "node:test";

import {
  assertApplyAllowed,
  buildOrderSnapshotPlan,
  buildQuoteSnapshotPlan,
  hasBlockingIssues,
  parseBackfillMode,
  summarizeBackfill
} from "./quote-order-model-snapshot-backfill-core.mjs";

const definitions = [
  { deletedAt: null, displayName: "NIO ET5", enabled: true, id: "definition-et5", legacyVehicleModel: "ET5" },
  { deletedAt: null, displayName: "NIO ES6 Disabled", enabled: false, id: "definition-es6", legacyVehicleModel: "ES6" }
];

test("defaults to dry-run mode", () => {
  assert.equal(parseBackfillMode([]), "dry-run");
});

test("requires QUOTE_ORDER_SNAPSHOT_BACKFILL_APPLY=1 for apply mode", () => {
  assert.throws(
    () => assertApplyAllowed({ env: {}, mode: "apply" }),
    /Quote\/Order snapshot backfill apply requires QUOTE_ORDER_SNAPSHOT_BACKFILL_APPLY=1/
  );
});

test("requires explicit production override for production apply", () => {
  assert.throws(
    () =>
      assertApplyAllowed({
        env: { NODE_ENV: "production", QUOTE_ORDER_SNAPSHOT_BACKFILL_APPLY: "1" },
        mode: "apply"
      }),
    /Production snapshot backfill requires backup and manual approval/
  );

  assert.doesNotThrow(() =>
    assertApplyAllowed({
      env: {
        ALLOW_PRODUCTION_QUOTE_ORDER_SNAPSHOT_BACKFILL: "1",
        NODE_ENV: "production",
        QUOTE_ORDER_SNAPSHOT_BACKFILL_APPLY: "1"
      },
      mode: "apply"
    })
  );
});

test("quote legacy vehicleModel maps to a model definition, including disabled history definitions", () => {
  const plan = buildQuoteSnapshotPlan({
    definitions,
    quotes: [
      emptyQuote({ id: "quote-1", vehicleModel: "ET5" }),
      emptyQuote({ id: "quote-2", vehicleModel: "ES6" })
    ]
  });

  assert.deepEqual(plan.updates, [
    {
      id: "quote-1",
      legacyVehicleModelSnapshot: "ET5",
      modelDefinitionIdSnapshot: "definition-et5",
      modelDisplayNameSnapshot: "NIO ET5",
      source: "vehicleModel",
      vehicleModel: "ET5"
    },
    {
      id: "quote-2",
      legacyVehicleModelSnapshot: "ES6",
      modelDefinitionIdSnapshot: "definition-es6",
      modelDisplayNameSnapshot: "NIO ES6 Disabled",
      source: "vehicleModel",
      vehicleModel: "ES6"
    }
  ]);
  assert.equal(plan.matched, 2);
  assert.equal(plan.unresolved.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

test("quote is unresolved when no legacy mapping exists", () => {
  const plan = buildQuoteSnapshotPlan({
    definitions,
    quotes: [emptyQuote({ id: "quote-1", vehicleModel: "ES9" })]
  });

  assert.equal(plan.matched, 0);
  assert.deepEqual(plan.unresolved, [
    {
      id: "quote-1",
      reason: "no matching VehicleModelDefinition",
      tableName: "SubscriptionQuote",
      vehicleModel: "ES9"
    }
  ]);
});

test("quote reports conflicts when legacy mapping is duplicated", () => {
  const plan = buildQuoteSnapshotPlan({
    definitions: [...definitions, { deletedAt: null, displayName: "NIO ET5 Copy", id: "definition-et5-copy", legacyVehicleModel: "ET5" }],
    quotes: [emptyQuote({ id: "quote-1", vehicleModel: "ET5" })]
  });

  assert.equal(plan.matched, 0);
  assert.deepEqual(plan.conflicts, [
    {
      definitionIds: ["definition-et5", "definition-et5-copy"],
      id: "quote-1",
      reason: "multiple matching VehicleModelDefinition records",
      tableName: "SubscriptionQuote",
      vehicleModel: "ET5"
    }
  ]);
});

test("quote snapshot backfill resolves a canonical string code without a legacy alias", () => {
  const plan = buildQuoteSnapshotPlan({
    definitions: [
      {
        deletedAt: null,
        displayName: "Model X 2027",
        enabled: true,
        id: "definition-model-x-2027",
        legacyVehicleModel: null,
        modelCode: "MODEL_X_2027"
      }
    ],
    quotes: [emptyQuote({ id: "quote-model-x", vehicleModel: "MODEL_X_2027" })]
  });

  assert.deepEqual(plan.updates, [
    {
      id: "quote-model-x",
      legacyVehicleModelSnapshot: "MODEL_X_2027",
      modelDefinitionIdSnapshot: "definition-model-x-2027",
      modelDisplayNameSnapshot: "Model X 2027",
      source: "vehicleModel",
      vehicleModel: "MODEL_X_2027"
    }
  ]);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.unresolved, []);
});

test("quote is skipped when any snapshot field already exists", () => {
  const plan = buildQuoteSnapshotPlan({
    definitions,
    quotes: [emptyQuote({ id: "quote-1", modelDisplayNameSnapshot: "Existing ET5", vehicleModel: "ET5" })]
  });

  assert.equal(plan.skippedExisting, 1);
  assert.equal(plan.matched, 0);
  assert.deepEqual(plan.updates, []);
});

test("order copies an existing quote snapshot", () => {
  const quote = emptyQuote({
    id: "quote-1",
    legacyVehicleModelSnapshot: "ET5",
    modelDefinitionIdSnapshot: "definition-et5",
    modelDisplayNameSnapshot: "Frozen ET5",
    vehicleModel: "ET5"
  });
  const quotePlan = buildQuoteSnapshotPlan({ definitions, quotes: [quote] });
  const orderPlan = buildOrderSnapshotPlan({
    definitions,
    orders: [emptyOrder({ id: "order-1", quote, quoteId: quote.id, vehicleModel: "ES6" })],
    quotePlan
  });

  assert.deepEqual(orderPlan.updates, [
    {
      id: "order-1",
      legacyVehicleModelSnapshot: "ET5",
      modelDefinitionIdSnapshot: "definition-et5",
      modelDisplayNameSnapshot: "Frozen ET5",
      quoteId: "quote-1",
      source: "quoteSnapshot",
      vehicleModel: "ES6"
    }
  ]);
});

test("order uses a computed quote snapshot from the same dry-run", () => {
  const quote = emptyQuote({ id: "quote-1", vehicleModel: "ET5" });
  const quotePlan = buildQuoteSnapshotPlan({ definitions, quotes: [quote] });
  const orderPlan = buildOrderSnapshotPlan({
    definitions,
    orders: [emptyOrder({ id: "order-1", quote, quoteId: quote.id, vehicleModel: "ES6" })],
    quotePlan
  });

  assert.deepEqual(orderPlan.updates, [
    {
      id: "order-1",
      legacyVehicleModelSnapshot: "ET5",
      modelDefinitionIdSnapshot: "definition-et5",
      modelDisplayNameSnapshot: "NIO ET5",
      quoteId: "quote-1",
      source: "plannedQuoteSnapshot",
      vehicleModel: "ES6"
    }
  ]);
});

test("order falls back to legacy vehicleModel when no quote snapshot is available", () => {
  const quotePlan = buildQuoteSnapshotPlan({ definitions, quotes: [] });
  const orderPlan = buildOrderSnapshotPlan({
    definitions,
    orders: [emptyOrder({ id: "order-1", quote: null, quoteId: null, vehicleModel: "ET5" })],
    quotePlan
  });

  assert.deepEqual(orderPlan.updates, [
    {
      id: "order-1",
      legacyVehicleModelSnapshot: "ET5",
      modelDefinitionIdSnapshot: "definition-et5",
      modelDisplayNameSnapshot: "NIO ET5",
      quoteId: null,
      source: "vehicleModel",
      vehicleModel: "ET5"
    }
  ]);
});

test("order is unresolved when quote snapshot and legacy mapping are unavailable", () => {
  const quotePlan = buildQuoteSnapshotPlan({ definitions, quotes: [] });
  const orderPlan = buildOrderSnapshotPlan({
    definitions,
    orders: [emptyOrder({ id: "order-1", quote: null, quoteId: null, vehicleModel: "ES9" })],
    quotePlan
  });

  assert.equal(orderPlan.matched, 0);
  assert.deepEqual(orderPlan.unresolved, [
    {
      id: "order-1",
      reason: "no quote snapshot and no matching VehicleModelDefinition",
      tableName: "SubscriptionOrder",
      vehicleModel: "ES9"
    }
  ]);
});

test("summarizes quote and order plans with blocking issue counts", () => {
  const quotePlan = buildQuoteSnapshotPlan({
    definitions,
    quotes: [emptyQuote({ id: "quote-1", vehicleModel: "ET5" })]
  });
  const orderPlan = buildOrderSnapshotPlan({
    definitions,
    orders: [emptyOrder({ id: "order-1", quote: null, quoteId: null, vehicleModel: "ES9" })],
    quotePlan
  });

  assert.equal(hasBlockingIssues({ order: orderPlan, quote: quotePlan }), true);
  assert.deepEqual(summarizeBackfill({ order: orderPlan, quote: quotePlan }), {
    conflicts: 0,
    matched: 1,
    skippedExisting: 0,
    total: 2,
    unresolved: 1,
    updated: 0
  });
});

function emptyQuote(overrides = {}) {
  return {
    id: "quote",
    legacyVehicleModelSnapshot: null,
    modelDefinitionIdSnapshot: null,
    modelDisplayNameSnapshot: null,
    vehicleModel: null,
    ...overrides
  };
}

function emptyOrder(overrides = {}) {
  return {
    id: "order",
    legacyVehicleModelSnapshot: null,
    modelDefinitionIdSnapshot: null,
    modelDisplayNameSnapshot: null,
    quote: null,
    quoteId: null,
    vehicleModel: null,
    ...overrides
  };
}
