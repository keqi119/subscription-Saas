import assert from "node:assert/strict";
import test from "node:test";

import { deterministicPlanDigest } from "@subscription-saas/release-foundation";

import { commandHandlers } from "../src/command-handlers.mjs";

import {
  classifyStage1ReturnClosureBackfill,
  executeStage1ReturnClosureBackfill
} from "../../../scripts/stage1-return-closure-backfill-core.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const INPUT = Object.freeze({
  operationId: "25d422be-1036-470c-a844-fe24735222cf",
  attemptId: "49101a87-aece-4c51-9be0-30233466510b",
  runId: "56f4ad5b-d7d3-4682-a835-0659a961c413",
  baselineManifestIdentityDigest: digest("1"),
  baselineManifestDigest: digest("2"),
  databaseIdentityFingerprint: digest("3"),
  generatedAt: "2026-09-02T09:00:00.000Z",
  postMigrationHead: "20260831010000_billing_maintenance_cycle_fact",
  expectedSchemaDigest: digest("4")
});

test("registers the DML-only return closure backfill handler", () => {
  const commandKey = "stage1.return-closure.backfill@1";
  if (!commandHandlers.has(commandKey)) {
    throw Object.assign(new Error(`RUNNER_HANDLER_MISSING:${commandKey}`), {
      code: `RUNNER_HANDLER_MISSING:${commandKey}`
    });
  }
  assert.equal(typeof commandHandlers.get(commandKey), "function");
});

test("matches legacy DML effects and preserves payment authority on independent states", async () => {
  const { applyReturnClosureBackfill, planReturnClosureBackfill } =
    await import("../src/commands/stage1-return-closure-backfill.mjs");
  const legacy = harness();
  const runner = harness();
  const legacyResult = await executeStage1ReturnClosureBackfill({
    apply: (classification) => legacy.applyClassification(null, classification),
    load: legacy.loadSnapshot,
    mode: "apply"
  });
  const plan = await planReturnClosureBackfill(runner.context, INPUT);
  const observation = await applyReturnClosureBackfill(runner.context, {
    input: INPUT,
    planDigest: deterministicPlanDigest(plan)
  });

  assert.equal(legacyResult.exitCode, 0);
  assert.deepEqual(runner.state, legacy.state);
  assert.deepEqual(runner.state.paymentRecords, fixture().paymentRecords);
  assert.deepEqual(runner.state.paymentWriteOffs, fixture().paymentWriteOffs);
  assert.equal(
    observation.postconditions.every(({ status }) => status === "PASSED"),
    true
  );
});

test("rejects stale bill and disposition authority before any DML", async () => {
  const { applyReturnClosureBackfill, planReturnClosureBackfill } =
    await import("../src/commands/stage1-return-closure-backfill.mjs");
  for (const mutate of [
    (state) => (state.bills[0].remainingAmount = 900),
    (state) => (state.dispositions[0].disposition = "DISPUTED")
  ]) {
    const subject = harness();
    const plan = await planReturnClosureBackfill(subject.context, INPUT);
    mutate(subject.state);
    await assert.rejects(
      () =>
        applyReturnClosureBackfill(subject.context, {
          input: INPUT,
          planDigest: deterministicPlanDigest(plan)
        }),
      { code: "PLAN_CHANGED_SINCE_APPROVAL" }
    );
    assert.equal(
      subject.statementLog.some((sql) => /^\s*(?:INSERT|UPDATE|DELETE)/i.test(sql)),
      false
    );
  }
});

test("rejects DDL and payment-table DML in repair statement evidence", async () => {
  const { assertReturnClosureDmlStatements } =
    await import("../src/commands/stage1-return-closure-backfill.mjs");
  assert.throws(
    () =>
      assertReturnClosureDmlStatements([
        'ALTER TABLE "subscription_closure_settlement_revision" VALIDATE CONSTRAINT "subscription_closure_settlement_publication_check"'
      ]),
    { code: "RETURN_CLOSURE_DDL_STATEMENT_FORBIDDEN" }
  );
  assert.throws(
    () => assertReturnClosureDmlStatements(['UPDATE "payment_record" SET "payment_status" = $1']),
    { code: "RETURN_CLOSURE_DML_TARGET_FORBIDDEN" }
  );
});

test("rejects a wrong or combined database capability before reading Closure facts", async () => {
  const { planReturnClosureBackfill } =
    await import("../src/commands/stage1-return-closure-backfill.mjs");
  for (const grantedCapabilityProfiles of [["migrate"], ["repair", "migrate"]]) {
    const subject = harness();
    subject.context.grantedCapabilityProfiles = grantedCapabilityProfiles;
    let reads = 0;
    subject.context.loadSnapshot = async () => {
      reads += 1;
      return fixture();
    };
    await assert.rejects(() => planReturnClosureBackfill(subject.context, INPUT), {
      code: "RUNNER_CAPABILITY_CREDENTIAL_MISMATCH"
    });
    assert.equal(reads, 0);
  }
});

test("marks after-commit statement-policy failure UNKNOWN and reconciles without duplicate DML", async () => {
  const { applyReturnClosureBackfill, planReturnClosureBackfill, reconcileReturnClosureBackfill } =
    await import("../src/commands/stage1-return-closure-backfill.mjs");
  const subject = harness();
  const originalApply = subject.context.applyClassification;
  subject.context.applyClassification = async (...args) => {
    const result = await originalApply(...args);
    subject.statementLog.push(
      'ALTER TABLE "subscription_closure_settlement_revision" VALIDATE CONSTRAINT "subscription_closure_settlement_publication_check"'
    );
    return result;
  };
  const plan = await planReturnClosureBackfill(subject.context, INPUT);
  const planDigest = deterministicPlanDigest(plan);
  await assert.rejects(
    () => applyReturnClosureBackfill(subject.context, { input: INPUT, planDigest }),
    (error) =>
      error.code === "RETURN_CLOSURE_DDL_STATEMENT_FORBIDDEN" &&
      error.outcomeUnknown === true &&
      error.commitState === "committed-result-unproved"
  );
  const before = structuredClone(subject.state);
  subject.statementLog.splice(0);
  const result = await reconcileReturnClosureBackfill(subject.context, {
    input: INPUT,
    planDigest,
    approvedPlan: plan
  });
  assert.equal(result.terminalStatus, "PASSED");
  assert.deepEqual(subject.state, before);
});

test("detects payment/write-off authority changes made during DML apply", async () => {
  const { applyReturnClosureBackfill, planReturnClosureBackfill } =
    await import("../src/commands/stage1-return-closure-backfill.mjs");
  const subject = harness();
  const originalApply = subject.context.applyClassification;
  subject.context.applyClassification = async (...args) => {
    const result = await originalApply(...args);
    subject.state.paymentWriteOffs[0].writeOffAmount = 2;
    return result;
  };
  const plan = await planReturnClosureBackfill(subject.context, INPUT);
  await assert.rejects(
    () =>
      applyReturnClosureBackfill(subject.context, {
        input: INPUT,
        planDigest: deterministicPlanDigest(plan)
      }),
    (error) => error.outcomeUnknown === true
  );
});

function harness() {
  const state = fixture();
  const statementLog = [];
  const subject = { state, statementLog };
  subject.loadSnapshot = async () => structuredClone(state);
  subject.applyClassification = async (_client, classification) => {
    const counts = { clauses: 0, fileAuthorities: 0, financial: 0, legacyLinks: 0 };
    for (const item of classification.fileAuthorityUpdates.filter(
      ({ disposition }) => disposition === "UPDATE"
    )) {
      state.files.find(({ id }) => id === item.fileId).contentSha256 = item.toContentSha256;
      statementLog.push('UPDATE "file_object" SET "content_sha256" = $1 WHERE "id" = $2');
      counts.fileAuthorities += 1;
    }
    for (const item of classification.legacyEvidenceLinks.filter(
      ({ disposition }) => disposition === "CREATE"
    )) {
      state.links.push({ sourceKey: item.sourceKey });
      statementLog.push('INSERT INTO "vehicle_return_evidence_link" ("source_key") VALUES ($1)');
      counts.legacyLinks += 1;
    }
    for (const { disposition: _disposition, ...item } of classification.clauseSnapshots.filter(
      ({ disposition }) => disposition === "CREATE"
    )) {
      state.clauses.push(item);
      statementLog.push(
        'INSERT INTO "contract_charge_clause_snapshot" ("contract_id") VALUES ($1)'
      );
      counts.clauses += 1;
    }
    for (const item of classification.financialUpdates.filter(
      ({ disposition }) => disposition === "UPDATE"
    )) {
      const closure = state.closures.find(({ id }) => id === item.closureCaseId);
      closure.financialStatus = item.to;
      closure.version += 1;
      statementLog.push(
        'UPDATE "subscription_closure_case" SET "financial_status" = $1 WHERE "id" = $2'
      );
      counts.financial += 1;
    }
    return { batchSize: 100, ...counts };
  };
  subject.context = {
    databaseIdentityFingerprint: INPUT.databaseIdentityFingerprint,
    grantedCapabilityProfiles: ["repair"],
    prisma: { $transaction: async (callback) => callback({}) },
    loadSnapshot: subject.loadSnapshot,
    applyClassification: subject.applyClassification,
    statementLog,
    now: () => new Date("2026-09-02T10:00:00.000Z")
  };
  return subject;
}

function fixture() {
  return {
    audits: [
      {
        action: "APPROVE",
        afterSnapshot: {
          fileId: "contract-file-1",
          signedPdfHash: "b".repeat(64),
          status: "ARCHIVED"
        },
        entityId: "contract-1",
        entityType: "contract"
      }
    ],
    bills: [
      {
        deletedAt: null,
        id: "bill-1",
        orderId: "order-1",
        paidAmount: 0,
        remainingAmount: 1000
      }
    ],
    clauses: [],
    closures: [
      {
        contractId: "contract-1",
        currentChecklistRevisionId: "checklist-1",
        currentDeltaRevisionId: "delta-1",
        currentSettlementRevisionId: "settlement-1",
        financialStatus: "DRAFT",
        id: "closure-1",
        orderId: "order-1",
        retiredAt: null,
        version: 3
      }
    ],
    contracts: [
      {
        archivedAt: "2026-08-28T00:00:00.000Z",
        contractSnapshot: {
          contentTemplate: "monthly mileage and overage terms",
          order: { mileageLimitKm: 1500, overMileageFeeAmount: 125, periodMonths: 12 }
        },
        fileId: "contract-file-1",
        id: "contract-1",
        signedAt: "2026-08-27T00:00:00.000Z",
        status: "ARCHIVED"
      }
    ],
    damages: [
      {
        deletedAt: null,
        id: "damage-1",
        orderId: "order-1",
        photoUrls: ["https://legacy.test/a.jpg?token=secret"]
      }
    ],
    deliveries: [
      {
        archiveStatus: "ARCHIVED",
        archivedAt: "2026-08-27T00:00:00.000Z",
        id: "delivery-1",
        orderId: "order-1",
        signedDocumentFileId: "delivery-file-1",
        signedPdfHash: "a".repeat(64),
        status: "ARCHIVED"
      }
    ],
    dispositions: [
      {
        billId: "bill-1",
        closureCaseId: "closure-1",
        createdAt: "2026-08-28T00:00:00.000Z",
        disposition: "COLLECTION_PENDING",
        id: "disposition-1",
        supersedesDispositionId: null
      }
    ],
    files: [
      { contentSha256: "a".repeat(64), id: "delivery-file-1" },
      { contentSha256: "b".repeat(64), id: "contract-file-1" }
    ],
    links: [],
    paymentRecords: [
      {
        deletedAt: null,
        id: "payment-1",
        orderId: "order-1",
        paymentAmount: 500,
        paymentStatus: "CONFIRMED",
        receivedAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z"
      }
    ],
    paymentWriteOffs: [
      {
        billId: "bill-1",
        deletedAt: null,
        id: "writeoff-1",
        orderId: "order-1",
        paymentId: "payment-1",
        writeOffAmount: 1,
        writeOffAt: "2026-08-28T00:00:00.000Z"
      }
    ],
    settlements: [
      {
        amountDueCents: 1000,
        closureCaseId: "closure-1",
        id: "settlement-1",
        publicationSnapshot: { channel: "PORTAL" },
        publishedAt: "2026-08-28T00:00:00.000Z",
        revisionNumber: 1,
        stage: "FINALIZED"
      }
    ]
  };
}
