import assert from "node:assert/strict";
import test from "node:test";

import { deterministicPlanDigest, sha256Canonical } from "@subscription-saas/release-foundation";

import { commandHandlers } from "../src/command-handlers.mjs";
import {
  applyInvalidTestOrderRetirement,
  planInvalidTestOrderRetirement,
  reconcileInvalidTestOrderRetirement
} from "../src/commands/stage1-invalid-test-order-retire.mjs";

import { STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET as TARGET } from "../../../scripts/stage1-staging-invalid-test-order-retirement-core.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const RAW_DIGEST = "e".repeat(64);
const INPUT = Object.freeze({
  operationId: "25d422be-1036-470c-a844-fe24735222cf",
  attemptId: "49101a87-aece-4c51-9be0-30233466510b",
  runId: "56f4ad5b-d7d3-4682-a835-0659a961c413",
  baselineManifestIdentityDigest: digest("1"),
  baselineManifestDigest: digest("2"),
  databaseIdentityFingerprint: digest("3"),
  generatedAt: "2026-09-02T09:00:00.000Z",
  operatorId: "11111111-1111-4111-8111-111111111111",
  postMigrationHead: "20260831010000_billing_maintenance_cycle_fact",
  expectedSchemaDigest: digest("4"),
  target: TARGET
});

test("registers the exact invalid-test-order retirement handler", () => {
  const commandKey = "stage1.invalid-test-order.retire@1";
  if (!commandHandlers.has(commandKey)) {
    throw Object.assign(new Error(`RUNNER_HANDLER_MISSING:${commandKey}`), {
      code: `RUNNER_HANDLER_MISSING:${commandKey}`
    });
  }
  assert.equal(typeof commandHandlers.get(commandKey), "function");
});

test("matches the legacy exact close, release and audit effects on independent states", async () => {
  const legacy = fakeContext();
  const runner = fakeContext();
  const legacyResult = await legacy.executeRetirement({
    mode: "apply",
    expectedEvidenceDigest: legacy.currentEvidenceDigest(),
    statementLog: legacy.statementLog
  });
  const plan = await planInvalidTestOrderRetirement(runner, INPUT);
  const observation = await applyInvalidTestOrderRetirement(runner, {
    input: INPUT,
    planDigest: deterministicPlanDigest(plan)
  });

  assert.deepEqual(runner.businessState(), legacy.businessState());
  assert.deepEqual(legacyResult.report.applied, {
    auditsCreated: 4,
    billingSchedulesUpdated: 1,
    blocked: false,
    correlationId: "22222222-2222-4222-8222-222222222222",
    leasesUpdated: 1,
    ordersUpdated: 1,
    skippedUnchanged: 0,
    vehiclesUpdated: 1
  });
  assert.equal(
    observation.postconditions.every(({ status }) => status === "PASSED"),
    true
  );
  assert.equal(
    runner.statementLog.some((statement) => /\b(?:ALTER|CREATE|DROP)\b/iu.test(statement)),
    false
  );
});

test("refuses non-allowlisted and valid business orders before any write", async () => {
  const nonAllowlisted = fakeContext();
  await assert.rejects(
    () =>
      planInvalidTestOrderRetirement(nonAllowlisted, {
        ...INPUT,
        target: { ...TARGET, orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }
      }),
    { code: "INVALID_TEST_ORDER_TARGET_REFUSED" }
  );
  assert.equal(nonAllowlisted.executionCalls, 0);
  assert.equal(nonAllowlisted.writeCalls, 0);

  const businessOrder = fakeContext({ blocked: true });
  await assert.rejects(() => planInvalidTestOrderRetirement(businessOrder, INPUT), {
    code: "INVALID_TEST_ORDER_TARGET_REFUSED"
  });
  assert.equal(businessOrder.writeCalls, 0);
});

test("invalidates the approved plan when ownership or version changes", async () => {
  for (const drift of ["owner", "version"]) {
    const context = fakeContext();
    const plan = await planInvalidTestOrderRetirement(context, INPUT);
    if (drift === "owner") {
      context.state.orderVehicleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      context.state.vehicleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    } else {
      context.state.version += 1;
    }
    await assert.rejects(
      () =>
        applyInvalidTestOrderRetirement(context, {
          input: INPUT,
          planDigest: deterministicPlanDigest(plan)
        }),
      { code: "PLAN_CHANGED_SINCE_APPROVAL" },
      drift
    );
    assert.equal(context.writeCalls, 0, drift);
  }
});

test("replay and reconcile do not repeat vehicle release or audit writes", async () => {
  const context = fakeContext();
  const plan = await planInvalidTestOrderRetirement(context, INPUT);
  const planDigest = deterministicPlanDigest(plan);
  await applyInvalidTestOrderRetirement(context, { input: INPUT, planDigest });
  const afterApply = context.businessState();
  const result = await reconcileInvalidTestOrderRetirement(context, {
    input: INPUT,
    planDigest,
    approvedPlan: plan
  });

  assert.equal(result.terminalStatus, "PASSED");
  assert.deepEqual(context.businessState(), afterApply);
  assert.equal(context.writeCalls, 5);
});

test("marks an after-commit observation loss UNKNOWN and reconciles without a new apply", async () => {
  const context = fakeContext({ losePostStateOnce: true });
  const plan = await planInvalidTestOrderRetirement(context, INPUT);
  const planDigest = deterministicPlanDigest(plan);
  await assert.rejects(
    () => applyInvalidTestOrderRetirement(context, { input: INPUT, planDigest }),
    (error) => error?.outcomeUnknown === true && error?.commitState === "committed-result-unproved"
  );
  const writesAfterUnknown = context.writeCalls;
  const result = await reconcileInvalidTestOrderRetirement(context, {
    input: INPUT,
    planDigest,
    approvedPlan: plan
  });

  assert.equal(result.terminalStatus, "PASSED");
  assert.equal(context.writeCalls, writesAfterUnknown);
  assert.equal(context.state.auditCount, 4);
});

test("treats forbidden DDL evidence after commit as UNKNOWN", async () => {
  const context = fakeContext({ appendDdl: true });
  const plan = await planInvalidTestOrderRetirement(context, INPUT);
  await assert.rejects(
    () =>
      applyInvalidTestOrderRetirement(context, {
        input: INPUT,
        planDigest: deterministicPlanDigest(plan)
      }),
    (error) =>
      error?.outcomeUnknown === true &&
      error?.code === "INVALID_TEST_ORDER_RETIREMENT_DDL_FORBIDDEN"
  );
  assert.equal(context.state.auditCount, 4);
});

function fakeContext({ appendDdl = false, blocked = false, losePostStateOnce = false } = {}) {
  const context = {
    databaseIdentityFingerprint: INPUT.databaseIdentityFingerprint,
    statementLog: [],
    state: {
      applied: false,
      appliedEvidenceDigest: null,
      auditCount: 0,
      blocked,
      orderVehicleId: TARGET.vehicleId,
      vehicleId: TARGET.vehicleId,
      version: 7
    },
    executionCalls: 0,
    writeCalls: 0,
    postStateLossPending: losePostStateOnce,
    prisma: { $transaction: async (callback) => callback({}) },
    now: () => new Date("2026-09-02T10:00:00.000Z")
  };
  context.currentEvidenceDigest = () =>
    context.state.appliedEvidenceDigest ??
    sha256Canonical({
      orderVehicleId: context.state.orderVehicleId,
      vehicleId: context.state.vehicleId,
      version: context.state.version
    }).slice("sha256:".length);
  context.executeRetirement = async ({ expectedEvidenceDigest, mode, statementLog }) => {
    context.executionCalls += 1;
    const classification = currentClassification(context);
    if (mode === "dry-run") {
      if (context.postStateLossPending && context.state.applied) {
        context.postStateLossPending = false;
        throw new Error("INJECTED_POST_COMMIT_OBSERVATION_LOSS");
      }
      return outcome("dry-run", classification, null);
    }
    assert.equal(mode, "apply");
    if (expectedEvidenceDigest !== classification.evidenceDigest) {
      throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_EVIDENCE_DIGEST_MISMATCH");
    }
    if (classification.disposition === "UNCHANGED") {
      return outcome("apply", classification, emptyApplied(1));
    }
    context.state.appliedEvidenceDigest = classification.evidenceDigest;
    context.state.applied = true;
    context.state.auditCount = 4;
    context.state.version += 1;
    context.writeCalls += 5;
    statementLog.push(
      "SELECT TRUE FROM pg_advisory_xact_lock(1)",
      'UPDATE "billing_schedule"',
      'UPDATE "lease"',
      'UPDATE "subscription_order"',
      'UPDATE "vehicle"',
      'INSERT INTO "audit_log"'
    );
    if (appendDdl) statementLog.push('ALTER TABLE "subscription_order" ADD COLUMN forbidden int');
    return outcome("apply", classification, {
      auditsCreated: 4,
      billingSchedulesUpdated: 1,
      blocked: false,
      correlationId: "22222222-2222-4222-8222-222222222222",
      leasesUpdated: 1,
      ordersUpdated: 1,
      skippedUnchanged: 0,
      vehiclesUpdated: 1
    });
  };
  context.businessState = () => ({
    applied: context.state.applied,
    auditCount: context.state.auditCount,
    orderVehicleId: context.state.orderVehicleId,
    vehicleId: context.state.vehicleId,
    version: context.state.version
  });
  return context;
}

function currentClassification(context) {
  const evidenceDigest = context.currentEvidenceDigest();
  if (context.state.blocked || context.state.orderVehicleId !== TARGET.vehicleId) {
    return {
      blockers: [
        { code: context.state.blocked ? "RELATED_RECORDS_PRESENT" : "TARGET_IDENTITY_MISMATCH" }
      ],
      candidate: null,
      disposition: "BLOCKED",
      evidenceDigest
    };
  }
  if (context.state.applied) {
    return { blockers: [], candidate: null, disposition: "UNCHANGED", evidenceDigest };
  }
  return {
    blockers: [],
    candidate: {
      billingScheduleId: "36054e6d-5104-4daf-b8a7-cb7e956fc436",
      leaseId: "44444444-4444-4444-8444-444444444444",
      ownership: { orderId: TARGET.orderId, vehicleId: context.state.orderVehicleId },
      orderId: TARGET.orderId,
      transitions: {
        billingSchedule: ["PAUSED", "CANCELLED"],
        lease: ["ACTIVE", "COMPLETED"],
        order: ["ACTIVE", "CANCELLED"],
        vehicle: ["LEASED", "AVAILABLE"]
      },
      vehicleId: context.state.vehicleId,
      versions: { billingSchedule: context.state.version }
    },
    disposition: "CANDIDATE",
    evidenceDigest
  };
}

function outcome(mode, classification, applied) {
  return {
    exitCode: classification.disposition === "BLOCKED" ? 1 : 0,
    report: {
      applied,
      classification,
      generatedAt: INPUT.generatedAt,
      mode,
      safeToApply: classification.disposition !== "BLOCKED"
    }
  };
}

function emptyApplied(skippedUnchanged) {
  return {
    auditsCreated: 0,
    billingSchedulesUpdated: 0,
    blocked: false,
    correlationId: null,
    leasesUpdated: 0,
    ordersUpdated: 0,
    skippedUnchanged,
    vehiclesUpdated: 0
  };
}
