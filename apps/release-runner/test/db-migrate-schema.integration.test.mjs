import assert from "node:assert/strict";
import test from "node:test";

import { deterministicPlanDigest, sha256Canonical } from "@subscription-saas/release-foundation";

import { commandHandlers } from "../src/command-handlers.mjs";
import { commandApprovalMode, loadCommandRegistry } from "../src/command-registry.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const operation = Object.freeze({
  operationId: "25d422be-1036-470c-a844-fe24735222cf",
  attemptId: "49101a87-aece-4c51-9be0-30233466510b",
  runId: "56f4ad5b-d7d3-4682-a835-0659a961c413",
  baselineManifestIdentityDigest: digest("1"),
  baselineManifestDigest: digest("2")
});

function catalog() {
  return {
    catalogVersion: "migration-catalog.v1",
    entries: [
      {
        order: 1,
        path: "apps/api/prisma/migrations/20260101000000_first/migration.sql",
        sha256: digest("a")
      },
      {
        order: 2,
        path: "apps/api/prisma/migrations/20260102000000_second/migration.sql",
        sha256: digest("b")
      }
    ],
    digest: digest("c")
  };
}

function input() {
  return {
    ...operation,
    databaseIdentityFingerprint: digest("3"),
    expectedOwner: "s1m_owner",
    expectedSchemaDigest: digest("4"),
    allowedExtensions: ["btree_gist", "pgcrypto"]
  };
}

function migrationContext() {
  let state = {
    migrationHead: "20260101000000_first",
    appliedMigrations: [catalog().entries[0]],
    schemaDigest: digest("0"),
    schemaOwner: "s1m_owner",
    extensions: ["btree_gist", "pgcrypto"],
    databaseIdentityFingerprint: digest("3")
  };
  const calls = [];
  return {
    calls,
    loadMigrationCatalog: async () => catalog(),
    observeMigrationState: async () => structuredClone(state),
    observeSchema: async () => ({
      ...structuredClone(state),
      ownerInventory: [{ objectClass: "schema", objectName: "public", owner: state.schemaOwner }],
      schemaDiff: { exitCode: 0, stdout: "" },
      statements: ["SELECT * FROM _prisma_migrations", "SHOW server_version_num"]
    }),
    withMigrationLock: async (callback) => {
      calls.push("lock");
      return callback();
    },
    executePrismaMigrateDeploy: async () => {
      calls.push("deploy");
      state = {
        ...state,
        migrationHead: "20260102000000_second",
        appliedMigrations: catalog().entries,
        schemaDigest: digest("4")
      };
    },
    readToolVersions: async () => ({ prisma: "7.8.0", psql: "17.11", postgresql: "17.11" }),
    now: () => new Date("2026-09-02T09:00:00.000Z")
  };
}

test("registers the fixed migration and schema handlers", () => {
  for (const commandKey of ["db.migrate.deploy@1", "db.schema.verify@1"]) {
    if (!commandHandlers.has(commandKey)) {
      throw Object.assign(new Error(`RUNNER_HANDLER_MISSING:${commandKey}`), {
        code: `RUNNER_HANDLER_MISSING:${commandKey}`
      });
    }
  }
});

test("fixes migration approval by environment and keeps both commands on complete build proofs", async () => {
  const registry = await loadCommandRegistry();
  const migration = registry.commands.find(({ commandId }) => commandId === "db.migrate.deploy");
  const verification = registry.commands.find(({ commandId }) => commandId === "db.schema.verify");
  assert.deepEqual(migration.allowedExecutionScopes, ["full-rc", "migration-schema"]);
  assert.deepEqual(verification.allowedExecutionScopes, ["full-rc", "migration-schema"]);
  assert.equal(commandApprovalMode(migration, "ci-fresh", "apply"), "ci-policy");
  assert.equal(commandApprovalMode(migration, "ci-snapshot", "apply"), "ci-policy");
  assert.equal(commandApprovalMode(migration, "staging", "apply"), "human");
  assert.equal(commandApprovalMode(migration, "staging", "dry-run"), "none");
  assert.equal(commandApprovalMode(verification, "staging", "verify"), "none");
});

test("plans an ordered deterministic migration prefix and recomputes it under lock", async () => {
  const { applyMigration, planMigration } = await import("../src/commands/db-migrate-deploy.mjs");
  const context = migrationContext();
  const plan = await planMigration(context, input());
  assert.equal(plan.identity.pendingMigrations.length, 1);
  assert.equal(plan.identity.pendingMigrations[0].order, 2);
  const planDigest = deterministicPlanDigest(plan);
  const postState = await applyMigration(context, { input: input(), planDigest });
  assert.deepEqual(context.calls, ["lock", "deploy"]);
  assert.equal(postState.postMigrationHead, "20260102000000_second");
  assert.equal(
    postState.postconditions.every(({ status }) => status === "PASSED"),
    true
  );
});

test("rejects migration plan drift before deploy", async () => {
  const { applyMigration } = await import("../src/commands/db-migrate-deploy.mjs");
  const context = migrationContext();
  await assert.rejects(() => applyMigration(context, { input: input(), planDigest: digest("f") }), {
    code: "PLAN_CHANGED_SINCE_APPROVAL"
  });
  assert.deepEqual(context.calls, ["lock"]);
});

test("schema verification accepts only read-only observations and exposes real tool versions", async () => {
  const { verifySchema } = await import("../src/commands/db-schema-verify.mjs");
  const statements = ["SELECT * FROM _prisma_migrations", "SHOW server_version_num"];
  const observation = await verifySchema(
    {
      loadMigrationCatalog: async () => catalog(),
      observeSchema: async () => ({
        migrationHead: "20260102000000_second",
        appliedMigrations: catalog().entries,
        schemaDigest: digest("4"),
        schemaOwner: "s1m_owner",
        ownerInventory: [{ objectClass: "schema", objectName: "public", owner: "s1m_owner" }],
        extensions: ["btree_gist", "pgcrypto"],
        schemaDiff: { exitCode: 0, stdout: "" },
        statements
      }),
      readToolVersions: async () => ({ prisma: "7.8.0", psql: "17.11", postgresql: "17.11" })
    },
    input()
  );
  assert.equal(observation.terminalStatus, "PASSED");
  assert.equal(observation.statementLogDigest, sha256Canonical(statements));
  assert.deepEqual(observation.toolVersions, {
    postgresql: "17.11",
    prisma: "7.8.0",
    psql: "17.11"
  });
});

test("schema verification rejects a write statement", async () => {
  const { verifySchema } = await import("../src/commands/db-schema-verify.mjs");
  await assert.rejects(
    () =>
      verifySchema(
        {
          loadMigrationCatalog: async () => catalog(),
          observeSchema: async () => ({
            migrationHead: "20260102000000_second",
            appliedMigrations: catalog().entries,
            schemaDigest: digest("4"),
            schemaOwner: "s1m_owner",
            ownerInventory: [],
            extensions: ["btree_gist", "pgcrypto"],
            schemaDiff: { exitCode: 0, stdout: "" },
            statements: ["UPDATE SubscriptionOrder SET status = 'ACTIVE'"]
          }),
          readToolVersions: async () => ({ prisma: "7.8.0", psql: "17.11", postgresql: "17.11" })
        },
        input()
      ),
    { code: "SCHEMA_VERIFY_WRITE_STATEMENT" }
  );
});
