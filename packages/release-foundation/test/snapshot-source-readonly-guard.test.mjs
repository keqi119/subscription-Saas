import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReadOnlySnapshotSource,
  createReadOnlySourceExecutor,
  fingerprintSourceSnapshot
} from "../src/snapshot/source-readonly-guard.mjs";

// @database-test: classified as a source-safety contract test; no PostgreSQL connection is opened.

const digest = (character) => `sha256:${character.repeat(64)}`;

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
    now: new Date("2026-09-02T08:00:00.000Z")
  });
  assert.equal(observation.schemaVersion, "source-privilege-observation.v1");
  assert.equal(JSON.stringify(observation).includes("password"), false);
  assert.equal("databaseName" in observation, false);
  await assert.rejects(
    () =>
      assertReadOnlySnapshotSource({
        source: safeSource(),
        secretReference: "postgres://user:password@staging/database"
      }),
    { code: "SNAPSHOT_SOURCE_SECRET_REFERENCE_INVALID" }
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
