import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStage2HandoverWorkflowBackfillPlan,
  parseStage2HandoverWorkflowBackfillMode
} from "./stage2-handover-workflow-backfill-core.mjs";

const MANIFEST_DIGEST = "a".repeat(64);
const MANIFEST_HASH = `sha256:${MANIFEST_DIGEST}`;
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
        name: "Internal Operator",
        status: "ACTIVE"
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

test("trims operator names without collapsing internal whitespace", () => {
  const plan = buildStage2HandoverWorkflowBackfillPlan([
    baseRecord({
      assignedInternalUser: {
        deletedAt: null,
        id: "user-1",
        mobile: "13800138000",
        name: "  Li  Ming  ",
        status: "ACTIVE"
      },
      fieldOperatorName: null,
      fieldOperatorPhone: null
    })
  ]);

  assert.deepEqual(plan.operatorSnapshotUpdates, [
    {
      expectedFieldOperatorName: null,
      expectedFieldOperatorPhone: null,
      fieldOperatorName: "Li  Ming",
      fieldOperatorPhone: "13800138000",
      operatorType: "INTERNAL",
      sourceId: "user-1",
      workOrderId: "work-order-1"
    }
  ]);
});

test("reports internal users without a valid mobile", () => {
  const plan = buildStage2HandoverWorkflowBackfillPlan([
    baseRecord({
      assignedInternalUser: {
        deletedAt: null,
        id: "user-invalid",
        mobile: "021-5555-1234",
        name: "Internal Operator",
        status: "ACTIVE"
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

  assert.deepEqual(plan.operatorSnapshotUpdates, [
    {
      expectedFieldOperatorName: "Legacy Canonical Name",
      expectedFieldOperatorPhone: "13800138000",
      fieldOperatorName: null,
      fieldOperatorPhone: null,
      operatorType: "INTERNAL",
      sourceId: "user-invalid",
      workOrderId: "work-order-invalid-internal"
    }
  ]);
  assert.deepEqual(plan.exceptions, [
    {
      code: "INTERNAL_OPERATOR_MOBILE_INVALID",
      sourceId: "user-invalid",
      workOrderId: "work-order-invalid-internal"
    }
  ]);
});

test("clears stale canonical snapshots for inactive or deleted internal users", () => {
  for (const assignedInternalUser of [
    {
      deletedAt: null,
      id: "user-disabled",
      mobile: "13800138000",
      name: "Disabled Operator",
      status: "DISABLED"
    },
    {
      deletedAt: "2026-07-27T01:00:00.000Z",
      id: "user-deleted",
      mobile: "13800138000",
      name: "Deleted Operator",
      status: "ACTIVE"
    }
  ]) {
    const plan = buildStage2HandoverWorkflowBackfillPlan([
      baseRecord({
        assignedInternalUser,
        assignedInternalUserId: assignedInternalUser.id,
        fieldOperatorName: assignedInternalUser.name,
        fieldOperatorPhone: assignedInternalUser.mobile,
        id: `work-order-${assignedInternalUser.id}`
      })
    ]);

    assert.deepEqual(plan.operatorSnapshotUpdates, [
      {
        expectedFieldOperatorName: assignedInternalUser.name,
        expectedFieldOperatorPhone: assignedInternalUser.mobile,
        fieldOperatorName: null,
        fieldOperatorPhone: null,
        operatorType: "INTERNAL",
        sourceId: assignedInternalUser.id,
        workOrderId: `work-order-${assignedInternalUser.id}`
      }
    ]);
    assert.deepEqual(plan.jobCandidates, []);
    assert.deepEqual(plan.exceptions, [
      {
        code: assignedInternalUser.status === "DISABLED"
          ? "INTERNAL_OPERATOR_INACTIVE"
          : "INTERNAL_OPERATOR_DELETED",
        sourceId: assignedInternalUser.id,
        workOrderId: `work-order-${assignedInternalUser.id}`
      }
    ]);
  }
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
      idempotencyKey: "field-notify:work-order-1:1",
      jobType: "NOTIFY_FIELD_ESIGN_READY",
      payload: {
        artifactVersion: 1,
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

test("reports an invalid platform signer state instead of silently converging", () => {
  const record = withActiveTask(withReadySource(baseRecord()));
  record.handover.handoverESignTask.taskStatus = "SIGNING";
  record.handover.handoverESignTask.signers[0].signerStatus = "SIGNED";
  record.handover.handoverESignTask.signers[1].signerStatus = "FAILED";
  record.handover.status = "PENDING_PLATFORM_SEAL";

  const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

  assert.deepEqual(plan.jobCandidates, []);
  assert.deepEqual(plan.exceptions, [
    {
      code: "STAGE2_WORKFLOW_STATE_INVALID",
      sourceId: "handover-1",
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
  record.handover.handoverContract.status = "SIGNED";
  record.handover.status = "SIGNED";

  const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

  assert.deepEqual(plan.jobCandidates, [
    {
      eSignTaskId: "stage2-task-1",
      handoverId: "handover-1",
      idempotencyKey: "archive:stage2-task-1:1",
      jobType: "ARCHIVE_SIGNED_PDF",
      payload: {
        artifactVersion: 1
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
  record.handover.handoverContract.status = "SIGNED";
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

test("reports return, objected, unconfirmed, resubmission, and stale reviews without jobs", () => {
  const cases = [
    {
      code: "STAGE2_HANDOVER_TYPE_INVALID",
      mutate(record) {
        record.handoverType = "RETURN_INBOUND";
      }
    },
    {
      code: "STAGE2_REVIEW_BINDING_INVALID",
      mutate(record) {
        record.customerObjectedAt = "2026-07-27T01:00:00.000Z";
        record.latestReview.status = "CUSTOMER_OBJECTED";
        record.status = "CUSTOMER_OBJECTED";
      }
    },
    {
      code: "STAGE2_REVIEW_BINDING_INVALID",
      mutate(record) {
        record.customerConfirmedAt = null;
      }
    },
    {
      code: "STAGE2_REVIEW_BINDING_INVALID",
      mutate(record) {
        record.latestReview.status = "RESUBMISSION_REQUESTED";
      }
    },
    {
      code: "STAGE2_REVIEW_BINDING_INVALID",
      mutate(record) {
        record.latestReview.handoverId = "stale-handover";
      }
    }
  ];

  for (const { code, mutate } of cases) {
    const record = baseRecord();
    mutate(record);
    const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

    assert.deepEqual(plan.jobCandidates, []);
    assert.deepEqual(plan.exceptions, [
      {
        code,
        sourceId: "handover-1",
        workOrderId: "work-order-1"
      }
    ]);
  }
});

test("rejects cross-order, contract, source, and customer task bindings", () => {
  const mutations = [
    (record) => {
      record.handover.handoverESignTask.orderId = "order-2";
    },
    (record) => {
      record.handover.handoverESignTask.contractId = "contract-stage2-2";
    },
    (record) => {
      record.handover.handoverESignTask.requestSnapshot.sourceDocumentFileId =
        "file-source-2";
    },
    (record) => {
      record.handover.handoverESignTask.customerId = "customer-2";
    }
  ];

  for (const mutate of mutations) {
    const record = withActiveTask(withReadySource(baseRecord()));
    mutate(record);
    const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

    assert.deepEqual(plan.jobCandidates, []);
    assert.deepEqual(plan.exceptions, [
      {
        code: "STAGE2_TASK_BINDING_INVALID",
        sourceId: "handover-1",
        workOrderId: "work-order-1"
      }
    ]);
  }
});

test("rejects inconsistent handover, contract, and source artifact bindings", () => {
  const mutations = [
    (record) => {
      record.handover.orderId = "order-2";
    },
    (record) => {
      record.handover.handoverContract.orderId = "order-2";
    },
    (record) => {
      record.handover.handoverContract.fileId = "file-source-2";
    },
    (record) => {
      record.handover.handoverContract.contractSnapshot.evidencePackage.manifestHash =
        `sha256:${"c".repeat(64)}`;
    }
  ];

  for (const mutate of mutations) {
    const record = withReadySource(baseRecord());
    mutate(record);
    const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

    assert.deepEqual(plan.jobCandidates, []);
    assert.equal(plan.exceptions.length, 1);
    assert.match(
      plan.exceptions[0].code,
      /^STAGE2_(HANDOVER|SOURCE)_BINDING_INVALID$/
    );
  }
});

test("rejects source artifacts outside the runtime version and size bounds", () => {
  const mutations = [
    (record) => {
      record.handover.artifactVersion = 2;
      record.handover.handoverContract.contractSnapshot
        .stage2HandoverPdfArtifact.artifactVersion = 2;
    },
    (record) => {
      record.handover.sourceFileObject.sizeBytes =
        18 * 1024 * 1024 + 1;
    }
  ];

  for (const mutate of mutations) {
    const record = withReadySource(baseRecord());
    mutate(record);
    const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

    assert.deepEqual(plan.jobCandidates, []);
    assert.deepEqual(plan.exceptions, [
      {
        code: "STAGE2_SOURCE_BINDING_INVALID",
        sourceId: "handover-1",
        workOrderId: "work-order-1"
      }
    ]);
  }
});

test("recognizes the canonical runtime PDF key with sha256 prefix", () => {
  const record = baseRecord();
  record.workflowJobs = [
    {
      eSignTaskId: null,
      handoverId: "handover-1",
      id: "runtime-pdf-job-1",
      idempotencyKey:
        `pdf:work-order-1:review-attempt-1:${MANIFEST_HASH}`,
      jobStatus: "PENDING",
      jobType: "GENERATE_SOURCE_PDF",
      payload: {
        manifestHash: MANIFEST_HASH,
        reviewAttemptId: "review-attempt-1"
      },
      workOrderId: "work-order-1"
    }
  ];

  const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

  assert.deepEqual(plan.jobCandidates, []);
  assert.deepEqual(plan.exceptions, []);
});

test("reports same-key wrong binding, payload, or status instead of false convergence", () => {
  const mutations = [
    (job) => {
      job.jobType = "AUTO_SEAL_PLATFORM";
    },
    (job) => {
      job.handoverId = "handover-2";
    },
    (job) => {
      job.eSignTaskId = "stage2-task-2";
    },
    (job) => {
      job.payload = {
        customerTransactionId: "ATTACKERCONTROLLEDH1"
      };
    },
    (job) => {
      job.jobStatus = "CANCELLED";
    },
    (job) => {
      job.workOrderId = "work-order-2";
    }
  ];

  for (const mutate of mutations) {
    const record = withActiveTask(withReadySource(baseRecord()));
    const job = {
      eSignTaskId: "stage2-task-1",
      handoverId: "handover-1",
      id: "existing-job-1",
      idempotencyKey:
        `customer-reconcile:stage2-task-1:${CUSTOMER_TRANSACTION_ID}`,
      jobStatus: "PENDING",
      jobType: "RECONCILE_CUSTOMER_SIGNATURE",
      payload: {
        customerTransactionId: CUSTOMER_TRANSACTION_ID
      },
      workOrderId: "work-order-1"
    };
    mutate(job);
    record.workflowJobs = [job];

    const plan = buildStage2HandoverWorkflowBackfillPlan([record]);

    assert.deepEqual(plan.jobCandidates, []);
    assert.deepEqual(plan.exceptions, [
      {
        code: "STAGE2_WORKFLOW_JOB_CONFLICT",
        sourceId: "existing-job-1",
        workOrderId: "work-order-1"
      }
    ]);
  }
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
  appliedRecord.workflowJobs = first.jobCandidates.map((candidate, index) => ({
    ...structuredClone(candidate),
    id: `applied-job-${index + 1}`,
    jobStatus: "PENDING"
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
  const record = {
    assignedInternalUser: {
      deletedAt: null,
      id: "user-1",
      mobile: "13800138000",
      name: "Internal Operator",
      status: "ACTIVE"
    },
    assignedInternalUserId: "user-1",
    customerConfirmedAt: "2026-07-27T00:00:00.000Z",
    customerObjectedAt: null,
    externalOperatorName: null,
    externalOperatorPhone: null,
    fieldOperatorName: "Internal Operator",
    fieldOperatorPhone: "13800138000",
    handover: {
      archiveStatus: "NOT_STARTED",
      archivedAt: null,
      artifactVersion: 1,
      deletedAt: null,
      handoverContract: null,
      handoverContractId: null,
      handoverESignTask: null,
      handoverESignTaskId: null,
      id: "handover-1",
      manifestHash: null,
      orderId: "order-1",
      sourceDocumentFileId: null,
      sourceObjectKey: null,
      sourcePdfHash: null,
      status: "DRAFT"
    },
    handoverId: "handover-1",
    handoverType: "DELIVERY_OUTBOUND",
    id: "work-order-1",
    latestReview: {
      customerConfirmedAt: "2026-07-27T00:00:00.000Z",
      evidenceSnapshot: {
        evidencePackage: {
          manifestHash: MANIFEST_HASH
        }
      },
      handoverId: "handover-1",
      id: "review-attempt-1",
      orderId: "order-1",
      status: "CUSTOMER_CONFIRMED",
      workOrderId: "work-order-1"
    },
    operatorType: "INTERNAL",
    order: {
      customerId: "customer-1",
      id: "order-1"
    },
    orderId: "order-1",
    status: "CUSTOMER_CONFIRMED",
    workflowJobs: [],
    ...overrides
  };
  if (overrides.id && !overrides.latestReview) {
    record.latestReview.workOrderId = overrides.id;
  }
  if (overrides.orderId && !overrides.order) {
    record.order.id = overrides.orderId;
    record.handover.orderId = overrides.orderId;
    record.latestReview.orderId = overrides.orderId;
  }
  if (overrides.handoverId && !overrides.handover) {
    record.handover.id = overrides.handoverId;
    record.latestReview.handoverId = overrides.handoverId;
  }
  return record;
}

function withReadySource(record) {
  record.handover = {
    ...record.handover,
    artifactVersion: 1,
    handoverContract: {
      contractSnapshot: {
        evidencePackage: {
          manifestHash: MANIFEST_HASH
        },
        fileId: "file-source-1",
        handoverId: record.handover.id,
        orderId: record.orderId,
        stage2HandoverPdfArtifact: {
          artifactVersion: 1,
          fileId: "file-source-1",
          sourcePdfHash: SOURCE_PDF_HASH
        },
        workOrderId: record.id
      },
      customerId: record.order.customerId,
      deletedAt: null,
      fileId: "file-source-1",
      id: "contract-stage2-1",
      orderId: record.orderId,
      status: "GENERATED"
    },
    handoverContractId: "contract-stage2-1",
    manifestHash: MANIFEST_DIGEST,
    sourceDocumentFileId: "file-source-1",
    sourceFileObject: {
      bucket: "application-materials",
      id: "file-source-1",
      mimeType: "application/pdf",
      objectKey: "contracts/contract-stage2-1/generated/handover.pdf",
      sizeBytes: 1024
    },
    sourceObjectKey: "contracts/contract-stage2-1/generated/handover.pdf",
    sourcePdfHash: SOURCE_PDF_HASH,
    status: "SOURCE_GENERATED"
  };
  return record;
}

function withActiveTask(record) {
  record.handover.handoverESignTaskId = "stage2-task-1";
  record.handover.handoverESignTask = {
    contractId: "contract-stage2-1",
    customerId: record.order.customerId,
    deletedAt: null,
    documentType: "DELIVERY_HANDOVER",
    id: "stage2-task-1",
    orderId: record.orderId,
    requestSnapshot: {
      artifactVersion: 1,
      contractId: "contract-stage2-1",
      documentType: "DELIVERY_HANDOVER",
      handoverId: record.handover.id,
      manifestHash: MANIFEST_DIGEST,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      slotIds: [
        "STAGE2_HANDOVER_CUSTOMER",
        "STAGE2_HANDOVER_PLATFORM"
      ],
      sourceDocumentFileId: "file-source-1",
      sourcePdfHash: SOURCE_PDF_HASH
    },
    signers: [
      {
        customerId: record.order.customerId,
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
  record.handover.handoverContract.status = "SIGNING";
  record.handover.status = "PENDING_CUSTOMER_SIGNATURE";
  record.status = "SIGNING";
  return record;
}
