import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSubscriptionRenewalReconciliationPlan,
  executeSubscriptionRenewalReconciliation,
  parseSubscriptionRenewalReconciliationMode
} from "./subscription-renewal-reconcile.mjs";

test("late enrollment makes only the latest applicable reminder immediately pending", () => {
  const now = new Date("2026-08-29T04:00:00.000Z");
  const plan = buildSubscriptionRenewalReconciliationPlan([segmentRecord()], now);

  assert.equal(plan.candidates.length, 1);
  assert.deepEqual(
    plan.candidates[0].reminders.map(({ scheduledAt, slot, status }) => ({
      scheduledAt,
      slot,
      status
    })),
    [
      {
        scheduledAt: new Date("2026-08-03T01:00:00.000Z"),
        slot: "D30",
        status: "SKIPPED_LATE_ENROLLMENT"
      },
      { scheduledAt: now, slot: "D14", status: "PENDING" },
      {
        scheduledAt: new Date("2026-08-30T01:00:00.000Z"),
        slot: "D3",
        status: "PENDING"
      }
    ]
  );
  assert.equal(
    plan.candidates[0].jobs.filter((job) => job.jobType.startsWith("RENEWAL_REMINDER")).length,
    2
  );
});

test("skips a source segment that already has a future extension", () => {
  const plan = buildSubscriptionRenewalReconciliationPlan(
    [
      segmentRecord({
        laterSegments: [
          {
            endDate: new Date("2027-03-02T00:00:00.000Z"),
            id: "segment-extension",
            segmentType: "EXTENSION",
            startDate: new Date("2026-09-03T00:00:00.000Z"),
            status: "SCHEDULED"
          }
        ]
      })
    ],
    new Date("2026-08-29T04:00:00.000Z")
  );

  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.summary.alreadyExtended, 1);
});

test("does not plan reminders after a customer has already chosen renewal", () => {
  const plan = buildSubscriptionRenewalReconciliationPlan(
    [
      segmentRecord({
        renewalConsideration: {
          id: "consideration-1",
          status: "RENEWAL_REQUESTED"
        }
      })
    ],
    new Date("2026-08-29T04:00:00.000Z")
  );

  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.summary.existing, 1);
});

test("reconciliation defaults to dry run and requires --apply for writes", () => {
  assert.equal(parseSubscriptionRenewalReconciliationMode([]), "dry-run");
  assert.equal(parseSubscriptionRenewalReconciliationMode(["--dry-run"]), "dry-run");
  assert.equal(parseSubscriptionRenewalReconciliationMode(["--apply"]), "apply");
  assert.throws(() => parseSubscriptionRenewalReconciliationMode(["--unsafe"]));
});

test("apply is transactional, idempotent, and only enqueues work without sending SMS", async () => {
  const harness = createPrismaHarness();
  const input = {
    mode: "apply",
    now: new Date("2026-08-29T04:00:00.000Z"),
    prisma: harness.prisma,
    records: [segmentRecord()]
  };

  const first = await executeSubscriptionRenewalReconciliation(input);
  const second = await executeSubscriptionRenewalReconciliation(input);

  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(harness.considerations.size, 1);
  assert.equal(harness.reminders.size, 3);
  assert.equal(harness.jobs.size, 4);
  assert.equal("sms" in harness.prisma, false);
  assert.equal(harness.transactionCount(), 2);
});

test("apply revalidates a stale plan after a concurrent renewal decision", async () => {
  const harness = createPrismaHarness({ considerationStatus: "RENEWAL_REQUESTED" });

  const result = await executeSubscriptionRenewalReconciliation({
    mode: "apply",
    now: new Date("2026-08-29T04:00:00.000Z"),
    prisma: harness.prisma,
    records: [segmentRecord()]
  });

  assert.equal(result.created, 0);
  assert.equal(result.reconciled, 0);
  assert.equal(harness.reminders.size, 0);
  assert.equal(harness.jobs.size, 0);
});

test("apply skips stale candidates after concurrent archive or expiry", async (t) => {
  for (const scenario of [
    { laterExtension: { id: "segment-extension" }, name: "archived extension" },
    { name: "completed source segment", segmentStatus: "COMPLETED" },
    { name: "order pending return", orderStatus: "PENDING_RETURN" }
  ]) {
    await t.test(scenario.name, async () => {
      const harness = createPrismaHarness(scenario);
      const result = await executeSubscriptionRenewalReconciliation({
        mode: "apply",
        now: new Date("2026-08-29T04:00:00.000Z"),
        prisma: harness.prisma,
        records: [segmentRecord()]
      });

      assert.equal(result.reconciled, 0);
      assert.equal(harness.reminders.size, 0);
      assert.equal(harness.jobs.size, 0);
    });
  }
});

function segmentRecord(overrides = {}) {
  return {
    endDate: new Date("2026-09-02T00:00:00.000Z"),
    id: "segment-base",
    laterSegments: [],
    orderId: "order-1",
    orderStatus: "ACTIVE",
    renewalConsideration: null,
    sequenceNo: 1,
    status: "ACTIVE",
    ...overrides
  };
}

function createPrismaHarness({
  considerationStatus = null,
  laterExtension = null,
  orderStatus = "ACTIVE",
  segmentStatus = "ACTIVE"
} = {}) {
  const considerations = new Map();
  const reminders = new Map();
  const jobs = new Map();
  if (considerationStatus) {
    considerations.set("segment-base", {
      id: "consideration-existing",
      segmentId: "segment-base",
      status: considerationStatus
    });
  }
  let transactions = 0;
  const tx = {
    $queryRaw: async () => [],
    renewalConsideration: {
      findUnique: async ({ where }) => considerations.get(where.segmentId) ?? null,
      upsert: async ({ create, where }) => {
        const current = considerations.get(where.segmentId);
        if (current) return current;
        const row = { ...structuredClone(create), id: `consideration-${considerations.size + 1}` };
        considerations.set(where.segmentId, row);
        return row;
      }
    },
    renewalReminder: {
      upsert: async ({ create, where }) => {
        const identity = where.renewalConsiderationId_slot;
        const key = `${identity.renewalConsiderationId}:${identity.slot}`;
        const current = reminders.get(key);
        if (current) return current;
        const row = { ...structuredClone(create), id: `reminder-${reminders.size + 1}` };
        reminders.set(key, row);
        return row;
      }
    },
    subscriptionAutomationJob: {
      upsert: async ({ create, where }) => {
        const current = jobs.get(where.idempotencyKey);
        if (current) return current;
        const row = { ...structuredClone(create), id: `job-${jobs.size + 1}` };
        jobs.set(where.idempotencyKey, row);
        return row;
      }
    },
    subscriptionContractSegment: {
      findFirst: async () => laterExtension,
      findUnique: async () => ({
        endDate: new Date("2026-09-02T00:00:00.000Z"),
        id: "segment-base",
        order: { orderStatus },
        orderId: "order-1",
        renewalConsideration: considerations.get("segment-base") ?? null,
        sequenceNo: 1,
        status: segmentStatus
      })
    }
  };
  return {
    considerations,
    jobs,
    prisma: {
      $transaction: async (operation) => {
        transactions += 1;
        return operation(tx);
      }
    },
    reminders,
    transactionCount: () => transactions
  };
}
