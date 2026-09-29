import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Canonical, sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import {
  encodeManualJson,
  encodePrivateObservationJson
} from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { suiteDatabaseName } from "../../packages/release-foundation/src/database-target.mjs";
import {
  buildDatabaseSuiteReport,
  runDatabaseManifest,
  selectManifestSuites
} from "../../packages/release-foundation/src/database-test-launcher.mjs";
import { databaseTestCounts, summarizeDatabaseTestLog } from "./database-test-launcher-runtime.mjs";
import { planManualR3TargetLocks } from "../../packages/release-foundation/src/manual-r3-target-locks.mjs";
import { assessR3PostgresReadback, buildR3Destination } from "./r3-destination.mjs";
import {
  bindR3SourceManifest,
  planR3DatabaseTargets,
  provisionR3DatabaseTargets,
  recheckR3DatabaseTargets
} from "./r3-database-targets.mjs";
import { executeR3SourceSuite, runR3SourceProcess } from "./r3-source-suite.mjs";

const repo = new URL("../../release/contracts/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("database-test-manifest.v1.json", repo)));
const policy = JSON.parse(
  readFileSync(new URL("database-target-policies.v1.json", repo))
).policies.find((item) => item.policyId === "s1-release-compose-ephemeral");
const operationRef = "10000000-0000-4000-8000-000000000001";
const createdAt = "2026-09-28T00:00:00.000Z";
const input = (phase = "source", chain = "fresh") => ({ operationRef, phase, chain, manifest });
const invalid = { code: "R3_DATABASE_TARGETS_UNAVAILABLE" };

test(
  "R3 source process captures output and drains aborted groups",
  { skip: process.platform !== "linux" },
  async () => {
    const run = (script, signal = new AbortController().signal) =>
      runR3SourceProcess({
        executable: "node",
        args: ["--input-type=module", "-e", script],
        timeoutMs: 5000,
        repoRoot: process.cwd(),
        environment: {},
        signal,
        recheck: async () => {}
      });
    const normal = await run(
      'process.stdout.write("original stdout"); process.stderr.write("original stderr");'
    );
    assert.equal(normal.code, 0);
    assert.equal(normal.signal, null);
    assert.equal(normal.processError, false);
    assert.equal(normal.stdout, "original stdout");
    assert.equal(normal.stderr, "original stderr");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 1000);
    let cancelled;
    try {
      cancelled = await run(
        'import { spawn } from "node:child_process"; const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio:"inherit"}); console.log(JSON.stringify([process.pid, child.pid])); setInterval(()=>{},1000);',
        abort.signal
      );
    } finally {
      clearTimeout(timer);
    }
    assert.notEqual(cancelled.signal, null);
    assert.equal(cancelled.processError, true);
    const pids = JSON.parse(cancelled.stdout.trim());
    assert.equal(pids.length, 2);
    for (const pid of pids) {
      assert.ok(Number.isSafeInteger(pid) && pid > 1);
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        assert.equal(
          stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0],
          "Z",
          "owned process must be terminated"
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const excessive = await run('process.stdout.write("x".repeat(700000));');
    assert.equal(excessive.truncated, true);
    assert.equal(Buffer.byteLength(excessive.stdout), 524288);
  }
);

function fakeAdmin({ failAfterCreate = Infinity, grantedTo = 0 } = {}) {
  const databases = new Map(),
    roles = new Map(),
    calls = [],
    restoreGrants = [],
    absentPasswords = new Set();
  let creates = 0;
  const executeAdmin = async ({ databaseName, sql }) => {
    calls.push({ databaseName, sql });
    if (/^CREATE ROLE /u.test(sql)) {
      const name = sql.match(/^CREATE ROLE "([^"]+)"/u)?.[1];
      assert.ok(name);
      roles.set(name, {
        oid: String(2000 + roles.size),
        name,
        canLogin: true,
        superuser: false,
        createdb: false,
        createrole: false,
        inherit: false,
        replication: false,
        bypassrls: false,
        memberships: 0,
        grantedTo,
        canConnect: true,
        canCreateDatabase: false,
        canCreateTemporary: false
      });
    } else if (/^CREATE DATABASE /u.test(sql)) {
      creates++;
      if (creates > failAfterCreate) throw new Error("synthetic creation failure");
      const [, name, owner] = sql.match(/^CREATE DATABASE "([^"]+)" OWNER "([^"]+)"$/u) ?? [];
      assert.ok(name && owner);
      databases.set(name, {
        databaseOid: String(3000 + creates),
        marker: "",
        owner,
        schemaOwner: owner
      });
    } else if (/^COMMENT ON DATABASE /u.test(sql)) {
      const [, name, marker] = sql.match(/^COMMENT ON DATABASE "([^"]+)" IS '(.+)'$/u) ?? [];
      databases.get(name).marker = marker.replaceAll("''", "'");
    } else if (/^SELECT d\.oid::text AS "databaseOid"/u.test(sql)) {
      const name = sql.match(/WHERE d\.datname='([^']+)'$/u)?.[1];
      const db = databases.get(name);
      return {
        rows: db ? [{ databaseOid: db.databaseOid, marker: db.marker, owner: db.owner }] : []
      };
    } else if (/^SELECT r\.oid::text AS "oid"/u.test(sql)) {
      const name = sql.match(/WHERE r\.rolname='([^']+)'$/u)?.[1];
      if (!roles.has(name)) return { rows: [] };
      const { grantedTo: grantees, ...row } = roles.get(name);
      if (sql.includes("m.roleid=r.oid")) row.grantedTo = grantees;
      return { rows: [row] };
    } else if (/^SELECT pg_get_userbyid\(n\.nspowner\)/u.test(sql)) {
      const db = databases.get(databaseName);
      return { rows: db ? [{ schemaOwner: db.schemaOwner, canCreate: false, canUse: true }] : [] };
    } else if (sql.startsWith('SELECT pg_get_userbyid(m.roleid) AS "roleName"')) {
      return { rows: restoreGrants.map((row) => ({ ...row })) };
    } else if (sql.startsWith('SELECT (r.rolpassword IS NULL) AS "passwordAbsent"')) {
      const name = sql.match(/WHERE r\.rolname='([^']+)'$/u)?.[1];
      return { rows: [{ passwordAbsent: absentPasswords.has(name) }] };
    }
    return { rows: [] };
  };
  return { executeAdmin, databases, roles, calls, restoreGrants, absentPasswords };
}
const createSecret = async ({ databaseName, profile, username }) => ({
  username,
  password: "synthetic-password-do-not-log",
  reference: `private/${databaseName}/${profile}`
});

test("R3 database plan covers every manifest suite with only lifecycle reserved", () => {
  const source = planR3DatabaseTargets(input());
  const final = planR3DatabaseTargets(input("final", "snapshot"));
  assert.equal(source.manifestDigest, sha256Canonical(manifest));
  assert.equal(source.targets.length, 37);
  assert.equal(source.reservations.length, 2);
  assert.equal(final.targets.length, 38);
  assert.equal(final.targets.at(-1).suiteId, "r3.application");
  assert.deepEqual(Object.keys(final.targets.at(-1).roles), [
    "migrate",
    "runtime-test",
    "restore",
    "api-runtime",
    "verify"
  ]);
  assert.equal(source.targets.filter((item) => item.name === "source").length, 1);
  assert.equal(
    source.targets.filter((item) => item.suiteId === "node.release-database-lifecycle.postgres")
      .length,
    0
  );
  for (const [shard, reservation] of source.reservations.entries()) {
    assert.equal(
      reservation.databaseName,
      suiteDatabaseName(operationRef, "database-lifecycle", shard)
    );
    assert.equal(Object.hasOwn(reservation, "databaseOid"), false);
    assert.equal(Object.hasOwn(reservation, "marker"), false);
  }
  assert.ok(Object.isFrozen(source) && Object.isFrozen(source.targets[0].roles));
  const duplicate = structuredClone(manifest);
  duplicate.suites[1].files = [...duplicate.suites[0].files];
  assert.throws(() => planR3DatabaseTargets({ ...input(), manifest: duplicate }), invalid);
  const extraTopology = structuredClone(manifest);
  extraTopology.suites[0].databaseTopology = "source-target";
  assert.throws(() => planR3DatabaseTargets({ ...input(), manifest: extraTopology }), invalid);
});

test("R3 source manifest binds every original command to exact held databases in both chains", () => {
  assert.equal(typeof bindR3SourceManifest, "function");
  const discoveryDigest = `sha256:${"d".repeat(64)}`;
  for (const chain of ["fresh", "snapshot"]) {
    const plan = planR3DatabaseTargets(input("source", chain));
    const selections = bindR3SourceManifest({
      operationRef,
      chain,
      manifest,
      plan,
      discoveryDigest,
      discoveryUnclassifiedCount: 0
    });
    const original = selectManifestSuites({
      manifest,
      discoveryDigest,
      discoveryUnclassifiedCount: 0,
      chain,
      runId: operationRef,
      secretRootRef: `.release-local/runs/${operationRef}`
    });
    assert.equal(selections.length, manifest.suites.length);
    assert.deepEqual(
      selections.map(({ suiteId }) => suiteId),
      manifest.suites.map(({ suiteId }) => suiteId)
    );
    const used = new Set();
    for (const [index, selection] of selections.entries()) {
      assert.deepEqual(selection.command, original[index].command);
      assert.deepEqual(selection.files, original[index].files);
      assert.equal(selection.runId, operationRef);
      assert.equal(selection.manifestDigest, plan.manifestDigest);
      assert.equal(selection.discoveryDigest, discoveryDigest);
      const expected =
        selection.suiteId === "node.release-database-lifecycle.postgres"
          ? plan.reservations
          : plan.targets.filter(({ suiteId }) => suiteId === selection.suiteId);
      assert.equal(
        expected.length,
        selection.suiteId === "script.stage1-clean-acceptance.postgres" ||
          selection.suiteId === "node.release-database-lifecycle.postgres"
          ? 2
          : 1
      );
      assert.equal(selection.assignment.databaseName, expected[0].databaseName);
      assert.equal(selection.assignment.shard, expected[0].shard);
      assert.equal(selection.additionalAssignments.length, expected.length - 1);
      assert.equal(
        selection.r3ExecutionMode,
        selection.suiteId === "node.release-database-lifecycle.postgres"
          ? "lifecycle-owned"
          : "suite"
      );
      for (const [resourceIndex, item] of expected.entries()) {
        const assignment =
          resourceIndex === 0 ? selection.assignment : selection.additionalAssignments[0];
        assert.equal(assignment.databaseName, item.databaseName);
        assert.equal(assignment.shard, item.shard);
        assert.deepEqual(
          assignment.secretReferences,
          Object.fromEntries(
            Object.keys(item.roles).map((profile) => [
              profile,
              `r3/${operationRef}/database-credentials/${item.databaseName}-${profile}.json`
            ])
          )
        );
        assert.equal(used.has(item.databaseName), false);
        used.add(item.databaseName);
      }
    }
    assert.equal(used.size, plan.targets.length + plan.reservations.length);
    const clean = selections.find(
      ({ suiteId }) => suiteId === "script.stage1-clean-acceptance.postgres"
    );
    assert.equal(clean.additionalAssignments[0].name, "source");
    const lifecycle = selections.find(
      ({ r3ExecutionMode }) => r3ExecutionMode === "lifecycle-owned"
    );
    assert.equal(lifecycle.assignment.name, "primary");
    assert.equal(lifecycle.additionalAssignments[0].name, "sibling");
    assert.equal(Object.isFrozen(selections) && Object.isFrozen(lifecycle.assignment), true);
  }
});

test("R3 source manifest refuses a partial or changed plan and caller selections", () => {
  const plan = planR3DatabaseTargets(input());
  const request = {
    operationRef,
    chain: "fresh",
    manifest,
    plan,
    discoveryDigest: `sha256:${"d".repeat(64)}`,
    discoveryUnclassifiedCount: 0
  };
  for (const override of [
    { suiteIds: [manifest.suites[0].suiteId] },
    { files: [manifest.suites[0].files[0]] },
    { command: { executable: "node", arguments: [] } },
    { batchId: "batch-a" },
    { operationRef: "20000000-0000-4000-8000-000000000001" },
    { chain: "snapshot" },
    { plan: planR3DatabaseTargets(input("final")) },
    { plan: Object.freeze({ ...plan, targets: plan.targets.slice(1) }) },
    {
      plan: Object.freeze({
        ...plan,
        targets: [
          Object.freeze({ ...plan.targets[0], databaseName: "s1ci_000000000000000000000000" }),
          ...plan.targets.slice(1)
        ]
      })
    },
    { manifest: { ...manifest, suites: manifest.suites.slice(1) } },
    { discoveryUnclassifiedCount: 1 }
  ])
    assert.throws(() => bindR3SourceManifest({ ...request, ...override }), invalid);
});

function sourceSuiteFixture(suiteId) {
  const plan = planR3DatabaseTargets(input());
  const execution = bindR3SourceManifest({
    operationRef,
    chain: "fresh",
    manifest,
    plan,
    discoveryDigest: `sha256:${"d".repeat(64)}`,
    discoveryUnclassifiedCount: 0
  }).find((selection) => selection.suiteId === suiteId);
  const assignments = [execution.assignment, ...execution.additionalAssignments];
  const records = assignments.map((assignment, index) => ({
    ...plan.targets.find((target) => target.databaseName === assignment.databaseName),
    databaseOid: String(3001 + index),
    targetFingerprint: `sha256:${"a".repeat(64)}`,
    secretReferences: assignment.secretReferences
  }));
  const events = [];
  const fixture = {
    execution,
    records,
    clusterFingerprint: `sha256:${"a".repeat(64)}`,
    containerId: "b".repeat(64),
    profileDigest: `sha256:${"c".repeat(64)}`,
    repoRoot: fileURLToPath(new URL("../../", import.meta.url)),
    async readSecret(record, profile) {
      events.push(`${record.databaseName}:secret:${profile}`);
      return {
        username: record.roles[profile],
        password: `${profile}-${record.databaseName}-private-password`,
        database: record.databaseName,
        host: "127.0.0.1",
        port: 55441,
        tlsMode: "require"
      };
    },
    async executeCredential(record, profile, sql) {
      events.push(
        `${record.databaseName}:${profile}:${sql.startsWith("SELECT r.rolsuper") ? "boundary" : sql.startsWith("ALTER SCHEMA") ? "grant" : "fixture"}`
      );
      if (sql.startsWith("SELECT r.rolsuper")) {
        return {
          rows: [
            {
              role: record.roles["runtime-test"],
              superuser: false,
              createdb: false,
              createrole: false,
              bypassrls: false,
              canCreateSchema: false,
              schemaOwner: false,
              objectOwner: false
            }
          ]
        };
      }
      return { rows: [] };
    },
    async runPrisma(record, args) {
      events.push(`${record.databaseName}:prisma:${args.join(" ")}`);
      return { code: 0, signal: null, truncated: false, stdout: "schema-readback", stderr: "" };
    },
    async writeContext(selection, context) {
      events.push("context");
      assert.equal(selection, execution);
      assert.deepEqual(context.allowedFiles, execution.files);
      assert.equal(context.databaseName, records[0].databaseName);
      assert.equal(context.runtimeSecretReference, records[0].secretReferences["runtime-test"]);
      if (records.length === 2) {
        assert.equal(context.namedDatabases.target.databaseName, records[0].databaseName);
        assert.equal(context.namedDatabases.source.databaseName, records[1].databaseName);
        assert.equal(
          context.namedDatabases.source.runtimeSecretReference,
          records[1].secretReferences["runtime-test"]
        );
      } else {
        assert.equal(context.namedDatabases, undefined);
      }
      return `r3/${operationRef}/database-test-contexts/${suiteId}/context.json`;
    },
    async runTest(selection, reference) {
      events.push("test");
      assert.equal(selection, execution);
      assert.equal(reference, `r3/${operationRef}/database-test-contexts/${suiteId}/context.json`);
      return {
        code: 0,
        signal: null,
        truncated: false,
        stdout:
          "TAP version 13\n# private-stdout-marker\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n",
        stderr: ""
      };
    },
    async recheck() {
      events.push("recheck");
    }
  };
  return { fixture, events };
}

async function sourceResultFixture() {
  const plan = planR3DatabaseTargets(input());
  const discoveryDigest = `sha256:${"d".repeat(64)}`;
  const selections = bindR3SourceManifest({
    operationRef,
    chain: "fresh",
    manifest,
    plan,
    discoveryDigest,
    discoveryUnclassifiedCount: 0
  });
  const binding = {
    operationRef,
    chain: "fresh",
    profileDigest: `sha256:${"c".repeat(64)}`,
    sessionId: "20000000-0000-4000-8000-000000000001",
    sessionNonce: "e".repeat(64),
    sourceSha: "f".repeat(40),
    destinationDigest: `sha256:${"1".repeat(64)}`,
    clusterFingerprint: `sha256:${"a".repeat(64)}`,
    containerId: "b".repeat(64),
    creationExecutionRecordDigest: `sha256:${"2".repeat(64)}`,
    candidateUseExecutionRecordDigest: `sha256:${"3".repeat(64)}`,
    snapshotExecutionRecordDigest: null
  };
  const attempt = {
    status: "SOURCE_MANIFEST_INTERRUPTED_UNKNOWN",
    operationRef,
    sessionId: binding.sessionId,
    sessionNonce: binding.sessionNonce,
    sourceSha: binding.sourceSha,
    destinationDigest: binding.destinationDigest,
    manifestDigest: sha256Canonical(manifest),
    candidateUseExecutionRecordDigest: binding.candidateUseExecutionRecordDigest,
    promotionEligible: false
  };
  const records = [],
    suiteReadbacks = [];
  let lifecycleRecords;
  for (const execution of selections) {
    let result;
    if (execution.r3ExecutionMode === "suite") {
      const { fixture } = sourceSuiteFixture(execution.suiteId);
      for (const record of fixture.records)
        record.databaseOid = String(
          4000 + plan.targets.findIndex((item) => item.databaseName === record.databaseName)
        );
      const count =
        execution.expectedCountPolicy.mode === "exact"
          ? execution.expectedCountPolicy.collected
          : 1;
      fixture.runTest = async () => ({
        code: 0,
        signal: null,
        truncated: false,
        stdout: `TAP version 13\n# tests ${count}\n# pass ${count}\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n`,
        stderr: ""
      });
      result = await executeR3SourceSuite(fixture);
      records.push(...fixture.records);
    } else {
      lifecycleRecords = plan.reservations.map((item, index) => ({
        ...item,
        databaseOid: String(5000 + index),
        targetFingerprint: binding.clusterFingerprint,
        secretReferences: [execution.assignment, ...execution.additionalAssignments][index]
          .secretReferences
      }));
      const normal = {
        code: 0,
        signal: null,
        truncated: false,
        stdout: "schema-readback",
        stderr: ""
      };
      const commands = [
        ["migrate", "deploy", "--schema", "prisma/schema.prisma"],
        ["migrate", "status", "--schema", "prisma/schema.prisma"],
        [
          "migrate",
          "diff",
          "--from-config-datasource",
          "--to-schema",
          "prisma/schema.prisma",
          "--exit-code"
        ],
        ["migrate", "diff", "--from-empty", "--to-config-datasource", "--script"]
      ];
      const falseRow = {
        superuser: false,
        createdb: false,
        createrole: false,
        bypassrls: false,
        canCreateSchema: false,
        schemaOwner: false,
        objectOwner: false
      };
      const observations = lifecycleRecords.flatMap((record, index) => [
        { stage: "provision", record },
        ...commands.map((args) => ({
          stage: "source-migration-process",
          databaseName: record.databaseName,
          arguments: args,
          result: normal
        })),
        {
          stage: "source-migration",
          databaseName: record.databaseName,
          value: {
            name: index === 0 ? "target" : "sibling",
            migrationStatusDigest: sha256Canonical(normal),
            schemaDiffDigest: sha256Canonical(normal),
            postSchemaDigest: sha256Bytes(Buffer.from(normal.stdout))
          }
        },
        {
          stage: "source-runtime-boundary",
          databaseName: record.databaseName,
          value: { rows: [falseRow] }
        }
      ]);
      for (const [index, record] of lifecycleRecords.entries()) {
        observations.push(
          {
            stage: "cleanup",
            databaseName: record.databaseName,
            recordDigest: sha256Canonical(record)
          },
          {
            stage: "database-absence",
            databaseName: record.databaseName,
            value: { rows: [{ count: "0" }] }
          }
        );
        if (index === 0)
          observations.push({
            stage: "sibling-connection",
            databaseName: lifecycleRecords[1].databaseName,
            value: { rows: [{ databaseName: lifecycleRecords[1].databaseName }] }
          });
      }
      observations.push({ stage: "owned-absence", value: { rows: [{ count: "0" }] } });
      const tap =
        "TAP version 13\n# tests 2\n# pass 2\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n";
      const counts = {
        tests: 2,
        passed: 2,
        failed: 0,
        skipped: 0,
        cancelled: 0,
        todo: 0,
        topLevel: 2,
        suites: 0
      };
      const lifecycle = {
        status: "LIFECYCLE_OBSERVED",
        operationRef,
        sessionId: binding.sessionId,
        sessionNonce: binding.sessionNonce,
        destinationDigest: binding.destinationDigest,
        creationExecutionRecordDigest: binding.creationExecutionRecordDigest,
        candidateUseExecutionRecordDigest: binding.candidateUseExecutionRecordDigest,
        snapshotExecutionRecordDigest: null,
        promotionEligible: false,
        observations,
        originals: {
          tap,
          counts,
          summaries: [{ success: true, counts }],
          testEvents: [
            "provisions, migrates, isolates, and exactly cleans concurrent PostgreSQL databases",
            "uses the platform package-manager entrypoint for lifecycle migrations"
          ].map((name) => ({
            type: "test:pass",
            data: {
              name,
              file: fileURLToPath(
                new URL(
                  "../../packages/release-foundation/test/database-lifecycle.postgres.test.mjs",
                  import.meta.url
                )
              )
            }
          }))
        }
      };
      const logSummary = summarizeDatabaseTestLog({ stdout: tap, stderr: "" });
      const report = buildDatabaseSuiteReport({
        execution,
        operationId: operationRef,
        provisioned: {
          ...lifecycleRecords[0],
          additionalDatabases: [{ ...lifecycleRecords[1], name: "sibling" }]
        },
        result: {
          counts: databaseTestCounts(tap),
          sanitizedLogDigest: sha256Canonical(logSummary),
          roleBoundaries: ["target", "sibling"].map((database) => ({
            database,
            roleAttributes: {
              superuser: false,
              createdb: false,
              createrole: false,
              bypassrls: false
            },
            canCreateSchema: false,
            schemaOwner: false,
            objectOwner: false
          }))
        }
      });
      result = {
        originals: lifecycle,
        logSummary,
        report,
        migrationObservations: observations
          .filter((item) => item.stage === "source-migration")
          .map((item) => item.value)
      };
    }
    suiteReadbacks.push({
      status: "SOURCE_SUITE_OBSERVED",
      attemptDigest: sha256Canonical(attempt),
      operationRef,
      sessionId: binding.sessionId,
      destinationDigest: binding.destinationDigest,
      ...result,
      promotionEligible: false
    });
  }
  const manifestReport = await runDatabaseManifest({
    selections,
    executeSuite: async (execution) =>
      suiteReadbacks.find((item) => item.report.suiteId === execution.suiteId).report
  });
  return {
    manifest,
    plan,
    discoveryDigest,
    binding,
    records,
    lifecycleRecords,
    attempt,
    suiteReadbacks,
    manifestReport
  };
}

test("R3 source result reconstructs every suite from originals and rejects omissions or substitutions", async () => {
  const { buildR3SourceResult } = await import("./r3-source-result.mjs");
  const fixture = await sourceResultFixture();
  const result = await buildR3SourceResult(fixture);
  assert.deepEqual(result.manifestReport, fixture.manifestReport);
  assert.equal(result.suiteReadbacks.length, manifest.suites.length);
  assert.equal(result.postSchemaDigest, sha256Bytes(Buffer.from("schema-readback")));
  for (const change of [
    (value) => {
      value.suiteReadbacks.pop();
    },
    (value) => {
      value.suiteReadbacks[1] = value.suiteReadbacks[0];
    },
    (value) => {
      value.suiteReadbacks[0].report.target.databaseOid = "9000";
    },
    (value) => {
      value.suiteReadbacks[0].originals.processes[1].result.code = 2;
    },
    (value) => {
      value.suiteReadbacks[0].originals.test.stdout =
        "# tests 0\n# pass 0\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n";
    },
    (value) => {
      value.suiteReadbacks[0].originals.context.profileDigest = `sha256:${"0".repeat(64)}`;
    },
    (value) => {
      value.attempt.sessionNonce = "0".repeat(64);
    },
    (value) => {
      value.binding.candidateUseExecutionRecordDigest = `sha256:${"9".repeat(64)}`;
    },
    (value) => {
      value.suiteReadbacks.find(
        (item) => item.originals.status === "LIFECYCLE_OBSERVED"
      ).originals.observations = value.suiteReadbacks
        .find((item) => item.originals.status === "LIFECYCLE_OBSERVED")
        .originals.observations.filter((item) => item.stage !== "owned-absence");
    },
    (value) => {
      value.manifestReport.counts.passed++;
    },
    (value) => {
      const originals = value.suiteReadbacks.find(
        (item) => item.originals.status === "LIFECYCLE_OBSERVED"
      ).originals.originals;
      originals.summaries[0].counts = { ...originals.counts, tests: 0 };
    },
    (value) => {
      const suite = value.suiteReadbacks[0];
      suite.originals.processes[3].result.stdout = "different schema";
      suite.migrationObservations[0].postSchemaDigest = sha256Bytes(
        Buffer.from("different schema")
      );
    }
  ]) {
    const value = structuredClone(fixture);
    value.plan = fixture.plan;
    change(value);
    await assert.rejects(buildR3SourceResult(value), { code: "R3_SOURCE_RESULT_INVALID" });
  }
});

test("R3 source originals require matching fixed dual readbacks and reject later drift", async () => {
  const { buildR3SourceResult, buildR3SourceCompletion, readR3SourceOriginals } =
    await import("./r3-source-result.mjs");
  assert.equal(typeof readR3SourceOriginals, "function");
  const fixture = await sourceResultFixture();
  const clean = fixture.suiteReadbacks.find(
    ({ report }) => report.suiteId === "script.stage1-clean-acceptance.postgres"
  );
  for (const index of [0, 4]) clean.originals.processes[index].result.stdout = "x".repeat(524000);
  assert.ok(encodePrivateObservationJson(clean).length > 1048576);
  const reconstructed = await buildR3SourceResult(fixture);
  const discovery = {
    candidates: [],
    classification: { unclassified: [] },
    discoveryDigest: fixture.discoveryDigest
  };
  const observed = {
    status: "SOURCE_MANIFEST_OBSERVED",
    attemptDigest: sha256Canonical(fixture.attempt),
    operationRef,
    sessionId: fixture.binding.sessionId,
    sessionNonce: fixture.binding.sessionNonce,
    sourceSha: fixture.binding.sourceSha,
    destinationDigest: fixture.binding.destinationDigest,
    manifestReport: fixture.manifestReport,
    reconstructed,
    observations: fixture.suiteReadbacks.map((value) => ({
      suiteId: value.report.suiteId,
      readbackDigest: sha256Canonical(value),
      migrationObservations: value.migrationObservations
    })),
    generation: {
      code: 0,
      signal: null,
      processError: false,
      timedOut: false,
      truncated: false,
      stdout: "generated",
      stderr: ""
    },
    discovery,
    promotionEligible: false
  };
  const originals = new Map([
    ["attempt", fixture.attempt],
    ...fixture.suiteReadbacks.map((value) => [value.report.suiteId, value]),
    ["manifest", observed]
  ]);
  const initial = () =>
    new Map(
      ["archive", "backup"].flatMap((storageRole) =>
        [...originals].map(([name, value]) => [
          `${storageRole}:${name}`,
          encodePrivateObservationJson(value)
        ])
      )
    );
  const read = (copies, recheck = async () => {}) =>
    readR3SourceOriginals({
      manifest: fixture.manifest,
      plan: fixture.plan,
      binding: fixture.binding,
      records: fixture.records,
      lifecycleRecords: fixture.lifecycleRecords,
      discovery,
      readObservation: async ({ storageRole, name }) => copies.get(`${storageRole}:${name}`),
      recheck
    });
  const copies = initial();
  const result = await read(copies);
  assert.equal(result.readbackDigest, sha256Canonical(observed));
  assert.equal(result.reconstructedDigest, sha256Canonical(reconstructed));
  assert.deepEqual(result.suiteReadbacks, reconstructed.suiteReadbacks);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.suiteReadbacks));
  assert.deepEqual(
    result.originals,
    [...originals].map(([name]) => {
      const bytes = copies.get(`archive:${name}`);
      return { name, digest: sha256Bytes(bytes), bytes: bytes.length };
    })
  );
  assert.ok(Object.isFrozen(result.originals) && result.originals.every(Object.isFrozen));
  const request = {
    schemaVersion: "manual-runner-request.v5",
    profileDigest: fixture.binding.profileDigest,
    ownerId: "owner",
    sessionId: fixture.binding.sessionId,
    sessionNonce: fixture.binding.sessionNonce,
    operationId: operationRef,
    idempotencyKey: `r3-candidate-use:${operationRef}`,
    attemptId: "30000000-0000-4000-8000-000000000001",
    runId: "40000000-0000-4000-8000-000000000001",
    stage: "candidate-use",
    capability: "execute-source-database-tests",
    purpose: "stage1-isolated-database-tests",
    phase: "source",
    chain: "fresh",
    sourceSha: fixture.binding.sourceSha,
    targetPolicyDigest: `sha256:${"4".repeat(64)}`,
    creationSpecDigest: `sha256:${"5".repeat(64)}`,
    jobAdmissionDigest: `sha256:${"6".repeat(64)}`,
    candidate: { buildProofDigest: `sha256:${"7".repeat(64)}` },
    destinationAdmissionDigest: fixture.binding.destinationDigest,
    preparationExecutionRecordDigest: `sha256:${"8".repeat(64)}`,
    databaseTestManifestDigest: sha256Canonical(manifest),
    attemptAllocationDigest: `sha256:${"9".repeat(64)}`
  };
  const initialExecution = {
    schemaVersion: "manual-operation-record.v3",
    kind: "execution",
    profileDigest: request.profileDigest,
    recordedAt: "2026-09-28T00:00:00.000Z",
    promotionEligible: false,
    stage: "candidate-use",
    sessionId: request.sessionId,
    sessionNonce: request.sessionNonce,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    attemptId: request.attemptId,
    requestDigest: sha256Canonical(request),
    authorizationDigest: `sha256:${"a".repeat(64)}`,
    consumptionRecordDigest: `sha256:${"b".repeat(64)}`,
    predecessorExecutionRecordDigest: request.preparationExecutionRecordDigest,
    startedAt: null,
    finishedAt: null,
    status: "INTERRUPTED_UNKNOWN",
    reasonCode: "MANUAL_EVIDENCE_INCOMPLETE",
    resultDigest: null,
    processEvidenceDigest: null
  };
  const completedAt = "2026-09-28T00:00:02.000Z";
  const custodyRecords = result.originals.flatMap(({ digest }) =>
    ["archive", "backup"].map((storageRole) => ({
      schemaVersion: "manual-operation-record.v3",
      kind: "custody",
      profileDigest: request.profileDigest,
      recordedAt: "2026-09-28T00:00:01.000Z",
      promotionEligible: false,
      ownerId: request.ownerId,
      subjectDigest: digest,
      subjectType: "record",
      purpose: `${storageRole}-readback`,
      outcome: "MATCH",
      observedDigest: digest,
      observedAt: "2026-09-28T00:00:01.000Z",
      storageRole,
      retentionDays: 90,
      reasonCode: null
    }))
  );
  const completionInput = {
    request,
    initialExecution,
    manifest,
    verified: result,
    custodyRecords,
    completedAt
  };
  const completion = buildR3SourceCompletion(completionInput);
  assert.equal(completion.schemaVersion, "manual-r3-source-result.v1");
  assert.equal(completion.originals.length, 39);
  assert.equal(completion.custodyRecordDigests.length, 78);
  assert.equal(completion.candidateUseExecutionRecordDigest, sha256Canonical(initialExecution));
  assert.equal(completion.promotionEligible, false);
  assert.ok(encodeManualJson(completion).length <= 1048576);
  for (const change of [
    (value) => value.verified.originals.pop(),
    (value) => {
      value.custodyRecords[1].subjectDigest = value.custodyRecords[2].subjectDigest;
      value.custodyRecords[1].observedDigest = value.custodyRecords[2].subjectDigest;
    },
    (value) => {
      value.request.phase = "final";
    },
    (value) => {
      value.completedAt = "2026-09-27T23:59:59.999Z";
    }
  ]) {
    const value = structuredClone(completionInput);
    change(value);
    assert.throws(() => buildR3SourceCompletion(value), { code: "R3_SOURCE_RESULT_INVALID" });
  }
  const firstSuite = fixture.suiteReadbacks[0].report.suiteId;
  for (const change of [
    (value) => value.set(`backup:${firstSuite}`, Buffer.from("{}")),
    (value) => value.delete(`archive:${firstSuite}`),
    (value) => {
      const altered = structuredClone(observed);
      altered.reconstructed.postSchemaDigest = `sha256:${"0".repeat(64)}`;
      const bytes = encodePrivateObservationJson(altered);
      value.set("archive:manifest", bytes);
      value.set("backup:manifest", bytes);
    }
  ]) {
    const altered = initial();
    change(altered);
    await assert.rejects(read(altered), { code: "R3_SOURCE_RESULT_INVALID" });
  }
  const drifting = initial();
  await assert.rejects(
    read(drifting, async () => drifting.set("backup:attempt", Buffer.from("{}"))),
    { code: "R3_SOURCE_RESULT_INVALID" }
  );
});

test("R3 source suite reuses ordered migration, fixture and report flow for ordinary and clean databases", async () => {
  for (const suiteId of [manifest.suites[0].suiteId, "script.stage1-clean-acceptance.postgres"]) {
    const { fixture, events } = sourceSuiteFixture(suiteId);
    const { report, originals, migrationObservations, logSummary } =
      await executeR3SourceSuite(fixture);
    assert.equal(report.terminalStatus, "PASSED");
    assert.equal(report.target.databaseName, fixture.records[0].databaseName);
    assert.deepEqual(
      report.additionalDatabases?.map(({ name, databaseName }) => ({ name, databaseName })) ?? [],
      fixture.records
        .slice(1)
        .map((record) => ({ name: "source", databaseName: record.databaseName }))
    );
    assert.equal(originals.processes.length, fixture.records.length * 4);
    assert.equal(
      originals.fixtures.length,
      fixture.execution.fixtures ? fixture.records.length : 0
    );
    assert.equal(migrationObservations.length, fixture.records.length);
    assert.deepEqual(
      events
        .filter((event) => event.includes(":prisma:"))
        .map((event) => event.split(":prisma:")[1].split(" ").slice(0, 2).join(" ")),
      fixture.records.flatMap(() => [
        "migrate deploy",
        "migrate status",
        "migrate diff",
        "migrate diff"
      ])
    );
    assert.ok(events.indexOf("context") < events.indexOf("test"));
    assert.ok(events.filter((event) => event.endsWith(":grant")).length === fixture.records.length);
    for (const record of fixture.records) {
      const prefix = `${record.databaseName}:`;
      const lastPrisma = events.findLastIndex((event) => event.startsWith(`${prefix}prisma:`));
      const grant = events.indexOf(`${prefix}migrate:grant`);
      const boundary = events.indexOf(`${prefix}runtime-test:boundary`);
      assert.ok(lastPrisma < grant && grant < boundary && boundary < events.indexOf("context"));
      if (fixture.execution.fixtures) {
        const migrationFixture = events.indexOf(`${prefix}migrate:fixture`);
        const runtimeFixture = events.indexOf(`${prefix}runtime-test:fixture`);
        assert.ok(boundary < migrationFixture && migrationFixture < runtimeFixture);
        assert.ok(runtimeFixture < events.indexOf("context"));
      }
    }
    assert.equal(originals.test.stdout.includes("private-stdout-marker"), true);
    assert.equal(JSON.stringify({ report, logSummary }).includes("private-stdout-marker"), false);
  }
});

test("R3 source suite refuses crossed credentials and failed runtime role readback while retaining originals", async () => {
  for (const defect of ["crossed-secret", "role-boundary"]) {
    const { fixture } = sourceSuiteFixture("script.stage1-clean-acceptance.postgres");
    if (defect === "crossed-secret") {
      const readSecret = fixture.readSecret;
      fixture.readSecret = async (record, profile) => ({
        ...(await readSecret(record, profile)),
        database: fixture.records[0].databaseName
      });
    } else {
      const executeCredential = fixture.executeCredential;
      fixture.executeCredential = async (record, profile, sql) => {
        const readback = await executeCredential(record, profile, sql);
        if (sql.startsWith("SELECT r.rolsuper")) readback.rows[0].superuser = true;
        return readback;
      };
    }
    await assert.rejects(executeR3SourceSuite(fixture), (error) => {
      assert.equal(error.code, "R3_SOURCE_SUITE_UNAVAILABLE");
      assert.ok(error.originals.databases.length > 0);
      return true;
    });
  }
});

test("R3 source suite retains private outputs but refuses abnormal process exits or missing counts", async () => {
  for (const defect of ["nonzero", "counts", "timedOut", "processError"]) {
    const { fixture } = sourceSuiteFixture(manifest.suites[0].suiteId);
    const runTest = fixture.runTest;
    fixture.runTest = async (...args) => {
      const result = await runTest(...args);
      if (defect === "nonzero")
        return {
          ...result,
          code: 1,
          stdout: result.stdout.replace("# pass 1\n# fail 0", "# pass 0\n# fail 1")
        };
      if (defect === "counts") return { ...result, stdout: "private-stdout-marker without counts" };
      return { ...result, [defect]: true };
    };
    await assert.rejects(executeR3SourceSuite(fixture), (error) => {
      assert.equal(error.code, "R3_SOURCE_SUITE_UNAVAILABLE");
      assert.ok(error.originals.test.stdout.includes("private-stdout-marker"));
      return true;
    });
  }
  const { fixture } = sourceSuiteFixture(manifest.suites[0].suiteId);
  const runPrisma = fixture.runPrisma;
  fixture.runPrisma = async (...args) => ({ ...(await runPrisma(...args)), timedOut: true });
  await assert.rejects(executeR3SourceSuite(fixture), (error) => {
    assert.equal(error.code, "R3_SOURCE_SUITE_UNAVAILABLE");
    assert.equal(error.originals.processes.length, 1);
    return true;
  });
});

test("R3 database provision executes single statements, bounds roles and rechecks actual identities", async () => {
  const plan = planR3DatabaseTargets(input("final", "snapshot"));
  const admin = fakeAdmin();
  let checks = 0;
  const result = await provisionR3DatabaseTargets({
    plan,
    policy,
    executeAdmin: admin.executeAdmin,
    createSecret,
    recheck: async () => {
      checks++;
    },
    createdAt
  });
  assert.equal(result.records.length, 38);
  assert.ok(result.records[0].marker.startsWith("{"));
  assert.ok(result.records.at(-1).marker.startsWith("subscription-s1-ephemeral/v1:{"));
  assert.equal(
    admin.databases.get(result.records.at(-1).databaseName).marker,
    result.records.at(-1).marker
  );
  assert.equal(checks, 76);
  assert.equal(admin.calls.filter((call) => /^CREATE DATABASE /u.test(call.sql)).length, 38);
  assert.ok(
    admin.calls.every(
      (call) => !call.sql.includes(";") || call.sql.startsWith("COMMENT ON DATABASE")
    ),
    "one SQL statement per call"
  );
  assert.ok(
    admin.calls
      .filter((call) => /^CREATE ROLE /u.test(call.sql))
      .every((call) =>
        /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS$/u.test(call.sql)
      )
  );
  assert.ok(admin.calls.some((call) => /^GRANT SELECT ON ALL TABLES/u.test(call.sql)));
  assert.ok(
    admin.calls.some((call) =>
      /^GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES/u.test(call.sql)
    )
  );
  assert.ok(admin.calls.some((call) => /^REVOKE ALL ON DATABASE /u.test(call.sql)));
  assert.ok(admin.calls.every((call) => !/^DROP |^ROLLBACK/u.test(call.sql)));
  assert.ok(!JSON.stringify(result).includes("synthetic-password"));
  assert.equal(result.records[0].owner, plan.targets[0].roles.migrate);
  assert.equal(result.records[0].runtimeCanCreate, false);
  assert.equal(result.records[0].roleReadback["runtime-test"].memberships, 0);
  assert.equal(result.records[0].roleReadback["runtime-test"].canCreateTemporary, false);
  assert.equal(result.records[0].schemaPrivileges["runtime-test"].canUse, true);
  assert.equal(
    await recheckR3DatabaseTargets({
      plan,
      records: result.records,
      executeAdmin: admin.executeAdmin
    }),
    true
  );
  admin.roles.get(result.records[0].roles["runtime-test"]).memberships = 1;
  await assert.rejects(
    recheckR3DatabaseTargets({ plan, records: result.records, executeAdmin: admin.executeAdmin }),
    invalid
  );
  admin.roles.get(result.records[0].roles["runtime-test"]).memberships = 0;
  admin.roles.get(result.records[0].roles["runtime-test"]).grantedTo = 1;
  await assert.rejects(
    recheckR3DatabaseTargets({ plan, records: result.records, executeAdmin: admin.executeAdmin }),
    invalid
  );
  const delegated = fakeAdmin({ grantedTo: 1 });
  await assert.rejects(
    provisionR3DatabaseTargets({
      plan,
      policy,
      executeAdmin: delegated.executeAdmin,
      createSecret,
      recheck: async () => {},
      createdAt
    }),
    invalid
  );
});

test("R3 database provision preserves completed facts and partial resources on failure", async () => {
  const plan = planR3DatabaseTargets(input());
  const admin = fakeAdmin({ failAfterCreate: 1 });
  await assert.rejects(
    provisionR3DatabaseTargets({
      plan,
      policy,
      executeAdmin: admin.executeAdmin,
      createSecret,
      recheck: async () => {},
      createdAt
    }),
    (error) => {
      assert.equal(error.code, invalid.code);
      assert.equal(error.records.length, 1);
      assert.equal(error.records[0].databaseName, plan.targets[0].databaseName);
      assert.deepEqual(Object.keys(error).sort(), ["code", "records"]);
      return true;
    }
  );
  assert.equal(admin.databases.size, 1);
  assert.ok(
    admin.roles.size > Object.keys(plan.targets[0].roles).length,
    "the partially created second target remains visible for UNKNOWN"
  );
  assert.ok(admin.calls.every((call) => !/^DROP |^ROLLBACK/u.test(call.sql)));
});

test("R3 restore recheck binds exact temporary membership and proven credential revocation", async () => {
  const plan = planR3DatabaseTargets(input("source", "snapshot"));
  const admin = fakeAdmin();
  const { records } = await provisionR3DatabaseTargets({
    plan,
    policy,
    executeAdmin: admin.executeAdmin,
    createSecret,
    recheck: async () => {},
    createdAt
  });
  const originalDigest = sha256Canonical(records);
  const record = records[0];
  admin.roles.get(record.roles.restore).memberships = 1;
  admin.roles.get(record.roles.migrate).grantedTo = 1;
  admin.restoreGrants.push({
    roleName: record.roles.migrate,
    memberName: record.roles.restore,
    adminOption: false,
    inheritOption: false,
    setOption: true
  });
  const request = { plan, records, executeAdmin: admin.executeAdmin };
  await assert.rejects(recheckR3DatabaseTargets(request), invalid);
  assert.equal(
    await recheckR3DatabaseTargets({
      ...request,
      restoreStates: [{ databaseName: record.databaseName, phase: "GRANTED" }]
    }),
    true
  );
  admin.restoreGrants[0].memberName = records[1].roles.restore;
  await assert.rejects(
    recheckR3DatabaseTargets({
      ...request,
      restoreStates: [{ databaseName: record.databaseName, phase: "GRANTED" }]
    }),
    invalid
  );
  admin.restoreGrants.length = 0;
  admin.roles.get(record.roles.restore).memberships = 0;
  admin.roles.get(record.roles.restore).canLogin = false;
  admin.roles.get(record.roles.restore).canConnect = false;
  admin.roles.get(record.roles.migrate).grantedTo = 0;
  const revoked = {
    ...request,
    restoreStates: [{ databaseName: record.databaseName, phase: "REVOKED" }]
  };
  await assert.rejects(recheckR3DatabaseTargets(revoked), invalid);
  admin.absentPasswords.add(record.roles.restore);
  assert.equal(await recheckR3DatabaseTargets(revoked), true);
  assert.equal(sha256Canonical(records), originalDigest);
});

test("R3 restore recheck refuses an unobserved or duplicate transition", async () => {
  const plan = planR3DatabaseTargets(input("source", "snapshot"));
  const admin = fakeAdmin();
  const { records } = await provisionR3DatabaseTargets({
    plan,
    policy,
    executeAdmin: admin.executeAdmin,
    createSecret,
    recheck: async () => {},
    createdAt
  });
  for (const restoreStates of [
    [{ databaseName: records[0].databaseName, phase: "GRANTING" }],
    [{ databaseName: records[0].databaseName, phase: "REVOKING" }],
    [
      { databaseName: records[0].databaseName, phase: "REVOKED" },
      { databaseName: records[0].databaseName, phase: "REVOKED" }
    ]
  ])
    await assert.rejects(
      recheckR3DatabaseTargets({
        plan,
        records,
        executeAdmin: admin.executeAdmin,
        restoreStates
      }),
      invalid
    );
});

function postgresReadback(engineId) {
  const id = operationRef.replaceAll("-", "");
  const mount = `/srv/stage1-snapshot/${id}`;
  const imageDigest = policy.requiredImageDigest;
  const containerId = "b".repeat(64);
  const networkId = "c".repeat(64);
  const networkName = `s1r3net_${id}`;
  const volumeName = `s1r3data_${id}`;
  const containerName = `s1r3pg_${id}`;
  const volumePath = `${mount}/docker/volumes/${volumeName}/_data`;
  const labels = { "com.subscription.release.operation-ref": operationRef };
  const postgres = {
    systemIdentifier: "7340000000000000001",
    serverVersionNum: 170011,
    serverAddress: "172.28.0.2",
    serverPort: 5432,
    databaseName: "postgres",
    databaseOid: "5",
    role: "release_provisioner",
    tls: true,
    clusterMarker: policy.requiredClusterMarker
  };
  const resources = {
    operationRef,
    workspaceMountPath: mount,
    engineId,
    imageDigest,
    engine: {
      ID: engineId,
      Driver: "overlay2",
      LoggingDriver: "json-file",
      DockerRootDir: `${mount}/docker`
    },
    image: {
      Id: `sha256:${"e".repeat(64)}`,
      RepoDigests: [`postgres@${imageDigest}`],
      Os: "linux",
      Architecture: "amd64"
    },
    container: {
      Id: containerId,
      Name: `/${containerName}`,
      Image: `sha256:${"e".repeat(64)}`,
      Config: { Image: `postgres:17-bookworm@${imageDigest}`, Labels: labels },
      State: { Running: true, Paused: false, Restarting: false, Dead: false, Pid: 321 },
      HostConfig: {
        NetworkMode: networkName,
        Privileged: false,
        PidMode: "",
        PortBindings: {},
        Binds: null
      },
      NetworkSettings: {
        Networks: { [networkName]: { NetworkID: networkId, IPAddress: "172.28.0.2" } },
        Ports: { "5432/tcp": null }
      },
      Mounts: [
        {
          Type: "volume",
          Name: volumeName,
          Source: volumePath,
          Destination: "/var/lib/postgresql/data",
          Driver: "local",
          RW: true
        }
      ]
    },
    network: {
      Id: networkId,
      Name: networkName,
      Driver: "bridge",
      Internal: true,
      Ingress: false,
      EnableIPv6: false,
      Labels: labels,
      Containers: { [containerId]: { Name: containerName, IPv4Address: "172.28.0.2/16" } }
    },
    volume: {
      Name: volumeName,
      Driver: "local",
      Mountpoint: volumePath,
      Options: null,
      Labels: labels
    },
    postgres
  };
  const payload = Buffer.from(JSON.stringify(postgres));
  const stream = Buffer.alloc(8 + payload.length);
  stream[0] = 1;
  stream.writeUInt32BE(payload.length, 4);
  payload.copy(stream, 8);
  return {
    resources,
    execution: { Id: "f".repeat(64) },
    streamBase64: stream.toString("base64"),
    completed: { ID: "f".repeat(64), ContainerID: containerId, Running: false, ExitCode: 0 }
  };
}

async function destinationFixture() {
  const engineId = operationRef;
  const plan = planR3DatabaseTargets(input());
  const admin = fakeAdmin();
  const spec = {
    schemaVersion: "manual-r3-creation-spec.v1",
    operationRef,
    profileDigest: `sha256:${"1".repeat(64)}`,
    ownerId: "owner",
    sourceSha: "a".repeat(40),
    buildProofDigest: `sha256:${"2".repeat(64)}`,
    targetPolicyDigest: `sha256:${"3".repeat(64)}`,
    phase: "source",
    chain: "fresh",
    createdAt: "2026-09-27T23:59:59.000Z",
    expiresAt: "2026-09-28T00:05:00.000Z",
    workspace: {
      id: operationRef.replaceAll("-", ""),
      mountPath: `/srv/stage1-snapshot/${operationRef.replaceAll("-", "")}`
    }
  };
  const jobAdmissionDigest = `sha256:${"4".repeat(64)}`;
  const sessionId = "20000000-0000-4000-8000-000000000001";
  const sessionNonce = "5".repeat(64);
  const created = await provisionR3DatabaseTargets({
    plan,
    policy,
    executeAdmin: admin.executeAdmin,
    recheck: async () => {},
    createdAt,
    createSecret: async ({ databaseName, profile, username }) => ({
      username,
      password: "synthetic-password-do-not-log",
      reference: `r3/${operationRef}/database-credentials/${databaseName}-${profile}.json`
    })
  });
  const pg = postgresReadback(engineId);
  const targetLocks = planManualR3TargetLocks({
    operationRef,
    engineId,
    systemIdentifier: pg.resources.postgres.systemIdentifier,
    targets: created.records.map(({ databaseName, databaseOid, marker }) => ({
      databaseName,
      databaseOid,
      marker
    }))
  }).entries;
  const databaseReadback = [];
  await recheckR3DatabaseTargets({
    plan,
    records: created.records,
    executeAdmin: async (query) => {
      const result = await admin.executeAdmin(query);
      databaseReadback.push({ ...query, rows: result.rows });
      return result;
    }
  });
  const initialExecution = {
    schemaVersion: "manual-operation-record.v3",
    profileDigest: spec.profileDigest,
    recordedAt: createdAt,
    promotionEligible: false,
    kind: "execution",
    stage: "target-create",
    sessionId,
    sessionNonce,
    operationId: operationRef,
    idempotencyKey: "r3-create",
    attemptId: operationRef,
    requestDigest: `sha256:${"6".repeat(64)}`,
    authorizationDigest: `sha256:${"7".repeat(64)}`,
    consumptionRecordDigest: `sha256:${"8".repeat(64)}`,
    predecessorExecutionRecordDigest: null,
    startedAt: null,
    finishedAt: null,
    status: "INTERRUPTED_UNKNOWN",
    reasonCode: "MANUAL_EVIDENCE_INCOMPLETE",
    resultDigest: null,
    processEvidenceDigest: null
  };
  const manifestRawDigest = sha256Bytes(Buffer.from(JSON.stringify(manifest)));
  return {
    spec,
    jobAdmissionDigest,
    hostedEvidence: {
      bundleDigest: `sha256:${"9".repeat(64)}`,
      engine: {
        id: engineId,
        info: {
          ID: engineId,
          DockerRootDir: pg.resources.engine.DockerRootDir,
          Driver: "overlay2",
          LoggingDriver: "json-file"
        }
      },
      workspaceObservation: { state: "active", status: "OBSERVED", workspace: spec.workspace },
      jobAdmissionDigest,
      spec
    },
    session: {
      profileDigest: spec.profileDigest,
      sessionId,
      sessionNonce,
      scope: {
        targetPolicyDigest: spec.targetPolicyDigest,
        creationSpecDigest: sha256Canonical(spec),
        jobAdmissionDigest,
        buildProofDigest: spec.buildProofDigest,
        sourceSha: spec.sourceSha,
        phase: spec.phase,
        chain: spec.chain
      }
    },
    initialExecution,
    manifest,
    manifestRawDigest,
    policy,
    postgresReadback: pg,
    databaseTargetSet: {
      ...created,
      targetLocks,
      status: "DATABASES_OBSERVED",
      manifestRawDigest,
      engineId,
      systemIdentifier: pg.resources.postgres.systemIdentifier,
      promotionEligible: false,
      targetSetComplete: false
    },
    databaseReadback,
    observedAt: "2026-09-28T00:00:02.000Z"
  };
}

test("R3 destination binds PG dual readback, full manifest targets and replayed SELECT originals", async () => {
  const input = await destinationFixture();
  const pg = assessR3PostgresReadback(input.postgresReadback);
  assert.equal(pg.postgres.systemIdentifier, input.databaseTargetSet.systemIdentifier);
  const result = await buildR3Destination(input);
  assert.equal(result.destination.observationEvidenceDigest, sha256Canonical(result.observations));
  assert.equal(result.destination.databaseTargetSet.records.length, 37);
  assert.equal(result.destination.databaseTargetSet.targetLocks.length, 39);
  assert.equal(result.destination.promotionEligible, false);
});

test("R3 destination rejects a mixed target and an incomplete SELECT transcript", async () => {
  const input = await destinationFixture();
  const missing = { ...input, databaseReadback: input.databaseReadback.slice(0, -1) };
  await assert.rejects(buildR3Destination(missing), { code: "R3_DESTINATION_INVALID" });
  const mixed = structuredClone(input);
  mixed.databaseTargetSet.records[0].databaseOid = "9999";
  await assert.rejects(buildR3Destination(mixed), { code: "R3_DESTINATION_INVALID" });
});
