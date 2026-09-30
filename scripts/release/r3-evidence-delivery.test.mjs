import test from "node:test";
import assert from "node:assert/strict";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import {
  r3EvidenceScope,
  encodeR3CleanupRequest,
  decodeR3CleanupRequest,
  encodeR3CleanupImported,
  decodeR3CleanupImported,
  encodeR3Closed,
  decodeR3Closed,
  encodeR3ClosedReceived,
  decodeR3ClosedReceived
} from "./r3-evidence-delivery.mjs";

const d = (character) => `sha256:${character.repeat(64)}`;
const operationRef = "123e4567-e89b-42d3-a456-426614174000";
const sessionId = "123e4567-e89b-42d3-a456-426614174001";
const sessionNonce = "a".repeat(64);
const spec = {
  operationRef,
  profileDigest: d("1"),
  ownerId: "owner",
  sourceSha: "b".repeat(40),
  buildProofDigest: d("2"),
  targetPolicyDigest: d("3"),
  phase: "source",
  chain: "fresh",
  expiresAt: "2099-01-01T00:00:00.000Z"
};
const specBytes = encodeManualJson(spec);
const job = {
  operationRef,
  creationSpecDigest: sha256Bytes(specBytes),
  profileDigest: spec.profileDigest,
  ownerId: spec.ownerId,
  sourceSha: spec.sourceSha,
  buildProofDigest: spec.buildProofDigest,
  phase: spec.phase,
  chain: spec.chain,
  expiresAt: spec.expiresAt
};
const jobBytes = encodeManualJson(job);
const scope = r3EvidenceScope({ creationSpecBytes: specBytes, jobAdmissionBytes: jobBytes });
const execution = {
  schemaVersion: "manual-operation-record.v3",
  kind: "execution",
  stage: "candidate-use",
  status: "SUCCEEDED",
  promotionEligible: false,
  operationId: operationRef,
  profileDigest: spec.profileDigest,
  sessionId,
  sessionNonce,
  resultDigest: d("4"),
  reasonCode: null
};
const executionBytes = encodeManualJson(execution);
const acknowledgement = {
  schemaVersion: "manual-operation-record.v3",
  kind: "custody",
  purpose: "owner-acknowledgement",
  outcome: "MATCH",
  promotionEligible: false,
  ownerId: spec.ownerId,
  profileDigest: spec.profileDigest,
  subjectDigest: sha256Bytes(executionBytes),
  observedDigest: sha256Bytes(executionBytes),
  reasonCode: null
};
const acknowledgementBytes = encodeManualJson(acknowledgement);

test("cleanup request carries exact terminal and owner acknowledgement records", () => {
  const bytes = encodeR3CleanupRequest({ scope, executionBytes, acknowledgementBytes });
  const decoded = decodeR3CleanupRequest({ bytes, scope });
  assert.deepEqual(decoded.executionBytes, executionBytes);
  assert.deepEqual(decoded.acknowledgementBytes, acknowledgementBytes);
  assert.equal(decoded.executionDigest, sha256Bytes(executionBytes));
  assert.equal(decoded.sessionId, sessionId);
  assert.equal(decoded.sessionNonce, sessionNonce);
});

test("foreign terminal and wrong ACK subject cannot request cleanup", () => {
  const foreign = encodeManualJson({
    ...execution,
    operationId: "123e4567-e89b-42d3-a456-426614174099"
  });
  assert.throws(() =>
    encodeR3CleanupRequest({ scope, executionBytes: foreign, acknowledgementBytes })
  );
  const wrongAck = encodeManualJson({ ...acknowledgement, subjectDigest: d("5") });
  assert.throws(() =>
    encodeR3CleanupRequest({ scope, executionBytes, acknowledgementBytes: wrongAck })
  );
});

test("cleanup imported binds the same session and cleanup bundle digest", () => {
  const request = decodeR3CleanupRequest({
    bytes: encodeR3CleanupRequest({ scope, executionBytes, acknowledgementBytes }),
    scope
  });
  const bundleDigest = d("6");
  const bytes = encodeR3CleanupImported({ request, bundleDigest });
  assert.equal(
    decodeR3CleanupImported({ bytes, request, bundleDigest }).bundleDigest,
    bundleDigest
  );
  assert.throws(() => decodeR3CleanupImported({ bytes, request, bundleDigest: d("7") }));
});

test("CLOSED message requires matching actual session record", () => {
  const request = decodeR3CleanupRequest({
    bytes: encodeR3CleanupRequest({ scope, executionBytes, acknowledgementBytes }),
    scope
  });
  const session = {
    schemaVersion: "manual-operation-record.v3",
    kind: "session",
    status: "CLOSED",
    reasonCode: null,
    promotionEligible: false,
    profileDigest: spec.profileDigest,
    ownerId: spec.ownerId,
    sessionId,
    sessionNonce,
    scope: {
      targetPolicyDigest: spec.targetPolicyDigest,
      creationSpecDigest: sha256Bytes(specBytes),
      jobAdmissionDigest: sha256Bytes(jobBytes),
      buildProofDigest: spec.buildProofDigest,
      sourceSha: spec.sourceSha,
      phase: spec.phase,
      chain: spec.chain
    }
  };
  const sessionBytes = encodeManualJson(session);
  const bytes = encodeR3Closed({ request, sessionBytes });
  assert.deepEqual(decodeR3Closed({ bytes, request }).sessionBytes, sessionBytes);
  assert.throws(() =>
    encodeR3Closed({
      request,
      sessionBytes: encodeManualJson({ ...session, status: "INTERRUPTED_UNKNOWN" })
    })
  );
  const receipt = encodeR3ClosedReceived({ request, closedBytes: bytes });
  assert.equal(
    decodeR3ClosedReceived({ bytes: receipt, request, closedBytes: bytes }).closedDigest,
    sha256Bytes(bytes)
  );
  const changed = encodeR3Closed({
    request,
    sessionBytes: encodeManualJson({ ...session, recordedAt: "2099-01-01T00:00:00.000Z" })
  });
  assert.throws(() => decodeR3ClosedReceived({ bytes: receipt, request, closedBytes: changed }));
});
