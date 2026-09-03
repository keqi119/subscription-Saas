import {
  buildPostStateObservation,
  deterministicPlanDigest,
  sha256Canonical
} from "@subscription-saas/release-foundation";

import { hashStage1cPeriodBackfillClassification } from "../../../../scripts/stage1c-period-backfill-core.mjs";
import { executeStage1cPeriodBackfill } from "../../../../scripts/stage1c-period-backfill-executor.mjs";
import { runnerError } from "../error-codes.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function database(context) {
  return context?.prisma ?? context;
}

function assertContext(context, input) {
  if (
    typeof (context?.executeBackfill ?? executeStage1cPeriodBackfill) !== "function" ||
    typeof database(context)?.$transaction !== "function" ||
    !DIGEST.test(context?.databaseIdentityFingerprint ?? "")
  ) {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING");
  }
  if (context.databaseIdentityFingerprint !== input?.databaseIdentityFingerprint) {
    throw runnerError("RUNNER_DATABASE_IDENTITY_MISMATCH");
  }
}

function postcondition(id, expected, actual) {
  const expectedDigest = sha256Canonical(expected);
  const actualDigest = sha256Canonical(actual);
  return Object.freeze({
    id,
    status: expectedDigest === actualDigest ? "PASSED" : "FAILED",
    expectedDigest,
    actualDigest
  });
}

function createdPeriods(classification) {
  return (classification?.subscriptionPeriods ?? [])
    .filter(({ disposition }) => disposition === "CREATE")
    .map(({ orderId, sourceKey, payload }) => ({
      orderId,
      sourceKey,
      payloadDigest: sha256Canonical(payload)
    }));
}

function reconciledPeriods(classification, candidates) {
  const expected = candidates.map(({ sourceKey }) => sourceKey).sort();
  const actual = (classification?.subscriptionPeriods ?? [])
    .filter(
      ({ disposition, sourceKey }) => disposition === "UNCHANGED" && expected.includes(sourceKey)
    )
    .map(({ sourceKey }) => sourceKey)
    .sort();
  const blockers = [
    ...(classification?.ambiguities ?? []),
    ...(classification?.overlaps ?? []),
    ...(classification?.segmentOmissions ?? []),
    ...(classification?.invariantViolations ?? [])
  ];
  return {
    expected,
    actual,
    complete:
      blockers.length === 0 &&
      !(classification?.subscriptionPeriods ?? []).some(({ disposition }) =>
        ["CREATE", "CONFLICT"].includes(disposition)
      ) &&
      JSON.stringify(expected) === JSON.stringify(actual)
  };
}

function postCommitUnknown(error) {
  const cause = error instanceof Error ? error : new Error("PERIOD_BACKFILL_POST_STATE_UNKNOWN");
  cause.outcomeUnknown = true;
  cause.commitState = "committed-result-unproved";
  return cause;
}

export async function planPeriodBackfill(context, input) {
  assertContext(context, input);
  const executeBackfill = context.executeBackfill ?? executeStage1cPeriodBackfill;
  const outcome = await executeBackfill({
    mode: "dry-run",
    generatedAt: input.generatedAt,
    prisma: database(context)
  });
  const classification = outcome?.report?.classification;
  if (!classification || !Array.isArray(classification.subscriptionPeriods)) {
    throw runnerError("PERIOD_BACKFILL_PLAN_INVALID");
  }
  const candidates = createdPeriods(classification);
  return deepFreeze({
    schemaVersion: "deterministic-plan.v1",
    identity: {
      planType: "stage1-period-backfill-plan.v1",
      commandKey: "stage1.period.backfill@1",
      inputDigest: sha256Canonical(input),
      databaseIdentityFingerprint: input.databaseIdentityFingerprint,
      baselineManifestIdentityDigest: input.baselineManifestIdentityDigest,
      baselineManifestDigest: input.baselineManifestDigest,
      classificationDigest: hashStage1cPeriodBackfillClassification(classification),
      safeToApply: outcome.report.safeToApply === true,
      candidates,
      expectedWrites: { periodsInserted: candidates.length, auditsCreated: candidates.length }
    },
    provenance: { planner: "stage1.period.backfill@1", generatedAt: input.generatedAt }
  });
}

function assertApprovedPlan(plan, planDigest) {
  if (
    plan?.identity?.commandKey !== "stage1.period.backfill@1" ||
    deterministicPlanDigest(plan) !== planDigest
  ) {
    throw runnerError("APPROVED_PLAN_INVALID");
  }
}

export async function applyPeriodBackfill(context, approved) {
  const currentPlan = await planPeriodBackfill(context, approved.input);
  const currentPlanDigest = deterministicPlanDigest(currentPlan);
  if (currentPlanDigest !== approved.planDigest) throw runnerError("PLAN_CHANGED_SINCE_APPROVAL");
  if (!currentPlan.identity.safeToApply) throw runnerError("PERIOD_BACKFILL_BLOCKED");
  const executeBackfill = context.executeBackfill ?? executeStage1cPeriodBackfill;
  let outcome;
  try {
    outcome = await executeBackfill({
      mode: "apply",
      generatedAt: approved.input.generatedAt,
      prisma: database(context),
      expectedClassificationDigest: currentPlan.identity.classificationDigest
    });
  } catch (error) {
    if (error?.code === "STAGE1C_PERIOD_BACKFILL_PLAN_CHANGED") {
      throw runnerError("PLAN_CHANGED_SINCE_APPROVAL");
    }
    throw error;
  }
  const expected = currentPlan.identity.expectedWrites;
  const actual = {
    periodsInserted: outcome?.report?.applied?.inserted,
    auditsCreated: outcome?.report?.applied?.inserted
  };
  let afterApply;
  try {
    afterApply = await executeBackfill({
      mode: "dry-run",
      generatedAt: approved.input.generatedAt,
      prisma: database(context)
    });
  } catch (error) {
    throw postCommitUnknown(error);
  }
  const reconciled = reconciledPeriods(
    afterApply?.report?.classification,
    currentPlan.identity.candidates
  );
  if (!reconciled.complete) throw postCommitUnknown();
  const postconditions = [
    postcondition(
      "approved-period-set-recomputed-under-lock",
      approved.planDigest,
      currentPlanDigest
    ),
    postcondition("expected-periods-inserted", expected.periodsInserted, actual.periodsInserted),
    postcondition("expected-audits-created", expected.auditsCreated, actual.auditsCreated),
    postcondition("no-period-overlap", 0, afterApply.report.classification.overlaps.length),
    postcondition(
      "no-multiple-current-period",
      0,
      afterApply.report.classification.counters.oneOrderMultipleCurrentAnomalies
    ),
    postcondition("candidate-set-unchanged-after-apply", reconciled.expected, reconciled.actual)
  ];
  if (postconditions.some(({ status }) => status !== "PASSED")) {
    throw postCommitUnknown(runnerError("PERIOD_BACKFILL_POSTCONDITION_FAILED"));
  }
  return buildPostStateObservation({
    operationId: approved.input.operationId,
    attemptId: approved.input.attemptId,
    runId: approved.input.runId,
    baselineManifestIdentityDigest: approved.input.baselineManifestIdentityDigest,
    baselineManifestDigest: approved.input.baselineManifestDigest,
    commandId: "stage1.period.backfill",
    commandVersion: "1",
    planDigest: approved.planDigest,
    databaseIdentityFingerprint: approved.input.databaseIdentityFingerprint,
    postMigrationHead: approved.input.postMigrationHead,
    postSchemaDigest: approved.input.expectedSchemaDigest,
    configurationFingerprint: sha256Canonical({
      classificationDigest: currentPlan.identity.classificationDigest,
      writes: actual
    }),
    postconditions,
    observedAt: (context.now?.() ?? new Date()).toISOString()
  });
}

export async function reconcilePeriodBackfill(context, prior) {
  assertContext(context, prior.input);
  assertApprovedPlan(prior.approvedPlan, prior.planDigest);
  const executeBackfill = context.executeBackfill ?? executeStage1cPeriodBackfill;
  const outcome = await executeBackfill({
    mode: "dry-run",
    generatedAt: prior.input.generatedAt,
    prisma: database(context)
  });
  const reconciled = reconciledPeriods(
    outcome?.report?.classification,
    prior.approvedPlan.identity.candidates
  );
  if (!reconciled.complete) throw runnerError("PERIOD_BACKFILL_RECONCILE_INCOMPLETE");
  return deepFreeze({
    schemaVersion: "stage1-period-backfill-reconcile-result.v1",
    planDigest: prior.planDigest,
    postconditions: [
      postcondition("replay-has-no-duplicate-side-effects", reconciled.expected, reconciled.actual)
    ],
    terminalStatus: "PASSED"
  });
}

export async function stage1PeriodBackfillHandler({ baseline, request, database: context }) {
  if (request.phase === "dry-run") {
    const plan = await planPeriodBackfill(context, request.input);
    return Object.freeze({
      baseline,
      plan,
      planDigest: deterministicPlanDigest(plan),
      terminalStatus: "PASSED"
    });
  }
  if (request.phase === "apply") {
    const postStateObservation = await applyPeriodBackfill(context, {
      input: request.input,
      planDigest: request.planDigest
    });
    return Object.freeze({ baseline, postStateObservation, terminalStatus: "PASSED" });
  }
  if (request.phase === "replay" || request.phase === "reconcile") {
    const reconciliation = await reconcilePeriodBackfill(context, {
      input: request.input,
      planDigest: request.planDigest,
      approvedPlan: request.approvedPlan
    });
    return Object.freeze({ baseline, reconciliation, terminalStatus: "PASSED" });
  }
  throw runnerError("RUNNER_COMMAND_PHASE_UNSUPPORTED");
}
