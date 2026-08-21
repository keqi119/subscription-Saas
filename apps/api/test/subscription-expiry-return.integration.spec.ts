import { ConfigService } from "@nestjs/config";
import {
  ContractSegmentStatus,
  ESignDocumentType,
  ESignProviderType,
  ESignSigningStage,
  ESignTaskStatus,
  LeaseStatus,
  OrderStatus,
  Prisma,
  SubscriptionAutomationJobStatus,
  SubscriptionChangeStatus,
  VehicleReturnStatus,
  VehicleStatus
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../src/asset-operations/asset-operations.service";
import { Stage3ExtensionArchiveService } from "../src/esign/stage3-extension-archive.service";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";
import { buildReturnEligibility } from "../src/order/order.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { SubscriptionExpiryService } from "../src/subscription-change/subscription-expiry.service";
import { SubscriptionClosureRepository } from "../src/subscription-closure/subscription-closure.repository";
import { SubscriptionClosureService } from "../src/subscription-closure/subscription-closure.service";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://subscription:subscription@127.0.0.1:55432/subscription_saas_codex?schema=public";

describe("subscription expiry to normal return integration boundary", () => {
  it("allows a PENDING_RETURN order with its leased vehicle to prepare and confirm the normal return", () => {
    expect(
      buildReturnEligibility(
        {
          actualDeliveryAt: new Date("2026-08-02T11:03:00.000Z"),
          actualReturnAt: null,
          orderStatus: OrderStatus.PENDING_RETURN,
          vehicle: { deletedAt: null, id: "vehicle-1", status: VehicleStatus.LEASED },
          vehicleId: "vehicle-1"
        },
        {
          returnStatus: VehicleReturnStatus.PENDING,
          returnedAt: null
        }
      )
    ).toMatchObject({
      canConfirmReturn: false,
      canPrepareReturn: true
    });
  });
});

describe("SubscriptionExpiryService PostgreSQL concurrency", () => {
  let prisma: PrismaService;
  let service: SubscriptionExpiryService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
    service = new SubscriptionExpiryService(
      prisma,
      {
        notifyRenewalExpiryInApp: vi.fn(async () => ({ created: true })),
        notifyRenewalReturnOverdueInApp: vi.fn(async () => ({ created: true }))
      } as never,
      new AuditService(prisma),
      passthroughClosureOrchestrator()
    );
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("converges duplicate workers on one return while preserving the earned rent job", async () => {
    const fixture = await createExpiryFixture(prisma);
    try {
      const attempts = await Promise.allSettled([
        service.expireSegment(fixture.segmentId, new Date("2026-09-02T16:00:00.000Z")),
        service.expireSegment(fixture.segmentId, new Date("2026-09-02T16:00:00.000Z"))
      ]);
      for (const attempt of attempts) {
        if (attempt.status === "rejected") {
          await service.expireSegment(fixture.segmentId, new Date("2026-09-02T16:00:00.000Z"));
        }
      }

      await expect(
        prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(1);
      await expect(
        prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } })
      ).resolves.toMatchObject({
        orderStatus: OrderStatus.PENDING_RETURN
      });
      await expect(
        prisma.lease.findUniqueOrThrow({ where: { orderId: fixture.orderId } })
      ).resolves.toMatchObject({
        status: LeaseStatus.RETURN_DUE
      });
      await expect(
        prisma.subscriptionContractSegment.findUniqueOrThrow({ where: { id: fixture.segmentId } })
      ).resolves.toMatchObject({
        status: ContractSegmentStatus.COMPLETED
      });
      await expect(
        prisma.billingSchedule.findUniqueOrThrow({ where: { orderId: fixture.orderId } })
      ).resolves.toMatchObject({
        status: "ACTIVE"
      });
      await expect(
        prisma.subscriptionAutomationJob.findUniqueOrThrow({ where: { id: fixture.earnedJobId } })
      ).resolves.toMatchObject({
        jobStatus: SubscriptionAutomationJobStatus.PENDING
      });
      await expect(
        prisma.subscriptionAutomationJob.findUniqueOrThrow({ where: { id: fixture.futureJobId } })
      ).resolves.toMatchObject({
        jobStatus: SubscriptionAutomationJobStatus.CANCELLED
      });
    } finally {
      await cleanupExpiryFixture(
        prisma,
        fixture.orderId,
        fixture.segmentId,
        fixture.customerId,
        fixture.vehicleId
      );
    }
  });

  it("returns a stable NOWAIT loser while the archive holder remains usable", async () => {
    const fixture = await createRaceFixture(prisma);
    const expiryService = createGovernedExpiryService(prisma);
    const barrier = createBarrier();
    const archiveService = new Stage3ExtensionArchiveService(
      hookTransaction(prisma, "subscriptionContractSegment", "create", barrier),
      new AuditService(prisma)
    );
    try {
      const archivePromise = archiveService.finalizeArchivedContract({
        completedAt: new Date("2026-08-20T15:59:00.000Z"),
        contractId: fixture.contractId,
        source: "CALLBACK",
        taskId: fixture.taskId
      });
      await barrier.entered;
      const expiryPromise = expiryService
        .expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"))
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason) => ({ reason, status: "rejected" as const })
        );
      const expiryResult = await expiryPromise;
      expect(expiryResult).toMatchObject({
        reason: {
          response: { code: "SUBSCRIPTION_EXPIRY_AUTHORITY_BUSY" },
          status: 409
        },
        status: "rejected"
      });
      barrier.release();

      const archiveResult = await Promise.allSettled([archivePromise]).then(([result]) => result);
      if (archiveResult.status === "rejected") throw archiveResult.reason;
      expect(archiveResult).toMatchObject({
        status: "fulfilled",
        value: { outcome: "SCHEDULED" }
      });
      await expect(
        expiryService.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"))
      ).resolves.toEqual({ outcome: "EXTENDED" });
      await expect(
        prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } })
      ).resolves.toMatchObject({
        orderStatus: OrderStatus.ACTIVE
      });
      await expect(
        prisma.subscriptionChangeOrder.findUniqueOrThrow({ where: { id: fixture.changeId } })
      ).resolves.toMatchObject({
        status: SubscriptionChangeStatus.SCHEDULED
      });
      await expect(
        prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(0);
      await expect(
        prisma.subscriptionContractSegment.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(2);
    } finally {
      barrier.release();
      await cleanupRaceFixture(prisma, fixture);
    }
  }, 15_000);

  it("records late evidence only when expiry commits before the archive callback", async () => {
    const fixture = await createRaceFixture(prisma);
    const barrier = createBarrier();
    const expiryService = createGovernedExpiryService(
      hookTransaction(prisma, "vehicleReturn", "create", barrier)
    );
    const archiveService = new Stage3ExtensionArchiveService(prisma, new AuditService(prisma));
    try {
      const expiryPromise = expiryService.expireSegment(
        fixture.segmentId,
        new Date("2026-08-20T16:00:00.000Z")
      );
      await barrier.entered;
      const archivePromise = archiveService.finalizeArchivedContract({
        completedAt: new Date("2026-08-20T15:59:00.000Z"),
        contractId: fixture.contractId,
        source: "CALLBACK",
        taskId: fixture.taskId
      });
      await waitForPostgresLockWait(prisma);
      barrier.release();

      const [expiryResult, archiveResult] = await Promise.allSettled([
        expiryPromise,
        archivePromise
      ]);
      if (expiryResult.status === "rejected") throw expiryResult.reason;
      expect(expiryResult).toMatchObject({
        status: "fulfilled",
        value: { outcome: "EXPIRED" }
      });
      expect(archiveResult).toEqual({
        status: "fulfilled",
        value: { outcome: "LATE_EVIDENCE_ONLY" }
      });
      await expect(
        prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } })
      ).resolves.toMatchObject({
        orderStatus: OrderStatus.PENDING_RETURN
      });
      await expect(
        prisma.subscriptionChangeOrder.findUniqueOrThrow({ where: { id: fixture.changeId } })
      ).resolves.toMatchObject({
        failureCode: "EXTENSION_DEADLINE_MISSED",
        status: SubscriptionChangeStatus.FAILED
      });
      await expect(
        prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(1);
      await expect(
        prisma.subscriptionContractSegment.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(1);
    } finally {
      barrier.release();
      await cleanupRaceFixture(prisma, fixture);
    }
  });
});

describe("SubscriptionExpiryService governed normal-closure PostgreSQL boundary", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("creates and exactly replays the linked normal-return facts and first manifest", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const service = createGovernedExpiryService(prisma);
    const decisionAt = new Date("2026-08-20T16:00:00.000Z");
    try {
      const unrelatedTaskIds = [randomUUID(), randomUUID()];
      await prisma.contractESignTask.createMany({
        data: [
          {
            contractId: fixture.contractId,
            customerId: fixture.customerId,
            documentType: ESignDocumentType.SUBSCRIPTION_CONTRACT,
            id: unrelatedTaskIds[0]!,
            orderId: fixture.orderId,
            provider: ESignProviderType.MOCK,
            signingStage: ESignSigningStage.STAGE1_SUBSCRIPTION_CONTRACT,
            taskNo: `ESG-TASK3-${unrelatedTaskIds[0]}`,
            taskStatus: ESignTaskStatus.CANCELLED
          },
          {
            contractId: fixture.contractId,
            customerId: fixture.customerId,
            documentType: ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT,
            id: unrelatedTaskIds[1]!,
            orderId: fixture.orderId,
            provider: ESignProviderType.MOCK,
            signingStage: ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION,
            taskNo: `ESG-TASK3-${unrelatedTaskIds[1]}`,
            taskStatus: ESignTaskStatus.COMPLETED
          }
        ]
      });
      await expect(service.expireSegment(fixture.segmentId, decisionAt)).resolves.toMatchObject({
        outcome: "EXPIRED"
      });
      await expect(
        service.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:01.000Z"))
      ).resolves.toMatchObject({ outcome: "DUPLICATE" });

      const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { orderId: fixture.orderId }
      });
      const currentManifest = await prisma.subscriptionClosureCurrentDocument.findUniqueOrThrow({
        include: { documentRevision: true },
        where: {
          closureCaseId_documentType: {
            closureCaseId: closureCase.id,
            documentType: "RETURN_MANIFEST"
          }
        }
      });
      const databaseClock = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS "now"
      `;
      expect(closureCase).toMatchObject({
        closureType: "NORMAL_COMPLETION",
        currentDocumentRevisionId: null,
        physicalControlMode: "VOLUNTARY_RETURN",
        vehicleReturnId: expect.any(String),
        returnAssetWorkOrderId: expect.any(String),
        returnHandoverWorkOrderId: expect.any(String)
      });
      expect(currentManifest.documentRevision).toMatchObject({
        documentType: "RETURN_MANIFEST",
        handoverWorkOrderId: closureCase.returnHandoverWorkOrderId,
        revisionNumber: 1,
        stage: "GENERATED",
        vehicleReturnId: closureCase.vehicleReturnId
      });
      const manifestTask = await prisma.contractESignTask.findUniqueOrThrow({
        where: { id: currentManifest.documentRevision.contractESignTaskId }
      });
      expect(unrelatedTaskIds).not.toContain(manifestTask.id);
      expect(manifestTask).toMatchObject({
        contractId: fixture.contractId,
        documentType: ESignDocumentType.DELIVERY_HANDOVER,
        orderId: fixture.orderId,
        signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
        sourceId: fixture.segmentId,
        sourceKey: "return-manifest:1",
        sourceType: "SUBSCRIPTION_EXPIRY"
      });
      await expect(
        prisma.contractESignTask.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(3);
      expect(currentManifest.documentRevision.generatedAt.getTime()).not.toBe(decisionAt.getTime());
      expect(currentManifest.documentRevision.generatedAt.getTime()).toBeLessThanOrEqual(
        databaseClock[0]!.now.getTime()
      );
      await expect(
        prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(1);
      await expect(
        prisma.vehicleHandoverWorkOrder.count({
          where: { handoverType: "RETURN_INBOUND", orderId: fixture.orderId }
        })
      ).resolves.toBe(1);
      await expect(
        prisma.assetWorkOrder.count({
          where: { orderId: fixture.orderId, workOrderType: "RETURN_INBOUND" }
        })
      ).resolves.toBe(1);
      await expect(
        prisma.subscriptionClosureDocumentRevision.count({
          where: { closureCaseId: closureCase.id, documentType: "RETURN_MANIFEST" }
        })
      ).resolves.toBe(1);
      await expect(
        prisma.subscriptionClosureCommandReceipt.count({ where: { closureCaseId: closureCase.id } })
      ).resolves.toBe(2);
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it("fails replay closed when the dedicated manifest task or exact source file drifts", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const service = createGovernedExpiryService(prisma);
    try {
      await service.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { orderId: fixture.orderId }
      });
      const revision = await prisma.subscriptionClosureDocumentRevision.findFirstOrThrow({
        where: {
          closureCaseId: closureCase.id,
          documentType: "RETURN_MANIFEST",
          revisionNumber: 1
        }
      });
      const originalTask = await prisma.contractESignTask.findUniqueOrThrow({
        where: { id: revision.contractESignTaskId }
      });
      const originalFile = await prisma.fileObject.findUniqueOrThrow({
        where: { id: revision.sourceFileId }
      });
      const baseline = await snapshotManagedExpiryTruth(prisma, fixture);

      const drifts = [
        {
          mutate: () =>
            prisma.contractESignTask.update({
              data: { deletedAt: new Date("2026-08-21T00:00:00.000Z") },
              where: { id: originalTask.id }
            }),
          restore: () =>
            prisma.contractESignTask.update({
              data: { deletedAt: originalTask.deletedAt },
              where: { id: originalTask.id }
            })
        },
        {
          mutate: () =>
            prisma.contractESignTask.update({
              data: { documentObjectKey: `${originalTask.documentObjectKey}.drift` },
              where: { id: originalTask.id }
            }),
          restore: () =>
            prisma.contractESignTask.update({
              data: { documentObjectKey: originalTask.documentObjectKey },
              where: { id: originalTask.id }
            })
        },
        {
          mutate: () =>
            prisma.contractESignTask.update({
              data: { documentName: `${originalTask.documentName}.drift` },
              where: { id: originalTask.id }
            }),
          restore: () =>
            prisma.contractESignTask.update({
              data: { documentName: originalTask.documentName },
              where: { id: originalTask.id }
            })
        },
        {
          mutate: () =>
            prisma.fileObject.update({
              data: { objectKey: `${originalFile.objectKey}.drift` },
              where: { id: originalFile.id }
            }),
          restore: () =>
            prisma.fileObject.update({
              data: { objectKey: originalFile.objectKey },
              where: { id: originalFile.id }
            })
        },
        {
          mutate: () =>
            prisma.fileObject.update({
              data: { originalName: `${originalFile.originalName}.drift` },
              where: { id: originalFile.id }
            }),
          restore: () =>
            prisma.fileObject.update({
              data: { originalName: originalFile.originalName },
              where: { id: originalFile.id }
            })
        }
      ];
      for (const drift of drifts) {
        await drift.mutate();
        try {
          await expect(
            service.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:01.000Z"))
          ).rejects.toMatchObject({
            response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
            status: 409
          });
        } finally {
          await drift.restore();
        }
        await expect(snapshotManagedExpiryTruth(prisma, fixture)).resolves.toEqual(baseline);
      }

      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.fileObject.delete({ where: { id: originalFile.id } });
      });
      try {
        await expect(
          service.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:01.000Z"))
        ).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
          status: 409
        });
      } finally {
        await prisma.fileObject.create({
          data: {
            bucket: originalFile.bucket,
            createdAt: originalFile.createdAt,
            id: originalFile.id,
            mimeType: originalFile.mimeType,
            objectKey: originalFile.objectKey,
            originalName: originalFile.originalName,
            sizeBytes: originalFile.sizeBytes,
            uploadedBy: originalFile.uploadedBy
          }
        });
      }
      await expect(snapshotManagedExpiryTruth(prisma, fixture)).resolves.toEqual(baseline);
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it.each(["task", "file"] as const)(
    "rejects %s drift committed after replay precheck and before coordinator locks",
    async (target) => {
      const fixture = await createManagedExpiryFixture(prisma);
      const initialService = createGovernedExpiryService(prisma);
      const barrier = createBarrier();
      try {
        await initialService.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
        const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
          where: { orderId: fixture.orderId }
        });
        const revision = await prisma.subscriptionClosureDocumentRevision.findFirstOrThrow({
          where: {
            closureCaseId: closureCase.id,
            documentType: "RETURN_MANIFEST",
            revisionNumber: 1
          }
        });
        const baseline = await snapshotManagedExpiryTruth(prisma, fixture);
        const replayService = createGovernedExpiryService(
          hookTransaction(prisma, "fileObject", "findUnique", barrier, "after")
        );
        const replayPromise = replayService
          .expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:01.000Z"))
          .then(
            (value) => ({ status: "fulfilled" as const, value }),
            (reason) => ({ reason, status: "rejected" as const })
          );
        await barrier.entered;

        if (target === "task") {
          const task = await prisma.contractESignTask.findUniqueOrThrow({
            where: { id: revision.contractESignTaskId }
          });
          await prisma.$transaction(async (tx) => {
            await tx.contractESignTask.update({
              data: { documentObjectKey: `${task.documentObjectKey}.post-precheck-drift` },
              where: { id: task.id }
            });
          });
        } else {
          await prisma.$transaction(async (tx) => {
            await tx.fileObject.update({
              data: { mimeType: "application/octet-stream" },
              where: { id: revision.sourceFileId }
            });
          });
        }
        barrier.release();

        await expect(replayPromise).resolves.toMatchObject({
          reason: {
            response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
            status: 409
          },
          status: "rejected"
        });
        if (target === "task") {
          await expect(
            prisma.contractESignTask.findUniqueOrThrow({
              select: { documentObjectKey: true },
              where: { id: revision.contractESignTaskId }
            })
          ).resolves.toMatchObject({
            documentObjectKey: expect.stringContaining(".post-precheck-drift")
          });
        } else {
          await expect(
            prisma.fileObject.findUniqueOrThrow({
              select: { mimeType: true },
              where: { id: revision.sourceFileId }
            })
          ).resolves.toEqual({ mimeType: "application/octet-stream" });
        }
        await expect(snapshotManagedExpiryTruth(prisma, fixture)).resolves.toEqual(baseline);
      } finally {
        barrier.release();
        await cleanupManagedExpiryFixture(prisma, fixture);
      }
    }
  );

  it("exactly replays when no drift occurs after replay precheck", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const initialService = createGovernedExpiryService(prisma);
    const barrier = createBarrier();
    try {
      await initialService.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      const baseline = await snapshotManagedExpiryTruth(prisma, fixture);
      const replayService = createGovernedExpiryService(
        hookTransaction(prisma, "fileObject", "findUnique", barrier, "after")
      );
      const replayPromise = replayService.expireSegment(
        fixture.segmentId,
        new Date("2026-08-20T16:00:01.000Z")
      );
      await barrier.entered;
      barrier.release();

      await expect(replayPromise).resolves.toMatchObject({ outcome: "DUPLICATE" });
      await expect(snapshotManagedExpiryTruth(prisma, fixture)).resolves.toEqual(baseline);
    } finally {
      barrier.release();
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it("replays the immutable actor and revision one after actor and manifest successors change", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const service = createGovernedExpiryService(prisma);
    const candidateId = randomUUID();
    try {
      await service.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { orderId: fixture.orderId }
      });
      const revisionOne = await prisma.subscriptionClosureDocumentRevision.findFirstOrThrow({
        where: {
          closureCaseId: closureCase.id,
          documentType: "RETURN_MANIFEST",
          revisionNumber: 1
        }
      });
      const revisionTwoId = randomUUID();
      const revisionThreeId = randomUUID();
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "user" ("id", "username", "name", "password_hash", "status", "created_at", "updated_at")
          VALUES (${candidateId}::uuid, ${`replay-${candidateId}`}, 'Replacement actor', 'not-used', 'ACTIVE', clock_timestamp(), clock_timestamp())
        `);
        await tx.user.update({ data: { status: "DISABLED" }, where: { id: fixture.actorId } });
        await tx.subscriptionOrder.update({
          data: { createdBy: candidateId, updatedBy: candidateId },
          where: { id: fixture.orderId }
        });
        await tx.subscriptionContractSegment.update({
          data: { createdBy: candidateId },
          where: { id: fixture.segmentId }
        });
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "subscription_closure_document_revision" (
            "id", "closure_case_id", "revision_number", "document_type", "stage",
            "document_snapshot", "document_snapshot_hash", "vehicle_return_id",
            "handover_work_order_id", "contract_esign_task_id", "source_file_id",
            "source_file_hash", "signed_file_id", "signed_file_hash", "source_type",
            "source_id", "source_key", "generated_by", "generated_at", "signed_by",
            "signed_at", "created_at"
          ) SELECT
            ${revisionTwoId}::uuid, "closure_case_id", 2, "document_type", 'SIGNED',
            "document_snapshot", "document_snapshot_hash", "vehicle_return_id",
            "handover_work_order_id", "contract_esign_task_id", "source_file_id",
            "source_file_hash", "source_file_id", "source_file_hash", 'TASK3_TEST',
            ${fixture.orderId}::uuid, 'return-manifest:2', ${candidateId}::uuid, "generated_at",
            ${candidateId}::uuid, "generated_at", clock_timestamp()
          FROM "subscription_closure_document_revision" WHERE "id" = ${revisionOne.id}::uuid
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "subscription_closure_document_revision" (
            "id", "closure_case_id", "revision_number", "document_type", "stage",
            "document_snapshot", "document_snapshot_hash", "vehicle_return_id",
            "handover_work_order_id", "contract_esign_task_id", "source_file_id",
            "source_file_hash", "signed_file_id", "signed_file_hash", "source_type",
            "source_id", "source_key", "generated_by", "generated_at", "signed_by",
            "signed_at", "archived_by", "archived_at", "created_at"
          ) SELECT
            ${revisionThreeId}::uuid, "closure_case_id", 3, "document_type", 'ARCHIVED',
            "document_snapshot", "document_snapshot_hash", "vehicle_return_id",
            "handover_work_order_id", "contract_esign_task_id", "source_file_id",
            "source_file_hash", "source_file_id", "source_file_hash", 'TASK3_TEST',
            ${fixture.orderId}::uuid, 'return-manifest:3', ${candidateId}::uuid, "generated_at",
            ${candidateId}::uuid, "generated_at", ${candidateId}::uuid, "generated_at", clock_timestamp()
          FROM "subscription_closure_document_revision" WHERE "id" = ${revisionOne.id}::uuid
        `);
        await tx.subscriptionClosureCurrentDocument.update({
          data: { documentRevisionId: revisionThreeId, updatedBy: candidateId },
          where: {
            closureCaseId_documentType: {
              closureCaseId: closureCase.id,
              documentType: "RETURN_MANIFEST"
            }
          }
        });
      });

      await expect(
        service.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:01.000Z"))
      ).resolves.toMatchObject({ outcome: "DUPLICATE" });

      await expect(
        prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCase.id } })
      ).resolves.toMatchObject({ createdBy: fixture.actorId });
      await expect(
        prisma.subscriptionClosureCurrentDocument.findUniqueOrThrow({
          where: {
            closureCaseId_documentType: {
              closureCaseId: closureCase.id,
              documentType: "RETURN_MANIFEST"
            }
          }
        })
      ).resolves.toMatchObject({ documentRevisionId: revisionThreeId });
      await expect(
        prisma.subscriptionClosureDocumentRevision.count({
          where: { closureCaseId: closureCase.id }
        })
      ).resolves.toBe(3);
      await expect(
        prisma.subscriptionClosureCommandReceipt.count({ where: { closureCaseId: closureCase.id } })
      ).resolves.toBe(2);
      await expect(
        prisma.subscriptionClosureEvent.findMany({
          select: { actorId: true },
          where: { closureCaseId: closureCase.id }
        })
      ).resolves.toEqual([
        expect.objectContaining({ actorId: fixture.actorId }),
        expect.objectContaining({ actorId: fixture.actorId })
      ]);
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
      await prisma.user.deleteMany({ where: { id: candidateId } });
    }
  });

  it("fails closed on empty expiry actor authority before creating any managed fact", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const service = createGovernedExpiryService(prisma);
    try {
      await prisma.$transaction(async (tx) => {
        await tx.subscriptionOrder.update({
          data: { createdBy: null, updatedBy: null },
          where: { id: fixture.orderId }
        });
        await tx.subscriptionContractSegment.update({
          data: { createdBy: null },
          where: { id: fixture.segmentId }
        });
      });

      await expect(
        service.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"))
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_NOT_FOUND" },
        status: 409
      });
      await expectManagedExpiryFactCounts(prisma, fixture, {
        assetWorkOrders: 0,
        auditLogs: 0,
        closureCases: 0,
        closureCurrentDocuments: 0,
        closureDocuments: 0,
        closureEvents: 0,
        closureReceipts: 0,
        esignTasks: 0,
        fileObjects: 0,
        handoverEvents: 0,
        handoverWorkOrders: 0,
        vehicleReturns: 0
      });
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it("preserves unmanaged legacy preparation and rejects an orphaned P0 specialist marker", async () => {
    const legacy = await createExpiryFixture(prisma);
    const managed = await createManagedExpiryFixture(prisma);
    const closure = createGovernedClosureService(prisma);
    try {
      const legacyReturnId = randomUUID();
      await prisma.$transaction(async (tx) => {
        await tx.subscriptionOrder.update({
          data: { orderStatus: "PENDING_RETURN" },
          where: { id: legacy.orderId }
        });
        await tx.vehicleReturn.create({
          data: {
            customerId: legacy.customerId,
            id: legacyReturnId,
            orderId: legacy.orderId,
            returnNo: `RETLEG${legacyReturnId.replaceAll("-", "").slice(0, 18)}`,
            returnStatus: "PENDING",
            returnType: "NORMAL_RETURN",
            vehicleId: legacy.vehicleId
          }
        });
        const capability = await closure.prepareManagedReturnInTransaction(tx, {
          actorId: managed.actorId,
          orderId: legacy.orderId,
          returnLocation: "legacy center",
          scheduledAt: new Date("2026-08-22T02:00:00.000Z")
        });
        expect(capability).toBeNull();
        await tx.vehicleReturn.update({
          data: { returnLocation: "legacy center", returnStatus: "READY" },
          where: { orderId: legacy.orderId }
        });
      });
      await expect(
        prisma.vehicleReturn.findUniqueOrThrow({ where: { orderId: legacy.orderId } })
      ).resolves.toMatchObject({ id: legacyReturnId, returnLocation: "legacy center" });

      await prisma.$transaction(
        async (tx) => {
          const handover = new HandoverWorkOrderService(prisma, {} as never);
          const command = {
            actorId: managed.actorId,
            orderId: managed.orderId,
            source: {
              id: managed.segmentId,
              key: "return-inbound-handover",
              type: "SUBSCRIPTION_EXPIRY"
            }
          };
          const sourceCapability = await handover.prepareReturnInboundInTransaction(tx, command);
          await handover.createReturnInboundInTransaction(tx, command, sourceCapability);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
      );
      await expect(
        prisma.$transaction(
          (tx) =>
            closure.prepareManagedReturnInTransaction(tx, {
              actorId: managed.actorId,
              orderId: managed.orderId,
              returnLocation: null,
              scheduledAt: null
            }),
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
        )
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_MANAGED_RETURN_AUTHORITY_NOT_FOUND" },
        status: 409
      });
    } finally {
      await cleanupExpiryFixture(
        prisma,
        legacy.orderId,
        legacy.segmentId,
        legacy.customerId,
        legacy.vehicleId
      );
      await cleanupManagedExpiryFixture(prisma, managed);
    }
  });

  it("rolls back the managed return, specialist event, and transaction audit together", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const expiry = createGovernedExpiryService(prisma);
    const closure = createGovernedClosureService(prisma);
    try {
      await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { orderId: fixture.orderId }
      });
      const before = await Promise.all([
        prisma.vehicleReturn.findUniqueOrThrow({ where: { id: closureCase.vehicleReturnId! } }),
        prisma.vehicleHandoverWorkOrder.findUniqueOrThrow({
          where: { id: closureCase.returnHandoverWorkOrderId! }
        }),
        prisma.vehicleHandoverEvent.count({
          where: { workOrderId: closureCase.returnHandoverWorkOrderId! }
        }),
        prisma.auditLog.count({ where: { operatorId: fixture.actorId } })
      ]);
      await expect(
        prisma.$transaction(
          async (tx) => {
            const input = {
              actorId: fixture.actorId,
              orderId: fixture.orderId,
              returnLocation: "rollback center",
              scheduledAt: new Date("2026-08-22T02:00:00.000Z")
            };
            const capability = await closure.prepareManagedReturnInTransaction(tx, input);
            if (!capability) throw new Error("Expected managed normal-return authority");
            const vehicleReturn = await tx.vehicleReturn.update({
              data: {
                returnLocation: input.returnLocation,
                returnStatus: "READY",
                scheduledAt: input.scheduledAt,
                updatedBy: fixture.actorId
              },
              where: { id: closureCase.vehicleReturnId! }
            });
            await closure.completeManagedReturnInTransaction(
              tx,
              { ...input, vehicleReturnId: vehicleReturn.id },
              capability
            );
            await new AuditService(prisma).write(
              {
                action: "UPDATE",
                after: { returnLocation: input.returnLocation },
                entityId: vehicleReturn.id,
                entityType: "vehicle_return",
                module: "vehicle_return",
                operatorId: fixture.actorId
              },
              tx
            );
            throw new Error("TASK3_MANAGED_AUDIT_FAIL");
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
        )
      ).rejects.toThrow("TASK3_MANAGED_AUDIT_FAIL");
      const after = await Promise.all([
        prisma.vehicleReturn.findUniqueOrThrow({ where: { id: closureCase.vehicleReturnId! } }),
        prisma.vehicleHandoverWorkOrder.findUniqueOrThrow({
          where: { id: closureCase.returnHandoverWorkOrderId! }
        }),
        prisma.vehicleHandoverEvent.count({
          where: { workOrderId: closureCase.returnHandoverWorkOrderId! }
        }),
        prisma.auditLog.count({ where: { operatorId: fixture.actorId } })
      ]);
      expect(after).toEqual(before);
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it.each([
    "after-specialist",
    "after-common",
    "after-case-audit",
    "after-document-audit",
    "after-document"
  ] as const)("rolls back every fact and audit at the %s failpoint", async (failpoint) => {
    const fixture = await createManagedExpiryFixture(prisma);
    const service = createGovernedExpiryService(prisma, failpoint);
    try {
      const beforeTruth = await snapshotManagedExpiryTruth(prisma, fixture);
      await expect(
        service.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"))
      ).rejects.toThrow(`TASK3_FAILPOINT:${failpoint}`);

      await expect(snapshotManagedExpiryTruth(prisma, fixture)).resolves.toEqual(beforeTruth);

      await expectManagedExpiryFactCounts(prisma, fixture, {
        assetWorkOrders: 0,
        auditLogs: 0,
        closureCases: 0,
        closureCurrentDocuments: 0,
        closureDocuments: 0,
        closureEvents: 0,
        closureReceipts: 0,
        esignTasks: 0,
        fileObjects: 0,
        handoverEvents: 0,
        handoverWorkOrders: 0,
        vehicleReturns: 0
      });
      await expect(
        prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } })
      ).resolves.toMatchObject({ orderStatus: OrderStatus.ACTIVE });
      await expect(
        prisma.subscriptionContractSegment.findUniqueOrThrow({ where: { id: fixture.segmentId } })
      ).resolves.toMatchObject({ status: ContractSegmentStatus.ACTIVE });
      await expect(
        prisma.lease.findUniqueOrThrow({ where: { orderId: fixture.orderId } })
      ).resolves.toMatchObject({ status: LeaseStatus.ACTIVE });
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it("proves the rollback snapshot detects a committed mutation", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const service = createGovernedExpiryService(prisma);
    try {
      const beforeTruth = await snapshotManagedExpiryTruth(prisma, fixture);
      await service.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      const afterTruth = await snapshotManagedExpiryTruth(prisma, fixture);
      expect(afterTruth).not.toEqual(beforeTruth);
      expectExactCommittedManagedExpiryTruth(afterTruth, fixture);

      const mutation = structuredClone(afterTruth);
      mutation.audits.push({ ...mutation.audits[0]!, id: randomUUID() });
      expect(() => expectExactCommittedManagedExpiryTruth(mutation, fixture)).toThrow();
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it("lets recovery win against managed prepare with one authoritative result", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const expiry = createGovernedExpiryService(prisma);
    const closure = createGovernedClosureService(prisma);
    const repository = new SubscriptionClosureRepository();
    const barrier = createBarrier();
    try {
      await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { orderId: fixture.orderId }
      });
      const recoveryPromise = prisma.$transaction(
        async (tx) => {
          const result = await repository.escalateRecovery(tx, {
            actorId: fixture.actorId,
            closureCaseId: closureCase.id,
            detailSnapshot: { reason: "recovery won" },
            expectedStatus: "PREPARING_RETURN",
            expectedVersion: 1,
            occurredAt: await databaseNow(tx),
            source: { id: fixture.orderId, key: "recovery-race", type: "TASK3_TEST" }
          });
          barrier.enter();
          await barrier.released;
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
      );
      await barrier.entered;

      const prepareResult = await runManagedPrepare(prisma, closure, fixture).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ reason, status: "rejected" as const })
      );
      expect(prepareResult).toMatchObject({
        reason: { response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" }, status: 409 },
        status: "rejected"
      });
      barrier.release();
      await expect(recoveryPromise).resolves.toMatchObject({ wrote: true });
      await expect(
        prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCase.id } })
      ).resolves.toMatchObject({
        physicalControlMode: "RECOVERY",
        status: "RECOVERY_ASSESSMENT_PENDING",
        version: 2
      });
      await expect(runManagedPrepare(prisma, closure, fixture)).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_MANAGED_RETURN_AUTHORITY_NOT_FOUND" },
        status: 409
      });
    } finally {
      barrier.release();
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it("lets managed prepare win while the recovery contender receives stable NOWAIT 409", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const expiry = createGovernedExpiryService(prisma);
    const closure = createGovernedClosureService(prisma);
    const repository = new SubscriptionClosureRepository();
    const barrier = createBarrier();
    try {
      await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { orderId: fixture.orderId }
      });
      const preparePromise = runManagedPrepare(prisma, closure, fixture, barrier);
      await barrier.entered;
      const recoveryResult = await prisma
        .$transaction(
          async (tx) =>
            repository.escalateRecovery(tx, {
              actorId: fixture.actorId,
              closureCaseId: closureCase.id,
              detailSnapshot: { reason: "recovery lost" },
              expectedStatus: "PREPARING_RETURN",
              expectedVersion: 1,
              occurredAt: await databaseNow(tx),
              source: { id: fixture.orderId, key: "recovery-race", type: "TASK3_TEST" }
            }),
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
        )
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason) => ({ reason, status: "rejected" as const })
        );
      expect(recoveryResult).toMatchObject({
        reason: { response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" }, status: 409 },
        status: "rejected"
      });
      barrier.release();
      await expect(preparePromise).resolves.toMatchObject({
        handoverWorkOrderId: closureCase.returnHandoverWorkOrderId
      });
      await expect(
        prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCase.id } })
      ).resolves.toMatchObject({
        physicalControlMode: "VOLUNTARY_RETURN",
        status: "PREPARING_RETURN",
        version: 1
      });
      await expect(
        prisma.vehicleReturn.findUniqueOrThrow({ where: { id: closureCase.vehicleReturnId! } })
      ).resolves.toMatchObject({
        returnLocation: "静安旺旺大厦",
        returnStatus: "READY",
        scheduledAt: new Date("2026-08-22T02:00:00.000Z")
      });
      await expect(
        prisma.vehicleHandoverWorkOrder.findUniqueOrThrow({
          where: { id: closureCase.returnHandoverWorkOrderId! }
        })
      ).resolves.toMatchObject({
        deliveryLocation: "静安旺旺大厦",
        scheduledAt: new Date("2026-08-22T02:00:00.000Z")
      });
    } finally {
      barrier.release();
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });
});

function passthroughClosureOrchestrator() {
  const capability = Object.freeze({});
  return {
    completeNormalExpiryInTransaction: vi.fn(async () => ({
      closureCaseId: randomUUID(),
      returnAssetWorkOrderId: randomUUID(),
      returnHandoverWorkOrderId: randomUUID(),
      returnManifestRevisionId: randomUUID()
    })),
    prepareNormalExpiryInTransaction: vi.fn(async () => capability),
    preparedNormalExpiryVehicleReturnId: vi.fn(() => randomUUID())
  } as never;
}

function createGovernedClosureService(prisma: PrismaService) {
  const audit = new AuditService(prisma);
  return new SubscriptionClosureService(
    new SubscriptionClosureRepository(),
    new HandoverWorkOrderService(prisma, {} as never),
    new AssetOperationsService(prisma, new AssetOperationsRepository(), audit),
    audit
  );
}

async function runManagedPrepare(
  prisma: PrismaService,
  closure: SubscriptionClosureService,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>,
  barrier?: ReturnType<typeof createBarrier>
) {
  return prisma.$transaction(
    async (tx) => {
      const input = {
        actorId: fixture.actorId,
        orderId: fixture.orderId,
        returnLocation: "静安旺旺大厦",
        scheduledAt: new Date("2026-08-22T02:00:00.000Z")
      };
      const capability = await closure.prepareManagedReturnInTransaction(tx, input);
      if (!capability) throw new Error("Expected managed normal-return authority");
      barrier?.enter();
      if (barrier) await barrier.released;
      const vehicleReturn = await tx.vehicleReturn.update({
        data: {
          returnLocation: input.returnLocation,
          returnStatus: "READY",
          scheduledAt: input.scheduledAt,
          updatedBy: fixture.actorId
        },
        where: { orderId: fixture.orderId }
      });
      return closure.completeManagedReturnInTransaction(
        tx,
        { ...input, vehicleReturnId: vehicleReturn.id },
        capability
      );
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
  );
}

async function databaseNow(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "now"
  `);
  if (!row) throw new Error("Database clock unavailable");
  return row.now;
}

type Task3Failpoint =
  | "after-case-audit"
  | "after-common"
  | "after-document"
  | "after-document-audit"
  | "after-specialist";

function createGovernedExpiryService(prisma: PrismaService, failpoint?: Task3Failpoint) {
  const actualAudit = new AuditService(prisma);
  const audit = {
    write: async (entry: { after?: unknown }, tx?: Prisma.TransactionClient) => {
      const result = await actualAudit.write(entry as never, tx);
      const action =
        entry.after && typeof entry.after === "object" && "action" in entry.after
          ? entry.after.action
          : undefined;
      if (
        (failpoint === "after-case-audit" && action === "CREATE_CASE") ||
        (failpoint === "after-document-audit" && action === "CREATE_DOCUMENT_REVISION")
      ) {
        throw new Error(`TASK3_FAILPOINT:${failpoint}`);
      }
      return result;
    }
  } as unknown as AuditService;
  const actualHandover = new HandoverWorkOrderService(prisma, {} as never);
  const handover = new Proxy(actualHandover, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "createPreparedReturnInboundInTransaction") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          if (failpoint === "after-specialist") {
            throw new Error(`TASK3_FAILPOINT:${failpoint}`);
          }
          return result;
        };
      }
      return value.bind(target);
    }
  });
  const actualAssetOperations = new AssetOperationsService(
    prisma,
    new AssetOperationsRepository(),
    audit
  );
  const assetOperations = new Proxy(actualAssetOperations, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "createPreparedWorkOrderInTransaction") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          if (failpoint === "after-common") {
            throw new Error(`TASK3_FAILPOINT:${failpoint}`);
          }
          return result;
        };
      }
      return value.bind(target);
    }
  });
  const actualRepository = new SubscriptionClosureRepository();
  const repository = new Proxy(actualRepository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "appendPreparedDocumentRevisionInTransaction") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          if (failpoint === "after-document") {
            throw new Error(`TASK3_FAILPOINT:${failpoint}`);
          }
          return result;
        };
      }
      return value.bind(target);
    }
  });
  const closure = new SubscriptionClosureService(repository, handover, assetOperations, audit);
  return new SubscriptionExpiryService(
    prisma,
    {
      notifyRenewalExpiryInApp: vi.fn(async () => ({ created: true })),
      notifyRenewalReturnOverdueInApp: vi.fn(async () => ({ created: true }))
    } as never,
    audit,
    closure
  );
}

async function createManagedExpiryFixture(prisma: PrismaService) {
  const fixture = await createExpiryFixture(prisma);
  const actorId = randomUUID();
  const contractId = randomUUID();
  const marker = `expiry-${fixture.orderId}`;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw(Prisma.sql`
      INSERT INTO "user" ("id", "username", "name", "password_hash", "status", "created_at", "updated_at")
      VALUES (${actorId}::uuid, ${marker}, 'Expiry actor', 'not-used', 'ACTIVE', clock_timestamp(), clock_timestamp())
    `);
      await tx.$executeRaw(Prisma.sql`
      INSERT INTO "contract" (
        "id", "contract_no", "order_id", "customer_id", "business_type", "contract_version_id",
        "contract_title", "contract_snapshot", "status", "created_by", "updated_by", "created_at", "updated_at"
      ) VALUES (
        ${contractId}::uuid, ${`CONEXP${contractId.replaceAll("-", "").slice(0, 18)}`},
        ${fixture.orderId}::uuid, ${fixture.customerId}::uuid, 'SUBSCRIPTION', ${randomUUID()}::uuid,
        'Normal expiry contract', '{}'::jsonb, 'SIGNED', ${actorId}::uuid, ${actorId}::uuid,
        clock_timestamp(), clock_timestamp()
      )
    `);
      await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_order"
      SET "contract_id" = ${contractId}::uuid,
          "created_by" = ${actorId}::uuid,
          "updated_by" = ${actorId}::uuid,
          "end_date" = '2026-08-20'::date
      WHERE "id" = ${fixture.orderId}::uuid
    `);
      await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_contract_segment"
      SET "end_date" = '2026-08-20'::date,
          "created_by" = ${actorId}::uuid
      WHERE "id" = ${fixture.segmentId}::uuid
    `);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
  );
  return { ...fixture, actorId, contractId };
}

async function expectManagedExpiryFactCounts(
  prisma: PrismaService,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>,
  expected: Readonly<{
    assetWorkOrders: number;
    auditLogs: number;
    closureCases: number;
    closureCurrentDocuments: number;
    closureDocuments: number;
    closureEvents: number;
    closureReceipts: number;
    esignTasks: number;
    fileObjects: number;
    handoverEvents: number;
    handoverWorkOrders: number;
    vehicleReturns: number;
  }>
) {
  const [
    assetWorkOrders,
    auditLogs,
    closureCases,
    closureCurrentDocuments,
    closureDocuments,
    closureEvents,
    closureReceipts,
    esignTasks,
    fileObjects,
    handoverEvents,
    handoverWorkOrders,
    vehicleReturns
  ] = await Promise.all([
    prisma.assetWorkOrder.count({ where: { orderId: fixture.orderId } }),
    prisma.auditLog.count({ where: { operatorId: fixture.actorId } }),
    prisma.subscriptionClosureCase.count({ where: { orderId: fixture.orderId } }),
    prisma.subscriptionClosureCurrentDocument.count({
      where: { closureCase: { orderId: fixture.orderId } }
    }),
    prisma.subscriptionClosureDocumentRevision.count({
      where: { closureCase: { orderId: fixture.orderId } }
    }),
    prisma.subscriptionClosureEvent.count({
      where: { closureCase: { orderId: fixture.orderId } }
    }),
    prisma.subscriptionClosureCommandReceipt.count({
      where: { closureCase: { orderId: fixture.orderId } }
    }),
    prisma.contractESignTask.count({ where: { orderId: fixture.orderId } }),
    prisma.fileObject.count({ where: { uploadedBy: fixture.actorId } }),
    prisma.vehicleHandoverEvent.count({
      where: { workOrder: { orderId: fixture.orderId } }
    }),
    prisma.vehicleHandoverWorkOrder.count({ where: { orderId: fixture.orderId } }),
    prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })
  ]);
  expect({
    assetWorkOrders,
    auditLogs,
    closureCases,
    closureCurrentDocuments,
    closureDocuments,
    closureEvents,
    closureReceipts,
    esignTasks,
    fileObjects,
    handoverEvents,
    handoverWorkOrders,
    vehicleReturns
  }).toEqual(expected);
}

async function snapshotManagedExpiryTruth(
  prisma: PrismaService,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>
) {
  const [
    segment,
    order,
    lease,
    vehicleReturns,
    considerations,
    changes,
    billingSchedule,
    entitlementAccounts,
    automationJobs,
    specialistWorkOrders,
    specialistEvents,
    assetWorkOrders,
    assetEvents,
    closureCases,
    closureEvents,
    closureReceipts,
    currentDocuments,
    documentRevisions,
    files,
    esignTasks
  ] = await Promise.all([
    prisma.subscriptionContractSegment.findUnique({
      select: { completedAt: true, id: true, status: true },
      where: { id: fixture.segmentId }
    }),
    prisma.subscriptionOrder.findUnique({
      select: { id: true, orderStatus: true },
      where: { id: fixture.orderId }
    }),
    prisma.lease.findUnique({
      select: { id: true, status: true },
      where: { orderId: fixture.orderId }
    }),
    prisma.vehicleReturn.findMany({
      orderBy: { id: "asc" },
      select: {
        deletedAt: true,
        id: true,
        orderId: true,
        returnLocation: true,
        returnStatus: true,
        returnType: true,
        scheduledAt: true
      },
      where: { orderId: fixture.orderId }
    }),
    prisma.renewalConsideration.findMany({
      orderBy: { id: "asc" },
      select: { id: true, status: true, version: true },
      where: { orderId: fixture.orderId }
    }),
    prisma.subscriptionChangeOrder.findMany({
      orderBy: { id: "asc" },
      select: { failureCode: true, failureMessage: true, id: true, status: true, version: true },
      where: { orderId: fixture.orderId }
    }),
    prisma.billingSchedule.findUnique({
      select: { completedAt: true, id: true, pauseReason: true, status: true, version: true },
      where: { orderId: fixture.orderId }
    }),
    prisma.orderEntitlementAccount.findMany({
      orderBy: { id: "asc" },
      select: { accountStatus: true, id: true },
      where: { orderId: fixture.orderId }
    }),
    prisma.subscriptionAutomationJob.findMany({
      orderBy: { id: "asc" },
      select: {
        cancelledAt: true,
        completedAt: true,
        id: true,
        jobStatus: true,
        leaseExpiresAt: true,
        leaseToken: true
      },
      where: { orderId: fixture.orderId }
    }),
    prisma.vehicleHandoverWorkOrder.findMany({
      orderBy: { id: "asc" },
      select: {
        deliveryLocation: true,
        handoverType: true,
        id: true,
        metadata: true,
        orderId: true,
        scheduledAt: true,
        status: true
      },
      where: { orderId: fixture.orderId }
    }),
    prisma.vehicleHandoverEvent.findMany({
      orderBy: { id: "asc" },
      select: { actorId: true, eventType: true, id: true, workOrderId: true },
      where: { workOrder: { orderId: fixture.orderId } }
    }),
    prisma.assetWorkOrder.findMany({
      orderBy: { id: "asc" },
      select: {
        contractId: true,
        createSourceId: true,
        createSourceKey: true,
        createSourceType: true,
        customerId: true,
        id: true,
        orderId: true,
        status: true,
        vehicleId: true,
        workOrderType: true
      },
      where: { orderId: fixture.orderId }
    }),
    prisma.assetWorkOrderEvent.findMany({
      orderBy: { id: "asc" },
      select: { actorId: true, eventType: true, id: true, workOrderId: true },
      where: { workOrder: { orderId: fixture.orderId } }
    }),
    prisma.subscriptionClosureCase.findMany({
      orderBy: { id: "asc" },
      select: {
        closureType: true,
        caseNo: true,
        contractId: true,
        createSourceId: true,
        createSourceKey: true,
        createSourceType: true,
        customerId: true,
        id: true,
        orderId: true,
        returnAssetWorkOrderId: true,
        returnHandoverWorkOrderId: true,
        status: true,
        vehicleId: true,
        vehicleReturnId: true,
        version: true
      },
      where: { orderId: fixture.orderId }
    }),
    prisma.subscriptionClosureEvent.findMany({
      orderBy: { id: "asc" },
      select: {
        actorId: true,
        closureCaseId: true,
        eventType: true,
        id: true,
        sequence: true,
        sourceId: true,
        sourceKey: true,
        sourceType: true
      },
      where: { closureCase: { orderId: fixture.orderId } }
    }),
    prisma.subscriptionClosureCommandReceipt.findMany({
      orderBy: { id: "asc" },
      select: {
        actorId: true,
        closureCaseId: true,
        commandType: true,
        eventId: true,
        id: true,
        sourceId: true,
        sourceKey: true,
        sourceType: true
      },
      where: { closureCase: { orderId: fixture.orderId } }
    }),
    prisma.subscriptionClosureCurrentDocument.findMany({
      orderBy: { documentType: "asc" },
      select: { closureCaseId: true, documentRevisionId: true, documentType: true },
      where: { closureCase: { orderId: fixture.orderId } }
    }),
    prisma.subscriptionClosureDocumentRevision.findMany({
      orderBy: { id: "asc" },
      select: {
        archivedAt: true,
        closureCaseId: true,
        contractESignTaskId: true,
        documentSnapshot: true,
        documentSnapshotHash: true,
        documentType: true,
        generatedAt: true,
        generatedBy: true,
        handoverWorkOrderId: true,
        id: true,
        revisionNumber: true,
        signedAt: true,
        sourceFileId: true,
        sourceId: true,
        sourceKey: true,
        sourceType: true,
        stage: true,
        vehicleReturnId: true
      },
      where: { closureCase: { orderId: fixture.orderId } }
    }),
    prisma.fileObject.findMany({
      orderBy: { id: "asc" },
      select: { id: true, objectKey: true, uploadedBy: true },
      where: { uploadedBy: fixture.actorId }
    }),
    prisma.contractESignTask.findMany({
      orderBy: { id: "asc" },
      select: {
        contractId: true,
        customerId: true,
        documentType: true,
        id: true,
        orderId: true,
        requestSnapshot: true,
        signingStage: true,
        sourceId: true,
        sourceKey: true,
        sourceType: true,
        taskStatus: true
      },
      where: { orderId: fixture.orderId }
    })
  ]);
  const relatedEntityIds = [
    fixture.orderId,
    fixture.segmentId,
    ...(lease ? [lease.id] : []),
    ...(billingSchedule ? [billingSchedule.id] : []),
    ...vehicleReturns.map(({ id }) => id),
    ...considerations.map(({ id }) => id),
    ...changes.map(({ id }) => id),
    ...entitlementAccounts.map(({ id }) => id),
    ...automationJobs.map(({ id }) => id),
    ...specialistWorkOrders.map(({ id }) => id),
    ...specialistEvents.map(({ id }) => id),
    ...assetWorkOrders.map(({ id }) => id),
    ...assetEvents.map(({ id }) => id),
    ...closureCases.map(({ id }) => id),
    ...closureEvents.map(({ id }) => id),
    ...closureReceipts.map(({ id }) => id),
    ...documentRevisions.map(({ id }) => id),
    ...files.map(({ id }) => id),
    ...esignTasks.map(({ id }) => id)
  ];
  const audits = await prisma.auditLog.findMany({
    orderBy: { id: "asc" },
    select: { action: true, entityId: true, entityType: true, id: true, module: true },
    where: { entityId: { in: relatedEntityIds } }
  });
  return {
    assetEvents,
    assetWorkOrders,
    audits,
    automationJobs,
    billingSchedule,
    changes,
    closureCases,
    closureEvents,
    closureReceipts,
    considerations,
    currentDocuments,
    documentRevisions,
    entitlementAccounts,
    esignTasks,
    files,
    lease,
    order,
    segment,
    specialistEvents,
    specialistWorkOrders,
    vehicleReturns
  };
}

type ManagedExpiryTruth = Awaited<ReturnType<typeof snapshotManagedExpiryTruth>>;

function expectExactCommittedManagedExpiryTruth(
  truth: ManagedExpiryTruth,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>
) {
  const decisionAt = new Date("2026-08-20T16:00:00.000Z");
  expect(truth.segment).toEqual({
    completedAt: decisionAt,
    id: fixture.segmentId,
    status: "COMPLETED"
  });
  expect(truth.order).toEqual({ id: fixture.orderId, orderStatus: "PENDING_RETURN" });
  expect(truth.lease).toEqual({ id: expectUuid(), status: "RETURN_DUE" });
  expect(truth.considerations).toEqual([]);
  expect(truth.changes).toEqual([]);
  expect(truth.entitlementAccounts).toEqual([]);
  expect(truth.billingSchedule).toEqual({
    completedAt: null,
    id: fixture.scheduleId,
    pauseReason: null,
    status: "ACTIVE",
    version: 1
  });
  expect(Object.fromEntries(truth.automationJobs.map((job) => [job.id, job]))).toEqual({
    [fixture.earnedJobId]: {
      cancelledAt: null,
      completedAt: null,
      id: fixture.earnedJobId,
      jobStatus: "PENDING",
      leaseExpiresAt: null,
      leaseToken: null
    },
    [fixture.futureJobId]: {
      cancelledAt: decisionAt,
      completedAt: decisionAt,
      id: fixture.futureJobId,
      jobStatus: "CANCELLED",
      leaseExpiresAt: null,
      leaseToken: null
    }
  });

  expect(truth.vehicleReturns).toHaveLength(1);
  const vehicleReturn = truth.vehicleReturns[0]!;
  expect(vehicleReturn).toEqual({
    deletedAt: null,
    id: expectUuid(),
    orderId: fixture.orderId,
    returnLocation: null,
    returnStatus: "PENDING",
    returnType: "NORMAL_RETURN",
    scheduledAt: decisionAt
  });
  expect(truth.specialistWorkOrders).toHaveLength(1);
  const specialist = truth.specialistWorkOrders[0]!;
  const specialistMetadata = specialist.metadata as {
    p0ReturnInbound?: { commandHash?: unknown; source?: unknown };
  };
  expect(specialistMetadata.p0ReturnInbound?.commandHash).toMatch(/^[a-f0-9]{64}$/);
  expect(specialist).toEqual({
    deliveryLocation: null,
    handoverType: "RETURN_INBOUND",
    id: expectUuid(),
    metadata: {
      p0ReturnInbound: {
        commandHash: specialistMetadata.p0ReturnInbound!.commandHash,
        source: {
          id: fixture.segmentId,
          key: "return-inbound-handover",
          type: "SUBSCRIPTION_EXPIRY"
        }
      }
    },
    orderId: fixture.orderId,
    scheduledAt: null,
    status: "DRAFT"
  });
  expect(truth.specialistEvents).toEqual([
    {
      actorId: fixture.actorId,
      eventType: "WORK_ORDER_CREATED",
      id: expectUuid(),
      workOrderId: specialist.id
    }
  ]);
  expect(truth.assetWorkOrders).toEqual([
    {
      contractId: fixture.contractId,
      createSourceId: fixture.segmentId,
      createSourceKey: "return-inbound-asset-work-order",
      createSourceType: "SUBSCRIPTION_EXPIRY",
      customerId: fixture.customerId,
      id: expectUuid(),
      orderId: fixture.orderId,
      status: "PENDING",
      vehicleId: fixture.vehicleId,
      workOrderType: "RETURN_INBOUND"
    }
  ]);
  const asset = truth.assetWorkOrders[0]!;
  expect(truth.assetEvents).toEqual([
    {
      actorId: fixture.actorId,
      eventType: "CREATED",
      id: expectUuid(),
      workOrderId: asset.id
    }
  ]);

  expect(truth.closureCases).toHaveLength(1);
  const closureCase = truth.closureCases[0]!;
  expect(closureCase).toEqual({
    caseNo: expect.stringMatching(/^SC-[a-f0-9]{52,64}$/),
    closureType: "NORMAL_COMPLETION",
    contractId: fixture.contractId,
    createSourceId: fixture.segmentId,
    createSourceKey: "normal-closure-case",
    createSourceType: "SUBSCRIPTION_EXPIRY",
    customerId: fixture.customerId,
    id: expectUuid(),
    orderId: fixture.orderId,
    returnAssetWorkOrderId: asset.id,
    returnHandoverWorkOrderId: specialist.id,
    status: "PREPARING_RETURN",
    vehicleId: fixture.vehicleId,
    vehicleReturnId: vehicleReturn.id,
    version: 1
  });
  const closureEvents = [...truth.closureEvents].sort(
    (left, right) => left.sequence - right.sequence
  );
  expect(closureEvents).toEqual([
    {
      actorId: fixture.actorId,
      closureCaseId: closureCase.id,
      eventType: "CASE_CREATED",
      id: expectUuid(),
      sequence: 1,
      sourceId: fixture.segmentId,
      sourceKey: "normal-closure-case",
      sourceType: "SUBSCRIPTION_EXPIRY"
    },
    {
      actorId: fixture.actorId,
      closureCaseId: closureCase.id,
      eventType: "DOCUMENT_REVISION_CREATED",
      id: expectUuid(),
      sequence: 2,
      sourceId: fixture.segmentId,
      sourceKey: "return-manifest:1",
      sourceType: "SUBSCRIPTION_EXPIRY"
    }
  ]);
  expect(truth.documentRevisions).toHaveLength(1);
  const document = truth.documentRevisions[0]!;
  expect(document.documentSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
  expect(document).toEqual({
    archivedAt: null,
    closureCaseId: closureCase.id,
    contractESignTaskId: expectUuid(),
    documentSnapshot: {
      assetWorkOrderId: asset.id,
      caseNo: closureCase.caseNo,
      closureCaseId: closureCase.id,
      contractId: fixture.contractId,
      customerId: fixture.customerId,
      documentType: "RETURN_MANIFEST",
      handoverWorkOrderId: specialist.id,
      orderId: fixture.orderId,
      segmentId: fixture.segmentId,
      vehicleId: fixture.vehicleId,
      vehicleReturnId: vehicleReturn.id
    },
    documentSnapshotHash: document.documentSnapshotHash,
    documentType: "RETURN_MANIFEST",
    generatedAt: expect.any(Date),
    generatedBy: fixture.actorId,
    handoverWorkOrderId: specialist.id,
    id: expectUuid(),
    revisionNumber: 1,
    signedAt: null,
    sourceFileId: expectUuid(),
    sourceId: fixture.segmentId,
    sourceKey: "return-manifest:1",
    sourceType: "SUBSCRIPTION_EXPIRY",
    stage: "GENERATED",
    vehicleReturnId: vehicleReturn.id
  });
  expect(truth.currentDocuments).toEqual([
    {
      closureCaseId: closureCase.id,
      documentRevisionId: document.id,
      documentType: "RETURN_MANIFEST"
    }
  ]);
  expect(truth.files).toEqual([
    {
      id: document.sourceFileId,
      objectKey: `subscription-closure/${closureCase.id}/return-manifest-r1.json`,
      uploadedBy: fixture.actorId
    }
  ]);
  expect(truth.esignTasks).toEqual([
    {
      contractId: fixture.contractId,
      customerId: fixture.customerId,
      documentType: "DELIVERY_HANDOVER",
      id: document.contractESignTaskId,
      orderId: fixture.orderId,
      requestSnapshot: {
        closureCaseId: closureCase.id,
        documentSnapshotHash: document.documentSnapshotHash,
        documentType: "RETURN_MANIFEST",
        returnManifestSource: {
          id: fixture.segmentId,
          key: "return-manifest:1",
          type: "SUBSCRIPTION_EXPIRY"
        },
        revisionNumber: 1
      },
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      sourceId: fixture.segmentId,
      sourceKey: "return-manifest:1",
      sourceType: "SUBSCRIPTION_EXPIRY",
      taskStatus: "CREATED"
    }
  ]);
  const receipts = [...truth.closureReceipts].sort((left, right) =>
    compareTestText(left.commandType, right.commandType)
  );
  expect(receipts).toEqual([
    {
      actorId: fixture.actorId,
      closureCaseId: closureCase.id,
      commandType: "CREATE_CASE",
      eventId: closureEvents[0]!.id,
      id: expectUuid(),
      sourceId: fixture.segmentId,
      sourceKey: "normal-closure-case",
      sourceType: "SUBSCRIPTION_EXPIRY"
    },
    {
      actorId: fixture.actorId,
      closureCaseId: closureCase.id,
      commandType: "CREATE_DOCUMENT_REVISION",
      eventId: closureEvents[1]!.id,
      id: expectUuid(),
      sourceId: fixture.segmentId,
      sourceKey: "return-manifest:1",
      sourceType: "SUBSCRIPTION_EXPIRY"
    }
  ]);

  const auditFacts = truth.audits
    .map(({ action, entityId, entityType, module }) => ({ action, entityId, entityType, module }))
    .sort(
      (left, right) =>
        compareTestText(left.entityType, right.entityType) ||
        compareTestText(left.entityId ?? "", right.entityId ?? "")
    );
  expect(new Set(truth.audits.map(({ id }) => id)).size).toBe(5);
  for (const { id } of truth.audits) expect(id).toMatch(UUID_PATTERN);
  expect(auditFacts).toEqual(
    [
      {
        action: "CREATE",
        entityId: asset.id,
        entityType: "asset_work_order",
        module: "asset_operations"
      },
      {
        action: "CREATE",
        entityId: truth.assetEvents[0]!.id,
        entityType: "asset_work_order_event",
        module: "asset_operations"
      },
      ...closureEvents.map(({ id }) => ({
        action: "CREATE" as const,
        entityId: id,
        entityType: "subscription_closure_event",
        module: "subscription_closure"
      })),
      {
        action: "UPDATE",
        entityId: fixture.segmentId,
        entityType: "subscription_contract_segment",
        module: "subscription_change"
      }
    ].sort(
      (left, right) =>
        compareTestText(left.entityType, right.entityType) ||
        compareTestText(left.entityId, right.entityId)
    )
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function expectUuid() {
  return expect.stringMatching(UUID_PATTERN);
}

function compareTestText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function createRaceFixture(prisma: PrismaService) {
  const fixture = await createExpiryFixture(prisma);
  const actorId = randomUUID();
  const changeId = randomUUID();
  const considerationId = randomUUID();
  const contractId = randomUUID();
  const quoteId = randomUUID();
  const taskId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "user" ("id", "username", "name", "password_hash", "status", "created_at", "updated_at")
      VALUES (${actorId}::uuid, ${`race-${actorId}`}, 'Race actor', 'not-used', 'ACTIVE', clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "contract" (
        "id", "contract_no", "order_id", "customer_id", "business_type", "contract_version_id",
        "contract_title", "contract_snapshot", "status", "created_by", "updated_by", "created_at", "updated_at"
      ) VALUES (${contractId}::uuid, ${`CONRACE${contractId.replaceAll("-", "").slice(0, 18)}`}, ${fixture.orderId}::uuid, ${fixture.customerId}::uuid, 'SUBSCRIPTION', ${randomUUID()}::uuid, 'Extension agreement', '{}'::jsonb, 'SIGNED', ${actorId}::uuid, ${actorId}::uuid, clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_order"
      SET "contract_id" = ${contractId}::uuid, "created_by" = ${actorId}::uuid, "updated_by" = ${actorId}::uuid,
          "end_date" = '2026-08-20'::date
      WHERE "id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_contract_segment" SET "created_by" = ${actorId}::uuid, "end_date" = '2026-08-20'::date
      WHERE "id" = ${fixture.segmentId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "renewal_consideration" (
        "id", "consideration_no", "order_id", "segment_id", "status", "consideration_start_at", "completion_deadline_at", "created_at", "updated_at"
      ) VALUES (${considerationId}::uuid, ${`RCNRACE${considerationId.replaceAll("-", "").slice(0, 18)}`}, ${fixture.orderId}::uuid, ${fixture.segmentId}::uuid, 'EXTENSION_IN_PROGRESS', '2026-08-03T00:00:00Z'::timestamptz, '2026-08-22T16:00:00Z'::timestamptz, clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_change_order" (
        "id", "change_no", "order_id", "status", "source_segment_id", "renewal_consideration_id",
        "extension_months", "pricing_mode", "contract_id", "target_start_date", "target_end_date",
        "completion_deadline_at", "created_at", "updated_at"
      ) VALUES (${changeId}::uuid, ${`CHGRACE${changeId.replaceAll("-", "").slice(0, 18)}`}, ${fixture.orderId}::uuid, 'SIGNING_OR_PAYMENT', ${fixture.segmentId}::uuid, ${considerationId}::uuid, 6, 'CURRENT_VERSION', ${contractId}::uuid, '2026-08-21'::date, '2027-02-20'::date, '2026-08-22T16:00:00Z'::timestamptz, clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_change_quote" (
        "id", "quote_no", "change_order_id", "revision", "status", "pricing_mode", "monthly_fee_amount",
        "deposit_amount", "mileage_limit_km", "over_mileage_fee_amount", "plan_snapshot", "price_rule_snapshot",
        "quote_snapshot", "valid_until", "formalized_at", "confirmed_at", "created_at"
      ) VALUES (${quoteId}::uuid, ${`QUORACE${quoteId.replaceAll("-", "").slice(0, 18)}`}, ${changeId}::uuid, 1, 'CUSTOMER_CONFIRMED', 'CURRENT_VERSION', 100, 0, 1500, 100, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '2026-08-22T16:00:00Z'::timestamptz, clock_timestamp(), clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_change_order" SET "current_quote_id" = ${quoteId}::uuid, "confirmed_quote_id" = ${quoteId}::uuid WHERE "id" = ${changeId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "renewal_consideration" SET "change_order_id" = ${changeId}::uuid WHERE "id" = ${considerationId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "contract_esign_task" (
        "id", "task_no", "contract_id", "order_id", "customer_id", "provider", "signing_stage",
        "document_type", "task_status", "signed_document_object_key", "completed_at", "created_at", "updated_at"
      ) VALUES (${taskId}::uuid, ${`ESGRACE${taskId.replaceAll("-", "").slice(0, 18)}`}, ${contractId}::uuid, ${fixture.orderId}::uuid, ${fixture.customerId}::uuid, ${ESignProviderType.MOCK}::esign_provider_type, ${ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION}::esign_signing_stage, ${ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT}::esign_document_type, ${ESignTaskStatus.COMPLETED}::esign_task_status, 'signed/race.pdf', '2026-08-20T15:59:00Z'::timestamptz, clock_timestamp(), clock_timestamp())
    `);
  });
  return { ...fixture, actorId, changeId, considerationId, contractId, quoteId, taskId };
}

async function cleanupRaceFixture(
  prisma: PrismaService,
  fixture: Awaited<ReturnType<typeof createRaceFixture>>
) {
  await cleanupManagedExpiryFixture(prisma, fixture);
}

async function createExpiryFixture(prisma: PrismaService) {
  const customerId = randomUUID();
  const earnedJobId = randomUUID();
  const futureJobId = randomUUID();
  const orderId = randomUUID();
  const scheduleId = randomUUID();
  const segmentId = randomUUID();
  const vehicleId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "customer" ("id", "customer_no", "name", "mobile", "status", "created_at", "updated_at")
      VALUES (${customerId}::uuid, ${`CUSTEXP${customerId.replaceAll("-", "").slice(0, 18)}`}, 'Expiry Integration', '13800000000', 'ACTIVE', clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle" ("id", "vehicle_no", "plate_no", "brand", "model_definition_id", "purchase_price_amount", "status", "created_at", "updated_at")
      VALUES (${vehicleId}::uuid, ${`VEHEXP${vehicleId.replaceAll("-", "").slice(0, 18)}`}, ${`沪E${vehicleId.replaceAll("-", "").slice(0, 5)}`}, 'NIO', ${randomUUID()}::uuid, 20000000, 'LEASED', clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_order" (
        "id", "order_no", "customer_id", "application_id", "quote_id", "vehicle_id",
        "product_id", "product_version_id", "vehicle_purchase_price_amount", "monthly_fee_amount",
        "deposit_amount", "period_months", "mileage_limit_km", "over_mileage_fee_amount",
        "model_definition_id_snapshot", "model_code_snapshot", "model_display_name_snapshot",
        "quote_snapshot", "final_plan_snapshot", "order_status", "start_date", "end_date",
        "actual_delivery_at", "created_at", "updated_at"
      ) VALUES (
        ${orderId}::uuid, ${`ORDEXP${orderId.replaceAll("-", "").slice(0, 20)}`}, ${customerId}::uuid,
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${vehicleId}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, 20000000, 100, 0, 6, 1500, 100, ${randomUUID()}::uuid,
        'NIO_ET5_2024', 'NIO ET5', '{}'::jsonb, '{}'::jsonb, 'ACTIVE', '2026-03-03'::date,
        '2026-09-02'::date, '2026-03-03T02:00:00Z'::timestamptz, clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "lease" ("id", "order_id", "status", "activated_at", "created_at", "updated_at")
      VALUES (${randomUUID()}::uuid, ${orderId}::uuid, 'ACTIVE', '2026-03-03T02:00:00Z'::timestamptz, clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_schedule" (
        "id", "order_id", "status", "next_cycle_no", "next_period_start", "next_period_end", "next_generate_at", "created_at", "updated_at"
      ) VALUES (${scheduleId}::uuid, ${orderId}::uuid, 'ACTIVE', 6, '2026-08-03'::date, '2026-09-02'::date, '2026-08-01T01:00:00Z'::timestamptz, clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_contract_segment" (
        "id", "segment_no", "order_id", "segment_type", "sequence_no", "status", "start_date", "end_date",
        "monthly_fee_amount", "mileage_limit_km", "over_mileage_fee_amount", "plan_snapshot", "quote_snapshot", "contract_snapshot", "activated_at", "created_at"
      ) VALUES (${segmentId}::uuid, ${`SEGEXP${segmentId.replaceAll("-", "").slice(0, 20)}`}, ${orderId}::uuid, 'BASE', 1, 'ACTIVE', '2026-03-03'::date, '2026-09-02'::date, 100, 1500, 100, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '2026-03-03T02:00:00Z'::timestamptz, clock_timestamp())
    `);
    for (const job of [
      { id: earnedJobId, periodStart: "2026-08-03" },
      { id: futureJobId, periodStart: "2026-10-03" }
    ]) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "subscription_automation_job" (
          "id", "billing_schedule_id", "order_id", "job_type", "job_status", "idempotency_key", "available_at", "payload", "created_at", "updated_at"
        ) VALUES (${job.id}::uuid, ${scheduleId}::uuid, ${orderId}::uuid, 'GENERATE_MONTHLY_RENT_BILL', 'PENDING', ${`expiry-integration:${job.id}`}, clock_timestamp(), ${JSON.stringify({ periodStart: job.periodStart })}::jsonb, clock_timestamp(), clock_timestamp())
      `);
    }
  });
  return { customerId, earnedJobId, futureJobId, orderId, scheduleId, segmentId, vehicleId };
}

function createBarrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { enter, entered, release, released };
}

function hookTransaction(
  prisma: PrismaService,
  model: string,
  method: string,
  barrier: ReturnType<typeof createBarrier>,
  timing: "after" | "before" = "before"
) {
  let invoked = false;
  return {
    $transaction: (
      operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel }
    ) =>
      prisma.$transaction(async (tx) => {
        const hooked = new Proxy(tx, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (property !== model || !value || typeof value !== "object") return value;
            return new Proxy(value, {
              get(delegate, delegateProperty, delegateReceiver) {
                const delegateValue = Reflect.get(delegate, delegateProperty, delegateReceiver);
                if (delegateProperty !== method || typeof delegateValue !== "function") {
                  return typeof delegateValue === "function"
                    ? delegateValue.bind(delegate)
                    : delegateValue;
                }
                return async (...args: unknown[]) => {
                  if (!invoked && timing === "before") {
                    invoked = true;
                    barrier.enter();
                    await barrier.released;
                  }
                  const result = await delegateValue.apply(delegate, args);
                  if (!invoked && timing === "after") {
                    invoked = true;
                    barrier.enter();
                    await barrier.released;
                  }
                  return result;
                };
              }
            });
          }
        });
        return operation(hooked);
      }, options)
  } as PrismaService;
}

async function waitForPostgresLockWait(prisma: PrismaService) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const waiting = await prisma.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND datname = current_database()
          AND wait_event_type = 'Lock'
      ) AS "waiting"
    `);
    if (waiting[0]?.waiting) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Expected a PostgreSQL session to wait on an observed lock");
}

async function cleanupManagedExpiryFixture(
  prisma: PrismaService,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "audit_log" WHERE "operator_id" = ${fixture.actorId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_closure_command_receipt"
      WHERE "closure_case_id" IN (
        SELECT "id" FROM "subscription_closure_case" WHERE "order_id" = ${fixture.orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_closure_current_document"
      WHERE "closure_case_id" IN (
        SELECT "id" FROM "subscription_closure_case" WHERE "order_id" = ${fixture.orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_closure_document_revision"
      WHERE "closure_case_id" IN (
        SELECT "id" FROM "subscription_closure_case" WHERE "order_id" = ${fixture.orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_closure_event"
      WHERE "closure_case_id" IN (
        SELECT "id" FROM "subscription_closure_case" WHERE "order_id" = ${fixture.orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_closure_case" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "vehicle_handover_event"
      WHERE "work_order_id" IN (
        SELECT "id" FROM "vehicle_handover_work_order" WHERE "order_id" = ${fixture.orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "vehicle_handover_work_order" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "asset_work_order_event"
      WHERE "work_order_id" IN (
        SELECT "id" FROM "asset_work_order" WHERE "order_id" = ${fixture.orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "asset_work_order" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "file_object" WHERE "uploaded_by" = ${fixture.actorId}::uuid
    `);
  });
  await cleanupExpiryFixture(
    prisma,
    fixture.orderId,
    fixture.segmentId,
    fixture.customerId,
    fixture.vehicleId
  );
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM "user" WHERE "id" = ${fixture.actorId}::uuid
  `);
}

async function cleanupExpiryFixture(
  prisma: PrismaService,
  orderId: string,
  segmentId: string,
  customerId: string,
  vehicleId: string
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "audit_log"
      WHERE "entity_id" IN (${orderId}::uuid, ${segmentId}::uuid)
         OR "entity_id" IN (
        SELECT "id" FROM "subscription_contract_segment" WHERE "order_id" = ${orderId}::uuid
        UNION
        SELECT "id" FROM "subscription_change_order" WHERE "order_id" = ${orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "contract_esign_task" WHERE "order_id" = ${orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "renewal_reminder" WHERE "renewal_consideration_id" IN (
        SELECT "id" FROM "renewal_consideration" WHERE "order_id" = ${orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_change_quote" WHERE "change_order_id" IN (
        SELECT "id" FROM "subscription_change_order" WHERE "order_id" = ${orderId}::uuid
      )
    `);
    for (const table of [
      "vehicle_return",
      "subscription_automation_job",
      "renewal_consideration",
      "subscription_change_order",
      "subscription_contract_segment",
      "order_entitlement_account",
      "billing_schedule",
      "lease",
      "subscription_order"
    ]) {
      const column = table === "subscription_order" ? "id" : "order_id";
      if (
        table === "subscription_contract_segment" ||
        table === "billing_schedule" ||
        table === "lease" ||
        table === "vehicle_return" ||
        table === "subscription_automation_job" ||
        table === "renewal_consideration" ||
        table === "subscription_change_order" ||
        table === "order_entitlement_account" ||
        table === "subscription_order"
      ) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${column}" = $1::uuid`, orderId);
      }
    }
    await tx.$executeRaw(Prisma.sql`DELETE FROM "contract" WHERE "order_id" = ${orderId}::uuid`);
    await tx.$executeRaw(Prisma.sql`DELETE FROM "vehicle" WHERE "id" = ${vehicleId}::uuid`);
    await tx.$executeRaw(Prisma.sql`DELETE FROM "customer" WHERE "id" = ${customerId}::uuid`);
  });
}
