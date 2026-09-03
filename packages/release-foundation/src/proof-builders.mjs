import { canonicalJson } from "./canonical-json.mjs";
import { sha256Canonical } from "./digest.mjs";
import { validateContract } from "./schema-registry.mjs";

function proofError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function canonicalClone(value) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw proofError("PROOF_INPUT_INVALID", { cause: error?.code });
  }
}

function validateAndFreeze(schemaId, value) {
  try {
    validateContract(schemaId, value);
  } catch (error) {
    throw proofError("PROOF_CONTRACT_INVALID", { schemaId, cause: error?.code });
  }
  return deepFreeze(canonicalClone(value));
}

export function deterministicPlanDigest(plan) {
  if (
    plan === null ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    plan.schemaVersion !== "deterministic-plan.v1" ||
    plan.identity === null ||
    typeof plan.identity !== "object" ||
    Array.isArray(plan.identity) ||
    plan.provenance === null ||
    typeof plan.provenance !== "object" ||
    Array.isArray(plan.provenance) ||
    Object.keys(plan).some((key) => !["schemaVersion", "identity", "provenance"].includes(key))
  ) {
    throw proofError("DETERMINISTIC_PLAN_INVALID");
  }
  return sha256Canonical({
    schemaVersion: "deterministic-plan-digest.v1",
    identity: plan.identity
  });
}

export function buildPostStateObservation(input) {
  if (
    Object.prototype.hasOwnProperty.call(input ?? {}, "executionProofDigest") ||
    Object.prototype.hasOwnProperty.call(input ?? {}, "executionProof")
  ) {
    throw proofError("POST_STATE_FORWARD_REFERENCE_FORBIDDEN");
  }
  return validateAndFreeze("post-state-observation.v1", {
    schemaVersion: "post-state-observation.v1",
    ...input
  });
}

export function buildExecutionProof({ postStateObservation, ...input } = {}) {
  if (Object.prototype.hasOwnProperty.call(input, "postStateObservationDigest")) {
    throw proofError("EXECUTION_PROOF_DIGEST_OVERRIDE_FORBIDDEN");
  }
  try {
    validateContract("post-state-observation.v1", postStateObservation);
  } catch (error) {
    throw proofError("EXECUTION_PROOF_OBSERVATION_INVALID", { cause: error?.code });
  }
  if (
    ["PREFLIGHT_REJECTED", "INTERRUPTED_UNKNOWN"].includes(input.status) ||
    input.operationId !== postStateObservation.operationId ||
    input.attemptId !== postStateObservation.attemptId ||
    input.baselineManifestIdentityDigest !== postStateObservation.baselineManifestIdentityDigest ||
    input.baselineManifestDigest !== postStateObservation.baselineManifestDigest ||
    input.command?.id !== postStateObservation.commandId ||
    input.command?.version !== postStateObservation.commandVersion ||
    input.databaseIdentityFingerprint !== postStateObservation.databaseIdentityFingerprint ||
    input.planDigest !== postStateObservation.planDigest
  ) {
    throw proofError(
      ["PREFLIGHT_REJECTED", "INTERRUPTED_UNKNOWN"].includes(input.status)
        ? "EXECUTION_PROOF_STATUS_REQUIRES_LAUNCHER_RECORD"
        : "EXECUTION_PROOF_OBSERVATION_MISMATCH"
    );
  }
  const postconditionsPassed = postStateObservation.postconditions.every(
    ({ status }) => status === "PASSED"
  );
  if (
    (input.status === "SUCCEEDED" &&
      (!postconditionsPassed || input.postconditionsStatus !== "PASSED")) ||
    Date.parse(input.timing?.completedAt ?? "") < Date.parse(input.timing?.startedAt ?? "")
  ) {
    throw proofError("EXECUTION_PROOF_RESULT_INCONSISTENT");
  }
  return validateAndFreeze("execution-proof.v1", {
    schemaVersion: "execution-proof.v1",
    ...input,
    postStateObservationDigest: sha256Canonical(postStateObservation)
  });
}
