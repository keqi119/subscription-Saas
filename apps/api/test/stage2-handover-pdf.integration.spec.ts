import { ConfigService } from "@nestjs/config";
import {
  BusinessType,
  ContractStatus,
  ContractTemplateType,
  ContractVersionStatus,
  DeliveryHandoverStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from "vitest";

import { buildDeliveryHandoverEvidencePackage } from "../src/delivery-handover/delivery-handover-evidence-manifest";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";
import { Stage2HandoverWorkflowRepository } from "../src/handover-work-order/stage2-handover-workflow.repository";
import { PrismaService } from "../src/prisma/prisma.service";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://subscription:subscription@127.0.0.1:5432/subscription_saas?schema=public";

describe("Stage 2 source PDF PostgreSQL finalization", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(
      new ConfigService({
        DATABASE_POOL_MAX: "10",
        DATABASE_URL: TEST_DATABASE_URL
      })
    );
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("rolls a losing concurrent finalizer back without changing the winner", async () => {
    const fixture = await createDatabaseFixture(prisma);
    const loserPdf = Buffer.from("%PDF-loser--000");
    const winnerPdf = Buffer.from("%PDF-winner-000");
    const loserUploadEntered = deferred<void>();
    const releaseLoserUpload = deferred<void>();
    const storage = coordinatedStorage({
      blockedBytes: loserPdf,
      onBlocked: () => loserUploadEntered.resolve(),
      releaseBlocked: releaseLoserUpload.promise
    });
    const renderer = queuedRenderer([loserPdf, winnerPdf]);
    const repository = new Stage2HandoverWorkflowRepository(prisma);
    const service = createService(
      prisma,
      fixture.evidenceChecklist,
      renderer,
      storage,
      repository
    );

    try {
      const losingAttempt = service.ensureStage2HandoverPdf(
        fixture.workOrderId,
        fixture.manifestHash
      );
      await loserUploadEntered.promise;
      const winningAttempt = service.ensureStage2HandoverPdf(
        fixture.workOrderId,
        fixture.manifestHash
      );
      const winner = await winningAttempt;
      releaseLoserUpload.resolve();
      const loser = await losingAttempt;

      expect(loser.artifactId).toBe(winner.artifactId);
      const handover =
        await prisma.vehicleDeliveryHandover.findUniqueOrThrow({
          include: { handoverContract: true },
          where: { id: fixture.handoverId }
        });
      const sourceContracts = await prisma.contract.findMany({
        where: {
          id: { not: fixture.stage1ContractId },
          orderId: fixture.orderId
        }
      });
      const sourceFiles = await prisma.fileObject.findMany({
        where: {
          id: {
            in: sourceContracts
              .map((contract) => contract.fileId)
              .filter((id): id is string => Boolean(id))
          }
        }
      });
      const notifications =
        await prisma.vehicleHandoverWorkflowJob.findMany({
          where: {
            jobType:
              VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY,
            workOrderId: fixture.workOrderId
          }
        });
      const snapshot = handover.handoverContract
        ?.contractSnapshot as Record<string, unknown>;
      const artifact = snapshot.stage2HandoverPdfArtifact as
        | Record<string, unknown>
        | undefined;

      expect(sourceContracts).toHaveLength(1);
      expect(sourceFiles).toHaveLength(1);
      expect(notifications).toHaveLength(1);
      expect(handover.status).toBe(DeliveryHandoverStatus.SOURCE_GENERATED);
      expect(artifact).toMatchObject({
        artifactVersion: handover.artifactVersion,
        fileId: handover.sourceDocumentFileId,
        sourcePdfHash: handover.sourcePdfHash
      });
      const storedBytes = storage.objects.get(handover.sourceObjectKey!);
      expect(storedBytes).toBeDefined();
      expect(sha256(storedBytes!)).toBe(handover.sourcePdfHash);
    } finally {
      releaseLoserUpload.resolve();
      await fixture.cleanup();
    }
  });

  it("rolls back Contract, FileObject, handover, and notification when enqueue fails", async () => {
    const fixture = await createDatabaseFixture(prisma);
    const pdf = Buffer.from("%PDF-enqueue-rollback");
    const storage = coordinatedStorage();
    const renderer = queuedRenderer([pdf]);
    const repository = new Stage2HandoverWorkflowRepository(prisma);
    const enqueue = repository.enqueue.bind(repository);
    vi.spyOn(repository, "enqueue").mockImplementation(
      async (tx, input) => {
        const job = await enqueue(tx, input);
        if (
          input.jobType ===
          VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY
        ) {
          throw new Error("synthetic notification enqueue failure");
        }
        return job;
      }
    );
    const service = createService(
      prisma,
      fixture.evidenceChecklist,
      renderer,
      storage,
      repository
    );

    try {
      await expect(
        service.ensureStage2HandoverPdf(
          fixture.workOrderId,
          fixture.manifestHash
        )
      ).rejects.toThrow("synthetic notification enqueue failure");

      const handover =
        await prisma.vehicleDeliveryHandover.findUniqueOrThrow({
          where: { id: fixture.handoverId }
        });
      const sourceContracts = await prisma.contract.findMany({
        where: {
          id: { not: fixture.stage1ContractId },
          orderId: fixture.orderId
        }
      });
      const sourceFiles = await prisma.fileObject.findMany({
        where: {
          objectKey: { startsWith: "contracts/" }
        }
      });
      const notifications =
        await prisma.vehicleHandoverWorkflowJob.findMany({
          where: {
            jobType:
              VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY,
            workOrderId: fixture.workOrderId
          }
        });

      expect(handover).toMatchObject({
        handoverContractId: null,
        sourceDocumentFileId: null,
        sourceObjectKey: null,
        sourcePdfHash: null,
        status: DeliveryHandoverStatus.DRAFT
      });
      expect(sourceContracts).toEqual([]);
      expect(
        sourceFiles.filter((file) =>
          storage.objects.has(file.objectKey)
        )
      ).toEqual([]);
      expect(notifications).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

async function createDatabaseFixture(prisma: PrismaService) {
  const customerId = randomUUID();
  const orderId = randomUUID();
  const handoverId = randomUUID();
  const workOrderId = randomUUID();
  const templateId = randomUUID();
  const stage1ContractId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "");
  const evidenceChecklist = {
    blockingReasons: [],
    items: [],
    ready: true
  };
  const evidencePackage = buildDeliveryHandoverEvidencePackage({
    evidenceChecklist,
    handoverId,
    orderId,
    workOrderId
  });

  await prisma.customer.create({
    data: {
      customerNo: `CUS-S2PDF-${suffix}`,
      id: customerId,
      mobile: "13800000000",
      name: "Stage 2 PDF Integration"
    }
  });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`
      INSERT INTO "subscription_order" (
        "id",
        "order_no",
        "customer_id",
        "application_id",
        "quote_id",
        "product_id",
        "product_version_id",
        "vehicle_model",
        "vehicle_purchase_price_amount",
        "monthly_fee_amount",
        "deposit_amount",
        "period_months",
        "mileage_limit_km",
        "over_mileage_fee_amount",
        "quote_snapshot",
        "created_at",
        "updated_at"
      )
      VALUES (
        ${orderId}::uuid,
        ${`ORD-S2PDF-${suffix}`},
        ${customerId}::uuid,
        ${randomUUID()}::uuid,
        ${randomUUID()}::uuid,
        ${randomUUID()}::uuid,
        ${randomUUID()}::uuid,
        'ES6',
        100000,
        1000,
        5000,
        12,
        20000,
        100,
        ${JSON.stringify({ source: "stage2-pdf-integration" })}::jsonb,
        now(),
        now()
      )
    `;
  });
  await prisma.contractVersion.create({
    data: {
      businessType: BusinessType.SUBSCRIPTION,
      contentTemplate: "Stage 2 integration template",
      effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
      id: templateId,
      status: ContractVersionStatus.ACTIVE,
      templateName: `Stage 2 PDF ${suffix}`,
      templateType: ContractTemplateType.DELIVERY_HANDOVER,
      versionNo: "V1.0"
    }
  });
  await prisma.contract.create({
    data: {
      businessType: BusinessType.SUBSCRIPTION,
      contractNo: `S1-${suffix}`,
      contractSnapshot: { source: "stage1-integration" },
      contractTitle: "Stage 1 integration contract",
      contractVersionId: templateId,
      customerId,
      id: stage1ContractId,
      orderId,
      status: ContractStatus.SIGNED
    }
  });
  await prisma.vehicleDeliveryHandover.create({
    data: {
      id: handoverId,
      orderId,
      stage1ContractId
    }
  });
  await prisma.vehicleHandoverWorkOrder.create({
    data: {
      accessoryChecklist: { keys: 2 },
      customerConfirmedAt: new Date(),
      damageDeclared: false,
      deliveryLocation: "Stage 2 integration center",
      energyLevelText: "80%",
      fieldSubmittedAt: new Date(),
      handoverId,
      handoverMileageKm: 1200,
      handoverType: "DELIVERY_OUTBOUND",
      id: workOrderId,
      noVisibleDamageDeclared: true,
      orderId,
      status: "CUSTOMER_CONFIRMED"
    }
  });
  await prisma.vehicleHandoverReviewAttempt.create({
    data: {
      attemptNo: 1,
      customerConfirmedAt: new Date(),
      evidenceSnapshot: {
        evidencePackage: {
          manifestHash: evidencePackage.manifestHash
        }
      },
      handoverId,
      orderId,
      status: "CUSTOMER_CONFIRMED",
      workOrderId
    }
  });

  return {
    async cleanup() {
      const contracts = await prisma.contract.findMany({
        select: { fileId: true },
        where: { orderId }
      });
      const fileIds = contracts
        .map((contract) => contract.fileId)
        .filter((id): id is string => Boolean(id));
      await prisma.vehicleHandoverWorkflowJob.deleteMany({
        where: { workOrderId }
      });
      await prisma.vehicleHandoverReviewAttempt.deleteMany({
        where: { workOrderId }
      });
      await prisma.vehicleHandoverWorkOrder.deleteMany({
        where: { id: workOrderId }
      });
      await prisma.vehicleDeliveryHandover.deleteMany({
        where: { id: handoverId }
      });
      await prisma.contract.deleteMany({ where: { orderId } });
      if (fileIds.length > 0) {
        await prisma.fileObject.deleteMany({
          where: { id: { in: fileIds } }
        });
      }
      await prisma.contractVersion.deleteMany({
        where: { id: templateId }
      });
      await prisma.subscriptionOrder.deleteMany({ where: { id: orderId } });
      await prisma.customer.deleteMany({ where: { id: customerId } });
    },
    evidenceChecklist,
    handoverId,
    manifestHash: evidencePackage.manifestHash,
    orderId,
    stage1ContractId,
    workOrderId
  };
}

function createService(
  prisma: PrismaService,
  evidenceChecklist: unknown,
  renderer: ReturnType<typeof queuedRenderer>,
  storage: ReturnType<typeof coordinatedStorage>,
  repository: Stage2HandoverWorkflowRepository
) {
  return new HandoverWorkOrderService(
    prisma,
    {
      assertFieldEvidenceComplete: vi.fn(async () => undefined),
      getChecklist: vi.fn(async () => evidenceChecklist)
    } as never,
    undefined,
    storage as never,
    renderer as never,
    new ConfigService({
      CONTRACT_PDF_CJK_FONT_PATH: process.execPath,
      STAGE2_HANDOVER_PUBLIC_WEB_BASE_URL: "https://portal.example.test"
    }),
    undefined,
    repository
  );
}

function queuedRenderer(buffers: Buffer[]) {
  let index = 0;
  return {
    renderToFile: vi.fn(async () => {
      const buffer = buffers[index];
      index += 1;
      if (!buffer) {
        throw new Error("No queued integration PDF.");
      }
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "stage2-pdf-integration-")
      );
      const filePath = path.join(directory, "handover.pdf");
      await writeFile(filePath, buffer);
      return {
        cleanup: vi.fn(async () =>
          rm(directory, { force: true, recursive: true })
        ),
        contentType: "application/pdf" as const,
        diagnostics: {
          evidenceFileCount: 0,
          evidenceItemCount: 0,
          hasCustomerSignatureArea: true,
          hasEvidenceSummary: true,
          hasPlatformSealArea: true,
          pageCount: 1,
          photoCount: 0,
          targetBytesExceeded: false,
          videoCount: 0
        },
        fileName: "handover.pdf",
        filePath,
        sizeBytes: buffer.length,
        slotCoordinates: []
      };
    })
  };
}

function coordinatedStorage(options: {
  blockedBytes?: Buffer;
  onBlocked?: () => void;
  releaseBlocked?: Promise<void>;
} = {}) {
  const objects = new Map<string, Buffer>();
  return {
    deleteObject: vi.fn(async (_bucket: string, objectKey: string) => {
      objects.delete(objectKey);
    }),
    getObject: vi.fn(async (_bucket: string, objectKey: string) => {
      const bytes = objects.get(objectKey);
      if (!bytes) {
        throw new Error(`Missing coordinated object: ${objectKey}`);
      }
      return {
        contentLength: bytes.length,
        contentType: "application/pdf",
        stream: Readable.from([bytes])
      };
    }),
    objects,
    putGeneratedContractPdfArtifactFromPath: vi.fn(
      async (input: {
        contentType: "application/pdf";
        filePath: string;
        objectKey: string;
        originalName: string;
        sizeBytes: number;
      }) => {
        const bytes = await readFile(input.filePath);
        if (options.blockedBytes?.equals(bytes)) {
          options.onBlocked?.();
          await options.releaseBlocked;
        }
        objects.set(input.objectKey, bytes);
        return {
          bucket: "application-materials",
          contentType: input.contentType,
          objectKey: input.objectKey,
          originalName: input.originalName,
          sizeBytes: input.sizeBytes,
          stored: {
            driver: "local",
            key: `application-materials/${input.objectKey}`
          }
        };
      }
    )
  };
}

function deferred<T>() {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = (value) => resolvePromise(value as T);
  });
  return { promise, resolve };
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
