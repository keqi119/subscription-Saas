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

  it("starts while the public extension flag is disabled so existing jobs can drain", async () => {
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
          key === "SUBSCRIPTION_EXTENSION_ENABLED" ? "false" : undefined
        )
      } as never
    );

    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    await worker.onModuleDestroy();

    expect(repository.claimDue).toHaveBeenCalledOnce();
    expect(jobs.enqueueDueEnrollmentJobs).not.toHaveBeenCalled();
    expect(jobs.reconcileActiveChanges).toHaveBeenCalledOnce();
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
      { get: vi.fn(() => "false") } as never
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
      { get: vi.fn(() => "false") } as never
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
      { get: vi.fn(() => "false") } as never
    );

    await worker.runOnce();

    expect(repository.complete).toHaveBeenCalledTimes(1);
    expect(repository.deadLetter).not.toHaveBeenCalled();
    expect(repository.reschedule).not.toHaveBeenCalled();
    expect(jobs.markManualTakeover).not.toHaveBeenCalled();
  });
});
