import {
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionChangeWorker } from "../src/subscription-change/subscription-change.worker";

describe("SubscriptionChangeWorker", () => {
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
      enqueueDueEnrollmentJobs: vi.fn(async () => 0),
      handle: vi.fn(async () => ({ action: "SENT" }))
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
  });
});
