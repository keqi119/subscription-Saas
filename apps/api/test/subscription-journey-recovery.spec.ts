import { SubscriptionJourneyStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";
import { VehicleAvailabilityPurpose } from "../src/asset-operations/vehicle-availability";
import { OrderService } from "../src/order/order.service";

describe("SubscriptionJourneyService recovery", () => {
  it("uses the indexed Journey relation only when the Orders exception filter is supplied", async () => {
    const findMany = vi.fn(async () => []);
    const service = new OrderService(
      { write: vi.fn() } as never,
      { subscriptionOrder: { findMany } } as never
    );
    const user = {
      id: "user-1",
      menus: [],
      name: "Admin",
      permissions: [],
      roles: ["ADMIN"],
      username: "admin"
    };

    await service.listOrders(user, { journeyStatus: "EXCEPTION" });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          subscriptionJourney: { is: { status: "EXCEPTION" } }
        }
      })
    );

    await service.listOrders(user);
    const secondCall = findMany.mock.calls[1] as unknown as [
      { where: Record<string, unknown> }
    ];
    expect(secondCall[0].where).toEqual({ deletedAt: null });
  });

  it("pauses with optimistic versioning and writes audit in the same transaction", async () => {
    const harness = createRecoveryHarness();

    await harness.service.pauseJourney(
      "journey-1",
      { reason: "operator investigation", version: 3 },
      harness.user,
      harness.context
    );

    expect(harness.state.status).toBe(SubscriptionJourneyStatus.PAUSED);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "subscription_journey" }),
      harness.tx
    );
  });

  it("rejects a stale recovery version before mutating journey state", async () => {
    const harness = createRecoveryHarness();

    await expect(
      harness.service.pauseJourney(
        "journey-1",
        { reason: "stale browser tab", version: 2 },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("JOURNEY_OPTIMISTIC_LOCK_CONFLICT");

    expect(harness.tx.subscriptionJourney.updateMany).not.toHaveBeenCalled();
    expect(harness.auditService.write).not.toHaveBeenCalled();
  });

  it("rechecks authoritative facts and re-enqueues the current step when resuming", async () => {
    const harness = createRecoveryHarness({
      activation: true,
      pausedFromStatus: SubscriptionJourneyStatus.RUNNING,
      status: SubscriptionJourneyStatus.PAUSED
    });

    await harness.service.resumeJourney(
      "journey-1",
      { reason: "facts repaired", version: 3 },
      harness.user,
      harness.context
    );

    expect(harness.tx.application.findUnique).toHaveBeenCalledWith({
      select: { id: true },
      where: { id: "application-1" }
    });
    expect(harness.repository.enqueueJob).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        journeyId: "journey-1",
        payload: expect.objectContaining({
          finalPlanRevision: 4,
          orderId: "order-1"
        }),
        sourceKey: "journey:journey-1:resume:4",
        stepId: "step-1"
      })
    );
    expect(harness.state.status).toBe(SubscriptionJourneyStatus.RUNNING);
  });

  it("retries only a DEAD_LETTER job backed by an OPEN exception", async () => {
    const harness = createRecoveryHarness({ status: SubscriptionJourneyStatus.EXCEPTION });

    await harness.service.retryJourney(
      "journey-1",
      { reason: "configuration repaired", version: 3 },
      harness.user,
      harness.context
    );

    expect(harness.tx.subscriptionJourneyJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "RETRY_SCHEDULED" }) })
    );
    expect(harness.tx.subscriptionJourneyException.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "RESOLVED" }) })
    );
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({
          applicationId: "application-1",
          journeyId: "journey-1",
          operation: "RETRY"
        }),
        entityId: "application-1",
        entityType: "subscription_journey"
      }),
      harness.tx
    );
  });

  it("rejects retry when the exception is not open", async () => {
    const harness = createRecoveryHarness({ exceptionOpen: false, status: SubscriptionJourneyStatus.EXCEPTION });

    await expect(
      harness.service.retryJourney(
        "journey-1",
        { reason: "retry", version: 3 },
        harness.user,
        harness.context
      )
    ).rejects.toThrow();
    expect(harness.tx.subscriptionJourneyJob.update).not.toHaveBeenCalled();
  });

  it("does not allow ordinary cancellation after the contract is archived", async () => {
    const harness = createRecoveryHarness({ archivedContract: true });

    await expect(
      harness.service.cancelJourney(
        "journey-1",
        { reason: "customer request", version: 3 },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("JOURNEY_CONTRACT_TERMINATION_REQUIRED");
    expect(harness.tx.subscriptionJourney.updateMany).not.toHaveBeenCalled();
  });

  it("cancels pre-order facts and releases only the application-owned soft reservation", async () => {
    const harness = createRecoveryHarness({ softReservedVehicleId: "vehicle-1" });

    await harness.service.cancelJourney(
      "journey-1",
      { reason: "customer withdrew", version: 3 },
      harness.user,
      harness.context
    );

    expect(harness.tx.vehicle.updateMany).toHaveBeenCalledWith({
      data: { status: "AVAILABLE", updatedBy: "user-1" },
      where: { id: "vehicle-1", status: "REVIEW_RESERVED" }
    });
    expect(harness.assetOperationsService.assertVehicleAvailable).toHaveBeenCalledWith(
      harness.tx,
      "vehicle-1",
      VehicleAvailabilityPurpose.MARK_AVAILABLE,
      expect.any(Date),
      "AVAILABLE"
    );
    expect(harness.tx.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          softReservedVehicleId: null,
          status: "CANCELLED"
        }),
        where: { id: "application-1" }
      })
    );
    expect(harness.state.status).toBe(SubscriptionJourneyStatus.CANCELLED);
    expect(harness.auditService.write).toHaveBeenCalled();
  });

  it("guards a post-order vehicle release before writing order cancellation facts", async () => {
    const harness = createRecoveryHarness({ postOrder: true });
    harness.assetOperationsService.assertVehicleAvailable.mockRejectedValueOnce(
      new Error("VEHICLE_OPERATIONALLY_RESTRICTED")
    );

    await expect(
      harness.service.cancelJourney(
        "journey-1",
        { reason: "customer withdrew", version: 3 },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("VEHICLE_OPERATIONALLY_RESTRICTED");

    expect(harness.tx.subscriptionOrder.update).not.toHaveBeenCalled();
    expect(harness.tx.contract.updateMany).not.toHaveBeenCalled();
    expect(harness.tx.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it("excludes customer-waiting work from the automated failure denominator", async () => {
    const firstOccurredAt = new Date("2026-08-01T00:00:00.000Z");
    const stepCount = vi.fn()
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(2);
    const prisma = {
      subscriptionJourney: {
        groupBy: vi.fn(async () => [{ _count: { _all: 4 }, status: "RUNNING" }])
      },
      subscriptionJourneyException: {
        findFirst: vi.fn(async () => ({ firstOccurredAt }))
      },
      subscriptionJourneyJob: {
        aggregate: vi.fn(async () => ({ _sum: { attemptCount: 6 } }))
      },
      subscriptionJourneyStep: {
        count: stepCount,
        groupBy: vi.fn(async () => [
          { _count: { _all: 3 }, code: "CUSTOMER_PLAN_CONFIRMATION", status: "WAITING_CUSTOMER" }
        ])
      }
    };
    const service = new SubscriptionJourneyService(
      {} as never,
      prisma as never
    );

    await expect(service.getAdminMetrics()).resolves.toEqual({
      automatedProgressRate: 0.8,
      journeyCounts: { RUNNING: 4 },
      oldestOpenExceptionAt: firstOccurredAt,
      retryCount: 6,
      stepCounts: [
        { code: "CUSTOMER_PLAN_CONFIRMATION", count: 3, status: "WAITING_CUSTOMER" }
      ]
    });
    expect(stepCount.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["EXCEPTION", "RETRY_SCHEDULED"] }
        })
      })
    );
  });

  it("returns an allowlisted projection without raw callbacks, secrets, or exception text", async () => {
    const row = {
      ...adminJourneyRow(),
      application: {
        ...adminJourneyRow().application,
        applicationSource: "SELF_SERVICE",
        finalPlanSnapshot: {
          vehicleSnapshot: {
            brand: "NIO",
            model: "ES6",
            plateNo: "沪DGU578",
            vehicleNo: "VEH20260807061849KRNM",
            vin: "VIN-1"
          }
        },
        finalVehicleId: "vehicle-1",
        softReservedVehicleId: "vehicle-1"
      }
    };
    const findUnique = vi.fn(async (query: unknown) => {
      const select = (query as {
        include: { application: { select: Record<string, boolean> } };
      }).include.application.select;
      return {
        ...row,
        application: Object.fromEntries(
          Object.keys(select).map((key) => [key, row.application[key as keyof typeof row.application]])
        )
      };
    });
    const service = new SubscriptionJourneyService(
      {} as never,
      {
        subscriptionJourney: { findUnique }
      } as never
    );

    const projection = await service.getByApplication("application-1", {
      id: "user-1",
      menus: [],
      name: "Admin",
      permissions: ["subscription_journey:view"],
      roles: [],
      username: "admin"
    });
    const serialized = JSON.stringify(projection);

    expect(serialized).toContain("order-1");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("raw callback body");
    expect(serialized).not.toContain("customer-phone");
    expect(serialized).not.toContain("provider stack trace");
    expect(projection.exceptions[0]?.message).toBe("Journey operation failed.");
    expect(projection.application).toMatchObject({
      applicationSource: "SELF_SERVICE",
      finalVehicleId: "vehicle-1",
      softReservedVehicleId: "vehicle-1"
    });
    expect(projection.application.finalPlanSnapshot).toEqual(row.application.finalPlanSnapshot);
  });

  it("binds an evidence decision to the exact reviewed manifest", async () => {
    const manifestHash = "a".repeat(64);
    const journey = {
      ...adminJourneyRow(),
      currentStepCode: "DELIVERY_EVIDENCE_DECISION",
      currentStepStatus: "WAITING_OPERATOR",
      steps: [
        {
          ...adminJourneyRow().steps[0],
          code: "DELIVERY_EVIDENCE_DECISION",
          status: "WAITING_OPERATOR"
        }
      ]
    };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      subscriptionJourney: { findUnique: vi.fn(async () => journey) }
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx))
    };
    const handover = {
      decideJourneyDeliveryEvidence: vi.fn(async () => ({
        id: "0798f776-261b-4a73-818b-d822f2315c89",
        orderId: "order-1"
      }))
    };
    const audit = { write: vi.fn(async () => undefined) };
    const service = new SubscriptionJourneyService(
      {} as never,
      prisma as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      handover as never,
      undefined,
      audit as never
    );
    const user = {
      id: "user-1",
      menus: [],
      name: "Admin",
      permissions: [],
      roles: ["ADMIN"],
      username: "admin"
    };

    await service.decideDeliveryEvidence(
      "journey-1",
      {
        decision: "APPROVED",
        manifestHash,
        version: 3,
        workOrderId: "0798f776-261b-4a73-818b-d822f2315c89"
      },
      user,
      { ipAddress: "127.0.0.1", userAgent: "vitest" }
    );

    expect(handover.decideJourneyDeliveryEvidence).toHaveBeenCalledWith(
      tx,
      "0798f776-261b-4a73-818b-d822f2315c89",
      "APPROVED",
      "user-1",
      undefined,
      manifestHash
    );
  });
});

function createRecoveryHarness(overrides: Partial<RecoveryState> = {}) {
  const state: RecoveryState = {
    activation: false,
    archivedContract: false,
    exceptionOpen: true,
    pausedFromStatus: null,
    postOrder: false,
    softReservedVehicleId: null,
    status: SubscriptionJourneyStatus.RUNNING,
    version: 3,
    ...overrides
  };
  const journey = () => ({
    applicationId: "application-1",
    application: {
      finalPlanRevision: 4,
      softReservedVehicleId: state.softReservedVehicleId
    },
    currentStepCode: state.activation ? "AUTHORITATIVE_ACTIVATION" : "APPLICATION_VALIDATION",
    currentStepStatus: state.status === "EXCEPTION" ? "EXCEPTION" : "RUNNING",
    id: "journey-1",
    order: state.archivedContract || state.postOrder
      ? { contract: state.archivedContract ? { status: "ARCHIVED" } : null, id: "order-1", vehicleId: "vehicle-1" }
      : null,
    orderId: state.archivedContract || state.activation || state.postOrder ? "order-1" : null,
    pausedFromStatus: state.pausedFromStatus,
    status: state.status,
    steps: [{ code: state.activation ? "AUTHORITATIVE_ACTIVATION" : "APPLICATION_VALIDATION", id: "step-1", status: "RUNNING" }],
    version: state.version
  });
  const tx = {
    $queryRaw: vi.fn(async () => []),
    application: {
      findUnique: vi.fn(async () => ({ id: "application-1" })),
      update: vi.fn(async () => ({}))
    },
    contract: { updateMany: vi.fn(async () => ({ count: 1 })) },
    subscriptionOrder: {
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => ({ deletedAt: null, id: "order-1" })),
      update: vi.fn(async () => ({}))
    },
    subscriptionJourney: {
      findUnique: vi.fn(async () => journey()),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (typeof data.status === "string") state.status = data.status as SubscriptionJourneyStatus;
        if ("pausedFromStatus" in data) {
          state.pausedFromStatus = data.pausedFromStatus as SubscriptionJourneyStatus | null;
        }
        state.version += 1;
        return { count: 1 };
      })
    },
    subscriptionJourneyEvent: { create: vi.fn(async ({ data }) => data), findUnique: vi.fn(async () => null) },
    subscriptionJourneyException: {
      findFirst: vi.fn(async () => state.exceptionOpen ? { id: "exception-1", jobId: "job-1", status: "OPEN" } : null),
      update: vi.fn(async ({ data }) => data)
    },
    subscriptionJourneyJob: {
      findFirst: vi.fn(async () => ({ id: "job-1", status: "DEAD_LETTER" })),
      update: vi.fn(async ({ data }) => data),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    subscriptionJourneyManualTask: { updateMany: vi.fn(async () => ({ count: 1 })) },
    subscriptionJourneyOutbox: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async ({ create }) => create)
    },
    subscriptionJourneyStep: { updateMany: vi.fn(async () => ({ count: 1 })) },
    vehicle: {
      findUnique: vi.fn(async () => ({
        deletedAt: null,
        id: "vehicle-1",
        status: state.postOrder ? "RESERVED" : "REVIEW_RESERVED"
      })),
      updateMany: vi.fn(async () => ({ count: 1 }))
    }
  };
  const prisma = { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
  const auditService = { write: vi.fn(async () => undefined) };
  const repository = { enqueueJob: vi.fn(async () => ({})) };
  const assetOperationsService = {
    assertVehicleAvailable: vi.fn(async () => undefined)
  };
  const service = new SubscriptionJourneyService(
    repository as never,
    prisma as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    auditService as never,
    assetOperationsService as never
  );
  return {
    assetOperationsService,
    auditService,
    context: { ipAddress: "127.0.0.1", userAgent: "vitest" },
    repository,
    service,
    state,
    tx,
    user: {
      id: "user-1",
      menus: [],
      name: "Admin",
      permissions: [],
      roles: ["ADMIN"],
      username: "admin"
    }
  };
}

interface RecoveryState {
  activation: boolean;
  archivedContract: boolean;
  exceptionOpen: boolean;
  pausedFromStatus: SubscriptionJourneyStatus | null;
  postOrder: boolean;
  softReservedVehicleId: string | null;
  status: SubscriptionJourneyStatus;
  version: number;
}

function adminJourneyRow() {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    application: {
      applicationNo: "APP-1",
      customerId: "customer-1",
      finalPlanRevision: 1,
      id: "application-1",
      softReservedVehicleId: null,
      status: "APPROVED"
    },
    applicationId: "application-1",
    cancelledAt: null,
    completedAt: null,
    currentStepCode: "APPLICATION_VALIDATION",
    currentStepStatus: "EXCEPTION",
    events: [
      {
        actorType: "SYSTEM",
        createdAt: now,
        eventType: "STEP_FAILED",
        id: "event-1",
        payload: {
          accessToken: "provider-secret",
          callback: "raw callback body",
          orderId: "order-1"
        },
        sequence: 1
      }
    ],
    exceptions: [
      {
        code: "UPSTREAM_ERROR",
        firstOccurredAt: now,
        id: "exception-1",
        lastOccurredAt: now,
        message: "provider stack trace",
        occurrenceCount: 1,
        retryable: true,
        status: "OPEN"
      }
    ],
    id: "journey-1",
    jobs: [
      {
        attemptCount: 1,
        availableAt: now,
        id: "job-1",
        jobType: "VALIDATE_APPLICATION",
        lastErrorCode: "UPSTREAM_ERROR",
        lastErrorMessage: "provider stack trace",
        payload: { token: "provider-secret" },
        status: "DEAD_LETTER"
      }
    ],
    manualTasks: [
      {
        createdAt: now,
        id: "task-1",
        inputSnapshot: { mobile: "customer-phone", vehicleId: "vehicle-1" },
        status: "OPEN",
        taskType: "FINAL_PLAN_DECISION",
        version: 0
      }
    ],
    order: {
      contract: null,
      id: "order-1",
      orderNo: "ORD-1",
      orderStatus: "CREATED",
      vehicleId: "vehicle-1"
    },
    orderId: "order-1",
    pausedFromStatus: null,
    startedAt: now,
    status: "EXCEPTION",
    steps: [
      {
        attemptCount: 1,
        code: "APPLICATION_VALIDATION",
        completedAt: null,
        createdAt: now,
        id: "step-1",
        lastErrorCode: "UPSTREAM_ERROR",
        startedAt: now,
        status: "EXCEPTION",
        waitingAt: null
      }
    ],
    version: 3
  };
}
