import {
  ContractStatus,
  ESignTaskStatus,
  SubscriptionJourneyEventType,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStepCode
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionJourneyHandlers } from "../src/subscription-journey/subscription-journey.handlers";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";
import type {
  ClaimedJourneyJob,
  ClaimedJourneyOutbox
} from "../src/subscription-journey/subscription-journey.types";

describe("subscription journey Fadada signing", () => {
  it("starts one production task, schedules reconciliation, and never returns the sign URL", async () => {
    const tx = signingTransaction();
    const prisma = transactionHost(tx);
    const repository = { enqueueJob: vi.fn(async () => undefined) };
    const esignService = {
      startJourneyFadadaSigning: vi.fn(async () => ({
        id: "task-1",
        providerTaskId: "provider-transaction-1",
        signUrl: "https://sign.example.test/secret",
        taskStatus: ESignTaskStatus.WAITING_CUSTOMER
      }))
    };
    const service = journeyService({ esignService, prisma, repository });

    const result = await service.startFadadaSigningJob(signingJob());

    expect(result).toEqual({
      action: "FADADA_SIGNING_STARTED",
      contractId: "contract-1",
      taskId: "task-1",
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER
    });
    expect(JSON.stringify(result)).not.toContain("sign.example.test");
    expect(esignService.startJourneyFadadaSigning).toHaveBeenCalledWith(
      "contract-1",
      "00000000-0000-4000-8000-000000000001"
    );
    expect(repository.enqueueJob).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        jobType: SubscriptionJourneyJobType.RECONCILE_FADADA_SIGNING,
        journeyId: "journey-1",
        maxAttempts: 100,
        payload: {
          contractId: "contract-1",
          orderId: "order-1",
          taskId: "task-1"
        },
        sourceKey:
          "journey:journey-1:step:FADADA_SIGNING_AND_ARCHIVE:task:task-1:reconcile",
        stepId: "step-fadada"
      })
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("archives a completed task and keeps a pending task retryable", async () => {
    const tx = signingTransaction();
    const completedESign = {
      reconcileJourneyFadadaSigning: vi.fn(async () => ({
        id: "task-1",
        taskStatus: ESignTaskStatus.COMPLETED
      }))
    };
    const archiveService = {
      archiveSignedContract: vi.fn(async () => ({ archived: true }))
    };
    const completed = journeyService({
      archiveService,
      esignService: completedESign,
      prisma: transactionHost(tx),
      repository: {}
    });

    await expect(
      completed.reconcileFadadaSigningJob(
        signingJob({ jobType: SubscriptionJourneyJobType.RECONCILE_FADADA_SIGNING })
      )
    ).resolves.toEqual({
      action: "FADADA_ARTIFACT_ARCHIVED",
      contractId: "contract-1",
      taskId: "task-1"
    });
    expect(archiveService.archiveSignedContract).toHaveBeenCalledWith({
      actorId: "00000000-0000-4000-8000-000000000001",
      taskId: "task-1"
    });

    const pending = journeyService({
      archiveService,
      esignService: {
        reconcileJourneyFadadaSigning: vi.fn(async () => ({
          id: "task-1",
          taskStatus: ESignTaskStatus.SIGNING
        }))
      },
      prisma: transactionHost(tx),
      repository: {}
    });
    await expect(
      pending.reconcileFadadaSigningJob(
        signingJob({ jobType: SubscriptionJourneyJobType.RECONCILE_FADADA_SIGNING })
      )
    ).rejects.toMatchObject({
      code: "JOURNEY_FADADA_SIGNING_PENDING",
      retryable: true
    });
  });

  it("completes the step only from the archived-artifact authority signal", async () => {
    const tx = signingTransaction();
    const repository = {
      completeStep: vi.fn(async () => undefined),
      enqueueJob: vi.fn(async () => undefined),
      enqueueNotificationOutbox: vi.fn(async () => undefined)
    };
    const service = journeyService({ repository });

    await service.dispatchSignalOutbox(
      tx as never,
      signingOutbox("FADADA_TASK_COMPLETED")
    );
    expect(repository.completeStep).not.toHaveBeenCalled();
    expect(repository.enqueueJob).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        jobType: SubscriptionJourneyJobType.RECONCILE_FADADA_SIGNING
      })
    );

    await service.dispatchSignalOutbox(
      tx as never,
      signingOutbox("FADADA_ARTIFACT_ARCHIVED")
    );
    expect(repository.completeStep).toHaveBeenCalledWith(tx, {
      eventKey:
        "journey:journey-1:step:FADADA_SIGNING_AND_ARCHIVE:contract:contract-1:archived",
      expectedVersion: 5,
      journeyId: "journey-1",
      payload: { contractId: "contract-1", taskId: "task-1" },
      stepId: "step-fadada"
    });
  });

  it("routes start and reconcile jobs through implemented handlers", async () => {
    const service = {
      reconcileFadadaSigningJob: vi.fn(async () => ({ action: "ARCHIVED" })),
      startFadadaSigningJob: vi.fn(async () => ({ action: "STARTED" }))
    };
    const handlers = new SubscriptionJourneyHandlers(service as never);

    await expect(handlers.handle(signingJob())).resolves.toEqual({ action: "STARTED" });
    await expect(
      handlers.handle(
        signingJob({ jobType: SubscriptionJourneyJobType.RECONCILE_FADADA_SIGNING })
      )
    ).resolves.toEqual({ action: "ARCHIVED" });
  });
});

function journeyService(input: {
  archiveService?: unknown;
  esignService?: unknown;
  prisma?: unknown;
  repository: unknown;
}) {
  return new SubscriptionJourneyService(
    input.repository as never,
    input.prisma as never,
    {} as never,
    {} as never,
    {} as never,
    input.esignService as never,
    input.archiveService as never
  );
}

function signingTransaction() {
  return {
    subscriptionJourney: {
      findUnique: vi.fn(async () => ({
        application: {
          finalPlanRevision: 1,
          salesUserId: "00000000-0000-4000-8000-000000000001"
        },
        applicationId: "application-1",
        currentStepCode: SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
        id: "journey-1",
        order: {
          contract: {
            id: "contract-1",
            status: ContractStatus.GENERATED
          },
          contractId: "contract-1",
          id: "order-1"
        },
        orderId: "order-1",
        steps: [
          {
            code: SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
            id: "step-fadada"
          }
        ],
        version: 5
      }))
    }
  };
}

function transactionHost(tx: unknown) {
  return {
    $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(tx))
  };
}

function signingJob(
  overrides: Partial<ClaimedJourneyJob> = {}
): ClaimedJourneyJob {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    completedAt: null,
    createdAt: now,
    id: "job-fadada",
    jobType: SubscriptionJourneyJobType.START_FADADA_SIGNING,
    journeyId: "journey-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date("2026-08-06T00:02:00.000Z"),
    leaseToken: "lease-fadada",
    maxAttempts: 100,
    payload: { contractId: "contract-1", orderId: "order-1" },
    sourceKey:
      "journey:journey-1:step:FADADA_SIGNING_AND_ARCHIVE:revision:1",
    status: SubscriptionJourneyJobStatus.PROCESSING,
    stepId: "step-fadada",
    updatedAt: now,
    ...overrides
  };
}

function signingOutbox(
  signalType: "FADADA_ARTIFACT_ARCHIVED" | "FADADA_TASK_COMPLETED"
): ClaimedJourneyOutbox {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    aggregateId: "order-1",
    aggregateType: "SUBSCRIPTION_JOURNEY",
    attemptCount: 0,
    availableAt: now,
    createdAt: now,
    deliveredAt: null,
    eventKey: `journey:journey-1:${signalType.toLowerCase()}`,
    eventType: SubscriptionJourneyEventType.DOMAIN_FACT_OBSERVED,
    id: `outbox-${signalType.toLowerCase()}`,
    journeyId: "journey-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date("2026-08-06T00:02:00.000Z"),
    leaseToken: "lease-outbox",
    payload: {
      contractId: "contract-1",
      signalType,
      taskId: "task-1"
    },
    status: "PROCESSING",
    updatedAt: now
  } as ClaimedJourneyOutbox;
}
