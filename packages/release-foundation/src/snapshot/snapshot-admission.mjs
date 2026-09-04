import { randomBytes } from "node:crypto";

import { canonicalJson } from "../canonical-json.mjs";
import { sha256Canonical } from "../digest.mjs";
import { assertVerifiedDispatchAuthorization } from "../dispatch-authorization.mjs";
import { validateContract } from "../schema-registry.mjs";
import {
  assertKernelFrame,
  snapshotKernelData,
  buildEnvironmentPolicyIdentity
} from "./environment-policy.mjs";

const REPOSITORY = "keqi119/subscription-Saas";
const ENVIRONMENT = "stage1-snapshot-export";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[1-9][0-9]*$/;
const NONCE = /^[0-9a-f]{32}$/;
const coded = (code) => Object.assign(new Error(code), { code });
const fail = (code) => {
  throw coded(code);
};
const same = (a, b) => canonicalJson(a) === canonicalJson(b);

function frame(value, keys, code = "SNAPSHOT_ADMISSION_INVALID") {
  assertKernelFrame(value, keys, code);
}

function policy(rootPolicy) {
  frame(rootPolicy, Object.keys(rootPolicy), "SNAPSHOT_ADMISSION_POLICY_INVALID");
  const { repository, environment, workflow, environmentPolicyIdentity } = rootPolicy;
  frame(repository, ["id", "name"], "SNAPSHOT_ADMISSION_POLICY_INVALID");
  frame(environment, ["id", "name"], "SNAPSHOT_ADMISSION_POLICY_INVALID");
  frame(
    workflow,
    ["path", "ref", "blobDigest", "actionCommits"],
    "SNAPSHOT_ADMISSION_POLICY_INVALID"
  );
  if (
    repository.id !== "1253231368" ||
    repository.name !== REPOSITORY ||
    environment.name !== ENVIRONMENT ||
    !ID.test(environment.id) ||
    workflow.path !== ".github/workflows/sanitized-snapshot.yml" ||
    workflow.ref !== "main" ||
    !DIGEST.test(workflow.blobDigest) ||
    !Array.isArray(workflow.actionCommits)
  )
    fail("SNAPSHOT_ADMISSION_POLICY_INVALID");
  try {
    validateContract("environment-policy-identity.v1", environmentPolicyIdentity);
  } catch {
    fail("SNAPSHOT_ADMISSION_POLICY_INVALID");
  }
  const expectedIdentity = buildEnvironmentPolicyIdentity({
    rootPolicy,
    apiPolicy: {
      environment: {
        ...environment,
        canAdminsBypass: false,
        preventSelfReview: false,
        waitTimerSeconds: 0,
        requiredReviewerIds: ["275060624"],
        branchRules: ["main"],
        tagRules: []
      },
      workflow
    }
  });
  if (!same(environmentPolicyIdentity, expectedIdentity)) fail("SNAPSHOT_ADMISSION_POLICY_INVALID");
  return { repository, workflow, environmentPolicyIdentity };
}

function producer(value, trusted = false) {
  frame(value, [
    "repository",
    "runId",
    "runAttempt",
    "workflowPath",
    "workflowRef",
    "workflowBlobDigest",
    "sourceSha",
    "event",
    ...(trusted ? ["actorId", "jobId", "queuedJobs", "usedRouteNonces"] : ["queuedLabels"])
  ]);
  if (
    value.repository !== REPOSITORY ||
    !ID.test(value.runId) ||
    value.runAttempt !== 1 ||
    value.workflowPath !== ".github/workflows/sanitized-snapshot.yml" ||
    value.workflowRef !== "main" ||
    !DIGEST.test(value.workflowBlobDigest) ||
    !SHA.test(value.sourceSha) ||
    value.event !== "workflow_dispatch" ||
    (trusted
      ? value.actorId !== "275060624"
      : !Array.isArray(value.queuedLabels) ||
        !same([...value.queuedLabels].sort(), ["self-hosted", "linux", "x64", ENVIRONMENT].sort()))
  )
    fail("SNAPSHOT_ADMISSION_INVALID");
  return {
    repository: value.repository,
    runId: value.runId,
    runAttempt: value.runAttempt,
    workflowPath: value.workflowPath,
    workflowRef: value.workflowRef,
    workflowBlobDigest: value.workflowBlobDigest,
    sourceSha: value.sourceSha
  };
}

function authorization(value) {
  try {
    validateContract("rc-dispatch-authorization.v1", value);
  } catch {
    fail("SNAPSHOT_ADMISSION_INVALID");
  }
  return value;
}

export function uniqueRouteLabel(runId, nonce) {
  if (!ID.test(String(runId)) || !NONCE.test(nonce)) fail("SNAPSHOT_ROUTE_IDENTITY_INVALID");
  return `stage1-snapshot-export-${runId}-${nonce}`;
}

export function createUntrustedSnapshotAdmissionInput(input = {}) {
  frame(input, ["authorization", "producerRunObservation", "route"]);
  const {
    authorization: rawAuthorization,
    producerRunObservation,
    route
  } = snapshotKernelData(input, "SNAPSHOT_ADMISSION_INVALID");
  const auth = authorization(rawAuthorization);
  const run = producer(producerRunObservation);
  if (
    !route ||
    typeof route !== "object" ||
    Array.isArray(route) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(route)) ||
    !Object.keys(route).every((key) =>
      ["nonce", "environmentPolicyIdentityDigest"].includes(key)
    ) ||
    !DIGEST.test(route.environmentPolicyIdentityDigest) ||
    (route.nonce !== undefined && !NONCE.test(route.nonce))
  )
    fail("SNAPSHOT_ROUTE_IDENTITY_INVALID");
  const nonce = route.nonce ?? randomBytes(16).toString("hex");
  const value = {
    schemaVersion: "snapshot-admission.v1",
    dispatchAuthorizationDigest: sha256Canonical(auth),
    releaseAttemptId: auth.releaseAttemptId,
    executionPurpose: auth.executionPurpose,
    producerRun: run,
    route: { nonce, label: uniqueRouteLabel(run.runId, nonce) },
    adapterDigest: auth.adapterDigest,
    environmentPolicyIdentityDigest: route.environmentPolicyIdentityDigest
  };
  // This is an untrusted copied digest, not an approval or a decision. The root recomputes it
  // from protected policy plus the fresh environment readback before byte-for-byte comparison.
  validateContract("snapshot-admission.v1", value);
  return snapshotKernelData(value, "SNAPSHOT_ADMISSION_INVALID");
}

export function buildSnapshotAdmission(input = {}) {
  frame(input, ["verifiedDispatch", "producerRunObservation", "routeNonce", "rootPolicy", "now"]);
  const { verifiedDispatch } = input;
  const { producerRunObservation, routeNonce, rootPolicy, now } = snapshotKernelData(
    {
      producerRunObservation: input.producerRunObservation,
      routeNonce: input.routeNonce,
      rootPolicy: input.rootPolicy,
      now: input.now
    },
    "SNAPSHOT_ADMISSION_INVALID"
  );
  const trustedPolicy = policy(rootPolicy);
  try {
    // Do not evaluate fields on an unbranded candidate while assembling the assertion.
    // A descriptor read rejects accessors; Task2V alone still establishes the brand.
    const expectedDescriptor = Object.getOwnPropertyDescriptor(verifiedDispatch, "expected");
    if (!expectedDescriptor || !Object.hasOwn(expectedDescriptor, "value"))
      fail("DISPATCH_DECISION_UNVERIFIED");
    assertVerifiedDispatchAuthorization(verifiedDispatch, {
      expected: expectedDescriptor.value,
      now
    });
  } catch (error) {
    if (error?.code?.startsWith("DISPATCH_")) throw error;
    fail("DISPATCH_DECISION_UNVERIFIED");
  }
  const auth = verifiedDispatch.authorization;
  const run = producer(producerRunObservation, true);
  if (
    !same(verifiedDispatch.expected, {
      ...verifiedDispatch.expected,
      executionPurpose: auth.executionPurpose,
      releaseAttemptId: auth.releaseAttemptId,
      sourceSha: auth.sourceSha,
      producerWorkflow: auth.producerWorkflow,
      adapterDigest: auth.adapterDigest
    }) ||
    run.workflowPath !== auth.producerWorkflow.path ||
    run.workflowBlobDigest !== auth.producerWorkflow.blobDigest ||
    run.workflowBlobDigest !== trustedPolicy.workflow.blobDigest ||
    run.sourceSha !== auth.sourceSha
  )
    fail("SNAPSHOT_ADMISSION_BINDING_MISMATCH");
  const label = uniqueRouteLabel(run.runId, routeNonce);
  const routeCode = "SNAPSHOT_ROUTE_IDENTITY_INVALID";
  const { jobId, queuedJobs, usedRouteNonces } = producerRunObservation;
  if (
    typeof jobId !== "string" ||
    !ID.test(jobId) ||
    !Array.isArray(queuedJobs) ||
    !Array.isArray(usedRouteNonces) ||
    usedRouteNonces.some((nonce) => typeof nonce !== "string" || !NONCE.test(nonce)) ||
    new Set(usedRouteNonces).size !== usedRouteNonces.length ||
    usedRouteNonces.includes(routeNonce)
  )
    fail(routeCode);
  const jobs = new Set();
  for (const job of queuedJobs) {
    frame(job, ["repository", "runId", "runAttempt", "id", "name", "status", "labels"], routeCode);
    if (
      job.repository !== REPOSITORY ||
      typeof job.runId !== "string" ||
      !ID.test(job.runId) ||
      typeof job.id !== "string" ||
      !ID.test(job.id) ||
      jobs.has(job.id) ||
      !Number.isSafeInteger(job.runAttempt) ||
      job.runAttempt < 1 ||
      typeof job.name !== "string" ||
      !Array.isArray(job.labels) ||
      job.labels.some((label) => typeof label !== "string") ||
      !["waiting", "queued"].includes(job.status)
    )
      fail(routeCode);
    jobs.add(job.id);
  }
  const selected = queuedJobs.find((job) => job.id === jobId);
  const matches = queuedJobs.filter((job) => job.labels.includes(label));
  if (
    !selected ||
    selected.name !== "snapshot-data" ||
    selected.runId !== run.runId ||
    selected.runAttempt !== 1 ||
    matches.length !== 1 ||
    matches[0] !== selected ||
    !same([...selected.labels].sort(), ["self-hosted", "linux", "x64", ENVIRONMENT, label].sort())
  )
    fail(routeCode);
  const value = {
    schemaVersion: "snapshot-admission.v1",
    dispatchAuthorizationDigest: verifiedDispatch.authorizationDigest,
    releaseAttemptId: auth.releaseAttemptId,
    executionPurpose: auth.executionPurpose,
    producerRun: run,
    route: { nonce: routeNonce, label },
    adapterDigest: auth.adapterDigest,
    environmentPolicyIdentityDigest: sha256Canonical(trustedPolicy.environmentPolicyIdentity)
  };
  try {
    validateContract("snapshot-admission.v1", value);
  } catch {
    fail("SNAPSHOT_ADMISSION_INVALID");
  }
  return snapshotKernelData(value, "SNAPSHOT_ADMISSION_INVALID");
}
