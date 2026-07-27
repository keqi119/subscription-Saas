import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Stage2HandoverWorkflowRepository } from "../src/handover-work-order/stage2-handover-workflow.repository";
import { PrismaService } from "../src/prisma/prisma.service";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://subscription:subscription@127.0.0.1:5432/subscription_saas?schema=public";

describe("Stage2HandoverWorkflowRepository", () => {
  const workOrderId = randomUUID();
  const missingOrderId = randomUUID();
  let prisma: PrismaService;
  let repository: Stage2HandoverWorkflowRepository;

  beforeAll(async () => {
    prisma = new PrismaService(
      new ConfigService({
        DATABASE_POOL_MAX: "10",
        DATABASE_URL: TEST_DATABASE_URL
      })
    );
    await prisma.onModuleInit();
    repository = new Stage2HandoverWorkflowRepository(prisma);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`
        INSERT INTO "vehicle_handover_work_order" (
          "id",
          "order_id",
          "handover_type",
          "created_at",
          "updated_at"
        )
        VALUES (
          ${workOrderId}::uuid,
          ${missingOrderId}::uuid,
          'DELIVERY_OUTBOUND',
          now(),
          now()
        )
      `;
    });
  });

  beforeEach(async () => {
    await prisma.vehicleHandoverWorkflowJob.deleteMany({
      where: { workOrderId }
    });
  });

  afterAll(async () => {
    await prisma.vehicleHandoverWorkflowJob.deleteMany({
      where: { workOrderId }
    });
    await prisma.vehicleHandoverWorkOrder.delete({
      where: { id: workOrderId }
    });
    await prisma.onModuleDestroy();
  });

  it("returns the existing row for a duplicate idempotency key", async () => {
    const input = workflowJobInput("duplicate");
    const created = await repository.enqueue(prisma, input);
    const duplicate = await prisma.$transaction((tx) => repository.enqueue(tx, input));

    expect(duplicate.id).toBe(created.id);
    await expect(
      prisma.vehicleHandoverWorkflowJob.count({
        where: { idempotencyKey: input.idempotencyKey }
      })
    ).resolves.toBe(1);
  });

  it("claims a due pending job only once across two workers", async () => {
    const job = await repository.enqueue(prisma, workflowJobInput("parallel-claim"));

    const claims = await Promise.all([
      repository.claimDue(1, 120_000),
      repository.claimDue(1, 120_000)
    ]);

    expect(claims.flat().filter((claimed) => claimed.id === job.id)).toHaveLength(1);
  });

  it("does not claim a processing job with a live lease", async () => {
    const job = await prisma.vehicleHandoverWorkflowJob.create({
      data: {
        ...workflowJobInput("live-lease"),
        jobStatus: VehicleHandoverWorkflowJobStatus.PROCESSING,
        leaseExpiresAt: new Date(),
        leaseToken: randomUUID(),
        startedAt: new Date()
      }
    });
    await prisma.$executeRaw`
      UPDATE "vehicle_handover_workflow_job"
      SET "lease_expires_at" = now() + interval '1 hour'
      WHERE "id" = ${job.id}::uuid
    `;

    await expect(repository.claimDue(1, 120_000)).resolves.toEqual([]);
  });

  it("reclaims a processing job after its lease expires", async () => {
    const staleLeaseToken = randomUUID();
    const job = await prisma.vehicleHandoverWorkflowJob.create({
      data: {
        ...workflowJobInput("expired-lease"),
        jobStatus: VehicleHandoverWorkflowJobStatus.PROCESSING,
        leaseExpiresAt: new Date(),
        leaseToken: staleLeaseToken,
        startedAt: new Date(Date.now() - 120_000)
      }
    });
    await prisma.$executeRaw`
      UPDATE "vehicle_handover_workflow_job"
      SET "lease_expires_at" = now() - interval '1 second'
      WHERE "id" = ${job.id}::uuid
    `;

    const claimed = await repository.claimDue(1, 120_000);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: job.id,
      jobStatus: VehicleHandoverWorkflowJobStatus.PROCESSING
    });
    expect(claimed[0]?.leaseToken).not.toBe(staleLeaseToken);
    expect(claimed[0]?.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("requires the matching lease token to complete or reschedule", async () => {
    const firstJob = await repository.enqueue(prisma, workflowJobInput("guard-complete"));
    const [firstClaim] = await repository.claimDue(1, 120_000);
    const wrongToken = randomUUID();

    await expect(
      repository.complete(firstJob.id, wrongToken, { providerStatus: "SIGNED" })
    ).resolves.toBe(false);
    await expect(
      repository.complete(firstJob.id, firstClaim!.leaseToken, {
        providerStatus: "SIGNED"
      })
    ).resolves.toBe(true);

    const secondJob = await repository.enqueue(prisma, workflowJobInput("guard-reschedule"));
    const [secondClaim] = await repository.claimDue(1, 120_000);
    const availableAt = new Date(Date.now() + 60_000);

    await expect(
      repository.reschedule(secondJob.id, wrongToken, {
        availableAt,
        error: { code: "PROVIDER_PENDING", message: "Provider is still processing." }
      })
    ).resolves.toBe(false);
    await expect(
      repository.reschedule(secondJob.id, secondClaim!.leaseToken, {
        availableAt,
        error: { code: "PROVIDER_PENDING", message: "Provider is still processing." }
      })
    ).resolves.toBe(true);

    await expect(
      prisma.vehicleHandoverWorkflowJob.findUniqueOrThrow({
        where: { id: secondJob.id }
      })
    ).resolves.toMatchObject({
      attemptCount: 1,
      availableAt,
      jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
      lastErrorCode: "PROVIDER_PENDING",
      leaseExpiresAt: null,
      leaseToken: null
    });
  });

  it("renews only a live matching lease", async () => {
    const job = await repository.enqueue(
      prisma,
      workflowJobInput("guard-renew")
    );
    const [claim] = await repository.claimDue(1, 120_000);

    await expect(
      repository.renewLease(job.id, claim!.leaseToken, 120_000)
    ).resolves.toBe(true);
    await prisma.$executeRaw`
      UPDATE "vehicle_handover_workflow_job"
      SET "lease_expires_at" = now() - interval '1 second'
      WHERE "id" = ${job.id}::uuid
    `;
    const [expired] = await prisma.$queryRaw<Array<{ expired: boolean }>>`
      SELECT "lease_expires_at" <= now() AS "expired"
      FROM "vehicle_handover_workflow_job"
      WHERE "id" = ${job.id}::uuid
    `;
    expect(expired?.expired).toBe(true);
    await expect(
      repository.renewLease(job.id, claim!.leaseToken, 120_000)
    ).resolves.toBe(false);
  });

  function workflowJobInput(suffix: string) {
    return {
      idempotencyKey: `stage2-workflow-repository-test:${workOrderId}:${suffix}`,
      jobType: VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF,
      payload: { source: "repository-test" } satisfies Prisma.InputJsonValue,
      workOrderId
    };
  }
});
