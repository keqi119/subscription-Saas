import {
  buildPostStateObservation,
  deterministicPlanDigest,
  sha256Canonical
} from "@subscription-saas/release-foundation";

import { normalizeStage1CleanAcceptanceExecutionResult } from "../../../../scripts/stage1-clean-acceptance-baseline-core.mjs";
import { executeStage1CleanAcceptanceBaseline } from "../../../../scripts/stage1-clean-acceptance-baseline-executor.mjs";
import { runnerError } from "../error-codes.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const LEGACY_CONFIRMATION = "STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function assertContext(context, input) {
  if (
    typeof (context?.executeBaseline ?? executeStage1CleanAcceptanceBaseline) !== "function" ||
    typeof context?.sourcePrisma?.$transaction !== "function" ||
    typeof context?.targetPrisma?.$transaction !== "function" ||
    !DIGEST.test(context.sourceDatabaseIdentityFingerprint ?? "") ||
    !DIGEST.test(context.databaseIdentityFingerprint ?? "")
  ) {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING");
  }
  if (
    context.sourceDatabaseIdentityFingerprint !== input?.sourceDatabaseIdentityFingerprint ||
    context.databaseIdentityFingerprint !== input?.databaseIdentityFingerprint
  ) {
    throw runnerError("RUNNER_DATABASE_IDENTITY_MISMATCH");
  }
}

function executorOptions(context, input, mode, approval) {
  return {
    mode,
    sourcePrisma: context.sourcePrisma,
    targetPrisma: context.targetPrisma,
    selection: input.selection,
    generatedAt: input.generatedAt,
    hashSalt: input.hashSalt,
    gitSha: input.gitSha,
    imageRef: input.imageRef,
    approvedManifest: approval?.manifest,
    approvedManifestSha256: approval?.manifestSha256,
    runnerConfirmation: mode === "dry-run" ? undefined : LEGACY_CONFIRMATION
  };
}

function totalCounts(counts = {}) {
  return Object.values(counts).reduce(
    (sum, count) => (Number.isSafeInteger(count) && count >= 0 ? sum + count : Number.NaN),
    0
  );
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

export async function planCleanAcceptanceBaseline(context, input) {
  assertContext(context, input);
  const executeBaseline = context.executeBaseline ?? executeStage1CleanAcceptanceBaseline;
  const dryRun = await executeBaseline(executorOptions(context, input, "dry-run"));
  if (
    dryRun?.mode !== "dry-run" ||
    typeof dryRun.manifest !== "object" ||
    dryRun.manifest === null ||
    !/^[0-9a-f]{64}$/.test(dryRun.manifestSha256 ?? "") ||
    dryRun.manifestSha256 !== dryRun.manifestSha256.toLowerCase()
  ) {
    throw runnerError("CLEAN_ACCEPTANCE_PLAN_INVALID");
  }
  const inserted = totalCounts(dryRun.manifest.counts);
  if (!Number.isSafeInteger(inserted)) throw runnerError("CLEAN_ACCEPTANCE_PLAN_INVALID");
  return deepFreeze({
    schemaVersion: "deterministic-plan.v1",
    identity: {
      planType: "stage1-clean-acceptance-baseline-plan.v1",
      commandKey: "stage1.clean-acceptance.baseline@1",
      inputDigest: sha256Canonical(input),
      sourceDatabaseIdentityFingerprint: input.sourceDatabaseIdentityFingerprint,
      databaseIdentityFingerprint: input.databaseIdentityFingerprint,
      baselineManifestIdentityDigest: input.baselineManifestIdentityDigest,
      baselineManifestDigest: input.baselineManifestDigest,
      manifest: dryRun.manifest,
      manifestSha256: dryRun.manifestSha256,
      safeToApply: dryRun.safe === true,
      expectedWrites: {
        inserted,
        updated: 0,
        deleted: 0,
        auditCreated: 1
      },
      targetCountEvidenceDigest: sha256Canonical(dryRun.targetCountEvidence ?? {})
    },
    provenance: {
      planner: "stage1.clean-acceptance.baseline@1",
      generatedAt: input.generatedAt
    }
  });
}

function assertApprovedPlan(approvedPlan, planDigest) {
  if (
    approvedPlan?.schemaVersion !== "deterministic-plan.v1" ||
    approvedPlan?.identity?.commandKey !== "stage1.clean-acceptance.baseline@1" ||
    deterministicPlanDigest(approvedPlan) !== planDigest
  ) {
    throw runnerError("APPROVED_PLAN_INVALID");
  }
}

export async function applyCleanAcceptanceBaseline(context, approved) {
  const currentPlan = await planCleanAcceptanceBaseline(context, approved.input);
  const currentPlanDigest = deterministicPlanDigest(currentPlan);
  if (currentPlanDigest !== approved.planDigest) {
    throw runnerError("PLAN_CHANGED_SINCE_APPROVAL", {
      approvedPlanDigest: approved.planDigest,
      currentPlanDigest
    });
  }
  if (currentPlan.identity.safeToApply !== true) {
    throw runnerError("MANIFEST_CLASSIFICATION_INVALID");
  }
  const executeBaseline = context.executeBaseline ?? executeStage1CleanAcceptanceBaseline;
  const rawResult = await executeBaseline(
    executorOptions(context, approved.input, "apply", {
      manifest: currentPlan.identity.manifest,
      manifestSha256: currentPlan.identity.manifestSha256
    })
  );
  const result = normalizeStage1CleanAcceptanceExecutionResult(rawResult);
  const expectedWrites = currentPlan.identity.expectedWrites;
  const actualWrites = {
    inserted: result.inserted,
    updated: result.updated,
    deleted: result.deleted,
    auditCreated: result.auditCreated
  };
  const postconditions = [
    postcondition("approved-plan-recomputed", approved.planDigest, currentPlanDigest),
    postcondition(
      "target-baseline-exact",
      currentPlan.identity.manifestSha256,
      result.manifestSha256
    ),
    postcondition("forbidden-domains-empty", true, result.safe),
    postcondition("one-baseline-audit-created", expectedWrites, actualWrites)
  ];
  if (postconditions.some(({ status }) => status !== "PASSED")) {
    throw runnerError("CLEAN_ACCEPTANCE_POSTCONDITION_FAILED");
  }
  return buildPostStateObservation({
    operationId: approved.input.operationId,
    attemptId: approved.input.attemptId,
    runId: approved.input.runId,
    baselineManifestIdentityDigest: approved.input.baselineManifestIdentityDigest,
    baselineManifestDigest: approved.input.baselineManifestDigest,
    commandId: "stage1.clean-acceptance.baseline",
    commandVersion: "1",
    planDigest: approved.planDigest,
    databaseIdentityFingerprint: approved.input.databaseIdentityFingerprint,
    postMigrationHead: approved.input.postMigrationHead,
    postSchemaDigest: approved.input.expectedSchemaDigest,
    configurationFingerprint: sha256Canonical({
      manifestSha256: result.manifestSha256,
      writes: actualWrites
    }),
    postconditions,
    observedAt: (context.now?.() ?? new Date()).toISOString()
  });
}

export async function reconcileCleanAcceptanceBaseline(context, prior) {
  assertContext(context, prior.input);
  assertApprovedPlan(prior.approvedPlan, prior.planDigest);
  const executeBaseline = context.executeBaseline ?? executeStage1CleanAcceptanceBaseline;
  const rawResult = await executeBaseline(
    executorOptions(context, prior.input, "replay", {
      manifest: prior.approvedPlan.identity.manifest,
      manifestSha256: prior.approvedPlan.identity.manifestSha256
    })
  );
  const result = normalizeStage1CleanAcceptanceExecutionResult(rawResult);
  if (result.mode !== "replay") throw runnerError("CLEAN_ACCEPTANCE_REPLAY_INVALID");
  return deepFreeze({
    schemaVersion: "stage1-clean-acceptance-reconcile-result.v1",
    planDigest: prior.planDigest,
    result,
    postconditions: [postcondition("replay-has-no-duplicate-side-effects", 0, result.inserted)],
    terminalStatus: "PASSED"
  });
}

export async function stage1CleanAcceptanceBaselineHandler({ baseline, request, database }) {
  if (request.phase === "dry-run") {
    const plan = await planCleanAcceptanceBaseline(database, request.input);
    return Object.freeze({
      baseline,
      plan,
      planDigest: deterministicPlanDigest(plan),
      terminalStatus: "PASSED"
    });
  }
  if (request.phase === "apply") {
    const postStateObservation = await applyCleanAcceptanceBaseline(database, {
      input: request.input,
      planDigest: request.planDigest
    });
    return Object.freeze({ baseline, postStateObservation, terminalStatus: "PASSED" });
  }
  if (request.phase === "replay" || request.phase === "reconcile") {
    const reconciliation = await reconcileCleanAcceptanceBaseline(database, {
      input: request.input,
      planDigest: request.planDigest,
      approvedPlan: request.approvedPlan
    });
    return Object.freeze({ baseline, reconciliation, terminalStatus: "PASSED" });
  }
  throw runnerError("RUNNER_COMMAND_PHASE_UNSUPPORTED");
}
