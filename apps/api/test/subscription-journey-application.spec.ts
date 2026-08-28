import {
  ApplicationSource,
  ApplicationStatus,
  DepositStatus,
  OrderReviewStatus,
  SubscriptionJourneyEventType,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStatus,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus
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

const FINAL_PLAN_COMMERCIAL_HASH = `sha256:${"a".repeat(64)}`;

describe("subscription journey application validation", () => {
  it("runs validation and completes APPLICATION_VALIDATION in one transaction", async () => {
    const tx = validationTransaction();
    const prisma = transactionHost(tx);
    const customerService = {
      validateJourneyApplication: vi.fn(async () => ({
        factVersion: 0,
        outcome: "READY",
        reasonCodes: []
      }))
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
      factVersion: 0,
      journeyId: "journey-1",
      payload: { applicationId: "application-1", factVersion: 0 },
      stepId: "step-validation"
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("persists a manual business wait without completing validation", async () => {
    const tx = validationTransaction();
    const repository = {
      completeStep: vi.fn(async () => undefined),
      waitForManual: vi.fn(async () => undefined)
    };
    const customerService = {
      validateJourneyApplication: vi.fn(async () => ({
        factVersion: 3,
        outcome: "WAITING_MANUAL",
        reasonCodes: ["MATERIAL_REVIEW_PENDING", "CREDIT_REVIEW_PENDING"]
      }))
    };
    const service = new SubscriptionJourneyService(
      repository as never,
      transactionHost(tx) as never,
      customerService as never
    );

    await expect(service.validateApplicationJob(validationJob())).resolves.toEqual({
      action: "APPLICATION_VALIDATION_WAITING_MANUAL",
      applicationId: "application-1",
      factVersion: 3,
      reasonCodes: ["MATERIAL_REVIEW_PENDING", "CREDIT_REVIEW_PENDING"]
    });
    expect(repository.waitForManual).toHaveBeenCalledWith(tx, {
      eventKey: "journey:journey-1:step:APPLICATION_VALIDATION:facts:3:waiting-manual",
      expectedVersion: 0,
      factVersion: 3,
      journeyId: "journey-1",
      payload: {
        factVersion: 3,
        reasonCodes: ["MATERIAL_REVIEW_PENDING", "CREDIT_REVIEW_PENDING"]
      },
      stepId: "step-validation"
    });
    expect(repository.completeStep).not.toHaveBeenCalled();
  });

  it("persists a customer supplementation wait without completing validation", async () => {
    const tx = validationTransaction();
    const repository = {
      completeStep: vi.fn(async () => undefined),
      waitForCustomer: vi.fn(async () => undefined)
    };
    const customerService = {
      validateJourneyApplication: vi.fn(async () => ({
        factVersion: 4,
        outcome: "WAITING_CUSTOMER",
        reasonCodes: ["MATERIAL_SUPPLEMENT_REQUIRED"]
      }))
    };
    const service = new SubscriptionJourneyService(
      repository as never,
      transactionHost(tx) as never,
      customerService as never
    );

    await expect(service.validateApplicationJob(validationJob())).resolves.toEqual({
      action: "APPLICATION_VALIDATION_WAITING_CUSTOMER",
      applicationId: "application-1",
      factVersion: 4,
      reasonCodes: ["MATERIAL_SUPPLEMENT_REQUIRED"]
    });
    expect(repository.waitForCustomer).toHaveBeenCalledWith(tx, {
      eventKey: "journey:journey-1:step:APPLICATION_VALIDATION:facts:4:waiting-customer",
      expectedVersion: 0,
      factVersion: 4,
      journeyId: "journey-1",
      payload: {
        factVersion: 4,
        reasonCodes: ["MATERIAL_SUPPLEMENT_REQUIRED"]
      },
      stepId: "step-validation"
    });
    expect(repository.completeStep).not.toHaveBeenCalled();
  });

  it("closes a rejected application journey and releases its reservation", async () => {
    const tx = validationTransaction();
    const repository = {
      completeStep: vi.fn(async () => undefined),
      rejectForApplication: vi.fn(async () => undefined)
    };
    const customerService = {
      releaseRejectedJourneyApplication: vi.fn(async () => undefined),
      validateJourneyApplication: vi.fn(async () => ({
        factVersion: 5,
        outcome: "REJECTED",
        reasonCodes: ["CREDIT_REVIEW_REJECTED"]
      }))
    };
    const service = new SubscriptionJourneyService(
      repository as never,
      transactionHost(tx) as never,
      customerService as never
    );

    await expect(service.validateApplicationJob(validationJob())).resolves.toEqual({
      action: "APPLICATION_VALIDATION_REJECTED",
      applicationId: "application-1",
      factVersion: 5,
      reasonCodes: ["CREDIT_REVIEW_REJECTED"]
    });
    expect(customerService.releaseRejectedJourneyApplication).toHaveBeenCalledWith(
      tx,
      "application-1"
    );
    expect(repository.rejectForApplication).toHaveBeenCalledWith(tx, {
      activeJobId: "job-validation",
      eventKey: "journey:journey-1:step:APPLICATION_VALIDATION:facts:5:rejected",
      expectedVersion: 0,
      factVersion: 5,
      journeyId: "journey-1",
      payload: {
        factVersion: 5,
        reasonCodes: ["CREDIT_REVIEW_REJECTED"]
      },
      stepId: "step-validation"
    });
    expect(repository.completeStep).not.toHaveBeenCalled();
  });

  it("propagates technical validation errors without completing the step", async () => {
    const tx = validationTransaction();
    const repository = { completeStep: vi.fn(async () => undefined) };
    const customerService = {
      validateJourneyApplication: vi.fn(async () => {
        throw Object.assign(new Error("materials incomplete"), {
          code: "JOURNEY_APPLICATION_NOT_FOUND"
        });
      })
    };
    const service = new SubscriptionJourneyService(
      repository as never,
      transactionHost(tx) as never,
      customerService as never
    );

    await expect(service.validateApplicationJob(validationJob())).rejects.toMatchObject({
      code: "JOURNEY_APPLICATION_NOT_FOUND"
    });
    expect(repository.completeStep).not.toHaveBeenCalled();
  });

  it.each([
    [
      { materialReviewStatus: OrderReviewStatus.PENDING },
      "WAITING_MANUAL",
      ["MATERIAL_REVIEW_PENDING"]
    ],
    [
      { creditReviewStatus: OrderReviewStatus.PENDING },
      "WAITING_MANUAL",
      ["CREDIT_REVIEW_PENDING"]
    ],
    [
      { materialReviewStatus: OrderReviewStatus.NEED_MORE_INFO },
      "WAITING_CUSTOMER",
      ["MATERIAL_SUPPLEMENT_REQUIRED"]
    ],
    [
      { creditReviewStatus: OrderReviewStatus.REJECTED },
      "REJECTED",
      ["CREDIT_REVIEW_REJECTED"]
    ],
    [
      { finalSubscriptionPlanId: null, intentSubscriptionPlanId: null },
      "WAITING_MANUAL",
      ["PRODUCT_SELECTION_REQUIRED"]
    ]
  ])("returns structured readiness for incomplete application facts", async (override, outcome, reasonCodes) => {
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

    await expect(service.validateJourneyApplication(tx as never, application.id)).resolves.toEqual({
      factVersion: 0,
      outcome,
      reasonCodes
    });
  });

  it("releases a rejected application soft reservation in the validation transaction", async () => {
    const application = readyApplication({
      creditReviewStatus: OrderReviewStatus.REJECTED,
      softReservedAt: new Date("2026-08-26T00:00:00.000Z"),
      softReservedVehicleId: "vehicle-1",
      status: ApplicationStatus.REJECTED
    });
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: application.id }]),
      application: {
        findUnique: vi.fn(async () => application),
        update: vi.fn(async (input) => ({ ...application, ...input.data }))
      },
      vehicle: {
        findUnique: vi.fn(async () => ({
          deletedAt: null,
          id: "vehicle-1",
          status: "REVIEW_RESERVED"
        })),
        update: vi.fn(async (input) => ({ id: "vehicle-1", ...input.data }))
      }
    };
    const assetOperations = {
      assertVehicleAvailable: vi.fn(async () => undefined)
    };
    const service = new CustomerService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      assetOperations as never
    );

    await service.releaseRejectedJourneyApplication(tx as never, application.id);

    expect(tx.vehicle.update).toHaveBeenCalledWith({
      data: { status: "AVAILABLE" },
      where: { id: "vehicle-1" }
    });
    expect(tx.application.update).toHaveBeenCalledWith({
      data: {
        softReservationExpiresAt: null,
        softReservedAt: null,
        softReservedVehicleId: null
      },
      where: { id: application.id }
    });
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

  it("ignores a validation-targeted fact signal after the journey has advanced", async () => {
    const repository = {
      enqueueJob: vi.fn(async () => undefined),
      enqueueNotificationOutbox: vi.fn(async () => undefined),
      openManualTask: vi.fn(async () => undefined)
    };
    const tx = {
      subscriptionJourney: {
        findUnique: vi.fn(async () => ({
          application: { finalPlanRevision: 0 },
          applicationId: "application-1",
          currentStepCode: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION,
          currentStepStatus: "PENDING",
          id: "journey-1",
          orderId: null,
          steps: [
            {
              code: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION,
              id: "step-final-plan",
              journeyId: "journey-1"
            }
          ],
          version: 4
        }))
      }
    };
    const service = new SubscriptionJourneyService(repository as never);

    await service.dispatchSignalOutbox(tx as never, {
      ...validationOutbox(),
      eventType: SubscriptionJourneyEventType.DOMAIN_FACT_OBSERVED,
      payload: {
        factType: "credit",
        factVersion: 3,
        signalType: "APPLICATION_FACTS_CHANGED",
        sourceActionId: "application-action-3",
        targetStepCode: "APPLICATION_VALIDATION"
      }
    });

    expect(repository.openManualTask).not.toHaveBeenCalled();
    expect(repository.enqueueJob).not.toHaveBeenCalled();
  });

  it("enqueues validation only for a newer validation-targeted fact version", async () => {
    const repository = {
      enqueueJob: vi.fn(async () => undefined),
      enqueueNotificationOutbox: vi.fn(async () => undefined),
      openManualTask: vi.fn(async () => undefined)
    };
    const tx = validationTransaction({ lastApplicationFactVersion: 2 });
    const service = new SubscriptionJourneyService(repository as never);
    const outbox = {
      ...validationOutbox(),
      eventType: SubscriptionJourneyEventType.DOMAIN_FACT_OBSERVED,
      payload: {
        factType: "material",
        factVersion: 3,
        signalType: "APPLICATION_FACTS_CHANGED",
        sourceActionId: "application-action-3",
        targetStepCode: "APPLICATION_VALIDATION"
      }
    };

    await service.dispatchSignalOutbox(tx as never, outbox);
    await service.dispatchSignalOutbox(
      validationTransaction({ lastApplicationFactVersion: 3 }) as never,
      outbox
    );

    expect(repository.enqueueJob).toHaveBeenCalledOnce();
    expect(repository.enqueueJob).toHaveBeenCalledWith(expect.anything(), {
      jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
      journeyId: "journey-1",
      payload: {
        applicationId: "application-1",
        factType: "material",
        factVersion: 3,
        sourceActionId: "application-action-3",
        stepCode: "APPLICATION_VALIDATION"
      },
      sourceKey: "journey:journey-1:step:APPLICATION_VALIDATION:facts:3",
      stepId: "step-validation"
    });
    expect(repository.openManualTask).not.toHaveBeenCalled();
  });

  it("accepts application-status facts as validation-targeted versions", async () => {
    const repository = {
      enqueueJob: vi.fn(async () => undefined),
      enqueueNotificationOutbox: vi.fn(async () => undefined),
      openManualTask: vi.fn(async () => undefined)
    };
    const tx = validationTransaction({ lastApplicationFactVersion: 3 });
    const service = new SubscriptionJourneyService(repository as never);

    await service.dispatchSignalOutbox(tx as never, {
      ...validationOutbox(),
      eventType: SubscriptionJourneyEventType.DOMAIN_FACT_OBSERVED,
      payload: {
        factType: "application",
        factVersion: 4,
        signalType: "APPLICATION_FACTS_CHANGED",
        sourceActionId: "application-action-4",
        targetStepCode: "APPLICATION_VALIDATION"
      }
    });

    expect(repository.enqueueJob).toHaveBeenCalledWith(expect.anything(), {
      jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
      journeyId: "journey-1",
      payload: {
        applicationId: "application-1",
        factType: "application",
        factVersion: 4,
        sourceActionId: "application-action-4",
        stepCode: "APPLICATION_VALIDATION"
      },
      sourceKey: "journey:journey-1:step:APPLICATION_VALIDATION:facts:4",
      stepId: "step-validation"
    });
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
      expectedVersion: 3,
      journeyId: "journey-1",
      payload: {
        finalPlanCommercialHash: FINAL_PLAN_COMMERCIAL_HASH,
        finalPlanRevision: 1
      },
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
      payload: {
        commercialHash: FINAL_PLAN_COMMERCIAL_HASH,
        revision: 1,
        signalType: "CUSTOMER_PLAN_CONFIRMED"
      }
    });

    expect(repository.completeStep).toHaveBeenCalledWith(tx, {
      eventKey:
        "journey:journey-1:step:CUSTOMER_PLAN_CONFIRMATION:" +
        `revision:1:hash:${"a".repeat(16)}:completed`,
      expectedVersion: 3,
      journeyId: "journey-1",
      payload: {
        finalPlanCommercialHash: FINAL_PLAN_COMMERCIAL_HASH,
        finalPlanRevision: 1
      },
      stepId: "step-customer-confirmation"
    });
    expect(repository.waitForCustomer).not.toHaveBeenCalled();
  });
});

describe("subscription journey manual application decisions", () => {
  it("terminates an open application journey at its current step", async () => {
    const repository = {
      rejectForApplication: vi.fn(async () => undefined)
    };
    const tx = {
      subscriptionJourney: {
        findUnique: vi.fn(async () => ({
          applicationId: "application-1",
          currentStepCode: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION,
          id: "journey-1",
          status: "WAITING_MANUAL",
          steps: [
            {
              code: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION,
              id: "step-final-plan"
            }
          ],
          version: 7
        }))
      }
    };
    const service = new SubscriptionJourneySignalService(
      repository as never,
      {} as never
    );

    await service.terminateApplication(tx as never, {
      actionId: "application-action-7",
      applicationId: "application-1",
      factVersion: 5,
      outcome: "REJECTED",
      reason: "资质未通过"
    });

    expect(repository.rejectForApplication).toHaveBeenCalledWith(tx, {
      eventKey:
        "application:application-1:terminated:rejected:application-action-7",
      expectedVersion: 7,
      factVersion: 5,
      journeyId: "journey-1",
      payload: {
        decision: "REJECTED",
        factVersion: 5,
        reasonCodes: ["APPLICATION_REJECTED"]
      },
      stepId: "step-final-plan"
    });
  });

  it("completes final-plan and vehicle-allocation steps before customer confirmation", async () => {
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
    const commercialHash = `sha256:${"a".repeat(64)}`;

    await service.completeFinalPlanAndVehicleAllocation(tx as never, {
      actorId: "00000000-0000-4000-8000-000000000001",
      applicationId: "application-1",
      finalPlanCommercialHash: commercialHash,
      finalPlanRevision: 1,
      vehicleId: "vehicle-1"
    });

    expect(repository.decideManualTask).toHaveBeenCalledOnce();
    expect(repository.completeStep).toHaveBeenNthCalledWith(1, tx, {
      eventKey: `journey:journey-1:step:FINAL_PLAN_DECISION:revision:1:hash:${"a".repeat(16)}`,
      expectedVersion: 2,
      journeyId: "journey-1",
      payload: {
        finalPlanCommercialHash: commercialHash,
        finalPlanRevision: 1,
        vehicleId: "vehicle-1"
      },
      stepId: "step-manual"
    });
    expect(repository.completeStep).toHaveBeenNthCalledWith(2, tx, {
      eventKey: `journey:journey-1:step:FINAL_VEHICLE_ALLOCATION:revision:1:hash:${"a".repeat(16)}`,
      expectedVersion: 3,
      journeyId: "journey-1",
      payload: {
        finalPlanCommercialHash: commercialHash,
        finalPlanRevision: 1,
        vehicleId: "vehicle-1"
      },
      stepId: "step-vehicle-allocation"
    });
  });

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

describe("subscription journey final-plan command replay", () => {
  it("returns the committed publication for an exact stale-version replay", async () => {
    const harness = finalPlanReplayHarness();

    await expect(
      harness.service.decideFinalPlan(
        "journey-1",
        {
          finalPeriodMonths: 12,
          finalSubscriptionPlanId: "plan-1",
          finalVehicleId: "vehicle-1",
          version: 2
        },
        harness.user,
        harness.context
      )
    ).resolves.toEqual({
      applicationId: "application-1",
      finalPlanCommercialHash: FINAL_PLAN_COMMERCIAL_HASH,
      finalPlanRevision: 1,
      finalVehicleId: "vehicle-1",
      journeyId: "journey-1",
      replayed: true
    });
    expect(
      harness.customerService.applyJourneyFinalPlanDecision
    ).not.toHaveBeenCalled();
  });

  it("rejects payload drift after the publication was committed", async () => {
    const harness = finalPlanReplayHarness();

    await expect(
      harness.service.decideFinalPlan(
        "journey-1",
        {
          finalPeriodMonths: 24,
          finalSubscriptionPlanId: "plan-1",
          finalVehicleId: "vehicle-1",
          version: 2
        },
        harness.user,
        harness.context
      )
    ).rejects.toMatchObject({ code: "JOURNEY_IDEMPOTENCY_CONFLICT" });
    expect(
      harness.customerService.applyJourneyFinalPlanDecision
    ).not.toHaveBeenCalled();
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
    },
    subscriptionJourneyStep: {
      upsert: vi.fn(async () => ({
        code: SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION,
        id: "step-vehicle-allocation",
        journeyId: "journey-1",
        status: "PENDING"
      }))
    }
  };
}

function customerConfirmationTransaction() {
  return {
    subscriptionJourney: {
      findUnique: vi.fn(async () => ({
        application: {
          finalPlanCommercialHash: FINAL_PLAN_COMMERCIAL_HASH,
          finalPlanRevision: 1
        },
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
        version: 3
      }))
    }
  };
}

function finalPlanReplayHarness() {
  const journey = {
    application: {
      finalPeriodMonths: 12,
      finalPlanCommercialHash: FINAL_PLAN_COMMERCIAL_HASH,
      finalPlanRevision: 1,
      finalSubscriptionPlanId: "plan-1",
      finalVehicleId: "vehicle-1",
      id: "application-1"
    },
    applicationId: "application-1",
    currentStepCode: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
    id: "journey-1",
    status: SubscriptionJourneyStatus.RUNNING,
    steps: [
      {
        code: SubscriptionJourneyStepCode.FINAL_PLAN_DECISION,
        status: SubscriptionJourneyStepStatus.COMPLETED
      }
    ],
    version: 4
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: journey.id }]),
    subscriptionJourney: {
      findUnique: vi.fn(async () => journey)
    }
  };
  const prisma = transactionHost(tx);
  const customerService = {
    applyJourneyFinalPlanDecision: vi.fn(async () => undefined)
  };
  const service = new SubscriptionJourneyService(
    {} as never,
    prisma as never,
    customerService as never
  );
  return {
    context: { ipAddress: "127.0.0.1", userAgent: "vitest" },
    customerService,
    service,
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      menus: [],
      name: "Admin",
      permissions: [],
      roles: ["ADMIN"],
      username: "admin"
    }
  };
}

function validationTransaction(overrides: Record<string, unknown> = {}) {
  return {
    subscriptionJourney: {
      findUnique: vi.fn(async () => ({
        applicationId: "application-1",
        currentStepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
        id: "journey-1",
        lastApplicationFactVersion: 0,
        steps: [
          {
            code: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
            id: "step-validation"
          }
        ],
        version: 0,
        ...overrides
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
    journeyFactVersion: 0,
    materialReviewStatus: OrderReviewStatus.APPROVED,
    orders: [],
    productReviewStatus: OrderReviewStatus.PENDING,
    softReservedVehicleId: null,
    status: ApplicationStatus.SUBMITTED,
    vehicleReviewStatus: OrderReviewStatus.PENDING,
    ...overrides
  };
}
