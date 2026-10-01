import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReadOnlySnapshotSource,
  createReadOnlySourceExecutor,
  fingerprintSourceSnapshot
} from "../src/snapshot/source-readonly-guard.mjs";
import { createPostgresSnapshotSource } from "../src/snapshot/postgres-source.mjs";

// @database-test: classified as a source-safety contract test; no PostgreSQL connection is opened.

const digest = (character) => `sha256:${character.repeat(64)}`;
const ownershipMap = Object.freeze({
  sourceOwners: ["subscription", "subscription_saas"]
});

function safeSource(privilegeOverrides = {}) {
  return {
    trustPolicy: "protected-snapshot-source/v1",
    async observePrivileges({ secretReference }) {
      assert.equal(secretReference, "secret://stage1-snapshot-export/source");
      return {
        roleIdentityFingerprint: digest("1"),
        databaseIdentityFingerprint: digest("2"),
        superuser: false,
        createDatabase: false,
        createRole: false,
        bypassRls: false,
        schemaOwner: false,
        canCreateSchema: false,
        tableWritePrivileges: [],
        tableTruncatePrivileges: [],
        writableFunctionExecutePrivileges: [],
        objectOwners: ["subscription"],
        ...privilegeOverrides
      };
    }
  };
}

for (const [name, override] of [
  ["SUPERUSER", { superuser: true }],
  ["CREATEDB", { createDatabase: true }],
  ["CREATEROLE", { createRole: true }],
  ["BYPASSRLS", { bypassRls: true }],
  ["Schema owner", { schemaOwner: true }],
  ["Schema CREATE", { canCreateSchema: true }],
  ["table INSERT/UPDATE/DELETE", { tableWritePrivileges: ["public.customer:UPDATE"] }],
  ["table TRUNCATE", { tableTruncatePrivileges: ["public.customer"] }],
  [
    "writable function EXECUTE",
    { writableFunctionExecutePrivileges: ["public.rotate_provider_secret()"] }
  ]
]) {
  test(`rejects source capability ${name}`, async () => {
    await assert.rejects(
      () =>
        assertReadOnlySnapshotSource({
          source: safeSource(override),
          secretReference: "secret://stage1-snapshot-export/source",
          ownershipMap,
          now: new Date("2026-09-02T08:00:00.000Z")
        }),
      { code: "SNAPSHOT_SOURCE_WRITE_CAPABILITY_FORBIDDEN" }
    );
  });
}

test("accepts only a protected secret reference and emits no raw role or database name", async () => {
  const observation = await assertReadOnlySnapshotSource({
    source: safeSource(),
    secretReference: "secret://stage1-snapshot-export/source",
    ownershipMap,
    now: new Date("2026-09-02T08:00:00.000Z")
  });
  assert.equal(observation.schemaVersion, "source-privilege-observation.v1");
  assert.equal(JSON.stringify(observation).includes("password"), false);
  assert.equal("databaseName" in observation, false);
  await assert.rejects(
    () =>
      assertReadOnlySnapshotSource({
        source: safeSource(),
        secretReference: "postgres://user:password@staging/database",
        ownershipMap
      }),
    { code: "SNAPSHOT_SOURCE_SECRET_REFERENCE_INVALID" }
  );
});

test("rejects a source object owner absent from the approved owner map", async () => {
  await assert.rejects(
    () =>
      assertReadOnlySnapshotSource({
        source: safeSource({ objectOwners: ["ambient_staging_owner"] }),
        secretReference: "secret://stage1-snapshot-export/source",
        ownershipMap
      }),
    { code: "SNAPSHOT_SOURCE_OWNER_UNMAPPED" }
  );
});

test("source executor permits catalog/read and COPY TO STDOUT only", async () => {
  const calls = [];
  const executor = createReadOnlySourceExecutor({
    async execute(statement) {
      calls.push(statement);
      return { rows: [] };
    }
  });
  await executor.execute("SELECT count(*) FROM public.customer");
  await executor.execute("COPY (SELECT id FROM public.customer) TO STDOUT WITH (FORMAT binary)");
  assert.equal(calls.length, 2);
  for (const statement of [
    "UPDATE public.customer SET mobile = 'x'",
    "INSERT INTO public.customer(id) VALUES ('x')",
    "DELETE FROM public.customer",
    "TRUNCATE public.customer",
    "CREATE TABLE public.leak(id int)",
    "SET TRANSACTION READ WRITE",
    "SELECT nextval('customer_seq')",
    "SELECT safe_read() /* ; UPDATE public.customer SET mobile = 'x' */"
  ]) {
    await assert.rejects(() => executor.execute(statement), {
      code: "SNAPSHOT_SOURCE_DML_FORBIDDEN"
    });
  }
});

test("fingerprint identity is stable across provenance timestamps", async () => {
  const source = {
    async readFingerprint() {
      return {
        migrationHead: "20260901010000_stage1_schema_drift_convergence",
        databaseIdentityFingerprint: digest("2"),
        roleIdentityFingerprint: digest("1"),
        tables: [
          { table: "public.customer", rowCount: 2, checksum: digest("4") },
          { table: "public.application", rowCount: 1, checksum: digest("3") }
        ]
      };
    }
  };
  const first = await fingerprintSourceSnapshot({
    source,
    snapshotId: "00000003-0000001A-1",
    keyTables: ["public.application", "public.customer"],
    now: new Date("2026-09-02T08:00:00.000Z")
  });
  const second = await fingerprintSourceSnapshot({
    source,
    snapshotId: "00000003-0000001A-1",
    keyTables: ["public.application", "public.customer"],
    now: new Date("2026-09-02T08:05:00.000Z")
  });
  assert.deepEqual(first.identity, second.identity);
  assert.notEqual(first.provenance.observedAt, second.provenance.observedAt);
});

function postgresClientFixture({
  failOn,
  readOnly = "on",
  rollbackFails = false,
  owner = "subscription",
  functionRows = []
} = {}) {
  const statements = [];
  const client = {
    processID: 321,
    ended: false,
    async query(sql, values) {
      statements.push({ sql, values });
      if (failOn && sql.includes(failOn)) throw new Error("mock query failed with private details");
      if (sql === "ROLLBACK" && rollbackFails) throw new Error("mock rollback failed");
      if (sql.includes("pg_control_system()"))
        return {
          rows: [
            {
              database_name: "staging_fixture",
              database_oid: "16384",
              current_role: "snapshot_reader",
              session_role: "snapshot_reader",
              role_oid: "16400",
              backend_pid: this.processID,
              system_identifier: "1234567890123456789"
            }
          ]
        };
      if (sql.includes("rolsuper AS superuser"))
        return {
          rows: [
            { superuser: false, create_database: false, create_role: false, bypass_rls: false }
          ]
        };
      if (sql.includes("SELECT DISTINCT CASE WHEN owner.rolname")) return { rows: [{ owner }] };
      if (sql.includes("has_schema_privilege"))
        return { rows: [{ schema_name: "public", owner, can_create: false }] };
      if (sql.includes("has_table_privilege")) return { rows: [] };
      if (sql.includes("has_sequence_privilege")) return { rows: [] };
      if (sql.includes("has_function_privilege")) return { rows: functionRows };
      if (sql.includes("has_database_privilege")) return { rows: [{ can_create: false }] };
      if (sql.includes("transaction_isolation"))
        return { rows: [{ isolation_level: "repeatable read", read_only: readOnly }] };
      if (sql.includes("pg_export_snapshot()"))
        return { rows: [{ snapshot_id: "00000003-0000001A-1" }] };
      if (sql.includes("FROM public._prisma_migrations"))
        return {
          rows: [
            { migration_name: "20260925091000_stage1_operational_completion_settlement_guard" }
          ]
        };
      if (sql.includes("row_to_json(t)"))
        return {
          rows: [{ id: "00000000-0000-0000-0000-000000000001", record: '{"id":"fixture"}' }]
        };
      if (sql.startsWith("BEGIN") || sql === "ROLLBACK") return { rows: [] };
      throw new Error("Unexpected SQL in mock client");
    },
    async end() {
      this.ended = true;
    }
  };
  return { client, statements };
}

test("PostgreSQL source admits only catalog-proven trigger and pgcrypto functions", async () => {
  const base = {
    schema_name: "public",
    can_execute: true,
    volatility: "v",
    security_definer: false,
    trigger_return: false,
    event_trigger_return: false,
    pgcrypto_member: false,
    language: "c",
    library: "$libdir/pgcrypto",
    argument_type_oids: "25",
    return_type_oid: "25",
    symbol: "pg_gen_salt"
  };
  const trigger = {
    ...base,
    function_name: "fixture_guard",
    trigger_return: true,
    language: "plpgsql",
    library: "",
    argument_type_oids: "",
    return_type_oid: "2279",
    symbol: "fixture_guard"
  };
  const crypto = { ...base, function_name: "gen_salt", pgcrypto_member: true };
  const observe = async (functionRows) => {
    const { client } = postgresClientFixture({ functionRows });
    const source = createPostgresSnapshotSource({
      client,
      exportDump: async () => Buffer.from("PGDMP")
    });
    try {
      return await assertReadOnlySnapshotSource({
        source,
        secretReference: "secret://stage1-snapshot-export/source",
        ownershipMap
      });
    } finally {
      await source.closeSnapshot();
    }
  };
  const accepted = await observe([trigger, crypto]);
  assert.equal(accepted.capabilities.writableFunctionExecutePrivilegeCount, 0);
  for (const unsafe of [
    { ...crypto, pgcrypto_member: false, language: "sql", library: "" },
    { ...trigger, security_definer: true }
  ]) {
    await assert.rejects(observe([unsafe]), { code: "SNAPSHOT_SOURCE_WRITE_CAPABILITY_FORBIDDEN" });
  }
});

test("PostgreSQL source uses real catalog queries and one held read-only snapshot", async () => {
  const { client, statements } = postgresClientFixture();
  const exports = [];
  const source = createPostgresSnapshotSource({
    client,
    async exportDump(request) {
      exports.push(request);
      return Buffer.from("PGDMP\0fixture");
    }
  });
  const privilege = await assertReadOnlySnapshotSource({
    source,
    secretReference: "secret://stage1-snapshot-export/source",
    ownershipMap
  });
  const session = await source.openReadOnlySnapshot();
  const keyTables = [
    "public.application",
    "public.customer",
    "public.customer_identity",
    "public.subscription_order"
  ];
  const before = await fingerprintSourceSnapshot({
    source,
    snapshotId: session.snapshotId,
    keyTables
  });
  const dump = await source.exportRaw({ snapshotId: session.snapshotId });
  const after = await fingerprintSourceSnapshot({
    source,
    snapshotId: session.snapshotId,
    keyTables
  });
  await source.closeSnapshot();
  assert.equal(privilege.schemaVersion, "source-privilege-observation.v1");
  assert.equal(session.isolationLevel, "REPEATABLE READ");
  assert.equal(before.identity.snapshotIdFingerprint, after.identity.snapshotIdFingerprint);
  assert.equal(before.identity.databaseIdentityFingerprint, privilege.databaseIdentityFingerprint);
  assert.deepEqual(dump, Buffer.from("PGDMP\0fixture"));
  assert.equal(exports.length, 1);
  assert.equal(exports[0].snapshotId, session.snapshotId);
  assert.ok(
    statements.some(({ sql }) => sql.startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"))
  );
  assert.ok(statements.some(({ sql }) => sql.includes("pg_export_snapshot()")));
  assert.equal(statements.at(-1).sql, "ROLLBACK");
  assert.equal(client.ended, true);
});

test("PostgreSQL source resolves dynamic database owner and serializes catalog reads", async () => {
  const { client, statements } = postgresClientFixture({ owner: "postgres" });
  const originalQuery = client.query.bind(client);
  let active = 0;
  client.query = async (...args) => {
    active += 1;
    assert.equal(active, 1, "one pg Client cannot run catalog queries concurrently");
    try {
      await Promise.resolve();
      return await originalQuery(...args);
    } finally {
      active -= 1;
    }
  };
  const source = createPostgresSnapshotSource({
    client,
    exportDump: async () => Buffer.from("PGDMP\0fixture")
  });
  const observation = await assertReadOnlySnapshotSource({
    source,
    secretReference: "secret://stage1-snapshot-export/source",
    ownershipMap: { sourceOwners: ["postgres"] }
  });
  assert.equal(observation.capabilities.objectOwnerCount, 1);
  const ownerQuery = statements.find(({ sql }) =>
    sql.includes("SELECT DISTINCT CASE WHEN owner.rolname")
  )?.sql;
  assert.match(ownerQuery, /pg_database_owner/u);
  assert.match(ownerQuery, /db\.datdba/u);
  assert.match(ownerQuery, /pg_proc/u);
  assert.match(ownerQuery, /pg_type/u);
  assert.match(
    statements.find(({ sql }) => sql.includes("has_schema_privilege"))?.sql,
    /db\.datdba/u
  );
  await source.closeSnapshot();
});

test("PostgreSQL source rejects a changed backend and contract-external tables", async () => {
  const fixture = postgresClientFixture();
  const source = createPostgresSnapshotSource({
    client: fixture.client,
    exportDump: async () => Buffer.from("PGDMP\0fixture")
  });
  await source.observePrivileges();
  const session = await source.openReadOnlySnapshot();
  await assert.rejects(
    source.readFingerprint({ snapshotId: session.snapshotId, keyTables: ["public.customer"] }),
    { code: "SNAPSHOT_SOURCE_TABLES_INVALID" }
  );
  assert.equal(fixture.client.ended, true);
  const driftFixture = postgresClientFixture();
  const driftSource = createPostgresSnapshotSource({
    client: driftFixture.client,
    exportDump: async () => Buffer.from("PGDMP\0fixture")
  });
  await driftSource.observePrivileges();
  const driftSession = await driftSource.openReadOnlySnapshot();
  driftFixture.client.processID = 322;
  await assert.rejects(driftSource.exportRaw({ snapshotId: driftSession.snapshotId }), {
    code: "SNAPSHOT_SOURCE_IDENTITY_DRIFT"
  });
  assert.equal(driftFixture.client.ended, true);
});

test("PostgreSQL source closes itself after pre-open, post-BEGIN and held-session failures", async () => {
  for (const scenario of [
    { options: { failOn: "rolsuper AS superuser" }, phase: "observe", rollback: false },
    { options: { readOnly: "off" }, phase: "open", rollback: true },
    { options: {}, phase: "fingerprint", rollback: true },
    { options: {}, phase: "export", rollback: true }
  ]) {
    const { client, statements } = postgresClientFixture(scenario.options);
    const source = createPostgresSnapshotSource({
      client,
      exportDump: async () => {
        throw new Error("private exporter failure");
      }
    });
    if (scenario.phase === "observe") {
      await assert.rejects(source.observePrivileges(), { code: "SNAPSHOT_SOURCE_QUERY_FAILED" });
    } else {
      await source.observePrivileges();
      if (scenario.phase === "open") {
        await assert.rejects(source.openReadOnlySnapshot(), {
          code: "SNAPSHOT_SOURCE_TRANSACTION_INVALID"
        });
      } else {
        const { snapshotId } = await source.openReadOnlySnapshot();
        if (scenario.phase === "fingerprint") {
          await assert.rejects(
            source.readFingerprint({ snapshotId, keyTables: ["public.customer"] }),
            { code: "SNAPSHOT_SOURCE_TABLES_INVALID" }
          );
        } else {
          await assert.rejects(source.exportRaw({ snapshotId }), {
            code: "SNAPSHOT_SOURCE_EXPORT_FAILED"
          });
        }
      }
    }
    assert.equal(client.ended, true, scenario.phase);
    assert.equal(
      statements.some(({ sql }) => sql === "ROLLBACK"),
      scenario.rollback
    );
  }
});

test("PostgreSQL source reports UNKNOWN when rollback cannot be proven", async () => {
  const { client } = postgresClientFixture({ readOnly: "off", rollbackFails: true });
  const source = createPostgresSnapshotSource({
    client,
    exportDump: async () => Buffer.from("PGDMP")
  });
  await source.observePrivileges();
  await assert.rejects(source.openReadOnlySnapshot(), { code: "SNAPSHOT_SOURCE_CLEANUP_UNKNOWN" });
  assert.equal(client.ended, true);
  await assert.rejects(source.closeSnapshot(), { code: "SNAPSHOT_SOURCE_CLEANUP_UNKNOWN" });
});
