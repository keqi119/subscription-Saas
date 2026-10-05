// Root-private API adapter. Only the trusted launcher supplies these readers;
// none is obtained from a workflow, job environment, artifact, or admission.
import { Buffer } from "node:buffer";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import {
  assertKernelFrame,
  snapshotKernelData,
  buildEnvironmentPolicyIdentity,
  buildPostApprovalObservationFromGitHub
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { readSnapshotWorkflowIdentity } from "../../packages/release-foundation/src/snapshot/snapshot-admission-verification.mjs";
import { createH1GitHubReader } from "./snapshot-h1-github-reader.mjs";
import { createH1GitHubJwtSupplier } from "./snapshot-h1-github-jwt.mjs";

const CODE = "H1_GITHUB_OBSERVATION_INVALID";
const REPOSITORY = { id: "1253231368", name: "keqi119/subscription-Saas" };
const PATH = ".github/workflows/sanitized-snapshot.yml";
const ACTIVE = ["in_progress", "queued", "requested", "waiting", "pending"];
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const requireThat = (value) => {
  if (!value) fail();
};
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const frame = (value, fields) => assertKernelFrame(value, fields, CODE);
const id = (value) => {
  requireThat(Number.isSafeInteger(value) && value > 0);
  return String(value);
};
const repository = (value) => {
  requireThat(value && id(value.id) === REPOSITORY.id && value.full_name === REPOSITORY.name);
};
const timestamp = (value) => {
  requireThat(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  );
  const result = Date.parse(value);
  requireThat(
    Number.isFinite(result) && new Date(result).toISOString().slice(0, 19) === value.slice(0, 19)
  );
  return result;
};

function environmentPolicy(raw) {
  const env = raw.environment;
  requireThat(env && Array.isArray(env.protection_rules) && Array.isArray(raw.branchPolicies));
  const rules = new Map();
  for (const rule of env.protection_rules) {
    requireThat(
      rule &&
        ["required_reviewers", "wait_timer", "branch_policy"].includes(rule.type) &&
        !rules.has(rule.type)
    );
    rules.set(rule.type, rule);
  }
  const reviewerRule = rules.get("required_reviewers");
  requireThat(reviewerRule && Array.isArray(reviewerRule.reviewers) && rules.has("branch_policy"));
  requireThat(
    env.deployment_branch_policy?.protected_branches === false &&
      env.deployment_branch_policy.custom_branch_policies === true
  );
  const reviewerIds = reviewerRule.reviewers.map((item) => {
    requireThat(item?.type === "User");
    return id(item.reviewer?.id);
  });
  const wait = rules.get("wait_timer");
  if (wait)
    requireThat(
      Number.isSafeInteger(wait.wait_timer) && wait.wait_timer >= 0 && wait.wait_timer <= 43200
    );
  const branchIds = new Set();
  for (const policy of raw.branchPolicies) {
    const key = id(policy.id);
    requireThat(
      !branchIds.has(key) &&
        ["branch", "tag"].includes(policy.type) &&
        typeof policy.name === "string"
    );
    branchIds.add(key);
  }
  const workflow = readSnapshotWorkflowIdentity(raw.workflowBytes);
  return {
    environment: {
      id: id(env.id),
      name: env.name,
      canAdminsBypass: env.can_admins_bypass,
      preventSelfReview: reviewerRule.prevent_self_review,
      // No wait_timer rule means no delay; GitHub's configured unit is minutes.
      waitTimerSeconds: wait ? wait.wait_timer * 60 : 0,
      requiredReviewerIds: reviewerIds,
      branchRules: raw.branchPolicies
        .filter((policy) => policy.type === "branch")
        .map((policy) => policy.name),
      tagRules: raw.branchPolicies
        .filter((policy) => policy.type === "tag")
        .map((policy) => policy.name)
    },
    workflow: { path: PATH, ref: "main", ...workflow },
    github: { environment: env, branchPolicies: raw.branchPolicies }
  };
}

function jobsForRun(run, jobs, seen) {
  repository(run.repository);
  const runId = id(run.id);
  requireThat(
    Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0 &&
      typeof run.head_sha === "string" &&
      /^[a-f0-9]{40}$/.test(run.head_sha) &&
      Array.isArray(jobs) &&
      jobs.length <= 100
  );
  return jobs.map((job) => {
    const jobId = id(job.id);
    requireThat(
      !seen.has(jobId) &&
        id(job.run_id) === runId &&
        job.head_sha === run.head_sha &&
        (job.run_attempt === undefined || job.run_attempt === run.run_attempt) &&
        typeof job.name === "string" &&
        ["completed", ...ACTIVE].includes(job.status) &&
        Array.isArray(job.labels) &&
        job.labels.every((label) => typeof label === "string")
    );
    seen.add(jobId);
    // runAttempt is bound to the actual run and the attempt-specific jobs API,
    // not asserted to be a field present on every job response.
    return {
      repository: REPOSITORY.name,
      runId,
      runAttempt: run.run_attempt,
      id: jobId,
      name: job.name,
      status: job.status,
      labels: job.labels
    };
  });
}

function mapped(raw, selection, rootPolicy, nonces, now) {
  frame(raw, [
    "observedAt",
    "usedRouteNonces",
    "repository",
    "run",
    "jobs",
    "environment",
    "branchPolicies",
    "workflowBytes",
    "artifact",
    "activeRuns",
    "deployment",
    "reviews"
  ]);
  const age = timestamp(now) - timestamp(raw.observedAt);
  requireThat(age >= 0 && age < 300000);
  repository(raw.repository);
  const run = raw.run;
  repository(run.repository);
  repository(run.head_repository);
  requireThat(
    id(run.id) === selection.runId &&
      run.run_attempt === 1 &&
      run.head_sha === selection.sourceSha &&
      id(run.actor?.id) === "275060624" &&
      run.path === PATH &&
      run.head_branch === "main" &&
      run.event === "workflow_dispatch" &&
      ACTIVE.includes(run.status)
  );
  const selectedJobs = jobsForRun(run, raw.jobs, new Set());
  const admissionJob = raw.jobs.find((job) => id(job.id) === selection.admissionJobId);
  const job = raw.jobs.find((item) => id(item.id) === selection.jobId);
  requireThat(
    admissionJob?.name === "admission" &&
      admissionJob.status === "completed" &&
      admissionJob.conclusion === "success" &&
      job?.name === "snapshot-data" &&
      ["waiting", "queued"].includes(job.status)
  );
  frame(raw.artifact, ["metadata", "bytes"]);
  const metadata = raw.artifact.metadata;
  requireThat(
    id(metadata.id) === selection.artifactId &&
      metadata.name === "snapshot-admission" &&
      id(metadata.workflow_run?.id) === selection.runId &&
      id(metadata.workflow_run.repository_id) === REPOSITORY.id &&
      metadata.workflow_run.head_sha === selection.sourceSha &&
      Buffer.isBuffer(raw.artifact.bytes) &&
      raw.artifact.bytes.length > 0 &&
      raw.artifact.bytes.length <= 1048576
  );
  const environment = environmentPolicy(raw);
  buildEnvironmentPolicyIdentity({ rootPolicy, apiPolicy: environment });
  requireThat(Array.isArray(raw.activeRuns) && raw.activeRuns.length <= 100);
  const runIds = new Set(),
    jobIds = new Set(),
    queuedJobs = [];
  for (const group of raw.activeRuns) {
    frame(group, ["run", "jobs"]);
    const key = id(group.run.id);
    requireThat(!runIds.has(key) && ACTIVE.includes(group.run.status));
    runIds.add(key);
    const jobs = jobsForRun(group.run, group.jobs, jobIds);
    requireThat(jobIds.size <= 100);
    if (key === selection.runId) {
      requireThat(
        group.run.run_attempt === 1 &&
          group.run.head_sha === selection.sourceSha &&
          same(jobs, selectedJobs)
      );
    }
    queuedJobs.push(...jobs.filter((item) => ["waiting", "queued"].includes(item.status)));
  }
  requireThat(
    runIds.has(selection.runId) &&
      Array.isArray(nonces) &&
      nonces.every((nonce) => typeof nonce === "string" && /^[a-f0-9]{32}$/.test(nonce)) &&
      new Set(nonces).size === nonces.length
  );
  return {
    repository: REPOSITORY,
    producerRun: {
      repository: REPOSITORY.name,
      runId: selection.runId,
      runAttempt: 1,
      workflowPath: run.path,
      workflowRef: run.head_branch,
      workflowBlobDigest: environment.workflow.blobDigest,
      sourceSha: run.head_sha,
      event: run.event,
      actorId: id(run.actor.id)
    },
    admissionJob: {
      repository: REPOSITORY.name,
      runId: selection.runId,
      runAttempt: 1,
      id: id(admissionJob.id),
      name: admissionJob.name,
      status: admissionJob.status,
      conclusion: admissionJob.conclusion,
      sourceSha: admissionJob.head_sha,
      startedAt: admissionJob.started_at,
      completedAt: admissionJob.completed_at
    },
    workflow: {
      repositoryId: REPOSITORY.id,
      path: run.path,
      sourceSha: run.head_sha,
      bytes: raw.workflowBytes
    },
    environmentPolicy: environment,
    artifact: {
      id: id(metadata.id),
      name: metadata.name,
      repositoryId: id(metadata.workflow_run.repository_id),
      runId: id(metadata.workflow_run.id),
      sourceSha: metadata.workflow_run.head_sha,
      createdAt: metadata.created_at,
      bytes: raw.artifact.bytes
    },
    queuedJobs,
    usedRouteNonces: nonces
  };
}

export function createH1SnapshotObservations(input) {
  frame(input, ["selection", "rootPolicy", "readGitHub", "clock"]);
  const captured = snapshotKernelData(input, CODE, true);
  const { selection, rootPolicy, readGitHub, clock } = captured;
  frame(selection, [
    "repository",
    "runId",
    "runAttempt",
    "sourceSha",
    "admissionJobId",
    "jobId",
    "artifactId",
    "artifactName"
  ]);
  requireThat(
    same(selection.repository, REPOSITORY) &&
      selection.runAttempt === 1 &&
      selection.artifactName === "snapshot-admission" &&
      typeof selection.sourceSha === "string" &&
      /^[a-f0-9]{40}$/.test(selection.sourceSha) &&
      [selection.runId, selection.admissionJobId, selection.jobId, selection.artifactId].every(
        (value) => typeof value === "string" && /^[1-9][0-9]*$/.test(value)
      ) &&
      selection.admissionJobId !== selection.jobId &&
      typeof readGitHub === "function"
  );
  frame(clock, ["now"]);
  requireThat(typeof clock.now === "function");
  async function read() {
    let raw;
    try {
      raw = snapshotKernelData(await readGitHub(selection), CODE);
    } catch {
      throw Object.assign(new Error("H1_GITHUB_OBSERVATION_UNAVAILABLE"), {
        code: "H1_GITHUB_OBSERVATION_UNAVAILABLE"
      });
    }
    const now = clock.now();
    return { raw, now, observation: mapped(raw, selection, rootPolicy, raw.usedRouteNonces, now) };
  }
  return Object.freeze({
    githubObservations: Object.freeze({
      selection,
      async readExact(request) {
        requireThat(same(snapshotKernelData(request, CODE), selection));
        return snapshotKernelData((await read()).observation, CODE);
      }
    }),
    async readPostApproval(request) {
      frame(request, ["admission", "approvalSelection"]);
      const copied = snapshotKernelData(request, CODE);
      const { raw, now, observation } = await read();
      frame(raw.deployment, ["job", "checkRun"]);
      const job = raw.jobs.find((item) => id(item.id) === selection.jobId);
      requireThat(same(raw.deployment.job, job));
      const apiPolicy = {
        ...observation.environmentPolicy,
        approval: {
          observedAt: raw.observedAt,
          run: raw.run,
          job,
          checkRun: raw.deployment.checkRun,
          reviews: raw.reviews
        }
      };
      return buildPostApprovalObservationFromGitHub({
        rootPolicy,
        apiPolicy,
        ...copied,
        now,
        maxAgeMs: 300000
      });
    }
  });
}

export function createInstalledH1SnapshotObservations(input) {
  frame(input, ["selection", "rootPolicy", "installation", "clock"]);
  const { selection, rootPolicy, installation, clock } = snapshotKernelData(input, CODE, true);
  return createH1SnapshotObservations({
    selection,
    rootPolicy,
    clock,
    readGitHub: createH1GitHubReader({ jwtSupplier: createH1GitHubJwtSupplier(), installation })
  });
}
