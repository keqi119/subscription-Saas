import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { finalDatabaseEnvelopeFixture } from "../../apps/release-runner/test/fixtures/final-database-envelope.mjs";
import { validateFinalDatabaseTestAssignments } from "../../apps/release-runner/src/database-test-envelope.mjs";
import { observeFinalRuntimeBoundary } from "../../apps/release-runner/src/final-database-runtime.mjs";
import {
  runSchemaFixture,
  runRuntimeSeedFixture,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import {
  buildDatabaseSuiteReport,
  runDatabaseManifest
} from "../../packages/release-foundation/src/database-test-launcher.mjs";
import { databaseTestCounts, summarizeDatabaseTestLog } from "./database-test-launcher-runtime.mjs";
import { assessR3FinalSuiteReadbacks } from "./r3-final-suite-result.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const tap =
  "TAP version 13\n1..1\nok 1 - fixed\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n";
const lifecycleTap =
  "TAP version 13\n1..2\nok 1 - provisions, migrates, isolates, and exactly cleans concurrent PostgreSQL databases\nok 2 - uses the platform package-manager entrypoint for lifecycle migrations\n# tests 2\n# pass 2\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n";
const names = [
  "provisions, migrates, isolates, and exactly cleans concurrent PostgreSQL databases",
  "uses the platform package-manager entrypoint for lifecycle migrations"
];
const same = (a, b) => sha256Canonical(a) === sha256Canonical(b);
const role = { superuser: false, createdb: false, createrole: false, bypassrls: false };
const runtimeRow = (db) => ({
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
});
const readBoundary = (db) =>
  observeFinalRuntimeBoundary({ $queryRawUnsafe: async () => [runtimeRow(db)] }, db);

async function fixture() {
  const { envelope, manifest } = await finalDatabaseEnvelopeFixture();
  const discoveryDigest = envelope.databaseTestDiscoveryDigest;
  const selections = validateFinalDatabaseTestAssignments({
    envelope,
    manifest,
    discoveryDigest
  }).selections.map((selection) => ({ ...selection, runId: envelope.runId }));
  const runtimePreparations = {},
    suiteReadbacks = [];
  let lifecycle;
  for (const selection of selections) {
    if (selection.r3ExecutionMode === "lifecycle-owned") {
      const fingerprint = sha256Canonical({
        engineId: envelope.postgres.engineId,
        systemIdentifier: envelope.postgres.systemIdentifier,
        containerId: envelope.postgres.containerId,
        imageDigest: envelope.postgres.imageDigest
      });
      const records = selection.databaseAssignment.reservations.map((reservation, index) => {
        const databaseOid = String(9001 + index);
        const createdAt = "2026-09-29T00:00:00.000Z";
        const marker = JSON.stringify({
          markerVersion: "subscription-s1-ephemeral/v1",
          runIdDigest: sha256Canonical(envelope.operationId),
          suiteIdDigest: sha256Canonical("database-lifecycle"),
          shard: index,
          createdAt
        });
        return {
          recordVersion: "provisioned-database.v1",
          targetFingerprint: fingerprint,
          databaseName: reservation.databaseName,
          databaseOid,
          marker,
          runId: envelope.operationId,
          suiteId: "database-lifecycle",
          shard: index,
          roles: reservation.roles,
          secretReferences: Object.fromEntries(
            Object.keys(reservation.roles).map((profile) => [
              profile,
              `r3/${envelope.operationId}/database-credentials/${reservation.databaseName}-${profile}.json`
            ])
          ),
          createdAt
        };
      });
      const observations = [];
      const roleBoundaries = [];
      for (const [index, record] of records.entries()) {
        const reservation = selection.databaseAssignment.reservations[index];
        observations.push({
          stage: "provision",
          record,
          identity: {
            rows: [{ oid: record.databaseOid, marker: record.marker, owner: record.roles.migrate }]
          },
          lock: {
            reservationLockDigest: reservation.targetLockDigest,
            lock: {
              lockDigest: sha256Canonical({
                kind: "r3-database-target",
                engineId: envelope.postgres.engineId,
                systemIdentifier: envelope.postgres.systemIdentifier,
                databaseOid: record.databaseOid,
                marker: record.marker
              })
            }
          }
        });
        const db = {
          ...record,
          migrationRole: record.roles.migrate,
          runtimeRole: record.roles["runtime-test"],
          databaseIdentityFingerprint: sha256Canonical({
            databaseName: record.databaseName,
            databaseOid: record.databaseOid,
            role: record.roles["runtime-test"],
            tls: true
          })
        };
        const observation = await readBoundary(db);
        observations.push({
          stage: "final-runtime-boundary",
          databaseName: record.databaseName,
          value: observation
        });
        observations.push({ stage: "grant-runtime-observed", databaseName: record.databaseName });
        roleBoundaries.push({
          database: index === 0 ? "target" : "sibling",
          ...observation.roleBoundary
        });
        observations.push({
          stage: "cleanup",
          databaseName: record.databaseName,
          recordDigest: sha256Canonical(record)
        });
      }
      observations.push({ stage: "owned-absence", value: { rows: [{ count: "0" }] } });
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
        summaries: [{ success: true }],
        testEvents: names.map((name) => ({
          type: "test:pass",
          data: {
            name,
            file: "/app/packages/release-foundation/test/database-lifecycle.postgres.test.mjs"
          }
        }))
      };
      const report = buildDatabaseSuiteReport({
        execution: selection,
        operationId: envelope.operationId,
        provisioned: { ...records[0], additionalDatabases: [{ ...records[1], name: "sibling" }] },
        result: {
          counts: databaseTestCounts(lifecycleTap),
          roleBoundaries,
          sanitizedLogDigest: sha256Canonical(
            summarizeDatabaseTestLog({ stdout: lifecycleTap, stderr: "" })
          )
        }
      });
      suiteReadbacks.push({
        suiteId: selection.suiteId,
        report,
        originals: {
          suiteId: selection.suiteId,
          databases: [],
          fixtures: [],
          context: null,
          secretReferences: [],
          process: null,
          invocation: null,
          logSummary: null,
          lifecycle: originals
        }
      });
      lifecycle = { records, observations, originals };
      continue;
    }
    const dbs = selection.databaseAssignment.databases;
    const entries = [
      { name: "target", item: selection.assignment },
      ...selection.additionalAssignments.map((item) => ({ name: item.name, item }))
    ];
    const databases = [],
      secretReferences = [],
      fixtures = [],
      boundaries = [],
      contexts = {};
    for (const { name, item } of entries) {
      const db = dbs[name];
      const reference = path.posix.join(
        ".release-local",
        "runs",
        envelope.runId,
        selection.suiteId,
        name,
        "runtime-test.json"
      );
      const observation = await readBoundary(db);
      databases.push({ name, databaseName: db.databaseName, observation });
      boundaries.push({ database: name, ...observation.roleBoundary });
      secretReferences.push({ name, databaseName: db.databaseName, reference });
      contexts[name] = {
        databaseName: db.databaseName,
        databaseOid: db.databaseOid,
        targetFingerprint: db.databaseIdentityFingerprint,
        runtimeSecretReference: reference,
        migrationCredentialFingerprint: db.migrationCredentialFingerprint,
        runtimeCredentialFingerprint: db.runtimeCredentialFingerprint
      };
      const migration = selection.fixtures
        ? await runSchemaFixture({
            repoRoot,
            runtimeRole: db.runtimeRole,
            fixturePath: selection.fixtures.schema,
            credentialRef: item.secretReferences.migrate,
            credentialFingerprint: db.migrationCredentialFingerprint,
            counterpartCredentialFingerprint: db.runtimeCredentialFingerprint,
            executeSql: async () => {}
          })
        : null;
      runtimePreparations[db.databaseName] = {
        migrationEvidenceDigest: db.migrationEvidenceDigest,
        schemaFixture: migration
      };
      if (selection.fixtures) {
        const runtime = await runRuntimeSeedFixture({
          repoRoot,
          fixturePath: selection.fixtures.seed,
          credentialRef: reference,
          credentialFingerprint: db.runtimeCredentialFingerprint,
          counterpartCredentialFingerprint: db.migrationCredentialFingerprint,
          executeSql: async () => {}
        });
        fixtures.push({
          database: name,
          migration,
          runtime,
          roleBoundary: { ...role, canCreateSchema: false, schemaOwner: false, objectOwner: false }
        });
      }
    }
    const context = {
      schemaVersion: "release-database-test-context.v1",
      operationRef: envelope.operationId,
      suiteId: selection.suiteId,
      profileDigest: envelope.profileDigest,
      allowedFiles: [...selection.files],
      containerId: envelope.runnerContainerId,
      ...contexts.target,
      ...(entries.length > 1 ? { namedDatabases: contexts } : {})
    };
    const contextRef = path.posix.join(
      ".release-local",
      "runs",
      envelope.runId,
      selection.suiteId,
      "context.json"
    );
    const cmd =
      selection.command.executable === "node"
        ? { executable: "node", arguments: [...selection.command.arguments] }
        : {
            executable: "node",
            arguments: [
              "apps/api/node_modules/vitest/vitest.mjs",
              ...selection.command.arguments.slice(
                selection.command.arguments.indexOf("vitest") + 1
              )
            ]
          };
    const invocation = {
      ...cmd,
      cwd: "/app",
      environment: {
        PATH: "/pnpm:/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        NODE_ENV: "test",
        S1_RELEASE_DATABASE_TEST: "1",
        S1_RELEASE_DATABASE_CONTEXT: contextRef
      }
    };
    const stdout = cmd.arguments[0].includes("vitest")
      ? JSON.stringify({
          numTotalTests: 1,
          numPassedTests: 1,
          numFailedTests: 0,
          numPendingTests: 0,
          numTodoTests: 0,
          testResults: []
        })
      : tap;
    const process = {
      code: 0,
      exitCode: 0,
      signal: null,
      processError: false,
      timedOut: false,
      truncated: false,
      stdout,
      stderr: ""
    };
    const logSummary = summarizeDatabaseTestLog(process);
    const provisioned = {
      ...selection.assignment,
      databaseOid: dbs.target.databaseOid,
      targetFingerprint: dbs.target.databaseIdentityFingerprint,
      additionalDatabases: selection.additionalAssignments.map((item) => ({
        ...item,
        databaseOid: dbs[item.name].databaseOid,
        targetFingerprint: dbs[item.name].databaseIdentityFingerprint
      }))
    };
    const report = buildDatabaseSuiteReport({
      execution: selection,
      operationId: envelope.operationId,
      provisioned,
      result: {
        counts: databaseTestCounts(stdout),
        roleBoundaries: boundaries,
        sanitizedLogDigest: sha256Canonical(logSummary),
        ...(selection.fixtures ? { fixtureObservations: fixtures } : {})
      }
    });
    suiteReadbacks.push({
      suiteId: selection.suiteId,
      report,
      originals: {
        suiteId: selection.suiteId,
        databases,
        fixtures,
        context,
        secretReferences,
        process,
        invocation,
        logSummary,
        lifecycle: null
      }
    });
  }
  const manifestReport = await runDatabaseManifest({
    selections,
    concurrency: 1,
    executeSuite: async (selection) =>
      suiteReadbacks.find((item) => item.suiteId === selection.suiteId).report
  });
  return {
    envelope,
    manifest,
    discoveryDigest,
    runtimePreparations,
    suiteReadbacks,
    lifecycle,
    repoRoot,
    manifestReport
  };
}

test("rebuilds fixed final suite and manifest reports from private originals", async () => {
  const f = await fixture();
  const result = await assessR3FinalSuiteReadbacks(f);
  assert.ok(same(result.manifestReport, f.manifestReport));
  assert.equal(result.suiteDigests.length, f.manifest.suites.length);
});

test("rejects altered context, invocation and physical lifecycle readback", async () => {
  for (const mutate of [
    (f) => {
      f.suiteReadbacks[0].originals.context.allowedFiles = [];
    },
    (f) => {
      f.suiteReadbacks[0].originals.invocation.environment.NODE_ENV = "production";
    },
    (f) => {
      f.lifecycle.observations.find((item) => item.stage === "owned-absence").value.rows[0].count =
        "1";
    }
  ]) {
    const f = await fixture();
    mutate(f);
    await assert.rejects(() => assessR3FinalSuiteReadbacks(f), {
      code: "R3_FINAL_SUITE_READBACK_INVALID"
    });
  }
});
