import { Injectable } from "@nestjs/common";
import {
  Prisma,
  VehicleHandoverWorkflowJob,
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";
import { randomUUID } from "node:crypto";

import { PrismaService } from "../prisma/prisma.service";
import {
  ClaimedStage2WorkflowJob,
  EnqueueStage2WorkflowJobInput,
  RescheduleStage2WorkflowJobInput,
  Stage2HandoverWorkflowDb,
  Stage2WorkflowError
} from "./stage2-handover-workflow.types";

@Injectable()
export class Stage2HandoverWorkflowRepository {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(
    tx: Stage2HandoverWorkflowDb,
    input: EnqueueStage2WorkflowJobInput
  ): Promise<VehicleHandoverWorkflowJob> {
    const availableAt =
      input.delayMs === undefined
        ? undefined
        : await databaseAvailableAt(tx, input.delayMs);

    return tx.vehicleHandoverWorkflowJob.upsert({
      create: {
        availableAt,
        eSignTaskId: input.eSignTaskId,
        handoverId: input.handoverId,
        idempotencyKey: input.idempotencyKey,
        jobType: input.jobType,
        maxAttempts: input.maxAttempts,
        payload: input.payload,
        workOrderId: input.workOrderId
      },
      update: {},
      where: { idempotencyKey: input.idempotencyKey }
    });
  }

  async claimDue(
    limit: number,
    leaseMs: number,
    supportedJobTypes: readonly VehicleHandoverWorkflowJobType[] = [
      VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF
    ]
  ): Promise<ClaimedStage2WorkflowJob[]> {
    if (limit <= 0 || leaseMs <= 0 || supportedJobTypes.length === 0) {
      return [];
    }

    return this.prisma.$transaction(async (tx) => {
      const leaseToken = randomUUID();
      const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "vehicle_handover_workflow_job"
        WHERE (
          (
            "job_status" = 'PENDING'
            AND "available_at" <= now()
          ) OR (
            "job_status" = 'PROCESSING'
            AND "lease_expires_at" <= now()
          )
        )
          AND "job_type" IN (${Prisma.join(
            supportedJobTypes.map(
              (jobType) =>
                Prisma.sql`${jobType}::"vehicle_handover_workflow_job_type"`
            )
          )})
        ORDER BY "available_at" ASC, "created_at" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      const ids = candidates.map(({ id }) => id);

      if (ids.length === 0) {
        return [];
      }

      await tx.$executeRaw(Prisma.sql`
        UPDATE "vehicle_handover_workflow_job"
        SET
          "job_status" = 'PROCESSING',
          "lease_token" = ${leaseToken}::uuid,
          "lease_expires_at" = now() + (${leaseMs} * interval '1 millisecond'),
          "started_at" = now(),
          "updated_at" = now()
        WHERE "id" = ANY(ARRAY[${Prisma.join(ids)}]::uuid[])
          AND (
            (
              "job_status" = 'PENDING'
              AND "available_at" <= now()
            ) OR (
              "job_status" = 'PROCESSING'
              AND "lease_expires_at" <= now()
            )
          )
      `);

      const claimed = await tx.vehicleHandoverWorkflowJob.findMany({
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
  ): Promise<boolean> {
    const updated = await this.prisma.vehicleHandoverWorkflowJob.updateMany({
      data: {
        completedAt: new Date(),
        jobStatus: VehicleHandoverWorkflowJobStatus.COMPLETED,
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
    input: RescheduleStage2WorkflowJobInput
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const availableAt = await databaseAvailableAt(tx, input.delayMs);
      const updated = await tx.vehicleHandoverWorkflowJob.updateMany({
        data: {
          attemptCount:
            input.incrementAttempt === false ? undefined : { increment: 1 },
          availableAt,
          jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
          lastErrorCode: input.error?.code ?? null,
          lastErrorMessage: input.error?.message ?? null,
          leaseExpiresAt: null,
          leaseToken: null,
          resultSnapshot: input.result
        },
        where: processingLease(jobId, leaseToken)
      });

      return updated.count === 1;
    });
  }

  async deadLetter(
    jobId: string,
    leaseToken: string,
    error: Stage2WorkflowError
  ): Promise<boolean> {
    const updated = await this.prisma.vehicleHandoverWorkflowJob.updateMany({
      data: {
        attemptCount: { increment: 1 },
        completedAt: new Date(),
        jobStatus: VehicleHandoverWorkflowJobStatus.DEAD_LETTER,
        lastErrorCode: error.code,
        lastErrorMessage: error.message,
        leaseExpiresAt: null,
        leaseToken: null
      },
      where: processingLease(jobId, leaseToken)
    });

    return updated.count === 1;
  }

  async renewLease(
    jobId: string,
    leaseToken: string,
    leaseMs: number,
    db: Stage2HandoverWorkflowDb = this.prisma
  ): Promise<boolean> {
    if (leaseMs <= 0) {
      return false;
    }

    const updated = await db.$executeRaw(Prisma.sql`
      UPDATE "vehicle_handover_workflow_job"
      SET
        "lease_expires_at" = now() + (${leaseMs} * interval '1 millisecond'),
        "updated_at" = now()
      WHERE "id" = ${jobId}::uuid
        AND "job_status" = 'PROCESSING'
        AND "lease_token" = ${leaseToken}::uuid
        AND "lease_expires_at" > now()
    `);

    return updated === 1;
  }

  async cancelPending(
    workOrderId: string,
    jobTypes?: VehicleHandoverWorkflowJobType[]
  ): Promise<number> {
    const updated = await this.prisma.vehicleHandoverWorkflowJob.updateMany({
      data: {
        completedAt: new Date(),
        jobStatus: VehicleHandoverWorkflowJobStatus.CANCELLED
      },
      where: {
        jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
        jobType: jobTypes ? { in: jobTypes } : undefined,
        workOrderId
      }
    });

    return updated.count;
  }
}

function processingLease(jobId: string, leaseToken: string) {
  return {
    id: jobId,
    jobStatus: VehicleHandoverWorkflowJobStatus.PROCESSING,
    leaseToken
  };
}

function hasLease(job: VehicleHandoverWorkflowJob): job is ClaimedStage2WorkflowJob {
  return job.leaseExpiresAt instanceof Date && typeof job.leaseToken === "string";
}

async function databaseAvailableAt(
  db: Stage2HandoverWorkflowDb,
  delayMs: number
): Promise<Date> {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new RangeError("Stage 2 workflow delay must be a non-negative integer.");
  }

  const [row] = await db.$queryRaw<Array<{ availableAt: Date }>>(Prisma.sql`
    SELECT now() + (${delayMs} * interval '1 millisecond') AS "availableAt"
  `);
  if (!(row?.availableAt instanceof Date)) {
    throw new Error("PostgreSQL did not return a Stage 2 workflow schedule.");
  }

  return row.availableAt;
}
