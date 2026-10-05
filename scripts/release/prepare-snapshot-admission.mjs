#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { open, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import process from "node:process";
import { TextDecoder } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";
import { createUntrustedSnapshotAdmissionInput } from "../../packages/release-foundation/src/snapshot/snapshot-admission.mjs";
import { readSnapshotWorkflowIdentity } from "../../packages/release-foundation/src/snapshot/snapshot-admission-verification.mjs";

const REPOSITORY = "keqi119/subscription-Saas";
const REPOSITORY_ID = "1253231368";
const ACTOR_ID = "275060624";
const WORKFLOW_PATH = ".github/workflows/sanitized-snapshot.yml";
const WORKFLOW_REF = `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`;
const QUEUED_LABELS = ["self-hosted", "linux", "x64", "stage1-snapshot-export"];
const MAX_AUTH_BYTES = 1048576;
const coded = (code) => Object.assign(new Error(code), { code });
const fail = (code) => {
  throw coded(code);
};

function required(env, name, max = 4096) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail("SNAPSHOT_ADMISSION_CONTEXT_INVALID");
  }
  return value;
}

function decodeAuthorization(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil((MAX_AUTH_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    fail("SNAPSHOT_ADMISSION_AUTHORIZATION_INVALID");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_AUTH_BYTES || bytes.toString("base64") !== value)
    fail("SNAPSHOT_ADMISSION_AUTHORIZATION_INVALID");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("SNAPSHOT_ADMISSION_AUTHORIZATION_INVALID");
  }
  let authorization;
  try {
    authorization = JSON.parse(text);
    if (canonicalJson(authorization) !== text) fail("SNAPSHOT_ADMISSION_AUTHORIZATION_INVALID");
    validateContract("rc-dispatch-authorization.v1", authorization);
  } catch {
    fail("SNAPSHOT_ADMISSION_AUTHORIZATION_INVALID");
  }
  return authorization;
}

function githubContext(env, authorization, workflowIdentity) {
  const context = {
    repository: required(env, "GITHUB_REPOSITORY", 256),
    repositoryId: required(env, "GITHUB_REPOSITORY_ID", 32),
    actorId: required(env, "GITHUB_ACTOR_ID", 32),
    runId: required(env, "GITHUB_RUN_ID", 32),
    runAttempt: required(env, "GITHUB_RUN_ATTEMPT", 8),
    sha: required(env, "GITHUB_SHA", 40),
    ref: required(env, "GITHUB_REF", 256),
    eventName: required(env, "GITHUB_EVENT_NAME", 128),
    workflowRef: required(env, "GITHUB_WORKFLOW_REF", 512)
  };
  if (
    context.repository !== REPOSITORY ||
    context.repositoryId !== REPOSITORY_ID ||
    context.actorId !== ACTOR_ID ||
    !/^[1-9][0-9]*$/.test(context.runId) ||
    context.runAttempt !== "1" ||
    !/^[0-9a-f]{40}$/.test(context.sha) ||
    context.ref !== "refs/heads/main" ||
    context.eventName !== "workflow_dispatch" ||
    context.workflowRef !== WORKFLOW_REF ||
    authorization.sourceSha !== context.sha ||
    authorization.producerWorkflow.path !== WORKFLOW_PATH ||
    authorization.producerWorkflow.ref !== "main" ||
    authorization.producerWorkflow.blobDigest !== workflowIdentity.blobDigest
  )
    fail("SNAPSHOT_ADMISSION_CONTEXT_INVALID");
  return context;
}

export function prepareSnapshotAdmission({ env, authorizationBytes, workflowBytes }) {
  if (!env || typeof env !== "object" || !Buffer.isBuffer(workflowBytes))
    fail("SNAPSHOT_ADMISSION_INPUT_INVALID");
  const authorization = decodeAuthorization(
    Buffer.isBuffer(authorizationBytes) ? authorizationBytes.toString("base64") : authorizationBytes
  );
  const workflowIdentity = readSnapshotWorkflowIdentity(workflowBytes);
  const context = githubContext(env, authorization, workflowIdentity);
  const policyDigest = required(env, "STAGE1_ENVIRONMENT_POLICY_DIGEST", 71);
  const admission = createUntrustedSnapshotAdmissionInput({
    authorization,
    producerRunObservation: {
      repository: context.repository,
      runId: context.runId,
      runAttempt: 1,
      workflowPath: WORKFLOW_PATH,
      workflowRef: "main",
      workflowBlobDigest: workflowIdentity.blobDigest,
      sourceSha: context.sha,
      event: context.eventName,
      queuedLabels: QUEUED_LABELS
    },
    route: { environmentPolicyIdentityDigest: policyDigest }
  });
  const bytes = Buffer.from(canonicalJson(admission), "utf8");
  return Object.freeze({
    admission,
    bytes,
    admissionRef: sha256Bytes(bytes),
    routeLabel: admission.route.label
  });
}

async function assertRegularNoLink(filePath, code) {
  let stat;
  try {
    stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(filePath)) !== filePath)
      fail(code);
  } catch {
    fail(code);
  }
}

async function writeOutputFile(cwd, prepared) {
  const outputDir = path.join(cwd, ".release-output");
  try {
    await mkdir(outputDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") fail("SNAPSHOT_ADMISSION_OUTPUT_INVALID");
  }
  const directoryStat = await lstat(outputDir).catch(() => null);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink())
    fail("SNAPSHOT_ADMISSION_OUTPUT_INVALID");
  const filePath = path.join(outputDir, "snapshot-admission.v1.json");
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(prepared.bytes);
    await handle.sync();
  } catch {
    fail("SNAPSHOT_ADMISSION_OUTPUT_INVALID");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function appendGitHubOutput(outputPath, prepared) {
  if (typeof outputPath !== "string" || !path.isAbsolute(outputPath) || outputPath.length > 4096)
    fail("SNAPSHOT_ADMISSION_GITHUB_OUTPUT_INVALID");
  await assertRegularNoLink(outputPath, "SNAPSHOT_ADMISSION_GITHUB_OUTPUT_INVALID");
  let handle;
  try {
    handle = await open(
      outputPath,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW
    );
    await handle.writeFile(
      `admission_ref=${prepared.admissionRef}\nroute_label=${prepared.routeLabel}\n`,
      "utf8"
    );
    await handle.sync();
  } catch {
    fail("SNAPSHOT_ADMISSION_GITHUB_OUTPUT_INVALID");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function main() {
  if (process.argv.length !== 2) fail("SNAPSHOT_ADMISSION_ARGUMENTS_INVALID");
  const env = process.env;
  const cwd = process.cwd();
  const auth = required(
    env,
    "STAGE1_DISPATCH_AUTHORIZATION_BASE64",
    Math.ceil((MAX_AUTH_BYTES * 4) / 3) + 4
  );
  const workflowPath = path.join(cwd, WORKFLOW_PATH);
  await assertRegularNoLink(workflowPath, "SNAPSHOT_ADMISSION_WORKFLOW_INVALID");
  const workflowBytes = await readFile(workflowPath);
  const prepared = prepareSnapshotAdmission({ env, authorizationBytes: auth, workflowBytes });
  await writeOutputFile(cwd, prepared);
  await appendGitHubOutput(required(env, "GITHUB_OUTPUT", 4096), prepared);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "SNAPSHOT_ADMISSION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
