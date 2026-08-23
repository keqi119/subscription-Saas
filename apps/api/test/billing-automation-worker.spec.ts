import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  NotificationEventType,
  NotificationType,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingAutomationHandlers } from "../src/billing-automation/billing-automation.handlers";
import { BillingAutomationRepository } from "../src/billing-automation/billing-automation.repository";
import { BillingAutomationService } from "../src/billing-automation/billing-automation.service";
import {
  BillingAutomationError,
  ClaimedBillingAutomationJob
} from "../src/billing-automation/billing-automation.types";
import { BillingAutomationWorker } from "../src/billing-automation/billing-automation.worker";
import { NotificationService } from "../src/notification/notification.service";
import { PrismaService } from "../src/prisma/prisma.service";

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BillingAutomationWorker", () => {
  it("does not poll when billing automation is disabled", async () => {
    vi.useFakeTimers();
    const harness = createWorkerHarness({
      config: { BILLING_AUTOMATION_WORKER_ENABLED: "false" }
    });

    harness.worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.repository.claimDue).not.toHaveBeenCalled();
    expect(harness.service.reconcileSchedules).not.toHaveBeenCalled();
    await harness.worker.onModuleDestroy();
  });

  it("claims all four billing automation job types", async () => {
    const harness = createWorkerHarness();

    await harness.worker.runOnce();

    expect(harness.repository.claimDue).toHaveBeenCalledWith(1, 120_000, [
      SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
      SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE,
      SubscriptionAutomationJobType.MARK_BILL_OVERDUE,
      SubscriptionAutomationJobType.SEND_BILL_OVERDUE_NOTICE
    ]);
  });

  it("reconciles schedules, enqueues due cycles, and completes a successful job", async () => {
    const job = claimedJob();
    const harness = createWorkerHarness({ jobs: [job] });

    await harness.worker.runOnce();

    expect(harness.service.reconcileSchedules).toHaveBeenCalledWith({
      dryRun: false
    });
    expect(harness.service.enqueueDueSchedules).toHaveBeenCalledTimes(1);
    expect(harness.handlers.handle).toHaveBeenCalledWith(job);
    expect(harness.repository.complete).toHaveBeenCalledWith(job.id, job.leaseToken, {
      action: "COMPLETED"
    });
  });

  it("uses 1m, 5m, 15m, 1h, and 6h retry delays", async () => {
    const expectedDelays = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];

    for (const [attemptCount, delayMs] of expectedDelays.entries()) {
      const job = claimedJob({ attemptCount });
      const harness = createWorkerHarness({
        error: new Error("temporary provider failure"),
        jobs: [job]
      });

      await harness.worker.runOnce();

      expect(harness.repository.reschedule).toHaveBeenCalledWith(job.id, job.leaseToken, {
        delayMs,
        error: {
          code: "BILLING_EXECUTION_ERROR",
          message: "Billing automation operation failed.",
          retryable: true
        }
      });
    }
  });

  it("moves deterministic errors directly to dead letter", async () => {
    const job = claimedJob();
    const error = new BillingAutomationError({
      code: "BILLING_CONFIGURATION_ERROR",
      message: "Billing automation configuration is invalid.",
      retryable: false
    });
    const harness = createWorkerHarness({ error, jobs: [job] });

    await harness.worker.runOnce();

    expect(harness.repository.deadLetter).toHaveBeenCalledWith(job.id, job.leaseToken, {
      code: "BILLING_CONFIGURATION_ERROR",
      message: "Billing automation configuration is invalid.",
      retryable: false
    });
    expect(harness.repository.reschedule).not.toHaveBeenCalled();
  });

  it("reschedules a supported billing notification after a retryable failure", async () => {
    const job = claimedJob({
      jobType: SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE
    });
    const error = new Error("temporary billing notification provider failure");
    const harness = createWorkerHarness({ error, jobs: [job] });

    await harness.worker.runOnce();

    expect(harness.repository.reschedule).toHaveBeenCalledWith(job.id, job.leaseToken, {
      delayMs: 60_000,
      error: {
        code: "BILLING_EXECUTION_ERROR",
        message: "Billing automation operation failed.",
        retryable: true
      }
    });
  });

  it("returns a claimed generation job to pending without consuming an attempt when paused", async () => {
    const job = claimedJob();
    const error = new BillingAutomationError({
      code: "BILLING_SCHEDULE_PAUSED",
      message: "Billing schedule is paused.",
      retryable: true
    });
    const harness = createWorkerHarness({ error, jobs: [job] });

    await harness.worker.runOnce();

    expect(harness.repository.defer).toHaveBeenCalledWith(job.id, job.leaseToken, {
      code: "BILLING_SCHEDULE_PAUSED",
      message: "Billing schedule is paused.",
      retryable: true
    });
    expect(harness.repository.deadLetter).not.toHaveBeenCalled();
    expect(harness.repository.reschedule).not.toHaveBeenCalled();
  });

  it("moves the sixth transient failure to dead letter", async () => {
    const job = claimedJob({ attemptCount: 5 });
    const harness = createWorkerHarness({
      error: new Error("provider unavailable"),
      jobs: [job]
    });

    await harness.worker.runOnce();

    expect(harness.repository.deadLetter).toHaveBeenCalledWith(job.id, job.leaseToken, {
      code: "BILLING_EXECUTION_ERROR",
      message: "Billing automation operation failed.",
      retryable: true
    });
    expect(harness.repository.reschedule).not.toHaveBeenCalled();
  });

  it("does not persist or log raw failure content", async () => {
    const secret = "customer=13800138000 token=secret-482913";
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const harness = createWorkerHarness({
      error: Object.assign(new Error(secret), { code: secret }),
      jobs: [claimedJob()]
    });

    await harness.worker.runOnce();

    const persistedAndLogged = JSON.stringify({
      logs: warn.mock.calls,
      reschedule: harness.repository.reschedule.mock.calls
    });
    expect(persistedAndLogged).not.toContain(secret);
    expect(persistedAndLogged).not.toContain("13800138000");
    expect(persistedAndLogged).not.toContain("482913");
  });

  it("never runs more handlers than configured concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const jobs = Array.from({ length: 5 }, (_, index) =>
      claimedJob({
        id: `00000000-0000-4000-8000-00000000001${index}`
      })
    );
    const harness = createWorkerHarness({
      config: { BILLING_AUTOMATION_WORKER_CONCURRENCY: "2" },
      jobs
    });
    harness.handlers.handle.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { action: "COMPLETED" };
    });

    await harness.worker.runOnce();

    expect(maxActive).toBe(2);
    expect(harness.repository.complete).toHaveBeenCalledTimes(5);
  });
});

describe("BillingAutomationHandlers", () => {
  it("dispatches a due notice through the idempotent notification service", async () => {
    const bill = {
      amount: 12_800n,
      billNo: "BIL-202608-1",
      billStatus: "PENDING",
      customerId: "00000000-0000-4000-8000-000000000006",
      deletedAt: null,
      dueDate: new Date("2026-08-10T00:00:00.000Z"),
      id: "00000000-0000-4000-8000-000000000004",
      remainingAmount: 12_800n
    };
    const service = {
      generateScheduledMonthlyRent: vi.fn(),
      markScheduledBillOverdue: vi.fn()
    };
    const prisma = {
      receivableBill: {
        findUnique: vi.fn().mockResolvedValue(bill)
      }
    };
    const notification = {
      notifyBillLifecycle: vi.fn().mockResolvedValue([{ id: "notification-1" }])
    };
    const handlers = new BillingAutomationHandlers(
      service as unknown as BillingAutomationService,
      prisma as unknown as PrismaService,
      notification as unknown as NotificationService
    );
    const job = claimedJob({
      idempotencyKey: `bill-due-notice:${bill.id}`,
      jobType: SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE
    });

    await handlers.handle(job);

    expect(notification.notifyBillLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        billId: bill.id,
        customerId: bill.customerId,
        eventType: NotificationEventType.BILL_DUE,
        idempotencyKey: job.idempotencyKey,
        notificationType: NotificationType.BILL_DUE,
        url: `/portal/bills/${bill.id}`
      })
    );
  });
});

function createWorkerHarness(
  options: {
    config?: Record<string, string>;
    error?: unknown;
    jobs?: ClaimedBillingAutomationJob[];
  } = {}
) {
  const repository = {
    claimDue: vi.fn().mockResolvedValue(options.jobs ?? []),
    complete: vi.fn().mockResolvedValue(true),
    deadLetter: vi.fn().mockResolvedValue(true),
    defer: vi.fn().mockResolvedValue(true),
    reschedule: vi.fn().mockResolvedValue(true)
  };
  const service = {
    enqueueDueSchedules: vi.fn().mockResolvedValue({
      dueCount: 0,
      enqueuedCount: 0
    }),
    reconcileSchedules: vi.fn().mockResolvedValue({
      createdCount: 0,
      dryRun: false,
      eligibleCount: 0,
      existingCount: 0,
      items: []
    })
  };
  const handlers = {
    handle: vi.fn().mockImplementation(() => {
      if (options.error !== undefined) {
        return Promise.reject(options.error);
      }
      return Promise.resolve({ action: "COMPLETED" });
    }),
    supportedJobTypes: [
      SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
      SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE,
      SubscriptionAutomationJobType.MARK_BILL_OVERDUE,
      SubscriptionAutomationJobType.SEND_BILL_OVERDUE_NOTICE
    ]
  };
  const config = new ConfigService({
    BILLING_AUTOMATION_WORKER_CONCURRENCY: "1",
    BILLING_AUTOMATION_WORKER_ENABLED: "true",
    BILLING_AUTOMATION_WORKER_LEASE_MS: "120000",
    BILLING_AUTOMATION_WORKER_POLL_INTERVAL_MS: "5000",
    ...options.config
  });
  const worker = new BillingAutomationWorker(
    repository as unknown as BillingAutomationRepository,
    service as unknown as BillingAutomationService,
    handlers as unknown as BillingAutomationHandlers,
    config
  );

  return { handlers, repository, service, worker };
}

function claimedJob(
  overrides: Partial<ClaimedBillingAutomationJob> = {}
): ClaimedBillingAutomationJob {
  const now = new Date("2026-07-31T08:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    billId: "00000000-0000-4000-8000-000000000004",
    billingScheduleId: "00000000-0000-4000-8000-000000000003",
    changeOrderId: null,
    contractSegmentId: null,
    cancelledAt: null,
    completedAt: null,
    createdAt: now,
    id: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: "billing-worker-test",
    jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
    jobType: SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date(now.getTime() + 120_000),
    leaseToken: "00000000-0000-4000-8000-000000000002",
    maxAttempts: 6,
    orderId: "00000000-0000-4000-8000-000000000005",
    payload: null,
    renewalConsiderationId: null,
    resultSnapshot: null,
    startedAt: now,
    updatedAt: now,
    ...overrides
  };
}
