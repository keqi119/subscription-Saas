import {
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionChangeError } from "../src/subscription-change/subscription-change.errors";
import { SubscriptionChangeJobService } from "../src/subscription-change/subscription-change-job.service";

describe("subscription-change job routing", () => {
  it("routes extension, vehicle-swap and early-termination reconciliation to dedicated executors", async () => {
    const prisma = {
      subscriptionChangeOrder: {
        findMany: vi.fn(async () => [
          {
            changeType: SubscriptionChangeType.EXTENSION,
            id: "extension-1",
            status: SubscriptionChangeStatus.EXECUTING
          },
          {
            changeType: SubscriptionChangeType.VEHICLE_SWAP,
            id: "swap-scheduled",
            status: SubscriptionChangeStatus.SCHEDULED
          },
          {
            changeType: SubscriptionChangeType.VEHICLE_SWAP,
            id: "swap-executing",
            status: SubscriptionChangeStatus.EXECUTING
          },
          {
            changeType: SubscriptionChangeType.EARLY_TERMINATION,
            id: "early-scheduled",
            status: SubscriptionChangeStatus.SCHEDULED
          },
          {
            changeType: SubscriptionChangeType.EARLY_TERMINATION,
            id: "early-executing",
            status: SubscriptionChangeStatus.EXECUTING
          }
        ])
      }
    };
    const extension = {
      completeIfReady: vi.fn(async () => ({ completed: true })),
      markManualTakeover: vi.fn()
    };
    const swaps = {
      markManualTakeover: vi.fn(),
      progress: vi
        .fn()
        .mockResolvedValueOnce({ outcome: "EXECUTING" })
        .mockResolvedValueOnce({ outcome: "COMPLETED" })
    };
    const earlyTermination = {
      markManualTakeover: vi.fn(),
      progress: vi.fn(async () => ({ outcome: "EXECUTING" })),
      reconcile: vi.fn(async () => ({ outcome: "COMPLETED" }))
    };
    const jobs = new SubscriptionChangeJobService(
      prisma as never,
      {} as never,
      {} as never,
      extension as never,
      {} as never,
      {} as never,
      undefined,
      swaps as never,
      earlyTermination as never
    );

    await expect(jobs.reconcileActiveChanges()).resolves.toBe(3);

    expect(extension.completeIfReady).toHaveBeenCalledOnce();
    expect(extension.completeIfReady).toHaveBeenCalledWith("extension-1");
    expect(swaps.progress).toHaveBeenCalledTimes(2);
    expect(swaps.progress).toHaveBeenNthCalledWith(1, "swap-scheduled");
    expect(swaps.progress).toHaveBeenNthCalledWith(2, "swap-executing");
    expect(earlyTermination.progress).toHaveBeenCalledWith("early-scheduled");
    expect(earlyTermination.reconcile).toHaveBeenCalledWith("early-executing");
  });

  it("moves an unreconcilable early termination to governed manual takeover", async () => {
    const prisma = {
      subscriptionChangeOrder: {
        findMany: vi.fn(async () => [
          {
            changeType: SubscriptionChangeType.EARLY_TERMINATION,
            id: "early-broken",
            status: SubscriptionChangeStatus.EXECUTING
          }
        ])
      }
    };
    const earlyTermination = {
      markManualTakeover: vi.fn(async () => ({ updated: true })),
      reconcile: vi.fn(async () => {
        throw new SubscriptionChangeError(
          "EARLY_TERMINATION_CLOSURE_FACT_MISSING",
          "The Closure case is missing.",
          409
        );
      })
    };
    const jobs = new SubscriptionChangeJobService(
      prisma as never,
      {} as never,
      {} as never,
      { completeIfReady: vi.fn() } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      earlyTermination as never
    );

    await expect(jobs.reconcileActiveChanges()).resolves.toBe(0);

    expect(earlyTermination.markManualTakeover).toHaveBeenCalledWith("early-broken", {
      code: "EARLY_TERMINATION_CLOSURE_FACT_MISSING",
      message: "The Closure case is missing."
    });
  });

  it("does not send a non-extension job completion through extension completion", async () => {
    const extension = {
      completeIfReady: vi.fn(async () => ({ completed: false })),
      markManualTakeover: vi.fn()
    };
    const swaps = { markManualTakeover: vi.fn(), progress: vi.fn() };
    const jobs = new SubscriptionChangeJobService(
      {} as never,
      {} as never,
      {} as never,
      extension as never,
      {} as never,
      {} as never,
      undefined,
      swaps as never
    );

    await expect(
      jobs.afterComplete({
        attemptCount: 0,
        changeOrderId: "change-1",
        id: "job-1",
        jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
        jobType: SubscriptionAutomationJobType.RENEWAL_REMINDER_D30,
        leaseExpiresAt: new Date(),
        leaseToken: "lease-1",
        maxAttempts: 6
      } as never)
    ).resolves.toEqual({ completed: false });
    expect(extension.completeIfReady).not.toHaveBeenCalled();
  });
});
