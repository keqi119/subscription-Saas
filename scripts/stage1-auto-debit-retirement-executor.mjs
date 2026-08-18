import {
  buildRetirementPlan,
  RETIRED_AUTO_DEBIT_JOB_TYPES
} from "./stage1-auto-debit-retirement-core.mjs";

const COLLECTION_MODE = "ACTIVE_PAYMENT_ONLY";
const RETIREMENT_CODE = "STAGE1_ACTIVE_PAYMENT_BASELINE_RETIRED";
const RETIREMENT_MESSAGE = "Cancelled by Stage 1 active-payment-only baseline rollout.";
const LOCK_EXECUTABLE_RETIRED_JOBS_SQL = `
  SELECT "id"
  FROM "subscription_automation_job"
  WHERE "job_type" IN (
    'SUBMIT_BILL_DEBIT',
    'QUERY_DEBIT_ATTEMPT',
    'SEND_DEBIT_FAILURE_NOTICE',
    'SYNC_PAYMENT_MANDATE'
  )
    AND "job_status" IN ('PENDING', 'PROCESSING')
  ORDER BY "available_at" ASC, "created_at" ASC, "id" ASC
  FOR UPDATE
`;

export async function executeStage1AutoDebitRetirement({ mode, prisma }) {
  if (mode === "dry-run") {
    return prisma.$transaction(async (tx) => {
      const effectiveNow = await readDatabaseNow(tx);
      const rows = await findRetiredJobs(tx);
      const plan = buildRetirementPlan(rows, effectiveNow);
      const executableJobCount = await countExecutableJobs(tx);
      return {
        exitCode: 0,
        report: report({
          cancelledCount: 0,
          executableJobCount,
          mode,
          ok: plan.blockedProcessingIds.length === 0,
          plan
        })
      };
    });
  }

  return prisma.$transaction(async (tx) => {
    await lockExecutableRetiredJobs(tx);
    const effectiveNow = await readDatabaseNow(tx);
    const rows = await findRetiredJobs(tx);
    const plan = buildRetirementPlan(rows, effectiveNow);
    if (plan.blockedProcessingIds.length > 0) {
      return {
        exitCode: 2,
        report: report({
          cancelledCount: 0,
          executableJobCount: await countExecutableJobs(tx),
          mode,
          ok: false,
          plan
        })
      };
    }

    const byId = new Map(rows.map((row) => [row.id, row]));
    let cancelledCount = 0;
    for (const id of plan.cancellableIds) {
      const before = byId.get(id);
      if (!before) {
        continue;
      }
      const updated = await tx.subscriptionAutomationJob.updateMany({
        data: {
          cancelledAt: effectiveNow,
          completedAt: effectiveNow,
          jobStatus: "CANCELLED",
          lastErrorCode: RETIREMENT_CODE,
          lastErrorMessage: RETIREMENT_MESSAGE,
          leaseExpiresAt: null,
          leaseToken: null,
          resultSnapshot: {
            collectionMode: COLLECTION_MODE,
            retiredAt: effectiveNow.toISOString()
          }
        },
        where:
          before.jobStatus === "PROCESSING"
            ? {
                id,
                jobStatus: "PROCESSING",
                leaseExpiresAt: { lte: effectiveNow }
              }
            : { id, jobStatus: "PENDING" }
      });
      if (updated.count !== 1) {
        continue;
      }
      cancelledCount += 1;
      await tx.auditLog.create({
        data: {
          action: "UPDATE",
          afterSnapshot: {
            jobStatus: "CANCELLED",
            reasonCode: RETIREMENT_CODE
          },
          beforeSnapshot: {
            jobStatus: before.jobStatus,
            jobType: before.jobType
          },
          entityId: id,
          entityType: "subscription_automation_job",
          module: "billing",
          operatorId: null,
          userAgent: "stage1-auto-debit-retirement"
        }
      });
    }

    const executableJobCount = await countExecutableJobs(tx);
    const ok = executableJobCount === 0;
    return {
      exitCode: ok ? 0 : 2,
      report: report({
        cancelledCount,
        executableJobCount,
        mode,
        ok,
        plan
      })
    };
  });
}

async function lockExecutableRetiredJobs(db) {
  await db.$queryRawUnsafe(LOCK_EXECUTABLE_RETIRED_JOBS_SQL);
}

async function readDatabaseNow(db) {
  const rows = await db.$queryRawUnsafe('SELECT clock_timestamp() AS "now"');
  const value = rows[0]?.now;
  if (!value || typeof value.getTime !== "function" || Number.isNaN(value.getTime())) {
    throw new Error("STAGE1_AUTO_DEBIT_RETIREMENT_DATABASE_CLOCK_INVALID");
  }
  return value;
}

function findRetiredJobs(db) {
  return db.subscriptionAutomationJob.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      jobStatus: true,
      jobType: true,
      leaseExpiresAt: true
    },
    where: {
      jobType: { in: [...RETIRED_AUTO_DEBIT_JOB_TYPES] }
    }
  });
}

function countExecutableJobs(db) {
  return db.subscriptionAutomationJob.count({
    where: {
      jobStatus: { in: ["PENDING", "PROCESSING"] },
      jobType: { in: [...RETIRED_AUTO_DEBIT_JOB_TYPES] }
    }
  });
}

function report({ cancelledCount, executableJobCount, mode, ok, plan }) {
  return {
    blockedProcessingCount: plan.blockedProcessingIds.length,
    byJobType: plan.byJobType,
    cancellableCount: plan.cancellableIds.length,
    cancelledCount,
    collectionMode: COLLECTION_MODE,
    historicalCount: plan.historicalCount,
    mode,
    ok,
    postcondition: { executableJobCount },
    scannedCount: plan.scannedCount
  };
}
