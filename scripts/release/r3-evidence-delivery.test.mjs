import test from "node:test";
import assert from "node:assert/strict";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
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

function finalClosedFixture() {
  const finalScope = { ...scope, phase: "final" };
  const finalExecution = {
    ...execution,
    attemptId: "123e4567-e89b-42d3-a456-426614174003",
    requestDigest: d("e")
  };
  const finalExecutionBytes = encodeManualJson(finalExecution);
  const finalAcknowledgementBytes = encodeManualJson({
    ...acknowledgement,
    subjectDigest: sha256Bytes(finalExecutionBytes),
    observedDigest: sha256Bytes(finalExecutionBytes)
  });
  const request = decodeR3CleanupRequest({
    scope: finalScope,
    bytes: encodeR3CleanupRequest({
      scope: finalScope,
      executionBytes: finalExecutionBytes,
      acknowledgementBytes: finalAcknowledgementBytes
    })
  });
  const sessionBytes = encodeManualJson({
    schemaVersion: "manual-operation-record.v3",
    kind: "session",
    status: "CLOSED",
    reasonCode: null,
    promotionEligible: false,
    profileDigest: spec.profileDigest,
    ownerId: spec.ownerId,
    sessionId,
    sessionNonce,
    recordedAt: "2026-10-01T00:00:00.000Z",
    scope: {
      targetPolicyDigest: spec.targetPolicyDigest,
      creationSpecDigest: scope.creationSpecDigest,
      jobAdmissionDigest: scope.jobAdmissionDigest,
      buildProofDigest: spec.buildProofDigest,
      sourceSha: spec.sourceSha,
      phase: "final",
      chain: "fresh"
    }
  });
  const manifestDigest = d("f");
  const browserTraceDigest = d("a");
  const webClient = {
    schemaVersion: "web-public-api-evidence.v1",
    operationId: operationRef,
    buildProofDigest: spec.buildProofDigest,
    manifestDigest,
    publicApiBase: "https://api.example.test/api",
    webOrigin: "http://web:3000",
    embeddedApiBase: "https://api.example.test/api",
    actualRequestUrl: "https://api.example.test/api/portal/catalog/model-definitions",
    corsAllowOrigin: "http://web:3000",
    responseStatus: 200,
    bundleContainsEmbeddedApiBase: true,
    mockedNetwork: false,
    traceDigest: browserTraceDigest,
    observedAt: "2026-10-01T00:00:00.000Z"
  };
  webClient.evidenceDigest = sha256Canonical(webClient);
  const native = {
    requestDigest: finalExecution.requestDigest,
    terminalExecutionDigest: sha256Bytes(finalExecutionBytes),
    resultDigest: finalExecution.resultDigest,
    readbackDigest: d("1"),
    reconstructedDigest: d("2"),
    originalSetDigest: d("3"),
    originalCustodyRecordDigests: ["1", "2", "3", "4", "5", "6"].map(d),
    sourceOriginalDigest: d("4"),
    applicationOriginalDigest: d("5"),
    applicationReconstructedDigest: d("6"),
    runtimeDigest: d("7"),
    migrationObservationsDigest: d("8"),
    destination: {
      admissionDigest: d("1"),
      creationEvidenceDigest: d("2"),
      targetPlanDigest: d("3"),
      engineId: "engine-1",
      containerId: "c".repeat(64),
      systemIdentifier: "123456789",
      imageDigest: d("9"),
      serverVersionNum: "170006"
    },
    applicationAssessmentDigest: d("9"),
    browserTraceDigest,
    acknowledgementDigest: sha256Bytes(finalAcknowledgementBytes),
    cleanupObservationDigest: d("b"),
    cleanupBundleDigest: d("c"),
    cleanupCustodyRecordDigests: ["0", "1", "2", "3", "4", "5", "6", "7"].map(d),
    closedSessionDigest: sha256Bytes(sessionBytes),
    previousSessionRecordDigest: d("d")
  };
  const runId = "123e4567-e89b-42d3-a456-426614174002";
  const attemptId = "123e4567-e89b-42d3-a456-426614174003";
  const sourceGateEvidenceDigest = d("5");
  const evidence = {
    schemaVersion: "final-native-evidence.v1",
    chain: "fresh",
    terminalStatus: "PASSED",
    sourceSha: spec.sourceSha,
    buildProofDigest: spec.buildProofDigest,
    releaseImages: Object.fromEntries(
      ["api", "web", "runner"].map((name) => [
        name,
        `ghcr.io/keqi119/subscription-${name}@${d("1")}`
      ])
    ),
    contracts: {
      migrationCatalogDigest: d("5"),
      repositoryContractDigest: d("6"),
      databaseTestManifestDigest: d("7"),
      databaseTestDiscoveryDigest: d("8"),
      postgresImageDigest: d("9"),
      snapshotMetadataDigest: null
    },
    sourceGateEvidenceDigest,
    operationId: operationRef,
    runId,
    attemptId,
    manifestDigest,
    manifestIdentityDigest: d("0"),
    databaseIdentityFingerprint: d("1"),
    apiSessionNonceDigest: d("2"),
    databaseTests: { reportDigest: d("3"), counts: publicEvidence.counts },
    apiReadiness: {
      healthStatus: 200,
      catalogStatus: 200,
      applicationName: "subscription-api/r3-123/aaa",
      databaseOid: "1001",
      runtimeRole: "api_role",
      tls: true,
      sessionState: "idle",
      evidenceDigest: d("4")
    },
    webClient,
    native,
    attemptHistory: {
      schemaVersion: "final-native-attempt-history.v1",
      profileDigest: spec.profileDigest,
      ownerId: spec.ownerId,
      chain: "fresh",
      sourceSha: spec.sourceSha,
      buildProofDigest: spec.buildProofDigest,
      matchingSourceEvidenceDigest: d("6"),
      sourceGateEvidenceDigest,
      ci: {
        repository: "keqi119/subscription-Saas",
        runId: "123",
        runAttempt: 1,
        workflowPath: ".github/workflows/release-final-chain.yml",
        callerWorkflowPath: ".github/workflows/release-candidate-gate.yml",
        jobId: "456"
      },
      matchingRequestDigests: [finalExecution.requestDigest],
      selected: {
        operationId: operationRef,
        runId,
        attemptId,
        sessionId,
        sessionNonceDigest: sha256Bytes(Buffer.from(sessionNonce, "utf8")),
        requestDigest: finalExecution.requestDigest,
        initialExecutionDigest: d("7"),
        terminalExecutionDigest: native.terminalExecutionDigest,
        resultDigest: native.resultDigest,
        acknowledgementRecordDigest: native.acknowledgementDigest,
        cleanupObservationRecordDigest: native.cleanupObservationDigest,
        closedSessionRecordDigest: native.closedSessionDigest
      },
      verifiedAt: "2026-10-01T00:00:01.000Z"
    },
    producedAt: "2026-10-01T00:00:00.000Z"
  };
  return { request, sessionBytes, finalNativeEvidenceBytes: encodeManualJson(evidence), evidence };
}

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

test("final CLOSED requires native evidence in the same notice", () => {
  const sourceRequest = decodeR3CleanupRequest({
    bytes: encodeR3CleanupRequest({ scope, executionBytes, acknowledgementBytes }),
    scope
  });
  const request = { ...sourceRequest, phase: "final" };
  const sessionBytes = encodeManualJson({
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
      creationSpecDigest: scope.creationSpecDigest,
      jobAdmissionDigest: scope.jobAdmissionDigest,
      buildProofDigest: spec.buildProofDigest,
      sourceSha: spec.sourceSha,
      phase: "final",
      chain: "fresh"
    }
  });
  assert.throws(() => encodeR3Closed({ request, sessionBytes }));
});

test("final CLOSED round-trips authenticated native evidence and both request representations", () => {
  const input = finalClosedFixture();
  const closedBytes = encodeR3Closed(input);
  const decoded = decodeR3Closed({ bytes: closedBytes, request: input.request });
  assert.deepEqual(decoded.finalNativeEvidenceBytes, input.finalNativeEvidenceBytes);
  assert.notEqual(decoded.finalNativeEvidenceBytes, input.finalNativeEvidenceBytes);
  assert.equal(decoded.finalNativeEvidenceDigest, sha256Bytes(input.finalNativeEvidenceBytes));
  const { executionBytes: heldExecution, acknowledgementBytes: heldAck, ...fields } = input.request;
  const h1Request = {
    ...fields,
    execution: JSON.parse(heldExecution),
    acknowledgement: JSON.parse(heldAck)
  };
  assert.deepEqual(encodeR3Closed({ ...input, request: h1Request }), closedBytes);
  decoded.finalNativeEvidenceBytes.fill(0);
  assert.deepEqual(
    decodeR3Closed({ bytes: closedBytes, request: input.request }).finalNativeEvidenceBytes,
    input.finalNativeEvidenceBytes
  );
  for (const change of [
    (value) => (value.native.requestDigest = d("0")),
    (value) => (value.native.terminalExecutionDigest = d("0")),
    (value) => (value.native.acknowledgementDigest = d("0")),
    (value) => (value.native.closedSessionDigest = d("0")),
    (value) => (value.sourceSha = "0".repeat(40)),
    (value) => (value.attemptHistory.ci.runId = "999")
  ]) {
    const altered = JSON.parse(input.finalNativeEvidenceBytes);
    change(altered);
    assert.throws(() =>
      encodeR3Closed({ ...input, finalNativeEvidenceBytes: encodeManualJson(altered) })
    );
  }
  const tamperedNotice = JSON.parse(closedBytes);
  tamperedNotice.finalNativeEvidenceDigest = d("0");
  assert.throws(() =>
    decodeR3Closed({ bytes: encodeManualJson(tamperedNotice), request: input.request })
  );
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
  assert.throws(() =>
    encodeR3Closed({
      request,
      sessionBytes,
      sourceGateEvidenceBytes,
      finalNativeEvidenceBytes: Buffer.from("{}")
    })
  );
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
  const metadata = {
    schemaVersion: "snapshot-metadata.v1",
    dumpDigest: d("1"),
    sourceMigrationHead: "20260925091000_stage1_operational_completion_settlement_guard",
    sourcePrivilegeObservationDigest: d("2"),
    sourceFingerprintBeforeDigest: d("3"),
    sourceFingerprintAfterDigest: d("3"),
    sanitizationContractDigest: d("4"),
    ownershipMapDigest: d("5"),
    ownershipContractVersion: "1",
    scanDigest: d("6"),
    scanSubjectDigest: d("1"),
    exportToolVersion: "fixture.v1",
    scanToolVersion: "fixture.v1",
    createdAt: "2026-09-27T00:00:00.000Z",
    reviewAt: "2026-09-27T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    owner: "owner",
    readers: ["reader"],
    accessPolicyRef: "fixture-policy",
    workflowRunRef: "fixture-run"
  };
  const snapshotMetadataBytes = encodeManualJson(metadata);
  const snapshotGate = {
    ...publicEvidence,
    chain: "snapshot",
    snapshot: {
      snapshotMetadataDigest: sha256Bytes(snapshotMetadataBytes),
      snapshotBundleDigest: d("7"),
      sourceMigrationHead: metadata.sourceMigrationHead,
      ownershipMapDigest: metadata.ownershipMapDigest,
      ownershipObservationDigest: d("8")
    }
  };
  const snapshotRequest = { ...request, chain: "snapshot" };
  const snapshotInput = {
    request: snapshotRequest,
    sessionBytes: encodeManualJson({ ...session, scope: { ...session.scope, chain: "snapshot" } }),
    sourceGateEvidenceBytes: encodeManualJson(snapshotGate),
    snapshotMetadataBytes
  };
  const snapshotClosed = encodeR3Closed(snapshotInput);
  const snapshotDecoded = decodeR3Closed({ bytes: snapshotClosed, request: snapshotRequest });
  assert.deepEqual(snapshotDecoded.snapshotMetadataBytes, snapshotMetadataBytes);
  assert.deepEqual(snapshotDecoded.sourceGateEvidence, snapshotGate);
  assert.equal(snapshotDecoded.snapshotMetadataDigest, sha256Bytes(snapshotMetadataBytes));
  assert.throws(() => encodeR3Closed({ ...snapshotInput, snapshotMetadataBytes: undefined }));
  assert.throws(() =>
    encodeR3Closed({ request, sessionBytes, sourceGateEvidenceBytes, snapshotMetadataBytes })
  );
  assert.throws(() =>
    encodeR3Closed({
      ...snapshotInput,
      snapshotMetadataBytes: encodeManualJson({ ...metadata, owner: "different" })
    })
  );
  assert.throws(() =>
    encodeR3Closed({
      ...snapshotInput,
      snapshotMetadataBytes: Buffer.from(JSON.stringify(metadata))
    })
  );
  for (const field of ["snapshotMetadataDigest", "snapshotMetadata"]) {
    const changed = JSON.parse(snapshotClosed);
    if (field === "snapshotMetadata") changed.snapshotMetadata.owner = "different";
    else changed[field] = d("0");
    assert.throws(() =>
      decodeR3Closed({ bytes: encodeManualJson(changed), request: snapshotRequest })
    );
  }
  const snapshotReceipt = encodeR3ClosedReceived({
    request: snapshotRequest,
    closedBytes: snapshotClosed
  });
  assert.equal(
    decodeR3ClosedReceived({
      bytes: snapshotReceipt,
      request: snapshotRequest,
      closedBytes: snapshotClosed
    }).closedDigest,
    sha256Bytes(snapshotClosed)
  );
  const otherMetadata = encodeManualJson({ ...metadata, owner: "different" });
  const changedSnapshotClosed = encodeR3Closed({
    ...snapshotInput,
    snapshotMetadataBytes: otherMetadata,
    sourceGateEvidenceBytes: encodeManualJson({
      ...snapshotGate,
      snapshot: { ...snapshotGate.snapshot, snapshotMetadataDigest: sha256Bytes(otherMetadata) }
    })
  });
  assert.throws(() =>
    decodeR3ClosedReceived({
      bytes: snapshotReceipt,
      request: snapshotRequest,
      closedBytes: changedSnapshotClosed
    })
  );
});
