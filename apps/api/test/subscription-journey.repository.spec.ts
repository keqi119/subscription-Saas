import { ConfigService } from "@nestjs/config";
import {
  SubscriptionJourneyEventType,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyManualDecision,
  SubscriptionJourneyStatus,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SubscriptionJourneyRepository } from "../src/subscription-journey/subscription-journey.repository";
import { SubscriptionJourneyRuntimeConfig } from "../src/subscription-journey/subscription-journey.config";
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

  it("writes one terminal JOURNEY_COMPLETED event and outbox row on activation retries", async () => {
    const step = journeyStep({
      code: SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION
    });
    const events = new Map<string, { journeyId: string }>();
    const tx = completeStepTransaction(step, events);
    const repository = new SubscriptionJourneyRepository();
    const input = {
      expectedVersion: 0,
      journeyId: step.journeyId,
      payload: { leaseId: "lease-1", orderId: "order-1" },
      stepId: step.id
    };

    await repository.completeActivation(tx as never, input);
    await repository.completeActivation(tx as never, input);

    expect(
      [...events.values()].filter(
        (event) =>
          (event as { eventType?: string }).eventType ===
          SubscriptionJourneyEventType.JOURNEY_COMPLETED
      )
    ).toHaveLength(1);
    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.subscriptionJourneyEvent.create).toHaveBeenCalledTimes(2);
    expect(tx.subscriptionJourneyOutbox.upsert).toHaveBeenCalledTimes(2);
  });

  it("persists an activation operational-clearance wait without completing the step", async () => {
    const step = journeyStep({
      code: SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION
    });
    const tx = completeStepTransaction(step, new Map(), {
      currentStepCode: SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION,
      currentStepStatus: SubscriptionJourneyStepStatus.RUNNING,
      status: SubscriptionJourneyStatus.RUNNING,
      version: 5
    } as never);
    const repository = new SubscriptionJourneyRepository();

    await repository.pauseForOperationalRestriction(tx as never, {
      expectedVersion: 5,
      journeyId: step.journeyId,
      reasons: [{ code: "ACTIVE_OPERATIONAL_RESTRICTION", restrictionId: "restriction-1" }],
      stepId: step.id
    });

    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledWith({
      data: {
        pausedFromStatus: SubscriptionJourneyStatus.RUNNING,
        status: SubscriptionJourneyStatus.PAUSED,
        version: { increment: 1 }
      },
      where: { id: step.journeyId, version: 5 }
    });
    expect(tx.subscriptionJourneyStep.update).not.toHaveBeenCalled();
    expect(tx.subscriptionJourneyEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: SubscriptionJourneyEventType.JOURNEY_PAUSED,
          sequence: 6
        })
      })
    );
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
      application: {
        findUnique: vi.fn(async () => ({ customerId: "customer-1" }))
      },
      subscriptionJourney: {
        findUnique: vi.fn(async () => null),
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
      new SubscriptionJourneyRepository(),
      enabledJourneyConfig()
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
      $queryRaw: vi.fn(async () => [{ acquired: true }]),
      subscriptionJourney: {
        findFirst: vi.fn(async () => currentJourney),
        findUnique: vi.fn(async () => currentJourney),
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
      new SubscriptionJourneyRepository(),
      enabledJourneyConfig()
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

  it("opens a manual task once and moves the journey to WAITING_MANUAL", async () => {
    const step = journeyStep({
      code: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION
    });
    const tx = completeStepTransaction(step, new Map());
    const repository = new SubscriptionJourneyRepository();
    const input = {
      inputSnapshot: { applicationId: randomUUID(), finalPlanRevision: 0 },
      journeyId: step.journeyId,
      stepId: step.id
    };

    const first = await repository.openManualTask(tx as never, input);
    const second = await repository.openManualTask(tx as never, input);

    expect(second).toEqual(first);
    expect(tx.subscriptionJourneyManualTask.create).toHaveBeenCalledOnce();
    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledOnce();
    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledWith({
      data: {
        currentStepCode: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION,
        currentStepStatus: "WAITING_MANUAL",
        status: "WAITING_MANUAL",
        version: { increment: 1 }
      },
      where: { id: step.journeyId, version: 0 }
    });
    expect(tx.subscriptionJourneyStep.update).toHaveBeenCalledOnce();
    expect(tx.subscriptionJourneyEvent.create).toHaveBeenCalledOnce();
    expect(tx.subscriptionJourneyOutbox.upsert).toHaveBeenCalledOnce();
  });

  it("completes vehicle allocation and returns to customer confirmation for revised terms", async () => {
    const step = journeyStep({
      code: SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION
    });
    const tx = completeStepTransaction(step, new Map(), { version: 3 } as never);
    const customerStep = journeyStep({
      code: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
      id: "step-customer-confirmation"
    });
    tx.subscriptionJourneyStep.upsert = vi.fn(async () => customerStep) as never;
    const repository = new SubscriptionJourneyRepository();

    await repository.returnToCustomerConfirmation(tx as never, {
      eventKey: "journey:journey-1:vehicle:revision:2:reconfirmation",
      expectedVersion: 3,
      journeyId: step.journeyId,
      payload: { finalPlanRevision: 2, vehicleId: randomUUID() },
      vehicleStepId: step.id
    });

    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledWith({
      data: {
        currentStepCode: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
        currentStepStatus: "WAITING_CUSTOMER",
        status: "WAITING_CUSTOMER",
        version: { increment: 1 }
      },
      where: { id: step.journeyId, version: 3 }
    });
    expect(tx.subscriptionJourneyStep.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED" })
      })
    );
    expect(tx.subscriptionJourneyEvent.create).toHaveBeenCalledOnce();
    expect(tx.subscriptionJourneyOutbox.upsert).toHaveBeenCalledOnce();
  });

  it("returns a rejected delivery decision to handover preparation without opening a duplicate task", async () => {
    const decisionStep = journeyStep({
      code: SubscriptionJourneyStepCode.DELIVERY_EVIDENCE_DECISION,
      id: "step-delivery-decision"
    });
    const tx = completeStepTransaction(
      decisionStep,
      new Map(),
      { version: 11 } as never
    );
    const handoverStep = journeyStep({
      code: SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION,
      id: "step-handover"
    });
    tx.subscriptionJourneyStep.upsert = vi.fn(async () => handoverStep) as never;
    const repository = new SubscriptionJourneyRepository();

    await repository.returnToHandoverEvidence(tx as never, {
      decisionStepId: decisionStep.id,
      eventKey: "journey:journey-1:delivery-review:rejected",
      expectedVersion: 11,
      journeyId: decisionStep.journeyId,
      payload: {
        decision: SubscriptionJourneyManualDecision.REJECTED,
        manifestHash: "a".repeat(64),
        workOrderId: "work-order-1"
      }
    });

    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledWith({
      data: {
        currentStepCode:
          SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION,
        currentStepStatus: "RUNNING",
        status: "RUNNING",
        version: { increment: 1 }
      },
      where: { id: decisionStep.journeyId, version: 11 }
    });
    expect(tx.subscriptionJourneyStep.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          completedAt: null,
          status: "PENDING",
          waitingAt: null
        })
      })
    );
    expect(tx.subscriptionJourneyManualTask.create).not.toHaveBeenCalled();
    expect(tx.subscriptionJourneyEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: SubscriptionJourneyEventType.MANUAL_TASK_DECIDED
      })
    });
  });

  it("skips a completed vehicle step after revised-plan reconfirmation", async () => {
    const step = journeyStep({
      code: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION
    });
    const tx = completeStepTransaction(step, new Map(), { version: 4 } as never);
    tx.subscriptionJourneyStep.findUnique.mockResolvedValueOnce({
      ...journeyStep({
        code: SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION,
        id: "step-vehicle"
      }),
      status: "COMPLETED"
    } as never);
    const repository = new SubscriptionJourneyRepository();

    await repository.completeStep(tx as never, {
      eventKey: "journey:journey-1:customer:revision:2:completed",
      expectedVersion: 4,
      journeyId: step.journeyId,
      payload: { finalPlanRevision: 2 },
      stepId: step.id
    });

    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentStepCode: SubscriptionJourneyStepCode.ORDER_AND_CONTRACT_CREATION
        })
      })
    );
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
      expect(sql).toContain(
        index === 0
          ? "FOR UPDATE OF job SKIP LOCKED"
          : "FOR UPDATE SKIP LOCKED"
      );
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
    expect(queries[0]?.strings.join(" ")).toContain(
      "journey.\"status\" NOT IN ('PAUSED', 'CANCELLED', 'COMPLETED')"
    );
    expect(tx.subscriptionJourneyJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ leaseToken: expect.any(String) })
      })
    );
  });

  it("keeps signal and notification outbox claims disjoint", async () => {
    const queries: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async (query: { strings: readonly string[] }) => {
        queries.push(query.strings.join(" "));
        return [];
      })
    };
    const repository = new SubscriptionJourneyRepository();

    await repository.claimSignalOutbox(tx as never, 10, 120_000);
    await repository.claimNotificationOutbox(tx as never, 10, 120_000);

    expect(queries[0]).toContain(`"aggregate_type" <> 'JOURNEY_NOTIFICATION'`);
    expect(queries[1]).toContain(`"aggregate_type" = 'JOURNEY_NOTIFICATION'`);
  });

  it.each(["completeOutbox", "rescheduleOutbox", "deadLetterOutbox"] as const)(
    "requires an unexpired outbox lease for %s",
    async (operation) => {
      const executeRaw = vi
        .fn<(query: unknown) => Promise<number>>()
        .mockResolvedValue(0);
      const repository = new SubscriptionJourneyRepository();
      const tx = { $executeRaw: executeRaw };

      const result =
        operation === "completeOutbox"
          ? repository.completeOutbox(tx as never, "outbox-1", "lease-1")
          : operation === "rescheduleOutbox"
            ? repository.rescheduleOutbox(
                tx as never,
                "outbox-1",
                "lease-1",
                {
                  delayMs: 1_000,
                  error: {
                    code: "TIMEOUT",
                    message: "Timed out.",
                    retryable: true
                  }
                }
              )
            : repository.deadLetterOutbox(
                tx as never,
                "outbox-1",
                "lease-1",
                {
                  code: "FAILED",
                  message: "Failed.",
                  retryable: false
                }
              );

      await expect(result).rejects.toMatchObject({ code: "JOURNEY_LEASE_LOST" });
      const query = executeRaw.mock.calls[0]![0] as {
        strings: readonly string[];
        values: readonly unknown[];
      };
      const sql = query.strings.join(" ");
      expect(sql).toContain('UPDATE "subscription_journey_outbox"');
      expect(sql).toContain(`"status" = 'PROCESSING'`);
      expect(sql).toContain(`"lease_expires_at" > clock_timestamp()`);
      expect(query.values).toContain("outbox-1");
      expect(query.values).toContain("lease-1");
    }
  );

  it("derives worker activity and last success from persisted rows", async () => {
    const jobActivityAt = new Date("2026-08-06T01:00:00.000Z");
    const outboxActivityAt = new Date("2026-08-06T02:00:00.000Z");
    const eventAt = new Date("2026-08-06T03:00:00.000Z");
    const successfulJobAt = new Date("2026-08-06T00:30:00.000Z");
    const jobAggregate = vi
      .fn()
      .mockResolvedValueOnce({ _max: { updatedAt: jobActivityAt } })
      .mockResolvedValueOnce({ _max: { completedAt: successfulJobAt } });
    const tx = {
      subscriptionJourneyEvent: {
        aggregate: vi.fn(async () => ({ _max: { createdAt: eventAt } }))
      },
      subscriptionJourneyException: {
        count: vi.fn(async () => 2),
        findFirst: vi.fn(async () => ({
          firstOccurredAt: new Date("2026-08-05T23:00:00.000Z")
        }))
      },
      subscriptionJourneyJob: {
        aggregate: jobAggregate,
        count: vi.fn(async () => 3),
        findFirst: vi.fn(async () => ({
          availableAt: new Date("2026-08-05T22:00:00.000Z")
        }))
      },
      subscriptionJourneyOutbox: {
        aggregate: vi.fn(async () => ({
          _max: { deliveredAt: null, updatedAt: outboxActivityAt }
        })),
        count: vi.fn(async () => 4),
        findFirst: vi.fn(async () => ({
          availableAt: new Date("2026-08-05T21:00:00.000Z")
        }))
      }
    };
    const repository = new SubscriptionJourneyRepository();

    const metrics = await repository.readOperationalMetrics(tx as never);

    expect(jobAggregate).toHaveBeenNthCalledWith(2, {
      _max: { completedAt: true },
      where: { status: SubscriptionJourneyJobStatus.COMPLETED }
    });
    expect(metrics).toMatchObject({
      lastEventAt: eventAt,
      lastSuccessfulJobAt: successfulJobAt,
      openExceptionCount: 2,
      pendingJobCount: 3,
      pendingOutboxCount: 4,
      workerHeartbeatAt: outboxActivityAt
    });
  });

  it("requires the active lease token to complete a job", async () => {
    const tx = {
      $executeRaw: vi.fn(async () => 0)
    };
    const repository = new SubscriptionJourneyRepository();

    await expect(
      repository.completeJob(tx as never, "job-1", "stale-lease", {
        ok: true
      })
    ).rejects.toMatchObject({ code: "JOURNEY_LEASE_LOST" });
  });

  it("preserves the idempotency input payload when completing a job", async () => {
    const executeRaw = vi
      .fn<(query: unknown) => Promise<number>>()
      .mockResolvedValue(1);
    const repository = new SubscriptionJourneyRepository();

    await repository.completeJob(
      { $executeRaw: executeRaw } as never,
      "job-1",
      "lease-1",
      { resultId: "domain-result-1" }
    );

    const query = executeRaw.mock.calls[0]![0] as {
      strings: readonly string[];
      values: readonly unknown[];
    };
    expect(query.strings.join(" ")).not.toContain('"payload"');
    expect(query.values).not.toContain("domain-result-1");
  });

  it.each(["completeJob", "rescheduleJob", "deadLetterJob"] as const)(
    "requires an unexpired lease for %s",
    async (operation) => {
      const executeRaw = vi
        .fn<(query: unknown) => Promise<number>>()
        .mockResolvedValue(0);
      const tx = {
        $executeRaw: executeRaw,
        subscriptionJourneyException: { create: vi.fn() },
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

      const query = executeRaw.mock.calls[0]![0] as {
        strings: readonly string[];
        values: readonly unknown[];
      };
      const sql = query.strings.join(" ");
      expect(sql).toContain('UPDATE "subscription_journey_job"');
      expect(sql).toContain(`"status" = 'PROCESSING'`);
      expect(sql).toContain(`"lease_expires_at" > clock_timestamp()`);
      expect(query.values).toContain("job-1");
      expect(query.values).toContain("lease-1");
    }
  );

  it("schedules retry with a safe error and clears the lease", async () => {
    const executeRaw = vi
      .fn<(query: unknown) => Promise<number>>()
      .mockResolvedValue(1);
    const repository = new SubscriptionJourneyRepository();

    await repository.rescheduleJob(
      { $executeRaw: executeRaw } as never,
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

    const query = executeRaw.mock.calls[0]![0] as {
      strings: readonly string[];
      values: readonly unknown[];
    };
    const sql = query.strings.join(" ");
    expect(sql).toContain(`"status" = 'RETRY_SCHEDULED'`);
    expect(sql).toContain(`"attempt_count" = "attempt_count" + 1`);
    expect(sql).toContain(`clock_timestamp()`);
    expect(sql).toContain(`"lease_expires_at" = NULL`);
    expect(sql).toContain(`"lease_token" = NULL`);
    expect(query.values).toEqual(
      expect.arrayContaining([
        30_000,
        "PROVIDER_TIMEOUT",
        "Provider request failed.",
        "job-1",
        "lease-1"
      ])
    );
  });

  it("dead-letters under the lease and creates a composite-linked exception", async () => {
    const create = vi.fn(async (input) => ({ id: "exception-1", ...input.data }));
    const executeRaw = vi
      .fn<(query: unknown) => Promise<number>>()
      .mockResolvedValue(1);
    const updateStep = vi.fn(async (input) => input.data);
    const updateJourney = vi.fn(async () => ({ count: 1 }));
    const repository = new SubscriptionJourneyRepository();

    await repository.deadLetterJob(
      {
        $executeRaw: executeRaw,
        subscriptionJourney: {
          findUnique: vi.fn(async () => ({
            currentStepCode: SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
            id: "journey-1",
            status: SubscriptionJourneyStatus.RUNNING,
            version: 0
          })),
          updateMany: updateJourney
        },
        subscriptionJourneyException: { create },
        subscriptionJourneyEvent: { create: vi.fn(async (input) => input.data) },
        subscriptionJourneyOutbox: {
          upsert: vi.fn(async (input) => input.create)
        },
        subscriptionJourneyStep: {
          findUnique: vi.fn(async () => ({
            code: SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
            id: "step-1",
            journeyId: "journey-1"
          })),
          update: updateStep
        }
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
    expect(updateStep).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastErrorCode: "SIGNATURE_PROVIDER_FAILED",
          status: SubscriptionJourneyStepStatus.EXCEPTION
        })
      })
    );
    expect(updateJourney).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentStepStatus: SubscriptionJourneyStepStatus.EXCEPTION,
          status: SubscriptionJourneyStatus.EXCEPTION
        }),
        where: { id: "journey-1", version: 0 }
      })
    );
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
    const executeRaw = vi
      .fn<(query: unknown) => Promise<number>>()
      .mockResolvedValue(1);
    const repository = new SubscriptionJourneyRepository();

    await repository.rescheduleJob(
      { $executeRaw: executeRaw } as never,
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

    const query = executeRaw.mock.calls[0]![0] as {
      values: readonly unknown[];
    };
    expect(query.values).toEqual(
      expect.arrayContaining([
        "PROVIDER_HTTP_500_BODY",
        "Journey operation failed."
      ])
    );
  });

  it("does not persist a truncated raw JSON provider error", async () => {
    const executeRaw = vi
      .fn<(query: unknown) => Promise<number>>()
      .mockResolvedValue(1);
    const repository = new SubscriptionJourneyRepository();

    await repository.rescheduleJob(
      { $executeRaw: executeRaw } as never,
      "job-1",
      "lease-1",
      {
        delayMs: 1_000,
        error: {
          code: "PROVIDER_HTTP_500",
          message: JSON.stringify({
            providerResponse: "x".repeat(800)
          }),
          retryable: true
        }
      }
    );

    const query = executeRaw.mock.calls[0]![0] as {
      values: readonly unknown[];
    };
    expect(query.values).toContain("Journey operation failed.");
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

  it("persists an application business wait with reasons and observed fact version", async () => {
    const step = journeyStep();
    const tx = completeStepTransaction(step, new Map());
    const repository = new SubscriptionJourneyRepository();

    await repository.waitForManual(tx as never, {
      eventKey: "application:validation:facts:3:waiting-manual",
      expectedVersion: 0,
      factVersion: 3,
      journeyId: step.journeyId,
      payload: {
        factVersion: 3,
        reasonCodes: ["MATERIAL_REVIEW_PENDING"]
      },
      stepId: step.id
    });

    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledWith({
      data: {
        currentStepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
        currentStepStatus: "WAITING_MANUAL",
        lastApplicationFactVersion: 3,
        status: "WAITING_MANUAL",
        version: { increment: 1 }
      },
      where: { id: step.journeyId, version: 0 }
    });
    expect(tx.subscriptionJourneyStep.update).toHaveBeenCalledWith({
      data: {
        status: "WAITING_MANUAL",
        waitingAt: expect.any(Date),
        waitingReasonSnapshot: {
          factVersion: 3,
          reasonCodes: ["MATERIAL_REVIEW_PENDING"]
        }
      },
      where: { id_journeyId: { id: step.id, journeyId: step.journeyId } }
    });
  });

  it("closes the current step and open tasks for a rejected application", async () => {
    const step = journeyStep();
    const tx = completeStepTransaction(step, new Map());
    const repository = new SubscriptionJourneyRepository();

    await repository.rejectForApplication(tx as never, {
      eventKey: "application:validation:facts:4:rejected",
      expectedVersion: 0,
      factVersion: 4,
      journeyId: step.journeyId,
      payload: { factVersion: 4, reasonCodes: ["CREDIT_REVIEW_REJECTED"] },
      stepId: step.id
    });

    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cancelledAt: expect.any(Date),
        currentStepStatus: "CANCELLED",
        lastApplicationFactVersion: 4,
        status: "CANCELLED",
        version: { increment: 1 }
      }),
      where: { id: step.journeyId, version: 0 }
    });
    expect(tx.subscriptionJourneyManualTask.updateMany).toHaveBeenCalledWith({
      data: { status: "CANCELLED" },
      where: { journeyId: step.journeyId, status: "OPEN" }
    });
    expect(tx.subscriptionJourneyJob.updateMany).toHaveBeenCalledWith({
      data: {
        completedAt: expect.any(Date),
        leaseExpiresAt: null,
        leaseToken: null,
        status: "CANCELLED"
      },
      where: {
        journeyId: step.journeyId,
        status: { notIn: ["COMPLETED", "CANCELLED"] }
      }
    });
    expect(tx.subscriptionJourneyOutbox.updateMany).toHaveBeenCalledWith({
      data: {
        leaseExpiresAt: null,
        leaseToken: null,
        status: "CANCELLED"
      },
      where: {
        journeyId: step.journeyId,
        status: { in: ["PENDING", "PROCESSING"] }
      }
    });
    expect(tx.subscriptionJourneyStep.updateMany).toHaveBeenCalledWith({
      data: { status: "CANCELLED" },
      where: {
        id: { not: step.id },
        journeyId: step.journeyId,
        status: { notIn: ["COMPLETED", "CANCELLED"] }
      }
    });
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
    waitingReasonSnapshot: null,
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
  let manualTask: Record<string, unknown> | null = null;
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
      updateMany: vi.fn(async (input) => {
        if (input.data.currentStepCode !== undefined) {
          currentJourney.currentStepCode = input.data.currentStepCode;
        }
        if (input.data.currentStepStatus !== undefined) {
          currentJourney.currentStepStatus = input.data.currentStepStatus;
        }
        if (input.data.status !== undefined) {
          currentJourney.status = input.data.status;
        }
        if (input.data.version?.increment) {
          currentJourney.version += input.data.version.increment;
        }
        return { count: 1 };
      })
    },
    subscriptionJourneyJob: {
      updateMany: vi.fn(async () => ({ count: 0 }))
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
      updateMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async (input) => input.create)
    },
    subscriptionJourneyManualTask: {
      create: vi.fn(async (input) => {
        manualTask = { id: "manual-task-1", ...input.data };
        return manualTask;
      }),
      findFirst: vi.fn(async () => manualTask),
      updateMany: vi.fn(async () => ({ count: manualTask ? 1 : 0 }))
    },
    subscriptionJourneyStep: {
      findUnique: vi.fn(async () => step),
      upsert: vi.fn(),
      update: vi.fn(async (input) => {
        Object.assign(step, input.data);
        return step;
      }),
      updateMany: vi.fn(async () => ({ count: 0 }))
    }
  };
}

function enabledJourneyConfig() {
  return new SubscriptionJourneyRuntimeConfig(
    new ConfigService({ SUBSCRIPTION_JOURNEY_ENABLED: "true" })
  );
}
