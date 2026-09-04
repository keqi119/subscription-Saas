import { canonicalJson } from "../canonical-json.mjs";
import { sha256Canonical } from "../digest.mjs";
import { validateContract } from "../schema-registry.mjs";

const REPOSITORY = Object.freeze({ id: "1253231368", name: "keqi119/subscription-Saas" });
const ACTOR_ID = "275060624";
const ENVIRONMENT_NAME = "stage1-snapshot-export";
const WORKFLOW_PATH = ".github/workflows/sanitized-snapshot.yml";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[1-9][0-9]*$/;
const coded = (code) => Object.assign(new Error(code), { code });
const fail = (code) => {
  throw coded(code);
};
const same = (left, right) => canonicalJson(left) === canonicalJson(right);

// Internal kernel boundary helper. Never evaluate accessors, preserve no caller-owned data,
// and capture function slots only in explicitly function-bearing runtime frames.
export function snapshotKernelData(value, code, capabilities = false, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (capabilities && typeof value === "function") return value;
  if (!value || typeof value !== "object" || seen.has(value)) fail(code);
  if (Buffer.isBuffer(value)) {
    if (
      Object.getPrototypeOf(value) !== Buffer.prototype ||
      Reflect.ownKeys(value).some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          typeof key !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(key) ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        );
      })
    )
      fail(code);
    return Buffer.from(value);
  }
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    array &&
    (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1)
  )
    fail(code);
  seen.add(value);
  const result = array ? [] : {};
  for (const key of keys) {
    if (array && key === "length") continue;
    const descriptor = descriptors[key];
    if (
      typeof key !== "string" ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
    )
      fail(code);
    Object.defineProperty(result, key, {
      value: snapshotKernelData(descriptor.value, code, capabilities, seen),
      enumerable: true
    });
  }
  seen.delete(value);
  return Object.freeze(result);
}

export function assertKernelFrame(value, keys, code) {
  closed(value, keys, code);
}

function plain(value, code) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail(code);
}

function closed(value, keys, code) {
  plain(value, code);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || !descriptor.enumerable || !("value" in descriptor);
    })
  )
    fail(code);
}

function instant(value, code) {
  const epoch = typeof value === "string" ? Date.parse(value) : NaN;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    fail(code);
  return epoch;
}

function root(rootPolicy) {
  plain(rootPolicy, "ENVIRONMENT_POLICY_INVALID");
  const { repository, actorId, environment, workflow } = rootPolicy;
  closed(repository, ["id", "name"], "ENVIRONMENT_POLICY_INVALID");
  closed(environment, ["id", "name"], "ENVIRONMENT_POLICY_INVALID");
  if (
    !same(repository, REPOSITORY) ||
    actorId !== ACTOR_ID ||
    !ID.test(environment.id) ||
    environment.name !== ENVIRONMENT_NAME
  )
    fail("ENVIRONMENT_POLICY_INVALID");
  closed(workflow, ["path", "ref", "blobDigest", "actionCommits"], "ENVIRONMENT_POLICY_INVALID");
  if (
    workflow.path !== WORKFLOW_PATH ||
    workflow.ref !== "main" ||
    !DIGEST.test(workflow.blobDigest)
  )
    fail("ENVIRONMENT_POLICY_INVALID");
  if (!Array.isArray(workflow.actionCommits) || workflow.actionCommits.length === 0)
    fail("ENVIRONMENT_POLICY_INVALID");
  const actionCommits = workflow.actionCommits.map((entry) => {
    closed(entry, ["action", "commit"], "ENVIRONMENT_POLICY_INVALID");
    if (
      typeof entry.action !== "string" ||
      !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(entry.action) ||
      !SHA.test(entry.commit)
    )
      fail("ENVIRONMENT_POLICY_INVALID");
    return { action: entry.action, commit: entry.commit };
  });
  actionCommits.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  if (new Set(actionCommits.map(canonicalJson)).size !== actionCommits.length)
    fail("ENVIRONMENT_POLICY_INVALID");
  return {
    repository: REPOSITORY,
    actorId: ACTOR_ID,
    environment: { ...environment },
    workflow: {
      path: workflow.path,
      ref: workflow.ref,
      blobDigest: workflow.blobDigest,
      actionCommits
    }
  };
}

function policyFacts(rootPolicy, apiPolicy) {
  const policy = root(rootPolicy);
  plain(apiPolicy, "ENVIRONMENT_POLICY_INVALID");
  const environment = apiPolicy.environment;
  const workflow = apiPolicy.workflow;
  if (environment === "ABSENT") fail("ENVIRONMENT_POLICY_INVALID");
  plain(environment, "ENVIRONMENT_POLICY_INVALID");
  for (const field of [
    "id",
    "name",
    "canAdminsBypass",
    "preventSelfReview",
    "waitTimerSeconds",
    "requiredReviewerIds",
    "branchRules",
    "tagRules"
  ])
    if (!Object.prototype.hasOwnProperty.call(environment, field))
      fail("ENVIRONMENT_POLICY_INVALID");
  if (
    environment.id !== policy.environment.id ||
    environment.name !== ENVIRONMENT_NAME ||
    environment.canAdminsBypass !== false ||
    environment.preventSelfReview !== false ||
    environment.waitTimerSeconds !== 0 ||
    !Array.isArray(environment.requiredReviewerIds) ||
    environment.requiredReviewerIds.length !== 1 ||
    environment.requiredReviewerIds[0] !== ACTOR_ID ||
    !Array.isArray(environment.branchRules) ||
    !Array.isArray(environment.tagRules) ||
    environment.tagRules.length !== 0
  )
    fail("ENVIRONMENT_POLICY_INVALID");
  const branches = [...environment.branchRules].sort();
  if (
    !same(branches, ["main"]) ||
    branches.some((entry) => entry.includes("*") || entry !== "main")
  )
    fail("ENVIRONMENT_POLICY_INVALID");
  plain(workflow, "ENVIRONMENT_POLICY_INVALID");
  for (const field of ["path", "ref", "blobDigest", "actionCommits"])
    if (!Object.prototype.hasOwnProperty.call(workflow, field)) fail("ENVIRONMENT_POLICY_INVALID");
  const actions = workflow.actionCommits
    .map((entry) => {
      closed(entry, ["action", "commit"], "ENVIRONMENT_POLICY_INVALID");
      return { action: entry.action, commit: entry.commit };
    })
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  if (
    workflow.path !== policy.workflow.path ||
    workflow.ref !== "main" ||
    workflow.blobDigest !== policy.workflow.blobDigest ||
    !same(actions, policy.workflow.actionCommits)
  )
    fail("ENVIRONMENT_POLICY_INVALID");
  return policy;
}

function identity(value) {
  try {
    validateContract("environment-policy-identity.v1", value);
  } catch {
    fail("ENVIRONMENT_POLICY_INVALID");
  }
}

function admission(value) {
  try {
    validateContract("snapshot-admission.v1", value);
  } catch {
    fail("ENVIRONMENT_OBSERVATION_INVALID");
  }
}

export function buildEnvironmentPolicyIdentity(input = {}) {
  const { rootPolicy, apiPolicy } = snapshotKernelData(input, "ENVIRONMENT_POLICY_INVALID");
  const policy = policyFacts(rootPolicy, apiPolicy);
  const result = {
    schemaVersion: "environment-policy-identity.v1",
    repository: { ...policy.repository },
    environment: policy.environment,
    requiredReviewerId: ACTOR_ID,
    branchPolicy: { protectedBranches: ["main"], tagRules: [] },
    canAdminsBypass: false,
    preventSelfReview: false,
    allowedActorId: ACTOR_ID,
    waitTimerSeconds: 0,
    workflowPath: policy.workflow.path,
    workflowBlobDigest: policy.workflow.blobDigest,
    actionCommitAllowlist: policy.workflow.actionCommits,
    canonicalizationVersion: "RFC8785"
  };
  identity(result);
  return snapshotKernelData(result, "ENVIRONMENT_POLICY_INVALID");
}

export function buildEnvironmentPolicyObservation(input = {}) {
  const {
    identity: policyIdentity,
    apiPolicy,
    observedAt,
    phase,
    deployment,
    run,
    job,
    review
  } = snapshotKernelData(input, "ENVIRONMENT_OBSERVATION_INVALID");
  identity(policyIdentity);
  instant(observedAt, "ENVIRONMENT_OBSERVATION_INVALID");
  const value = {
    schemaVersion: "environment-policy-observation.v1",
    environmentPolicyIdentityDigest: sha256Canonical(policyIdentity),
    phase,
    observedAt,
    apiResponseDigest: sha256Canonical(apiPolicy),
    deployment,
    run,
    job,
    review
  };
  try {
    validateContract("environment-policy-observation.v1", value);
  } catch {
    fail("ENVIRONMENT_OBSERVATION_INVALID");
  }
  return snapshotKernelData(value, "ENVIRONMENT_OBSERVATION_INVALID");
}

export function verifyPostApprovalObservation(input = {}) {
  const {
    rootPolicy,
    apiPolicy,
    identity: policyIdentity,
    observation,
    admission: snapshotAdmission,
    now,
    maxAgeMs,
    approvalSelection
  } = snapshotKernelData(input, "ENVIRONMENT_OBSERVATION_INVALID");
  const latestIdentity = buildEnvironmentPolicyIdentity({ rootPolicy, apiPolicy });
  identity(policyIdentity);
  admission(snapshotAdmission);
  try {
    validateContract("environment-policy-observation.v1", observation);
  } catch {
    fail("ENVIRONMENT_OBSERVATION_INVALID");
  }
  const observedAt = instant(observation.observedAt, "ENVIRONMENT_OBSERVATION_EXPIRED");
  const current = instant(now, "ENVIRONMENT_OBSERVATION_EXPIRED");
  if (
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 0 ||
    maxAgeMs > 300000 ||
    current < observedAt ||
    current - observedAt > maxAgeMs
  )
    fail("ENVIRONMENT_OBSERVATION_EXPIRED");
  if (
    !same(policyIdentity, latestIdentity) ||
    observation.environmentPolicyIdentityDigest !== sha256Canonical(latestIdentity) ||
    observation.apiResponseDigest !== sha256Canonical(apiPolicy) ||
    snapshotAdmission.environmentPolicyIdentityDigest !== sha256Canonical(latestIdentity) ||
    observation.phase !== "approved-queued" ||
    observation.deployment.state !== "approved" ||
    observation.review.state !== "approved" ||
    observation.review.reviewerId !== ACTOR_ID ||
    observation.job.status !== "queued" ||
    observation.run.repository !== REPOSITORY.name ||
    observation.run.runId !== snapshotAdmission.producerRun.runId ||
    observation.run.workflowPath !== snapshotAdmission.producerRun.workflowPath ||
    observation.run.workflowRef !== "main" ||
    observation.run.sourceSha !== snapshotAdmission.producerRun.sourceSha ||
    !same(
      [...observation.job.labels].sort(),
      ["self-hosted", "linux", "x64", ENVIRONMENT_NAME, snapshotAdmission.route.label].sort()
    )
  )
    fail("ENVIRONMENT_OBSERVATION_INVALID");
  const code = "ENVIRONMENT_OBSERVATION_INVALID";
  closed(approvalSelection, ["runId", "runAttempt", "jobId", "deploymentId"], code);
  const facts = apiPolicy.approval;
  closed(
    facts,
    [
      "repositoryId",
      "environmentId",
      "bypassed",
      "observedAt",
      "run",
      "deployment",
      "job",
      "review"
    ],
    code
  );
  closed(facts.deployment, ["id", "state", "runId", "runAttempt", "approvedAt"], code);
  closed(
    facts.job,
    ["id", "name", "status", "labels", "runId", "runAttempt", "deploymentId"],
    code
  );
  closed(facts.review, ["reviewerId", "state", "deploymentId", "approvedAt"], code);
  const approvedAt = instant(facts.deployment.approvedAt, code);
  if (
    facts.repositoryId !== REPOSITORY.id ||
    facts.environmentId !== latestIdentity.environment.id ||
    facts.bypassed !== false ||
    approvalSelection.runId !== snapshotAdmission.producerRun.runId ||
    approvalSelection.runAttempt !== 1 ||
    !ID.test(approvalSelection.jobId) ||
    !ID.test(approvalSelection.deploymentId) ||
    !same(facts.run, observation.run) ||
    facts.deployment.id !== approvalSelection.deploymentId ||
    facts.deployment.runId !== approvalSelection.runId ||
    facts.deployment.runAttempt !== 1 ||
    !same(observation.deployment, { id: facts.deployment.id, state: facts.deployment.state }) ||
    facts.job.id !== approvalSelection.jobId ||
    facts.job.runId !== approvalSelection.runId ||
    facts.job.runAttempt !== 1 ||
    facts.job.deploymentId !== approvalSelection.deploymentId ||
    facts.job.name !== "snapshot-data" ||
    !same(observation.job, {
      id: facts.job.id,
      name: facts.job.name,
      status: facts.job.status,
      labels: facts.job.labels
    }) ||
    facts.review.deploymentId !== approvalSelection.deploymentId ||
    !same(observation.review, { reviewerId: facts.review.reviewerId, state: facts.review.state }) ||
    instant(facts.review.approvedAt, code) !== approvedAt ||
    approvedAt > observedAt ||
    instant(facts.observedAt, code) !== observedAt
  )
    fail(code);
}
