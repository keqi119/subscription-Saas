import assert from "node:assert/strict";
import test from "node:test";

import {
  computeManualClusterFingerprint,
  sha256Canonical
} from "@subscription-saas/release-foundation";
import { createPostgresConnector } from "../src/postgres-connector.mjs";
import { assertReadOnlyStatements } from "../src/commands/db-schema-verify.mjs";
import { observeManualTarget } from "../src/manual-target-observer.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const uuid = (tail) => `00000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;
const cluster = {
  systemIdentifier: "123456789012345678",
  databaseContainerId: "b".repeat(64),
  dataVolumeName: "fresh-volume",
  postgresImageDigest: digest,
  marker: "fresh-marker",
  serverAddress: "172.19.0.2",
  serverPort: 5432
};
const context = {
  contextVersion: "manual-h3-target-context.v1",
  operationRef: uuid(8),
  indexDigest: digest,
  runId: uuid(2),
  profileDigest: digest,
  targetIntent: { endpointPolicyId: "fresh", databaseName: "fresh_db" },
  databaseOid: "123",
  h3Approval: { digest, bytes: 42 },
  h3Readback: { digest, bytes: 42 },
  cluster
};
const request = {
  schemaVersion: "manual-runner-request.v1",
  attemptId: uuid(1),
  runId: uuid(2),
  attemptAllocationDigest: digest,
  profileDigest: digest,
  ownerId: "owner",
  sessionId: uuid(3),
  sessionNonce: "a".repeat(64),
  operationId: uuid(4),
  idempotencyKey: "observe",
  purpose: "synthetic-fresh",
  targetIntent: context.targetIntent,
  stage: "target-observe",
  capability: "verify"
};
const endpointPolicy = {
  ...context.targetIntent,
  roles: { observer: "observer", migrate: "migrator", verify: "verifier" },
  tls: "required",
  endpoint: "127.0.0.1:5432"
};

function databaseFor(overrides = {}) {
  const statements = [];
  let transaction = false;
  const responses = {
    systemIdentifier: cluster.systemIdentifier,
    serverAddress: cluster.serverAddress,
    serverPort: cluster.serverPort,
    databaseName: "fresh_db",
    databaseOid: "123",
    role: "observer",
    tls: true,
    transactionIsolation: "repeatable read",
    transactionReadOnly: "on",
    ...overrides
  };
  const createClient = () => ({
    async unsafe(sql) {
      statements.push({ sql, transaction });
      if (sql === "SET TRANSACTION READ ONLY, ISOLATION LEVEL REPEATABLE READ") return [];
      if (sql === "SHOW transaction_isolation")
        return [{ transaction_isolation: responses.transactionIsolation }];
      if (sql === "SHOW transaction_read_only")
        return [{ transaction_read_only: responses.transactionReadOnly }];
      if (sql.includes("pg_control_system()"))
        return [{ systemIdentifier: responses.systemIdentifier }];
      if (sql.includes("inet_server_addr()"))
        return [
          {
            serverAddress: responses.serverAddress,
            serverPort: responses.serverPort,
            databaseName: responses.databaseName,
            databaseOid: responses.databaseOid,
            role: responses.role,
            tls: responses.tls
          }
        ];
      if (sql.includes("to_regclass"))
        return [
          { oid: responses.migrationTableOid === undefined ? "456" : responses.migrationTableOid }
        ];
      if (sql.includes('FROM "public"."_prisma_migrations"')) {
        if (responses.denyMigrationRead)
          throw Object.assign(new Error("permission denied"), { code: "42501" });
        return [
          {
            id: "id1",
            migrationName: "20260101000000_first",
            checksum: "c".repeat(64),
            startedAt: new Date("2026-09-01T00:00:00.000Z"),
            finishedAt: null,
            rolledBackAt: null,
            appliedStepsCount: 0
          }
        ];
      }
      if (sql.includes("FROM pg_class AS c"))
        return [{ objectClass: "schema", objectName: "public", owner: "schema_owner" }];
      if (sql.includes("nspowner::regrole")) return [{ owner: "schema_owner" }];
      if (sql.includes("FROM pg_extension")) return [{ name: "plpgsql" }];
      if (sql === "SHOW server_version") return [{ server_version: "17.11" }];
      throw new Error(`UNEXPECTED_SQL:${sql}`);
    },
    async begin(callback) {
      transaction = true;
      try {
        return await callback(this);
      } finally {
        transaction = false;
      }
    },
    async end() {}
  });
  return { connect: createPostgresConnector({ createClient }), statements };
}

test("reads one RR readonly transaction and preserves unfinished migration rows", async () => {
  const { connect, statements } = databaseFor();
  const database = await connect({
    credential: { capabilityProfile: "verify", username: "observer", password: "test" },
    target: { hostname: "127.0.0.1", databaseName: "fresh_db", tlsMode: "require" }
  });
  const observed = await observeManualTarget({
    request,
    database,
    endpointPolicy,
    approvedClusterObservation: context
  });
  assert.equal(
    observed.physicalIdentity.clusterFingerprint,
    computeManualClusterFingerprint(cluster)
  );
  assert.equal(observed.roleObservation.schemaObservationDigest, sha256Canonical(observed.catalog));
  assert.equal(observed.catalog.migrationRows.length, 1);
  assert.equal(observed.catalog.migrationRows[0].finishedAt, null);
  assert.deepEqual(
    statements.slice(0, 3).map(({ sql }) => sql),
    [
      "SET TRANSACTION READ ONLY, ISOLATION LEVEL REPEATABLE READ",
      "SHOW transaction_isolation",
      "SHOW transaction_read_only"
    ]
  );
  assert.equal(
    statements.every(({ transaction }) => transaction),
    true
  );
  assert.deepEqual(
    database.statementLog,
    statements.map(({ sql }) => sql)
  );
  assert.doesNotThrow(() => assertReadOnlyStatements(database.statementLog));
  assert.throws(
    () => assertReadOnlyStatements([...database.statementLog, "UPDATE public.sample SET id = 2"]),
    { code: "SCHEMA_VERIFY_WRITE_STATEMENT" }
  );
});

for (const [field, value] of [
  ["systemIdentifier", "999"],
  ["serverAddress", "172.19.0.9"],
  ["serverPort", 5433],
  ["databaseOid", "999"],
  ["databaseName", "other"]
]) {
  test(`rejects actual ${field} drift`, async () => {
    const { connect } = databaseFor({ [field]: value });
    const database = await connect({
      credential: { capabilityProfile: "verify", username: "observer", password: "test" },
      target: { hostname: "127.0.0.1", databaseName: "fresh_db", tlsMode: "require" }
    });
    await assert.rejects(
      () =>
        observeManualTarget({
          request,
          database,
          endpointPolicy,
          approvedClusterObservation: context
        }),
      { code: "MANUAL_CLUSTER_IDENTITY_MISMATCH" }
    );
  });
}

for (const [field, value, code] of [
  ["role", "migrator", "MANUAL_CLUSTER_IDENTITY_MISMATCH"],
  ["tls", false, "MANUAL_CLUSTER_IDENTITY_MISMATCH"],
  ["transactionIsolation", "read committed", "MANUAL_READONLY_TRANSACTION_UNVERIFIED"],
  ["transactionReadOnly", "off", "MANUAL_READONLY_TRANSACTION_UNVERIFIED"]
]) {
  test(`rejects ${field} mismatch before catalog read`, async () => {
    const { connect, statements } = databaseFor({ [field]: value });
    const database = await connect({
      credential: { capabilityProfile: "verify", username: "observer", password: "test" },
      target: { hostname: "127.0.0.1", databaseName: "fresh_db", tlsMode: "require" }
    });
    await assert.rejects(
      () =>
        observeManualTarget({
          request,
          database,
          endpointPolicy,
          approvedClusterObservation: context
        }),
      { code }
    );
    assert.equal(
      statements.some(({ sql }) => sql.includes("_prisma_migrations")),
      false
    );
  });
}

test("a missing migration table is distinct from a denied table query", async () => {
  const { connect } = databaseFor({ migrationTableOid: null });
  const database = await connect({
    credential: { capabilityProfile: "verify", username: "observer", password: "test" },
    target: { hostname: "127.0.0.1", databaseName: "fresh_db", tlsMode: "require" }
  });
  const observed = await observeManualTarget({
    request,
    database,
    endpointPolicy,
    approvedClusterObservation: context
  });
  assert.equal(observed.catalog.migrationTableOid, null);
  assert.deepEqual(observed.catalog.migrationRows, []);
});

test("a denied migration read never becomes an empty prefix", async () => {
  const { connect } = databaseFor({ denyMigrationRead: true });
  const database = await connect({
    credential: { capabilityProfile: "verify", username: "observer", password: "test" },
    target: { hostname: "127.0.0.1", databaseName: "fresh_db", tlsMode: "require" }
  });
  await assert.rejects(
    () =>
      observeManualTarget({
        request,
        database,
        endpointPolicy,
        approvedClusterObservation: context
      }),
    { code: "42501" }
  );
});

test("missing approved context or wrong fixed endpoint policy rejects before SQL", async () => {
  const { connect } = databaseFor();
  const database = await connect({
    credential: { capabilityProfile: "verify", username: "observer", password: "test" },
    target: { hostname: "127.0.0.1", databaseName: "fresh_db", tlsMode: "require" }
  });
  for (const values of [
    { approvedClusterObservation: undefined, endpointPolicy },
    { approvedClusterObservation: context, endpointPolicy: undefined },
    {
      approvedClusterObservation: context,
      endpointPolicy: { ...endpointPolicy, databaseName: "other" }
    }
  ]) {
    await assert.rejects(() => observeManualTarget({ request, database, ...values }), {
      code: "MANUAL_CLUSTER_IDENTITY_MISMATCH"
    });
  }
  assert.deepEqual(database.statementLog, []);
});
