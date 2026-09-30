import { URL } from "node:url";
import {
  encodeManualJson,
  sha256Canonical,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";
import { assertR3FinalAcknowledgement } from "./r3-final-result.mjs";

const CODE = "R3_FINAL_GATE_EVIDENCE_INVALID";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (condition) => {
  if (!condition) fail();
};
const same = (left, right) => sha256Canonical(left) === sha256Canonical(right);
const exact = (value, names) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));
const clone = (value) => JSON.parse(encodeManualJson(value));
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function time(value) {
  const instant = Date.parse(value);
  need(
    typeof value === "string" &&
      Number.isFinite(instant) &&
      new Date(instant).toISOString() === value
  );
  return instant;
}
function countsPassed(counts) {
  return (
    counts?.collected > 0 &&
    counts.collected === counts.selected &&
    counts.selected === counts.executed &&
    counts.executed === counts.passed &&
    ["failed", "skipped", "todo", "filtered", "cancelled"].every((key) => counts[key] === 0)
  );
}
function assertWebClient(webClient, evidence) {
  const { evidenceDigest, ...original } = webClient;
  const api = new URL(webClient.publicApiBase);
  need(
    api.protocol === "https:" &&
      api.username === "" &&
      api.password === "" &&
      api.search === "" &&
      api.hash === "" &&
      api.port === "" &&
      api.pathname === "/api" &&
      webClient.publicApiBase === api.toString().replace(/\/$/u, "") &&
      webClient.embeddedApiBase === webClient.publicApiBase &&
      webClient.actualRequestUrl ===
        new URL("portal/catalog/model-definitions", `${webClient.publicApiBase}/`).toString() &&
      webClient.buildProofDigest === evidence.buildProofDigest &&
      webClient.manifestDigest === evidence.manifestDigest &&
      webClient.operationId === evidence.operationId &&
      webClient.traceDigest === evidence.native.browserTraceDigest &&
      sha256Canonical(original) === evidenceDigest
  );
}

export function validateR3FinalGateEvidence(value) {
  try {
    validateContract("final-native-evidence.v1", value);
    need(countsPassed(value.databaseTests.counts));
    need(
      value.chain === "fresh"
        ? value.contracts.snapshotMetadataDigest === null
        : DIGEST.test(value.contracts.snapshotMetadataDigest)
    );
    need(
      value.native.destination.imageDigest === value.contracts.postgresImageDigest &&
        value.native.originalCustodyRecordDigests.length % 2 === 0 &&
        value.native.originalCustodyRecordDigests.length >= 6
    );
    assertWebClient(value.webClient, value);
    return true;
  } catch {
    fail();
  }
}

// This pure projection grants no authority. Its caller must authenticate the
// history graph, complete original readback, cleanup observation, and CLOSED
// record before supplying these already checked values. Retry history is not
// inferable from a successful request, so this contract makes no retry claim.
export function buildR3FinalGateEvidence({
  request,
  execution,
  result,
  reconstructed,
  acknowledgement,
  cleanupReceipt,
  sessionRecord
}) {
  try {
    validateContract("manual-runner-request.v5", request);
    validateContract("manual-operation-record.v3", execution);
    validateContract("manual-operation-record.v3", sessionRecord);
    const requestDigest = sha256Canonical(request);
    const terminalExecutionDigest = sha256Canonical(execution);
    const resultDigest = sha256Canonical(result);
    const acknowledgementDigest = sha256Canonical(acknowledgement);
    const facts = reconstructed?.publicFacts;
    const gate = facts?.sourceGateEvidence;
    validateContract("source-gate-evidence.v1", gate);
    assertR3FinalAcknowledgement({
      acknowledgement,
      profileDigest: request.profileDigest,
      ownerId: request.ownerId,
      execution,
      result,
      now: sessionRecord.recordedAt
    });
    need(
      request.phase === "final" &&
        request.stage === "candidate-use" &&
        request.capability === "execute-final-database-tests" &&
        execution.kind === "execution" &&
        execution.stage === "candidate-use" &&
        execution.status === "SUCCEEDED" &&
        execution.reasonCode === null &&
        execution.promotionEligible === false &&
        execution.requestDigest === requestDigest &&
        execution.resultDigest === resultDigest &&
        execution.processEvidenceDigest === result.readbackDigest &&
        execution.predecessorExecutionRecordDigest === result.candidateUseExecutionRecordDigest &&
        [
          "profileDigest",
          "sessionId",
          "sessionNonce",
          "operationId",
          "idempotencyKey",
          "attemptId"
        ].every((key) => execution[key] === request[key]) &&
        result.schemaVersion === "manual-r3-final-result.v1" &&
        result.promotionEligible === false &&
        result.phase === "final" &&
        result.chain === request.chain &&
        result.operationRef === request.operationId &&
        result.requestDigest === requestDigest &&
        result.buildProofDigest === request.candidate.buildProofDigest &&
        result.destinationAdmissionDigest === request.destinationAdmissionDigest &&
        result.databaseTestManifestDigest === request.databaseTestManifestDigest &&
        result.matchingSourceEvidenceDigest === request.matchingSourceEvidenceDigest &&
        result.reconstructedDigest === sha256Canonical(reconstructed) &&
        [
          "profileDigest",
          "ownerId",
          "sessionId",
          "sessionNonce",
          "sourceSha",
          "targetPolicyDigest",
          "creationSpecDigest",
          "jobAdmissionDigest"
        ].every((key) => result[key] === request[key]) &&
        exact(result.sourceClaims, [
          "matchingSourceEvidenceDigest",
          "matchingSourceResultDigest",
          "expectedSchemaDigest",
          "sourceGateEvidenceDigest"
        ]) &&
        same(result.sourceClaims, reconstructed.sourceClaims) &&
        result.sourceClaims.matchingSourceEvidenceDigest === request.matchingSourceEvidenceDigest &&
        result.sourceClaims.sourceGateEvidenceDigest === sha256Canonical(gate) &&
        result.sourceClaims.expectedSchemaDigest === gate.postSchemaDigest &&
        gate.chain === request.chain &&
        gate.sourceSha === request.sourceSha &&
        gate.databaseTestManifestDigest === request.databaseTestManifestDigest &&
        gate.terminalStatus === "PASSED" &&
        facts.contracts.databaseTestManifestDigest === request.databaseTestManifestDigest &&
        facts.contracts.migrationCatalogDigest === gate.migrationCatalogDigest &&
        facts.contracts.repositoryContractDigest === gate.repositoryContractDigest &&
        facts.contracts.databaseTestDiscoveryDigest === gate.databaseTestDiscoveryDigest &&
        facts.contracts.postgresImageDigest === gate.postgres.imageDigest &&
        facts.contracts.snapshotMetadataDigest ===
          (request.chain === "snapshot" ? gate.snapshot?.snapshotMetadataDigest : null) &&
        reconstructed.manifestReport.schemaVersion === "database-test-manifest-report.v1" &&
        reconstructed.manifestReport.chain === request.chain &&
        reconstructed.manifestReport.runId === request.runId &&
        reconstructed.manifestReport.manifestDigest === request.databaseTestManifestDigest &&
        reconstructed.manifestReport.discoveryDigest === gate.databaseTestDiscoveryDigest &&
        reconstructed.manifestReport.terminalStatus === "PASSED" &&
        countsPassed(reconstructed.manifestReport.counts)
    );
    need(
      Array.isArray(result.originals) &&
        result.originals.length >= 3 &&
        new Set(result.originals.map(({ name }) => name)).size === result.originals.length &&
        result.originals.every(
          (item) =>
            exact(item, ["name", "digest", "bytes"]) &&
            typeof item.name === "string" &&
            DIGEST.test(item.digest) &&
            Number.isSafeInteger(item.bytes) &&
            item.bytes > 0
        ) &&
        Array.isArray(result.custodyRecordDigests) &&
        result.custodyRecordDigests.length === result.originals.length * 2 &&
        new Set(result.custodyRecordDigests).size === result.custodyRecordDigests.length &&
        result.custodyRecordDigests.every((digest) => DIGEST.test(digest)) &&
        result.originals.at(-1).name === "manifest" &&
        result.originals.at(-1).digest === result.readbackDigest &&
        result.originals.find(({ name }) => name === "source")?.digest ===
          reconstructed.sourceOriginalDigest &&
        result.originals.find(({ name }) => name === "application")?.digest ===
          reconstructed.applicationDigest &&
        result.originals.find(({ name }) => name === "runtime")?.digest ===
          reconstructed.runtimeDigest &&
        Array.isArray(reconstructed.migrationDigests) &&
        reconstructed.migrationDigests.length > 0 &&
        reconstructed.migrationDigests.every(
          ({ databaseName, digest }) =>
            result.originals.find(({ name }) => name === databaseName)?.digest === digest
        ) &&
        DIGEST.test(reconstructed.applicationReconstructedDigest) &&
        DIGEST.test(reconstructed.runtimeDigest)
    );
    const application = facts.application;
    const assessment = application.assessment;
    need(
      exact(facts, [
        "releaseImages",
        "contracts",
        "sourceGateEvidence",
        "destination",
        "application"
      ]) &&
        exact(application, [
          "manifestDigest",
          "manifestIdentityDigest",
          "databaseIdentityFingerprint",
          "apiSessionNonceDigest",
          "apiReadiness",
          "webClient",
          "assessment"
        ]) &&
        assessment.schemaVersion === "r3-final-application-originals-assessment.v1" &&
        assessment.promotionEligible === false &&
        assessment.operationRef === request.operationId &&
        DIGEST.test(assessment.observationDigest) &&
        sha256Canonical(assessment) === reconstructed.applicationReconstructedDigest &&
        DIGEST.test(assessment.migrationObservationDigest) &&
        reconstructed.migrationDigests.some(
          ({ digest }) => digest === assessment.migrationObservationDigest
        ) &&
        application.apiReadiness.evidenceDigest === assessment.apiReadinessDigest &&
        application.webClient.evidenceDigest === assessment.browserEvidenceDigest &&
        application.webClient.traceDigest === assessment.browserTraceDigest &&
        application.webClient.operationId === request.operationId &&
        application.webClient.buildProofDigest === request.candidate.buildProofDigest &&
        application.webClient.manifestDigest === application.manifestDigest &&
        facts.destination.admissionDigest === request.destinationAdmissionDigest &&
        facts.destination.creationEvidenceDigest === cleanupReceipt.creationEvidenceDigest &&
        facts.destination.imageDigest === facts.contracts.postgresImageDigest &&
        facts.destination.serverVersionNum === gate.postgres.serverVersionNum
    );
    need(
      exact(cleanupReceipt, [
        "status",
        "cleanupObservationRecordDigest",
        "cleanupBundleDigest",
        "creationEvidenceDigest",
        "forwardEvidenceDigest",
        "forwardObservationDigest",
        "finalExecutionRecordDigest",
        "finalAcknowledgementRecordDigest",
        "custodyRecordDigests",
        "promotionEligible"
      ]) &&
        cleanupReceipt.status === "CLEANUP_OBSERVED" &&
        cleanupReceipt.promotionEligible === false &&
        cleanupReceipt.finalExecutionRecordDigest === terminalExecutionDigest &&
        cleanupReceipt.finalAcknowledgementRecordDigest === acknowledgementDigest &&
        [
          "cleanupObservationRecordDigest",
          "cleanupBundleDigest",
          "creationEvidenceDigest",
          "forwardEvidenceDigest",
          "forwardObservationDigest"
        ].every((key) => DIGEST.test(cleanupReceipt[key])) &&
        Array.isArray(cleanupReceipt.custodyRecordDigests) &&
        cleanupReceipt.custodyRecordDigests.length === 8 &&
        new Set(cleanupReceipt.custodyRecordDigests).size === 8 &&
        cleanupReceipt.custodyRecordDigests.every((digest) => DIGEST.test(digest)) &&
        sessionRecord.kind === "session" &&
        sessionRecord.status === "CLOSED" &&
        sessionRecord.reasonCode === null &&
        sessionRecord.promotionEligible === false &&
        DIGEST.test(sessionRecord.previousSessionRecordDigest) &&
        ["profileDigest", "ownerId", "sessionId", "sessionNonce"].every(
          (key) => sessionRecord[key] === request[key]
        ) &&
        same(sessionRecord.scope, {
          targetPolicyDigest: request.targetPolicyDigest,
          creationSpecDigest: request.creationSpecDigest,
          jobAdmissionDigest: request.jobAdmissionDigest,
          buildProofDigest: request.candidate.buildProofDigest,
          sourceSha: request.sourceSha,
          phase: "final",
          chain: request.chain
        }) &&
        time(result.completedAt) <= time(execution.finishedAt) &&
        time(execution.finishedAt) <= time(execution.recordedAt) &&
        time(execution.recordedAt) <= time(acknowledgement.observedAt) &&
        time(acknowledgement.recordedAt) <= time(sessionRecord.recordedAt) &&
        time(sessionRecord.openedAt) <= time(execution.recordedAt)
    );
    const evidence = {
      schemaVersion: "final-native-evidence.v1",
      chain: request.chain,
      terminalStatus: "PASSED",
      sourceSha: request.sourceSha,
      buildProofDigest: request.candidate.buildProofDigest,
      releaseImages: facts.releaseImages,
      contracts: facts.contracts,
      sourceGateEvidenceDigest: sha256Canonical(gate),
      operationId: request.operationId,
      runId: request.runId,
      attemptId: request.attemptId,
      manifestDigest: application.manifestDigest,
      manifestIdentityDigest: application.manifestIdentityDigest,
      databaseIdentityFingerprint: application.databaseIdentityFingerprint,
      apiSessionNonceDigest: application.apiSessionNonceDigest,
      databaseTests: {
        reportDigest: sha256Canonical(reconstructed.manifestReport),
        counts: reconstructed.manifestReport.counts
      },
      apiReadiness: application.apiReadiness,
      webClient: application.webClient,
      native: {
        requestDigest,
        terminalExecutionDigest,
        resultDigest,
        readbackDigest: result.readbackDigest,
        reconstructedDigest: result.reconstructedDigest,
        originalSetDigest: sha256Canonical(result.originals),
        originalCustodyRecordDigests: result.custodyRecordDigests,
        sourceOriginalDigest: reconstructed.sourceOriginalDigest,
        applicationOriginalDigest: reconstructed.applicationDigest,
        applicationReconstructedDigest: reconstructed.applicationReconstructedDigest,
        runtimeDigest: reconstructed.runtimeDigest,
        migrationObservationsDigest: sha256Canonical(reconstructed.migrationDigests),
        destination: facts.destination,
        applicationAssessmentDigest: sha256Canonical(assessment),
        browserTraceDigest: assessment.browserTraceDigest,
        acknowledgementDigest,
        cleanupObservationDigest: cleanupReceipt.cleanupObservationRecordDigest,
        cleanupBundleDigest: cleanupReceipt.cleanupBundleDigest,
        cleanupCustodyRecordDigests: cleanupReceipt.custodyRecordDigests,
        closedSessionDigest: sha256Canonical(sessionRecord),
        previousSessionRecordDigest: sessionRecord.previousSessionRecordDigest
      },
      producedAt: sessionRecord.recordedAt
    };
    validateR3FinalGateEvidence(evidence);
    return freeze(clone(evidence));
  } catch {
    fail();
  }
}

export function assertIndependentNativeChainEvidence(fresh, snapshot) {
  try {
    validateR3FinalGateEvidence(fresh);
    validateR3FinalGateEvidence(snapshot);
    need(fresh.chain === "fresh" && snapshot.chain === "snapshot");
    need(
      fresh.sourceSha === snapshot.sourceSha &&
        fresh.buildProofDigest === snapshot.buildProofDigest &&
        same(fresh.releaseImages, snapshot.releaseImages) &&
        [
          "migrationCatalogDigest",
          "repositoryContractDigest",
          "databaseTestManifestDigest",
          "databaseTestDiscoveryDigest",
          "postgresImageDigest"
        ].every((key) => fresh.contracts[key] === snapshot.contracts[key])
    );
    for (const key of [
      "sourceGateEvidenceDigest",
      "operationId",
      "runId",
      "attemptId",
      "manifestDigest",
      "manifestIdentityDigest",
      "databaseIdentityFingerprint",
      "apiSessionNonceDigest"
    ])
      need(fresh[key] !== snapshot[key]);
    for (const key of [
      "requestDigest",
      "terminalExecutionDigest",
      "resultDigest",
      "readbackDigest",
      "reconstructedDigest",
      "originalSetDigest",
      "sourceOriginalDigest",
      "applicationOriginalDigest",
      "applicationReconstructedDigest",
      "runtimeDigest",
      "migrationObservationsDigest",
      "applicationAssessmentDigest",
      "browserTraceDigest",
      "acknowledgementDigest",
      "cleanupObservationDigest",
      "cleanupBundleDigest",
      "closedSessionDigest",
      "previousSessionRecordDigest"
    ])
      need(fresh.native[key] !== snapshot.native[key]);
    need(
      !same(fresh.native.destination, snapshot.native.destination) &&
        fresh.native.destination.engineId !== snapshot.native.destination.engineId &&
        fresh.native.destination.containerId !== snapshot.native.destination.containerId &&
        fresh.native.destination.systemIdentifier !==
          snapshot.native.destination.systemIdentifier &&
        fresh.databaseTests.reportDigest !== snapshot.databaseTests.reportDigest &&
        fresh.apiReadiness.applicationName !== snapshot.apiReadiness.applicationName &&
        fresh.apiReadiness.evidenceDigest !== snapshot.apiReadiness.evidenceDigest &&
        fresh.webClient.evidenceDigest !== snapshot.webClient.evidenceDigest
    );
    const custody = new Set([
      ...fresh.native.originalCustodyRecordDigests,
      ...fresh.native.cleanupCustodyRecordDigests
    ]);
    need(
      [
        ...snapshot.native.originalCustodyRecordDigests,
        ...snapshot.native.cleanupCustodyRecordDigests
      ].every((digest) => !custody.has(digest))
    );
    return true;
  } catch {
    fail();
  }
}
