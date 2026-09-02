import {
  buildPostStateObservation,
  deterministicPlanDigest,
  sha256Canonical
} from "@subscription-saas/release-foundation";

import {
  STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET as REGISTERED_TARGET,
  assertStage1StagingInvalidTestOrderRetirementTarget,
  hashStage1StagingInvalidTestOrderRetirementClassification
} from "../../../../scripts/stage1-staging-invalid-test-order-retirement-core.mjs";
import { executeStage1StagingInvalidTestOrderRetirement } from "../../../../scripts/stage1-staging-invalid-test-order-retirement-executor.mjs";
import { runnerError } from "../error-codes.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DDL = /\b(?:ALTER|CREATE|DROP|GRANT|REVOKE|COMMENT|VACUUM|REINDEX|CLUSTER)\b/iu;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function prisma(context) {
  return context?.prisma ?? context;
}

function refuse(details) {
  throw runnerError("INVALID_TEST_ORDER_TARGET_REFUSED", details);
}

function assertExactTarget(target) {
  try {
    assertStage1StagingInvalidTestOrderRetirementTarget(target);
  } catch (error) {
    refuse({ cause: error?.message ?? "TARGET_MISMATCH" });
  }
}

function assertContext(context, input) {
  assertExactTarget(input?.target);
  if (
    typeof (context?.executeRetirement ?? executeStage1StagingInvalidTestOrderRetirement) !==
      "function" ||
    typeof prisma(context)?.$transaction !== "function" ||
    !Array.isArray(context?.statementLog) ||
    !DIGEST.test(context?.databaseIdentityFingerprint ?? "") ||
    !UUID.test(input?.operatorId ?? "")
  ) {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING");
  }
  if (context.databaseIdentityFingerprint !== input?.databaseIdentityFingerprint) {
    throw runnerError("RUNNER_DATABASE_IDENTITY_MISMATCH");
  }
}

function executionOptions(context, input, mode, expectedEvidenceDigest) {
  return {
    assertDatabaseIdentity: context.assertDatabaseIdentity ?? (async () => undefined),
    classify: context.classifyRetirement,
    expectedEvidenceDigest,
    generatedAt: input.generatedAt,
    loadSnapshot: context.loadRetirementSnapshot,
    mode,
    now: context.now,
    operatorId: input.operatorId,
    prisma: prisma(context),
    randomUuid: context.randomUuid,
    statementLog: context.statementLog
  };
}

function expectedWrites(disposition) {
  const count = disposition === "CANDIDATE" ? 1 : 0;
  return Object.freeze({
    auditsCreated: count * 4,
    billingSchedulesUpdated: count,
    leasesUpdated: count,
    ordersUpdated: count,
    vehiclesUpdated: count
  });
}

function assertClassification(outcome) {
  const classification = outcome?.report?.classification;
  if (
    outcome?.report?.mode !== "dry-run" ||
    !classification ||
    !["CANDIDATE", "UNCHANGED", "BLOCKED"].includes(classification.disposition) ||
    !RAW_SHA256.test(classification.evidenceDigest ?? "")
  ) {
    throw runnerError("INVALID_TEST_ORDER_RETIREMENT_PLAN_INVALID");
  }
  if (classification.disposition === "BLOCKED" || outcome.report.safeToApply !== true) {
    refuse({ blockers: classification.blockers ?? [] });
  }
  if (classification.disposition === "CANDIDATE") {
    const candidate = classification.candidate;
    if (
      candidate?.orderId !== REGISTERED_TARGET.orderId ||
      candidate?.vehicleId !== REGISTERED_TARGET.vehicleId ||
      candidate?.ownership?.orderId !== REGISTERED_TARGET.orderId ||
      candidate?.ownership?.vehicleId !== REGISTERED_TARGET.vehicleId ||
      !Number.isInteger(candidate?.versions?.billingSchedule)
    ) {
      refuse({ cause: "CANDIDATE_IDENTITY_OR_VERSION_INVALID" });
    }
  }
  return classification;
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

function assertNoDdl(statements) {
  const offending = statements.filter((statement) => DDL.test(String(statement)));
  if (offending.length > 0) {
    throw runnerError("INVALID_TEST_ORDER_RETIREMENT_DDL_FORBIDDEN", {
      statementDigests: offending.map((statement) => sha256Canonical(String(statement)))
    });
  }
  return statements;
}

export async function planInvalidTestOrderRetirement(context, input) {
  assertContext(context, input);
  const executeRetirement =
    context.executeRetirement ?? executeStage1StagingInvalidTestOrderRetirement;
  const outcome = await executeRetirement(executionOptions(context, input, "dry-run", undefined));
  const classification = assertClassification(outcome);
  const candidate = classification.candidate;
  return deepFreeze({
    schemaVersion: "deterministic-plan.v1",
    identity: {
      planType: "stage1-invalid-test-order-retirement-plan.v1",
      commandKey: "stage1.invalid-test-order.retire@1",
      inputDigest: sha256Canonical(input),
      databaseIdentityFingerprint: input.databaseIdentityFingerprint,
      baselineManifestIdentityDigest: input.baselineManifestIdentityDigest,
      baselineManifestDigest: input.baselineManifestDigest,
      target: { ...REGISTERED_TARGET },
      operatorId: input.operatorId,
      classificationDigest:
        hashStage1StagingInvalidTestOrderRetirementClassification(classification),
      evidenceDigest: classification.evidenceDigest,
      disposition: classification.disposition,
      ownership: candidate?.ownership ?? {
        orderId: REGISTERED_TARGET.orderId,
        vehicleId: REGISTERED_TARGET.vehicleId
      },
      versions: candidate?.versions ?? null,
      transitions: candidate?.transitions ?? null,
      expectedWrites: expectedWrites(classification.disposition)
    },
    provenance: {
      planner: "stage1.invalid-test-order.retire@1",
      generatedAt: input.generatedAt
    }
  });
}

function assertApprovedPlan(plan, planDigest) {
  if (
    plan?.schemaVersion !== "deterministic-plan.v1" ||
    plan?.identity?.commandKey !== "stage1.invalid-test-order.retire@1" ||
    deterministicPlanDigest(plan) !== planDigest
  ) {
    throw runnerError("APPROVED_PLAN_INVALID");
  }
}

function postCommitUnknown(error) {
  const cause =
    error instanceof Error ? error : new Error("INVALID_TEST_ORDER_RETIREMENT_POST_STATE_UNKNOWN");
  cause.outcomeUnknown = true;
  cause.commitState = "committed-result-unproved";
  return cause;
}

function actualWrites(outcome) {
  return {
    auditsCreated: outcome?.report?.applied?.auditsCreated,
    billingSchedulesUpdated: outcome?.report?.applied?.billingSchedulesUpdated,
    leasesUpdated: outcome?.report?.applied?.leasesUpdated,
    ordersUpdated: outcome?.report?.applied?.ordersUpdated,
    vehiclesUpdated: outcome?.report?.applied?.vehiclesUpdated
  };
}

function terminalClassificationMatches(classification, approvedPlan) {
  return (
    classification?.disposition === "UNCHANGED" &&
    classification?.evidenceDigest === approvedPlan.identity.evidenceDigest &&
    Array.isArray(classification?.blockers) &&
    classification.blockers.length === 0
  );
}

export async function applyInvalidTestOrderRetirement(context, approved) {
  assertExactTarget(approved?.input?.target);
  let currentPlan;
  try {
    currentPlan = await planInvalidTestOrderRetirement(context, approved.input);
  } catch (error) {
    if (error?.code === "INVALID_TEST_ORDER_TARGET_REFUSED") {
      throw runnerError("PLAN_CHANGED_SINCE_APPROVAL", { cause: error.code });
    }
    throw error;
  }
  const currentPlanDigest = deterministicPlanDigest(currentPlan);
  if (currentPlanDigest !== approved.planDigest) {
    throw runnerError("PLAN_CHANGED_SINCE_APPROVAL", {
      approvedPlanDigest: approved.planDigest,
      currentPlanDigest
    });
  }
  const executeRetirement =
    context.executeRetirement ?? executeStage1StagingInvalidTestOrderRetirement;
  const statementsBefore = context.statementLog.length;
  let outcome;
  try {
    outcome = await executeRetirement(
      executionOptions(context, approved.input, "apply", currentPlan.identity.evidenceDigest)
    );
  } catch (error) {
    if (error?.message?.includes("EVIDENCE_DIGEST_MISMATCH")) {
      throw runnerError("PLAN_CHANGED_SINCE_APPROVAL");
    }
    throw error;
  }
  const operationStatements = context.statementLog.slice(statementsBefore);
  try {
    assertNoDdl(operationStatements);
  } catch (error) {
    throw postCommitUnknown(error);
  }
  const actual = actualWrites(outcome);
  const expected = currentPlan.identity.expectedWrites;
  let afterApply;
  try {
    afterApply = await executeRetirement(
      executionOptions(context, approved.input, "dry-run", undefined)
    );
  } catch (error) {
    throw postCommitUnknown(error);
  }
  if (!terminalClassificationMatches(afterApply?.report?.classification, currentPlan)) {
    throw postCommitUnknown(runnerError("INVALID_TEST_ORDER_RETIREMENT_POSTCONDITION_FAILED"));
  }
  const postconditions = [
    postcondition(
      "approved-exact-target-recomputed-under-lock",
      approved.planDigest,
      currentPlanDigest
    ),
    postcondition(
      "order-vehicle-ownership-and-version-unchanged",
      true,
      outcome?.report?.safeToApply
    ),
    postcondition("exact-close-and-release-effects-applied", expected, actual),
    postcondition(
      "exactly-four-correlated-audits-present",
      expected.auditsCreated,
      actual.auditsCreated
    ),
    postcondition(
      "statement-log-has-no-ddl",
      [],
      operationStatements.filter((sql) => DDL.test(String(sql)))
    ),
    postcondition("terminal-retirement-state-observed", true, true)
  ];
  if (postconditions.some(({ status }) => status !== "PASSED")) {
    throw postCommitUnknown(runnerError("INVALID_TEST_ORDER_RETIREMENT_POSTCONDITION_FAILED"));
  }
  return buildPostStateObservation({
    operationId: approved.input.operationId,
    attemptId: approved.input.attemptId,
    runId: approved.input.runId,
    baselineManifestIdentityDigest: approved.input.baselineManifestIdentityDigest,
    baselineManifestDigest: approved.input.baselineManifestDigest,
    commandId: "stage1.invalid-test-order.retire",
    commandVersion: "1",
    planDigest: approved.planDigest,
    databaseIdentityFingerprint: approved.input.databaseIdentityFingerprint,
    postMigrationHead: approved.input.postMigrationHead,
    postSchemaDigest: approved.input.expectedSchemaDigest,
    configurationFingerprint: sha256Canonical({
      classificationDigest: currentPlan.identity.classificationDigest,
      evidenceDigest: currentPlan.identity.evidenceDigest,
      statementLogDigest: sha256Canonical(operationStatements),
      writes: actual
    }),
    postconditions,
    observedAt: (context.now?.() ?? new Date()).toISOString()
  });
}

export async function reconcileInvalidTestOrderRetirement(context, prior) {
  assertContext(context, prior.input);
  assertApprovedPlan(prior.approvedPlan, prior.planDigest);
  const executeRetirement =
    context.executeRetirement ?? executeStage1StagingInvalidTestOrderRetirement;
  const statementsBefore = context.statementLog.length;
  const outcome = await executeRetirement(
    executionOptions(context, prior.input, "dry-run", undefined)
  );
  assertNoDdl(context.statementLog.slice(statementsBefore));
  if (!terminalClassificationMatches(outcome?.report?.classification, prior.approvedPlan)) {
    throw runnerError("INVALID_TEST_ORDER_RETIREMENT_RECONCILE_INCOMPLETE");
  }
  return deepFreeze({
    schemaVersion: "stage1-invalid-test-order-retirement-reconcile-result.v1",
    planDigest: prior.planDigest,
    postconditions: [
      postcondition("replay-has-no-duplicate-side-effects", "UNCHANGED", "UNCHANGED")
    ],
    terminalStatus: "PASSED"
  });
}

export async function stage1InvalidTestOrderRetireHandler({ baseline, request, database }) {
  if (request.phase === "dry-run") {
    const plan = await planInvalidTestOrderRetirement(database, request.input);
    return Object.freeze({
      baseline,
      plan,
      planDigest: deterministicPlanDigest(plan),
      terminalStatus: "PASSED"
    });
  }
  if (request.phase === "apply") {
    const postStateObservation = await applyInvalidTestOrderRetirement(database, {
      input: request.input,
      planDigest: request.planDigest
    });
    return Object.freeze({ baseline, postStateObservation, terminalStatus: "PASSED" });
  }
  if (request.phase === "replay" || request.phase === "reconcile") {
    const reconciliation = await reconcileInvalidTestOrderRetirement(database, {
      input: request.input,
      planDigest: request.planDigest,
      approvedPlan: request.approvedPlan
    });
    return Object.freeze({ baseline, reconciliation, terminalStatus: "PASSED" });
  }
  throw runnerError("RUNNER_COMMAND_PHASE_UNSUPPORTED");
}
