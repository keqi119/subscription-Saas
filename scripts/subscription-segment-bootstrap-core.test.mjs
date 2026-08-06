import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSubscriptionSegmentBootstrapPlan,
  parseSubscriptionSegmentBootstrapMode
} from "./subscription-segment-bootstrap-core.mjs";

test("plans one clean ACTIVE order and reports incomplete source facts", () => {
  const plan = buildSubscriptionSegmentBootstrapPlan([
    orderRecord(),
    orderRecord({
      contract: null,
      endDate: null,
      finalPlanSnapshot: null,
      id: "order-incomplete",
      orderNo: "ORD-INCOMPLETE"
    })
  ]);

  assert.deepEqual(plan.summary, { eligible: 1, exceptions: 1, existing: 0 });
  assert.equal(plan.candidates[0].orderId, "order-1");
  assert.deepEqual(plan.exceptions, [
    {
      code: "BASE_SEGMENT_SOURCE_INCOMPLETE",
      missingFacts: ["END_DATE", "FINAL_PLAN_SNAPSHOT", "ARCHIVED_MAIN_CONTRACT"],
      orderId: "order-incomplete",
      orderNo: "ORD-INCOMPLETE"
    }
  ]);
});

test("treats an existing BASE as idempotent and ignores closed history", () => {
  const existing = orderRecord({
    contractSegments: [{ id: "segment-base", segmentType: "BASE", sequenceNo: 1 }]
  });
  const closed = orderRecord({ id: "order-closed", orderStatus: "COMPLETED" });

  const plan = buildSubscriptionSegmentBootstrapPlan([existing, closed]);

  assert.deepEqual(plan.summary, { eligible: 0, exceptions: 0, existing: 1 });
  assert.equal(plan.ignored, 1);
});

test("requires an explicit dry-run or apply mode", () => {
  assert.equal(parseSubscriptionSegmentBootstrapMode(["--dry-run"]), "dry-run");
  assert.equal(parseSubscriptionSegmentBootstrapMode(["--apply"]), "apply");
  assert.throws(() => parseSubscriptionSegmentBootstrapMode([]), /exactly one/);
  assert.throws(
    () => parseSubscriptionSegmentBootstrapMode(["--dry-run", "--apply"]),
    /exactly one/
  );
});

function orderRecord(overrides = {}) {
  return {
    contract: {
      contractSnapshot: { archivedDocument: "main-contract.pdf" },
      id: "contract-1",
      status: "ARCHIVED"
    },
    contractSegments: [],
    endDate: new Date("2026-09-02T00:00:00.000Z"),
    energyLimitCount: null,
    energyLimitKwh: 100,
    finalPlanSnapshot: { subscriptionPlan: { planNo: "PLAN-1" } },
    id: "order-1",
    mileageLimitKm: 1_500,
    monthlyFeeAmount: 88_000n,
    orderNo: "ORD-1",
    orderStatus: "ACTIVE",
    overMileageFeeAmount: 100n,
    productId: "product-1",
    productVersionId: "version-1",
    quoteSnapshot: { quoteNo: "QUOTE-1" },
    startDate: new Date("2026-03-03T00:00:00.000Z"),
    ...overrides
  };
}
