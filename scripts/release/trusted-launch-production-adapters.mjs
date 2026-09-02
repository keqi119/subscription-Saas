import { spawn as spawnProcess } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  sha256Bytes,
  sha256Canonical,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

const runnerServices = new Set(["runner-migration", "runner-verify", "runner-database-test"]);
const digestImage = /^[a-z0-9][a-z0-9./_-]+@sha256:[0-9a-f]{64}$/u;
const projectNamePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const trustedRepository = "keqi119/subscription-Saas";
const trustedSignerWorkflow =
  "github.com/keqi119/subscription-Saas/.github/workflows/release-candidate-gate.yml";

function launchError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function assertLaunchIdentity({ composeFile, projectName, service }) {
  if (
    typeof composeFile !== "string" ||
    composeFile.length === 0 ||
    !projectNamePattern.test(projectName ?? "")
  ) {
    throw launchError("RUNNER_CONTAINER_LAUNCH_INVALID");
  }
  if (!runnerServices.has(service)) {
    throw launchError("RUNNER_CONTAINER_SERVICE_FORBIDDEN", { service });
  }
}

export function runnerComposeInvocation({ composeFile, projectName, service }) {
  assertLaunchIdentity({ composeFile, projectName, service });
  return [
    "compose",
    "--project-name",
    projectName,
    "--file",
    composeFile,
    "run",
    "--no-deps",
    service
  ];
}

export async function verifyAttestedLaunchEnvelope({
  launchEnvelopeFile,
  repository = trustedRepository,
  readArtifact = readFile,
  run = runProcess
}) {
  if (repository !== trustedRepository || typeof launchEnvelopeFile !== "string") {
    throw launchError("RUNNER_LAUNCH_ATTESTATION_UNTRUSTED");
  }
  const absolute = path.resolve(launchEnvelopeFile);
  const allowedRoot = path.resolve(".release-local", "launch");
  const relative = path.relative(allowedRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw launchError("RUNNER_LAUNCH_ENVELOPE_PATH_FORBIDDEN");
  }
  const bytes = await readArtifact(absolute);
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
    validateContract("runner-launch-envelope.v1", envelope);
    validateContract("build-proof.v1", envelope.request.buildProof);
  } catch (error) {
    throw launchError("RUNNER_LAUNCH_ENVELOPE_INVALID", { cause: error?.code });
  }
  if (
    envelope.requestDigest !== sha256Canonical(envelope.request) ||
    envelope.buildProofDigest !== sha256Canonical(envelope.request.buildProof) ||
    envelope.buildProofDigest !== envelope.request.buildProofDigest ||
    envelope.actualRunnerDigest !== envelope.request.actualRunnerDigest ||
    envelope.actualRunnerDigest !==
      envelope.request.buildProof.identity.images.runner.imageDigest ||
    envelope.launchAttestationDigest !== sha256Canonical(envelope.request.launchAttestation)
  ) {
    throw launchError("RUNNER_LAUNCH_ENVELOPE_IDENTITY_MISMATCH");
  }
  const result = await run("gh", [
    "attestation",
    "verify",
    launchEnvelopeFile,
    "--repo",
    repository,
    "--signer-workflow",
    trustedSignerWorkflow,
    "--source-digest",
    envelope.request.buildProof.identity.sourceSha,
    "--format",
    "json"
  ]);
  if (result?.exitCode !== 0) {
    throw launchError("RUNNER_LAUNCH_ATTESTATION_UNTRUSTED");
  }
  let verified;
  try {
    verified = JSON.parse(result.stdout);
  } catch {
    throw launchError("RUNNER_LAUNCH_ATTESTATION_UNTRUSTED");
  }
  const expectedHex = sha256Bytes(bytes).slice("sha256:".length);
  const subjectMatched =
    Array.isArray(verified) &&
    verified.some(({ verificationResult }) =>
      verificationResult?.statement?.subject?.some(({ digest }) => digest?.sha256 === expectedHex)
    );
  if (!subjectMatched) throw launchError("RUNNER_LAUNCH_ATTESTATION_UNTRUSTED");
  return Object.freeze({ ...envelope, attestedArtifactDigest: `sha256:${expectedHex}` });
}

async function executeRunnerContainer({
  launchEnvelopeFile,
  composeFile,
  projectName,
  service,
  expectedRunnerImage,
  verifyLaunchEnvelope,
  inspectImage,
  spawn
}) {
  const args = runnerComposeInvocation({ composeFile, projectName, service });
  if (!digestImage.test(expectedRunnerImage ?? "")) {
    throw launchError("RUNNER_CONTAINER_IMAGE_MUTABLE");
  }
  if (
    typeof verifyLaunchEnvelope !== "function" ||
    typeof inspectImage !== "function" ||
    typeof spawn !== "function"
  ) {
    throw launchError("RUNNER_CONTAINER_ADAPTER_MISSING");
  }
  const envelope = await verifyLaunchEnvelope(launchEnvelopeFile);
  const expectedDigest = expectedRunnerImage.slice(expectedRunnerImage.indexOf("@") + 1);
  if (envelope.actualRunnerDigest !== expectedDigest) {
    throw launchError("RUNNER_LAUNCH_ENVELOPE_IDENTITY_MISMATCH");
  }
  const observation = await inspectImage(expectedRunnerImage);
  if (
    !observation?.repoDigests?.includes(expectedRunnerImage) ||
    observation.sourceRevision !== envelope.request.buildProof.identity.sourceSha
  ) {
    throw launchError("RUNNER_CONTAINER_DIGEST_MISMATCH");
  }
  const result = await spawn("docker", args, {
    environment: {
      ...process.env,
      ...(launchEnvelopeFile ? { RELEASE_RUNNER_LAUNCH_ENVELOPE_FILE: launchEnvelopeFile } : {})
    }
  });
  if (result?.exitCode !== 0) {
    throw launchError("RUNNER_CONTAINER_EXECUTION_FAILED", {
      exitCode: result?.exitCode,
      stderr: result?.stderr
    });
  }
  let output;
  try {
    output = JSON.parse(String(result.stdout ?? "").trim());
  } catch {
    throw launchError("RUNNER_CONTAINER_OUTPUT_INVALID");
  }
  if (output?.terminalStatus !== "PASSED") {
    throw launchError("RUNNER_CONTAINER_OUTPUT_INVALID");
  }
  return Object.freeze({ ...output, imageObservation: Object.freeze({ ...observation }) });
}

function hostTerminalClass(error) {
  return ["RUNNER_CONTAINER_EXECUTION_FAILED", "RUNNER_CONTAINER_OUTPUT_INVALID"].includes(
    error?.code
  )
    ? "INTERRUPTED_UNKNOWN"
    : "PREFLIGHT_REJECTED";
}

export async function launchRunnerContainer(input) {
  try {
    return await executeRunnerContainer(input);
  } catch (error) {
    if (typeof input?.recordHostFailure === "function") {
      await input.recordHostFailure({
        terminalClass: hostTerminalClass(error),
        reasonCode: error?.code ?? "RUNNER_CONTAINER_EXECUTION_FAILED"
      });
    }
    throw error;
  }
}

function runProcess(command, args, { environment = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function inspectDockerImage(reference) {
  const result = await runProcess("docker", ["image", "inspect", reference]);
  if (result.exitCode !== 0) throw launchError("RUNNER_CONTAINER_IMAGE_INSPECTION_FAILED");
  let images;
  try {
    images = JSON.parse(result.stdout);
  } catch {
    throw launchError("RUNNER_CONTAINER_IMAGE_INSPECTION_FAILED");
  }
  if (!Array.isArray(images) || images.length !== 1) {
    throw launchError("RUNNER_CONTAINER_IMAGE_INSPECTION_FAILED");
  }
  return Object.freeze({
    repoDigests: Object.freeze([...(images[0].RepoDigests ?? [])]),
    sourceRevision: images[0].Config?.Labels?.["org.opencontainers.image.revision"] ?? null
  });
}

async function appendHostLaunchFailure(launchEnvelopeFile, state) {
  const launchRoot = path.resolve(".release-local", "launch");
  const evidenceRoot = path.resolve(".release-local", "evidence");
  const absoluteEnvelope = path.resolve(launchEnvelopeFile);
  const relative = path.relative(launchRoot, absoluteEnvelope);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw launchError("RUNNER_LAUNCH_ENVELOPE_PATH_FORBIDDEN");
  }
  const journal = path.resolve(evidenceRoot, `${relative}.host-journal.ndjson`);
  const journalRelative = path.relative(evidenceRoot, journal);
  if (!journalRelative || journalRelative.startsWith("..") || path.isAbsolute(journalRelative)) {
    throw launchError("RUNNER_HOST_JOURNAL_PATH_FORBIDDEN");
  }
  await mkdir(path.dirname(journal), { recursive: true });
  const entry = Object.freeze({
    schemaVersion: "runner-host-launch-state.v1",
    recordedAt: new Date().toISOString(),
    launchEnvelopePath: relative.split(path.sep).join("/"),
    ...state
  });
  const line = `${JSON.stringify(entry)}\n`;
  await appendFile(journal, line, { encoding: "utf8", flag: "a" });
  const readback = await readFile(journal, "utf8");
  if (!readback.endsWith(line)) throw launchError("RUNNER_HOST_JOURNAL_UNAVAILABLE");
}

export function createTrustedLaunchProductionAdapters() {
  return Object.freeze({
    launchRunnerContainer(input) {
      return launchRunnerContainer({
        ...input,
        verifyLaunchEnvelope: (launchEnvelopeFile) =>
          verifyAttestedLaunchEnvelope({ launchEnvelopeFile }),
        inspectImage: inspectDockerImage,
        spawn: runProcess,
        recordHostFailure: (state) => appendHostLaunchFailure(input.launchEnvelopeFile, state)
      });
    }
  });
}
