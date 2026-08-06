import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  SubscriptionJourneyEventType,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyOutboxStatus,
  SubscriptionJourneyStepCode
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaService } from "../src/prisma/prisma.service";
import { SubscriptionJourneyRuntimeConfig } from "../src/subscription-journey/subscription-journey.config";
import { journeyError } from "../src/subscription-journey/subscription-journey.errors";
import { SubscriptionJourneyHandlers } from "../src/subscription-journey/subscription-journey.handlers";
import { SubscriptionJourneyRepository } from "../src/subscription-journey/subscription-journey.repository";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";
import type {
  ClaimedJourneyJob,
  ClaimedJourneyOutbox
} from "../src/subscription-journey/subscription-journey.types";
import {
  baseRetryDelayMs,
  capRetryAfterMs,
  fadadaReconcileDelayMs,
  jitteredRetryDelayMs,
  SubscriptionJourneyWorker
} from "../src/subscription-journey/subscription-journey.worker";

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("subscription journey retry policy", () => {
  it("uses the fixed four-delay default schedule", () => {
    expect(baseRetryDelayMs(1)).toBe(30_000);
    expect(baseRetryDelayMs(2)).toBe(120_000);
    expect(baseRetryDelayMs(3)).toBe(600_000);
    expect(baseRetryDelayMs(4)).toBe(1_800_000);
    expect(baseRetryDelayMs(20)).toBe(1_800_000);
  });

  it("adds at most twenty percent deterministic jitter", () => {
    expect(jitteredRetryDelayMs(30_000, 0)).toBe(30_000);
    expect(jitteredRetryDelayMs(30_000, 0.5)).toBe(33_000);
    expect(jitteredRetryDelayMs(30_000, 1)).toBe(36_000);
  });

  it("caps provider retry-after at two hours", () => {
    expect(capRetryAfterMs(9_000_000)).toBe(7_200_000);
    expect(capRetryAfterMs(60_000)).toBe(60_000);
  });

  it("uses the explicit Fadada reconciliation observation schedule", () => {
    expect(fadadaReconcileDelayMs(1)).toBe(300_000);
    expect(fadadaReconcileDelayMs(2)).toBe(1_800_000);
    expect(fadadaReconcileDelayMs(3)).toBe(21_600_000);
    expect(fadadaReconcileDelayMs(9)).toBe(21_600_000);
  });
});

describe("SubscriptionJourneyWorker", () => {
  it("does not poll any lane while the worker flag is disabled", async () => {
    vi.useFakeTimers();
    const harness = createWorkerHarness({
      config: { SUBSCRIPTION_JOURNEY_WORKER_ENABLED: "false" }
    });

    harness.worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.repository.claimSignalOutbox).not.toHaveBeenCalled();
    expect(harness.repository.claimJobs).not.toHaveBeenCalled();
    expect(harness.repository.claimNotificationOutbox).not.toHaveBeenCalled();
    await harness.worker.onModuleDestroy();
  });

  it("claims and completes signal, job, and notification lanes independently", async () => {
    const job = claimedJob();
    const signal = claimedOutbox({
      eventType: SubscriptionJourneyEventType.JOURNEY_STARTED,
      id: "signal-outbox"
    });
    const notification = claimedOutbox({
      eventType: SubscriptionJourneyEventType.STEP_COMPLETED,
      id: "notification-outbox"
    });
    const harness = createWorkerHarness({ jobs: [job], notifications: [notification], signals: [signal] });

    await harness.worker.runOnce();

    expect(harness.repository.claimSignalOutbox).toHaveBeenCalledWith(
      expect.anything(),
      10,
      120_000
    );
    expect(harness.repository.claimJobs).toHaveBeenCalledWith(
      expect.anything(),
      10,
      120_000
    );
    expect(harness.repository.claimNotificationOutbox).toHaveBeenCalledWith(
      expect.anything(),
      10,
      120_000
    );
    expect(harness.service.dispatchSignalOutbox).toHaveBeenCalledWith(
      expect.anything(),
      signal
    );
    expect(harness.handlers.handle).toHaveBeenCalledWith(job);
    expect(harness.service.dispatchNotificationOutbox).toHaveBeenCalledWith(
      expect.anything(),
      notification
    );
    expect(harness.repository.completeJob).toHaveBeenCalledWith(
      expect.anything(),
      job.id,
      job.leaseToken,
      { action: "COMPLETED" }
    );
    expect(harness.repository.completeOutbox).toHaveBeenCalledTimes(2);
  });

  it("applies bounded jitter when rescheduling a retryable job", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const job = claimedJob({ attemptCount: 0 });
    const harness = createWorkerHarness({
      handlerError: new Error("provider token=must-not-leak"),
      jobs: [job]
    });

    await harness.worker.runOnce();

    expect(harness.repository.rescheduleJob).toHaveBeenCalledWith(
      expect.anything(),
      job.id,
      job.leaseToken,
      {
        delayMs: 36_000,
        error: {
          code: "JOURNEY_EXECUTION_ERROR",
          message: "Subscription journey operation failed.",
          retryable: true
        }
      }
    );
  });

  it("prefers a capped provider retry-after value", async () => {
    const job = claimedJob();
    const harness = createWorkerHarness({
      handlerError: journeyError(
        "JOURNEY_EXECUTION_ERROR",
        "Subscription journey operation failed.",
        true,
        9_000_000
      ),
      jobs: [job]
    });

    await harness.worker.runOnce();

    expect(harness.repository.rescheduleJob).toHaveBeenCalledWith(
      expect.anything(),
      job.id,
      job.leaseToken,
      expect.objectContaining({ delayMs: 7_200_000 })
    );
  });

  it.each([
    [0, 300_000],
    [1, 1_800_000],
    [2, 21_600_000]
  ])(
    "uses the Fadada observation delay after attemptCount %s",
    async (attemptCount, delayMs) => {
      const job = claimedJob({
        attemptCount,
        jobType: SubscriptionJourneyJobType.RECONCILE_FADADA_SIGNING
      });
      const harness = createWorkerHarness({
        handlerError: new Error("Fadada signing is still pending."),
        jobs: [job]
      });

      await harness.worker.runOnce();

      expect(harness.repository.rescheduleJob).toHaveBeenCalledWith(
        expect.anything(),
        job.id,
        job.leaseToken,
        expect.objectContaining({ delayMs })
      );
    }
  );

  it("dead-letters the fifth failed execution", async () => {
    const job = claimedJob({ attemptCount: 4, maxAttempts: 5 });
    const harness = createWorkerHarness({
      handlerError: new Error("temporary failure"),
      jobs: [job]
    });

    await harness.worker.runOnce();

    expect(harness.repository.deadLetterJob).toHaveBeenCalledOnce();
    expect(harness.repository.rescheduleJob).not.toHaveBeenCalled();
  });

  it("dead-letters a non-retryable handler error immediately", async () => {
    const job = claimedJob();
    const harness = createWorkerHarness({
      handlerError: journeyError(
        "JOURNEY_HANDLER_NOT_READY",
        "The subscription journey handler is not ready.",
        false
      ),
      jobs: [job]
    });

    await harness.worker.runOnce();

    expect(harness.repository.deadLetterJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        error: {
          code: "JOURNEY_HANDLER_NOT_READY",
          message: "The subscription journey handler is not ready.",
          retryable: false
        },
        jobId: job.id,
        journeyId: job.journeyId,
        leaseToken: job.leaseToken,
        stepId: job.stepId
      })
    );
  });

  it("waits for an active poll before module shutdown completes", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const harness = createWorkerHarness({ jobs: [claimedJob()] });
    harness.handlers.handle.mockImplementation(
      () =>
        new Promise((resolve) => {
          started();
          release = () => resolve({ action: "COMPLETED" });
        })
    );

    harness.worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    await handlerStarted;
    const shutdown = harness.worker.onModuleDestroy();
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await shutdown;
    expect(settled).toBe(true);
  });

  it("rejects invalid positive-integer worker configuration at startup", () => {
    const harness = createWorkerHarness({
      config: { SUBSCRIPTION_JOURNEY_CLAIM_LIMIT: "0" }
    });

    expect(() => harness.worker.onModuleInit()).toThrowError(
      expect.objectContaining({ code: "JOURNEY_CONFIGURATION_ERROR" })
    );
  });
});

describe("SubscriptionJourneyHandlers", () => {
  it("fails closed for a domain handler that has not been implemented yet", async () => {
    const handlers = new SubscriptionJourneyHandlers({} as SubscriptionJourneyService);

    await expect(
      handlers.handle(
        claimedJob({
          jobType: SubscriptionJourneyJobType.START_FADADA_SIGNING
        })
      )
    ).rejects.toMatchObject({
      code: "JOURNEY_HANDLER_NOT_READY",
      retryable: false
    });
  });
});

interface HarnessOptions {
  config?: Record<string, string>;
  handlerError?: unknown;
  jobs?: ClaimedJourneyJob[];
  notifications?: ClaimedJourneyOutbox[];
  signals?: ClaimedJourneyOutbox[];
}

function createWorkerHarness(options: HarnessOptions = {}) {
  const tx = {};
  const prisma = {
    $transaction: vi.fn(async (operation: (transaction: unknown) => unknown) =>
      operation(tx)
    )
  };
  const repository = {
    claimJobs: vi.fn(async () => options.jobs ?? []),
    claimNotificationOutbox: vi.fn(async () => options.notifications ?? []),
    claimSignalOutbox: vi.fn(async () => options.signals ?? []),
    completeJob: vi.fn(async () => undefined),
    completeOutbox: vi.fn(async () => undefined),
    deadLetterJob: vi.fn(async () => undefined),
    deadLetterOutbox: vi.fn(async () => undefined),
    rescheduleJob: vi.fn(async () => undefined),
    rescheduleOutbox: vi.fn(async () => undefined)
  };
  const handlers = {
    handle: vi.fn(async () => {
      if (options.handlerError !== undefined) throw options.handlerError;
      return { action: "COMPLETED" };
    })
  };
  const service = {
    dispatchNotificationOutbox: vi.fn(async () => undefined),
    dispatchSignalOutbox: vi.fn(async () => undefined)
  };
  const runtimeConfig = new SubscriptionJourneyRuntimeConfig(
    new ConfigService({
      SUBSCRIPTION_JOURNEY_CLAIM_LIMIT: "10",
      SUBSCRIPTION_JOURNEY_ENABLED: "true",
      SUBSCRIPTION_JOURNEY_LEASE_MS: "120000",
      SUBSCRIPTION_JOURNEY_POLL_INTERVAL_MS: "5000",
      SUBSCRIPTION_JOURNEY_WORKER_ENABLED: "true",
      ...options.config
    })
  );
  const worker = new SubscriptionJourneyWorker(
    prisma as unknown as PrismaService,
    repository as unknown as SubscriptionJourneyRepository,
    handlers as unknown as SubscriptionJourneyHandlers,
    service as unknown as SubscriptionJourneyService,
    runtimeConfig
  );
  return { handlers, repository, service, worker };
}

function claimedJob(overrides: Partial<ClaimedJourneyJob> = {}): ClaimedJourneyJob {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    completedAt: null,
    createdAt: now,
    id: "job-1",
    jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
    journeyId: "journey-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date(now.getTime() + 120_000),
    leaseToken: "lease-job-1",
    maxAttempts: 5,
    payload: null,
    sourceKey: "journey:journey-1:step:APPLICATION_VALIDATION:revision:0",
    status: SubscriptionJourneyJobStatus.PROCESSING,
    stepId: "step-1",
    updatedAt: now,
    ...overrides
  };
}

function claimedOutbox(
  overrides: Partial<ClaimedJourneyOutbox> = {}
): ClaimedJourneyOutbox {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    aggregateId: "journey-1",
    aggregateType: "SUBSCRIPTION_JOURNEY",
    attemptCount: 0,
    availableAt: now,
    createdAt: now,
    deliveredAt: null,
    eventKey: "journey:event:outbox",
    eventType: SubscriptionJourneyEventType.JOURNEY_STARTED,
    id: "outbox-1",
    journeyId: "journey-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date(now.getTime() + 120_000),
    leaseToken: "lease-outbox-1",
    payload: { stepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION },
    status: SubscriptionJourneyOutboxStatus.PROCESSING,
    updatedAt: now,
    ...overrides
  };
}
