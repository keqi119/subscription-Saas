import {
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  BillingAutomationRepository,
  cancelPendingBillAutomationJobs
} from "../src/billing-automation/billing-automation.repository";

describe("BillingAutomationRepository", () => {
  it("returns one durable job for repeated enqueue with the same key", async () => {
    const rows = new Map<string, ReturnType<typeof automationJob>>();
    const db = {
      subscriptionAutomationJob: {
        async upsert(input: {
          create: ReturnType<typeof automationJob>;
          where: { idempotencyKey: string };
        }) {
          const existing = rows.get(input.where.idempotencyKey);
          if (existing) {
            return existing;
          }
          const created = {
            ...automationJob(),
            ...input.create
          };
          rows.set(input.where.idempotencyKey, created);
          return created;
        }
      }
    };
    const repository = new BillingAutomationRepository({} as never);
    const input = {
      availableAt: new Date("2026-08-07T00:00:00.000Z"),
      billingScheduleId: randomUUID(),
      idempotencyKey: "monthly-rent:order-1:2026-08-10",
      jobType:
        SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
      orderId: randomUUID()
    };

    const first = await repository.enqueue(db as never, input);
    const second = await repository.enqueue(db as never, input);

    expect(second.id).toBe(first.id);
    expect(rows.size).toBe(1);
  });

  it("does not query for claims with invalid limits or no supported types", async () => {
    const prisma = {
      $transaction: vi.fn()
    };
    const repository = new BillingAutomationRepository(prisma as never);

    await expect(
      repository.claimDue(0, 120_000, [
        SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL
      ])
    ).resolves.toEqual([]);
    await expect(
      repository.claimDue(1, 0, [
        SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL
      ])
    ).resolves.toEqual([]);
    await expect(repository.claimDue(1, 120_000, [])).resolves.toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns only rows carrying a valid database lease", async () => {
    const leased = automationJob({
      jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
      leaseExpiresAt: new Date("2026-08-07T00:02:00.000Z"),
      leaseToken: randomUUID()
    });
    const unleased = automationJob({
      id: randomUUID(),
      leaseExpiresAt: null,
      leaseToken: null
    });
    const transaction = {
      $executeRaw: vi.fn(async () => 2),
      $queryRaw: vi.fn(async () => [{ id: leased.id }, { id: unleased.id }]),
      subscriptionAutomationJob: {
        findMany: vi.fn(async () => [leased, unleased])
      }
    };
    const repository = new BillingAutomationRepository({
      $transaction: (operation: (tx: typeof transaction) => unknown) =>
        operation(transaction)
    } as never);

    const result = await repository.claimDue(2, 120_000, [
      SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL
    ]);

    expect(result).toEqual([leased]);
  });

  it("does not claim generation jobs while their schedule is paused", async () => {
    const transaction = {
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(async (query: unknown) => {
        void query;
        return [];
      }),
      subscriptionAutomationJob: {
        findMany: vi.fn()
      }
    };
    const repository = new BillingAutomationRepository({
      $transaction: (operation: (tx: typeof transaction) => unknown) =>
        operation(transaction)
    } as never);

    await repository.claimDue(1, 120_000, [
      SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL
    ]);

    const query = transaction.$queryRaw.mock.calls[0]?.[0] as {
      strings: string[];
    };
    expect(query.strings.join(" ")).toContain(
      `"subscription_automation_job"."job_type" <>`
    );
    expect(query.strings.join(" ")).toContain(
      `"billing_schedule"."status" = 'ACTIVE'`
    );
  });

  it("cancels only pending bill lifecycle jobs for settled bills", async () => {
    const settledBillId = randomUUID();
    const rows = [
      automationJob({
        billId: settledBillId,
        jobType: SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE
      }),
      automationJob({
        billId: settledBillId,
        id: randomUUID(),
        jobStatus: SubscriptionAutomationJobStatus.COMPLETED,
        jobType: SubscriptionAutomationJobType.MARK_BILL_OVERDUE
      }),
      automationJob({
        billId: randomUUID(),
        id: randomUUID(),
        jobType:
          SubscriptionAutomationJobType.SEND_BILL_OVERDUE_NOTICE
      })
    ];
    const db = updateManyHarness(rows);

    const cancelled = await cancelPendingBillAutomationJobs(
      db as never,
      [settledBillId]
    );

    expect(cancelled).toBe(1);
    expect(rows[0]?.jobStatus).toBe(
      SubscriptionAutomationJobStatus.CANCELLED
    );
    expect(rows[1]?.jobStatus).toBe(
      SubscriptionAutomationJobStatus.COMPLETED
    );
    expect(rows[2]?.jobStatus).toBe(
      SubscriptionAutomationJobStatus.PENDING
    );
  });

  it("retries a dead-letter job in place without changing its key", async () => {
    const row = automationJob({
      attemptCount: 6,
      completedAt: new Date("2026-08-07T00:00:00.000Z"),
      jobStatus: SubscriptionAutomationJobStatus.DEAD_LETTER,
      lastErrorCode: "BILLING_CONFIGURATION_ERROR",
      lastErrorMessage: "Billing automation configuration is invalid."
    });
    const prisma = updateManyHarness([row]);
    const repository = new BillingAutomationRepository(prisma as never);

    const retried = await repository.retryDeadLetter(row.id);

    expect(retried).toBe(true);
    expect(row).toMatchObject({
      attemptCount: 0,
      completedAt: null,
      idempotencyKey: "job-key",
      jobStatus: SubscriptionAutomationJobStatus.PENDING,
      lastErrorCode: null,
      lastErrorMessage: null
    });
  });
});

function automationJob(
  overrides: Partial<{
    attemptCount: number;
    billId: string | null;
    completedAt: Date | null;
    id: string;
    jobStatus: SubscriptionAutomationJobStatus;
    jobType: SubscriptionAutomationJobType;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    leaseExpiresAt: Date | null;
    leaseToken: string | null;
  }> = {}
) {
  const now = new Date("2026-08-07T00:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    billId: null,
    billingScheduleId: randomUUID(),
    cancelledAt: null,
    completedAt: null,
    createdAt: now,
    id: randomUUID(),
    idempotencyKey: "job-key",
    jobStatus: SubscriptionAutomationJobStatus.PENDING,
    jobType:
      SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: null,
    leaseToken: null,
    maxAttempts: 6,
    orderId: randomUUID(),
    payload: null,
    resultSnapshot: null,
    startedAt: null,
    updatedAt: now,
    ...overrides
  };
}

function updateManyHarness(
  rows: Array<ReturnType<typeof automationJob>>
) {
  return {
    subscriptionAutomationJob: {
      async updateMany(input: {
        data: Record<string, unknown>;
        where: {
          billId?: { in: string[] };
          id?: string;
          jobStatus?: SubscriptionAutomationJobStatus;
          jobType?: { in: SubscriptionAutomationJobType[] };
        };
      }) {
        const matching = rows.filter((row) => {
          if (input.where.id && row.id !== input.where.id) {
            return false;
          }
          if (
            input.where.billId &&
            (!row.billId || !input.where.billId.in.includes(row.billId))
          ) {
            return false;
          }
          if (
            input.where.jobStatus &&
            row.jobStatus !== input.where.jobStatus
          ) {
            return false;
          }
          return !(
            input.where.jobType &&
            !input.where.jobType.in.includes(row.jobType)
          );
        });

        for (const row of matching) {
          Object.assign(row, input.data);
        }
        return { count: matching.length };
      }
    }
  };
}
