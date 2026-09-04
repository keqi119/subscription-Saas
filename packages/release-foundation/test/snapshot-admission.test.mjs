import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { buildEnvironmentPolicyIdentity } from "../src/snapshot/environment-policy.mjs";
import {
  buildSnapshotAdmission,
  createUntrustedSnapshotAdmissionInput,
  uniqueRouteLabel
} from "../src/snapshot/snapshot-admission.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const SHA = "b".repeat(40);

const rootPolicy = {
  repository: { id: "1253231368", name: "keqi119/subscription-Saas" },
  actorId: "275060624",
  environment: { id: "44", name: "stage1-snapshot-export" },
  workflow: {
    path: ".github/workflows/sanitized-snapshot.yml",
    ref: "main",
    blobDigest: DIGEST,
    actionCommits: [{ action: "actions/checkout", commit: "d".repeat(40) }]
  }
};
const apiPolicy = {
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
  workflow: rootPolicy.workflow
};

function verifiedDispatch() {
  return {
    authorization: {
      schemaVersion: "rc-dispatch-authorization.v1",
      authorizationId: "authorization-1",
      executionPurpose: "qualification",
      releaseAttemptId: "attempt-1",
      sourceSha: SHA,
      producerWorkflow: {
        path: ".github/workflows/sanitized-snapshot.yml",
        ref: "main",
        blobDigest: DIGEST
      },
      adapterDigest: DIGEST,
      rcWorkflow: {
        path: ".github/workflows/release-candidate-gate.yml",
        ref: "main",
        blobDigest: DIGEST
      },
      buildProofDigest: DIGEST,
      buildBundleDigest: DIGEST,
      repositoryContractDigest: DIGEST,
      issuer: "test-issuer",
      issuedAt: "2026-09-03T00:00:00.000Z",
      notAfter: "2026-09-03T00:10:00.000Z",
      revocationPolicyDigest: DIGEST
    },
    authorizationDigest: DIGEST,
    expected: {
      executionPurpose: "qualification",
      releaseAttemptId: "attempt-1",
      sourceSha: SHA,
      producerWorkflow: {
        path: ".github/workflows/sanitized-snapshot.yml",
        ref: "main",
        blobDigest: DIGEST
      },
      adapterDigest: DIGEST
    }
  };
}

function producerRun() {
  return {
    repository: "keqi119/subscription-Saas",
    runId: "123",
    runAttempt: 1,
    workflowPath: ".github/workflows/sanitized-snapshot.yml",
    workflowRef: "main",
    workflowBlobDigest: DIGEST,
    sourceSha: SHA,
    event: "workflow_dispatch",
    queuedLabels: ["self-hosted", "linux", "x64", "stage1-snapshot-export"]
  };
}

test("unique route labels are exactly run-bound 128-bit identities", () => {
  assert.equal(
    uniqueRouteLabel("123", "c".repeat(32)),
    `stage1-snapshot-export-123-${"c".repeat(32)}`
  );
  for (const [runId, routeNonce] of [
    ["0", "c".repeat(32)],
    ["123", "c".repeat(31)],
    ["123", "C".repeat(32)]
  ])
    assert.throws(() => uniqueRouteLabel(runId, routeNonce), {
      code: "SNAPSHOT_ROUTE_IDENTITY_INVALID"
    });
});

test("untrusted preparation generates a nonce without claiming a decision", () => {
  const prepared = createUntrustedSnapshotAdmissionInput({
    authorization: verifiedDispatch().authorization,
    producerRunObservation: producerRun(),
    route: {
      nonce: randomBytes(16).toString("hex"),
      environmentPolicyIdentityDigest: `sha256:${"0".repeat(64)}`
    }
  });
  assert.equal(prepared.schemaVersion, "snapshot-admission.v1");
  assert.equal(prepared.releaseAttemptId, "attempt-1");
  assert.equal(prepared.verifiedDispatch, undefined);
  assert.equal(prepared.rootSigner, undefined);
  assert.equal(prepared.route.label, uniqueRouteLabel("123", prepared.route.nonce));
});

test("trusted reconstruction never treats a plain dispatch-shaped object as a decision", () => {
  const policyIdentity = buildEnvironmentPolicyIdentity({ rootPolicy, apiPolicy });
  assert.throws(
    () =>
      buildSnapshotAdmission({
        verifiedDispatch: verifiedDispatch(),
        producerRunObservation: producerRun(),
        routeNonce: "c".repeat(32),
        rootPolicy: { ...rootPolicy, environmentPolicyIdentity: policyIdentity },
        now: "2026-09-03T00:00:00.000Z"
      }),
    { code: "DISPATCH_DECISION_UNVERIFIED" }
  );
});

test("trusted reconstruction rejects unverified decisions and inconsistent route or producer facts", () => {
  const policyIdentity = buildEnvironmentPolicyIdentity({ rootPolicy, apiPolicy });
  const policy = { ...rootPolicy, environmentPolicyIdentity: policyIdentity };
  for (const mutate of [
    (v) => {
      v.verifiedDispatch = { ...v.verifiedDispatch };
    },
    (v) => {
      v.producerRunObservation.runAttempt = 2;
    },
    (v) => {
      v.producerRunObservation.workflowRef = "tag";
    },
    (v) => {
      v.producerRunObservation.event = "push";
    },
    (v) => {
      v.producerRunObservation.workflowBlobDigest = `sha256:${"f".repeat(64)}`;
    },
    (v) => {
      v.producerRunObservation.queuedLabels.push(uniqueRouteLabel("123", "c".repeat(32)));
    },
    (v) => {
      v.routeNonce = "d".repeat(32);
    }
  ]) {
    const input = {
      verifiedDispatch: verifiedDispatch(),
      producerRunObservation: producerRun(),
      routeNonce: "c".repeat(32),
      rootPolicy: policy,
      now: "2026-09-03T00:00:00.000Z"
    };
    mutate(input);
    assert.throws(() => buildSnapshotAdmission(input), /(?:SNAPSHOT_|DISPATCH_)/);
  }
});
