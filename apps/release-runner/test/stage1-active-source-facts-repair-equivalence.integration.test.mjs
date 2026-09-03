import assert from "node:assert/strict";
import test from "node:test";

import { deterministicPlanDigest } from "@subscription-saas/release-foundation";

import { commandHandlers } from "../src/command-handlers.mjs";

import { hashStage1ActiveSourceFactsRepairClassification } from "../../../scripts/stage1-active-source-facts-repair-core.mjs";

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

test("registers the active-source-facts repair handler", () => {
  const commandKey = "stage1.active-source-facts.repair@1";
  if (!commandHandlers.has(commandKey)) {
    throw Object.assign(new Error(`RUNNER_HANDLER_MISSING:${commandKey}`), {
      code: `RUNNER_HANDLER_MISSING:${commandKey}`
    });
  }
  assert.equal(typeof commandHandlers.get(commandKey), "function");
});

test("matches the legacy apply result on an independent database state", async () => {
  const { applyActiveSourceFactsRepair, planActiveSourceFactsRepair } =
    await import("../src/commands/stage1-active-source-facts-repair.mjs");
  const legacy = fakeContext();
  const runner = fakeContext();

  const legacyResult = await legacy.executeRepair({
    mode: "apply",
    generatedAt: INPUT.generatedAt,
    prisma: legacy.prisma
  });
  const plan = await planActiveSourceFactsRepair(runner, INPUT);
  const postState = await applyActiveSourceFactsRepair(runner, {
    input: INPUT,
    planDigest: deterministicPlanDigest(plan)
  });

  assert.deepEqual(runner.state, legacy.state);
  assert.deepEqual(legacyResult.report.applied, {
    audits: 2,
    blocked: false,
    contractsUpdated: 1,
    ordersUpdated: 1,
    skippedUnchanged: 0
  });
  assert.equal(postState.commandId, "stage1.active-source-facts.repair");
  assert.equal(
    postState.postconditions.every(({ status }) => status === "PASSED"),
    true
  );
});

test("rejects candidate drift both before and after the locked reload", async () => {
  const { applyActiveSourceFactsRepair, planActiveSourceFactsRepair } =
    await import("../src/commands/stage1-active-source-facts-repair.mjs");

  const beforeLock = fakeContext();
  const beforePlan = await planActiveSourceFactsRepair(beforeLock, INPUT);
  beforeLock.state.version = 2;
  await assert.rejects(
    () =>
      applyActiveSourceFactsRepair(beforeLock, {
        input: INPUT,
        planDigest: deterministicPlanDigest(beforePlan)
      }),
    { code: "PLAN_CHANGED_SINCE_APPROVAL" }
  );
  assert.equal(beforeLock.state.audits, 0);

  const underLock = fakeContext();
  const lockedPlan = await planActiveSourceFactsRepair(underLock, INPUT);
  underLock.driftOnApply = true;
  await assert.rejects(
    () =>
      applyActiveSourceFactsRepair(underLock, {
        input: INPUT,
        planDigest: deterministicPlanDigest(lockedPlan)
      }),
    { code: "PLAN_CHANGED_SINCE_APPROVAL" }
  );
  assert.equal(underLock.state.audits, 0);
});

test("reconciles process loss after commit without duplicate facts or audits", async () => {
  const { planActiveSourceFactsRepair, reconcileActiveSourceFactsRepair } =
    await import("../src/commands/stage1-active-source-facts-repair.mjs");
  const context = fakeContext();
  const plan = await planActiveSourceFactsRepair(context, INPUT);
  const planDigest = deterministicPlanDigest(plan);

  await context.executeRepair({
    mode: "apply",
    generatedAt: INPUT.generatedAt,
    prisma: context.prisma,
    expectedClassificationDigest: plan.identity.classificationDigest
  });
  const before = structuredClone(context.state);
  const result = await reconcileActiveSourceFactsRepair(context, {
    input: INPUT,
    planDigest,
    approvedPlan: plan
  });

  assert.equal(result.terminalStatus, "PASSED");
  assert.equal(result.postconditions[0].status, "PASSED");
  assert.deepEqual(context.state, before);
});

test("marks a lost post-commit observation unknown and permits only reconcile", async () => {
  const {
    applyActiveSourceFactsRepair,
    planActiveSourceFactsRepair,
    reconcileActiveSourceFactsRepair
  } = await import("../src/commands/stage1-active-source-facts-repair.mjs");
  const context = fakeContext();
  const plan = await planActiveSourceFactsRepair(context, INPUT);
  const planDigest = deterministicPlanDigest(plan);
  context.failPostApplyObservation = true;

  await assert.rejects(
    () => applyActiveSourceFactsRepair(context, { input: INPUT, planDigest }),
    (error) => error?.outcomeUnknown === true && error?.commitState === "committed-result-unproved"
  );
  assert.equal(context.state.repaired, true);
  assert.equal(context.state.audits, 2);

  context.failPostApplyObservation = false;
  const reconciliation = await reconcileActiveSourceFactsRepair(context, {
    input: INPUT,
    planDigest,
    approvedPlan: plan
  });
  assert.equal(reconciliation.terminalStatus, "PASSED");
  assert.equal(context.state.audits, 2);
});

function fakeContext() {
  const context = {
    databaseIdentityFingerprint: INPUT.databaseIdentityFingerprint,
    prisma: { $transaction: async (callback) => callback({}) },
    state: { repaired: false, version: 1, audits: 0, contractUpdates: 0, orderUpdates: 0 },
    now: () => new Date("2026-09-02T10:00:00.000Z"),
    driftOnApply: false,
    failPostApplyObservation: false
  };
  context.executeRepair = async ({ mode, expectedClassificationDigest }) => {
    if (mode === "dry-run") {
      if (context.state.repaired && context.failPostApplyObservation) {
        throw Object.assign(new Error("INJECTED_POST_COMMIT_READ_FAILURE"), {
          code: "INJECTED_POST_COMMIT_READ_FAILURE"
        });
      }
      return outcome("dry-run", classification(context.state), null);
    }
    if (context.driftOnApply) {
      context.driftOnApply = false;
      context.state.version += 1;
    }
    const current = classification(context.state);
    if (
      expectedClassificationDigest !== undefined &&
      expectedClassificationDigest !== hashStage1ActiveSourceFactsRepairClassification(current)
    ) {
      throw Object.assign(new Error("STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_PLAN_CHANGED"), {
        code: "STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_PLAN_CHANGED"
      });
    }
    if (!context.state.repaired) {
      context.state.repaired = true;
      context.state.audits = 2;
      context.state.contractUpdates = 1;
      context.state.orderUpdates = 1;
      return outcome("apply", current, {
        audits: 2,
        blocked: false,
        contractsUpdated: 1,
        ordersUpdated: 1,
        skippedUnchanged: 0
      });
    }
    return outcome("apply", current, {
      audits: 0,
      blocked: false,
      contractsUpdated: 0,
      ordersUpdated: 0,
      skippedUnchanged: 1
    });
  };
  return context;
}

function classification(state) {
  const identity = {
    orderId: "order-1",
    orderNo: "ORD-1",
    contractId: "contract-1",
    evidenceDigest: String(state.version).padStart(64, "0")
  };
  if (state.repaired) {
    return {
      candidates: [],
      exceptions: [],
      unchanged: [identity],
      summary: {
        actions: { ARCHIVE_CONTRACT: 0, BIND_CONTRACT: 0, SET_ORDER_DATES: 0 },
        candidates: 0,
        exceptions: 0,
        inspectedOrders: 1,
        unchanged: 1
      }
    };
  }
  return {
    candidates: [
      {
        ...identity,
        actions: ["ARCHIVE_CONTRACT", "BIND_CONTRACT", "SET_ORDER_DATES"],
        startDate: "2026-08-26",
        endDate: "2027-08-25",
        archivedAt: "2026-08-26T03:53:26.694Z"
      }
    ],
    exceptions: [],
    unchanged: [],
    summary: {
      actions: { ARCHIVE_CONTRACT: 1, BIND_CONTRACT: 1, SET_ORDER_DATES: 1 },
      candidates: 1,
      exceptions: 0,
      inspectedOrders: 1,
      unchanged: 0
    }
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
