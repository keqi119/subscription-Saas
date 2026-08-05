import assert from "node:assert/strict";
import test from "node:test";

import { executeSubscriptionSegmentBootstrap } from "./subscription-segment-bootstrap.mjs";

test("apply is transactional and an idempotent rerun creates no second BASE", async () => {
  const harness = createPrismaHarness();
  const records = [orderRecord()];

  const firstApply = await executeSubscriptionSegmentBootstrap({
    mode: "apply",
    prisma: harness.prisma,
    records
  });
  const secondApply = await executeSubscriptionSegmentBootstrap({
    mode: "apply",
    prisma: harness.prisma,
    records
  });

  assert.equal(firstApply.created, 1);
  assert.equal(secondApply.created, 0);
  assert.equal(secondApply.existing, 1);
  assert.equal(harness.rows.size, 1);
  assert.equal(harness.transactionCount(), 2);
});

test("dry run never opens a write transaction", async () => {
  const harness = createPrismaHarness();
  const result = await executeSubscriptionSegmentBootstrap({
    mode: "dry-run",
    prisma: harness.prisma,
    records: [orderRecord()]
  });

  assert.equal(result.created, 0);
  assert.deepEqual(result.plan.summary, { eligible: 1, exceptions: 0, existing: 0 });
  assert.equal(harness.transactionCount(), 0);
});

test("apply locks and rebuilds each candidate from current source facts", async () => {
  const planned = orderRecord();
  const current = orderRecord();
  current.monthlyFeeAmount = 99_000n;
  current.finalPlanSnapshot = { subscriptionPlan: { planNo: "PLAN-CURRENT" } };
  const harness = createPrismaHarness(current);

  const result = await executeSubscriptionSegmentBootstrap({
    mode: "apply",
    prisma: harness.prisma,
    records: [planned]
  });

  assert.equal(result.created, 1);
  assert.equal(harness.rows.get("order-1:1").monthlyFeeAmount, 99_000n);
  assert.deepEqual(harness.rows.get("order-1:1").planSnapshot, {
    subscriptionPlan: { planNo: "PLAN-CURRENT" }
  });
});

test("apply fails closed when a planned candidate is no longer eligible", async () => {
  const current = orderRecord();
  current.orderStatus = "CANCELLED";
  const harness = createPrismaHarness(current);

  await assert.rejects(
    executeSubscriptionSegmentBootstrap({
      mode: "apply",
      prisma: harness.prisma,
      records: [orderRecord()]
    }),
    /SUBSCRIPTION_SEGMENT_BOOTSTRAP_STALE_PLAN:order-1/
  );
  assert.equal(harness.rows.size, 0);
});

function createPrismaHarness(currentOrder = orderRecord()) {
  const rows = new Map();
  let transactions = 0;
  const tx = {
    $queryRawUnsafe: async () => [],
    subscriptionOrder: {
      findUnique: async ({ where }) => {
        if (where.id !== currentOrder.id) return null;
        return {
          ...structuredClone(currentOrder),
          contractSegments: [...rows.values()]
            .filter((row) => row.orderId === currentOrder.id)
            .map((row) => ({
              id: row.id ?? row.segmentNo,
              segmentType: row.segmentType,
              sequenceNo: row.sequenceNo
            }))
        };
      }
    },
    subscriptionContractSegment: {
      createMany: async ({ data }) => {
        let count = 0;
        for (const row of data) {
          const key = `${row.orderId}:${row.sequenceNo}`;
          if (rows.has(key)) continue;
          rows.set(key, structuredClone(row));
          count += 1;
        }
        return { count };
      },
      findMany: async ({ where }) =>
        [...rows.values()].filter((row) => where.orderId.in.includes(row.orderId))
    }
  };
  return {
    prisma: {
      $transaction: async (operation) => {
        transactions += 1;
        return operation(tx);
      }
    },
    rows,
    transactionCount: () => transactions
  };
}

function orderRecord() {
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
    startDate: new Date("2026-03-03T00:00:00.000Z")
  };
}
