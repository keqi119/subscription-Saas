import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Stage2HandoverWorkflowRepository } from "../src/handover-work-order/stage2-handover-workflow.repository";
import { Stage2HandoverWorkflowService } from "../src/handover-work-order/stage2-handover-workflow.service";
import {
  ClaimedStage2WorkflowJob,
  Stage2HandoverWorkflowHandler
} from "../src/handover-work-order/stage2-handover-workflow.types";
import { Stage2HandoverWorkflowWorker } from "../src/handover-work-order/stage2-handover-workflow.worker";

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(
    () => undefined
  );
});

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

  it("claims only the job types supported by its handler", async () => {
    const supportedJobTypes = [
      VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF
    ] as const;
    const handler = {
      handle: vi.fn(async () => ({ kind: "COMPLETED" as const })),
      supportedJobTypes
    } as Stage2HandoverWorkflowHandler & {
      supportedJobTypes: typeof supportedJobTypes;
    };
    const harness = createWorkerHarness({ handler });

    await harness.worker.runOnce();

    expect(harness.repository.claimDue).toHaveBeenCalledWith(
      1,
      120_000,
      supportedJobTypes
    );
  });

  it("runs a ten-record archive convergence batch before claiming due jobs", async () => {
    const order: string[] = [];
    const handler = {
      handle: vi.fn(async () => ({ kind: "COMPLETED" as const })),
      reconcileArchivedStage2Evidence: vi.fn(async (limit: number) => {
        order.push(`reconcile:${limit}`);
        return { failed: 0, processed: 0, scanned: 0 };
      }),
      supportedJobTypes: [
        VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF
      ]
    } satisfies Stage2HandoverWorkflowHandler & {
      reconcileArchivedStage2Evidence(
        limit: number
      ): Promise<{ failed: number; processed: number; scanned: number }>;
    };
    const harness = createWorkerHarness({ handler });
    harness.repository.claimDue.mockImplementationOnce(async () => {
      order.push("claim");
      return [];
    });

    await harness.worker.runOnce();

    expect(order).toEqual(["reconcile:10", "claim"]);
  });

  it("does not claim jobs when the archive convergence query fails", async () => {
    const failure = new Error("archive convergence query failed");
    const handler = {
      handle: vi.fn(async () => ({ kind: "COMPLETED" as const })),
      reconcileArchivedStage2Evidence: vi.fn(async () => {
        throw failure;
      }),
      supportedJobTypes: [
        VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF
      ]
    } satisfies Stage2HandoverWorkflowHandler & {
      reconcileArchivedStage2Evidence(
        limit: number
      ): Promise<{ failed: number; processed: number; scanned: number }>;
    };
    const harness = createWorkerHarness({ handler });

    await expect(harness.worker.runOnce()).rejects.toBe(failure);

    expect(harness.repository.claimDue).not.toHaveBeenCalled();
  });

  it("uses 1m, 5m, 15m, 1h, and 6h retry delays", async () => {
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
          delayMs: expectedDelay,
          error: {
            code: "WORKFLOW_ERROR",
            message: "Workflow operation failed."
          }
        })
      );
    }
  });

  it("moves the sixth failed attempt to DEAD_LETTER after all five delays", async () => {
    const job = claimedJob({ attemptCount: 5 });
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
        code: "WORKFLOW_ERROR",
        message: "Workflow operation failed."
      }
    );
    expect(harness.repository.reschedule).not.toHaveBeenCalled();
  });

  it("reschedules provider SIGNING without incrementing attemptCount", async () => {
    const job = claimedJob({ attemptCount: 2 });
    const delayMs = 300_000;
    const harness = createWorkerHarness({
      jobs: [job],
      result: {
        delayMs,
        kind: "OBSERVED_SIGNING",
        result: { providerStatus: "SIGNING" }
      }
    });

    await harness.worker.runOnce();

    expect(harness.repository.reschedule).toHaveBeenCalledWith(
      job.id,
      job.leaseToken,
      {
        delayMs,
        incrementAttempt: false,
        result: { providerStatus: "SIGNING" }
      }
    );
    expect(harness.repository.complete).not.toHaveBeenCalled();
  });

  it("persists and logs only generic errors without sensitive source values", async () => {
    const rawCode = "provider_password=short-code-secret otp=482913";
    const sensitiveValues = [
      rawCode,
      "482913",
      "+86 138-0013-8000",
      "138 0013 8000",
      "http://evidence.example/private?id=482913",
      "https://evidence.example/private",
      "oss://handover/private/object.jpg",
      "s3://handover/private/object.jpg",
      "file:///C:/handover/private/object.jpg",
      "C:\\handover\\private\\object.jpg",
      "/api/v1/evidence/private/object.jpg",
      "/object-storage/private/object.jpg",
      "tok7",
      "dig8",
      "sec9",
      "pwd0",
      "key1"
    ];
    const error = Object.assign(
      new Error(
        [
          "OTP 482913",
          "mobiles +86 138-0013-8000 and 138 0013 8000",
          "http://evidence.example/private?id=482913",
          "https://evidence.example/private",
          "oss://handover/private/object.jpg",
          "s3://handover/private/object.jpg",
          "file:///C:/handover/private/object.jpg",
          "C:\\handover\\private\\object.jpg",
          "/api/v1/evidence/private/object.jpg",
          "/object-storage/private/object.jpg",
          "token=tok7 digest=dig8 secret=sec9 password=pwd0 key=key1"
        ].join(" ")
      ),
      { code: rawCode }
    );
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const harness = createWorkerHarness({ error, jobs: [claimedJob()] });

    await harness.worker.runOnce();

    expect(harness.repository.reschedule).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        error: {
          code: "WORKFLOW_ERROR",
          message: "Workflow operation failed."
        }
      })
    );
    const persistedAndLogged = JSON.stringify({
      logs: warn.mock.calls,
      reschedule: harness.repository.reschedule.mock.calls
    });
    for (const sensitiveValue of sensitiveValues) {
      expect(persistedAndLogged).not.toContain(sensitiveValue);
    }
  });

  it("does not consume an attempt when persisting observed SIGNING fails", async () => {
    const transitionError = new Error("Signing observation persistence failed.");
    const delayMs = 300_000;
    const harness = createWorkerHarness({
      jobs: [claimedJob({ attemptCount: 2 })],
      result: {
        delayMs,
        kind: "OBSERVED_SIGNING",
        result: { providerStatus: "SIGNING" }
      }
    });
    harness.repository.reschedule.mockRejectedValueOnce(transitionError);

    await expect(harness.worker.runOnce()).rejects.toBe(transitionError);

    expect(harness.repository.reschedule).toHaveBeenCalledTimes(1);
    expect(harness.repository.reschedule).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      {
        delayMs,
        incrementAttempt: false,
        result: { providerStatus: "SIGNING" }
      }
    );
    expect(harness.repository.deadLetter).not.toHaveBeenCalled();
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
      },
      supportedJobTypes: [VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF]
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

  it("waits for every started lane before poll completion and module shutdown", async () => {
    const firstJob = claimedJob({
      id: "00000000-0000-4000-8000-000000000011"
    });
    const secondJob = claimedJob({
      id: "00000000-0000-4000-8000-000000000012"
    });
    const repositoryError = new Error("repository password=repo-secret");
    let releaseSecond!: () => void;
    let markSecondStarted!: () => void;
    let markSecondCompleted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const secondCompleted = new Promise<void>((resolve) => {
      markSecondCompleted = resolve;
    });
    const handler: Stage2HandoverWorkflowHandler = {
      handle(job) {
        if (job.id === firstJob.id) {
          return Promise.resolve({ kind: "COMPLETED" });
        }
        markSecondStarted();
        return new Promise((resolve) => {
          releaseSecond = () => resolve({ kind: "COMPLETED" });
        });
      },
      supportedJobTypes: [VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF]
    };
    const errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const harness = createWorkerHarness({
      config: {
        STAGE2_HANDOVER_WORKER_CONCURRENCY: "2",
        STAGE2_HANDOVER_WORKER_ENABLED: "true"
      },
      handler,
      jobs: [firstJob, secondJob]
    });
    harness.repository.complete.mockImplementation((jobId: string) => {
      if (jobId === firstJob.id) {
        return Promise.reject(repositoryError);
      }
      markSecondCompleted();
      return Promise.resolve(true);
    });
    harness.repository.reschedule.mockRejectedValue(repositoryError);

    harness.worker.onModuleInit();
    await secondStarted;
    const shutdown = harness.worker.onModuleDestroy();
    let shutdownSettled = false;
    void shutdown.then(
      () => {
        shutdownSettled = true;
      },
      () => {
        shutdownSettled = true;
      }
    );

    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(shutdownSettled).toBe(false);
    } finally {
      releaseSecond();
      await secondCompleted;
      await shutdown;
    }

    expect(errorLog).toHaveBeenCalledWith({
      errorCode: "WORKFLOW_ERROR",
      operation: "STAGE2_WORKFLOW_POLL"
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("repo-secret");
  });
});

describe("Stage2HandoverWorkflowService worker handler", () => {
  it("dispatches GENERATE_SOURCE_PDF and stops its bounded lease heartbeat", async () => {
    const repository = {
      renewLease: vi.fn(async () => true)
    };
    const handoverWorkOrderService = {
      ensureStage2HandoverPdf: vi.fn(async (
        _workOrderId: string,
        _manifestHash: string,
        options: { lease: { assertLease(): Promise<void> } }
      ) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await options.lease.assertLease();
        return {
          artifactId: "file-pdf-1",
          documentNo: "HDV20260727080000ABCD",
          downloadUrl: "/api/handover-work-orders/work-order-1/pdf/download",
          fileName: "handover.pdf",
          fileSize: 1024,
          generatedAt: new Date("2026-07-27T08:00:00.000Z"),
          orderNo: "ORD-001",
          status: "GENERATED",
          workOrderId: "work-order-1"
        };
      })
    };
    const service = new Stage2HandoverWorkflowService(
      {} as never,
      new ConfigService({
        STAGE2_HANDOVER_WORKER_LEASE_MS: "30",
        STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
      }),
      repository as never,
      handoverWorkOrderService as never
    );
    const job = claimedJob({
      jobType: VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF,
      payload: {
        manifestHash: `sha256:${"a".repeat(64)}`,
        reviewAttemptId: "review-attempt-1"
      }
    });

    await expect(service.handle(job)).resolves.toEqual({
      kind: "COMPLETED",
      result: {
        artifactId: "file-pdf-1",
        artifactStatus: "GENERATED"
      }
    });
    expect(handoverWorkOrderService.ensureStage2HandoverPdf)
      .toHaveBeenCalledWith(
        job.workOrderId,
        `sha256:${"a".repeat(64)}`,
        {
          lease: expect.objectContaining({
            jobId: job.id,
            leaseMs: 30,
            leaseToken: job.leaseToken
          })
        }
      );
    expect(repository.renewLease.mock.calls.length).toBeGreaterThan(1);
    const renewalsAfterCompletion = repository.renewLease.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(repository.renewLease).toHaveBeenCalledTimes(
      renewalsAfterCompletion
    );
  });

  it("rejects stale PDF work after heartbeat lease loss", async () => {
    const repository = {
      renewLease: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
    };
    const handoverWorkOrderService = {
      ensureStage2HandoverPdf: vi.fn(async (
        _workOrderId: string,
        _manifestHash: string,
        options: { lease: { assertLease(): Promise<void> } }
      ) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await options.lease.assertLease();
        throw new Error("stale worker continued");
      })
    };
    const service = new Stage2HandoverWorkflowService(
      {} as never,
      new ConfigService({
        STAGE2_HANDOVER_WORKER_LEASE_MS: "30",
        STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
      }),
      repository as never,
      handoverWorkOrderService as never
    );
    const job = claimedJob({
      jobType: VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF,
      payload: {
        manifestHash: `sha256:${"a".repeat(64)}`,
        reviewAttemptId: "review-attempt-1"
      }
    });

    await expect(service.handle(job)).rejects.toThrow("LEASE_LOST");
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
      }),
      supportedJobTypes: [VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF]
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
    maxAttempts: 6,
    payload: null,
    resultSnapshot: null,
    startedAt: now,
    updatedAt: now,
    workOrderId: "00000000-0000-4000-8000-000000000003",
    ...overrides
  };
}
