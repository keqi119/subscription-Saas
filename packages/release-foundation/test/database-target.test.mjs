import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertApprovedEphemeralTarget,
  cleanupSuiteDatabase,
  grantRuntimeEquivalentAccess,
  provisionSuiteDatabase,
  scanMigrationGlobalObjects,
  suiteDatabaseName
} from "../src/index.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const targetPolicy = {
  schemaVersion: "database-target-policy.v1",
  policyId: "s1-release-ephemeral",
  allowedEnvironments: ["ci", "local-controlled"],
  allowedHosts: ["127.0.0.1", "localhost", "::1"],
  requiredClusterMarker: "subscription-s1-controlled/v1",
  requiredEphemeralMarker: "subscription-s1-ephemeral/v1",
  requiredImageDigest: digest,
  requiredServerVersionMajor: 17,
  databaseNamePattern: "^s1ci_[0-9a-f]{24}$"
};
const validTarget = {
  policyId: targetPolicy.policyId,
  environment: "local-controlled",
  host: "127.0.0.1",
  clusterMarker: targetPolicy.requiredClusterMarker,
  clusterFingerprint: digest,
  imageDigest: digest,
  serverVersionNum: "170011"
};

test("rejects staging, production, unknown clusters and absent markers", () => {
  for (const environment of ["staging", "production", "unknown"]) {
    assert.throws(
      () => assertApprovedEphemeralTarget({ ...validTarget, environment }, targetPolicy),
      { code: "EPHEMERAL_TARGET_REJECTED" }
    );
  }
  for (const replacement of [
    { clusterMarker: undefined },
    { clusterFingerprint: undefined },
    { imageDigest: `sha256:${"b".repeat(64)}` },
    { serverVersionNum: "160010" },
    { host: "staging-db.internal" }
  ]) {
    assert.throws(
      () => assertApprovedEphemeralTarget({ ...validTarget, ...replacement }, targetPolicy),
      { code: "EPHEMERAL_TARGET_REJECTED" }
    );
  }
});

test("derives exact stable suite database names without accepting prefixes", () => {
  const name = suiteDatabaseName("run-1", "api.database.release", 0);
  assert.match(name, /^s1ci_[0-9a-f]{24}$/);
  assert.equal(name, suiteDatabaseName("run-1", "api.database.release", 0));
  assert.notEqual(name, suiteDatabaseName("run-1", "api.database.release", 1));
});

test("migration global-object scan allows only registered database-local extensions", async () => {
  const policy = {
    schemaVersion: "migration-global-object-policy.v1",
    allowedExtensions: ["btree_gist", "pgcrypto"]
  };
  const root = await mkdtemp(path.join(tmpdir(), "migration-global-scan-"));
  try {
    const directory = path.join(root, "apps", "api", "prisma", "migrations");
    await mkdir(path.join(directory, "20260101000000_allowed"), { recursive: true });
    await writeFile(
      path.join(directory, "20260101000000_allowed", "migration.sql"),
      'CREATE EXTENSION IF NOT EXISTS "pgcrypto";\nCREATE TABLE "ok" ("id" uuid);\n',
      "utf8"
    );
    const result = await scanMigrationGlobalObjects(root, policy);
    assert.deepEqual(result.extensions, ["pgcrypto"]);

    await mkdir(path.join(directory, "20260102000000_forbidden"), { recursive: true });
    await writeFile(
      path.join(directory, "20260102000000_forbidden", "migration.sql"),
      'CREATE ROLE "unexpected";\n',
      "utf8"
    );
    await assert.rejects(scanMigrationGlobalObjects(root, policy), {
      code: "MIGRATION_GLOBAL_OBJECT_FORBIDDEN"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration scan rejects unregistered or non-idempotent extension creation", async () => {
  const policy = {
    schemaVersion: "migration-global-object-policy.v1",
    allowedExtensions: ["pgcrypto"]
  };
  for (const sql of [
    'CREATE EXTENSION IF NOT EXISTS "untrusted";',
    'CREATE EXTENSION "pgcrypto";'
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), "migration-extension-scan-"));
    try {
      const directory = path.join(
        root,
        "apps",
        "api",
        "prisma",
        "migrations",
        "20260101000000_extension"
      );
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "migration.sql"), sql, "utf8");
      await assert.rejects(scanMigrationGlobalObjects(root, policy), {
        code: "MIGRATION_EXTENSION_POLICY_REJECTED"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("provisioning returns references and fingerprints but no credential or URL", async () => {
  const state = { marker: null, calls: [] };
  const executeAdmin = async ({ sql }) => {
    state.calls.push(sql);
    const markerMatch = sql.match(/COMMENT ON DATABASE "[^"]+" IS '([^']+)'/);
    if (markerMatch) state.marker = markerMatch[1].replaceAll("''", "'");
    if (sql.includes("FROM pg_database")) {
      return { rows: [{ oid: "19001", marker: state.marker }] };
    }
    return { rows: [] };
  };
  const secretStore = {
    async create({ profile, username }) {
      return {
        reference: `secret://task3/${profile}`,
        username,
        password: `${profile}-private-password`
      };
    }
  };
  const record = await provisionSuiteDatabase({
    target: validTarget,
    policy: targetPolicy,
    runId: "run-1",
    suiteId: "api.database.release",
    shard: 0,
    now: () => new Date("2026-09-02T08:00:00.000Z"),
    executeAdmin,
    secretStore
  });
  assert.equal(record.databaseName, suiteDatabaseName("run-1", "api.database.release", 0));
  assert.equal(record.databaseOid, "19001");
  assert.deepEqual(Object.keys(record.secretReferences), ["migrate", "runtime-test"]);
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /password|postgres(?:ql)?:\/\//i);
  assert.match(serialized, /secret:\/\/task3\/migrate/);
  assert.ok(state.calls.some((sql) => sql.includes("CREATE DATABASE")));
});

test("runtime access is limited to DML, sequences, and migration-owner defaults", async () => {
  const calls = [];
  await grantRuntimeEquivalentAccess({
    databaseName: "s1ci_aaaaaaaaaaaaaaaaaaaaaaaa",
    migrationRole: "s1m_aaaaaaaaaaaaaaaaaaaaaaaa",
    runtimeRole: "s1r_aaaaaaaaaaaaaaaaaaaaaaaa",
    executeDatabase: async ({ sql }) => {
      calls.push(sql);
      return { rows: [] };
    }
  });
  const sql = calls.join("\n");
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES/);
  assert.match(sql, /GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE/);
  assert.doesNotMatch(sql, /SUPERUSER|CREATEDB|BYPASSRLS/);
});

test("cleanup requires exact run record and database comment marker", async () => {
  const databaseName = suiteDatabaseName("run-1", "api.database.release", 0);
  const record = {
    recordVersion: "provisioned-database.v1",
    targetFingerprint: digest,
    databaseName,
    databaseOid: "19001",
    marker: "marker",
    runId: "run-1",
    suiteId: "api.database.release",
    shard: 0,
    roles: {
      migrate: "s1m_aaaaaaaaaaaaaaaaaaaaaaaa",
      "runtime-test": "s1r_aaaaaaaaaaaaaaaaaaaaaaaa"
    },
    secretReferences: { migrate: "secret://migrate", "runtime-test": "secret://runtime" },
    createdAt: "2026-09-02T08:00:00.000Z"
  };
  await assert.rejects(
    cleanupSuiteDatabase(
      { ...record, databaseName: `${record.databaseName}_x` },
      { target: validTarget, policy: targetPolicy, executeAdmin: async () => ({ rows: [] }) }
    ),
    { code: "CLEANUP_IDENTITY_MISMATCH" }
  );
  await assert.rejects(
    cleanupSuiteDatabase(record, {
      target: validTarget,
      policy: targetPolicy,
      executeAdmin: async ({ sql }) =>
        sql.includes("FROM pg_database")
          ? { rows: [{ oid: record.databaseOid, marker: "forged" }] }
          : { rows: [] }
    }),
    { code: "CLEANUP_IDENTITY_MISMATCH" }
  );
});
