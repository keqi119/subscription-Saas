import assert from "node:assert/strict";
import test from "node:test";

import { finalizeRunnerExecution, runCli, runProductionEntrypoint } from "../src/cli.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

for (const argv of [["sh"], ["execute", "scripts/foo.mjs"], ["sql", "select 1"]]) {
  test(`rejects unsupported invocation ${argv.join(" ")}`, async () => {
    await assert.rejects(() => runCli(argv), { code: "RUNNER_COMMAND_NOT_REGISTERED" });
  });
}

test("accepts only execute command@version with a request file", async () => {
  const calls = [];
  const result = await runCli(["execute", "release.verify@1", "--request-file", "request.json"], {
    execute: async (input) => {
      calls.push(input);
      return { terminalStatus: "PASSED" };
    }
  });
  assert.equal(calls[0].commandKey, "release.verify@1");
  assert.equal(calls[0].requestFile, "request.json");
  assert.equal(result.terminalStatus, "PASSED");
});

test("Runner finalizes a normal observation before its execution proof", () => {
  const operationId = "25d422be-1036-470c-a844-fe24735222cf";
  const attemptId = "49101a87-aece-4c51-9be0-30233466510b";
  const result = finalizeRunnerExecution({
    terminalStatus: "PASSED",
    postStateObservationInput: {
      operationId,
      attemptId,
      runId: "56f4ad5b-d7d3-4682-a835-0659a961c413",
      baselineManifestIdentityDigest: digest("1"),
      baselineManifestDigest: digest("2"),
      commandId: "release.verify",
      commandVersion: "1",
      planDigest: digest("3"),
      databaseIdentityFingerprint: digest("4"),
      postMigrationHead: null,
      postSchemaDigest: digest("5"),
      configurationFingerprint: digest("6"),
      postconditions: [
        {
          id: "schema-observed",
          status: "PASSED",
          expectedDigest: digest("7"),
          actualDigest: digest("7")
        }
      ],
      observedAt: "2026-09-02T09:00:00.000Z"
    },
    executionProofInput: {
      operationId,
      attemptId,
      phase: "verify",
      predecessorProofDigest: null,
      status: "SUCCEEDED",
      buildProofDigest: digest("8"),
      baselineManifestIdentityDigest: digest("1"),
      baselineManifestDigest: digest("2"),
      executionScope: "verify",
      command: {
        id: "release.verify",
        version: "1",
        capability: "verify",
        approvalMode: "none"
      },
      databaseIdentityFingerprint: digest("4"),
      inputDigest: digest("9"),
      planDigest: digest("3"),
      outputDigest: digest("a"),
      postconditionsStatus: "PASSED",
      timing: {
        startedAt: "2026-09-02T08:59:00.000Z",
        completedAt: "2026-09-02T09:00:01.000Z"
      },
      toolVersion: "release-runner/1",
      error: null,
      references: {
        launcher: "launcher://run/1",
        policy: "policy://s1-runner-controlled",
        approval: null
      }
    }
  });
  assert.equal(result.executionProof.postStateObservationDigest, result.postStateObservationDigest);
  assert.match(result.executionProofDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal("executionProofInput" in result, false);
});

test("production process delegates only the fixed launch-envelope path", async () => {
  const calls = [];
  const result = await runProductionEntrypoint({
    argv: [],
    environment: {
      RUNNER_LAUNCH_ENVELOPE_FILE: "/run/launch/runner-launch-envelope.v1.json"
    },
    adapters: { trustPolicy: "runner-runtime-adapters/v1" },
    executeTrusted: async (input) => {
      calls.push(input);
      return { terminalStatus: "PASSED" };
    }
  });

  assert.equal(result.terminalStatus, "PASSED");
  assert.deepEqual(calls, [
    {
      envelopeFile: "/run/launch/runner-launch-envelope.v1.json",
      argv: [],
      adapters: { trustPolicy: "runner-runtime-adapters/v1" }
    }
  ]);
});

test("production process constructs runtime adapters when none are injected", async () => {
  const calls = [];
  const runtimeAdapters = { trustPolicy: "runner-runtime-adapters/v1" };
  await runProductionEntrypoint({
    argv: [],
    environment: {
      RUNNER_LAUNCH_ENVELOPE_FILE: "/run/launch/runner-launch-envelope.v1.json"
    },
    createAdapters() {
      calls.push("create-adapters");
      return runtimeAdapters;
    },
    executeTrusted: async ({ adapters }) => {
      calls.push(adapters);
      return { terminalStatus: "PASSED" };
    }
  });

  assert.deepEqual(calls, ["create-adapters", runtimeAdapters]);
});
