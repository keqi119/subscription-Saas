import assert from "node:assert/strict";
import test from "node:test";

import { requiredReleaseDatabaseTestContext } from "../../packages/release-foundation/src/index.mjs";
import { executeDockerCommand } from "../../scripts/release/bootstrap-controlled-postgres.mjs";

const context = requiredReleaseDatabaseTestContext(import.meta.url);

test("uses only the assigned runtime-equivalent database identity", async () => {
  const output = await executeDockerCommand({
    args: [
      "exec",
      "--interactive",
      "--env",
      "PGPASSWORD",
      context.containerId,
      "psql",
      "--host",
      "127.0.0.1",
      "--username",
      context.runtimeCredential.username,
      "--dbname",
      context.databaseName,
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      "--field-separator",
      "|",
      "--command",
      [
        "SELECT current_database(), current_user,",
        "       r.rolsuper::text, r.rolcreatedb::text, r.rolbypassrls::text,",
        "       (n.nspowner = r.oid)::text AS schema_owner",
        "FROM pg_roles AS r",
        "JOIN pg_namespace AS n ON n.nspname = 'public'",
        "WHERE r.rolname = current_user;"
      ].join(" ")
    ],
    environment: { PGPASSWORD: context.runtimeCredential.password }
  });
  const [databaseName, roleName, superuser, createdb, bypassRls, schemaOwner] = output
    .trim()
    .split("|");
  assert.equal(databaseName, context.databaseName);
  assert.equal(roleName, context.runtimeCredential.username);
  assert.deepEqual(
    [superuser, createdb, bypassRls, schemaOwner],
    ["false", "false", "false", "false"]
  );
});
