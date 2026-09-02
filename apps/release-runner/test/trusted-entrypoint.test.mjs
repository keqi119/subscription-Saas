import assert from "node:assert/strict";
import test from "node:test";

import { sha256Canonical } from "@subscription-saas/release-foundation";

const digest = (character) => `sha256:${character.repeat(64)}`;

function validEnvelope() {
  const request = {
    buildProofDigest: digest("a"),
    actualRunnerDigest: digest("b"),
    secretReference: "secret://runner/verify",
    launchAttestation: { attestationId: "launch-1" }
  };
  return {
    schemaVersion: "runner-launch-envelope.v1",
    executionMode: "registered-command",
    commandKey: "release.verify@1",
    request,
    requestDigest: sha256Canonical(request),
    buildProofDigest: request.buildProofDigest,
    actualRunnerDigest: request.actualRunnerDigest,
    launchAttestationDigest: sha256Canonical(request.launchAttestation),
    capabilitySecretReference: "secret-file:///run/secrets/database-credential",
    journalReference: "evidence-file:///evidence/execution-journal.ndjson",
    revocationCheckpointReference: "evidence-file:///evidence/revocation-checkpoint.json",
    custodyPolicyReference: "launch-file:///run/launch/custody-policy.v1.json",
    custodyPolicyDigest: digest("d")
  };
}

test("exports the fixed trusted Runner entrypoint", async () => {
  const entrypoint = await import("../src/trusted-entrypoint.mjs").catch(() => ({}));

  assert.equal(typeof entrypoint.runTrustedEntrypoint, "function");
});

test("rejects a missing launch envelope before adapter access", async () => {
  const { runTrustedEntrypoint } = await import("../src/trusted-entrypoint.mjs");
  let adapterReads = 0;

  await assert.rejects(
    () =>
      runTrustedEntrypoint({
        envelopeFile: undefined,
        argv: [],
        adapters: {
          async readEnvelope() {
            adapterReads += 1;
          }
        }
      }),
    { code: "RUNNER_LAUNCH_ENVELOPE_REQUIRED" }
  );
  assert.equal(adapterReads, 0);
});

test("rejects process arguments before reading the launch envelope", async () => {
  const { runTrustedEntrypoint } = await import("../src/trusted-entrypoint.mjs");
  let adapterReads = 0;

  await assert.rejects(
    () =>
      runTrustedEntrypoint({
        envelopeFile: "/run/launch/runner-launch-envelope.v1.json",
        argv: ["node", "scripts/arbitrary.mjs"],
        adapters: {
          async readEnvelope() {
            adapterReads += 1;
          }
        }
      }),
    { code: "RUNNER_ENTRYPOINT_OVERRIDE_REJECTED" }
  );
  assert.equal(adapterReads, 0);
});

test("dispatches exactly one registered command from the validated envelope", async () => {
  const { runTrustedEntrypoint } = await import("../src/trusted-entrypoint.mjs");
  const envelope = validEnvelope();
  const launches = [];

  const result = await runTrustedEntrypoint({
    envelopeFile: "/run/launch/runner-launch-envelope.v1.json",
    argv: [],
    adapters: {
      async readEnvelope() {
        return envelope;
      },
      async launch(input) {
        launches.push(input);
        return { terminalStatus: "PASSED" };
      }
    }
  });

  assert.equal(result.terminalStatus, "PASSED");
  assert.equal(launches.length, 1);
  assert.equal(launches[0].commandKey, "release.verify@1");
  assert.deepEqual(launches[0].request, envelope.request);
});

test("rejects a launch-attestation digest mismatch before dispatch", async () => {
  const { runTrustedEntrypoint } = await import("../src/trusted-entrypoint.mjs");
  const envelope = validEnvelope();
  envelope.launchAttestationDigest = digest("f");
  let launches = 0;

  await assert.rejects(
    () =>
      runTrustedEntrypoint({
        envelopeFile: "/run/launch/runner-launch-envelope.v1.json",
        argv: [],
        adapters: {
          async readEnvelope() {
            return envelope;
          },
          async launch() {
            launches += 1;
          }
        }
      }),
    { code: "RUNNER_LAUNCH_ENVELOPE_IDENTITY_MISMATCH" }
  );
  assert.equal(launches, 0);
});

test("rejects raw credentials anywhere in the launch envelope", async () => {
  const { runTrustedEntrypoint } = await import("../src/trusted-entrypoint.mjs");
  const envelope = validEnvelope();
  envelope.request.databaseUrl = "postgresql://runner:secret@db/subscription";
  envelope.requestDigest = sha256Canonical(envelope.request);
  let launches = 0;

  await assert.rejects(
    () =>
      runTrustedEntrypoint({
        envelopeFile: "/run/launch/runner-launch-envelope.v1.json",
        argv: [],
        adapters: {
          async readEnvelope() {
            return envelope;
          },
          async launch() {
            launches += 1;
          }
        }
      }),
    { code: "RUNNER_LAUNCH_ENVELOPE_SECRET_FORBIDDEN" }
  );
  assert.equal(launches, 0);
});

test("rejects an unregistered envelope command before dispatch", async () => {
  const { runTrustedEntrypoint } = await import("../src/trusted-entrypoint.mjs");
  const envelope = validEnvelope();
  envelope.commandKey = "release.unknown@1";
  let launches = 0;

  await assert.rejects(
    () =>
      runTrustedEntrypoint({
        envelopeFile: "/run/launch/runner-launch-envelope.v1.json",
        argv: [],
        adapters: {
          async readEnvelope() {
            return envelope;
          },
          async launch() {
            launches += 1;
          }
        }
      }),
    { code: "RUNNER_COMMAND_NOT_REGISTERED" }
  );
  assert.equal(launches, 0);
});
