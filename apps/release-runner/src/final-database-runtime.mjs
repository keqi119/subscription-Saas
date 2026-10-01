// Read-only runtime observation after final envelope admission. This does not
// authorize a database connection, migration, suite execution or promotion.
import { sha256Canonical } from "../../../packages/release-foundation/src/digest.mjs";

const CODE = "DATABASE_TEST_TARGET_IDENTITY_MISMATCH";
const SQL = `
  SELECT d.datname::text AS "databaseName",
         d.oid::text AS "databaseOid",
         COALESCE(shobj_description(d.oid, 'pg_database'), '') AS "marker",
         pg_get_userbyid(d.datdba) AS "databaseOwner",
         (SELECT pg_get_userbyid(n.nspowner) FROM pg_namespace n
           WHERE n.nspname = 'public') AS "publicSchemaOwner",
         (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = '_prisma_migrations'
             AND c.relkind IN ('r', 'p')) AS "migrationTableOwner",
         current_user::text AS "role",
         COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS "tls",
         r.rolcanlogin AS "canLogin",
         r.rolsuper AS "superuser",
         r.rolcreatedb AS "createdb",
         r.rolcreaterole AS "createrole",
         r.rolinherit AS "inherit",
         r.rolreplication AS "replication",
         r.rolbypassrls AS "bypassrls",
         has_database_privilege(current_user, d.oid, 'CREATE') AS "canCreateDatabase",
         has_database_privilege(current_user, d.oid, 'TEMP') AS "canCreateTemporaryObjects",
         has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreatePublicSchema",
         EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid) AS "schemaOwner",
         (EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid)
           OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = r.oid)
           OR EXISTS (SELECT 1 FROM pg_type t WHERE t.typowner = r.oid)) AS "objectOwner",
         (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS "memberships",
         (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid = r.oid) AS "grantedTo"
    FROM pg_database d JOIN pg_roles r ON r.rolname = current_user
   WHERE d.datname = current_database()
`;
const FIELDS = [
  "databaseName",
  "databaseOid",
  "marker",
  "databaseOwner",
  "publicSchemaOwner",
  "migrationTableOwner",
  "role",
  "tls",
  "canLogin",
  "superuser",
  "createdb",
  "createrole",
  "inherit",
  "replication",
  "bypassrls",
  "canCreateDatabase",
  "canCreateTemporaryObjects",
  "canCreatePublicSchema",
  "schemaOwner",
  "objectOwner",
  "memberships",
  "grantedTo"
];

function mismatch(cause) {
  const error = Object.assign(new Error(CODE), { code: CODE });
  if (cause) Object.defineProperty(error, "cause", { value: cause });
  throw error;
}

export async function observeFinalRuntimeBoundary(database, target) {
  try {
    if (typeof database?.$queryRawUnsafe !== "function" || !target) mismatch();
    const rows = await database.$queryRawUnsafe(SQL);
    if (!Array.isArray(rows) || rows.length !== 1) mismatch();
    const row = rows[0];
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(FIELDS.slice().sort()) ||
      row.databaseName !== target.databaseName ||
      row.databaseOid !== target.databaseOid ||
      row.marker !== target.marker ||
      row.databaseOwner !== target.migrationRole ||
      row.publicSchemaOwner !== target.migrationRole ||
      row.migrationTableOwner !== target.migrationRole ||
      row.role !== target.runtimeRole ||
      row.tls !== true ||
      row.canLogin !== true ||
      row.memberships !== 0 ||
      row.grantedTo !== 0 ||
      [
        row.superuser,
        row.createdb,
        row.createrole,
        row.inherit,
        row.replication,
        row.bypassrls,
        row.canCreateDatabase,
        row.canCreateTemporaryObjects,
        row.canCreatePublicSchema,
        row.schemaOwner,
        row.objectOwner
      ].some((value) => value !== false) ||
      sha256Canonical({
        databaseName: row.databaseName,
        databaseOid: row.databaseOid,
        role: row.role,
        tls: row.tls
      }) !== target.databaseIdentityFingerprint
    )
      mismatch();
    return Object.freeze({
      identity: Object.freeze({ ...row }),
      roleBoundary: Object.freeze({
        roleAttributes: Object.freeze({
          superuser: row.superuser,
          createdb: row.createdb,
          createrole: row.createrole,
          bypassrls: row.bypassrls
        }),
        canCreateSchema: row.canCreateDatabase || row.canCreatePublicSchema,
        schemaOwner: row.schemaOwner,
        objectOwner: row.objectOwner
      })
    });
  } catch (error) {
    if (error?.code === CODE) throw error;
    mismatch(error);
  }
}
