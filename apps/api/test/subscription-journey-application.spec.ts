import {
  ApplicationSource,
  ApplicationStatus,
  DepositStatus,
  OrderReviewStatus,
  SubscriptionJourneyEventType,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStepCode
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { CustomerService } from "../src/customer/customer.service";
import { SubscriptionJourneyHandlers } from "../src/subscription-journey/subscription-journey.handlers";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";
import { SubscriptionJourneySignalService } from "../src/subscription-journey/subscription-journey-signal.service";
import type {
  ClaimedJourneyJob,
  ClaimedJourneyOutbox
} from "../src/subscription-journey/subscription-journey.types";

describe("subscription journey application validation", () => {
  it("runs validation and completes APPLICATION_VALIDATION in one transaction", async () => {
    const tx = validationTransaction();
    const prisma = transactionHost(tx);
    const customerService = {
      validateJourneyApplication: vi.fn(async () => undefined)
    };
    const repository = {
      completeStep: vi.fn(async () => undefined)
    };
    const service = new SubscriptionJourneyService(
      repository as never,
      prisma as never,
      customerService as never
    );

    await expect(service.validateApplicationJob(validationJob())).resolves.toEqual({
      action: "APPLICATION_VALIDATED",
      applicationId: "application-1"
    });

    expect(customerService.validateJourneyApplication).toHaveBeenCalledWith(
      tx,
      "application-1"
    );
    expect(repository.completeStep).toHaveBeenCalledWith(tx, {
      eventKey: "journey:journey-1:step:APPLICATION_VALIDATION:completed",
      expectedVersion: 0,
      journeyId: "journey-1",
      payload: { applicationId: "application-1" },
      stepId: "step-validation"
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("propagates stable validation errors without completing the step", async () => {
    const tx = validationTransaction();
    const repository = { completeStep: vi.fn(async () => undefined) };
    const customerService = {
      validateJourneyApplication: vi.fn(async () => {
        throw Object.assign(new Error("materials incomplete"), {
          code: "JOURNEY_APPLICATION_MATERIALS_INCOMPLETE"
        });
      })
    };
    const service = new SubscriptionJourneyService(
      repository as never,
      transactionHost(tx) as never,
      customerService as never
    );

    await expect(service.validateApplicationJob(validationJob())).rejects.toMatchObject({
      code: "JOURNEY_APPLICATION_MATERIALS_INCOMPLETE"
    });
    expect(repository.completeStep).not.toHaveBeenCalled();
  });

  it.each([
    [
      { materialReviewStatus: OrderReviewStatus.PENDING },
      "JOURNEY_APPLICATION_MATERIALS_INCOMPLETE"
    ],
    [
      { creditReviewStatus: OrderReviewStatus.PENDING },
      "JOURNEY_APPLICATION_CREDIT_NOT_APPROVED"
    ],
    [
      { finalSubscriptionPlanId: null, intentSubscriptionPlanId: null },
      "JOURNEY_APPLICATION_PRODUCT_INVALID"
    ]
  ])("returns a stable domain code for invalid application facts", async (override, code) => {
    const application = readyApplication(override);
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: application.id }]),
      application: { findUnique: vi.fn(async () => application) }
    };
    const service = new CustomerService(
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(
      service.validateJourneyApplication(tx as never, application.id)
    ).rejects.toMatchObject({ code });
  });
});

describe("subscription journey application dispatch", () => {
  it("routes implemented validation and order bootstrap jobs", async () => {
    const service = {
      createOrderAndContractJob: vi.fn(async () => ({
        action: "ORDER_AND_CONTRACT_CREATED"
      })),
      validateApplicationJob: vi.fn(async () => ({ action: "APPLICATION_VALIDATED" }))
    };
    const handlers = new SubscriptionJourneyHandlers(service as never);

    await expect(handlers.handle(validationJob())).resolves.toEqual({
      action: "APPLICATION_VALIDATED"
    });
    await expect(
      handlers.handle(
        validationJob({
          jobType: SubscriptionJourneyJobType.CREATE_ORDER_AND_CONTRACT
        })
      )
    ).resolves.toEqual({ action: "ORDER_AND_CONTRACT_CREATED" });
  });

  it("opens exactly one FINAL_PLAN_DECISION task when dispatch is replayed", async () => {
    const openTasks = new Map<string, unknown>();
    const repository = {
      enqueueNotificationOutbox: vi.fn(async () => undefined),
      openManualTask: vi.fn(async (_tx, input: { journeyId: string; stepId: string }) => {
        const key = `${input.journeyId}:${input.stepId}`;
        const task = openTasks.get(key) ?? { id: "task-final-plan", ...input };
        openTasks.set(key, task);
        return task;
      })
    };
    const tx = {
      subscriptionJourney: {
        findUnique: vi.fn(async () => ({
          application: { finalPlanRevision: 0 },
          applicationId: "application-1",
          currentStepCode: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION,
          id: "journey-1",
          orderId: null,
          steps: [
            {
              code: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION,
              id: "step-final-plan",
              journeyId: "journey-1"
            }
          ]
        }))
      }
    };
    const service = new SubscriptionJourneyService(repository as never);
    const outbox = validationOutbox();

    await service.dispatchSignalOutbox(tx as never, outbox);
    await service.dispatchSignalOutbox(tx as never, {
      ...outbox,
      eventKey: "journey:journey-1:step:validation:completed:replay:outbox",
      id: "outbox-validation-replay"
    });

    expect(openTasks.size).toBe(1);
    expect(repository.openManualTask).toHaveBeenLastCalledWith(tx, {
      inputSnapshot: {
        applicationId: "application-1",
        finalPlanRevision: 0
      },
      journeyId: "journey-1",
      stepId: "step-final-plan"
    });
  });

  it("waits for the exact plan revision after the final-plan decision", async () => {
    const repository = {
      enqueueNotificationOutbox: vi.fn(async () => undefined),
      waitForCustomer: vi.fn(async () => undefined)
    };
    const tx = customerConfirmationTransaction();
    const service = new SubscriptionJourneyService(repository as never);

    await service.dispatchSignalOutbox(tx as never, validationOutbox());

    expect(repository.waitForCustomer).toHaveBeenCalledWith(tx, {
      eventKey: "journey:journey-1:step:CUSTOMER_PLAN_CONFIRMATION:revision:1:waiting",
      expectedVersion: 2,
      journeyId: "journey-1",
      payload: { finalPlanRevision: 1 },
      stepId: "step-customer-confirmation"
    });
  });

  it("completes customer confirmation only for the exact observed revision", async () => {
    const repository = {
      completeStep: vi.fn(async () => undefined),
      enqueueNotificationOutbox: vi.fn(async () => undefined),
      waitForCustomer: vi.fn(async () => undefined)
    };
    const tx = customerConfirmationTransaction();
    const service = new SubscriptionJourneyService(repository as never);

    await service.dispatchSignalOutbox(tx as never, {
      ...validationOutbox(),
      eventType: SubscriptionJourneyEventType.DOMAIN_FACT_OBSERVED,
      payload: { revision: 1, signalType: "CUSTOMER_PLAN_CONFIRMED" }
    });

    expect(repository.completeStep).toHaveBeenCalledWith(tx, {
      eventKey: "journey:journey-1:step:CUSTOMER_PLAN_CONFIRMATION:revision:1:completed",
      expectedVersion: 2,
      journeyId: "journey-1",
      payload: { finalPlanRevision: 1 },
      stepId: "step-customer-confirmation"
    });
    expect(repository.waitForCustomer).not.toHaveBeenCalled();
  });
});

describe("subscription journey manual application decisions", () => {
  it("decides and completes a manual step through the transaction signal boundary", async () => {
    const repository = {
      completeStep: vi.fn(async () => undefined),
      decideManualTask: vi.fn(async () => undefined)
    };
    const tx = manualDecisionTransaction(
      SubscriptionJourneyStepCode.FINAL_PLAN_DECISION
    );
    const service = new SubscriptionJourneySignalService(
      repository as never,
      {} as never
    );

    await service.completeManualDecision(tx as never, {
      actorId: "00000000-0000-4000-8000-000000000001",
      applicationId: "application-1",
      expectedStepCode: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION,
      payload: { finalPlanRevision: 1 }
    });

    expect(repository.decideManualTask).toHaveBeenCalledWith(tx, {
      decidedBy: "00000000-0000-4000-8000-000000000001",
      decision: "APPROVED",
      expectedVersion: 0,
      journeyId: "journey-1",
      taskId: "manual-task-1"
    });
    expect(repository.completeStep).toHaveBeenCalledWith(tx, {
      eventKey: "journey:journey-1:step:FINAL_PLAN_DECISION:decision:1",
      expectedVersion: 2,
      journeyId: "journey-1",
      payload: { finalPlanRevision: 1 },
      stepId: "step-manual"
    });
  });

  it("completes vehicle work and returns to confirmation for a revised plan", async () => {
    const repository = {
      decideManualTask: vi.fn(async () => undefined),
      returnToCustomerConfirmation: vi.fn(async () => undefined)
    };
    const tx = manualDecisionTransaction(
      SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION
    );
    const service = new SubscriptionJourneySignalService(
      repository as never,
      {} as never
    );

    await service.requireCustomerReconfirmationAfterManualDecision(
      tx as never,
      {
        actorId: "00000000-0000-4000-8000-000000000001",
        applicationId: "application-1",
        finalPlanRevision: 2,
        vehicleId: "vehicle-1"
      }
    );

    expect(repository.decideManualTask).toHaveBeenCalledOnce();
    expect(repository.returnToCustomerConfirmation).toHaveBeenCalledWith(tx, {
      eventKey:
        "journey:journey-1:step:FINAL_VEHICLE_ALLOCATION:revision:2:reconfirmation",
      expectedVersion: 2,
      journeyId: "journey-1",
      payload: { finalPlanRevision: 2, vehicleId: "vehicle-1" },
      vehicleStepId: "step-manual"
    });
  });
});

function manualDecisionTransaction(stepCode: SubscriptionJourneyStepCode) {
  return {
    subscriptionJourney: {
      findUnique: vi.fn(async () => ({
        applicationId: "application-1",
        currentStepCode: stepCode,
        id: "journey-1",
        manualTasks: [
          {
            id: "manual-task-1",
            status: "OPEN",
            stepId: "step-manual",
            version: 0
          }
        ],
        steps: [{ code: stepCode, id: "step-manual" }],
        version: 2
      }))
    }
  };
}

function customerConfirmationTransaction() {
  return {
    subscriptionJourney: {
      findUnique: vi.fn(async () => ({
        application: { finalPlanRevision: 1 },
        applicationId: "application-1",
        currentStepCode: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
        id: "journey-1",
        orderId: null,
        steps: [
          {
            code: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
            id: "step-customer-confirmation",
            journeyId: "journey-1"
          }
        ],
        version: 2
      }))
    }
  };
}

function validationTransaction() {
  return {
    subscriptionJourney: {
      findUnique: vi.fn(async () => ({
        applicationId: "application-1",
        currentStepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
        id: "journey-1",
        steps: [
          {
            code: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
            id: "step-validation"
          }
        ],
        version: 0
      }))
    }
  };
}

function transactionHost(tx: unknown) {
  return {
    $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(tx))
  };
}

function validationJob(
  overrides: Partial<ClaimedJourneyJob> = {}
): ClaimedJourneyJob {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    completedAt: null,
    createdAt: now,
    id: "job-validation",
    jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
    journeyId: "journey-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date("2026-08-06T00:02:00.000Z"),
    leaseToken: "lease-validation",
    maxAttempts: 5,
    payload: { applicationId: "application-1" },
    sourceKey: "journey:journey-1:step:APPLICATION_VALIDATION:revision:0",
    status: SubscriptionJourneyJobStatus.PROCESSING,
    stepId: "step-validation",
    updatedAt: now,
    ...overrides
  };
}

function validationOutbox(): ClaimedJourneyOutbox {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    aggregateId: "journey-1",
    aggregateType: "SUBSCRIPTION_JOURNEY",
    attemptCount: 0,
    availableAt: now,
    createdAt: now,
    deliveredAt: null,
    eventKey: "journey:journey-1:step:validation:completed:outbox",
    eventType: SubscriptionJourneyEventType.STEP_COMPLETED,
    id: "outbox-validation",
    journeyId: "journey-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date("2026-08-06T00:02:00.000Z"),
    leaseToken: "lease-outbox",
    payload: {},
    status: "PROCESSING",
    updatedAt: now
  } as ClaimedJourneyOutbox;
}

function readyApplication(overrides: Record<string, unknown> = {}) {
  return {
    applicationSource: ApplicationSource.SALES_ASSISTED,
    creditReviewStatus: OrderReviewStatus.APPROVED,
    customerConfirmedPlanRevision: null,
    deletedAt: null,
    depositStatus: DepositStatus.CONFIRMED,
    finalDepositAmount: 1000n,
    finalPeriodMonths: 12,
    finalPlanRevision: 0,
    finalSubscriptionPlanId: "plan-1",
    finalVehicleBaseFeeAmount: 2000n,
    finalVehicleId: "vehicle-1",
    id: "application-1",
    intentPeriodMonths: null,
    intentSubscriptionPlanId: null,
    intentVehicleId: null,
    intendedPeriodMonths: null,
    materialReviewStatus: OrderReviewStatus.APPROVED,
    orders: [],
    productReviewStatus: OrderReviewStatus.PENDING,
    softReservedVehicleId: null,
    status: ApplicationStatus.SUBMITTED,
    vehicleReviewStatus: OrderReviewStatus.PENDING,
    ...overrides
  };
}
