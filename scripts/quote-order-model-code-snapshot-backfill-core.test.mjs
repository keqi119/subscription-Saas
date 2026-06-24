import assert from "node:assert/strict";
import test from "node:test";

import {
  assertApplyAllowed,
  buildOrderModelCodeSnapshotPlan,
  buildQuoteModelCodeSnapshotPlan,
  hasBlockingIssues,
  markPlanUpdated,
  parseBackfillMode,
  summarizeBackfill
} from "./quote-order-model-code-snapshot-backfill-core.mjs";

test("defaults to dry-run mode", () => {
  assert.equal(parseBackfillMode([]), "dry-run");
});

test("requires QUOTE_ORDER_MODEL_CODE_SNAPSHOT_BACKFILL_APPLY=1 for apply mode", () => {
  assert.throws(
    () => assertApplyAllowed({ env: {}, mode: "apply" }),
    /Quote\/Order model code snapshot backfill apply requires QUOTE_ORDER_MODEL_CODE_SNAPSHOT_BACKFILL_APPLY=1/
  );
});

test("requires explicit production override for production apply", () => {
  assert.throws(
    () =>
      assertApplyAllowed({
        env: { NODE_ENV: "production", QUOTE_ORDER_MODEL_CODE_SNAPSHOT_BACKFILL_APPLY: "1" },
        mode: "apply"
      }),
    /Production model code snapshot backfill requires backup and manual approval/
  );

  assert.doesNotThrow(() =>
    assertApplyAllowed({
      env: {
        ALLOW_PRODUCTION_QUOTE_ORDER_MODEL_CODE_SNAPSHOT_BACKFILL: "1",
        NODE_ENV: "production",
        QUOTE_ORDER_MODEL_CODE_SNAPSHOT_BACKFILL_APPLY: "1"
      },
      mode: "apply"
    })
  );
});

test("quote code snapshot uses legacyVehicleModelSnapshot before vehicleModel", () => {
  const plan = buildQuoteModelCodeSnapshotPlan({
    quotes: [quote({ id: "quote-1", legacyVehicleModelSnapshot: "ET5", vehicleModel: "ES6" })]
  });

  assert.deepEqual(plan.updates, [
    {
      id: "quote-1",
      legacyVehicleModelCodeSnapshot: "ET5",
      source: "legacyVehicleModelSnapshot"
    }
  ]);
  assert.equal(plan.matched, 1);
  assert.equal(plan.unresolved.length, 0);
});

test("quote code snapshot falls back to vehicleModel", () => {
  const plan = buildQuoteModelCodeSnapshotPlan({
    quotes: [quote({ id: "quote-1", vehicleModel: "ES6" })]
  });

  assert.deepEqual(plan.updates, [
    {
      id: "quote-1",
      legacyVehicleModelCodeSnapshot: "ES6",
      source: "vehicleModel"
    }
  ]);
});

test("quote is skipped when code snapshot already exists", () => {
  const plan = buildQuoteModelCodeSnapshotPlan({
    quotes: [quote({ id: "quote-1", legacyVehicleModelCodeSnapshot: "ET5", vehicleModel: "ES6" })]
  });

  assert.equal(plan.skippedExisting, 1);
  assert.equal(plan.matched, 0);
  assert.deepEqual(plan.updates, []);
});

test("order code snapshot uses order legacyVehicleModelSnapshot before order vehicleModel", () => {
  const quotePlan = buildQuoteModelCodeSnapshotPlan({ quotes: [] });
  const plan = buildOrderModelCodeSnapshotPlan({
    orders: [order({ id: "order-1", legacyVehicleModelSnapshot: "ET5", vehicleModel: "ES6" })],
    quotePlan
  });

  assert.deepEqual(plan.updates, [
    {
      id: "order-1",
      legacyVehicleModelCodeSnapshot: "ET5",
      quoteId: null,
      source: "legacyVehicleModelSnapshot"
    }
  ]);
});

test("order code snapshot falls back to order vehicleModel", () => {
  const quotePlan = buildQuoteModelCodeSnapshotPlan({ quotes: [] });
  const plan = buildOrderModelCodeSnapshotPlan({
    orders: [order({ id: "order-1", vehicleModel: "ES6" })],
    quotePlan
  });

  assert.deepEqual(plan.updates, [
    {
      id: "order-1",
      legacyVehicleModelCodeSnapshot: "ES6",
      quoteId: null,
      source: "vehicleModel"
    }
  ]);
});

test("order code snapshot falls back to related quote code snapshot", () => {
  const relatedQuote = quote({
    id: "quote-1",
    legacyVehicleModelCodeSnapshot: "ET5T",
    legacyVehicleModelSnapshot: "ET5",
    vehicleModel: "ES6"
  });
  const quotePlan = buildQuoteModelCodeSnapshotPlan({ quotes: [relatedQuote] });
  const plan = buildOrderModelCodeSnapshotPlan({
    orders: [order({ id: "order-1", quote: relatedQuote, quoteId: relatedQuote.id })],
    quotePlan
  });

  assert.deepEqual(plan.updates, [
    {
      id: "order-1",
      legacyVehicleModelCodeSnapshot: "ET5T",
      quoteId: "quote-1",
      source: "quoteLegacyVehicleModelCodeSnapshot"
    }
  ]);
});

test("order code snapshot can use a quote code planned in the same dry-run", () => {
  const relatedQuote = quote({ id: "quote-1", legacyVehicleModelSnapshot: "ET5" });
  const quotePlan = buildQuoteModelCodeSnapshotPlan({ quotes: [relatedQuote] });
  const plan = buildOrderModelCodeSnapshotPlan({
    orders: [order({ id: "order-1", quote: relatedQuote, quoteId: relatedQuote.id })],
    quotePlan
  });

  assert.deepEqual(plan.updates, [
    {
      id: "order-1",
      legacyVehicleModelCodeSnapshot: "ET5",
      quoteId: "quote-1",
      source: "plannedQuoteModelCodeSnapshot"
    }
  ]);
});

test("records are unresolved when no code source exists", () => {
  const quotePlan = buildQuoteModelCodeSnapshotPlan({ quotes: [quote({ id: "quote-1" })] });
  const orderPlan = buildOrderModelCodeSnapshotPlan({
    orders: [order({ id: "order-1", quote: null, quoteId: null })],
    quotePlan
  });

  assert.equal(hasBlockingIssues({ order: orderPlan, quote: quotePlan }), true);
  assert.deepEqual(quotePlan.unresolved, [
    {
      id: "quote-1",
      reason: "missing legacy model code source",
      tableName: "SubscriptionQuote"
    }
  ]);
  assert.deepEqual(orderPlan.unresolved, [
    {
      id: "order-1",
      reason: "missing legacy model code source",
      tableName: "SubscriptionOrder"
    }
  ]);
});

test("summarizes updated counts and idempotent skipped rows", () => {
  const quotePlan = markPlanUpdated(
    buildQuoteModelCodeSnapshotPlan({
      quotes: [
        quote({ id: "quote-1", legacyVehicleModelSnapshot: "ET5" }),
        quote({ id: "quote-2", legacyVehicleModelCodeSnapshot: "ES6", vehicleModel: "ES6" })
      ]
    }),
    1
  );
  const orderPlan = markPlanUpdated(
    buildOrderModelCodeSnapshotPlan({
      orders: [order({ id: "order-1", legacyVehicleModelCodeSnapshot: "ET5" })],
      quotePlan
    }),
    0
  );

  assert.deepEqual(summarizeBackfill({ order: orderPlan, quote: quotePlan }), {
    conflicts: 0,
    matched: 1,
    skippedExisting: 2,
    total: 3,
    unresolved: 0,
    updated: 1
  });
});

function quote(overrides = {}) {
  return {
    id: "quote",
    legacyVehicleModelCodeSnapshot: null,
    legacyVehicleModelSnapshot: null,
    vehicleModel: null,
    ...overrides
  };
}

function order(overrides = {}) {
  return {
    id: "order",
    legacyVehicleModelCodeSnapshot: null,
    legacyVehicleModelSnapshot: null,
    quote: null,
    quoteId: null,
    vehicleModel: null,
    ...overrides
  };
}
