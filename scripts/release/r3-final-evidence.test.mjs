import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { buildR3FinalAcknowledgement } from "./r3-final-result.mjs";
import {
  assertIndependentNativeChainEvidence,
  buildR3FinalGateEvidence,
  validateR3FinalGateEvidence
} from "./r3-final-evidence.mjs";

const digest = (value) => sha256Canonical(value);
const uuid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const counts = () => ({
  collected: 1,
  selected: 1,
  executed: 1,
  passed: 1,
  failed: 0,
  skipped: 0,
  todo: 0,
  filtered: 0,
  cancelled: 0
});

function fixture(chain = "fresh", n = 1) {
  const operationId = uuid(n),
    sourceSha = "a".repeat(40);
  const buildProofDigest = digest("build");
  const sourceGateEvidence = {
    schemaVersion: "source-gate-evidence.v1",
    sourceSha,
    migrationCatalogDigest: digest("catalog"),
    repositoryContractDigest: digest("repository"),
    databaseTestManifestDigest: digest("manifest"),
    databaseTestDiscoveryDigest: digest("discovery"),
    postgres: { imageDigest: digest("postgres"), serverVersionNum: "170006" },
    chain,
    counts: counts(),
    terminalStatus: "PASSED",
    schemaDiffDigest: digest(`schema-diff-${n}`),
    migrationStatusDigest: digest(`migration-status-${n}`),
    postSchemaDigest: digest(`post-schema-${n}`),
    sanitizedLogDigest: digest(`source-log-${n}`),
    provenance: {
      generatedAt: "2026-09-29T00:00:00.000Z",
      ciRunRef: "github://keqi119/subscription-Saas/actions/runs/123/attempts/1",
      executorVersion: "manual-r3-source-database-gate.v1"
    },
    ...(chain === "snapshot"
      ? {
          snapshot: {
            snapshotMetadataDigest: digest("snapshot"),
            snapshotBundleDigest: digest("snapshot-bundle"),
            sourceMigrationHead: "20260927000000_source",
            ownershipMapDigest: digest("ownership-map"),
            ownershipObservationDigest: digest("ownership-observation")
          }
        }
      : {})
  };
  const request = {
    schemaVersion: "manual-runner-request.v5",
    profileDigest: digest("profile"),
    ownerId: "owner",
    sessionId: uuid(n + 10),
    sessionNonce: String(n).repeat(64),
    operationId,
    idempotencyKey: `r3-candidate-use:${operationId}`,
    attemptId: uuid(n + 20),
    runId: uuid(n + 30),
    attemptAllocationDigest: digest(`allocation-${n}`),
    stage: "candidate-use",
    capability: "execute-final-database-tests",
    purpose: "stage1-isolated-database-tests",
    phase: "final",
    chain,
    sourceSha,
    targetPolicyDigest: digest("policy"),
    creationSpecDigest: digest("spec"),
    jobAdmissionDigest: digest("job"),
    destinationAdmissionDigest: digest(`destination-${n}`),
    preparationExecutionRecordDigest: digest(`preparation-${n}`),
    databaseTestManifestDigest: sourceGateEvidence.databaseTestManifestDigest,
    matchingSourceEvidenceDigest: digest(`source-terminal-${n}`),
    candidate: { buildProofDigest }
  };
  const sourceClaims = {
    matchingSourceEvidenceDigest: request.matchingSourceEvidenceDigest,
    matchingSourceResultDigest: digest(`source-result-${n}`),
    expectedSchemaDigest: sourceGateEvidence.postSchemaDigest,
    sourceGateEvidenceDigest: digest(sourceGateEvidence)
  };
  const originals = ["source", "db_app", "runtime", "application", "manifest"].map((name) => ({
    name,
    digest: digest(`${name}-${n}`),
    bytes: 20
  }));
  const migrationObservationDigest = originals[1].digest;
  const manifestDigest = digest(`application-manifest-${n}`);
  const apiReadiness = {
    healthStatus: 200,
    catalogStatus: 200,
    applicationName: `subscription-api/r3-${String(n).padStart(18, "0")}/${String(n).repeat(24)}`,
    databaseOid: "1001",
    runtimeRole: `api_role_${n}`,
    tls: true,
    sessionState: "idle",
    evidenceDigest: digest(`api-readiness-${n}`)
  };
  const publicApiBase = "https://api.example.test/api";
  const browserObservation = {
    schemaVersion: "web-public-api-evidence.v1",
    operationId,
    buildProofDigest,
    manifestDigest,
    publicApiBase,
    webOrigin: "http://web:3000",
    embeddedApiBase: publicApiBase,
    actualRequestUrl: `${publicApiBase}/portal/catalog/model-definitions`,
    corsAllowOrigin: "http://web:3000",
    responseStatus: 200,
    bundleContainsEmbeddedApiBase: true,
    mockedNetwork: false,
    traceDigest: digest(`trace-${n}`),
    observedAt: "2026-09-29T00:00:03.000Z"
  };
  const webClient = { ...browserObservation, evidenceDigest: digest(browserObservation) };
  const assessment = {
    schemaVersion: "r3-final-application-originals-assessment.v1",
    operationRef: operationId,
    observationDigest: digest(`application-observation-${n}`),
    migrationObservationDigest,
    apiReadinessDigest: apiReadiness.evidenceDigest,
    browserEvidenceDigest: webClient.evidenceDigest,
    browserTraceDigest: webClient.traceDigest,
    promotionEligible: false
  };
  const reconstructed = {
    manifestReport: {
      schemaVersion: "database-test-manifest-report.v1",
      runId: request.runId,
      chain,
      manifestDigest: request.databaseTestManifestDigest,
      discoveryDigest: sourceGateEvidence.databaseTestDiscoveryDigest,
      suiteReports: [],
      counts: counts(),
      sanitizedLogDigest: digest(`test-log-${n}`),
      terminalStatus: "PASSED"
    },
    migrationDigests: [{ databaseName: "db_app", digest: migrationObservationDigest }],
    sourceClaims,
    sourceOriginalDigest: originals[0].digest,
    applicationDigest: originals[3].digest,
    applicationReconstructedDigest: digest(assessment),
    runtimeDigest: originals[2].digest,
    publicFacts: {
      releaseImages: {
        api: `ghcr.io/keqi119/subscription-api@${digest("api")}`,
        web: `ghcr.io/keqi119/subscription-web@${digest("web")}`,
        runner: `ghcr.io/keqi119/subscription-runner@${digest("runner")}`
      },
      contracts: {
        migrationCatalogDigest: sourceGateEvidence.migrationCatalogDigest,
        repositoryContractDigest: sourceGateEvidence.repositoryContractDigest,
        databaseTestManifestDigest: sourceGateEvidence.databaseTestManifestDigest,
        databaseTestDiscoveryDigest: sourceGateEvidence.databaseTestDiscoveryDigest,
        postgresImageDigest: sourceGateEvidence.postgres.imageDigest,
        snapshotMetadataDigest: sourceGateEvidence.snapshot?.snapshotMetadataDigest ?? null
      },
      sourceGateEvidence,
      destination: {
        admissionDigest: request.destinationAdmissionDigest,
        creationEvidenceDigest: digest(`creation-${n}`),
        targetPlanDigest: digest(`target-plan-${n}`),
        engineId: `engine-${n}`,
        containerId: String(n).repeat(64),
        systemIdentifier: String(100000 + n),
        imageDigest: sourceGateEvidence.postgres.imageDigest,
        serverVersionNum: "170006"
      },
      application: {
        manifestDigest,
        manifestIdentityDigest: digest(`manifest-identity-${n}`),
        databaseIdentityFingerprint: digest(`db-identity-${n}`),
        apiSessionNonceDigest: digest(`nonce-${n}`),
        apiReadiness,
        webClient,
        assessment
      }
    }
  };
  const result = {
    schemaVersion: "manual-r3-final-result.v1",
    operationRef: operationId,
    profileDigest: request.profileDigest,
    ownerId: request.ownerId,
    sessionId: request.sessionId,
    sessionNonce: request.sessionNonce,
    sourceSha,
    targetPolicyDigest: request.targetPolicyDigest,
    creationSpecDigest: request.creationSpecDigest,
    jobAdmissionDigest: request.jobAdmissionDigest,
    phase: "final",
    chain,
    destinationAdmissionDigest: request.destinationAdmissionDigest,
    preparationExecutionRecordDigest: request.preparationExecutionRecordDigest,
    databaseTestManifestDigest: request.databaseTestManifestDigest,
    matchingSourceEvidenceDigest: request.matchingSourceEvidenceDigest,
    buildProofDigest,
    candidateUseExecutionRecordDigest: digest(`initial-${n}`),
    requestDigest: digest(request),
    readbackDigest: originals.at(-1).digest,
    reconstructedDigest: digest(reconstructed),
    sourceClaims,
    originals,
    custodyRecordDigests: Array.from({ length: originals.length * 2 }, (_, i) =>
      digest(`original-custody-${n}-${i}`)
    ),
    completedAt: "2026-09-29T00:00:02.000Z",
    promotionEligible: false
  };
  const execution = {
    schemaVersion: "manual-operation-record.v3",
    kind: "execution",
    profileDigest: request.profileDigest,
    recordedAt: "2026-09-29T00:00:03.000Z",
    promotionEligible: false,
    stage: "candidate-use",
    sessionId: request.sessionId,
    sessionNonce: request.sessionNonce,
    operationId,
    idempotencyKey: request.idempotencyKey,
    attemptId: request.attemptId,
    requestDigest: digest(request),
    authorizationDigest: digest(`authorization-${n}`),
    consumptionRecordDigest: digest(`consumption-${n}`),
    predecessorExecutionRecordDigest: result.candidateUseExecutionRecordDigest,
    startedAt: "2026-09-29T00:00:01.000Z",
    finishedAt: "2026-09-29T00:00:02.000Z",
    status: "SUCCEEDED",
    reasonCode: null,
    resultDigest: digest(result),
    processEvidenceDigest: result.readbackDigest
  };
  const acknowledgement = buildR3FinalAcknowledgement({
    profileDigest: request.profileDigest,
    ownerId: request.ownerId,
    execution,
    result,
    observedAt: "2026-09-29T00:00:04.000Z",
    recordedAt: "2026-09-29T00:00:04.000Z"
  });
  const cleanupReceipt = {
    status: "CLEANUP_OBSERVED",
    cleanupObservationRecordDigest: digest(`cleanup-observation-${n}`),
    cleanupBundleDigest: digest(`cleanup-bundle-${n}`),
    creationEvidenceDigest: reconstructed.publicFacts.destination.creationEvidenceDigest,
    forwardEvidenceDigest: digest(`forward-evidence-${n}`),
    forwardObservationDigest: digest(`forward-observation-${n}`),
    finalExecutionRecordDigest: digest(execution),
    finalAcknowledgementRecordDigest: digest(acknowledgement),
    custodyRecordDigests: Array.from({ length: 8 }, (_, i) => digest(`cleanup-custody-${n}-${i}`)),
    promotionEligible: false
  };
  const sessionRecord = {
    schemaVersion: "manual-operation-record.v3",
    kind: "session",
    profileDigest: request.profileDigest,
    recordedAt: "2026-09-29T00:00:05.000Z",
    promotionEligible: false,
    sessionId: request.sessionId,
    sessionNonce: request.sessionNonce,
    ownerId: request.ownerId,
    scope: {
      targetPolicyDigest: request.targetPolicyDigest,
      creationSpecDigest: request.creationSpecDigest,
      jobAdmissionDigest: request.jobAdmissionDigest,
      buildProofDigest,
      sourceSha,
      phase: "final",
      chain
    },
    status: "CLOSED",
    openedAt: "2026-09-29T00:00:00.000Z",
    previousSessionRecordDigest: digest(`prior-session-${n}`),
    reasonCode: null
  };
  return {
    request,
    execution,
    result,
    reconstructed,
    acknowledgement,
    cleanupReceipt,
    sessionRecord
  };
}

function reseal(input) {
  input.result.reconstructedDigest = digest(input.reconstructed);
  input.execution.resultDigest = digest(input.result);
  input.acknowledgement = buildR3FinalAcknowledgement({
    profileDigest: input.request.profileDigest,
    ownerId: input.request.ownerId,
    execution: input.execution,
    result: input.result,
    observedAt: input.acknowledgement.observedAt,
    recordedAt: input.acknowledgement.recordedAt
  });
  input.cleanupReceipt.finalExecutionRecordDigest = digest(input.execution);
  input.cleanupReceipt.finalAcknowledgementRecordDigest = digest(input.acknowledgement);
}

test("projects a bounded native final gate from fresh and snapshot held records", () => {
  for (const [chain, n] of [
    ["fresh", 1],
    ["snapshot", 2]
  ]) {
    const input = fixture(chain, n);
    const evidence = buildR3FinalGateEvidence(input);
    assert.equal(evidence.schemaVersion, "final-native-evidence.v1");
    assert.equal(evidence.native.resultDigest, digest(input.result));
    assert.equal(evidence.native.originalCustodyRecordDigests.length, 10);
    assert.equal(evidence.webClient.webOrigin, "http://web:3000");
    assert.equal(
      evidence.contracts.snapshotMetadataDigest,
      chain === "fresh" ? null : digest("snapshot")
    );
    assert.equal("compose" in evidence, false);
    assert.equal("priorFailureProofDigests" in evidence, false);
    assert.ok(Object.isFrozen(evidence.native.destination));
    assert.doesNotThrow(() => validateR3FinalGateEvidence(evidence));
  }
});

test("rejects altered source, reconstruction, cleanup, closed scope, and browser facts", () => {
  for (const change of [
    (x) => {
      x.reconstructed.publicFacts.sourceGateEvidence.postSchemaDigest = digest("wrong");
      reseal(x);
    },
    (x) => {
      x.result.reconstructedDigest = digest("wrong");
    },
    (x) => {
      x.cleanupReceipt.finalAcknowledgementRecordDigest = digest("wrong");
    },
    (x) => {
      x.sessionRecord.scope.buildProofDigest = digest("wrong");
    }
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => buildR3FinalGateEvidence(input), {
      code: "R3_FINAL_GATE_EVIDENCE_INVALID"
    });
  }
  const evidence = buildR3FinalGateEvidence(fixture());
  const browser = JSON.parse(JSON.stringify(evidence));
  browser.webClient.webOrigin = "http://localhost:3000";
  const original = { ...browser.webClient };
  delete original.evidenceDigest;
  browser.webClient.evidenceDigest = digest(original);
  assert.throws(() => validateR3FinalGateEvidence(browser), {
    code: "R3_FINAL_GATE_EVIDENCE_INVALID"
  });
});

test("requires independent native chain records with shared release inputs", () => {
  const fresh = buildR3FinalGateEvidence(fixture("fresh", 1));
  const snapshot = buildR3FinalGateEvidence(fixture("snapshot", 2));
  assert.doesNotThrow(() => assertIndependentNativeChainEvidence(fresh, snapshot));
  const reused = JSON.parse(JSON.stringify(snapshot));
  reused.native.terminalExecutionDigest = fresh.native.terminalExecutionDigest;
  assert.throws(() => assertIndependentNativeChainEvidence(fresh, reused), {
    code: "R3_FINAL_GATE_EVIDENCE_INVALID"
  });
});
