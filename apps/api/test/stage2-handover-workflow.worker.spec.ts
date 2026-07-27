import { ConfigService } from "@nestjs/config";
import {
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Stage2HandoverWorkflowRepository } from "../src/handover-work-order/stage2-handover-workflow.repository";
import {
  ClaimedStage2WorkflowJob,
  Stage2HandoverWorkflowHandler
} from "../src/handover-work-order/stage2-handover-workflow.types";
import { Stage2HandoverWorkflowWorker } from "../src/handover-work-order/stage2-handover-workflow.worker";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Stage2HandoverWorkflowWorker", () => {
  it("completes a successful claimed job", async () => {
    const job = claimedJob();
    const harness = createWorkerHarness({
      jobs: [job],
      result: { kind: "COMPLETED", result: { providerStatus: "SIGNED" } }
    });

    await harness.worker.runOnce();

    expect(harness.repository.complete).toHaveBeenCalledWith(
      job.id,
      job.leaseToken,
      { providerStatus: "SIGNED" }
    );
    expect(harness.repository.reschedule).not.toHaveBeenCalled();
    expect(harness.repository.deadLetter).not.toHaveBeenCalled();
  });

  it("uses 1m, 5m, 15m, 1h, and 6h retry delays", async () => {
    const now = new Date("2026-07-27T08:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    const expectedDelays = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];

    for (const [attemptCount, expectedDelay] of expectedDelays.entries()) {
      const job = claimedJob({ attemptCount, id: `00000000-0000-4000-8000-00000000000${attemptCount}` });
      const harness = createWorkerHarness({
        error: new Error("Provider request failed."),
        jobs: [job]
      });

      await harness.worker.runOnce();

      expect(harness.repository.reschedule).toHaveBeenCalledWith(
        job.id,
        job.leaseToken,
        expect.objectContaining({
          availableAt: new Date(now.getTime() + expectedDelay),
          error: {
            code: "ERROR",
            message: "Provider request failed."
          }
        })
      );
    }
  });

  it("moves the fifth failed attempt to DEAD_LETTER", async () => {
    const job = claimedJob({ attemptCount: 4, maxAttempts: 5 });
    const harness = createWorkerHarness({
      error: Object.assign(new Error("Provider request failed."), {
        code: "provider_timeout"
      }),
      jobs: [job]
    });

    await harness.worker.runOnce();

    expect(harness.repository.deadLetter).toHaveBeenCalledWith(
      job.id,
      job.leaseToken,
      {
        code: "PROVIDER_TIMEOUT",
        message: "Provider request failed."
      }
    );
    expect(harness.repository.reschedule).not.toHaveBeenCalled();
  });

  it("reschedules provider SIGNING without incrementing attemptCount", async () => {
    const job = claimedJob({ attemptCount: 2 });
    const availableAt = new Date("2026-07-27T08:05:00.000Z");
    const harness = createWorkerHarness({
      jobs: [job],
      result: {
        availableAt,
        kind: "OBSERVED_SIGNING",
        result: { providerStatus: "SIGNING" }
      }
    });

    await harness.worker.runOnce();

    expect(harness.repository.reschedule).toHaveBeenCalledWith(
      job.id,
      job.leaseToken,
      {
        availableAt,
        incrementAttempt: false,
        result: { providerStatus: "SIGNING" }
      }
    );
    expect(harness.repository.complete).not.toHaveBeenCalled();
  });

  it("does not poll when STAGE2_HANDOVER_WORKER_ENABLED is false", async () => {
    vi.useFakeTimers();
    const harness = createWorkerHarness({
      config: { STAGE2_HANDOVER_WORKER_ENABLED: "false" }
    });

    harness.worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.repository.claimDue).not.toHaveBeenCalled();
    await harness.worker.onModuleDestroy();
  });

  it("never runs more handlers than configured concurrency", async () => {
    let activeHandlers = 0;
    let maxActiveHandlers = 0;
    const jobs = Array.from({ length: 5 }, (_, index) =>
      claimedJob({
        id: `00000000-0000-4000-8000-00000000001${index}`
      })
    );
    const handler: Stage2HandoverWorkflowHandler = {
      async handle() {
        activeHandlers += 1;
        maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeHandlers -= 1;
        return { kind: "COMPLETED" };
      }
    };
    const harness = createWorkerHarness({
      config: { STAGE2_HANDOVER_WORKER_CONCURRENCY: "2" },
      handler,
      jobs
    });

    await harness.worker.runOnce();

    expect(maxActiveHandlers).toBe(2);
    expect(harness.repository.complete).toHaveBeenCalledTimes(5);
  });
});

interface WorkerHarnessOptions {
  config?: Record<string, string>;
  error?: unknown;
  handler?: Stage2HandoverWorkflowHandler;
  jobs?: ClaimedStage2WorkflowJob[];
  result?: Awaited<ReturnType<Stage2HandoverWorkflowHandler["handle"]>>;
}

function createWorkerHarness(options: WorkerHarnessOptions = {}) {
  const repository = {
    claimDue: vi.fn().mockResolvedValue(options.jobs ?? []),
    complete: vi.fn().mockResolvedValue(true),
    deadLetter: vi.fn().mockResolvedValue(true),
    reschedule: vi.fn().mockResolvedValue(true)
  };
  const handler =
    options.handler ??
    ({
      handle: vi.fn().mockImplementation(() => {
        if (options.error !== undefined) {
          return Promise.reject(options.error);
        }
        return Promise.resolve(options.result ?? { kind: "COMPLETED" });
      })
    } satisfies Stage2HandoverWorkflowHandler);
  const config = new ConfigService({
    STAGE2_HANDOVER_WORKER_CONCURRENCY: "1",
    STAGE2_HANDOVER_WORKER_ENABLED: "true",
    STAGE2_HANDOVER_WORKER_LEASE_MS: "120000",
    STAGE2_HANDOVER_WORKER_POLL_INTERVAL_MS: "5000",
    ...options.config
  });
  const worker = new Stage2HandoverWorkflowWorker(
    repository as unknown as Stage2HandoverWorkflowRepository,
    config,
    handler
  );

  return { handler, repository, worker };
}

function claimedJob(
  overrides: Partial<ClaimedStage2WorkflowJob> = {}
): ClaimedStage2WorkflowJob {
  const now = new Date("2026-07-27T08:00:00.000Z");

  return {
    attemptCount: 0,
    availableAt: now,
    completedAt: null,
    createdAt: now,
    eSignTaskId: null,
    handoverId: null,
    id: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: "stage2-worker-test",
    jobStatus: VehicleHandoverWorkflowJobStatus.PROCESSING,
    jobType: VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date(now.getTime() + 120_000),
    leaseToken: "00000000-0000-4000-8000-000000000002",
    maxAttempts: 10,
    payload: null,
    resultSnapshot: null,
    startedAt: now,
    updatedAt: now,
    workOrderId: "00000000-0000-4000-8000-000000000003",
    ...overrides
  };
}
