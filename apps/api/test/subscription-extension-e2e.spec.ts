import { Logger } from "@nestjs/common";
import {
  ContractSegmentStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SubscriptionChangeJobService } from "../src/subscription-change/subscription-change-job.service";
import { SubscriptionChangeWorker } from "../src/subscription-change/subscription-change.worker";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("subscription extension release orchestration", () => {
  it("runs an archived renewal through activation, billing, entitlement, notice and completion", async () => {
    const activation = {
      activate: vi.fn(async () => ({
        changeStatus: "EXECUTING",
        segmentStatus: ContractSegmentStatus.ACTIVE
      })),
      completeIfReady: vi.fn(async () => ({ completed: true })),
      renewEntitlements: vi.fn(async () => ({ renewed: true })),
      resumeBilling: vi.fn(async () => ({ resumed: true })),
      sendEffectiveNotice: vi.fn(async () => ({ sent: true }))
    };
    const service = jobService({ activation });
    const base = {
      attemptCount: 0,
      changeOrderId: "change-1",
      contractSegmentId: "segment-extension",
      id: "job-1",
      idempotencyKey: "extension:job-1",
      jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
      leaseToken: "lease-1",
      maxAttempts: 6
    };

    await service.handle({
      ...base,
      jobType: SubscriptionAutomationJobType.EXTENSION_SEGMENT_ACTIVATE
    } as never);
    await service.handle({
      ...base,
      jobType: SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME
    } as never);
    await service.handle({
      ...base,
      jobType: SubscriptionAutomationJobType.EXTENSION_ENTITLEMENT_RENEW,
      payload: { periodStart: "2026-09-03" }
    } as never);
    await service.handle({
      ...base,
      jobType: SubscriptionAutomationJobType.EXTENSION_EFFECTIVE_NOTICE
    } as never);
    await service.afterComplete(base as never);

    expect(activation.activate).toHaveBeenCalledWith("segment-extension");
    expect(activation.resumeBilling).toHaveBeenCalledWith("segment-extension");
    expect(activation.renewEntitlements).toHaveBeenCalledWith(
      "segment-extension",
      new Date("2026-09-03T00:00:00.000Z"),
      undefined
    );
    expect(activation.sendEffectiveNotice).toHaveBeenCalledWith(
      "segment-extension",
      "extension:job-1"
    );
    expect(activation.completeIfReady).toHaveBeenCalledWith("change-1");
  });

  it("routes an unsigned deadline through expiry and the D+1 return-due check", async () => {
    const expiry = {
      expireSegment: vi.fn(async () => ({ outcome: "EXPIRED", returnId: "return-1" })),
      flagOverdueReturn: vi.fn(async () => ({ created: true }))
    };
    const service = jobService({ expiry });

    await expect(
      service.handle({
        contractSegmentId: "segment-base",
        jobType: SubscriptionAutomationJobType.RENEWAL_EXPIRY_PROCESS
      } as never)
    ).resolves.toEqual({ outcome: "EXPIRED", returnId: "return-1" });
    await expect(
      service.handle({
        jobType: SubscriptionAutomationJobType.RENEWAL_RETURN_OVERDUE_D1,
        orderId: "order-1"
      } as never)
    ).resolves.toEqual({ created: true });

    expect(expiry.expireSegment).toHaveBeenCalledWith("segment-base");
    expect(expiry.flagOverdueReturn).toHaveBeenCalledWith("order-1");
  });

  it("recovers the same leased job after a worker restart", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const firstLease = workerJob({ attemptCount: 0, leaseToken: "lease-first" });
    const recoveredLease = workerJob({ attemptCount: 1, leaseToken: "lease-recovered" });
    const repository = {
      claimDue: vi.fn().mockResolvedValueOnce([firstLease]).mockResolvedValueOnce([recoveredLease]),
      complete: vi.fn(async () => true),
      deadLetter: vi.fn(),
      reschedule: vi.fn(async () => true)
    };
    const jobs = {
      afterComplete: vi.fn(async () => ({ completed: false })),
      enqueueDueEnrollmentJobs: vi.fn(async () => 0),
      handle: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary database disconnect"))
        .mockResolvedValueOnce({ action: "SENT" }),
      markManualTakeover: vi.fn(),
      reconcileExecutingChanges: vi.fn(async () => 0),
      supportedJobTypes: [SubscriptionAutomationJobType.RENEWAL_REMINDER_D30]
    };

    const firstWorker = new SubscriptionChangeWorker(
      repository as never,
      jobs as never,
      { get: vi.fn(() => "false") } as never
    );
    await firstWorker.runOnce();
    const restartedWorker = new SubscriptionChangeWorker(
      repository as never,
      jobs as never,
      { get: vi.fn(() => "false") } as never
    );
    await restartedWorker.runOnce();

    expect(repository.reschedule).toHaveBeenCalledWith(
      firstLease.id,
      "lease-first",
      expect.objectContaining({ error: expect.objectContaining({ retryable: true }) })
    );
    expect(repository.complete).toHaveBeenCalledWith(recoveredLease.id, "lease-recovered", {
      action: "SENT"
    });
    expect(repository.deadLetter).not.toHaveBeenCalled();
  });
});

function jobService({
  activation = {},
  expiry = {}
}: {
  activation?: Record<string, unknown>;
  expiry?: Record<string, unknown>;
}) {
  return new SubscriptionChangeJobService(
    { subscriptionChangeOrder: { findMany: vi.fn(async () => []) } } as never,
    {} as never,
    {} as never,
    activation as never,
    expiry as never
  );
}

function workerJob(overrides: Record<string, unknown>) {
  return {
    attemptCount: 0,
    id: "job-reminder",
    jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
    jobType: SubscriptionAutomationJobType.RENEWAL_REMINDER_D30,
    leaseExpiresAt: new Date("2026-08-29T04:02:00.000Z"),
    leaseToken: "lease",
    maxAttempts: 6,
    ...overrides
  };
}
