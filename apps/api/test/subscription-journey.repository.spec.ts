import {
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyManualDecision,
  SubscriptionJourneyStepCode
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SubscriptionJourneyRepository } from "../src/subscription-journey/subscription-journey.repository";
import { SubscriptionJourneySignalService } from "../src/subscription-journey/subscription-journey-signal.service";

describe("SubscriptionJourneyRepository", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses repeated event keys before applying a second state change", async () => {
    const eventKey = "application:submitted:evt-1";
    const step = journeyStep();
    const eventRows = new Map<string, { journeyId: string }>();
    const tx = completeStepTransaction(step, eventRows);
    const repository = new SubscriptionJourneyRepository();
    const input = {
      eventKey,
      expectedVersion: 0,
      journeyId: step.journeyId,
      nextStepCode: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION,
      payload: { source: "application" },
      stepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
      stepId: step.id
    };

    const first = await repository.completeStep(tx as never, input);
    const second = await repository.completeStep(tx as never, input);

    expect(second).toEqual(first);
    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.subscriptionJourneyEvent.create).toHaveBeenCalledTimes(1);
  });

  it("creates one application journey and one durable start event for producer retries", async () => {
    const applicationId = randomUUID();
    const journeys = new Map<string, ReturnType<typeof journey>>();
    const events = new Map<string, unknown>();
    const outbox = new Map<string, unknown>();
    const tx = {
      subscriptionJourney: {
        upsert: vi.fn(async (input) => {
          const existing = journeys.get(input.where.applicationId);
          if (existing) return existing;
          const created = journey({ applicationId: input.create.applicationId });
          journeys.set(applicationId, created);
          return created;
        })
      },
      subscriptionJourneyEvent: {
        upsert: vi.fn(async (input) => {
          const existing = events.get(input.where.eventKey);
          if (existing) return existing;
          events.set(input.where.eventKey, input.create);
          return input.create;
        })
      },
      subscriptionJourneyOutbox: {
        upsert: vi.fn(async (input) => {
          const existing = outbox.get(input.where.eventKey);
          if (existing) return existing;
          outbox.set(input.where.eventKey, input.create);
          return input.create;
        })
      }
    };
    const repository = new SubscriptionJourneyRepository() as unknown as {
      createOrGetForApplication(
        tx: unknown,
        applicationId: string,
        eventKey: string
      ): Promise<ReturnType<typeof journey>>;
    };

    const first = await repository.createOrGetForApplication(
      tx,
      applicationId,
      "application:submitted:evt-new"
    );
    const second = await repository.createOrGetForApplication(
      tx,
      applicationId,
      "application:submitted:evt-new"
    );

    expect(second.id).toBe(first.id);
    expect(journeys.size).toBe(1);
    expect(events.size).toBe(1);
    expect(outbox.size).toBe(1);
  });

  it("moves a step and journey to customer waiting in the caller transaction", async () => {
    const step = journeyStep();
    const tx = completeStepTransaction(step, new Map());
    const repository = new SubscriptionJourneyRepository() as unknown as {
      waitForCustomer(tx: unknown, input: Record<string, unknown>): Promise<unknown>;
    };

    await repository.waitForCustomer(tx, {
      eventKey: "customer:confirmation:waiting",
      expectedVersion: 1,
      journeyId: step.journeyId,
      payload: { planRevision: 3 },
      stepCode: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
      stepId: step.id
    });

    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "WAITING_CUSTOMER" }),
        where: { id: step.journeyId, version: 1 }
      })
    );
    expect(tx.subscriptionJourneyStep.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "WAITING_CUSTOMER" })
      })
    );
    expect(tx.subscriptionJourneyEvent.create).toHaveBeenCalledOnce();
    expect(tx.subscriptionJourneyOutbox.upsert).toHaveBeenCalledOnce();
  });

  it("routes application submission through the transaction signal boundary", async () => {
    const startedJourney = journey({ applicationId: "application-1" });
    const tx = {
      subscriptionJourney: {
        upsert: vi.fn(async () => startedJourney)
      },
      subscriptionJourneyEvent: {
        upsert: vi.fn(async (input) => input.create)
      },
      subscriptionJourneyOutbox: {
        upsert: vi.fn(async (input) => input.create)
      }
    };
    const service = new SubscriptionJourneySignalService(
      new SubscriptionJourneyRepository()
    ) as unknown as {
      record(tx: unknown, input: Record<string, unknown>): Promise<void>;
    };

    await service.record(tx, {
      applicationId: "application-1",
      eventKey: "application:submitted:signal-1",
      type: "APPLICATION_SUBMITTED"
    });

    expect(tx.subscriptionJourney.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { applicationId: "application-1" } })
    );
    expect(tx.subscriptionJourneyEvent.upsert).toHaveBeenCalledOnce();
    expect(tx.subscriptionJourneyOutbox.upsert).toHaveBeenCalledOnce();
  });

  it("records a later domain fact once when the producer retries", async () => {
    const currentJourney = journey({ id: "journey-signal" });
    const events = new Map<string, unknown>();
    const outbox = new Map<string, unknown>();
    const tx = {
      subscriptionJourney: {
        findFirst: vi.fn(async () => currentJourney),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      subscriptionJourneyEvent: {
        create: vi.fn(async (input) => {
          events.set(input.data.eventKey, input.data);
          return input.data;
        }),
        findUnique: vi.fn(async (input) =>
          events.get(input.where.eventKey) ?? null
        )
      },
      subscriptionJourneyOutbox: {
        upsert: vi.fn(async (input) => {
          const existing = outbox.get(input.where.eventKey);
          if (existing) return existing;
          outbox.set(input.where.eventKey, input.create);
          return input.create;
        })
      }
    };
    const service = new SubscriptionJourneySignalService(
      new SubscriptionJourneyRepository()
    ) as unknown as {
      record(tx: unknown, input: Record<string, unknown>): Promise<void>;
    };
    const input = {
      eventKey: "payment:settled:signal-1",
      orderId: "order-1",
      payload: { paymentId: "payment-1" },
      type: "PAYMENT_SETTLED"
    };

    await service.record(tx, input);
    await service.record(tx, input);

    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledTimes(1);
    expect(events.size).toBe(1);
    expect(outbox.size).toBe(1);
  });

  it("keeps source-key job enqueue idempotent", async () => {
    const rows = new Map<string, ReturnType<typeof journeyJob>>();
    const tx = {
      subscriptionJourneyJob: {
        async upsert(input: {
          create: ReturnType<typeof journeyJob>;
          where: { sourceKey: string };
        }) {
          const existing = rows.get(input.where.sourceKey);
          if (existing) return existing;
          const row = { ...journeyJob(), ...input.create };
          rows.set(input.where.sourceKey, row);
          return row;
        }
      }
    };
    const repository = new SubscriptionJourneyRepository();
    const step = journeyStep();
    const input = {
      jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
      journeyId: step.journeyId,
      payload: { applicationId: randomUUID() },
      sourceKey: "validate:application:42",
      stepId: step.id
    };

    const first = await repository.enqueueJob(tx as never, input);
    const second = await repository.enqueueJob(tx as never, input);

    expect(second.id).toBe(first.id);
    expect(rows.size).toBe(1);
  });

  it("rejects a stale journey version before changing its step", async () => {
    const tx = {
      subscriptionJourney: {
        updateMany: vi.fn(async () => ({ count: 0 }))
      },
      subscriptionJourneyEvent: {
        findUnique: vi.fn(async () => null)
      },
      subscriptionJourneyStep: {
        update: vi.fn()
      }
    };
    const step = journeyStep();
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.completeStep(tx as never, {
        eventKey: "step:stale",
        expectedVersion: 7,
        journeyId: step.journeyId,
        nextStepCode: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION,
        stepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
        stepId: step.id
      })
    ).rejects.toMatchObject({ code: "JOURNEY_OPTIMISTIC_LOCK_CONFLICT" });
    expect(tx.subscriptionJourneyStep.update).not.toHaveBeenCalled();
  });

  it("maps the one-open-manual-task constraint to a stable conflict", async () => {
    const tx = {
      subscriptionJourneyManualTask: {
        create: vi.fn(async () => {
          throw Object.assign(new Error("duplicate key value"), {
            code: "P2002",
            meta: { target: "subscription_journey_open_manual_task_key" }
          });
        })
      }
    };
    const step = journeyStep({
      code: SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION
    });
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.openManualTask(tx as never, {
        inputSnapshot: { vehicleId: randomUUID() },
        journeyId: step.journeyId,
        stepCode: step.code,
        stepId: step.id
      })
    ).rejects.toMatchObject({ code: "JOURNEY_MANUAL_TASK_ALREADY_OPEN" });
  });

  it("writes the step, event, and outbox through one caller transaction", async () => {
    const step = journeyStep();
    const tx = completeStepTransaction(step, new Map());
    const repository = new SubscriptionJourneyRepository();

    await repository.completeStep(tx as never, {
      eventKey: "application:validated:evt-2",
      expectedVersion: 0,
      journeyId: step.journeyId,
      nextStepCode: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION,
      payload: { applicationId: randomUUID() },
      stepCode: step.code,
      stepId: step.id
    });

    expect(tx.subscriptionJourneyStep.update).toHaveBeenCalledOnce();
    expect(tx.subscriptionJourneyEvent.create).toHaveBeenCalledOnce();
    expect(tx.subscriptionJourneyOutbox.upsert).toHaveBeenCalledOnce();
    expect(tx.$transaction).not.toHaveBeenCalled();
  });

  it("claims jobs and outbox rows with skip-locked leases", async () => {
    const job = journeyJob({
      leaseExpiresAt: new Date("2026-08-06T00:02:00.000Z"),
      leaseToken: "job-lease",
      status: SubscriptionJourneyJobStatus.PROCESSING
    });
    const outbox = {
      aggregateId: "application-1",
      aggregateType: "APPLICATION",
      attemptCount: 0,
      availableAt: new Date("2026-08-06T00:00:00.000Z"),
      createdAt: new Date("2026-08-06T00:00:00.000Z"),
      deliveredAt: null,
      eventKey: "outbox-1",
      eventType: "STEP_COMPLETED",
      id: "outbox-id",
      journeyId: job.journeyId,
      lastErrorCode: null,
      lastErrorMessage: null,
      leaseExpiresAt: new Date("2026-08-06T00:02:00.000Z"),
      leaseToken: "outbox-lease",
      payload: {},
      status: "PROCESSING",
      updatedAt: new Date("2026-08-06T00:00:00.000Z")
    };
    const queries: Array<{ strings: readonly string[] }> = [];
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async (query: { strings: readonly string[] }) => {
        queries.push(query);
        return queries.length === 1 ? [{ id: job.id }] : [{ id: outbox.id }];
      }),
      subscriptionJourneyJob: {
        findMany: vi.fn(async () => [job])
      },
      subscriptionJourneyOutbox: {
        findMany: vi.fn(async () => [outbox])
      }
    };
    const repository = new SubscriptionJourneyRepository();

    await expect(repository.claimJobs(tx as never, 1, 120_000)).resolves.toEqual([
      job
    ]);
    await expect(
      repository.claimOutbox(tx as never, 1, 120_000)
    ).resolves.toEqual([outbox]);

    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.strings.join(" ")).toContain("FOR UPDATE SKIP LOCKED");
    }
  });

  it("requires the active lease token to complete a job", async () => {
    const tx = {
      subscriptionJourneyJob: {
        updateMany: vi.fn(async () => ({ count: 0 }))
      }
    };
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.completeJob(tx as never, "job-1", "stale-lease", {
        ok: true
      })
    ).rejects.toMatchObject({ code: "JOURNEY_LEASE_LOST" });
  });

  it("schedules retry with a safe error and clears the lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T00:00:00.000Z"));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const repository = new SubscriptionJourneyRepository();

    await repository.rescheduleJob(
      { subscriptionJourneyJob: { updateMany } } as never,
      "job-1",
      "lease-1",
      {
        delayMs: 30_000,
        error: {
          code: "PROVIDER_TIMEOUT",
          message: "Provider request failed.",
          retryable: true
        }
      }
    );

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          availableAt: new Date("2026-08-06T00:00:30.000Z"),
          lastErrorCode: "PROVIDER_TIMEOUT",
          lastErrorMessage: "Provider request failed.",
          leaseExpiresAt: null,
          leaseToken: null,
          status: SubscriptionJourneyJobStatus.RETRY_SCHEDULED
        })
      })
    );
  });

  it("dead-letters under the lease and creates a composite-linked exception", async () => {
    const create = vi.fn(async (input) => ({ id: "exception-1", ...input.data }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const repository = new SubscriptionJourneyRepository();

    await repository.deadLetterJob(
      {
        subscriptionJourneyException: { create },
        subscriptionJourneyJob: { updateMany }
      } as never,
      {
        error: {
          code: "SIGNATURE_PROVIDER_FAILED",
          message: "Signature provider failed.",
          retryable: false
        },
        jobId: "job-1",
        journeyId: "journey-1",
        leaseToken: "lease-1",
        stepId: "step-1"
      }
    );

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: "job-1",
        journeyId: "journey-1",
        stepId: "step-1"
      })
    });
  });

  it("rejects sensitive payload keys before persisting them", async () => {
    const upsert = vi.fn();
    const repository = new SubscriptionJourneyRepository();
    const step = journeyStep();

    await expect(
      repository.enqueueJob(
        { subscriptionJourneyJob: { upsert } } as never,
        {
          jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
          journeyId: step.journeyId,
          payload: { nested: { accessToken: "must-not-be-stored" } },
          sourceKey: "unsafe-job",
          stepId: step.id
        }
      )
    ).rejects.toMatchObject({ code: "JOURNEY_SENSITIVE_PAYLOAD" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("decides manual work with an optimistic task version", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.decideManualTask(
        { subscriptionJourneyManualTask: { updateMany } } as never,
        {
          decidedBy: randomUUID(),
          decision: SubscriptionJourneyManualDecision.APPROVED,
          expectedVersion: 2,
          journeyId: "journey-1",
          taskId: "task-1"
        }
      )
    ).rejects.toMatchObject({ code: "JOURNEY_OPTIMISTIC_LOCK_CONFLICT" });
  });
});

function journeyStep(
  overrides: Partial<{
    code: SubscriptionJourneyStepCode;
    id: string;
    journeyId: string;
  }> = {}
) {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    attemptCount: 1,
    code: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
    completedAt: null,
    createdAt: now,
    id: "step-1",
    journeyId: "journey-1",
    lastErrorCode: null,
    startedAt: now,
    status: "RUNNING",
    updatedAt: now,
    waitingAt: null,
    ...overrides
  };
}

function journey(
  overrides: Partial<{
    applicationId: string;
    id: string;
  }> = {}
) {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    applicationId: randomUUID(),
    cancelledAt: null,
    completedAt: null,
    createdAt: now,
    currentStepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
    currentStepStatus: "PENDING",
    id: "journey-1",
    orderId: null,
    pausedFromStatus: null,
    startedAt: now,
    status: "RUNNING",
    updatedAt: now,
    version: 0,
    ...overrides
  };
}

function journeyJob(
  overrides: Partial<{
    leaseExpiresAt: Date | null;
    leaseToken: string | null;
    status: SubscriptionJourneyJobStatus;
  }> = {}
) {
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
    leaseExpiresAt: null,
    leaseToken: null,
    maxAttempts: 5,
    payload: {},
    sourceKey: "source-1",
    status: SubscriptionJourneyJobStatus.PENDING,
    stepId: "step-1",
    updatedAt: now,
    ...overrides
  };
}

function completeStepTransaction(
  step: ReturnType<typeof journeyStep>,
  eventRows: Map<string, { journeyId: string }>
) {
  return {
    $transaction: vi.fn(),
    subscriptionJourney: {
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    subscriptionJourneyEvent: {
      create: vi.fn(async (input: { data: { eventKey: string; journeyId: string } }) => {
        eventRows.set(input.data.eventKey, input.data);
        return input.data;
      }),
      findUnique: vi.fn(async (input: { where: { eventKey: string } }) =>
        eventRows.get(input.where.eventKey) ?? null
      )
    },
    subscriptionJourneyOutbox: {
      upsert: vi.fn(async (input) => input.create)
    },
    subscriptionJourneyStep: {
      findUnique: vi.fn(async () => step),
      update: vi.fn(async (input) => {
        Object.assign(step, input.data);
        return step;
      })
    }
  };
}
