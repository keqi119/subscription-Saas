import {
  BillingScheduleStatus,
  BillStatus,
  LeaseStatus,
  OrderStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { BillingAutomationService } from "../src/billing-automation/billing-automation.service";

describe("BillingAutomationService", () => {
  it("creates one active schedule when initialization is repeated", async () => {
    const harness = createHarness();

    const first = await harness.service.ensureActiveSchedule(
      harness.tx as never,
      harness.order.id,
      harness.order.actualDeliveryAt
    );
    const second = await harness.service.ensureActiveSchedule(
      harness.tx as never,
      harness.order.id,
      harness.order.actualDeliveryAt
    );

    expect(second.id).toBe(first.id);
    expect(harness.schedules).toHaveLength(1);
    expect(harness.schedules[0]).toMatchObject({
      nextCycleNo: 1,
      nextGenerateAt: new Date("2026-07-07T00:00:00.000Z"),
      nextPeriodEnd: new Date("2026-08-09T00:00:00.000Z"),
      nextPeriodStart: new Date("2026-07-10T00:00:00.000Z"),
      orderId: harness.order.id,
      status: BillingScheduleStatus.ACTIVE,
      timezone: "Asia/Shanghai"
    });
  });

  it("previews and applies active-lease schedule reconciliation without resuming a pause", async () => {
    const harness = createHarness();

    const preview = await harness.service.reconcileSchedules({
      dryRun: true
    });
    expect(preview).toMatchObject({
      createdCount: 1,
      dryRun: true,
      eligibleCount: 1,
      items: [
        {
          action: "WOULD_CREATE",
          amountSource: "ORDER_MONTHLY_FEE",
          basisBillId: null,
          monthlyRentAmount: 300000,
          nextCycleNo: 1,
          nextGenerateAt: "2026-07-07",
          nextPeriodEnd: "2026-08-09",
          nextPeriodStart: "2026-07-10"
        }
      ]
    });
    expect(harness.schedules).toHaveLength(0);

    const applied = await harness.service.reconcileSchedules({
      dryRun: false
    });
    expect(applied).toMatchObject({
      createdCount: 1,
      dryRun: false,
      eligibleCount: 1
    });
    harness.schedules[0]!.status = BillingScheduleStatus.PAUSED;

    await harness.service.reconcileSchedules({ dryRun: false });

    expect(harness.schedules).toHaveLength(1);
    expect(harness.schedules[0]?.status).toBe(
      BillingScheduleStatus.PAUSED
    );
  });

  it("starts reconciliation after an existing current-period bill", async () => {
    const harness = createHarness();
    const existingBillId = randomUUID();
    harness.bills.push({
      billPeriodEnd: new Date("2026-08-09T00:00:00.000Z"),
      billPeriodStart: new Date("2026-07-10T00:00:00.000Z"),
      billStatus: BillStatus.PENDING,
      billType: "MONTHLY_RENT",
      deletedAt: null,
      id: existingBillId,
      sourceKey: null
    });

    const result = await harness.service.reconcileSchedules({
      dryRun: false
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        action: "CREATED",
        baselineReason: "EXISTING_BILL",
        basisBillId: existingBillId,
        nextCycleNo: 2,
        nextGenerateAt: "2026-08-07",
        nextPeriodEnd: "2026-09-09",
        nextPeriodStart: "2026-08-10"
      })
    ]);
    expect(harness.schedules[0]).toMatchObject({
      nextCycleNo: 2,
      nextGenerateAt: new Date("2026-08-07T00:00:00.000Z"),
      nextPeriodEnd: new Date("2026-09-09T00:00:00.000Z"),
      nextPeriodStart: new Date("2026-08-10T00:00:00.000Z")
    });
  });

  it("baselines an old lease at the current period instead of replaying history", async () => {
    const harness = createHarness();
    harness.order.actualDeliveryAt = new Date(
      "2026-01-10T02:00:00.000Z"
    );

    const result = await harness.service.reconcileSchedules({
      dryRun: false
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        baselineReason: "CURRENT_PERIOD",
        basisBillId: null,
        nextCycleNo: 5,
        nextGenerateAt: "2026-06-07",
        nextPeriodEnd: "2026-07-09",
        nextPeriodStart: "2026-06-10"
      })
    ]);
    expect(harness.schedules[0]).toMatchObject({
      nextCycleNo: 5,
      nextPeriodStart: new Date("2026-06-10T00:00:00.000Z")
    });
  });

  it("enqueues a due schedule once across repeated dispatcher scans", async () => {
    const harness = createHarness();
    await harness.service.ensureActiveSchedule(
      harness.tx as never,
      harness.order.id,
      harness.order.actualDeliveryAt
    );

    const first = await harness.service.enqueueDueSchedules(
      new Date("2026-07-07T00:00:00.000Z")
    );
    const second = await harness.service.enqueueDueSchedules(
      new Date("2026-07-07T00:00:00.000Z")
    );

    expect(first).toMatchObject({ dueCount: 1, enqueuedCount: 1 });
    expect(second).toMatchObject({ dueCount: 1, enqueuedCount: 1 });
    expect([...harness.jobs.values()]).toEqual([
      expect.objectContaining({
        idempotencyKey: `monthly-rent:${harness.order.id}:2026-07-10`,
        jobType:
          SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL
      })
    ]);
  });

  it("creates a bill, advances the schedule, and enqueues follow-up work atomically", async () => {
    const harness = createHarness();
    const schedule = await harness.service.ensureActiveSchedule(
      harness.tx as never,
      harness.order.id,
      harness.order.actualDeliveryAt
    );
    const job = claimedJob({
      billingScheduleId: schedule.id,
      idempotencyKey: `monthly-rent:${harness.order.id}:2026-07-10`,
      orderId: harness.order.id
    });

    const result = await harness.service.generateScheduledMonthlyRent(job);

    expect(result).toMatchObject({
      billId: harness.bills[0]?.id,
      created: true,
      sourceKey: `monthly-rent:${harness.order.id}:2026-07-10`
    });
    expect(harness.schedules[0]).toMatchObject({
      lastGeneratedBillId: harness.bills[0]?.id,
      nextCycleNo: 2,
      nextGenerateAt: new Date("2026-08-07T00:00:00.000Z"),
      nextPeriodEnd: new Date("2026-09-09T00:00:00.000Z"),
      nextPeriodStart: new Date("2026-08-10T00:00:00.000Z"),
      version: 1
    });
    expect([...harness.jobs.values()].map((item) => item.jobType)).toEqual([
      SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE,
      SubscriptionAutomationJobType.MARK_BILL_OVERDUE
    ]);
    expect(harness.audits).toEqual([
      expect.objectContaining({
        entityId: harness.bills[0]?.id,
        entityType: "receivable_bill",
        operatorId: null
      })
    ]);
  });

  it("does not advance the schedule when finance rejects bill generation", async () => {
    const harness = createHarness();
    const schedule = await harness.service.ensureActiveSchedule(
      harness.tx as never,
      harness.order.id,
      harness.order.actualDeliveryAt
    );
    harness.finance.generateMonthlyRentBillForCycle.mockRejectedValueOnce(
      new Error("订单缺少月租金额，无法生成月租账单")
    );

    await expect(
      harness.service.generateScheduledMonthlyRent(
        claimedJob({
          billingScheduleId: schedule.id,
          idempotencyKey: `monthly-rent:${harness.order.id}:2026-07-10`,
          orderId: harness.order.id
        })
      )
    ).rejects.toThrow("Billing automation configuration is invalid.");

    expect(harness.schedules[0]).toMatchObject({
      lastGeneratedBillId: null,
      nextCycleNo: 1,
      version: 0
    });
    expect(harness.jobs.size).toBe(0);
  });

  it("reports a claimed generation job as deferred when its schedule is paused", async () => {
    const harness = createHarness();
    const schedule = await harness.service.ensureActiveSchedule(
      harness.tx as never,
      harness.order.id,
      harness.order.actualDeliveryAt
    );
    harness.schedules[0]!.status = BillingScheduleStatus.PAUSED;

    await expect(
      harness.service.generateScheduledMonthlyRent(
        claimedJob({
          billingScheduleId: schedule.id,
          idempotencyKey: `monthly-rent:${harness.order.id}:2026-07-10`,
          orderId: harness.order.id
        })
      )
    ).rejects.toMatchObject({
      code: "BILLING_SCHEDULE_PAUSED",
      retryable: true
    });
    expect(harness.finance.generateMonthlyRentBillForCycle).not.toHaveBeenCalled();
  });

  it("completes without billing when the current period starts after the contract ends", async () => {
    const harness = createHarness();
    harness.order.endDate = new Date("2026-07-09T00:00:00.000Z");
    const schedule = await harness.service.ensureActiveSchedule(
      harness.tx as never,
      harness.order.id,
      harness.order.actualDeliveryAt
    );

    const result = await harness.service.generateScheduledMonthlyRent(
      claimedJob({
        billingScheduleId: schedule.id,
        idempotencyKey: `monthly-rent:${harness.order.id}:2026-07-10`,
        orderId: harness.order.id
      })
    );

    expect(result).toEqual({
      billId: null,
      completed: true,
      created: false,
      sourceKey: `monthly-rent:${harness.order.id}:2026-07-10`
    });
    expect(harness.finance.generateMonthlyRentBillForCycle).not.toHaveBeenCalled();
    expect(harness.schedules[0]).toMatchObject({
      completedAt: new Date("2026-07-07T00:00:00.000Z"),
      lastGeneratedBillId: null,
      status: BillingScheduleStatus.COMPLETED,
      version: 1
    });
    expect(harness.jobs.size).toBe(0);
  });

  it("enqueues one overdue notification only after an overdue fact is confirmed", async () => {
    const harness = createHarness();
    const billId = randomUUID();
    harness.finance.markBillOverdueForAutomation.mockResolvedValueOnce({
      action: "MARKED_OVERDUE",
      bill: {
        billNo: "BIL-1",
        customerId: harness.order.customerId,
        id: billId
      },
      collectionCase: { id: randomUUID() }
    });

    const result = await harness.service.markScheduledBillOverdue(
      claimedJob({
        billId,
        jobType: SubscriptionAutomationJobType.MARK_BILL_OVERDUE
      })
    );

    expect(result.action).toBe("MARKED_OVERDUE");
    expect([...harness.jobs.values()]).toEqual([
      expect.objectContaining({
        billId,
        idempotencyKey: `bill-overdue-notice:${billId}`,
        jobType:
          SubscriptionAutomationJobType.SEND_BILL_OVERDUE_NOTICE
      })
    ]);
    expect(harness.audits).toEqual([
      expect.objectContaining({
        entityId: billId,
        entityType: "receivable_bill",
        operatorId: null
      })
    ]);
  });

  it("does not enqueue overdue notification work for a settled bill", async () => {
    const harness = createHarness();
    const billId = randomUUID();
    harness.finance.markBillOverdueForAutomation.mockResolvedValueOnce({
      action: "SKIPPED_SETTLED",
      bill: {
        billStatus: BillStatus.PAID,
        id: billId,
        remainingAmount: 0n
      }
    });

    const result = await harness.service.markScheduledBillOverdue(
      claimedJob({
        billId,
        jobType: SubscriptionAutomationJobType.MARK_BILL_OVERDUE
      })
    );

    expect(result.action).toBe("SKIPPED_SETTLED");
    expect(harness.jobs.size).toBe(0);
  });
});

function createHarness() {
  const now = new Date("2026-07-07T00:00:00.000Z");
  const order = {
    actualDeliveryAt: new Date("2026-06-10T02:00:00.000Z"),
    customerId: randomUUID(),
    deletedAt: null,
    endDate: new Date("2027-06-09T00:00:00.000Z"),
    id: randomUUID(),
    lease: {
      deletedAt: null,
      status: LeaseStatus.ACTIVE
    },
    orderNo: "ORD-1",
    orderStatus: OrderStatus.ACTIVE
    ,
    monthlyFeeAmount: 300000n,
    quoteSnapshot: null
  };
  const schedules: Array<Record<string, unknown>> = [];
  const bills: Array<Record<string, unknown>> = [];
  const jobs = new Map<string, Record<string, unknown>>();
  const audits: Array<Record<string, unknown>> = [];
  const tx = {
    auditLog: {
      async create({ data }: { data: Record<string, unknown> }) {
        audits.push(data);
        return data;
      }
    },
    billingSchedule: {
      async findUnique({ where }: { where: { id?: string; orderId?: string } }) {
        const schedule = schedules.find(
          (item) =>
            (where.id && item.id === where.id) ||
            (where.orderId && item.orderId === where.orderId)
        );
        return schedule ? { ...schedule, order } : null;
      },
      async updateMany({
        data,
        where
      }: {
        data: Record<string, unknown>;
        where: { id: string; status: BillingScheduleStatus; version: number };
      }) {
        const schedule = schedules.find(
          (item) =>
            item.id === where.id &&
            item.status === where.status &&
            item.version === where.version
        );
        if (!schedule) {
          return { count: 0 };
        }
        const version = data.version as { increment?: number } | undefined;
        Object.assign(schedule, data, {
          updatedAt: now,
          version:
            Number(schedule.version) + Number(version?.increment ?? 0)
        });
        return { count: 1 };
      },
      async upsert({
        create,
        where
      }: {
        create: Record<string, unknown>;
        where: { orderId: string };
      }) {
        const existing = schedules.find(
          (item) => item.orderId === where.orderId
        );
        if (existing) {
          return existing;
        }
        const created = {
          automationJobs: [],
          cancelledAt: null,
          completedAt: null,
          createdAt: now,
          id: randomUUID(),
          lastGeneratedAt: null,
          lastGeneratedBillId: null,
          pauseReason: null,
          updatedAt: now,
          version: 0,
          ...create
        };
        schedules.push(created);
        return created;
      }
    }
  };
  const prisma = {
    $transaction: (operation: (client: typeof tx) => unknown) =>
      operation(tx),
    billingSchedule: {
      async findMany({
        where
      }: {
        where: {
          nextGenerateAt: { lte: Date };
          status: BillingScheduleStatus;
        };
      }) {
        return schedules.filter(
          (schedule) =>
            schedule.status === where.status &&
            (schedule.nextGenerateAt as Date).getTime() <=
              where.nextGenerateAt.lte.getTime()
        );
      }
    },
    subscriptionOrder: {
      async findMany() {
        return [
          {
            ...order,
            billingSchedule:
              schedules.find(
                (schedule) => schedule.orderId === order.id
              ) ?? null,
            receivableBills: bills
          }
        ];
      }
    }
  };
  const repository = {
    enqueue: vi.fn(
      async (
        _db: unknown,
        input: {
          availableAt?: Date;
          billId?: string;
          billingScheduleId?: string;
          idempotencyKey: string;
          jobType: SubscriptionAutomationJobType;
          orderId?: string;
          payload?: unknown;
        }
      ) => {
        const existing = jobs.get(input.idempotencyKey);
        if (existing) {
          return existing;
        }
        const created = {
          attemptCount: 0,
          availableAt: input.availableAt ?? now,
          id: randomUUID(),
          jobStatus: SubscriptionAutomationJobStatus.PENDING,
          ...input
        };
        jobs.set(input.idempotencyKey, created);
        return created;
      }
    )
  };
  const finance = {
    generateMonthlyRentBillForCycle: vi.fn(
      async (
        _db: unknown,
        input: {
          orderId: string;
          periodEnd: Date;
          periodStart: Date;
          sourceKey: string;
        }
      ) => {
        const existing = bills.find(
          (bill) => bill.sourceKey === input.sourceKey
        );
        if (existing) {
          return { bill: existing, created: false };
        }
        const bill = {
          billNo: "BIL-1",
          billStatus: BillStatus.PENDING,
          customerId: order.customerId,
          id: randomUUID(),
          orderId: input.orderId,
          periodEnd: input.periodEnd,
          periodStart: input.periodStart,
          sourceKey: input.sourceKey
        };
        bills.push(bill);
        return { bill, created: true };
      }
    ),
    markBillOverdueForAutomation: vi.fn()
  };
  const service = new BillingAutomationService(
    prisma as never,
    repository as never,
    finance as never,
    () => now
  );

  return {
    audits,
    bills,
    finance,
    jobs,
    order,
    schedules,
    service,
    tx
  };
}

function claimedJob(
  overrides: Partial<{
    billId: string | null;
    billingScheduleId: string | null;
    idempotencyKey: string;
    jobType: SubscriptionAutomationJobType;
    orderId: string | null;
  }> = {}
) {
  const now = new Date("2026-07-07T00:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    billId: null,
    billingScheduleId: null,
    cancelledAt: null,
    completedAt: null,
    createdAt: now,
    id: randomUUID(),
    idempotencyKey: "job-key",
    jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
    jobType:
      SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date("2026-07-07T00:02:00.000Z"),
    leaseToken: randomUUID(),
    maxAttempts: 6,
    orderId: null,
    payload: null,
    resultSnapshot: null,
    startedAt: now,
    updatedAt: now,
    ...overrides
  };
}
