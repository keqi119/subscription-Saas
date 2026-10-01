import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "@subscription-saas/release-foundation";
import { finalMigrationInputFixture } from "./fixtures/final-migration-input.mjs";
import { validateFinalMigrationInput } from "../src/final-migration-input.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
async function fixture(
  options = {
    suiteId: "script.stage1-clean-acceptance.postgres"
  }
) {
  const values = await finalMigrationInputFixture(options);
  const held = validateFinalMigrationInput(values),
    calls = [];
  const row = {
    databaseName: held.input.database.databaseName,
    databaseOid: held.input.database.databaseOid,
    marker: held.input.database.marker,
    migrationRole: held.input.database.migrationRole,
    databaseOwner: held.input.database.migrationRole,
    schemaOwner: held.input.database.migrationRole,
    tls: true,
    runtimeRole: held.runtimeRole,
    canLogin: true,
    superuser: false,
    createdb: false,
    createrole: false,
    inherit: false,
    replication: false,
    bypassrls: false,
    memberships: 0,
    grantedTo: 0,
    canCreateDatabase: false,
    canCreateTemporaryObjects: false,
    canCreatePublicSchema: false,
    schemaOwnerRuntime: false,
    objectOwnerRuntime: false,
    canUsePublic: true
  };
  const database = {
    $transaction: async (work) =>
      work({
        $queryRawUnsafe: async (sql, role) => {
          calls.push({ kind: "query", sql, role });
          return [structuredClone(row)];
        },
        $executeRawUnsafe: async (sql) => {
          calls.push({ kind: "execute", sql });
          return 0;
        }
      })
  };
  return { values, held, calls, row, database };
}

test("fixed preparation executes manifest schema and grants with migration connection before runtime seed", async () => {
  const api = await import("../src/final-runtime-preparation.mjs"),
    f = await fixture();
  const result = await api.prepareFinalRuntimeDatabase({
    ...f.values,
    repoRoot,
    database: f.database,
    signal: new AbortController().signal
  });
  assert.equal(result.bindingDigest, sha256Canonical(f.values.input));
  assert.equal(
    result.schemaFixture.fixturePath,
    "release/test-fixtures/stage1-clean-acceptance.schema.sql"
  );
  assert.equal(result.executions.length, 2);
  assert.ok(result.executions[0].sql.includes(`TO "${f.held.runtimeRole}"`));
  assert.ok(result.executions[1].sql.includes("CREATE SCHEMA stage1_clean_acceptance_fixture"));
  assert.ok(result.executions.every(({ sql }) => !/INSERT INTO/iu.test(sql)));
  assert.deepEqual(
    f.calls.map(({ kind }) => kind),
    ["query", "execute", "execute", "query"]
  );
  const evidence = await api.assessFinalRuntimePreparation({
    ...f.values,
    repoRoot,
    preparation: result
  });
  assert.equal(evidence.preparationDigest, sha256Canonical(result));
  const replaced = structuredClone(result);
  replaced.executions[1].sql = "CREATE SCHEMA foreign_fixture;";
  await assert.rejects(
    api.assessFinalRuntimePreparation({ ...f.values, repoRoot, preparation: replaced }),
    { code: "R3_FINAL_RUNTIME_PREPARATION_FAILED" }
  );
});

test("preparation rejects wrong physical identity before the first statement and retains an actual execution failure", async () => {
  const api = await import("../src/final-runtime-preparation.mjs"),
    f = await fixture();
  f.row.marker = "foreign";
  await assert.rejects(
    api.prepareFinalRuntimeDatabase({
      ...f.values,
      repoRoot,
      database: f.database,
      signal: new AbortController().signal
    }),
    { code: "R3_FINAL_RUNTIME_PREPARATION_FAILED" }
  );
  assert.equal(
    f.calls.some(({ kind }) => kind === "execute"),
    false
  );
  f.row.marker = f.values.input.database.marker;
  f.database.$transaction = async (work) =>
    work({
      $queryRawUnsafe: async () => [f.row],
      $executeRawUnsafe: async () => {
        throw new Error("actual statement failure");
      }
    });
  await assert.rejects(
    api.prepareFinalRuntimeDatabase({
      ...f.values,
      repoRoot,
      database: f.database,
      signal: new AbortController().signal
    }),
    (error) => {
      assert.equal(error.code, "R3_FINAL_RUNTIME_PREPARATION_FAILED");
      assert.equal(error.originals.executions.length, 0);
      assert.equal(error.cause.message, "actual statement failure");
      return true;
    }
  );
});

test("application preparation grants the fixed runtime role without executing a test schema or seed", async () => {
  const api = await import("../src/final-runtime-preparation.mjs");
  for (const chain of ["fresh", "snapshot"]) {
    const f = await fixture({ application: true, chain });
    const result = await api.prepareFinalRuntimeDatabase({
      ...f.values,
      repoRoot,
      database: f.database,
      signal: new AbortController().signal
    });
    assert.equal(result.schemaFixture, null);
    assert.equal(result.executions.length, 1);
    assert.ok(result.executions[0].sql.includes(`TO "${f.held.runtimeRole}"`));
    assert.ok(!/INSERT INTO|CREATE SCHEMA/iu.test(result.executions[0].sql));
    assert.deepEqual(
      f.calls.map(({ kind }) => kind),
      ["query", "execute", "query"]
    );
    const evidence = await api.assessFinalRuntimePreparation({
      ...f.values,
      repoRoot,
      preparation: result
    });
    assert.equal(evidence.preparationDigest, sha256Canonical(result));
  }
});
