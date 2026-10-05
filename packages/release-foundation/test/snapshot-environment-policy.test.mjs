import assert from "node:assert/strict";
import test from "node:test";

import { sha256Canonical } from "../src/digest.mjs";
import {
  buildEnvironmentPolicyIdentity,
  buildEnvironmentPolicyObservation,
  buildPostApprovalObservationFromGitHub,
  verifyPostApprovalObservation
} from "../src/snapshot/environment-policy.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const SHA = "b".repeat(40);
const NOW = "2026-09-03T00:00:00.000Z";
const nonce = "c".repeat(32);
const { structuredClone } = globalThis;

function rootPolicy() {
  return {
    repository: { id: "1253231368", name: "keqi119/subscription-Saas" },
    actorId: "275060624",
    environment: { id: "44", name: "stage1-snapshot-export" },
    workflow: {
      path: ".github/workflows/sanitized-snapshot.yml",
      ref: "main",
      blobDigest: DIGEST,
      actionCommits: [
        { action: "actions/checkout", commit: "d".repeat(40) },
        { action: "actions/setup-node", commit: "e".repeat(40) }
      ]
    }
  };
}

function apiPolicyAt(observedAt = NOW) {
  return {
    environment: {
      id: "44",
      name: "stage1-snapshot-export",
      canAdminsBypass: false,
      preventSelfReview: false,
      waitTimerSeconds: 0,
      requiredReviewerIds: ["275060624"],
      branchRules: ["main"],
      tagRules: []
    },
    workflow: {
      path: ".github/workflows/sanitized-snapshot.yml",
      ref: "main",
      blobDigest: DIGEST,
      actionCommits: [
        { action: "actions/setup-node", commit: "e".repeat(40) },
        { action: "actions/checkout", commit: "d".repeat(40) }
      ]
    },
    retrievedAt: observedAt,
    responseId: `environment-response-${observedAt}`
  };
}

function admission(identityDigest) {
  return {
    schemaVersion: "snapshot-admission.v1",
    dispatchAuthorizationDigest: DIGEST,
    releaseAttemptId: "attempt-1",
    executionPurpose: "qualification",
    producerRun: {
      repository: "keqi119/subscription-Saas",
      runId: "123",
      runAttempt: 1,
      workflowPath: ".github/workflows/sanitized-snapshot.yml",
      workflowRef: "main",
      workflowBlobDigest: DIGEST,
      sourceSha: SHA
    },
    route: { nonce, label: `stage1-snapshot-export-123-${nonce}` },
    adapterDigest: DIGEST,
    environmentPolicyIdentityDigest: identityDigest
  };
}

function approvedFixture() {
  const root = rootPolicy();
  const api = apiPolicyAt();
  const identity = buildEnvironmentPolicyIdentity({ rootPolicy: root, apiPolicy: api });
  const snapshotAdmission = admission(sha256Canonical(identity));
  const observation = buildEnvironmentPolicyObservation({
    identity,
    apiPolicy: api,
    observedAt: NOW,
    phase: "approved-queued",
    deployment: { id: "88", state: "approved" },
    run: {
      repository: "keqi119/subscription-Saas",
      runId: "123",
      runAttempt: 1,
      workflowPath: ".github/workflows/sanitized-snapshot.yml",
      workflowRef: "main",
      sourceSha: SHA
    },
    job: {
      id: "99",
      name: "snapshot-data",
      status: "queued",
      labels: [
        "self-hosted",
        "linux",
        "x64",
        "stage1-snapshot-export",
        snapshotAdmission.route.label
      ]
    },
    review: { reviewerId: "275060624", state: "approved" }
  });
  const approvalSelection = { runId: "123", runAttempt: 1, jobId: "99", deploymentId: "88" };
  api.approval = {
    observedAt: NOW,
    run: {
      id: 123,
      run_attempt: 1,
      head_sha: SHA,
      head_branch: "main",
      event: "workflow_dispatch",
      path: ".github/workflows/sanitized-snapshot.yml",
      actor: { id: 275060624 },
      repository: { id: 1253231368, full_name: "keqi119/subscription-Saas" },
      head_repository: { id: 1253231368, full_name: "keqi119/subscription-Saas" }
    },
    job: {
      id: 99,
      name: "snapshot-data",
      status: "queued",
      labels: [...observation.job.labels],
      run_id: 123,
      head_sha: SHA,
      check_run_url: "https://api.github.com/repos/keqi119/subscription-Saas/check-runs/555"
    },
    checkRun: {
      id: "CR_actual_api_node",
      databaseId: 555,
      name: "snapshot-data",
      status: "QUEUED",
      repository: { databaseId: 1253231368, nameWithOwner: "keqi119/subscription-Saas" },
      checkSuite: { commit: { oid: SHA }, workflowRun: { databaseId: 123 } },
      deployment: { databaseId: 88, environment: "stage1-snapshot-export", commitOid: SHA },
      pendingDeploymentRequest: null
    },
    reviews: [
      {
        state: "approved",
        user: { id: 275060624 },
        environments: [{ id: 44, name: "stage1-snapshot-export" }]
      }
    ]
  };
  const boundObservation = { ...observation, apiResponseDigest: sha256Canonical(api) };
  return {
    root,
    api,
    identity,
    snapshotAdmission,
    observation: boundObservation,
    approvalSelection
  };
}

test("reading the same policy later does not drift identity", () => {
  const a = buildEnvironmentPolicyIdentity({
    rootPolicy: rootPolicy(),
    apiPolicy: apiPolicyAt("2026-09-03T00:00:00Z")
  });
  const b = buildEnvironmentPolicyIdentity({
    rootPolicy: rootPolicy(),
    apiPolicy: apiPolicyAt("2026-09-03T00:04:00Z")
  });
  assert.equal(sha256Canonical(a), sha256Canonical(b));
  assert.deepEqual(
    a.actionCommitAllowlist.map(({ action }) => action),
    ["actions/checkout", "actions/setup-node"]
  );
});

test("identity rejects absent or weakened environment protection facts", () => {
  for (const mutate of [
    (v) => {
      v.environment = "ABSENT";
    },
    (v) => {
      v.environment.requiredReviewerIds = [];
    },
    (v) => {
      v.environment.requiredReviewerIds = ["other"];
    },
    (v) => {
      v.environment.branchRules = ["*"];
    },
    (v) => {
      v.environment.tagRules = ["v*"];
    },
    (v) => {
      v.environment.canAdminsBypass = true;
    },
    (v) => {
      v.environment.preventSelfReview = true;
    },
    (v) => {
      v.environment.waitTimerSeconds = 1;
    },
    (v) => {
      v.workflow.actionCommits[0].commit = "f".repeat(40);
    }
  ]) {
    const api = apiPolicyAt();
    mutate(api);
    assert.throws(
      () => buildEnvironmentPolicyIdentity({ rootPolicy: rootPolicy(), apiPolicy: api }),
      {
        code: "ENVIRONMENT_POLICY_INVALID"
      }
    );
  }
});

test("a five-minute-old post-approval observation is rejected", () => {
  const fixture = approvedFixture();
  assert.throws(
    () =>
      verifyPostApprovalObservation({
        rootPolicy: fixture.root,
        approvalSelection: fixture.approvalSelection,
        apiPolicy: fixture.api,
        identity: fixture.identity,
        observation: fixture.observation,
        admission: fixture.snapshotAdmission,
        now: "2026-09-03T00:05:00.001Z",
        maxAgeMs: 300000
      }),
    /ENVIRONMENT_OBSERVATION_EXPIRED/
  );
});

test("post-approval verification binds latest environment facts, reviewer and exact route", () => {
  for (const mutate of [
    (v) => {
      v.api.environment.id = "45";
    },
    (v) => {
      v.observation.review = { reviewerId: "other", state: "approved" };
    },
    (v) => {
      v.observation.job.labels.pop();
    },
    (v) => {
      v.observation.job.status = "in_progress";
    },
    (v) => {
      v.observation.run.runId = "124";
    },
    (v) => {
      v.observation.phase = "pending";
    },
    (v) => {
      v.observation.observedAt = undefined;
    }
  ]) {
    const original = approvedFixture();
    const fixture = {
      root: structuredClone(original.root),
      api: structuredClone(original.api),
      identity: structuredClone(original.identity),
      snapshotAdmission: structuredClone(original.snapshotAdmission),
      observation: structuredClone(original.observation),
      approvalSelection: original.approvalSelection
    };
    mutate(fixture);
    assert.throws(
      () =>
        verifyPostApprovalObservation({
          rootPolicy: fixture.root,
          approvalSelection: fixture.approvalSelection,
          apiPolicy: fixture.api,
          identity: fixture.identity,
          observation: fixture.observation,
          admission: fixture.snapshotAdmission,
          now: "2026-09-03T00:01:00.000Z",
          maxAgeMs: 300000
        }),
      /ENVIRONMENT_(?:POLICY|OBSERVATION)_/
    );
  }
});

test("postapproval accepts independently bound approval and rejects forged provenance and time", () => {
  const check = (f) =>
    verifyPostApprovalObservation({
      rootPolicy: f.root,
      apiPolicy: f.api,
      identity: f.identity,
      observation: f.observation,
      admission: f.snapshotAdmission,
      approvalSelection: f.approvalSelection,
      now: "2026-09-03T00:01:00.000Z",
      maxAgeMs: 300000
    });
  assert.doesNotThrow(() => check(approvedFixture()));
  for (const mutate of [
    (f) => {
      f.observation.job.id = "100";
    },
    (f) => {
      f.observation.deployment.id = "89";
    },
    (f) => {
      f.api.approval.job.run_id = 124;
    },
    (f) => {
      f.api.approval.reviews[0].environments[0].id = 45;
    },
    (f) => {
      f.api.approval.bypassed = true;
    },
    (f) => {
      f.api.approval.checkRun.deployment.commitOid = "e".repeat(40);
    },
    (f) => {
      f.api.approval.reviews[0].state = "rejected";
    },
    (f) => {
      f.api.approval.observedAt = "2026-09-02T00:00:00Z";
    },
    (f) => {
      f.approvalSelection.jobId = "100";
    }
  ]) {
    const f = structuredClone(approvedFixture());
    mutate(f);
    f.observation.apiResponseDigest = sha256Canonical(f.api);
    assert.throws(() => check(f), { code: "ENVIRONMENT_OBSERVATION_INVALID" });
  }
});

test("postapproval builder accepts actual REST and GraphQL fields without fabricated approval time", () => {
  const f = approvedFixture();
  const result = buildPostApprovalObservationFromGitHub({
    rootPolicy: f.root,
    apiPolicy: f.api,
    admission: f.snapshotAdmission,
    approvalSelection: f.approvalSelection,
    now: NOW,
    maxAgeMs: 300000
  });
  assert.deepEqual(result.identity, f.identity);
  assert.deepEqual(result.observation, f.observation);
  assert.equal(JSON.stringify(f.api.approval).includes("approvedAt"), false);
});

test("actual approval relationship rejects missing, pending, cross-run or conflicting evidence", () => {
  for (const mutate of [
    (f) => {
      f.api.approval.checkRun.deployment = null;
    },
    (f) => {
      f.api.approval.checkRun.pendingDeploymentRequest = {
        environment: { name: "stage1-snapshot-export" }
      };
    },
    (f) => {
      f.api.approval.checkRun.checkSuite.workflowRun.databaseId = 124;
    },
    (f) => {
      f.api.approval.job.check_run_url =
        "https://api.github.com/repos/other/project/check-runs/555";
    },
    (f) => {
      f.api.approval.run.actor.id = 12;
    },
    (f) => {
      f.api.approval.reviews[0].user.id = 12;
    },
    (f) => {
      f.api.approval.reviews.push({
        ...structuredClone(f.api.approval.reviews[0]),
        state: "rejected"
      });
    },
    (f) => {
      f.api.approval.job.status = "waiting";
    },
    (f) => {
      f.api.approval.checkRun.status = "IN_PROGRESS";
    }
  ]) {
    const f = approvedFixture();
    mutate(f);
    assert.throws(
      () =>
        buildPostApprovalObservationFromGitHub({
          rootPolicy: f.root,
          apiPolicy: f.api,
          admission: f.snapshotAdmission,
          approvalSelection: f.approvalSelection,
          now: NOW,
          maxAgeMs: 300000
        }),
      { code: "ENVIRONMENT_OBSERVATION_INVALID" }
    );
  }
});

test("identity is deeply immutable and never exposes shared policy constants", () => {
  const identity = buildEnvironmentPolicyIdentity({
    rootPolicy: rootPolicy(),
    apiPolicy: apiPolicyAt()
  });
  assert.throws(() => {
    identity.repository.id = "2";
  }, TypeError);
  assert.throws(() => {
    identity.actionCommitAllowlist[0].commit = "f".repeat(40);
  }, TypeError);
  assert.equal(
    buildEnvironmentPolicyIdentity({ rootPolicy: rootPolicy(), apiPolicy: apiPolicyAt() })
      .repository.id,
    "1253231368"
  );
});

test("policy rejects accessors without invoking them", () => {
  let reads = 0;
  const api = apiPolicyAt();
  Object.defineProperty(api.environment, "id", {
    enumerable: true,
    get() {
      reads++;
      return "44";
    }
  });
  assert.throws(
    () => buildEnvironmentPolicyIdentity({ rootPolicy: rootPolicy(), apiPolicy: api }),
    { code: "ENVIRONMENT_POLICY_INVALID" }
  );
  assert.equal(reads, 0);
});
