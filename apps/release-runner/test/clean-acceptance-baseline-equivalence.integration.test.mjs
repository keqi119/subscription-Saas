import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { deterministicPlanDigest } from "@subscription-saas/release-foundation";

import { commandHandlers } from "../src/command-handlers.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const INPUT = Object.freeze({
  operationId: "25d422be-1036-470c-a844-fe24735222cf",
  attemptId: "49101a87-aece-4c51-9be0-30233466510b",
  runId: "56f4ad5b-d7d3-4682-a835-0659a961c413",
  baselineManifestIdentityDigest: digest("1"),
  baselineManifestDigest: digest("2"),
  sourceDatabaseIdentityFingerprint: digest("3"),
  databaseIdentityFingerprint: digest("4"),
  selection: {
    adminUsername: "keqi_119",
    customerPhone: "18616570212",
    vehicleIds: ["11111111-1111-4111-8111-111111111111"]
  },
  generatedAt: "2026-09-02T09:00:00.000Z",
  hashSalt: "5".repeat(64),
  gitSha: "6".repeat(40),
  imageRef: `registry.example/api@sha256:${"7".repeat(64)}`,
  postMigrationHead: "20260831010000_billing_maintenance_cycle_fact",
  expectedSchemaDigest: digest("8")
});

test("registers the clean-acceptance baseline repair handler", () => {
  const commandKey = "stage1.clean-acceptance.baseline@1";
  if (!commandHandlers.has(commandKey)) {
    throw Object.assign(new Error(`RUNNER_HANDLER_MISSING:${commandKey}`), {
      code: `RUNNER_HANDLER_MISSING:${commandKey}`
    });
  }
  assert.equal(typeof commandHandlers.get(commandKey), "function");
});

test("normalizes the old entry and Runner apply to equivalent independent database results", async () => {
  const { applyCleanAcceptanceBaseline, planCleanAcceptanceBaseline } =
    await import("../src/commands/stage1-clean-acceptance-baseline.mjs");
  const { normalizeStage1CleanAcceptanceExecutionResult } =
    await import("../../../scripts/stage1-clean-acceptance-baseline-core.mjs");
  const legacy = fakeContext("legacy");
  const runner = fakeContext("runner");

  const legacyDry = await legacy.executeBaseline(executorInput(legacy, "dry-run"));
  const legacyApply = await legacy.executeBaseline(
    executorInput(legacy, "apply", legacyDry.manifest, legacyDry.manifestSha256)
  );
  const plan = await planCleanAcceptanceBaseline(runner, INPUT);
  const postState = await applyCleanAcceptanceBaseline(runner, {
    input: INPUT,
    planDigest: deterministicPlanDigest(plan)
  });

  assert.deepEqual(runner.targetPrisma.state, legacy.targetPrisma.state);
  assert.deepEqual(normalizeStage1CleanAcceptanceExecutionResult(legacyApply), {
    auditCreated: 1,
    deleted: 0,
    inserted: 4,
    manifestSha256: plan.identity.manifestSha256,
    mode: "apply",
    safe: true,
    updated: 0
  });
  assert.equal(postState.commandId, "stage1.clean-acceptance.baseline");
  assert.equal(
    postState.postconditions.every(({ status }) => status === "PASSED"),
    true
  );
  assert.deepEqual(
    runner.calls.map(({ mode, confirmation }) => ({ mode, confirmation })),
    [
      { mode: "dry-run", confirmation: undefined },
      { mode: "dry-run", confirmation: undefined },
      { mode: "apply", confirmation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY" }
    ]
  );
});

test("recomputes the manifest and rejects TOCTOU drift before writes", async () => {
  const { applyCleanAcceptanceBaseline, planCleanAcceptanceBaseline } =
    await import("../src/commands/stage1-clean-acceptance-baseline.mjs");
  const context = fakeContext("drift");
  const plan = await planCleanAcceptanceBaseline(context, INPUT);
  context.sourcePrisma.state.revision = "changed-after-approval";

  await assert.rejects(
    () =>
      applyCleanAcceptanceBaseline(context, {
        input: INPUT,
        planDigest: deterministicPlanDigest(plan)
      }),
    { code: "PLAN_CHANGED_SINCE_APPROVAL" }
  );
  assert.deepEqual(context.targetPrisma.state, { inserted: 0, auditCreated: 0 });
});

test("reconciles an after-commit unknown result without duplicate side effects", async () => {
  const { planCleanAcceptanceBaseline, reconcileCleanAcceptanceBaseline } =
    await import("../src/commands/stage1-clean-acceptance-baseline.mjs");
  const context = fakeContext("unknown");
  const plan = await planCleanAcceptanceBaseline(context, INPUT);
  const planDigest = deterministicPlanDigest(plan);

  await context.executeBaseline(
    executorInput(context, "apply", plan.identity.manifest, plan.identity.manifestSha256)
  );
  const before = structuredClone(context.targetPrisma.state);
  const reconciliation = await reconcileCleanAcceptanceBaseline(context, {
    input: INPUT,
    planDigest,
    approvedPlan: plan
  });

  assert.equal(reconciliation.result.mode, "replay");
  assert.equal(reconciliation.result.inserted, 0);
  assert.equal(reconciliation.postconditions[0].status, "PASSED");
  assert.deepEqual(context.targetPrisma.state, before);
});

test("propagates a pre-commit failure without writing an audit fact", async () => {
  const { applyCleanAcceptanceBaseline, planCleanAcceptanceBaseline } =
    await import("../src/commands/stage1-clean-acceptance-baseline.mjs");
  const context = fakeContext("failure");
  const baseExecute = context.executeBaseline;
  const plan = await planCleanAcceptanceBaseline(context, INPUT);
  context.executeBaseline = async (options) => {
    if (options.mode === "apply") {
      throw Object.assign(new Error("INJECTED_BEFORE_COMMIT"), {
        code: "INJECTED_BEFORE_COMMIT"
      });
    }
    return baseExecute(options);
  };

  await assert.rejects(
    () =>
      applyCleanAcceptanceBaseline(context, {
        input: INPUT,
        planDigest: deterministicPlanDigest(plan)
      }),
    { code: "INJECTED_BEFORE_COMMIT" }
  );
  assert.deepEqual(context.targetPrisma.state, { inserted: 0, auditCreated: 0 });
});

function fakeContext(label) {
  const context = {
    label,
    calls: [],
    sourceDatabaseIdentityFingerprint: INPUT.sourceDatabaseIdentityFingerprint,
    databaseIdentityFingerprint: INPUT.databaseIdentityFingerprint,
    sourcePrisma: fakePrisma({ revision: "source-v1" }),
    targetPrisma: fakePrisma({ inserted: 0, auditCreated: 0 }),
    now: () => new Date("2026-09-02T10:00:00.000Z")
  };
  context.executeBaseline = async (options) => {
    context.calls.push({ mode: options.mode, confirmation: options.runnerConfirmation });
    const manifest = fakeManifest(context);
    const manifestSha256 = hash(manifest);
    if (options.mode === "dry-run") {
      return {
        mode: "dry-run",
        safe: true,
        manifest,
        manifestSha256,
        targetCountEvidence: { forbiddenCounts: {}, tableCounts: {} }
      };
    }
    if (
      options.runnerConfirmation !== "STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY" ||
      options.approvedManifestSha256 !== manifestSha256 ||
      hash(options.approvedManifest) !== manifestSha256
    ) {
      throw Object.assign(new Error("MANIFEST_STALE"), { code: "MANIFEST_STALE" });
    }
    if (options.mode === "apply") {
      if (context.targetPrisma.state.inserted !== 0) {
        throw Object.assign(new Error("MANIFEST_STALE"), { code: "MANIFEST_STALE" });
      }
      context.targetPrisma.state.inserted = 4;
      context.targetPrisma.state.auditCreated = 1;
      return result("apply", manifestSha256, 4, 1);
    }
    if (
      options.mode !== "replay" ||
      context.targetPrisma.state.inserted !== 4 ||
      context.targetPrisma.state.auditCreated !== 1
    ) {
      throw Object.assign(new Error("MANIFEST_STALE"), { code: "MANIFEST_STALE" });
    }
    return result("replay", manifestSha256, 0, 0);
  };
  return context;
}

function fakePrisma(state) {
  return { state, $transaction: async (callback) => callback({}) };
}

function fakeManifest(context) {
  return {
    schemaVersion: 1,
    operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
    generatedAt: INPUT.generatedAt,
    gitSha: INPUT.gitSha,
    imageRef: INPUT.imageRef,
    hashSalt: INPUT.hashSalt,
    sourceRevision: context.sourcePrisma.state.revision,
    selectionDigest: hash(INPUT.selection),
    counts: { access: 1, customer: 1, catalog: 1, templates: 0, vehicle: 1 },
    rowDigests: {},
    exceptions: [],
    safeToApply: true
  };
}

function executorInput(context, mode, approvedManifest, approvedManifestSha256) {
  return {
    mode,
    sourcePrisma: context.sourcePrisma,
    targetPrisma: context.targetPrisma,
    selection: INPUT.selection,
    generatedAt: INPUT.generatedAt,
    hashSalt: INPUT.hashSalt,
    gitSha: INPUT.gitSha,
    imageRef: INPUT.imageRef,
    approvedManifest,
    approvedManifestSha256,
    runnerConfirmation: mode === "dry-run" ? undefined : "STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY"
  };
}

function result(mode, manifestSha256, inserted, auditCreated) {
  return {
    auditCreated,
    deleted: 0,
    inserted,
    manifestSha256,
    mode,
    safe: true,
    updated: 0
  };
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
