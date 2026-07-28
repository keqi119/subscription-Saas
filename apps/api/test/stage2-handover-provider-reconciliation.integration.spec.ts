/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  DeliveryHandoverStatus,
  ESignDocumentType,
  ESignProviderActionType,
  ESignProviderType,
  ESignSignerStatus,
  ESignSignerType,
  ESignSigningStage,
  ESignSlotId,
  ESignTaskStatus,
  Prisma,
  VehicleHandoverType,
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType,
  VehicleHandoverWorkOrderStatus
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "vitest";

import { ESignService } from "../src/esign/esign.service";
import { PrismaService } from "../src/prisma/prisma.service";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://subscription:subscription@127.0.0.1:5432/subscription_saas?schema=public";
const COMPLETED_AT = new Date("2026-07-28T02:00:00.000Z");
const SIGNED_QUERY_RESULT = {
  resultCode: "3000",
  status: "SIGNED"
} as const;

describe("Stage 2 provider reconciliation PostgreSQL interleaving", () => {
  let callbackClient: PrismaService;
  let queryClient: PrismaService;

  beforeAll(async () => {
    callbackClient = createPrismaClient();
    queryClient = createPrismaClient();
    await Promise.all([
      callbackClient.onModuleInit(),
      queryClient.onModuleInit()
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      callbackClient.onModuleDestroy(),
      queryClient.onModuleDestroy()
    ]);
  });

  it("converges an H1 callback/query race through a real P2034 retry", async () => {
    const fixture = await createFixture(callbackClient, "H1");
    const barrier = new TwoPartyBarrier();
    const callbackObservation = createObservation();
    const queryObservation = createObservation();
    const callbackService = createService(
      observeSerializableTransactions(
        callbackClient,
        barrier,
        callbackObservation
      )
    );
    const queryService = createService(
      observeSerializableTransactions(
        queryClient,
        barrier,
        queryObservation
      )
    );

    try {
      await Promise.all([
        callbackService.reconcileCustomerSigned({
          completedAt: COMPLETED_AT,
          eSignTaskId: fixture.taskId,
          providerTransactionId: fixture.customerTransactionId,
          source: "CALLBACK"
        }),
        queryService.reconcileCustomerSigned({
          completedAt: COMPLETED_AT,
          eSignTaskId: fixture.taskId,
          providerTransactionId: fixture.customerTransactionId,
          queryResult: SIGNED_QUERY_RESULT,
          source: "QUERY"
        })
      ]);

      const snapshot = await readFixtureSnapshot(
        callbackClient,
        fixture
      );
      expect(snapshot.task).toMatchObject({
        completedAt: null,
        taskStatus: ESignTaskStatus.SIGNING
      });
      expect(snapshot.customerSigner).toMatchObject({
        signedAt: COMPLETED_AT,
        signerStatus: ESignSignerStatus.SIGNED
      });
      expect(snapshot.platformSigner).toMatchObject({
        signedAt: null,
        signerStatus: ESignSignerStatus.PENDING
      });
      expect(snapshot.handover).toMatchObject({
        completedAt: null,
        customerSignedAt: COMPLETED_AT,
        status: DeliveryHandoverStatus.PENDING_PLATFORM_SEAL
      });
      expect(
        snapshot.jobs.filter(
          (job) =>
            job.jobType ===
            VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM
        )
      ).toHaveLength(1);
      expect(
        snapshot.jobs.filter(
          (job) =>
            job.jobType ===
              VehicleHandoverWorkflowJobType
                .RECONCILE_CUSTOMER_SIGNATURE &&
            job.jobStatus ===
              VehicleHandoverWorkflowJobStatus.CANCELLED
        )
      ).toHaveLength(1);
      assertOneQueryAudit(snapshot.audits, fixture);
      assertRealSerializableRetry(
        barrier,
        callbackObservation,
        queryObservation
      );
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("converges an H2 callback/query race on one archive job and audit", async () => {
    const fixture = await createFixture(callbackClient, "H2");
    const barrier = new TwoPartyBarrier();
    const callbackObservation = createObservation();
    const queryObservation = createObservation();
    const callbackService = createService(
      observeSerializableTransactions(
        callbackClient,
        barrier,
        callbackObservation
      )
    );
    const queryService = createService(
      observeSerializableTransactions(
        queryClient,
        barrier,
        queryObservation
      )
    );

    try {
      await Promise.all([
        callbackService.reconcilePlatformSigned({
          completedAt: COMPLETED_AT,
          eSignTaskId: fixture.taskId,
          providerTransactionId: fixture.platformTransactionId,
          source: "CALLBACK"
        }),
        queryService.reconcilePlatformSigned({
          completedAt: COMPLETED_AT,
          eSignTaskId: fixture.taskId,
          providerTransactionId: fixture.platformTransactionId,
          queryResult: SIGNED_QUERY_RESULT,
          source: "QUERY"
        })
      ]);

      const snapshot = await readFixtureSnapshot(
        callbackClient,
        fixture
      );
      expect(snapshot.task).toMatchObject({
        completedAt: COMPLETED_AT,
        taskStatus: ESignTaskStatus.COMPLETED
      });
      expect(snapshot.task.contract).toMatchObject({
        signedAt: COMPLETED_AT,
        status: ContractStatus.SIGNED
      });
      expect(snapshot.customerSigner).toMatchObject({
        signerStatus: ESignSignerStatus.SIGNED
      });
      expect(snapshot.platformSigner).toMatchObject({
        signedAt: COMPLETED_AT,
        signerStatus: ESignSignerStatus.SIGNED
      });
      expect(snapshot.handover).toMatchObject({
        completedAt: COMPLETED_AT,
        customerSignedAt: fixture.customerSignedAt,
        platformSignedAt: COMPLETED_AT,
        status: DeliveryHandoverStatus.SIGNED
      });
      expect(
        snapshot.jobs.filter(
          (job) =>
            job.jobType ===
            VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF
        )
      ).toHaveLength(1);
      expect(
        snapshot.jobs.filter(
          (job) =>
            (
              job.jobType ===
                VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM ||
              job.jobType ===
                VehicleHandoverWorkflowJobType.RECONCILE_PLATFORM_SEAL
            ) &&
            job.jobStatus ===
              VehicleHandoverWorkflowJobStatus.CANCELLED
        )
      ).toHaveLength(2);
      assertOneQueryAudit(snapshot.audits, fixture);
      assertRealSerializableRetry(
        barrier,
        callbackObservation,
        queryObservation
      );
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});

function createPrismaClient() {
  return new PrismaService(
    new ConfigService({
      DATABASE_POOL_MAX: "4",
      DATABASE_URL: TEST_DATABASE_URL
    })
  );
}

function createService(prisma: {
  $transaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel }
  ): Promise<T>;
}) {
  return new ESignService(
    { write: async () => undefined } as never,
    new ConfigService(),
    {} as never,
    prisma as never
  );
}

function observeSerializableTransactions(
  client: PrismaService,
  barrier: TwoPartyBarrier,
  observation: TransactionObservation
) {
  return {
    async $transaction<T>(
      callback: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel }
    ) {
      observation.attempts += 1;
      observation.isolationLevels.push(options?.isolationLevel);
      const attempt = observation.attempts;
      try {
        return await client.$transaction(async (tx) => {
          return callback(
            attempt === 1
              ? withTaskReadBarrier(
                  tx,
                  barrier,
                  observation
                )
              : tx
          );
        }, options);
      } catch (error) {
        if (readErrorCode(error) === "P2034") {
          observation.serializationConflicts += 1;
        }
        throw error;
      }
    }
  };
}

function withTaskReadBarrier(
  tx: Prisma.TransactionClient,
  barrier: TwoPartyBarrier,
  observation: TransactionObservation
) {
  let waited = false;
  const taskDelegate = new Proxy(
    tx.contractESignTask as any,
    {
      get(target, property) {
        if (property !== "findUnique") {
          return Reflect.get(target, property, target);
        }
        return async (...args: any[]) => {
          const result = await target.findUnique(...args);
          if (!waited) {
            waited = true;
            const [backend] =
              await tx.$queryRaw<Array<{ pid: number }>>`
                SELECT pg_backend_pid() AS "pid"
              `;
            observation.backendPids.add(backend!.pid);
            await barrier.arrive();
          }
          return result;
        };
      }
    }
  );

  return new Proxy(tx as any, {
    get(target, property) {
      if (property === "contractESignTask") {
        return taskDelegate;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function"
        ? value.bind(target)
        : value;
    }
  }) as Prisma.TransactionClient;
}

class TwoPartyBarrier {
  arrivals = 0;
  private readonly release: Promise<void>;
  private resolve!: () => void;
  private reject!: (error: Error) => void;
  private readonly timer: NodeJS.Timeout;

  constructor() {
    this.release = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.timer = setTimeout(() => {
      this.reject(
        new Error("Timed out waiting for both PostgreSQL transactions.")
      );
    }, 10_000);
  }

  async arrive() {
    this.arrivals += 1;
    if (this.arrivals === 2) {
      clearTimeout(this.timer);
      this.resolve();
    }
    await this.release;
  }
}

function createObservation(): TransactionObservation {
  return {
    attempts: 0,
    backendPids: new Set<number>(),
    isolationLevels: [],
    serializationConflicts: 0
  };
}

function assertRealSerializableRetry(
  barrier: TwoPartyBarrier,
  left: TransactionObservation,
  right: TransactionObservation
) {
  expect(barrier.arrivals).toBe(2);
  expect(left.attempts + right.attempts).toBeGreaterThanOrEqual(3);
  expect(
    left.serializationConflicts + right.serializationConflicts
  ).toBeGreaterThanOrEqual(1);
  expect(
    new Set([
      ...left.backendPids,
      ...right.backendPids
    ]).size
  ).toBe(2);
  expect([
    ...left.isolationLevels,
    ...right.isolationLevels
  ]).toEqual(
    expect.arrayContaining([
      Prisma.TransactionIsolationLevel.Serializable,
      Prisma.TransactionIsolationLevel.Serializable
    ])
  );
}

function assertOneQueryAudit(
  audits: Awaited<ReturnType<typeof readFixtureSnapshot>>["audits"],
  fixture: DatabaseFixture
) {
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    action: "UPDATE",
    afterSnapshot: {
      eventType: "STAGE2_PROVIDER_SIGNER_STATUS_QUERY",
      providerStatus: "SIGNED",
      providerTransactionId:
        fixture.stage === "H1"
          ? fixture.customerTransactionId
          : fixture.platformTransactionId,
      resultCode: "3000",
      slotId:
        fixture.stage === "H1"
          ? ESignSlotId.STAGE2_HANDOVER_CUSTOMER
          : ESignSlotId.STAGE2_HANDOVER_PLATFORM,
      source: "QUERY"
    },
    entityId: fixture.taskId,
    entityType: "ContractESignTaskProviderQuery",
    module: "esign"
  });
}

async function readFixtureSnapshot(
  prisma: PrismaService,
  fixture: DatabaseFixture
) {
  const task = await prisma.contractESignTask.findUniqueOrThrow({
    include: {
      contract: true,
      signers: true
    },
    where: { id: fixture.taskId }
  });
  return {
    audits: await prisma.auditLog.findMany({
      where: {
        entityId: fixture.taskId,
        entityType: "ContractESignTaskProviderQuery"
      }
    }),
    customerSigner: task.signers.find(
      (signer) =>
        signer.slotId === ESignSlotId.STAGE2_HANDOVER_CUSTOMER
    )!,
    handover:
      await prisma.vehicleDeliveryHandover.findUniqueOrThrow({
        where: { id: fixture.handoverId }
      }),
    jobs: await prisma.vehicleHandoverWorkflowJob.findMany({
      where: { workOrderId: fixture.workOrderId }
    }),
    platformSigner: task.signers.find(
      (signer) =>
        signer.slotId === ESignSlotId.STAGE2_HANDOVER_PLATFORM
    )!,
    task
  };
}

async function createFixture(
  prisma: PrismaService,
  stage: "H1" | "H2"
): Promise<DatabaseFixture> {
  const contractId = randomUUID();
  const customerId = randomUUID();
  const handoverId = randomUUID();
  const orderId = randomUUID();
  const taskId = randomUUID();
  const taskNo =
    `ESG${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`;
  const customerTransactionId = `${taskNo}H1`;
  const platformTransactionId = `${taskNo}H2`;
  const workOrderId = randomUUID();
  const customerSignedAt =
    new Date("2026-07-28T01:55:00.000Z");

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SET LOCAL session_replication_role = replica
    `;
    await tx.contract.create({
      data: {
        contractNo: `HDV-${randomUUID()}`,
        contractSnapshot: {},
        contractTitle: "Stage 2 reconciliation integration",
        contractVersionId: randomUUID(),
        customerId,
        id: contractId,
        orderId,
        status: ContractStatus.SIGNING
      }
    });
    await tx.contractESignTask.create({
      data: {
        contractId,
        documentType: ESignDocumentType.DELIVERY_HANDOVER,
        id: taskId,
        provider: ESignProviderType.FADADA,
        providerEnvelopeId: taskNo,
        providerTaskId: customerTransactionId,
        signingStage:
          ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
        taskNo,
        taskStatus:
          stage === "H1"
            ? ESignTaskStatus.WAITING_CUSTOMER
            : ESignTaskStatus.SIGNING
      }
    });
    await tx.contractESignSigner.createMany({
      data: [
        {
          customerId,
          documentType: ESignDocumentType.DELIVERY_HANDOVER,
          id: randomUUID(),
          providerActionType:
            ESignProviderActionType.CUSTOMER_MANUAL_SIGN,
          providerTransactionId: customerTransactionId,
          signedAt: stage === "H2" ? customerSignedAt : null,
          signerStatus:
            stage === "H1"
              ? ESignSignerStatus.SIGNING
              : ESignSignerStatus.SIGNED,
          signerType: ESignSignerType.CUSTOMER,
          slotId: ESignSlotId.STAGE2_HANDOVER_CUSTOMER,
          taskId
        },
        {
          documentType: ESignDocumentType.DELIVERY_HANDOVER,
          id: randomUUID(),
          providerActionType:
            ESignProviderActionType.PLATFORM_AUTO_SEAL,
          providerTransactionId:
            stage === "H2" ? platformTransactionId : null,
          signerStatus:
            stage === "H2"
              ? ESignSignerStatus.SIGNING
              : ESignSignerStatus.PENDING,
          signerType: ESignSignerType.PLATFORM,
          slotId: ESignSlotId.STAGE2_HANDOVER_PLATFORM,
          taskId
        }
      ]
    });
    await tx.vehicleDeliveryHandover.create({
      data: {
        artifactVersion: 3,
        customerSignedAt:
          stage === "H2" ? customerSignedAt : null,
        handoverContractId: contractId,
        handoverESignTaskId: taskId,
        id: handoverId,
        orderId,
        stage1ContractId: contractId,
        status:
          stage === "H1"
            ? DeliveryHandoverStatus
                .PENDING_CUSTOMER_SIGNATURE
            : DeliveryHandoverStatus.PENDING_PLATFORM_SEAL
      }
    });
    await tx.vehicleHandoverWorkOrder.create({
      data: {
        handoverId,
        handoverType: VehicleHandoverType.DELIVERY_OUTBOUND,
        id: workOrderId,
        orderId,
        status: VehicleHandoverWorkOrderStatus.SIGNING
      }
    });
    if (stage === "H1") {
      await tx.vehicleHandoverWorkflowJob.create({
        data: {
          eSignTaskId: taskId,
          handoverId,
          idempotencyKey:
            `customer-reconcile:${taskId}:${customerTransactionId}`,
          jobType:
            VehicleHandoverWorkflowJobType
              .RECONCILE_CUSTOMER_SIGNATURE,
          payload: { customerTransactionId },
          workOrderId
        }
      });
    } else {
      await tx.vehicleHandoverWorkflowJob.createMany({
        data: [
          {
            eSignTaskId: taskId,
            handoverId,
            idempotencyKey:
              `platform-seal:${taskId}:${platformTransactionId}`,
            jobType:
              VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM,
            payload: { platformTransactionId },
            workOrderId
          },
          {
            eSignTaskId: taskId,
            handoverId,
            idempotencyKey:
              `platform-reconcile:${taskId}:${platformTransactionId}`,
            jobType:
              VehicleHandoverWorkflowJobType
                .RECONCILE_PLATFORM_SEAL,
            payload: { platformTransactionId },
            workOrderId
          }
        ]
      });
    }
  });

  return {
    contractId,
    customerSignedAt,
    customerTransactionId,
    handoverId,
    platformTransactionId,
    stage,
    taskId,
    workOrderId,
    async cleanup() {
      await prisma.vehicleHandoverWorkflowJob.deleteMany({
        where: { workOrderId }
      });
      await prisma.auditLog.deleteMany({
        where: { entityId: taskId }
      });
      await prisma.vehicleHandoverWorkOrder.deleteMany({
        where: { id: workOrderId }
      });
      await prisma.vehicleDeliveryHandover.deleteMany({
        where: { id: handoverId }
      });
      await prisma.contractESignSigner.deleteMany({
        where: { taskId }
      });
      await prisma.contractESignTask.deleteMany({
        where: { id: taskId }
      });
      await prisma.contract.deleteMany({
        where: { id: contractId }
      });
    }
  };
}

function readErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : null;
}

interface TransactionObservation {
  attempts: number;
  backendPids: Set<number>;
  isolationLevels: Array<
    Prisma.TransactionIsolationLevel | undefined
  >;
  serializationConflicts: number;
}

interface DatabaseFixture {
  cleanup(): Promise<void>;
  contractId: string;
  customerSignedAt: Date;
  customerTransactionId: string;
  handoverId: string;
  platformTransactionId: string;
  stage: "H1" | "H2";
  taskId: string;
  workOrderId: string;
}
