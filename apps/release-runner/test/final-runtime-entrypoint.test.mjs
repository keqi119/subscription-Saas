import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sha256Canonical } from "../../../packages/release-foundation/src/digest.mjs";
import { finalDatabaseEnvelopeFixture } from "./fixtures/final-database-envelope.mjs";
import { runFinalRuntimeEntrypoint } from "../src/final-runtime-entrypoint.mjs";

async function fixture() {
  const { envelope, manifest } = await finalDatabaseEnvelopeFixture();
  const readActual = async (name) =>
    JSON.parse(await readFile(new URL(`../../../release/contracts/${name}`, import.meta.url)));
  const discovery = await readActual("database-test-discovery.v1.json");
  const policies = await readActual("database-target-policies.v1.json");
  const hosted = await readActual("manual-stage1-r3-target-policy.v1.json");
  const policy = policies.policies.find((item) => item.policyId === "s1-release-compose-ephemeral");
  envelope.postgres.imageDigest = policy.requiredImageDigest;
  envelope.postgres.hostname = "postgres";
  envelope.profileDigest = hosted.profileDigest;
  const credentials = {},
    runtimePreparations = {};
  for (const assignment of Object.values(envelope.suiteAssignments)) {
    if (assignment.kind !== "suite") continue;
    for (const database of Object.values(assignment.databases)) {
      credentials[database.databaseName] = {
        username: database.runtimeRole,
        password: `${database.databaseName}:runtime-test`,
        capabilityProfile: "runtime-test"
      };
      runtimePreparations[database.databaseName] = {
        migrationEvidenceDigest: database.migrationEvidenceDigest,
        schemaFixture: null
      };
    }
  }
  const input = { envelope, credentials, runtimePreparations, lifecycleContext: {} };
  const files = new Map([
    ["/app/release/contracts/database-test-manifest.v1.json", manifest],
    ["/app/release/contracts/database-test-discovery.v1.json", discovery],
    ["/app/release/contracts/database-target-policies.v1.json", policies],
    ["/app/release/contracts/manual-stage1-r3-target-policy.v1.json", hosted]
  ]);
  const writes = [];
  const readFixed = async (file) => {
    assert.ok(files.has(file), `unexpected read: ${file}`);
    return Buffer.from(JSON.stringify(files.get(file)));
  };
  const writeFixed = async (file, bytes, options) => {
    writes.push({ file, content: JSON.parse(Buffer.from(bytes)), options });
  };
  let called;
  const executeManifest = async (args) => {
    called = args;
    return { manifestReport: { terminalStatus: "PASSED" }, suiteReadbacks: [] };
  };
  const runChannel = async ({ executeManifest: callback }) =>
    callback(input, { executeLifecycle: async () => {}, signal: new AbortController().signal });
  return {
    input,
    files,
    writes,
    readFixed,
    writeFixed,
    executeManifest,
    runChannel,
    get called() {
      return called;
    }
  };
}

test("fixed final runtime entrypoint binds repository contracts and writes only allowed launch files", async () => {
  const f = await fixture();
  await runFinalRuntimeEntrypoint({
    readFixed: f.readFixed,
    writeFixed: f.writeFixed,
    runChannel: f.runChannel,
    executeManifest: f.executeManifest
  });
  assert.deepEqual(f.called.envelope, f.input.envelope);
  assert.equal(f.called.discoveryDigest, f.input.envelope.databaseTestDiscoveryDigest);
  assert.equal(f.called.repoRoot, "/app");
  assert.equal(f.writes.length, 1 + Object.keys(f.input.credentials).length);
  assert.equal(f.writes[0].file, "/run/launch/database-test-manifest.json");
  assert.equal(sha256Canonical(f.writes[0].content), f.input.envelope.databaseTestManifestDigest);
  assert.ok(
    f.writes
      .slice(1)
      .every(
        ({ file, options }) =>
          /^\/run\/secrets\/s1ci_[0-9a-f]{24}-runtime-test\.json$/.test(file) &&
          options.flag === "wx" &&
          options.mode === 0o600
      )
  );
});

test("fixed final runtime entrypoint rejects changed references and credentials before writes", async () => {
  const f = await fixture();
  f.input.envelope.databaseTestManifestReference =
    "launch-file:///run/launch/foreign-manifest.json";
  await assert.rejects(
    () =>
      runFinalRuntimeEntrypoint({
        readFixed: f.readFixed,
        writeFixed: f.writeFixed,
        runChannel: f.runChannel,
        executeManifest: f.executeManifest
      }),
    { code: "R3_FINAL_RUNTIME_INPUT_INVALID" }
  );
  assert.equal(f.writes.length, 0);
  f.input.envelope.databaseTestManifestReference =
    "launch-file:///run/launch/database-test-manifest.json";
  Object.values(f.input.credentials)[0].capabilityProfile = "migrate";
  await assert.rejects(
    () =>
      runFinalRuntimeEntrypoint({
        readFixed: f.readFixed,
        writeFixed: f.writeFixed,
        runChannel: f.runChannel,
        executeManifest: f.executeManifest
      }),
    { code: "R3_FINAL_RUNTIME_INPUT_INVALID" }
  );
  assert.equal(f.writes.length, 0);
});
