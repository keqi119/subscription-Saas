import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/index.mjs";

const runnerImage = `ghcr.io/keqi119/subscription-runner@sha256:${"a".repeat(64)}`;

test("builds only the fixed no-command Compose invocation", async () => {
  const production = await import("./trusted-launch-production-adapters.mjs").catch(() => ({}));

  assert.equal(typeof production.runnerComposeInvocation, "function");
  assert.deepEqual(
    production.runnerComposeInvocation({
      composeFile: "docker-compose.release-gate.yml",
      projectName: "stage1-s1-fresh",
      service: "runner-verify"
    }),
    [
      "compose",
      "--project-name",
      "stage1-s1-fresh",
      "--file",
      "docker-compose.release-gate.yml",
      "run",
      "--no-deps",
      "runner-verify"
    ]
  );
});

test("launches one allowlisted service only after the image digest matches", async () => {
  const { launchRunnerContainer } = await import("./trusted-launch-production-adapters.mjs");
  const calls = [];
  const result = await launchRunnerContainer({
    launchEnvelopeFile: ".release-local/launch/fresh/runner-launch-envelope.v1.json",
    composeFile: "docker-compose.release-gate.yml",
    projectName: "stage1-s1-fresh",
    service: "runner-verify",
    expectedRunnerImage: runnerImage,
    async verifyLaunchEnvelope(file) {
      calls.push(["verify-envelope", file]);
      return {
        actualRunnerDigest: runnerImage.slice(runnerImage.indexOf("@") + 1),
        request: { buildProof: { identity: { sourceSha: "b".repeat(40) } } }
      };
    },
    async inspectImage(reference) {
      calls.push(["inspect", reference]);
      return { repoDigests: [runnerImage], sourceRevision: "b".repeat(40) };
    },
    async spawn(command, args) {
      calls.push([command, args]);
      return { exitCode: 0, stdout: '{"terminalStatus":"PASSED"}\n', stderr: "" };
    }
  });

  assert.equal(result.terminalStatus, "PASSED");
  assert.deepEqual(calls[0], [
    "verify-envelope",
    ".release-local/launch/fresh/runner-launch-envelope.v1.json"
  ]);
  assert.deepEqual(calls[1], ["inspect", runnerImage]);
  assert.equal(calls[2][0], "docker");
  assert.equal(calls[2][1].includes("exec"), false);
  assert.equal(calls[2][1].includes("--entrypoint"), false);
  assert.equal(calls[2][1].includes("--volume"), false);
  assert.equal(calls[2][1].at(-1), "runner-verify");
});

test("rejects unknown services and digest substitution before Docker launch", async () => {
  const { launchRunnerContainer } = await import("./trusted-launch-production-adapters.mjs");
  let spawns = 0;
  const failures = [];
  const spawn = async () => {
    spawns += 1;
  };
  await assert.rejects(
    () =>
      launchRunnerContainer({
        composeFile: "docker-compose.release-gate.yml",
        projectName: "stage1-s1-fresh",
        service: "runner-arbitrary",
        launchEnvelopeFile: ".release-local/launch/fresh/runner-launch-envelope.v1.json",
        expectedRunnerImage: runnerImage,
        verifyLaunchEnvelope: async () => ({}),
        inspectImage: async () => ({ repoDigests: [runnerImage] }),
        spawn
      }),
    { code: "RUNNER_CONTAINER_SERVICE_FORBIDDEN" }
  );
  await assert.rejects(
    () =>
      launchRunnerContainer({
        composeFile: "docker-compose.release-gate.yml",
        projectName: "stage1-s1-fresh",
        service: "runner-migration",
        launchEnvelopeFile: ".release-local/launch/fresh/runner-launch-envelope.v1.json",
        expectedRunnerImage: runnerImage,
        verifyLaunchEnvelope: async () => ({
          actualRunnerDigest: runnerImage.slice(runnerImage.indexOf("@") + 1),
          request: { buildProof: { identity: { sourceSha: "b".repeat(40) } } }
        }),
        inspectImage: async () => ({
          repoDigests: [`ghcr.io/keqi119/subscription-runner@sha256:${"f".repeat(64)}`]
        }),
        spawn,
        recordHostFailure: async (failure) => failures.push(failure)
      }),
    { code: "RUNNER_CONTAINER_DIGEST_MISMATCH" }
  );
  assert.equal(spawns, 0);
  assert.deepEqual(failures, [
    {
      terminalClass: "PREFLIGHT_REJECTED",
      reasonCode: "RUNNER_CONTAINER_DIGEST_MISMATCH"
    }
  ]);
});

test("records an indeterminate container result as INTERRUPTED_UNKNOWN", async () => {
  const { launchRunnerContainer } = await import("./trusted-launch-production-adapters.mjs");
  const failures = [];
  await assert.rejects(
    () =>
      launchRunnerContainer({
        composeFile: "docker-compose.release-gate.yml",
        projectName: "stage1-s1-fresh",
        service: "runner-verify",
        launchEnvelopeFile: ".release-local/launch/fresh/runner-launch-envelope.v1.json",
        expectedRunnerImage: runnerImage,
        verifyLaunchEnvelope: async () => ({
          actualRunnerDigest: runnerImage.slice(runnerImage.indexOf("@") + 1),
          request: { buildProof: { identity: { sourceSha: "b".repeat(40) } } }
        }),
        inspectImage: async () => ({
          repoDigests: [runnerImage],
          sourceRevision: "b".repeat(40)
        }),
        spawn: async () => ({ exitCode: 137, stdout: "", stderr: "terminated" }),
        recordHostFailure: async (failure) => failures.push(failure)
      }),
    { code: "RUNNER_CONTAINER_EXECUTION_FAILED" }
  );
  assert.deepEqual(failures, [
    {
      terminalClass: "INTERRUPTED_UNKNOWN",
      reasonCode: "RUNNER_CONTAINER_EXECUTION_FAILED"
    }
  ]);
});

test("cryptographically verifies the launch envelope against the fixed workflow identity", async () => {
  const { verifyAttestedLaunchEnvelope } = await import("./trusted-launch-production-adapters.mjs");
  const buildProof = JSON.parse(
    await readFile("scripts/release/fixtures/build-proof.valid.json", "utf8")
  );
  const request = {
    buildProof,
    buildProofDigest: sha256Canonical(buildProof),
    actualRunnerDigest: buildProof.identity.images.runner.imageDigest,
    launchAttestation: { attestationId: "launch-1" }
  };
  const envelope = {
    schemaVersion: "runner-launch-envelope.v1",
    executionMode: "registered-command",
    commandKey: "db.schema.verify@1",
    request,
    requestDigest: sha256Canonical(request),
    buildProofDigest: request.buildProofDigest,
    actualRunnerDigest: request.actualRunnerDigest,
    launchAttestationDigest: sha256Canonical(request.launchAttestation),
    capabilitySecretReference: "secret-file:///run/secrets/database-credential",
    journalReference: "evidence-file:///evidence/execution-journal.ndjson",
    revocationCheckpointReference: "evidence-file:///evidence/revocation-checkpoint.ndjson",
    custodyPolicyReference: "launch-file:///run/launch/custody-policy.v1.json",
    custodyPolicyDigest: `sha256:${"d".repeat(64)}`
  };
  const bytes = Buffer.from(JSON.stringify(envelope));
  const subjectDigest = sha256Bytes(bytes).slice("sha256:".length);
  const calls = [];

  const verified = await verifyAttestedLaunchEnvelope({
    launchEnvelopeFile: ".release-local/launch/fresh/runner-launch-envelope.v1.json",
    repository: "keqi119/subscription-Saas",
    readArtifact: async () => bytes,
    async run(command, args) {
      calls.push([command, args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            verificationResult: {
              statement: { subject: [{ digest: { sha256: subjectDigest } }] }
            }
          }
        ]),
        stderr: ""
      };
    }
  });

  assert.equal(verified.actualRunnerDigest, request.actualRunnerDigest);
  assert.deepEqual(calls, [
    [
      "gh",
      [
        "attestation",
        "verify",
        ".release-local/launch/fresh/runner-launch-envelope.v1.json",
        "--repo",
        "keqi119/subscription-Saas",
        "--signer-workflow",
        "github.com/keqi119/subscription-Saas/.github/workflows/release-candidate-gate.yml",
        "--source-digest",
        buildProof.identity.sourceSha,
        "--format",
        "json"
      ]
    ]
  ]);
});

test("Runner image and Compose keep a fixed entrypoint and read-only launch envelope", async () => {
  const [dockerfile, compose] = await Promise.all([
    readFile("Dockerfile.runner", "utf8"),
    readFile("docker-compose.release-gate.yml", "utf8")
  ]);

  assert.match(dockerfile, /COPY scripts \.\/scripts/u);
  assert.match(dockerfile, /ENTRYPOINT \["node", "\/app\/apps\/release-runner\/src\/cli\.mjs"\]/u);
  assert.match(dockerfile, /RUNNER_ENTRYPOINT_OVERRIDE_REJECTED/u);
  assert.match(dockerfile, /RUNNER_LAUNCH_ENVELOPE_REQUIRED/u);
  assert.match(
    compose,
    /RUNNER_LAUNCH_ENVELOPE_FILE: \/run\/launch\/runner-launch-envelope\.v1\.json/u
  );
  assert.match(compose, /target: \/run\/launch\/runner-launch-envelope\.v1\.json/u);
  assert.doesNotMatch(compose, /\/var\/run\/docker\.sock|entrypoint:/u);
});
