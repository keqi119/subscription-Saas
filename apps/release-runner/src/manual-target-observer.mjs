import {
  computeManualClusterFingerprint,
  encodeManualJson,
  sha256Canonical,
  validateContract,
  validateManualRunnerRequest
} from "@subscription-saas/release-foundation";

import { runnerError } from "./error-codes.mjs";

const SET_READONLY_RR = "SET TRANSACTION READ ONLY, ISOLATION LEVEL REPEATABLE READ";

function one(rows) {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") {
    throw runnerError("MANUAL_TARGET_OBSERVATION_UNAVAILABLE");
  }
  return rows[0];
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw runnerError("MANUAL_TARGET_OBSERVATION_UNAVAILABLE");
  return date.toISOString();
}

function equal(left, right) {
  return sha256Canonical(left) === sha256Canonical(right);
}

function assertContext(request, endpointPolicy, approved) {
  if (
    !approved ||
    !approved.targetIntent ||
    !endpointPolicy ||
    approved.contextVersion !== "manual-h3-target-context.v1" ||
    approved.profileDigest !== request.profileDigest ||
    approved.runId !== request.runId ||
    !equal(approved.targetIntent, request.targetIntent) ||
    !equal(
      {
        endpointPolicyId: endpointPolicy.endpointPolicyId,
        databaseName: endpointPolicy.databaseName
      },
      request.targetIntent
    ) ||
    endpointPolicy?.tls !== "required" ||
    !approved.h3Approval?.digest ||
    !approved.h3Readback?.digest ||
    !approved.databaseOid
  ) {
    throw runnerError("MANUAL_CLUSTER_IDENTITY_MISMATCH");
  }
  const clusterFingerprint = computeManualClusterFingerprint(approved.cluster);
  if (
    request.stage === "runner-command" &&
    (request.physicalIdentity.databaseOid !== approved.databaseOid ||
      request.physicalIdentity.clusterFingerprint !== clusterFingerprint)
  )
    throw runnerError("MANUAL_CLUSTER_IDENTITY_MISMATCH");
  return clusterFingerprint;
}

export async function observeManualTarget({
  request,
  database,
  endpointPolicy,
  approvedClusterObservation
}) {
  validateManualRunnerRequest(request);
  const expectedClusterFingerprint = assertContext(
    request,
    endpointPolicy,
    approvedClusterObservation
  );
  if (typeof database?.$transaction !== "function") {
    throw runnerError("RUNNER_DATABASE_ADAPTER_UNAVAILABLE");
  }
  const expectedRole =
    request.stage === "target-observe"
      ? endpointPolicy.roles?.observer
      : endpointPolicy.roles?.[request.capability];
  if (
    !expectedRole ||
    (request.stage === "runner-command" && request.roleObservation.role !== expectedRole)
  ) {
    throw runnerError("MANUAL_CLUSTER_IDENTITY_MISMATCH");
  }

  const observed = await database.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(SET_READONLY_RR);
    const isolation = one(await tx.$queryRawUnsafe("SHOW transaction_isolation"));
    const readOnly = one(await tx.$queryRawUnsafe("SHOW transaction_read_only"));
    if (
      isolation.transaction_isolation !== "repeatable read" ||
      readOnly.transaction_read_only !== "on"
    ) {
      throw runnerError("MANUAL_READONLY_TRANSACTION_UNVERIFIED");
    }
    const system = one(
      await tx.$queryRawUnsafe(
        'SELECT system_identifier::text AS "systemIdentifier" FROM pg_control_system()'
      )
    );
    const identity = one(
      await tx.$queryRawUnsafe(`
      SELECT host(inet_server_addr())::text AS "serverAddress",
             inet_server_port() AS "serverPort",
             current_database()::text AS "databaseName",
             (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS "databaseOid",
             current_user::text AS role,
             EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid = pg_backend_pid() AND ssl = TRUE) AS tls
    `)
    );
    const actualCluster = {
      ...approvedClusterObservation.cluster,
      systemIdentifier: String(system.systemIdentifier),
      serverAddress: identity.serverAddress,
      serverPort: Number(identity.serverPort)
    };
    let actualFingerprint;
    try {
      actualFingerprint = computeManualClusterFingerprint(actualCluster);
    } catch {
      throw runnerError("MANUAL_CLUSTER_IDENTITY_MISMATCH");
    }
    if (
      actualFingerprint !== expectedClusterFingerprint ||
      identity.databaseName !== request.targetIntent.databaseName ||
      String(identity.databaseOid) !== approvedClusterObservation.databaseOid ||
      identity.role !== expectedRole ||
      identity.tls !== true
    )
      throw runnerError("MANUAL_CLUSTER_IDENTITY_MISMATCH");
    const physicalIdentity = {
      endpointPolicyId: endpointPolicy.endpointPolicyId,
      databaseName: identity.databaseName,
      databaseOid: String(identity.databaseOid),
      clusterFingerprint: actualFingerprint
    };
    if (request.stage === "runner-command" && !equal(request.physicalIdentity, physicalIdentity)) {
      throw runnerError("MANUAL_CLUSTER_IDENTITY_MISMATCH");
    }

    const table = one(
      await tx.$queryRawUnsafe("SELECT to_regclass('public._prisma_migrations')::oid::text AS oid")
    );
    const migrationTableOid = table.oid === null ? null : String(table.oid);
    const rows =
      migrationTableOid === null
        ? []
        : await tx.$queryRawUnsafe(`
      SELECT id::text AS id, migration_name::text AS "migrationName",
             checksum::text AS checksum, started_at AS "startedAt",
             finished_at AS "finishedAt", rolled_back_at AS "rolledBackAt",
             applied_steps_count AS "appliedStepsCount"
      FROM "public"."_prisma_migrations"
      ORDER BY started_at, migration_name, id
    `);
    if (!Array.isArray(rows)) throw runnerError("MANUAL_TARGET_OBSERVATION_UNAVAILABLE");
    const migrationRows = rows.map((row) => ({
      id: row.id,
      migrationName: row.migrationName,
      checksum: String(row.checksum).startsWith("sha256:")
        ? row.checksum
        : `sha256:${row.checksum}`,
      startedAt: timestamp(row.startedAt),
      finishedAt: row.finishedAt === null ? null : timestamp(row.finishedAt),
      rolledBackAt: row.rolledBackAt === null ? null : timestamp(row.rolledBackAt),
      appliedStepsCount: Number(row.appliedStepsCount)
    }));
    const owner = one(
      await tx.$queryRawUnsafe(
        "SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'public'"
      )
    );
    const inventory = await tx.$queryRawUnsafe(`
      SELECT 'schema'::text AS "objectClass", nspname::text AS "objectName",
             nspowner::regrole::text AS owner
      FROM pg_namespace WHERE nspname = 'public'
      UNION ALL
      SELECT CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'relation' END,
             c.relname::text, c.relowner::regrole::text
      FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')
      ORDER BY 1, 2
    `);
    const extensions = await tx.$queryRawUnsafe(
      "SELECT extname::text AS name FROM pg_extension ORDER BY extname"
    );
    const version = one(await tx.$queryRawUnsafe("SHOW server_version"));
    if (!Array.isArray(inventory) || !Array.isArray(extensions)) {
      throw runnerError("MANUAL_TARGET_OBSERVATION_UNAVAILABLE");
    }
    return {
      physicalIdentity,
      role: identity.role,
      catalog: {
        migrationTableOid,
        migrationRows,
        schemaOwner: owner.owner,
        ownerInventory: inventory,
        extensions: extensions.map(({ name }) => name),
        postgresqlVersion: version.server_version
      }
    };
  });
  const now = (database.now?.() ?? new Date()).toISOString();
  const process = database.manualContext?.processEvidence;
  const observation = {
    schemaVersion: "manual-runner-evidence.v1",
    recordedAt: now,
    promotionEligible: false,
    kind: "observation",
    profileDigest: request.profileDigest,
    sessionId: request.sessionId,
    sessionNonce: request.sessionNonce,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    attemptId: request.attemptId,
    runId: request.runId,
    requestDigest: sha256Canonical(request),
    observedAt: now,
    physicalIdentity: observed.physicalIdentity,
    roleObservation: {
      role: observed.role,
      tls: true,
      schemaObservationDigest: sha256Canonical(observed.catalog)
    },
    catalog: observed.catalog,
    schema: null,
    processEvidenceDigest:
      request.stage === "target-observe" ? null : process ? sha256Canonical(process) : null
  };
  validateContract("manual-runner-evidence.v1", observation);
  encodeManualJson(observation);
  return Object.freeze(observation);
}
