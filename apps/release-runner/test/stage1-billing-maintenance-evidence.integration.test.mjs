import assert from "node:assert/strict";
import test from "node:test";

import { custodyEvidence, sha256Canonical } from "@subscription-saas/release-foundation";

import { commandHandlers } from "../src/command-handlers.mjs";

import {
  BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256,
  BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION,
  BILLING_MAINTENANCE_FORBIDDEN_KEYS,
  hashBillingMaintenanceEvidenceValue
} from "../../../scripts/billing-maintenance-cycle-evidence-core.mjs";

const RUN_ID = "a".repeat(64);
const RELEASE_SHA = "b".repeat(40);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const DATABASE_IDENTITY_SHA256 = "d".repeat(64);
const NOT_BEFORE = "2026-08-31T01:00:00Z";
const INPUT = Object.freeze({
  runId: RUN_ID,
  expectedReleaseSha: RELEASE_SHA,
  expectedImageDigest: IMAGE_DIGEST,
  expectedDatabaseIdentitySha256: DATABASE_IDENTITY_SHA256,
  notBefore: NOT_BEFORE,
  timeoutSeconds: 60
});

test("registers the billing-maintenance evidence handler", () => {
  const commandKey = "stage1.billing-maintenance.evidence@1";
  if (!commandHandlers.has(commandKey)) {
    throw Object.assign(new Error(`RUNNER_HANDLER_MISSING:${commandKey}`), {
      code: `RUNNER_HANDLER_MISSING:${commandKey}`
    });
  }
  assert.equal(typeof commandHandlers.get(commandKey), "function");
});

test("collects two bounded read-only cycles and accepts output only after custody", async () => {
  const { collectBillingMaintenanceEvidence } =
    await import("../src/commands/stage1-billing-maintenance-evidence.mjs");
  const responses = [[], [completedFact(1)], [completedFact(1), completedFact(2)]];
  const statements = [];
  const events = [];
  let elapsed = 0;
  const result = await collectBillingMaintenanceEvidence(
    context({
      statementLog: statements,
      queryBillingMaintenanceFacts: async () => {
        statements.push(
          'SELECT * FROM "BillingMaintenanceCycleFact" WHERE "evidenceRunId" = $1 ORDER BY "sequence"'
        );
        return responses.shift() ?? [];
      },
      wait: async (milliseconds) => {
        events.push("wait");
        elapsed += milliseconds;
      },
      now: () => elapsed,
      custodyEvidence: async (request) => {
        events.push("custody");
        return custodize(request.value);
      }
    }),
    INPUT
  );

  assert.equal(result.terminalStatus, "PASSED");
  assert.deepEqual(
    result.evidence.cycles.map(({ sequence }) => sequence),
    [1, 2]
  );
  assert.equal(result.evidenceDigest, sha256Canonical(result.evidence));
  assert.equal(result.custodyReceipt.contentDigest, result.evidenceDigest);
  assert.equal(events.at(-1), "custody");
  assert.equal(Object.isFrozen(result.evidence.cycles[0].beforeCounts), true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /"(?:orderId|customerId|customerPhone|vehicleId|vehicleVin|databaseUrl|token)"\s*:/iu
  );
});

test("rejects database writes before evidence custody", async () => {
  const { collectBillingMaintenanceEvidence } =
    await import("../src/commands/stage1-billing-maintenance-evidence.mjs");
  let custodyCalls = 0;
  await assert.rejects(
    () =>
      collectBillingMaintenanceEvidence(
        context({
          statementLog: ["UPDATE BillingMaintenanceCycleFact SET status = 'COMPLETED'"],
          queryBillingMaintenanceFacts: async () => [completedFact(1), completedFact(2)],
          custodyEvidence: async () => {
            custodyCalls += 1;
          }
        }),
        INPUT
      ),
    { code: "SCHEMA_VERIFY_WRITE_STATEMENT" }
  );
  assert.equal(custodyCalls, 0);
});

test("requires statement evidence for a successful collection", async () => {
  const { collectBillingMaintenanceEvidence } =
    await import("../src/commands/stage1-billing-maintenance-evidence.mjs");
  await assert.rejects(
    () =>
      collectBillingMaintenanceEvidence(
        context({
          statementLog: [],
          queryBillingMaintenanceFacts: async () => [completedFact(1), completedFact(2)]
        }),
        INPUT
      ),
    { code: "BILLING_MAINTENANCE_STATEMENT_LOG_MISSING" }
  );
});

test("does not synthesize success or custody output when polling times out", async () => {
  const { collectBillingMaintenanceEvidence } =
    await import("../src/commands/stage1-billing-maintenance-evidence.mjs");
  let elapsed = 0;
  let custodyCalls = 0;
  await assert.rejects(
    () =>
      collectBillingMaintenanceEvidence(
        context({
          now: () => elapsed,
          pollIntervalMs: 400,
          queryBillingMaintenanceFacts: async () => [],
          wait: async (milliseconds) => {
            elapsed += milliseconds;
          },
          custodyEvidence: async () => {
            custodyCalls += 1;
          }
        }),
        { ...INPUT, timeoutSeconds: 1 }
      ),
    { code: "BILLING_MAINTENANCE_EVIDENCE_TIMEOUT" }
  );
  assert.equal(custodyCalls, 0);
});

test("rejects an incomplete custody receipt", async () => {
  const { collectBillingMaintenanceEvidence } =
    await import("../src/commands/stage1-billing-maintenance-evidence.mjs");
  await assert.rejects(
    () =>
      collectBillingMaintenanceEvidence(
        context({
          queryBillingMaintenanceFacts: async () => [completedFact(1), completedFact(2)],
          custodyEvidence: async ({ contentDigest }) => ({
            schemaVersion: "custody-receipt.v1",
            contentDigest
          })
        }),
        INPUT
      ),
    { code: "CUSTODY_RECEIPT_INCOMPLETE" }
  );
});

test("rejects a database identity mismatch before querying", async () => {
  const { collectBillingMaintenanceEvidence } =
    await import("../src/commands/stage1-billing-maintenance-evidence.mjs");
  let queries = 0;
  await assert.rejects(
    () =>
      collectBillingMaintenanceEvidence(
        context({
          databaseIdentitySha256: "e".repeat(64),
          queryBillingMaintenanceFacts: async () => {
            queries += 1;
            return [];
          }
        }),
        INPUT
      ),
    { code: "BILLING_MAINTENANCE_DATABASE_IDENTITY_MISMATCH" }
  );
  assert.equal(queries, 0);
});

function context(overrides = {}) {
  return {
    databaseIdentitySha256: DATABASE_IDENTITY_SHA256,
    statementLog: [
      'SELECT * FROM "BillingMaintenanceCycleFact" WHERE "evidenceRunId" = $1 ORDER BY "sequence"'
    ],
    queryBillingMaintenanceFacts: async () => [completedFact(1), completedFact(2)],
    custodyEvidence: async ({ value }) => custodize(value),
    ...overrides
  };
}

function completedFact(sequence) {
  const counts = Object.fromEntries(BILLING_MAINTENANCE_FORBIDDEN_KEYS.map((key) => [key, 0]));
  const countsSha256 = hashBillingMaintenanceEvidenceValue(counts);
  const base = Date.parse(NOT_BEFORE) + (sequence - 1) * 5_000;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sequence,
    status: "COMPLETED",
    evidenceRunId: RUN_ID,
    releaseSha: RELEASE_SHA,
    imageDigest: IMAGE_DIGEST,
    databaseIdentitySha256: DATABASE_IDENTITY_SHA256,
    forbiddenDomainSetVersion: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION,
    forbiddenDomainSetSha256: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256,
    cycleStartedAt: new Date(base + 1_000),
    reconciliationCompletedAt: new Date(base + 2_000),
    enqueueCompletedAt: new Date(base + 3_000),
    completedAt: new Date(base + 4_000),
    blockedCount: 0,
    reconciliationSummary: {
      blockedCount: 0,
      blockerCodes: [],
      createdCount: 0,
      dryRun: false,
      eligibleCount: 0,
      existingCount: 0,
      leaseActivationCount: 0
    },
    enqueueSummary: { dueCount: 0, enqueuedCount: 0 },
    beforeCounts: counts,
    beforeCountsSha256: countsSha256,
    afterCounts: { ...counts },
    afterCountsSha256: countsSha256
  };
}

async function custodize(value) {
  const stored = new Map();
  const fixedNow = new Date("2026-09-02T08:00:00.000Z");
  return custodyEvidence({
    value,
    policy: {
      owner: "release-engineering",
      readers: ["audit-reader"],
      retentionDays: 180,
      expiryDisposition: "review"
    },
    storage: {
      trustPolicy: "immutable-content-addressed/v1",
      writerIdentity: "release-evidence-writer",
      auditReaderIdentity: "audit-reader",
      async createOnly({ key, bytes, contentDigest, retainUntil }) {
        if (stored.has(key)) return { created: false };
        stored.set(key, Buffer.from(bytes));
        return {
          created: true,
          storeRef: `immutable-store/${key}`,
          contentDigest,
          contentSizeBytes: bytes.byteLength,
          storedAt: fixedNow.toISOString(),
          retainUntil
        };
      },
      async read({ key }) {
        return stored.get(key);
      }
    },
    now: () => fixedNow,
    createReceiptId: () => "00000000-0000-4000-8000-000000000018",
    attestationRef: "attestation/stage1-billing-maintenance-evidence"
  });
}
