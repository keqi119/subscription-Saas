import { ConfigService } from "@nestjs/config";
import {
  ApplicationSource,
  BillStatus,
  BillType,
  ContractStatus,
  ContractVersionStatus,
  DeliveryEvidenceRequirementLevel,
  DeliveryEvidenceReviewStatus,
  DeliveryEvidenceStatus,
  DeliveryEvidenceType,
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus,
  ESignProviderType,
  ESignTaskStatus,
  LeaseStatus,
  OrderSource,
  PaymentChannel,
  PaymentMethod,
  PaymentOrderStatus,
  PaymentProviderType,
  PaymentStatus,
  Prisma,
  SubscriptionJourneyManualDecision,
  SubscriptionJourneyStepCode,
  VehicleHandoverOpsReviewStatus,
  VehicleHandoverType,
  VehicleHandoverWorkOrderStatus
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../src/prisma/prisma.service";
import { JOURNEY_STEP_SEQUENCE } from "../src/subscription-journey/subscription-journey-state-machine";
import { SubscriptionJourneyRepository } from "../src/subscription-journey/subscription-journey.repository";
import { SubscriptionJourneySignalService } from "../src/subscription-journey/subscription-journey-signal.service";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";
import { insertRuntimeOrderGraph } from "./helpers/runtime-domain-fixture";

const TEST_DATABASE_URL = requiredReleaseDatabaseTestContext(
  "apps/api/test/subscription-journey-golden-path.e2e-spec.ts"
).databaseUrl;
const ROLLBACK = new Error("ROLL_BACK_GOLDEN_PATH_FIXTURE");
const FINAL_PLAN_COMMERCIAL_HASH = `sha256:${"a".repeat(64)}`;

type Tx = Prisma.TransactionClient;
type FlowSnapshot = Awaited<ReturnType<typeof driveGoldenPath>>;

describe("Stage 1 subscription Journey Golden Path", () => {
  let prisma: PrismaService;
  let repository: SubscriptionJourneyRepository;

  beforeAll(async () => {
    prisma = new PrismaService(
      new ConfigService({ DATABASE_POOL_MAX: "10", DATABASE_URL: TEST_DATABASE_URL })
    );
    await prisma.onModuleInit();
    repository = new SubscriptionJourneyRepository();
  });

  afterAll(async () => prisma.onModuleDestroy());

  it("converges Portal self-service A and Admin-assisted B on the same authoritative path", async () => {
    const portal = await rolledBack(prisma, (tx) =>
      driveGoldenPath(tx, repository, ApplicationSource.SELF_SERVICE)
    );
    const admin = await rolledBack(prisma, (tx) =>
      driveGoldenPath(tx, repository, ApplicationSource.SALES_ASSISTED)
    );

    expect(portal.stepCodes).toEqual(JOURNEY_STEP_SEQUENCE);
    expect(admin.stepCodes).toEqual(portal.stepCodes);
    expect(admin.manualTaskTypes).toEqual(portal.manualTaskTypes);
    expect(portal.manualTaskTypes).toEqual(["FINAL_PLAN_DECISION", "DELIVERY_EVIDENCE_DECISION"]);
    expect(stripEntrySpecificFacts(admin)).toEqual(stripEntrySpecificFacts(portal));
  });
});

async function driveGoldenPath(
  tx: Tx,
  repository: SubscriptionJourneyRepository,
  source: ApplicationSource
) {
  const ids = fixtureIds(source);
  const adapter = new DeterministicExternalAdapter(tx, ids);
  const signal = new SubscriptionJourneySignalService(repository, {} as never);
  await createEntryFacts(tx, ids, source);
  const journey = await repository.createOrGetForApplication(
    tx,
    ids.applicationId,
    `${ids.prefix}:submitted`
  );

  await completeCurrent(tx, repository, journey.id, "application-validated");
  const finalPlanStep = await current(tx, journey.id);
  await repository.openManualTask(tx, {
    inputSnapshot: {
      applicationId: ids.applicationId,
      finalPlanRevision: 0
    },
    journeyId: journey.id,
    stepId: finalPlanStep.step.id
  });
  await tx.application.update({
    data: {
      finalDepositAmount: 500_000n,
      finalPeriodMonths: 12,
      finalPlanCommercialHash: FINAL_PLAN_COMMERCIAL_HASH,
      finalPlanRevision: 1,
      finalPlanSnapshot: {
        periodMonths: 12,
        subscriptionPlanId: "approved-plan",
        vehicleId: ids.vehicleId
      },
      finalSubscriptionPlanId: randomUUID(),
      finalVehicleId: ids.vehicleId,
      softReservedVehicleId: ids.vehicleId
    },
    where: { id: ids.applicationId }
  });
  await signal.completeFinalPlanAndVehicleAllocation(tx, {
    actorId: ids.userId,
    applicationId: ids.applicationId,
    finalPlanCommercialHash: FINAL_PLAN_COMMERCIAL_HASH,
    finalPlanRevision: 1,
    vehicleId: ids.vehicleId
  });
  await tx.auditLog.create({
    data: {
      action: "UPDATE",
      afterSnapshot: {
        finalPlanCommercialHash: FINAL_PLAN_COMMERCIAL_HASH,
        finalPlanRevision: 1,
        softReservedVehicleId: ids.vehicleId,
        steps: ["FINAL_PLAN_DECISION", "FINAL_VEHICLE_ALLOCATION"]
      },
      entityId: ids.applicationId,
      entityType: "Application",
      module: `subscription_journey:${ids.applicationId}`
    }
  });

  expect((await current(tx, journey.id)).currentStepCode).toBe(
    SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION
  );
  await waitForCustomer(tx, repository, journey.id, "confirm-revision-1");
  await tx.application.update({
    data: {
      customerConfirmedPlanRevision: 1,
      planConfirmStatus: "CONFIRMED"
    },
    where: { id: ids.applicationId }
  });
  await completeCurrent(tx, repository, journey.id, "revision-1-confirmed");

  await adapter.createOrderAndContract(source);
  await tx.subscriptionJourney.update({
    data: { orderId: ids.orderId },
    where: { id: journey.id }
  });
  await completeCurrent(tx, repository, journey.id, "order-contract-created");

  await adapter.signSealAndArchiveWithFadada();
  await completeCurrent(tx, repository, journey.id, "fadada-archive-authoritative");

  await adapter.generateInitialBills();
  await completeCurrent(tx, repository, journey.id, "initial-bills-created");

  await waitForCustomer(tx, repository, journey.id, "wechat-jsapi-payment");
  await adapter.settleJsapiPayment();
  await completeCurrent(tx, repository, journey.id, "jsapi-payment-settled");

  await adapter.createStage2HandoverAndEvidence();
  await completeCurrent(tx, repository, journey.id, "handover-evidence-ready");
  await decideCurrentManualTask(tx, repository, journey.id, ids.userId, {
    handoverId: ids.handoverId,
    manifestHash: "a".repeat(64),
    workOrderId: ids.workOrderId
  });
  await completeCurrent(tx, repository, journey.id, "delivery-evidence-approved");

  await adapter.activateAuthoritativeSubscription();
  const activation = await current(tx, journey.id);
  await repository.completeActivation(tx, {
    expectedVersion: activation.version,
    journeyId: journey.id,
    payload: { leaseId: ids.leaseId, orderId: ids.orderId },
    stepId: activation.step.id
  });
  await tx.auditLog.create({
    data: {
      action: "UPDATE",
      afterSnapshot: {
        result: "COMPLETED",
        stepCode: SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION
      },
      entityId: ids.applicationId,
      entityType: "Application",
      module: ids.auditModule
    }
  });

  const persisted = await tx.subscriptionJourney.findUniqueOrThrow({
    include: { manualTasks: { orderBy: { createdAt: "asc" } }, steps: true },
    where: { id: journey.id }
  });
  const orderCount = await tx.subscriptionOrder.count({
    where: { applicationId: ids.applicationId }
  });
  const contracts = await tx.contract.findMany({
    include: { esignTasks: true },
    where: { orderId: ids.orderId }
  });
  const leases = await tx.lease.count({
    where: { orderId: ids.orderId, status: LeaseStatus.ACTIVE }
  });
  const schedules = await tx.billingSchedule.count({ where: { orderId: ids.orderId } });
  const bills = await tx.receivableBill.findMany({ where: { orderId: ids.orderId } });
  const payments = await tx.paymentRecord.count({ where: { orderId: ids.orderId } });
  const writeOffs = await tx.paymentWriteOff.count({ where: { orderId: ids.orderId } });
  const mandates = await tx.paymentMandate.count({ where: { orderId: ids.orderId } });
  const debitAttempts = await tx.debitAttempt.count({ where: { orderId: ids.orderId } });
  const audits = await tx.auditLog.count({ where: { module: ids.auditModule } });
  const handovers = await tx.vehicleDeliveryHandover.findMany({
    where: { orderId: ids.orderId }
  });

  expect(persisted).toMatchObject({
    currentStepCode: SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION,
    currentStepStatus: "COMPLETED",
    orderId: ids.orderId,
    status: "COMPLETED"
  });
  expect(persisted.completedAt).toBeInstanceOf(Date);
  expect(orderCount).toBe(1);
  expect(contracts).toHaveLength(1);
  expect(contracts[0]).toMatchObject({ status: ContractStatus.ARCHIVED });
  expect(contracts[0]?.archivedAt).toBeInstanceOf(Date);
  expect(contracts[0]?.fileId).toBe(ids.archivedContractFileId);
  expect(contracts[0]?.esignTasks).toEqual([
    expect.objectContaining({
      evidenceObjectKey: `${ids.prefix}/fadada/evidence.json`,
      provider: ESignProviderType.FADADA,
      signedDocumentObjectKey: `${ids.prefix}/fadada/signed.pdf`,
      taskStatus: ESignTaskStatus.COMPLETED
    })
  ]);
  expect(leases).toBe(1);
  expect(schedules).toBe(1);
  expect(bills).toHaveLength(2);
  expect(bills.every((bill) => bill.billStatus === BillStatus.PAID)).toBe(true);
  expect(bills.every((bill) => bill.remainingAmount === 0n)).toBe(true);
  expect(payments).toBe(1);
  expect(writeOffs).toBe(2);
  expect(handovers).toEqual([
    expect.objectContaining({
      archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
      manifestHash: "a".repeat(64),
      signedObjectKey: `${ids.prefix}/stage2/signed.pdf`,
      signedPdfHash: "b".repeat(64),
      status: DeliveryHandoverStatus.ARCHIVED
    })
  ]);
  expect(audits).toBe(JOURNEY_STEP_SEQUENCE.length - 1);
  expect([mandates, debitAttempts]).toEqual([0, 0]);

  return {
    auditCount: audits,
    billStatuses: bills.map(({ billStatus }) => billStatus).sort(),
    contractCount: contracts.length,
    debitAttemptCount: debitAttempts,
    journeyStatus: persisted.status,
    leaseCount: leases,
    mandateCount: mandates,
    manualTaskTypes: persisted.manualTasks.map(({ taskType }) => taskType),
    orderCount,
    paymentCount: payments,
    scheduleCount: schedules,
    source,
    stepCodes: persisted.steps
      .sort(
        (left, right) =>
          JOURNEY_STEP_SEQUENCE.indexOf(left.code) - JOURNEY_STEP_SEQUENCE.indexOf(right.code)
      )
      .map(({ code }) => code),
    writeOffCount: writeOffs
  };
}

class DeterministicExternalAdapter {
  constructor(
    private readonly tx: Tx,
    private readonly ids: ReturnType<typeof fixtureIds>
  ) {}

  async createOrderAndContract(source: ApplicationSource) {
    await insertRuntimeOrderGraph(this.tx, {
      applicationId: this.ids.applicationId,
      customerId: this.ids.customerId,
      label: this.ids.prefix,
      orderId: this.ids.orderId,
      salesUserId: this.ids.userId,
      vehicleId: this.ids.vehicleId
    });
    await this.tx.subscriptionOrder.update({
      data: {
        orderSource:
          source === ApplicationSource.SELF_SERVICE
            ? OrderSource.CUSTOMER_SELF_SERVICE
            : OrderSource.SALES_ASSISTED,
        quoteSnapshot: { revision: 1 }
      },
      where: { id: this.ids.orderId }
    });

    const version = await this.tx.contractVersion.create({
      data: {
        contentTemplate: "Deterministic Stage 1 contract",
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        status: ContractVersionStatus.ACTIVE,
        templateName: `${this.ids.prefix}-stage1`,
        versionNo: "1"
      }
    });
    await this.tx.contract.create({
      data: {
        contractNo: `${this.ids.prefix}-CONTRACT`,
        contractSnapshot: { finalPlanRevision: 1 },
        contractTitle: "Stage 1 Subscription Contract",
        contractVersionId: version.id,
        customerId: this.ids.customerId,
        id: this.ids.contractId,
        orderId: this.ids.orderId,
        status: ContractStatus.GENERATED
      }
    });
    await this.tx.subscriptionOrder.update({
      data: { contractId: this.ids.contractId },
      where: { id: this.ids.orderId }
    });
  }

  async signSealAndArchiveWithFadada() {
    const archivedAt = new Date("2026-08-06T00:03:00.000Z");
    await this.tx.contractESignTask.create({
      data: {
        completedAt: archivedAt,
        contractId: this.ids.contractId,
        customerId: this.ids.customerId,
        evidenceObjectKey: `${this.ids.prefix}/fadada/evidence.json`,
        orderId: this.ids.orderId,
        provider: ESignProviderType.FADADA,
        providerTaskId: `${this.ids.prefix}-FADADA`,
        signedDocumentObjectKey: `${this.ids.prefix}/fadada/signed.pdf`,
        taskNo: `${this.ids.prefix}-ESIGN`,
        taskStatus: ESignTaskStatus.COMPLETED
      }
    });
    await this.tx.contract.update({
      data: {
        archivedAt,
        contractSnapshot: {
          archivedPdf: {
            objectKey: `${this.ids.prefix}/fadada/signed.pdf`,
            sha256: "c".repeat(64)
          },
          finalPlanRevision: 1
        },
        fileId: this.ids.archivedContractFileId,
        signedAt: archivedAt,
        status: ContractStatus.ARCHIVED
      },
      where: { id: this.ids.contractId }
    });
  }

  async generateInitialBills() {
    const dueDate = new Date("2026-08-07T00:00:00.000Z");
    await this.tx.receivableBill.createMany({
      data: [
        {
          amount: 500_000n,
          billNo: `${this.ids.prefix}-DEPOSIT`,
          billType: BillType.DEPOSIT,
          customerId: this.ids.customerId,
          dueDate,
          orderId: this.ids.orderId,
          remainingAmount: 500_000n,
          sourceKey: `${this.ids.prefix}:bill:deposit`
        },
        {
          amount: 100_000n,
          billNo: `${this.ids.prefix}-FIRST-MONTH`,
          billType: BillType.FIRST_MONTHLY_FEE,
          customerId: this.ids.customerId,
          dueDate,
          orderId: this.ids.orderId,
          remainingAmount: 100_000n,
          sourceKey: `${this.ids.prefix}:bill:first-month`
        }
      ]
    });
  }

  async settleJsapiPayment() {
    const existing = await this.tx.paymentOrder.findUnique({
      where: { paymentOrderNo: `${this.ids.prefix}-JSAPI` }
    });
    if (existing?.paymentStatus === PaymentOrderStatus.PAID) return;
    const bills = await this.tx.receivableBill.findMany({
      orderBy: { billNo: "asc" },
      where: { orderId: this.ids.orderId }
    });
    const paidAt = new Date("2026-08-06T00:05:00.000Z");
    const payment = await this.tx.paymentRecord.create({
      data: {
        customerId: this.ids.customerId,
        orderId: this.ids.orderId,
        paymentAmount: 600_000n,
        paymentMethod: PaymentMethod.WECHAT,
        paymentNo: `${this.ids.prefix}-PAYMENT`,
        paymentStatus: PaymentStatus.CONFIRMED,
        receivedAt: paidAt
      }
    });
    const paymentOrder = await this.tx.paymentOrder.create({
      data: {
        amount: 600_000n,
        customerId: this.ids.customerId,
        orderId: this.ids.orderId,
        paidAmount: 600_000n,
        paidAt,
        paymentChannel: PaymentChannel.WECHAT_JSAPI,
        paymentOrderNo: `${this.ids.prefix}-JSAPI`,
        paymentRecordId: payment.id,
        paymentStatus: PaymentOrderStatus.PAID,
        provider: PaymentProviderType.WECHAT_PAY,
        providerTransactionId: `${this.ids.prefix}-WX-TXN`
      }
    });
    for (const bill of bills) {
      await this.tx.paymentOrderItem.create({
        data: { amount: bill.amount, billId: bill.id, paymentOrderId: paymentOrder.id }
      });
      await this.tx.paymentWriteOff.create({
        data: {
          billId: bill.id,
          customerId: this.ids.customerId,
          orderId: this.ids.orderId,
          paymentId: payment.id,
          writeOffAmount: bill.amount,
          writeOffAt: paidAt
        }
      });
      await this.tx.receivableBill.update({
        data: {
          billStatus: BillStatus.PAID,
          paidAmount: bill.amount,
          paidAt,
          remainingAmount: 0n
        },
        where: { id: bill.id }
      });
    }
    await this.tx.paymentCallbackLog.create({
      data: {
        eventType: "TRANSACTION.SUCCESS",
        handled: true,
        handledAt: paidAt,
        paymentOrderId: paymentOrder.id,
        provider: PaymentProviderType.WECHAT_PAY,
        providerTransactionId: `${this.ids.prefix}-WX-TXN`,
        verified: true
      }
    });
  }

  async createStage2HandoverAndEvidence() {
    const completedAt = new Date("2026-08-06T00:06:00.000Z");
    await this.tx.vehicleDeliveryHandover.create({
      data: {
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        archivedAt: completedAt,
        completedAt,
        customerSignedAt: completedAt,
        id: this.ids.handoverId,
        manifestHash: "a".repeat(64),
        orderId: this.ids.orderId,
        platformSignedAt: completedAt,
        signedDocumentFileId: randomUUID(),
        signedObjectKey: `${this.ids.prefix}/stage2/signed.pdf`,
        signedPdfHash: "b".repeat(64),
        stage1ContractId: this.ids.contractId,
        status: DeliveryHandoverStatus.ARCHIVED
      }
    });
    await this.tx.vehicleHandoverWorkOrder.create({
      data: {
        assignedInternalUserId: this.ids.userId,
        fieldCompletedAt: completedAt,
        handoverId: this.ids.handoverId,
        handoverType: VehicleHandoverType.DELIVERY_OUTBOUND,
        id: this.ids.workOrderId,
        opsReviewedAt: completedAt,
        opsReviewedBy: this.ids.userId,
        opsReviewStatus: VehicleHandoverOpsReviewStatus.APPROVED,
        orderId: this.ids.orderId,
        status: VehicleHandoverWorkOrderStatus.OPS_REVIEWED
      }
    });
    await this.tx.vehicleDeliveryEvidenceItem.create({
      data: {
        evidenceType: DeliveryEvidenceType.CUSTOMER_WITH_VEHICLE_FRONT,
        handoverId: this.ids.handoverId,
        isRequired: true,
        orderId: this.ids.orderId,
        requirementLevel: DeliveryEvidenceRequirementLevel.REQUIRED,
        reviewStatus: DeliveryEvidenceReviewStatus.APPROVED,
        status: DeliveryEvidenceStatus.APPROVED,
        title: "Customer delivery evidence"
      }
    });
  }

  async activateAuthoritativeSubscription() {
    await this.tx.lease.create({
      data: {
        activatedAt: new Date("2026-08-06T00:07:00.000Z"),
        id: this.ids.leaseId,
        orderId: this.ids.orderId,
        status: LeaseStatus.ACTIVE
      }
    });
    await this.tx.billingSchedule.create({
      data: {
        lastGeneratedBillId: (
          await this.tx.receivableBill.findFirstOrThrow({ where: { orderId: this.ids.orderId } })
        ).id,
        nextCycleNo: 2,
        nextGenerateAt: new Date("2026-09-01T00:00:00.000Z"),
        nextPeriodEnd: new Date("2026-09-30T00:00:00.000Z"),
        nextPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        orderId: this.ids.orderId
      }
    });
    await this.tx.subscriptionOrder.update({
      data: {
        orderStatus: "ACTIVE",
        startDate: new Date("2026-08-06T00:00:00.000Z")
      },
      where: { id: this.ids.orderId }
    });
  }
}

async function completeCurrent(
  tx: Tx,
  repository: SubscriptionJourneyRepository,
  journeyId: string,
  eventSuffix: string
) {
  const value = await current(tx, journeyId);
  await repository.completeStep(tx, {
    eventKey: `${journeyId}:${value.step.code}:${eventSuffix}`,
    expectedVersion: value.version,
    journeyId,
    payload: { stepCode: value.step.code },
    stepId: value.step.id
  });
  await tx.auditLog.create({
    data: {
      action: "UPDATE",
      afterSnapshot: { result: "COMPLETED", stepCode: value.step.code },
      entityId: value.applicationId,
      entityType: "Application",
      module: `subscription_journey:${value.applicationId}`
    }
  });
}

async function decideCurrentManualTask(
  tx: Tx,
  repository: SubscriptionJourneyRepository,
  journeyId: string,
  userId: string,
  inputSnapshot: Prisma.InputJsonValue
) {
  const value = await current(tx, journeyId);
  const task = await repository.openManualTask(tx, {
    inputSnapshot,
    journeyId,
    stepId: value.step.id
  });
  await repository.decideManualTask(tx, {
    decidedBy: userId,
    decision: SubscriptionJourneyManualDecision.APPROVED,
    expectedVersion: task.version,
    journeyId,
    taskId: task.id
  });
}

async function waitForCustomer(
  tx: Tx,
  repository: SubscriptionJourneyRepository,
  journeyId: string,
  eventSuffix: string
) {
  const value = await current(tx, journeyId);
  await repository.waitForCustomer(tx, {
    eventKey: `${journeyId}:${value.step.code}:${eventSuffix}`,
    expectedVersion: value.version,
    journeyId,
    payload: {
      finalPlanCommercialHash: FINAL_PLAN_COMMERCIAL_HASH,
      finalPlanRevision: 1,
      stepCode: value.step.code
    },
    stepId: value.step.id
  });
}

async function current(tx: Tx, journeyId: string) {
  const journey = await tx.subscriptionJourney.findUniqueOrThrow({ where: { id: journeyId } });
  const step = await tx.subscriptionJourneyStep.upsert({
    create: { code: journey.currentStepCode, journeyId },
    update: {},
    where: { journeyId_code: { code: journey.currentStepCode, journeyId } }
  });
  return { ...journey, step };
}

async function createEntryFacts(
  tx: Tx,
  ids: ReturnType<typeof fixtureIds>,
  source: ApplicationSource
) {
  await tx.user.create({
    data: {
      id: ids.userId,
      name: "Golden Path Operator",
      passwordHash: "test-only-not-a-credential",
      username: `${ids.prefix}_operator`
    }
  });
  await tx.customer.create({
    data: {
      customerNo: `${ids.prefix}-CUSTOMER`,
      id: ids.customerId,
      mobile: "13800000000",
      name: "Golden Path Customer"
    }
  });
  await tx.application.create({
    data: {
      applicationNo: `${ids.prefix}-APPLICATION`,
      applicationSource: source,
      customerId: ids.customerId,
      id: ids.applicationId,
      salesUserId: ids.userId,
      status: "SUBMITTED",
      submittedAt: new Date("2026-08-06T00:00:00.000Z")
    }
  });
}

function fixtureIds(source: ApplicationSource) {
  const prefix = `gp_${source.toLowerCase()}_${randomUUID().replaceAll("-", "")}`;
  const applicationId = randomUUID();
  return {
    applicationId,
    archivedContractFileId: randomUUID(),
    auditModule: `subscription_journey:${applicationId}`,
    contractId: randomUUID(),
    customerId: randomUUID(),
    handoverId: randomUUID(),
    leaseId: randomUUID(),
    orderId: randomUUID(),
    prefix,
    userId: randomUUID(),
    vehicleId: randomUUID(),
    workOrderId: randomUUID()
  };
}

async function rolledBack<T>(prisma: PrismaService, work: (tx: Tx) => Promise<T>) {
  let result: T | undefined;
  try {
    await prisma.$transaction(
      async (tx) => {
        result = await work(tx);
        throw ROLLBACK;
      },
      { timeout: 30_000 }
    );
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  if (result === undefined) throw new Error("Golden Path transaction produced no result");
  return result;
}

function stripEntrySpecificFacts(snapshot: FlowSnapshot) {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "source"));
}
