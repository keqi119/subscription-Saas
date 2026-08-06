import {
  SubscriptionJourneyEventType,
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
      payload: { source: "application" },
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
      $queryRaw: vi.fn(async () => []),
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
        findUnique: vi.fn(async (input) => {
          const event = events.get(input.where.eventKey) as Record<string, unknown> | undefined;
          return event ? { ...event, journey: journeys.get(applicationId) } : null;
        }),
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
    const step = journeyStep({
      code: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION
    });
    const tx = completeStepTransaction(step, new Map(), { version: 1 } as never);
    const repository = new SubscriptionJourneyRepository() as unknown as {
      waitForCustomer(tx: unknown, input: Record<string, unknown>): Promise<unknown>;
    };

    await repository.waitForCustomer(tx, {
      eventKey: "customer:confirmation:waiting",
      expectedVersion: 1,
      journeyId: step.journeyId,
      payload: { planRevision: 3 },
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
      $queryRaw: vi.fn(async () => []),
      subscriptionJourney: {
        upsert: vi.fn(async () => startedJourney)
      },
      subscriptionJourneyEvent: {
        findUnique: vi.fn(async () => null),
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
      $queryRaw: vi.fn(async () => []),
      subscriptionJourneyJob: {
        async findUnique(input: { where: { sourceKey: string } }) {
          return rows.get(input.where.sourceKey) ?? null;
        },
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
    const step = journeyStep();
    const tx = completeStepTransaction(step, new Map(), { version: 7 } as never);
    tx.subscriptionJourney.updateMany.mockResolvedValue({ count: 0 });
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.completeStep(tx as never, {
        eventKey: "step:stale",
        expectedVersion: 7,
        journeyId: step.journeyId,
        stepId: step.id
      })
    ).rejects.toMatchObject({ code: "JOURNEY_OPTIMISTIC_LOCK_CONFLICT" });
    expect(tx.subscriptionJourneyStep.update).not.toHaveBeenCalled();
  });

  it("maps the one-open-manual-task constraint to a stable conflict", async () => {
    const step = journeyStep({
      code: SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION
    });
    const tx = completeStepTransaction(step, new Map());
    tx.subscriptionJourneyManualTask.create.mockRejectedValue(
      Object.assign(new Error("duplicate key value"), {
        code: "P2002",
        meta: { target: "subscription_journey_open_manual_task_key" }
      })
    );
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.openManualTask(tx as never, {
        inputSnapshot: { vehicleId: randomUUID() },
        journeyId: step.journeyId,
        stepCode: step.code,
        stepId: step.id
      } as never)
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
      payload: { applicationId: randomUUID() },
      stepId: step.id
    });

    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentStepCode: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION
        })
      })
    );
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
    const queries: Array<{
      strings: readonly string[];
      values: readonly unknown[];
    }> = [];
    const tx = {
      $executeRaw: vi.fn(
        async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
          void query;
          return 1;
        }
      ),
      $queryRaw: vi.fn(async (query: {
        strings: readonly string[];
        values: readonly unknown[];
      }) => {
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
    for (const [index, query] of queries.entries()) {
      const sql = query.strings.join(" ");
      expect(sql).toContain("FOR UPDATE SKIP LOCKED");
      expect(sql).toContain("clock_timestamp()");
      expect(sql).toContain("ORDER BY");
      expect(query.values).toContain(1);
      const updateSql = (tx.$executeRaw.mock.calls[index]?.[0] as {
        strings: readonly string[];
        values: readonly unknown[];
      }).strings.join(" ");
      const updateWhere = updateSql.split("WHERE")[1] ?? "";
      expect(updateWhere).toContain("lease_expires_at");
      expect(updateWhere).toContain("clock_timestamp()");
      expect(updateWhere).toContain("status");
    }
    expect(tx.subscriptionJourneyJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ leaseToken: expect.any(String) })
      })
    );
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

  it.each(["completeJob", "rescheduleJob", "deadLetterJob"] as const)(
    "requires an unexpired lease for %s",
    async (operation) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-06T00:00:00.000Z"));
      const updateMany = vi.fn(async () => ({ count: 0 }));
      const tx = {
        subscriptionJourneyException: { create: vi.fn() },
        subscriptionJourneyJob: { updateMany }
      };
      const repository = new SubscriptionJourneyRepository();

      if (operation === "completeJob") {
        await expect(
          repository.completeJob(tx as never, "job-1", "lease-1")
        ).rejects.toMatchObject({ code: "JOURNEY_LEASE_LOST" });
      } else if (operation === "rescheduleJob") {
        await expect(
          repository.rescheduleJob(tx as never, "job-1", "lease-1", {
            delayMs: 1_000,
            error: { code: "TIMEOUT", message: "Timed out.", retryable: true }
          })
        ).rejects.toMatchObject({ code: "JOURNEY_LEASE_LOST" });
      } else {
        await expect(
          repository.deadLetterJob(tx as never, {
            error: { code: "FAILED", message: "Failed.", retryable: false },
            jobId: "job-1",
            journeyId: "journey-1",
            leaseToken: "lease-1",
            stepId: "step-1"
          })
        ).rejects.toMatchObject({ code: "JOURNEY_LEASE_LOST" });
      }

      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            leaseExpiresAt: { gt: new Date("2026-08-06T00:00:00.000Z") }
          })
        })
      );
    }
  );

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

  it.each([
    { rawBody: "callback" },
    { providerResponse: { status: "ok" } },
    { headers: { authorization: "Bearer value" } },
    { customer: { idCard: "310101199001011234" } }
  ])("rejects raw provider and identity containers: %j", async (payload) => {
    const upsert = vi.fn();
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.enqueueJob(
        { subscriptionJourneyJob: { upsert } } as never,
        {
          jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
          journeyId: "journey-1",
          payload,
          sourceKey: "unsafe-container",
          stepId: "step-1"
        }
      )
    ).rejects.toMatchObject({ code: "JOURNEY_SENSITIVE_PAYLOAD" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    "Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature",
    '{"provider":"fadada","raw":"callback body"}',
    "customer card 6222021234567890",
    "customer mobile 13800138000"
  ])("rejects credential and payment/identity strings: %s", async (value) => {
    const upsert = vi.fn();
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.enqueueJob(
        { subscriptionJourneyJob: { upsert } } as never,
        {
          jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
          journeyId: "journey-1",
          payload: { value },
          sourceKey: "unsafe-string",
          stepId: "step-1"
        }
      )
    ).rejects.toMatchObject({ code: "JOURNEY_SENSITIVE_PAYLOAD" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("stores a bounded generic failure instead of a raw provider response", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const repository = new SubscriptionJourneyRepository();

    await repository.rescheduleJob(
      { subscriptionJourneyJob: { updateMany } } as never,
      "job-1",
      "lease-1",
      {
        delayMs: 1_000,
        error: {
          code: "provider-http-500/body",
          message:
            'Bearer abc.def.ghi {"customerPhone":"13800138000","rawBody":"provider callback"}',
          retryable: true
        }
      }
    );

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastErrorCode: "PROVIDER_HTTP_500_BODY",
          lastErrorMessage: "Journey operation failed."
        })
      })
    );
  });

  it("rejects a persisted journey/step mismatch before completing", async () => {
    const step = journeyStep();
    const tx = completeStepTransaction(
      step,
      new Map(),
      {
        currentStepCode: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION
      } as never
    );
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.completeStep(tx as never, {
        eventKey: "mismatched-step",
        expectedVersion: 0,
        journeyId: step.journeyId,
        stepId: step.id
      })
    ).rejects.toMatchObject({ code: "JOURNEY_INVALID_TRANSITION" });
    expect(tx.subscriptionJourney.updateMany).not.toHaveBeenCalled();
  });

  it("derives manual task type from the locked persisted step", async () => {
    const step = journeyStep({
      code: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION
    });
    const tx = completeStepTransaction(step, new Map());
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.openManualTask(tx as never, {
        inputSnapshot: { planRevision: 2 },
        journeyId: step.journeyId,
        stepCode: SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION,
        stepId: step.id
      } as never)
    ).rejects.toMatchObject({ code: "JOURNEY_INVALID_TRANSITION" });
    expect(tx.subscriptionJourneyManualTask.create).not.toHaveBeenCalled();
  });

  it("returns the committed waiting step for an exact event retry", async () => {
    const step = journeyStep({
      code: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
      status: "WAITING_CUSTOMER"
    } as never);
    const payload = { planRevision: 3 };
    const events = new Map<string, never>([
      [
        "customer:waiting:retry",
        {
          eventKey: "customer:waiting:retry",
          eventType: SubscriptionJourneyEventType.STEP_WAITING_CUSTOMER,
          journeyId: step.journeyId,
          payload: {
            operation: "WAIT_FOR_CUSTOMER",
            payload,
            stepId: step.id
          }
        } as never
      ]
    ]);
    const tx = completeStepTransaction(step, events);
    const repository = new SubscriptionJourneyRepository();

    const result = await repository.waitForCustomer(tx as never, {
      eventKey: "customer:waiting:retry",
      expectedVersion: 1,
      journeyId: step.journeyId,
      payload,
      stepId: step.id
    } as never);

    expect(result).toEqual(step);
    expect(tx.subscriptionJourney.updateMany).not.toHaveBeenCalled();
    expect(tx.subscriptionJourneyEvent.create).not.toHaveBeenCalled();
  });

  it("rejects reuse of a waiting event key for another step", async () => {
    const step = journeyStep({
      code: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION
    });
    const events = new Map<string, never>([
      [
        "customer:waiting:conflict",
        {
          eventKey: "customer:waiting:conflict",
          eventType: SubscriptionJourneyEventType.STEP_WAITING_CUSTOMER,
          journeyId: "another-journey",
          payload: {
            operation: "WAIT_FOR_CUSTOMER",
            payload: { planRevision: 3 },
            stepId: "another-step"
          }
        } as never
      ]
    ]);
    const tx = completeStepTransaction(step, events);
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.waitForCustomer(tx as never, {
        eventKey: "customer:waiting:conflict",
        expectedVersion: 1,
        journeyId: step.journeyId,
        payload: { planRevision: 3 },
        stepId: step.id
      } as never)
    ).rejects.toMatchObject({ code: "JOURNEY_IDEMPOTENCY_CONFLICT" });
    expect(tx.subscriptionJourney.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a journey start event key owned by another application", async () => {
    const existing = journey({ applicationId: "application-existing" });
    const upsert = vi.fn(async () => journey({ applicationId: "application-new" }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      subscriptionJourney: { upsert },
      subscriptionJourneyEvent: {
        findUnique: vi.fn(async () => ({
          eventKey: "application:start:shared",
          eventType: SubscriptionJourneyEventType.JOURNEY_STARTED,
          journey: existing,
          journeyId: existing.id,
          payload: { applicationId: existing.applicationId }
        })),
        upsert: vi.fn(async (input) => input.create)
      },
      subscriptionJourneyOutbox: {
        upsert: vi.fn(async (input) => input.create)
      }
    };
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.createOrGetForApplication(
        tx as never,
        "application-new",
        "application:start:shared"
      )
    ).rejects.toMatchObject({ code: "JOURNEY_IDEMPOTENCY_CONFLICT" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a job source key owned by another journey contract", async () => {
    const existing = journeyJob({
      journeyId: "journey-existing",
      stepId: "step-existing"
    } as never);
    const upsert = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async () => []),
      subscriptionJourneyJob: {
        findUnique: vi.fn(async () => existing),
        upsert
      }
    };
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.enqueueJob(tx as never, {
        jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
        journeyId: "journey-new",
        payload: { applicationId: "application-new" },
        sourceKey: existing.sourceKey,
        stepId: "step-new"
      })
    ).rejects.toMatchObject({ code: "JOURNEY_IDEMPOTENCY_CONFLICT" });
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
  eventRows: Map<string, { journeyId: string }>,
  journeyOverrides: Partial<ReturnType<typeof journey>> = {}
) {
  const currentJourney = journey({
    currentStepCode: step.code,
    currentStepStatus: step.status,
    id: step.journeyId,
    ...journeyOverrides
  } as never);
  return {
    $queryRaw: vi.fn(async () => [
      {
        journeyId: currentJourney.id,
        journeyStatus: currentJourney.status,
        journeyVersion: currentJourney.version,
        currentStepCode: currentJourney.currentStepCode,
        currentStepStatus: currentJourney.currentStepStatus,
        stepCode: step.code,
        stepId: step.id,
        stepStatus: step.status
      }
    ]),
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
    subscriptionJourneyManualTask: {
      create: vi.fn(async (input) => ({ id: "manual-task-1", ...input.data }))
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
