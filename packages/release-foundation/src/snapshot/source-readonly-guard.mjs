import { canonicalJson } from "../canonical-json.mjs";
import { sha256Canonical } from "../digest.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const secretReferencePattern = /^secret:\/\/[a-z0-9][a-z0-9./_-]+$/;
const forbiddenStatementPattern =
  /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|MERGE|CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT|VACUUM|ANALYZE|REFRESH|REINDEX|CLUSTER|CALL|DO|SET|RESET|BEGIN|COMMIT|ROLLBACK|COPY\s+[^ (]+\s+FROM|nextval|setval|lo_import|pg_write_file|dblink_exec)\b/i;

function snapshotError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function immutable(value) {
  const clone = JSON.parse(canonicalJson(value));
  const freeze = (entry) => {
    if (entry && typeof entry === "object" && !Object.isFrozen(entry)) {
      Object.values(entry).forEach(freeze);
      Object.freeze(entry);
    }
    return entry;
  };
  return freeze(clone);
}

function assertTimestamp(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw snapshotError("SNAPSHOT_CLOCK_INVALID");
  }
}

export async function assertReadOnlySnapshotSource({
  source,
  secretReference,
  ownershipMap,
  now = new Date(),
  ...forbidden
}) {
  if (
    Object.keys(forbidden).length > 0 ||
    !secretReferencePattern.test(secretReference ?? "") ||
    source?.trustPolicy !== "protected-snapshot-source/v1" ||
    typeof source.observePrivileges !== "function"
  ) {
    throw snapshotError("SNAPSHOT_SOURCE_SECRET_REFERENCE_INVALID");
  }
  assertTimestamp(now);
  const privileges = await source.observePrivileges({ secretReference });
  const objectOwners = [...(privileges?.objectOwners ?? [])].sort();
  if (
    !digestPattern.test(privileges?.roleIdentityFingerprint ?? "") ||
    !digestPattern.test(privileges?.databaseIdentityFingerprint ?? "") ||
    privileges.superuser !== false ||
    privileges.createDatabase !== false ||
    privileges.createRole !== false ||
    privileges.bypassRls !== false ||
    privileges.schemaOwner !== false ||
    privileges.canCreateSchema !== false ||
    !Array.isArray(privileges.tableWritePrivileges) ||
    privileges.tableWritePrivileges.length > 0 ||
    !Array.isArray(privileges.tableTruncatePrivileges) ||
    privileges.tableTruncatePrivileges.length > 0 ||
    !Array.isArray(privileges.writableFunctionExecutePrivileges) ||
    privileges.writableFunctionExecutePrivileges.length > 0
  ) {
    throw snapshotError("SNAPSHOT_SOURCE_WRITE_CAPABILITY_FORBIDDEN");
  }
  if (
    !Array.isArray(privileges.objectOwners) ||
    new Set(objectOwners).size !== objectOwners.length ||
    objectOwners.length === 0 ||
    !Array.isArray(ownershipMap?.sourceOwners) ||
    objectOwners.some((owner) => !ownershipMap.sourceOwners.includes(owner))
  ) {
    throw snapshotError("SNAPSHOT_SOURCE_OWNER_UNMAPPED");
  }
  return immutable({
    schemaVersion: "source-privilege-observation.v1",
    secretReferenceFingerprint: sha256Canonical({ secretReference }),
    roleIdentityFingerprint: privileges.roleIdentityFingerprint,
    databaseIdentityFingerprint: privileges.databaseIdentityFingerprint,
    capabilities: {
      superuser: false,
      createDatabase: false,
      createRole: false,
      bypassRls: false,
      schemaOwner: false,
      canCreateSchema: false,
      tableWritePrivilegeCount: 0,
      tableTruncatePrivilegeCount: 0,
      writableFunctionExecutePrivilegeCount: 0,
      objectOwnerCount: objectOwners.length,
      objectOwnerSetDigest: sha256Canonical(objectOwners)
    },
    observedAt: now.toISOString()
  });
}

export function createReadOnlySourceExecutor(sourceSession) {
  if (typeof sourceSession?.execute !== "function") {
    throw snapshotError("SNAPSHOT_SOURCE_EXECUTOR_INVALID");
  }
  return Object.freeze({
    async execute(statement) {
      const normalized = typeof statement === "string" ? statement.trim() : "";
      const semicolonCount = (normalized.match(/;/g) ?? []).length;
      const allowedShape =
        /^SELECT\b[\s\S]*$/i.test(normalized) ||
        /^COPY\s*\(\s*SELECT\b[\s\S]*\)\s+TO\s+STDOUT(?:\s+WITH\b[\s\S]*)?$/i.test(normalized);
      if (
        !normalized ||
        /--|\/\*/.test(normalized) ||
        semicolonCount > (normalized.endsWith(";") ? 1 : 0) ||
        forbiddenStatementPattern.test(normalized) ||
        !allowedShape
      ) {
        throw snapshotError("SNAPSHOT_SOURCE_DML_FORBIDDEN");
      }
      return sourceSession.execute(normalized);
    }
  });
}

export async function fingerprintSourceSnapshot({
  source,
  snapshotId,
  keyTables,
  now = new Date()
}) {
  assertTimestamp(now);
  if (
    typeof source?.readFingerprint !== "function" ||
    typeof snapshotId !== "string" ||
    snapshotId.length === 0 ||
    !Array.isArray(keyTables) ||
    keyTables.length === 0 ||
    new Set(keyTables).size !== keyTables.length ||
    canonicalJson([...keyTables].sort()) !== canonicalJson(keyTables)
  ) {
    throw snapshotError("SNAPSHOT_SOURCE_FINGERPRINT_INVALID");
  }
  const observed = await source.readFingerprint({ snapshotId, keyTables });
  const tables = [...(observed?.tables ?? [])].sort((left, right) =>
    left.table.localeCompare(right.table)
  );
  if (
    !/^[0-9]{14}_[a-z0-9_]+$/.test(observed?.migrationHead ?? "") ||
    !digestPattern.test(observed?.databaseIdentityFingerprint ?? "") ||
    !digestPattern.test(observed?.roleIdentityFingerprint ?? "") ||
    canonicalJson(tables.map(({ table }) => table)) !== canonicalJson(keyTables) ||
    tables.some(
      ({ rowCount, checksum }) =>
        !Number.isInteger(rowCount) || rowCount < 0 || !digestPattern.test(checksum ?? "")
    )
  ) {
    throw snapshotError("SNAPSHOT_SOURCE_FINGERPRINT_INVALID");
  }
  return immutable({
    schemaVersion: "source-fingerprint.v1",
    identity: {
      snapshotIdFingerprint: sha256Canonical({ snapshotId }),
      migrationHead: observed.migrationHead,
      databaseIdentityFingerprint: observed.databaseIdentityFingerprint,
      roleIdentityFingerprint: observed.roleIdentityFingerprint,
      tables
    },
    provenance: { observedAt: now.toISOString() }
  });
}
