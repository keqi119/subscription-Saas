import {
  SubscriptionJourneyEventType,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyManualDecision,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionJourneyHandlers } from "../src/subscription-journey/subscription-journey.handlers";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";
import { SubscriptionJourneySignalService } from "../src/subscription-journey/subscription-journey-signal.service";
import type {
  ClaimedJourneyJob,
  ClaimedJourneyOutbox
} from "../src/subscription-journey/subscription-journey.types";

describe("subscription journey Stage 2 handover", () => {
  it("creates one source-keyed handover without advancing before evidence is ready", async () => {
    const tx = journeyTransaction(
      SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION,
      "step-handover",
      8
    );
    const repository = {
      completeStep: vi.fn(async () => undefined)
    };
    const handover = {
      createJourneyHandoverInTransaction: vi.fn(async () => ({
        handoverId: "handover-1",
        id: "work-order-1",
        vehicleDeliveryId: "delivery-1"
      }))
    };
    const service = journeyService(tx, repository, handover);
    const job = journeyJob();

    await expect(service.createHandoverJob(job)).resolves.toEqual({
      action: "HANDOVER_CREATED",
      handoverId: "handover-1",
      orderId: "order-1",
      vehicleDeliveryId: "delivery-1",
      workOrderId: "work-order-1"
    });
    expect(handover.createJourneyHandoverInTransaction).toHaveBeenCalledWith(
      tx,
      "order-1",
      "00000000-0000-4000-8000-000000000001",
      job.sourceKey
    );
    expect(repository.completeStep).not.toHaveBeenCalled();
  });

  it("advances to the third manual decision only for an exact evidence-ready signal", async () => {
    const tx = journeyTransaction(
      SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION,
      "step-handover",
      9
    );
    const repository = {
      completeStep: vi.fn(async () => undefined),
      enqueueNotificationOutbox: vi.fn(async () => undefined)
    };
    const service = journeyService(tx, repository, {});
    const outbox = evidenceReadyOutbox();

    await service.dispatchSignalOutbox(tx as never, outbox);

    expect(repository.completeStep).toHaveBeenCalledWith(tx, {
      eventKey:
        "journey:journey-1:handover:work-order-1:ready",
      expectedVersion: 9,
      journeyId: "journey-1",
      payload: {
        handoverId: "handover-1",
        manifestHash: "a".repeat(64),
        workOrderId: "work-order-1"
      },
      stepId: "step-handover"
    });
  });

  it("binds the third manual task to the exact work order and evidence manifest", async () => {
    const tx = journeyTransaction(
      SubscriptionJourneyStepCode.DELIVERY_EVIDENCE_DECISION,
      "step-delivery-decision",
      10
    );
    const repository = {
      enqueueNotificationOutbox: vi.fn(async () => undefined),
      openManualTask: vi.fn(async () => undefined)
    };
    const service = journeyService(tx, repository, {});

    await service.dispatchSignalOutbox(
      tx as never,
      stepCompletedOutbox() as ClaimedJourneyOutbox
    );

    expect(repository.openManualTask).toHaveBeenCalledWith(tx, {
      inputSnapshot: {
        applicationId: "application-1",
        finalPlanRevision: 1,
        handoverId: "handover-1",
        manifestHash: "a".repeat(64),
        workOrderId: "work-order-1"
      },
      journeyId: "journey-1",
      stepId: "step-delivery-decision"
    });
  });

  it("routes CREATE_HANDOVER through an implemented handler", async () => {
    const service = {
      createHandoverJob: vi.fn(async () => ({ action: "HANDOVER_CREATED" }))
    };
    const handlers = new SubscriptionJourneyHandlers(service as never);

    await expect(handlers.handle(journeyJob())).resolves.toEqual({
      action: "HANDOVER_CREATED"
    });
  });
});

describe("subscription journey aggregate delivery-evidence decision", () => {
  it("records approval and completes the third manual task in one transaction", async () => {
    const tx = decisionTransaction();
    const repository = {
      completeStep: vi.fn(async () => undefined),
      decideManualTask: vi.fn(async () => undefined),
      recordSignal: vi.fn(async () => undefined)
    };
    const service = new SubscriptionJourneySignalService(
      repository as never,
      { enabled: true } as never
    );

    await service.completeHandoverEvidenceDecision(tx as never, {
      actorId: "00000000-0000-4000-8000-000000000002",
      decision: SubscriptionJourneyManualDecision.APPROVED,
      manifestHash: "a".repeat(64),
      notes: "approved",
      orderId: "order-1",
      workOrderId: "work-order-1"
    });

    expect(repository.recordSignal).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        orderId: "order-1",
        type: "HANDOVER_OPS_REVIEWED"
      })
    );
    expect(repository.decideManualTask).toHaveBeenCalledWith(tx, {
      decidedBy: "00000000-0000-4000-8000-000000000002",
      decision: SubscriptionJourneyManualDecision.APPROVED,
      decisionNotes: "approved",
      expectedVersion: 0,
      journeyId: "journey-1",
      taskId: "manual-task-3"
    });
    expect(repository.completeStep).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        expectedVersion: 11,
        journeyId: "journey-1",
        stepId: "step-delivery-decision"
      })
    );
  });

  it("treats rejection as an audited business outcome and returns to evidence preparation", async () => {
    const tx = decisionTransaction();
    const repository = {
      decideManualTask: vi.fn(async () => undefined),
      recordSignal: vi.fn(async () => undefined),
      returnToHandoverEvidence: vi.fn(async () => undefined)
    };
    const service = new SubscriptionJourneySignalService(
      repository as never,
      { enabled: true } as never
    );

    await expect(
      service.completeHandoverEvidenceDecision(tx as never, {
        actorId: "00000000-0000-4000-8000-000000000002",
        decision: SubscriptionJourneyManualDecision.REJECTED,
        manifestHash: "a".repeat(64),
        notes: "replace damaged photo",
        orderId: "order-1",
        workOrderId: "work-order-1"
      })
    ).resolves.toBeUndefined();
    expect(repository.returnToHandoverEvidence).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        expectedVersion: 11,
        journeyId: "journey-1",
        decisionStepId: "step-delivery-decision"
      })
    );
  });
});

function journeyService(tx: unknown, repository: unknown, handover: unknown) {
  return new SubscriptionJourneyService(
    repository as never,
    transactionHost(tx) as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    handover as never
  );
}

function journeyTransaction(
  stepCode: SubscriptionJourneyStepCode,
  stepId: string,
  version: number
) {
  return {
    $queryRaw: vi.fn(async () => [{ id: "journey-1" }]),
    subscriptionJourney: {
      findUnique: vi.fn(async () => ({
        application: {
          finalPlanRevision: 1,
          salesUserId: "00000000-0000-4000-8000-000000000001"
        },
        applicationId: "application-1",
        currentStepCode: stepCode,
        currentStepStatus: SubscriptionJourneyStepStatus.RUNNING,
        id: "journey-1",
        orderId: "order-1",
        steps: [
          {
            code: stepCode,
            id: stepId,
            status: SubscriptionJourneyStepStatus.RUNNING
          }
        ],
        version
      }))
    }
  };
}

function decisionTransaction() {
  return {
    subscriptionJourney: {
      findUnique: vi.fn(async () => ({
        currentStepCode: SubscriptionJourneyStepCode.DELIVERY_EVIDENCE_DECISION,
        id: "journey-1",
        manualTasks: [
          {
            id: "manual-task-3",
            inputSnapshot: {
              manifestHash: "a".repeat(64),
              workOrderId: "work-order-1"
            },
            status: "OPEN",
            stepId: "step-delivery-decision",
            version: 0
          }
        ],
        orderId: "order-1",
        steps: [
          {
            code: SubscriptionJourneyStepCode.DELIVERY_EVIDENCE_DECISION,
            id: "step-delivery-decision"
          }
        ],
        version: 10
      }))
    }
  };
}

function transactionHost(tx: unknown) {
  return {
    $transaction: vi.fn(async (operation: (value: unknown) => unknown) =>
      operation(tx)
    )
  };
}

function journeyJob(): ClaimedJourneyJob {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    completedAt: null,
    createdAt: now,
    id: "job-create-handover",
    jobType: SubscriptionJourneyJobType.CREATE_HANDOVER,
    journeyId: "journey-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date("2026-08-06T00:02:00.000Z"),
    leaseToken: "lease-handover",
    maxAttempts: 20,
    payload: {
      finalPlanRevision: 1,
      orderId: "order-1",
      stepCode: SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION
    },
    sourceKey:
      "journey:journey-1:step:HANDOVER_AND_STAGE2_CREATION:revision:1",
    status: SubscriptionJourneyJobStatus.PROCESSING,
    stepId: "step-handover",
    updatedAt: now
  };
}

function evidenceReadyOutbox(): ClaimedJourneyOutbox {
  return outbox({
    eventKey: "handover:work-order-1:ready:aaaaaaaaaaaaaaaa",
    payload: {
      handoverId: "handover-1",
      journeyVersion: 9,
      manifestHash: "a".repeat(64),
      signalType: "HANDOVER_EVIDENCE_READY",
      workOrderId: "work-order-1"
    }
  });
}

function stepCompletedOutbox() {
  return outbox({
    eventKey:
      "journey:journey-1:step:HANDOVER_AND_STAGE2_CREATION:work-order:work-order-1:evidence-ready:outbox",
    eventType: SubscriptionJourneyEventType.STEP_COMPLETED,
    payload: {
      operation: "COMPLETE_STEP",
      payload: {
        handoverId: "handover-1",
        manifestHash: "a".repeat(64),
        workOrderId: "work-order-1"
      },
      stepId: "step-handover"
    }
  });
}

function outbox(
  overrides: Partial<ClaimedJourneyOutbox>
): ClaimedJourneyOutbox {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    aggregateId: "order-1",
    aggregateType: "SUBSCRIPTION_JOURNEY",
    attemptCount: 0,
    availableAt: now,
    createdAt: now,
    deliveredAt: null,
    eventKey: "event-1",
    eventType: SubscriptionJourneyEventType.DOMAIN_FACT_OBSERVED,
    id: "outbox-handover",
    journeyId: "journey-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date("2026-08-06T00:02:00.000Z"),
    leaseToken: "lease-outbox",
    payload: {},
    status: "PROCESSING",
    updatedAt: now,
    ...overrides
  } as ClaimedJourneyOutbox;
}
