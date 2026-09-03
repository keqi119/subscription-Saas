import assert from "node:assert/strict";
import test from "node:test";

import { deterministicPlanDigest } from "@subscription-saas/release-foundation";

import { commandHandlers } from "../src/command-handlers.mjs";

import { hashStage1cPeriodBackfillClassification } from "../../../scripts/stage1c-period-backfill-core.mjs";

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

test("registers the period backfill handler", () => {
  const commandKey = "stage1.period.backfill@1";
  if (!commandHandlers.has(commandKey)) {
    throw Object.assign(new Error(`RUNNER_HANDLER_MISSING:${commandKey}`), {
      code: `RUNNER_HANDLER_MISSING:${commandKey}`
    });
  }
  assert.equal(typeof commandHandlers.get(commandKey), "function");
});

test("matches legacy insertion and audit effects on independent states", async () => {
  const { applyPeriodBackfill, planPeriodBackfill } =
    await import("../src/commands/stage1-period-backfill.mjs");
  const legacy = fakeContext();
  const runner = fakeContext();
  const legacyResult = await legacy.executeBackfill({ mode: "apply" });
  const plan = await planPeriodBackfill(runner, INPUT);
  const postState = await applyPeriodBackfill(runner, {
    input: INPUT,
    planDigest: deterministicPlanDigest(plan)
  });

  assert.deepEqual(runner.state, legacy.state);
  assert.equal(legacyResult.report.applied.inserted, 1);
  assert.equal(
    postState.postconditions.every(({ status }) => status === "PASSED"),
    true
  );
});

test("rejects source drift inside the locked apply before insertion", async () => {
  const { applyPeriodBackfill, planPeriodBackfill } =
    await import("../src/commands/stage1-period-backfill.mjs");
  const context = fakeContext();
  const plan = await planPeriodBackfill(context, INPUT);
  context.driftOnApply = true;
  await assert.rejects(
    () =>
      applyPeriodBackfill(context, {
        input: INPUT,
        planDigest: deterministicPlanDigest(plan)
      }),
    { code: "PLAN_CHANGED_SINCE_APPROVAL" }
  );
  assert.deepEqual(context.state, { persisted: false, version: 1, audits: 0 });
});

test("reconciles an after-commit unknown without a second period", async () => {
  const { planPeriodBackfill, reconcilePeriodBackfill } =
    await import("../src/commands/stage1-period-backfill.mjs");
  const context = fakeContext();
  const plan = await planPeriodBackfill(context, INPUT);
  const planDigest = deterministicPlanDigest(plan);
  await context.executeBackfill({
    mode: "apply",
    expectedClassificationDigest: plan.identity.classificationDigest
  });
  const before = structuredClone(context.state);
  const result = await reconcilePeriodBackfill(context, {
    input: INPUT,
    planDigest,
    approvedPlan: plan
  });
  assert.equal(result.terminalStatus, "PASSED");
  assert.deepEqual(context.state, before);
});

function fakeContext() {
  const context = {
    databaseIdentityFingerprint: INPUT.databaseIdentityFingerprint,
    prisma: { $transaction: async (callback) => callback({}) },
    state: { persisted: false, version: 1, audits: 0 },
    driftOnApply: false,
    now: () => new Date("2026-09-02T10:00:00.000Z")
  };
  context.executeBackfill = async ({ mode, expectedClassificationDigest }) => {
    if (mode === "dry-run") return outcome("dry-run", classification(context.state), null);
    if (context.driftOnApply) {
      context.driftOnApply = false;
      context.state.version += 1;
    }
    const current = classification(context.state);
    if (
      expectedClassificationDigest !== undefined &&
      expectedClassificationDigest !== hashStage1cPeriodBackfillClassification(current)
    ) {
      context.state.version = 1;
      throw Object.assign(new Error("STAGE1C_PERIOD_BACKFILL_PLAN_CHANGED"), {
        code: "STAGE1C_PERIOD_BACKFILL_PLAN_CHANGED"
      });
    }
    if (!context.state.persisted) {
      context.state.persisted = true;
      context.state.audits = 1;
      return outcome("apply", current, { blocked: false, inserted: 1, skippedUnchanged: 0 });
    }
    return outcome("apply", current, { blocked: false, inserted: 0, skippedUnchanged: 1 });
  };
  return context;
}

function classification(state) {
  const period = {
    disposition: state.persisted ? "UNCHANGED" : "CREATE",
    orderId: "order-1",
    sourceKey: "subscription-order:order-1",
    payload: {
      orderId: "order-1",
      vehicleId: "vehicle-1",
      customerId: "customer-1",
      startedAt: "2026-08-26T03:53:26.694Z",
      endedAt: null,
      startSourceKey: "subscription-order:order-1",
      version: state.version
    }
  };
  return {
    ambiguities: [],
    counters: {
      activeOrders: 1,
      closedPeriods: 0,
      existingOpenPeriods: state.persisted ? 1 : 0,
      leasedVehicles: 1,
      oneOrderMultipleCurrentAnomalies: 0,
      overlaps: 0,
      ownershipUnknownVehicles: 0,
      proposedOpenPeriods: state.persisted ? 0 : 1
    },
    invariantViolations: [],
    overlaps: [],
    ownership: { proposedPeriods: [], unknownVehicles: [] },
    segmentOmissions: [],
    sourceCounts: {},
    subscriptionPeriods: [period]
  };
}

function outcome(mode, currentClassification, applied) {
  return {
    exitCode: 0,
    report: {
      applied,
      classification: currentClassification,
      generatedAt: INPUT.generatedAt,
      mode,
      safeToApply: true
    }
  };
}
