import {
  SubscriptionJourneyEventType,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionJourneyHandlers } from "../src/subscription-journey/subscription-journey.handlers";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";
import type {
  ClaimedJourneyJob,
  ClaimedJourneyOutbox
} from "../src/subscription-journey/subscription-journey.types";

describe("subscription journey initial billing and customer payment", () => {
  it("generates source-keyed initial bills and advances to customer payment", async () => {
    const tx = journeyTransaction(SubscriptionJourneyStepCode.INITIAL_BILLING);
    const repository = {
      completeStep: vi.fn(async () => undefined)
    };
    const finance = {
      generateInitialBillsInTransaction: vi.fn(async () => [
        { id: "bill-deposit" },
        { id: "bill-first-month" }
      ])
    };
    const service = journeyService(tx, repository, finance);
    const job = journeyJob(
      SubscriptionJourneyJobType.GENERATE_INITIAL_BILLS,
      SubscriptionJourneyStepCode.INITIAL_BILLING,
      "step-initial-billing"
    );

    await expect(service.generateInitialBillsJob(job)).resolves.toEqual({
      action: "INITIAL_BILLS_GENERATED",
      billIds: ["bill-deposit", "bill-first-month"],
      orderId: "order-1"
    });
    expect(finance.generateInitialBillsInTransaction).toHaveBeenCalledWith(
      tx,
      "order-1",
      "00000000-0000-4000-8000-000000000001",
      job.sourceKey
    );
    expect(repository.completeStep).toHaveBeenCalledWith(tx, {
      eventKey: `${job.sourceKey}:completed`,
      expectedVersion: 5,
      journeyId: "journey-1",
      payload: {
        billIds: ["bill-deposit", "bill-first-month"],
        orderId: "order-1"
      },
      stepId: "step-initial-billing"
    });
  });

  it("waits for the customer while initial bills remain and advances only after full settlement", async () => {
    const waitingTx = journeyTransaction(
      SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT
    );
    const waitingRepository = {
      completeStep: vi.fn(async () => undefined),
      waitForCustomer: vi.fn(async () => undefined)
    };
    const waitingFinance = {
      evaluateInitialBillSettlement: vi.fn(async () => ({
        paid: false,
        remainingAmount: 300000n
      }))
    };
    const job = journeyJob(
      SubscriptionJourneyJobType.EVALUATE_PAYMENT_SETTLEMENT,
      SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT,
      "step-payment"
    );
    const waitingService = journeyService(
      waitingTx,
      waitingRepository,
      waitingFinance
    );

    await expect(waitingService.evaluatePaymentSettlementJob(job)).resolves.toEqual({
      action: "WAITING_CUSTOMER_PAYMENT",
      orderId: "order-1",
      remainingAmount: "300000"
    });
    expect(waitingRepository.waitForCustomer).toHaveBeenCalledWith(waitingTx, {
      eventKey: `${job.sourceKey}:waiting`,
      expectedVersion: 5,
      journeyId: "journey-1",
      payload: { orderId: "order-1", remainingAmount: "300000" },
      stepId: "step-payment"
    });
    expect(waitingRepository.completeStep).not.toHaveBeenCalled();

    const paidTx = journeyTransaction(
      SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT,
      SubscriptionJourneyStepStatus.WAITING_CUSTOMER,
      6
    );
    const paidRepository = {
      completeStep: vi.fn(async () => undefined),
      waitForCustomer: vi.fn(async () => undefined)
    };
    const paidService = journeyService(paidTx, paidRepository, {
      evaluateInitialBillSettlement: vi.fn(async () => ({
        paid: true,
        remainingAmount: 0n
      }))
    });
    const paidJob = journeyJob(
      SubscriptionJourneyJobType.EVALUATE_PAYMENT_SETTLEMENT,
      SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT,
      "step-payment",
      { sourceKey: `${job.sourceKey}:facts:6` }
    );

    await expect(paidService.evaluatePaymentSettlementJob(paidJob)).resolves.toEqual({
      action: "INITIAL_BILLS_SETTLED",
      orderId: "order-1"
    });
    expect(paidRepository.completeStep).toHaveBeenCalledWith(paidTx, {
      eventKey: `${paidJob.sourceKey}:completed`,
      expectedVersion: 6,
      journeyId: "journey-1",
      payload: { orderId: "order-1" },
      stepId: "step-payment"
    });
    expect(paidRepository.waitForCustomer).not.toHaveBeenCalled();
  });

  it("creates a distinct settlement evaluation job for each payment fact", async () => {
    const tx = journeyTransaction(
      SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT,
      SubscriptionJourneyStepStatus.WAITING_CUSTOMER,
      6
    );
    const repository = {
      enqueueJob: vi.fn(async () => undefined),
      enqueueNotificationOutbox: vi.fn(async () => undefined)
    };
    const service = journeyService(tx, repository, {});

    await service.dispatchSignalOutbox(tx as never, paymentOutbox(6));

    expect(repository.enqueueJob).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        jobType: SubscriptionJourneyJobType.EVALUATE_PAYMENT_SETTLEMENT,
        sourceKey:
          "journey:journey-1:step:CUSTOMER_JSAPI_PAYMENT:revision:1:facts:6",
        stepId: "step-payment"
      })
    );
  });

  it("routes initial-billing and settlement jobs through implemented handlers", async () => {
    const service = {
      evaluatePaymentSettlementJob: vi.fn(async () => ({ action: "SETTLED" })),
      generateInitialBillsJob: vi.fn(async () => ({ action: "BILLED" }))
    };
    const handlers = new SubscriptionJourneyHandlers(service as never);

    await expect(
      handlers.handle(
        journeyJob(
          SubscriptionJourneyJobType.GENERATE_INITIAL_BILLS,
          SubscriptionJourneyStepCode.INITIAL_BILLING,
          "step-initial-billing"
        )
      )
    ).resolves.toEqual({ action: "BILLED" });
    await expect(
      handlers.handle(
        journeyJob(
          SubscriptionJourneyJobType.EVALUATE_PAYMENT_SETTLEMENT,
          SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT,
          "step-payment"
        )
      )
    ).resolves.toEqual({ action: "SETTLED" });
  });
});

function journeyService(tx: unknown, repository: unknown, finance: unknown) {
  return new SubscriptionJourneyService(
    repository as never,
    transactionHost(tx) as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    finance as never
  );
}

function journeyTransaction(
  stepCode: SubscriptionJourneyStepCode,
  stepStatus: SubscriptionJourneyStepStatus =
    SubscriptionJourneyStepStatus.RUNNING,
  version = 5
) {
  const stepId =
    stepCode === SubscriptionJourneyStepCode.INITIAL_BILLING
      ? "step-initial-billing"
      : "step-payment";
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
        currentStepStatus: stepStatus,
        id: "journey-1",
        orderId: "order-1",
        steps: [{ code: stepCode, id: stepId, status: stepStatus }],
        version
      }))
    }
  };
}

function transactionHost(tx: unknown) {
  return {
    $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(tx))
  };
}

function journeyJob(
  jobType: SubscriptionJourneyJobType,
  stepCode: SubscriptionJourneyStepCode,
  stepId: string,
  overrides: Partial<ClaimedJourneyJob> = {}
): ClaimedJourneyJob {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    completedAt: null,
    createdAt: now,
    id: `job-${jobType.toLowerCase()}`,
    jobType,
    journeyId: "journey-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date("2026-08-06T00:02:00.000Z"),
    leaseToken: "lease-payment",
    maxAttempts: 20,
    payload: { finalPlanRevision: 1, orderId: "order-1", stepCode },
    sourceKey: `journey:journey-1:step:${stepCode}:revision:1`,
    status: SubscriptionJourneyJobStatus.PROCESSING,
    stepId,
    updatedAt: now,
    ...overrides
  };
}

function paymentOutbox(journeyVersion: number): ClaimedJourneyOutbox {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    aggregateId: "order-1",
    aggregateType: "SUBSCRIPTION_JOURNEY",
    attemptCount: 0,
    availableAt: now,
    createdAt: now,
    deliveredAt: null,
    eventKey: "payment-order:payment-order-1:settled:outbox",
    eventType: SubscriptionJourneyEventType.DOMAIN_FACT_OBSERVED,
    id: "outbox-payment-settled",
    journeyId: "journey-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date("2026-08-06T00:02:00.000Z"),
    leaseToken: "lease-outbox",
    payload: {
      journeyVersion,
      paymentOrderId: "payment-order-1",
      signalType: "PAYMENT_SETTLED"
    },
    status: "PROCESSING",
    updatedAt: now
  } as ClaimedJourneyOutbox;
}
