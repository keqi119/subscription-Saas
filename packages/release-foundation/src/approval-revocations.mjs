import { assertCustodyComplete } from "./evidence-custody.mjs";
import { sha256Canonical } from "./digest.mjs";
import { validateContract } from "./schema-registry.mjs";

const verifiedRevocationSets = new WeakSet();
const verifiedAttestations = new WeakSet();

function revocationError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function epoch(value, code) {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw revocationError(code);
  }
  return parsed;
}

function assertPolicy(policy) {
  try {
    validateContract("approval-policy.v1", policy);
  } catch (error) {
    throw revocationError("APPROVAL_REVOCATIONS_POLICY_INVALID", { cause: error?.code });
  }
}

function assertSortedUniqueRevocations(revocations) {
  const keys = revocations.map(
    ({ approvalId, approvalRecordDigest }) => `${approvalId}\u0000${approvalRecordDigest}`
  );
  const sorted = [...keys].sort((left, right) => left.localeCompare(right));
  if (new Set(keys).size !== keys.length || keys.some((key, index) => key !== sorted[index])) {
    throw revocationError("APPROVAL_REVOCATIONS_ORDER_INVALID");
  }
}

function assertCustodyPolicy(receipt, policy, code) {
  if (
    receipt.owner !== policy.owner ||
    receipt.expiryDisposition !== policy.expiryDisposition ||
    receipt.readers.length !== policy.readers.length ||
    receipt.readers.some((reader, index) => reader !== policy.readers[index])
  ) {
    throw revocationError(code);
  }
}

function verifiedSet(artifact, artifactDigest) {
  const result = Object.freeze({
    status: "verified",
    artifactDigest,
    policyDigest: artifact.policyDigest,
    sequence: artifact.sequence,
    issuedAt: artifact.issuedAt,
    notAfter: artifact.notAfter,
    revokedApprovalIds: Object.freeze(artifact.revocations.map(({ approvalId }) => approvalId)),
    revokedRecordDigests: Object.freeze(
      artifact.revocations.map(({ approvalRecordDigest }) => approvalRecordDigest)
    )
  });
  verifiedRevocationSets.add(result);
  return result;
}

export function assertVerifiedRevocationSet(value) {
  if (!verifiedRevocationSets.has(value)) {
    throw revocationError("APPROVAL_REVOCATIONS_UNVERIFIED");
  }
  return value;
}

export async function verifyTrustedArtifactAttestation({ envelope, verifier, subjectDigest }) {
  if (
    verifier?.trustPolicy !== "github-artifact-attestation/v1" ||
    typeof verifier.verify !== "function"
  ) {
    throw revocationError("ARTIFACT_ATTESTATION_VERIFIER_UNTRUSTED");
  }
  let claims;
  try {
    claims = await verifier.verify(envelope);
  } catch {
    throw revocationError("ARTIFACT_ATTESTATION_INVALID");
  }
  if (
    claims === null ||
    typeof claims !== "object" ||
    Array.isArray(claims) ||
    claims.subjectDigest !== subjectDigest ||
    typeof claims.issuer !== "string" ||
    typeof claims.repository !== "string" ||
    typeof claims.workflowPath !== "string" ||
    typeof claims.workflowRef !== "string"
  ) {
    throw revocationError("ARTIFACT_ATTESTATION_INVALID");
  }
  const decision = Object.freeze({ ...claims, status: "verified" });
  verifiedAttestations.add(decision);
  return decision;
}

function assertVerifiedAttestation(value, code) {
  if (!verifiedAttestations.has(value)) throw revocationError(code);
  return value;
}

export function verifyRevocationArtifact({
  artifact,
  policy,
  attestation,
  custodyReceipt,
  observedHeadSequence,
  expectedPreviousArtifactDigest,
  previouslyObserved,
  now = new Date()
}) {
  if (!artifact) throw revocationError("APPROVAL_REVOCATIONS_MISSING");
  assertPolicy(policy);
  try {
    validateContract("approval-revocations.v1", artifact);
  } catch (error) {
    throw revocationError("APPROVAL_REVOCATIONS_INVALID", { cause: error?.code });
  }
  const artifactDigest = sha256Canonical(artifact);
  const policyDigest = sha256Canonical(policy);
  if (artifact.policyDigest !== policyDigest) {
    throw revocationError("APPROVAL_REVOCATIONS_POLICY_MISMATCH");
  }
  const source = policy.revocationSource;
  const verifiedAttestation = assertVerifiedAttestation(
    attestation,
    "APPROVAL_REVOCATIONS_ATTESTATION_INVALID"
  );
  if (
    artifact.issuer !== source.attestationIssuer ||
    artifact.repository !== source.repository ||
    artifact.workflowPath !== source.workflowPath ||
    artifact.workflowRef !== source.workflowRef ||
    verifiedAttestation.issuer !== source.attestationIssuer
  ) {
    throw revocationError("APPROVAL_REVOCATIONS_ISSUER_UNTRUSTED");
  }
  if (
    verifiedAttestation.subjectDigest !== artifactDigest ||
    verifiedAttestation.repository !== artifact.repository ||
    verifiedAttestation.workflowPath !== artifact.workflowPath ||
    verifiedAttestation.workflowRef !== artifact.workflowRef ||
    verifiedAttestation.workflowRunId !== artifact.workflowRunId ||
    verifiedAttestation.runAttempt !== 1 ||
    artifact.runAttempt !== 1
  ) {
    throw revocationError("APPROVAL_REVOCATIONS_ATTESTATION_INVALID");
  }
  try {
    assertCustodyComplete(custodyReceipt, artifactDigest);
    assertCustodyPolicy(custodyReceipt, policy.custody, "APPROVAL_REVOCATIONS_CUSTODY_INVALID");
  } catch (error) {
    if (error?.code === "APPROVAL_REVOCATIONS_CUSTODY_INVALID") throw error;
    throw revocationError("APPROVAL_REVOCATIONS_CUSTODY_INVALID", { cause: error?.code });
  }
  if (artifact.previousArtifactDigest !== expectedPreviousArtifactDigest) {
    throw revocationError("APPROVAL_REVOCATIONS_CHAIN_BROKEN");
  }
  if (
    !Number.isInteger(observedHeadSequence) ||
    artifact.sequence < observedHeadSequence ||
    artifact.sequence < source.minimumWorkflowRunNumber
  ) {
    throw revocationError("APPROVAL_REVOCATIONS_ROLLBACK");
  }
  if (artifact.sequence > observedHeadSequence) {
    throw revocationError("APPROVAL_REVOCATIONS_LIST_INCOMPLETE");
  }
  if (
    previouslyObserved &&
    (artifact.sequence < previouslyObserved.sequence ||
      (artifact.sequence === previouslyObserved.sequence &&
        artifactDigest !== previouslyObserved.artifactDigest))
  ) {
    throw revocationError("APPROVAL_REVOCATIONS_ROLLBACK");
  }
  assertSortedUniqueRevocations(artifact.revocations);
  const nowEpoch = now instanceof Date ? now.getTime() : Number.NaN;
  const issuedAt = epoch(artifact.issuedAt, "APPROVAL_REVOCATIONS_TIME_INVALID");
  const notAfter = epoch(artifact.notAfter, "APPROVAL_REVOCATIONS_TIME_INVALID");
  if (
    !Number.isFinite(nowEpoch) ||
    nowEpoch < issuedAt ||
    nowEpoch >= notAfter ||
    nowEpoch - issuedAt > source.maximumPublicationDelaySeconds * 1000 ||
    notAfter - issuedAt > source.maximumArtifactLifetimeSeconds * 1000
  ) {
    throw revocationError("APPROVAL_REVOCATIONS_EXPIRED");
  }
  return verifiedSet(artifact, artifactDigest);
}

export async function fetchLatestTrustedRevocations({
  policy,
  githubClient,
  previouslyObserved,
  now = new Date()
}) {
  assertPolicy(policy);
  if (
    typeof githubClient?.listSuccessfulWorkflowRuns !== "function" ||
    typeof githubClient?.downloadRunArtifact !== "function"
  ) {
    throw revocationError("APPROVAL_REVOCATIONS_UNAVAILABLE");
  }
  const runs = [];
  const seenCursors = new Set();
  let cursor;
  try {
    for (;;) {
      const page = await githubClient.listSuccessfulWorkflowRuns({
        repository: policy.revocationSource.repository,
        workflowPath: policy.revocationSource.workflowPath,
        workflowRef: policy.revocationSource.workflowRef,
        cursor
      });
      if (!Array.isArray(page?.runs)) {
        throw revocationError("APPROVAL_REVOCATIONS_LIST_INCOMPLETE");
      }
      runs.push(...page.runs);
      if (page.nextCursor === null || page.nextCursor === undefined) break;
      if (typeof page.nextCursor !== "string" || seenCursors.has(page.nextCursor)) {
        throw revocationError("APPROVAL_REVOCATIONS_LIST_INCOMPLETE");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  } catch (error) {
    if (error?.code?.startsWith("APPROVAL_REVOCATIONS_")) throw error;
    throw revocationError("APPROVAL_REVOCATIONS_UNAVAILABLE");
  }
  const orderedRuns = runs
    .filter(
      ({ runNumber, runAttempt }) =>
        Number.isInteger(runNumber) &&
        runNumber >= policy.revocationSource.minimumWorkflowRunNumber &&
        runAttempt === 1
    )
    .sort((left, right) => left.runNumber - right.runNumber);
  if (
    runs.some(
      ({ runNumber, runAttempt }) =>
        Number.isInteger(runNumber) &&
        runNumber >= policy.revocationSource.minimumWorkflowRunNumber &&
        runAttempt !== 1
    )
  ) {
    throw revocationError("APPROVAL_REVOCATIONS_LIST_INCOMPLETE");
  }
  if (orderedRuns.length === 0) throw revocationError("APPROVAL_REVOCATIONS_MISSING");
  if (new Set(orderedRuns.map(({ runNumber }) => runNumber)).size !== orderedRuns.length) {
    throw revocationError("APPROVAL_REVOCATIONS_LIST_INCOMPLETE");
  }
  let previousDigest = policy.revocationSource.checkpointArtifactDigest;
  let latest;
  for (const run of orderedRuns) {
    let downloaded;
    try {
      downloaded = await githubClient.downloadRunArtifact({
        repository: policy.revocationSource.repository,
        runId: String(run.runId),
        artifactName: `${policy.revocationSource.artifactNamePrefix}${run.runId}`
      });
    } catch {
      throw revocationError("APPROVAL_REVOCATIONS_UNAVAILABLE");
    }
    if (
      downloaded?.artifact?.sequence !== run.runNumber ||
      downloaded?.artifact?.workflowRunId !== String(run.runId)
    ) {
      throw revocationError(
        downloaded?.artifact?.sequence < run.runNumber
          ? "APPROVAL_REVOCATIONS_ROLLBACK"
          : "APPROVAL_REVOCATIONS_LIST_INCOMPLETE"
      );
    }
    const artifactDigest = sha256Canonical(downloaded.artifact);
    let verifiedAttestation;
    try {
      verifiedAttestation = await verifyTrustedArtifactAttestation({
        envelope: downloaded.attestation,
        verifier: githubClient.attestationVerifier,
        subjectDigest: artifactDigest
      });
    } catch (error) {
      throw revocationError("APPROVAL_REVOCATIONS_ATTESTATION_INVALID", {
        cause: error?.code
      });
    }
    latest = verifyRevocationArtifact({
      ...downloaded,
      attestation: verifiedAttestation,
      policy,
      observedHeadSequence: run.runNumber,
      expectedPreviousArtifactDigest: previousDigest,
      now
    });
    previousDigest = latest.artifactDigest;
  }
  if (
    previouslyObserved &&
    (latest.sequence < previouslyObserved.sequence ||
      (latest.sequence === previouslyObserved.sequence &&
        latest.artifactDigest !== previouslyObserved.artifactDigest))
  ) {
    throw revocationError("APPROVAL_REVOCATIONS_ROLLBACK");
  }
  return latest;
}

export async function publishRevocationArtifact({
  artifact,
  policy,
  storage,
  attestor,
  now,
  createReceiptId
}) {
  assertPolicy(policy);
  validateContract("approval-revocations.v1", artifact);
  if (
    artifact.policyDigest !== sha256Canonical(policy) ||
    typeof attestor?.attestSubject !== "function"
  ) {
    throw revocationError("APPROVAL_REVOCATIONS_PUBLICATION_INVALID");
  }
  assertSortedUniqueRevocations(artifact.revocations);
  const artifactDigest = sha256Canonical(artifact);
  const attestation = await attestor.attestSubject({
    subjectDigest: artifactDigest,
    repository: artifact.repository,
    workflowPath: artifact.workflowPath,
    workflowRef: artifact.workflowRef,
    workflowRunId: artifact.workflowRunId,
    runAttempt: artifact.runAttempt
  });
  if (
    attestation?.subjectDigest !== artifactDigest ||
    attestation.issuer !== policy.revocationSource.attestationIssuer ||
    typeof attestation.reference !== "string"
  ) {
    throw revocationError("APPROVAL_REVOCATIONS_ATTESTATION_INVALID");
  }
  const { custodyEvidence } = await import("./evidence-custody.mjs");
  return custodyEvidence({
    value: artifact,
    policy: policy.custody,
    storage,
    now,
    createReceiptId,
    attestationRef: attestation.reference
  });
}
