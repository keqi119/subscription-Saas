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
  expiresAt: spec.expiresAt,
  ci: { repository: "keqi119/subscription-Saas", runId: "123", runAttempt: 1 }
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
const publicEvidence = {
  schemaVersion: "source-gate-evidence.v1",
  sourceSha: spec.sourceSha,
  migrationCatalogDigest: d("5"),
  repositoryContractDigest: d("6"),
  databaseTestManifestDigest: d("7"),
  databaseTestDiscoveryDigest: d("8"),
  postgres: { imageDigest: d("9"), serverVersionNum: "170006" },
  chain: "fresh",
  counts: {
    collected: 2,
    selected: 2,
    executed: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
    todo: 0,
    filtered: 0,
    cancelled: 0
  },
  terminalStatus: "PASSED",
  schemaDiffDigest: d("a"),
  migrationStatusDigest: d("b"),
  postSchemaDigest: d("c"),
  sanitizedLogDigest: d("d"),
  provenance: {
    generatedAt: "2026-10-01T00:00:00.000Z",
    ciRunRef: "github://keqi119/subscription-Saas/actions/runs/123/attempts/1",
    executorVersion: "manual-r3-source-database-gate.v1"
  }
};
const sourceGateEvidenceBytes = encodeManualJson(publicEvidence);

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
  const bytes = encodeR3Closed({ request, sessionBytes, sourceGateEvidenceBytes });
  assert.deepEqual(decodeR3Closed({ bytes, request }).sessionBytes, sessionBytes);
  assert.deepEqual(
    decodeR3Closed({ bytes, request }).sourceGateEvidenceBytes,
    sourceGateEvidenceBytes
  );
  assert.equal(decodeR3Closed({ bytes, request }).resultDigest, execution.resultDigest);
  assert.throws(() => encodeR3Closed({ request, sessionBytes }));
  for (const mutate of [
    (value) => {
      value.sourceSha = "0".repeat(40);
    },
    (value) => {
      value.chain = "snapshot";
    },
    (value) => {
      value.provenance.ciRunRef = "github://keqi119/subscription-Saas/actions/runs/456/attempts/1";
    },
    (value) => {
      value.counts.filtered = 1;
    },
    (value) => {
      value.terminalStatus = "FAILED";
    }
  ]) {
    const value = structuredClone(publicEvidence);
    mutate(value);
    assert.throws(() =>
      encodeR3Closed({ request, sessionBytes, sourceGateEvidenceBytes: encodeManualJson(value) })
    );
  }
  const changedProjection = JSON.parse(bytes);
  changedProjection.sourceGateEvidenceDigest = d("0");
  assert.throws(() => decodeR3Closed({ bytes: encodeManualJson(changedProjection), request }));
  assert.throws(() =>
    encodeR3Closed({
      request,
      sourceGateEvidenceBytes,
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
    sourceGateEvidenceBytes,
    sessionBytes: encodeManualJson({ ...session, recordedAt: "2099-01-01T00:00:00.000Z" })
  });
  assert.throws(() => decodeR3ClosedReceived({ bytes: receipt, request, closedBytes: changed }));
});
