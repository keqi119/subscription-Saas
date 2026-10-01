import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { sha256Canonical } from "../digest.mjs";

const contractUrl = new URL(
  "../../../../release/contracts/sanitization-contract.v1.json",
  import.meta.url
);
const TABLE = /^public\.[a-z_][a-z0-9_]*$/u;
const SNAPSHOT = /^[0-9a-fA-F-]+$/u;
const PAGE_SIZE = 500;
const PGCRYPTO_FUNCTIONS = new Map([
  ["gen_salt|25|25", "pg_gen_salt"],
  ["gen_salt|25 23|25", "pg_gen_salt_rounds"],
  ["gen_random_bytes|23|17", "pg_random_bytes"],
  ["gen_random_uuid||2950", "pg_random_uuid"],
  ["pgp_sym_encrypt|25 25|17", "pgp_sym_encrypt_text"],
  ["pgp_sym_encrypt|25 25 25|17", "pgp_sym_encrypt_text"],
  ["pgp_sym_encrypt_bytea|17 25|17", "pgp_sym_encrypt_bytea"],
  ["pgp_sym_encrypt_bytea|17 25 25|17", "pgp_sym_encrypt_bytea"],
  ["pgp_pub_encrypt|25 17|17", "pgp_pub_encrypt_text"],
  ["pgp_pub_encrypt|25 17 25|17", "pgp_pub_encrypt_text"],
  ["pgp_pub_encrypt_bytea|17 17|17", "pgp_pub_encrypt_bytea"],
  ["pgp_pub_encrypt_bytea|17 17 25|17", "pgp_pub_encrypt_bytea"]
]);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function queryRows(result) {
  if (!result || !Array.isArray(result.rows)) fail("SNAPSHOT_SOURCE_QUERY_INVALID");
  return result.rows;
}

function single(result) {
  const rows = queryRows(result);
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") {
    fail("SNAPSHOT_SOURCE_QUERY_INVALID");
  }
  return rows[0];
}

function allowedTables() {
  const contract = JSON.parse(readFileSync(contractUrl, "utf8"));
  const names = contract?.source?.keyTables;
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => !TABLE.test(name))) {
    fail("SNAPSHOT_SOURCE_CONTRACT_INVALID");
  }
  return names;
}

const IDENTITY_SQL = `SELECT current_database() AS database_name,
  (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid,
  current_user AS current_role, session_user AS session_role,
  (SELECT oid::text FROM pg_roles WHERE rolname = current_user) AS role_oid,
  pg_backend_pid() AS backend_pid,
  (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier`;

const ROLE_SQL = `SELECT rolsuper AS superuser, rolcreatedb AS create_database,
  rolcreaterole AS create_role, rolbypassrls AS bypass_rls
  FROM pg_roles WHERE rolname = current_user`;

const OWNER_SQL = `WITH database_owner AS (
    SELECT role.rolname FROM pg_database db JOIN pg_roles role ON role.oid = db.datdba
    WHERE db.datname = current_database()
  )
  SELECT DISTINCT CASE WHEN owner.rolname = 'pg_database_owner'
    THEN database_owner.rolname ELSE owner.rolname END AS owner
  FROM (
    SELECT n.nspowner AS owner_oid FROM pg_namespace n
      WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
    UNION
    SELECT c.relowner AS owner_oid FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
    UNION
    SELECT p.proowner AS owner_oid FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
    UNION
    SELECT t.typowner AS owner_oid FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
  ) AS owned JOIN pg_roles owner ON owner.oid = owned.owner_oid
  CROSS JOIN database_owner
  ORDER BY owner`;

const SCHEMA_SQL = `WITH database_owner AS (
    SELECT role.rolname FROM pg_database db JOIN pg_roles role ON role.oid = db.datdba
    WHERE db.datname = current_database()
  )
  SELECT n.nspname AS schema_name,
  CASE WHEN owner.rolname = 'pg_database_owner'
    THEN database_owner.rolname ELSE owner.rolname END AS owner,
  has_schema_privilege(n.oid, 'CREATE') AS can_create
  FROM pg_namespace n JOIN pg_roles owner ON owner.oid = n.nspowner
  CROSS JOIN database_owner
  WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'`;

const TABLE_PRIVILEGE_SQL = `SELECT n.nspname AS schema_name, c.relname AS relation_name,
  has_any_column_privilege(c.oid, 'INSERT') AS can_insert,
  has_any_column_privilege(c.oid, 'UPDATE') AS can_update,
  has_table_privilege(c.oid, 'DELETE') AS can_delete,
  has_table_privilege(c.oid, 'TRUNCATE') AS can_truncate
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
    AND c.relkind IN ('r', 'p', 'v', 'f')`;

const SEQUENCE_PRIVILEGE_SQL = `SELECT n.nspname AS schema_name, c.relname AS sequence_name,
  has_sequence_privilege(c.oid, 'USAGE') AS can_use,
  has_sequence_privilege(c.oid, 'UPDATE') AS can_update
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
    AND c.relkind = 'S'`;

const FUNCTION_PRIVILEGE_SQL = `SELECT n.nspname AS schema_name, p.proname AS function_name,
  has_function_privilege(p.oid, 'EXECUTE') AS can_execute,
  p.provolatile AS volatility, p.prosecdef AS security_definer,
  p.prorettype = 'pg_catalog.trigger'::regtype AS trigger_return,
  p.prorettype = 'pg_catalog.event_trigger'::regtype AS event_trigger_return,
  p.proargtypes::text AS argument_type_oids, p.prorettype::text AS return_type_oid,
  language.lanname AS language, COALESCE(p.probin, '') AS library, p.prosrc AS symbol,
  EXISTS (
    SELECT 1 FROM pg_depend dependency
    JOIN pg_extension extension ON extension.oid = dependency.refobjid
    WHERE dependency.classid = 'pg_catalog.pg_proc'::regclass
      AND dependency.objid = p.oid AND dependency.objsubid = 0
      AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
      AND dependency.deptype = 'e' AND extension.extname = 'pgcrypto'
      AND extension.extversion = '1.3'
  ) AS pgcrypto_member
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language language ON language.oid = p.prolang
  WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'`;

export function createPostgresSnapshotSource({ client, exportDump } = {}) {
  if (
    typeof client?.query !== "function" ||
    typeof client?.end !== "function" ||
    !Number.isInteger(client.processID) ||
    client.processID <= 0 ||
    typeof exportDump !== "function"
  ) {
    fail("SNAPSHOT_SOURCE_CLIENT_INVALID");
  }
  let pinned;
  let snapshotId;
  let state = "ready";
  const query = async (sql, values) => {
    if (state === "closed") fail("SNAPSHOT_SOURCE_CLOSED");
    try {
      return await client.query(sql, values);
    } catch {
      fail("SNAPSHOT_SOURCE_QUERY_FAILED");
    }
  };
  const identity = async () => {
    const row = single(await query(IDENTITY_SQL));
    if (
      !Number.isInteger(row.backend_pid) ||
      row.backend_pid !== client.processID ||
      typeof row.database_name !== "string" ||
      !/^\d+$/u.test(row.database_oid ?? "") ||
      typeof row.current_role !== "string" ||
      typeof row.session_role !== "string" ||
      !/^\d+$/u.test(row.role_oid ?? "") ||
      !/^\d+$/u.test(row.system_identifier ?? "")
    ) {
      fail("SNAPSHOT_SOURCE_IDENTITY_INVALID");
    }
    const current = {
      databaseName: row.database_name,
      databaseOid: row.database_oid,
      roleName: row.current_role,
      sessionRole: row.session_role,
      roleOid: row.role_oid,
      systemIdentifier: row.system_identifier,
      backendPid: row.backend_pid
    };
    if (pinned && sha256Canonical(current) !== sha256Canonical(pinned)) {
      fail("SNAPSHOT_SOURCE_IDENTITY_DRIFT");
    }
    pinned ??= current;
    return {
      databaseIdentityFingerprint: sha256Canonical({
        databaseName: current.databaseName,
        databaseOid: current.databaseOid,
        systemIdentifier: current.systemIdentifier
      }),
      roleIdentityFingerprint: sha256Canonical({
        roleName: current.roleName,
        sessionRole: current.sessionRole,
        roleOid: current.roleOid
      })
    };
  };
  const requireSnapshot = async (requested) => {
    if (state !== "open" || requested !== snapshotId) fail("SNAPSHOT_SOURCE_SESSION_INVALID");
    return identity();
  };
  const close = async () => {
    if (state === "closed") return;
    if (state === "unknown") fail("SNAPSHOT_SOURCE_CLEANUP_UNKNOWN");
    const rollback = state === "open";
    state = "closing";
    let uncertain = false;
    if (rollback) {
      try {
        await client.query("ROLLBACK");
      } catch {
        uncertain = true;
      }
    }
    try {
      await client.end();
    } catch {
      uncertain = true;
    }
    state = uncertain ? "unknown" : "closed";
    if (uncertain) fail("SNAPSHOT_SOURCE_CLEANUP_UNKNOWN");
  };
  const protectedCall = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      await close();
      if (typeof error?.code === "string" && error.code.startsWith("SNAPSHOT_SOURCE_")) {
        throw error;
      }
      fail("SNAPSHOT_SOURCE_FAILED");
    }
  };
  const source = {
    trustPolicy: "protected-snapshot-source/v1",
    async observePrivileges() {
      if (state !== "ready") fail("SNAPSHOT_SOURCE_SESSION_INVALID");
      const ids = await identity();
      const role = single(await query(ROLE_SQL));
      const owners = await query(OWNER_SQL);
      const schemas = await query(SCHEMA_SQL);
      const tables = await query(TABLE_PRIVILEGE_SQL);
      const sequences = await query(SEQUENCE_PRIVILEGE_SQL);
      const functions = await query(FUNCTION_PRIVILEGE_SQL);
      const database = await query(
        "SELECT has_database_privilege(current_database(), 'CREATE') AS can_create"
      );
      await identity();
      const schemaRows = queryRows(schemas);
      const write = queryRows(tables).flatMap((row) =>
        ["can_insert", "can_update", "can_delete"]
          .filter((key) => row[key] === true)
          .map((key) => `${row.schema_name}.${row.relation_name}:${key}`)
      );
      for (const row of queryRows(sequences)) {
        if (row.can_use || row.can_update)
          write.push(`${row.schema_name}.${row.sequence_name}:sequence`);
      }
      const truncate = queryRows(tables)
        .filter((row) => row.can_truncate === true)
        .map((row) => `${row.schema_name}.${row.relation_name}`);
      const knownBooleans = (row, keys) => keys.every((key) => typeof row[key] === "boolean");
      if (
        !knownBooleans(role, ["superuser", "create_database", "create_role", "bypass_rls"]) ||
        !knownBooleans(single(database), ["can_create"]) ||
        schemaRows.some((row) => !knownBooleans(row, ["can_create"])) ||
        queryRows(tables).some(
          (row) => !knownBooleans(row, ["can_insert", "can_update", "can_delete", "can_truncate"])
        ) ||
        queryRows(sequences).some((row) => !knownBooleans(row, ["can_use", "can_update"])) ||
        queryRows(functions).some(
          (row) =>
            !knownBooleans(row, [
              "can_execute",
              "security_definer",
              "trigger_return",
              "event_trigger_return",
              "pgcrypto_member"
            ]) ||
            !["i", "s", "v"].includes(row.volatility) ||
            [
              "schema_name",
              "function_name",
              "argument_type_oids",
              "return_type_oid",
              "language",
              "library",
              "symbol"
            ].some((key) => typeof row[key] !== "string")
        )
      ) {
        fail("SNAPSHOT_SOURCE_CAPABILITY_UNKNOWN");
      }
      for (const row of [
        ...schemaRows,
        ...queryRows(tables),
        ...queryRows(sequences),
        ...queryRows(functions)
      ]) {
        if (Object.values(row).some((value) => value === null || value === undefined)) {
          fail("SNAPSHOT_SOURCE_CAPABILITY_UNKNOWN");
        }
      }
      const noWriteCapability =
        !role.superuser &&
        !role.create_database &&
        !role.create_role &&
        !role.bypass_rls &&
        !single(database).can_create &&
        !schemaRows.some((row) => row.can_create || row.owner === pinned.roleName) &&
        write.length === 0 &&
        truncate.length === 0;
      const executable = queryRows(functions)
        .filter((row) => row.can_execute && (row.volatility === "v" || row.security_definer))
        .filter((row) => {
          if (row.security_definer) return true;
          if (noWriteCapability && (row.trigger_return || row.event_trigger_return)) return false;
          const signature = `${row.function_name}|${row.argument_type_oids}|${row.return_type_oid}`;
          return !(
            row.pgcrypto_member &&
            row.language === "c" &&
            row.library === "$libdir/pgcrypto" &&
            PGCRYPTO_FUNCTIONS.get(signature) === row.symbol
          );
        })
        .map((row) => `${row.schema_name}.${row.function_name}`);
      return {
        ...ids,
        superuser: role.superuser,
        createDatabase: role.create_database,
        createRole: role.create_role,
        bypassRls: role.bypass_rls,
        schemaOwner: schemaRows.some((row) => row.owner === pinned.roleName),
        canCreateSchema:
          single(database).can_create === true || schemaRows.some((row) => row.can_create === true),
        tableWritePrivileges: write,
        tableTruncatePrivileges: truncate,
        writableFunctionExecutePrivileges: executable,
        objectOwners: queryRows(owners).map((row) => row.owner)
      };
    },
    async openReadOnlySnapshot() {
      if (state !== "ready" || !pinned) fail("SNAPSHOT_SOURCE_SESSION_INVALID");
      await identity();
      state = "open";
      await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const settings = single(
        await query(
          "SELECT current_setting('transaction_isolation') AS isolation_level, current_setting('transaction_read_only') AS read_only"
        )
      );
      if (settings.isolation_level !== "repeatable read" || settings.read_only !== "on") {
        fail("SNAPSHOT_SOURCE_TRANSACTION_INVALID");
      }
      await identity();
      const row = single(await query("SELECT pg_export_snapshot() AS snapshot_id"));
      if (typeof row.snapshot_id !== "string" || !SNAPSHOT.test(row.snapshot_id)) {
        fail("SNAPSHOT_SOURCE_TRANSACTION_INVALID");
      }
      snapshotId = row.snapshot_id;
      return { snapshotId, isolationLevel: "REPEATABLE READ", readOnly: true, deferrable: false };
    },
    async readFingerprint({ snapshotId: requested, keyTables } = {}) {
      const ids = await requireSnapshot(requested);
      const allowed = allowedTables();
      if (!Array.isArray(keyTables) || JSON.stringify(keyTables) !== JSON.stringify(allowed)) {
        fail("SNAPSHOT_SOURCE_TABLES_INVALID");
      }
      const migration = single(
        await query(`SELECT migration_name FROM public._prisma_migrations
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
          ORDER BY finished_at DESC, migration_name DESC LIMIT 1`)
      );
      if (!/^[0-9]{14}_[a-z0-9_]+$/u.test(migration.migration_name ?? "")) {
        fail("SNAPSHOT_SOURCE_MIGRATION_INVALID");
      }
      const tables = [];
      for (const table of allowed) {
        const name = table.slice("public.".length);
        const hash = createHash("sha256");
        let rowCount = 0;
        let lastId = null;
        for (;;) {
          const rows = queryRows(
            await query(
              `SELECT id::text AS id, row_to_json(t)::text AS record
               FROM "public"."${name}" AS t
               WHERE ($1::text IS NULL OR id::text COLLATE "C" > $1)
               ORDER BY id::text COLLATE "C" LIMIT ${PAGE_SIZE}`,
              [lastId]
            )
          );
          if (rows.length > PAGE_SIZE) fail("SNAPSHOT_SOURCE_FINGERPRINT_INVALID");
          for (const row of rows) {
            if (
              typeof row.id !== "string" ||
              typeof row.record !== "string" ||
              (lastId !== null && row.id <= lastId)
            ) {
              fail("SNAPSHOT_SOURCE_FINGERPRINT_INVALID");
            }
            const bytes = Buffer.from(row.record, "utf8");
            hash.update(`${bytes.length}:`).update(bytes);
            lastId = row.id;
            rowCount += 1;
            if (!Number.isSafeInteger(rowCount)) fail("SNAPSHOT_SOURCE_FINGERPRINT_INVALID");
          }
          if (rows.length < PAGE_SIZE) break;
        }
        tables.push({ table, rowCount, checksum: `sha256:${hash.digest("hex")}` });
      }
      await requireSnapshot(requested);
      return { ...ids, migrationHead: migration.migration_name, tables };
    },
    async exportRaw({ snapshotId: requested } = {}) {
      const ids = await requireSnapshot(requested);
      let dump;
      try {
        dump = await exportDump({
          snapshotId,
          databaseName: pinned.databaseName,
          databaseOid: pinned.databaseOid,
          roleName: pinned.roleName,
          ...ids
        });
      } catch {
        fail("SNAPSHOT_SOURCE_EXPORT_FAILED");
      }
      await requireSnapshot(requested);
      if (
        !Buffer.isBuffer(dump) ||
        dump.length > 1073741824 ||
        !dump.subarray(0, 5).equals(Buffer.from("PGDMP"))
      ) {
        fail("SNAPSHOT_SOURCE_EXPORT_INVALID");
      }
      return Buffer.from(dump);
    },
    closeSnapshot: close
  };
  return Object.freeze({
    trustPolicy: source.trustPolicy,
    observePrivileges: (...args) => protectedCall(() => source.observePrivileges(...args)),
    openReadOnlySnapshot: (...args) => protectedCall(() => source.openReadOnlySnapshot(...args)),
    readFingerprint: (...args) => protectedCall(() => source.readFingerprint(...args)),
    exportRaw: (...args) => protectedCall(() => source.exportRaw(...args)),
    closeSnapshot: close
  });
}
