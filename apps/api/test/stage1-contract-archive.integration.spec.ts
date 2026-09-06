import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  ESignDocumentType,
  ESignProviderActionType,
  ESignProviderType,
  ESignSignerStatus,
  ESignSignerType,
  ESignSigningStage,
  ESignSlotId,
  ESignTaskStatus,
  OrderStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStatus,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import type { ESignProvider } from "../src/esign/esign.provider";
import { ESignService } from "../src/esign/esign.service";
import {
  FADADA_ARCHIVE_INVALID_TASK,
  FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF,
  FadadaSignedArtifactService,
  type FadadaSignedArtifactApi
} from "../src/esign/fadada/fadada-signed-artifact.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { StorageService } from "../src/storage/storage.service";
import type { StorageProvider } from "../src/storage/storage.types";
import { SubscriptionJourneyRuntimeConfig } from "../src/subscription-journey/subscription-journey.config";
import { SubscriptionJourneyRepository } from "../src/subscription-journey/subscription-journey.repository";
import { SubscriptionJourneySignalService } from "../src/subscription-journey/subscription-journey-signal.service";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";
import { insertRuntimeContract, insertRuntimeOrderGraph } from "./helpers/runtime-domain-fixture";

const TEST_DATABASE_URL = requiredReleaseDatabaseTestContext(
  "apps/api/test/stage1-contract-archive.integration.spec.ts"
).databaseUrl;
const PDF_BYTES = Buffer.from("%PDF-1.4\n%B3\n", "utf8");

class TestFadadaSignedArtifactService extends FadadaSignedArtifactService {
  constructor(
    prisma: PrismaService,
    storage: StorageService,
    journeySignal: SubscriptionJourneySignalService,
    audit: AuditService,
    private readonly api: FadadaSignedArtifactApi
  ) {
    super(prisma, storage, new ConfigService(), undefined, journeySignal, audit);
  }

  protected override getApiClient(): FadadaSignedArtifactApi {
    return this.api;
  }
}

async function activationWriteCounts(prisma: PrismaService, orderId: string) {
  const [leases, periods] = await Promise.all([
    prisma.lease.count({ where: { orderId } }),
    prisma.vehicleSubscriptionPeriod.count({ where: { orderId } })
  ]);
  return { leases, periods };
}

interface Stage1ArchiveFixture {
  applicationId: string;
  contractId: string;
  contractVersionId: string;
  customerId: string;
  journeyId: string;
  orderId: string;
  providerContractId: string;
  taskId: string;
  transactionId: string;
}

type Stage1ArchiveFixtureBuilder = (
  prisma: PrismaService,
  label: string
) => Promise<Stage1ArchiveFixture>;

const createStage1ArchiveFixture: Stage1ArchiveFixtureBuilder = async (prisma, label) => {
  const applicationId = randomUUID();
  const contractId = randomUUID();
  const contractVersionId = randomUUID();
  const customerId = randomUUID();
  const journeyId = randomUUID();
  const orderId = randomUUID();
  const providerContractId = `B3-CONTRACT-${randomUUID()}`;
  const taskId = randomUUID();
  const taskNo = `B3-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const transactionId = `B3TX${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const alreadySignedAt = new Date("2026-09-06T00:00:00.000Z");

  await prisma.$transaction(async (tx) => {
    await insertRuntimeOrderGraph(tx, {
      applicationId,
      customerId,
      label,
      orderId
    });
    await insertRuntimeContract(tx, {
      contractId,
      contractVersionId,
      customerId,
      label,
      orderId,
      status: "SIGNING"
    });
    await tx.subscriptionOrder.update({
      data: { orderStatus: OrderStatus.PENDING_SIGN },
      where: { id: orderId }
    });
    await tx.contractESignTask.create({
      data: {
        contractId,
        customerId,
        documentType: ESignDocumentType.SUBSCRIPTION_CONTRACT,
        id: taskId,
        orderId,
        provider: ESignProviderType.FADADA,
        providerEnvelopeId: providerContractId,
        providerTaskId: transactionId,
        requestSnapshot: { stage1MultiSlot: true },
        signingStage: ESignSigningStage.STAGE1_SUBSCRIPTION_CONTRACT,
        taskNo,
        taskStatus: ESignTaskStatus.WAITING_CUSTOMER
      }
    });
    await tx.contractESignSigner.createMany({
      data: [
        {
          customerId,
          documentType: ESignDocumentType.CONTRACT_BODY,
          providerActionType: ESignProviderActionType.CUSTOMER_MANUAL_SIGN,
          providerSignerId: transactionId,
          required: true,
          signerStatus: ESignSignerStatus.PENDING,
          signerType: ESignSignerType.CUSTOMER,
          slotId: ESignSlotId.STAGE1_BODY_CUSTOMER,
          snapshot: {
            documentType: "CONTRACT_BODY",
            providerActionType: "CUSTOMER_MANUAL_SIGN",
            required: true,
            signerRole: "CUSTOMER",
            signingStage: "STAGE1_CONTRACT",
            slotId: "STAGE1_BODY_CUSTOMER"
          },
          taskId
        },
        {
          documentType: ESignDocumentType.CONTRACT_BODY,
          providerActionType: ESignProviderActionType.PLATFORM_AUTO_SEAL,
          providerSignerId: `${transactionId}-BODY-PLATFORM`,
          required: true,
          signedAt: alreadySignedAt,
          signerStatus: ESignSignerStatus.SIGNED,
          signerType: ESignSignerType.PLATFORM,
          slotId: ESignSlotId.STAGE1_BODY_PLATFORM,
          snapshot: {
            documentType: "CONTRACT_BODY",
            providerActionType: "PLATFORM_AUTO_SEAL",
            required: true,
            signerRole: "PLATFORM",
            signingStage: "STAGE1_CONTRACT",
            slotId: "STAGE1_BODY_PLATFORM"
          },
          taskId
        },
        {
          customerId,
          documentType: ESignDocumentType.ATTACHMENT1_SUBSCRIPTION_PLAN,
          providerActionType: ESignProviderActionType.CUSTOMER_MANUAL_SIGN,
          providerSignerId: `${transactionId}-ATTACHMENT-CUSTOMER`,
          required: true,
          signedAt: alreadySignedAt,
          signerStatus: ESignSignerStatus.SIGNED,
          signerType: ESignSignerType.CUSTOMER,
          slotId: ESignSlotId.STAGE1_ATTACHMENT1_CUSTOMER,
          snapshot: {
            documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
            providerActionType: "CUSTOMER_MANUAL_SIGN",
            required: true,
            signerRole: "CUSTOMER",
            signingStage: "STAGE1_CONTRACT",
            slotId: "STAGE1_ATTACHMENT1_CUSTOMER"
          },
          taskId
        },
        {
          documentType: ESignDocumentType.ATTACHMENT1_SUBSCRIPTION_PLAN,
          providerActionType: ESignProviderActionType.PLATFORM_AUTO_SEAL,
          providerSignerId: `${transactionId}-ATTACHMENT-PLATFORM`,
          required: true,
          signedAt: alreadySignedAt,
          signerStatus: ESignSignerStatus.SIGNED,
          signerType: ESignSignerType.PLATFORM,
          slotId: ESignSlotId.STAGE1_ATTACHMENT1_PLATFORM,
          snapshot: {
            documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
            providerActionType: "PLATFORM_AUTO_SEAL",
            required: true,
            signerRole: "PLATFORM",
            signingStage: "STAGE1_CONTRACT",
            slotId: "STAGE1_ATTACHMENT1_PLATFORM"
          },
          taskId
        }
      ]
    });
    await tx.subscriptionJourney.create({
      data: {
        applicationId,
        currentStepCode: SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
        currentStepStatus: SubscriptionJourneyStepStatus.RUNNING,
        id: journeyId,
        orderId,
        status: SubscriptionJourneyStatus.RUNNING,
        steps: {
          create: {
            code: SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
            status: SubscriptionJourneyStepStatus.RUNNING
          }
        }
      }
    });
  });

  return {
    applicationId,
    contractId,
    contractVersionId,
    customerId,
    journeyId,
    orderId,
    providerContractId,
    taskId,
    transactionId
  };
};

type CallbackPayload = {
  providerContractId: string;
  providerTaskId: string;
  resultCode: "3000" | "3001" | "3003";
};

function createDeterministicBoundaries() {
  let selectedBytes = Buffer.from("NOT_A_PDF", "utf8");
  const storedBytes = new Map<string, Buffer>();
  const deleteObject = vi.fn(async (key: string) => {
    storedBytes.delete(key);
  });
  const getObject = vi.fn(async (key: string) => {
    const bytes = storedBytes.get(key);
    if (!bytes) {
      throw new Error(`MISSING_STORAGE_OBJECT:${key}`);
    }
    return {
      contentLength: bytes.length,
      contentType: "application/pdf",
      stream: Readable.from(bytes)
    };
  });
  const putObject = vi.fn(
    async ({
      buffer,
      contentType,
      key,
      originalName
    }: Parameters<StorageProvider["putObject"]>[0]) => {
      const immutableBytes = Buffer.from(buffer);
      storedBytes.set(key, immutableBytes);
      return {
        contentType,
        driver: "local" as const,
        key,
        originalName,
        size: immutableBytes.length
      };
    }
  );
  const callbackProvider: ESignProvider = {
    createSignTask: vi.fn(async () => {
      throw new Error("UNEXPECTED_PROVIDER_CALL");
    }),
    getSignerUrl: vi.fn(async () => {
      throw new Error("UNEXPECTED_PROVIDER_CALL");
    }),
    querySignerStatus: vi.fn(async () => {
      throw new Error("UNEXPECTED_PROVIDER_CALL");
    }),
    verifyCallback: vi.fn(async (payload: unknown) => {
      if (!isCallbackPayload(payload)) {
        throw new Error("UNEXPECTED_CALLBACK_PAYLOAD");
      }
      return {
        eventType: {
          "3000": "FADADA_SIGN_COMPLETED",
          "3001": "FADADA_SIGN_FAILED",
          "3003": "FADADA_SIGN_REJECTED"
        }[payload.resultCode],
        payload,
        providerContractId: payload.providerContractId,
        providerTaskId: payload.providerTaskId,
        resultCode: payload.resultCode,
        verified: true
      };
    })
  };
  const signedArtifactApi = {
    createContractFiling: vi.fn(async ({ contractId }: { contractId: string }) => ({
      contractId,
      raw: {}
    })),
    downloadSignedContract: vi.fn(async () => ({
      buffer: Buffer.from(selectedBytes),
      contentType: "application/pdf",
      fileName: "signed.pdf",
      raw: {}
    })),
    queryContractStatus: vi.fn(async ({ contractId }: { contractId: string }) => ({
      contractId,
      raw: {},
      status: "SIGNED"
    })),
    querySignResult: vi.fn(async ({ contractId }: { contractId: string }) => ({
      contractId,
      raw: {},
      resultCode: "3000",
      status: "SIGNED" as const
    }))
  } satisfies FadadaSignedArtifactApi;
  const memoryStorageProvider: StorageProvider = {
    deleteObject,
    getObject,
    putObject
  };

  return {
    callbackProvider,
    deleteObject,
    getObject,
    memoryStorageProvider,
    putObject,
    selectBytes(bytes: Buffer) {
      selectedBytes = Buffer.from(bytes);
    },
    signedArtifactApi,
    storedBytes
  };
}

function isCallbackPayload(value: unknown): value is CallbackPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    typeof record.providerContractId === "string" &&
    typeof record.providerTaskId === "string" &&
    (record.resultCode === "3000" || record.resultCode === "3001" || record.resultCode === "3003")
  );
}

function callbackPayload(fixture: Stage1ArchiveFixture, resultCode: CallbackPayload["resultCode"]) {
  return {
    providerContractId: fixture.providerContractId,
    providerTaskId: fixture.transactionId,
    resultCode
  } satisfies CallbackPayload;
}

function boundaryCounts(boundaries: ReturnType<typeof createDeterministicBoundaries>) {
  return {
    createContractFiling: boundaries.signedArtifactApi.createContractFiling.mock.calls.length,
    deleteObject: boundaries.deleteObject.mock.calls.length,
    downloadSignedContract: boundaries.signedArtifactApi.downloadSignedContract.mock.calls.length,
    getObject: boundaries.getObject.mock.calls.length,
    putObject: boundaries.putObject.mock.calls.length,
    queryContractStatus: boundaries.signedArtifactApi.queryContractStatus.mock.calls.length,
    querySignResult: boundaries.signedArtifactApi.querySignResult.mock.calls.length
  };
}

describe("Stage 1 contract archive admission", () => {
  let archive: TestFadadaSignedArtifactService;
  let boundaries: ReturnType<typeof createDeterministicBoundaries>;
  let esign: ESignService;
  let journey: SubscriptionJourneyService;
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
  });

  beforeEach(() => {
    boundaries = createDeterministicBoundaries();
    const repository = new SubscriptionJourneyRepository();
    const journeyConfig = new SubscriptionJourneyRuntimeConfig(
      new ConfigService({ SUBSCRIPTION_JOURNEY_ENABLED: "true" })
    );
    const journeySignal = new SubscriptionJourneySignalService(repository, journeyConfig);
    const audit = new AuditService(prisma);
    esign = new ESignService(
      audit,
      new ConfigService(),
      boundaries.callbackProvider,
      prisma,
      undefined,
      undefined,
      undefined,
      journeySignal
    );
    const storage = new StorageService(
      new ConfigService({ UPLOAD_STORAGE_DRIVER: "local" }),
      boundaries.memoryStorageProvider as never,
      {} as never
    );
    archive = new TestFadadaSignedArtifactService(
      prisma,
      storage,
      journeySignal,
      audit,
      boundaries.signedArtifactApi
    );
    journey = new SubscriptionJourneyService(repository, prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("persists callback monotonicity without admitting a platform archive", async () => {
    const completed = await createStage1ArchiveFixture(prisma, `b3-callback-a-${randomUUID()}`);

    await esign.handleCallback("fadada", callbackPayload(completed, "3000"));
    const signedAt = (
      await prisma.contract.findUniqueOrThrow({
        where: { id: completed.contractId }
      })
    ).signedAt;
    await esign.handleCallback("fadada", callbackPayload(completed, "3000"));
    await esign.handleCallback("fadada", callbackPayload(completed, "3001"));
    await esign.handleCallback("fadada", callbackPayload(completed, "3003"));

    const completedTask = await prisma.contractESignTask.findUniqueOrThrow({
      include: { signers: { where: { required: true } } },
      where: { id: completed.taskId }
    });
    const completedContract = await prisma.contract.findUniqueOrThrow({
      where: { id: completed.contractId }
    });
    expect(completedTask.taskStatus).toBe(ESignTaskStatus.COMPLETED);
    expect(completedTask.signers).toHaveLength(4);
    expect(completedTask.signers.every(({ signerStatus }) => signerStatus === "SIGNED")).toBe(true);
    expect(completedContract).toMatchObject({
      archivedAt: null,
      fileId: null,
      signedAt,
      status: ContractStatus.SIGNED
    });
    expect(
      await prisma.fileObject.count({
        where: { objectKey: { contains: `contracts/${completed.contractId}/` } }
      })
    ).toBe(0);
    expect(
      await prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: completed.orderId } })
    ).toMatchObject({ orderStatus: OrderStatus.PENDING_PAYMENT });
    expect(
      await prisma.subscriptionJourneyEvent.count({
        where: { eventKey: `fadada-task:${completed.taskId}:completed` }
      })
    ).toBe(1);
    expect(
      await prisma.subscriptionJourneyOutbox.count({
        where: { eventKey: `fadada-task:${completed.taskId}:completed:outbox` }
      })
    ).toBe(1);
    const completedCallbackLogs = await prisma.contractESignCallbackLog.findMany({
      where: { taskId: completed.taskId }
    });
    expect(completedCallbackLogs).toHaveLength(4);
    expect(completedCallbackLogs.map(({ eventType }) => eventType).sort()).toEqual(
      [
        "FADADA_SIGN_COMPLETED",
        "FADADA_SIGN_COMPLETED",
        "FADADA_SIGN_FAILED",
        "FADADA_SIGN_REJECTED"
      ].sort()
    );
    expect(completedCallbackLogs.every(({ handled }) => handled)).toBe(true);
    expect(await activationWriteCounts(prisma, completed.orderId)).toEqual({
      leases: 0,
      periods: 0
    });

    const failed = await createStage1ArchiveFixture(prisma, `b3-callback-b-${randomUUID()}`);
    await esign.handleCallback("fadada", callbackPayload(failed, "3001"));
    await esign.handleCallback("fadada", callbackPayload(failed, "3000"));

    expect(
      await prisma.contractESignTask.findUniqueOrThrow({ where: { id: failed.taskId } })
    ).toMatchObject({ taskStatus: ESignTaskStatus.FAILED });
    expect(
      await prisma.contract.findUniqueOrThrow({ where: { id: failed.contractId } })
    ).toMatchObject({
      archivedAt: null,
      fileId: null,
      signedAt: null,
      status: ContractStatus.SIGNING
    });
    expect(
      await prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: failed.orderId } })
    ).toMatchObject({ orderStatus: OrderStatus.PENDING_SIGN });
    expect(
      await prisma.fileObject.count({
        where: { objectKey: { contains: `contracts/${failed.contractId}/` } }
      })
    ).toBe(0);
    expect(
      await prisma.subscriptionJourneyEvent.count({
        where: {
          eventKey: {
            in: [
              `fadada-task:${failed.taskId}:completed`,
              `fadada-artifact:${failed.taskId}:archived`
            ]
          }
        }
      })
    ).toBe(0);
    expect(
      await prisma.subscriptionJourneyOutbox.count({ where: { journeyId: failed.journeyId } })
    ).toBe(0);
    expect(await prisma.contractESignCallbackLog.count({ where: { taskId: failed.taskId } })).toBe(
      2
    );
    await expect(archive.archiveSignedContract({ taskId: failed.taskId })).rejects.toThrow(
      FADADA_ARCHIVE_INVALID_TASK
    );
    expect(boundaryCounts(boundaries)).toEqual({
      createContractFiling: 0,
      deleteObject: 0,
      downloadSignedContract: 0,
      getObject: 0,
      putObject: 0,
      queryContractStatus: 0,
      querySignResult: 0
    });
    expect(await activationWriteCounts(prisma, failed.orderId)).toEqual({
      leases: 0,
      periods: 0
    });
  });

  it("admits exactly one persisted PDF archive and preserves non-archive authorities", async () => {
    const fixture = await createStage1ArchiveFixture(prisma, `b3-archive-${randomUUID()}`);
    await esign.handleCallback("fadada", callbackPayload(fixture, "3000"));

    const contractVersionBefore = await prisma.contractVersion.findUniqueOrThrow({
      where: { id: fixture.contractVersionId }
    });
    const contractBefore = await prisma.contract.findUniqueOrThrow({
      where: { id: fixture.contractId }
    });
    const signedAtBefore = contractBefore.signedAt;
    const orderBefore = await prisma.subscriptionOrder.findUniqueOrThrow({
      where: { id: fixture.orderId }
    });
    const activationBefore = await activationWriteCounts(prisma, fixture.orderId);

    await expect(archive.archiveSignedContract({ taskId: fixture.taskId })).rejects.toThrow(
      FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF
    );
    expect(
      await prisma.contract.findUniqueOrThrow({ where: { id: fixture.contractId } })
    ).toMatchObject({
      archivedAt: null,
      fileId: null,
      signedAt: signedAtBefore,
      status: ContractStatus.SIGNED
    });
    expect(
      await prisma.fileObject.count({
        where: { objectKey: { contains: `contracts/${fixture.contractId}/` } }
      })
    ).toBe(0);
    expect(
      await prisma.subscriptionJourneyEvent.count({
        where: { eventKey: `fadada-artifact:${fixture.taskId}:archived` }
      })
    ).toBe(0);
    expect(boundaryCounts(boundaries)).toEqual({
      createContractFiling: 0,
      deleteObject: 0,
      downloadSignedContract: 1,
      getObject: 0,
      putObject: 0,
      queryContractStatus: 0,
      querySignResult: 1
    });
    expect(await activationWriteCounts(prisma, fixture.orderId)).toEqual(activationBefore);

    boundaries.selectBytes(PDF_BYTES);
    const first = await archive.archiveSignedContract({ taskId: fixture.taskId });
    const contract = await prisma.contract.findUniqueOrThrow({
      where: { id: fixture.contractId }
    });
    const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: contract.fileId! } });
    const contractVersionAfter = await prisma.contractVersion.findUniqueOrThrow({
      where: { id: fixture.contractVersionId }
    });
    const orderAfter = await prisma.subscriptionOrder.findUniqueOrThrow({
      where: { id: fixture.orderId }
    });

    expect(first).toMatchObject({ archived: true, signedPdfObjectKey: expect.any(String) });
    expect(contract).toMatchObject({
      archivedAt: expect.any(Date),
      fileId: expect.any(String),
      signedAt: signedAtBefore,
      status: ContractStatus.ARCHIVED
    });
    expect(file).toMatchObject({
      bucket: "application-materials",
      contentSha256: createHash("sha256").update(PDF_BYTES).digest("hex"),
      mimeType: "application/pdf",
      objectKey: first.signedPdfObjectKey,
      originalName: `${contract.contractNo}-signed.pdf`,
      sizeBytes: BigInt(PDF_BYTES.length)
    });
    expect(contract.fileId).toBe(file.id);
    expect(boundaries.storedBytes.get(`application-materials/${first.signedPdfObjectKey}`)).toEqual(
      PDF_BYTES
    );
    expect(contractVersionAfter).toEqual(contractVersionBefore);
    expect(orderAfter).toEqual(orderBefore);
    expect(orderAfter.orderStatus).toBe(OrderStatus.PENDING_PAYMENT);
    expect(await activationWriteCounts(prisma, fixture.orderId)).toEqual({
      leases: 0,
      periods: 0
    });
    expect(
      await prisma.subscriptionJourneyEvent.count({
        where: { eventKey: `fadada-artifact:${fixture.taskId}:archived` }
      })
    ).toBe(1);
    expect(
      await prisma.subscriptionJourneyOutbox.count({
        where: { eventKey: `fadada-artifact:${fixture.taskId}:archived:outbox` }
      })
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { entityId: fixture.contractId, entityType: "contract", module: "esign" }
      })
    ).toBe(1);
    expect(boundaryCounts(boundaries)).toEqual({
      createContractFiling: 1,
      deleteObject: 0,
      downloadSignedContract: 2,
      getObject: 0,
      putObject: 1,
      queryContractStatus: 0,
      querySignResult: 2
    });

    await esign.handleCallback("fadada", callbackPayload(fixture, "3000"));
    await esign.handleCallback("fadada", callbackPayload(fixture, "3001"));
    const contractAfterCallbacks = await prisma.contract.findUniqueOrThrow({
      where: { id: fixture.contractId }
    });
    expect(contractAfterCallbacks).toMatchObject({
      archivedAt: contract.archivedAt,
      fileId: contract.fileId,
      signedAt: contract.signedAt,
      status: ContractStatus.ARCHIVED
    });
    expect(
      await prisma.subscriptionJourneyEvent.count({
        where: {
          eventKey: {
            in: [
              `fadada-task:${fixture.taskId}:completed`,
              `fadada-artifact:${fixture.taskId}:archived`
            ]
          }
        }
      })
    ).toBe(2);
    expect(
      await prisma.subscriptionJourneyOutbox.count({ where: { journeyId: fixture.journeyId } })
    ).toBe(2);

    const countersAfterFirstArchive = boundaryCounts(boundaries);
    await expect(archive.archiveSignedContract({ taskId: fixture.taskId })).resolves.toMatchObject({
      archived: false,
      skippedReason: "SIGNED_PDF_ALREADY_ARCHIVED"
    });
    expect(boundaryCounts(boundaries)).toEqual(countersAfterFirstArchive);
    expect(
      await prisma.fileObject.count({
        where: { objectKey: { contains: `contracts/${fixture.contractId}/` } }
      })
    ).toBe(1);
    expect(
      await prisma.subscriptionJourneyEvent.count({
        where: { eventKey: `fadada-artifact:${fixture.taskId}:archived` }
      })
    ).toBe(1);
    expect(
      await prisma.subscriptionJourneyOutbox.count({
        where: { eventKey: `fadada-artifact:${fixture.taskId}:archived:outbox` }
      })
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { entityId: fixture.contractId, entityType: "contract", module: "esign" }
      })
    ).toBe(1);
  });

  it("converges archive-first and repeated signal dispatch without a B4 write", async () => {
    const fixture = await createStage1ArchiveFixture(prisma, `b3-signal-${randomUUID()}`);
    await esign.handleCallback("fadada", callbackPayload(fixture, "3000"));
    boundaries.selectBytes(PDF_BYTES);
    await archive.archiveSignedContract({ taskId: fixture.taskId });

    const taskOutbox = await prisma.subscriptionJourneyOutbox.findUniqueOrThrow({
      where: { eventKey: `fadada-task:${fixture.taskId}:completed:outbox` }
    });
    const archiveOutbox = await prisma.subscriptionJourneyOutbox.findUniqueOrThrow({
      where: { eventKey: `fadada-artifact:${fixture.taskId}:archived:outbox` }
    });

    await prisma.$transaction((tx) => journey.dispatchSignalOutbox(tx, archiveOutbox as never));
    await prisma.$transaction((tx) => journey.dispatchSignalOutbox(tx, taskOutbox as never));
    await prisma.$transaction((tx) => journey.dispatchSignalOutbox(tx, taskOutbox as never));
    await prisma.$transaction((tx) => journey.dispatchSignalOutbox(tx, archiveOutbox as never));

    const journeyAfter = await prisma.subscriptionJourney.findUniqueOrThrow({
      where: { id: fixture.journeyId }
    });
    const signingStepAfter = await prisma.subscriptionJourneyStep.findUniqueOrThrow({
      where: {
        journeyId_code: {
          code: SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
          journeyId: fixture.journeyId
        }
      }
    });
    expect(journeyAfter.currentStepCode).toBe(SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT);
    expect(signingStepAfter.status).toBe(SubscriptionJourneyStepStatus.COMPLETED);
    expect(
      await prisma.subscriptionJourneyEvent.count({
        where: {
          eventKey:
            `journey:${fixture.journeyId}:step:FADADA_SIGNING_AND_ARCHIVE:` +
            `contract:${fixture.contractId}:archived`
        }
      })
    ).toBe(1);
    expect(
      await prisma.subscriptionJourneyJob.count({
        where: {
          jobType: SubscriptionJourneyJobType.RECONCILE_FADADA_SIGNING,
          journeyId: fixture.journeyId
        }
      })
    ).toBe(0);
    expect(await activationWriteCounts(prisma, fixture.orderId)).toEqual({
      leases: 0,
      periods: 0
    });
  });
});
