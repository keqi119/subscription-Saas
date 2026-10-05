import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { buildEnvironmentPolicyIdentity } from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { createH1SnapshotObservations } from "./snapshot-h1-observations.mjs";

const SHA = "b".repeat(40);
const NOW = "2026-10-05T14:00:00.000Z";
const nonce = "c".repeat(32);
const route = `stage1-snapshot-export-123-${nonce}`;
const labels = ["self-hosted", "linux", "x64", "stage1-snapshot-export", route];
const repository = { id: 1253231368, full_name: "keqi119/subscription-Saas" };
const workflow = Buffer.from(`name: snapshot
on:
  workflow_dispatch:
jobs:
  admission:
    steps:
      - uses: actions/upload-artifact@${"a".repeat(40)}
        with:
          name: snapshot-admission
          path: .release-output/snapshot-admission.v1.json
          overwrite: false
          if-no-files-found: error
  snapshot-data:
    needs: admission
    steps:
      - run: fixed-entry
  snapshot-custody:
    needs: snapshot-data
    steps:
      - run: fixed-custody
`);

function fixture() {
  const rootPolicy = {
    repository: { id: String(repository.id), name: repository.full_name },
    actorId: "275060624",
    environment: { id: "23175152803", name: "stage1-snapshot-export" },
    workflow: {
      path: ".github/workflows/sanitized-snapshot.yml",
      ref: "main",
      blobDigest: sha256Bytes(workflow),
      actionCommits: [{ action: "actions/upload-artifact", commit: "a".repeat(40) }]
    }
  };
  const run = {
    id: 123,
    run_attempt: 1,
    repository,
    head_repository: repository,
    head_sha: SHA,
    head_branch: "main",
    path: rootPolicy.workflow.path,
    actor: { id: 275060624 },
    event: "workflow_dispatch",
    status: "in_progress"
  };
  const admissionJob = {
    id: 77,
    run_id: 123,
    head_sha: SHA,
    name: "admission",
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-05T13:58:00Z",
    completed_at: "2026-10-05T13:59:00Z",
    labels: ["ubuntu-latest"]
  };
  const job = {
    id: 99,
    run_id: 123,
    head_sha: SHA,
    name: "snapshot-data",
    status: "queued",
    labels,
    check_run_url: "https://api.github.com/repos/keqi119/subscription-Saas/check-runs/555"
  };
  const raw = {
    observedAt: NOW,
    usedRouteNonces: [],
    repository,
    run,
    jobs: [admissionJob, job],
    environment: {
      id: 23175152803,
      name: "stage1-snapshot-export",
      can_admins_bypass: false,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [{ type: "User", reviewer: { id: 275060624 } }]
        },
        { type: "branch_policy" }
      ],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
    },
    branchPolicies: [{ id: 61601943, type: "branch", name: "main" }],
    workflowBytes: workflow,
    artifact: {
      metadata: {
        id: 456,
        name: "snapshot-admission",
        workflow_run: { id: 123, repository_id: repository.id, head_sha: SHA },
        created_at: "2026-10-05T13:58:45Z"
      },
      bytes: Buffer.from("{}")
    },
    activeRuns: [{ run, jobs: [admissionJob, job] }],
    deployment: {
      job,
      checkRun: {
        id: "CR_actual_api_node",
        databaseId: 555,
        name: "snapshot-data",
        status: "QUEUED",
        repository: { databaseId: repository.id, nameWithOwner: repository.full_name },
        checkSuite: { commit: { oid: SHA }, workflowRun: { databaseId: 123 } },
        deployment: { databaseId: 88, environment: "stage1-snapshot-export", commitOid: SHA },
        pendingDeploymentRequest: null
      }
    },
    reviews: [
      {
        state: "approved",
        user: { id: 275060624 },
        environments: [{ id: 23175152803, name: "stage1-snapshot-export" }]
      }
    ]
  };
  const selection = {
    repository: rootPolicy.repository,
    runId: "123",
    runAttempt: 1,
    sourceSha: SHA,
    admissionJobId: "77",
    jobId: "99",
    artifactId: "456",
    artifactName: "snapshot-admission"
  };
  let reads = 0;
  const inputs = {
    rootPolicy,
    selection,
    readGitHub: async (actual) => {
      assert.deepEqual(actual, selection);
      reads++;
      return raw;
    },
    clock: { now: () => NOW }
  };
  return {
    raw,
    inputs,
    get reads() {
      return reads;
    },
    set nonces(value) {
      raw.usedRouteNonces = value;
    }
  };
}

test("root source maps actual environment, workflow bytes, artifact and all active runs", async () => {
  const f = fixture();
  const competitor = {
    ...f.raw.run,
    id: 124,
    run_attempt: 2,
    head_repository: { id: 42 },
    path: ".github/workflows/other.yml"
  };
  f.raw.activeRuns.push({
    run: competitor,
    jobs: [
      { id: 100, run_id: 124, head_sha: SHA, name: "other", status: "queued", labels: [...labels] }
    ]
  });
  const source = createH1SnapshotObservations(f.inputs);
  const observed = await source.githubObservations.readExact(f.inputs.selection);
  assert.equal(f.reads, 1);
  assert.deepEqual(
    observed.queuedJobs.map((job) => [job.runId, job.runAttempt, job.id]),
    [
      ["123", 1, "99"],
      ["124", 2, "100"]
    ]
  );
  assert.equal(observed.environmentPolicy.environment.waitTimerSeconds, 0);
  assert.equal(observed.environmentPolicy.workflow.blobDigest, sha256Bytes(workflow));
  assert.deepEqual(observed.artifact.bytes, Buffer.from("{}"));
  assert.equal(Object.hasOwn(observed.artifact, "jobId"), false);
  assert.equal(Object.hasOwn(observed.artifact, "runAttempt"), false);
  f.nonces = [nonce];
  const reread = await source.githubObservations.readExact(f.inputs.selection);
  assert.deepEqual(reread.usedRouteNonces, [nonce]);
  assert.equal(f.reads, 2);
  assert.deepEqual(observed.usedRouteNonces, []);
});

test("root source rejects missing queue coverage, changed identities and weakened environment", async () => {
  const mutations = [
    (raw) => {
      raw.activeRuns = [];
    },
    (raw) => {
      raw.run.head_sha = "d".repeat(40);
    },
    (raw) => {
      raw.artifact.metadata.workflow_run.id = 999;
    },
    (raw) => {
      raw.environment.can_admins_bypass = true;
    },
    (raw) => {
      raw.branchPolicies.push({ id: 2, type: "tag", name: "*" });
    },
    (raw) => {
      raw.environment.protection_rules[0].reviewers[0].type = "Team";
    },
    (raw) => {
      raw.workflowBytes = Buffer.from(workflow.toString().replace("a".repeat(40), "d".repeat(40)));
    },
    (raw) => {
      raw.activeRuns[0].jobs.push({ ...raw.jobs[1] });
    }
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f.raw);
    const source = createH1SnapshotObservations(f.inputs);
    await assert.rejects(source.githubObservations.readExact(f.inputs.selection));
  }
  const f = fixture();
  const source = createH1SnapshotObservations(f.inputs);
  await assert.rejects(
    source.githubObservations.readExact({ ...f.inputs.selection, artifactId: "999" })
  );
  assert.equal(f.reads, 0);
});

test("postapproval source rereads live facts and rejects missing actual deployment", async () => {
  const f = fixture();
  const source = createH1SnapshotObservations(f.inputs);
  const observation = await source.githubObservations.readExact(f.inputs.selection);
  const identity = buildEnvironmentPolicyIdentity({
    rootPolicy: f.inputs.rootPolicy,
    apiPolicy: observation.environmentPolicy
  });
  const admission = {
    schemaVersion: "snapshot-admission.v1",
    dispatchAuthorizationDigest: `sha256:${"a".repeat(64)}`,
    releaseAttemptId: "attempt-1",
    executionPurpose: "qualification",
    producerRun: {
      repository: repository.full_name,
      runId: "123",
      runAttempt: 1,
      workflowPath: f.inputs.rootPolicy.workflow.path,
      workflowRef: "main",
      workflowBlobDigest: sha256Bytes(workflow),
      sourceSha: SHA
    },
    route: { nonce, label: route },
    adapterDigest: `sha256:${"a".repeat(64)}`,
    environmentPolicyIdentityDigest: sha256Canonical(identity)
  };
  const request = {
    admission,
    approvalSelection: { runId: "123", runAttempt: 1, jobId: "99", deploymentId: "88" }
  };
  const approved = await source.readPostApproval(request);
  assert.equal(f.reads, 2);
  assert.equal(approved.observation.deployment.id, "88");
  f.raw.deployment.checkRun.deployment = null;
  await assert.rejects(source.readPostApproval(request));
  assert.equal(f.reads, 3);
});
