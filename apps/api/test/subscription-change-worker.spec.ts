import { SubscriptionAutomationJobStatus, SubscriptionAutomationJobType } from "@prisma/client";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubscriptionChangeWorker } from "../src/subscription-change/subscription-change.worker";

describe("SubscriptionChangeWorker", () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([undefined, "false", "TRUE", " true"]) (
    "does not start or process work when SUBSCRIPTION_CHANGE_WORKER_ENABLED is %j",
    async (workerEnabled) => {
      vi.useFakeTimers();
      const repository = {
        claimDue: vi.fn(async () => []),
        complete: vi.fn(),
        deadLetter: vi.fn(),
        reschedule: vi.fn()
      };
      const jobs = {
        afterComplete: vi.fn(),
        enqueueDueEnrollmentJobs: vi.fn(async () => 0),
        handle: vi.fn(),
        markManualTakeover: vi.fn(),
        reconcileActiveChanges: vi.fn(async () => 0),
        supportedJobTypes: []
      };
      const worker = new SubscriptionChangeWorker(
        repository as never,
        jobs as never,
        {
          get: vi.fn((key: string) =>
            key === "SUBSCRIPTION_CHANGE_WORKER_ENABLED" ? workerEnabled : "true"
          )
        } as never
      );

      worker.onModuleInit();
      await worker.runOnce();

      expect(vi.getTimerCount()).toBe(0);
      expect(repository.claimDue).not.toHaveBeenCalled();
      expect(jobs.enqueueDueEnrollmentJobs).not.toHaveBeenCalled();
      expect(jobs.reconcileActiveChanges).not.toHaveBeenCalled();
    }
  );

  it("schedules and drains existing work when the worker is enabled but extension enrollment is disabled", async () => {
    vi.useFakeTimers();
    const job = {
      attemptCount: 0,
      id: "job-1",
      jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
      jobType: SubscriptionAutomationJobType.RENEWAL_REMINDER_D30,
      leaseExpiresAt: new Date("2026-08-05T01:02:00.000Z"),
      leaseToken: "lease-1",
      maxAttempts: 6
    };
    const repository = {
      claimDue: vi.fn(async () => [job]),
      complete: vi.fn(async () => true),
      deadLetter: vi.fn(),
      reschedule: vi.fn()
    };
    const jobs = {
      afterComplete: vi.fn(async () => undefined),
      enqueueDueEnrollmentJobs: vi.fn(async () => 0),
      handle: vi.fn(async () => ({ action: "SENT" })),
      markManualTakeover: vi.fn(),
      reconcileActiveChanges: vi.fn(async () => 0),
      supportedJobTypes: []
    };
    const worker = new SubscriptionChangeWorker(
      repository as never,
      jobs as never,
      {
        get: vi.fn((key: string) =>
          key === "SUBSCRIPTION_CHANGE_WORKER_ENABLED"
            ? "true"
            : key === "SUBSCRIPTION_EXTENSION_ENABLED"
              ? "false"
              : undefined
        )
      } as never
    );

    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);

    expect(repository.claimDue).toHaveBeenCalledOnce();
    expect(jobs.enqueueDueEnrollmentJobs).not.toHaveBeenCalled();
    expect(jobs.reconcileActiveChanges).toHaveBeenCalledOnce();
    expect(jobs.handle).toHaveBeenCalledWith(job);
    expect(repository.complete).toHaveBeenCalledWith(job.id, job.leaseToken, { action: "SENT" });
    expect(vi.getTimerCount()).toBe(1);

    await worker.onModuleDestroy();
  });

  it("completes a claimed reminder only once across duplicate polls", async () => {
    const job = {
      attemptCount: 0,
      id: "job-1",
      jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
      jobType: SubscriptionAutomationJobType.RENEWAL_REMINDER_D30,
      leaseExpiresAt: new Date("2026-08-05T01:02:00.000Z"),
      leaseToken: "lease-1",
      maxAttempts: 6
    };
    const repository = {
      claimDue: vi.fn().mockResolvedValueOnce([job]).mockResolvedValueOnce([]),
      complete: vi.fn(async () => true),
      deadLetter: vi.fn(),
      reschedule: vi.fn()
    };
    const jobs = {
      afterComplete: vi.fn(async () => ({ completed: false })),
      enqueueDueEnrollmentJobs: vi.fn(async () => 0),
      handle: vi.fn(async () => ({ action: "SENT" })),
      markManualTakeover: vi.fn(),
      reconcileActiveChanges: vi.fn(async () => 0)
    };
    const worker = new SubscriptionChangeWorker(
      repository as never,
      jobs as never,
      {
        get: vi.fn((key: string) =>
          key === "SUBSCRIPTION_CHANGE_WORKER_ENABLED" ? "true" : "false"
        )
      } as never
    );

    await worker.runOnce();
    await worker.runOnce();

    expect(jobs.handle).toHaveBeenCalledTimes(1);
    expect(repository.complete).toHaveBeenCalledTimes(1);
    expect(jobs.afterComplete).toHaveBeenCalledTimes(1);
    expect(jobs.reconcileActiveChanges).toHaveBeenCalledTimes(1);
  });

  it("moves an exhausted extension continuation job to manual takeover after dead-lettering", async () => {
    const job = {
      attemptCount: 0,
      changeOrderId: "change-1",
      id: "job-extension",
      jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
      jobType: SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME,
      leaseExpiresAt: new Date("2026-09-03T00:02:00.000Z"),
      leaseToken: "lease-extension",
      maxAttempts: 1
    };
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      complete: vi.fn(),
      deadLetter: vi.fn(async () => true),
      reschedule: vi.fn()
    };
    const jobs = {
      afterComplete: vi.fn(),
      enqueueDueEnrollmentJobs: vi.fn(async () => 0),
      handle: vi.fn(async () => {
        throw new Error("billing unavailable");
      }),
      markManualTakeover: vi.fn(async () => ({ updated: true })),
      reconcileActiveChanges: vi.fn(async () => 0)
    };
    const worker = new SubscriptionChangeWorker(
      repository as never,
      jobs as never,
      {
        get: vi.fn((key: string) =>
          key === "SUBSCRIPTION_CHANGE_WORKER_ENABLED" ? "true" : "false"
        )
      } as never
    );

    await worker.runOnce();

    expect(repository.deadLetter).toHaveBeenCalledTimes(1);
    expect(jobs.markManualTakeover).toHaveBeenCalledWith(
      job,
      expect.objectContaining({
        code: "SUBSCRIPTION_CHANGE_JOB_FAILED",
        message: "billing unavailable"
      })
    );
  });

  it("does not dead-letter a completed side effect when completion reconciliation temporarily fails", async () => {
    const job = {
      attemptCount: 0,
      changeOrderId: "change-1",
      id: "job-notice",
      jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
      jobType: SubscriptionAutomationJobType.EXTENSION_EFFECTIVE_NOTICE,
      leaseExpiresAt: new Date("2026-09-03T00:02:00.000Z"),
      leaseToken: "lease-notice",
      maxAttempts: 1
    };
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      complete: vi.fn(async () => true),
      deadLetter: vi.fn(),
      reschedule: vi.fn()
    };
    const jobs = {
      afterComplete: vi.fn(async () => {
        throw new Error("temporary reconciliation failure");
      }),
      enqueueDueEnrollmentJobs: vi.fn(async () => 0),
      handle: vi.fn(async () => ({ sent: true })),
      markManualTakeover: vi.fn(),
      reconcileActiveChanges: vi.fn(async () => 0)
    };
    const worker = new SubscriptionChangeWorker(
      repository as never,
      jobs as never,
      {
        get: vi.fn((key: string) =>
          key === "SUBSCRIPTION_CHANGE_WORKER_ENABLED" ? "true" : "false"
        )
      } as never
    );

    await worker.runOnce();

    expect(repository.complete).toHaveBeenCalledTimes(1);
    expect(repository.deadLetter).not.toHaveBeenCalled();
    expect(repository.reschedule).not.toHaveBeenCalled();
    expect(jobs.markManualTakeover).not.toHaveBeenCalled();
  });
});
