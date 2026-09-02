import { canonicalJson } from "./canonical-json.mjs";
import { sha256Canonical, sha256Text } from "./digest.mjs";
import { sqlIdentifier, sqlLiteral } from "./database-roles.mjs";
import { assertApprovedEphemeralTarget, suiteDatabaseName } from "./database-target.mjs";

function lifecycleError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function roleNames(databaseName, enableRestore = false) {
  const suffix = sha256Text(databaseName).slice(0, 24);
  return {
    migrate: `s1m_${suffix}`,
    "runtime-test": `s1r_${suffix}`,
    ...(enableRestore ? { restore: `s1x_${suffix}` } : {})
  };
}

function assertSecret(secret, expectedUsername, profile) {
  if (
    secret?.username !== expectedUsername ||
    typeof secret?.password !== "string" ||
    secret.password.length < 16 ||
    typeof secret?.reference !== "string" ||
    secret.reference.length === 0 ||
    /postgres(?:ql)?:\/\//i.test(secret.reference)
  ) {
    throw lifecycleError("DATABASE_SECRET_REFERENCE_INVALID", { profile });
  }
}

function markerFor({ policy, runId, suiteId, shard, createdAt }) {
  return canonicalJson({
    markerVersion: policy.requiredEphemeralMarker,
    runIdDigest: sha256Canonical(runId),
    suiteIdDigest: sha256Canonical(suiteId),
    shard,
    createdAt
  });
}

async function rollbackPartial({ executeAdmin, databaseName, roles, databaseCreated }) {
  const statements = [];
  if (databaseCreated) {
    statements.push(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlLiteral(databaseName)} AND pid <> pg_backend_pid();`,
      `DROP DATABASE IF EXISTS ${sqlIdentifier(databaseName)};`
    );
  }
  statements.push(
    ...(roles.restore ? [`DROP ROLE IF EXISTS ${sqlIdentifier(roles.restore)};`] : []),
    `DROP ROLE IF EXISTS ${sqlIdentifier(roles["runtime-test"])};`,
    `DROP ROLE IF EXISTS ${sqlIdentifier(roles.migrate)};`
  );
  await executeAdmin({ databaseName: "postgres", sql: statements.join("\n") });
}

export async function provisionSuiteDatabase({
  target,
  policy,
  runId,
  suiteId,
  shard,
  now = () => new Date(),
  executeAdmin,
  secretStore,
  enableRestore = false
}) {
  assertApprovedEphemeralTarget(target, policy);
  if (!executeAdmin || !secretStore?.create)
    throw lifecycleError("DATABASE_PROVISION_INPUT_INVALID");
  const databaseName = suiteDatabaseName(runId, suiteId, shard);
  if (!new RegExp(policy.databaseNamePattern).test(databaseName)) {
    throw lifecycleError("DATABASE_NAME_POLICY_MISMATCH");
  }
  const roles = roleNames(databaseName, enableRestore);
  const migrateSecret = await secretStore.create({
    profile: "migrate",
    databaseName,
    username: roles.migrate
  });
  const runtimeSecret = await secretStore.create({
    profile: "runtime-test",
    databaseName,
    username: roles["runtime-test"]
  });
  const restoreSecret = enableRestore
    ? await secretStore.create({
        profile: "restore",
        databaseName,
        username: roles.restore
      })
    : undefined;
  assertSecret(migrateSecret, roles.migrate, "migrate");
  assertSecret(runtimeSecret, roles["runtime-test"], "runtime-test");
  if (enableRestore) assertSecret(restoreSecret, roles.restore, "restore");
  const createdAt = now().toISOString();
  const marker = markerFor({ policy, runId, suiteId, shard, createdAt });
  let databaseCreated = false;
  try {
    await executeAdmin({
      databaseName: "postgres",
      sql: [
        `CREATE ROLE ${sqlIdentifier(roles.migrate)} LOGIN PASSWORD ${sqlLiteral(migrateSecret.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
        `CREATE ROLE ${sqlIdentifier(roles["runtime-test"])} LOGIN PASSWORD ${sqlLiteral(runtimeSecret.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
        ...(enableRestore
          ? [
              `CREATE ROLE ${sqlIdentifier(roles.restore)} LOGIN PASSWORD ${sqlLiteral(restoreSecret.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`
            ]
          : []),
        `CREATE DATABASE ${sqlIdentifier(databaseName)} OWNER ${sqlIdentifier(roles.migrate)};`
      ].join("\n")
    });
    databaseCreated = true;
    await executeAdmin({
      databaseName: "postgres",
      sql: [
        `COMMENT ON DATABASE ${sqlIdentifier(databaseName)} IS ${sqlLiteral(marker)};`,
        `REVOKE CONNECT ON DATABASE ${sqlIdentifier(databaseName)} FROM PUBLIC;`,
        `GRANT CONNECT ON DATABASE ${sqlIdentifier(databaseName)} TO ${[
          sqlIdentifier(roles.migrate),
          sqlIdentifier(roles["runtime-test"]),
          ...(enableRestore ? [sqlIdentifier(roles.restore)] : [])
        ].join(", ")};`
      ].join("\n")
    });
    await executeAdmin({
      databaseName,
      sql: [
        `ALTER SCHEMA public OWNER TO ${sqlIdentifier(roles.migrate)};`,
        "REVOKE CREATE ON SCHEMA public FROM PUBLIC;"
      ].join("\n")
    });
    const identity = await executeAdmin({
      databaseName: "postgres",
      sql: [
        "SELECT d.oid::text AS oid,",
        "       COALESCE(shobj_description(d.oid, 'pg_database'), '') AS marker",
        "FROM pg_database AS d",
        `WHERE d.datname = ${sqlLiteral(databaseName)};`
      ].join(" ")
    });
    const row = identity?.rows?.[0];
    if (!/^[0-9]+$/.test(row?.oid ?? "") || row?.marker !== marker) {
      throw lifecycleError("DATABASE_PROVISION_IDENTITY_MISMATCH");
    }
    const record = {
      recordVersion: "provisioned-database.v1",
      targetFingerprint: target.clusterFingerprint,
      databaseName,
      databaseOid: row.oid,
      marker,
      runId,
      suiteId,
      shard,
      roles,
      secretReferences: {
        migrate: migrateSecret.reference,
        "runtime-test": runtimeSecret.reference,
        ...(enableRestore ? { restore: restoreSecret.reference } : {})
      },
      createdAt
    };
    const serialized = JSON.stringify(record);
    if (/"password"\s*:|postgres(?:ql)?:\/\//i.test(serialized)) {
      throw lifecycleError("DATABASE_PROVISION_RECORD_CONTAINS_SECRET");
    }
    return Object.freeze(record);
  } catch (error) {
    try {
      await rollbackPartial({ executeAdmin, databaseName, roles, databaseCreated });
    } catch {
      throw lifecycleError("DATABASE_PROVISION_ROLLBACK_FAILED", { causeCode: error?.code });
    }
    throw error;
  }
}

export async function cleanupSuiteDatabase(record, { target, policy, executeAdmin }) {
  assertApprovedEphemeralTarget(target, policy);
  if (!executeAdmin || record?.recordVersion !== "provisioned-database.v1") {
    throw lifecycleError("CLEANUP_IDENTITY_MISMATCH");
  }
  const expectedName = suiteDatabaseName(record.runId, record.suiteId, record.shard);
  const expectedRoles = roleNames(expectedName, Boolean(record.roles?.restore));
  if (
    record.databaseName !== expectedName ||
    record.targetFingerprint !== target.clusterFingerprint ||
    record.roles?.migrate !== expectedRoles.migrate ||
    record.roles?.["runtime-test"] !== expectedRoles["runtime-test"] ||
    record.roles?.restore !== expectedRoles.restore ||
    (record.roles?.restore
      ? typeof record.secretReferences?.restore !== "string"
      : record.secretReferences?.restore !== undefined) ||
    !/^[0-9]+$/.test(record.databaseOid ?? "") ||
    typeof record.marker !== "string"
  ) {
    throw lifecycleError("CLEANUP_IDENTITY_MISMATCH");
  }
  const identity = await executeAdmin({
    databaseName: "postgres",
    sql: [
      "SELECT d.oid::text AS oid,",
      "       COALESCE(shobj_description(d.oid, 'pg_database'), '') AS marker",
      "FROM pg_database AS d",
      `WHERE d.datname = ${sqlLiteral(record.databaseName)};`
    ].join(" ")
  });
  const row = identity?.rows?.[0];
  if (row?.oid !== record.databaseOid || row?.marker !== record.marker) {
    throw lifecycleError("CLEANUP_IDENTITY_MISMATCH");
  }
  await executeAdmin({
    databaseName: "postgres",
    sql: [
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlLiteral(record.databaseName)} AND pid <> pg_backend_pid();`,
      `DROP DATABASE ${sqlIdentifier(record.databaseName)};`,
      ...(record.roles.restore ? [`DROP ROLE ${sqlIdentifier(record.roles.restore)};`] : []),
      `DROP ROLE ${sqlIdentifier(record.roles["runtime-test"])};`,
      `DROP ROLE ${sqlIdentifier(record.roles.migrate)};`
    ].join("\n")
  });
}
