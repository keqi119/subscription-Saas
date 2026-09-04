import assert from "node:assert/strict";
import test from "node:test";

import { validateContract } from "../src/index.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = "2026-09-04T00:00:00.000Z";

const validIdentity = {
  schemaVersion: "environment-policy-identity.v1",
  repository: { id: "1", name: "keqi119/subscription-Saas" },
  environment: { id: "2", name: "snapshot-data" },
  requiredReviewerId: "3",
  branchPolicy: { protectedBranches: ["main"], tagRules: [] },
  canAdminsBypass: false,
  preventSelfReview: true,
  allowedActorId: "4",
  waitTimerSeconds: 0,
  workflowPath: ".github/workflows/sanitized-snapshot.yml",
  workflowBlobDigest: DIGEST,
  actionCommitAllowlist: [{ action: "actions/checkout", commit: "b".repeat(40) }],
  canonicalizationVersion: "RFC8785"
};

const validAdmission = {
  schemaVersion: "snapshot-admission.v1",
  dispatchAuthorizationDigest: DIGEST,
  releaseAttemptId: "attempt-1",
  executionPurpose: "stage1-qualification",
  producerRun: {
    repository: "keqi119/subscription-Saas",
    runId: "123",
    runAttempt: 1,
    workflowPath: ".github/workflows/sanitized-snapshot.yml",
    workflowRef: "main",
    workflowBlobDigest: DIGEST,
    sourceSha: "b".repeat(40)
  },
  route: { nonce: "c".repeat(32), label: `stage1-snapshot-export-123-${"c".repeat(32)}` },
  adapterDigest: DIGEST,
  environmentPolicyIdentityDigest: DIGEST
};

function assertSchemaInvalidAdditionalProperties(schemaId, value) {
  assert.throws(
    () => validateContract(schemaId, value),
    (error) =>
      error?.code === "CONTRACT_SCHEMA_INVALID" &&
      error.details?.errors?.some(({ keyword }) => keyword === "additionalProperties")
  );
}

test("environment identity cannot contain observation time", () => {
  assertSchemaInvalidAdditionalProperties("environment-policy-identity.v1", {
    ...validIdentity,
    observedAt: NOW
  });
});

test("admission cannot reference a future observation", () => {
  assertSchemaInvalidAdditionalProperties("snapshot-admission.v1", {
    ...validAdmission,
    environmentPolicyObservationDigest: DIGEST
  });
});

test("producer completion rejects self-reported future workflow terminal state", () => {
  const completion = {
    schemaVersion: "snapshot-producer-completion.v1",
    snapshotAdmissionVerificationDigest: DIGEST,
    producerRun: {
      repository: "keqi119/subscription-Saas",
      runId: "123",
      runAttempt: 1,
      workflowPath: ".github/workflows/sanitized-snapshot.yml",
      sourceSha: "b".repeat(40)
    },
    dataJob: { id: "4", name: "snapshot-data" },
    dataExportDigest: DIGEST,
    scanReportDigest: DIGEST,
    encryptedObject: {
      objectDigest: DIGEST,
      objectVersion: "v1",
      custodyReference: "custody://object"
    },
    cryptoUseProofDigest: DIGEST,
    publisherUseProofDigest: DIGEST,
    destructionReceiptDigest: DIGEST,
    dataCustodyReceiptDigest: DIGEST,
    runTerminalState: "success"
  };
  assertSchemaInvalidAdditionalProperties("snapshot-producer-completion.v1", completion);
});

test("terminal observation rejects non-success runs and required job conclusions", () => {
  const observation = {
    schemaVersion: "producer-terminal-observation.v1",
    snapshotProducerCompletionDigest: DIGEST,
    producerRun: {
      repository: "keqi119/subscription-Saas",
      runId: "123",
      runAttempt: 1,
      workflowPath: ".github/workflows/sanitized-snapshot.yml",
      sourceSha: "b".repeat(40),
      status: "completed",
      conclusion: "cancelled"
    },
    requiredJobs: [
      { id: "1", name: "snapshot-admission", status: "completed", conclusion: "success" },
      { id: "2", name: "snapshot-data", status: "completed", conclusion: "success" },
      { id: "3", name: "snapshot-custody", status: "completed", conclusion: "success" }
    ],
    githubApiReadback: { responseDigest: DIGEST, observedAt: NOW },
    externalCustodyReadback: {
      reference: "custody://object",
      contentDigest: DIGEST,
      observedAt: NOW
    }
  };
  assert.throws(() => validateContract("producer-terminal-observation.v1", observation), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
});
