import assert from "node:assert/strict";
import test from "node:test";
import { snapshotCustodyContext, provisionalSnapshotCustody } from "./snapshot-custody-job.mjs";
import { validateSnapshotCustody } from "../../packages/release-foundation/src/snapshot/custody-contracts.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const sourceSha = "b".repeat(40);
const releaseAttemptId = "11111111-2222-4333-8444-555555555555";
const workflowPath = ".github/workflows/sanitized-snapshot.yml";

test("custody context binds the exact hosted job, attempt, actor and checkout", () => {
  const authorization = {
    schemaVersion: "rc-dispatch-authorization.v1",
    authorizationId: "authorization-1",
    executionPurpose: "qualification",
    releaseAttemptId,
    sourceSha,
    producerWorkflow: { path: workflowPath, ref: "main", blobDigest: digest },
    rcWorkflow: {
      path: ".github/workflows/release-candidate-gate.yml",
      ref: "main",
      blobDigest: digest
    },
    buildProofDigest: digest,
    buildBundleDigest: digest,
    repositoryContractDigest: digest,
    adapterDigest: digest,
    issuer: "dispatch",
    issuedAt: "2026-10-06T00:00:00.000Z",
    notAfter: "2026-10-06T01:00:00.000Z",
    revocationPolicyDigest: digest
  };
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_REPOSITORY: "keqi119/subscription-Saas",
    GITHUB_REPOSITORY_ID: "1253231368",
    GITHUB_ACTOR_ID: "275060624",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "12345",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: sourceSha,
    GITHUB_JOB: "snapshot-custody",
    GITHUB_WORKFLOW_REF: `keqi119/subscription-Saas/${workflowPath}@refs/heads/main`,
    STAGE1_SNAPSHOT_ACCESS_POLICY_DIGEST: digest
  };
  assert.equal(snapshotCustodyContext(env, authorization).releaseAttemptId, releaseAttemptId);
  for (const patch of [
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_ACTOR_ID: "42" },
    { GITHUB_JOB: "snapshot-data" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { GITHUB_SHA: "c".repeat(40) },
    { STAGE1_SNAPSHOT_ACCESS_POLICY_DIGEST: "" }
  ]) {
    assert.throws(() => snapshotCustodyContext({ ...env, ...patch }, authorization), {
      code: "SNAPSHOT_CUSTODY_JOB_REJECTED"
    });
  }
});

function readbackFixture() {
  const envelope = {
    releaseAttemptId,
    snapshotRunId: "12345",
    sourceSha,
    ciphertextDigest: digest,
    ciphertextSizeBytes: 8192,
    expiresAt: "2026-11-05T00:00:00.000Z"
  };
  const object = {
    key: `snapshot-slots/v2/${releaseAttemptId}/12345/snapshot.enc`,
    requestId: "actual-put"
  };
  const read = {
    key: object.key,
    version: "null-version-disabled",
    etag: "etag-one",
    digest,
    sizeBytes: 8192,
    lastModified: "2026-10-06T00:01:00.000Z"
  };
  return {
    status: "READBACK_VERIFIED",
    data: { data: { envelope } },
    publication: { objects: [object] },
    observedAt: "2026-10-06T00:02:00.000Z",
    observations: [
      {
        get: { ...read },
        head: { ...read },
        expectedWriterArn: "snapshot-publisher-session",
        readerArn: "snapshot-reader-session",
        bucket: { acl: "private", worm: { id: "actual-worm", state: "Locked", retentionDays: 210 } }
      }
    ]
  };
}

test("readback produces only provisional custody and keeps independent identities and real retention", () => {
  const result = provisionalSnapshotCustody(readbackFixture(), digest);
  assert.equal(result.provisional, true);
  assert.equal(result.terminalAt, null);
  assert.equal(result.conditionalCreate.requestId, "actual-put");
  assert.equal(result.worm.retainUntil, "2027-05-04T00:01:00.000Z");
  assert.throws(() => validateSnapshotCustody(result), {
    code: "SNAPSHOT_CUSTODY_TERMINAL_REVALIDATION_REQUIRED"
  });
  const mismatched = readbackFixture();
  mismatched.observations[0].head.digest = `sha256:${"c".repeat(64)}`;
  assert.throws(() => provisionalSnapshotCustody(mismatched, digest), {
    code: "SNAPSHOT_CUSTODY_OBJECT_READBACK_INVALID"
  });
  const sameIdentity = readbackFixture();
  sameIdentity.observations[0].readerArn = sameIdentity.observations[0].expectedWriterArn;
  assert.throws(() => provisionalSnapshotCustody(sameIdentity, digest), {
    code: "SNAPSHOT_CUSTODY_IDENTITY_NOT_INDEPENDENT"
  });
});
