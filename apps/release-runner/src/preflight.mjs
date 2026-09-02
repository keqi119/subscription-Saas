import {
  assertApprovalDecision,
  sha256Canonical,
  validateContract
} from "@subscription-saas/release-foundation";

import { runnerError } from "./error-codes.mjs";
import { commandApprovalMode } from "./command-registry.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/;

export function verifyPreflight({ command, request, policy }) {
  if (!digestPattern.test(request.actualRunnerDigest ?? "")) {
    throw runnerError("RUNNER_IMAGE_IDENTITY_MUTABLE");
  }
  validateContract("build-proof.v1", request.buildProof);
  validateContract("launch-attestation.v1", request.launchAttestation);
  if (request.buildProofDigest !== sha256Canonical(request.buildProof)) {
    throw runnerError("RUNNER_BUILD_PROOF_DIGEST_MISMATCH");
  }
  if (command.prohibitedEnvironments.includes(request.environmentClass)) {
    throw runnerError("RUNNER_ENVIRONMENT_PROHIBITED");
  }
  if (
    !command.allowedEnvironments.includes(request.environmentClass) ||
    !policy.allowedEnvironments.includes(request.environmentClass)
  ) {
    throw runnerError("RUNNER_ENVIRONMENT_UNKNOWN");
  }
  if (command.capabilityProfile !== request.capabilityProfile) {
    throw runnerError("RUNNER_CAPABILITY_MISMATCH");
  }
  if (!command.allowedExecutionScopes?.includes(request.executionScope)) {
    throw runnerError("RUNNER_EXECUTION_SCOPE_PROHIBITED");
  }
  const proofRunner = request.buildProof.identity.images.runner;
  if (
    proofRunner.imageDigest !== request.actualRunnerDigest ||
    proofRunner.sourceRevision !== request.buildProof.identity.sourceSha
  ) {
    throw runnerError("RUNNER_DIGEST_MISMATCH");
  }
  const attestation = request.launchAttestation;
  if (
    attestation.buildProofDigest !== request.buildProofDigest ||
    attestation.runnerDigest !== request.actualRunnerDigest ||
    attestation.sourceSha !== request.buildProof.identity.sourceSha ||
    attestation.environmentClass !== request.environmentClass ||
    attestation.executionScope !== request.executionScope ||
    attestation.secretReference !== request.secretReference ||
    attestation.capability !== request.capabilityProfile ||
    attestation.commandId !== command.commandId ||
    attestation.commandVersion !== command.commandVersion
  ) {
    throw runnerError("RUNNER_LAUNCH_ATTESTATION_MISMATCH");
  }
  if (
    !policy.allowedHosts.includes(request.target.hostname) ||
    !new RegExp(policy.databaseNamePattern).test(request.target.databaseName) ||
    request.target.tlsMode !== policy.requiredTlsMode ||
    typeof request.secretReference !== "string" ||
    !new RegExp(policy.secretReferencePattern ?? "^secret://").test(request.secretReference)
  ) {
    throw runnerError("RUNNER_TARGET_POLICY_REJECTED");
  }
  return Object.freeze({
    status: "verified",
    commandKey: `${command.commandId}@${command.commandVersion}`,
    capabilityProfile: command.capabilityProfile,
    approvalMode: commandApprovalMode(command, request.environmentClass, request.phase),
    targetIntent: Object.freeze({ ...request.target })
  });
}

function verifyApprovalRequirement(command, request, decision, approvalDecision) {
  if (decision.approvalMode === "none") {
    const readOnlyDryRun = request.phase === "dry-run" && command.supports?.dryRun === true;
    if ((command.dataImpact !== "read-only" && !readOnlyDryRun) || approvalDecision !== undefined) {
      throw runnerError("RUNNER_APPROVAL_MODE_INVALID");
    }
    return;
  }
  try {
    assertApprovalDecision(approvalDecision);
  } catch (error) {
    throw runnerError("RUNNER_APPROVAL_REQUIRED", { cause: error?.code });
  }
}

export async function executeRegisteredCommand({
  command,
  request,
  policy,
  handler = async ({ baseline }) => ({ baseline, terminalStatus: "PASSED" }),
  readCredential,
  connectDatabase,
  credentialFileReference,
  approvalDecision
}) {
  const decision = verifyPreflight({ command, request, policy });
  verifyApprovalRequirement(command, request, decision, approvalDecision);
  const credential = await readCredential(credentialFileReference);
  const database = await connectDatabase({ credential, target: decision.targetIntent });
  const observed = await database.observeIdentity();
  if (
    observed.databaseName !== request.target.databaseName ||
    observed.role !== credential.username ||
    observed.tls !== true
  ) {
    throw runnerError("RUNNER_DATABASE_IDENTITY_MISMATCH");
  }
  const baseline = Object.freeze({
    schemaVersion: "runner-baseline-observation.v1",
    databaseName: observed.databaseName,
    databaseOid: String(observed.databaseOid),
    role: observed.role,
    tls: observed.tls,
    schemas: Object.freeze([...(observed.schemas ?? [])]),
    extensions: Object.freeze([...(observed.extensions ?? [])]),
    migrationHead: observed.migrationHead ?? null
  });
  return handler({ baseline, command, decision, request, database });
}
