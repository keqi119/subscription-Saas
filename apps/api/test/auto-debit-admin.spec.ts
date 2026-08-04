import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import {
  BillStatus,
  DebitAttemptStatus,
  DebitRetrySlot,
  PaymentMandateStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { validate } from "class-validator";
import { describe, expect, it, vi } from "vitest";

import { AutoDebitAdminService } from "../src/auto-debit/auto-debit.admin.service";
import { AutoDebitActionReasonDto, SetMockDebitResultDto } from "../src/auto-debit/auto-debit.dto";
import { MockAutoDebitProvider } from "../src/auto-debit/mock-auto-debit.provider";

describe("AutoDebitAdminService", () => {
  it("loads the PaymentOrder to PaymentRecord to WriteOff trace for operators", async () => {
    const harness = createHarness();
    harness.findAttempts.mockResolvedValueOnce([]);

    await harness.service.listAttempts({ page: 1, pageSize: 20 });

    expect(harness.findAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          paymentOrder: expect.objectContaining({
            select: expect.objectContaining({
              paymentRecord: expect.objectContaining({
                select: expect.objectContaining({ writeOffs: expect.any(Object) })
              })
            })
          })
        })
      })
    );
  });

  it("requeues provider query for UNKNOWN attempts and records the operator reason", async () => {
    const harness = createHarness();

    const result = await harness.service.queryAttempt(
      harness.attempt.id,
      { reason: "核实渠道最终状态" },
      testUser(),
      testContext()
    );

    expect(result).toMatchObject({
      action: "QUERY_QUEUED",
      attemptId: harness.attempt.id
    });
    expect(harness.job).toMatchObject({
      jobStatus: SubscriptionAutomationJobStatus.PENDING,
      jobType: SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT
    });
    expect(harness.audits).toContainEqual(
      expect.objectContaining({
        after: expect.objectContaining({ reason: "核实渠道最终状态" }),
        operatorId: testUser().id
      })
    );
  });

  it("does not turn a final failure into a retryable attempt", async () => {
    const harness = createHarness();
    harness.attempt.status = DebitAttemptStatus.FAILED_FINAL;

    await expect(
      harness.service.queryAttempt(
        harness.attempt.id,
        { reason: "错误重试" },
        testUser(),
        testContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.job.jobStatus).toBe(SubscriptionAutomationJobStatus.DEAD_LETTER);
  });

  it("creates one manual debit job only for an unpaid bill with an active mandate", async () => {
    const harness = createHarness();
    harness.attempt.status = DebitAttemptStatus.FAILED_FINAL;
    harness.jobs.push({
      ...harness.job,
      completedAt: null,
      id: "00000000-0000-4000-8000-000000000299",
      idempotencyKey: `debit:${harness.bill.id}:D1`,
      jobStatus: SubscriptionAutomationJobStatus.PENDING,
      jobType: SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
      payload: { billId: harness.bill.id, retrySlot: DebitRetrySlot.D1 }
    });

    const result = await harness.service.requestManualDebit(
      harness.bill.id,
      { reason: "客户确认余额充足，请重新扣款" },
      testUser(),
      testContext()
    );

    expect(result).toMatchObject({
      action: "DEBIT_QUEUED",
      billId: harness.bill.id,
      retrySlot: DebitRetrySlot.MANUAL
    });
    expect(harness.jobs).toContainEqual(
      expect.objectContaining({
        jobType: SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
        payload: expect.objectContaining({
          billId: harness.bill.id,
          retrySlot: DebitRetrySlot.MANUAL
        })
      })
    );
    expect(harness.jobs).toContainEqual(
      expect.objectContaining({
        idempotencyKey: `debit:${harness.bill.id}:D1`,
        jobStatus: SubscriptionAutomationJobStatus.CANCELLED
      })
    );
  });

  it("rejects manual debit while an unresolved attempt exists", async () => {
    const harness = createHarness();

    await expect(
      harness.service.requestManualDebit(
        harness.bill.id,
        { reason: "重复扣款" },
        testUser(),
        testContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.jobs).toHaveLength(1);
  });

  it("persists the next mock result in Staging and forbids it in Production", async () => {
    const harness = createHarness();

    await harness.service.setMockNextResult(
      harness.attempt.id,
      { nextResult: "SUCCEEDED", reason: "验收成功扣款" },
      testUser(),
      testContext()
    );
    expect(harness.attempt.responseSnapshot).toMatchObject({
      nextResult: "SUCCEEDED"
    });

    const production = createHarness({ environment: "production" });
    await expect(
      production.service.setMockNextResult(
        production.attempt.id,
        { nextResult: "SUCCEEDED", reason: "不应允许" },
        testUser(),
        testContext()
      )
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("cancels only a pending automation job and audits the reason", async () => {
    const harness = createHarness();
    harness.job.jobStatus = SubscriptionAutomationJobStatus.PENDING;
    harness.job.completedAt = null;

    await expect(
      harness.service.cancelJob(
        harness.job.id,
        { reason: "订单改为主动支付" },
        testUser(),
        testContext()
      )
    ).resolves.toMatchObject({ jobStatus: SubscriptionAutomationJobStatus.CANCELLED });
    expect(harness.job.jobStatus).toBe(SubscriptionAutomationJobStatus.CANCELLED);
    expect(harness.audits.at(-1)).toMatchObject({
      after: expect.objectContaining({ reason: "订单改为主动支付" })
    });
  });

  it("does not cancel a non-auto-debit billing job", async () => {
    const harness = createHarness();
    harness.job.jobStatus = SubscriptionAutomationJobStatus.PENDING;
    harness.job.jobType = SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL;

    await expect(
      harness.service.cancelJob(
        harness.job.id,
        { reason: "越权取消" },
        testUser(),
        testContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(harness.job.jobStatus).toBe(SubscriptionAutomationJobStatus.PENDING);
  });
});

describe("auto debit admin DTOs", () => {
  it("requires a non-empty operator reason", async () => {
    const dto = Object.assign(new AutoDebitActionReasonDto(), { reason: "   " });
    await expect(validate(dto)).resolves.toHaveLength(1);
  });

  it("rejects PROCESSING as a mock final result", async () => {
    const dto = Object.assign(new SetMockDebitResultDto(), {
      nextResult: "PROCESSING",
      reason: "invalid"
    });
    await expect(validate(dto)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "nextResult" })])
    );
  });
});

function createHarness(options: { environment?: string } = {}) {
  const audits: Array<Record<string, unknown>> = [];
  const bill = {
    billStatus: BillStatus.OVERDUE,
    customerId: "00000000-0000-4000-8000-000000000202",
    deletedAt: null,
    id: "00000000-0000-4000-8000-000000000203",
    orderId: "00000000-0000-4000-8000-000000000204",
    remainingAmount: 100n,
    updatedAt: new Date("2026-08-06T01:00:00.000Z")
  };
  const attempt = {
    billId: bill.id,
    customerId: bill.customerId,
    id: "00000000-0000-4000-8000-000000000201",
    orderId: bill.orderId,
    providerOutTradeNo: "AUTO-DEBIT-ADMIN-1",
    providerTransactionId: "mock-transaction-1",
    responseSnapshot: {
      amount: "100",
      kind: "mock-debit",
      providerOutTradeNo: "AUTO-DEBIT-ADMIN-1",
      providerTransactionId: "mock-transaction-1",
      status: "PROCESSING"
    } as Record<string, unknown>,
    retrySlot: DebitRetrySlot.D3,
    status: DebitAttemptStatus.UNKNOWN as DebitAttemptStatus
  };
  const mandate = {
    id: "00000000-0000-4000-8000-000000000205",
    orderId: bill.orderId,
    status: PaymentMandateStatus.ACTIVE
  };
  const jobs: Array<Record<string, unknown>> = [];
  const job = {
    availableAt: new Date("2026-08-06T01:00:00.000Z"),
    billId: bill.id,
    cancelledAt: null as Date | null,
    completedAt: new Date("2026-08-06T01:01:00.000Z") as Date | null,
    id: "00000000-0000-4000-8000-000000000206",
    idempotencyKey: `debit-query:${attempt.id}`,
    jobStatus: SubscriptionAutomationJobStatus.DEAD_LETTER as SubscriptionAutomationJobStatus,
    jobType: SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT as SubscriptionAutomationJobType,
    orderId: bill.orderId,
    payload: { debitAttemptId: attempt.id }
  };
  jobs.push(job);
  const findAttempts = vi.fn().mockResolvedValue([attempt]);
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: bill.id }]),
    $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(prisma)),
    debitAttempt: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn(async ({ where }) =>
        where.status?.in.includes(attempt.status) ? attempt : null
      ),
      findMany: findAttempts,
      findUnique: vi.fn().mockResolvedValue(attempt),
      update: vi.fn(async ({ data }) => Object.assign(attempt, data))
    },
    paymentMandate: {
      findFirst: vi.fn().mockResolvedValue(mandate)
    },
    receivableBill: {
      findUnique: vi.fn().mockResolvedValue(bill)
    },
    subscriptionAutomationJob: {
      findFirst: vi.fn(
        async ({ where }) =>
          jobs.find(
            (item) =>
              item.idempotencyKey === where.idempotencyKey ||
              (item.billId === where.billId &&
                item.jobType === where.jobType &&
                (where.jobStatus?.in?.includes(item.jobStatus) ||
                  where.jobStatus === item.jobStatus))
          ) ?? null
      ),
      findUnique: vi.fn(async ({ where }) => jobs.find((item) => item.id === where.id) ?? null),
      create: vi.fn(async ({ data }) => {
        const created = {
          ...data,
          id: `00000000-0000-4000-8000-${String(jobs.length + 207).padStart(12, "0")}`,
          jobStatus: SubscriptionAutomationJobStatus.PENDING
        };
        jobs.push(created);
        return created;
      }),
      update: vi.fn(async ({ data, where }) => {
        const current = jobs.find((item) => item.id === where.id);
        if (!current) throw new Error("job missing");
        Object.assign(current, data);
        return current;
      }),
      updateMany: vi.fn(async ({ data, where }) => {
        const matches = jobs.filter((item) => {
          if (where.id && item.id !== where.id) return false;
          if (where.billId && item.billId !== where.billId) return false;
          if (where.jobType?.in && !where.jobType.in.includes(item.jobType)) return false;
          if (where.jobType && typeof where.jobType === "string" && item.jobType !== where.jobType) return false;
          if (where.jobStatus?.in && !where.jobStatus.in.includes(item.jobStatus)) return false;
          if (where.jobStatus && typeof where.jobStatus === "string" && item.jobStatus !== where.jobStatus) return false;
          return true;
        });
        for (const current of matches) Object.assign(current, data);
        return { count: matches.length };
      })
    }
  };
  const service = new AutoDebitAdminService(
    prisma as never,
    new MockAutoDebitProvider(),
    {
      enabled: true,
      environment: options.environment ?? "staging",
      mockEnabled: true,
      provider: "mock",
      runTime: "09:00",
      wechatTemplateId: null
    },
    { write: vi.fn(async (input) => audits.push(input)) } as never
  );
  return { attempt, audits, bill, findAttempts, job, jobs, service };
}

function testUser() {
  return {
    id: "00000000-0000-4000-8000-000000000299",
    menus: [],
    name: "Finance admin",
    permissions: [
      PermissionCode.AUTO_DEBIT_VIEW,
      PermissionCode.AUTO_DEBIT_MANAGE,
      PermissionCode.AUTO_DEBIT_EXECUTE
    ],
    roles: ["FINANCE"],
    username: "finance"
  };
}

function testContext() {
  return { ipAddress: "127.0.0.1", userAgent: "vitest" };
}
