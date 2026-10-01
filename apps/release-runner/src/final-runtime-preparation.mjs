// Final-image schema preparation after independently accepted base-schema
// verification. Runtime passwords and seed DML never enter this capability.
import { grantRuntimeEquivalentAccess } from "../../../packages/release-foundation/src/database-roles.mjs";
import { runSchemaFixture } from "../../../packages/release-foundation/src/node-database-test-runner.mjs";
import { sha256Canonical } from "../../../packages/release-foundation/src/digest.mjs";
import { validateFinalMigrationInput } from "./final-migration-input.mjs";

const CODE = "R3_FINAL_RUNTIME_PREPARATION_FAILED";
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (value) => {
  if (!value) fail();
};
const same = (a, b) => sha256Canonical(a) === sha256Canonical(b);
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
const SQL = `SELECT d.datname::text AS "databaseName", d.oid::text AS "databaseOid",
  COALESCE(shobj_description(d.oid,'pg_database'),'') AS marker,
  current_user::text AS "migrationRole", pg_get_userbyid(d.datdba) AS "databaseOwner",
  (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='public') AS "schemaOwner",
  EXISTS(SELECT 1 FROM pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl) AS tls,
  r.rolname::text AS "runtimeRole", r.rolcanlogin AS "canLogin", r.rolsuper AS superuser,
  r.rolcreatedb AS createdb, r.rolcreaterole AS createrole, r.rolinherit AS inherit,
  r.rolreplication AS replication, r.rolbypassrls AS bypassrls,
  (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships,
  (SELECT count(*)::int FROM pg_auth_members WHERE roleid=r.oid) AS "grantedTo",
  has_database_privilege(r.oid,d.oid,'CREATE') AS "canCreateDatabase",
  has_database_privilege(r.oid,d.oid,'TEMP') AS "canCreateTemporaryObjects",
  has_schema_privilege(r.oid,'public','CREATE') AS "canCreatePublicSchema",
  EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid) AS "schemaOwnerRuntime",
  (EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid) OR
   EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid) OR
   EXISTS(SELECT 1 FROM pg_type WHERE typowner=r.oid)) AS "objectOwnerRuntime",
  has_schema_privilege(r.oid,'public','USAGE') AS "canUsePublic"
  FROM pg_database d CROSS JOIN pg_roles r WHERE d.datname=current_database() AND r.rolname=$1`;
const forbidden = [
  "superuser",
  "createdb",
  "createrole",
  "inherit",
  "replication",
  "bypassrls",
  "canCreateDatabase",
  "canCreateTemporaryObjects",
  "canCreatePublicSchema",
  "schemaOwnerRuntime",
  "objectOwnerRuntime"
];
function identity(row, held, after = false) {
  const db = held.input.database;
  need(
    exact(row, [
      "databaseName",
      "databaseOid",
      "marker",
      "migrationRole",
      "databaseOwner",
      "schemaOwner",
      "tls",
      "runtimeRole",
      "canLogin",
      "memberships",
      "grantedTo",
      "canUsePublic",
      ...forbidden
    ]) &&
      ["databaseName", "databaseOid", "marker", "migrationRole"].every(
        (key) => row[key] === db[key]
      ) &&
      row.databaseOwner === db.migrationRole &&
      row.schemaOwner === db.migrationRole &&
      row.tls === true &&
      row.runtimeRole === held.runtimeRole &&
      row.canLogin === true &&
      row.memberships === 0 &&
      row.grantedTo === 0 &&
      forbidden.every((key) => row[key] === false) &&
      typeof row.canUsePublic === "boolean" &&
      (!after || row.canUsePublic)
  );
}
async function operations(held, repoRoot) {
  const statements = [];
  await grantRuntimeEquivalentAccess({
    databaseName: held.input.database.databaseName,
    migrationRole: held.input.database.migrationRole,
    runtimeRole: held.runtimeRole,
    executeDatabase: async ({ databaseName, sql }) => {
      need(databaseName === held.input.database.databaseName);
      statements.push(sql);
    }
  });
  const schemaFixture = held.schemaFixturePath
    ? await runSchemaFixture({
        repoRoot,
        runtimeRole: held.runtimeRole,
        fixturePath: held.schemaFixturePath,
        credentialRef: held.migrationSecretReference,
        credentialFingerprint: held.input.database.migrationCredentialFingerprint,
        counterpartCredentialFingerprint: held.input.database.runtimeCredentialFingerprint,
        executeSql: async ({ sql }) => {
          statements.push(sql);
        }
      })
    : null;
  // This function plans only. A fixture observation becomes an execution fact
  // only when every fixed statement below has completed in the transaction.
  return { statements, schemaFixture };
}

export async function prepareFinalRuntimeDatabase({
  input,
  manifest,
  migrationCatalog,
  globalObjectPolicy,
  database,
  signal,
  repoRoot = "/app"
}) {
  const originals = { executions: [] };
  try {
    const held = validateFinalMigrationInput({
      input,
      manifest,
      migrationCatalog,
      globalObjectPolicy
    });
    const live = () => need(signal?.addEventListener && !signal.aborted);
    live();
    need(typeof database?.$transaction === "function");
    const plan = await operations(held, repoRoot);
    live();
    await database.$transaction(async (transaction) => {
      live();
      const rows = await transaction.$queryRawUnsafe(SQL, held.runtimeRole);
      need(Array.isArray(rows) && rows.length === 1);
      originals.before = structuredClone(rows[0]);
      identity(originals.before, held);
      for (const sql of plan.statements) {
        live();
        const result = await transaction.$executeRawUnsafe(sql);
        originals.executions.push({ sql, result });
        need(Number.isSafeInteger(result) && result >= 0);
      }
      live();
      const after = await transaction.$queryRawUnsafe(SQL, held.runtimeRole);
      need(Array.isArray(after) && after.length === 1);
      originals.after = structuredClone(after[0]);
      identity(originals.after, held, true);
      live();
    });
    live();
    return freeze({
      schemaVersion: "r3-final-runtime-preparation.v1",
      bindingDigest: sha256Canonical(held.input),
      runtimeRole: held.runtimeRole,
      schemaFixture: plan.schemaFixture,
      ...originals
    });
  } catch (cause) {
    const error = Object.assign(new Error(CODE), { code: CODE });
    Object.defineProperties(error, {
      cause: { value: cause },
      originals: { value: freeze(originals) }
    });
    throw error;
  }
}

// Independent reconstruction from the fixed image/repository manifest. The H1
// holder must additionally authenticate container, input and physical target.
export async function assessFinalRuntimePreparation({
  input,
  manifest,
  migrationCatalog,
  globalObjectPolicy,
  preparation,
  repoRoot = "/app"
}) {
  try {
    const held = validateFinalMigrationInput({
      input,
      manifest,
      migrationCatalog,
      globalObjectPolicy
    });
    preparation = structuredClone(preparation);
    const plan = await operations(held, repoRoot);
    need(
      exact(preparation, [
        "schemaVersion",
        "bindingDigest",
        "runtimeRole",
        "schemaFixture",
        "executions",
        "before",
        "after"
      ]) &&
        preparation.schemaVersion === "r3-final-runtime-preparation.v1" &&
        preparation.bindingDigest === sha256Canonical(held.input) &&
        preparation.runtimeRole === held.runtimeRole &&
        same(preparation.schemaFixture, plan.schemaFixture) &&
        Array.isArray(preparation.executions) &&
        preparation.executions.length === plan.statements.length
    );
    for (const [index, entry] of preparation.executions.entries())
      need(
        exact(entry, ["sql", "result"]) &&
          entry.sql === plan.statements[index] &&
          Number.isSafeInteger(entry.result) &&
          entry.result >= 0
      );
    identity(preparation.before, held);
    identity(preparation.after, held, true);
    return freeze({
      preparationDigest: sha256Canonical(preparation),
      runtimeRole: held.runtimeRole,
      schemaFixture: preparation.schemaFixture
    });
  } catch {
    fail();
  }
}
