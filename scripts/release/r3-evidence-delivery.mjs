// Internal file-delivery notices. These records convey retained originals and
// their bindings; only the native holder can authorize the corresponding action.
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";

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
    expiresAt: scope.expiresAt
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
  need(DIGEST.test(request.executionDigest) && DIGEST.test(request.acknowledgementDigest));
  return {
    ...scopeFields(request),
    sessionId: request.sessionId,
    sessionNonce: request.sessionNonce,
    executionDigest: request.executionDigest,
    acknowledgementDigest: request.acknowledgementDigest
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
    expiresAt: job.expiresAt
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

export function encodeR3Closed({ request, sessionBytes }) {
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
  return encoded({
    schemaVersion: "manual-r3-evidence-delivery.v1",
    kind: "closed",
    ...fields,
    sessionDigest: sha256Bytes(sessionBytes),
    session
  });
}

export function decodeR3Closed({ bytes, request }) {
  const value = parse(bytes);
  need(value.kind === "closed");
  const sessionBytes = encoded(value.session);
  need(encodeR3Closed({ request, sessionBytes }).equals(bytes));
  return Object.freeze({ ...value, sessionBytes });
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
