import {
  assertManualHandoffDecision,
  computeManualClusterFingerprint,
  encodeManualJson,
  sha256Canonical,
  validateContract,
  validateManualRunnerRequest
} from "@subscription-saas/release-foundation";

import { runnerError } from "./error-codes.mjs";
import { commandHandlers } from "./command-handlers.mjs";
import { loadCommandRegistry, registeredCommand } from "./command-registry.mjs";
import { observeManualTarget } from "./manual-target-observer.mjs";
import { planMigration, applyMigration } from "./commands/db-migrate-deploy.mjs";
import { verifySchema } from "./commands/db-schema-verify.mjs";

function same(left, right) {
  return sha256Canonical(left) === sha256Canonical(right);
}

export function buildManualBaseline({
  trustedBuildDecision,
  request,
  targetObservation,
  roleObservation,
  preState,
  authorizationDigest
}) {
  if (!request) throw runnerError("MANUAL_EVIDENCE_INPUT_REQUIRED");
  validateManualRunnerRequest(request);
  validateContract("manual-runner-evidence.v1", targetObservation);
  if (
    request.stage !== "target-observe" ||
    targetObservation.kind !== "observation" ||
    targetObservation.requestDigest !== sha256Canonical(request) ||
    [
      "profileDigest",
      "sessionId",
      "sessionNonce",
      "operationId",
      "idempotencyKey",
      "attemptId",
      "runId"
    ].some((field) => targetObservation[field] !== request[field]) ||
    targetObservation.processEvidenceDigest !== null ||
    targetObservation.schema !== null ||
    targetObservation.physicalIdentity.endpointPolicyId !== request.targetIntent.endpointPolicyId ||
    targetObservation.physicalIdentity.databaseName !== request.targetIntent.databaseName ||
    !same(targetObservation.roleObservation, roleObservation) ||
    !same(targetObservation.catalog, preState) ||
    targetObservation.roleObservation.schemaObservationDigest !== sha256Canonical(preState) ||
    typeof trustedBuildDecision?.buildProofDigest !== "string"
  )
    throw runnerError("MANUAL_EVIDENCE_BINDING_MISMATCH");
  const baseline = {
    schemaVersion: "manual-baseline-manifest.v1",
    identity: {
      buildProofDigest: trustedBuildDecision.buildProofDigest,
      purpose: request.purpose,
      targetObservationDigest: sha256Canonical(targetObservation),
      physicalIdentity: targetObservation.physicalIdentity,
      roleObservation: targetObservation.roleObservation,
      preStateDigest: sha256Canonical(preState),
      authorizationDigest
    },
    createdAt: new Date().toISOString(),
    promotionEligible: false
  };
  validateContract("manual-baseline-manifest.v1", baseline);
  encodeManualJson(baseline);
  return Object.freeze(baseline);
}

function assertBaseline(request, baseline) {
  validateContract("manual-baseline-manifest.v1", baseline);
  if (
    request.baselineManifestDigest !== sha256Canonical(baseline) ||
    request.domainInput.baselineManifestIdentityDigest !== sha256Canonical(baseline.identity) ||
    request.purpose !== baseline.identity.purpose ||
    request.buildProofDigest !== baseline.identity.buildProofDigest ||
    request.targetObservationDigest !== baseline.identity.targetObservationDigest ||
    !same(request.physicalIdentity, baseline.identity.physicalIdentity)
  )
    throw runnerError("MANUAL_EVIDENCE_BINDING_MISMATCH");
}

function assertDecision(request, decision) {
  assertManualHandoffDecision(decision);
  if (
    decision.requestDigest !== sha256Canonical(request) ||
    decision.profileDigest !== request.profileDigest ||
    decision.containerId !== request.containerId ||
    decision.runnerImageDigest !== request.runnerImageDigest ||
    decision.childChallenge !== request.childChallenge
  )
    throw runnerError("MANUAL_EVIDENCE_BINDING_MISMATCH");
}

function assertManualContext(request, baseline, runtime) {
  const manual = runtime?.manualContext;
  if (!manual?.endpointPolicy || !manual?.approvedClusterObservation || !manual.processEvidence) {
    throw runnerError("MANUAL_EVIDENCE_INPUT_REQUIRED");
  }
  const approved = manual.approvedClusterObservation;
  let clusterFingerprint;
  try {
    clusterFingerprint = computeManualClusterFingerprint(approved.cluster);
  } catch {
    throw runnerError("MANUAL_CLUSTER_IDENTITY_MISMATCH");
  }
  if (
    !approved.h3Approval?.digest ||
    !approved.h3Readback?.digest ||
    approved.databaseOid !== request.physicalIdentity.databaseOid ||
    clusterFingerprint !== request.physicalIdentity.clusterFingerprint ||
    approved.runId !== request.runId ||
    approved.profileDigest !== request.profileDigest ||
    !same(approved.targetIntent, request.targetIntent) ||
    !same(baseline.identity.physicalIdentity, request.physicalIdentity)
  )
    throw runnerError("MANUAL_CLUSTER_IDENTITY_MISMATCH");
  return manual;
}

function time(runtime) {
  return (runtime.now?.() ?? new Date()).toISOString();
}

function failureReason(error) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
    ? error.code
    : "MANUAL_COMMAND_FAILED";
}

function completedObservation(runtime, observation) {
  if (observation === null) return null;
  const completedAt = time(runtime);
  const completed = {
    ...observation,
    recordedAt: completedAt,
    observedAt: completedAt,
    processEvidenceDigest: sha256Canonical(runtime.manualContext.processEvidence)
  };
  validateContract("manual-runner-evidence.v1", completed);
  encodeManualJson(completed);
  return Object.freeze(completed);
}

function resultFor(request, runtime, startedAt, outcome, reasonCode, plan, postState, observation) {
  const process = runtime.manualContext.processEvidence,
    completedAt = time(runtime);
  const result = {
    schemaVersion: "manual-runner-evidence.v1",
    recordedAt: completedAt,
    promotionEligible: false,
    kind: "manual-command-result",
    profileDigest: request.profileDigest,
    sessionId: request.sessionId,
    sessionNonce: request.sessionNonce,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    attemptId: request.attemptId,
    runId: request.runId,
    requestDigest: sha256Canonical(request),
    phaseKey: request.phase,
    attemptAllocationDigest: request.attemptAllocationDigest,
    startedAt,
    finishedAt: completedAt,
    outcome,
    reasonCode,
    plan,
    postState,
    observationDigest: observation ? sha256Canonical(observation) : null,
    processEvidenceDigest: sha256Canonical(process),
    statements: Array.isArray(runtime.statementLog) ? [...runtime.statementLog] : [],
    originalExecutionRecordDigest: ["replay", "reconcile"].includes(request.phase)
      ? request.predecessorExecutionRecordDigest
      : null
  };
  validateContract("manual-runner-evidence.v1", result);
  encodeManualJson(result);
  return Object.freeze(result);
}

export async function executeManualCommand(input) {
  assertManualHandoffDecision(input?.decision);
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 5 ||
    ["request", "decision", "baseline", "database", "runtime"].some(
      (key) => !Object.hasOwn(input, key)
    )
  )
    throw runnerError("MANUAL_COMMAND_INPUT_INVALID");
  const { request, decision, baseline, database, runtime } = input;
  validateManualRunnerRequest(request);
  if (
    request.stage !== "runner-command" ||
    !["db.migrate.deploy@1", "db.schema.verify@1"].includes(
      `${request.commandId}@${request.commandVersion}`
    )
  ) {
    throw runnerError("RUNNER_COMMAND_NOT_REGISTERED");
  }
  const commandKey = `${request.commandId}@${request.commandVersion}`;
  registeredCommand(await loadCommandRegistry(), commandKey);
  if (!commandHandlers.has(commandKey)) throw runnerError("RUNNER_HANDLER_MISSING");
  assertDecision(request, decision);
  assertBaseline(request, baseline);
  const manual = assertManualContext(request, baseline, runtime);
  if (database !== runtime || typeof database?.observeIdentity !== "function") {
    throw runnerError("RUNNER_DATABASE_ADAPTER_UNAVAILABLE");
  }
  const startedAt = time(runtime);
  let plan = null,
    postState = null,
    observation = null;
  try {
    const actual = await database.observeIdentity();
    if (
      actual.databaseName !== request.physicalIdentity.databaseName ||
      String(actual.databaseOid) !== request.physicalIdentity.databaseOid ||
      actual.role !== request.roleObservation.role ||
      actual.tls !== true ||
      database.databaseIdentityFingerprint !== request.domainInput.databaseIdentityFingerprint
    )
      throw runnerError("MANUAL_CLUSTER_IDENTITY_MISMATCH");

    observation = await observeManualTarget({
      request,
      database,
      endpointPolicy: manual.endpointPolicy,
      approvedClusterObservation: manual.approvedClusterObservation
    });
    if (
      ["dry-run", "apply"].includes(request.phase) &&
      sha256Canonical(observation.catalog) !== baseline.identity.preStateDigest
    ) {
      throw runnerError("MANUAL_BASELINE_STATE_CHANGED");
    }
    if (request.phase === "dry-run") {
      const candidate = await planMigration(runtime, request.domainInput);
      resultFor(request, runtime, startedAt, "RETURNED", null, candidate, null, observation);
      plan = candidate;
    } else if (request.phase === "apply") {
      const candidatePostState = await applyMigration(
        runtime,
        {
          input: request.domainInput,
          planDigest: request.approvedPlanDigest
        },
        {
          executionIdentity: {
            operationId: request.operationId,
            attemptId: request.attemptId,
            runId: request.runId
          }
        }
      );
      resultFor(
        request,
        runtime,
        startedAt,
        "RETURNED",
        null,
        null,
        candidatePostState,
        observation
      );
      postState = candidatePostState;
      const current = await observeManualTarget({
        request,
        database,
        endpointPolicy: manual.endpointPolicy,
        approvedClusterObservation: manual.approvedClusterObservation
      });
      observation = current;
      const schema = await verifySchema(runtime, request.domainInput);
      const candidate = { ...current, schema };
      validateContract("manual-runner-evidence.v1", candidate);
      encodeManualJson(candidate);
      observation = Object.freeze(candidate);
    } else {
      const schema = await verifySchema(runtime, request.domainInput);
      const candidate = { ...observation, schema };
      validateContract("manual-runner-evidence.v1", candidate);
      encodeManualJson(candidate);
      observation = Object.freeze(candidate);
    }
    observation = completedObservation(runtime, observation);
    const result = resultFor(
      request,
      runtime,
      startedAt,
      "RETURNED",
      null,
      plan,
      postState,
      observation
    );
    return { result, observation };
  } catch (error) {
    observation = completedObservation(runtime, observation);
    const result = resultFor(
      request,
      runtime,
      startedAt,
      "THREW",
      failureReason(error),
      plan,
      postState,
      observation
    );
    return { result, observation };
  }
}
