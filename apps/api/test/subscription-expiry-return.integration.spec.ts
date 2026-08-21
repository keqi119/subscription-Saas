import { ConfigService } from "@nestjs/config";
import {
  CollectionActionResult,
  CollectionActionType,
  ContactMethod,
  ContractSegmentStatus,
  ESignDocumentType,
  ESignProviderType,
  ESignSigningStage,
  ESignTaskStatus,
  LeaseStatus,
  OrderStatus,
  PaymentMethod,
  Prisma,
  SubscriptionAutomationJobStatus,
  SubscriptionChangeStatus,
  VehicleReturnStatus,
  VehicleStatus
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { AssetAccountingRepository } from "../src/asset-accounting/asset-accounting.repository";
import {
  ASSET_ACCOUNTING_PERMISSION,
  AssetAccountingService
} from "../src/asset-accounting/asset-accounting.service";
import { AssetFactsRepository } from "../src/asset-facts/asset-facts.repository";
import { AssetFactsService } from "../src/asset-facts/asset-facts.service";
import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../src/asset-operations/asset-operations.service";
import { Stage3ExtensionArchiveService } from "../src/esign/stage3-extension-archive.service";
import { FinanceService } from "../src/finance/finance.service";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";
import { buildReturnEligibility } from "../src/order/order.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { SubscriptionExpiryService } from "../src/subscription-change/subscription-expiry.service";
import { SubscriptionClosureRepository } from "../src/subscription-closure/subscription-closure.repository";
import { SubscriptionClosureService } from "../src/subscription-closure/subscription-closure.service";
import { canonicalSubscriptionClosureJson } from "../src/subscription-closure/subscription-closure.domain";
import { VehicleMileageRepository } from "../src/vehicle-mileage/vehicle-mileage.repository";
import { VehicleMileageService } from "../src/vehicle-mileage/vehicle-mileage.service";

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

  it("atomically records a signed-manifest physical receipt and exactly replays it", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const expiry = createGovernedExpiryService(prisma);
    let occurredAt = new Date("2026-08-21T08:00:00.000Z");
    const checklist = {
      batteryCheckedConfirmed: true,
      chargingEquipmentReturnedConfirmed: true,
      customerItemsClearedConfirmed: true,
      damageFound: true,
      exteriorCheckedConfirmed: true,
      interiorCheckedConfirmed: true,
      keysReturnedConfirmed: true,
      mileageConfirmed: true,
      vehicleDocumentsReturnedConfirmed: true,
      violationCheckedConfirmed: true
    };
    try {
      await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      await runManagedPrepare(prisma, createGovernedClosureService(prisma), fixture);
      occurredAt = (
        await prisma.subscriptionClosureEvent.findFirstOrThrow({
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          where: { closureCase: { orderId: fixture.orderId } }
        })
      ).occurredAt;
      await prisma.vehicleSubscriptionPeriod.create({
        data: {
          contractId: fixture.contractId,
          contractSegmentId: fixture.segmentId,
          createdBy: fixture.actorId,
          customerId: fixture.customerId,
          orderId: fixture.orderId,
          startConfirmedAt: new Date("2026-03-03T02:00:00.000Z"),
          startConfirmedBy: fixture.actorId,
          startReason: "DELIVERY_CONFIRMED",
          startSnapshot: { fixture: "task-4" },
          startSourceId: fixture.orderId,
          startSourceKey: "task-4-open-subscription",
          startSourceType: "TASK4_TEST",
          startedAt: new Date("2026-03-03T02:00:00.000Z"),
          vehicleId: fixture.vehicleId
        }
      });
      const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { orderId: fixture.orderId }
      });
      const revisionOne = await prisma.subscriptionClosureDocumentRevision.findFirstOrThrow({
        where: { closureCaseId: closureCase.id, documentType: "RETURN_MANIFEST" }
      });
      const checklistHash = createHash("sha256")
        .update(canonicalSubscriptionClosureJson(checklist))
        .digest("hex");
      const documentSnapshot = {
        ...(revisionOne.documentSnapshot as Prisma.JsonObject),
        returnChecklistSnapshotHash: checklistHash
      };
      const documentHash = createHash("sha256")
        .update(canonicalSubscriptionClosureJson(documentSnapshot))
        .digest("hex");
      const signedFileId = randomUUID();
      const signedFileHash = "b".repeat(64);
      const revisionId = randomUUID();
      const revisionTaskId = randomUUID();
      const revisionSource = {
        id: closureCase.id,
        key: "return-manifest:2",
        type: "SUBSCRIPTION_CLOSURE"
      };
      await prisma.$transaction(async (tx) => {
        await tx.vehicleReturn.update({
          data: {
            ...checklist,
            checklistSnapshot: checklist,
            returnStatus: "READY",
            updatedBy: fixture.actorId
          },
          where: { orderId: fixture.orderId }
        });
        const sourceFile = await tx.fileObject.findUniqueOrThrow({
          where: { id: revisionOne.sourceFileId }
        });
        await tx.fileObject.create({
          data: {
            bucket: sourceFile.bucket,
            id: signedFileId,
            mimeType: "application/pdf",
            objectKey: `subscription-closure/${closureCase.id}/return-manifest-r2-signed.pdf`,
            originalName: `${closureCase.caseNo}-return-manifest-r2-signed.pdf`,
            sizeBytes: 128n,
            uploadedBy: fixture.actorId
          }
        });
        await tx.contractESignTask.create({
          data: {
            completedAt: occurredAt,
            contractId: fixture.contractId,
            createdBy: fixture.actorId,
            customerId: fixture.customerId,
            documentObjectKey: sourceFile.objectKey,
            documentType: "DELIVERY_HANDOVER",
            id: revisionTaskId,
            orderId: fixture.orderId,
            provider: "OTHER",
            requestSnapshot: { documentSnapshotHash: documentHash },
            responseSnapshot: { signedFileHash, signedFileId },
            signingStage: "STAGE2_DELIVERY_HANDOVER",
            signedDocumentObjectKey: `subscription-closure/${closureCase.id}/return-manifest-r2-signed.pdf`,
            sourceId: revisionSource.id,
            sourceKey: revisionSource.key,
            sourceType: revisionSource.type,
            taskNo: `ESG-TASK4-${revisionTaskId}`,
            taskStatus: "COMPLETED",
            updatedBy: fixture.actorId
          }
        });
        await tx.subscriptionClosureDocumentRevision.create({
          data: {
            archivedAt: occurredAt,
            archivedBy: fixture.actorId,
            closureCaseId: closureCase.id,
            contractESignTaskId: revisionTaskId,
            documentSnapshot,
            documentSnapshotHash: documentHash,
            documentType: "RETURN_MANIFEST",
            generatedAt: occurredAt,
            generatedBy: fixture.actorId,
            handoverWorkOrderId: closureCase.returnHandoverWorkOrderId,
            id: revisionId,
            revisionNumber: 2,
            signedAt: occurredAt,
            signedBy: fixture.actorId,
            signedFileHash,
            signedFileId,
            sourceFileHash: documentHash,
            sourceFileId: revisionOne.sourceFileId,
            sourceId: revisionSource.id,
            sourceKey: revisionSource.key,
            sourceType: revisionSource.type,
            stage: "ARCHIVED",
            supersedesRevisionId: revisionOne.id,
            vehicleReturnId: closureCase.vehicleReturnId
          }
        });
        await tx.subscriptionClosureCurrentDocument.update({
          data: { documentRevisionId: revisionId, updatedBy: fixture.actorId },
          where: {
            closureCaseId_documentType: {
              closureCaseId: closureCase.id,
              documentType: "RETURN_MANIFEST"
            }
          }
        });
      });
      const audit = new AuditService(prisma);
      const accounting = new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
      const operations = new AssetOperationsService(
        prisma,
        new AssetOperationsRepository(),
        audit,
        accounting
      );
      const facts = new AssetFactsService(prisma, new AssetFactsRepository(), audit);
      const closure = new SubscriptionClosureService(
        new SubscriptionClosureRepository(),
        new HandoverWorkOrderService(prisma, {} as never),
        operations,
        audit,
        prisma,
        facts,
        accounting,
        new VehicleMileageService(prisma, new VehicleMileageRepository())
      );
      const receipt = {
        actorId: fixture.actorId,
        checklist,
        damages: [
          {
            damageLevel: "MEDIUM",
            damageType: "EXTERIOR",
            description: "Rear door scratch",
            estimatedRepairAmount: 3600n,
            photoUrls: ["https://evidence.invalid/rear-door-1.jpg", "rear-door-2.jpg"],
            responsibleParty: "CUSTOMER"
          }
        ],
        orderId: fixture.orderId,
        physicalControlMode: "VOLUNTARY_RETURN" as const,
        remark: "received",
        returnMileageKm: 1200,
        returnType: "NORMAL_RETURN" as const,
        returnedAt: occurredAt
      };

      let failingAuditEntity: string | null = null;
      const failpointAudit = {
        write: vi.fn(async (input: { entityType: string }, client: Prisma.TransactionClient) => {
          if (input.entityType === failingAuditEntity) {
            throw new Error(`task-4-audit-failpoint:${failingAuditEntity}`);
          }
          return audit.write(input as never, client);
        })
      } as unknown as AuditService;
      const failpointAccounting = new AssetAccountingService(
        prisma,
        new AssetAccountingRepository(),
        failpointAudit
      );
      const failpointClosure = new SubscriptionClosureService(
        new SubscriptionClosureRepository(),
        new HandoverWorkOrderService(prisma, {} as never),
        new AssetOperationsService(
          prisma,
          new AssetOperationsRepository(),
          failpointAudit,
          failpointAccounting
        ),
        failpointAudit,
        prisma,
        new AssetFactsService(prisma, new AssetFactsRepository(), failpointAudit),
        failpointAccounting,
        new VehicleMileageService(prisma, new VehicleMileageRepository())
      );
      const baselineAuditCount = await prisma.auditLog.count({
        where: { operatorId: fixture.actorId }
      });
      for (failingAuditEntity of [
        "vehicle_subscription_period",
        "vehicle_return",
        "vehicle_return_damage",
        "vehicle_mileage_reading",
        "subscription_order",
        "lease",
        "vehicle",
        "asset_work_order",
        "vehicle_operational_restriction",
        "subscription_closure_event"
      ]) {
        const failpointTruth = await snapshotPhysicalReturnTruth(prisma, fixture);
        expect(failpointTruth).toHaveLength(15);
        await expect(failpointClosure.confirmManagedPhysicalReceipt(receipt, {})).rejects.toThrow(
          `task-4-audit-failpoint:${failingAuditEntity}`
        );
        await expect(snapshotPhysicalReturnTruth(prisma, fixture)).resolves.toEqual(failpointTruth);
        const [
          period,
          vehicleReturn,
          order,
          lease,
          vehicle,
          workOrder,
          restrictions,
          mileage,
          damages,
          currentCase,
          auditCount
        ] = await Promise.all([
          prisma.vehicleSubscriptionPeriod.findFirstOrThrow({
            where: { orderId: fixture.orderId }
          }),
          prisma.vehicleReturn.findUniqueOrThrow({ where: { orderId: fixture.orderId } }),
          prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } }),
          prisma.lease.findUniqueOrThrow({ where: { orderId: fixture.orderId } }),
          prisma.vehicle.findUniqueOrThrow({ where: { id: fixture.vehicleId } }),
          prisma.assetWorkOrder.findUniqueOrThrow({
            where: { id: closureCase.returnAssetWorkOrderId! }
          }),
          prisma.vehicleOperationalRestriction.count({ where: { vehicleId: fixture.vehicleId } }),
          prisma.vehicleMileageReading.count({ where: { orderId: fixture.orderId } }),
          prisma.vehicleReturnDamage.count({ where: { orderId: fixture.orderId } }),
          prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCase.id } }),
          prisma.auditLog.count({ where: { operatorId: fixture.actorId } })
        ]);
        expect({
          auditCount,
          caseStatus: currentCase.status,
          leaseStatus: lease.status,
          mileage,
          damages,
          orderStatus: order.orderStatus,
          periodEndedAt: period.endedAt,
          restrictions,
          returnStatus: vehicleReturn.returnStatus,
          vehicleStatus: vehicle.status,
          workOrderStatus: workOrder.status
        }).toEqual({
          auditCount: baselineAuditCount,
          caseStatus: "PREPARING_RETURN",
          leaseStatus: "RETURN_DUE",
          mileage: 0,
          damages: 0,
          orderStatus: "PENDING_RETURN",
          periodEndedAt: null,
          restrictions: 0,
          returnStatus: "READY",
          vehicleStatus: "LEASED",
          workOrderStatus: "PENDING"
        });
      }
      failingAuditEntity = null;

      for (const invalidStatus of [
        OrderStatus.ACTIVE,
        OrderStatus.COMPLETED,
        OrderStatus.TERMINATED,
        OrderStatus.CANCELLED
      ]) {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
          await tx.subscriptionOrder.update({
            data: { orderStatus: invalidStatus },
            where: { id: fixture.orderId }
          });
        });
        const invalidStatusTruth = await snapshotPhysicalReturnTruth(prisma, fixture);
        await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
          status: 409
        });
        await expect(snapshotPhysicalReturnTruth(prisma, fixture)).resolves.toEqual(
          invalidStatusTruth
        );
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
          await tx.subscriptionOrder.update({
            data: { orderStatus: OrderStatus.PENDING_RETURN },
            where: { id: fixture.orderId }
          });
        });
      }

      const holderBarrier = createBarrier();
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "subscription_order" WHERE "id" = ${fixture.orderId}::uuid FOR UPDATE`
        );
        holderBarrier.enter();
        await holderBarrier.released;
        return tx.$queryRaw<Array<{ usable: number }>>(Prisma.sql`SELECT 1 AS "usable"`);
      });
      await holderBarrier.entered;
      await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
        status: 409
      });
      holderBarrier.release();
      await expect(holder).resolves.toEqual([{ usable: 1 }]);

      const [baselineAssetWorkOrderEvents, baselineClosureEvents, baselineAudits] =
        await Promise.all([
          prisma.assetWorkOrderEvent.findMany({
            select: { id: true },
            where: { workOrder: { orderId: fixture.orderId } }
          }),
          prisma.subscriptionClosureEvent.findMany({
            select: { id: true },
            where: { closureCaseId: closureCase.id }
          }),
          prisma.auditLog.findMany({
            select: { id: true },
            where: { operatorId: fixture.actorId }
          })
        ]);

      const concurrentReceipts = await Promise.allSettled([
        closure.confirmManagedPhysicalReceipt(receipt, {}),
        closure.confirmManagedPhysicalReceipt(receipt, {})
      ]);
      expect(concurrentReceipts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(concurrentReceipts.filter(({ status }) => status === "rejected")).toHaveLength(1);
      expect(concurrentReceipts.find(({ status }) => status === "rejected")).toMatchObject({
        reason: {
          response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
          status: 409
        },
        status: "rejected"
      });
      const damageIds = (
        await prisma.vehicleReturnDamage.findMany({
          orderBy: { id: "asc" },
          select: { id: true },
          where: { returnId: closureCase.vehicleReturnId! }
        })
      ).map(({ id }) => id);
      const winnerTruthScope = {
        damageIds,
        excludedAssetWorkOrderEventIds: baselineAssetWorkOrderEvents.map(({ id }) => id),
        excludedAuditIds: baselineAudits.map(({ id }) => id),
        excludedClosureEventIds: baselineClosureEvents.map(({ id }) => id)
      };
      const winnerTruth = await snapshotPhysicalReturnTruth(prisma, fixture, winnerTruthScope);
      expect(winnerTruth).toHaveLength(15);
      expect({
        id: winnerTruth[0]?.id,
        orderId: winnerTruth[0]?.orderId,
        physicalControlMode: winnerTruth[0]?.physicalControlMode,
        physicalControlledAt: winnerTruth[0]?.physicalControlledAt,
        returnAssetWorkOrderId: winnerTruth[0]?.returnAssetWorkOrderId,
        status: winnerTruth[0]?.status,
        vehicleReturnId: winnerTruth[0]?.vehicleReturnId,
        vehicleId: winnerTruth[0]?.vehicleId,
        version: winnerTruth[0]?.version
      }).toEqual({
        id: closureCase.id,
        orderId: fixture.orderId,
        physicalControlMode: "VOLUNTARY_RETURN",
        physicalControlledAt: occurredAt,
        returnAssetWorkOrderId: closureCase.returnAssetWorkOrderId,
        status: "RETURN_INSPECTION",
        vehicleReturnId: closureCase.vehicleReturnId,
        vehicleId: fixture.vehicleId,
        version: 2
      });
      expect({
        actualReturnAt: winnerTruth[1]?.actualReturnAt,
        id: winnerTruth[1]?.id,
        orderStatus: winnerTruth[1]?.orderStatus,
        updatedBy: winnerTruth[1]?.updatedBy,
        vehicleId: winnerTruth[1]?.vehicleId
      }).toEqual({
        actualReturnAt: occurredAt,
        id: fixture.orderId,
        orderStatus: "RETURNED_PENDING_SETTLEMENT",
        updatedBy: fixture.actorId,
        vehicleId: fixture.vehicleId
      });
      expect({
        deletedAt: winnerTruth[2]?.deletedAt,
        id: winnerTruth[2]?.id,
        orderId: winnerTruth[2]?.orderId,
        status: winnerTruth[2]?.status,
        updatedBy: winnerTruth[2]?.updatedBy
      }).toEqual({
        deletedAt: null,
        id: winnerTruth[2]?.id,
        orderId: fixture.orderId,
        status: "COMPLETED",
        updatedBy: fixture.actorId
      });
      expect({
        currentMileageKm: winnerTruth[3]?.currentMileageKm,
        id: winnerTruth[3]?.id,
        salePriceReinitRequiredAt: winnerTruth[3]?.salePriceReinitRequiredAt,
        salePriceStatus: winnerTruth[3]?.salePriceStatus,
        status: winnerTruth[3]?.status,
        updatedBy: winnerTruth[3]?.updatedBy
      }).toEqual({
        currentMileageKm: receipt.returnMileageKm,
        id: fixture.vehicleId,
        salePriceReinitRequiredAt: expect.any(Date),
        salePriceStatus: "PENDING_INITIALIZE",
        status: "MAINTENANCE",
        updatedBy: fixture.actorId
      });
      expect({
        checklistSnapshot: winnerTruth[4]?.checklistSnapshot,
        damageFound: winnerTruth[4]?.damageFound,
        deletedAt: winnerTruth[4]?.deletedAt,
        id: winnerTruth[4]?.id,
        orderId: winnerTruth[4]?.orderId,
        remark: winnerTruth[4]?.remark,
        returnMileageKm: winnerTruth[4]?.returnMileageKm,
        returnStatus: winnerTruth[4]?.returnStatus,
        returnType: winnerTruth[4]?.returnType,
        returnedAt: winnerTruth[4]?.returnedAt,
        updatedBy: winnerTruth[4]?.updatedBy,
        vehicleId: winnerTruth[4]?.vehicleId
      }).toEqual({
        checklistSnapshot: checklist,
        damageFound: true,
        deletedAt: null,
        id: closureCase.vehicleReturnId,
        orderId: fixture.orderId,
        remark: receipt.remark,
        returnMileageKm: receipt.returnMileageKm,
        returnStatus: "CONFIRMED",
        returnType: receipt.returnType,
        returnedAt: occurredAt,
        updatedBy: fixture.actorId,
        vehicleId: fixture.vehicleId
      });
      expect(
        winnerTruth[5].map(
          ({
            createdBy,
            damageLevel,
            damageType,
            deletedAt,
            description,
            estimatedRepairAmount,
            id,
            orderId,
            photoUrls,
            responsibleParty,
            returnId,
            status,
            updatedBy,
            vehicleId
          }) => ({
            createdBy,
            damageLevel,
            damageType,
            deletedAt,
            description,
            estimatedRepairAmount,
            id,
            orderId,
            photoUrls,
            responsibleParty,
            returnId,
            status,
            updatedBy,
            vehicleId
          })
        )
      ).toEqual([
        {
          createdBy: fixture.actorId,
          damageLevel: "MEDIUM",
          damageType: "EXTERIOR",
          deletedAt: null,
          description: "Rear door scratch",
          estimatedRepairAmount: 3600n,
          id: damageIds[0],
          orderId: fixture.orderId,
          photoUrls: ["https://evidence.invalid/rear-door-1.jpg", "rear-door-2.jpg"],
          responsibleParty: "CUSTOMER",
          returnId: closureCase.vehicleReturnId,
          status: "RECORDED",
          updatedBy: fixture.actorId,
          vehicleId: fixture.vehicleId
        }
      ]);
      expect(
        winnerTruth[6].map(
          ({
            endConfirmedAt,
            endConfirmedBy,
            endReason,
            endSourceId,
            endSourceKey,
            endSourceType,
            endedAt,
            id,
            orderId,
            vehicleId
          }) => ({
            endConfirmedAt,
            endConfirmedBy,
            endReason,
            endSourceId,
            endSourceKey,
            endSourceType,
            endedAt,
            id,
            orderId,
            vehicleId
          })
        )
      ).toEqual([
        {
          endConfirmedAt: occurredAt,
          endConfirmedBy: fixture.actorId,
          endReason: "RETURN_CONFIRMED",
          endSourceId: closureCase.id,
          endSourceKey: "physical-period-close:VOLUNTARY_RETURN",
          endSourceType: "SUBSCRIPTION_CLOSURE",
          endedAt: occurredAt,
          id: winnerTruth[6][0]?.id,
          orderId: fixture.orderId,
          vehicleId: fixture.vehicleId
        }
      ]);
      expect(
        winnerTruth[7].map(
          ({
            confirmedAt,
            confirmedBy,
            createdBy,
            evidenceSnapshot,
            id,
            mileageKm,
            orderId,
            recordedAt,
            sourceRecordId,
            sourceType,
            status,
            updatedBy,
            vehicleId
          }) => ({
            confirmedAt,
            confirmedBy,
            createdBy,
            evidenceSnapshot,
            id,
            mileageKm,
            orderId,
            recordedAt,
            sourceRecordId,
            sourceType,
            status,
            updatedBy,
            vehicleId
          })
        )
      ).toEqual([
        {
          confirmedAt: expect.any(Date),
          confirmedBy: fixture.actorId,
          createdBy: fixture.actorId,
          evidenceSnapshot: {
            closureCaseId: closureCase.id,
            physicalControlMode: "VOLUNTARY_RETURN"
          },
          id: winnerTruth[7][0]?.id,
          mileageKm: receipt.returnMileageKm,
          orderId: fixture.orderId,
          recordedAt: occurredAt,
          sourceRecordId: closureCase.vehicleReturnId,
          sourceType: "RETURN_CONFIRMATION",
          status: "ACTIVE",
          updatedBy: fixture.actorId,
          vehicleId: fixture.vehicleId
        }
      ]);
      expect(
        winnerTruth[8].map(
          ({ id, orderId, startedAt, status, updatedBy, vehicleId, version, workOrderType }) => ({
            id,
            orderId,
            startedAt,
            status,
            updatedBy,
            vehicleId,
            version,
            workOrderType
          })
        )
      ).toEqual([
        {
          id: closureCase.returnAssetWorkOrderId,
          orderId: fixture.orderId,
          startedAt: occurredAt,
          status: "IN_PROGRESS",
          updatedBy: fixture.actorId,
          vehicleId: fixture.vehicleId,
          version: 1,
          workOrderType: "RETURN_INBOUND"
        }
      ]);
      expect(
        winnerTruth[9].map(
          ({
            afterStatus,
            beforeStatus,
            detailSnapshot,
            eventType,
            sequence,
            sourceId,
            sourceKey,
            sourceType,
            workOrderId
          }) => ({
            afterStatus,
            beforeStatus,
            eventType,
            sequence,
            sourceId,
            sourceKey,
            sourceType,
            version:
              typeof detailSnapshot === "object" && !Array.isArray(detailSnapshot)
                ? (detailSnapshot as Record<string, { version?: number }>).__assetOperationCommandV1
                    ?.version
                : undefined,
            workOrderId
          })
        )
      ).toEqual([
        {
          afterStatus: "IN_PROGRESS",
          beforeStatus: "PENDING",
          eventType: "STARTED",
          sequence: 2,
          sourceId: closureCase.id,
          sourceKey: "physical-work-order:VOLUNTARY_RETURN",
          sourceType: "SUBSCRIPTION_CLOSURE",
          version: 1,
          workOrderId: closureCase.returnAssetWorkOrderId
        },
        {
          afterStatus: null,
          beforeStatus: null,
          eventType: "RESTRICTION_CREATED",
          sequence: 3,
          sourceId: closureCase.id,
          sourceKey: "return-inspection-restriction",
          sourceType: "SUBSCRIPTION_CLOSURE",
          version: 1,
          workOrderId: closureCase.returnAssetWorkOrderId
        }
      ]);
      expect(winnerTruth[10]).toEqual([]);
      expect(
        winnerTruth[11].map(
          ({
            id,
            restrictionType,
            severity,
            startSourceId,
            startSourceKey,
            startSourceType,
            startedAt,
            status,
            vehicleId,
            workOrderId
          }) => ({
            id,
            restrictionType,
            severity,
            startSourceId,
            startSourceKey,
            startSourceType,
            startedAt,
            status,
            vehicleId,
            workOrderId
          })
        )
      ).toEqual([
        {
          id: winnerTruth[11][0]?.id,
          restrictionType: "RETURN_INSPECTION_PENDING",
          severity: "BLOCKING",
          startSourceId: closureCase.id,
          startSourceKey: "return-inspection-restriction",
          startSourceType: "SUBSCRIPTION_CLOSURE",
          startedAt: occurredAt,
          status: "ACTIVE",
          vehicleId: fixture.vehicleId,
          workOrderId: closureCase.returnAssetWorkOrderId
        }
      ]);
      const expectedReceiptPayload = {
        checklistSnapshot: checklist,
        checklistSnapshotHash: createHash("sha256")
          .update(canonicalSubscriptionClosureJson(checklist))
          .digest("hex"),
        damages: [
          {
            damageLevel: "MEDIUM",
            damageType: "EXTERIOR",
            description: "Rear door scratch",
            estimatedRepairAmount: "3600",
            photoUrls: ["https://evidence.invalid/rear-door-1.jpg", "rear-door-2.jpg"],
            responsibleParty: "CUSTOMER"
          }
        ],
        physicalControlMode: "VOLUNTARY_RETURN",
        remark: "received",
        returnMileageKm: 1200,
        returnedAt: occurredAt.toISOString(),
        returnType: "NORMAL_RETURN"
      };
      const expectedReceiptDetail = {
        physicalControlMode: "VOLUNTARY_RETURN",
        receiptPayload: expectedReceiptPayload,
        receiptPayloadHash: createHash("sha256")
          .update(canonicalSubscriptionClosureJson(expectedReceiptPayload))
          .digest("hex"),
        vehicleReturnId: closureCase.vehicleReturnId
      };
      const expectedReceiptCommandPayload = {
        actorId: fixture.actorId,
        afterStatus: "RETURN_INSPECTION",
        closureCaseId: closureCase.id,
        detailSnapshot: expectedReceiptDetail,
        eventType: "PHYSICAL_CONTROL_CONFIRMED",
        expectedStatus: "PREPARING_RETURN",
        expectedVersion: 1,
        occurredAt: occurredAt.toISOString(),
        reconditioningAssetWorkOrderId: null,
        recoveryAssetWorkOrderId: null,
        source: {
          id: closureCase.id,
          key: "physical-receipt:VOLUNTARY_RETURN",
          type: "SUBSCRIPTION_CLOSURE"
        }
      };
      expect(
        winnerTruth[12].map(
          ({
            afterStatus,
            actorId,
            beforeStatus,
            closureCaseId,
            commandReceipt,
            detailSnapshot,
            eventType,
            id,
            occurredAt: eventOccurredAt,
            sequence,
            sourceId,
            sourceKey,
            sourceType
          }) => ({
            afterStatus,
            actorId,
            beforeStatus,
            closureCaseId,
            commandReceipt: commandReceipt
              ? {
                  actorId: commandReceipt.actorId,
                  closureCaseId: commandReceipt.closureCaseId,
                  commandType: commandReceipt.commandType,
                  eventId: commandReceipt.eventId,
                  outcomeCaseStatus:
                    typeof commandReceipt.outcomeSnapshot === "object" &&
                    !Array.isArray(commandReceipt.outcomeSnapshot)
                      ? (
                          commandReceipt.outcomeSnapshot as {
                            case?: { status?: string };
                          }
                        ).case?.status
                      : undefined,
                  payloadHash: commandReceipt.payloadHash,
                  payloadSnapshot: commandReceipt.payloadSnapshot,
                  sourceId: commandReceipt.sourceId,
                  sourceKey: commandReceipt.sourceKey,
                  sourceType: commandReceipt.sourceType
                }
              : null,
            detailSnapshot,
            eventType,
            id,
            occurredAt: eventOccurredAt,
            sequence,
            sourceId,
            sourceKey,
            sourceType
          })
        )
      ).toEqual([
        {
          afterStatus: "RETURN_INSPECTION",
          actorId: fixture.actorId,
          beforeStatus: "PREPARING_RETURN",
          closureCaseId: closureCase.id,
          commandReceipt: {
            actorId: fixture.actorId,
            closureCaseId: closureCase.id,
            commandType: "TRANSITION_CASE",
            eventId: winnerTruth[12][0]?.id,
            outcomeCaseStatus: "RETURN_INSPECTION",
            payloadHash: createHash("sha256")
              .update(canonicalSubscriptionClosureJson(expectedReceiptCommandPayload))
              .digest("hex"),
            payloadSnapshot: expectedReceiptCommandPayload,
            sourceId: closureCase.id,
            sourceKey: "physical-receipt:VOLUNTARY_RETURN",
            sourceType: "SUBSCRIPTION_CLOSURE"
          },
          detailSnapshot: expectedReceiptDetail,
          eventType: "PHYSICAL_CONTROL_CONFIRMED",
          id: winnerTruth[12][0]?.id,
          occurredAt,
          sequence: 3,
          sourceId: closureCase.id,
          sourceKey: "physical-receipt:VOLUNTARY_RETURN",
          sourceType: "SUBSCRIPTION_CLOSURE"
        }
      ]);
      const winnerCommandReceipts = winnerTruth[12].flatMap(({ commandReceipt }) =>
        commandReceipt ? [commandReceipt] : []
      );
      expect(winnerCommandReceipts).toHaveLength(1);
      const expectedReceiptAudits = [
        ["asset_facts", "vehicle_subscription_period", winnerTruth[6][0]?.id, "UPDATE"],
        ["subscription_closure", "vehicle_return_damage", winnerTruth[5][0]?.id, "CREATE"],
        ["subscription_closure", "vehicle_mileage_reading", winnerTruth[7][0]?.id, "CREATE"],
        ["subscription_closure", "vehicle_return", closureCase.vehicleReturnId, "UPDATE"],
        ["subscription_closure", "subscription_order", fixture.orderId, "UPDATE"],
        ["subscription_closure", "lease", winnerTruth[2]?.id, "UPDATE"],
        ["subscription_closure", "vehicle", fixture.vehicleId, "UPDATE"],
        ["asset_operations", "asset_work_order", closureCase.returnAssetWorkOrderId, "UPDATE"],
        ["asset_operations", "asset_work_order_event", winnerTruth[9][0]?.id, "CREATE"],
        ["asset_operations", "vehicle_operational_restriction", winnerTruth[11][0]?.id, "CREATE"],
        ["asset_operations", "asset_work_order_event", winnerTruth[9][1]?.id, "CREATE"],
        ["subscription_closure", "subscription_closure_event", winnerTruth[12][0]?.id, "CREATE"]
      ].map(([module, entityType, entityId, action]) => ({ action, entityId, entityType, module }));
      const sortAuditSemantics = (
        left: Readonly<{
          action: unknown;
          entityId: unknown;
          entityType: unknown;
          module: unknown;
        }>,
        right: Readonly<{
          action: unknown;
          entityId: unknown;
          entityType: unknown;
          module: unknown;
        }>
      ) => {
        const leftKey = canonicalSubscriptionClosureJson(left as never);
        const rightKey = canonicalSubscriptionClosureJson(right as never);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      };
      expect(
        winnerTruth[13]
          .map(({ action, entityId, entityType, module }) => ({
            action,
            entityId,
            entityType,
            module
          }))
          .sort(sortAuditSemantics)
      ).toEqual(expectedReceiptAudits.sort(sortAuditSemantics));
      expect(winnerTruth[14]).toEqual([]);
      const baseline = await Promise.all([
        prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCase.id } }),
        prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } }),
        prisma.lease.findUniqueOrThrow({ where: { orderId: fixture.orderId } }),
        prisma.vehicle.findUniqueOrThrow({ where: { id: fixture.vehicleId } }),
        prisma.vehicleOperationalRestriction.findMany({ where: { vehicleId: fixture.vehicleId } }),
        prisma.subscriptionClosureEvent.findMany({ where: { closureCaseId: closureCase.id } })
      ]);
      expect(baseline[0]).toMatchObject({ status: "RETURN_INSPECTION" });
      expect(baseline[1]).toMatchObject({
        actualReturnAt: occurredAt,
        orderStatus: "RETURNED_PENDING_SETTLEMENT"
      });
      expect(baseline[2]).toMatchObject({ status: "COMPLETED" });
      expect(baseline[3]).toMatchObject({
        currentMileageKm: 1200,
        salePriceReinitRequiredAt: expect.any(Date),
        status: "MAINTENANCE"
      });
      expect(baseline[4]).toEqual([
        expect.objectContaining({
          restrictionType: "RETURN_INSPECTION_PENDING",
          severity: "BLOCKING",
          status: "ACTIVE"
        })
      ]);
      await expect(
        prisma.vehicleReturnDamage.findMany({
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          where: { orderId: fixture.orderId }
        })
      ).resolves.toEqual([
        expect.objectContaining({
          damageLevel: "MEDIUM",
          damageType: "EXTERIOR",
          description: "Rear door scratch",
          estimatedRepairAmount: 3600n,
          photoUrls: ["https://evidence.invalid/rear-door-1.jpg", "rear-door-2.jpg"],
          responsibleParty: "CUSTOMER",
          status: "RECORDED"
        })
      ]);
      await expect(
        prisma.auditLog.findMany({
          select: { entityType: true },
          where: {
            entityType: { in: ["vehicle_return_damage", "vehicle_mileage_reading"] },
            operatorId: fixture.actorId
          }
        })
      ).resolves.toEqual(
        expect.arrayContaining([
          { entityType: "vehicle_return_damage" },
          { entityType: "vehicle_mileage_reading" }
        ])
      );

      const exactReplayTruth = winnerTruth;
      await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).resolves.toEqual({
        vehicleReturnId: closureCase.vehicleReturnId
      });
      await expect(snapshotPhysicalReturnTruth(prisma, fixture, winnerTruthScope)).resolves.toEqual(
        exactReplayTruth
      );
      for (const driftedReceipt of [
        { ...receipt, remark: "different remark" },
        { ...receipt, returnMileageKm: receipt.returnMileageKm + 1 },
        { ...receipt, returnedAt: new Date(receipt.returnedAt.getTime() + 1) },
        { ...receipt, returnType: "EARLY_TERMINATION" as const },
        { ...receipt, checklist: { ...receipt.checklist, damageFound: false } },
        {
          ...receipt,
          damages: [{ ...receipt.damages[0]!, description: "different description" }]
        },
        {
          ...receipt,
          damages: [{ ...receipt.damages[0]!, estimatedRepairAmount: 3601n }]
        },
        {
          ...receipt,
          damages: [{ ...receipt.damages[0]!, photoUrls: ["different-photo.jpg"] }]
        },
        {
          ...receipt,
          damages: [{ ...receipt.damages[0]!, responsibleParty: "COMPANY" }]
        },
        {
          ...receipt,
          damages: [{ ...receipt.damages[0]!, damageLevel: "SEVERE" }]
        },
        {
          ...receipt,
          damages: [{ ...receipt.damages[0]!, damageType: "INTERIOR" }]
        }
      ]) {
        await expect(
          closure.confirmManagedPhysicalReceipt(driftedReceipt, {})
        ).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
          status: 409
        });
        await expect(
          snapshotPhysicalReturnTruth(prisma, fixture, winnerTruthScope)
        ).resolves.toEqual(exactReplayTruth);
      }
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.vehicleReturn.update({
          data: { remark: "persisted fact drift" },
          where: { id: closureCase.vehicleReturnId! }
        });
      });
      const persistedDriftTruth = await snapshotPhysicalReturnTruth(
        prisma,
        fixture,
        winnerTruthScope
      );
      await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
        status: 409
      });
      await expect(snapshotPhysicalReturnTruth(prisma, fixture, winnerTruthScope)).resolves.toEqual(
        persistedDriftTruth
      );
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.vehicleReturn.update({
          data: { remark: receipt.remark },
          where: { id: closureCase.vehicleReturnId! }
        });
      });

      const damage = await prisma.vehicleReturnDamage.findFirstOrThrow({
        where: { returnId: closureCase.vehicleReturnId! }
      });
      const mileageReading = await prisma.vehicleMileageReading.findUniqueOrThrow({
        where: {
          sourceType_sourceRecordId: {
            sourceRecordId: closureCase.vehicleReturnId!,
            sourceType: "RETURN_CONFIRMATION"
          }
        }
      });
      const assertPersistedReplayDrift = async (
        mutate: (tx: Prisma.TransactionClient) => Promise<unknown>,
        restore: (tx: Prisma.TransactionClient) => Promise<unknown>
      ) => {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
          await mutate(tx);
        });
        const driftTruth = await snapshotPhysicalReturnTruth(prisma, fixture, winnerTruthScope);
        await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
          status: 409
        });
        await expect(
          snapshotPhysicalReturnTruth(prisma, fixture, winnerTruthScope)
        ).resolves.toEqual(driftTruth);
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
          await restore(tx);
        });
        await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).resolves.toEqual({
          vehicleReturnId: closureCase.vehicleReturnId
        });
      };
      for (const [mutate, restore] of [
        [
          (tx: Prisma.TransactionClient) =>
            tx.vehicleReturnDamage.update({
              data: { status: "CONFIRMED" },
              where: { id: damage.id }
            }),
          (tx: Prisma.TransactionClient) =>
            tx.vehicleReturnDamage.update({
              data: { status: "RECORDED" },
              where: { id: damage.id }
            })
        ],
        [
          (tx: Prisma.TransactionClient) =>
            tx.vehicleReturnDamage.update({
              data: { deletedAt: new Date(receipt.returnedAt.getTime() + 1) },
              where: { id: damage.id }
            }),
          (tx: Prisma.TransactionClient) =>
            tx.vehicleReturnDamage.update({ data: { deletedAt: null }, where: { id: damage.id } })
        ],
        [
          (tx: Prisma.TransactionClient) =>
            tx.vehicleReturnDamage.update({
              data: { returnId: randomUUID() },
              where: { id: damage.id }
            }),
          (tx: Prisma.TransactionClient) =>
            tx.vehicleReturnDamage.update({
              data: { returnId: closureCase.vehicleReturnId! },
              where: { id: damage.id }
            })
        ],
        [
          (tx: Prisma.TransactionClient) =>
            tx.vehicleReturnDamage.update({
              data: { orderId: randomUUID() },
              where: { id: damage.id }
            }),
          (tx: Prisma.TransactionClient) =>
            tx.vehicleReturnDamage.update({
              data: { orderId: fixture.orderId },
              where: { id: damage.id }
            })
        ],
        [
          (tx: Prisma.TransactionClient) =>
            tx.vehicleReturnDamage.update({
              data: { vehicleId: randomUUID() },
              where: { id: damage.id }
            }),
          (tx: Prisma.TransactionClient) =>
            tx.vehicleReturnDamage.update({
              data: { vehicleId: fixture.vehicleId },
              where: { id: damage.id }
            })
        ],
        [
          (tx: Prisma.TransactionClient) =>
            tx.vehicleMileageReading.update({
              data: {
                status: "VOIDED",
                voidReason: "task-4 replay drift",
                voidedAt: new Date(receipt.returnedAt.getTime() + 1),
                voidedBy: fixture.actorId
              },
              where: { id: mileageReading.id }
            }),
          (tx: Prisma.TransactionClient) =>
            tx.vehicleMileageReading.update({
              data: {
                status: "ACTIVE",
                voidReason: null,
                voidedAt: null,
                voidedBy: null
              },
              where: { id: mileageReading.id }
            })
        ],
        [
          (tx: Prisma.TransactionClient) =>
            tx.vehicleMileageReading.update({
              data: { confirmedBy: randomUUID() },
              where: { id: mileageReading.id }
            }),
          (tx: Prisma.TransactionClient) =>
            tx.vehicleMileageReading.update({
              data: { confirmedBy: fixture.actorId },
              where: { id: mileageReading.id }
            })
        ],
        [
          (tx: Prisma.TransactionClient) =>
            tx.vehicleMileageReading.update({
              data: { evidenceSnapshot: { closureCaseId: randomUUID() } },
              where: { id: mileageReading.id }
            }),
          (tx: Prisma.TransactionClient) =>
            tx.vehicleMileageReading.update({
              data: {
                evidenceSnapshot: {
                  closureCaseId: closureCase.id,
                  physicalControlMode: "VOLUNTARY_RETURN"
                }
              },
              where: { id: mileageReading.id }
            })
        ]
      ] as const) {
        await assertPersistedReplayDrift(mutate, restore);
      }

      const submittedAt = occurredAt;
      await operations.transitionWorkOrder(
        {
          closeReason: null,
          detailSnapshot: { inspection: "submitted" },
          expectedVersion: 1,
          occurredAt: submittedAt,
          solution: null,
          source: {
            id: closureCase.id,
            key: "task-4-inspection-submit",
            type: "TASK4_TEST"
          },
          targetStatus: "PENDING_ACCEPTANCE",
          workOrderId: closureCase.returnAssetWorkOrderId!
        },
        { actorId: fixture.actorId, permissions: [] }
      );
      const acceptedAt = occurredAt;
      await operations.transitionWorkOrder(
        {
          closeReason: "inspection accepted",
          detailSnapshot: { inspection: "accepted" },
          expectedVersion: 2,
          occurredAt: acceptedAt,
          solution: "accepted",
          source: {
            id: closureCase.id,
            key: "task-4-inspection-accept",
            type: "TASK4_TEST"
          },
          targetStatus: "CLOSED",
          workOrderId: closureCase.returnAssetWorkOrderId!
        },
        { actorId: fixture.actorId, permissions: [] }
      );
      const inspectionAt = occurredAt;
      const inspectionCommand = {
        accepted: true,
        actorId: fixture.actorId,
        closureCaseId: closureCase.id,
        costs: [
          {
            actionType: "ACTUAL_COST" as const,
            accountingPeriod: "2026-08",
            amountCents: 2500n,
            assetOwnerId: null,
            assetOwnerSnapshot: null,
            confirmedAt: inspectionAt,
            costCategory: "CLEANING" as const,
            evidenceId: null,
            evidenceSnapshot: null,
            occurredOn: new Date("2026-08-21T00:00:00.000Z"),
            reason: "return cleaning",
            responsiblePartyId: fixture.customerId,
            responsiblePartyType: "CUSTOMER" as const,
            responsibilitySnapshot: { basis: "inspection" }
          }
        ],
        evidence: [
          {
            action: "ATTACH" as const,
            capturedAt: inspectionAt,
            captureMetadata: { station: "return-inspection" },
            contentSha256: signedFileHash,
            eventId: null,
            evidenceType: "INSPECTION_REPORT" as const,
            fileId: signedFileId,
            occurredAt: inspectionAt,
            supersedesEvidenceId: null
          }
        ],
        occurredAt: inspectionAt,
        reconditioningRequired: true
      };
      await expect(
        closure.recordManagedReturnInspection(
          {
            ...inspectionCommand,
            costs: [],
            evidence: [],
            reconditioningRequired: false
          },
          {}
        )
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      for (const actionType of [
        "RESPONSIBILITY_CONFIRMED",
        "RECOVERY_EXPOSURE",
        "RECOVERY_RECEIVED",
        "WAIVER",
        "WRITE_OFF"
      ] as const) {
        await expect(
          closure.recordManagedReturnInspection(
            {
              ...inspectionCommand,
              costs: [{ ...inspectionCommand.costs[0]!, actionType }]
            },
            {}
          )
        ).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
          status: 409
        });
      }
      await expect(
        Promise.all([
          prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCase.id } }),
          prisma.assetWorkOrderEvidence.count({
            where: { workOrderId: closureCase.returnAssetWorkOrderId! }
          }),
          prisma.vehicleCostLedgerEntry.count({ where: { orderId: fixture.orderId } })
        ])
      ).resolves.toEqual([expect.objectContaining({ status: "RETURN_INSPECTION" }), 0, 0]);
      for (failingAuditEntity of [
        "asset_work_order_evidence",
        "vehicle_cost_ledger_entry",
        "asset_work_order",
        "subscription_closure_event"
      ]) {
        const failpointTruth = await snapshotPhysicalReturnTruth(prisma, fixture);
        expect(failpointTruth).toHaveLength(15);
        await expect(
          failpointClosure.recordManagedReturnInspection(inspectionCommand, {})
        ).rejects.toThrow(`task-4-audit-failpoint:${failingAuditEntity}`);
        await expect(snapshotPhysicalReturnTruth(prisma, fixture)).resolves.toEqual(failpointTruth);
        await expect(
          Promise.all([
            prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCase.id } }),
            prisma.assetWorkOrderEvidence.count({
              where: { workOrderId: closureCase.returnAssetWorkOrderId! }
            }),
            prisma.vehicleCostLedgerEntry.count({ where: { orderId: fixture.orderId } }),
            prisma.assetWorkOrder.count({ where: { orderId: fixture.orderId } })
          ])
        ).resolves.toEqual([
          expect.objectContaining({
            reconditioningAssetWorkOrderId: null,
            status: "RETURN_INSPECTION"
          }),
          0,
          0,
          1
        ]);
      }
      failingAuditEntity = null;
      await expect(
        closure.recordManagedReturnInspection(inspectionCommand, {})
      ).resolves.toMatchObject({ case: { status: "RECONDITIONING" } });
      await expect(
        prisma.assetWorkOrderEvidence.count({
          where: { workOrderId: closureCase.returnAssetWorkOrderId! }
        })
      ).resolves.toBe(1);
      const reconditioningCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { id: closureCase.id }
      });
      expect(reconditioningCase.reconditioningAssetWorkOrderId).toEqual(expect.any(String));
      const reconditioningWorkOrderId = reconditioningCase.reconditioningAssetWorkOrderId!;
      for (const [expectedVersion, targetStatus] of [
        [0, "IN_PROGRESS"],
        [1, "PENDING_ACCEPTANCE"],
        [2, "PENDING_COST_CONFIRMATION"],
        [3, "CLOSED"]
      ] as const) {
        await operations.transitionWorkOrder(
          {
            closeReason: targetStatus === "CLOSED" ? "reconditioning accepted" : null,
            detailSnapshot: { targetStatus },
            expectedVersion,
            occurredAt,
            solution: targetStatus === "CLOSED" ? "accepted" : null,
            source: {
              id: closureCase.id,
              key: `task-4-reconditioning-${expectedVersion}`,
              type: "TASK4_TEST"
            },
            targetStatus,
            workOrderId: reconditioningWorkOrderId
          },
          { actorId: fixture.actorId, permissions: [] }
        );
        if (targetStatus === "PENDING_COST_CONFIRMATION") {
          const source = {
            id: closureCase.id,
            key: "task-4-reconditioning-cost",
            type: "TASK4_TEST"
          };
          await accounting.appendCost(
            {
              actionType: "ACTUAL_COST",
              accountingPeriod: "2026-08",
              amountCents: 7500n,
              assetOwnerId: null,
              assetOwnerSnapshot: null,
              confirmedAt: occurredAt,
              contractId: fixture.contractId,
              costCategory: "CLEANING",
              customerId: fixture.customerId,
              evidenceId: null,
              evidenceSnapshot: null,
              occurredOn: new Date("2026-08-21T00:00:00.000Z"),
              orderId: fixture.orderId,
              reason: "reconditioning cost confirmed",
              responsiblePartyId: fixture.customerId,
              responsiblePartyType: "CUSTOMER",
              responsibilitySnapshot: { basis: "accepted reconditioning" },
              source,
              vehicleId: fixture.vehicleId,
              workOrderId: reconditioningWorkOrderId
            },
            {
              actorId: fixture.actorId,
              idempotencyKey: source.key,
              permissions: [ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM]
            }
          );
        }
      }
      await expect(
        closure.recordManagedReturnInspection(
          {
            accepted: true,
            actorId: fixture.actorId,
            closureCaseId: closureCase.id,
            costs: [],
            evidence: [],
            occurredAt,
            reconditioningRequired: false
          },
          {}
        )
      ).resolves.toMatchObject({ case: { status: "PENDING_SETTLEMENT" } });

      const releaseAt = occurredAt;
      const intendedRestriction = await prisma.vehicleOperationalRestriction.findFirstOrThrow({
        where: {
          startSourceId: closureCase.id,
          startSourceKey: "return-inspection-restriction",
          startSourceType: "SUBSCRIPTION_CLOSURE"
        }
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.vehicleOperationalRestriction.update({
          data: { startSourceKey: "unrelated-return-inspection-restriction" },
          where: { id: intendedRestriction.id }
        });
      });
      const missingRestrictionTruth = await snapshotPhysicalReturnTruth(prisma, fixture);
      await expect(
        closure.releaseManagedReturnInventory(
          {
            actorId: fixture.actorId,
            closureCaseId: closureCase.id,
            occurredAt: releaseAt,
            releaseReason: "inspection accepted"
          },
          {}
        )
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      await expect(snapshotPhysicalReturnTruth(prisma, fixture)).resolves.toEqual(
        missingRestrictionTruth
      );
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.vehicleOperationalRestriction.update({
          data: { startSourceKey: "return-inspection-restriction" },
          where: { id: intendedRestriction.id }
        });
      });
      await expect(
        closure.releaseManagedReturnInventory(
          {
            actorId: fixture.actorId,
            closureCaseId: closureCase.id,
            occurredAt: releaseAt,
            releaseReason: "inspection accepted"
          },
          {}
        )
      ).rejects.toMatchObject({ response: { code: "VEHICLE_NOT_AVAILABLE" } });
      await expect(
        prisma.vehicleOperationalRestriction.findFirstOrThrow({
          where: { vehicleId: fixture.vehicleId }
        })
      ).resolves.toMatchObject({ status: "ACTIVE" });
      await prisma.vehicle.update({
        data: { currentSalePriceAmount: 10000000n, salePriceStatus: "EFFECTIVE" },
        where: { id: fixture.vehicleId }
      });
      const allowedAt = occurredAt;
      const inventoryCommand = {
        actorId: fixture.actorId,
        closureCaseId: closureCase.id,
        occurredAt: allowedAt,
        releaseReason: "inspection accepted"
      };
      for (failingAuditEntity of [
        "vehicle_operational_restriction",
        "vehicle",
        "subscription_closure_event"
      ]) {
        const failpointTruth = await snapshotPhysicalReturnTruth(prisma, fixture);
        expect(failpointTruth).toHaveLength(15);
        await expect(
          failpointClosure.releaseManagedReturnInventory(inventoryCommand, {})
        ).rejects.toThrow(`task-4-audit-failpoint:${failingAuditEntity}`);
        await expect(snapshotPhysicalReturnTruth(prisma, fixture)).resolves.toEqual(failpointTruth);
        await expect(
          Promise.all([
            prisma.vehicle.findUniqueOrThrow({ where: { id: fixture.vehicleId } }),
            prisma.vehicleOperationalRestriction.findFirstOrThrow({
              where: { vehicleId: fixture.vehicleId }
            }),
            prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCase.id } })
          ])
        ).resolves.toEqual([
          expect.objectContaining({ status: "MAINTENANCE" }),
          expect.objectContaining({ status: "ACTIVE" }),
          expect.objectContaining({ status: "PENDING_SETTLEMENT" })
        ]);
      }
      failingAuditEntity = null;
      await expect(closure.releaseManagedReturnInventory(inventoryCommand, {})).resolves.toEqual({
        closureCaseId: closureCase.id,
        vehicleId: fixture.vehicleId
      });
      await expect(
        prisma.vehicle.findUniqueOrThrow({ where: { id: fixture.vehicleId } })
      ).resolves.toMatchObject({ status: "AVAILABLE" });
      await expect(
        prisma.vehicleOperationalRestriction.findFirstOrThrow({
          where: { vehicleId: fixture.vehicleId }
        })
      ).resolves.toMatchObject({ status: "RELEASED" });
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  }, 20_000);

  it("focuses physical receipt replay over every touched fact and audit", async () => {
    const scenario = await setupFocusedPhysicalReceipt(prisma);
    try {
      await expect(
        scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {})
      ).resolves.toEqual({ vehicleReturnId: scenario.closureCase.vehicleReturnId });
      const truth = await snapshotPhysicalReturnTruth(prisma, scenario.fixture);
      await expect(
        scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {})
      ).resolves.toEqual({ vehicleReturnId: scenario.closureCase.vehicleReturnId });
      await expect(snapshotPhysicalReturnTruth(prisma, scenario.fixture)).resolves.toEqual(truth);
      await expect(
        scenario.closure.confirmManagedPhysicalReceipt(
          {
            ...scenario.receipt,
            damages: [
              {
                ...scenario.receipt.damages[0]!,
                description: "focused conflicting damage"
              }
            ]
          },
          {}
        )
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
        status: 409
      });
      await expect(snapshotPhysicalReturnTruth(prisma, scenario.fixture)).resolves.toEqual(truth);
    } finally {
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  });

  it("focuses inspection evidence and actual-cost acceptance", async () => {
    const scenario = await setupFocusedPhysicalReceipt(prisma);
    try {
      await scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {});
      await closeFocusedInspectionWorkOrder(scenario);
      const before = await snapshotPhysicalReturnTruth(prisma, scenario.fixture);
      await expect(
        scenario.closure.recordManagedReturnInspection(
          focusedInspectionCommand(scenario, false),
          {}
        )
      ).resolves.toMatchObject({ case: { status: "PENDING_SETTLEMENT" } });
      const after = await snapshotPhysicalReturnTruth(prisma, scenario.fixture);
      expect(after).not.toEqual(before);
      expect(after[10]).toEqual([
        expect.objectContaining({
          action: "ATTACH",
          evidenceType: "INSPECTION_REPORT",
          workOrderId: scenario.closureCase.returnAssetWorkOrderId
        })
      ]);
      await expect(
        prisma.vehicleCostLedgerEntry.findMany({ where: { orderId: scenario.fixture.orderId } })
      ).resolves.toEqual([
        expect.objectContaining({ actionType: "ACTUAL_COST", amountCents: 2500n })
      ]);
    } finally {
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  });

  it("focuses governed reconditioning and its cost-confirmed acceptance gate", async () => {
    const scenario = await setupFocusedPhysicalReceipt(prisma);
    try {
      await scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {});
      await closeFocusedInspectionWorkOrder(scenario);
      await expect(
        scenario.closure.recordManagedReturnInspection(focusedInspectionCommand(scenario, true), {})
      ).resolves.toMatchObject({ case: { status: "RECONDITIONING" } });
      const reconditioningCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { id: scenario.closureCase.id }
      });
      const workOrderId = reconditioningCase.reconditioningAssetWorkOrderId!;
      for (const [expectedVersion, targetStatus] of [
        [0, "IN_PROGRESS"],
        [1, "PENDING_ACCEPTANCE"],
        [2, "PENDING_COST_CONFIRMATION"]
      ] as const) {
        await scenario.operations.transitionWorkOrder(
          {
            closeReason: null,
            detailSnapshot: { targetStatus },
            expectedVersion,
            occurredAt: scenario.occurredAt,
            solution: null,
            source: {
              id: scenario.closureCase.id,
              key: `focused-reconditioning-${expectedVersion}`,
              type: "TASK4_TEST"
            },
            targetStatus,
            workOrderId
          },
          { actorId: scenario.fixture.actorId, permissions: [] }
        );
      }
      const reconditioningCloseCommand = {
        closeReason: "focused reconditioning accepted",
        detailSnapshot: { accepted: true },
        expectedVersion: 3,
        occurredAt: scenario.occurredAt,
        solution: "accepted",
        source: {
          id: scenario.closureCase.id,
          key: "focused-reconditioning-close",
          type: "TASK4_TEST"
        },
        targetStatus: "CLOSED" as const,
        workOrderId
      };
      let preCostAttempts = 0;
      const attemptPreCostClose = () => {
        preCostAttempts += 1;
        return scenario.operations.transitionWorkOrder(reconditioningCloseCommand, {
          actorId: scenario.fixture.actorId,
          permissions: []
        });
      };
      const preCostTruth = await snapshotPhysicalReturnTruth(prisma, scenario.fixture);
      await expect(attemptPreCostClose()).rejects.toMatchObject({
        response: { code: "ASSET_ACCOUNTING_WORK_ORDER_COST_NOT_CONFIRMED" },
        status: 409
      });
      expect(preCostAttempts).toBe(1);
      await expect(snapshotPhysicalReturnTruth(prisma, scenario.fixture)).resolves.toEqual(
        preCostTruth
      );
      const costSource = {
        id: scenario.closureCase.id,
        key: "focused-reconditioning-cost",
        type: "TASK4_TEST"
      };
      await scenario.accounting.appendCost(
        {
          actionType: "ACTUAL_COST",
          accountingPeriod: "2026-08",
          amountCents: 7500n,
          assetOwnerId: null,
          assetOwnerSnapshot: null,
          confirmedAt: scenario.occurredAt,
          contractId: scenario.fixture.contractId,
          costCategory: "CLEANING",
          customerId: scenario.fixture.customerId,
          evidenceId: null,
          evidenceSnapshot: null,
          occurredOn: new Date("2026-08-21T00:00:00.000Z"),
          orderId: scenario.fixture.orderId,
          reason: "focused reconditioning cost",
          responsiblePartyId: scenario.fixture.customerId,
          responsiblePartyType: "CUSTOMER",
          responsibilitySnapshot: { basis: "focused reconditioning" },
          source: costSource,
          vehicleId: scenario.fixture.vehicleId,
          workOrderId
        },
        {
          actorId: scenario.fixture.actorId,
          idempotencyKey: costSource.key,
          permissions: [ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM]
        }
      );
      await scenario.operations.transitionWorkOrder(reconditioningCloseCommand, {
        actorId: scenario.fixture.actorId,
        permissions: []
      });
      await expect(
        scenario.closure.recordManagedReturnInspection(
          {
            accepted: true,
            actorId: scenario.fixture.actorId,
            closureCaseId: scenario.closureCase.id,
            costs: [],
            evidence: [],
            occurredAt: scenario.occurredAt,
            reconditioningRequired: false
          },
          {}
        )
      ).resolves.toMatchObject({ case: { status: "PENDING_SETTLEMENT" } });
      await expect(
        prisma.assetWorkOrder.findUniqueOrThrow({ where: { id: workOrderId } })
      ).resolves.toMatchObject({ costConfirmationRequired: true, status: "CLOSED" });
    } finally {
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  });

  it("focuses inventory release on the exact closure restriction", async () => {
    const scenario = await setupFocusedPhysicalReceipt(prisma);
    try {
      await scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {});
      await closeFocusedInspectionWorkOrder(scenario);
      await scenario.closure.recordManagedReturnInspection(
        focusedInspectionCommand(scenario, false),
        {}
      );
      await prisma.vehicle.update({
        data: { currentSalePriceAmount: 10000000n, salePriceStatus: "EFFECTIVE" },
        where: { id: scenario.fixture.vehicleId }
      });
      const restriction = await prisma.vehicleOperationalRestriction.findFirstOrThrow({
        where: {
          startSourceId: scenario.closureCase.id,
          startSourceKey: "return-inspection-restriction",
          startSourceType: "SUBSCRIPTION_CLOSURE"
        }
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.vehicleOperationalRestriction.update({
          data: { startSourceKey: "focused-unrelated-restriction" },
          where: { id: restriction.id }
        });
      });
      const driftTruth = await snapshotPhysicalReturnTruth(prisma, scenario.fixture);
      const releaseCommand = {
        actorId: scenario.fixture.actorId,
        closureCaseId: scenario.closureCase.id,
        occurredAt: scenario.occurredAt,
        releaseReason: "focused inspection accepted"
      };
      await expect(
        scenario.closure.releaseManagedReturnInventory(releaseCommand, {})
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      await expect(snapshotPhysicalReturnTruth(prisma, scenario.fixture)).resolves.toEqual(
        driftTruth
      );
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.vehicleOperationalRestriction.update({
          data: { startSourceKey: "return-inspection-restriction" },
          where: { id: restriction.id }
        });
      });
      await expect(
        scenario.closure.releaseManagedReturnInventory(releaseCommand, {})
      ).resolves.toEqual({
        closureCaseId: scenario.closureCase.id,
        vehicleId: scenario.fixture.vehicleId
      });
      await expect(
        prisma.vehicleOperationalRestriction.findUniqueOrThrow({
          where: { id: restriction.id }
        })
      ).resolves.toMatchObject({ status: "RELEASED" });
      await expect(
        prisma.vehicle.findUniqueOrThrow({
          where: { id: scenario.fixture.vehicleId }
        })
      ).resolves.toMatchObject({ status: "AVAILABLE" });
    } finally {
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  });

  it("rejects raw legacy recovery authority despite snapshot-bound approval and evidence", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const requesterId = randomUUID();
    const expiry = createGovernedExpiryService(prisma);
    try {
      await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      await runManagedPrepare(prisma, createGovernedClosureService(prisma), fixture);
      const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { orderId: fixture.orderId }
      });
      const occurredAt = (
        await prisma.subscriptionClosureEvent.findFirstOrThrow({
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          where: { closureCaseId: closureCase.id }
        })
      ).occurredAt;
      await awaitDatabaseClockPast(prisma, occurredAt);
      await prisma.vehicleSubscriptionPeriod.create({
        data: {
          contractId: fixture.contractId,
          contractSegmentId: fixture.segmentId,
          createdBy: fixture.actorId,
          customerId: fixture.customerId,
          orderId: fixture.orderId,
          startConfirmedAt: new Date("2026-03-03T02:00:00.000Z"),
          startConfirmedBy: fixture.actorId,
          startReason: "DELIVERY_CONFIRMED",
          startSnapshot: { fixture: "task-4-recovery" },
          startSourceId: fixture.orderId,
          startSourceKey: "task-4-recovery-open-subscription",
          startSourceType: "TASK4_TEST",
          startedAt: new Date("2026-03-03T02:00:00.000Z"),
          vehicleId: fixture.vehicleId
        }
      });
      const audit = new AuditService(prisma);
      const accounting = new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
      const operations = new AssetOperationsService(
        prisma,
        new AssetOperationsRepository(),
        audit,
        accounting
      );
      const recovery = await operations.createWorkOrder(
        {
          assetOwnerId: null,
          contractId: fixture.contractId,
          costConfirmationRequired: false,
          customerId: fixture.customerId,
          description: `Recovery execution for closure ${closureCase.caseNo}`,
          metadata: { closureCaseId: closureCase.id },
          occurredAt: new Date(occurredAt.getTime() - 1_000),
          orderId: fixture.orderId,
          priority: "URGENT",
          relatedWorkOrderId: closureCase.returnAssetWorkOrderId,
          source: { id: closureCase.id, key: "task-4-recovery-work-order", type: "TASK4_TEST" },
          vehicleId: fixture.vehicleId,
          workOrderType: "RECOVERY"
        },
        { actorId: fixture.actorId, permissions: [] }
      );
      const governingBill = await prisma.receivableBill.create({
        data: {
          amount: 900n,
          billNo: `BIL-TASK4-${closureCase.id}`,
          billStatus: "OVERDUE",
          billType: "MONTHLY_RENT",
          createdBy: fixture.actorId,
          customerId: fixture.customerId,
          dueDate: new Date("2026-08-05T00:00:00.000Z"),
          orderId: fixture.orderId,
          paidAmount: 0n,
          remainingAmount: 900n
        },
        select: {
          billStatus: true,
          dueDate: true,
          id: true,
          remainingAmount: true
        }
      });
      const assessmentDetail = {
        plannedRecoveryAssetWorkOrderId: recovery.workOrder.id
      };
      const latestSequence = await prisma.subscriptionClosureEvent.aggregate({
        _max: { sequence: true },
        where: { closureCaseId: closureCase.id }
      });
      await prisma.subscriptionClosureEvent.create({
        data: {
          actorId: fixture.actorId,
          afterStatus: "RECOVERY_IN_PROGRESS",
          beforeStatus: "RECOVERY_IN_PROGRESS",
          closureCaseId: closureCase.id,
          detailSnapshot: assessmentDetail,
          eventType: "RECOVERY_ESCALATED",
          occurredAt,
          sequence: (latestSequence._max.sequence ?? 0) + 1,
          sourceId: closureCase.id,
          sourceKey: "task-4-recovery-assessment",
          sourceType: "TASK4_TEST"
        }
      });
      const [recoveryVehicle, recoveryReturn] = await Promise.all([
        prisma.vehicle.findUniqueOrThrow({
          select: { id: true, status: true, vehicleNo: true },
          where: { id: fixture.vehicleId }
        }),
        prisma.vehicleReturn.findUniqueOrThrow({
          select: { id: true, returnStatus: true, returnedAt: true },
          where: { id: closureCase.vehicleReturnId! }
        })
      ]);
      const recoveryContextSnapshotHash = createHash("sha256")
        .update(
          canonicalSubscriptionClosureJson({
            assessmentSnapshotHash: createHash("sha256")
              .update(canonicalSubscriptionClosureJson(assessmentDetail))
              .digest("hex"),
            bills: [governingBill],
            collectionCases: [],
            extension: null,
            legalRestrictions: [],
            vehicle: recoveryVehicle,
            vehicleReturn: recoveryReturn
          })
        )
        .digest("hex");
      const revisionId = randomUUID();
      const correctedRevisionId = randomUUID();
      const approvalId = randomUUID();
      const correctedApprovalId = randomUUID();
      const sourceFileId = randomUUID();
      const signedFileId = randomUUID();
      const eSignTaskId = randomUUID();
      const correctedESignTaskId = randomUUID();
      const documentSnapshot = {
        caseNo: closureCase.caseNo,
        closureCaseId: closureCase.id,
        contractId: fixture.contractId,
        customerId: fixture.customerId,
        documentType: "RECOVERY_AUTHORITY",
        finalDisposition: "TERMINATE",
        orderId: fixture.orderId,
        physicalControlMode: "RECOVERY",
        recoveryAssetWorkOrderId: recovery.workOrder.id,
        recoveryWorkOrderType: "RECOVERY",
        vehicleId: fixture.vehicleId,
        vehicleReturnId: closureCase.vehicleReturnId
      };
      const documentHash = createHash("sha256")
        .update(canonicalSubscriptionClosureJson(documentSnapshot))
        .digest("hex");
      const driftedDocumentHash = "a".repeat(64);
      const approvalSnapshot = {
        closureCaseId: closureCase.id,
        orderId: fixture.orderId,
        recoveryAssetWorkOrderId: recovery.workOrder.id,
        recoveryAuthorityRevisionId: revisionId,
        recoveryAuthoritySnapshotHash: driftedDocumentHash,
        recoveryContextSnapshotHash,
        vehicleId: fixture.vehicleId
      };
      const approvalHash = createHash("sha256")
        .update(canonicalSubscriptionClosureJson(approvalSnapshot))
        .digest("hex");
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "user" ("id", "username", "name", "password_hash", "status", "created_at", "updated_at")
          VALUES (${requesterId}::uuid, ${`task4-requester-${requesterId}`}, 'Recovery requester', 'not-used', 'ACTIVE', clock_timestamp(), clock_timestamp())
        `);
        await tx.subscriptionClosureCase.update({
          data: {
            finalDisposition: "TERMINATE",
            physicalControlMode: "RECOVERY",
            recoveryAssetWorkOrderId: recovery.workOrder.id,
            status: "RECOVERY_IN_PROGRESS",
            updatedBy: fixture.actorId,
            version: { increment: 1 }
          },
          where: { id: closureCase.id }
        });
        for (const [id, suffix] of [
          [sourceFileId, "source"],
          [signedFileId, "signed"]
        ] as const) {
          await tx.fileObject.create({
            data: {
              bucket: "subscription-closure",
              id,
              mimeType: "application/pdf",
              objectKey: `subscription-closure/${closureCase.id}/recovery-${suffix}.pdf`,
              originalName: `${closureCase.caseNo}-recovery-${suffix}.pdf`,
              sizeBytes: 128n,
              uploadedBy: fixture.actorId
            }
          });
        }
        await tx.contractESignTask.create({
          data: {
            completedAt: occurredAt,
            contractId: fixture.contractId,
            createdBy: fixture.actorId,
            customerId: fixture.customerId,
            documentObjectKey: `subscription-closure/${closureCase.id}/recovery-source.pdf`,
            documentType: "DELIVERY_HANDOVER",
            id: eSignTaskId,
            orderId: fixture.orderId,
            provider: "OTHER",
            requestSnapshot: {
              documentSnapshotHash: driftedDocumentHash,
              sourceFileHash: driftedDocumentHash,
              sourceFileId
            },
            responseSnapshot: { signedFileHash: "d".repeat(64), signedFileId },
            signedDocumentObjectKey: `subscription-closure/${closureCase.id}/recovery-signed.pdf`,
            signingStage: "STAGE2_DELIVERY_HANDOVER",
            sourceId: closureCase.id,
            sourceKey: "task-4-recovery-authority",
            sourceType: "TASK4_TEST",
            taskNo: `ESG-TASK4-REC-${eSignTaskId}`,
            taskStatus: "COMPLETED",
            updatedBy: fixture.actorId
          }
        });
        await tx.subscriptionClosureDocumentRevision.create({
          data: {
            archivedAt: occurredAt,
            archivedBy: fixture.actorId,
            closureCaseId: closureCase.id,
            contractESignTaskId: eSignTaskId,
            documentSnapshot,
            documentSnapshotHash: driftedDocumentHash,
            documentType: "RECOVERY_AUTHORITY",
            generatedAt: occurredAt,
            generatedBy: fixture.actorId,
            id: revisionId,
            revisionNumber: 1,
            signedAt: occurredAt,
            signedBy: fixture.actorId,
            signedFileHash: "d".repeat(64),
            signedFileId,
            sourceFileHash: driftedDocumentHash,
            sourceFileId,
            sourceId: closureCase.id,
            sourceKey: "task-4-recovery-authority",
            sourceType: "TASK4_TEST",
            stage: "ARCHIVED"
          }
        });
        await tx.subscriptionClosureCurrentDocument.create({
          data: {
            closureCaseId: closureCase.id,
            documentRevisionId: revisionId,
            documentType: "RECOVERY_AUTHORITY",
            updatedBy: fixture.actorId
          }
        });
        await tx.businessExceptionApproval.create({
          data: {
            approvalNo: `BEA-TASK4-${approvalId}`,
            exceptionType: "RECOVERY_EXECUTION_APPROVAL",
            id: approvalId,
            requestReason: "recover vehicle",
            requestSourceId: closureCase.id,
            requestSourceKey: "task-4-recovery-approval",
            requestSourceType: "TASK4_TEST",
            requestedAt: occurredAt,
            requestedBy: requesterId,
            subjectField: "recoveryExecution",
            subjectId: closureCase.id,
            subjectSnapshot: approvalSnapshot,
            subjectSnapshotHash: approvalHash,
            subjectType: "RECOVERY_CASE"
          }
        });
        await tx.businessExceptionApproval.update({
          data: {
            decidedAt: occurredAt,
            decidedBy: fixture.actorId,
            decision: "APPROVED",
            decisionComment: "recovery execution approved",
            status: "APPROVED",
            version: { increment: 1 }
          },
          where: { id: approvalId }
        });
      });
      const closure = new SubscriptionClosureService(
        new SubscriptionClosureRepository(),
        new HandoverWorkOrderService(prisma, {} as never),
        operations,
        audit,
        prisma,
        new AssetFactsService(prisma, new AssetFactsRepository(), audit),
        accounting,
        new VehicleMileageService(prisma, new VehicleMileageRepository())
      );
      const receipt = {
        actorId: fixture.actorId,
        checklist: {},
        damages: [],
        orderId: fixture.orderId,
        physicalControlMode: "RECOVERY" as const,
        remark: "vehicle secured",
        returnMileageKm: 1300,
        returnType: "EARLY_TERMINATION" as const,
        returnedAt: occurredAt
      };
      await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" }
      });
      await prisma.$transaction(async (tx) => {
        await tx.contractESignTask.create({
          data: {
            completedAt: occurredAt,
            contractId: fixture.contractId,
            createdBy: fixture.actorId,
            customerId: fixture.customerId,
            documentObjectKey: `subscription-closure/${closureCase.id}/recovery-source.pdf`,
            documentType: "DELIVERY_HANDOVER",
            id: correctedESignTaskId,
            orderId: fixture.orderId,
            provider: "OTHER",
            requestSnapshot: {
              documentSnapshotHash: documentHash,
              sourceFileHash: documentHash,
              sourceFileId
            },
            responseSnapshot: { signedFileHash: "d".repeat(64), signedFileId },
            signedDocumentObjectKey: `subscription-closure/${closureCase.id}/recovery-signed.pdf`,
            signingStage: "STAGE2_DELIVERY_HANDOVER",
            sourceId: closureCase.id,
            sourceKey: "task-4-recovery-authority:2",
            sourceType: "TASK4_TEST",
            taskNo: `ESG-TASK4-REC-${correctedESignTaskId}`,
            taskStatus: "COMPLETED",
            updatedBy: fixture.actorId
          }
        });
        await tx.subscriptionClosureDocumentRevision.create({
          data: {
            archivedAt: occurredAt,
            archivedBy: fixture.actorId,
            closureCaseId: closureCase.id,
            contractESignTaskId: correctedESignTaskId,
            documentSnapshot,
            documentSnapshotHash: documentHash,
            documentType: "RECOVERY_AUTHORITY",
            generatedAt: occurredAt,
            generatedBy: fixture.actorId,
            id: correctedRevisionId,
            revisionNumber: 2,
            signedAt: occurredAt,
            signedBy: fixture.actorId,
            signedFileHash: "d".repeat(64),
            signedFileId,
            sourceFileHash: documentHash,
            sourceFileId,
            sourceId: closureCase.id,
            sourceKey: "task-4-recovery-authority:2",
            sourceType: "TASK4_TEST",
            stage: "ARCHIVED",
            supersedesRevisionId: revisionId
          }
        });
        await tx.subscriptionClosureCurrentDocument.update({
          data: { documentRevisionId: correctedRevisionId, updatedBy: fixture.actorId },
          where: {
            closureCaseId_documentType: {
              closureCaseId: closureCase.id,
              documentType: "RECOVERY_AUTHORITY"
            }
          }
        });
      });
      await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" }
      });
      const correctedApprovalSnapshot = {
        ...approvalSnapshot,
        recoveryAuthorityRevisionId: correctedRevisionId,
        recoveryAuthoritySnapshotHash: documentHash
      };
      const correctedApprovalHash = createHash("sha256")
        .update(canonicalSubscriptionClosureJson(correctedApprovalSnapshot))
        .digest("hex");
      await prisma.$transaction(async (tx) => {
        await tx.businessExceptionApproval.update({
          data: {
            expiredAt: occurredAt,
            expiredBy: fixture.actorId,
            expiryReason: "superseded recovery authority",
            status: "EXPIRED",
            version: { increment: 1 }
          },
          where: { id: approvalId }
        });
        await tx.businessExceptionApproval.create({
          data: {
            approvalNo: `BEA-TASK4-${correctedApprovalId}`,
            exceptionType: "RECOVERY_EXECUTION_APPROVAL",
            id: correctedApprovalId,
            requestReason: "recover vehicle under current authority",
            requestSourceId: closureCase.id,
            requestSourceKey: "task-4-recovery-approval:2",
            requestSourceType: "TASK4_TEST",
            requestedAt: occurredAt,
            requestedBy: requesterId,
            subjectField: "recoveryExecution",
            subjectId: closureCase.id,
            subjectSnapshot: correctedApprovalSnapshot,
            subjectSnapshotHash: correctedApprovalHash,
            subjectType: "RECOVERY_CASE"
          }
        });
        await tx.businessExceptionApproval.update({
          data: {
            decidedAt: occurredAt,
            decidedBy: fixture.actorId,
            decision: "APPROVED",
            decisionComment: "current recovery execution approved",
            status: "APPROVED",
            version: { increment: 1 }
          },
          where: { id: correctedApprovalId }
        });
      });
      await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" }
      });
      await prisma.assetWorkOrderEvidence.create({
        data: {
          action: "ATTACH",
          actorId: fixture.actorId,
          captureMetadata: {
            recoveryApprovalId: correctedApprovalId,
            recoveryAuthorityRevisionId: correctedRevisionId
          },
          capturedAt: new Date(occurredAt.getTime() - 1),
          contentSha256: "c".repeat(64),
          evidenceType: "LOCATION_PROOF",
          fileBucket: "subscription-closure",
          fileId: signedFileId,
          fileMimeType: "application/pdf",
          fileObjectKey: `subscription-closure/${closureCase.id}/recovery-signed.pdf`,
          fileSizeBytes: 128n,
          sourceId: closureCase.id,
          sourceKey: "task-4-recovery-preapproval-evidence",
          sourceType: "TASK4_TEST",
          workOrderId: recovery.workOrder.id
        }
      });
      await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" }
      });
      await prisma.assetWorkOrderEvidence.create({
        data: {
          action: "ATTACH",
          actorId: fixture.actorId,
          captureMetadata: {
            recoveryApprovalId: correctedApprovalId,
            recoveryAuthorityRevisionId: correctedRevisionId
          },
          capturedAt: occurredAt,
          contentSha256: "e".repeat(64),
          evidenceType: "LOCATION_PROOF",
          fileBucket: "subscription-closure",
          fileId: signedFileId,
          fileMimeType: "application/pdf",
          fileObjectKey: `subscription-closure/${closureCase.id}/recovery-signed.pdf`,
          fileSizeBytes: 128n,
          sourceId: closureCase.id,
          sourceKey: "task-4-recovery-execution-evidence",
          sourceType: "TASK4_TEST",
          workOrderId: recovery.workOrder.id
        }
      });
      const expectRecoveryAuthorityDrift = async (
        mutate: () => Promise<unknown>,
        restore: () => Promise<unknown>
      ) => {
        await mutate();
        const driftTruth = await snapshotPhysicalReturnTruth(prisma, fixture);
        await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
          status: 409
        });
        await expect(snapshotPhysicalReturnTruth(prisma, fixture)).resolves.toEqual(driftTruth);
        await restore();
      };
      const restoreSemanticAuthority = () =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
          await tx.subscriptionClosureDocumentRevision.update({
            data: {
              documentSnapshot,
              documentSnapshotHash: documentHash,
              sourceFileHash: documentHash
            },
            where: { id: correctedRevisionId }
          });
          await tx.contractESignTask.update({
            data: {
              requestSnapshot: {
                documentSnapshotHash: documentHash,
                sourceFileHash: documentHash,
                sourceFileId
              }
            },
            where: { id: correctedESignTaskId }
          });
          await tx.businessExceptionApproval.update({
            data: {
              subjectSnapshot: correctedApprovalSnapshot,
              subjectSnapshotHash: correctedApprovalHash
            },
            where: { id: correctedApprovalId }
          });
        });
      for (const [field, value] of [
        ["orderId", randomUUID()],
        ["vehicleId", randomUUID()],
        ["recoveryAssetWorkOrderId", randomUUID()]
      ] as const) {
        const semanticDriftSnapshot = { ...documentSnapshot, [field]: value };
        const semanticDriftHash = createHash("sha256")
          .update(canonicalSubscriptionClosureJson(semanticDriftSnapshot))
          .digest("hex");
        const semanticDriftApprovalSnapshot = {
          ...correctedApprovalSnapshot,
          recoveryAuthoritySnapshotHash: semanticDriftHash
        };
        await expectRecoveryAuthorityDrift(
          () =>
            prisma.$transaction(async (tx) => {
              await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
              await tx.subscriptionClosureDocumentRevision.update({
                data: {
                  documentSnapshot: semanticDriftSnapshot,
                  documentSnapshotHash: semanticDriftHash,
                  sourceFileHash: semanticDriftHash
                },
                where: { id: correctedRevisionId }
              });
              await tx.contractESignTask.update({
                data: {
                  requestSnapshot: {
                    documentSnapshotHash: semanticDriftHash,
                    sourceFileHash: semanticDriftHash,
                    sourceFileId
                  }
                },
                where: { id: correctedESignTaskId }
              });
              await tx.businessExceptionApproval.update({
                data: {
                  subjectSnapshot: semanticDriftApprovalSnapshot,
                  subjectSnapshotHash: createHash("sha256")
                    .update(canonicalSubscriptionClosureJson(semanticDriftApprovalSnapshot))
                    .digest("hex")
                },
                where: { id: correctedApprovalId }
              });
            }),
          restoreSemanticAuthority
        );
      }
      const sourceObjectKey = `subscription-closure/${closureCase.id}/recovery-source.pdf`;
      const signedObjectKey = `subscription-closure/${closureCase.id}/recovery-signed.pdf`;
      const withReplica = (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
          return run(tx);
        });
      for (const [mutate, restore] of [
        [
          () =>
            withReplica((tx) =>
              tx.fileObject.update({
                data: { objectKey: `${sourceObjectKey}.drift` },
                where: { id: sourceFileId }
              })
            ),
          () =>
            withReplica((tx) =>
              tx.fileObject.update({
                data: { objectKey: sourceObjectKey },
                where: { id: sourceFileId }
              })
            )
        ],
        [
          () =>
            withReplica((tx) =>
              tx.fileObject.update({
                data: { objectKey: `${signedObjectKey}.drift` },
                where: { id: signedFileId }
              })
            ),
          () =>
            withReplica((tx) =>
              tx.fileObject.update({
                data: { objectKey: signedObjectKey },
                where: { id: signedFileId }
              })
            )
        ],
        [
          () =>
            withReplica((tx) =>
              tx.contractESignTask.update({
                data: { sourceKey: "drifted-esign-source" },
                where: { id: correctedESignTaskId }
              })
            ),
          () =>
            withReplica((tx) =>
              tx.contractESignTask.update({
                data: { sourceKey: "task-4-recovery-authority:2" },
                where: { id: correctedESignTaskId }
              })
            )
        ],
        [
          () =>
            withReplica((tx) =>
              tx.contractESignTask.update({
                data: {
                  requestSnapshot: {
                    documentSnapshotHash: documentHash,
                    sourceFileHash: documentHash,
                    sourceFileId: signedFileId
                  }
                },
                where: { id: correctedESignTaskId }
              })
            ),
          () =>
            withReplica((tx) =>
              tx.contractESignTask.update({
                data: {
                  requestSnapshot: {
                    documentSnapshotHash: documentHash,
                    sourceFileHash: documentHash,
                    sourceFileId
                  }
                },
                where: { id: correctedESignTaskId }
              })
            )
        ],
        [
          () =>
            withReplica((tx) =>
              tx.contractESignTask.update({
                data: {
                  responseSnapshot: { signedFileHash: "d".repeat(64), signedFileId: sourceFileId }
                },
                where: { id: correctedESignTaskId }
              })
            ),
          () =>
            withReplica((tx) =>
              tx.contractESignTask.update({
                data: { responseSnapshot: { signedFileHash: "d".repeat(64), signedFileId } },
                where: { id: correctedESignTaskId }
              })
            )
        ]
      ] as const) {
        await expectRecoveryAuthorityDrift(mutate, restore);
      }
      const missingRecoveryRestrictionTruth = await snapshotPhysicalReturnTruth(prisma, fixture);
      await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      await expect(snapshotPhysicalReturnTruth(prisma, fixture)).resolves.toEqual(
        missingRecoveryRestrictionTruth
      );
      const recoveryRestriction = await operations.createRestriction(
        {
          conditionsSnapshot: {
            closureCaseId: closureCase.id,
            releaseCondition: "RECOVERY_PHYSICAL_CONTROL_CONFIRMED"
          },
          evidenceSnapshot: {
            recoveryApprovalId: correctedApprovalId,
            recoveryAuthorityRevisionId: correctedRevisionId
          },
          occurredAt,
          restrictionType: "RECOVERY_IN_PROGRESS",
          scopes: ["ALLOCATION", "DELIVERY", "CUSTOMER_USE", "INVENTORY_RELEASE"],
          severity: "BLOCKING",
          source: {
            id: closureCase.id,
            key: "recovery-restriction",
            type: "SUBSCRIPTION_CLOSURE"
          },
          startedAt: occurredAt,
          vehicleId: fixture.vehicleId,
          workOrderId: recovery.workOrder.id
        },
        { actorId: fixture.actorId, permissions: [] }
      );
      const expectRecoveryRestrictionDrift = async (
        mutate: () => Promise<unknown>,
        restore: () => Promise<unknown>
      ) => {
        await mutate();
        const driftTruth = await snapshotPhysicalReturnTruth(prisma, fixture);
        await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
          status: 409
        });
        await expect(snapshotPhysicalReturnTruth(prisma, fixture)).resolves.toEqual(driftTruth);
        await restore();
      };
      for (const [data, restore] of [
        [
          { workOrderId: closureCase.returnAssetWorkOrderId },
          { workOrderId: recovery.workOrder.id }
        ],
        [
          { restrictionType: "LEGAL_HOLD" as const },
          { restrictionType: "RECOVERY_IN_PROGRESS" as const }
        ],
        [
          {
            releaseReason: "invalid pre-receipt release",
            releaseSnapshot: { invalidFixture: true },
            releaseSourceId: closureCase.id,
            releaseSourceKey: "invalid-pre-receipt-release",
            releaseSourceType: "TASK6_TEST",
            releasedAt: occurredAt,
            releasedBy: fixture.actorId,
            status: "RELEASED" as const
          },
          {
            releaseReason: null,
            releaseSnapshot: Prisma.DbNull,
            releaseSourceId: null,
            releaseSourceKey: null,
            releaseSourceType: null,
            releasedAt: null,
            releasedBy: null,
            status: "ACTIVE" as const
          }
        ]
      ] as const) {
        await expectRecoveryRestrictionDrift(
          () =>
            withReplica((tx) =>
              tx.vehicleOperationalRestriction.update({
                data,
                where: { id: recoveryRestriction.restriction.id }
              })
            ),
          () =>
            withReplica((tx) =>
              tx.vehicleOperationalRestriction.update({
                data: restore,
                where: { id: recoveryRestriction.restriction.id }
              })
            )
        );
      }
      const duplicateRecoveryRestrictionId = randomUUID();
      await expectRecoveryRestrictionDrift(
        () =>
          prisma.vehicleOperationalRestriction.create({
            data: {
              conditionsSnapshot: { duplicateFixture: true },
              createdBy: fixture.actorId,
              evidenceSnapshot: { duplicateFixture: true },
              id: duplicateRecoveryRestrictionId,
              restrictionType: "RECOVERY_IN_PROGRESS",
              scopes: ["ALLOCATION"],
              severity: "BLOCKING",
              startSourceId: closureCase.id,
              startSourceKey: "duplicate-recovery-restriction",
              startSourceType: "TASK6_TEST",
              startedAt: occurredAt,
              status: "ACTIVE",
              updatedBy: fixture.actorId,
              vehicleId: fixture.vehicleId,
              workOrderId: recovery.workOrder.id
            }
          }),
        () =>
          withReplica((tx) =>
            tx.vehicleOperationalRestriction.delete({
              where: { id: duplicateRecoveryRestrictionId }
            })
          )
      );
      const competingModes = await Promise.allSettled([
        closure.confirmManagedPhysicalReceipt(receipt, {}),
        closure.confirmManagedPhysicalReceipt(
          { ...receipt, physicalControlMode: "VOLUNTARY_RETURN" },
          {}
        )
      ]);
      expect(competingModes.filter(({ status }) => status === "fulfilled")).toHaveLength(0);
      expect(competingModes.filter(({ status }) => status === "rejected")).toHaveLength(2);
      expect(competingModes[0]).toMatchObject({
        reason: {
          response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
          status: 409
        },
        status: "rejected"
      });
      expect(competingModes[1]).toMatchObject({
        reason: {
          response: { code: "SUBSCRIPTION_CLOSURE_MANAGED_RETURN_AUTHORITY_NOT_FOUND" },
          status: 409
        },
        status: "rejected"
      });
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
      await prisma.$executeRaw(Prisma.sql`DELETE FROM "user" WHERE "id" = ${requesterId}::uuid`);
    }
  }, 30_000);

  it("executes the D+7 approved recovery and secures the vehicle through the Task 4 command", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const requesterId = randomUUID();
    const billId = randomUUID();
    try {
      const expiry = createGovernedExpiryService(prisma);
      await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      const audit = new AuditService(prisma);
      const accounting = new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
      const operations = new AssetOperationsService(
        prisma,
        new AssetOperationsRepository(),
        audit,
        accounting
      );
      const closure = new SubscriptionClosureService(
        new SubscriptionClosureRepository(),
        new HandoverWorkOrderService(prisma, {} as never),
        operations,
        audit,
        prisma,
        new AssetFactsService(prisma, new AssetFactsRepository(), audit),
        accounting,
        new VehicleMileageService(prisma, new VehicleMileageRepository())
      );
      await runManagedPrepare(prisma, closure, fixture);
      await prisma.vehicleSubscriptionPeriod.create({
        data: {
          contractId: fixture.contractId,
          contractSegmentId: fixture.segmentId,
          createdBy: fixture.actorId,
          customerId: fixture.customerId,
          orderId: fixture.orderId,
          startConfirmedAt: new Date("2026-03-03T02:00:00.000Z"),
          startConfirmedBy: fixture.actorId,
          startReason: "DELIVERY_CONFIRMED",
          startSnapshot: { fixture: "task-6-recovery" },
          startSourceId: fixture.orderId,
          startSourceKey: "task-6-recovery-open-subscription",
          startSourceType: "TASK6_TEST",
          startedAt: new Date("2026-03-03T02:00:00.000Z"),
          vehicleId: fixture.vehicleId
        }
      });
      const initialCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { orderId: fixture.orderId }
      });
      await prisma.receivableBill.create({
        data: {
          amount: 9000n,
          billNo: `BIL-TASK6-${billId}`,
          billStatus: "OVERDUE",
          billType: "MONTHLY_RENT",
          createdBy: fixture.actorId,
          customerId: fixture.customerId,
          dueDate: new Date("2026-08-10T00:00:00.000Z"),
          id: billId,
          orderId: fixture.orderId,
          paidAmount: 0n,
          remainingAmount: 9000n,
          snapshot: { fixture: "task-6-recovery" }
        }
      });
      const scheduled = await prisma.$transaction((tx) =>
        closure.scheduleRecoveryAssessmentInTransaction(tx, {
          closureCaseId: initialCase.id,
          orderId: fixture.orderId,
          scheduledAt: new Date("2026-08-20T16:00:00.000Z")
        })
      );
      expect(scheduled).toMatchObject({
        availableAt: new Date("2026-08-16T16:00:00.000Z"),
        billId,
        dueDate: "2026-08-10T00:00:00.000Z",
        scheduled: true
      });
      if (!scheduled.scheduled) throw new Error("Expected recovery assessment job");
      const assessmentInput = {
        actorId: fixture.actorId,
        closureCaseId: initialCase.id,
        governingBillId: billId,
        governingDueDate: new Date("2026-08-10T00:00:00.000Z"),
        jobId: scheduled.jobId,
        jobKey: `closure-recovery-assessment:${initialCase.id}:D7`,
        orderId: fixture.orderId
      };
      const assessed = await closure.assessRecoveryJob(assessmentInput);
      expect(assessed).toEqual({ action: "ASSESSED", wrote: true });
      await expect(closure.assessRecoveryJob(assessmentInput)).resolves.toEqual({
        action: "ASSESSED",
        wrote: false
      });
      const assessedCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { id: initialCase.id }
      });
      const assessmentEvent = await prisma.subscriptionClosureEvent.findFirstOrThrow({
        where: { closureCaseId: initialCase.id, eventType: "RECOVERY_ESCALATED" }
      });
      const assessmentDetail = assessmentEvent.detailSnapshot as Prisma.JsonObject;
      const plannedRecoveryAssetWorkOrderId = String(
        assessmentDetail.plannedRecoveryAssetWorkOrderId
      );
      expect(assessedCase).toMatchObject({
        closureType: "NORMAL_COMPLETION",
        finalDisposition: "TERMINATE",
        physicalControlMode: "RECOVERY",
        recoveryAssetWorkOrderId: null,
        status: "RECOVERY_ASSESSMENT_PENDING"
      });

      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "user" ("id", "username", "name", "password_hash", "status", "created_at", "updated_at")
        VALUES (${requesterId}::uuid, ${`task6-requester-${requesterId}`}, 'Task 6 requester', 'not-used', 'ACTIVE', clock_timestamp(), clock_timestamp())
      `);
      const authorityCommand = {
        actorId: fixture.actorId,
        closureCaseId: assessedCase.id,
        idempotencyKey: "task-6-recovery-authority"
      };
      const archiveRollbackBefore = await Promise.all([
        prisma.subscriptionClosureDocumentRevision.count({
          where: { closureCaseId: assessedCase.id, documentType: "RECOVERY_AUTHORITY" }
        }),
        prisma.subscriptionClosureCurrentDocument.count({
          where: { closureCaseId: assessedCase.id, documentType: "RECOVERY_AUTHORITY" }
        }),
        prisma.fileObject.count({
          where: { objectKey: { contains: `${assessedCase.id}/`, mode: "default" } }
        }),
        prisma.contractESignTask.count({
          where: {
            sourceId: assessedCase.id,
            sourceKey: { startsWith: "recovery-authority:task-6-recovery-authority:" }
          }
        }),
        prisma.subscriptionClosureCommandReceipt.count({
          where: {
            closureCaseId: assessedCase.id,
            sourceKey: { startsWith: "recovery-authority:task-6-recovery-authority:" }
          }
        }),
        prisma.subscriptionClosureEvent.count({
          where: {
            closureCaseId: assessedCase.id,
            sourceKey: { startsWith: "recovery-authority:task-6-recovery-authority:" }
          }
        }),
        prisma.auditLog.count({ where: { operatorId: fixture.actorId } })
      ]);
      const archiveFailpointRepositoryTarget = new SubscriptionClosureRepository();
      let archiveAppendCount = 0;
      const archiveFailpointRepository = new Proxy(archiveFailpointRepositoryTarget, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          if (property === "appendPreparedDocumentRevisionInTransaction") {
            return async (...args: unknown[]) => {
              archiveAppendCount += 1;
              if (archiveAppendCount === 2) {
                throw new Error("TASK6_FAILPOINT:after-generated-recovery-authority");
              }
              return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
            };
          }
          return value.bind(target);
        }
      });
      const archiveFailpointClosure = new SubscriptionClosureService(
        archiveFailpointRepository,
        new HandoverWorkOrderService(prisma, {} as never),
        operations,
        audit,
        prisma,
        new AssetFactsService(prisma, new AssetFactsRepository(), audit),
        accounting,
        new VehicleMileageService(prisma, new VehicleMileageRepository())
      );
      await expect(
        archiveFailpointClosure.archiveRecoveryAuthority(authorityCommand)
      ).rejects.toThrow("TASK6_FAILPOINT:after-generated-recovery-authority");
      await expect(
        Promise.all([
          prisma.subscriptionClosureDocumentRevision.count({
            where: { closureCaseId: assessedCase.id, documentType: "RECOVERY_AUTHORITY" }
          }),
          prisma.subscriptionClosureCurrentDocument.count({
            where: { closureCaseId: assessedCase.id, documentType: "RECOVERY_AUTHORITY" }
          }),
          prisma.fileObject.count({
            where: { objectKey: { contains: `${assessedCase.id}/`, mode: "default" } }
          }),
          prisma.contractESignTask.count({
            where: {
              sourceId: assessedCase.id,
              sourceKey: { startsWith: "recovery-authority:task-6-recovery-authority:" }
            }
          }),
          prisma.subscriptionClosureCommandReceipt.count({
            where: {
              closureCaseId: assessedCase.id,
              sourceKey: { startsWith: "recovery-authority:task-6-recovery-authority:" }
            }
          }),
          prisma.subscriptionClosureEvent.count({
            where: {
              closureCaseId: assessedCase.id,
              sourceKey: { startsWith: "recovery-authority:task-6-recovery-authority:" }
            }
          }),
          prisma.auditLog.count({ where: { operatorId: fixture.actorId } })
        ])
      ).resolves.toEqual(archiveRollbackBefore);
      const authority = await closure.archiveRecoveryAuthority(authorityCommand);
      await expect(closure.archiveRecoveryAuthority(authorityCommand)).resolves.toEqual({
        ...authority,
        wrote: false
      });
      const archivedAuthorityRow =
        await prisma.subscriptionClosureDocumentRevision.findUniqueOrThrow({
          where: { id: authority.archivedRevisionId }
        });
      const authorityLockTargets = [
        { id: authority.generatedRevisionId, kind: "REVISION" as const },
        { id: archivedAuthorityRow.sourceFileId, kind: "FILE" as const },
        { id: authority.signedFileId, kind: "FILE" as const },
        { id: archivedAuthorityRow.contractESignTaskId, kind: "ESIGN" as const },
        { id: assessedCase.id, kind: "CURRENT_POINTER" as const }
      ];
      await assertTask6AuthorityMutationBoundaries(
        prisma,
        authorityLockTargets,
        () => closure.archiveRecoveryAuthority(authorityCommand),
        fixture,
        assessedCase.id
      );
      const generatedAuthorityReceipt =
        await prisma.subscriptionClosureCommandReceipt.findFirstOrThrow({
          where: {
            closureCaseId: assessedCase.id,
            sourceKey: "recovery-authority:task-6-recovery-authority:generated"
          }
        });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.subscriptionClosureCommandReceipt.update({
          data: { payloadHash: "f".repeat(64) },
          where: { id: generatedAuthorityReceipt.id }
        });
      });
      await expect(closure.archiveRecoveryAuthority(authorityCommand)).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.subscriptionClosureCommandReceipt.update({
          data: { payloadHash: generatedAuthorityReceipt.payloadHash },
          where: { id: generatedAuthorityReceipt.id }
        });
      });
      const generatedAuthorityEvent = await prisma.subscriptionClosureEvent.findFirstOrThrow({
        where: {
          closureCaseId: assessedCase.id,
          sourceKey: "recovery-authority:task-6-recovery-authority:generated"
        }
      });
      const generatedAuthorityAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          entityId: generatedAuthorityEvent.id,
          entityType: "subscription_closure_event",
          module: "subscription_closure"
        }
      });
      const assertArchiveMutation = (
        mutate: () => Promise<unknown>,
        restore: () => Promise<unknown>
      ) =>
        assertTask6ArchiveReplayMutationRejected(
          prisma,
          () => closure.archiveRecoveryAuthority(authorityCommand),
          mutate,
          restore,
          fixture,
          assessedCase.id
        );
      await assertArchiveMutation(
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureCommandReceipt.update({
              data: { payloadSnapshot: { drifted: true } },
              where: { id: generatedAuthorityReceipt.id }
            })
          ),
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureCommandReceipt.update({
              data: {
                payloadSnapshot: generatedAuthorityReceipt.payloadSnapshot as Prisma.InputJsonValue
              },
              where: { id: generatedAuthorityReceipt.id }
            })
          )
      );
      await assertArchiveMutation(
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureCommandReceipt.update({
              data: { outcomeSnapshot: { drifted: true } },
              where: { id: generatedAuthorityReceipt.id }
            })
          ),
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureCommandReceipt.update({
              data: {
                outcomeSnapshot: generatedAuthorityReceipt.outcomeSnapshot as Prisma.InputJsonValue
              },
              where: { id: generatedAuthorityReceipt.id }
            })
          )
      );
      await assertArchiveMutation(
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureCommandReceipt.delete({
              where: { id: generatedAuthorityReceipt.id }
            })
          ),
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureCommandReceipt.create({
              data: {
                actorId: generatedAuthorityReceipt.actorId,
                closureCaseId: generatedAuthorityReceipt.closureCaseId,
                commandType: generatedAuthorityReceipt.commandType,
                createdAt: generatedAuthorityReceipt.createdAt,
                eventId: generatedAuthorityReceipt.eventId,
                id: generatedAuthorityReceipt.id,
                outcomeSnapshot: generatedAuthorityReceipt.outcomeSnapshot as Prisma.InputJsonValue,
                payloadHash: generatedAuthorityReceipt.payloadHash,
                payloadSnapshot: generatedAuthorityReceipt.payloadSnapshot as Prisma.InputJsonValue,
                sourceId: generatedAuthorityReceipt.sourceId,
                sourceKey: generatedAuthorityReceipt.sourceKey,
                sourceType: generatedAuthorityReceipt.sourceType
              }
            })
          )
      );
      const extraReceiptId = randomUUID();
      await assertArchiveMutation(
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureCommandReceipt.create({
              data: {
                actorId: generatedAuthorityReceipt.actorId,
                closureCaseId: generatedAuthorityReceipt.closureCaseId,
                commandType: generatedAuthorityReceipt.commandType,
                eventId: randomUUID(),
                id: extraReceiptId,
                outcomeSnapshot: generatedAuthorityReceipt.outcomeSnapshot as Prisma.InputJsonValue,
                payloadHash: generatedAuthorityReceipt.payloadHash,
                payloadSnapshot: generatedAuthorityReceipt.payloadSnapshot as Prisma.InputJsonValue,
                sourceId: generatedAuthorityReceipt.sourceId,
                sourceKey: `${generatedAuthorityReceipt.sourceKey}:extra`,
                sourceType: generatedAuthorityReceipt.sourceType
              }
            })
          ),
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureCommandReceipt.delete({ where: { id: extraReceiptId } })
          )
      );
      await assertArchiveMutation(
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureEvent.update({
              data: { afterStatus: "RECOVERY_APPROVAL_PENDING" },
              where: { id: generatedAuthorityEvent.id }
            })
          ),
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureEvent.update({
              data: { afterStatus: generatedAuthorityEvent.afterStatus },
              where: { id: generatedAuthorityEvent.id }
            })
          )
      );
      await assertArchiveMutation(
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureEvent.delete({ where: { id: generatedAuthorityEvent.id } })
          ),
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureEvent.create({
              data: {
                actorId: generatedAuthorityEvent.actorId,
                afterStatus: generatedAuthorityEvent.afterStatus,
                beforeStatus: generatedAuthorityEvent.beforeStatus,
                closureCaseId: generatedAuthorityEvent.closureCaseId,
                detailSnapshot: generatedAuthorityEvent.detailSnapshot as Prisma.InputJsonValue,
                eventType: generatedAuthorityEvent.eventType,
                id: generatedAuthorityEvent.id,
                occurredAt: generatedAuthorityEvent.occurredAt,
                recordedAt: generatedAuthorityEvent.recordedAt,
                sequence: generatedAuthorityEvent.sequence,
                sourceId: generatedAuthorityEvent.sourceId,
                sourceKey: generatedAuthorityEvent.sourceKey,
                sourceType: generatedAuthorityEvent.sourceType
              }
            })
          )
      );
      const extraEventId = randomUUID();
      await assertArchiveMutation(
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureEvent.create({
              data: {
                actorId: generatedAuthorityEvent.actorId,
                afterStatus: generatedAuthorityEvent.afterStatus,
                beforeStatus: generatedAuthorityEvent.beforeStatus,
                closureCaseId: generatedAuthorityEvent.closureCaseId,
                detailSnapshot: generatedAuthorityEvent.detailSnapshot as Prisma.InputJsonValue,
                eventType: generatedAuthorityEvent.eventType,
                id: extraEventId,
                occurredAt: generatedAuthorityEvent.occurredAt,
                recordedAt: generatedAuthorityEvent.recordedAt,
                sequence: generatedAuthorityEvent.sequence + 100,
                sourceId: generatedAuthorityEvent.sourceId,
                sourceKey: `${generatedAuthorityEvent.sourceKey}:extra`,
                sourceType: generatedAuthorityEvent.sourceType
              }
            })
          ),
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.subscriptionClosureEvent.delete({ where: { id: extraEventId } })
          )
      );
      await assertArchiveMutation(
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.auditLog.update({
              data: { afterSnapshot: { drifted: true } },
              where: { id: generatedAuthorityAudit.id }
            })
          ),
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.auditLog.update({
              data: { afterSnapshot: generatedAuthorityAudit.afterSnapshot ?? Prisma.DbNull },
              where: { id: generatedAuthorityAudit.id }
            })
          )
      );
      await assertArchiveMutation(
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.auditLog.delete({ where: { id: generatedAuthorityAudit.id } })
          ),
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.auditLog.create({
              data: {
                action: generatedAuthorityAudit.action,
                afterSnapshot: generatedAuthorityAudit.afterSnapshot ?? Prisma.DbNull,
                beforeSnapshot: generatedAuthorityAudit.beforeSnapshot ?? Prisma.DbNull,
                createdAt: generatedAuthorityAudit.createdAt,
                entityId: generatedAuthorityAudit.entityId,
                entityType: generatedAuthorityAudit.entityType,
                id: generatedAuthorityAudit.id,
                ipAddress: generatedAuthorityAudit.ipAddress,
                module: generatedAuthorityAudit.module,
                operatorId: generatedAuthorityAudit.operatorId,
                userAgent: generatedAuthorityAudit.userAgent
              }
            })
          )
      );
      const extraAuditId = randomUUID();
      await assertArchiveMutation(
        () =>
          withTask6Replica(prisma, (tx) =>
            tx.auditLog.create({
              data: {
                action: generatedAuthorityAudit.action,
                afterSnapshot: generatedAuthorityAudit.afterSnapshot ?? Prisma.DbNull,
                beforeSnapshot: generatedAuthorityAudit.beforeSnapshot ?? Prisma.DbNull,
                entityId: generatedAuthorityAudit.entityId,
                entityType: generatedAuthorityAudit.entityType,
                id: extraAuditId,
                module: generatedAuthorityAudit.module,
                operatorId: generatedAuthorityAudit.operatorId
              }
            })
          ),
        () => withTask6Replica(prisma, (tx) => tx.auditLog.delete({ where: { id: extraAuditId } }))
      );
      await expect(
        closure.archiveRecoveryAuthority({ ...authorityCommand, actorId: requesterId })
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      await expect(
        closure.archiveRecoveryAuthority({
          ...authorityCommand,
          idempotencyKey: "task-6-recovery-authority-drift"
        })
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      const signedFileId = authority.signedFileId;
      const signedFileHash = authority.signedFileHash;
      await expect(
        prisma.subscriptionClosureDocumentRevision.findMany({
          orderBy: { revisionNumber: "asc" },
          select: {
            archivedAt: true,
            id: true,
            signedAt: true,
            stage: true,
            supersedesRevisionId: true
          },
          where: { closureCaseId: assessedCase.id, documentType: "RECOVERY_AUTHORITY" }
        })
      ).resolves.toEqual([
        expect.objectContaining({
          archivedAt: null,
          id: authority.generatedRevisionId,
          signedAt: null,
          stage: "GENERATED",
          supersedesRevisionId: null
        }),
        expect.objectContaining({
          archivedAt: null,
          id: authority.signedRevisionId,
          signedAt: expect.any(Date),
          stage: "SIGNED",
          supersedesRevisionId: authority.generatedRevisionId
        }),
        expect.objectContaining({
          archivedAt: expect.any(Date),
          id: authority.archivedRevisionId,
          signedAt: expect.any(Date),
          stage: "ARCHIVED",
          supersedesRevisionId: authority.signedRevisionId
        })
      ]);
      await expect(
        prisma.subscriptionClosureCurrentDocument.findUniqueOrThrow({
          where: {
            closureCaseId_documentType: {
              closureCaseId: assessedCase.id,
              documentType: "RECOVERY_AUTHORITY"
            }
          }
        })
      ).resolves.toMatchObject({ documentRevisionId: authority.archivedRevisionId });
      await expect(
        prisma.subscriptionClosureCommandReceipt.count({
          where: {
            closureCaseId: assessedCase.id,
            commandType: "CREATE_DOCUMENT_REVISION",
            payloadSnapshot: { path: ["documentType"], equals: "RECOVERY_AUTHORITY" }
          }
        })
      ).resolves.toBe(3);
      await expect(
        prisma.auditLog.count({
          where: {
            action: "CREATE",
            entityId: {
              in: (
                await prisma.subscriptionClosureEvent.findMany({
                  select: { id: true },
                  where: {
                    closureCaseId: assessedCase.id,
                    eventType: "DOCUMENT_REVISION_CREATED",
                    sourceKey: { startsWith: "recovery-authority:task-6-recovery-authority:" }
                  }
                })
              ).map(({ id }) => id)
            },
            entityType: "subscription_closure_event",
            operatorId: fixture.actorId
          }
        })
      ).resolves.toBe(3);

      const archivedAuthorityEvent = await prisma.subscriptionClosureEvent.findFirstOrThrow({
        orderBy: [{ sequence: "desc" }, { id: "desc" }],
        where: {
          closureCaseId: assessedCase.id,
          eventType: "DOCUMENT_REVISION_CREATED",
          sourceKey: "recovery-authority:task-6-recovery-authority:archived"
        }
      });
      await awaitDatabaseClockPast(prisma, archivedAuthorityEvent.occurredAt);
      const requestedAt = new Date(archivedAuthorityEvent.occurredAt.getTime() + 1);
      const requestCommand = {
        actorId: requesterId,
        closureCaseId: assessedCase.id,
        idempotencyKey: "task-6-request-approval",
        reason: "D+7 debt and uncontrolled vehicle require governed recovery",
        requestedAt
      };
      await assertTask6AuthorityMutationBoundaries(
        prisma,
        authorityLockTargets,
        () => closure.requestRecoveryExecutionApproval(requestCommand),
        fixture,
        assessedCase.id
      );
      const generatedAuthorityRevision =
        await prisma.subscriptionClosureDocumentRevision.findUniqueOrThrow({
          where: { id: authority.generatedRevisionId }
        });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.subscriptionClosureDocumentRevision.update({
          data: { sourceKey: `${generatedAuthorityRevision.sourceKey}:drift` },
          where: { id: generatedAuthorityRevision.id }
        });
      });
      await expect(
        closure.requestRecoveryExecutionApproval({
          actorId: requesterId,
          closureCaseId: assessedCase.id,
          idempotencyKey: "task-6-tampered-chain-request",
          reason: "must reject a tampered generated predecessor",
          requestedAt
        })
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.subscriptionClosureDocumentRevision.update({
          data: { sourceKey: generatedAuthorityRevision.sourceKey },
          where: { id: generatedAuthorityRevision.id }
        });
      });
      const archivedAuthorityRevision =
        await prisma.subscriptionClosureDocumentRevision.findUniqueOrThrow({
          where: { id: authority.archivedRevisionId }
        });
      const archiveESignTask = await prisma.contractESignTask.findUniqueOrThrow({
        where: { id: archivedAuthorityRevision.contractESignTaskId }
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.contractESignTask.update({
          data: { requestSnapshot: { tampered: true } },
          where: { id: archiveESignTask.id }
        });
      });
      await expect(
        closure.requestRecoveryExecutionApproval({
          actorId: requesterId,
          closureCaseId: assessedCase.id,
          idempotencyKey: "task-6-tampered-esign-request",
          reason: "must reject tampered eSign request coherence",
          requestedAt
        })
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.contractESignTask.update({
          data: { requestSnapshot: archiveESignTask.requestSnapshot as Prisma.InputJsonValue },
          where: { id: archiveESignTask.id }
        });
      });
      const requested = await closure.requestRecoveryExecutionApproval(requestCommand);
      const pendingApproval = await prisma.businessExceptionApproval.findUniqueOrThrow({
        where: { id: requested.approvalId }
      });
      await assertTask6AuthorityMutationBoundaries(
        prisma,
        authorityLockTargets,
        () => closure.requestRecoveryExecutionApproval(requestCommand),
        fixture,
        assessedCase.id
      );
      expect(pendingApproval.subjectSnapshot).toMatchObject({
        recoveryAssetWorkOrderId: plannedRecoveryAssetWorkOrderId,
        recoveryContextSnapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/)
      });
      const decidedAt = new Date(requestedAt.getTime() + 1);
      const decisionCommand = {
        actorId: fixture.actorId,
        approvalId: pendingApproval.id,
        closureCaseId: assessedCase.id,
        decision: "APPROVED",
        decisionComment: "Approved after independent administrator review",
        decidedAt,
        expectedApprovalVersion: pendingApproval.version,
        idempotencyKey: "task-6-decide-approval"
      } as const;
      await assertTask6AuthorityMutationBoundaries(
        prisma,
        authorityLockTargets,
        () => closure.decideRecoveryExecutionApproval(decisionCommand),
        fixture,
        assessedCase.id
      );
      const decided = await closure.decideRecoveryExecutionApproval(decisionCommand);
      expect(decided.status).toBe("RECOVERY_APPROVED");
      await assertTask6AuthorityMutationBoundaries(
        prisma,
        authorityLockTargets,
        () => closure.decideRecoveryExecutionApproval(decisionCommand),
        fixture,
        assessedCase.id
      );
      await expect(
        closure.decideRecoveryExecutionApproval({
          actorId: fixture.actorId,
          approvalId: pendingApproval.id,
          closureCaseId: assessedCase.id,
          decision: "APPROVED",
          decisionComment: "Approved after independent administrator review",
          decidedAt,
          expectedApprovalVersion: pendingApproval.version,
          idempotencyKey: "task-6-decide-approval"
        })
      ).resolves.toEqual({ ...decided, wrote: false });
      const approved = await prisma.businessExceptionApproval.findUniqueOrThrow({
        where: { id: pendingApproval.id }
      });
      const executionInput = {
        actorId: fixture.actorId,
        approvalId: approved.id,
        closureCaseId: assessedCase.id,
        expectedApprovalVersion: approved.version,
        idempotencyKey: "task-6-execute-recovery",
        occurredAt: new Date(requestedAt.getTime() + 2)
      };
      await assertTask6AuthorityMutationBoundaries(
        prisma,
        authorityLockTargets,
        () => closure.executeApprovedRecovery(executionInput),
        fixture,
        assessedCase.id
      );
      const holderBarrier = createBarrier();
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${assessedCase.id}::uuid FOR UPDATE`
        );
        holderBarrier.enter();
        await holderBarrier.released;
        return tx.$queryRaw<Array<{ usable: number }>>(Prisma.sql`SELECT 1 AS "usable"`);
      });
      await holderBarrier.entered;
      const busyExecution = await closure.executeApprovedRecovery(executionInput).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ reason, status: "rejected" as const })
      );
      holderBarrier.release();
      expect(busyExecution).toMatchObject({
        reason: {
          response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
          status: 409
        },
        status: "rejected"
      });
      await expect(holder).resolves.toEqual([{ usable: 1 }]);
      const rollbackBefore = await Promise.all([
        prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: assessedCase.id } }),
        prisma.businessExceptionApproval.findUniqueOrThrow({ where: { id: approved.id } }),
        prisma.assetWorkOrder.count({
          where: { orderId: fixture.orderId, workOrderType: "RECOVERY" }
        }),
        prisma.vehicleOperationalRestriction.count({
          where: { restrictionType: "RECOVERY_IN_PROGRESS", vehicleId: fixture.vehicleId }
        }),
        prisma.subscriptionClosureCommandReceipt.count({
          where: { closureCaseId: assessedCase.id }
        }),
        prisma.auditLog.count({ where: { operatorId: fixture.actorId } })
      ]);
      const failpointOperations = new Proxy(operations, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          if (property === "createPreparedRestrictionInTransaction") {
            return async () => {
              throw new Error("TASK6_FAILPOINT:after-recovery-work-order");
            };
          }
          return value.bind(target);
        }
      });
      const failpointClosure = new SubscriptionClosureService(
        new SubscriptionClosureRepository(),
        new HandoverWorkOrderService(prisma, {} as never),
        failpointOperations,
        audit,
        prisma,
        new AssetFactsService(prisma, new AssetFactsRepository(), audit),
        accounting,
        new VehicleMileageService(prisma, new VehicleMileageRepository())
      );
      await expect(failpointClosure.executeApprovedRecovery(executionInput)).rejects.toThrow(
        "TASK6_FAILPOINT:after-recovery-work-order"
      );
      await expect(
        Promise.all([
          prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: assessedCase.id } }),
          prisma.businessExceptionApproval.findUniqueOrThrow({ where: { id: approved.id } }),
          prisma.assetWorkOrder.count({
            where: { orderId: fixture.orderId, workOrderType: "RECOVERY" }
          }),
          prisma.vehicleOperationalRestriction.count({
            where: { restrictionType: "RECOVERY_IN_PROGRESS", vehicleId: fixture.vehicleId }
          }),
          prisma.subscriptionClosureCommandReceipt.count({
            where: { closureCaseId: assessedCase.id }
          }),
          prisma.auditLog.count({ where: { operatorId: fixture.actorId } })
        ])
      ).resolves.toEqual(rollbackBefore);
      const executed = await closure.executeApprovedRecovery(executionInput);
      await assertTask6AuthorityMutationBoundaries(
        prisma,
        authorityLockTargets,
        () => closure.executeApprovedRecovery(executionInput),
        fixture,
        assessedCase.id
      );
      await expect(closure.executeApprovedRecovery(executionInput)).resolves.toEqual({
        ...executed,
        wrote: false
      });
      await expect(
        closure.executeApprovedRecovery({
          ...executionInput,
          occurredAt: new Date(executionInput.occurredAt.getTime() + 1)
        })
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
        status: 409
      });
      expect(executed).toMatchObject({
        action: "RECOVERY_STARTED",
        recoveryAssetWorkOrderId: plannedRecoveryAssetWorkOrderId,
        wrote: true
      });
      await expect(
        closure.requestRecoveryExecutionApproval({
          actorId: requesterId,
          closureCaseId: assessedCase.id,
          idempotencyKey: "task-6-request-approval",
          reason: "D+7 debt and uncontrolled vehicle require governed recovery",
          requestedAt
        })
      ).resolves.toEqual({ ...requested, wrote: false });
      await expect(
        closure.decideRecoveryExecutionApproval({
          actorId: fixture.actorId,
          approvalId: pendingApproval.id,
          closureCaseId: assessedCase.id,
          decision: "APPROVED",
          decisionComment: "Approved after independent administrator review",
          decidedAt,
          expectedApprovalVersion: pendingApproval.version,
          idempotencyKey: "task-6-decide-approval"
        })
      ).resolves.toEqual({ ...decided, wrote: false });
      await expect(
        closure.requestRecoveryExecutionApproval({
          actorId: requesterId,
          closureCaseId: assessedCase.id,
          idempotencyKey: "task-6-request-approval",
          reason: "drifted request payload",
          requestedAt
        })
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
        status: 409
      });
      await expect(
        closure.decideRecoveryExecutionApproval({
          actorId: fixture.actorId,
          approvalId: pendingApproval.id,
          closureCaseId: assessedCase.id,
          decision: "REJECTED",
          decisionComment: "drifted decision payload",
          decidedAt,
          expectedApprovalVersion: pendingApproval.version,
          idempotencyKey: "task-6-decide-approval"
        })
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
        status: 409
      });
      await expect(
        prisma.assetWorkOrder.count({
          where: { orderId: fixture.orderId, workOrderType: "RECOVERY" }
        })
      ).resolves.toBe(1);
      await expect(
        prisma.vehicleOperationalRestriction.count({
          where: {
            restrictionType: "RECOVERY_IN_PROGRESS",
            status: "ACTIVE",
            vehicleId: fixture.vehicleId
          }
        })
      ).resolves.toBe(1);

      const evidenceAt = new Date(requestedAt.getTime() + 3);
      const executionRecord = {
        actorId: fixture.actorId,
        closureCaseId: assessedCase.id,
        costs: [
          {
            actionType: "ACTUAL_COST" as const,
            accountingPeriod: "2026-08",
            amountCents: 2500n,
            assetOwnerId: null,
            assetOwnerSnapshot: null,
            confirmedAt: evidenceAt,
            costCategory: "TOWING" as const,
            evidenceId: null,
            evidenceSnapshot: null,
            occurredOn: new Date("2026-08-22T00:00:00.000Z"),
            reason: "governed recovery towing",
            responsiblePartyId: fixture.customerId,
            responsiblePartyType: "CUSTOMER" as const,
            responsibilitySnapshot: { basis: "approved recovery" }
          }
        ],
        evidence: [
          {
            action: "ATTACH" as const,
            capturedAt: evidenceAt,
            captureMetadata: { station: "task-6-recovery-site" },
            contentSha256: signedFileHash,
            eventId: null,
            evidenceType: "LOCATION_PROOF" as const,
            fileId: signedFileId,
            occurredAt: evidenceAt,
            supersedesEvidenceId: null
          }
        ],
        idempotencyKey: "task-6-execution-record",
        occurredAt: evidenceAt
      };
      await assertTask6AuthorityMutationBoundaries(
        prisma,
        authorityLockTargets,
        () => closure.recordRecoveryExecution(executionRecord),
        fixture,
        assessedCase.id
      );
      await expect(closure.recordRecoveryExecution(executionRecord)).resolves.toEqual({
        costCount: 1,
        evidenceCount: 1,
        wrote: true
      });
      await assertTask6AuthorityMutationBoundaries(
        prisma,
        authorityLockTargets,
        () => closure.recordRecoveryExecution(executionRecord),
        fixture,
        assessedCase.id
      );
      await expect(closure.recordRecoveryExecution(executionRecord)).resolves.toEqual({
        costCount: 1,
        evidenceCount: 1,
        wrote: false
      });

      const returnedAt = new Date(requestedAt.getTime() + 4);
      const physicalReceipt = {
        actorId: fixture.actorId,
        checklist: {},
        damages: [],
        orderId: fixture.orderId,
        physicalControlMode: "RECOVERY" as const,
        remark: "Task 6 vehicle secured",
        returnMileageKm: 1400,
        returnType: "EARLY_TERMINATION" as const,
        returnedAt
      };
      await assertTask6AuthorityMutationBoundaries(
        prisma,
        authorityLockTargets,
        () => closure.confirmManagedPhysicalReceipt(physicalReceipt, {}),
        fixture,
        assessedCase.id
      );
      await expect(
        closure.confirmManagedPhysicalReceipt(physicalReceipt, {})
      ).resolves.toMatchObject({ vehicleReturnId: assessedCase.vehicleReturnId });
      await assertTask6AuthorityMutationBoundaries(
        prisma,
        authorityLockTargets,
        () => closure.confirmManagedPhysicalReceipt(physicalReceipt, {}),
        fixture,
        assessedCase.id
      );
      await expect(
        closure.confirmManagedPhysicalReceipt(physicalReceipt, {})
      ).resolves.toMatchObject({ vehicleReturnId: assessedCase.vehicleReturnId });
      await expect(
        prisma.vehicleSubscriptionPeriod.findFirstOrThrow({ where: { orderId: fixture.orderId } })
      ).resolves.toMatchObject({ endReason: "RECOVERY_CONFIRMED" });
      await expect(
        prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: assessedCase.id } })
      ).resolves.toMatchObject({
        closureType: "NORMAL_COMPLETION",
        finalDisposition: "TERMINATE",
        physicalControlMode: "RECOVERY",
        recoveryAssetWorkOrderId: plannedRecoveryAssetWorkOrderId,
        status: "RETURN_INSPECTION"
      });
      await expect(
        prisma.vehicleOperationalRestriction.findFirstOrThrow({
          where: {
            restrictionType: "RECOVERY_IN_PROGRESS",
            vehicleId: fixture.vehicleId
          }
        })
      ).resolves.toMatchObject({ status: "RELEASED" });
      await expect(
        prisma.vehicleOperationalRestriction.findFirstOrThrow({
          where: {
            restrictionType: "RETURN_INSPECTION_PENDING",
            vehicleId: fixture.vehicleId
          }
        })
      ).resolves.toMatchObject({ status: "ACTIVE" });
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
      await prisma.$executeRaw(Prisma.sql`DELETE FROM "user" WHERE "id" = ${requesterId}::uuid`);
    }
  }, 120_000);

  it.each(["PAYMENT", "DISPUTE", "APPROVED_EXTENSION", "VOLUNTARY_RETURN"] as const)(
    "expires and pauses physical recovery on post-execution %s drift without physical leakage",
    async (drift) => {
      const scenario = await setupTask6ExecutedRecovery(prisma);
      try {
        const finance = new FinanceService(new AuditService(prisma), prisma);
        const financeUser = {
          id: scenario.fixture.actorId,
          menus: [],
          name: "Task 6 administrator",
          permissions: [],
          roles: ["ADMIN"],
          username: `task6-admin-${scenario.fixture.actorId}`
        };
        if (drift === "PAYMENT") {
          await settleTask6Bill(prisma, finance, scenario.fixture, scenario.billId, 900n, 0);
        } else if (drift === "DISPUTE") {
          await finance.refreshOverdueBills({ asOfDate: "2026-08-22" }, financeUser, {
            ipAddress: "127.0.0.1",
            userAgent: "task-6-drift"
          });
          const collectionCase = await prisma.collectionCase.findFirstOrThrow({
            where: { caseStatus: "ACTIVE", orderId: scenario.fixture.orderId }
          });
          await finance.createCollectionAction(
            collectionCase.id,
            {
              actionResult: CollectionActionResult.DISPUTED,
              actionType: CollectionActionType.CUSTOMER_DISPUTE,
              contactMethod: ContactMethod.SYSTEM,
              content: "Customer disputed the recovery debt after execution evidence"
            },
            financeUser,
            { ipAddress: "127.0.0.1", userAgent: "task-6-drift" }
          );
        } else if (drift === "APPROVED_EXTENSION") {
          await prisma.subscriptionContractSegment.update({
            data: { status: "ACTIVE" },
            where: { id: scenario.fixture.segmentId }
          });
        } else {
          await prisma.vehicleReturn.update({
            data: {
              returnStatus: "CONFIRMED",
              returnedAt: new Date(scenario.receipt.returnedAt.getTime() - 1),
              updatedBy: scenario.fixture.actorId
            },
            where: { id: scenario.closureCase.vehicleReturnId! }
          });
        }

        const physicalBefore = await snapshotRecoveryPhysicalMutationSurface(
          prisma,
          scenario.fixture
        );
        await expect(
          scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {})
        ).resolves.toBeNull();
        await expect(
          snapshotRecoveryPhysicalMutationSurface(prisma, scenario.fixture)
        ).resolves.toEqual(physicalBefore);
        await expect(
          prisma.businessExceptionApproval.findUniqueOrThrow({
            where: { id: scenario.approvalId }
          })
        ).resolves.toMatchObject({ status: "EXPIRED" });
        await expect(
          prisma.subscriptionClosureCase.findUniqueOrThrow({
            where: { id: scenario.closureCase.id }
          })
        ).resolves.toMatchObject({
          recoveryAssetWorkOrderId: scenario.plannedRecoveryAssetWorkOrderId,
          status: "PAUSED"
        });
        await expect(
          prisma.subscriptionClosureEvent.findMany({
            where: {
              afterStatus: "PAUSED",
              closureCaseId: scenario.closureCase.id,
              sourceKey: "physical-receipt-drift:RECOVERY"
            }
          })
        ).resolves.toEqual([
          expect.objectContaining({
            detailSnapshot: expect.objectContaining({
              pausedFromStatus: "RECOVERY_IN_PROGRESS",
              physicalCommandFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
              reason: "RECOVERY_AUTHORITY_DRIFT"
            })
          })
        ]);
        await expect(
          prisma.subscriptionClosureCommandReceipt.count({
            where: {
              closureCaseId: scenario.closureCase.id,
              sourceKey: "physical-receipt:RECOVERY"
            }
          })
        ).resolves.toBe(0);

        const durableTruth = await snapshotPhysicalReturnTruth(prisma, scenario.fixture);
        await expect(
          scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {})
        ).resolves.toBeNull();
        await expect(snapshotPhysicalReturnTruth(prisma, scenario.fixture)).resolves.toEqual(
          durableTruth
        );
        await expect(
          scenario.closure.confirmManagedPhysicalReceipt(
            { ...scenario.receipt, remark: `${scenario.receipt.remark}:drift` },
            {}
          )
        ).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
          status: 409
        });
        await expect(snapshotPhysicalReturnTruth(prisma, scenario.fixture)).resolves.toEqual(
          durableTruth
        );
      } finally {
        await cleanupManagedExpiryFixture(prisma, scenario.fixture);
        await prisma.$executeRaw(
          Prisma.sql`DELETE FROM "user" WHERE "id" = ${scenario.requesterId}::uuid`
        );
      }
    },
    30_000
  );

  it("freezes the earliest overdue bill and cancels after all overdue debt settles despite a future bill", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const billIds = [randomUUID(), randomUUID(), randomUUID()];
    const futureBillId = randomUUID();
    try {
      const expiry = createGovernedExpiryService(prisma);
      await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      const audit = new AuditService(prisma);
      const accounting = new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
      const closure = new SubscriptionClosureService(
        new SubscriptionClosureRepository(),
        new HandoverWorkOrderService(prisma, {} as never),
        new AssetOperationsService(prisma, new AssetOperationsRepository(), audit, accounting),
        audit,
        prisma,
        new AssetFactsService(prisma, new AssetFactsRepository(), audit),
        accounting,
        new VehicleMileageService(prisma, new VehicleMileageRepository())
      );
      await runManagedPrepare(prisma, closure, fixture);
      const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { orderId: fixture.orderId }
      });
      const scheduledAt = new Date("2026-08-20T16:00:00.000Z");

      await expect(
        prisma.$transaction((tx) =>
          closure.scheduleRecoveryAssessmentInTransaction(tx, {
            closureCaseId: closureCase.id,
            orderId: fixture.orderId,
            scheduledAt
          })
        )
      ).resolves.toEqual({ scheduled: false });
      await prisma.receivableBill.createMany({
        data: [
          {
            amount: 100n,
            billNo: `BIL-TASK6-${billIds[0]}`,
            billStatus: "OVERDUE",
            billType: "MONTHLY_RENT",
            createdBy: fixture.actorId,
            customerId: fixture.customerId,
            dueDate: new Date("2026-08-05T00:00:00.000Z"),
            id: billIds[0],
            orderId: fixture.orderId,
            paidAmount: 0n,
            remainingAmount: 100n,
            snapshot: { fixture: "task-6-earliest" }
          },
          {
            amount: 200n,
            billNo: `BIL-TASK6-${billIds[1]}`,
            billStatus: "OVERDUE",
            billType: "MONTHLY_RENT",
            createdBy: fixture.actorId,
            customerId: fixture.customerId,
            dueDate: new Date("2026-08-10T00:00:00.000Z"),
            id: billIds[1],
            orderId: fixture.orderId,
            paidAmount: 0n,
            remainingAmount: 200n,
            snapshot: { fixture: "task-6-later" }
          },
          {
            amount: 300n,
            billNo: `BIL-TASK6-${futureBillId}`,
            billStatus: "PENDING",
            billType: "MONTHLY_RENT",
            createdBy: fixture.actorId,
            customerId: fixture.customerId,
            dueDate: new Date("2099-08-10T00:00:00.000Z"),
            id: futureBillId,
            orderId: fixture.orderId,
            paidAmount: 0n,
            remainingAmount: 300n,
            snapshot: { fixture: "task-6-future" }
          }
        ]
      });
      const scheduled = await prisma.$transaction((tx) =>
        closure.scheduleRecoveryAssessmentInTransaction(tx, {
          closureCaseId: closureCase.id,
          orderId: fixture.orderId,
          scheduledAt
        })
      );
      expect(scheduled).toMatchObject({
        availableAt: new Date("2026-08-11T16:00:00.000Z"),
        billId: billIds[0],
        dueDate: "2026-08-05T00:00:00.000Z",
        scheduled: true
      });
      if (!scheduled.scheduled) throw new Error("Expected recovery assessment job");
      await prisma.receivableBill.create({
        data: {
          amount: 50n,
          billNo: `BIL-TASK6-${billIds[2]}`,
          billStatus: "OVERDUE",
          billType: "MONTHLY_RENT",
          createdBy: fixture.actorId,
          customerId: fixture.customerId,
          dueDate: new Date("2026-08-01T00:00:00.000Z"),
          id: billIds[2],
          orderId: fixture.orderId,
          paidAmount: 0n,
          remainingAmount: 50n,
          snapshot: { fixture: "task-6-later-arrival" }
        }
      });
      await expect(
        prisma.$transaction((tx) =>
          closure.scheduleRecoveryAssessmentInTransaction(tx, {
            closureCaseId: closureCase.id,
            orderId: fixture.orderId,
            scheduledAt
          })
        )
      ).resolves.toEqual(scheduled);
      const assessmentInput = {
        actorId: fixture.actorId,
        closureCaseId: closureCase.id,
        governingBillId: billIds[0]!,
        governingDueDate: new Date("2026-08-05T00:00:00.000Z"),
        jobId: scheduled.jobId,
        jobKey: `closure-recovery-assessment:${closureCase.id}:D7`,
        orderId: fixture.orderId
      };

      const finance = new FinanceService(new AuditService(prisma), prisma);
      for (const [index, billId] of billIds.entries()) {
        const amount = [100n, 200n, 50n][index]!;
        await settleTask6Bill(prisma, finance, fixture, billId!, amount, index);
        await expect(
          prisma.subscriptionAutomationJob.findUniqueOrThrow({
            where: { id: scheduled.jobId }
          })
        ).resolves.toMatchObject({
          jobStatus: index === billIds.length - 1 ? "CANCELLED" : "PENDING"
        });
      }
      await expect(closure.assessRecoveryJob(assessmentInput)).resolves.toEqual({
        action: "NO_OP",
        reason: "OVERDUE_DEBT_SETTLED"
      });
      await expect(
        prisma.receivableBill.findUniqueOrThrow({ where: { id: futureBillId } })
      ).resolves.toMatchObject({ billStatus: "PENDING", remainingAmount: 300n });
      await expect(
        prisma.subscriptionClosureCase.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(1);
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  }, 30_000);

  it.each(["LIVE_DISPUTE", "APPROVED_EXTENSION"] as const)(
    "durably replays the first recovery assessment no-op for %s after the blocking fact clears",
    async (reason) => {
      const fixture = await createManagedExpiryFixture(prisma);
      const billId = randomUUID();
      const collectionCaseId = randomUUID();
      const collectionActionId = randomUUID();
      try {
        const expiry = createGovernedExpiryService(prisma);
        await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
        const { closure } = createTask6ClosureService(prisma);
        await runManagedPrepare(prisma, closure, fixture);
        const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
          where: { orderId: fixture.orderId }
        });
        await prisma.receivableBill.create({
          data: {
            amount: 900n,
            billNo: `BIL-TASK6-${billId}`,
            billStatus: "OVERDUE",
            billType: "MONTHLY_RENT",
            createdBy: fixture.actorId,
            customerId: fixture.customerId,
            dueDate: new Date("2026-08-05T00:00:00.000Z"),
            id: billId,
            orderId: fixture.orderId,
            paidAmount: 0n,
            remainingAmount: 900n
          }
        });
        const scheduled = await prisma.$transaction((tx) =>
          closure.scheduleRecoveryAssessmentInTransaction(tx, {
            closureCaseId: closureCase.id,
            orderId: fixture.orderId,
            scheduledAt: new Date("2026-08-20T16:00:00.000Z")
          })
        );
        if (!scheduled.scheduled) throw new Error("Expected recovery assessment job");

        if (reason === "LIVE_DISPUTE") {
          await prisma.collectionCase.create({
            data: {
              caseNo: `COL-TASK6-${collectionCaseId}`,
              caseStatus: "ACTIVE",
              collectionLevel: "D2",
              createdBy: fixture.actorId,
              customerId: fixture.customerId,
              id: collectionCaseId,
              latestDueDate: new Date("2026-08-05T00:00:00.000Z"),
              maxOverdueDays: 10,
              orderId: fixture.orderId,
              totalOverdueAmount: 900n
            }
          });
          await prisma.collectionAction.create({
            data: {
              actionResult: "DISPUTED",
              actionType: "CUSTOMER_DISPUTE",
              caseId: collectionCaseId,
              contactMethod: "SYSTEM",
              content: "Task 6 live dispute",
              createdBy: fixture.actorId,
              customerId: fixture.customerId,
              id: collectionActionId,
              orderId: fixture.orderId
            }
          });
        } else {
          await prisma.subscriptionContractSegment.update({
            data: { status: "ACTIVE" },
            where: { id: fixture.segmentId }
          });
        }

        const assessmentInput = {
          actorId: fixture.actorId,
          closureCaseId: closureCase.id,
          governingBillId: billId,
          governingDueDate: new Date("2026-08-05T00:00:00.000Z"),
          jobId: scheduled.jobId,
          jobKey: `closure-recovery-assessment:${closureCase.id}:D7`,
          orderId: fixture.orderId
        };
        await expect(closure.assessRecoveryJob(assessmentInput)).resolves.toEqual({
          action: "NO_OP",
          reason
        });

        if (reason === "LIVE_DISPUTE") {
          await prisma.collectionAction.delete({ where: { id: collectionActionId } });
          await prisma.collectionCase.delete({ where: { id: collectionCaseId } });
        } else {
          await prisma.subscriptionContractSegment.update({
            data: { status: "COMPLETED" },
            where: { id: fixture.segmentId }
          });
        }
        await expect(closure.assessRecoveryJob(assessmentInput)).resolves.toEqual({
          action: "NO_OP",
          reason
        });
        await expect(
          prisma.subscriptionClosureCommandReceipt.count({
            where: {
              closureCaseId: closureCase.id,
              sourceId: scheduled.jobId,
              sourceKey: assessmentInput.jobKey,
              sourceType: "CLOSURE_RECOVERY_ASSESSMENT_D7"
            }
          })
        ).resolves.toBe(1);
        await expect(
          prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCase.id } })
        ).resolves.toMatchObject({
          finalDisposition: "COMPLETE",
          physicalControlMode: "VOLUNTARY_RETURN",
          status: "PREPARING_RETURN"
        });
      } finally {
        await prisma.collectionAction.deleteMany({ where: { id: collectionActionId } });
        await prisma.collectionCaseBill.deleteMany({ where: { caseId: collectionCaseId } });
        await prisma.collectionCase.deleteMany({ where: { id: collectionCaseId } });
        await cleanupManagedExpiryFixture(prisma, fixture);
      }
    },
    30_000
  );

  it.each(["PAYMENT", "WRITEOFF", "DISPUTE"] as const)(
    "returns stable NOWAIT while a %s writer holds assessment authority, then persists the exact no-op",
    async (writerKind) => {
      const scenario = await setupTask6PendingAssessment(prisma);
      const barrier = createBarrier();
      try {
        const financeUser = {
          id: scenario.fixture.actorId,
          menus: [],
          name: "Task 6 administrator",
          permissions: [],
          roles: ["ADMIN"],
          username: `task6-admin-${scenario.fixture.actorId}`
        };
        const financeContext = { ipAddress: "127.0.0.1", userAgent: "task-6-race" };
        let writer: Promise<unknown>;
        if (writerKind === "PAYMENT") {
          const paymentOrderId = randomUUID();
          await prisma.paymentOrder.create({
            data: {
              amount: 900n,
              customerId: scenario.fixture.customerId,
              id: paymentOrderId,
              items: { create: { amount: 900n, billId: scenario.billId } },
              orderId: scenario.fixture.orderId,
              paidAmount: 0n,
              paymentChannel: "MOCK",
              paymentOrderNo: `PYO-TASK6-${paymentOrderId}`,
              paymentStatus: "PENDING",
              provider: "MOCK",
              providerTradeNo: `task6-race-${paymentOrderId}`
            }
          });
          const hooked = hookTransaction(prisma, "receivableBill", "update", barrier, "after");
          const finance = new FinanceService(new AuditService(hooked), hooked);
          const now = await prisma.$transaction((tx) => databaseNow(tx));
          writer = finance.settlePaymentOrder({
            operatorId: scenario.fixture.actorId,
            paidAmount: 900n,
            paidAt: new Date(now.getTime() - 1),
            paymentOrderId,
            providerTransactionId: `task6-race-provider-${paymentOrderId}`
          });
        } else if (writerKind === "WRITEOFF") {
          const finance = new FinanceService(new AuditService(prisma), prisma);
          const payment = await finance.createPayment(
            {
              customerId: scenario.fixture.customerId,
              orderId: scenario.fixture.orderId,
              payerAccount: "task-6-race",
              payerName: "Task 6 payer",
              paymentAmount: 900,
              paymentMethod: PaymentMethod.BANK_TRANSFER,
              paymentProofUrls: [],
              receivedAt: "2026-08-22T00:00:00.000Z",
              remark: "Task 6 race payment"
            },
            financeUser,
            financeContext
          );
          const hooked = hookTransaction(prisma, "receivableBill", "update", barrier, "after");
          writer = new FinanceService(new AuditService(hooked), hooked).writeOffPayment(
            payment.id,
            {
              items: [{ billId: scenario.billId, writeOffAmount: 900 }],
              remark: "Task 6 race write-off"
            },
            financeUser,
            financeContext
          );
        } else {
          const finance = new FinanceService(new AuditService(prisma), prisma);
          await finance.refreshOverdueBills(
            { asOfDate: "2026-08-22" },
            financeUser,
            financeContext
          );
          const collectionCase = await prisma.collectionCase.findFirstOrThrow({
            where: { caseStatus: "ACTIVE", orderId: scenario.fixture.orderId }
          });
          const hooked = hookTransaction(prisma, "collectionAction", "create", barrier, "after");
          writer = new FinanceService(new AuditService(hooked), hooked).createCollectionAction(
            collectionCase.id,
            {
              actionResult: CollectionActionResult.DISPUTED,
              actionType: CollectionActionType.CUSTOMER_DISPUTE,
              contactMethod: ContactMethod.SYSTEM,
              content: "Task 6 concurrent dispute"
            },
            financeUser,
            financeContext
          );
        }

        await barrier.entered;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await expect(
            scenario.closure.assessRecoveryJob(scenario.assessmentInput)
          ).rejects.toMatchObject({
            response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
            status: 409
          });
        }
        barrier.release();
        await expect(writer).resolves.toBeDefined();
        await expect(scenario.closure.assessRecoveryJob(scenario.assessmentInput)).resolves.toEqual(
          {
            action: "NO_OP",
            reason: writerKind === "DISPUTE" ? "LIVE_DISPUTE" : "OVERDUE_DEBT_SETTLED"
          }
        );
        await expect(scenario.closure.assessRecoveryJob(scenario.assessmentInput)).resolves.toEqual(
          {
            action: "NO_OP",
            reason: writerKind === "DISPUTE" ? "LIVE_DISPUTE" : "OVERDUE_DEBT_SETTLED"
          }
        );
        await expect(
          prisma.subscriptionClosureCase.findUniqueOrThrow({
            where: { id: scenario.closureCase.id }
          })
        ).resolves.toMatchObject({
          finalDisposition: "COMPLETE",
          physicalControlMode: "VOLUNTARY_RETURN",
          status: "PREPARING_RETURN"
        });
      } finally {
        barrier.release();
        await cleanupManagedExpiryFixture(prisma, scenario.fixture);
      }
    },
    30_000
  );

  it("returns stable NOWAIT while the production extension archive owns the empty-probe parent", async () => {
    const scenario = await setupTask6PendingAssessment(prisma);
    const barrier = createBarrier();
    try {
      const extension = await seedTask6ExtensionArchivePrerequisites(prisma, scenario.fixture);
      const hooked = hookTransaction(
        prisma,
        "subscriptionContractSegment",
        "create",
        barrier,
        "after"
      );
      const archive = new Stage3ExtensionArchiveService(hooked, new AuditService(prisma));
      const writer = archive.finalizeArchivedContract({
        completedAt: extension.completedAt,
        contractId: scenario.fixture.contractId,
        source: "CALLBACK",
        taskId: extension.taskId
      });
      await barrier.entered;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          scenario.closure.assessRecoveryJob(scenario.assessmentInput)
        ).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
          status: 409
        });
      }
      barrier.release();
      await expect(writer).resolves.toMatchObject({ outcome: "SCHEDULED" });
      await expect(scenario.closure.assessRecoveryJob(scenario.assessmentInput)).resolves.toEqual({
        action: "NO_OP",
        reason: "APPROVED_EXTENSION"
      });
      await expect(scenario.closure.assessRecoveryJob(scenario.assessmentInput)).resolves.toEqual({
        action: "NO_OP",
        reason: "APPROVED_EXTENSION"
      });
    } finally {
      barrier.release();
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  }, 30_000);

  it.each(["PAYMENT", "WRITEOFF", "DISPUTE", "APPROVED_EXTENSION"] as const)(
    "serializes a %s writer behind the assessment holder without changing the committed recovery decision",
    async (writerKind) => {
      const scenario = await setupTask6PendingAssessment(prisma);
      const barrier = createBarrier();
      const financeUser = {
        id: scenario.fixture.actorId,
        menus: [],
        name: "Task 6 administrator",
        permissions: [],
        roles: ["ADMIN"],
        username: `task6-admin-${scenario.fixture.actorId}`
      };
      const financeContext = { ipAddress: "127.0.0.1", userAgent: "task-6-race" };
      let paymentOrderId: string | null = null;
      let paymentId: string | null = null;
      let collectionCaseId: string | null = null;
      let extension: Awaited<ReturnType<typeof seedTask6ExtensionArchivePrerequisites>> | null =
        null;
      let assessment: Promise<unknown> | null = null;
      let writer: Promise<unknown> | null = null;
      try {
        if (writerKind === "PAYMENT") {
          paymentOrderId = randomUUID();
          await prisma.paymentOrder.create({
            data: {
              amount: 900n,
              customerId: scenario.fixture.customerId,
              id: paymentOrderId,
              items: { create: { amount: 900n, billId: scenario.billId } },
              orderId: scenario.fixture.orderId,
              paidAmount: 0n,
              paymentChannel: "MOCK",
              paymentOrderNo: `PYO-TASK6-${paymentOrderId}`,
              paymentStatus: "PENDING",
              provider: "MOCK",
              providerTradeNo: `task6-holder-${paymentOrderId}`
            }
          });
        } else if (writerKind === "WRITEOFF") {
          const payment = await new FinanceService(new AuditService(prisma), prisma).createPayment(
            {
              customerId: scenario.fixture.customerId,
              orderId: scenario.fixture.orderId,
              payerAccount: "task-6-holder",
              payerName: "Task 6 payer",
              paymentAmount: 900,
              paymentMethod: PaymentMethod.BANK_TRANSFER,
              paymentProofUrls: [],
              receivedAt: "2026-08-22T00:00:00.000Z",
              remark: "Task 6 assessment-holder payment"
            },
            financeUser,
            financeContext
          );
          paymentId = payment.id;
        } else if (writerKind === "DISPUTE") {
          const finance = new FinanceService(new AuditService(prisma), prisma);
          await finance.refreshOverdueBills(
            { asOfDate: "2026-08-22" },
            financeUser,
            financeContext
          );
          collectionCaseId = (
            await prisma.collectionCase.findFirstOrThrow({
              where: { caseStatus: "ACTIVE", orderId: scenario.fixture.orderId }
            })
          ).id;
        } else {
          extension = await seedTask6ExtensionArchivePrerequisites(prisma, scenario.fixture);
        }

        const hooked = hookTransaction(
          prisma,
          "subscriptionClosureCase",
          "update",
          barrier,
          "before"
        );
        assessment = createTask6ClosureService(hooked).closure.assessRecoveryJob(
          scenario.assessmentInput
        );
        await barrier.entered;

        if (writerKind === "PAYMENT") {
          const now = await prisma.$transaction((tx) => databaseNow(tx));
          writer = new FinanceService(new AuditService(prisma), prisma).settlePaymentOrder({
            operatorId: scenario.fixture.actorId,
            paidAmount: 900n,
            paidAt: new Date(now.getTime() - 1),
            paymentOrderId: paymentOrderId!,
            providerTransactionId: `task6-holder-provider-${paymentOrderId}`
          });
        } else if (writerKind === "WRITEOFF") {
          writer = new FinanceService(new AuditService(prisma), prisma).writeOffPayment(
            paymentId!,
            {
              items: [{ billId: scenario.billId, writeOffAmount: 900 }],
              remark: "Task 6 assessment-holder write-off"
            },
            financeUser,
            financeContext
          );
        } else if (writerKind === "DISPUTE") {
          writer = new FinanceService(new AuditService(prisma), prisma).createCollectionAction(
            collectionCaseId!,
            {
              actionResult: CollectionActionResult.DISPUTED,
              actionType: CollectionActionType.CUSTOMER_DISPUTE,
              contactMethod: ContactMethod.SYSTEM,
              content: "Task 6 assessment-holder dispute"
            },
            financeUser,
            financeContext
          );
        } else {
          writer = new Stage3ExtensionArchiveService(
            prisma,
            new AuditService(prisma)
          ).finalizeArchivedContract({
            completedAt: extension!.completedAt,
            contractId: scenario.fixture.contractId,
            source: "CALLBACK",
            taskId: extension!.taskId
          });
        }

        await waitForPostgresLockWait(prisma);
        barrier.release();
        await expect(assessment).resolves.toEqual({ action: "ASSESSED", wrote: true });
        await expect(writer).resolves.toBeDefined();
        await expect(scenario.closure.assessRecoveryJob(scenario.assessmentInput)).resolves.toEqual(
          {
            action: "ASSESSED",
            wrote: false
          }
        );
        await expect(
          prisma.subscriptionClosureCase.findUniqueOrThrow({
            where: { id: scenario.closureCase.id }
          })
        ).resolves.toMatchObject({
          finalDisposition: "TERMINATE",
          physicalControlMode: "RECOVERY",
          recoveryAssetWorkOrderId: null,
          status: "RECOVERY_ASSESSMENT_PENDING"
        });
        await expect(
          prisma.subscriptionAutomationJob.findUniqueOrThrow({
            where: { id: scenario.assessmentInput.jobId }
          })
        ).resolves.toMatchObject({
          jobStatus: writerKind === "PAYMENT" || writerKind === "WRITEOFF" ? "CANCELLED" : "PENDING"
        });
        await expect(
          prisma.businessExceptionApproval.count({
            where: { subjectId: scenario.closureCase.id, subjectType: "RECOVERY_CASE" }
          })
        ).resolves.toBe(0);
        await expect(
          prisma.assetWorkOrder.count({
            where: { orderId: scenario.fixture.orderId, workOrderType: "RECOVERY" }
          })
        ).resolves.toBe(0);

        if (writerKind === "PAYMENT" || writerKind === "WRITEOFF") {
          await expect(
            prisma.receivableBill.findUniqueOrThrow({ where: { id: scenario.billId } })
          ).resolves.toMatchObject({ billStatus: "PAID", remainingAmount: 0n });
        } else if (writerKind === "DISPUTE") {
          await expect(
            prisma.collectionAction.findFirstOrThrow({
              where: {
                actionResult: "DISPUTED",
                actionType: "CUSTOMER_DISPUTE",
                caseId: collectionCaseId!
              }
            })
          ).resolves.toMatchObject({ content: "Task 6 assessment-holder dispute" });
        } else {
          await expect(
            prisma.subscriptionContractSegment.findFirstOrThrow({
              where: {
                orderId: scenario.fixture.orderId,
                segmentType: "EXTENSION",
                status: "SCHEDULED"
              }
            })
          ).resolves.toBeDefined();
        }
        await expect(prisma.$queryRaw(Prisma.sql`SELECT 1 AS "usable"`)).resolves.toEqual([
          { usable: 1 }
        ]);
      } finally {
        barrier.release();
        await Promise.allSettled([assessment, writer].filter((value) => value !== null));
        await cleanupManagedExpiryFixture(prisma, scenario.fixture);
      }
    },
    30_000
  );

  it("persists PAUSED stage memory and resumes only the assessed recovery stage", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const billId = randomUUID();
    try {
      const expiry = createGovernedExpiryService(prisma);
      await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      const { closure } = createTask6ClosureService(prisma);
      await runManagedPrepare(prisma, closure, fixture);
      const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { orderId: fixture.orderId }
      });
      await prisma.receivableBill.create({
        data: {
          amount: 900n,
          billNo: `BIL-TASK6-${billId}`,
          billStatus: "OVERDUE",
          billType: "MONTHLY_RENT",
          createdBy: fixture.actorId,
          customerId: fixture.customerId,
          dueDate: new Date("2026-08-05T00:00:00.000Z"),
          id: billId,
          orderId: fixture.orderId,
          paidAmount: 0n,
          remainingAmount: 900n
        }
      });
      const scheduled = await prisma.$transaction((tx) =>
        closure.scheduleRecoveryAssessmentInTransaction(tx, {
          closureCaseId: closureCase.id,
          orderId: fixture.orderId,
          scheduledAt: new Date("2026-08-20T16:00:00.000Z")
        })
      );
      if (!scheduled.scheduled) throw new Error("Expected recovery assessment job");
      await closure.assessRecoveryJob({
        actorId: fixture.actorId,
        closureCaseId: closureCase.id,
        governingBillId: billId,
        governingDueDate: new Date("2026-08-05T00:00:00.000Z"),
        jobId: scheduled.jobId,
        jobKey: `closure-recovery-assessment:${closureCase.id}:D7`,
        orderId: fixture.orderId
      });
      const assessmentEvent = await prisma.subscriptionClosureEvent.findFirstOrThrow({
        where: { closureCaseId: closureCase.id, eventType: "RECOVERY_ESCALATED" }
      });
      await awaitDatabaseClockPast(prisma, assessmentEvent.occurredAt);
      const pause = {
        action: "PAUSE" as const,
        actorId: fixture.actorId,
        closureCaseId: closureCase.id,
        idempotencyKey: "task-6-pause-assessed",
        occurredAt: new Date(assessmentEvent.occurredAt.getTime() + 1),
        reason: "awaiting governed field confirmation"
      };
      await expect(closure.actOnRecovery(pause)).resolves.toEqual({
        action: "PAUSE",
        wrote: true
      });
      await expect(closure.actOnRecovery(pause)).resolves.toEqual({
        action: "PAUSE",
        wrote: false
      });
      await expect(
        prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCase.id } })
      ).resolves.toMatchObject({ status: "PAUSED" });
      await expect(
        prisma.subscriptionClosureEvent.findFirstOrThrow({
          where: {
            afterStatus: "PAUSED",
            closureCaseId: closureCase.id,
            sourceKey: "recovery-action:task-6-pause-assessed"
          }
        })
      ).resolves.toMatchObject({
        detailSnapshot: expect.objectContaining({
          pausedFromStatus: "RECOVERY_ASSESSMENT_PENDING",
          recoveryAction: "PAUSE"
        })
      });
      const resume = {
        action: "RESUME" as const,
        actorId: fixture.actorId,
        closureCaseId: closureCase.id,
        idempotencyKey: "task-6-resume-assessed",
        occurredAt: new Date(assessmentEvent.occurredAt.getTime() + 2),
        reason: "field confirmation received"
      };
      await expect(closure.actOnRecovery(resume)).resolves.toEqual({
        action: "RESUME",
        wrote: true
      });
      await expect(closure.actOnRecovery(resume)).resolves.toEqual({
        action: "RESUME",
        wrote: false
      });
      await expect(
        prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCase.id } })
      ).resolves.toMatchObject({ status: "RECOVERY_ASSESSMENT_PENDING" });
      await expect(
        prisma.subscriptionClosureEvent.findFirstOrThrow({
          where: {
            afterStatus: "RECOVERY_ASSESSMENT_PENDING",
            closureCaseId: closureCase.id,
            sourceKey: "recovery-action:task-6-resume-assessed"
          }
        })
      ).resolves.toMatchObject({
        detailSnapshot: expect.objectContaining({
          recoveryAction: "RESUME",
          resumedStage: "RECOVERY_ASSESSMENT_PENDING"
        })
      });
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  }, 30_000);

  it.each(["OVERDUE_BILL", "APPROVED_EXTENSION"] as const)(
    "expires a %s-drifted recovery approval into durable PAUSED with exact replay",
    async (drift) => {
      const fixture = await createManagedExpiryFixture(prisma);
      const governingBillId = randomUUID();
      const driftBillId = randomUUID();
      let requesterId: string | null = null;
      try {
        const expiry = createGovernedExpiryService(prisma);
        await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
        const { closure } = createTask6ClosureService(prisma);
        await runManagedPrepare(prisma, closure, fixture);
        const initialCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
          where: { orderId: fixture.orderId }
        });
        await prisma.receivableBill.create({
          data: {
            amount: 900n,
            billNo: `BIL-TASK6-${governingBillId}`,
            billStatus: "OVERDUE",
            billType: "MONTHLY_RENT",
            createdBy: fixture.actorId,
            customerId: fixture.customerId,
            dueDate: new Date("2026-08-05T00:00:00.000Z"),
            id: governingBillId,
            orderId: fixture.orderId,
            paidAmount: 0n,
            remainingAmount: 900n
          }
        });
        const scheduled = await prisma.$transaction((tx) =>
          closure.scheduleRecoveryAssessmentInTransaction(tx, {
            closureCaseId: initialCase.id,
            orderId: fixture.orderId,
            scheduledAt: new Date("2026-08-20T16:00:00.000Z")
          })
        );
        if (!scheduled.scheduled) throw new Error("Expected recovery assessment job");
        await closure.assessRecoveryJob({
          actorId: fixture.actorId,
          closureCaseId: initialCase.id,
          governingBillId,
          governingDueDate: new Date("2026-08-05T00:00:00.000Z"),
          jobId: scheduled.jobId,
          jobKey: `closure-recovery-assessment:${initialCase.id}:D7`,
          orderId: fixture.orderId
        });
        const assessedCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
          where: { id: initialCase.id }
        });
        const assessmentEvent = await prisma.subscriptionClosureEvent.findFirstOrThrow({
          where: { closureCaseId: assessedCase.id, eventType: "RECOVERY_ESCALATED" }
        });
        const assessmentDetail = assessmentEvent.detailSnapshot as Prisma.JsonObject;
        const plannedRecoveryAssetWorkOrderId = String(
          assessmentDetail.plannedRecoveryAssetWorkOrderId
        );
        requesterId = randomUUID();
        const authority = await seedTask6RecoveryApproval(
          prisma,
          fixture,
          closure,
          assessedCase,
          requesterId,
          plannedRecoveryAssetWorkOrderId
        );
        if (drift === "OVERDUE_BILL") {
          await prisma.receivableBill.create({
            data: {
              amount: 100n,
              billNo: `BIL-TASK6-${driftBillId}`,
              billStatus: "OVERDUE",
              billType: "OTHER",
              createdBy: fixture.actorId,
              customerId: fixture.customerId,
              dueDate: new Date("2026-08-06T00:00:00.000Z"),
              id: driftBillId,
              orderId: fixture.orderId,
              paidAmount: 0n,
              remainingAmount: 100n,
              snapshot: { factDrift: true }
            }
          });
        } else {
          await prisma.subscriptionContractSegment.update({
            data: { status: "ACTIVE" },
            where: { id: fixture.segmentId }
          });
        }
        const command = {
          actorId: fixture.actorId,
          approvalId: authority.approval.id,
          closureCaseId: assessedCase.id,
          expectedApprovalVersion: authority.approval.version,
          idempotencyKey: "task-6-stale-execution",
          occurredAt: authority.executeAt
        };

        await expect(closure.executeApprovedRecovery(command)).resolves.toEqual({
          action: "APPROVAL_EXPIRED",
          wrote: true
        });
        await expect(closure.executeApprovedRecovery(command)).resolves.toEqual({
          action: "APPROVAL_EXPIRED",
          wrote: false
        });
        await expect(
          closure.executeApprovedRecovery({
            ...command,
            occurredAt: new Date(command.occurredAt.getTime() + 1)
          })
        ).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
          status: 409
        });
        await expect(
          prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: assessedCase.id } })
        ).resolves.toMatchObject({
          recoveryAssetWorkOrderId: null,
          status: "PAUSED"
        });
        await expect(
          prisma.businessExceptionApproval.findUniqueOrThrow({
            where: { id: authority.approval.id }
          })
        ).resolves.toMatchObject({ status: "EXPIRED" });
        await expect(
          prisma.subscriptionClosureEvent.findMany({
            where: {
              afterStatus: "PAUSED",
              closureCaseId: assessedCase.id,
              sourceKey: "recovery-approval-stale-state:task-6-stale-execution"
            }
          })
        ).resolves.toHaveLength(1);
        await expect(
          prisma.assetWorkOrder.count({
            where: { id: plannedRecoveryAssetWorkOrderId, workOrderType: "RECOVERY" }
          })
        ).resolves.toBe(0);
        await expect(
          prisma.vehicleOperationalRestriction.count({
            where: { restrictionType: "RECOVERY_IN_PROGRESS", vehicleId: fixture.vehicleId }
          })
        ).resolves.toBe(0);
      } finally {
        await cleanupManagedExpiryFixture(prisma, fixture);
        if (requesterId) {
          await prisma.$executeRaw(
            Prisma.sql`DELETE FROM "user" WHERE "id" = ${requesterId}::uuid`
          );
        }
      }
    },
    30_000
  );

  it.each(["voluntary-first", "assessment-first"] as const)(
    "converges the recovery assessment/voluntary race when %s holds the authority rows",
    async (winner) => {
      const scenario = await setupFocusedPhysicalReceipt(prisma);
      const billId = randomUUID();
      const barrier = createBarrier();
      try {
        await prisma.receivableBill.create({
          data: {
            amount: 900n,
            billNo: `BIL-TASK6-${billId}`,
            billStatus: "OVERDUE",
            billType: "MONTHLY_RENT",
            createdBy: scenario.fixture.actorId,
            customerId: scenario.fixture.customerId,
            dueDate: new Date("2026-08-05T00:00:00.000Z"),
            id: billId,
            orderId: scenario.fixture.orderId,
            paidAmount: 0n,
            remainingAmount: 900n
          }
        });
        const scheduled = await prisma.$transaction((tx) =>
          scenario.closure.scheduleRecoveryAssessmentInTransaction(tx, {
            closureCaseId: scenario.closureCase.id,
            orderId: scenario.fixture.orderId,
            scheduledAt: new Date("2026-08-20T16:00:00.000Z")
          })
        );
        if (!scheduled.scheduled) throw new Error("Expected recovery assessment job");
        const assessmentInput = {
          actorId: scenario.fixture.actorId,
          closureCaseId: scenario.closureCase.id,
          governingBillId: billId,
          governingDueDate: new Date("2026-08-05T00:00:00.000Z"),
          jobId: scheduled.jobId,
          jobKey: `closure-recovery-assessment:${scenario.closureCase.id}:D7`,
          orderId: scenario.fixture.orderId
        };

        if (winner === "voluntary-first") {
          const hooked = hookTransaction(prisma, "vehicleReturn", "update", barrier, "after");
          const voluntaryClosure = createTask6ClosureService(hooked).closure;
          const voluntary = voluntaryClosure.confirmManagedPhysicalReceipt(scenario.receipt, {});
          await barrier.entered;
          const contender = createTask6ClosureService(prisma).closure;
          await expect(contender.assessRecoveryJob(assessmentInput)).rejects.toMatchObject({
            response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
            status: 409
          });
          barrier.release();
          await expect(voluntary).resolves.toMatchObject({
            vehicleReturnId: scenario.closureCase.vehicleReturnId
          });
          await expect(contender.assessRecoveryJob(assessmentInput)).resolves.toEqual({
            action: "NO_OP",
            reason: "VOLUNTARY_RETURNED"
          });
          await expect(
            prisma.subscriptionClosureCase.findUniqueOrThrow({
              where: { id: scenario.closureCase.id }
            })
          ).resolves.toMatchObject({
            physicalControlMode: "VOLUNTARY_RETURN",
            status: "RETURN_INSPECTION"
          });
        } else {
          const hooked = hookTransaction(
            prisma,
            "subscriptionClosureCase",
            "update",
            barrier,
            "after"
          );
          const assessmentClosure = createTask6ClosureService(hooked).closure;
          const assessment = assessmentClosure.assessRecoveryJob(assessmentInput);
          await barrier.entered;
          await expect(
            scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {})
          ).rejects.toMatchObject({
            response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
            status: 409
          });
          barrier.release();
          await expect(assessment).resolves.toEqual({ action: "ASSESSED", wrote: true });
          await expect(
            scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {})
          ).rejects.toMatchObject({
            response: { code: "SUBSCRIPTION_CLOSURE_MANAGED_RETURN_AUTHORITY_NOT_FOUND" },
            status: 409
          });
          await expect(
            prisma.subscriptionClosureCase.findUniqueOrThrow({
              where: { id: scenario.closureCase.id }
            })
          ).resolves.toMatchObject({
            physicalControlMode: "RECOVERY",
            status: "RECOVERY_ASSESSMENT_PENDING"
          });
        }
        await expect(
          prisma.subscriptionClosureCase.count({ where: { orderId: scenario.fixture.orderId } })
        ).resolves.toBe(1);
      } finally {
        barrier.release();
        await cleanupManagedExpiryFixture(prisma, scenario.fixture);
      }
    },
    30_000
  );

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
    preparedNormalExpiryVehicleReturnId: vi.fn(() => randomUUID()),
    scheduleRecoveryAssessmentInTransaction: vi.fn(async () => ({ scheduled: false }))
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

function createTask6ClosureService(prisma: PrismaService) {
  const audit = new AuditService(prisma);
  const accounting = new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
  const operations = new AssetOperationsService(
    prisma,
    new AssetOperationsRepository(),
    audit,
    accounting
  );
  return {
    accounting,
    audit,
    closure: new SubscriptionClosureService(
      new SubscriptionClosureRepository(),
      new HandoverWorkOrderService(prisma, {} as never),
      operations,
      audit,
      prisma,
      new AssetFactsService(prisma, new AssetFactsRepository(), audit),
      accounting,
      new VehicleMileageService(prisma, new VehicleMileageRepository())
    ),
    operations
  };
}

async function seedTask6RecoveryApproval(
  prisma: PrismaService,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>,
  closure: SubscriptionClosureService,
  assessedCase: Readonly<{
    caseNo: string;
    contractId: string;
    customerId: string;
    id: string;
    vehicleReturnId: string | null;
  }>,
  requesterId: string,
  plannedRecoveryAssetWorkOrderId: string
) {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "user" ("id", "username", "name", "password_hash", "status", "created_at", "updated_at")
    VALUES (${requesterId}::uuid, ${`task6-requester-${requesterId}`}, 'Task 6 requester', 'not-used', 'ACTIVE', clock_timestamp(), clock_timestamp())
  `);
  const authority = await closure.archiveRecoveryAuthority({
    actorId: fixture.actorId,
    closureCaseId: assessedCase.id,
    idempotencyKey: `task-6-recovery-authority:${assessedCase.id}`
  });
  const archivedEvent = await prisma.subscriptionClosureEvent.findFirstOrThrow({
    orderBy: [{ sequence: "desc" }, { id: "desc" }],
    where: {
      closureCaseId: assessedCase.id,
      eventType: "DOCUMENT_REVISION_CREATED",
      sourceKey: { endsWith: ":archived" }
    }
  });
  await awaitDatabaseClockPast(prisma, archivedEvent.occurredAt);
  const requestedAt = new Date(archivedEvent.occurredAt.getTime() + 1);
  const requested = await closure.requestRecoveryExecutionApproval({
    actorId: requesterId,
    closureCaseId: assessedCase.id,
    idempotencyKey: `task-6-request-approval:${authority.archivedRevisionId}`,
    reason: "D+7 debt and uncontrolled vehicle require governed recovery",
    requestedAt
  });
  const pendingApproval = await prisma.businessExceptionApproval.findUniqueOrThrow({
    where: { id: requested.approvalId }
  });
  await closure.decideRecoveryExecutionApproval({
    actorId: fixture.actorId,
    approvalId: pendingApproval.id,
    closureCaseId: assessedCase.id,
    decision: "APPROVED",
    decisionComment: "Approved after independent administrator review",
    decidedAt: new Date(requestedAt.getTime() + 1),
    expectedApprovalVersion: pendingApproval.version,
    idempotencyKey: `task-6-decide-approval:${authority.archivedRevisionId}`
  });
  const archivedRevision = await prisma.subscriptionClosureDocumentRevision.findUniqueOrThrow({
    where: { id: authority.archivedRevisionId }
  });
  expect(archivedRevision.documentSnapshot).toMatchObject({
    recoveryAssetWorkOrderId: plannedRecoveryAssetWorkOrderId
  });
  return {
    approval: await prisma.businessExceptionApproval.findUniqueOrThrow({
      where: { id: pendingApproval.id }
    }),
    authority,
    executeAt: new Date(requestedAt.getTime() + 2)
  };
}

async function setupTask6ExecutedRecovery(prisma: PrismaService) {
  const fixture = await createManagedExpiryFixture(prisma);
  const billId = randomUUID();
  let requesterId: string | null = null;
  try {
    await createGovernedExpiryService(prisma).expireSegment(
      fixture.segmentId,
      new Date("2026-08-20T16:00:00.000Z")
    );
    const { closure } = createTask6ClosureService(prisma);
    await runManagedPrepare(prisma, closure, fixture);
    await prisma.vehicleSubscriptionPeriod.create({
      data: {
        contractId: fixture.contractId,
        contractSegmentId: fixture.segmentId,
        createdBy: fixture.actorId,
        customerId: fixture.customerId,
        orderId: fixture.orderId,
        startConfirmedAt: new Date("2026-03-03T02:00:00.000Z"),
        startConfirmedBy: fixture.actorId,
        startReason: "DELIVERY_CONFIRMED",
        startSnapshot: { fixture: "task-6-physical-drift" },
        startSourceId: fixture.orderId,
        startSourceKey: "task-6-physical-drift-open-subscription",
        startSourceType: "TASK6_TEST",
        startedAt: new Date("2026-03-03T02:00:00.000Z"),
        vehicleId: fixture.vehicleId
      }
    });
    const initialCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
      where: { orderId: fixture.orderId }
    });
    await prisma.receivableBill.create({
      data: {
        amount: 900n,
        billNo: `BIL-TASK6-${billId}`,
        billStatus: "OVERDUE",
        billType: "MONTHLY_RENT",
        createdBy: fixture.actorId,
        customerId: fixture.customerId,
        dueDate: new Date("2026-08-05T00:00:00.000Z"),
        id: billId,
        orderId: fixture.orderId,
        paidAmount: 0n,
        remainingAmount: 900n,
        snapshot: { fixture: "task-6-physical-drift" }
      }
    });
    const scheduled = await prisma.$transaction((tx) =>
      closure.scheduleRecoveryAssessmentInTransaction(tx, {
        closureCaseId: initialCase.id,
        orderId: fixture.orderId,
        scheduledAt: new Date("2026-08-20T16:00:00.000Z")
      })
    );
    if (!scheduled.scheduled) throw new Error("Expected recovery assessment job");
    await closure.assessRecoveryJob({
      actorId: fixture.actorId,
      closureCaseId: initialCase.id,
      governingBillId: billId,
      governingDueDate: new Date("2026-08-05T00:00:00.000Z"),
      jobId: scheduled.jobId,
      jobKey: `closure-recovery-assessment:${initialCase.id}:D7`,
      orderId: fixture.orderId
    });
    const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
      where: { id: initialCase.id }
    });
    const assessmentEvent = await prisma.subscriptionClosureEvent.findFirstOrThrow({
      where: { closureCaseId: closureCase.id, eventType: "RECOVERY_ESCALATED" }
    });
    const plannedRecoveryAssetWorkOrderId = String(
      (assessmentEvent.detailSnapshot as Prisma.JsonObject).plannedRecoveryAssetWorkOrderId
    );
    requesterId = randomUUID();
    const approved = await seedTask6RecoveryApproval(
      prisma,
      fixture,
      closure,
      closureCase,
      requesterId,
      plannedRecoveryAssetWorkOrderId
    );
    await closure.executeApprovedRecovery({
      actorId: fixture.actorId,
      approvalId: approved.approval.id,
      closureCaseId: closureCase.id,
      expectedApprovalVersion: approved.approval.version,
      idempotencyKey: `task-6-physical-drift-execute:${closureCase.id}`,
      occurredAt: approved.executeAt
    });
    const evidenceAt = new Date(approved.executeAt.getTime() + 1);
    await closure.recordRecoveryExecution({
      actorId: fixture.actorId,
      closureCaseId: closureCase.id,
      costs: [],
      evidence: [
        {
          action: "ATTACH",
          capturedAt: evidenceAt,
          captureMetadata: { fixture: "task-6-physical-drift" },
          contentSha256: approved.authority.signedFileHash,
          eventId: null,
          evidenceType: "LOCATION_PROOF",
          fileId: approved.authority.signedFileId,
          occurredAt: evidenceAt,
          supersedesEvidenceId: null
        }
      ],
      idempotencyKey: `task-6-physical-drift-evidence:${closureCase.id}`,
      occurredAt: evidenceAt
    });
    return {
      approvalId: approved.approval.id,
      billId,
      closure,
      closureCase,
      fixture,
      plannedRecoveryAssetWorkOrderId,
      receipt: {
        actorId: fixture.actorId,
        checklist: {},
        damages: [],
        orderId: fixture.orderId,
        physicalControlMode: "RECOVERY" as const,
        remark: "Task 6 post-execution physical receipt",
        returnMileageKm: 1500,
        returnType: "EARLY_TERMINATION" as const,
        returnedAt: new Date(evidenceAt.getTime() + 1)
      },
      requesterId
    };
  } catch (error) {
    await cleanupManagedExpiryFixture(prisma, fixture);
    if (requesterId) {
      await prisma.$executeRaw(Prisma.sql`DELETE FROM "user" WHERE "id" = ${requesterId}::uuid`);
    }
    throw error;
  }
}

async function setupTask6PendingAssessment(prisma: PrismaService) {
  const fixture = await createManagedExpiryFixture(prisma);
  const billId = randomUUID();
  try {
    await createGovernedExpiryService(prisma).expireSegment(
      fixture.segmentId,
      new Date("2026-08-20T16:00:00.000Z")
    );
    const { closure } = createTask6ClosureService(prisma);
    await runManagedPrepare(prisma, closure, fixture);
    const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
      where: { orderId: fixture.orderId }
    });
    await prisma.receivableBill.create({
      data: {
        amount: 900n,
        billNo: `BIL-TASK6-RACE-${billId}`,
        billStatus: "OVERDUE",
        billType: "MONTHLY_RENT",
        createdBy: fixture.actorId,
        customerId: fixture.customerId,
        dueDate: new Date("2026-08-05T00:00:00.000Z"),
        id: billId,
        orderId: fixture.orderId,
        paidAmount: 0n,
        remainingAmount: 900n,
        snapshot: { fixture: "task-6-assessment-race" }
      }
    });
    const scheduled = await prisma.$transaction((tx) =>
      closure.scheduleRecoveryAssessmentInTransaction(tx, {
        closureCaseId: closureCase.id,
        orderId: fixture.orderId,
        scheduledAt: new Date("2026-08-20T16:00:00.000Z")
      })
    );
    if (!scheduled.scheduled) throw new Error("Expected recovery assessment job");
    return {
      assessmentInput: {
        actorId: fixture.actorId,
        closureCaseId: closureCase.id,
        governingBillId: billId,
        governingDueDate: new Date("2026-08-05T00:00:00.000Z"),
        jobId: scheduled.jobId,
        jobKey: `closure-recovery-assessment:${closureCase.id}:D7`,
        orderId: fixture.orderId
      },
      billId,
      closure,
      closureCase,
      fixture
    };
  } catch (error) {
    await cleanupManagedExpiryFixture(prisma, fixture);
    throw error;
  }
}

async function seedTask6ExtensionArchivePrerequisites(
  prisma: PrismaService,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>
) {
  const changeId = randomUUID();
  const considerationId = randomUUID();
  const quoteId = randomUUID();
  const taskId = randomUUID();
  const completedAt = new Date("2026-08-22T00:00:00.000Z");
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "renewal_consideration" (
        "id", "consideration_no", "order_id", "segment_id", "status",
        "consideration_start_at", "completion_deadline_at", "created_at", "updated_at"
      ) VALUES (
        ${considerationId}::uuid,
        ${`RCNTASK6${considerationId.replaceAll("-", "").slice(0, 18)}`},
        ${fixture.orderId}::uuid,
        ${fixture.segmentId}::uuid,
        'EXTENSION_IN_PROGRESS',
        '2026-08-03T00:00:00Z'::timestamptz,
        '2026-08-30T00:00:00Z'::timestamptz,
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_change_order" (
        "id", "change_no", "order_id", "status", "source_segment_id",
        "renewal_consideration_id", "extension_months", "pricing_mode", "contract_id",
        "target_start_date", "target_end_date", "completion_deadline_at", "created_at", "updated_at"
      ) VALUES (
        ${changeId}::uuid,
        ${`CHGTASK6${changeId.replaceAll("-", "").slice(0, 18)}`},
        ${fixture.orderId}::uuid,
        'SIGNING_OR_PAYMENT',
        ${fixture.segmentId}::uuid,
        ${considerationId}::uuid,
        6,
        'CURRENT_VERSION',
        ${fixture.contractId}::uuid,
        '2026-08-21'::date,
        '2027-02-20'::date,
        '2026-08-30T00:00:00Z'::timestamptz,
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_change_quote" (
        "id", "quote_no", "change_order_id", "revision", "status", "pricing_mode",
        "monthly_fee_amount", "deposit_amount", "mileage_limit_km", "over_mileage_fee_amount",
        "plan_snapshot", "price_rule_snapshot", "quote_snapshot", "valid_until",
        "formalized_at", "confirmed_at", "created_at"
      ) VALUES (
        ${quoteId}::uuid,
        ${`QUOTASK6${quoteId.replaceAll("-", "").slice(0, 18)}`},
        ${changeId}::uuid,
        1,
        'CUSTOMER_CONFIRMED',
        'CURRENT_VERSION',
        100,
        0,
        1500,
        100,
        '{}'::jsonb,
        '{}'::jsonb,
        '{}'::jsonb,
        '2026-08-30T00:00:00Z'::timestamptz,
        clock_timestamp(),
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_change_order"
      SET "current_quote_id" = ${quoteId}::uuid, "confirmed_quote_id" = ${quoteId}::uuid
      WHERE "id" = ${changeId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "renewal_consideration"
      SET "change_order_id" = ${changeId}::uuid
      WHERE "id" = ${considerationId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "contract_esign_task" (
        "id", "task_no", "contract_id", "order_id", "customer_id", "provider",
        "signing_stage", "document_type", "task_status", "signed_document_object_key",
        "completed_at", "created_at", "updated_at"
      ) VALUES (
        ${taskId}::uuid,
        ${`ESGTASK6${taskId.replaceAll("-", "").slice(0, 18)}`},
        ${fixture.contractId}::uuid,
        ${fixture.orderId}::uuid,
        ${fixture.customerId}::uuid,
        ${ESignProviderType.MOCK}::esign_provider_type,
        ${ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION}::esign_signing_stage,
        ${ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT}::esign_document_type,
        ${ESignTaskStatus.COMPLETED}::esign_task_status,
        'signed/task-6-extension-race.pdf',
        ${completedAt},
        clock_timestamp(),
        clock_timestamp()
      )
    `);
  });
  return { completedAt, taskId };
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

async function awaitDatabaseClockPast(prisma: PrismaService, occurredAt: Date) {
  const requiredDatabaseTime = occurredAt.getTime() + 2_000;
  const deadline = Date.now() + 10_000;
  while (true) {
    const current = await prisma.$transaction((tx) => databaseNow(tx));
    if (current.getTime() >= requiredDatabaseTime) return;
    if (Date.now() >= deadline) throw new Error("Database clock did not pass fixture event time");
  }
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

async function setupFocusedPhysicalReceipt(prisma: PrismaService) {
  const fixture = await createManagedExpiryFixture(prisma);
  const checklist = {
    batteryCheckedConfirmed: true,
    chargingEquipmentReturnedConfirmed: true,
    customerItemsClearedConfirmed: true,
    damageFound: true,
    exteriorCheckedConfirmed: true,
    interiorCheckedConfirmed: true,
    keysReturnedConfirmed: true,
    mileageConfirmed: true,
    vehicleDocumentsReturnedConfirmed: true,
    violationCheckedConfirmed: true
  };
  const expiry = createGovernedExpiryService(prisma);
  await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
  await runManagedPrepare(prisma, createGovernedClosureService(prisma), fixture);
  const occurredAt = (
    await prisma.subscriptionClosureEvent.findFirstOrThrow({
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      where: { closureCase: { orderId: fixture.orderId } }
    })
  ).occurredAt;
  await prisma.vehicleSubscriptionPeriod.create({
    data: {
      contractId: fixture.contractId,
      contractSegmentId: fixture.segmentId,
      createdBy: fixture.actorId,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      startConfirmedAt: new Date("2026-03-03T02:00:00.000Z"),
      startConfirmedBy: fixture.actorId,
      startReason: "DELIVERY_CONFIRMED",
      startSnapshot: { fixture: "task-4-focused" },
      startSourceId: fixture.orderId,
      startSourceKey: "task-4-focused-open-subscription",
      startSourceType: "TASK4_TEST",
      startedAt: new Date("2026-03-03T02:00:00.000Z"),
      vehicleId: fixture.vehicleId
    }
  });
  const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
    where: { orderId: fixture.orderId }
  });
  const revisionOne = await prisma.subscriptionClosureDocumentRevision.findFirstOrThrow({
    where: { closureCaseId: closureCase.id, documentType: "RETURN_MANIFEST" }
  });
  const checklistHash = createHash("sha256")
    .update(canonicalSubscriptionClosureJson(checklist))
    .digest("hex");
  const documentSnapshot = {
    ...(revisionOne.documentSnapshot as Prisma.JsonObject),
    returnChecklistSnapshotHash: checklistHash
  };
  const documentHash = createHash("sha256")
    .update(canonicalSubscriptionClosureJson(documentSnapshot))
    .digest("hex");
  const signedFileId = randomUUID();
  const signedFileHash = "b".repeat(64);
  const revisionId = randomUUID();
  const revisionTaskId = randomUUID();
  const revisionSource = {
    id: closureCase.id,
    key: "focused-return-manifest:2",
    type: "SUBSCRIPTION_CLOSURE"
  };
  await prisma.$transaction(async (tx) => {
    await tx.vehicleReturn.update({
      data: {
        ...checklist,
        checklistSnapshot: checklist,
        returnStatus: "READY",
        updatedBy: fixture.actorId
      },
      where: { orderId: fixture.orderId }
    });
    const sourceFile = await tx.fileObject.findUniqueOrThrow({
      where: { id: revisionOne.sourceFileId }
    });
    const signedObjectKey = `subscription-closure/${closureCase.id}/focused-return-manifest-signed.pdf`;
    await tx.fileObject.create({
      data: {
        bucket: sourceFile.bucket,
        id: signedFileId,
        mimeType: "application/pdf",
        objectKey: signedObjectKey,
        originalName: `${closureCase.caseNo}-focused-return-manifest-signed.pdf`,
        sizeBytes: 128n,
        uploadedBy: fixture.actorId
      }
    });
    await tx.contractESignTask.create({
      data: {
        completedAt: occurredAt,
        contractId: fixture.contractId,
        createdBy: fixture.actorId,
        customerId: fixture.customerId,
        documentObjectKey: sourceFile.objectKey,
        documentType: "DELIVERY_HANDOVER",
        id: revisionTaskId,
        orderId: fixture.orderId,
        provider: "OTHER",
        requestSnapshot: { documentSnapshotHash: documentHash },
        responseSnapshot: { signedFileHash, signedFileId },
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        signedDocumentObjectKey: signedObjectKey,
        sourceId: revisionSource.id,
        sourceKey: revisionSource.key,
        sourceType: revisionSource.type,
        taskNo: `ESG-TASK4-FOCUSED-${revisionTaskId}`,
        taskStatus: "COMPLETED",
        updatedBy: fixture.actorId
      }
    });
    await tx.subscriptionClosureDocumentRevision.create({
      data: {
        archivedAt: occurredAt,
        archivedBy: fixture.actorId,
        closureCaseId: closureCase.id,
        contractESignTaskId: revisionTaskId,
        documentSnapshot,
        documentSnapshotHash: documentHash,
        documentType: "RETURN_MANIFEST",
        generatedAt: occurredAt,
        generatedBy: fixture.actorId,
        handoverWorkOrderId: closureCase.returnHandoverWorkOrderId,
        id: revisionId,
        revisionNumber: 2,
        signedAt: occurredAt,
        signedBy: fixture.actorId,
        signedFileHash,
        signedFileId,
        sourceFileHash: documentHash,
        sourceFileId: revisionOne.sourceFileId,
        sourceId: revisionSource.id,
        sourceKey: revisionSource.key,
        sourceType: revisionSource.type,
        stage: "ARCHIVED",
        supersedesRevisionId: revisionOne.id,
        vehicleReturnId: closureCase.vehicleReturnId
      }
    });
    await tx.subscriptionClosureCurrentDocument.update({
      data: { documentRevisionId: revisionId, updatedBy: fixture.actorId },
      where: {
        closureCaseId_documentType: {
          closureCaseId: closureCase.id,
          documentType: "RETURN_MANIFEST"
        }
      }
    });
  });
  const audit = new AuditService(prisma);
  const accounting = new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
  const operations = new AssetOperationsService(
    prisma,
    new AssetOperationsRepository(),
    audit,
    accounting
  );
  const closure = new SubscriptionClosureService(
    new SubscriptionClosureRepository(),
    new HandoverWorkOrderService(prisma, {} as never),
    operations,
    audit,
    prisma,
    new AssetFactsService(prisma, new AssetFactsRepository(), audit),
    accounting,
    new VehicleMileageService(prisma, new VehicleMileageRepository())
  );
  const receipt = {
    actorId: fixture.actorId,
    checklist,
    damages: [
      {
        damageLevel: "MEDIUM",
        damageType: "EXTERIOR",
        description: "Focused rear door scratch",
        estimatedRepairAmount: 3600n,
        photoUrls: ["focused-rear-door-1.jpg", "focused-rear-door-2.jpg"],
        responsibleParty: "CUSTOMER"
      }
    ],
    orderId: fixture.orderId,
    physicalControlMode: "VOLUNTARY_RETURN" as const,
    remark: "focused receipt",
    returnMileageKm: 1200,
    returnType: "NORMAL_RETURN" as const,
    returnedAt: occurredAt
  };
  await awaitDatabaseClockPast(prisma, occurredAt);
  return {
    accounting,
    closure,
    closureCase,
    fixture,
    occurredAt,
    operations,
    receipt,
    signedFileHash,
    signedFileId
  };
}

async function closeFocusedInspectionWorkOrder(
  scenario: Awaited<ReturnType<typeof setupFocusedPhysicalReceipt>>
) {
  for (const [expectedVersion, targetStatus] of [
    [1, "PENDING_ACCEPTANCE"],
    [2, "CLOSED"]
  ] as const) {
    await scenario.operations.transitionWorkOrder(
      {
        closeReason: targetStatus === "CLOSED" ? "focused inspection accepted" : null,
        detailSnapshot: { targetStatus },
        expectedVersion,
        occurredAt: scenario.occurredAt,
        solution: targetStatus === "CLOSED" ? "accepted" : null,
        source: {
          id: scenario.closureCase.id,
          key: `focused-inspection-${expectedVersion}`,
          type: "TASK4_TEST"
        },
        targetStatus,
        workOrderId: scenario.closureCase.returnAssetWorkOrderId!
      },
      { actorId: scenario.fixture.actorId, permissions: [] }
    );
  }
}

function focusedInspectionCommand(
  scenario: Awaited<ReturnType<typeof setupFocusedPhysicalReceipt>>,
  reconditioningRequired: boolean
) {
  return {
    accepted: true,
    actorId: scenario.fixture.actorId,
    closureCaseId: scenario.closureCase.id,
    costs: [
      {
        actionType: "ACTUAL_COST" as const,
        accountingPeriod: "2026-08",
        amountCents: 2500n,
        assetOwnerId: null,
        assetOwnerSnapshot: null,
        confirmedAt: scenario.occurredAt,
        costCategory: "CLEANING" as const,
        evidenceId: null,
        evidenceSnapshot: null,
        occurredOn: new Date("2026-08-21T00:00:00.000Z"),
        reason: "focused return inspection",
        responsiblePartyId: scenario.fixture.customerId,
        responsiblePartyType: "CUSTOMER" as const,
        responsibilitySnapshot: { basis: "focused inspection" }
      }
    ],
    evidence: [
      {
        action: "ATTACH" as const,
        capturedAt: scenario.occurredAt,
        captureMetadata: { station: "focused-return-inspection" },
        contentSha256: scenario.signedFileHash,
        eventId: null,
        evidenceType: "INSPECTION_REPORT" as const,
        fileId: scenario.signedFileId,
        occurredAt: scenario.occurredAt,
        supersedesEvidenceId: null
      }
    ],
    occurredAt: scenario.occurredAt,
    reconditioningRequired
  };
}

async function snapshotPhysicalReturnTruth(
  prisma: PrismaService,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>,
  scope: Readonly<{
    damageIds?: readonly string[];
    excludedAssetWorkOrderEventIds?: readonly string[];
    excludedAuditIds?: readonly string[];
    excludedClosureEventIds?: readonly string[];
  }> = {}
) {
  return Promise.all([
    prisma.subscriptionClosureCase.findUnique({ where: { orderId: fixture.orderId } }),
    prisma.subscriptionOrder.findUnique({ where: { id: fixture.orderId } }),
    prisma.lease.findUnique({ where: { orderId: fixture.orderId } }),
    prisma.vehicle.findUnique({ where: { id: fixture.vehicleId } }),
    prisma.vehicleReturn.findUnique({ where: { orderId: fixture.orderId } }),
    prisma.vehicleReturnDamage.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: scope.damageIds
        ? {
            OR: [{ id: { in: [...scope.damageIds] } }, { orderId: fixture.orderId }]
          }
        : { orderId: fixture.orderId }
    }),
    prisma.vehicleSubscriptionPeriod.findMany({
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      where: { orderId: fixture.orderId }
    }),
    prisma.vehicleMileageReading.findMany({
      orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
      where: { orderId: fixture.orderId }
    }),
    prisma.assetWorkOrder.findMany({
      orderBy: { id: "asc" },
      where: { orderId: fixture.orderId }
    }),
    prisma.assetWorkOrderEvent.findMany({
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
      where: {
        id: scope.excludedAssetWorkOrderEventIds
          ? { notIn: [...scope.excludedAssetWorkOrderEventIds] }
          : undefined,
        workOrder: { orderId: fixture.orderId }
      }
    }),
    prisma.assetWorkOrderEvidence.findMany({
      orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
      where: { workOrder: { orderId: fixture.orderId } }
    }),
    prisma.vehicleOperationalRestriction.findMany({
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      where: { vehicleId: fixture.vehicleId }
    }),
    prisma.subscriptionClosureEvent.findMany({
      include: { commandReceipt: true },
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
      where: {
        closureCase: { orderId: fixture.orderId },
        id: scope.excludedClosureEventIds
          ? { notIn: [...scope.excludedClosureEventIds] }
          : undefined
      }
    }),
    prisma.auditLog.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: {
        id: scope.excludedAuditIds ? { notIn: [...scope.excludedAuditIds] } : undefined,
        operatorId: fixture.actorId
      }
    }),
    prisma.vehicleCostLedgerEntry.findMany({
      orderBy: [{ occurredOn: "asc" }, { id: "asc" }],
      where: { orderId: fixture.orderId }
    })
  ]);
}

async function snapshotRecoveryPhysicalMutationSurface(
  prisma: PrismaService,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>
) {
  const truth = await snapshotPhysicalReturnTruth(prisma, fixture);
  return [...truth.slice(1, 12), truth[14]];
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

type Task6AuthorityMutationTarget = Readonly<{
  id: string;
  kind: "CURRENT_POINTER" | "ESIGN" | "FILE" | "REVISION";
}>;

async function assertTask6AuthorityMutationBoundaries(
  prisma: PrismaService,
  targets: readonly Task6AuthorityMutationTarget[],
  operation: () => Promise<unknown>,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>,
  closureCaseId: string
) {
  for (const target of targets) {
    const barrier = createBarrier();
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      if (target.kind === "REVISION") {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "subscription_closure_document_revision"
          SET "source_key" = "source_key"
          WHERE "id" = ${target.id}::uuid
        `);
      } else if (target.kind === "FILE") {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "file_object"
          SET "object_key" = "object_key"
          WHERE "id" = ${target.id}::uuid
        `);
      } else if (target.kind === "ESIGN") {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "contract_esign_task"
          SET "request_snapshot" = "request_snapshot"
          WHERE "id" = ${target.id}::uuid
        `);
      } else {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "subscription_closure_current_document"
          SET "document_revision_id" = "document_revision_id"
          WHERE "closure_case_id" = ${target.id}::uuid
            AND "document_type" = 'RECOVERY_AUTHORITY'::"subscription_closure_document_type"
        `);
      }
      barrier.enter();
      await barrier.released;
      await expect(tx.$queryRaw(Prisma.sql`SELECT 1 AS "usable"`)).resolves.toEqual([
        { usable: 1 }
      ]);
      throw new Error(`TASK6_EXPECTED_HOLDER_ROLLBACK:${target.kind}`);
    });
    await barrier.entered;
    const before = await snapshotTask6RecoveryBoundaryTruth(prisma, fixture, closureCaseId);
    try {
      await expect(operation()).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
        status: 409
      });
      await expect(
        snapshotTask6RecoveryBoundaryTruth(prisma, fixture, closureCaseId)
      ).resolves.toEqual(before);
    } finally {
      barrier.release();
    }
    await expect(holder).rejects.toThrow(`TASK6_EXPECTED_HOLDER_ROLLBACK:${target.kind}`);
  }
}

async function snapshotTask6RecoveryBoundaryTruth(
  prisma: PrismaService,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>,
  closureCaseId: string
) {
  return Promise.all([
    snapshotPhysicalReturnTruth(prisma, fixture),
    prisma.businessExceptionApproval.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: { subjectId: closureCaseId, subjectType: "RECOVERY_CASE" }
    }),
    prisma.subscriptionClosureDocumentRevision.findMany({
      orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
      where: { closureCaseId, documentType: "RECOVERY_AUTHORITY" }
    })
  ]);
}

async function withTask6Replica<T>(
  prisma: PrismaService,
  operation: (tx: Prisma.TransactionClient) => Promise<T>
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    return operation(tx);
  });
}

async function assertTask6ArchiveReplayMutationRejected(
  prisma: PrismaService,
  replay: () => Promise<unknown>,
  mutate: () => Promise<unknown>,
  restore: () => Promise<unknown>,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>,
  closureCaseId: string
) {
  await mutate();
  const driftTruth = await snapshotTask6RecoveryBoundaryTruth(prisma, fixture, closureCaseId);
  try {
    await expect(replay()).rejects.toMatchObject({
      response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
      status: 409
    });
    await expect(
      snapshotTask6RecoveryBoundaryTruth(prisma, fixture, closureCaseId)
    ).resolves.toEqual(driftTruth);
  } finally {
    await restore();
  }
}

function hookTransaction(
  prisma: PrismaService,
  model: string,
  method: string,
  barrier: ReturnType<typeof createBarrier>,
  timing: "after" | "before" = "before"
) {
  let invoked = false;
  const transaction = (
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
    }, options);
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === "$transaction") return transaction;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as PrismaService;
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

async function settleTask6Bill(
  prisma: PrismaService,
  finance: FinanceService,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>,
  billId: string,
  amount: bigint,
  index: number
) {
  const paymentOrderId = randomUUID();
  await prisma.paymentOrder.create({
    data: {
      amount,
      customerId: fixture.customerId,
      id: paymentOrderId,
      items: { create: { amount, billId } },
      orderId: fixture.orderId,
      paidAmount: 0n,
      paymentChannel: "MOCK",
      paymentOrderNo: `PYO-TASK6-${paymentOrderId}`,
      paymentStatus: "PENDING",
      provider: "MOCK",
      providerTradeNo: `task6-trade-${paymentOrderId}`
    }
  });
  const now = await prisma.$transaction((tx) => databaseNow(tx));
  await finance.settlePaymentOrder({
    operatorId: fixture.actorId,
    paidAmount: amount,
    paidAt: new Date(now.getTime() - 1_000 + index),
    paymentOrderId,
    providerTransactionId: `task6-provider-${paymentOrderId}`
  });
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
      DELETE FROM "asset_accounting_command_receipt"
      WHERE "approval_id" IN (
        SELECT "id" FROM "business_exception_approval"
        WHERE "subject_id" IN (
          SELECT "id" FROM "subscription_closure_case" WHERE "order_id" = ${fixture.orderId}::uuid
        )
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "business_exception_approval"
      WHERE "subject_id" IN (
        SELECT "id" FROM "subscription_closure_case" WHERE "order_id" = ${fixture.orderId}::uuid
      )
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
      DELETE FROM "vehicle_operational_restriction" WHERE "vehicle_id" = ${fixture.vehicleId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "vehicle_mileage_reading" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "vehicle_subscription_period" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "vehicle_return_damage" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "asset_accounting_command_receipt"
      WHERE "cost_entry_id" IN (
        SELECT "id" FROM "vehicle_cost_ledger_entry" WHERE "order_id" = ${fixture.orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "vehicle_cost_ledger_entry" WHERE "order_id" = ${fixture.orderId}::uuid
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
      DELETE FROM "asset_work_order_evidence"
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
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_automation_job" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "collection_action" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "collection_case_bill" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "collection_case" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "payment_write_off" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "payment_record" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "payment_order_item"
      WHERE "payment_order_id" IN (
        SELECT "id" FROM "payment_order" WHERE "order_id" = ${fixture.orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "payment_order" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "receivable_bill" WHERE "order_id" = ${fixture.orderId}::uuid
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
