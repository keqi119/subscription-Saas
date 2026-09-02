import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyStage1ReturnClosureBackfill,
  executeStage1ReturnClosureBackfill,
  parseStage1ReturnClosureBackfillArgs
} from "./stage1-return-closure-backfill-core.mjs";
import { applyClassification } from "./stage1-return-closure-backfill.mjs";

test("requires one explicit mode and accepts one output path", () => {
  assert.deepEqual(parseStage1ReturnClosureBackfillArgs(["--dry-run"]), {
    mode: "dry-run",
    output: null
  });
  assert.deepEqual(
    parseStage1ReturnClosureBackfillArgs(["--apply", "--output=output/return.json"]),
    { mode: "apply", output: "output/return.json" }
  );
  for (const args of [[], ["--dry-run", "--apply"], ["--dry-run", "--output"], ["--x"]]) {
    assert.throws(() => parseStage1ReturnClosureBackfillArgs(args), /ARGUMENTS_INVALID/);
  }
});

test("classifies legacy URLs without fabricating file hashes and compiles exact contract terms", () => {
  const report = classifyStage1ReturnClosureBackfill(fixture());
  assert.equal(report.counters.legacyUrlCreates, 1);
  assert.equal(report.legacyEvidenceLinks[0].evidencePurpose, "LEGACY_EXTERNAL_REFERENCE");
  assert.equal(
    report.legacyEvidenceLinks[0].legacyExternalReference,
    "https://legacy.test/a.jpg?token=secret#fragment"
  );
  assert.equal(Object.hasOwn(report.legacyEvidenceLinks[0], "contentSha256"), false);
  const mileageClause = report.clauseSnapshots.find((item) => item.clauseCode === "OVER_MILEAGE");
  assert.deepEqual(mileageClause.pricingSnapshot, {
    includedQuantity: 18000,
    monthlyIncludedQuantity: 1500,
    periodMonths: 12,
    unitPriceCents: 125
  });
  assert.equal(mileageClause.status, "EXECUTABLE");
  assert.ok(report.clauseSnapshots.some((item) => item.clauseCode === "DAMAGE_VEHICLE_EXTERIOR"));
  assert.equal(report.financialUpdates[0].to, "COLLECTION_PENDING");
  assert.deepEqual(
    report.manualReview.map((item) => item.code),
    ["MISSING_CONDITION_DELTA", "MISSING_RETURN_CHECKLIST"]
  );
});

test("missing exact price inputs is manual review rather than a default price", () => {
  const snapshot = fixture();
  snapshot.contracts[0].contractSnapshot = { contentTemplate: "损伤费用另行确认", order: {} };
  const report = classifyStage1ReturnClosureBackfill(snapshot);
  const mileageClause = report.clauseSnapshots.find((item) => item.clauseCode === "OVER_MILEAGE");
  assert.equal(mileageClause.status, "MANUAL_CLAUSE_REVIEW_REQUIRED");
  assert.equal(mileageClause.pricingSnapshot.unitPriceCents, undefined);
  assert.ok(report.manualReview.some((item) => item.code === "MANUAL_CLAUSE_REVIEW_REQUIRED"));
});

test("dry-run performs no writes and apply receives only a clean deterministic report", async () => {
  let writes = 0;
  const dryRun = await executeStage1ReturnClosureBackfill({
    apply: async () => {
      writes += 1;
    },
    load: async () => fixture(),
    mode: "dry-run"
  });
  assert.equal(dryRun.exitCode, 1);
  assert.equal(dryRun.report.applied, null);
  assert.equal(
    dryRun.report.legacyEvidenceLinks[0].legacyExternalReference,
    "https://legacy.test/a.jpg"
  );
  assert.equal(writes, 0);

  const clean = fixture();
  clean.closures[0].currentChecklistRevisionId = "checklist-1";
  clean.closures[0].currentDeltaRevisionId = "delta-1";
  const applied = await executeStage1ReturnClosureBackfill({
    apply: async (classification) => {
      writes += 1;
      return { legacyLinks: classification.counters.legacyUrlCreates };
    },
    load: async () => clean,
    mode: "apply"
  });
  assert.equal(applied.exitCode, 0);
  assert.deepEqual(applied.report.applied, { legacyLinks: 1 });
  assert.equal(writes, 1);
});

test("apply quarantines manual-review closures while applying clean closure facts", async () => {
  const snapshot = fixture();
  const cleanClosure = structuredClone(snapshot.closures[0]);
  cleanClosure.id = "closure-2";
  cleanClosure.orderId = "order-2";
  cleanClosure.contractId = "contract-2";
  cleanClosure.currentChecklistRevisionId = "checklist-2";
  cleanClosure.currentDeltaRevisionId = "delta-2";
  cleanClosure.currentSettlementRevisionId = "settlement-2";
  snapshot.closures.push(cleanClosure);
  snapshot.contracts.push({
    ...structuredClone(snapshot.contracts[0]),
    id: "contract-2"
  });
  snapshot.audits.push({
    ...structuredClone(snapshot.audits[0]),
    entityId: "contract-2"
  });
  snapshot.deliveries.push({
    ...structuredClone(snapshot.deliveries[0]),
    id: "delivery-2",
    orderId: "order-2"
  });
  snapshot.settlements.push({
    ...structuredClone(snapshot.settlements[0]),
    closureCaseId: "closure-2",
    id: "settlement-2"
  });
  snapshot.bills.push({
    ...structuredClone(snapshot.bills[0]),
    id: "bill-2",
    orderId: "order-2"
  });
  snapshot.dispositions.push({
    ...structuredClone(snapshot.dispositions[0]),
    billId: "bill-2",
    closureCaseId: "closure-2"
  });
  let appliedClassification = null;
  const result = await executeStage1ReturnClosureBackfill({
    apply: async (classification) => {
      appliedClassification = classification;
      return { safeClosures: classification.financialUpdates.map((item) => item.closureCaseId) };
    },
    load: async () => snapshot,
    mode: "apply"
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.blocked, true);
  assert.deepEqual(result.report.quarantinedClosureIds, ["closure-1"]);
  assert.deepEqual(result.report.quarantinedContractIds, ["contract-1"]);
  assert.deepEqual(
    appliedClassification.financialUpdates.map((item) => item.closureCaseId),
    ["closure-2"]
  );
  assert.ok(
    appliedClassification.clauseSnapshots.every((item) => item.contractId === "contract-2")
  );
  assert.deepEqual(result.report.applied, { safeClosures: ["closure-2"] });
});

test("scans every historical FINALIZED settlement for immutable publication facts", () => {
  const snapshot = fixture();
  snapshot.settlements.unshift({
    amountDueCents: 1000,
    closureCaseId: "closure-1",
    id: "settlement-unpublished",
    publicationSnapshot: null,
    publishedAt: null,
    revisionNumber: 0,
    stage: "FINALIZED"
  });
  const report = classifyStage1ReturnClosureBackfill(snapshot);
  assert.ok(
    report.manualReview.some(
      (item) =>
        item.code === "MISSING_SETTLEMENT_PUBLICATION_FACT" &&
        item.settlementRevisionId === "settlement-unpublished"
    )
  );
  assert.equal(report.publicationValidationReady, false);
});

test("scans FINALIZED settlement publication facts for retired closures", () => {
  const snapshot = fixture();
  snapshot.closures[0].retiredAt = "2026-08-29T00:00:00.000Z";
  snapshot.settlements[0].publicationSnapshot = null;
  snapshot.settlements[0].publishedAt = null;
  const report = classifyStage1ReturnClosureBackfill(snapshot);
  assert.ok(
    report.manualReview.some(
      (item) =>
        item.code === "MISSING_SETTLEMENT_PUBLICATION_FACT" &&
        item.settlementRevisionId === "settlement-1"
    )
  );
  assert.equal(report.publicationValidationReady, false);
});

test("quarantines a closure when its signed contract file has no trusted hash", () => {
  const snapshot = fixture();
  snapshot.files.find((file) => file.id === "contract-file-1").contentSha256 = null;
  snapshot.audits = [];
  const report = classifyStage1ReturnClosureBackfill(snapshot);
  assert.ok(
    report.manualReview.some((item) => item.code === "MISSING_SIGNED_CONTRACT_FILE_AUTHORITY")
  );
  assert.deepEqual(report.quarantinedClosureIds, ["closure-1"]);
});

test("does not trust a generated draft hash without an archived-contract audit", () => {
  const snapshot = fixture();
  snapshot.audits = [];
  const report = classifyStage1ReturnClosureBackfill(snapshot);
  assert.ok(
    report.manualReview.some((item) => item.code === "MISSING_SIGNED_CONTRACT_FILE_AUTHORITY")
  );
  assert.deepEqual(report.quarantinedClosureIds, ["closure-1"]);
});

test("does not trust a signed-contract audit attached to another contract", () => {
  const snapshot = fixture();
  snapshot.audits[0].entityId = "another-contract";
  const report = classifyStage1ReturnClosureBackfill(snapshot);
  assert.ok(
    report.manualReview.some((item) => item.code === "MISSING_SIGNED_CONTRACT_FILE_AUTHORITY")
  );
});

test("uses a trusted signed-contract audit hash as an explicit file authority update", () => {
  const snapshot = fixture();
  const trustedHash = "c".repeat(64);
  snapshot.files.find((file) => file.id === "contract-file-1").contentSha256 = null;
  snapshot.audits.push({
    action: "UPDATE",
    afterSnapshot: {
      fileId: "contract-file-1",
      signedPdfHash: trustedHash,
      status: "ARCHIVED"
    },
    entityId: "contract-1",
    entityType: "contract"
  });
  const report = classifyStage1ReturnClosureBackfill(snapshot);
  assert.equal(
    report.manualReview.some((item) => item.code === "MISSING_SIGNED_CONTRACT_FILE_AUTHORITY"),
    false
  );
  assert.deepEqual(report.fileAuthorityUpdates, [
    {
      closureCaseId: "closure-1",
      contractId: "contract-1",
      disposition: "UPDATE",
      expectedContentSha256: null,
      fileId: "contract-file-1",
      toContentSha256: trustedHash
    }
  ]);
});

test("apply preflights every historical publication before the first write", async () => {
  let writes = 0;
  const client = {
    $queryRawUnsafe: async () => [{ missingCount: 1 }],
    $transaction: async () => {
      writes += 1;
      throw new Error("unexpected write");
    }
  };
  await assert.rejects(
    applyClassification(client, {
      clauseSnapshots: [{ disposition: "CREATE" }],
      financialUpdates: [],
      legacyEvidenceLinks: [],
      publicationValidationReady: true
    }),
    /STAGE1_RETURN_CLOSURE_BACKFILL_PUBLICATION_PREFLIGHT_FAILED/
  );
  assert.equal(writes, 0);
});

test("the DML backfill never validates the publication constraint", async () => {
  let ddlCalls = 0;
  const client = {
    $executeRawUnsafe: async () => {
      ddlCalls += 1;
      throw new Error("DDL_MUST_NOT_RUN");
    },
    $queryRawUnsafe: async () => [{ missingCount: 0 }]
  };
  const result = await applyClassification(client, {
    clauseSnapshots: [],
    fileAuthorityUpdates: [],
    financialUpdates: [],
    legacyEvidenceLinks: [],
    publicationValidationReady: true
  });
  assert.equal(ddlCalls, 0);
  assert.deepEqual(result, {
    batchSize: 100,
    clauses: 0,
    fileAuthorities: 0,
    financial: 0,
    legacyLinks: 0
  });
});

test("apply persists a trusted contract audit hash with compare-and-set semantics", async () => {
  let contentSha256 = null;
  const trustedHash = "c".repeat(64);
  const client = {
    $transaction: async (callback) =>
      callback({
        fileObject: {
          findUnique: async () => ({ contentSha256, id: "contract-file-1" }),
          updateMany: async ({ data, where }) => {
            if (where.contentSha256 !== contentSha256) return { count: 0 };
            contentSha256 = data.contentSha256;
            return { count: 1 };
          }
        }
      })
  };
  const result = await applyClassification(client, {
    clauseSnapshots: [],
    fileAuthorityUpdates: [
      {
        disposition: "UPDATE",
        expectedContentSha256: null,
        fileId: "contract-file-1",
        toContentSha256: trustedHash
      }
    ],
    financialUpdates: [],
    legacyEvidenceLinks: []
  });
  assert.equal(contentSha256, trustedHash);
  assert.equal(result.fileAuthorities, 1);
});

test("apply rejects a concurrent legacy evidence link with the same source but different facts", async () => {
  const client = {
    $queryRawUnsafe: async () => [{ missingCount: 0 }],
    $executeRawUnsafe: async () => undefined,
    $transaction: async (callback) =>
      callback({
        vehicleReturnEvidenceLink: {
          findUnique: async () => ({
            closureCaseId: "different-closure",
            damageId: "damage-1",
            evidencePurpose: "LEGACY_EXTERNAL_REFERENCE",
            legacyExternalReference: "https://legacy.test/a.jpg",
            sourceId: "damage-1",
            sourceKey: "legacy-photo:0",
            sourceType: "VEHICLE_RETURN_DAMAGE",
            visibility: "CUSTOMER_VISIBLE"
          })
        }
      })
  };

  await assert.rejects(
    applyClassification(client, {
      clauseSnapshots: [],
      financialUpdates: [],
      legacyEvidenceLinks: [
        {
          closureCaseId: "closure-1",
          damageId: "damage-1",
          disposition: "CREATE",
          evidencePurpose: "LEGACY_EXTERNAL_REFERENCE",
          legacyExternalReference: "https://legacy.test/a.jpg",
          sourceId: "damage-1",
          sourceKey: "legacy-photo:0",
          sourceType: "VEHICLE_RETURN_DAMAGE",
          visibility: "CUSTOMER_VISIBLE"
        }
      ]
    }),
    /STAGE1_RETURN_CLOSURE_BACKFILL_CONCURRENT_EVIDENCE_LINK_CONFLICT/
  );
});

test("apply rejects a financial projection when bill authority changed after classification", async () => {
  const clean = fixture();
  clean.closures[0].currentChecklistRevisionId = "checklist-1";
  clean.closures[0].currentDeltaRevisionId = "delta-1";
  const classification = classifyStage1ReturnClosureBackfill(clean);
  const client = {
    $queryRawUnsafe: async () => [{ missingCount: 0 }],
    $executeRawUnsafe: async () => undefined,
    $transaction: async (callback) =>
      callback({
        receivableBill: {
          findMany: async () => [
            {
              deletedAt: null,
              id: "bill-1",
              orderId: "order-1",
              paidAmount: 500,
              remainingAmount: 500
            }
          ]
        },
        subscriptionClosureCase: {
          findUnique: async () => ({ orderId: "order-1", version: 3 })
        },
        subscriptionClosureReceivableDisposition: {
          findMany: async () => clean.dispositions
        }
      })
  };
  await assert.rejects(
    applyClassification(client, {
      ...classification,
      clauseSnapshots: [],
      legacyEvidenceLinks: []
    }),
    /STAGE1_RETURN_CLOSURE_BACKFILL_CONCURRENT_FINANCIAL_CHANGE/
  );
});

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
        currentChecklistRevisionId: null,
        currentDeltaRevisionId: null,
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
          contentTemplate: "每月 1500 公里，超出每公里 1.25 元。",
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
        photoUrls: ["https://legacy.test/a.jpg?token=secret#fragment"]
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
    files: [
      { contentSha256: "a".repeat(64), id: "delivery-file-1" },
      { contentSha256: "b".repeat(64), id: "contract-file-1" }
    ],
    dispositions: [
      {
        billId: "bill-1",
        closureCaseId: "closure-1",
        createdAt: "2026-08-28T00:00:00.000Z",
        disposition: "COLLECTION_PENDING"
      }
    ],
    links: [],
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
