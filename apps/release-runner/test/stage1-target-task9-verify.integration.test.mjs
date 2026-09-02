import assert from "node:assert/strict";
import test from "node:test";

import { commandHandlers } from "../src/command-handlers.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

test("registers both fixed Stage1 verification handlers", () => {
  for (const commandKey of ["stage1.acceptance.target.verify@1", "stage1.task9.preflight@1"]) {
    if (!commandHandlers.has(commandKey)) {
      throw Object.assign(new Error(`RUNNER_HANDLER_MISSING:${commandKey}`), {
        code: `RUNNER_HANDLER_MISSING:${commandKey}`
      });
    }
  }
});

test("validates an acceptance target inside one read-only transaction", async () => {
  const { verifyAcceptanceTarget } =
    await import("../src/commands/stage1-acceptance-target-verify.mjs");
  const calls = [];
  const result = await verifyAcceptanceTarget(
    {
      databaseIdentityFingerprint: digest("a"),
      withReadOnlyTransaction: async (callback) => {
        calls.push("SET TRANSACTION READ ONLY");
        return callback({ auditLog: { findMany: async () => [] } });
      },
      statementLog: calls,
      validateTarget: async (_tx, options) => ({
        counts: options.approvedManifest.counts,
        manifestSha256: options.approvedManifestSha256,
        safe: true,
        target: { databaseDigest: digest("b") }
      })
    },
    {
      expectedDatabaseIdentityFingerprint: digest("a"),
      approvedManifest: { counts: { vehicle: 1 } },
      approvedManifestSha256: "c".repeat(64)
    }
  );
  assert.equal(result.safe, true);
  assert.deepEqual(calls, ["SET TRANSACTION READ ONLY"]);
});

test("rejects a mismatched target identity before opening a transaction", async () => {
  const { verifyAcceptanceTarget } =
    await import("../src/commands/stage1-acceptance-target-verify.mjs");
  let transactions = 0;
  await assert.rejects(
    () =>
      verifyAcceptanceTarget(
        {
          databaseIdentityFingerprint: digest("a"),
          withReadOnlyTransaction: async () => (transactions += 1),
          statementLog: []
        },
        {
          expectedDatabaseIdentityFingerprint: digest("b"),
          approvedManifest: {},
          approvedManifestSha256: "c".repeat(64)
        }
      ),
    { code: "TARGET_IDENTITY_MISMATCH" }
  );
  assert.equal(transactions, 0);
});

test("rejects target verification when statement evidence contains a write", async () => {
  const { verifyAcceptanceTarget } =
    await import("../src/commands/stage1-acceptance-target-verify.mjs");
  await assert.rejects(
    () =>
      verifyAcceptanceTarget(
        {
          databaseIdentityFingerprint: digest("a"),
          withReadOnlyTransaction: async (callback) => callback({}),
          statementLog: ["UPDATE Application SET status = 'APPROVED'"],
          validateTarget: async () => ({ safe: true })
        },
        {
          expectedDatabaseIdentityFingerprint: digest("a"),
          approvedManifest: {},
          approvedManifestSha256: "c".repeat(64)
        }
      ),
    { code: "SCHEMA_VERIFY_WRITE_STATEMENT" }
  );
});

function task9Input() {
  return {
    ruleSetVersion: "stage1-task9-rules.v1",
    expectedDatabaseIdentityFingerprint: digest("a"),
    databasePair: {
      allowedHostname: "db.internal",
      owner: "stage1_owner",
      targetDatabase: "subscription_saas_staging_acceptance"
    },
    vehicleId: "25d422be-1036-470c-a844-fe24735222cf",
    discoveryReport: { candidates: [{ id: "25d422be-1036-470c-a844-fe24735222cf" }] },
    approvalReport: { approved: true },
    resources: {
      diskAvailableKb: String(11 * 1024 * 1024),
      apiMemoryState: "256MiB / 512MiB",
      postgresConnectionState: "5|30"
    }
  };
}

function task9Context(overrides = {}) {
  return {
    databaseIdentityFingerprint: digest("a"),
    readDatabasePair: async () => ({
      sourceUrl: "postgresql://stage1_owner:secret@db.internal/subscription_saas_staging",
      targetUrl: "postgresql://stage1_owner:secret@db.internal/subscription_saas_staging_acceptance"
    }),
    buildApprovalSummary: () => ({ safe: true, safeToApply: true, exceptionsCount: 0 }),
    statementLog: ["SHOW server_version_num"],
    ...overrides
  };
}

test("runs the frozen Task9 rules without exposing database URLs", async () => {
  const { verifyTask9Preflight } = await import("../src/commands/stage1-task9-preflight.mjs");
  const result = await verifyTask9Preflight(task9Context(), task9Input());
  assert.equal(result.safe, true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(result.resources, {
    disk: { availableKb: 11534336, code: "OK" },
    memory: {
      code: "OK",
      headroomBytes: 268435456,
      limitBytes: 536870912,
      usageBytes: 268435456
    },
    postgresConnections: {
      activeConnections: 5,
      code: "OK",
      headroomConnections: 25,
      maxConnections: 30
    }
  });
});

test("preserves the existing Task9 normalized refusal code", async () => {
  const { verifyTask9Preflight } = await import("../src/commands/stage1-task9-preflight.mjs");
  const input = task9Input();
  input.resources.postgresConnectionState = "25|30";
  await assert.rejects(() => verifyTask9Preflight(task9Context(), input), {
    code: "POSTGRES_CONNECTION_HEADROOM_LOW"
  });
});
