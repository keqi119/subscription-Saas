import { Buffer } from "node:buffer";
import { createPublicKey, sign } from "node:crypto";

import { canonicalJson } from "../canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../digest.mjs";
import { verifyDispatchAuthorization } from "../dispatch-authorization.mjs";
import { validateContract } from "../schema-registry.mjs";
import {
  buildEnvironmentPolicyIdentity,
  assertKernelFrame,
  snapshotKernelData
} from "./environment-policy.mjs";
import { buildSnapshotAdmission } from "./snapshot-admission.mjs";

const coded = (code) => Object.assign(new Error(code), { code });
const fail = (code) => {
  throw coded(code);
};
const same = (a, b) => canonicalJson(a) === canonicalJson(b);

function root(rootPolicy) {
  assertKernelFrame(
    rootPolicy,
    ["repository", "actorId", "environment", "workflow", "environmentPolicyIdentity", "rootSigner"],
    "SNAPSHOT_ADMISSION_POLICY_INVALID"
  );
  const signer = rootPolicy.rootSigner;
  if (
    !signer ||
    typeof signer !== "object" ||
    Array.isArray(signer) ||
    Object.keys(signer).length !== 3 ||
    typeof signer.issuer !== "string" ||
    !signer.issuer.length ||
    signer.issuer.length > 2048 ||
    typeof signer.keyId !== "string" ||
    !signer.keyId.length ||
    signer.keyId.length > 2048 ||
    typeof signer.publicKey !== "string"
  )
    fail("SNAPSHOT_ADMISSION_POLICY_INVALID");
  let publicKey;
  try {
    publicKey = createPublicKey(signer.publicKey);
  } catch {
    fail("SNAPSHOT_ADMISSION_POLICY_INVALID");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") fail("SNAPSHOT_ADMISSION_POLICY_INVALID");
  try {
    validateContract("environment-policy-identity.v1", rootPolicy.environmentPolicyIdentity);
  } catch {
    fail("SNAPSHOT_ADMISSION_POLICY_INVALID");
  }
  return { signer, publicKey };
}

function observations(githubObservations) {
  const code = "SNAPSHOT_ADMISSION_OBSERVATION_INVALID";
  assertKernelFrame(githubObservations, ["selection", "readExact"], code);
  if (typeof githubObservations.readExact !== "function") fail(code);
  const { selection } = githubObservations;
  assertKernelFrame(
    selection,
    [
      "repository",
      "runId",
      "runAttempt",
      "sourceSha",
      "admissionJobId",
      "jobId",
      "artifactId",
      "artifactName"
    ],
    code
  );
  assertKernelFrame(selection.repository, ["id", "name"], code);
  if (
    selection.repository.id !== "1253231368" ||
    selection.repository.name !== "keqi119/subscription-Saas" ||
    selection.runAttempt !== 1 ||
    selection.artifactName !== "snapshot-admission" ||
    !/^[0-9a-f]{40}$/.test(selection.sourceSha) ||
    selection.admissionJobId === selection.jobId ||
    [selection.runId, selection.admissionJobId, selection.jobId, selection.artifactId].some(
      (id) => typeof id !== "string" || !/^[1-9][0-9]*$/.test(id)
    )
  )
    fail(code);
  return githubObservations;
}

function exact(raw, selection) {
  const code = "SNAPSHOT_ADMISSION_OBSERVATION_INVALID";
  const value = snapshotKernelData(raw, code);
  assertKernelFrame(
    value,
    [
      "repository",
      "producerRun",
      "admissionJob",
      "workflow",
      "environmentPolicy",
      "artifact",
      "queuedJobs",
      "usedRouteNonces"
    ],
    code
  );
  assertKernelFrame(value.repository, ["id", "name"], code);
  assertKernelFrame(
    value.producerRun,
    [
      "repository",
      "runId",
      "runAttempt",
      "workflowPath",
      "workflowRef",
      "workflowBlobDigest",
      "sourceSha",
      "event",
      "actorId"
    ],
    code
  );
  assertKernelFrame(value.workflow, ["repositoryId", "path", "sourceSha", "bytes"], code);
  assertKernelFrame(
    value.admissionJob,
    [
      "repository",
      "runId",
      "runAttempt",
      "id",
      "name",
      "status",
      "conclusion",
      "sourceSha",
      "startedAt",
      "completedAt"
    ],
    code
  );
  assertKernelFrame(
    value.artifact,
    ["id", "name", "repositoryId", "runId", "sourceSha", "createdAt", "bytes"],
    code
  );
  const { producerRun: run, workflow, artifact } = value;
  if (
    !same(value.repository, selection.repository) ||
    run.repository !== selection.repository.name ||
    run.runId !== selection.runId ||
    run.runAttempt !== selection.runAttempt ||
    run.sourceSha !== selection.sourceSha ||
    run.actorId !== "275060624" ||
    value.admissionJob.repository !== selection.repository.name ||
    value.admissionJob.id !== selection.admissionJobId ||
    value.admissionJob.runId !== selection.runId ||
    value.admissionJob.runAttempt !== 1 ||
    value.admissionJob.sourceSha !== selection.sourceSha ||
    value.admissionJob.name !== "admission" ||
    value.admissionJob.status !== "completed" ||
    value.admissionJob.conclusion !== "success" ||
    workflow.repositoryId !== selection.repository.id ||
    workflow.path !== ".github/workflows/sanitized-snapshot.yml" ||
    workflow.path !== run.workflowPath ||
    workflow.sourceSha !== selection.sourceSha ||
    !Buffer.isBuffer(workflow.bytes) ||
    workflow.bytes.length > 1048576 ||
    artifact.id !== selection.artifactId ||
    artifact.name !== selection.artifactName ||
    artifact.repositoryId !== selection.repository.id ||
    artifact.runId !== selection.runId ||
    artifact.sourceSha !== selection.sourceSha ||
    !Buffer.isBuffer(artifact.bytes) ||
    artifact.bytes.length > 1048576 ||
    !Array.isArray(value.queuedJobs) ||
    !Array.isArray(value.usedRouteNonces)
  )
    fail(code);
  const time = (text) => {
    if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text))
      fail(code);
    const result = Date.parse(text);
    if (
      !Number.isFinite(result) ||
      new Date(result).toISOString().slice(0, 19) !== text.slice(0, 19)
    )
      fail(code);
    return result;
  };
  const started = time(value.admissionJob.startedAt);
  const completed = time(value.admissionJob.completedAt);
  const created = time(artifact.createdAt);
  if (started > completed || created < started || created > completed) fail(code);
  return value;
}

// Closed YAML subset: two-space block mappings and mapping-item sequences, plain keys,
// and single-line plain scalar values. Every non-comment line is consumed. Quoting,
// flow forms, aliases, document directives and block scalars are unsupported. A whole
// single-line ${{ ... }} scalar with the restricted character set below is opaque text;
// it is never evaluated and cannot supply an action reference or a mapping key.
// Action keys are permitted only in jobs.<job>.steps[n], never inferred from script text.
function parsedWorkflow(workflowBytes) {
  const code = "SNAPSHOT_ADMISSION_WORKFLOW_INVALID";
  const source = workflowBytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(workflowBytes)) fail(code);
  const tokens = [];
  for (const line of source.split(/\r?\n/)) {
    if (/^ *(?:#.*)?$/.test(line)) continue;
    const match = line.trimEnd().match(/^((?: {2})*)(- )?([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/);
    if (!match) fail(code);
    const scalar = match[4] === undefined ? "" : match[4];
    if (
      scalar !== "" &&
      !/^[A-Za-z0-9_./@][A-Za-z0-9_./@ -]*$/.test(scalar) &&
      !/^\$\{\{ [A-Za-z0-9_.()'" !=&|,+*/-]+ \}\}$/.test(scalar)
    )
      fail(code);
    tokens.push({ indent: match[1].length, sequence: !!match[2], key: match[3], scalar });
  }
  let cursor = 0;
  function entry(target, token, logicalIndent) {
    if (Object.hasOwn(target, token.key)) fail(code);
    let value = token.scalar || null;
    if (tokens[cursor]?.indent > logicalIndent) {
      if (token.scalar || tokens[cursor].indent !== logicalIndent + 2) fail(code);
      value = block(logicalIndent + 2);
    }
    target[token.key] = value;
  }
  function block(indent) {
    if (tokens[cursor]?.indent !== indent) fail(code);
    const sequence = tokens[cursor].sequence;
    const result = sequence ? [] : Object.create(null);
    while (cursor < tokens.length && tokens[cursor].indent === indent) {
      const token = tokens[cursor++];
      if (token.sequence !== sequence) fail(code);
      if (!sequence) entry(result, token, indent);
      else {
        const item = Object.create(null);
        entry(item, token, indent + 2);
        while (tokens[cursor]?.indent === indent + 2 && !tokens[cursor].sequence)
          entry(item, tokens[cursor++], indent + 2);
        result.push(item);
      }
      if (tokens[cursor]?.indent > indent) fail(code);
    }
    return result;
  }
  if (!tokens.length) fail(code);
  const document = block(0);
  if (
    cursor !== tokens.length ||
    Array.isArray(document) ||
    !document.jobs ||
    Array.isArray(document.jobs)
  )
    fail(code);
  const actions = [];
  function visit(node, path = []) {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "uses") {
        if (
          path.length !== 4 ||
          path[0] !== "jobs" ||
          path[2] !== "steps" ||
          !/^[0-9]+$/.test(path[3]) ||
          typeof value !== "string"
        )
          fail(code);
        const match = value.match(/^([a-z0-9_.-]+\/[a-z0-9_.-]+)@([0-9a-f]{40})$/);
        if (!match) fail(code);
        actions.push({ action: match[1], commit: match[2] });
      }
      visit(value, [...path, key]);
    }
  }
  visit(document);
  if (actions.length === 0) fail("SNAPSHOT_ADMISSION_WORKFLOW_INVALID");
  const uniqueActions = [
    ...new Map(actions.map((action) => [canonicalJson(action), action])).values()
  ];
  return {
    document,
    actions: uniqueActions.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
  };
}

function admissionUploader(document, admissionJob) {
  const code = "SNAPSHOT_ADMISSION_WORKFLOW_INVALID";
  const jobs = document.jobs;
  const names = ["admission", "snapshot-custody", "snapshot-data"];
  if (!same(Object.keys(jobs).sort(), names)) fail(code);
  for (const name of names) {
    const job = jobs[name];
    if (
      !job ||
      typeof job !== "object" ||
      Array.isArray(job) ||
      (job.name !== undefined && job.name !== name) ||
      job.strategy !== undefined ||
      !Array.isArray(job.steps) ||
      job.steps.length === 0
    )
      fail(code);
  }
  if (
    jobs.admission.needs !== undefined ||
    jobs.admission.environment !== undefined ||
    jobs["snapshot-data"].needs !== "admission" ||
    jobs["snapshot-custody"].needs !== "snapshot-data" ||
    jobs["snapshot-data"].steps.length !== 1 ||
    typeof jobs["snapshot-data"].steps[0].run !== "string" ||
    jobs["snapshot-data"].steps[0].uses !== undefined
  )
    fail(code);
  const uploaders = [];
  for (const name of names) {
    for (const [index, step] of jobs[name].steps.entries()) {
      if (!step.uses?.startsWith("actions/upload-artifact@")) continue;
      const target = step.with?.name;
      // An expression could resolve to the admission name; only fixed names can
      // establish a unique declared uploader from the independently pinned file.
      if (typeof target !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target))
        fail(code);
      if (target === "snapshot-admission") uploaders.push({ name, index, step });
    }
  }
  if (
    uploaders.length !== 1 ||
    uploaders[0].name !== "admission" ||
    uploaders[0].step.with.path !== ".release-output/snapshot-admission.v1.json" ||
    uploaders[0].step.with.overwrite !== "false" ||
    uploaders[0].step.with["if-no-files-found"] !== "error"
  )
    fail(code);
  // This is a derivation from the approved workflow and observed completed job,
  // not a job_id field on GitHub's artifact API (which has no such field).
  return {
    method: "unique-pinned-workflow-uploader",
    workflowJob: "admission",
    jobId: admissionJob.id,
    stepIndex: uploaders[0].index,
    action: uploaders[0].step.uses,
    artifactPath: uploaders[0].step.with.path
  };
}

// Share the exact parser with the root API adapter; action pins are derived
// from fetched bytes, never copied from the independently installed policy.
export function readSnapshotWorkflowIdentity(workflowBytes) {
  if (
    !Buffer.isBuffer(workflowBytes) ||
    workflowBytes.length === 0 ||
    workflowBytes.length > 1048576
  )
    fail("SNAPSHOT_ADMISSION_WORKFLOW_INVALID");
  const { actions } = parsedWorkflow(workflowBytes);
  return snapshotKernelData(
    { blobDigest: sha256Bytes(workflowBytes), actionCommits: actions },
    "SNAPSHOT_ADMISSION_WORKFLOW_INVALID"
  );
}

function keyDescriptor(privateKeyFd, expectedPublicKey) {
  if (
    !privateKeyFd ||
    typeof privateKeyFd !== "object" ||
    Array.isArray(privateKeyFd) ||
    Object.keys(privateKeyFd).length !== 2 ||
    typeof privateKeyFd.publicKey !== "string" ||
    typeof privateKeyFd.readPrivateKey !== "function"
  )
    fail("SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID");
  try {
    if (
      !createPublicKey(privateKeyFd.publicKey)
        .export({ type: "spki", format: "der" })
        .equals(expectedPublicKey.export({ type: "spki", format: "der" }))
    )
      fail("SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID");
  } catch (error) {
    if (error?.code === "SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID") throw error;
    fail("SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID");
  }
  let privateKey;
  try {
    privateKey = privateKeyFd.readPrivateKey();
  } catch {
    fail("SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID");
  }
  try {
    if (
      privateKey?.asymmetricKeyType !== "ed25519" ||
      !createPublicKey(privateKey)
        .export({ type: "spki", format: "der" })
        .equals(expectedPublicKey.export({ type: "spki", format: "der" }))
    )
      fail("SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID");
  } catch (error) {
    if (error?.code === "SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID") throw error;
    fail("SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID");
  }
  return privateKey;
}

export async function verifyAndSignSnapshotAdmission(input = {}) {
  assertKernelFrame(
    input,
    ["admission", "dispatchVerification", "githubObservations", "rootPolicy", "privateKeyFd"],
    "SNAPSHOT_ADMISSION_INVALID"
  );
  const admission = snapshotKernelData(input.admission, "SNAPSHOT_ADMISSION_INVALID");
  const rootPolicy = snapshotKernelData(input.rootPolicy, "SNAPSHOT_ADMISSION_POLICY_INVALID");
  const dispatchVerification = snapshotKernelData(
    input.dispatchVerification,
    "SNAPSHOT_ADMISSION_DISPATCH_INVALID",
    true
  );
  const githubObservations = snapshotKernelData(
    input.githubObservations,
    "SNAPSHOT_ADMISSION_OBSERVATION_INVALID",
    true
  );
  const privateKeyFd = snapshotKernelData(
    input.privateKeyFd,
    "SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID",
    true
  );
  const trustedRoot = root(rootPolicy);
  // Every GitHub fact is read before the fresh Task 2V verifier and before the descriptor.
  const { readExact, selection } = observations(githubObservations);
  let received;
  try {
    received = exact(await readExact(selection), selection);
  } catch (error) {
    if (error?.code?.startsWith("SNAPSHOT_ADMISSION_")) throw error;
    fail("SNAPSHOT_ADMISSION_OBSERVATION_UNAVAILABLE");
  }
  const identity = buildEnvironmentPolicyIdentity({
    rootPolicy,
    apiPolicy: received.environmentPolicy
  });
  const { actions, document } = parsedWorkflow(received.workflow.bytes);
  if (
    !same(identity, rootPolicy.environmentPolicyIdentity) ||
    sha256Bytes(received.workflow.bytes) !== rootPolicy.workflow.blobDigest ||
    received.producerRun.workflowBlobDigest !== rootPolicy.workflow.blobDigest
  )
    fail("SNAPSHOT_ADMISSION_OBSERVATION_INVALID");
  if (
    !same(
      actions,
      [...rootPolicy.workflow.actionCommits].sort((a, b) =>
        canonicalJson(a).localeCompare(canonicalJson(b))
      )
    )
  )
    fail("SNAPSHOT_ADMISSION_WORKFLOW_INVALID");
  const derivedArtifactProvenance = admissionUploader(document, received.admissionJob);
  let verifiedDispatch;
  try {
    verifiedDispatch = await verifyDispatchAuthorization(dispatchVerification);
  } catch (error) {
    if (error?.code?.startsWith("DISPATCH_")) throw error;
    fail("SNAPSHOT_ADMISSION_DISPATCH_INVALID");
  }
  const routeNonce = (() => {
    try {
      const copied = received.artifact.bytes;
      const artifact = JSON.parse(copied.toString("utf8"));
      if (
        !artifact?.route?.nonce ||
        !copied.equals(Buffer.from(canonicalJson(artifact))) ||
        !same(artifact, admission)
      )
        fail("SNAPSHOT_ADMISSION_ARTIFACT_MISMATCH");
      return artifact.route.nonce;
    } catch (error) {
      if (error?.code === "SNAPSHOT_ADMISSION_ARTIFACT_MISMATCH") throw error;
      fail("SNAPSHOT_ADMISSION_ARTIFACT_MISMATCH");
    }
  })();
  const rebuilt = buildSnapshotAdmission({
    verifiedDispatch,
    producerRunObservation: {
      ...received.producerRun,
      jobId: selection.jobId,
      queuedJobs: received.queuedJobs,
      usedRouteNonces: received.usedRouteNonces
    },
    routeNonce,
    rootPolicy,
    now: dispatchVerification.clock.now()
  });
  if (!received.artifact.bytes.equals(Buffer.from(canonicalJson(rebuilt))))
    fail("SNAPSHOT_ADMISSION_ARTIFACT_MISMATCH");
  const unsigned = {
    schemaVersion: "snapshot-admission-verification.v1",
    snapshotAdmissionDigest: sha256Canonical(rebuilt),
    environmentPolicyIdentityDigest: sha256Canonical(identity),
    githubApiResponseDigest: sha256Canonical({
      repository: received.repository,
      producerRun: received.producerRun,
      admissionJob: received.admissionJob,
      workflow: {
        repositoryId: received.workflow.repositoryId,
        path: received.workflow.path,
        sourceSha: received.workflow.sourceSha,
        blobDigest: sha256Bytes(received.workflow.bytes)
      },
      environmentPolicy: received.environmentPolicy,
      artifact: {
        id: received.artifact.id,
        name: received.artifact.name,
        repositoryId: received.artifact.repositoryId,
        runId: received.artifact.runId,
        sourceSha: received.artifact.sourceSha,
        createdAt: received.artifact.createdAt,
        digest: sha256Bytes(received.artifact.bytes)
      },
      derivedArtifactProvenance,
      queuedJobs: received.queuedJobs,
      usedRouteNonces: received.usedRouteNonces,
      selection
    }),
    workflowBlobDigest: sha256Bytes(received.workflow.bytes),
    rootSigner: {
      issuer: trustedRoot.signer.issuer,
      keyId: trustedRoot.signer.keyId,
      algorithm: "Ed25519"
    }
  };
  const privateKey = keyDescriptor(privateKeyFd, trustedRoot.publicKey);
  const signature = sign(
    null,
    Buffer.from(
      canonicalJson({ domain: "snapshot-admission-verification.v1", verification: unsigned })
    ),
    privateKey
  ).toString("base64");
  const result = { ...unsigned, signature };
  try {
    validateContract("snapshot-admission-verification.v1", result);
  } catch {
    fail("SNAPSHOT_ADMISSION_SIGNING_INVALID");
  }
  return snapshotKernelData(result, "SNAPSHOT_ADMISSION_SIGNING_INVALID");
}
