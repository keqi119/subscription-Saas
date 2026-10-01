import assert from "node:assert/strict";
import test from "node:test";
import { sha256Bytes, sha256Canonical } from "@subscription-saas/release-foundation";
import { finalMigrationInputFixture } from "./fixtures/final-migration-input.mjs";

const digest = (value) => sha256Canonical(value);
async function fixture({ complete = false, beforeLock } = {}) {
  const values = await finalMigrationInputFixture();
  const { input, migrationCatalog } = values;
  const credential = {
    username: input.database.migrationRole,
    password: "synthetic-migration-only-password",
    capabilityProfile: "migrate"
  };
  input.database.migrationCredentialFingerprint = sha256Bytes(Buffer.from(credential.password));
  const state = {
    complete,
    marker: input.database.marker,
    schemaDigest: complete ? input.expectedSchemaDigest : digest("empty-schema"),
    extensions: complete ? ["btree_gist", "pgcrypto", "plpgsql"] : ["plpgsql"]
  };
  const calls = [];
  let locked = false;
  const head = () =>
    state.complete ? migrationCatalog.entries.at(-1).path.split("/").at(-2) : null;
  const identity = () => ({
    databaseName: input.database.databaseName,
    databaseOid: input.database.databaseOid,
    role: input.database.migrationRole,
    tls: true,
    schemas: ["public"],
    extensions: state.extensions,
    marker: state.marker,
    databaseOwner: input.database.migrationRole,
    schemaOwner: input.database.migrationRole,
    canLogin: true,
    superuser: false,
    createdb: false,
    createrole: false,
    inherit: false,
    replication: false,
    bypassrls: false,
    memberships: "0",
    grantedTo: "0"
  });
  const query = async () => [identity()];
  const database = {
    async $queryRawUnsafe(sql) {
      assert.equal(
        locked,
        false,
        "outer connection must not be used while transaction owns max:1 pool"
      );
      calls.push("identity-outside-lock");
      return query(sql);
    },
    loadMigrationCatalog: async () => structuredClone(migrationCatalog),
    observeMigrationState: async () => ({
      appliedMigrations: state.complete ? migrationCatalog.entries : [],
      migrationHead: head(),
      databaseIdentityFingerprint: database.databaseIdentityFingerprint,
      schemaOwner: input.database.migrationRole
    }),
    observeSchema: async () => ({
      appliedMigrations: state.complete ? migrationCatalog.entries : [],
      migrationHead: head(),
      schemaDigest: state.schemaDigest,
      schemaOwner: input.database.migrationRole,
      ownerInventory: [
        { objectClass: "schema", objectName: "public", owner: input.database.migrationRole }
      ],
      extensions: state.extensions,
      schemaDiff: { exitCode: state.complete ? 0 : 2, stdout: state.complete ? "" : "pending DDL" },
      statements: ["SELECT current_database()"]
    }),
    readToolVersions: async () => ({ prisma: "7.8.0", psql: "17.11", postgresql: "17.11" }),
    async withMigrationLock(callback) {
      calls.push("lock");
      locked = true;
      beforeLock?.(state);
      try {
        return await callback({
          $queryRawUnsafe: async (sql) => {
            calls.push("identity-inside-lock");
            return query(sql);
          }
        });
      } finally {
        locked = false;
      }
    },
    async executePrismaMigrateDeploy() {
      calls.push("deploy");
      state.complete = true;
      state.schemaDigest = input.expectedSchemaDigest;
      state.extensions = ["btree_gist", "pgcrypto", "plpgsql"];
    },
    now: () => new Date("2026-09-29T01:00:00.000Z")
  };
  const { createFinalMigrationSession } = await import("../src/final-migration-session.mjs");
  return {
    values,
    state,
    calls,
    credential,
    database,
    session: createFinalMigrationSession({ ...values, database, credential, now: database.now })
  };
}

test("final migration records an actual baseline and exact plan/apply/verify predecessors", async () => {
  const f = await fixture();
  const plan = await f.session.plan();
  assert.equal(plan.stage, "plan");
  assert.equal(plan.baseline.schemaVersion, "r3-final-migration-baseline.v1");
  assert.deepEqual(plan.baseline.identity.appliedMigrations, []);
  assert.equal(plan.baselineManifestIdentityDigest, digest(plan.baseline.identity));
  assert.equal(plan.baselineManifestDigest, digest(plan.baseline));
  assert.notEqual(plan.baselineManifestDigest, f.values.input.candidateUseExecutionRecordDigest);
  assert.equal(
    plan.plan.identity.pendingMigrations.length,
    f.values.migrationCatalog.entries.length
  );
  const apply = await f.session.apply({
    predecessorDigest: digest(plan),
    planDigest: plan.planDigest
  });
  const verify = await f.session.verify({ predecessorDigest: digest(apply) });
  assert.equal(apply.predecessorDigest, digest(plan));
  assert.equal(verify.predecessorDigest, digest(apply));
  assert.equal(verify.observation.schemaDigest, f.values.input.expectedSchemaDigest);
  assert.equal(verify.observation.terminalStatus, "PASSED");
  assert.deepEqual(f.calls, [
    "identity-outside-lock",
    "lock",
    "identity-inside-lock",
    "deploy",
    "identity-outside-lock"
  ]);
  assert.equal(JSON.stringify([plan, apply, verify]).includes(f.credential.password), false);
  assert.equal(Object.isFrozen(plan.baseline.identity), true);
  await assert.rejects(
    () => f.session.apply({ predecessorDigest: digest(plan), planDigest: plan.planDigest }),
    { code: "R3_FINAL_MIGRATION_SEQUENCE_INVALID" }
  );
});

test("waiting for the lock cannot hide baseline drift or trigger a second connection", async () => {
  for (const field of ["marker", "schemaDigest"]) {
    const f = await fixture({
      beforeLock: (state) => {
        state[field] = field === "marker" ? "different-target" : digest("drift");
      }
    });
    const plan = await f.session.plan();
    await assert.rejects(
      () => f.session.apply({ predecessorDigest: digest(plan), planDigest: plan.planDigest }),
      (error) => {
        assert.equal(error.code, "R3_FINAL_MIGRATION_FAILED");
        assert.ok(error.originals.length > 0);
        return true;
      }
    );
    assert.equal(f.calls.includes("identity-inside-lock"), true);
    assert.equal(f.calls.includes("deploy"), false);
    await assert.rejects(() => f.session.plan(), { code: "R3_FINAL_MIGRATION_SEQUENCE_INVALID" });
  }
});

test("complete snapshots are verified without deploy and bad predecessor never takes the lock", async () => {
  const f = await fixture({ complete: true });
  const plan = await f.session.plan();
  assert.equal(plan.plan.identity.pendingMigrations.length, 0);
  const apply = await f.session.apply({
    predecessorDigest: digest(plan),
    planDigest: plan.planDigest
  });
  await f.session.verify({ predecessorDigest: digest(apply) });
  assert.equal(f.calls.includes("deploy"), false);
  const bad = await fixture();
  await bad.session.plan();
  await assert.rejects(
    () => bad.session.apply({ predecessorDigest: digest("foreign"), planDigest: plan.planDigest }),
    { code: "R3_FINAL_MIGRATION_FAILED" }
  );
  assert.equal(bad.calls.includes("lock"), false);
});

test("a failed concurrent call stops deploy even after the locked baseline check", async () => {
  const f = await fixture();
  const plan = await f.session.plan();
  let release, reached;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  const atReplan = new Promise((resolve) => {
    reached = resolve;
  });
  let reads = 0;
  const originalLoad = f.database.loadMigrationCatalog;
  f.database.loadMigrationCatalog = async () => {
    if (++reads === 2) {
      reached();
      await paused;
    }
    return originalLoad();
  };
  const applying = f.session.apply({
    predecessorDigest: digest(plan),
    planDigest: plan.planDigest
  });
  await atReplan;
  await assert.rejects(() => f.session.verify({ predecessorDigest: digest(plan) }), {
    code: "R3_FINAL_MIGRATION_SEQUENCE_INVALID"
  });
  release();
  await assert.rejects(() => applying, { code: "R3_FINAL_MIGRATION_FAILED" });
  assert.equal(f.calls.includes("deploy"), false);
});
