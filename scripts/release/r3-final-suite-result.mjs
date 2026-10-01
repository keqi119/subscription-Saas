// Independent reconstruction of final suite reports from retained image and
// H1 originals. The caller must authenticate their custody and physical origin.
import path from "node:path";

import {
  runRuntimeSeedFixture,
  runSchemaFixture,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import {
  buildDatabaseSuiteReport,
  runDatabaseManifest
} from "../../packages/release-foundation/src/database-test-launcher.mjs";
import { validateFinalDatabaseTestAssignments } from "../../apps/release-runner/src/database-test-envelope.mjs";
import { observeFinalRuntimeBoundary } from "../../apps/release-runner/src/final-database-runtime.mjs";
import { databaseTestCounts, summarizeDatabaseTestLog } from "./database-test-launcher-runtime.mjs";
import { assertR3FinalLifecycleOriginals } from "./r3-lifecycle-test-runner.mjs";

const CODE = "R3_FINAL_SUITE_READBACK_INVALID";
const MAX_OUTPUT = 524288;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (value) => {
  if (!value) fail();
};
const same = (left, right) => sha256Canonical(left) === sha256Canonical(right);
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  same(Object.keys(value).sort(), [...keys].sort());
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const secretPath = (envelope, suiteId, name) =>
  path.posix.join(".release-local", "runs", envelope.runId, suiteId, name, "runtime-test.json");
const contextPath = (envelope, suiteId) =>
  path.posix.join(".release-local", "runs", envelope.runId, suiteId, "context.json");

function fixedCommand(selection) {
  if (selection.command.executable === "node")
    return { executable: "node", arguments: [...selection.command.arguments] };
  const args = selection.command.arguments;
  const marker = args.indexOf("vitest");
  need(
    selection.command.executable === "pnpm" &&
      marker >= 0 &&
      same(args.slice(0, marker), ["--filter", "@subscription-saas/api", "exec"])
  );
  return {
    executable: "node",
    arguments: ["apps/api/node_modules/vitest/vitest.mjs", ...args.slice(marker + 1)]
  };
}
function contextDatabase(db, reference) {
  return {
    databaseName: db.databaseName,
    databaseOid: db.databaseOid,
    targetFingerprint: db.databaseIdentityFingerprint,
    runtimeSecretReference: reference,
    migrationCredentialFingerprint: db.migrationCredentialFingerprint,
    runtimeCredentialFingerprint: db.runtimeCredentialFingerprint
  };
}
function provisioned(selection) {
  const dbs = selection.databaseAssignment.databases;
  return {
    ...selection.assignment,
    databaseOid: dbs.target.databaseOid,
    targetFingerprint: dbs.target.databaseIdentityFingerprint,
    additionalDatabases: selection.additionalAssignments.map((item) => ({
      ...item,
      databaseOid: dbs[item.name].databaseOid,
      targetFingerprint: dbs[item.name].databaseIdentityFingerprint
    }))
  };
}
function processCounts(process, originals, selection) {
  need(
    exact(process, [
      "code",
      "exitCode",
      "signal",
      "processError",
      "timedOut",
      "truncated",
      "stdout",
      "stderr"
    ]) &&
      process.code === 0 &&
      process.exitCode === 0 &&
      process.signal === null &&
      process.processError === false &&
      process.timedOut === false &&
      process.truncated === false &&
      typeof process.stdout === "string" &&
      typeof process.stderr === "string" &&
      Buffer.byteLength(process.stdout) + Buffer.byteLength(process.stderr) <= MAX_OUTPUT
  );
  const counts = databaseTestCounts(process.stdout);
  need(
    counts.failed === 0 &&
      counts.skipped === 0 &&
      counts.todo === 0 &&
      counts.filtered === 0 &&
      counts.cancelled === 0
  );
  const summary = summarizeDatabaseTestLog(process);
  need(same(originals.logSummary, summary));
  const command = fixedCommand(selection);
  const invocation = {
    executable: command.executable,
    arguments: command.arguments,
    cwd: "/app",
    environment: {
      PATH: "/pnpm:/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp",
      NODE_ENV: "test",
      S1_RELEASE_DATABASE_TEST: "1",
      S1_RELEASE_DATABASE_CONTEXT: contextPath(selection.envelope, selection.suiteId)
    }
  };
  need(same(originals.invocation, invocation));
  return { counts, sanitizedLogDigest: sha256Canonical(summary) };
}

async function ordinary({ selection, envelope, readback, runtimePreparations, repoRoot }) {
  const originals = readback.originals;
  need(
    exact(originals, [
      "suiteId",
      "databases",
      "fixtures",
      "context",
      "secretReferences",
      "process",
      "invocation",
      "logSummary",
      "lifecycle"
    ]) &&
      originals.suiteId === selection.suiteId &&
      originals.lifecycle === null
  );
  const names = ["target", ...selection.additionalAssignments.map(({ name }) => name)];
  need(
    Array.isArray(originals.databases) &&
      originals.databases.length === names.length &&
      Array.isArray(originals.secretReferences) &&
      originals.secretReferences.length === names.length &&
      Array.isArray(originals.fixtures) &&
      originals.fixtures.length === (selection.fixtures ? names.length : 0)
  );
  const dbs = selection.databaseAssignment.databases;
  const contexts = {},
    boundaries = [],
    fixtures = [];
  for (const [index, name] of names.entries()) {
    const db = dbs[name],
      observation = originals.databases[index];
    const reference = secretPath(envelope, selection.suiteId, name);
    need(
      exact(observation, ["name", "databaseName", "observation"]) &&
        observation.name === name &&
        observation.databaseName === db.databaseName &&
        same(originals.secretReferences[index], { name, databaseName: db.databaseName, reference })
    );
    const replay = await observeFinalRuntimeBoundary(
      {
        $queryRawUnsafe: async () => [observation.observation?.identity]
      },
      db
    );
    need(same(replay, observation.observation));
    boundaries.push({ database: name, ...replay.roleBoundary });
    contexts[name] = contextDatabase(db, reference);
    const prepared = runtimePreparations[db.databaseName];
    need(
      exact(prepared, ["migrationEvidenceDigest", "schemaFixture"]) &&
        prepared.migrationEvidenceDigest === db.migrationEvidenceDigest
    );
    if (!selection.fixtures) {
      need(prepared.schemaFixture === null);
      continue;
    }
    const assignment =
      index === 0 ? selection.assignment : selection.additionalAssignments[index - 1];
    const migration = await runSchemaFixture({
      repoRoot,
      runtimeRole: db.runtimeRole,
      fixturePath: selection.fixtures.schema,
      credentialRef: assignment.secretReferences.migrate,
      credentialFingerprint: db.migrationCredentialFingerprint,
      counterpartCredentialFingerprint: db.runtimeCredentialFingerprint,
      executeSql: async () => {}
    });
    const runtime = await runRuntimeSeedFixture({
      repoRoot,
      fixturePath: selection.fixtures.seed,
      credentialRef: reference,
      credentialFingerprint: db.runtimeCredentialFingerprint,
      counterpartCredentialFingerprint: db.migrationCredentialFingerprint,
      executeSql: async () => {}
    });
    const fixture = {
      database: name,
      migration,
      runtime,
      roleBoundary: {
        ...replay.roleBoundary.roleAttributes,
        canCreateSchema: replay.roleBoundary.canCreateSchema,
        schemaOwner: replay.roleBoundary.schemaOwner,
        objectOwner: replay.roleBoundary.objectOwner
      }
    };
    need(same(prepared.schemaFixture, migration) && same(originals.fixtures[index], fixture));
    fixtures.push(fixture);
  }
  const expectedContext = {
    schemaVersion: "release-database-test-context.v1",
    operationRef: envelope.operationId,
    suiteId: selection.suiteId,
    profileDigest: envelope.profileDigest,
    allowedFiles: [...selection.files],
    containerId: envelope.runnerContainerId,
    ...contexts.target,
    ...(names.length > 1 ? { namedDatabases: contexts } : {})
  };
  need(same(originals.context, expectedContext));
  const counts = processCounts(originals.process, originals, { ...selection, envelope });
  const report = buildDatabaseSuiteReport({
    execution: selection,
    operationId: envelope.operationId,
    provisioned: provisioned(selection),
    result: {
      ...counts,
      roleBoundaries: boundaries,
      ...(selection.fixtures ? { fixtureObservations: fixtures } : {})
    }
  });
  need(report.terminalStatus === "PASSED" && same(report, readback.report));
  return report;
}

function lifecycleReport({ selection, envelope, readback, lifecycle }) {
  const { records, observations, originals } = lifecycle ?? {};
  need(
    Array.isArray(records) &&
      records.length === 2 &&
      Array.isArray(observations) &&
      exact(readback.originals, [
        "suiteId",
        "databases",
        "fixtures",
        "context",
        "secretReferences",
        "process",
        "invocation",
        "logSummary",
        "lifecycle"
      ]) &&
      readback.originals.suiteId === selection.suiteId &&
      readback.originals.databases.length === 0 &&
      readback.originals.fixtures.length === 0 &&
      readback.originals.context === null &&
      readback.originals.process === null &&
      readback.originals.invocation === null &&
      readback.originals.logSummary === null &&
      readback.originals.secretReferences.length === 0 &&
      same(readback.originals.lifecycle, originals)
  );
  assertR3FinalLifecycleOriginals(originals);
  const reservations = selection.databaseAssignment.reservations;
  const physical = observations.filter(({ stage }) => stage === "provision");
  const grants = observations.filter(({ stage }) => stage === "grant-runtime-observed");
  const boundaries = observations.filter(({ stage }) => stage === "final-runtime-boundary");
  const cleanup = observations.filter(({ stage }) => stage === "cleanup");
  const absent = observations.filter(({ stage }) => stage === "owned-absence");
  need(
    physical.length === 2 &&
      grants.length === 2 &&
      boundaries.length === 2 &&
      cleanup.length === 2 &&
      absent.length === 1 &&
      absent[0].value?.rows?.[0]?.count === "0"
  );
  const fingerprint = sha256Canonical({
    engineId: envelope.postgres.engineId,
    systemIdentifier: envelope.postgres.systemIdentifier,
    containerId: envelope.postgres.containerId,
    imageDigest: envelope.postgres.imageDigest
  });
  const roleBoundaries = [];
  for (const [index, reservation] of reservations.entries()) {
    const record = records[index],
      provision = physical[index];
    need(
      record.databaseName === reservation.databaseName &&
        same(record.roles, reservation.roles) &&
        record.shard === index &&
        record.runId === envelope.operationId &&
        record.suiteId === "database-lifecycle" &&
        record.targetFingerprint === fingerprint &&
        same(provision.record, record) &&
        provision.lock?.reservationLockDigest === reservation.targetLockDigest &&
        provision.lock?.lock?.lockDigest ===
          sha256Canonical({
            kind: "r3-database-target",
            engineId: envelope.postgres.engineId,
            systemIdentifier: envelope.postgres.systemIdentifier,
            databaseOid: record.databaseOid,
            marker: record.marker
          }) &&
        provision.identity?.rows?.length === 1 &&
        provision.identity.rows[0].oid === record.databaseOid &&
        provision.identity.rows[0].marker === record.marker &&
        provision.identity.rows[0].owner === record.roles.migrate &&
        grants[index].databaseName === record.databaseName &&
        cleanup[index].databaseName === record.databaseName &&
        cleanup[index].recordDigest === sha256Canonical(record) &&
        boundaries[index].databaseName === record.databaseName
    );
    const position = (entry) => observations.indexOf(entry);
    need(
      position(provision) < position(boundaries[index]) &&
        position(boundaries[index]) < position(grants[index]) &&
        position(grants[index]) < position(cleanup[index]) &&
        position(cleanup[index]) < position(absent[0])
    );
    const db = {
      databaseName: record.databaseName,
      databaseOid: record.databaseOid,
      marker: record.marker,
      migrationRole: record.roles.migrate,
      runtimeRole: record.roles["runtime-test"],
      databaseIdentityFingerprint: sha256Canonical({
        databaseName: record.databaseName,
        databaseOid: record.databaseOid,
        role: record.roles["runtime-test"],
        tls: true
      })
    };
    const observation = boundaries[index].value;
    // The H1 callback's saved identity row is replayed through the same strict
    // physical role and ownership assessor used by the image.
    roleBoundaries.push({ database: index === 0 ? "target" : "sibling", observation, target: db });
  }
  return { roleBoundaries, records, originals };
}

export async function assessR3FinalSuiteReadbacks({
  envelope,
  manifest,
  discoveryDigest,
  runtimePreparations,
  suiteReadbacks,
  lifecycle,
  repoRoot
}) {
  try {
    need(path.isAbsolute(repoRoot) && Array.isArray(suiteReadbacks));
    const { selections: bound } = validateFinalDatabaseTestAssignments({
      envelope,
      manifest,
      discoveryDigest
    });
    const selections = bound.map((selection) => ({ ...selection, runId: envelope.runId }));
    need(suiteReadbacks.length === selections.length);
    const names = selections
      .filter((selection) => selection.r3ExecutionMode !== "lifecycle-owned")
      .flatMap((selection) =>
        Object.values(selection.databaseAssignment.databases).map(
          (database) => database.databaseName
        )
      );
    need(new Set(names).size === names.length && exact(runtimePreparations, names));
    const reports = [];
    for (const [index, selection] of selections.entries()) {
      const readback = suiteReadbacks[index];
      need(
        exact(readback, ["suiteId", "report", "originals"]) &&
          readback.suiteId === selection.suiteId
      );
      let report;
      if (selection.r3ExecutionMode === "lifecycle-owned") {
        const held = lifecycleReport({ selection, envelope, readback, lifecycle });
        const roleBoundaries = [];
        for (const value of held.roleBoundaries) {
          const replay = await observeFinalRuntimeBoundary(
            {
              $queryRawUnsafe: async () => [value.observation?.identity]
            },
            value.target
          );
          need(same(replay, value.observation));
          roleBoundaries.push({ database: value.database, ...replay.roleBoundary });
        }
        const counts = databaseTestCounts(held.originals.tap);
        need(
          counts.collected === held.originals.counts.tests &&
            counts.passed === held.originals.counts.passed
        );
        const summary = summarizeDatabaseTestLog({ stdout: held.originals.tap, stderr: "" });
        report = buildDatabaseSuiteReport({
          execution: selection,
          operationId: envelope.operationId,
          provisioned: {
            ...held.records[0],
            additionalDatabases: [{ ...held.records[1], name: "sibling" }]
          },
          result: { counts, roleBoundaries, sanitizedLogDigest: sha256Canonical(summary) }
        });
        need(report.terminalStatus === "PASSED" && same(report, readback.report));
      } else {
        report = await ordinary({ selection, envelope, readback, runtimePreparations, repoRoot });
      }
      reports.push(report);
    }
    const manifestReport = await runDatabaseManifest({
      selections,
      concurrency: 1,
      executeSuite: async (selection) =>
        reports[selections.findIndex(({ suiteId }) => suiteId === selection.suiteId)]
    });
    need(manifestReport.terminalStatus === "PASSED");
    return freeze({
      manifestReport,
      suiteDigests: suiteReadbacks.map(({ suiteId }, index) => ({
        suiteId,
        digest: sha256Canonical(suiteReadbacks[index])
      }))
    });
  } catch {
    fail();
  }
}
