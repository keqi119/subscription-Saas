import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildStage2HandoverWorkflowBackfillPlan,
  parseStage2HandoverWorkflowBackfillMode
} from "./stage2-handover-workflow-backfill-core.mjs";
import {
  applyStage2BackfillJobCandidates
} from "./stage2-handover-workflow-backfill-apply.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));

let prisma;

async function main() {
  const mode = parseStage2HandoverWorkflowBackfillMode(process.argv.slice(2));
  prisma = await createPrismaClient();

  if (mode === "dry-run") {
    const plan = buildStage2HandoverWorkflowBackfillPlan(await loadRecords(prisma));
    printReport({
      applied: null,
      mode,
      plan,
      remaining: null
    });
    return;
  }

  const applied = await prisma.$transaction(
    async (tx) => {
      const plan = buildStage2HandoverWorkflowBackfillPlan(await loadRecords(tx));
      const operatorSnapshotsUpdated = await applyOperatorSnapshotUpdates(
        tx,
        plan.operatorSnapshotUpdates
      );
      await applyStage2BackfillJobCandidates(tx, plan.jobCandidates);
      return {
        exceptionsObserved: plan.exceptions.length,
        jobCandidatesApplied: plan.jobCandidates.length,
        operatorSnapshotsUpdated
      };
    },
    {
      isolationLevel: "Serializable",
      maxWait: 10_000,
      timeout: 120_000
    }
  );
  const remaining = buildStage2HandoverWorkflowBackfillPlan(await loadRecords(prisma));
  const converged =
    remaining.operatorSnapshotUpdates.length === 0 &&
    remaining.jobCandidates.length === 0 &&
    !remaining.exceptions.some(
      ({ code }) => code === "STAGE2_WORKFLOW_JOB_CONFLICT"
    );
  printReport({
    applied: {
      ...applied,
      converged
    },
    mode,
    plan: remaining,
    remaining
  });
  if (!converged) {
    process.exitCode = 1;
  }
}

async function createPrismaClient() {
  const [{ PrismaPg }, { PrismaClient }, { config }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href),
    import(pathToFileURL(requireFromApi.resolve("dotenv")).href)
  ]);

  config({
    path: resolve(repoRoot, ".env"),
    quiet: true
  });
  config({
    path: resolve(repoRoot, "apps/api/.env"),
    quiet: true
  });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("STAGE2_HANDOVER_WORKFLOW_BACKFILL_DATABASE_URL_REQUIRED");
  }
  return new PrismaClient({
    adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl))
  });
}

async function loadRecords(db) {
  const workOrders = await db.vehicleHandoverWorkOrder.findMany({
    orderBy: { id: "asc" },
    select: {
      assignedInternalUserId: true,
      customerConfirmedAt: true,
      customerObjectedAt: true,
      externalOperatorName: true,
      externalOperatorPhone: true,
      fieldOperatorName: true,
      fieldOperatorPhone: true,
      handoverId: true,
      handoverType: true,
      id: true,
      operatorType: true,
      order: {
        select: {
          customerId: true,
          id: true
        }
      },
      orderId: true,
      status: true
    }
  });
  if (workOrders.length === 0) {
    return [];
  }

  const workOrderIds = workOrders.map(({ id }) => id);
  const internalUserIds = uniqueNonNull(
    workOrders.map(({ assignedInternalUserId }) => assignedInternalUserId)
  );
  const handoverIds = uniqueNonNull(workOrders.map(({ handoverId }) => handoverId));

  const users =
    internalUserIds.length === 0
      ? []
      : await db.user.findMany({
          select: {
            deletedAt: true,
            id: true,
            mobile: true,
            name: true
          },
          where: { id: { in: internalUserIds } }
        });
  const handovers =
    handoverIds.length === 0
      ? []
      : await db.vehicleDeliveryHandover.findMany({
          select: {
            archiveStatus: true,
            archivedAt: true,
            artifactVersion: true,
            deletedAt: true,
            handoverContract: {
              select: {
                contractSnapshot: true,
                customerId: true,
                deletedAt: true,
                fileId: true,
                id: true,
                orderId: true,
                status: true
              }
            },
            handoverContractId: true,
            handoverESignTaskId: true,
            id: true,
            manifestHash: true,
            orderId: true,
            sourceDocumentFileId: true,
            sourceObjectKey: true,
            sourcePdfHash: true,
            status: true
          },
          where: { id: { in: handoverIds } }
        });
  const taskIds = uniqueNonNull(handovers.map(({ handoverESignTaskId }) => handoverESignTaskId));
  const tasks =
    taskIds.length === 0
      ? []
      : await db.contractESignTask.findMany({
          select: {
            contractId: true,
            customerId: true,
            deletedAt: true,
            documentType: true,
            id: true,
            orderId: true,
            requestSnapshot: true,
            signingStage: true,
            taskNo: true,
            taskStatus: true
          },
          where: { id: { in: taskIds } }
        });
  const signers =
    taskIds.length === 0
      ? []
      : await db.contractESignSigner.findMany({
          select: {
            customerId: true,
            deletedAt: true,
            documentType: true,
            providerActionType: true,
            providerTransactionId: true,
            required: true,
            signerStatus: true,
            signerType: true,
            slotId: true,
            taskId: true
          },
          where: { taskId: { in: taskIds } }
        });
  const reviews = await db.vehicleHandoverReviewAttempt.findMany({
    orderBy: [{ workOrderId: "asc" }, { attemptNo: "desc" }],
    select: {
      customerConfirmedAt: true,
      evidenceSnapshot: true,
      handoverId: true,
      id: true,
      orderId: true,
      status: true,
      workOrderId: true
    },
    where: { workOrderId: { in: workOrderIds } }
  });
  const sourceFileIds = uniqueNonNull(
    handovers.map(({ sourceDocumentFileId }) => sourceDocumentFileId)
  );
  const sourceFileObjects =
    sourceFileIds.length === 0
      ? []
      : await db.fileObject.findMany({
          select: {
            bucket: true,
            id: true,
            mimeType: true,
            objectKey: true,
            sizeBytes: true
          },
          where: { id: { in: sourceFileIds } }
        });

  const usersById = indexBy(users, "id");
  const sourceFileObjectsById = indexBy(sourceFileObjects, "id");
  const tasksById = indexBy(
    tasks.map((task) => ({
      ...task,
      signers: signers.filter(({ taskId }) => taskId === task.id)
    })),
    "id"
  );
  const handoversById = indexBy(
    handovers.map((handover) => ({
      ...handover,
      handoverESignTask: tasksById.get(handover.handoverESignTaskId) ?? null,
      sourceFileObject:
        sourceFileObjectsById.get(handover.sourceDocumentFileId) ?? null
    })),
    "id"
  );
  const latestReviewsByWorkOrderId = new Map();
  for (const review of reviews) {
    if (!latestReviewsByWorkOrderId.has(review.workOrderId)) {
      latestReviewsByWorkOrderId.set(review.workOrderId, review);
    }
  }

  const records = workOrders.map((record) => ({
    ...record,
    assignedInternalUser: usersById.get(record.assignedInternalUserId) ?? null,
    handover: handoversById.get(record.handoverId) ?? null,
    latestReview: latestReviewsByWorkOrderId.get(record.id) ?? null,
    workflowJobs: []
  }));
  const initialPlan = buildStage2HandoverWorkflowBackfillPlan(records);
  const candidateKeys = initialPlan.jobCandidates.map(
    ({ idempotencyKey }) => idempotencyKey
  );
  if (candidateKeys.length === 0) {
    return records;
  }
  const workflowJobs = await db.vehicleHandoverWorkflowJob.findMany({
    select: {
      eSignTaskId: true,
      handoverId: true,
      id: true,
      idempotencyKey: true,
      jobStatus: true,
      jobType: true,
      payload: true,
      workOrderId: true
    },
    where: {
      idempotencyKey: {
        in: candidateKeys
      }
    }
  });
  const workflowJobsByKey = indexBy(workflowJobs, "idempotencyKey");
  const candidateKeysByWorkOrderId = new Map(
    initialPlan.jobCandidates.map(({ idempotencyKey, workOrderId }) => [
      workOrderId,
      idempotencyKey
    ])
  );
  return records.map((record) => {
    const idempotencyKey = candidateKeysByWorkOrderId.get(record.id);
    const existing = idempotencyKey
      ? workflowJobsByKey.get(idempotencyKey)
      : null;
    return {
      ...record,
      workflowJobs: existing ? [existing] : []
    };
  });
}

function uniqueNonNull(values) {
  return [...new Set(values.filter(Boolean))];
}

function indexBy(records, key) {
  return new Map(records.map((record) => [record[key], record]));
}

async function applyOperatorSnapshotUpdates(tx, updates) {
  let updated = 0;
  for (const update of updates) {
    const result = await tx.vehicleHandoverWorkOrder.updateMany({
      data: {
        fieldOperatorName: update.fieldOperatorName,
        fieldOperatorPhone: update.fieldOperatorPhone
      },
      where: {
        fieldOperatorName: update.expectedFieldOperatorName,
        fieldOperatorPhone: update.expectedFieldOperatorPhone,
        id: update.workOrderId,
        operatorType: update.operatorType,
        ...(update.operatorType === "INTERNAL"
          ? {
              assignedInternalUserId: update.sourceId
            }
          : {})
      }
    });
    if (result.count !== 1) {
      throw new Error("STAGE2_HANDOVER_WORKFLOW_BACKFILL_SNAPSHOT_WRITE_CONFLICT");
    }
    updated += result.count;
  }
  return updated;
}

function printReport({ applied, mode, plan, remaining }) {
  const report = {
    applied,
    counts: summarizePlan(plan),
    ids: redactPlan(plan),
    mode,
    remaining: remaining === null ? null : summarizePlan(remaining)
  };
  console.log(JSON.stringify(report, null, 2));
}

function summarizePlan(plan) {
  return {
    exceptions: plan.exceptions.length,
    jobCandidates: plan.jobCandidates.length,
    operatorSnapshotUpdates: plan.operatorSnapshotUpdates.length,
    records: plan.recordCount
  };
}

function redactPlan(plan) {
  return {
    exceptions: plan.exceptions.map(({ code, sourceId, workOrderId }) => ({
      code,
      sourceId,
      workOrderId
    })),
    jobCandidates: plan.jobCandidates.map(({ eSignTaskId, handoverId, jobType, workOrderId }) => ({
      eSignTaskId,
      handoverId,
      jobType,
      workOrderId
    })),
    operatorSnapshotWorkOrderIds: plan.operatorSnapshotUpdates.map(({ workOrderId }) => workOrderId)
  };
}

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}

main()
  .catch(() => {
    console.error(
      JSON.stringify({
        error: "STAGE2_HANDOVER_WORKFLOW_BACKFILL_FAILED"
      })
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma?.$disconnect();
  });
