import assert from "node:assert/strict";
import test from "node:test";

import { deterministicPlanDigest } from "@subscription-saas/release-foundation";

import { commandHandlers } from "../src/command-handlers.mjs";

import {
  applySubscriptionSegmentBootstrapPlan,
  buildSubscriptionSegmentBootstrapPlan
} from "../../../scripts/subscription-segment-bootstrap-core.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const INPUT = Object.freeze({
  operationId: "25d422be-1036-470c-a844-fe24735222cf",
  attemptId: "49101a87-aece-4c51-9be0-30233466510b",
  runId: "56f4ad5b-d7d3-4682-a835-0659a961c413",
  baselineManifestIdentityDigest: digest("1"),
  baselineManifestDigest: digest("2"),
  databaseIdentityFingerprint: digest("3"),
  generatedAt: "2026-09-02T09:00:00.000Z",
  postMigrationHead: "20260831010000_billing_maintenance_cycle_fact",
  expectedSchemaDigest: digest("4")
});

test("registers the subscription segment bootstrap handler", () => {
  const commandKey = "subscription.segment.bootstrap@1";
  if (!commandHandlers.has(commandKey)) {
    throw Object.assign(new Error(`RUNNER_HANDLER_MISSING:${commandKey}`), {
      code: `RUNNER_HANDLER_MISSING:${commandKey}`
    });
  }
  assert.equal(typeof commandHandlers.get(commandKey), "function");
});

test("matches legacy segment and audit effects on independent database states", async () => {
  const { applySubscriptionSegmentBootstrap, planSubscriptionSegmentBootstrap } =
    await import("../src/commands/subscription-segment-bootstrap.mjs");
  const legacy = harness();
  const runner = harness();

  const legacyPlan = buildSubscriptionSegmentBootstrapPlan(await legacy.loadRecords());
  await applySubscriptionSegmentBootstrapPlan(legacy.prisma, legacyPlan);
  const plan = await planSubscriptionSegmentBootstrap(runner.context, INPUT);
  const observation = await applySubscriptionSegmentBootstrap(runner.context, {
    input: INPUT,
    planDigest: deterministicPlanDigest(plan)
  });

  assert.deepEqual(normalizedState(runner), normalizedState(legacy));
  assert.equal(
    observation.postconditions.every(({ status }) => status === "PASSED"),
    true
  );
});

test("retains incomplete and overlapping segment source refusal classes without writes", async () => {
  const { applySubscriptionSegmentBootstrap, planSubscriptionSegmentBootstrap } =
    await import("../src/commands/subscription-segment-bootstrap.mjs");
  const subject = harness({
    contractSegments: [{ id: "change-1", segmentType: "CHANGE", sequenceNo: 1 }]
  });
  const plan = await planSubscriptionSegmentBootstrap(subject.context, INPUT);
  assert.deepEqual(plan.identity.exceptions[0].missingFacts, ["CONTRACT_SEGMENT_STATE"]);
  const observation = await applySubscriptionSegmentBootstrap(subject.context, {
    input: INPUT,
    planDigest: deterministicPlanDigest(plan)
  });
  assert.equal(
    observation.postconditions.every(({ status }) => status === "PASSED"),
    true
  );
  assert.equal(subject.rows.size, 0);
  assert.equal(subject.audits.length, 0);
});

test("rejects stale and locked candidate plans before segment creation", async () => {
  const { applySubscriptionSegmentBootstrap, planSubscriptionSegmentBootstrap } =
    await import("../src/commands/subscription-segment-bootstrap.mjs");
  const stale = harness();
  const stalePlan = await planSubscriptionSegmentBootstrap(stale.context, INPUT);
  stale.current.monthlyFeeAmount = 99_000n;
  await assert.rejects(
    () =>
      applySubscriptionSegmentBootstrap(stale.context, {
        input: INPUT,
        planDigest: deterministicPlanDigest(stalePlan)
      }),
    { code: "PLAN_CHANGED_SINCE_APPROVAL" }
  );
  assert.equal(stale.rows.size, 0);

  const locked = harness();
  const lockedPlan = await planSubscriptionSegmentBootstrap(locked.context, INPUT);
  locked.mutateAfterLoad = 3;
  await assert.rejects(
    () =>
      applySubscriptionSegmentBootstrap(locked.context, {
        input: INPUT,
        planDigest: deterministicPlanDigest(lockedPlan)
      }),
    (error) => error.outcomeUnknown === true && error.commitState === "committed-result-unproved"
  );
  assert.equal(locked.rows.size, 0);
});

test("reconciles an after-commit unknown without a duplicate BASE segment", async () => {
  const {
    applySubscriptionSegmentBootstrap,
    planSubscriptionSegmentBootstrap,
    reconcileSubscriptionSegmentBootstrap
  } = await import("../src/commands/subscription-segment-bootstrap.mjs");
  const subject = harness();
  const originalApply = subject.context.applyPlan;
  subject.context.applyPlan = async (...args) => {
    const result = await originalApply(...args);
    throw Object.assign(new Error("INJECTED_PROCESS_LOSS"), { committedResult: result });
  };
  const plan = await planSubscriptionSegmentBootstrap(subject.context, INPUT);
  const planDigest = deterministicPlanDigest(plan);
  await assert.rejects(
    () => applySubscriptionSegmentBootstrap(subject.context, { input: INPUT, planDigest }),
    (error) => error.outcomeUnknown === true
  );
  assert.equal(subject.rows.size, 1);
  assert.equal(subject.audits.length, 1);

  const result = await reconcileSubscriptionSegmentBootstrap(subject.context, {
    input: INPUT,
    planDigest,
    approvedPlan: plan
  });
  assert.equal(result.terminalStatus, "PASSED");
  assert.equal(subject.rows.size, 1);
  assert.equal(subject.audits.length, 1);
});

function harness(overrides = {}) {
  const current = orderRecord(overrides);
  const rows = new Map();
  const audits = [];
  const subject = { current, rows, audits, mutateAfterLoad: 0, loadCount: 0 };
  const tx = {
    $queryRawUnsafe: async () => [],
    auditLog: { create: async ({ data }) => (audits.push(structuredClone(data)), data) },
    subscriptionOrder: {
      findUnique: async ({ where }) =>
        where.id === current.id ? recordWithSegments(current, rows) : null
    },
    subscriptionContractSegment: {
      createMany: async ({ data }) => {
        let count = 0;
        for (const value of data) {
          const key = `${value.orderId}:${value.sequenceNo}`;
          if (rows.has(key)) continue;
          rows.set(key, {
            id: `segment-${value.orderId}-${value.sequenceNo}`,
            ...structuredClone(value)
          });
          count += 1;
        }
        return { count };
      },
      findMany: async ({ where }) =>
        [...rows.values()].filter(({ orderId }) => where.orderId.in.includes(orderId))
    }
  };
  subject.prisma = {
    $transaction: async (operation) => {
      const beforeRows = structuredClone([...rows.entries()]);
      const beforeAudits = structuredClone(audits);
      try {
        return await operation(tx);
      } catch (error) {
        rows.clear();
        for (const [key, value] of beforeRows) rows.set(key, value);
        audits.splice(0, audits.length, ...beforeAudits);
        throw error;
      }
    }
  };
  subject.loadRecords = async () => {
    subject.loadCount += 1;
    const result = [recordWithSegments(current, rows)];
    if (subject.mutateAfterLoad === subject.loadCount) current.monthlyFeeAmount = 99_000n;
    return result;
  };
  subject.context = {
    databaseIdentityFingerprint: INPUT.databaseIdentityFingerprint,
    prisma: subject.prisma,
    loadRecords: subject.loadRecords,
    applyPlan: (...args) => applySubscriptionSegmentBootstrapPlan(...args),
    now: () => new Date("2026-09-02T10:00:00.000Z")
  };
  return subject;
}

function recordWithSegments(current, rows) {
  return {
    ...structuredClone(current),
    contractSegments: [
      ...(current.contractSegments ?? []),
      ...[...rows.values()].map(({ id, segmentType, sequenceNo }) => ({
        id,
        segmentType,
        sequenceNo
      }))
    ]
  };
}

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

function normalizedState(subject) {
  return {
    rows: [...subject.rows.values()].map((row) => ({
      ...row,
      activatedAt: row.activatedAt.toISOString(),
      endDate: row.endDate.toISOString(),
      monthlyFeeAmount: row.monthlyFeeAmount.toString(),
      overMileageFeeAmount: row.overMileageFeeAmount.toString(),
      startDate: row.startDate.toISOString()
    })),
    audits: subject.audits
  };
}
