import {
  BillStatus,
  CollectionActionResult,
  CollectionActionType,
  CollectionCaseStatus,
  CollectionLevel,
  ContactMethod,
  DebitAttemptStatus,
  DebitRetrySlot,
  PaymentChannel,
  PaymentOrderStatus,
  PaymentProviderType,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { DebitAttemptService } from "../src/auto-debit/debit-attempt.service";
import {
  DebitProviderResult,
  MandateDebitProvider,
  MandateProviderResult
} from "../src/auto-debit/auto-debit-provider";
import { PaymentMandateService } from "../src/auto-debit/payment-mandate.service";
import { ClaimedBillingAutomationJob } from "../src/billing-automation/billing-automation.types";
import { FinanceService } from "../src/finance/finance.service";
import { PrismaService } from "../src/prisma/prisma.service";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://subscription:subscription@127.0.0.1:5432/subscription_saas?schema=public";

describe("auto debit atomic settlement PostgreSQL integration", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(
      new ConfigService({
        DATABASE_POOL_MAX: "5",
        DATABASE_URL: TEST_DATABASE_URL
      })
    );
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("settles one bill once and preserves the later channel receipt as unallocated", async () => {
    const ids = {
      application: randomUUID(),
      attempt: randomUUID(),
      bill: randomUUID(),
      collectionCase: randomUUID(),
      customer: randomUUID(),
      order: randomUUID(),
      mandate: randomUUID(),
      paymentOrderA: randomUUID(),
      paymentOrderB: randomUUID(),
      quote: randomUUID(),
      vehicle: randomUUID()
    };
    const paymentOrderNoA = uniqueNo("PYOA");
    const paymentOrderNoB = uniqueNo("PYOB");
    const finance = new FinanceService(new AuditService(prisma), prisma);

    try {
      await seedSettlementFixture(prisma, ids, paymentOrderNoA, paymentOrderNoB);

      await Promise.all([
        finance.settlePaymentOrder({
          debitAttempt: {
            confirmedAmount: 1n,
            id: ids.attempt,
            providerTransactionId: `txn-${ids.paymentOrderA}`,
            resolvedAt: new Date("2026-08-05T01:00:00.000Z"),
            responseSnapshot: { status: "SUCCEEDED" }
          },
          operatorId: null,
          paidAmount: 1n,
          paidAt: new Date("2026-08-05T01:00:00.000Z"),
          paymentOrderId: ids.paymentOrderA,
          providerTransactionId: `txn-${ids.paymentOrderA}`
        }),
        finance.settlePaymentOrder({
          operatorId: null,
          paidAmount: 1n,
          paidAt: new Date("2026-08-05T01:00:01.000Z"),
          paymentOrderId: ids.paymentOrderB,
          providerTransactionId: `txn-${ids.paymentOrderB}`
        })
      ]);

      const [bill, attempt, paymentOrders, payments, writeOffs, jobs, collectionCase, collectionActions] = await Promise.all([
        prisma.receivableBill.findUniqueOrThrow({ where: { id: ids.bill } }),
        prisma.debitAttempt.findUniqueOrThrow({ where: { id: ids.attempt } }),
        prisma.paymentOrder.findMany({ where: { id: { in: [ids.paymentOrderA, ids.paymentOrderB] } } }),
        prisma.paymentRecord.findMany({ where: { orderId: ids.order } }),
        prisma.paymentWriteOff.findMany({ where: { billId: ids.bill } }),
        prisma.subscriptionAutomationJob.findMany({ where: { billId: ids.bill } }),
        prisma.collectionCase.findUniqueOrThrow({ where: { id: ids.collectionCase } }),
        prisma.collectionAction.findMany({ where: { caseId: ids.collectionCase } })
      ]);
      expect(bill).toMatchObject({
        billStatus: BillStatus.PAID,
        paidAmount: 1n,
        remainingAmount: 0n
      });
      expect(attempt).toMatchObject({
        confirmedAmount: 1n,
        status: DebitAttemptStatus.SUCCEEDED
      });
      expect(paymentOrders).toHaveLength(2);
      expect(paymentOrders.every((item) => item.paymentStatus === PaymentOrderStatus.PAID)).toBe(true);
      expect(payments).toHaveLength(2);
      expect(writeOffs).toHaveLength(1);
      expect(writeOffs[0]?.writeOffAmount).toBe(1n);
      expect(
        payments.reduce((sum, item) => sum + item.paymentAmount, 0n) -
          writeOffs.reduce((sum, item) => sum + item.writeOffAmount, 0n)
      ).toBe(1n);
      expect(
        jobs.every((item) => item.jobStatus === SubscriptionAutomationJobStatus.CANCELLED)
      ).toBe(true);
      expect(collectionCase).toMatchObject({
        caseStatus: CollectionCaseStatus.CLOSED,
        closeReason: "PAYMENT_SETTLED",
        totalOverdueAmount: 0n
      });
      expect(collectionActions).toEqual([
        expect.objectContaining({
          actionResult: CollectionActionResult.SUCCESS,
          actionType: CollectionActionType.CLOSE,
          contactMethod: ContactMethod.SYSTEM
        })
      ]);

      await finance.settlePaymentOrder({
        operatorId: null,
        paidAmount: 1n,
        paidAt: new Date("2026-08-05T01:00:02.000Z"),
        paymentOrderId: ids.paymentOrderA,
        providerTransactionId: `txn-${ids.paymentOrderA}`
      });
      await expect(
        prisma.paymentRecord.count({ where: { orderId: ids.order } })
      ).resolves.toBe(2);
      await expect(
        prisma.paymentWriteOff.count({ where: { billId: ids.bill } })
      ).resolves.toBe(1);
    } finally {
      await cleanupSettlementFixture(prisma, ids);
    }
  }, 15_000);

  it("allows only one payment order to claim the same provider transaction", async () => {
    const ids = {
      application: randomUUID(),
      attempt: randomUUID(),
      bill: randomUUID(),
      collectionCase: randomUUID(),
      customer: randomUUID(),
      order: randomUUID(),
      mandate: randomUUID(),
      paymentOrderA: randomUUID(),
      paymentOrderB: randomUUID(),
      quote: randomUUID(),
      vehicle: randomUUID()
    };
    const finance = new FinanceService(new AuditService(prisma), prisma);
    const providerTransactionId = `shared-txn-${randomUUID()}`;

    try {
      await seedSettlementFixture(
        prisma,
        ids,
        uniqueNo("PYOA"),
        uniqueNo("PYOB")
      );

      const results = await Promise.allSettled(
        [ids.paymentOrderA, ids.paymentOrderB].map((paymentOrderId) =>
          finance.settlePaymentOrder({
            operatorId: null,
            paidAmount: 1n,
            paidAt: new Date("2026-08-05T01:00:00.000Z"),
            paymentOrderId,
            providerTransactionId
          })
        )
      );

      expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
      await expect(
        prisma.paymentOrder.count({ where: { providerTransactionId } })
      ).resolves.toBe(1);
      await expect(
        prisma.paymentRecord.count({ where: { orderId: ids.order } })
      ).resolves.toBe(1);
    } finally {
      await cleanupSettlementFixture(prisma, ids);
    }
  }, 15_000);

  it("creates only one attempt when DUE and D+1 slots race", async () => {
    const ids = settlementIds();
    const finance = new FinanceService(new AuditService(prisma), prisma);
    const provider = processingProvider();
    const service = new DebitAttemptService(prisma, provider, finance);

    try {
      await seedSettlementFixture(
        prisma,
        ids,
        uniqueNo("PYOA"),
        uniqueNo("PYOB")
      );
      await resetFixtureForDebitSubmission(prisma, ids);

      await Promise.all([
        service.submitBillDebit(
          claimedSubmitJob(ids.bill, ids.order, DebitRetrySlot.DUE)
        ),
        service.submitBillDebit(
          claimedSubmitJob(ids.bill, ids.order, DebitRetrySlot.D1)
        )
      ]);

      await expect(
        prisma.debitAttempt.count({ where: { billId: ids.bill } })
      ).resolves.toBe(1);
      await expect(
        prisma.paymentOrder.count({
          where: { debitAttempt: { isNot: null }, orderId: ids.order }
        })
      ).resolves.toBe(1);
    } finally {
      await cleanupSettlementFixture(prisma, ids);
    }
  }, 15_000);

  it("keeps SUCCEEDED and PAID absorbing when a stale submit result arrives", async () => {
    const ids = settlementIds();
    const finance = new FinanceService(new AuditService(prisma), prisma);
    const submitGate = deferred<void>();
    const submitStarted = deferred<void>();
    const provider = processingProvider({ submitGate, submitStarted });
    const service = new DebitAttemptService(prisma, provider, finance);

    try {
      await seedSettlementFixture(
        prisma,
        ids,
        uniqueNo("PYOA"),
        uniqueNo("PYOB")
      );
      await resetFixtureForDebitSubmission(prisma, ids);

      const staleSubmission = service.submitBillDebit(
        claimedSubmitJob(ids.bill, ids.order, DebitRetrySlot.DUE)
      );
      await submitStarted.promise;
      const attempt = await prisma.debitAttempt.findFirstOrThrow({
        where: { billId: ids.bill }
      });

      await service.queryDebitAttempt(
        claimedQueryJob(ids.bill, ids.order, attempt.id)
      );
      submitGate.resolve();
      await staleSubmission;

      await expect(
        prisma.debitAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
      ).resolves.toMatchObject({ status: DebitAttemptStatus.SUCCEEDED });
      await expect(
        prisma.paymentOrder.findUniqueOrThrow({
          where: { id: attempt.paymentOrderId }
        })
      ).resolves.toMatchObject({ paymentStatus: PaymentOrderStatus.PAID });
    } finally {
      submitGate.resolve();
      await cleanupSettlementFixture(prisma, ids);
    }
  }, 15_000);

  it("does not resubmit a missing provider transaction after the mandate is revoked", async () => {
    const ids = settlementIds();
    const finance = new FinanceService(new AuditService(prisma), prisma);
    let submitCount = 0;
    const provider = processingProvider({
      onSubmit: () => {
        submitCount += 1;
      },
      queryDebitNotFound: true
    });
    const service = new DebitAttemptService(prisma, provider, finance);

    try {
      await seedSettlementFixture(
        prisma,
        ids,
        uniqueNo("PYOA"),
        uniqueNo("PYOB")
      );
      await resetFixtureForDebitSubmission(prisma, ids);

      await service.submitBillDebit(
        claimedSubmitJob(ids.bill, ids.order, DebitRetrySlot.DUE)
      );
      const attempt = await prisma.debitAttempt.findFirstOrThrow({
        where: { billId: ids.bill }
      });
      await prisma.paymentMandate.update({
        data: { revokedAt: new Date(), status: "REVOKED" },
        where: { id: ids.mandate }
      });

      await expect(
        service.queryDebitAttempt(
          claimedQueryJob(ids.bill, ids.order, attempt.id)
        )
      ).resolves.toMatchObject({
        action: "RESOLVED",
        status: DebitAttemptStatus.CANCELLED
      });

      expect(submitCount).toBe(1);
      await expect(
        prisma.debitAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
      ).resolves.toMatchObject({ status: DebitAttemptStatus.CANCELLED });
      await expect(
        prisma.paymentOrder.findUniqueOrThrow({
          where: { id: attempt.paymentOrderId }
        })
      ).resolves.toMatchObject({ paymentStatus: PaymentOrderStatus.CANCELLED });
    } finally {
      await cleanupSettlementFixture(prisma, ids);
    }
  }, 15_000);

  it("does not reactivate a mandate when sync finishes after revoke", async () => {
    const ids = settlementIds();
    const queryGate = deferred<void>();
    const queryStarted = deferred<void>();
    const provider = processingProvider({ queryGate, queryStarted });
    const service = new PaymentMandateService(
      prisma,
      provider,
      {
        enabled: true,
        environment: "staging",
        mockEnabled: true,
        provider: "mock",
        runTime: "09:00",
        wechatTemplateId: "mock-template"
      },
      { enqueueFutureForBill: async () => [] } as never,
      new AuditService(prisma)
    );
    const admin = {
      id: randomUUID(),
      menus: [],
      name: "Concurrency reviewer",
      permissions: [],
      roles: ["ADMIN"],
      username: uniqueNo("ADM")
    };

    try {
      await seedSettlementFixture(
        prisma,
        ids,
        uniqueNo("PYOA"),
        uniqueNo("PYOB")
      );

      const staleSync = service.syncAdminMandate(
        ids.mandate,
        { reason: "并发同步" },
        admin,
        {}
      );
      await queryStarted.promise;
      await service.revokeAdminMandate(
        ids.mandate,
        { reason: "客户要求解约" },
        admin,
        {}
      );
      queryGate.resolve();
      await expect(staleSync).resolves.toMatchObject({
        status: "REVOKED"
      });
      await expect(
        prisma.paymentMandate.findUniqueOrThrow({
          where: { id: ids.mandate }
        })
      ).resolves.toMatchObject({ status: "REVOKED" });
    } finally {
      queryGate.resolve();
      await cleanupSettlementFixture(prisma, ids);
    }
  }, 15_000);
});

function settlementIds() {
  return {
    application: randomUUID(),
    attempt: randomUUID(),
    bill: randomUUID(),
    collectionCase: randomUUID(),
    customer: randomUUID(),
    order: randomUUID(),
    mandate: randomUUID(),
    paymentOrderA: randomUUID(),
    paymentOrderB: randomUUID(),
    quote: randomUUID(),
    vehicle: randomUUID()
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function processingProvider(options: {
  onSubmit?: () => void;
  queryDebitNotFound?: boolean;
  queryGate?: ReturnType<typeof deferred<void>>;
  queryStarted?: ReturnType<typeof deferred<void>>;
  submitGate?: ReturnType<typeof deferred<void>>;
  submitStarted?: ReturnType<typeof deferred<void>>;
} = {}): MandateDebitProvider {
  return {
    async createMandate(): Promise<MandateProviderResult> {
      throw new Error("not used");
    },
    async queryDebit(input): Promise<DebitProviderResult> {
      if (options.queryDebitNotFound) {
        return {
          confirmedAmount: 0n,
          errorCode: "PROVIDER_TRANSACTION_NOT_FOUND",
          providerOutTradeNo: input.providerOutTradeNo,
          providerSnapshot: {
            kind: "integration-query",
            status: "FAILED_RETRYABLE"
          },
          providerTransactionId: "",
          status: "FAILED_RETRYABLE"
        };
      }
      return {
        confirmedAmount: 1n,
        providerOutTradeNo: input.providerOutTradeNo,
        providerSnapshot: { kind: "integration-query", status: "SUCCEEDED" },
        providerTransactionId: `txn-${input.providerOutTradeNo}`,
        resolvedAt: new Date("2026-08-05T01:00:00.000Z"),
        status: "SUCCEEDED"
      };
    },
    async queryMandate(input): Promise<MandateProviderResult> {
      options.queryStarted?.resolve();
      await options.queryGate?.promise;
      return {
        effectiveAt: new Date("2026-08-04T00:00:00.000Z"),
        providerMandateId: input.providerMandateId,
        providerSnapshot: { ...input.providerSnapshot, status: "ACTIVE" },
        status: "ACTIVE"
      };
    },
    async revokeMandate(input): Promise<MandateProviderResult> {
      return {
        providerMandateId: input.providerMandateId,
        providerSnapshot: { ...input.providerSnapshot, status: "REVOKED" },
        status: "REVOKED"
      };
    },
    async submitDebit(input): Promise<DebitProviderResult> {
      options.onSubmit?.();
      options.submitStarted?.resolve();
      await options.submitGate?.promise;
      return {
        confirmedAmount: 0n,
        providerOutTradeNo: input.providerOutTradeNo,
        providerSnapshot: { kind: "integration-submit", status: "PROCESSING" },
        providerTransactionId: `txn-${input.providerOutTradeNo}`,
        status: "PROCESSING"
      };
    },
    async verifyCallback() {
      return { payload: {}, verified: false };
    }
  };
}

function claimedSubmitJob(
  billId: string,
  orderId: string,
  retrySlot: DebitRetrySlot
): ClaimedBillingAutomationJob {
  const now = new Date("2026-08-05T00:00:00.000Z");
  return {
    attemptCount: 1,
    availableAt: now,
    billId,
    billingScheduleId: null,
    changeOrderId: null,
    contractSegmentId: null,
    cancelledAt: null,
    completedAt: null,
    createdAt: now,
    id: randomUUID(),
    idempotencyKey: `debit:${billId}:${retrySlot}`,
    jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
    jobType: SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date(now.getTime() + 120_000),
    leaseToken: randomUUID(),
    maxAttempts: 6,
    orderId,
    payload: { billId, retrySlot },
    renewalConsiderationId: null,
    resultSnapshot: null,
    startedAt: now,
    updatedAt: now
  };
}

function claimedQueryJob(
  billId: string,
  orderId: string,
  debitAttemptId: string
): ClaimedBillingAutomationJob {
  return {
    ...claimedSubmitJob(billId, orderId, DebitRetrySlot.DUE),
    idempotencyKey: `debit-query:${debitAttemptId}`,
    jobType: SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT,
    payload: { debitAttemptId }
  };
}

async function seedSettlementFixture(
  prisma: PrismaService,
  ids: {
    application: string;
    attempt: string;
    bill: string;
    collectionCase: string;
    customer: string;
    order: string;
    mandate: string;
    paymentOrderA: string;
    paymentOrderB: string;
    quote: string;
    vehicle: string;
  },
  paymentOrderNoA: string,
  paymentOrderNoB: string
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`
      INSERT INTO "customer" (
        "id", "customer_no", "name", "mobile", "status", "created_at", "updated_at"
      ) VALUES (
        ${ids.customer}::uuid, ${uniqueNo("CUS")}, 'Settlement integration',
        ${`139${ids.customer.replaceAll("-", "").slice(0, 8)}`}, 'ACTIVE',
        clock_timestamp(), clock_timestamp()
      )
    `;
    await tx.$executeRaw`
      INSERT INTO "subscription_order" (
        "id", "order_no", "customer_id", "application_id", "quote_id",
        "vehicle_id", "product_id", "product_version_id",
        "vehicle_purchase_price_amount", "monthly_fee_amount", "deposit_amount",
        "period_months", "mileage_limit_km", "over_mileage_fee_amount",
        "model_definition_id_snapshot", "model_code_snapshot",
        "model_display_name_snapshot", "quote_snapshot", "order_status",
        "created_at", "updated_at"
      ) VALUES (
        ${ids.order}::uuid, ${uniqueNo("ORD")}, ${ids.customer}::uuid,
        ${ids.application}::uuid, ${ids.quote}::uuid, ${ids.vehicle}::uuid,
        ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        20000000, 1, 0, 12, 1500, 100, ${randomUUID()}::uuid,
        'NIO_ET5_2024', 'NIO ET5', '{}'::jsonb, 'ACTIVE',
        clock_timestamp(), clock_timestamp()
      )
    `;
    await tx.receivableBill.create({
      data: {
        amount: 1n,
        billNo: uniqueNo("BIL"),
        billStatus: BillStatus.PENDING,
        billType: "MONTHLY_RENT",
        customerId: ids.customer,
        dueDate: new Date("2026-08-05T00:00:00.000Z"),
        id: ids.bill,
        orderId: ids.order,
        paidAmount: 0n,
        remainingAmount: 1n
      }
    });
    await tx.collectionCase.create({
      data: {
        bills: {
          create: {
            billId: ids.bill,
            customerId: ids.customer,
            orderId: ids.order,
            overdueAmount: 1n,
            overdueDays: 5
          }
        },
        caseNo: uniqueNo("COL"),
        caseStatus: CollectionCaseStatus.ACTIVE,
        collectionLevel: CollectionLevel.D2,
        customerId: ids.customer,
        id: ids.collectionCase,
        latestDueDate: new Date("2026-08-05T00:00:00.000Z"),
        maxOverdueDays: 5,
        orderId: ids.order,
        totalOverdueAmount: 1n
      }
    });
    for (const [id, paymentOrderNo] of [
      [ids.paymentOrderA, paymentOrderNoA],
      [ids.paymentOrderB, paymentOrderNoB]
    ] as const) {
      await tx.paymentOrder.create({
        data: {
          amount: 1n,
          customerId: ids.customer,
          id,
          items: { create: { amount: 1n, billId: ids.bill } },
          orderId: ids.order,
          paidAmount: 0n,
          paymentChannel: PaymentChannel.MOCK,
          paymentOrderNo,
          paymentStatus: PaymentOrderStatus.PENDING,
          provider: PaymentProviderType.MOCK,
          providerTradeNo: `trade-${id}`
        }
      });
    }
    await tx.paymentMandate.create({
      data: {
        customerId: ids.customer,
        id: ids.mandate,
        mandateNo: uniqueNo("MDT"),
        orderId: ids.order,
        provider: PaymentProviderType.MOCK,
        providerMandateId: `mandate-${ids.mandate}`,
        providerMode: "mock",
        responseSnapshot: {
          kind: "mock-mandate",
          providerMandateId: `mandate-${ids.mandate}`,
          status: "ACTIVE"
        },
        status: "ACTIVE"
      }
    });
    await tx.debitAttempt.create({
      data: {
        billId: ids.bill,
        customerId: ids.customer,
        debitAttemptNo: uniqueNo("DBT"),
        id: ids.attempt,
        idempotencyKey: `debit:${ids.bill}:DUE`,
        mandateId: ids.mandate,
        orderId: ids.order,
        paymentOrderId: ids.paymentOrderA,
        providerOutTradeNo: `trade-${ids.paymentOrderA}`,
        requestedAmount: 1n,
        retrySlot: DebitRetrySlot.DUE,
        status: DebitAttemptStatus.UNKNOWN
      }
    });
    for (const [index, jobType] of [
      SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE,
      SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
      SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT
    ].entries()) {
      await tx.subscriptionAutomationJob.create({
        data: {
          billId: ids.bill,
          idempotencyKey: `settlement:${ids.bill}:${index}`,
          jobType,
          orderId: ids.order
        }
      });
    }
  });
}

async function resetFixtureForDebitSubmission(
  prisma: PrismaService,
  ids: {
    attempt: string;
    paymentOrderA: string;
    paymentOrderB: string;
  }
) {
  const paymentOrderIds = [ids.paymentOrderA, ids.paymentOrderB];
  await prisma.debitAttempt.deleteMany({ where: { id: ids.attempt } });
  await prisma.paymentOrderItem.deleteMany({
    where: { paymentOrderId: { in: paymentOrderIds } }
  });
  await prisma.paymentOrder.deleteMany({
    where: { id: { in: paymentOrderIds } }
  });
}

async function cleanupSettlementFixture(
  prisma: PrismaService,
  ids: {
    bill: string;
    collectionCase: string;
    customer: string;
    mandate: string;
    order: string;
    paymentOrderA: string;
    paymentOrderB: string;
  }
) {
  const paymentOrderIds = (
    await prisma.paymentOrder.findMany({
      select: { id: true },
      where: { orderId: ids.order }
    })
  ).map((item) => item.id);
  const payments = await prisma.paymentRecord.findMany({
    select: { id: true },
    where: { orderId: ids.order }
  });
  const collectionActions = await prisma.collectionAction.findMany({
    select: { id: true },
    where: { caseId: ids.collectionCase }
  });
  await prisma.collectionAction.deleteMany({ where: { caseId: ids.collectionCase } });
  await prisma.collectionCaseBill.deleteMany({ where: { caseId: ids.collectionCase } });
  await prisma.collectionCase.deleteMany({ where: { id: ids.collectionCase } });
  const writeOffs = await prisma.paymentWriteOff.findMany({
    select: { id: true },
    where: { paymentId: { in: payments.map((item) => item.id) } }
  });
  await prisma.paymentCallbackLog.deleteMany({ where: { paymentOrderId: { in: paymentOrderIds } } });
  await prisma.debitAttempt.deleteMany({ where: { paymentOrderId: { in: paymentOrderIds } } });
  await prisma.paymentOrderItem.deleteMany({ where: { paymentOrderId: { in: paymentOrderIds } } });
  await prisma.paymentOrder.deleteMany({ where: { id: { in: paymentOrderIds } } });
  await prisma.paymentWriteOff.deleteMany({ where: { paymentId: { in: payments.map((item) => item.id) } } });
  await prisma.paymentRecord.deleteMany({ where: { id: { in: payments.map((item) => item.id) } } });
  await prisma.paymentMandate.deleteMany({ where: { id: ids.mandate } });
  await prisma.subscriptionAutomationJob.deleteMany({ where: { billId: ids.bill } });
  await prisma.receivableBill.deleteMany({ where: { id: ids.bill } });
  await prisma.auditLog.deleteMany({
    where: {
      entityId: {
        in: [
          ...paymentOrderIds,
          ...payments.map((item) => item.id),
          ...writeOffs.map((item) => item.id),
          ...collectionActions.map((item) => item.id),
          ids.bill,
          ids.collectionCase
        ]
      }
    }
  });
  await prisma.subscriptionOrder.deleteMany({ where: { id: ids.order } });
  await prisma.customer.deleteMany({ where: { id: ids.customer } });
}

function uniqueNo(prefix: string) {
  return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}
