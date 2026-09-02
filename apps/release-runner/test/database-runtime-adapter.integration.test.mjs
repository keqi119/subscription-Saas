import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  createDatabaseRuntimeAdapter,
  prismaMigrateDeployArgs,
  prismaSchemaDiffArgs
} from "../src/database-runtime-adapter.mjs";

test("uses only fixed Prisma argv and rejects a schema outside the image contract", () => {
  const schema = path.resolve("C:/app/apps/api/prisma/schema.prisma");
  assert.deepEqual(prismaMigrateDeployArgs({ schema, repoRoot: "C:/app" }), [
    "migrate",
    "deploy",
    "--schema",
    schema
  ]);
  assert.deepEqual(prismaSchemaDiffArgs({ schema, repoRoot: "C:/app" }), [
    "migrate",
    "diff",
    "--from-config-datasource",
    "--to-schema",
    schema,
    "--exit-code"
  ]);
  assert.throws(
    () => prismaMigrateDeployArgs({ schema: "C:/tmp/schema.prisma", repoRoot: "C:/app" }),
    { code: "RUNNER_SCHEMA_PATH_FORBIDDEN" }
  );
});

test("observes migration and schema facts and keeps the database URL out of argv", async () => {
  const statements = [];
  const database = {
    databaseIdentityFingerprint: `sha256:${"a".repeat(64)}`,
    statementLog: statements,
    async $queryRawUnsafe(sql) {
      statements.push(String(sql));
      if (String(sql).includes("to_regclass")) return [{ name: "_prisma_migrations" }];
      if (String(sql).includes("migration_name")) {
        return [
          {
            name: "20260901010000_stage1_schema_drift_convergence",
            checksum: "b".repeat(64)
          }
        ];
      }
      if (String(sql).includes("nspowner")) return [{ owner: "s1m_owner" }];
      if (String(sql).includes("pg_class")) {
        return [{ objectClass: "schema", objectName: "public", owner: "s1m_owner" }];
      }
      if (String(sql).includes("pg_extension")) return [{ name: "pgcrypto" }];
      if (String(sql).includes("server_version")) return [{ server_version: "17.11" }];
      return [];
    },
    async $transaction(callback) {
      return callback(database);
    }
  };
  const calls = [];
  const adapter = createDatabaseRuntimeAdapter({
    database,
    credential: {
      username: "s1m_owner",
      password: "not-exposed",
      capabilityProfile: "migrate"
    },
    target: {
      hostname: "postgres",
      databaseName: `s1ci_${"c".repeat(24)}`,
      tlsMode: "require"
    },
    repoRoot: "C:/app",
    async runProcess(command, args, options) {
      calls.push({ command, args, options });
      if (args.includes("--version")) return { exitCode: 0, signal: null, stdout: "tool 1\n" };
      if (args.includes("--script")) {
        return { exitCode: 0, signal: null, stdout: "CREATE TABLE example();\n" };
      }
      return { exitCode: 0, signal: null, stdout: "" };
    }
  });

  const migration = await adapter.observeMigrationState();
  const schema = await adapter.observeSchema();
  const versions = await adapter.readToolVersions();

  assert.equal(migration.schemaOwner, "s1m_owner");
  assert.equal(schema.schemaOwner, "s1m_owner");
  assert.match(schema.schemaDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(versions.postgresql, "17.11");
  assert.equal(
    calls.some(({ args }) => args.some((arg) => arg.includes("postgresql://"))),
    false
  );
  assert.equal(
    calls.every(({ options }) => options.environment.DATABASE_URL.includes("postgresql://")),
    true
  );
});
