import { ConfigService } from "@nestjs/config";
import {
  BillType,
  PaymentMethod,
  Prisma,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStatus,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaService } from "../src/prisma/prisma.service";
import { SubscriptionJourneyRepository } from "../src/subscription-journey/subscription-journey.repository";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";
import { SubscriptionJourneyError } from "../src/subscription-journey/subscription-journey.errors";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";
import { insertRuntimeOrderGraph } from "./helpers/runtime-domain-fixture";
import {
  activationServices,
  activationTruth,
  expectActivated,
  prepareActivation
} from "./helpers/stage1-activation-fixture";

const TEST_DATABASE_URL = requiredReleaseDatabaseTestContext(
  "apps/api/test/subscription-journey-failure-recovery.e2e-spec.ts"
).databaseUrl;
const ROLLBACK = new Error("ROLL_BACK_JOURNEY_RECOVERY_FIXTURE");
const BUSINESS_WAIT_RECONCILIATION_MODULE = pathToFileURL(
  resolve(__dirname, "../../../scripts/stage1-journey-business-wait-reconcile.mjs")
).href;
type Tx = Prisma.TransactionClient;

describe("Stage 1 subscription Journey failure recovery", () => {
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

  it("retries every external boundary without duplicating its durable job", async () => {
    await rolledBack(prisma, async (tx) => {
      const fixture = await createFixture(
        tx,
        SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE
      );
      const failures = [
        [SubscriptionJourneyJobType.START_FADADA_SIGNING, "FADADA_START_TIMEOUT"],
        [SubscriptionJourneyJobType.RECONCILE_FADADA_SIGNING, "FADADA_ARCHIVE_STORAGE_TIMEOUT"],
        [SubscriptionJourneyJobType.GENERATE_INITIAL_BILLS, "BILL_GENERATION_TIMEOUT"],
        [SubscriptionJourneyJobType.CREATE_HANDOVER, "HANDOVER_CREATION_TIMEOUT"],
        [SubscriptionJourneyJobType.ACTIVATE_SUBSCRIPTION, "ACTIVATION_PREREQUISITE_PENDING"]
      ] as const;

      for (const [jobType, code] of failures) {
        const sourceKey = `${fixture.prefix}:${jobType}`;
        const job = await repository.enqueueJob(tx, {
          availableAt: new Date("2000-01-01T00:00:00.000Z"),
          jobType,
          journeyId: fixture.journeyId,
          payload: { stepCode: fixture.stepCode },
          sourceKey,
          stepId: fixture.stepId
        });
        await repository.enqueueJob(tx, {
          availableAt: new Date("2000-01-01T00:00:00.000Z"),
          jobType,
          journeyId: fixture.journeyId,
          payload: { stepCode: fixture.stepCode },
          sourceKey,
          stepId: fixture.stepId
        });
        const [claimed] = await repository.claimJobs(tx, 1, 120_000);
        expect(claimed?.id).toBe(job.id);
        const beforeRetry = new Date();
        await repository.rescheduleJob(tx, job.id, claimed!.leaseToken, {
          delayMs: 30_000,
          error: { code, message: "Sanitized retryable boundary failure.", retryable: true }
        });
        const scheduled = await tx.subscriptionJourneyJob.findUniqueOrThrow({
          where: { id: job.id }
        });
        expect(scheduled).toMatchObject({
          attemptCount: 1,
          lastErrorCode: code,
          status: SubscriptionJourneyJobStatus.RETRY_SCHEDULED
        });
        expect(scheduled.availableAt.getTime()).toBeGreaterThanOrEqual(
          beforeRetry.getTime() + 29_000
        );
        expect(await tx.subscriptionJourneyJob.count({ where: { sourceKey } })).toBe(1);

        await tx.subscriptionJourneyJob.update({
          data: { availableAt: new Date("2000-01-01T00:00:00.000Z") },
          where: { id: job.id }
        });
        const [retried] = await repository.claimJobs(tx, 1, 120_000);
        await repository.completeJob(tx, retried!.id, retried!.leaseToken, {
          operation: "RECOVERED"
        });
        await expect(
          tx.subscriptionJourneyJob.findUniqueOrThrow({ where: { id: job.id } })
        ).resolves.toMatchObject({ status: SubscriptionJourneyJobStatus.COMPLETED });
      }
    });
  });

  it("projects a dead letter as a safe exception and supports retry, pause, resume and completion", async () => {
    await rolledBack(prisma, async (tx) => {
      const fixture = await createFixture(
        tx,
        SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE
      );
      const job = await repository.enqueueJob(tx, {
        availableAt: new Date("2000-01-01T00:00:00.000Z"),
        jobType: SubscriptionJourneyJobType.START_FADADA_SIGNING,
        journeyId: fixture.journeyId,
        maxAttempts: 1,
        payload: { stepCode: fixture.stepCode },
        sourceKey: `${fixture.prefix}:dead-letter`,
        stepId: fixture.stepId
      });
      const [claimed] = await repository.claimJobs(tx, 1, 120_000);
      await repository.deadLetterJob(tx, {
        error: {
          code: "FADADA_PROVIDER_REJECTED",
          message: "raw provider stack and tenant details must remain internal",
          retryable: false
        },
        jobId: job.id,
        journeyId: fixture.journeyId,
        leaseToken: claimed!.leaseToken,
        stepId: fixture.stepId
      });

      await expect(
        tx.subscriptionJourney.findUniqueOrThrow({ where: { id: fixture.journeyId } })
      ).resolves.toMatchObject({
        currentStepStatus: SubscriptionJourneyStepStatus.EXCEPTION,
        status: SubscriptionJourneyStatus.EXCEPTION,
        version: 1
      });
      await expect(
        tx.subscriptionJourneyStep.findUniqueOrThrow({ where: { id: fixture.stepId } })
      ).resolves.toMatchObject({
        lastErrorCode: "FADADA_PROVIDER_REJECTED",
        status: SubscriptionJourneyStepStatus.EXCEPTION
      });

      const { audit, service } = recoveryService(tx, repository);
      const projection = await service.getByApplication(fixture.applicationId, fixture.user);
      expect(projection.availableActions).toContain("RETRY");
      expect(projection.exceptions).toEqual([
        expect.objectContaining({ message: "Journey operation failed.", status: "OPEN" })
      ]);
      expect(JSON.stringify(projection)).not.toContain("raw provider stack");

      const retry = await service.retryJourney(
        fixture.journeyId,
        { reason: "provider configuration repaired", version: 1 },
        fixture.user,
        fixture.context
      );
      const paused = await service.pauseJourney(
        fixture.journeyId,
        { reason: "operator verifies recovered facts", version: retry.version },
        fixture.user,
        fixture.context
      );
      const resumed = await service.resumeJourney(
        fixture.journeyId,
        { reason: "facts verified", version: paused.version },
        fixture.user,
        fixture.context
      );
      expect(resumed.status).toBe(SubscriptionJourneyStatus.RETRY_SCHEDULED);
      expect(audit.write).toHaveBeenCalledTimes(3);

      await tx.subscriptionJourneyJob.update({
        data: { availableAt: new Date("2000-01-01T00:00:00.000Z") },
        where: { id: job.id }
      });
      const [retried] = await repository.claimJobs(tx, 1, 120_000);
      await repository.completeJob(tx, retried!.id, retried!.leaseToken, {
        operation: "FADADA_RECOVERED"
      });
      const beforeStepCompletion = await tx.subscriptionJourney.findUniqueOrThrow({
        where: { id: fixture.journeyId }
      });
      await repository.completeStep(tx, {
        eventKey: `${fixture.prefix}:recovered-step-completed`,
        expectedVersion: beforeStepCompletion.version,
        journeyId: fixture.journeyId,
        payload: { stepCode: fixture.stepCode },
        stepId: fixture.stepId
      });
      await expect(
        tx.subscriptionJourney.findUniqueOrThrow({ where: { id: fixture.journeyId } })
      ).resolves.toMatchObject({
        currentStepCode: SubscriptionJourneyStepCode.INITIAL_BILLING,
        status: SubscriptionJourneyStatus.RUNNING
      });
    });
  });

  it("deduplicates payment callbacks and recovers an evidence rejection", async () => {
    await rolledBack(prisma, async (tx) => {
      const payment = await createFixture(tx, SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT);
      const orderId = await createRawOrder(tx, payment);
      await tx.subscriptionJourney.update({
        data: { orderId },
        where: { id: payment.journeyId }
      });
      const bill = await tx.receivableBill.create({
        data: {
          amount: 100_000n,
          billNo: `${payment.prefix}-BILL`,
          billType: BillType.FIRST_MONTHLY_FEE,
          customerId: payment.customerId,
          dueDate: new Date("2026-08-07T00:00:00.000Z"),
          orderId,
          remainingAmount: 100_000n
        }
      });

      await settlePaymentCallbackExactlyOnce(tx, repository, payment, orderId, bill.id);
      await settlePaymentCallbackExactlyOnce(tx, repository, payment, orderId, bill.id);
      expect(await tx.paymentRecord.count({ where: { orderId } })).toBe(1);
      expect(await tx.paymentWriteOff.count({ where: { orderId } })).toBe(1);
      expect(
        await tx.subscriptionJourneyEvent.count({
          where: { eventKey: `${payment.prefix}:wechat-callback` }
        })
      ).toBe(1);

      const evidence = await createFixture(
        tx,
        SubscriptionJourneyStepCode.DELIVERY_EVIDENCE_DECISION,
        SubscriptionJourneyStepStatus.WAITING_MANUAL,
        SubscriptionJourneyStatus.WAITING_MANUAL
      );
      const handover = await tx.subscriptionJourneyStep.create({
        data: {
          code: SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION,
          completedAt: new Date(),
          journeyId: evidence.journeyId,
          status: SubscriptionJourneyStepStatus.COMPLETED
        }
      });
      await repository.returnToHandoverEvidence(tx, {
        decisionStepId: evidence.stepId,
        eventKey: `${evidence.prefix}:evidence-rejected`,
        expectedVersion: 0,
        journeyId: evidence.journeyId,
        payload: { workOrderId: randomUUID() }
      });
      await expect(
        tx.subscriptionJourney.findUniqueOrThrow({ where: { id: evidence.journeyId } })
      ).resolves.toMatchObject({
        currentStepCode: SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION,
        status: SubscriptionJourneyStatus.RUNNING
      });
      await repository.completeStep(tx, {
        eventKey: `${evidence.prefix}:handover-evidence-repaired`,
        expectedVersion: 1,
        journeyId: evidence.journeyId,
        payload: { stepCode: SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION },
        stepId: handover.id
      });
      await expect(
        tx.subscriptionJourney.findUniqueOrThrow({ where: { id: evidence.journeyId } })
      ).resolves.toMatchObject({
        currentStepCode: SubscriptionJourneyStepCode.DELIVERY_EVIDENCE_DECISION,
        currentStepStatus: SubscriptionJourneyStepStatus.PENDING
      });
    });
  });

  it("recovers a historical validation business-wait exception into canonical revalidation", async () => {
    const reconciliation = await import(BUSINESS_WAIT_RECONCILIATION_MODULE);
    await rolledBack(prisma, async (tx) => {
      const fixture = await createFixture(tx, SubscriptionJourneyStepCode.APPLICATION_VALIDATION);
      const job = await repository.enqueueJob(tx, {
        availableAt: new Date("2000-01-01T00:00:00.000Z"),
        jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
        journeyId: fixture.journeyId,
        maxAttempts: 1,
        payload: { stepCode: fixture.stepCode },
        sourceKey: `${fixture.prefix}:legacy-business-wait`,
        stepId: fixture.stepId
      });
      const [claimed] = await repository.claimJobs(tx, 1, 120_000);
      await repository.deadLetterJob(tx, {
        error: {
          code: "JOURNEY_APPLICATION_MATERIALS_INCOMPLETE",
          message: "Legacy material review pending.",
          retryable: false
        },
        jobId: job.id,
        journeyId: fixture.journeyId,
        leaseToken: claimed!.leaseToken,
        stepId: fixture.stepId
      });
      const historical = await tx.subscriptionJourney.findUniqueOrThrow({
        include: {
          application: {
            select: {
              creditReviewStatus: true,
              depositStatus: true,
              finalDepositAmount: true,
              journeyFactVersion: true,
              materialReviewStatus: true,
              status: true
            }
          },
          exceptions: {
            select: { code: true, id: true, status: true },
            where: { status: "OPEN" }
          },
          steps: {
            select: { code: true, id: true, status: true },
            where: { code: SubscriptionJourneyStepCode.APPLICATION_VALIDATION }
          }
        },
        where: { id: fixture.journeyId }
      });
      const planned = reconciliation.toReconciliationRow(historical);

      await expect(
        reconciliation.applyBusinessWaitCandidateInTransaction(tx, planned)
      ).resolves.toEqual({
        action: "REVALIDATE_APPLICATION",
        journeyId: fixture.journeyId
      });
      await expect(
        reconciliation.applyBusinessWaitCandidateInTransaction(tx, planned)
      ).resolves.toEqual({
        action: "SKIPPED",
        journeyId: fixture.journeyId
      });
      await expect(
        tx.subscriptionJourney.findUniqueOrThrow({
          where: { id: fixture.journeyId }
        })
      ).resolves.toMatchObject({
        currentStepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
        currentStepStatus: SubscriptionJourneyStepStatus.PENDING,
        status: SubscriptionJourneyStatus.RUNNING,
        version: 2
      });
      await expect(
        tx.subscriptionJourneyException.findFirstOrThrow({
          where: { journeyId: fixture.journeyId }
        })
      ).resolves.toMatchObject({ status: "RESOLVED" });
      await expect(
        tx.subscriptionJourneyStep.findUniqueOrThrow({
          where: { id: fixture.stepId }
        })
      ).resolves.toMatchObject({ lastErrorCode: null, status: "PENDING" });

      const recoveryOutbox = await tx.subscriptionJourneyOutbox.findUniqueOrThrow({
        where: {
          eventKey:
            `journey:${fixture.journeyId}:reconcile:` + "application-validation:version:1:outbox"
        }
      });
      const service = new SubscriptionJourneyService(repository);
      await service.dispatchSignalOutbox(tx, recoveryOutbox as never);
      expect(
        await tx.subscriptionJourneyJob.count({
          where: {
            jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
            journeyId: fixture.journeyId,
            status: SubscriptionJourneyJobStatus.PENDING
          }
        })
      ).toBe(1);
      expect(
        await tx.auditLog.count({
          where: {
            entityId: fixture.applicationId,
            entityType: "subscription_journey",
            userAgent: "stage1-journey-business-wait-reconcile"
          }
        })
      ).toBe(1);
    });
  });

  it("reclaims an expired worker lease and permits only safe pre-order cancellation", async () => {
    await rolledBack(prisma, async (tx) => {
      const fixture = await createFixture(tx, SubscriptionJourneyStepCode.APPLICATION_VALIDATION);
      const expiredToken = `${fixture.prefix}:expired`;
      const expired = await tx.subscriptionJourneyJob.create({
        data: {
          availableAt: new Date("2000-01-01T00:00:00.000Z"),
          jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
          journeyId: fixture.journeyId,
          leaseExpiresAt: new Date("2000-01-01T00:00:00.000Z"),
          leaseToken: expiredToken,
          sourceKey: `${fixture.prefix}:expired-lease`,
          status: SubscriptionJourneyJobStatus.PROCESSING,
          stepId: fixture.stepId
        }
      });
      const [reclaimed] = await repository.claimJobs(tx, 1, 120_000);
      expect(reclaimed).toMatchObject({ id: expired.id, status: "PROCESSING" });
      expect(reclaimed?.leaseToken).not.toBe(expiredToken);

      const { audit, service } = recoveryService(tx, repository);
      const cancelled = await service.cancelJourney(
        fixture.journeyId,
        { reason: "customer withdrew before contract creation", version: 0 },
        fixture.user,
        fixture.context
      );
      expect(cancelled.status).toBe(SubscriptionJourneyStatus.CANCELLED);
      await expect(
        tx.application.findUniqueOrThrow({ where: { id: fixture.applicationId } })
      ).resolves.toMatchObject({ status: "CANCELLED" });
      await expect(
        tx.subscriptionJourneyJob.findUniqueOrThrow({ where: { id: expired.id } })
      ).resolves.toMatchObject({ status: SubscriptionJourneyJobStatus.CANCELLED });
      expect(audit.write).toHaveBeenCalledOnce();
    });
  });
  it("B4 refuses missing inspection facts without activation residue and permits recovery", async () => {
    const h = await prepareActivation(prisma);
    await prisma.vehicleInspection.update({
      data: { status: "PENDING" },
      where: { orderId: h.orderId }
    });
    const [claimed] = await prisma.$transaction((tx) => h.repository.claimJobs(tx, 1, 120_000));
    expect(claimed?.id).toBe(h.jobId);
    const before = await activationTruth(prisma, h);
    await expect(h.service.activateSubscriptionJob(claimed!)).rejects.toMatchObject({
      response: { canActivate: false, missingConditions: ["INSPECTION_PASSED"] }
    });
    expect(await activationTruth(prisma, h)).toEqual(before);
    await prisma.vehicleInspection.update({
      data: { status: "PASSED" },
      where: { orderId: h.orderId }
    });
    const result = await h.service.activateSubscriptionJob(claimed!);
    expectActivated(await activationTruth(prisma, h));
    await prisma.$transaction((tx) =>
      h.repository.completeJob(tx, h.jobId, claimed!.leaseToken, result)
    );
  });

  it.each(["subscriptionContractSegment", "vehicleSubscriptionPeriod"] as const)(
    "B4 rolls back every real activation fact after the %s write and retries once",
    async (model) => {
      const h = await prepareActivation(prisma);
      const [claimed] = await prisma.$transaction((tx) => h.repository.claimJobs(tx, 1, 120_000));
      expect(claimed?.id).toBe(h.jobId);
      const before = await activationTruth(prisma, h);
      const failure = new Error(`B4_AFTER_${model}_WRITE`);
      let reached = false;
      const failingPrisma = new Proxy(prisma, {
        get(target, property, receiver) {
          if (property === "$transaction") {
            return (work: (tx: Tx) => Promise<unknown>, options?: { timeout?: number }) =>
              prisma.$transaction(
                (tx) =>
                  work(
                    new Proxy(tx, {
                      get(transaction, delegateName) {
                        const delegate = Reflect.get(transaction, delegateName);
                        if (delegateName !== model) return delegate;
                        return new Proxy(delegate, {
                          get(realDelegate, method) {
                            const value = Reflect.get(realDelegate, method);
                            if (method !== "create")
                              return typeof value === "function" ? value.bind(realDelegate) : value;
                            return async (args: unknown) => {
                              const row = await value.call(realDelegate, args);
                              expect(
                                await realDelegate.findUnique({ where: { id: row.id } })
                              ).not.toBeNull();
                              reached = true;
                              throw failure;
                            };
                          }
                        });
                      }
                    })
                  ),
                options
              );
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as PrismaService;
      await expect(
        activationServices(failingPrisma).service.activateSubscriptionJob(claimed!)
      ).rejects.toBe(failure);
      expect(reached).toBe(true);
      expect(await activationTruth(prisma, h)).toEqual(before);
      const result = await h.service.activateSubscriptionJob(claimed!);
      expectActivated(await activationTruth(prisma, h));
      await prisma.$transaction((tx) =>
        h.repository.completeJob(tx, h.jobId, claimed!.leaseToken, result)
      );
    }
  );

  it("B4 recovers an ACK transaction failure after real activation has committed without repeating business writes", async () => {
    const h = await prepareActivation(prisma);
    const complete = h.repository.completeJob.bind(h.repository);
    let reached = false;
    const ack = vi
      .spyOn(h.repository, "completeJob")
      .mockImplementationOnce(async (tx, id, token, result) => {
        expect(id).toBe(h.jobId);
        await complete(tx, id, token, result);
        expect(await tx.subscriptionJourneyJob.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: "COMPLETED"
        });
        reached = true;
        throw new SubscriptionJourneyError({
          code: "JOURNEY_EXECUTION_ERROR",
          message: "B4 controlled ACK rollback",
          retryable: true,
          retryAfterMs: 0
        });
      });
    try {
      await h.worker.runOnce();
      expect(reached).toBe(true);
      const activated = await activationTruth(prisma, h);
      expectActivated(activated);
      expect(
        await prisma.subscriptionJourneyJob.findUniqueOrThrow({ where: { id: h.jobId } })
      ).toMatchObject({
        attemptCount: 1,
        completedAt: null,
        leaseExpiresAt: null,
        leaseToken: null,
        status: "RETRY_SCHEDULED"
      });
      const due = await prisma.$queryRaw<Array<{ due: boolean }>>(Prisma.sql`
        SELECT "available_at" <= clock_timestamp() AS "due" FROM "subscription_journey_job" WHERE "id" = ${h.jobId}
      `);
      expect(due).toEqual([{ due: true }]);
      await h.worker.runOnce();
      expect(
        await prisma.subscriptionJourneyJob.findUniqueOrThrow({ where: { id: h.jobId } })
      ).toMatchObject({
        attemptCount: 1,
        status: "COMPLETED",
        completedAt: expect.any(Date),
        leaseToken: null
      });
      expect(ack).toHaveBeenLastCalledWith(expect.anything(), h.jobId, expect.any(String), {
        action: "SUBSCRIPTION_ALREADY_ACTIVATED", orderId: h.orderId
      });
      expect(await activationTruth(prisma, h)).toEqual(activated);
    } finally {
      ack.mockRestore();
    }
  });
});

async function createFixture(
  tx: Tx,
  stepCode: SubscriptionJourneyStepCode,
  stepStatus: SubscriptionJourneyStepStatus = SubscriptionJourneyStepStatus.RUNNING,
  journeyStatus: SubscriptionJourneyStatus = SubscriptionJourneyStatus.RUNNING
) {
  const prefix = `recovery_${randomUUID().replaceAll("-", "")}`;
  const userId = randomUUID();
  const customerId = randomUUID();
  const applicationId = randomUUID();
  await tx.user.create({
    data: {
      id: userId,
      name: "Recovery Operator",
      passwordHash: "test-only-not-a-credential",
      username: `${prefix}_operator`
    }
  });
  await tx.customer.create({
    data: {
      customerNo: `${prefix}-C`,
      id: customerId,
      mobile: "13800000000",
      name: "Recovery Customer"
    }
  });
  await tx.application.create({
    data: { applicationNo: `${prefix}-A`, customerId, id: applicationId, salesUserId: userId }
  });
  const journey = await tx.subscriptionJourney.create({
    data: {
      applicationId,
      currentStepCode: stepCode,
      currentStepStatus: stepStatus,
      status: journeyStatus
    }
  });
  const step = await tx.subscriptionJourneyStep.create({
    data: { code: stepCode, journeyId: journey.id, status: stepStatus }
  });
  return {
    applicationId,
    context: { ipAddress: "127.0.0.1", userAgent: "vitest" },
    customerId,
    journeyId: journey.id,
    prefix,
    stepCode,
    stepId: step.id,
    user: {
      id: userId,
      menus: [],
      name: "Recovery Operator",
      permissions: ["subscription_journey:view", "subscription_journey:recover"],
      roles: ["ADMIN"],
      username: `${prefix}_operator`
    },
    userId
  };
}

function recoveryService(tx: Tx, repository: SubscriptionJourneyRepository) {
  const audit = { write: vi.fn(async () => undefined) };
  const transactionalPrisma = {
    $transaction: async (callback: (client: Tx) => unknown) => callback(tx),
    subscriptionJourney: tx.subscriptionJourney
  } as unknown as PrismaService;
  return {
    audit,
    service: new SubscriptionJourneyService(
      repository,
      transactionalPrisma,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      audit as never
    )
  };
}

async function createRawOrder(tx: Tx, fixture: Awaited<ReturnType<typeof createFixture>>) {
  const orderId = randomUUID();
  await insertRuntimeOrderGraph(tx, {
    applicationId: fixture.applicationId,
    customerId: fixture.customerId,
    label: fixture.prefix,
    orderId,
    salesUserId: fixture.userId
  });
  return orderId;
}

async function settlePaymentCallbackExactlyOnce(
  tx: Tx,
  repository: SubscriptionJourneyRepository,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  orderId: string,
  billId: string
) {
  let payment = await tx.paymentRecord.findUnique({
    where: { paymentNo: `${fixture.prefix}-PAYMENT` }
  });
  if (!payment) {
    payment = await tx.paymentRecord.create({
      data: {
        customerId: fixture.customerId,
        orderId,
        paymentAmount: 100_000n,
        paymentMethod: PaymentMethod.WECHAT,
        paymentNo: `${fixture.prefix}-PAYMENT`,
        receivedAt: new Date("2026-08-06T00:00:00.000Z")
      }
    });
    await tx.paymentWriteOff.create({
      data: {
        billId,
        customerId: fixture.customerId,
        orderId,
        paymentId: payment.id,
        writeOffAmount: 100_000n
      }
    });
  }
  await repository.recordSignal(tx, {
    eventKey: `${fixture.prefix}:wechat-callback`,
    orderId,
    payload: { orderId },
    type: "PAYMENT_SETTLED"
  });
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
  return result;
}
