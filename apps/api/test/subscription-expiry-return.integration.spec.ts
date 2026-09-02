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
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../src/audit/audit.service";
import { AutoDebitScheduler } from "../src/auto-debit/auto-debit.scheduler";
import { AssetAccountingRepository } from "../src/asset-accounting/asset-accounting.repository";
import {
  ASSET_ACCOUNTING_PERMISSION,
  AssetAccountingService
} from "../src/asset-accounting/asset-accounting.service";
import { AssetFactsRepository } from "../src/asset-facts/asset-facts.repository";
import { AssetFactsService } from "../src/asset-facts/asset-facts.service";
import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../src/asset-operations/asset-operations.service";
import { billingSourceKey } from "../src/billing-automation/billing-automation.calendar";
import { BillingAutomationRepository } from "../src/billing-automation/billing-automation.repository";
import { BillingAutomationService } from "../src/billing-automation/billing-automation.service";
import { ESignService } from "../src/esign/esign.service";
import { Stage3ExtensionArchiveService } from "../src/esign/stage3-extension-archive.service";
import { MockESignProvider } from "../src/esign/mock-esign.provider";
import { ReturnManifestESignService } from "../src/esign/return-manifest-esign.service";
import { FinanceService } from "../src/finance/finance.service";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";
import { buildReturnEligibility } from "../src/order/order.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { SubscriptionExpiryService } from "../src/subscription-change/subscription-expiry.service";
import { ContractSegmentService } from "../src/subscription-change/contract-segment.service";
import { subscriptionEffectiveBoundaryOwner } from "../src/subscription-change/subscription-effective-boundary";
import { SubscriptionClosureRepository } from "../src/subscription-closure/subscription-closure.repository";
import { SubscriptionClosureProjectionService } from "../src/subscription-closure/subscription-closure.projection";
import { SubscriptionClosureSettlementResolver } from "../src/subscription-closure/subscription-closure.settlement-resolver";
import { SubscriptionClosureService } from "../src/subscription-closure/subscription-closure.service";
import { canonicalSubscriptionClosureJson } from "../src/subscription-closure/subscription-closure.domain";
import { VehicleMileageRepository } from "../src/vehicle-mileage/vehicle-mileage.repository";
import { VehicleMileageService } from "../src/vehicle-mileage/vehicle-mileage.service";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";
import { insertRuntimeOrderGraph, insertRuntimeUser } from "./helpers/runtime-domain-fixture";

const TEST_DATABASE_URL = requiredReleaseDatabaseTestContext(
  "apps/api/test/subscription-expiry-return.integration.spec.ts"
).databaseUrl;

function observeSettlement<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ reason, status: "rejected" })
  );
}

function rethrowRecoveryAssessmentIntegrationError(error: unknown): never {
  const response =
    typeof error === "object" && error !== null && "response" in error
      ? (error.response as { code?: unknown })
      : undefined;
  const code = typeof response?.code === "string" ? response.code : undefined;
  if (code && /^[A-Z0-9_]+$/.test(code)) {
    throw new Error(`INTEGRATION_RECOVERY_ASSESSMENT_${code}`);
  }
  throw error;
}

describe("SubscriptionClosureService Task 7 early-termination initiation", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("keeps AuditService persistence timestamps implicit unless an internal caller supplies one", async () => {
    const create = vi.fn(async (input: { data: Record<string, unknown> }) => {
      void input;
      return { id: randomUUID() };
    });
    const audit = new AuditService({} as never);
    const client = { auditLog: { create } } as never;
    const input = {
      action: "CREATE" as const,
      after: { stable: true },
      entityId: randomUUID(),
      entityType: "subscription_closure_event",
      module: "subscription_closure",
      operatorId: randomUUID()
    };

    await audit.write(input, client);

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0].data).not.toHaveProperty("createdAt");

    const persistenceAt = new Date("2026-08-22T07:15:16.123Z");
    await audit.write({ ...input, createdAt: persistenceAt }, client);

    expect(create.mock.calls[1]?.[0].data).toMatchObject({ createdAt: persistenceAt });
  });

  it("creates one active-authority case and replays only the exact immutable request", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const { closure } = createTask6ClosureService(prisma);
    try {
      await prisma.$transaction([
        prisma.subscriptionOrder.update({
          data: { endDate: new Date("2027-02-02T00:00:00.000Z") },
          where: { id: fixture.orderId }
        }),
        prisma.subscriptionContractSegment.update({
          data: { endDate: new Date("2027-02-02T00:00:00.000Z") },
          where: { id: fixture.segmentId }
        })
      ]);
      const earnedBill = await prisma.receivableBill.create({
        data: {
          amount: 100n,
          billNo: `BIL-TASK7-${randomUUID()}`,
          billPeriodEnd: new Date("2026-09-02T00:00:00.000Z"),
          billPeriodStart: new Date("2026-08-03T00:00:00.000Z"),
          billStatus: "PARTIALLY_PAID",
          billType: "MONTHLY_RENT",
          createdBy: fixture.actorId,
          customerId: fixture.customerId,
          dueDate: new Date("2026-08-03T00:00:00.000Z"),
          orderId: fixture.orderId,
          paidAmount: 40n,
          remainingAmount: 60n,
          snapshot: { fixture: "task-7-earned-receivable" }
        }
      });
      const earnedPayment = await prisma.paymentRecord.create({
        data: {
          createdBy: fixture.actorId,
          customerId: fixture.customerId,
          orderId: fixture.orderId,
          paymentAmount: 40n,
          paymentMethod: "BANK_TRANSFER",
          paymentNo: `PAY-TASK7-${randomUUID()}`,
          paymentProofUrls: [],
          receivedAt: new Date("2026-08-03T00:00:01.000Z"),
          remark: "Task 7 earned payment"
        }
      });
      const earnedDeposit = await prisma.depositLedger.create({
        data: {
          amount: 500n,
          balanceAfter: 500n,
          createdBy: fixture.actorId,
          customerId: fixture.customerId,
          ledgerNo: `DPL-TASK7-${randomUUID()}`,
          occurredAt: new Date("2026-03-03T02:00:00.000Z"),
          orderId: fixture.orderId,
          paymentId: earnedPayment.id,
          snapshot: { fixture: "task-7-deposit" },
          transactionStatus: "CONFIRMED",
          transactionType: "COLLECT"
        }
      });
      const entitlement = await prisma.orderEntitlementAccount.create({
        data: {
          accountNo: `ENT-TASK7-${randomUUID()}`,
          accountStatus: "ACTIVE",
          createdBy: fixture.actorId,
          customerId: fixture.customerId,
          orderId: fixture.orderId,
          periodEnd: new Date("2026-09-02T00:00:00.000Z"),
          periodStart: new Date("2026-03-03T00:00:00.000Z"),
          snapshot: { fixture: "task-7-earned-benefit" }
        }
      });
      const protectedFinanceBefore = await Promise.all([
        prisma.receivableBill.findUniqueOrThrow({ where: { id: earnedBill.id } }),
        prisma.paymentRecord.findUniqueOrThrow({ where: { id: earnedPayment.id } }),
        prisma.depositLedger.findUniqueOrThrow({ where: { id: earnedDeposit.id } })
      ]);
      const now = await readTestDatabaseClock(prisma);
      const input = {
        actorId: fixture.actorId,
        effectiveAt: new Date(now.getTime() + 500),
        evidence: [{ reference: "customer-request-42", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "task-7-initiate",
        orderId: fixture.orderId,
        reason: "Customer requested an early return"
      } as const;

      const first = await closure.initiateEarlyTermination(input);
      const replay = await closure.initiateEarlyTermination(input);

      expect(first).toMatchObject({ closureCaseId: expectUuid(), wrote: true });
      expect(replay).toEqual({ ...first, wrote: false });
      await expect(
        prisma.subscriptionClosureCase.findFirstOrThrow({
          where: { orderId: fixture.orderId, retiredAt: null }
        })
      ).resolves.toMatchObject({
        authoritySnapshot: {
          agreement: {
            effectiveAt: input.effectiveAt.toISOString(),
            evidence: input.evidence,
            reason: input.reason,
            requestedBy: fixture.actorId
          },
          contract: { id: fixture.contractId, status: "SIGNED" },
          lease: { status: "ACTIVE" },
          order: { id: fixture.orderId, status: "ACTIVE" },
          segment: { id: fixture.segmentId, status: "ACTIVE" }
        },
        closureType: "EARLY_TERMINATION",
        effectiveAt: input.effectiveAt,
        finalDisposition: "TERMINATE",
        physicalControlMode: "VOLUNTARY_RETURN",
        status: "PREPARING_RETURN"
      });
      const agreement = await closure.archiveEarlyTerminationAgreement({
        actorId: fixture.actorId,
        closureCaseId: first.closureCaseId,
        idempotencyKey: "task-7-agreement",
        syntheticTestEvidence: true
      });
      const agreementReplay = await closure.archiveEarlyTerminationAgreement({
        actorId: fixture.actorId,
        closureCaseId: first.closureCaseId,
        idempotencyKey: "task-7-agreement",
        syntheticTestEvidence: true
      });
      expect(agreement).toMatchObject({
        archivedRevisionId: expectUuid(),
        generatedRevisionId: expectUuid(),
        signedFileHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        signedFileId: expectUuid(),
        signedRevisionId: expectUuid(),
        wrote: true
      });
      expect(agreementReplay).toEqual({ ...agreement, wrote: false });
      await expect(
        prisma.subscriptionClosureDocumentRevision.findMany({
          orderBy: { revisionNumber: "asc" },
          where: {
            closureCaseId: first.closureCaseId,
            documentType: "EARLY_TERMINATION_AGREEMENT"
          }
        })
      ).resolves.toMatchObject([
        {
          documentSnapshot: {
            authoritySnapshotHash: first.authoritySnapshotHash,
            documentType: "EARLY_TERMINATION_AGREEMENT"
          },
          stage: "GENERATED"
        },
        { stage: "SIGNED" },
        { id: agreement.archivedRevisionId, stage: "ARCHIVED" }
      ]);
      await expect(
        prisma.contractESignTask.findUniqueOrThrow({
          where: {
            id: (
              await prisma.subscriptionClosureDocumentRevision.findUniqueOrThrow({
                where: { id: agreement.archivedRevisionId }
              })
            ).contractESignTaskId
          }
        })
      ).resolves.toMatchObject({
        completedAt: expect.any(Date),
        documentType: ESignDocumentType.EARLY_TERMINATION_AGREEMENT,
        signingStage: ESignSigningStage.STAGE4_EARLY_TERMINATION,
        sourceKey: "early-termination-agreement:task-7-agreement:archived",
        taskStatus: "COMPLETED"
      });
      await awaitDatabaseClockPast(prisma, input.effectiveAt);
      const execution = await closure.executeEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: first.closureCaseId,
        idempotencyKey: "task-7-execute"
      });
      const executionReplay = await closure.executeEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: first.closureCaseId,
        idempotencyKey: "task-7-execute"
      });
      expect(execution).toMatchObject({
        closureCaseId: first.closureCaseId,
        returnAssetWorkOrderId: expectUuid(),
        returnHandoverWorkOrderId: expectUuid(),
        returnManifestRevisionId: expectUuid(),
        vehicleReturnId: expectUuid(),
        wrote: true
      });
      expect(executionReplay).toEqual({ ...execution, wrote: false });
      const billingClock = await readTestDatabaseClock(prisma);
      const earnedSourceKey = billingSourceKey(
        fixture.orderId,
        new Date("2026-08-03T00:00:00.000Z")
      );
      await prisma.billingSchedule.update({
        data: { nextCycleNo: 5, nextGenerateAt: new Date("2026-07-31T00:00:00.000Z") },
        where: { id: fixture.scheduleId }
      });
      const earnedJob = await prisma.subscriptionAutomationJob.update({
        data: { idempotencyKey: earnedSourceKey },
        where: { id: fixture.earnedJobId }
      });
      const billing = new BillingAutomationService(
        prisma,
        new BillingAutomationRepository(prisma),
        new FinanceService(new AuditService(prisma), prisma),
        new AutoDebitScheduler(),
        new ContractSegmentService(prisma),
        () => billingClock
      );
      await expect(
        billing.generateScheduledMonthlyRent({
          ...earnedJob,
          leaseExpiresAt: new Date(billingClock.getTime() + 60_000),
          leaseToken: "task-7-earned-worker"
        })
      ).resolves.toMatchObject({ completed: true, created: false, sourceKey: earnedSourceKey });
      await expect(billing.enqueueDueSchedules(billingClock)).resolves.toEqual({
        dueCount: 0,
        enqueuedCount: 0
      });
      await runManagedPrepare(prisma, closure, fixture);
      await expect(closure.initiateEarlyTermination(input)).resolves.toEqual({
        ...first,
        wrote: false
      });
      await expect(
        closure.executeEarlyTermination({
          actorId: fixture.actorId,
          closureCaseId: first.closureCaseId,
          idempotencyKey: "task-7-execute"
        })
      ).resolves.toEqual({ ...execution, wrote: false });
      await expect(
        Promise.all([
          prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } }),
          prisma.lease.findUniqueOrThrow({ where: { orderId: fixture.orderId } }),
          prisma.subscriptionContractSegment.findUniqueOrThrow({
            where: { id: fixture.segmentId }
          }),
          prisma.vehicleReturn.findUniqueOrThrow({ where: { orderId: fixture.orderId } }),
          prisma.billingSchedule.findUniqueOrThrow({ where: { orderId: fixture.orderId } }),
          prisma.subscriptionAutomationJob.findUniqueOrThrow({
            where: { id: fixture.earnedJobId }
          }),
          prisma.subscriptionAutomationJob.findUniqueOrThrow({
            where: { id: fixture.futureJobId }
          })
        ])
      ).resolves.toMatchObject([
        { orderStatus: "PENDING_RETURN" },
        { status: "RETURN_DUE" },
        { completedAt: expect.any(Date), status: "COMPLETED" },
        { returnStatus: "READY", returnType: "EARLY_TERMINATION" },
        {
          completedAt: expect.any(Date),
          serviceEndDate: new Date(input.effectiveAt.toISOString().slice(0, 10)),
          status: "COMPLETED"
        },
        { jobStatus: "PENDING" },
        { jobStatus: "CANCELLED" }
      ]);
      await expect(
        Promise.all([
          prisma.receivableBill.findUniqueOrThrow({ where: { id: earnedBill.id } }),
          prisma.paymentRecord.findUniqueOrThrow({ where: { id: earnedPayment.id } }),
          prisma.depositLedger.findUniqueOrThrow({ where: { id: earnedDeposit.id } })
        ])
      ).resolves.toEqual(protectedFinanceBefore);
      await expect(
        prisma.orderEntitlementAccount.findUniqueOrThrow({ where: { id: entitlement.id } })
      ).resolves.toMatchObject({ accountStatus: "CLOSED" });
      await expect(
        prisma.receivableBill.findMany({
          where: {
            billPeriodStart: { gt: new Date(input.effectiveAt.toISOString().slice(0, 10)) },
            billType: "MONTHLY_RENT",
            orderId: fixture.orderId
          }
        })
      ).resolves.toEqual([]);
      await expect(
        closure.initiateEarlyTermination({ ...input, reason: "drifted reason" })
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
        status: 409
      });
      await expect(
        prisma.subscriptionClosureCase.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(1);
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it("reactivates a paused retained cycle once and then makes billing terminal", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const { closure } = createTask6ClosureService(prisma);
    const now = await readTestDatabaseClock(prisma);
    try {
      await prisma.$transaction([
        prisma.subscriptionOrder.update({
          data: { endDate: new Date("2027-02-02T00:00:00.000Z") },
          where: { id: fixture.orderId }
        }),
        prisma.subscriptionContractSegment.update({
          data: { endDate: new Date("2027-02-02T00:00:00.000Z") },
          where: { id: fixture.segmentId }
        }),
        prisma.billingSchedule.update({
          data: {
            nextCycleNo: 5,
            nextGenerateAt: new Date("2026-07-31T00:00:00.000Z"),
            pauseReason: "TASK7_PREEXISTING_PAUSE",
            status: "PAUSED"
          },
          where: { id: fixture.scheduleId }
        })
      ]);
      const retainedBill = await prisma.receivableBill.create({
        data: {
          amount: 100n,
          billNo: `BIL-TASK7-PAUSED-${randomUUID()}`,
          billPeriodEnd: new Date("2026-09-02T00:00:00.000Z"),
          billPeriodStart: new Date("2026-08-03T00:00:00.000Z"),
          billStatus: "PENDING",
          billType: "MONTHLY_RENT",
          createdBy: fixture.actorId,
          customerId: fixture.customerId,
          dueDate: new Date("2026-08-03T00:00:00.000Z"),
          orderId: fixture.orderId,
          paidAmount: 0n,
          remainingAmount: 100n,
          snapshot: { fixture: "task-7-paused-retained" }
        }
      });
      const retainedBefore = await prisma.receivableBill.findUniqueOrThrow({
        where: { id: retainedBill.id }
      });
      const initiated = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt: new Date(now.getTime() + 500),
        evidence: [{ reference: "customer-request-paused", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "task-7-paused-init",
        orderId: fixture.orderId,
        reason: "Customer requested early termination while billing was paused"
      });
      await closure.archiveEarlyTerminationAgreement({
        actorId: fixture.actorId,
        closureCaseId: initiated.closureCaseId,
        idempotencyKey: "task-7-paused-agreement",
        syntheticTestEvidence: true
      });
      await awaitDatabaseClockPast(prisma, new Date(now.getTime() + 500));
      await closure.executeEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: initiated.closureCaseId,
        idempotencyKey: "task-7-paused-execute"
      });
      await expect(
        prisma.billingSchedule.findUniqueOrThrow({ where: { id: fixture.scheduleId } })
      ).resolves.toMatchObject({ pauseReason: null, status: "ACTIVE" });

      const earnedSourceKey = billingSourceKey(
        fixture.orderId,
        new Date("2026-08-03T00:00:00.000Z")
      );
      const earnedJob = await prisma.subscriptionAutomationJob.update({
        data: { idempotencyKey: earnedSourceKey },
        where: { id: fixture.earnedJobId }
      });
      const billingClock = await readTestDatabaseClock(prisma);
      const billing = new BillingAutomationService(
        prisma,
        new BillingAutomationRepository(prisma),
        new FinanceService(new AuditService(prisma), prisma),
        new AutoDebitScheduler(),
        new ContractSegmentService(prisma),
        () => billingClock
      );
      await expect(
        billing.generateScheduledMonthlyRent({
          ...earnedJob,
          leaseExpiresAt: new Date(billingClock.getTime() + 60_000),
          leaseToken: "task-7-paused-earned-worker"
        })
      ).resolves.toMatchObject({ completed: true, created: false, sourceKey: earnedSourceKey });
      await expect(billing.enqueueDueSchedules(billingClock)).resolves.toEqual({
        dueCount: 0,
        enqueuedCount: 0
      });
      await expect(
        prisma.billingSchedule.findUniqueOrThrow({ where: { id: fixture.scheduleId } })
      ).resolves.toMatchObject({ completedAt: expect.any(Date), status: "COMPLETED" });
      await expect(
        prisma.receivableBill.findUniqueOrThrow({ where: { id: retainedBill.id } })
      ).resolves.toEqual(retainedBefore);
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it.each(["BILLING_FIRST", "TERMINATION_FIRST"] as const)(
    "serializes the earned billing worker against early termination: %s",
    async (winner) => {
      const fixture = await createManagedExpiryFixture(prisma);
      const concurrentPrisma = new PrismaService(
        new ConfigService({ DATABASE_URL: TEST_DATABASE_URL })
      );
      await concurrentPrisma.onModuleInit();
      const now = await readTestDatabaseClock(prisma);
      const barrier = createBarrier();
      try {
        await prisma.$transaction([
          prisma.subscriptionOrder.update({
            data: { endDate: new Date("2027-02-02T00:00:00.000Z") },
            where: { id: fixture.orderId }
          }),
          prisma.subscriptionContractSegment.update({
            data: { endDate: new Date("2027-02-02T00:00:00.000Z") },
            where: { id: fixture.segmentId }
          }),
          prisma.billingSchedule.update({
            data: { nextCycleNo: 5, nextGenerateAt: new Date("2026-07-31T00:00:00.000Z") },
            where: { id: fixture.scheduleId }
          })
        ]);
        const retainedBill = await prisma.receivableBill.create({
          data: {
            amount: 100n,
            billNo: `BIL-TASK7-RACE-${randomUUID()}`,
            billPeriodEnd: new Date("2026-09-02T00:00:00.000Z"),
            billPeriodStart: new Date("2026-08-03T00:00:00.000Z"),
            billStatus: "PENDING",
            billType: "MONTHLY_RENT",
            createdBy: fixture.actorId,
            customerId: fixture.customerId,
            dueDate: new Date("2026-08-03T00:00:00.000Z"),
            orderId: fixture.orderId,
            paidAmount: 0n,
            remainingAmount: 100n,
            snapshot: { fixture: `task-7-billing-race-${winner}` }
          }
        });
        const retainedBefore = await prisma.receivableBill.findUniqueOrThrow({
          where: { id: retainedBill.id }
        });
        const baseClosure = createTask6ClosureService(prisma).closure;
        const initiated = await baseClosure.initiateEarlyTermination({
          actorId: fixture.actorId,
          effectiveAt: new Date(now.getTime() + 500),
          evidence: [{ reference: `task-7-billing-race-${winner}`, type: "CUSTOMER_REQUEST" }],
          idempotencyKey: `task-7-billing-race-${winner}-init`,
          orderId: fixture.orderId,
          reason: `Customer requested early termination during ${winner}`
        });
        await baseClosure.archiveEarlyTerminationAgreement({
          actorId: fixture.actorId,
          closureCaseId: initiated.closureCaseId,
          idempotencyKey: `task-7-billing-race-${winner}-agreement`,
          syntheticTestEvidence: true
        });
        await awaitDatabaseClockPast(prisma, new Date(now.getTime() + 500));
        const periodStart = new Date("2026-08-03T00:00:00.000Z");
        const sourceKey = billingSourceKey(fixture.orderId, periodStart);
        const job = await prisma.subscriptionAutomationJob.update({
          data: { idempotencyKey: sourceKey },
          where: { id: fixture.earnedJobId }
        });
        const billingClock = await readTestDatabaseClock(prisma);
        const createBilling = (db: PrismaService) =>
          new BillingAutomationService(
            db,
            new BillingAutomationRepository(db),
            new FinanceService(new AuditService(db), db),
            new AutoDebitScheduler(),
            new ContractSegmentService(db),
            () => billingClock
          );
        const executionInput = {
          actorId: fixture.actorId,
          closureCaseId: initiated.closureCaseId,
          idempotencyKey: `task-7-billing-race-${winner}-execute`
        };
        const claimedJob = {
          ...job,
          leaseExpiresAt: new Date(billingClock.getTime() + 60_000),
          leaseToken: `task-7-billing-race-${winner}`
        };

        if (winner === "BILLING_FIRST") {
          const hookedBilling = createBilling(
            hookTransaction(prisma, "billingSchedule", "updateMany", barrier, "after")
          );
          const billingRun = hookedBilling.generateScheduledMonthlyRent(claimedJob);
          const billingResultPromise = observeSettlement(billingRun);
          const firstBillingSignal = await Promise.race([
            barrier.entered.then(() => ({ kind: "BARRIER" as const })),
            billingRun.then(
              () => ({ kind: "SETTLED" as const, reason: null }),
              (reason: unknown) => ({ kind: "SETTLED" as const, reason })
            )
          ]);
          if (firstBillingSignal.kind === "SETTLED") throw firstBillingSignal.reason;
          const terminationResultPromise = observeSettlement(
            createTask6ClosureService(concurrentPrisma).closure.executeEarlyTermination(
              executionInput
            )
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          barrier.release();
          const [billingResult, terminationResult] = await Promise.all([
            billingResultPromise,
            terminationResultPromise
          ]);
          expect(billingResult).toMatchObject({
            status: "fulfilled",
            value: { created: false, sourceKey }
          });
          if (terminationResult.status === "rejected") {
            expect(terminationResult.reason).toMatchObject({ status: 409 });
            await expect(
              baseClosure.executeEarlyTermination(executionInput)
            ).resolves.toMatchObject({ wrote: true });
          } else {
            expect(terminationResult.value).toMatchObject({ wrote: true });
          }
        } else {
          const hookedClosure = createTask6ClosureService(
            hookTransaction(prisma, "billingSchedule", "updateMany", barrier, "after")
          ).closure;
          const terminationResultPromise = observeSettlement(
            hookedClosure.executeEarlyTermination(executionInput)
          );
          await barrier.entered;
          const billingResultPromise = observeSettlement(
            createBilling(concurrentPrisma).generateScheduledMonthlyRent(claimedJob)
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          barrier.release();
          const [terminationResult, billingResult] = await Promise.all([
            terminationResultPromise,
            billingResultPromise
          ]);
          expect(terminationResult).toMatchObject({
            status: "fulfilled",
            value: { wrote: true }
          });
          expect(billingResult).toMatchObject({
            status: "fulfilled",
            value: { completed: true, created: false, sourceKey }
          });
        }

        const boundaryDate = new Date(new Date(now.getTime() + 500).toISOString().slice(0, 10));
        await expect(
          prisma.billingSchedule.findUniqueOrThrow({ where: { id: fixture.scheduleId } })
        ).resolves.toMatchObject({
          completedAt: expect.any(Date),
          serviceEndDate: boundaryDate,
          status: "COMPLETED"
        });
        await expect(
          prisma.receivableBill.findMany({
            orderBy: [{ billPeriodStart: "asc" }, { id: "asc" }],
            where: { billType: "MONTHLY_RENT", orderId: fixture.orderId }
          })
        ).resolves.toEqual([retainedBefore]);
        const remainingJobs = await prisma.subscriptionAutomationJob.findMany({
          where: { jobStatus: { in: ["PENDING", "PROCESSING"] }, orderId: fixture.orderId }
        });
        expect(
          remainingJobs.filter(({ payload }) => {
            const periodStart =
              payload && typeof payload === "object" && !Array.isArray(payload)
                ? (payload as Record<string, unknown>).periodStart
                : null;
            return (
              typeof periodStart === "string" &&
              periodStart > boundaryDate.toISOString().slice(0, 10)
            );
          })
        ).toEqual([]);
      } finally {
        barrier.release();
        await concurrentPrisma.onModuleDestroy();
        await cleanupManagedExpiryFixture(prisma, fixture);
      }
    },
    30_000
  );

  it("cancels before execution without leaking physical or financial mutations", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const { closure } = createTask6ClosureService(prisma);
    try {
      const futureWindow = await task7FutureAuthorityWindow(prisma);
      await prisma.$transaction([
        prisma.subscriptionOrder.update({
          data: { endDate: futureWindow.endDate },
          where: { id: fixture.orderId }
        }),
        prisma.subscriptionContractSegment.update({
          data: { endDate: futureWindow.endDate },
          where: { id: fixture.segmentId }
        })
      ]);
      const created = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt: futureWindow.effectiveAt,
        evidence: [{ reference: "customer-request-43", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "task-7-cancel-init",
        orderId: fixture.orderId,
        reason: "Customer requested early termination then withdrew"
      });
      await closure.archiveEarlyTerminationAgreement({
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-cancel-agreement",
        syntheticTestEvidence: true
      });
      await expect(
        closure.executeEarlyTermination({
          actorId: fixture.actorId,
          closureCaseId: created.closureCaseId,
          idempotencyKey: "task-7-cancel-too-early"
        })
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      await expect(
        prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(0);

      const cancelled = await closure.cancelEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-cancel",
        reason: "Customer withdrew before execution"
      });
      const replay = await closure.cancelEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-cancel",
        reason: "Customer withdrew before execution"
      });
      expect(cancelled).toEqual({ closureCaseId: created.closureCaseId, wrote: true });
      expect(replay).toEqual({ closureCaseId: created.closureCaseId, wrote: false });
      await expect(
        Promise.all([
          prisma.subscriptionClosureCase.findUniqueOrThrow({
            where: { id: created.closureCaseId }
          }),
          prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } }),
          prisma.lease.findUniqueOrThrow({ where: { orderId: fixture.orderId } }),
          prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } }),
          prisma.contractESignTask.findFirstOrThrow({
            where: {
              orderId: fixture.orderId,
              sourceKey: "early-termination-agreement:task-7-cancel-agreement:archived"
            }
          })
        ])
      ).resolves.toMatchObject([
        { status: "CANCELLED", vehicleReturnId: null },
        { orderStatus: "ACTIVE" },
        { status: "ACTIVE" },
        0,
        { cancelledAt: expect.any(Date), taskStatus: "CANCELLED" }
      ]);
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it("keeps cancelled-agreement successors immutable during archive replay", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const { closure } = createTask6ClosureService(prisma);
    const now = await readTestDatabaseClock(prisma);
    try {
      await prisma.$transaction([
        prisma.subscriptionOrder.update({
          data: { endDate: new Date("2026-09-02T00:00:00.000Z") },
          where: { id: fixture.orderId }
        }),
        prisma.subscriptionContractSegment.update({
          data: { endDate: new Date("2026-09-02T00:00:00.000Z") },
          where: { id: fixture.segmentId }
        })
      ]);
      const initiated = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt: new Date(now.getTime() + 5_000),
        evidence: [{ reference: "task-7-r2-cancelled-successor", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "task-7-r2-cancelled-successor-init",
        orderId: fixture.orderId,
        reason: "Exercise exact cancelled agreement replay"
      });
      const agreementInput = {
        actorId: fixture.actorId,
        closureCaseId: initiated.closureCaseId,
        idempotencyKey: "task-7-r2-cancelled-successor-agreement"
      } as const;
      await closure.archiveEarlyTerminationAgreement(agreementInput);
      await closure.cancelEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: initiated.closureCaseId,
        idempotencyKey: "task-7-r2-cancelled-successor-cancel",
        reason: "Cancel before effective execution"
      });
      const cancellationReceipt = await prisma.subscriptionClosureCommandReceipt.findFirstOrThrow({
        where: {
          closureCaseId: initiated.closureCaseId,
          event: { afterStatus: "CANCELLED", eventType: "STATUS_TRANSITIONED" }
        }
      });
      const cancellationEvent = await prisma.subscriptionClosureEvent.findUniqueOrThrow({
        where: { id: cancellationReceipt.eventId }
      });
      await expect(
        prisma.subscriptionClosureCommandReceipt.update({
          data: { outcomeSnapshot: { tampered: "cancelled-successor-outcome" } },
          where: { id: cancellationReceipt.id }
        })
      ).rejects.toBeDefined();
      await expect(
        prisma.subscriptionClosureEvent.update({
          data: { detailSnapshot: { tampered: "cancelled-agreement-event" } },
          where: { id: cancellationEvent.id }
        })
      ).rejects.toBeDefined();
      await expect(closure.archiveEarlyTerminationAgreement(agreementInput)).resolves.toMatchObject(
        {
          wrote: false
        }
      );
      await expect(
        prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: initiated.closureCaseId } })
      ).resolves.toMatchObject({ status: "CANCELLED", vehicleReturnId: null });
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it("retires a pre-agreement cancellation and permits one later early attempt", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const { closure } = createTask6ClosureService(prisma);
    const now = await readTestDatabaseClock(prisma);
    try {
      await prisma.$transaction([
        prisma.subscriptionOrder.update({
          data: { endDate: new Date("2026-09-02T00:00:00.000Z") },
          where: { id: fixture.orderId }
        }),
        prisma.subscriptionContractSegment.update({
          data: { endDate: new Date("2026-09-02T00:00:00.000Z") },
          where: { id: fixture.segmentId }
        })
      ]);
      const firstInput = {
        actorId: fixture.actorId,
        effectiveAt: new Date(now.getTime() + 5_000),
        evidence: [{ reference: "customer-request-prearchive-1", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "task-7-prearchive-first",
        orderId: fixture.orderId,
        reason: "Customer withdrew before agreement generation"
      } as const;
      const first = await closure.initiateEarlyTermination(firstInput);

      const cancelled = await closure.cancelEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: first.closureCaseId,
        idempotencyKey: "task-7-prearchive-cancel",
        reason: "Customer withdrew before agreement generation"
      });
      const replay = await closure.cancelEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: first.closureCaseId,
        idempotencyKey: "task-7-prearchive-cancel",
        reason: "Customer withdrew before agreement generation"
      });
      expect(cancelled).toEqual({ closureCaseId: first.closureCaseId, wrote: true });
      expect(replay).toEqual({ closureCaseId: first.closureCaseId, wrote: false });

      const second = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt: new Date(now.getTime() + 10_000),
        evidence: [{ reference: "customer-request-prearchive-2", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "task-7-prearchive-second",
        orderId: fixture.orderId,
        reason: "Customer submitted a later authorized request"
      });
      expect(second.closureCaseId).not.toBe(first.closureCaseId);
      await expect(closure.initiateEarlyTermination(firstInput)).resolves.toEqual({
        ...first,
        wrote: false
      });
      await expect(
        prisma.subscriptionClosureCase.findMany({
          orderBy: { createdAt: "asc" },
          where: { orderId: fixture.orderId }
        })
      ).resolves.toMatchObject([
        {
          id: first.closureCaseId,
          retiredAt: expect.any(Date),
          retiredBy: fixture.actorId,
          status: "CANCELLED"
        },
        { id: second.closureCaseId, retiredAt: null, retiredBy: null, status: "PREPARING_RETURN" }
      ]);
      await expect(
        prisma.subscriptionClosureCase.count({
          where: { orderId: fixture.orderId, retiredAt: null }
        })
      ).resolves.toBe(1);
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it("retains an archived cancelled attempt while later normal expiry owns the active aggregate", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const { closure } = createTask6ClosureService(prisma);
    const expiry = createGovernedExpiryService(prisma);
    const now = await readTestDatabaseClock(prisma);
    try {
      await prisma.$transaction([
        prisma.subscriptionOrder.update({
          data: { endDate: new Date(now.getTime() + 1_500) },
          where: { id: fixture.orderId }
        }),
        prisma.subscriptionContractSegment.update({
          data: { endDate: new Date(now.getTime() + 1_500) },
          where: { id: fixture.segmentId }
        })
      ]);
      const early = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt: new Date(now.getTime() + 500),
        evidence: [{ reference: "customer-request-before-expiry", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "task-7-cancel-before-expiry",
        orderId: fixture.orderId,
        reason: "Customer initially requested early termination"
      });
      await closure.archiveEarlyTerminationAgreement({
        actorId: fixture.actorId,
        closureCaseId: early.closureCaseId,
        idempotencyKey: "task-7-cancel-before-expiry-agreement",
        syntheticTestEvidence: true
      });
      await closure.cancelEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: early.closureCaseId,
        idempotencyKey: "task-7-cancel-before-expiry-command",
        reason: "Customer retained the subscription until natural expiry"
      });
      const expiredEndDate = new Date("2026-08-20T00:00:00.000Z");
      await prisma.$transaction([
        prisma.subscriptionOrder.update({
          data: { endDate: expiredEndDate },
          where: { id: fixture.orderId }
        }),
        prisma.subscriptionContractSegment.update({
          data: { endDate: expiredEndDate },
          where: { id: fixture.segmentId }
        })
      ]);

      await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      const active = await prisma.subscriptionClosureCase.findFirstOrThrow({
        where: { orderId: fixture.orderId, retiredAt: null }
      });
      expect(active.id).not.toBe(early.closureCaseId);
      await expect(
        prisma.subscriptionClosureCase.findMany({
          orderBy: { createdAt: "asc" },
          where: { orderId: fixture.orderId }
        })
      ).resolves.toMatchObject([
        { id: early.closureCaseId, retiredAt: expect.any(Date), status: "CANCELLED" },
        {
          closureType: "NORMAL_COMPLETION",
          id: active.id,
          retiredAt: null,
          status: "PREPARING_RETURN"
        }
      ]);
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it("invalidates the archived agreement task on current-fact drift without return leakage", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const { closure } = createTask6ClosureService(prisma);
    const now = (
      await prisma.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`)
    )[0]?.now;
    if (!now) throw new Error("Database clock unavailable");
    // Both Order.endDate and SubscriptionContractSegment.endDate are PostgreSQL DATE values.
    // Keep the two facts more than 24 hours apart so database truncation cannot collapse the
    // intended drift onto the same calendar date at some times of day.
    const originalAuthorityEnd = new Date(now.getTime() + 259_200_000);
    const driftedAuthorityEnd = new Date(now.getTime() + 43_200_000);
    try {
      await prisma.$transaction([
        prisma.subscriptionOrder.update({
          data: { endDate: originalAuthorityEnd },
          where: { id: fixture.orderId }
        }),
        prisma.subscriptionContractSegment.update({
          data: { endDate: originalAuthorityEnd },
          where: { id: fixture.segmentId }
        })
      ]);
      const created = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt: new Date(now.getTime() + 3_000),
        evidence: [{ reference: "customer-request-44", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "task-7-drift-init",
        orderId: fixture.orderId,
        reason: "Customer requested early termination"
      });
      await closure.archiveEarlyTerminationAgreement({
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-drift-agreement",
        syntheticTestEvidence: true
      });
      await prisma.subscriptionContractSegment.update({
        data: { endDate: driftedAuthorityEnd },
        where: { id: fixture.segmentId }
      });
      await awaitDatabaseClockPast(
        prisma,
        (
          await prisma.subscriptionClosureCase.findUniqueOrThrow({
            where: { id: created.closureCaseId }
          })
        ).effectiveAt
      );

      const generatedReceipt = await prisma.subscriptionClosureCommandReceipt.findFirstOrThrow({
        where: {
          closureCaseId: created.closureCaseId,
          sourceKey: "early-termination-agreement:task-7-drift-agreement:generated"
        }
      });
      await expect(
        prisma.subscriptionClosureCommandReceipt.update({
          data: { payloadHash: "0".repeat(64) },
          where: { id: generatedReceipt.id }
        })
      ).rejects.toBeDefined();

      const result = await closure.executeEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-drift-execute"
      });
      const replay = await closure.executeEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-drift-execute"
      });
      expect(result).toEqual({
        closureCaseId: created.closureCaseId,
        outcome: "AGREEMENT_STALE",
        wrote: true
      });
      expect(replay).toEqual({ ...result, wrote: false });
      await expect(
        Promise.all([
          prisma.subscriptionClosureCase.findUniqueOrThrow({
            where: { id: created.closureCaseId }
          }),
          prisma.contractESignTask.findFirstOrThrow({
            where: {
              orderId: fixture.orderId,
              sourceKey: "early-termination-agreement:task-7-drift-agreement:archived"
            }
          }),
          prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } }),
          prisma.assetWorkOrder.count({ where: { orderId: fixture.orderId } })
        ])
      ).resolves.toMatchObject([
        { status: "MANUAL_TAKEOVER", vehicleReturnId: null },
        { cancelledAt: expect.any(Date), taskStatus: "CANCELLED" },
        0,
        0
      ]);

      const cancelled = await closure.cancelEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-drift-cancel",
        reason: "Retire the stale pre-execution attempt under governed review"
      });
      const cancelReplay = await closure.cancelEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-drift-cancel",
        reason: "Retire the stale pre-execution attempt under governed review"
      });
      expect(cancelled).toEqual({ closureCaseId: created.closureCaseId, wrote: true });
      expect(cancelReplay).toEqual({ closureCaseId: created.closureCaseId, wrote: false });
      await expect(
        closure.archiveEarlyTerminationAgreement({
          actorId: fixture.actorId,
          closureCaseId: created.closureCaseId,
          idempotencyKey: "task-7-drift-agreement",
          syntheticTestEvidence: true
        })
      ).resolves.toMatchObject({ wrote: false });
      await expect(
        closure.executeEarlyTermination({
          actorId: fixture.actorId,
          closureCaseId: created.closureCaseId,
          idempotencyKey: "task-7-drift-execute"
        })
      ).resolves.toEqual({ ...result, wrote: false });

      const laterClock = await readTestDatabaseClock(prisma);
      const later = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt: new Date(laterClock.getTime() + 5_000),
        evidence: [{ reference: "customer-request-after-drift", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "task-7-drift-later-init",
        orderId: fixture.orderId,
        reason: "Customer submitted a later request against current authority"
      });
      expect(later.closureCaseId).not.toBe(created.closureCaseId);
      await expect(
        prisma.subscriptionClosureCase.findUniqueOrThrow({
          where: { id: created.closureCaseId }
        })
      ).resolves.toMatchObject({
        retiredAt: expect.any(Date),
        retiredBy: fixture.actorId,
        status: "CANCELLED"
      });
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  }, 30_000);

  it("rolls back the entire effective-boundary and return graph on a late manifest failpoint", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const { closure } = createTask6ClosureService(prisma);
    const now = (
      await prisma.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`)
    )[0]?.now;
    if (!now) throw new Error("Database clock unavailable");
    try {
      await prisma.$transaction([
        prisma.subscriptionOrder.update({
          data: { endDate: new Date("2026-09-02T00:00:00.000Z") },
          where: { id: fixture.orderId }
        }),
        prisma.subscriptionContractSegment.update({
          data: { endDate: new Date("2026-09-02T00:00:00.000Z") },
          where: { id: fixture.segmentId }
        })
      ]);
      const created = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt: new Date(now.getTime() + 500),
        evidence: [{ reference: "customer-request-45", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "task-7-rollback-init",
        orderId: fixture.orderId,
        reason: "Customer requested early termination"
      });
      await closure.archiveEarlyTerminationAgreement({
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-rollback-agreement",
        syntheticTestEvidence: true
      });
      await awaitDatabaseClockPast(
        prisma,
        (
          await prisma.subscriptionClosureCase.findUniqueOrThrow({
            where: { id: created.closureCaseId }
          })
        ).effectiveAt
      );
      const truth = () =>
        Promise.all([
          prisma.subscriptionClosureCase.findUniqueOrThrow({
            where: { id: created.closureCaseId }
          }),
          prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } }),
          prisma.lease.findUniqueOrThrow({ where: { orderId: fixture.orderId } }),
          prisma.subscriptionContractSegment.findUniqueOrThrow({
            where: { id: fixture.segmentId }
          }),
          prisma.vehicleReturn.findMany({ where: { orderId: fixture.orderId } }),
          prisma.assetWorkOrder.findMany({ where: { orderId: fixture.orderId } }),
          prisma.vehicleHandoverWorkOrder.findMany({ where: { orderId: fixture.orderId } }),
          prisma.subscriptionClosureDocumentRevision.findMany({
            orderBy: { revisionNumber: "asc" },
            where: { closureCaseId: created.closureCaseId }
          }),
          prisma.subscriptionClosureEvent.findMany({
            orderBy: { sequence: "asc" },
            where: { closureCaseId: created.closureCaseId }
          }),
          prisma.subscriptionClosureCommandReceipt.findMany({
            orderBy: { createdAt: "asc" },
            where: { closureCaseId: created.closureCaseId }
          }),
          prisma.subscriptionAutomationJob.findMany({
            orderBy: { id: "asc" },
            where: { orderId: fixture.orderId }
          })
        ]);
      const before = await truth();
      const repository = new SubscriptionClosureRepository();
      const failpointRepository = new Proxy(repository, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== "appendPreparedDocumentRevisionInTransaction") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (...args: unknown[]) => {
            const result = await value.apply(target, args);
            const documentCommand = args[2] as { documentType?: string } | undefined;
            if (documentCommand?.documentType === "RETURN_MANIFEST") {
              throw new Error("TASK7_FAILPOINT:after-return-manifest");
            }
            return result;
          };
        }
      }) as SubscriptionClosureRepository;
      const failpointClosure = createTask6ClosureService(prisma, failpointRepository).closure;
      const executionInput = {
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-rollback-execute"
      };
      await expect(failpointClosure.executeEarlyTermination(executionInput)).rejects.toThrow(
        "TASK7_FAILPOINT:after-return-manifest"
      );
      await expect(truth()).resolves.toEqual(before);
      await expect(closure.executeEarlyTermination(executionInput)).resolves.toMatchObject({
        closureCaseId: created.closureCaseId,
        vehicleReturnId: expectUuid(),
        wrote: true
      });
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

  it("rejects effective-boundary fact drift after observation with no partial return graph", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const { closure } = createTask6ClosureService(prisma);
    const now = (
      await prisma.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`)
    )[0]?.now;
    if (!now) throw new Error("Database clock unavailable");
    const barrier = createBarrier();
    try {
      await prisma.$transaction([
        prisma.subscriptionOrder.update({
          data: { endDate: new Date("2026-09-02T00:00:00.000Z") },
          where: { id: fixture.orderId }
        }),
        prisma.subscriptionContractSegment.update({
          data: { endDate: new Date("2026-09-02T00:00:00.000Z") },
          where: { id: fixture.segmentId }
        })
      ]);
      const created = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt: new Date(now.getTime() + 500),
        evidence: [{ reference: "customer-request-47", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "task-7-boundary-drift-init",
        orderId: fixture.orderId,
        reason: "Customer requested early termination"
      });
      await closure.archiveEarlyTerminationAgreement({
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-boundary-drift-agreement",
        syntheticTestEvidence: true
      });
      await awaitDatabaseClockPast(
        prisma,
        (
          await prisma.subscriptionClosureCase.findUniqueOrThrow({
            where: { id: created.closureCaseId }
          })
        ).effectiveAt
      );
      const hookedPrisma = hookTransaction(
        prisma,
        "subscriptionAutomationJob",
        "findMany",
        barrier,
        "after"
      );
      const hookedClosure = createTask6ClosureService(hookedPrisma).closure;
      const input = {
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-boundary-drift-execute"
      };
      const execution = hookedClosure.executeEarlyTermination(input);
      await barrier.entered;
      await prisma.subscriptionAutomationJob.update({
        data: { payload: { periodStart: "2026-08-03" } },
        where: { id: fixture.futureJobId }
      });
      barrier.release();
      await expect(execution).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      await expect(
        Promise.all([
          prisma.subscriptionClosureCase.findUniqueOrThrow({
            where: { id: created.closureCaseId }
          }),
          prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } }),
          prisma.lease.findUniqueOrThrow({ where: { orderId: fixture.orderId } }),
          prisma.subscriptionContractSegment.findUniqueOrThrow({
            where: { id: fixture.segmentId }
          }),
          prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } }),
          prisma.assetWorkOrder.count({ where: { orderId: fixture.orderId } }),
          prisma.vehicleHandoverWorkOrder.count({ where: { orderId: fixture.orderId } }),
          prisma.subscriptionClosureDocumentRevision.count({
            where: {
              closureCaseId: created.closureCaseId,
              documentType: "RETURN_MANIFEST"
            }
          })
        ])
      ).resolves.toMatchObject([
        {
          returnAssetWorkOrderId: null,
          returnHandoverWorkOrderId: null,
          vehicleReturnId: null
        },
        { orderStatus: "ACTIVE" },
        { status: "ACTIVE" },
        { status: "ACTIVE" },
        0,
        0,
        0,
        0
      ]);
      await prisma.subscriptionAutomationJob.update({
        data: { payload: { periodStart: "2026-10-03" } },
        where: { id: fixture.futureJobId }
      });

      const holderBarrier = createBarrier();
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "subscription_automation_job" WHERE "id" = ${fixture.futureJobId}::uuid FOR UPDATE`
        );
        holderBarrier.enter();
        await holderBarrier.released;
        return tx.$queryRaw<Array<{ usable: number }>>(Prisma.sql`SELECT 1 AS "usable"`);
      });
      await holderBarrier.entered;
      try {
        await expect(closure.executeEarlyTermination(input)).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
          status: 409
        });
      } finally {
        holderBarrier.release();
      }
      await expect(holder).resolves.toEqual([{ usable: 1 }]);
      await expect(closure.executeEarlyTermination(input)).resolves.toMatchObject({
        closureCaseId: created.closureCaseId,
        wrote: true
      });
    } finally {
      barrier.release();
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  }, 30_000);

  it("arbitrates early initiation against expiry without a second case or return", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const barrier = createBarrier();
    try {
      const futureWindow = await task7FutureAuthorityWindow(prisma);
      await prisma.$transaction([
        prisma.subscriptionOrder.update({
          data: { endDate: futureWindow.endDate },
          where: { id: fixture.orderId }
        }),
        prisma.subscriptionContractSegment.update({
          data: { endDate: futureWindow.endDate },
          where: { id: fixture.segmentId }
        })
      ]);
      const hookedPrisma = hookTransaction(
        prisma,
        "subscriptionClosureCase",
        "create",
        barrier,
        "after"
      );
      const early = createTask6ClosureService(hookedPrisma).closure;
      const expiry = createGovernedExpiryService(prisma);
      const initiation = early.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt: futureWindow.effectiveAt,
        evidence: [{ reference: "customer-request-48", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "task-7-expiry-race-init",
        orderId: fixture.orderId,
        reason: "Customer requested early termination before natural expiry"
      });
      await barrier.entered;
      await expect(
        expiry.expireSegment(fixture.segmentId, futureWindow.expiryDecisionAt)
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_EXPIRY_AUTHORITY_BUSY" },
        status: 409
      });
      barrier.release();
      await expect(initiation).resolves.toMatchObject({ wrote: true });
      await expect(
        expiry.expireSegment(fixture.segmentId, futureWindow.expiryDecisionAt)
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      await expect(
        Promise.all([
          prisma.subscriptionClosureCase.count({ where: { orderId: fixture.orderId } }),
          prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } }),
          prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } }),
          prisma.subscriptionContractSegment.findUniqueOrThrow({
            where: { id: fixture.segmentId }
          })
        ])
      ).resolves.toMatchObject([1, 0, { orderStatus: "ACTIVE" }, { status: "ACTIVE" }]);
    } finally {
      barrier.release();
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  }, 30_000);

  it.each(["LATER_EARLY_FIRST", "NORMAL_EXPIRY_FIRST"] as const)(
    "serializes a later active closure winner while retaining cancelled history: %s",
    async (winner) => {
      const fixture = await createManagedExpiryFixture(prisma);
      const concurrentPrisma = new PrismaService(
        new ConfigService({ DATABASE_URL: TEST_DATABASE_URL })
      );
      await concurrentPrisma.onModuleInit();
      const barrier = createBarrier();
      const closure = createTask6ClosureService(prisma).closure;
      try {
        const futureWindow = await task7FutureAuthorityWindow(prisma);
        await prisma.$transaction([
          prisma.subscriptionOrder.update({
            data: { endDate: futureWindow.endDate },
            where: { id: fixture.orderId }
          }),
          prisma.subscriptionContractSegment.update({
            data: { endDate: futureWindow.endDate },
            where: { id: fixture.segmentId }
          })
        ]);
        const retiredInput = {
          actorId: fixture.actorId,
          effectiveAt: futureWindow.effectiveAt,
          evidence: [{ reference: `task-7-retired-race-${winner}`, type: "CUSTOMER_REQUEST" }],
          idempotencyKey: `task-7-retired-race-${winner}-first`,
          orderId: fixture.orderId,
          reason: "Customer withdrew the first early request"
        } as const;
        const retired = await closure.initiateEarlyTermination(retiredInput);
        await closure.cancelEarlyTermination({
          actorId: fixture.actorId,
          closureCaseId: retired.closureCaseId,
          idempotencyKey: `task-7-retired-race-${winner}-cancel`,
          reason: "Customer withdrew before execution"
        });
        const laterInput = {
          ...retiredInput,
          evidence: [
            { reference: `task-7-retired-race-${winner}-later`, type: "CUSTOMER_REQUEST" }
          ],
          idempotencyKey: `task-7-retired-race-${winner}-later`,
          reason: "Customer submitted a later valid early request"
        } as const;
        let earlyResult: PromiseSettledResult<unknown>;
        let expiryResult: PromiseSettledResult<unknown>;

        if (winner === "LATER_EARLY_FIRST") {
          const earlyResultPromise = observeSettlement(
            createTask6ClosureService(
              hookTransaction(prisma, "subscriptionClosureCase", "create", barrier, "after")
            ).closure.initiateEarlyTermination(laterInput)
          );
          await barrier.entered;
          const expiryResultPromise = observeSettlement(
            createGovernedExpiryService(concurrentPrisma).expireSegment(
              fixture.segmentId,
              futureWindow.expiryDecisionAt
            )
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          barrier.release();
          [earlyResult, expiryResult] = await Promise.all([
            earlyResultPromise,
            expiryResultPromise
          ]);
        } else {
          const targetRepository = new SubscriptionClosureRepository();
          const repository = new Proxy(targetRepository, {
            get(target, property, receiver) {
              const value = Reflect.get(target, property, receiver);
              if (typeof value !== "function") return value;
              if (property === "prepareAuthorityInTransaction") {
                return async (...args: unknown[]) => {
                  barrier.enter();
                  await barrier.released;
                  return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
                };
              }
              return value.bind(target);
            }
          });
          const earlyResultPromise = observeSettlement(
            createTask6ClosureService(
              concurrentPrisma,
              repository
            ).closure.initiateEarlyTermination(laterInput)
          );
          await barrier.entered;
          await prisma.$transaction([
            prisma.subscriptionOrder.update({
              data: { endDate: new Date("2026-08-20T00:00:00.000Z") },
              where: { id: fixture.orderId }
            }),
            prisma.subscriptionContractSegment.update({
              data: { endDate: new Date("2026-08-20T00:00:00.000Z") },
              where: { id: fixture.segmentId }
            })
          ]);
          const expiryResultPromise = observeSettlement(
            createGovernedExpiryService(prisma).expireSegment(
              fixture.segmentId,
              new Date("2026-08-20T16:00:00.000Z")
            )
          );
          [expiryResult] = await Promise.all([expiryResultPromise]);
          barrier.release();
          [earlyResult] = await Promise.all([earlyResultPromise]);
        }

        expect(winner === "LATER_EARLY_FIRST" ? earlyResult : expiryResult).toMatchObject(
          winner === "LATER_EARLY_FIRST"
            ? { status: "fulfilled", value: { wrote: true } }
            : { status: "fulfilled", value: { outcome: "EXPIRED", returnId: expect.any(String) } }
        );
        expect(winner === "LATER_EARLY_FIRST" ? expiryResult : earlyResult).toMatchObject({
          reason: { status: 409 },
          status: "rejected"
        });
        await expect(closure.initiateEarlyTermination(retiredInput)).resolves.toEqual({
          authoritySnapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          closureCaseId: retired.closureCaseId,
          wrote: false
        });
        await expect(
          prisma.subscriptionClosureCase.findMany({
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            where: { orderId: fixture.orderId }
          })
        ).resolves.toMatchObject([
          { closureType: "EARLY_TERMINATION", retiredAt: expect.any(Date), status: "CANCELLED" },
          {
            closureType: winner === "LATER_EARLY_FIRST" ? "EARLY_TERMINATION" : "NORMAL_COMPLETION",
            retiredAt: null,
            status: "PREPARING_RETURN"
          }
        ]);
        await expect(
          prisma.subscriptionClosureCase.count({
            where: { orderId: fixture.orderId, retiredAt: null }
          })
        ).resolves.toBe(1);
        await expect(
          prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })
        ).resolves.toBe(winner === "LATER_EARLY_FIRST" ? 0 : 1);
      } finally {
        barrier.release();
        await concurrentPrisma.onModuleDestroy();
        await cleanupManagedExpiryFixture(prisma, fixture);
      }
    },
    30_000
  );

  it("locks every current-document family for agreement replay without cross-family gaps", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const { closure } = createTask6ClosureService(prisma);
    const now = (
      await prisma.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`)
    )[0]?.now;
    if (!now) throw new Error("Database clock unavailable");
    try {
      await prisma.$transaction([
        prisma.subscriptionOrder.update({
          data: { endDate: new Date("2026-09-02T00:00:00.000Z") },
          where: { id: fixture.orderId }
        }),
        prisma.subscriptionContractSegment.update({
          data: { endDate: new Date("2026-09-02T00:00:00.000Z") },
          where: { id: fixture.segmentId }
        })
      ]);
      const created = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt: new Date(now.getTime() + 500),
        evidence: [{ reference: "customer-request-46", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "task-7-current-family-init",
        orderId: fixture.orderId,
        reason: "Customer requested early termination"
      });
      const agreementInput = {
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-current-family-agreement"
      };
      const agreement = await closure.archiveEarlyTerminationAgreement(agreementInput);
      const agreementTask = await prisma.contractESignTask.findFirstOrThrow({
        where: {
          orderId: fixture.orderId,
          sourceKey: "early-termination-agreement:task-7-current-family-agreement:archived"
        }
      });
      await prisma.contractESignTask.update({
        data: { requestSnapshot: { drift: "task-7-agreement-request" } },
        where: { id: agreementTask.id }
      });
      await expect(closure.archiveEarlyTerminationAgreement(agreementInput)).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      await prisma.contractESignTask.update({
        data: { requestSnapshot: agreementTask.requestSnapshot ?? Prisma.JsonNull },
        where: { id: agreementTask.id }
      });
      await expect(closure.archiveEarlyTerminationAgreement(agreementInput)).resolves.toEqual({
        ...agreement,
        wrote: false
      });
      await awaitDatabaseClockPast(
        prisma,
        (
          await prisma.subscriptionClosureCase.findUniqueOrThrow({
            where: { id: created.closureCaseId }
          })
        ).effectiveAt
      );
      await closure.executeEarlyTermination({
        actorId: fixture.actorId,
        closureCaseId: created.closureCaseId,
        idempotencyKey: "task-7-current-family-execute"
      });
      await expect(
        prisma.subscriptionClosureCurrentDocument.findMany({
          orderBy: { documentType: "asc" },
          where: { closureCaseId: created.closureCaseId }
        })
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ documentType: "EARLY_TERMINATION_AGREEMENT" }),
          expect.objectContaining({ documentType: "RETURN_MANIFEST" })
        ])
      );

      for (const documentType of ["EARLY_TERMINATION_AGREEMENT", "RETURN_MANIFEST"] as const) {
        const barrier = createBarrier();
        const holder = prisma.$transaction(async (tx) => {
          await tx.$executeRaw(Prisma.sql`
            UPDATE "subscription_closure_current_document"
            SET "document_revision_id" = "document_revision_id"
            WHERE "closure_case_id" = ${created.closureCaseId}::uuid
              AND "document_type" = ${documentType}::"subscription_closure_document_type"
          `);
          barrier.enter();
          await barrier.released;
          return tx.$queryRaw<Array<{ usable: number }>>(Prisma.sql`SELECT 1 AS "usable"`);
        });
        await barrier.entered;
        try {
          await expect(
            closure.archiveEarlyTerminationAgreement(agreementInput)
          ).rejects.toMatchObject({
            response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
            status: 409
          });
        } finally {
          barrier.release();
        }
        await expect(holder).resolves.toEqual([{ usable: 1 }]);
      }
      await expect(closure.archiveEarlyTerminationAgreement(agreementInput)).resolves.toEqual({
        ...agreement,
        wrote: false
      });
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  }, 30_000);
});

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

  it("Task 9 journey A completes normal expiry, return, inspection, settlement, and inventory release", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const expiry = createGovernedExpiryService(prisma);
    let occurredAt: Date;
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
      const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
        where: { orderId: fixture.orderId, retiredAt: null }
      });
      await prisma.vehicleReturn.update({
        data: {
          ...checklist,
          checklistSnapshot: checklist,
          returnStatus: "READY",
          updatedBy: fixture.actorId
        },
        where: { orderId: fixture.orderId }
      });
      const manifestSuccessors = await produceReturnManifestSuccessors(prisma, {
        actorId: fixture.actorId,
        closureCaseId: closureCase.id,
        idempotencyKey: "task-4-physical-receipt-manifest"
      });
      const signedFileHash = manifestSuccessors.finalized.signedFileHash;
      const signedFileId = manifestSuccessors.finalized.signedFileId;
      occurredAt = (
        await prisma.subscriptionClosureEvent.findFirstOrThrow({
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          where: { closureCaseId: closureCase.id }
        })
      ).occurredAt;
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
        new VehicleMileageService(prisma, new VehicleMileageRepository()),
        new SubscriptionClosureSettlementResolver()
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
      const forgedReturnTypeTruth = await snapshotPhysicalReturnTruth(prisma, fixture);
      await expect(
        closure.confirmManagedPhysicalReceipt({ ...receipt, returnType: "EARLY_TERMINATION" }, {})
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      await expect(snapshotPhysicalReturnTruth(prisma, fixture)).resolves.toEqual(
        forgedReturnTypeTruth
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
        version: 4
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
        expectedVersion: 3,
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
          sequence: 5,
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
          await restore(tx);
        });
        await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).resolves.toEqual({
          vehicleReturnId: closureCase.vehicleReturnId
        });
      };
      for (const invalidAuthorityMutation of [
        () =>
          prisma.vehicleReturnDamage.update({
            data: { returnId: randomUUID() },
            where: { id: damage.id }
          }),
        () =>
          prisma.vehicleReturnDamage.update({
            data: { orderId: randomUUID() },
            where: { id: damage.id }
          }),
        () =>
          prisma.vehicleReturnDamage.update({
            data: { vehicleId: randomUUID() },
            where: { id: damage.id }
          }),
        () =>
          prisma.vehicleMileageReading.update({
            data: { confirmedBy: randomUUID() },
            where: { id: mileageReading.id }
          })
      ]) {
        const authorityTruth = await snapshotPhysicalReturnTruth(prisma, fixture, winnerTruthScope);
        await expect(invalidAuthorityMutation()).rejects.toBeDefined();
        await expect(
          snapshotPhysicalReturnTruth(prisma, fixture, winnerTruthScope)
        ).resolves.toEqual(authorityTruth);
      }
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
      const immutableRestrictionTruth = await snapshotPhysicalReturnTruth(prisma, fixture);
      await expect(
        prisma.vehicleOperationalRestriction.update({
          data: { startSourceKey: "unrelated-return-inspection-restriction" },
          where: { id: intendedRestriction.id }
        })
      ).rejects.toBeDefined();
      await expect(snapshotPhysicalReturnTruth(prisma, fixture)).resolves.toEqual(
        immutableRestrictionTruth
      );
      await expect(
        prisma.vehicleOperationalRestriction.update({
          data: { startSourceKey: "return-inspection-restriction" },
          where: { id: intendedRestriction.id }
        })
      ).rejects.toBeDefined();
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
      const normalSettlementInput = async (suffix: string) => ({
        actorId: fixture.actorId,
        closureCaseId: closureCase.id,
        idempotencyKey: `task-9-normal-${suffix}`,
        occurredAt: await readTestDatabaseClock(prisma),
        waiverApprovalId: null,
        writeOffApprovalId: null
      });
      await closure.proposeManagedSettlement(await normalSettlementInput("propose"));
      await closure.finalizeManagedSettlement(await normalSettlementInput("finalize"));
      const normalSettleCommand = await normalSettlementInput("settle");
      const normalSettled = await closure.settleManagedSettlement(normalSettleCommand);
      expect(normalSettled).toMatchObject({ closureCaseId: closureCase.id, stage: "SETTLED" });
      await expect(closure.settleManagedSettlement(normalSettleCommand)).resolves.toEqual(
        normalSettled
      );
      await expect(
        Promise.all([
          prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } }),
          prisma.contract.findUniqueOrThrow({ where: { id: fixture.contractId } })
        ])
      ).resolves.toMatchObject([{ orderStatus: "COMPLETED" }, { status: "COMPLETED" }]);
      const postSettlementInventoryCommand = {
        ...inventoryCommand,
        occurredAt: await readTestDatabaseClock(prisma)
      };
      await expect(
        closure.releaseManagedReturnInventory(postSettlementInventoryCommand, {})
      ).resolves.toEqual({
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
      const projection = new SubscriptionClosureProjectionService(prisma);
      await expect(projection.getAdminByOrder(fixture.orderId)).resolves.toMatchObject({
        closureCase: { status: "COMPLETED" },
        settlementRevisions: [{ stage: "PROPOSED" }, { stage: "FINALIZED" }, { stage: "SETTLED" }]
      });
      await expect(
        projection.getCustomerByOrder(fixture.orderId, fixture.customerId)
      ).resolves.toMatchObject({
        nextAction: "流程已结束",
        settlement: { stage: "SETTLED" },
        status: "COMPLETED"
      });
      await expect(
        prisma.subscriptionClosureCommandReceipt.count({ where: { closureCaseId: closureCase.id } })
      ).resolves.toBeGreaterThan(0);
      await expect(
        prisma.auditLog.count({ where: { operatorId: fixture.actorId } })
      ).resolves.toBeGreaterThan(0);
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  });

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

  it("Task 9 journey C completes early agreement, return, inspection, and terminal settlement", async () => {
    const scenario = await setupFocusedPhysicalReceipt(prisma, { early: true });
    if (!scenario.early) throw new Error("Expected early-termination fixture authority");
    const settlementInput = async (suffix: string) => ({
      actorId: scenario.fixture.actorId,
      closureCaseId: scenario.closureCase.id,
      idempotencyKey: `task-7-full-journey-${suffix}`,
      occurredAt: await readTestDatabaseClock(prisma),
      waiverApprovalId: null,
      writeOffApprovalId: null
    });
    try {
      await expect(
        scenario.closure.proposeManagedSettlement(await settlementInput("finance-too-early"))
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_SETTLEMENT_STATUS_CONFLICT" },
        status: 409
      });
      await expect(
        scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {})
      ).resolves.toEqual({ vehicleReturnId: scenario.closureCase.vehicleReturnId });
      const receivedVehicle = await prisma.vehicle.findUniqueOrThrow({
        where: { id: scenario.fixture.vehicleId }
      });
      await expect(
        scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {})
      ).resolves.toEqual({ vehicleReturnId: scenario.closureCase.vehicleReturnId });
      await expect(
        scenario.closure.archiveEarlyTerminationAgreement(scenario.early.agreementInput)
      ).resolves.toMatchObject({ wrote: false });
      await expect(
        scenario.closure.executeEarlyTermination(scenario.early.executionInput)
      ).resolves.toEqual({ ...scenario.early.execution, wrote: false });

      await closeFocusedInspectionWorkOrder(scenario);
      await expect(
        scenario.closure.recordManagedReturnInspection(
          focusedInspectionCommand(scenario, false),
          {}
        )
      ).resolves.toMatchObject({ case: { status: "PENDING_SETTLEMENT" } });
      await expect(
        scenario.closure.executeEarlyTermination(scenario.early.executionInput)
      ).resolves.toEqual({ ...scenario.early.execution, wrote: false });

      const proposed = await scenario.closure.proposeManagedSettlement(
        await settlementInput("propose")
      );
      const finalized = await scenario.closure.finalizeManagedSettlement(
        await settlementInput("finalize")
      );
      const settleCommand = await settlementInput("settle");
      const settled = await scenario.closure.settleManagedSettlement(settleCommand);
      await expect(scenario.closure.settleManagedSettlement(settleCommand)).resolves.toEqual(
        settled
      );
      expect(proposed).toMatchObject({ revisionNumber: 1, stage: "PROPOSED" });
      expect(finalized).toMatchObject({ revisionNumber: 2, stage: "FINALIZED" });
      expect(settled).toMatchObject({ revisionNumber: 3, stage: "SETTLED" });
      await expect(
        scenario.closure.archiveEarlyTerminationAgreement(scenario.early.agreementInput)
      ).resolves.toMatchObject({ wrote: false });
      await expect(
        scenario.closure.executeEarlyTermination(scenario.early.executionInput)
      ).resolves.toEqual({ ...scenario.early.execution, wrote: false });
      await expect(
        scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {})
      ).resolves.toEqual({ vehicleReturnId: scenario.closureCase.vehicleReturnId });

      const originalManifest = await prisma.subscriptionClosureDocumentRevision.findUniqueOrThrow({
        where: { id: scenario.early.execution.returnManifestRevisionId }
      });
      const replayLockBarrier = createBarrier();
      const replayLockHolder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "subscription_closure_document_revision" WHERE "id" = ${originalManifest.id}::uuid FOR UPDATE`
        );
        replayLockBarrier.enter();
        await replayLockBarrier.released;
        return tx.$queryRaw<Array<{ usable: number }>>(Prisma.sql`SELECT 1 AS "usable"`);
      });
      await replayLockBarrier.entered;
      try {
        await expect(
          scenario.closure.executeEarlyTermination(scenario.early.executionInput)
        ).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
          status: 409
        });
      } finally {
        replayLockBarrier.release();
      }
      await expect(replayLockHolder).resolves.toEqual([{ usable: 1 }]);
      await expect(
        scenario.closure.executeEarlyTermination(scenario.early.executionInput)
      ).resolves.toEqual({ ...scenario.early.execution, wrote: false });

      await expect(
        Promise.all([
          prisma.subscriptionClosureCase.findUniqueOrThrow({
            where: { id: scenario.closureCase.id }
          }),
          prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: scenario.fixture.orderId } }),
          prisma.contract.findUniqueOrThrow({ where: { id: scenario.fixture.contractId } }),
          prisma.vehicle.findUniqueOrThrow({ where: { id: scenario.fixture.vehicleId } })
        ])
      ).resolves.toMatchObject([
        { status: "TERMINATED" },
        { orderStatus: "TERMINATED" },
        { status: "TERMINATED" },
        { status: receivedVehicle.status }
      ]);
      const projection = new SubscriptionClosureProjectionService(prisma);
      await expect(projection.getAdminByOrder(scenario.fixture.orderId)).resolves.toMatchObject({
        closureCase: { closureType: "EARLY_TERMINATION", status: "TERMINATED" },
        settlementRevisions: [{ stage: "PROPOSED" }, { stage: "FINALIZED" }, { stage: "SETTLED" }]
      });
      await expect(
        projection.getCustomerByOrder(scenario.fixture.orderId, scenario.fixture.customerId)
      ).resolves.toMatchObject({
        nextAction: "流程已结束",
        settlement: { stage: "SETTLED" },
        status: "TERMINATED"
      });
    } finally {
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  }, 30_000);

  it("produces the return-manifest provider lifecycle through the internal command", async () => {
    const scenario = await setupFocusedPhysicalReceipt(prisma, {
      early: true,
      skipManifestSuccessors: true
    });
    if (!scenario.early) throw new Error("Expected early-termination fixture authority");
    try {
      await prisma.vehicleReturn.update({
        data: {
          ...scenario.receipt.checklist,
          checklistSnapshot: scenario.receipt.checklist,
          returnStatus: "READY",
          updatedBy: scenario.fixture.actorId
        },
        where: { id: scenario.closureCase.vehicleReturnId! }
      });
      const input = {
        actorId: scenario.fixture.actorId,
        closureCaseId: scenario.closureCase.id,
        idempotencyKey: "task-7-production-return-manifest"
      } as const;
      const generated = await prisma.subscriptionClosureDocumentRevision.findFirstOrThrow({
        where: {
          closureCaseId: scenario.closureCase.id,
          documentType: "RETURN_MANIFEST",
          revisionNumber: 1
        }
      });
      await expect(
        prisma.subscriptionAutomationJob.findUnique({
          where: {
            idempotencyKey: `closure-return-manifest-esign:${generated.id}`
          }
        })
      ).resolves.toMatchObject({
        jobStatus: "PENDING",
        jobType: "CLOSURE_RETURN_MANIFEST_ESIGN",
        orderId: scenario.fixture.orderId,
        payload: {
          actorId: scenario.fixture.actorId,
          closureCaseId: scenario.closureCase.id,
          generatedRevisionId: generated.id,
          version: 1
        }
      });
      const produced = await produceReturnManifestSuccessors(prisma, input);
      expect(produced.started).toMatchObject({ wrote: true });
      expect(produced.callback).toMatchObject({ finalized: true });
      expect(produced.finalized).toMatchObject({ wrote: false });
      const revisions = await prisma.subscriptionClosureDocumentRevision.findMany({
        include: { contractESignTask: true, signedFile: true, sourceFile: true },
        orderBy: { revisionNumber: "asc" },
        where: { closureCaseId: scenario.closureCase.id, documentType: "RETURN_MANIFEST" }
      });
      expect(revisions).toHaveLength(3);
      expect(revisions.map(({ stage }) => stage)).toEqual(["GENERATED", "SIGNED", "ARCHIVED"]);
      expect(revisions[1]?.contractESignTaskId).toBe(revisions[2]?.contractESignTaskId);
      expect(revisions[1]?.sourceFileId).toBe(revisions[2]?.sourceFileId);
      expect(revisions[1]?.signedFileId).toBe(revisions[2]?.signedFileId);
      expect(revisions[1]?.sourceFile.mimeType).toBe("application/json");
      expect(revisions[1]?.signedFile?.mimeType).toBe("application/pdf");
      const providerTask = revisions[1]!.contractESignTask;
      const providerSource = await prisma.fileObject.findUniqueOrThrow({
        where: {
          id: (providerTask.requestSnapshot as Prisma.JsonObject).providerSourceFile
            ? ((
                (providerTask.requestSnapshot as Prisma.JsonObject)
                  .providerSourceFile as Prisma.JsonObject
              ).id as string)
            : randomUUID()
        }
      });
      expect(providerSource.mimeType).toBe("application/pdf");
      expect(
        new Set([revisions[1]!.sourceFileId, providerSource.id, revisions[1]!.signedFileId]).size
      ).toBe(3);
      await expect(produceReturnManifestSuccessors(prisma, input)).resolves.toMatchObject({
        finalized: { wrote: false },
        started: { wrote: false }
      });
      await expect(
        scenario.closure.executeEarlyTermination(scenario.early.executionInput)
      ).resolves.toEqual({ ...scenario.early.execution, wrote: false });
    } finally {
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  }, 30_000);

  it("retries provider start and completion without duplicating reserved authority", async () => {
    const scenario = await setupFocusedPhysicalReceipt(prisma, {
      early: true,
      skipManifestSuccessors: true
    });
    if (!scenario.early) throw new Error("Expected early-termination fixture authority");
    const input = {
      actorId: scenario.fixture.actorId,
      closureCaseId: scenario.closureCase.id,
      idempotencyKey: "task-7-return-manifest-provider-retry"
    } as const;
    const harness = createReturnManifestESignHarness(prisma);
    try {
      const providerStart = vi.spyOn(harness.provider, "createReturnManifestTask");
      const serviceWithPersist = harness.service as unknown as {
        persistStartedProviderTask: (...args: never[]) => Promise<never>;
      };
      vi.spyOn(serviceWithPersist, "persistStartedProviderTask").mockRejectedValueOnce(
        new Error("TASK7_FAKE_PROVIDER_RESULT_PERSISTENCE_RETRY")
      );
      await expect(harness.service.start(input)).rejects.toThrow(
        "TASK7_FAKE_PROVIDER_RESULT_PERSISTENCE_RETRY"
      );
      const reserved = await prisma.contractESignTask.findFirstOrThrow({
        where: {
          sourceId: scenario.closureCase.id,
          sourceKey: { startsWith: "return-manifest-esign:" },
          sourceType: "SUBSCRIPTION_CLOSURE_ESIGN"
        }
      });
      expect(reserved).toMatchObject({ providerTaskId: null, taskStatus: "CREATED" });
      await expect(harness.service.start(input)).resolves.toMatchObject({
        taskId: reserved.id,
        wrote: true
      });
      expect(providerStart).toHaveBeenCalledTimes(1);
      const started = await prisma.contractESignTask.findUniqueOrThrow({
        where: { id: reserved.id }
      });
      const providerCompletion = vi.spyOn(harness.provider, "completeReturnManifestTask");
      vi.spyOn(harness.service, "finalize").mockRejectedValueOnce(
        new Error("TASK7_FAKE_FINALIZATION_RETRY")
      );
      const callbackPayload = {
        eventType: "RETURN_MANIFEST_CUSTOMER_SIGNED",
        providerTaskId: started.providerTaskId
      };
      const dispatch = new ESignService(
        harness.audit,
        harness.config,
        harness.provider,
        prisma,
        undefined,
        undefined,
        undefined,
        undefined,
        harness.service
      );
      await expect(dispatch.handleCallback("mock", callbackPayload)).rejects.toThrow(
        "TASK7_FAKE_FINALIZATION_RETRY"
      );
      await expect(
        prisma.contractESignCallbackLog.findMany({ where: { taskId: reserved.id } })
      ).resolves.toMatchObject([{ handled: false }]);
      await expect(dispatch.handleCallback("mock", callbackPayload)).resolves.toMatchObject({
        handled: true,
        taskId: reserved.id
      });
      expect(providerCompletion).toHaveBeenCalledTimes(1);
      await expect(
        dispatch.handleCallback("mock", {
          ...callbackPayload,
          providerObservedAt: "2026-08-22T00:00:00.000Z"
        })
      ).resolves.toMatchObject({ handled: true, idempotent: true, taskId: reserved.id });
      await expect(
        prisma.contractESignCallbackLog.findMany({ where: { taskId: reserved.id } })
      ).resolves.toMatchObject([{ handled: true }]);
      await expect(
        harness.service.start({ ...input, idempotencyKey: `${input.idempotencyKey}:drift` })
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
        status: 409
      });
      await expect(harness.service.finalize(input)).resolves.toMatchObject({ wrote: false });
      await expect(harness.service.start(input)).resolves.toMatchObject({ wrote: false });
      await expect(harness.service.finalize(input)).resolves.toMatchObject({ wrote: false });
    } finally {
      vi.restoreAllMocks();
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  }, 30_000);

  it("serializes concurrent provider start before the external provider side effect", async () => {
    const scenario = await setupFocusedPhysicalReceipt(prisma, {
      early: true,
      skipManifestSuccessors: true
    });
    const input = {
      actorId: scenario.fixture.actorId,
      closureCaseId: scenario.closureCase.id,
      idempotencyKey: "task-7-return-manifest-provider-concurrency"
    } as const;
    const harness = createReturnManifestESignHarness(prisma);
    const barrier = createBarrier();
    const originalCreate = harness.provider.createReturnManifestTask.bind(harness.provider);
    let providerCalls = 0;
    vi.spyOn(harness.provider, "createReturnManifestTask").mockImplementation(
      async (providerInput) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          barrier.enter();
          await barrier.released;
        }
        return originalCreate(providerInput);
      }
    );
    try {
      const first = harness.service.start(input);
      await barrier.entered;
      const second = harness.service.start(input);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(providerCalls).toBe(1);
      barrier.release();
      const results = await Promise.all([first, second]);
      expect(results.map(({ wrote }) => wrote).sort()).toEqual([false, true]);
      expect(providerCalls).toBe(1);
    } finally {
      barrier.release();
      vi.restoreAllMocks();
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  }, 30_000);

  it("serializes concurrent semantic callbacks before the external completion side effect", async () => {
    const scenario = await setupFocusedPhysicalReceipt(prisma, {
      early: true,
      skipManifestSuccessors: true
    });
    const input = {
      actorId: scenario.fixture.actorId,
      closureCaseId: scenario.closureCase.id,
      idempotencyKey: "task-7-return-manifest-callback-concurrency"
    } as const;
    const harness = createReturnManifestESignHarness(prisma);
    const barrier = createBarrier();
    const inFlight: Promise<unknown>[] = [];
    try {
      const started = await harness.service.start(input);
      const callbackPayload = {
        eventType: "RETURN_MANIFEST_CUSTOMER_SIGNED",
        providerTaskId: (
          await prisma.contractESignTask.findUniqueOrThrow({ where: { id: started.taskId } })
        ).providerTaskId
      };
      const dispatch = new ESignService(
        harness.audit,
        harness.config,
        harness.provider,
        prisma,
        undefined,
        undefined,
        undefined,
        undefined,
        harness.service
      );
      const originalComplete = harness.provider.completeReturnManifestTask.bind(harness.provider);
      let providerCalls = 0;
      vi.spyOn(harness.provider, "completeReturnManifestTask").mockImplementation(
        async (providerInput) => {
          providerCalls += 1;
          if (providerCalls === 1) {
            barrier.enter();
            await barrier.released;
          }
          return originalComplete(providerInput);
        }
      );

      const first = dispatch.handleCallback("mock", callbackPayload);
      inFlight.push(first);
      await barrier.entered;
      const second = dispatch.handleCallback("mock", {
        ...callbackPayload,
        retryObservedAt: "2026-08-22T00:00:00.000Z"
      });
      inFlight.push(second);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(providerCalls).toBe(1);
      barrier.release();
      await expect(first).resolves.toMatchObject({ handled: true, taskId: started.taskId });
      await expect(second).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
        status: 409
      });
      await expect(dispatch.handleCallback("mock", callbackPayload)).resolves.toMatchObject({
        handled: true,
        idempotent: true,
        taskId: started.taskId
      });
      expect(providerCalls).toBe(1);
      await expect(
        prisma.contractESignCallbackLog.findMany({ where: { taskId: started.taskId } })
      ).resolves.toMatchObject([{ handled: true }]);
    } finally {
      barrier.release();
      await Promise.allSettled(inFlight);
      vi.restoreAllMocks();
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  }, 30_000);

  it("rolls back finalization when the shared replay validator detects audit drift", async () => {
    const prepared = await prepareTask7ManifestSuccessorRace(prisma);
    const extraAuditId = randomUUID();
    try {
      const task = await prisma.contractESignTask.findFirstOrThrow({
        where: {
          sourceId: prepared.scenario.closureCase.id,
          sourceKey: { startsWith: "return-manifest-esign:" },
          sourceType: "SUBSCRIPTION_CLOSURE_ESIGN"
        }
      });
      await prisma.auditLog.create({
        data: {
          action: "UPDATE",
          afterSnapshot: { tampered: "extra-return-manifest-task-audit" },
          entityId: task.id,
          entityType: "contract_esign_task",
          id: extraAuditId,
          module: "subscription_closure",
          operatorId: prepared.scenario.fixture.actorId
        }
      });
      const before = await Promise.all([
        prisma.subscriptionClosureDocumentRevision.count({
          where: {
            closureCaseId: prepared.scenario.closureCase.id,
            documentType: "RETURN_MANIFEST"
          }
        }),
        prisma.fileObject.count({ where: { uploadedBy: prepared.scenario.fixture.actorId } }),
        prisma.contractESignTask.findUniqueOrThrow({ where: { id: task.id } })
      ]);
      await expect(prepared.harness.service.finalize(prepared.input)).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
        status: 409
      });
      const after = await Promise.all([
        prisma.subscriptionClosureDocumentRevision.count({
          where: {
            closureCaseId: prepared.scenario.closureCase.id,
            documentType: "RETURN_MANIFEST"
          }
        }),
        prisma.fileObject.count({ where: { uploadedBy: prepared.scenario.fixture.actorId } }),
        prisma.contractESignTask.findUniqueOrThrow({ where: { id: task.id } })
      ]);
      expect(after).toEqual(before);
      await prisma.auditLog.delete({ where: { id: extraAuditId } });
      await expect(prepared.harness.service.finalize(prepared.input)).resolves.toMatchObject({
        wrote: true
      });
    } finally {
      await prisma.auditLog.deleteMany({ where: { id: extraAuditId } });
      await cleanupManagedExpiryFixture(prisma, prepared.scenario.fixture);
    }
  }, 30_000);

  it("enforces immutable production manifest facts and detects mutable task drift", async () => {
    const scenario = await setupFocusedPhysicalReceipt(prisma, { early: true });
    if (!scenario.early) throw new Error("Expected early-termination fixture authority");
    try {
      const signedReceipt = await prisma.subscriptionClosureCommandReceipt.findFirstOrThrow({
        where: {
          closureCaseId: scenario.closureCase.id,
          sourceKey: { endsWith: ":signed", startsWith: "return-manifest-esign:" }
        }
      });
      const signedEvent = await prisma.subscriptionClosureEvent.findUniqueOrThrow({
        where: { id: signedReceipt.eventId }
      });
      const signedRevision = await prisma.subscriptionClosureDocumentRevision.findFirstOrThrow({
        where: {
          closureCaseId: scenario.closureCase.id,
          sourceKey: { endsWith: ":signed", startsWith: "return-manifest-esign:" }
        }
      });
      const signedTask = await prisma.contractESignTask.findUniqueOrThrow({
        where: { id: signedRevision.contractESignTaskId }
      });
      await expect(
        scenario.closure.executeEarlyTermination(scenario.early.executionInput)
      ).resolves.toEqual({ ...scenario.early.execution, wrote: false });
      for (const immutableMutation of [
        () =>
          prisma.subscriptionClosureCommandReceipt.update({
            data: { outcomeSnapshot: { tampered: "manifest-successor-outcome" } },
            where: { id: signedReceipt.id }
          }),
        () =>
          prisma.subscriptionClosureEvent.update({
            data: { detailSnapshot: { tampered: "manifest-successor-event" } },
            where: { id: signedEvent.id }
          }),
        () =>
          prisma.subscriptionClosureDocumentRevision.update({
            data: { documentSnapshotHash: "0".repeat(64) },
            where: { id: signedRevision.id }
          })
      ]) {
        await expect(immutableMutation()).rejects.toBeDefined();
      }
      const originalRequestSnapshot = signedTask.requestSnapshot as Prisma.InputJsonValue;
      await prisma.contractESignTask.update({
        data: { requestSnapshot: { tampered: "manifest-successor-task" } },
        where: { id: signedTask.id }
      });
      await expect(
        scenario.closure.executeEarlyTermination(scenario.early.executionInput)
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
        status: 409
      });
      await prisma.contractESignTask.update({
        data: { requestSnapshot: originalRequestSnapshot, updatedAt: signedTask.updatedAt },
        where: { id: signedTask.id }
      });
      await expect(
        scenario.closure.executeEarlyTermination(scenario.early.executionInput)
      ).resolves.toEqual({ ...scenario.early.execution, wrote: false });
    } finally {
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  }, 30_000);

  it("enforces immutable production inspection facts and detects audit drift", async () => {
    const scenario = await setupFocusedPhysicalReceipt(prisma, { early: true });
    if (!scenario.early) throw new Error("Expected early-termination fixture authority");
    try {
      await scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {});
      await closeFocusedInspectionWorkOrder(scenario);
      await scenario.closure.recordManagedReturnInspection(
        focusedInspectionCommand(scenario, false),
        {}
      );
      const inspectionReceipt = await prisma.subscriptionClosureCommandReceipt.findFirstOrThrow({
        where: {
          closureCaseId: scenario.closureCase.id,
          event: { eventType: "INSPECTION_RECORDED" }
        }
      });
      const inspectionEvent = await prisma.subscriptionClosureEvent.findUniqueOrThrow({
        where: { id: inspectionReceipt.eventId }
      });
      const inspectionAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          entityId: inspectionEvent.id,
          entityType: "subscription_closure_event",
          module: "subscription_closure"
        }
      });
      const inspectionEvidence = await prisma.assetWorkOrderEvidence.findFirstOrThrow({
        where: {
          sourceId: scenario.closureCase.id,
          sourceKey: "inspection-evidence:0",
          sourceType: "SUBSCRIPTION_CLOSURE"
        }
      });
      const inspectionCost = await prisma.vehicleCostLedgerEntry.findFirstOrThrow({
        where: {
          sourceId: scenario.closureCase.id,
          sourceKey: "inspection-cost:0",
          sourceType: "SUBSCRIPTION_CLOSURE"
        }
      });
      const inspectionCostReceipt = await prisma.assetAccountingCommandReceipt.findFirstOrThrow({
        where: { costEntryId: inspectionCost.id }
      });
      await expect(
        scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {})
      ).resolves.toEqual({ vehicleReturnId: scenario.closureCase.vehicleReturnId });
      for (const immutableMutation of [
        () =>
          prisma.subscriptionClosureCommandReceipt.update({
            data: { outcomeSnapshot: { tampered: "inspection-successor-outcome" } },
            where: { id: inspectionReceipt.id }
          }),
        () =>
          prisma.subscriptionClosureEvent.update({
            data: { detailSnapshot: { tampered: "inspection-successor-event" } },
            where: { id: inspectionEvent.id }
          }),
        () =>
          prisma.assetWorkOrderEvidence.update({
            data: { sourceKey: "tampered-inspection-evidence" },
            where: { id: inspectionEvidence.id }
          }),
        () =>
          prisma.vehicleCostLedgerEntry.update({
            data: { sourceKey: "tampered-inspection-cost" },
            where: { id: inspectionCost.id }
          }),
        () =>
          prisma.assetAccountingCommandReceipt.update({
            data: { commandType: "COST_REVERSE" },
            where: { id: inspectionCostReceipt.id }
          })
      ]) {
        await expect(immutableMutation()).rejects.toBeDefined();
      }
      await prisma.auditLog.update({
        data: { afterSnapshot: { tampered: "inspection-audit" } },
        where: { id: inspectionAudit.id }
      });
      await expect(
        scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {})
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
        status: 409
      });
      await prisma.auditLog.update({
        data: { afterSnapshot: inspectionAudit.afterSnapshot ?? Prisma.JsonNull },
        where: { id: inspectionAudit.id }
      });
      await expect(
        scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {})
      ).resolves.toEqual({ vehicleReturnId: scenario.closureCase.vehicleReturnId });
    } finally {
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  }, 30_000);

  it("enforces immutable reconditioning facts and detects mutable authority drift", async () => {
    const scenario = await setupFocusedPhysicalReceipt(prisma, { early: true });
    if (!scenario.early) throw new Error("Expected early-termination fixture authority");
    try {
      await scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {});
      await closeFocusedInspectionWorkOrder(scenario);
      await scenario.closure.recordManagedReturnInspection(
        focusedInspectionCommand(scenario, true),
        {}
      );
      const closureCase = await prisma.subscriptionClosureCase.findUniqueOrThrow({
        where: { id: scenario.closureCase.id }
      });
      const createdWorkOrder = await prisma.assetWorkOrder.findUniqueOrThrow({
        where: { id: closureCase.reconditioningAssetWorkOrderId! }
      });
      await scenario.operations.transitionWorkOrder(
        {
          closeReason: null,
          detailSnapshot: { task7: "reconditioning-started" },
          expectedVersion: createdWorkOrder.version,
          occurredAt: scenario.occurredAt,
          solution: null,
          source: {
            id: scenario.closureCase.id,
            key: "focused-reconditioning-start",
            type: "SUBSCRIPTION_CLOSURE"
          },
          targetStatus: "IN_PROGRESS",
          workOrderId: createdWorkOrder.id
        },
        { actorId: scenario.fixture.actorId, permissions: [] }
      );
      const workOrder = await prisma.assetWorkOrder.findUniqueOrThrow({
        where: { id: createdWorkOrder.id }
      });
      const workOrderEvent = await prisma.assetWorkOrderEvent.findFirstOrThrow({
        where: { sequence: 1, workOrderId: workOrder.id }
      });
      const inspectionRestriction = await prisma.vehicleOperationalRestriction.findFirstOrThrow({
        where: {
          restrictionType: "RETURN_INSPECTION_PENDING",
          vehicleId: scenario.fixture.vehicleId
        }
      });
      await expect(
        scenario.closure.executeEarlyTermination(scenario.early.executionInput)
      ).resolves.toEqual({ ...scenario.early.execution, wrote: false });
      await expect(
        prisma.assetWorkOrderEvent.update({
          data: { detailSnapshot: { tampered: "reconditioning-envelope" } },
          where: { id: workOrderEvent.id }
        })
      ).rejects.toBeDefined();
      await expect(
        prisma.vehicleOperationalRestriction.update({
          data: { workOrderId: workOrder.id },
          where: { id: inspectionRestriction.id }
        })
      ).rejects.toBeDefined();
      await prisma.assetWorkOrder.update({
        data: { priority: "URGENT" },
        where: { id: workOrder.id }
      });
      await expect(
        scenario.closure.executeEarlyTermination(scenario.early.executionInput)
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" },
        status: 409
      });
      await prisma.assetWorkOrder.update({
        data: { priority: workOrder.priority, updatedAt: workOrder.updatedAt },
        where: { id: workOrder.id }
      });
      await expect(
        scenario.closure.executeEarlyTermination(scenario.early.executionInput)
      ).resolves.toEqual({ ...scenario.early.execution, wrote: false });
    } finally {
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  }, 30_000);

  it("serializes production execution replay and manifest successor in both directions", async () => {
    const writerFirst = await prepareTask7ManifestSuccessorRace(prisma);
    const writerBarrier = createBarrier();
    try {
      const writerPrisma = hookTransaction(
        prisma,
        "subscriptionClosureDocumentRevision",
        "create",
        writerBarrier,
        "after"
      );
      const writer = new ReturnManifestESignService(
        writerPrisma,
        new SubscriptionClosureRepository(),
        new AuditService(writerPrisma),
        writerFirst.harness.storage as never,
        writerFirst.harness.config,
        writerFirst.harness.provider
      ).finalize(writerFirst.input);
      await writerBarrier.entered;
      await expect(
        writerFirst.scenario.closure.executeEarlyTermination(
          writerFirst.scenario.early!.executionInput
        )
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
        status: 409
      });
      writerBarrier.release();
      await expect(writer).resolves.toMatchObject({ wrote: true });
      await expect(
        writerFirst.scenario.closure.executeEarlyTermination(
          writerFirst.scenario.early!.executionInput
        )
      ).resolves.toEqual({ ...writerFirst.scenario.early!.execution, wrote: false });
    } finally {
      writerBarrier.release();
      await cleanupManagedExpiryFixture(prisma, writerFirst.scenario.fixture);
    }

    const replayFirst = await prepareTask7ManifestSuccessorRace(prisma);
    const replayBarrier = createBarrier();
    try {
      const replay = createTask7ClosureService(
        hookTransaction(prisma, "subscriptionClosureCase", "findUnique", replayBarrier, "after", 3)
      ).executeEarlyTermination(replayFirst.scenario.early!.executionInput);
      await replayBarrier.entered;
      await expect(replayFirst.harness.service.finalize(replayFirst.input)).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
        status: 409
      });
      replayBarrier.release();
      await expect(replay).resolves.toEqual({
        ...replayFirst.scenario.early!.execution,
        wrote: false
      });
      await expect(replayFirst.harness.service.finalize(replayFirst.input)).resolves.toMatchObject({
        wrote: true
      });
      await expect(
        replayFirst.scenario.closure.executeEarlyTermination(
          replayFirst.scenario.early!.executionInput
        )
      ).resolves.toEqual({ ...replayFirst.scenario.early!.execution, wrote: false });
    } finally {
      replayBarrier.release();
      await cleanupManagedExpiryFixture(prisma, replayFirst.scenario.fixture);
    }
  }, 45_000);

  it("proves recovery commands have no authority on the voluntary early-execution graph", async () => {
    const scenario = await setupFocusedPhysicalReceipt(prisma, {
      early: true,
      skipManifestSuccessors: true
    });
    if (!scenario.early) throw new Error("Expected early-termination fixture authority");
    try {
      await expect(
        prisma.subscriptionAutomationJob.count({
          where: {
            jobType: "CLOSURE_RECOVERY_ASSESSMENT_D7",
            orderId: scenario.fixture.orderId
          }
        })
      ).resolves.toBe(0);
      const now = await readTestDatabaseClock(prisma);
      await expect(
        scenario.closure.assessRecoveryJob({
          actorId: scenario.fixture.actorId,
          closureCaseId: scenario.closureCase.id,
          governingBillId: randomUUID(),
          governingDueDate: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1_000),
          jobId: randomUUID(),
          jobKey: `task-7-r2-inapplicable-recovery:${scenario.closureCase.id}`,
          orderId: scenario.fixture.orderId
        })
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_RECOVERY_JOB_AUTHORITY_INVALID" },
        status: 409
      });
      await expect(
        scenario.closure.requestRecoveryExecutionApproval({
          actorId: scenario.fixture.actorId,
          closureCaseId: scenario.closureCase.id,
          idempotencyKey: "task-7-r2-inapplicable-recovery-approval",
          reason: "Must not cross from voluntary early termination into recovery",
          requestedAt: now
        })
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
    } finally {
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
    }
  }, 30_000);

  it("serializes production execution replay and physical receipt in both directions", async () => {
    const writerFirst = await setupFocusedPhysicalReceipt(prisma, { early: true });
    if (!writerFirst.early) throw new Error("Expected early-termination fixture authority");
    const writerBarrier = createBarrier();
    try {
      const before = await snapshotPhysicalReturnTruth(prisma, writerFirst.fixture);
      const writer = createTask7ClosureService(
        hookTransaction(prisma, "vehicleReturn", "update", writerBarrier, "after")
      ).confirmManagedPhysicalReceipt(writerFirst.receipt, {});
      await writerBarrier.entered;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          writerFirst.closure.executeEarlyTermination(writerFirst.early.executionInput)
        ).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
          status: 409
        });
      }
      await expect(snapshotPhysicalReturnTruth(prisma, writerFirst.fixture)).resolves.toEqual(
        before
      );
      writerBarrier.release();
      await expect(writer).resolves.toEqual({
        vehicleReturnId: writerFirst.closureCase.vehicleReturnId
      });
      await expect(
        writerFirst.closure.executeEarlyTermination(writerFirst.early.executionInput)
      ).resolves.toEqual({ ...writerFirst.early.execution, wrote: false });
    } finally {
      writerBarrier.release();
      await cleanupManagedExpiryFixture(prisma, writerFirst.fixture);
    }

    const replayFirst = await setupFocusedPhysicalReceipt(prisma, { early: true });
    if (!replayFirst.early) throw new Error("Expected early-termination fixture authority");
    const replayBarrier = createBarrier();
    try {
      const before = await snapshotPhysicalReturnTruth(prisma, replayFirst.fixture);
      const replay = createTask7ClosureService(
        hookTransaction(prisma, "subscriptionClosureCase", "findUnique", replayBarrier, "after", 3)
      ).executeEarlyTermination(replayFirst.early.executionInput);
      await replayBarrier.entered;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          replayFirst.closure.confirmManagedPhysicalReceipt(replayFirst.receipt, {})
        ).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
          status: 409
        });
      }
      await expect(snapshotPhysicalReturnTruth(prisma, replayFirst.fixture)).resolves.toEqual(
        before
      );
      replayBarrier.release();
      await expect(replay).resolves.toEqual({ ...replayFirst.early.execution, wrote: false });
      await expect(
        replayFirst.closure.confirmManagedPhysicalReceipt(replayFirst.receipt, {})
      ).resolves.toEqual({ vehicleReturnId: replayFirst.closureCase.vehicleReturnId });
    } finally {
      replayBarrier.release();
      await cleanupManagedExpiryFixture(prisma, replayFirst.fixture);
    }
  }, 45_000);

  it("serializes production execution replay and inspection in both directions", async () => {
    const prepare = async () => {
      const scenario = await setupFocusedPhysicalReceipt(prisma, { early: true });
      if (!scenario.early) throw new Error("Expected early-termination fixture authority");
      await scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {});
      await closeFocusedInspectionWorkOrder(scenario);
      return scenario;
    };
    const writerFirst = await prepare();
    const writerBarrier = createBarrier();
    try {
      const before = await snapshotPhysicalReturnTruth(prisma, writerFirst.fixture);
      const writer = createTask7ClosureService(
        hookTransaction(prisma, "assetWorkOrderEvidence", "create", writerBarrier, "after")
      ).recordManagedReturnInspection(focusedInspectionCommand(writerFirst, false), {});
      await writerBarrier.entered;
      await expect(
        writerFirst.closure.executeEarlyTermination(writerFirst.early!.executionInput)
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
        status: 409
      });
      await expect(snapshotPhysicalReturnTruth(prisma, writerFirst.fixture)).resolves.toEqual(
        before
      );
      writerBarrier.release();
      await expect(writer).resolves.toMatchObject({ case: { status: "PENDING_SETTLEMENT" } });
      await expect(
        writerFirst.closure.executeEarlyTermination(writerFirst.early!.executionInput)
      ).resolves.toEqual({ ...writerFirst.early!.execution, wrote: false });
    } finally {
      writerBarrier.release();
      await cleanupManagedExpiryFixture(prisma, writerFirst.fixture);
    }

    const replayFirst = await prepare();
    const replayBarrier = createBarrier();
    try {
      const before = await snapshotPhysicalReturnTruth(prisma, replayFirst.fixture);
      const replay = createTask7ClosureService(
        hookTransaction(prisma, "subscriptionClosureCase", "findUnique", replayBarrier, "after", 3)
      ).executeEarlyTermination(replayFirst.early!.executionInput);
      await replayBarrier.entered;
      await expect(
        replayFirst.closure.recordManagedReturnInspection(
          focusedInspectionCommand(replayFirst, false),
          {}
        )
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
        status: 409
      });
      await expect(snapshotPhysicalReturnTruth(prisma, replayFirst.fixture)).resolves.toEqual(
        before
      );
      replayBarrier.release();
      await expect(replay).resolves.toEqual({ ...replayFirst.early!.execution, wrote: false });
      await expect(
        replayFirst.closure.recordManagedReturnInspection(
          focusedInspectionCommand(replayFirst, false),
          {}
        )
      ).resolves.toMatchObject({ case: { status: "PENDING_SETTLEMENT" } });
    } finally {
      replayBarrier.release();
      await cleanupManagedExpiryFixture(prisma, replayFirst.fixture);
    }
  }, 45_000);

  it("serializes production execution replay and settlement close writer in both directions", async () => {
    const settlementInput = async (
      scenario: Awaited<ReturnType<typeof setupFocusedPhysicalReceipt>>,
      suffix: string
    ) => ({
      actorId: scenario.fixture.actorId,
      closureCaseId: scenario.closureCase.id,
      idempotencyKey: `task-7-r2-race-${suffix}`,
      occurredAt: await readTestDatabaseClock(prisma),
      waiverApprovalId: null,
      writeOffApprovalId: null
    });
    const prepare = async () => {
      const scenario = await setupFocusedPhysicalReceipt(prisma, { early: true });
      if (!scenario.early) throw new Error("Expected early-termination fixture authority");
      await scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {});
      await closeFocusedInspectionWorkOrder(scenario);
      await scenario.closure.recordManagedReturnInspection(
        focusedInspectionCommand(scenario, false),
        {}
      );
      await scenario.closure.proposeManagedSettlement(
        await settlementInput(scenario, "prepare-propose")
      );
      await scenario.closure.finalizeManagedSettlement(
        await settlementInput(scenario, "prepare-finalize")
      );
      return scenario;
    };
    const writerFirst = await prepare();
    const writerBarrier = createBarrier();
    try {
      const command = await settlementInput(writerFirst, "writer-first");
      const before = await snapshotPhysicalReturnTruth(prisma, writerFirst.fixture);
      const writer = createTask7ClosureService(
        hookTransaction(
          prisma,
          "subscriptionClosureSettlementRevision",
          "create",
          writerBarrier,
          "after"
        )
      ).settleManagedSettlement(command);
      await writerBarrier.entered;
      await expect(
        writerFirst.closure.executeEarlyTermination(writerFirst.early!.executionInput)
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
        status: 409
      });
      await expect(snapshotPhysicalReturnTruth(prisma, writerFirst.fixture)).resolves.toEqual(
        before
      );
      writerBarrier.release();
      await expect(writer).resolves.toMatchObject({ revisionNumber: 3, stage: "SETTLED" });
      await expect(
        writerFirst.closure.executeEarlyTermination(writerFirst.early!.executionInput)
      ).resolves.toEqual({ ...writerFirst.early!.execution, wrote: false });
    } finally {
      writerBarrier.release();
      await cleanupManagedExpiryFixture(prisma, writerFirst.fixture);
    }

    const replayFirst = await prepare();
    const replayBarrier = createBarrier();
    try {
      const command = await settlementInput(replayFirst, "replay-first");
      const before = await snapshotPhysicalReturnTruth(prisma, replayFirst.fixture);
      const replay = createTask7ClosureService(
        hookTransaction(prisma, "subscriptionClosureCase", "findUnique", replayBarrier, "after", 3)
      ).executeEarlyTermination(replayFirst.early!.executionInput);
      await replayBarrier.entered;
      await expect(replayFirst.closure.settleManagedSettlement(command)).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
        status: 409
      });
      await expect(snapshotPhysicalReturnTruth(prisma, replayFirst.fixture)).resolves.toEqual(
        before
      );
      replayBarrier.release();
      await expect(replay).resolves.toEqual({ ...replayFirst.early!.execution, wrote: false });
      await expect(replayFirst.closure.settleManagedSettlement(command)).resolves.toMatchObject({
        revisionNumber: 3,
        stage: "SETTLED"
      });
    } finally {
      replayBarrier.release();
      await cleanupManagedExpiryFixture(prisma, replayFirst.fixture);
    }
  }, 45_000);

  it("serializes production execution replay and reconditioning creation in both directions", async () => {
    const prepare = async () => {
      const scenario = await setupFocusedPhysicalReceipt(prisma, { early: true });
      if (!scenario.early) throw new Error("Expected early-termination fixture authority");
      await scenario.closure.confirmManagedPhysicalReceipt(scenario.receipt, {});
      await closeFocusedInspectionWorkOrder(scenario);
      return scenario;
    };
    const writerFirst = await prepare();
    const writerBarrier = createBarrier();
    try {
      const before = await snapshotPhysicalReturnTruth(prisma, writerFirst.fixture);
      const writer = createTask7ClosureService(
        hookTransaction(prisma, "assetWorkOrder", "create", writerBarrier, "after")
      ).recordManagedReturnInspection(focusedInspectionCommand(writerFirst, true), {});
      await writerBarrier.entered;
      await expect(
        writerFirst.closure.executeEarlyTermination(writerFirst.early!.executionInput)
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
        status: 409
      });
      await expect(snapshotPhysicalReturnTruth(prisma, writerFirst.fixture)).resolves.toEqual(
        before
      );
      writerBarrier.release();
      await expect(writer).resolves.toMatchObject({ case: { status: "RECONDITIONING" } });
      await expect(
        writerFirst.closure.executeEarlyTermination(writerFirst.early!.executionInput)
      ).resolves.toEqual({ ...writerFirst.early!.execution, wrote: false });
    } finally {
      writerBarrier.release();
      await cleanupManagedExpiryFixture(prisma, writerFirst.fixture);
    }

    const replayFirst = await prepare();
    const replayBarrier = createBarrier();
    try {
      const before = await snapshotPhysicalReturnTruth(prisma, replayFirst.fixture);
      const replay = createTask7ClosureService(
        hookTransaction(prisma, "subscriptionClosureCase", "findUnique", replayBarrier, "after", 3)
      ).executeEarlyTermination(replayFirst.early!.executionInput);
      await replayBarrier.entered;
      await expect(
        replayFirst.closure.recordManagedReturnInspection(
          focusedInspectionCommand(replayFirst, true),
          {}
        )
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY" },
        status: 409
      });
      await expect(snapshotPhysicalReturnTruth(prisma, replayFirst.fixture)).resolves.toEqual(
        before
      );
      replayBarrier.release();
      await expect(replay).resolves.toEqual({ ...replayFirst.early!.execution, wrote: false });
      await expect(
        replayFirst.closure.recordManagedReturnInspection(
          focusedInspectionCommand(replayFirst, true),
          {}
        )
      ).resolves.toMatchObject({ case: { status: "RECONDITIONING" } });
    } finally {
      replayBarrier.release();
      await cleanupManagedExpiryFixture(prisma, replayFirst.fixture);
    }
  }, 45_000);

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
  }, 45_000);

  it("keeps the exact closure restriction immutable before inventory release", async () => {
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
      const releaseCommand = {
        actorId: scenario.fixture.actorId,
        closureCaseId: scenario.closureCase.id,
        occurredAt: scenario.occurredAt,
        releaseReason: "focused inspection accepted"
      };
      const immutableTruth = await snapshotPhysicalReturnTruth(prisma, scenario.fixture);
      await expect(
        prisma.vehicleOperationalRestriction.update({
          data: { startSourceKey: "focused-unrelated-restriction" },
          where: { id: restriction.id }
        })
      ).rejects.toBeDefined();
      await expect(snapshotPhysicalReturnTruth(prisma, scenario.fixture)).resolves.toEqual(
        immutableTruth
      );
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
      const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
        where: { orderId: fixture.orderId, retiredAt: null }
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
            documentType: "RECOVERY_AUTHORITY",
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
            signingStage: "STAGE5_RECOVERY_AUTHORITY",
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
      await expect(closure.confirmManagedPhysicalReceipt(receipt, {})).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      await expect(
        closure.confirmManagedPhysicalReceipt(
          { ...receipt, physicalControlMode: "VOLUNTARY_RETURN" },
          {}
        )
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_MANAGED_RETURN_AUTHORITY_NOT_FOUND" },
        status: 409
      });
    } finally {
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  }, 30_000);

  it("Task 9 journey B completes D+7 approval, recovery, inspection, and termination settlement", async () => {
    const scenario = await setupTask6ExecutedRecovery(prisma);
    try {
      const { closure, closureCase, fixture, plannedRecoveryAssetWorkOrderId } = scenario;
      await expect(closure.confirmManagedPhysicalReceipt(scenario.receipt, {})).resolves.toEqual({
        vehicleReturnId: closureCase.vehicleReturnId
      });
      const audit = new AuditService(prisma);
      const accounting = new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
      const operations = new AssetOperationsService(
        prisma,
        new AssetOperationsRepository(),
        audit,
        accounting
      );
      for (const [expectedVersion, targetStatus] of [
        [1, "PENDING_ACCEPTANCE"],
        [2, "PENDING_COST_CONFIRMATION"],
        [3, "CLOSED"]
      ] as const) {
        await operations.transitionWorkOrder(
          {
            closeReason: targetStatus === "CLOSED" ? "recovery inspection accepted" : null,
            detailSnapshot: { journey: "TASK9_RECOVERY", targetStatus },
            expectedVersion,
            occurredAt: await readTestDatabaseClock(prisma),
            solution: targetStatus === "CLOSED" ? "accepted" : null,
            source: {
              id: closureCase.id,
              key: `task-9-recovery-inspection-${expectedVersion}`,
              type: "TASK9_ACCEPTANCE"
            },
            targetStatus,
            workOrderId: plannedRecoveryAssetWorkOrderId
          },
          { actorId: fixture.actorId, permissions: [] }
        );
        if (targetStatus === "PENDING_COST_CONFIRMATION") {
          const costSource = {
            id: closureCase.id,
            key: "task-9-recovery-cost",
            type: "TASK9_ACCEPTANCE"
          };
          const confirmedAt = await readTestDatabaseClock(prisma);
          await accounting.appendCost(
            {
              actionType: "ACTUAL_COST",
              accountingPeriod: "2026-08",
              amountCents: 1500n,
              assetOwnerId: null,
              assetOwnerSnapshot: null,
              confirmedAt,
              contractId: fixture.contractId,
              costCategory: "CLEANING",
              customerId: fixture.customerId,
              evidenceId: null,
              evidenceSnapshot: null,
              occurredOn: new Date("2026-08-23T00:00:00.000Z"),
              orderId: fixture.orderId,
              reason: "secured recovery cost confirmed",
              responsiblePartyId: fixture.customerId,
              responsiblePartyType: "CUSTOMER",
              responsibilitySnapshot: { basis: "task-9 recovery acceptance" },
              source: costSource,
              vehicleId: fixture.vehicleId,
              workOrderId: plannedRecoveryAssetWorkOrderId
            },
            {
              actorId: fixture.actorId,
              idempotencyKey: costSource.key,
              permissions: [ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM]
            }
          );
        }
      }
      const inspectionAt = await readTestDatabaseClock(prisma);
      await expect(
        closure.recordManagedReturnInspection(
          {
            accepted: true,
            actorId: fixture.actorId,
            closureCaseId: closureCase.id,
            costs: [
              {
                actionType: "ACTUAL_COST",
                accountingPeriod: "2026-08",
                amountCents: 1500n,
                assetOwnerId: null,
                assetOwnerSnapshot: null,
                confirmedAt: inspectionAt,
                costCategory: "CLEANING",
                evidenceId: null,
                evidenceSnapshot: null,
                occurredOn: new Date("2026-08-23T00:00:00.000Z"),
                reason: "secured vehicle inspection",
                responsiblePartyId: fixture.customerId,
                responsiblePartyType: "CUSTOMER",
                responsibilitySnapshot: { basis: "task-9 recovery inspection" }
              }
            ],
            evidence: [
              {
                action: "ATTACH",
                capturedAt: inspectionAt,
                captureMetadata: { journey: "TASK9_RECOVERY" },
                contentSha256: scenario.signedFileHash,
                eventId: null,
                evidenceType: "INSPECTION_REPORT",
                fileId: scenario.signedFileId,
                occurredAt: inspectionAt,
                supersedesEvidenceId: null
              }
            ],
            occurredAt: inspectionAt,
            reconditioningRequired: false
          },
          {}
        )
      ).resolves.toMatchObject({ case: { status: "PENDING_SETTLEMENT" } });
      await settleTask6Bill(
        prisma,
        new FinanceService(new AuditService(prisma), prisma),
        fixture,
        scenario.billId,
        900n,
        0
      );
      const settlementInput = async (suffix: string) => ({
        actorId: fixture.actorId,
        closureCaseId: closureCase.id,
        idempotencyKey: `task-9-recovery-${suffix}`,
        occurredAt: await readTestDatabaseClock(prisma),
        waiverApprovalId: null,
        writeOffApprovalId: null
      });
      await closure.proposeManagedSettlement(await settlementInput("propose"));
      await closure.finalizeManagedSettlement(await settlementInput("finalize"));
      const settleCommand = await settlementInput("settle");
      const settled = await closure.settleManagedSettlement(settleCommand);
      await expect(closure.settleManagedSettlement(settleCommand)).resolves.toEqual(settled);
      await expect(
        Promise.all([
          prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCase.id } }),
          prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } }),
          prisma.contract.findUniqueOrThrow({ where: { id: fixture.contractId } })
        ])
      ).resolves.toMatchObject([
        { status: "TERMINATED" },
        { orderStatus: "TERMINATED" },
        { status: "TERMINATED" }
      ]);
    } finally {
      await cleanupManagedExpiryFixture(prisma, scenario.fixture);
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
      const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
        where: { orderId: fixture.orderId, retiredAt: null }
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
        const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
          where: { orderId: fixture.orderId, retiredAt: null }
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
        const firstAssessment = await closure
          .assessRecoveryJob(assessmentInput)
          .catch(rethrowRecoveryAssessmentIntegrationError);
        expect(firstAssessment).toEqual({ action: "NO_OP", reason });

        if (reason === "LIVE_DISPUTE") {
          await prisma.collectionAction.delete({ where: { id: collectionActionId } });
          await prisma.collectionCase.delete({ where: { id: collectionCaseId } });
        } else {
          await prisma.subscriptionContractSegment.update({
            data: { status: "COMPLETED" },
            where: { id: fixture.segmentId }
          });
        }
        const replayedAssessment = await closure
          .assessRecoveryJob(assessmentInput)
          .catch(rethrowRecoveryAssessmentIntegrationError);
        expect(replayedAssessment).toEqual({ action: "NO_OP", reason });
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
    let writer: Promise<unknown> | null = null;
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
      writer = archive.finalizeArchivedContract({
        completedAt: extension.completedAt,
        contractId: scenario.fixture.contractId,
        source: "CALLBACK",
        taskId: extension.taskId
      });
      await waitForTask6BarrierEntry(barrier, [writer], "extension archive writer");
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
      await Promise.allSettled([writer].filter((value) => value !== null));
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
        await waitForTask6BarrierEntry(barrier, [assessment], "recovery assessment holder");

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
      const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
        where: { orderId: fixture.orderId, retiredAt: null }
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
      let requesterId: string;
      try {
        const expiry = createGovernedExpiryService(prisma);
        await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
        const { closure } = createTask6ClosureService(prisma);
        await runManagedPrepare(prisma, closure, fixture);
        const initialCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
          where: { orderId: fixture.orderId, retiredAt: null }
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

      const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
        where: { orderId: fixture.orderId, retiredAt: null }
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
        documentType: ESignDocumentType.RETURN_MANIFEST,
        orderId: fixture.orderId,
        signingStage: ESignSigningStage.STAGE6_RETURN_MANIFEST,
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
      const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
        where: { orderId: fixture.orderId, retiredAt: null }
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

      await expect(
        prisma.fileObject.delete({ where: { id: originalFile.id } })
      ).rejects.toBeDefined();
      await expect(
        service.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:01.000Z"))
      ).resolves.toMatchObject({ outcome: "DUPLICATE" });
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
        const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
          where: { orderId: fixture.orderId, retiredAt: null }
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

  it("fails normal-expiry replay closed when effective-boundary facts drift after observation", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const initialService = createGovernedExpiryService(prisma);
    const barrier = createBarrier();
    const originalPayload = { periodStart: "2026-10-03" };
    try {
      await initialService.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      const baseline = await snapshotManagedExpiryTruth(prisma, fixture);
      const replayService = createGovernedExpiryService(
        hookTransaction(prisma, "subscriptionAutomationJob", "findMany", barrier, "after")
      );
      const replayPromise = replayService.expireSegment(
        fixture.segmentId,
        new Date("2026-08-20T16:00:01.000Z")
      );
      await barrier.entered;
      await prisma.subscriptionAutomationJob.update({
        data: { payload: { periodStart: "2026-11-03" } },
        where: { id: fixture.futureJobId }
      });
      barrier.release();

      await expect(replayPromise).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" },
        status: 409
      });
      const driftOnly = structuredClone(baseline);
      const driftedJob = driftOnly.automationJobs.find(({ id }) => id === fixture.futureJobId);
      if (!driftedJob) throw new Error("Expected the future-job authority snapshot");
      driftedJob.payload = { periodStart: "2026-11-03" };
      await expect(snapshotManagedExpiryTruth(prisma, fixture)).resolves.toEqual(driftOnly);
      await expect(
        prisma.subscriptionAutomationJob.findUniqueOrThrow({
          select: { payload: true },
          where: { id: fixture.futureJobId }
        })
      ).resolves.toEqual({ payload: { periodStart: "2026-11-03" } });

      await prisma.subscriptionAutomationJob.update({
        data: { payload: originalPayload },
        where: { id: fixture.futureJobId }
      });
      await expect(
        initialService.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:01.000Z"))
      ).resolves.toMatchObject({ outcome: "DUPLICATE" });
    } finally {
      barrier.release();
      await cleanupManagedExpiryFixture(prisma, fixture);
    }
  }, 30_000);

  it("replays the immutable actor and revision one after actor and manifest successors change", async () => {
    const fixture = await createManagedExpiryFixture(prisma);
    const service = createGovernedExpiryService(prisma);
    const candidateId = randomUUID();
    try {
      await service.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
      const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
        where: { orderId: fixture.orderId, retiredAt: null }
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
            "id", "closure_case_id", "revision_number", "supersedes_revision_id", "document_type", "stage",
            "document_snapshot", "document_snapshot_hash", "vehicle_return_id",
            "handover_work_order_id", "contract_esign_task_id", "source_file_id",
            "source_file_hash", "signed_file_id", "signed_file_hash", "source_type",
            "source_id", "source_key", "generated_by", "generated_at", "signed_by",
            "signed_at", "created_at"
          ) SELECT
            ${revisionTwoId}::uuid, "closure_case_id", 2, ${revisionOne.id}::uuid, "document_type", 'SIGNED',
            "document_snapshot", "document_snapshot_hash", "vehicle_return_id",
            "handover_work_order_id", "contract_esign_task_id", "source_file_id",
            "source_file_hash", "source_file_id", "source_file_hash", 'TASK3_TEST',
            ${fixture.orderId}::uuid, 'return-manifest:2', ${candidateId}::uuid, "generated_at",
            ${candidateId}::uuid, "generated_at", clock_timestamp()
          FROM "subscription_closure_document_revision" WHERE "id" = ${revisionOne.id}::uuid
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "subscription_closure_document_revision" (
            "id", "closure_case_id", "revision_number", "supersedes_revision_id", "document_type", "stage",
            "document_snapshot", "document_snapshot_hash", "vehicle_return_id",
            "handover_work_order_id", "contract_esign_task_id", "source_file_id",
            "source_file_hash", "signed_file_id", "signed_file_hash", "source_type",
            "source_id", "source_key", "generated_by", "generated_at", "signed_by",
            "signed_at", "archived_by", "archived_at", "created_at"
          ) SELECT
            ${revisionThreeId}::uuid, "closure_case_id", 3, ${revisionTwoId}::uuid, "document_type", 'ARCHIVED',
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
      const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
        where: { orderId: fixture.orderId, retiredAt: null }
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
      const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
        where: { orderId: fixture.orderId, retiredAt: null }
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
      const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
        where: { orderId: fixture.orderId, retiredAt: null }
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
  const repository = new SubscriptionClosureRepository();
  const capabilities = new WeakMap<
    object,
    Readonly<{
      boundaryCapability: Parameters<
        typeof subscriptionEffectiveBoundaryOwner.applyPreparedInTransaction
      >[2];
      returnId: string;
      session: Parameters<typeof repository.prepareAuthorityInTransaction>[1];
      transaction: Prisma.TransactionClient;
      attestation: Parameters<
        typeof subscriptionEffectiveBoundaryOwner.applyPreparedInTransaction
      >[3];
    }>
  >();
  return {
    completeNormalExpiryInTransaction: vi.fn(
      async (tx: Prisma.TransactionClient, _input: unknown, capability: object) => {
        const state = capabilities.get(capability);
        capabilities.delete(capability);
        if (!state || state.transaction !== tx) throw new Error("TEST_BOUNDARY_CAPABILITY_INVALID");
        await subscriptionEffectiveBoundaryOwner.applyPreparedInTransaction(
          tx,
          state.session,
          state.boundaryCapability,
          state.attestation
        );
        return {
          closureCaseId: randomUUID(),
          returnAssetWorkOrderId: randomUUID(),
          returnHandoverWorkOrderId: randomUUID(),
          returnManifestRevisionId: randomUUID()
        };
      }
    ),
    prepareNormalExpiryInTransaction: vi.fn(
      async (
        tx: Prisma.TransactionClient,
        input: Readonly<{ decisionAt: Date; orderId: string; segmentId: string }>
      ) => {
        const segment = await tx.subscriptionContractSegment.findUniqueOrThrow({
          select: { endDate: true },
          where: { id: input.segmentId }
        });
        const session = repository.createAuthoritySessionInTransaction(tx);
        const prepared = await subscriptionEffectiveBoundaryOwner.prepareInTransaction(
          tx,
          session,
          {
            boundaryAt: segment.endDate,
            occurredAt: input.decisionAt,
            orderId: input.orderId
          }
        );
        const attestations = await repository.prepareAuthorityInTransaction(
          tx,
          session,
          prepared.requirement.locks,
          [prepared.requirement]
        );
        const attestation = attestations.get("effective-boundary-stop");
        if (!attestation) throw new Error("TEST_BOUNDARY_ATTESTATION_MISSING");
        const capability = Object.freeze({});
        capabilities.set(capability, {
          attestation,
          boundaryCapability: prepared.capability,
          returnId: randomUUID(),
          session,
          transaction: tx
        });
        return capability;
      }
    ),
    preparedNormalExpiryVehicleReturnId: vi.fn(
      (_tx: Prisma.TransactionClient, capability: object) => {
        const state = capabilities.get(capability);
        if (!state) throw new Error("TEST_BOUNDARY_CAPABILITY_INVALID");
        return state.returnId;
      }
    ),
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

function createTask6ClosureService(
  prisma: PrismaService,
  repository: SubscriptionClosureRepository = new SubscriptionClosureRepository()
) {
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
      repository,
      new HandoverWorkOrderService(prisma, {} as never),
      operations,
      audit,
      prisma,
      new AssetFactsService(prisma, new AssetFactsRepository(), audit),
      accounting,
      new VehicleMileageService(prisma, new VehicleMileageRepository()),
      new SubscriptionClosureSettlementResolver()
    ),
    operations
  };
}

function createTask7ClosureService(prisma: PrismaService) {
  const audit = new AuditService(prisma);
  const accounting = new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
  const operations = new AssetOperationsService(
    prisma,
    new AssetOperationsRepository(),
    audit,
    accounting
  );
  return new SubscriptionClosureService(
    new SubscriptionClosureRepository(),
    new HandoverWorkOrderService(prisma, {} as never),
    operations,
    audit,
    prisma,
    new AssetFactsService(prisma, new AssetFactsRepository(), audit),
    accounting,
    new VehicleMileageService(prisma, new VehicleMileageRepository()),
    new SubscriptionClosureSettlementResolver()
  );
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
  await awaitDatabaseClockAtOrAfterLatestClosureEvent(prisma, assessedCase.id);
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
  let requesterId: string;
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
    const initialCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
      where: { orderId: fixture.orderId, retiredAt: null }
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
      signedFileHash: approved.authority.signedFileHash,
      signedFileId: approved.authority.signedFileId,
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
    const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
      where: { orderId: fixture.orderId, retiredAt: null }
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
  const databaseClock = await readTestDatabaseClock(prisma);
  const completionDeadlineAt = new Date(databaseClock.getTime() + 24 * 60 * 60 * 1_000);
  await prisma.$transaction(async (tx) => {
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
        ${completionDeadlineAt},
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
        ${completionDeadlineAt},
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.subscriptionExtensionChangeDetail.create({
      data: {
        changeOrderId: changeId,
        extensionMonths: 6,
        pricingMode: "CURRENT_VERSION",
        sourceSegmentId: fixture.segmentId,
        targetEndDate: new Date("2027-02-20T00:00:00.000Z"),
        targetStartDate: new Date("2026-08-21T00:00:00.000Z")
      }
    });
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
        "source_type", "source_id", "source_key", "completed_at", "created_at", "updated_at"
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
        'SUBSCRIPTION_EXTENSION',
        ${changeId}::uuid,
        ${`subscription-change:${changeId}:esign:attempt:1`},
        ${completedAt},
        clock_timestamp(),
        clock_timestamp()
      )
    `);
  });
  const [currentDatabaseClock, consideration, changeOrder] = await Promise.all([
    readTestDatabaseClock(prisma),
    prisma.renewalConsideration.findUniqueOrThrow({
      select: { completionDeadlineAt: true },
      where: { id: considerationId }
    }),
    prisma.subscriptionChangeOrder.findUniqueOrThrow({
      select: { completionDeadlineAt: true },
      where: { id: changeId }
    })
  ]);
  if (
    consideration.completionDeadlineAt.getTime() <= currentDatabaseClock.getTime() ||
    changeOrder.completionDeadlineAt.getTime() <= currentDatabaseClock.getTime()
  ) {
    throw new Error("Task 6 extension fixture requires future completion deadlines");
  }
  return { completedAt, completionDeadlineAt, taskId };
}

async function runManagedPrepare(
  prisma: PrismaService,
  closure: SubscriptionClosureService,
  fixture: Awaited<ReturnType<typeof createManagedExpiryFixture>>,
  barrier?: ReturnType<typeof createBarrier>
) {
  const result = await prisma.$transaction(
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
  await awaitDatabaseClockAtOrAfterLatestClosureEvent(prisma, undefined, fixture.orderId);
  return result;
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

async function awaitDatabaseClockAtOrAfterLatestClosureEvent(
  prisma: PrismaService,
  closureCaseId?: string,
  orderId?: string
) {
  if ((closureCaseId === undefined) === (orderId === undefined)) {
    throw new Error("Exactly one closure-event authority identifier is required");
  }
  const deadline = Date.now() + 10_000;
  while (true) {
    const [boundary] = await prisma.$queryRaw<
      Array<{ clockTimestamp: Date; latestOccurredAt: Date | null }>
    >(Prisma.sql`
      SELECT clock_timestamp() AS "clockTimestamp",
             MAX(event."occurred_at") AS "latestOccurredAt"
      FROM "subscription_closure_event" AS event
      JOIN "subscription_closure_case" AS closure_case
        ON closure_case."id" = event."closure_case_id"
      WHERE (${closureCaseId ?? null}::uuid IS NOT NULL AND closure_case."id" = ${closureCaseId ?? null}::uuid)
         OR (${orderId ?? null}::uuid IS NOT NULL AND closure_case."order_id" = ${orderId ?? null}::uuid)
    `);
    if (
      boundary &&
      (boundary.latestOccurredAt === null ||
        boundary.clockTimestamp.getTime() >= boundary.latestOccurredAt.getTime())
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Database clock did not reach the latest closure event");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
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
  const contractVersionId = randomUUID();
  const marker = `expiry-${fixture.orderId}`;
  await prisma.$transaction(
    async (tx) => {
      await insertRuntimeUser(tx, actorId, marker);
      await tx.contractVersion.create({
        data: {
          contentTemplate: "Normal expiry contract",
          effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
          id: contractVersionId,
          status: "ACTIVE",
          templateName: `Expiry ${contractId}`,
          versionNo: "V1.0"
        }
      });
      await tx.contract.create({
        data: {
          contractNo: `CONEXP${contractId.replaceAll("-", "").slice(0, 18)}`,
          contractSnapshot: {},
          contractTitle: "Normal expiry contract",
          contractVersionId,
          createdBy: actorId,
          customerId: fixture.customerId,
          id: contractId,
          orderId: fixture.orderId,
          status: "SIGNED",
          updatedBy: actorId
        }
      });
      await tx.subscriptionOrder.update({
        data: {
          contractId,
          createdBy: actorId,
          endDate: new Date("2026-08-20T00:00:00.000Z"),
          updatedBy: actorId
        },
        where: { id: fixture.orderId }
      });
      await tx.subscriptionContractSegment.update({
        data: {
          createdBy: actorId,
          endDate: new Date("2026-08-20T00:00:00.000Z")
        },
        where: { id: fixture.segmentId }
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
  );
  return { ...fixture, actorId, contractId };
}

async function setupFocusedPhysicalReceipt(
  prisma: PrismaService,
  options: Readonly<{ early?: boolean; skipManifestSuccessors?: boolean }> = {}
) {
  const fixture = await createManagedExpiryFixture(prisma);
  const checklist = {
    batteryCheckedConfirmed: true,
    chargingEquipmentReturnedConfirmed: true,
    customerItemsClearedConfirmed: true,
    damageFound: !options.early,
    exteriorCheckedConfirmed: true,
    interiorCheckedConfirmed: true,
    keysReturnedConfirmed: true,
    mileageConfirmed: true,
    vehicleDocumentsReturnedConfirmed: true,
    violationCheckedConfirmed: true
  };
  let early:
    | Readonly<{
        agreementInput: Readonly<{
          actorId: string;
          closureCaseId: string;
          idempotencyKey: string;
        }>;
        execution: Extract<
          Awaited<ReturnType<SubscriptionClosureService["executeEarlyTermination"]>>,
          { returnManifestRevisionId: string }
        >;
        executionInput: Readonly<{
          actorId: string;
          closureCaseId: string;
          idempotencyKey: string;
        }>;
      }>
    | undefined;
  if (options.early) {
    const earlyClosure = createTask6ClosureService(prisma).closure;
    const now = await readTestDatabaseClock(prisma);
    const effectiveAt = new Date(now.getTime() + 1_000);
    await prisma.$transaction([
      prisma.subscriptionOrder.update({
        data: { endDate: new Date("2027-02-02T00:00:00.000Z") },
        where: { id: fixture.orderId }
      }),
      prisma.subscriptionContractSegment.update({
        data: { endDate: new Date("2027-02-02T00:00:00.000Z") },
        where: { id: fixture.segmentId }
      })
    ]);
    const initiated = await earlyClosure.initiateEarlyTermination({
      actorId: fixture.actorId,
      effectiveAt,
      evidence: [{ reference: "task-7-full-journey", type: "CUSTOMER_REQUEST" }],
      idempotencyKey: "task-7-full-journey-init",
      orderId: fixture.orderId,
      reason: "Customer requested the governed full early-termination journey"
    });
    const agreementInput = {
      actorId: fixture.actorId,
      closureCaseId: initiated.closureCaseId,
      idempotencyKey: "task-7-full-journey-agreement"
    } as const;
    await earlyClosure.archiveEarlyTerminationAgreement(agreementInput);
    await awaitDatabaseClockPast(prisma, effectiveAt);
    const executionInput = {
      actorId: fixture.actorId,
      closureCaseId: initiated.closureCaseId,
      idempotencyKey: "task-7-full-journey-execute"
    } as const;
    const execution = await earlyClosure.executeEarlyTermination(executionInput);
    if (!("returnManifestRevisionId" in execution)) {
      throw new Error("Expected early-termination execution to create a return manifest");
    }
    await runManagedPrepare(prisma, earlyClosure, fixture);
    early = Object.freeze({ agreementInput, execution, executionInput });
  } else {
    const expiry = createGovernedExpiryService(prisma);
    await expiry.expireSegment(fixture.segmentId, new Date("2026-08-20T16:00:00.000Z"));
    await runManagedPrepare(prisma, createGovernedClosureService(prisma), fixture);
  }
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
  const closureCase = await prisma.subscriptionClosureCase.findFirstOrThrow({
    where: { orderId: fixture.orderId, retiredAt: null }
  });
  await prisma.vehicleReturn.update({
    data: {
      ...checklist,
      checklistSnapshot: checklist,
      returnStatus: "READY",
      updatedBy: fixture.actorId
    },
    where: { orderId: fixture.orderId }
  });
  let signedFileId = "";
  let signedFileHash = "";
  if (!options.skipManifestSuccessors) {
    const produced = await produceReturnManifestSuccessors(prisma, {
      actorId: fixture.actorId,
      closureCaseId: closureCase.id,
      idempotencyKey: "task-7-focused-return-manifest"
    });
    signedFileId = produced.finalized.signedFileId;
    signedFileHash = produced.finalized.signedFileHash;
  }
  const occurredAt = (
    await prisma.subscriptionClosureEvent.findFirstOrThrow({
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      where: { closureCaseId: closureCase.id }
    })
  ).occurredAt;
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
    new VehicleMileageService(prisma, new VehicleMileageRepository()),
    new SubscriptionClosureSettlementResolver()
  );
  const receipt = {
    actorId: fixture.actorId,
    checklist,
    damages: options.early
      ? []
      : [
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
    returnType: options.early ? ("EARLY_TERMINATION" as const) : ("NORMAL_RETURN" as const),
    returnedAt: occurredAt
  };
  await awaitDatabaseClockPast(prisma, occurredAt);
  return {
    accounting,
    closure,
    closureCase,
    early,
    fixture,
    occurredAt,
    operations,
    receipt,
    signedFileHash,
    signedFileId
  };
}

function createReturnManifestESignHarness(prisma: PrismaService) {
  const config = new ConfigService({
    API_BASE_URL: "http://localhost:4000",
    ESIGN_PROVIDER: "mock",
    PORTAL_BASE_URL: "http://localhost:3000"
  });
  const provider = new MockESignProvider(config);
  const objects = new Map<string, Buffer>();
  const storage = {
    async deleteObject(bucket: string, objectKey: string) {
      objects.delete(`${bucket}\0${objectKey}`);
    },
    async getObject(bucket: string, objectKey: string) {
      const buffer = objects.get(`${bucket}\0${objectKey}`);
      if (!buffer) throw new Error("RETURN_MANIFEST_TEST_OBJECT_MISSING");
      return {
        contentLength: buffer.length,
        stream: Readable.from(buffer)
      };
    },
    resolveReturnManifestArtifactIdentity(input: {
      closureCaseId: string;
      objectIdentity: string;
      originalName?: string;
    }) {
      const bucket = "task-7-return-manifest";
      const objectKey =
        `subscription-closure/${input.closureCaseId}/return-manifest/` +
        `${input.objectIdentity}-${input.originalName ?? "artifact"}`;
      return { bucket, objectKey };
    },
    async putReturnManifestArtifact(input: {
      buffer: Buffer;
      closureCaseId: string;
      contentType?: string;
      objectIdentity: string;
      originalName?: string;
    }) {
      const { bucket, objectKey } = this.resolveReturnManifestArtifactIdentity(input);
      objects.set(`${bucket}\0${objectKey}`, Buffer.from(input.buffer));
      return {
        bucket,
        objectKey,
        stored: { driver: "local", key: `${bucket}/${objectKey}` }
      };
    }
  };
  const audit = new AuditService(prisma);
  const service = new ReturnManifestESignService(
    prisma,
    new SubscriptionClosureRepository(),
    audit,
    storage as never,
    config,
    provider
  );
  return { audit, config, objects, provider, service, storage };
}

async function produceReturnManifestSuccessors(
  prisma: PrismaService,
  input: Readonly<{ actorId: string; closureCaseId: string; idempotencyKey: string }>
) {
  const harness = createReturnManifestESignHarness(prisma);
  const started = await harness.service.start(input);
  const task = await prisma.contractESignTask.findUniqueOrThrow({
    where: { id: started.taskId }
  });
  const payload = {
    eventType: "RETURN_MANIFEST_CUSTOMER_SIGNED",
    providerTaskId: task.providerTaskId
  };
  const callback = await new ESignService(
    harness.audit,
    harness.config,
    harness.provider,
    prisma,
    undefined,
    undefined,
    undefined,
    undefined,
    harness.service
  ).handleCallback("mock", payload);
  const finalized = await harness.service.finalize(input);
  return { callback, finalized, harness, started };
}

async function prepareTask7ManifestSuccessorRace(prisma: PrismaService) {
  const scenario = await setupFocusedPhysicalReceipt(prisma, {
    early: true,
    skipManifestSuccessors: true
  });
  if (!scenario.early) throw new Error("Expected early-termination fixture authority");
  const input = {
    actorId: scenario.fixture.actorId,
    closureCaseId: scenario.closureCase.id,
    idempotencyKey: "task-7-production-manifest-race"
  } as const;
  const harness = createReturnManifestESignHarness(prisma);
  const started = await harness.service.start(input);
  const task = await prisma.contractESignTask.findUniqueOrThrow({
    where: { id: started.taskId }
  });
  const finalizationFailure = vi
    .spyOn(harness.service, "finalize")
    .mockRejectedValueOnce(new Error("TASK7_MANIFEST_SUCCESSOR_RACE_BEFORE_FINALIZATION"));
  const callback = new ESignService(
    harness.audit,
    harness.config,
    harness.provider,
    prisma,
    undefined,
    undefined,
    undefined,
    undefined,
    harness.service
  );
  await expect(
    callback.handleCallback("mock", {
      eventType: "RETURN_MANIFEST_CUSTOMER_SIGNED",
      providerTaskId: task.providerTaskId
    })
  ).rejects.toThrow("TASK7_MANIFEST_SUCCESSOR_RACE_BEFORE_FINALIZATION");
  finalizationFailure.mockRestore();
  return { harness, input, scenario };
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
    prisma.subscriptionClosureCase.findFirst({
      where: { orderId: fixture.orderId, retiredAt: null }
    }),
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
        idempotencyKey: true,
        jobStatus: true,
        jobType: true,
        leaseExpiresAt: true,
        leaseToken: true,
        orderId: true,
        payload: true
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
  const jobsById = Object.fromEntries(truth.automationJobs.map((job) => [job.id, job]));
  expect(truth.automationJobs).toHaveLength(3);
  expect(jobsById[fixture.earnedJobId]).toEqual({
    cancelledAt: null,
    completedAt: null,
    id: fixture.earnedJobId,
    idempotencyKey: `expiry-integration:${fixture.earnedJobId}`,
    jobStatus: "PENDING",
    jobType: "GENERATE_MONTHLY_RENT_BILL",
    leaseExpiresAt: null,
    leaseToken: null,
    orderId: fixture.orderId,
    payload: { periodStart: "2026-08-03" }
  });
  expect(jobsById[fixture.futureJobId]).toEqual({
    cancelledAt: decisionAt,
    completedAt: decisionAt,
    id: fixture.futureJobId,
    idempotencyKey: `expiry-integration:${fixture.futureJobId}`,
    jobStatus: "CANCELLED",
    jobType: "GENERATE_MONTHLY_RENT_BILL",
    leaseExpiresAt: null,
    leaseToken: null,
    orderId: fixture.orderId,
    payload: { periodStart: "2026-10-03" }
  });
  const generatedManifest = truth.documentRevisions.find(
    ({ documentType, revisionNumber }) => documentType === "RETURN_MANIFEST" && revisionNumber === 1
  );
  expect(generatedManifest).toBeDefined();
  const returnManifestJob = truth.automationJobs.find(
    ({ jobType }) => jobType === "CLOSURE_RETURN_MANIFEST_ESIGN"
  );
  expect(returnManifestJob).toEqual({
    cancelledAt: null,
    completedAt: null,
    id: expectUuid(),
    idempotencyKey: `closure-return-manifest-esign:${generatedManifest!.id}`,
    jobStatus: "PENDING",
    jobType: "CLOSURE_RETURN_MANIFEST_ESIGN",
    leaseExpiresAt: null,
    leaseToken: null,
    orderId: fixture.orderId,
    payload: {
      actorId: fixture.actorId,
      closureCaseId: generatedManifest!.closureCaseId,
      generatedRevisionId: generatedManifest!.id,
      version: 1
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
      documentType: "RETURN_MANIFEST",
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
        revisionNumber: 1,
        sourceFileHash: document.documentSnapshotHash,
        sourceFileId: document.sourceFileId
      },
      signingStage: "STAGE6_RETURN_MANIFEST",
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

async function readTestDatabaseClock(prisma: PrismaService) {
  const now = (
    await prisma.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`)
  )[0]?.now;
  if (!now) throw new Error("Database clock unavailable");
  return now;
}

async function task7FutureAuthorityWindow(prisma: PrismaService) {
  const now = await readTestDatabaseClock(prisma);
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7));
  return Object.freeze({
    effectiveAt: new Date(now.getTime() + 60_000),
    endDate,
    expiryDecisionAt: new Date(endDate.getTime() + 16 * 60 * 60 * 1_000)
  });
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
  const contractVersionId = randomUUID();
  const quoteId = randomUUID();
  const taskId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "user" ("id", "username", "name", "password_hash", "status", "created_at", "updated_at")
      VALUES (${actorId}::uuid, ${`race-${actorId}`}, 'Race actor', 'not-used', 'ACTIVE', clock_timestamp(), clock_timestamp())
    `);
    await tx.contractVersion.create({
      data: {
        contentTemplate: "Extension agreement",
        effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
        id: contractVersionId,
        status: "ACTIVE",
        templateName: `Race ${contractId}`,
        versionNo: "V1.0"
      }
    });
    await tx.contract.create({
      data: {
        contractNo: `CONRACE${contractId.replaceAll("-", "").slice(0, 18)}`,
        contractSnapshot: {},
        contractTitle: "Extension agreement",
        contractVersionId,
        createdBy: actorId,
        customerId: fixture.customerId,
        id: contractId,
        orderId: fixture.orderId,
        status: "SIGNED",
        updatedBy: actorId
      }
    });
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
      ) VALUES (${considerationId}::uuid, ${`RCNRACE${considerationId.replaceAll("-", "").slice(0, 18)}`}, ${fixture.orderId}::uuid, ${fixture.segmentId}::uuid, 'EXTENSION_IN_PROGRESS', '2026-08-03T00:00:00Z'::timestamptz, clock_timestamp() + interval '1 day', clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_change_order" (
        "id", "change_no", "order_id", "status", "source_segment_id", "renewal_consideration_id",
        "extension_months", "pricing_mode", "contract_id", "target_start_date", "target_end_date",
        "completion_deadline_at", "created_at", "updated_at"
      ) VALUES (${changeId}::uuid, ${`CHGRACE${changeId.replaceAll("-", "").slice(0, 18)}`}, ${fixture.orderId}::uuid, 'SIGNING_OR_PAYMENT', ${fixture.segmentId}::uuid, ${considerationId}::uuid, 6, 'CURRENT_VERSION', ${contractId}::uuid, '2026-08-21'::date, '2027-02-20'::date, clock_timestamp() + interval '1 day', clock_timestamp(), clock_timestamp())
    `);
    await tx.subscriptionExtensionChangeDetail.create({
      data: {
        changeOrderId: changeId,
        extensionMonths: 6,
        pricingMode: "CURRENT_VERSION",
        sourceSegmentId: fixture.segmentId,
        targetEndDate: new Date("2027-02-20T00:00:00.000Z"),
        targetStartDate: new Date("2026-08-21T00:00:00.000Z")
      }
    });
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_change_quote" (
        "id", "quote_no", "change_order_id", "revision", "status", "pricing_mode", "monthly_fee_amount",
        "deposit_amount", "mileage_limit_km", "over_mileage_fee_amount", "plan_snapshot", "price_rule_snapshot",
        "quote_snapshot", "valid_until", "formalized_at", "confirmed_at", "created_at"
      ) VALUES (${quoteId}::uuid, ${`QUORACE${quoteId.replaceAll("-", "").slice(0, 18)}`}, ${changeId}::uuid, 1, 'CUSTOMER_CONFIRMED', 'CURRENT_VERSION', 100, 0, 1500, 100, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, clock_timestamp() + interval '1 day', clock_timestamp(), clock_timestamp(), clock_timestamp())
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
        "document_type", "task_status", "signed_document_object_key", "source_type", "source_id",
        "source_key", "completed_at", "created_at", "updated_at"
      ) VALUES (${taskId}::uuid, ${`ESGRACE${taskId.replaceAll("-", "").slice(0, 18)}`}, ${contractId}::uuid, ${fixture.orderId}::uuid, ${fixture.customerId}::uuid, ${ESignProviderType.MOCK}::esign_provider_type, ${ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION}::esign_signing_stage, ${ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT}::esign_document_type, ${ESignTaskStatus.COMPLETED}::esign_task_status, 'signed/race.pdf', 'SUBSCRIPTION_EXTENSION', ${changeId}::uuid, ${`subscription-change:${changeId}:esign:attempt:1`}, '2026-08-20T15:59:00Z'::timestamptz, clock_timestamp(), clock_timestamp())
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
    await insertRuntimeOrderGraph(tx, {
      customerId,
      label: `expiry-${orderId}`,
      orderId,
      vehicleId
    });
    await tx.vehicle.update({
      data: {
        plateNo: `TEST${vehicleId.replaceAll("-", "").slice(0, 5)}`,
        purchasePriceAmount: 20_000_000n,
        status: VehicleStatus.LEASED
      },
      where: { id: vehicleId }
    });
    await tx.subscriptionOrder.update({
      data: {
        actualDeliveryAt: new Date("2026-03-03T02:00:00.000Z"),
        depositAmount: 0n,
        endDate: new Date("2026-09-02T00:00:00.000Z"),
        finalPlanSnapshot: {},
        mileageLimitKm: 1500,
        monthlyFeeAmount: 100n,
        orderStatus: OrderStatus.ACTIVE,
        overMileageFeeAmount: 100n,
        periodMonths: 6,
        startDate: new Date("2026-03-03T00:00:00.000Z"),
        vehiclePurchasePriceAmount: 20_000_000n
      },
      where: { id: orderId }
    });
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

async function waitForTask6BarrierEntry(
  barrier: ReturnType<typeof createBarrier>,
  inFlight: readonly Promise<unknown>[],
  operation: string
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    barrier.entered.then(() => "ENTERED" as const),
    Promise.race(inFlight.map(observeSettlement)).then(() => "SETTLED" as const),
    new Promise<"TIMED_OUT">((resolve) => {
      timeout = setTimeout(() => resolve("TIMED_OUT"), 5_000);
    })
  ]);
  if (timeout) clearTimeout(timeout);
  if (outcome === "SETTLED") {
    throw new Error(`Expected ${operation} to enter the test barrier before settling`);
  }
  if (outcome === "TIMED_OUT") {
    throw new Error(`Timed out waiting for ${operation} to enter the test barrier`);
  }
}

function hookTransaction(
  prisma: PrismaService,
  model: string,
  method: string,
  barrier: ReturnType<typeof createBarrier>,
  timing: "after" | "before" = "before",
  occurrence = 1
) {
  let invoked = false;
  let invocationCount = 0;
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
                invocationCount += 1;
                const shouldHook = !invoked && invocationCount === occurrence;
                if (shouldHook && timing === "before") {
                  invoked = true;
                  barrier.enter();
                  await barrier.released;
                }
                const result = await delegateValue.apply(delegate, args);
                if (shouldHook && timing === "after") {
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
  // The Launcher drops this suite's exact disposable database after evidence custody.
  // Per-test identifiers are unique, so append-only facts remain intact for assertions.
  void prisma;
  void fixture;
}

async function cleanupExpiryFixture(
  prisma: PrismaService,
  orderId: string,
  segmentId: string,
  customerId: string,
  vehicleId: string
) {
  // The Launcher owns exact-database cleanup after proof custody succeeds.
  void prisma;
  void orderId;
  void segmentId;
  void customerId;
  void vehicleId;
}
