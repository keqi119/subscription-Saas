import { Injectable } from "@nestjs/common";
import {
  Prisma,
  SubscriptionAutomationJob,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { randomUUID } from "node:crypto";

import { PrismaService } from "../prisma/prisma.service";
import {
  BillingAutomationDb,
  BillingAutomationFailure,
  ClaimedBillingAutomationJob,
  EnqueueBillingAutomationJobInput,
  RescheduleBillingAutomationJobInput
} from "./billing-automation.types";

const SETTLED_BILL_JOB_TYPES = [
  SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE,
  SubscriptionAutomationJobType.MARK_BILL_OVERDUE,
  SubscriptionAutomationJobType.SEND_BILL_OVERDUE_NOTICE,
  SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
  SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT,
  SubscriptionAutomationJobType.SEND_DEBIT_FAILURE_NOTICE
] as const;

@Injectable()
export class BillingAutomationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(
    tx: BillingAutomationDb,
    input: EnqueueBillingAutomationJobInput
  ): Promise<SubscriptionAutomationJob> {
    return tx.subscriptionAutomationJob.upsert({
      create: {
        availableAt: input.availableAt,
        billId: input.billId,
        billingScheduleId: input.billingScheduleId,
        changeOrderId: input.changeOrderId,
        contractSegmentId: input.contractSegmentId,
        idempotencyKey: input.idempotencyKey,
        jobType: input.jobType,
        maxAttempts: input.maxAttempts ?? 6,
        orderId: input.orderId,
        payload: input.payload,
        renewalConsiderationId: input.renewalConsiderationId
      },
      update: {},
      where: { idempotencyKey: input.idempotencyKey }
    });
  }

  async claimDue(
    limit: number,
    leaseMs: number,
    supportedJobTypes: readonly SubscriptionAutomationJobType[]
  ): Promise<ClaimedBillingAutomationJob[]> {
    if (limit <= 0 || leaseMs <= 0 || supportedJobTypes.length === 0) {
      return [];
    }

    return this.prisma.$transaction(async (tx) => {
      const leaseToken = randomUUID();
      const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "subscription_automation_job"."id"
        FROM "subscription_automation_job"
        LEFT JOIN "billing_schedule"
          ON "billing_schedule"."id" =
            "subscription_automation_job"."billing_schedule_id"
        WHERE (
          (
            "subscription_automation_job"."job_status" = 'PENDING'
            AND "subscription_automation_job"."available_at" <= clock_timestamp()
          ) OR (
            "subscription_automation_job"."job_status" = 'PROCESSING'
            AND "subscription_automation_job"."lease_expires_at" <= clock_timestamp()
          )
        )
          AND "subscription_automation_job"."job_type" IN (${Prisma.join(
            supportedJobTypes.map(
              (jobType) =>
                Prisma.sql`${jobType}::"subscription_automation_job_type"`
            )
          )})
          AND (
            "subscription_automation_job"."job_type" <>
              'GENERATE_MONTHLY_RENT_BILL'
            OR "billing_schedule"."status" = 'ACTIVE'
          )
        ORDER BY
          "subscription_automation_job"."available_at" ASC,
          "subscription_automation_job"."created_at" ASC
        LIMIT ${limit}
        FOR UPDATE OF "subscription_automation_job" SKIP LOCKED
      `);
      const ids = candidates.map(({ id }) => id);

      if (ids.length === 0) {
        return [];
      }

      await tx.$executeRaw(Prisma.sql`
        UPDATE "subscription_automation_job"
        SET
          "job_status" = 'PROCESSING',
          "lease_token" = ${leaseToken}::uuid,
          "lease_expires_at" = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
          "started_at" = clock_timestamp(),
          "updated_at" = clock_timestamp()
        WHERE "id" = ANY(ARRAY[${Prisma.join(ids)}]::uuid[])
          AND (
            (
              "job_status" = 'PENDING'
              AND "available_at" <= clock_timestamp()
            ) OR (
              "job_status" = 'PROCESSING'
              AND "lease_expires_at" <= clock_timestamp()
            )
          )
      `);

      const claimed = await tx.subscriptionAutomationJob.findMany({
        orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
        where: {
          id: { in: ids },
          leaseToken
        }
      });

      return claimed.filter(hasLease);
    });
  }

  async complete(
    jobId: string,
    leaseToken: string,
    result?: Prisma.InputJsonValue
  ) {
    const updated = await this.prisma.subscriptionAutomationJob.updateMany({
      data: {
        completedAt: new Date(),
        jobStatus: SubscriptionAutomationJobStatus.COMPLETED,
        lastErrorCode: null,
        lastErrorMessage: null,
        leaseExpiresAt: null,
        leaseToken: null,
        resultSnapshot: result
      },
      where: processingLease(jobId, leaseToken)
    });
    return updated.count === 1;
  }

  async reschedule(
    jobId: string,
    leaseToken: string,
    input: RescheduleBillingAutomationJobInput
  ) {
    return this.prisma.$transaction(async (tx) => {
      const availableAt = await databaseAvailableAt(tx, input.delayMs);
      const updated = await tx.subscriptionAutomationJob.updateMany({
        data: {
          attemptCount: { increment: 1 },
          availableAt,
          jobStatus: SubscriptionAutomationJobStatus.PENDING,
          lastErrorCode: input.error.code,
          lastErrorMessage: input.error.message,
          leaseExpiresAt: null,
          leaseToken: null
        },
        where: processingLease(jobId, leaseToken)
      });
      return updated.count === 1;
    });
  }

  async defer(
    jobId: string,
    leaseToken: string,
    reason: BillingAutomationFailure
  ) {
    return this.prisma.$transaction(async (tx) => {
      const availableAt = await databaseAvailableAt(tx, 0);
      const updated = await tx.subscriptionAutomationJob.updateMany({
        data: {
          availableAt,
          jobStatus: SubscriptionAutomationJobStatus.PENDING,
          lastErrorCode: reason.code,
          lastErrorMessage: reason.message,
          leaseExpiresAt: null,
          leaseToken: null
        },
        where: processingLease(jobId, leaseToken)
      });
      return updated.count === 1;
    });
  }

  async deadLetter(
    jobId: string,
    leaseToken: string,
    error: BillingAutomationFailure
  ) {
    const updated = await this.prisma.subscriptionAutomationJob.updateMany({
      data: {
        attemptCount: { increment: 1 },
        completedAt: new Date(),
        jobStatus: SubscriptionAutomationJobStatus.DEAD_LETTER,
        lastErrorCode: error.code,
        lastErrorMessage: error.message,
        leaseExpiresAt: null,
        leaseToken: null
      },
      where: processingLease(jobId, leaseToken)
    });
    return updated.count === 1;
  }

  cancelPendingForBills(
    tx: BillingAutomationDb,
    billIds: string[]
  ) {
    return cancelPendingBillAutomationJobs(tx, billIds);
  }

  async cancelPendingForSchedule(
    tx: BillingAutomationDb,
    billingScheduleId: string
  ) {
    const now = new Date();
    const updated = await tx.subscriptionAutomationJob.updateMany({
      data: {
        cancelledAt: now,
        completedAt: now,
        jobStatus: SubscriptionAutomationJobStatus.CANCELLED
      },
      where: {
        billingScheduleId,
        jobStatus: SubscriptionAutomationJobStatus.PENDING
      }
    });
    return updated.count;
  }

  async retryDeadLetter(jobId: string) {
    const updated = await this.prisma.subscriptionAutomationJob.updateMany({
      data: {
        attemptCount: 0,
        availableAt: new Date(),
        completedAt: null,
        jobStatus: SubscriptionAutomationJobStatus.PENDING,
        lastErrorCode: null,
        lastErrorMessage: null,
        leaseExpiresAt: null,
        leaseToken: null,
        startedAt: null
      },
      where: {
        id: jobId,
        jobStatus: SubscriptionAutomationJobStatus.DEAD_LETTER
      }
    });
    return updated.count === 1;
  }
}

export async function cancelPendingBillAutomationJobs(
  tx: BillingAutomationDb,
  billIds: string[]
) {
  if (billIds.length === 0) {
    return 0;
  }

  const now = new Date();
  const updated = await tx.subscriptionAutomationJob.updateMany({
    data: {
      cancelledAt: now,
      completedAt: now,
      jobStatus: SubscriptionAutomationJobStatus.CANCELLED
    },
    where: {
      billId: { in: billIds },
      jobStatus: SubscriptionAutomationJobStatus.PENDING,
      jobType: { in: [...SETTLED_BILL_JOB_TYPES] }
    }
  });
  return updated.count;
}

function processingLease(jobId: string, leaseToken: string) {
  return {
    id: jobId,
    jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
    leaseToken
  };
}

function hasLease(
  job: SubscriptionAutomationJob
): job is ClaimedBillingAutomationJob {
  return (
    job.leaseExpiresAt instanceof Date &&
    typeof job.leaseToken === "string"
  );
}

async function databaseAvailableAt(
  db: BillingAutomationDb,
  delayMs: number
) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new RangeError(
      "Billing automation delay must be a non-negative integer."
    );
  }

  const [row] = await db.$queryRaw<Array<{ availableAt: Date }>>(Prisma.sql`
    SELECT now() + (${delayMs} * interval '1 millisecond') AS "availableAt"
  `);
  if (!(row?.availableAt instanceof Date)) {
    throw new Error(
      "PostgreSQL did not return a billing automation schedule."
    );
  }
  return row.availableAt;
}
