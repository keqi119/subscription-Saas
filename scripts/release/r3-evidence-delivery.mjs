// Internal file-delivery notices. These records convey retained originals and
// their bindings; only the native holder can authorize the corresponding action.
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";

const CODE = "R3_EVIDENCE_DELIVERY_INVALID";
const LIMIT = 1048576;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (condition) => {
  if (!condition) fail();
};
const bound = (bytes) => Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMIT;
function parse(bytes) {
  need(bound(bytes));
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail();
  }
  need(value && typeof value === "object" && !Array.isArray(value));
  need(encodeManualJson(value).equals(bytes));
  return value;
}
function encoded(value) {
  const bytes = encodeManualJson(value);
  need(bound(bytes));
  return bytes;
}
function expiry(value) {
  need(
    typeof value === "string" &&
      Number.isFinite(Date.parse(value)) &&
      Date.now() < Date.parse(value)
  );
}
function scopeFields(scope) {
  need(scope && typeof scope === "object" && UUID.test(scope.operationRef));
  for (const field of [
    "profileDigest",
    "creationSpecDigest",
    "jobAdmissionDigest",
    "buildProofDigest",
    "targetPolicyDigest"
  ])
    need(DIGEST.test(scope[field]));
  need(
    typeof scope.ownerId === "string" &&
      scope.ownerId.length > 0 &&
      /^[0-9a-f]{40}$/u.test(scope.sourceSha) &&
      ["source", "final"].includes(scope.phase) &&
      ["fresh", "snapshot"].includes(scope.chain)
  );
  expiry(scope.expiresAt);
  need(
    /^github:\/\/keqi119\/subscription-Saas\/actions\/runs\/[1-9][0-9]*\/attempts\/1$/u.test(
      scope.ciRunRef
    )
  );
  return {
    operationRef: scope.operationRef,
    profileDigest: scope.profileDigest,
    ownerId: scope.ownerId,
    sourceSha: scope.sourceSha,
    buildProofDigest: scope.buildProofDigest,
    targetPolicyDigest: scope.targetPolicyDigest,
    creationSpecDigest: scope.creationSpecDigest,
    jobAdmissionDigest: scope.jobAdmissionDigest,
    phase: scope.phase,
    chain: scope.chain,
    expiresAt: scope.expiresAt,
    ciRunRef: scope.ciRunRef
  };
}
function sameScope(value, scope) {
  const expected = scopeFields(scope);
  need(Object.entries(expected).every(([field, item]) => value[field] === item));
}
function requestFields(request) {
  need(
    request?.schemaVersion === "manual-r3-evidence-delivery.v1" &&
      request.kind === "cleanup-request"
  );
  sameScope(request, request);
  need(UUID.test(request.sessionId) && /^[0-9a-f]{64}$/u.test(request.sessionNonce));
  need(
    DIGEST.test(request.executionDigest) &&
      DIGEST.test(request.acknowledgementDigest) &&
      DIGEST.test(request.resultDigest)
  );
  return {
    ...scopeFields(request),
    sessionId: request.sessionId,
    sessionNonce: request.sessionNonce,
    executionDigest: request.executionDigest,
    acknowledgementDigest: request.acknowledgementDigest,
    resultDigest: request.resultDigest
  };
}
function assertExecution(execution, scope) {
  need(
    execution.schemaVersion === "manual-operation-record.v3" &&
      execution.kind === "execution" &&
      execution.stage === "candidate-use" &&
      execution.status === "SUCCEEDED" &&
      execution.reasonCode === null &&
      execution.promotionEligible === false &&
      execution.operationId === scope.operationRef &&
      execution.profileDigest === scope.profileDigest &&
      UUID.test(execution.sessionId) &&
      /^[0-9a-f]{64}$/u.test(execution.sessionNonce) &&
      DIGEST.test(execution.resultDigest)
  );
}
function assertAcknowledgement(ack, execution, scope, executionDigest) {
  need(
    ack.schemaVersion === "manual-operation-record.v3" &&
      ack.kind === "custody" &&
      ack.purpose === "owner-acknowledgement" &&
      ack.outcome === "MATCH" &&
      ack.reasonCode === null &&
      ack.promotionEligible === false &&
      ack.ownerId === scope.ownerId &&
      ack.profileDigest === scope.profileDigest &&
      ack.subjectDigest === executionDigest &&
      ack.observedDigest === executionDigest
  );
  if (ack.recordedAt && execution.recordedAt)
    need(Date.parse(ack.recordedAt) >= Date.parse(execution.recordedAt));
}

export function r3EvidenceScope({ creationSpecBytes, jobAdmissionBytes }) {
  const spec = parse(creationSpecBytes),
    job = parse(jobAdmissionBytes);
  need(
    job.ci?.repository === "keqi119/subscription-Saas" &&
      job.ci.runAttempt === 1 &&
      /^[1-9][0-9]*$/u.test(job.ci.runId)
  );
  need(
    UUID.test(spec.operationRef) &&
      job.operationRef === spec.operationRef &&
      job.creationSpecDigest === sha256Bytes(creationSpecBytes) &&
      ["profileDigest", "ownerId", "sourceSha", "buildProofDigest", "phase", "chain"].every(
        (field) => job[field] === spec[field]
      )
  );
  const result = scopeFields({
    operationRef: spec.operationRef,
    profileDigest: spec.profileDigest,
    ownerId: spec.ownerId,
    sourceSha: spec.sourceSha,
    buildProofDigest: spec.buildProofDigest,
    targetPolicyDigest: spec.targetPolicyDigest,
    creationSpecDigest: sha256Bytes(creationSpecBytes),
    jobAdmissionDigest: sha256Bytes(jobAdmissionBytes),
    phase: spec.phase,
    chain: spec.chain,
    expiresAt: job.expiresAt,
    ciRunRef: `github://${job.ci.repository}/actions/runs/${job.ci.runId}/attempts/${job.ci.runAttempt}`
  });
  need(Date.parse(job.expiresAt) <= Date.parse(spec.expiresAt));
  return Object.freeze(result);
}

export function encodeR3CleanupRequest({ scope, executionBytes, acknowledgementBytes }) {
  const fields = scopeFields(scope);
  const execution = parse(executionBytes),
    acknowledgement = parse(acknowledgementBytes);
  assertExecution(execution, fields);
  const executionDigest = sha256Bytes(executionBytes);
  assertAcknowledgement(acknowledgement, execution, fields, executionDigest);
  return encoded({
    schemaVersion: "manual-r3-evidence-delivery.v1",
    kind: "cleanup-request",
    ...fields,
    sessionId: execution.sessionId,
    sessionNonce: execution.sessionNonce,
    executionDigest,
    resultDigest: execution.resultDigest,
    acknowledgementDigest: sha256Bytes(acknowledgementBytes),
    execution,
    acknowledgement
  });
}

export function decodeR3CleanupRequest({ bytes, scope }) {
  const value = parse(bytes);
  need(
    value.schemaVersion === "manual-r3-evidence-delivery.v1" && value.kind === "cleanup-request"
  );
  sameScope(value, scope);
  const executionBytes = encoded(value.execution),
    acknowledgementBytes = encoded(value.acknowledgement);
  need(encodeR3CleanupRequest({ scope, executionBytes, acknowledgementBytes }).equals(bytes));
  return Object.freeze({
    ...requestFields(value),
    executionBytes,
    acknowledgementBytes
  });
}

export function encodeR3CleanupImported({ request, bundleDigest }) {
  const fields = requestFields({
    schemaVersion: "manual-r3-evidence-delivery.v1",
    kind: "cleanup-request",
    ...request
  });
  need(DIGEST.test(bundleDigest));
  return encoded({
    schemaVersion: "manual-r3-evidence-delivery.v1",
    kind: "cleanup-imported",
    ...fields,
    bundleDigest
  });
}

export function decodeR3CleanupImported({ bytes, request, bundleDigest }) {
  const value = parse(bytes);
  need(value.kind === "cleanup-imported" && value.bundleDigest === bundleDigest);
  need(encodeR3CleanupImported({ request, bundleDigest }).equals(bytes));
  return Object.freeze(value);
}

export function encodeR3Closed({ request, sessionBytes, sourceGateEvidenceBytes }) {
  const fields = requestFields({
    schemaVersion: "manual-r3-evidence-delivery.v1",
    kind: "cleanup-request",
    ...request
  });
  const session = parse(sessionBytes);
  need(
    session.schemaVersion === "manual-operation-record.v3" &&
      session.kind === "session" &&
      session.status === "CLOSED" &&
      session.reasonCode === null &&
      session.promotionEligible === false &&
      session.profileDigest === fields.profileDigest &&
      session.ownerId === fields.ownerId &&
      session.sessionId === fields.sessionId &&
      session.sessionNonce === fields.sessionNonce &&
      session.scope &&
      [
        "targetPolicyDigest",
        "creationSpecDigest",
        "jobAdmissionDigest",
        "buildProofDigest",
        "sourceSha",
        "phase",
        "chain"
      ].every((field) => session.scope[field] === fields[field])
  );
  const freshSource = fields.phase === "source" && fields.chain === "fresh";
  let sourceGateEvidence;
  if (freshSource) {
    sourceGateEvidence = parse(sourceGateEvidenceBytes);
    try {
      validateContract("source-gate-evidence.v1", sourceGateEvidence);
    } catch {
      fail();
    }
    const gate = sourceGateEvidence,
      counts = gate.counts;
    need(
      gate.sourceSha === fields.sourceSha &&
        gate.chain === "fresh" &&
        gate.terminalStatus === "PASSED" &&
        gate.provenance.ciRunRef === fields.ciRunRef &&
        gate.provenance.executorVersion === "manual-r3-source-database-gate.v1" &&
        counts.executed > 0 &&
        counts.collected === counts.selected &&
        counts.selected === counts.executed &&
        counts.executed === counts.passed &&
        ["failed", "skipped", "todo", "filtered", "cancelled"].every((field) => counts[field] === 0)
    );
  } else need(sourceGateEvidenceBytes === undefined);
  return encoded({
    schemaVersion: "manual-r3-evidence-delivery.v1",
    kind: "closed",
    ...fields,
    ...(freshSource
      ? { sourceGateEvidenceDigest: sha256Bytes(sourceGateEvidenceBytes), sourceGateEvidence }
      : {}),
    sessionDigest: sha256Bytes(sessionBytes),
    session
  });
}

export function decodeR3Closed({ bytes, request }) {
  const value = parse(bytes);
  need(value.kind === "closed");
  const sessionBytes = encoded(value.session);
  const sourceGateEvidenceBytes = Object.hasOwn(value, "sourceGateEvidence")
    ? encoded(value.sourceGateEvidence)
    : undefined;
  need(encodeR3Closed({ request, sessionBytes, sourceGateEvidenceBytes }).equals(bytes));
  return Object.freeze({
    ...value,
    sessionBytes,
    ...(sourceGateEvidenceBytes ? { sourceGateEvidenceBytes } : {})
  });
}

// This only confirms the hosted holder read the precise CLOSED notice. It is
// not a release grant and it cannot substitute for either native original.
export function encodeR3ClosedReceived({ request, closedBytes }) {
  const closed = decodeR3Closed({ bytes: closedBytes, request });
  const fields = requestFields({
    schemaVersion: "manual-r3-evidence-delivery.v1",
    kind: "cleanup-request",
    ...request
  });
  return encoded({
    schemaVersion: "manual-r3-evidence-delivery.v1",
    kind: "closed-received",
    ...fields,
    sessionDigest: closed.sessionDigest,
    closedDigest: sha256Bytes(closedBytes)
  });
}

export function decodeR3ClosedReceived({ bytes, request, closedBytes }) {
  const value = parse(bytes);
  need(value.kind === "closed-received" && value.closedDigest === sha256Bytes(closedBytes));
  need(encodeR3ClosedReceived({ request, closedBytes }).equals(bytes));
  return Object.freeze(value);
}
