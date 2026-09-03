import assert from "node:assert/strict";
import test from "node:test";

import { deterministicPlanDigest } from "@subscription-saas/release-foundation";

import {
  applyReturnClosureBackfill,
  planReturnClosureBackfill,
  reconcileReturnClosureBackfill
} from "../src/commands/stage1-return-closure-backfill.mjs";
import {
  applyReturnClosurePublicationConstraintValidation,
  planReturnClosurePublicationConstraintValidation,
  reconcileReturnClosurePublicationConstraintValidation
} from "../src/commands/stage1-return-closure-publication-constraint-validate.mjs";
import { executeStage1ReturnClosureBackfill } from "../../../scripts/stage1-return-closure-backfill-core.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const databaseIdentityFingerprint = digest("3");
const dmlInput = Object.freeze({
  operationId: "25d422be-1036-470c-a844-fe24735222cf",
  attemptId: "49101a87-aece-4c51-9be0-30233466510b",
  runId: "56f4ad5b-d7d3-4682-a835-0659a961c413",
  baselineManifestIdentityDigest: digest("1"),
  baselineManifestDigest: digest("2"),
  databaseIdentityFingerprint,
  generatedAt: "2026-09-02T09:00:00.000Z",
  postMigrationHead: "20260831010000_billing_maintenance_cycle_fact",
  expectedSchemaDigest: digest("4")
});
const dmlDependencies = Object.freeze({
  applyExecutionProofDigest: digest("5"),
  applyPostStateObservationDigest: digest("6"),
  replayExecutionProofDigest: digest("7"),
  dmlPlanDigest: digest("8"),
  dmlOperationId: dmlInput.operationId
});
const ddlInput = Object.freeze({
  operationId: "658d8171-c0b7-41af-b012-859e423d37fd",
  attemptId: "7cf4f606-292c-41c6-9ab8-f02d9c61797a",
  runId: "38571b77-6332-44dc-b46a-80f90e0036cb",
  buildProofDigest: digest("9"),
  sourceSha: "a".repeat(40),
  migrationCatalogDigest: digest("a"),
  repositoryContractDigest: digest("b"),
  baselineManifestIdentityDigest: dmlInput.baselineManifestIdentityDigest,
  baselineManifestDigest: dmlInput.baselineManifestDigest,
  databaseIdentityFingerprint,
  postMigrationHead: dmlInput.postMigrationHead,
  expectedSchemaDigest: dmlInput.expectedSchemaDigest,
  dmlApplyExecutionProofDigest: dmlDependencies.applyExecutionProofDigest,
  dmlApplyPostStateObservationDigest: dmlDependencies.applyPostStateObservationDigest,
  dmlReplayExecutionProofDigest: dmlDependencies.replayExecutionProofDigest,
  generatedAt: "2026-09-02T10:00:00.000Z"
});

test("matches the captured legacy DML-plus-validation result through two independent operations", async () => {
  const legacy = dmlHarness();
  const candidate = dmlHarness();
  const candidateConstraint = constraintHarness();
  const sequence = [];

  await executeStage1ReturnClosureBackfill({
    load: legacy.loadSnapshot,
    apply: (classification) => legacy.applyClassification(null, classification),
    mode: "apply"
  });
  legacy.constraintValidated = true;

  sequence.push("dml-dry-run");
  const dmlPlan = await planReturnClosureBackfill(candidate.context, dmlInput);
  sequence.push("dml-approval", "dml-apply");
  await applyReturnClosureBackfill(candidate.context, {
    input: dmlInput,
    planDigest: deterministicPlanDigest(dmlPlan)
  });
  sequence.push("dml-replay");
  await reconcileReturnClosureBackfill(candidate.context, {
    input: dmlInput,
    planDigest: deterministicPlanDigest(dmlPlan),
    approvedPlan: dmlPlan
  });
  sequence.push("dml-proof-custody", "ddl-dry-run");
  const ddlPlan = await planReturnClosurePublicationConstraintValidation(
    candidateConstraint.context,
    ddlInput,
    dmlDependencies
  );
  sequence.push("ddl-independent-approval", "ddl-apply");
  await applyReturnClosurePublicationConstraintValidation(candidateConstraint.context, {
    input: ddlInput,
    dependencies: dmlDependencies,
    planDigest: deterministicPlanDigest(ddlPlan)
  });
  candidateConstraint.statementLog.splice(0);
  sequence.push("ddl-replay");
  await reconcileReturnClosurePublicationConstraintValidation(candidateConstraint.context, {
    input: ddlInput,
    dependencies: dmlDependencies,
    approvedPlan: ddlPlan,
    planDigest: deterministicPlanDigest(ddlPlan)
  });

  assert.deepEqual(sequence, [
    "dml-dry-run",
    "dml-approval",
    "dml-apply",
    "dml-replay",
    "dml-proof-custody",
    "ddl-dry-run",
    "ddl-independent-approval",
    "ddl-apply",
    "ddl-replay"
  ]);
  assert.deepEqual(candidate.state, legacy.state);
  assert.equal(candidateConstraint.state.convalidated, legacy.constraintValidated);
  assert.deepEqual(candidate.state.paymentRecords, initialState().paymentRecords);
  assert.deepEqual(candidate.state.paymentWriteOffs, initialState().paymentWriteOffs);
  assert.equal(
    candidate.statementLog.some((sql) => /\bALTER\b/iu.test(sql)),
    false
  );
  assert.equal(
    candidateConstraint.statementLog.some((sql) =>
      /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/iu.test(sql)
    ),
    false
  );
});

function dmlHarness() {
  const state = initialState();
  const statementLog = [];
  const harness = { state, statementLog, constraintValidated: false };
  harness.loadSnapshot = async () => structuredClone(state);
  harness.applyClassification = async (_client, classification) => {
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
  harness.context = {
    databaseIdentityFingerprint,
    grantedCapabilityProfiles: ["repair"],
    prisma: { $transaction: async (callback) => callback({}) },
    loadSnapshot: harness.loadSnapshot,
    applyClassification: harness.applyClassification,
    statementLog,
    now: () => new Date("2026-09-02T10:00:00.000Z")
  };
  return harness;
}

function constraintHarness() {
  const statementLog = [];
  const state = {
    schema: "public",
    table: "subscription_closure_settlement_revision",
    tableOid: "16389",
    name: "subscription_closure_settlement_publication_check",
    constraintOid: "16394",
    definition:
      "CHECK (stage = 'FINALIZED'::subscription_closure_settlement_stage AND published_at IS NOT NULL AND publication_snapshot IS NOT NULL OR stage <> 'FINALIZED'::subscription_closure_settlement_stage AND published_at IS NULL AND publication_snapshot IS NULL) NOT VALID",
    convalidated: false,
    violationCount: 0
  };
  const context = {
    databaseIdentityFingerprint,
    grantedCapabilityProfiles: ["migrate"],
    statementLog,
    observePublicationConstraint: async () => structuredClone(state),
    withPublicationConstraintLock: async (_options, callback) => callback(),
    executePublicationConstraintValidation: async ({ sql }) => {
      statementLog.push(sql);
      state.convalidated = true;
      state.definition = state.definition.replace(/\s+NOT VALID$/u, "");
    },
    now: () => new Date("2026-09-02T10:01:00.000Z")
  };
  return { context, state, statementLog };
}

function initialState() {
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
      { deletedAt: null, id: "bill-1", orderId: "order-1", paidAmount: 0, remainingAmount: 1000 }
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
