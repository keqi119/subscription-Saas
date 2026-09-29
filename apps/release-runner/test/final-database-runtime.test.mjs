import assert from "node:assert/strict";
import test from "node:test";

import { finalDatabaseEnvelopeFixture } from "./fixtures/final-database-envelope.mjs";
import { observeFinalRuntimeBoundary } from "../src/final-database-runtime.mjs";

const mismatch = { code: "DATABASE_TEST_TARGET_IDENTITY_MISMATCH" };

async function fixture() {
  const { envelope } = await finalDatabaseEnvelopeFixture();
  const target = Object.values(envelope.suiteAssignments).find((value) => value.kind === "suite")
    .databases.target;
  const row = {
    databaseName: target.databaseName,
    databaseOid: target.databaseOid,
    marker: target.marker,
    databaseOwner: target.migrationRole,
    publicSchemaOwner: target.migrationRole,
    migrationTableOwner: target.migrationRole,
    role: target.runtimeRole,
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
  return { target, row };
}

test("final runtime boundary reads one fixed SQL row and returns actual frozen facts", async () => {
  const { target, row } = await fixture();
  const statements = [];
  const database = {
    async $queryRawUnsafe(sql) {
      statements.push(sql);
      return [{ ...row }];
    }
  };
  const observed = await observeFinalRuntimeBoundary(database, target);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^\s*SELECT\b/u);
  assert.match(statements[0], /current_database\(\)/u);
  assert.match(statements[0], /shobj_description/u);
  assert.match(statements[0], /pg_stat_ssl/u);
  assert.match(statements[0], /pg_auth_members/u);
  assert.match(statements[0], /rolreplication/u);
  assert.match(statements[0], /has_database_privilege\(current_user, d\.oid, 'TEMP'\)/u);
  assert.deepEqual(observed.identity, row);
  assert.deepEqual(observed.roleBoundary, {
    roleAttributes: { superuser: false, createdb: false, createrole: false, bypassrls: false },
    canCreateSchema: false,
    schemaOwner: false,
    objectOwner: false
  });
  assert.ok(Object.isFrozen(observed) && Object.isFrozen(observed.identity));
  row.databaseOid = "9999";
  assert.notEqual(observed.identity.databaseOid, row.databaseOid);
});

test("final runtime boundary rejects changed identity, owner and active capabilities", async () => {
  const { target, row } = await fixture();
  const changes = [
    { databaseOid: "9999" },
    { marker: "changed" },
    { tls: false },
    { role: target.migrationRole },
    { databaseOwner: target.runtimeRole },
    { publicSchemaOwner: target.runtimeRole },
    { migrationTableOwner: target.runtimeRole },
    { canLogin: false },
    { canCreateDatabase: true },
    { replication: true },
    { canCreateTemporaryObjects: true },
    { canCreatePublicSchema: true },
    { memberships: 1 },
    { grantedTo: 1 },
    { inherit: true },
    { schemaOwner: true },
    { objectOwner: true }
  ];
  for (const change of changes)
    await assert.rejects(
      observeFinalRuntimeBoundary({ $queryRawUnsafe: async () => [{ ...row, ...change }] }, target),
      mismatch
    );
  await assert.rejects(
    observeFinalRuntimeBoundary({ $queryRawUnsafe: async () => [] }, target),
    mismatch
  );
  const cause = new Error("synthetic database failure");
  await assert.rejects(
    observeFinalRuntimeBoundary(
      {
        async $queryRawUnsafe() {
          throw cause;
        }
      },
      target
    ),
    (error) =>
      error.code === mismatch.code &&
      error.cause === cause &&
      Object.keys(error).includes("cause") === false
  );
});
