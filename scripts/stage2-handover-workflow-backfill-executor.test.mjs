import assert from "node:assert/strict";
import test from "node:test";

import {
  executeStage2HandoverWorkflowBackfill
} from "./stage2-handover-workflow-backfill-executor.mjs";

const MANIFEST_HASH = `sha256:${"a".repeat(64)}`;
const PDF_JOB_KEY =
  `pdf:work-order-1:review-attempt-1:${MANIFEST_HASH}`;

test("applies a non-empty plan through the production executor and converges", async () => {
  const harness = createExecutorHarness();

  const result = await executeStage2HandoverWorkflowBackfill({
    mode: "apply",
    prisma: harness.prisma
  });

  assert.deepEqual(result, {
    exitCode: 0,
    report: {
      applied: {
        converged: true,
        exceptionsObserved: 0,
        jobCandidatesApplied: 1,
        operatorSnapshotsUpdated: 1
      },
      counts: {
        exceptions: 0,
        jobCandidates: 0,
        operatorSnapshotUpdates: 0,
        records: 1
      },
      ids: {
        exceptions: [],
        jobCandidates: [],
        operatorSnapshotWorkOrderIds: []
      },
      mode: "apply",
      remaining: {
        exceptions: 0,
        jobCandidates: 0,
        operatorSnapshotUpdates: 0,
        records: 1
      }
    }
  });
  assert.deepEqual(harness.transactionOptions, {
    isolationLevel: "Serializable",
    maxWait: 10_000,
    timeout: 120_000
  });
  assert.equal(harness.state.workOrders[0].fieldOperatorName, "Li  Ming");
  assert.equal(harness.state.workOrders[0].fieldOperatorPhone, "13800138000");
  assert.deepEqual(harness.state.jobs, [
    {
      eSignTaskId: null,
      handoverId: "handover-1",
      id: "workflow-job-1",
      idempotencyKey: PDF_JOB_KEY,
      jobStatus: "PENDING",
      jobType: "GENERATE_SOURCE_PDF",
      payload: {
        manifestHash: MANIFEST_HASH,
        reviewAttemptId: "review-attempt-1"
      },
      workOrderId: "work-order-1"
    }
  ]);
  assert.equal(harness.globalCandidateLookups, 2);
  assert.equal(harness.upserts, 1);
});

test("keeps a global same-key binding conflict non-converged", async () => {
  const harness = createExecutorHarness({
    canonicalOperatorSnapshot: true,
    jobs: [
      {
        ...canonicalPdfJob(),
        id: "foreign-job",
        workOrderId: "foreign-work-order"
      }
    ]
  });

  const result = await executeStage2HandoverWorkflowBackfill({
    mode: "apply",
    prisma: harness.prisma
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.applied.converged, false);
  assert.equal(result.report.applied.exceptionsObserved, 1);
  assert.deepEqual(result.report.ids.exceptions, [
    {
      code: "STAGE2_WORKFLOW_JOB_CONFLICT",
      sourceId: "foreign-job",
      workOrderId: "work-order-1"
    }
  ]);
  assert.equal(result.report.remaining.exceptions, 1);
  assert.equal(harness.globalCandidateLookups, 2);
  assert.equal(harness.upserts, 0);
});

test("fails closed and rolls back when a concurrent unique-key winner conflicts", async () => {
  const harness = createExecutorHarness({
    concurrentWinner: {
      ...canonicalPdfJob(),
      id: "concurrent-job",
      jobStatus: "CANCELLED",
      payload: {
        manifestHash: `sha256:${"c".repeat(64)}`,
        reviewAttemptId: "review-attempt-1"
      }
    }
  });

  await assert.rejects(
    executeStage2HandoverWorkflowBackfill({
      mode: "apply",
      prisma: harness.prisma
    }),
    /STAGE2_HANDOVER_WORKFLOW_BACKFILL_JOB_WRITE_CONFLICT/
  );

  assert.equal(harness.state.workOrders[0].fieldOperatorName, null);
  assert.equal(harness.state.workOrders[0].fieldOperatorPhone, null);
  assert.deepEqual(harness.state.jobs, []);
  assert.equal(harness.globalCandidateLookups, 1);
  assert.equal(harness.upserts, 1);
});

test("CAS-clears a stale snapshot for an inactive internal user and converges idempotently", async () => {
  const harness = createExecutorHarness({
    canonicalOperatorSnapshot: true,
    userStatus: "DISABLED"
  });

  const first = await executeStage2HandoverWorkflowBackfill({
    mode: "apply",
    prisma: harness.prisma
  });
  const second = await executeStage2HandoverWorkflowBackfill({
    mode: "apply",
    prisma: harness.prisma
  });

  assert.equal(first.exitCode, 0);
  assert.equal(first.report.applied.operatorSnapshotsUpdated, 1);
  assert.deepEqual(first.report.ids.exceptions, [
    {
      code: "INTERNAL_OPERATOR_INACTIVE",
      sourceId: "user-1",
      workOrderId: "work-order-1"
    }
  ]);
  assert.equal(harness.state.workOrders[0].fieldOperatorName, null);
  assert.equal(harness.state.workOrders[0].fieldOperatorPhone, null);
  assert.equal(second.report.applied.operatorSnapshotsUpdated, 0);
  assert.equal(second.report.applied.converged, true);
});

function createExecutorHarness({
  canonicalOperatorSnapshot = false,
  concurrentWinner = null,
  jobs = [],
  userStatus = "ACTIVE"
} = {}) {
  const state = {
    handovers: [
      {
        archiveStatus: "NOT_STARTED",
        archivedAt: null,
        artifactVersion: 1,
        deletedAt: null,
        handoverContract: null,
        handoverContractId: null,
        handoverESignTaskId: null,
        id: "handover-1",
        manifestHash: null,
        orderId: "order-1",
        sourceDocumentFileId: null,
        sourceObjectKey: null,
        sourcePdfHash: null,
        status: "DRAFT"
      }
    ],
    jobs: structuredClone(jobs),
    reviews: [
      {
        customerConfirmedAt: new Date("2026-07-27T00:00:00.000Z"),
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
      }
    ],
    users: [
      {
        deletedAt: null,
        id: "user-1",
        mobile: "+86 138-0013-8000",
        name: "  Li  Ming  ",
        status: userStatus
      }
    ],
    workOrders: [
      {
        assignedInternalUserId: "user-1",
        customerConfirmedAt: new Date("2026-07-27T00:00:00.000Z"),
        customerObjectedAt: null,
        externalOperatorName: null,
        externalOperatorPhone: null,
        fieldOperatorName: canonicalOperatorSnapshot ? "Li  Ming" : null,
        fieldOperatorPhone: canonicalOperatorSnapshot ? "13800138000" : null,
        handoverId: "handover-1",
        handoverType: "DELIVERY_OUTBOUND",
        id: "work-order-1",
        operatorType: "INTERNAL",
        order: {
          customerId: "customer-1",
          id: "order-1"
        },
        orderId: "order-1",
        status: "CUSTOMER_CONFIRMED"
      }
    ]
  };
  let globalCandidateLookups = 0;
  let transactionOptions = null;
  let upserts = 0;

  const prisma = {
    $transaction: async (operation, options) => {
      transactionOptions = structuredClone(options);
      const snapshot = structuredClone(state);
      try {
        return await operation(prisma);
      } catch (error) {
        state.handovers = snapshot.handovers;
        state.jobs = snapshot.jobs;
        state.reviews = snapshot.reviews;
        state.users = snapshot.users;
        state.workOrders = snapshot.workOrders;
        throw error;
      }
    },
    contractESignSigner: {
      findMany: async () => {
        throw new Error("unexpected signer query for a DRAFT handover");
      }
    },
    contractESignTask: {
      findMany: async () => {
        throw new Error("unexpected task query for a DRAFT handover");
      }
    },
    fileObject: {
      findMany: async () => {
        throw new Error("unexpected file query without a source artifact");
      }
    },
    user: {
      findMany: async ({ select, where }) => {
        assert.equal(select.deletedAt, true);
        assert.equal(select.mobile, true);
        assert.equal(select.status, true);
        assert.deepEqual(where, { id: { in: ["user-1"] } });
        return structuredClone(state.users);
      }
    },
    vehicleDeliveryHandover: {
      findMany: async ({ select, where }) => {
        assert.equal(select.handoverContract.select.contractSnapshot, true);
        assert.equal(select.handoverESignTaskId, true);
        assert.deepEqual(where, { id: { in: ["handover-1"] } });
        return structuredClone(state.handovers);
      }
    },
    vehicleHandoverReviewAttempt: {
      findMany: async ({ orderBy, select, where }) => {
        assert.deepEqual(orderBy, [
          { workOrderId: "asc" },
          { attemptNo: "desc" }
        ]);
        assert.equal(select.evidenceSnapshot, true);
        assert.deepEqual(where, { workOrderId: { in: ["work-order-1"] } });
        return structuredClone(state.reviews);
      }
    },
    vehicleHandoverWorkOrder: {
      findMany: async ({ orderBy, select }) => {
        assert.deepEqual(orderBy, { id: "asc" });
        assert.equal(select.order.select.customerId, true);
        assert.equal(select.fieldOperatorName, true);
        return structuredClone(state.workOrders);
      },
      updateMany: async ({ data, where }) => {
        const record = state.workOrders.find(({ id }) => id === where.id);
        if (
          !record ||
          record.fieldOperatorName !== where.fieldOperatorName ||
          record.fieldOperatorPhone !== where.fieldOperatorPhone ||
          record.operatorType !== where.operatorType ||
          record.assignedInternalUserId !== where.assignedInternalUserId
        ) {
          return { count: 0 };
        }
        record.fieldOperatorName = data.fieldOperatorName;
        record.fieldOperatorPhone = data.fieldOperatorPhone;
        return { count: 1 };
      }
    },
    vehicleHandoverWorkflowJob: {
      findMany: async ({ select, where }) => {
        globalCandidateLookups += 1;
        assert.equal(select.jobStatus, true);
        assert.equal(select.payload, true);
        assert.equal("workOrderId" in where, false);
        assert.deepEqual(where.idempotencyKey.in, [PDF_JOB_KEY]);
        return structuredClone(
          state.jobs.filter(({ idempotencyKey }) =>
            where.idempotencyKey.in.includes(idempotencyKey)
          )
        );
      },
      upsert: async ({ create, select, update, where }) => {
        upserts += 1;
        assert.deepEqual(update, {});
        assert.equal(select.jobStatus, true);
        assert.deepEqual(where, { idempotencyKey: PDF_JOB_KEY });
        const existing = state.jobs.find(
          ({ idempotencyKey }) => idempotencyKey === where.idempotencyKey
        );
        if (existing) {
          return structuredClone(existing);
        }
        const persisted = concurrentWinner
          ? structuredClone(concurrentWinner)
          : {
              ...structuredClone(create),
              id: "workflow-job-1",
              jobStatus: "PENDING"
            };
        state.jobs.push(persisted);
        return structuredClone(persisted);
      }
    }
  };

  return {
    get globalCandidateLookups() {
      return globalCandidateLookups;
    },
    get transactionOptions() {
      return transactionOptions;
    },
    get upserts() {
      return upserts;
    },
    prisma,
    state
  };
}

function canonicalPdfJob() {
  return {
    eSignTaskId: null,
    handoverId: "handover-1",
    id: "workflow-job-1",
    idempotencyKey: PDF_JOB_KEY,
    jobStatus: "PENDING",
    jobType: "GENERATE_SOURCE_PDF",
    payload: {
      manifestHash: MANIFEST_HASH,
      reviewAttemptId: "review-attempt-1"
    },
    workOrderId: "work-order-1"
  };
}
