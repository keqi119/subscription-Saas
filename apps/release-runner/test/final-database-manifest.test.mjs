import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Canonical } from "../../../packages/release-foundation/src/digest.mjs";
import { runSchemaFixture } from "../../../packages/release-foundation/src/node-database-test-runner.mjs";
import { buildDatabaseSuiteReport } from "../../../packages/release-foundation/src/database-test-launcher.mjs";
import { summarizeDatabaseTestLog } from "../../../scripts/release/database-test-launcher-runtime.mjs";
import { validateFinalDatabaseTestAssignments } from "../src/database-test-envelope.mjs";
import { finalDatabaseEnvelopeFixture } from "./fixtures/final-database-envelope.mjs";
import { executePreparedFinalManifest } from "../src/final-database-manifest.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const lifecycleFile = "/app/packages/release-foundation/test/database-lifecycle.postgres.test.mjs";
const tap =
  "TAP version 13\n1..1\nok 1 - fixed\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n";
const lifecycleTap =
  "TAP version 13\n1..2\nok 1 - fixed\nok 2 - fixed\n# tests 2\n# pass 2\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n";
const lifecycleNames = [
  "provisions, migrates, isolates, and exactly cleans concurrent PostgreSQL databases",
  "uses the platform package-manager entrypoint for lifecycle migrations"
];

async function fixture(t) {
  const { envelope, manifest } = await finalDatabaseEnvelopeFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "r3-final-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selected = validateFinalDatabaseTestAssignments({
    envelope,
    manifest,
    discoveryDigest: envelope.databaseTestDiscoveryDigest
  }).selections;
  const credentials = {},
    runtimePreparations = {},
    byName = {};
  for (const selection of selected) {
    if (selection.r3ExecutionMode === "lifecycle-owned") continue;
    for (const name of Object.keys(selection.databaseAssignment.databases)) {
      const db = selection.databaseAssignment.databases[name];
      credentials[db.databaseName] = {
        username: db.runtimeRole,
        password: `${db.databaseName}:runtime-test`,
        capabilityProfile: "runtime-test"
      };
      byName[db.databaseName] = db;
      const schemaFixture = selection.fixtures?.schema ?? null;
      if (schemaFixture) {
        const source = path.join(repoRoot, schemaFixture);
        const destination = path.join(root, schemaFixture);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(source));
      }
      runtimePreparations[db.databaseName] = {
        migrationEvidenceDigest: db.migrationEvidenceDigest,
        schemaFixture: schemaFixture
          ? await runSchemaFixture({
              repoRoot: root,
              runtimeRole: db.runtimeRole,
              fixturePath: schemaFixture,
              credentialRef:
                selection[name === "target" ? "assignment" : "additionalAssignments"]
                  ?.secretReferences?.migrate ??
                selection.additionalAssignments.find((entry) => entry.name === name)
                  .secretReferences.migrate,
              credentialFingerprint: db.migrationCredentialFingerprint,
              counterpartCredentialFingerprint: db.runtimeCredentialFingerprint,
              executeSql: async () => {}
            })
          : null
      };
      if (selection.fixtures?.seed) {
        const source = path.join(repoRoot, selection.fixtures.seed);
        const destination = path.join(root, selection.fixtures.seed);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(source));
      }
    }
  }
  const calls = { connected: [], closed: [], executed: [], contexts: [], lifecycle: [] };
  const connectDatabase = async ({ credential, target }) => {
    calls.connected.push({ databaseName: target.databaseName, username: credential.username });
    const db = byName[target.databaseName];
    const row = {
      databaseName: db.databaseName,
      databaseOid: db.databaseOid,
      marker: db.marker,
      databaseOwner: db.migrationRole,
      publicSchemaOwner: db.migrationRole,
      migrationTableOwner: db.migrationRole,
      role: db.runtimeRole,
      tls: true,
      canLogin: true,
      superuser: false,
      createdb: false,
      createrole: false,
      inherit: false,
      replication: false,
      bypassrls: false,
      canCreateDatabase: false,
      canCreateTemporaryObjects: false,
      canCreatePublicSchema: false,
      schemaOwner: false,
      objectOwner: false,
      memberships: 0,
      grantedTo: 0
    };
    return {
      $queryRawUnsafe: async () => [row],
      $executeRawUnsafe: async (sql) => {
        calls.executed.push({ databaseName: db.databaseName, sql });
        return 1;
      },
      close: async () => {
        calls.closed.push(db.databaseName);
      }
    };
  };
  const executeProcess = async (command, args, { environment }) => {
    const context = JSON.parse(
      await readFile(path.join(root, environment.S1_RELEASE_DATABASE_CONTEXT))
    );
    calls.contexts.push({ context, command, args, environment });
    return {
      exitCode: 0,
      signal: null,
      stdout:
        command === "node" && args[0]?.includes("vitest")
          ? JSON.stringify({
              numTotalTests: 1,
              numPassedTests: 1,
              numFailedTests: 0,
              numPendingTests: 0,
              numTodoTests: 0,
              testResults: []
            })
          : tap,
      stderr: "",
      timedOut: false,
      truncated: false,
      processError: false
    };
  };
  const executeLifecycle = async (selection) => {
    calls.lifecycle.push(selection.suiteId);
    const originals = {
      tap: lifecycleTap,
      counts: {
        tests: 2,
        passed: 2,
        failed: 0,
        skipped: 0,
        cancelled: 0,
        todo: 0,
        topLevel: 2,
        suites: 0
      },
      summaries: [
        {
          success: true,
          counts: {
            tests: 2,
            passed: 2,
            failed: 0,
            skipped: 0,
            cancelled: 0,
            todo: 0,
            topLevel: 2,
            suites: 0
          }
        }
      ],
      testEvents: lifecycleNames.map((name) => ({
        type: "test:pass",
        data: { name, file: lifecycleFile }
      }))
    };
    const provisioned = {
      ...selection.assignment,
      databaseOid: "9001",
      targetFingerprint: envelope.profileDigest,
      additionalDatabases: selection.additionalAssignments.map((item) => ({
        ...item,
        databaseOid: "9002",
        targetFingerprint: envelope.profileDigest
      }))
    };
    const boundary = (database) => ({
      database,
      roleAttributes: { superuser: false, createdb: false, createrole: false, bypassrls: false },
      canCreateSchema: false,
      schemaOwner: false,
      objectOwner: false
    });
    const report = buildDatabaseSuiteReport({
      execution: selection,
      provisioned,
      operationId: envelope.operationId,
      result: {
        counts: {
          collected: 2,
          selected: 2,
          executed: 2,
          passed: 2,
          failed: 0,
          skipped: 0,
          todo: 0,
          filtered: 0,
          cancelled: 0
        },
        roleBoundaries: [boundary("target"), boundary("sibling")],
        sanitizedLogDigest: sha256Canonical(
          summarizeDatabaseTestLog({ stdout: lifecycleTap, stderr: "" })
        )
      }
    });
    return { report, originals };
  };
  return {
    envelope,
    manifest,
    discoveryDigest: envelope.databaseTestDiscoveryDigest,
    credentials,
    runtimePreparations,
    connectDatabase,
    executeProcess,
    executeLifecycle,
    calls,
    repoRoot: root,
    signal: new AbortController().signal
  };
}

test("final manifest uses distinct prepared databases and source-target contexts", async (t) => {
  const f = await fixture(t);
  const result = await executePreparedFinalManifest(f);
  assert.equal(result.manifestReport.terminalStatus, "PASSED");
  assert.equal(result.suiteReadbacks.length, f.manifest.suites.length);
  assert.equal(f.calls.lifecycle.length, 1);
  const clean = f.calls.contexts.find(
    ({ context }) => context.suiteId === "script.stage1-clean-acceptance.postgres"
  );
  assert.ok(clean);
  assert.notEqual(
    clean.context.namedDatabases.target.databaseName,
    clean.context.namedDatabases.source.databaseName
  );
  assert.equal(clean.context.containerId, f.envelope.runnerContainerId);
  assert.deepEqual(
    clean.context.allowedFiles,
    f.manifest.suites.find((suite) => suite.suiteId === clean.context.suiteId).files
  );
  assert.equal(
    new Set(f.calls.connected.map((item) => item.databaseName)).size,
    Object.keys(f.credentials).length
  );
  assert.equal(f.calls.closed.length, f.calls.connected.length);
});

test("final manifest rejects migration credentials before opening a database", async (t) => {
  const f = await fixture(t);
  const name = Object.keys(f.credentials)[0];
  f.credentials[name].capabilityProfile = "migrate";
  await assert.rejects(() => executePreparedFinalManifest(f), {
    code: "DATABASE_TEST_FINAL_MANIFEST_INVALID"
  });
  assert.equal(f.calls.connected.length, 0);
  assert.equal(f.calls.lifecycle.length, 0);
});

test("final manifest fails closed with retained originals after a process failure", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.executeProcess = async (...args) => {
    const result = await fixtureProcess(...args);
    if (++calls === 2) return { ...result, exitCode: 1 };
    return result;
  };
  // Use the first harmless process output as a fixed failure without executing a suite.
  async function fixtureProcess(command, args, options) {
    const context = JSON.parse(
      await readFile(path.join(f.repoRoot, options.environment.S1_RELEASE_DATABASE_CONTEXT))
    );
    f.calls.contexts.push({ context, command, args });
    return {
      exitCode: 0,
      signal: null,
      stdout: tap,
      stderr: "",
      timedOut: false,
      truncated: false,
      processError: false
    };
  }
  await assert.rejects(
    () => executePreparedFinalManifest(f),
    (error) =>
      error.code === "DATABASE_TEST_FINAL_MANIFEST_INVALID" &&
      Array.isArray(error.suiteReadbacks) &&
      error.suiteReadbacks.length > 0 &&
      error.manifestReport === undefined
  );
});
