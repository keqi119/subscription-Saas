const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ACTIVE_JOB_STATUSES = new Set(["PENDING", "PROCESSING"]);

export const STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION = 2;
export const STAGE2_HANDOVER_PDF_HARD_MAX_BYTES = 18 * 1024 * 1024;

export function canonicalStage2Sha256(value) {
  const digest = stage2Sha256Digest(value);
  return digest ? `sha256:${digest}` : null;
}

export function stage2Sha256Digest(value) {
  if (typeof value !== "string") {
    return null;
  }
  const digest = value.trim().toLowerCase().replace(/^sha256:/, "");
  return SHA256_DIGEST_PATTERN.test(digest) ? digest : null;
}

export function buildCanonicalStage2PdfJobKey({
  manifestHash,
  reviewAttemptId,
  workOrderId
}) {
  const canonicalManifestHash = canonicalStage2Sha256(manifestHash);
  if (
    !canonicalManifestHash ||
    !nonEmptyString(reviewAttemptId) ||
    !nonEmptyString(workOrderId)
  ) {
    return null;
  }
  return `pdf:${workOrderId.trim()}:${reviewAttemptId.trim()}:${canonicalManifestHash}`;
}

export function stage2BackfillJobMatchesCandidate(job, candidate) {
  return Boolean(
    job &&
    candidate &&
    job.idempotencyKey === candidate.idempotencyKey &&
    job.workOrderId === candidate.workOrderId &&
    job.handoverId === candidate.handoverId &&
    job.eSignTaskId === candidate.eSignTaskId &&
    job.jobType === candidate.jobType &&
    jobStatusConverges(job.jobType, job.jobStatus) &&
    exactStage2WorkflowPayloadMatches(job.payload, candidate.payload)
  );
}

export function exactStage2WorkflowPayloadMatches(actual, expected) {
  if (expected === undefined) {
    return actual === undefined || actual === null;
  }
  if (
    actual === null ||
    expected === null ||
    typeof actual !== "object" ||
    typeof expected !== "object"
  ) {
    return actual === expected;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((value, index) =>
        exactStage2WorkflowPayloadMatches(value, expected[index])
      )
    );
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    exactStage2WorkflowPayloadMatches(actualKeys, expectedKeys) &&
    expectedKeys.every((key) =>
      exactStage2WorkflowPayloadMatches(actual[key], expected[key])
    )
  );
}

function jobStatusConverges(jobType, jobStatus) {
  return (
    ACTIVE_JOB_STATUSES.has(jobStatus) ||
    (
      jobType === "NOTIFY_FIELD_ESIGN_READY" &&
      jobStatus === "COMPLETED"
    )
  );
}

function nonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}
