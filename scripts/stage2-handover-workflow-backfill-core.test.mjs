import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStage2HandoverWorkflowBackfillPlan,
  parseStage2HandoverWorkflowBackfillMode
} from "./stage2-handover-workflow-backfill-core.mjs";

const MANIFEST_HASH = "a".repeat(64);
const SOURCE_PDF_HASH = "b".repeat(64);
const CUSTOMER_TRANSACTION_ID = "ESG20260726080000ABCDH1";
const PLATFORM_TRANSACTION_ID = "ESG20260726080000ABCDH2";

test("backfills internal and external canonical operator snapshots", () => {
  const plan = buildStage2HandoverWorkflowBackfillPlan([
    baseRecord({
      assignedInternalUser: {
        deletedAt: null,
        id: "user-1",
        mobile: "+86 138-0013-8000",
        name: "Internal Operator"
      },
      assignedInternalUserId: "user-1",
      fieldOperatorName: null,
      fieldOperatorPhone: null,
      id: "work-order-internal",
      operatorType: "INTERNAL"
    }),
    baseRecord({
      externalOperatorName: "External Operator",
      externalOperatorPhone: "139 0013 9000",
      fieldOperatorName: "Stale Name",
      fieldOperatorPhone: "13700000000",
      id: "work-order-external",
      operatorType: "EXTERNAL"
    })
  ]);

  assert.deepEqual(plan.operatorSnapshotUpdates, [
    {
      expectedFieldOperatorName: null,
      expectedFieldOperatorPhone: null,
      fieldOperatorName: "Internal Operator",
      fieldOperatorPhone: "13800138000",
      operatorType: "INTERNAL",
      sourceId: "user-1",
      workOrderId: "work-order-internal"
    },
    {
      expectedFieldOperatorName: "Stale Name",
      expectedFieldOperatorPhone: "13700000000",
      fieldOperatorName: "External Operator",
      fieldOperatorPhone: "13900139000",
      operatorType: "EXTERNAL",
      sourceId: "work-order-external",
      workOrderId: "work-order-external"
    }
  ]);
  assert.deepEqual(plan.exceptions, []);
});

test("reports internal users without a valid mobile", () => {
  const plan = buildStage2HandoverWorkflowBackfillPlan([
    baseRecord({
      assignedInternalUser: {
        deletedAt: null,
        id: "user-invalid",
        mobile: "021-5555-1234",
        name: "Internal Operator"
      },
      assignedInternalUserId: "user-invalid",
      externalOperatorName: "Legacy External Name",
      externalOperatorPhone: "13800138000",
      fieldOperatorName: "Legacy Canonical Name",
      fieldOperatorPhone: "13800138000",
      id: "work-order-invalid-internal",
      operatorType: "INTERNAL"
    })
  ]);

  assert.deepEqual(plan.operatorSnapshotUpdates, []);
  assert.deepEqual(plan.exceptions, [
    {
      code: "INTERNAL_OPERATOR_MOBILE_INVALID",
      sourceId: "user-invalid",
      workOrderId: "work-order-invalid-internal"
    }
  ]);
});

test("does not use a canonical or legacy fallback for an unassigned internal operator", () => {
  const record = withReadySource(
    baseRecord({
      assignedInternalUser: null,
      assignedInternalUserId: null,
      externalOperatorName: "Legacy External Name",
      externalOperatorPhone: "13800138000",
      fieldOperatorName: "Legacy Canonical Name",
      fieldOperatorPhone: "13800138000",
      id: "work-order-unassigned-internal",
      operatorType: "INTERNAL"
    })
  );

  const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

  assert.deepEqual(plan.operatorSnapshotUpdates, []);
  assert.deepEqual(plan.jobCandidates, []);
  assert.deepEqual(plan.exceptions, [
    {
      code: "INTERNAL_OPERATOR_NOT_ASSIGNED",
      sourceId: "work-order-unassigned-internal",
      workOrderId: "work-order-unassigned-internal"
    }
  ]);
});

test("creates GENERATE_SOURCE_PDF after confirmed review without a source artifact", () => {
  const plan = buildStage2HandoverWorkflowBackfillPlan([baseRecord()]);

  assert.deepEqual(plan.jobCandidates, [
    {
      eSignTaskId: null,
      handoverId: "handover-1",
      idempotencyKey: `pdf:work-order-1:review-attempt-1:${MANIFEST_HASH}`,
      jobType: "GENERATE_SOURCE_PDF",
      payload: {
        manifestHash: MANIFEST_HASH,
        reviewAttemptId: "review-attempt-1"
      },
      workOrderId: "work-order-1"
    }
  ]);
});

test("creates NOTIFY_FIELD_ESIGN_READY for a ready source artifact without an eSign task", () => {
  const record = withReadySource(baseRecord());
  const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

  assert.deepEqual(plan.jobCandidates, [
    {
      eSignTaskId: null,
      handoverId: "handover-1",
      idempotencyKey: "field-notify:work-order-1:2",
      jobType: "NOTIFY_FIELD_ESIGN_READY",
      payload: {
        artifactVersion: 2,
        manifestHash: MANIFEST_HASH,
        sourcePdfHash: SOURCE_PDF_HASH
      },
      workOrderId: "work-order-1"
    }
  ]);
});

test("creates RECONCILE_CUSTOMER_SIGNATURE for an active typed customer transaction", () => {
  const record = withActiveTask(withReadySource(baseRecord()));
  const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

  assert.deepEqual(plan.jobCandidates, [
    {
      eSignTaskId: "stage2-task-1",
      handoverId: "handover-1",
      idempotencyKey: `customer-reconcile:stage2-task-1:${CUSTOMER_TRANSACTION_ID}`,
      jobType: "RECONCILE_CUSTOMER_SIGNATURE",
      payload: {
        customerTransactionId: CUSTOMER_TRANSACTION_ID
      },
      workOrderId: "work-order-1"
    }
  ]);
});

test("creates AUTO_SEAL_PLATFORM when customer is signed and platform is pending", () => {
  const record = withActiveTask(withReadySource(baseRecord()));
  record.handover.handoverESignTask.taskStatus = "SIGNING";
  record.handover.handoverESignTask.signers[0].signerStatus = "SIGNED";
  record.handover.status = "PENDING_PLATFORM_SEAL";

  const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

  assert.deepEqual(plan.jobCandidates, [
    {
      eSignTaskId: "stage2-task-1",
      handoverId: "handover-1",
      idempotencyKey: `platform-seal:stage2-task-1:${PLATFORM_TRANSACTION_ID}`,
      jobType: "AUTO_SEAL_PLATFORM",
      payload: {
        platformTransactionId: PLATFORM_TRANSACTION_ID
      },
      workOrderId: "work-order-1"
    }
  ]);
});

test("creates ARCHIVE_SIGNED_PDF when both signers are signed but archive is incomplete", () => {
  const record = withActiveTask(withReadySource(baseRecord()));
  record.handover.handoverESignTask.taskStatus = "COMPLETED";
  record.handover.handoverESignTask.signers[0].signerStatus = "SIGNED";
  record.handover.handoverESignTask.signers[1].providerTransactionId = PLATFORM_TRANSACTION_ID;
  record.handover.handoverESignTask.signers[1].signerStatus = "SIGNED";
  record.handover.status = "SIGNED";

  const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

  assert.deepEqual(plan.jobCandidates, [
    {
      eSignTaskId: "stage2-task-1",
      handoverId: "handover-1",
      idempotencyKey: "archive:stage2-task-1:2",
      jobType: "ARCHIVE_SIGNED_PDF",
      payload: {
        artifactVersion: 2
      },
      workOrderId: "work-order-1"
    }
  ]);
});

test("does not archive a signed task bound to a noncanonical H1 transaction", () => {
  const record = withActiveTask(withReadySource(baseRecord()));
  record.handover.handoverESignTask.taskStatus = "COMPLETED";
  record.handover.handoverESignTask.signers[0].providerTransactionId =
    "WRONG-H1";
  record.handover.handoverESignTask.signers[0].signerStatus = "SIGNED";
  record.handover.handoverESignTask.signers[1].providerTransactionId =
    PLATFORM_TRANSACTION_ID;
  record.handover.handoverESignTask.signers[1].signerStatus = "SIGNED";
  record.handover.status = "SIGNED";

  const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

  assert.deepEqual(plan.jobCandidates, []);
  assert.deepEqual(plan.exceptions, [
    {
      code: "STAGE2_CUSTOMER_TRANSACTION_INVALID",
      sourceId: "handover-1",
      workOrderId: "work-order-1"
    }
  ]);
});

test("creates no job for cancelled, voided, terminal failed, or archived work", () => {
  const records = [
    baseRecord({
      id: "work-order-cancelled",
      status: "CANCELLED"
    }),
    baseRecord({
      id: "work-order-voided",
      status: "VOIDED"
    }),
    withReadySource(
      baseRecord({
        id: "work-order-failed"
      })
    ),
    withReadySource(
      baseRecord({
        handover: {
          ...baseRecord().handover,
          archiveStatus: "ARCHIVED",
          archivedAt: "2026-07-28T00:00:00.000Z",
          status: "ARCHIVED"
        },
        id: "work-order-archived"
      })
    )
  ];
  records[2].handover.status = "FAILED";

  const plan = buildStage2HandoverWorkflowBackfillPlan(records);

  assert.deepEqual(plan.jobCandidates, []);
});

test("is idempotent across repeated dry-run and apply evaluation", () => {
  const firstRecord = withActiveTask(
    withReadySource(
      baseRecord({
        fieldOperatorName: null,
        fieldOperatorPhone: null
      })
    )
  );
  const first = buildStage2HandoverWorkflowBackfillPlan([firstRecord]);
  const appliedRecord = structuredClone(firstRecord);
  for (const update of first.operatorSnapshotUpdates) {
    appliedRecord.fieldOperatorName = update.fieldOperatorName;
    appliedRecord.fieldOperatorPhone = update.fieldOperatorPhone;
  }
  appliedRecord.workflowJobs = first.jobCandidates.map(({ idempotencyKey }) => ({
    idempotencyKey
  }));

  const repeatedDryRun = buildStage2HandoverWorkflowBackfillPlan([appliedRecord]);
  const repeatedApply = buildStage2HandoverWorkflowBackfillPlan([appliedRecord]);

  assert.equal(first.operatorSnapshotUpdates.length, 1);
  assert.equal(first.jobCandidates.length, 1);
  assert.deepEqual(repeatedDryRun, {
    exceptions: [],
    jobCandidates: [],
    operatorSnapshotUpdates: [],
    recordCount: 1
  });
  assert.deepEqual(repeatedApply, repeatedDryRun);
});

test("requires exactly one explicit execution mode", () => {
  assert.equal(parseStage2HandoverWorkflowBackfillMode(["--dry-run"]), "dry-run");
  assert.equal(parseStage2HandoverWorkflowBackfillMode(["--apply"]), "apply");
  assert.throws(() => parseStage2HandoverWorkflowBackfillMode([]), /exactly one/);
  assert.throws(
    () => parseStage2HandoverWorkflowBackfillMode(["--dry-run", "--apply"]),
    /exactly one/
  );
});

function baseRecord(overrides = {}) {
  return {
    assignedInternalUser: {
      deletedAt: null,
      id: "user-1",
      mobile: "13800138000",
      name: "Internal Operator"
    },
    assignedInternalUserId: "user-1",
    customerConfirmedAt: "2026-07-27T00:00:00.000Z",
    externalOperatorName: null,
    externalOperatorPhone: null,
    fieldOperatorName: "Internal Operator",
    fieldOperatorPhone: "13800138000",
    handover: {
      archiveStatus: "NOT_STARTED",
      archivedAt: null,
      artifactVersion: 1,
      deletedAt: null,
      handoverESignTask: null,
      handoverESignTaskId: null,
      id: "handover-1",
      manifestHash: null,
      sourceDocumentFileId: null,
      sourcePdfHash: null,
      status: "DRAFT"
    },
    handoverId: "handover-1",
    id: "work-order-1",
    latestReview: {
      evidenceSnapshot: {
        evidencePackage: {
          manifestHash: MANIFEST_HASH
        }
      },
      id: "review-attempt-1",
      status: "CUSTOMER_CONFIRMED"
    },
    operatorType: "INTERNAL",
    orderId: "order-1",
    status: "CUSTOMER_CONFIRMED",
    workflowJobs: [],
    ...overrides
  };
}

function withReadySource(record) {
  record.handover = {
    ...record.handover,
    artifactVersion: 2,
    manifestHash: MANIFEST_HASH,
    sourceDocumentFileId: "file-source-1",
    sourcePdfHash: SOURCE_PDF_HASH,
    status: "SOURCE_GENERATED"
  };
  return record;
}

function withActiveTask(record) {
  record.handover.handoverESignTaskId = "stage2-task-1";
  record.handover.handoverESignTask = {
    deletedAt: null,
    documentType: "DELIVERY_HANDOVER",
    id: "stage2-task-1",
    signers: [
      {
        deletedAt: null,
        documentType: "DELIVERY_HANDOVER",
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        providerTransactionId: CUSTOMER_TRANSACTION_ID,
        required: true,
        signerStatus: "SIGNING",
        signerType: "CUSTOMER",
        slotId: "STAGE2_HANDOVER_CUSTOMER"
      },
      {
        deletedAt: null,
        documentType: "DELIVERY_HANDOVER",
        providerActionType: "PLATFORM_AUTO_SEAL",
        providerTransactionId: null,
        required: true,
        signerStatus: "PENDING",
        signerType: "PLATFORM",
        slotId: "STAGE2_HANDOVER_PLATFORM"
      }
    ],
    signingStage: "STAGE2_DELIVERY_HANDOVER",
    taskNo: "ESG20260726080000ABCD",
    taskStatus: "WAITING_CUSTOMER"
  };
  record.handover.status = "PENDING_CUSTOMER_SIGNATURE";
  record.status = "SIGNING";
  return record;
}
