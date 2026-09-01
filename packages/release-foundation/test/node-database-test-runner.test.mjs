import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  runRuntimeSeedFixture,
  runSchemaFixture,
  scanDatabaseFrameworkBypasses
} from "../src/index.mjs";

const migrationFingerprint = `sha256:${"a".repeat(64)}`;
const runtimeFingerprint = `sha256:${"b".repeat(64)}`;
const repoRoot = resolve(import.meta.dirname, "../../..");

test("database candidates contain no framework bypasses", async () => {
  const manifest = {
    suites: [
      {
        files: [
          "scripts/stage1-clean-acceptance-baseline-postgres.integration.test.mjs",
          "scripts/stage1-staging-invalid-test-order-retirement-postgres.integration.test.mjs"
        ]
      }
    ]
  };
  const violations = await scanDatabaseFrameworkBypasses(repoRoot, manifest);
  assert.deepEqual(violations, []);
});

test("migration fixture accepts DDL and grants but rejects business DML", async () => {
  const calls = [];
  const observation = await runSchemaFixture({
    credentialRef: "secret://migration",
    credentialFingerprint: migrationFingerprint,
    counterpartCredentialFingerprint: runtimeFingerprint,
    fixturePath: "release/test-fixtures/schema.sql",
    sql: [
      "CREATE SCHEMA fixture",
      "CREATE TABLE fixture.target_state (id text PRIMARY KEY)",
      "GRANT SELECT ON fixture.target_state TO {{runtime_role}}"
    ].join(";\n"),
    runtimeRole: "s1r_aaaaaaaaaaaaaaaaaaaaaaaa",
    executeSql: async (input) => calls.push(input)
  });
  assert.deepEqual(observation.statementClasses, ["CREATE", "CREATE", "GRANT"]);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].sql, /\{\{runtime_role\}\}/);

  await assert.rejects(
    runSchemaFixture({
      credentialRef: "secret://migration",
      credentialFingerprint: migrationFingerprint,
      counterpartCredentialFingerprint: runtimeFingerprint,
      fixturePath: "release/test-fixtures/schema.sql",
      sql: "INSERT INTO fixture.target_state(id) VALUES ('x');",
      runtimeRole: "s1r_aaaaaaaaaaaaaaaaaaaaaaaa",
      executeSql: async () => {}
    }),
    { code: "MIGRATION_FIXTURE_BUSINESS_DML_FORBIDDEN" }
  );
});

test("runtime fixture accepts bounded DML and rejects DDL, ownership, and truncate", async () => {
  const calls = [];
  const observation = await runRuntimeSeedFixture({
    credentialRef: "secret://runtime",
    credentialFingerprint: runtimeFingerprint,
    counterpartCredentialFingerprint: migrationFingerprint,
    fixturePath: "release/test-fixtures/seed.sql",
    sql: "DELETE FROM fixture.target_state; INSERT INTO fixture.target_state(id) VALUES ('x');",
    executeSql: async (input) => calls.push(input)
  });
  assert.deepEqual(observation.statementClasses, ["DELETE", "INSERT"]);
  assert.equal(calls.length, 1);

  for (const sql of [
    "CREATE SCHEMA escaped;",
    "ALTER TABLE fixture.target_state OWNER TO escaped;",
    "DROP TABLE fixture.target_state;",
    "TRUNCATE fixture.target_state;"
  ]) {
    await assert.rejects(
      runRuntimeSeedFixture({
        credentialRef: "secret://runtime",
        credentialFingerprint: runtimeFingerprint,
        counterpartCredentialFingerprint: migrationFingerprint,
        fixturePath: "release/test-fixtures/seed.sql",
        sql,
        executeSql: async () => {}
      }),
      { code: "RUNTIME_FIXTURE_DDL_FORBIDDEN" }
    );
  }
});

test("fixture loaders reject capability credential reuse", async () => {
  for (const run of [runSchemaFixture, runRuntimeSeedFixture]) {
    await assert.rejects(
      run({
        credentialRef: "secret://combined",
        credentialFingerprint: migrationFingerprint,
        counterpartCredentialFingerprint: migrationFingerprint,
        fixturePath: "release/test-fixtures/fixture.sql",
        sql: run === runSchemaFixture ? "CREATE SCHEMA fixture;" : "DELETE FROM fixture.row;",
        runtimeRole: "s1r_aaaaaaaaaaaaaaaaaaaaaaaa",
        executeSql: async () => {}
      }),
      { code: "FIXTURE_CAPABILITY_CREDENTIAL_REUSE" }
    );
  }
});
