// Internal adapter for an already admitted private PostgreSQL workspace.
// The caller owns resource creation, host admission and fixed native tool callbacks.
import { readFileSync } from "node:fs";
import { sha256Bytes, sha256Canonical } from "../digest.mjs";
import { transformRecord } from "./export-sanitized.mjs";

const MAX_BYTES = 1073741824;
const PAGE_SIZE = 250;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[a-z][a-z0-9_]*$/u;
const KEY_REFERENCE = "secret://stage1-snapshot-export/tokenization-key";
const IDENTITY_SQL = `SELECT current_database() AS database_name,
  (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
  (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
  pg_backend_pid() AS backend_pid, current_user AS role_name,
  (SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid`;
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const archiveValid = (bytes) =>
  Buffer.isBuffer(bytes) &&
  bytes.length >= 5 &&
  bytes.length <= MAX_BYTES &&
  bytes.subarray(0, 5).equals(Buffer.from("PGDMP"));

export function createPostgresSanitizationWorkspace({
  client,
  sourceDatabaseIdentityFingerprint,
  workspaceDatabaseIdentityFingerprint,
  tokenizationKey,
  restoreDump,
  exportDump,
  expandArchive,
  destroyResource
}) {
  if (
    typeof client?.query !== "function" ||
    typeof client?.end !== "function" ||
    !Number.isInteger(client.processID) ||
    client.processID <= 0 ||
    !DIGEST.test(sourceDatabaseIdentityFingerprint) ||
    !DIGEST.test(workspaceDatabaseIdentityFingerprint) ||
    !Buffer.isBuffer(tokenizationKey) ||
    tokenizationKey.length < 32 ||
    [restoreDump, exportDump, expandArchive, destroyResource].some(
      (value) => typeof value !== "function"
    )
  ) {
    fail("SNAPSHOT_WORKSPACE_INPUT_INVALID");
  }
  const contract = JSON.parse(
    readFileSync(
      new URL("../../../../release/contracts/sanitization-contract.v1.json", import.meta.url),
      "utf8"
    )
  );
  const key = Buffer.from(tokenizationKey);
  let state = "created",
    transactionOpen = false,
    pinnedIdentity,
    exportedDigest;
  const query = async (sql, values) => {
    try {
      const result = await client.query(sql, values);
      if (!Array.isArray(result?.rows)) fail("SNAPSHOT_WORKSPACE_QUERY_FAILED");
      return result;
    } catch {
      fail("SNAPSHOT_WORKSPACE_QUERY_FAILED");
    }
  };
  const assertIdentity = async () => {
    const { rows } = await query(IDENTITY_SQL);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.backend_pid !== client.processID ||
      typeof row.database_name !== "string" ||
      !/^\d+$/u.test(row.database_oid ?? "") ||
      !/^\d+$/u.test(row.system_identifier ?? "") ||
      !/^\d+$/u.test(row.role_oid ?? "") ||
      typeof row.role_name !== "string"
    )
      fail("SNAPSHOT_WORKSPACE_TARGET_INVALID");
    const fingerprint = sha256Canonical({
      databaseName: row.database_name,
      databaseOid: row.database_oid,
      systemIdentifier: row.system_identifier
    });
    const identity = sha256Canonical(row);
    if (
      fingerprint !== workspaceDatabaseIdentityFingerprint ||
      fingerprint === sourceDatabaseIdentityFingerprint ||
      (pinnedIdentity && identity !== pinnedIdentity)
    )
      fail("SNAPSHOT_WORKSPACE_TARGET_INVALID");
    pinnedIdentity ??= identity;
  };
  const destroy = async () => {
    if (state === "destroyed") return;
    if (state === "unknown") fail("SNAPSHOT_WORKSPACE_CLEANUP_UNKNOWN");
    let failed = false;
    state = "destroying";
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        failed = true;
      }
    }
    try {
      await client.end();
    } catch {
      failed = true;
    }
    try {
      if ((await destroyResource())?.removed !== true) failed = true;
    } catch {
      failed = true;
    }
    key.fill(0);
    state = failed ? "unknown" : "destroyed";
    if (failed) fail("SNAPSHOT_WORKSPACE_CLEANUP_UNKNOWN");
  };
  const operation = async (expectedState, run) => {
    try {
      if (state !== expectedState) fail("SNAPSHOT_WORKSPACE_STATE_INVALID");
      await assertIdentity();
      return await run();
    } catch (error) {
      await destroy();
      if (error?.code?.startsWith("SNAPSHOT_")) throw error;
      fail("SNAPSHOT_WORKSPACE_FAILED");
    }
  };
  return Object.freeze({
    trustPolicy: "isolated-sanitization-workspace/v1",
    restoreRaw: (archive) =>
      operation("created", async () => {
        if (!archiveValid(archive)) fail("SNAPSHOT_WORKSPACE_ARCHIVE_INVALID");
        const { rows } = await query(`SELECT count(*)::int AS relation_count FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')`);
        if (rows.length !== 1 || rows[0].relation_count !== 0) fail("SNAPSHOT_WORKSPACE_NOT_EMPTY");
        await restoreDump(Buffer.from(archive));
        await assertIdentity();
        state = "restored";
      }),
    applyTransformations: (request) =>
      operation("restored", async () => {
        if (
          request?.sourceDatabaseAccess !== "forbidden" ||
          request?.tokenizationSecretReference !== KEY_REFERENCE ||
          sha256Canonical(request?.contract) !== sha256Canonical(contract)
        )
          fail("SNAPSHOT_WORKSPACE_CONTRACT_INVALID");
        const tables = [...new Set(contract.transformations.map(({ table }) => table))].sort();
        transactionOpen = true;
        await query("BEGIN");
        for (const table of tables) {
          const [schema, name, extra] = table.split(".");
          const columns = [
            ...new Set(
              contract.transformations
                .filter((rule) => rule.table === table)
                .map(({ column }) => column)
            )
          ].sort();
          if (
            schema !== "public" ||
            extra ||
            !IDENTIFIER.test(name) ||
            columns.some((column) => !IDENTIFIER.test(column) || column === "id")
          ) {
            fail("SNAPSHOT_WORKSPACE_CONTRACT_INVALID");
          }
          const relation = `"public"."${name}"`;
          let lastId = null;
          for (;;) {
            const { rows } = await query(
              `SELECT id::text AS id, ${columns.map((column) => `"${column}"`).join(", ")}
            FROM ${relation} WHERE ($1::text IS NULL OR id::text COLLATE "C" > $1)
            ORDER BY id::text COLLATE "C" LIMIT ${PAGE_SIZE}`,
              [lastId]
            );
            if (rows.length > PAGE_SIZE) fail("SNAPSHOT_WORKSPACE_ROWS_INVALID");
            for (const row of rows) {
              if (
                typeof row?.id !== "string" ||
                (lastId !== null && row.id <= lastId) ||
                columns.some((column) => !Object.hasOwn(row, column))
              )
                fail("SNAPSHOT_WORKSPACE_ROWS_INVALID");
              const transformed = transformRecord(row, { table, contract, tokenizationKey: key });
              const result = await query(
                `UPDATE ${relation} SET ${columns.map((column, index) => `"${column}"=$${index + 1}`).join(", ")}
              WHERE id::text=$${columns.length + 1}`,
                [...columns.map((column) => transformed[column]), row.id]
              );
              if (result.rowCount !== 1) fail("SNAPSHOT_WORKSPACE_ROWS_INVALID");
              lastId = row.id;
            }
            if (rows.length < PAGE_SIZE) break;
          }
        }
        await assertIdentity();
        await query("COMMIT");
        transactionOpen = false;
        state = "transformed";
      }),
    exportSanitized: () =>
      operation("transformed", async () => {
        const archive = await exportDump();
        if (!archiveValid(archive)) fail("SNAPSHOT_WORKSPACE_ARCHIVE_INVALID");
        await assertIdentity();
        exportedDigest = sha256Bytes(archive);
        state = "exported";
        return Buffer.from(archive);
      }),
    expandSanitizedArchive: (input) =>
      operation("exported", async () => {
        if (
          !archiveValid(input?.archive) ||
          input.expectedArchiveDigest !== exportedDigest ||
          sha256Bytes(input.archive) !== exportedDigest ||
          input.maxExpandedBytes !== MAX_BYTES
        ) {
          fail("SNAPSHOT_WORKSPACE_ARCHIVE_INVALID");
        }
        return expandArchive(input);
      }),
    destroy
  });
}
