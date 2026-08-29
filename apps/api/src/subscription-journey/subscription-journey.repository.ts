import { Injectable } from "@nestjs/common";
import {
  Prisma,
  SubscriptionJourney,
  SubscriptionJourneyEventType,
  SubscriptionJourneyException,
  SubscriptionJourneyExceptionStatus,
  SubscriptionJourneyJob,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyManualTask,
  SubscriptionJourneyManualTaskStatus,
  SubscriptionJourneyOutboxStatus,
  SubscriptionJourneyStatus,
  SubscriptionJourneyStep,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus
} from "@prisma/client";
import { randomUUID } from "node:crypto";

import { journeyError } from "./subscription-journey.errors";
import { sameJourneyJson } from "./subscription-journey-json";
import {
  assertTransition,
  manualTaskTypeFor,
  nextStep
} from "./subscription-journey-state-machine";
import {
  CompleteJourneyStepInput,
  CompleteJourneyActivationInput,
  DeadLetterJourneyJobInput,
  DecideManualTaskInput,
  EnqueueJourneyJobInput,
  JourneyFailure,
  JourneySignalInput,
  ClaimedJourneyOutbox,
  JourneyOperationalMetrics,
  OpenManualTaskInput,
  RejectJourneyForApplicationInput,
  RecordJourneyExceptionInput,
  RescheduleJourneyJobInput,
  WaitForCustomerInput,
  WaitForManualInput
} from "./subscription-journey.types";

type Tx = Prisma.TransactionClient;
type LockedJourneyStep = {
  currentStepCode: SubscriptionJourneyStepCode;
  currentStepStatus: SubscriptionJourneyStepStatus;
  journeyId: string;
  journeyStatus: SubscriptionJourneyStatus;
  journeyVersion: number;
  stepCode: SubscriptionJourneyStepCode;
  stepId: string;
  stepStatus: SubscriptionJourneyStepStatus;
};

@Injectable()
export class SubscriptionJourneyRepository {
  async pauseForOperationalRestriction(
    tx: Tx,
    input: {
      expectedVersion: number;
      journeyId: string;
      reasons: Prisma.InputJsonValue;
      stepId: string;
    }
  ): Promise<void> {
    assertSafePayload(input.reasons);
    const locked = await lockJourneyStep(tx, input.journeyId, input.stepId);
    validateCurrentStep(locked, input.expectedVersion);
    if (
      locked.stepCode !== SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION ||
      locked.journeyStatus !== SubscriptionJourneyStatus.RUNNING
    ) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "Only a running authoritative activation can wait for operational clearance."
      );
    }
    await this.updateJourneyVersion(tx, input.journeyId, input.expectedVersion, {
      pausedFromStatus: SubscriptionJourneyStatus.RUNNING,
      status: SubscriptionJourneyStatus.PAUSED,
      version: { increment: 1 }
    });
    await this.writeEventAndOutbox(tx, {
      eventKey: `journey:${input.journeyId}:activation:operational-clearance:version:${input.expectedVersion}`,
      eventType: SubscriptionJourneyEventType.JOURNEY_PAUSED,
      journeyId: input.journeyId,
      payload: safePayload({
        operation: "WAIT_FOR_OPERATIONAL_CLEARANCE",
        reasons: input.reasons,
        stepId: input.stepId
      }),
      sequence: input.expectedVersion + 1
    });
  }

  async createOrGetForApplication(
    tx: Tx,
    applicationId: string,
    eventKey: string
  ): Promise<SubscriptionJourney> {
    const payload = safePayload({ applicationId });
    await lockIdempotencyKey(tx, "journey-event", eventKey);
    const existing = await tx.subscriptionJourneyEvent.findUnique({
      include: { journey: true },
      where: { eventKey }
    });
    if (existing) {
      if (
        existing.eventType !== SubscriptionJourneyEventType.JOURNEY_STARTED ||
        existing.journey.applicationId !== applicationId ||
        !sameJourneyJson(existing.payload, payload)
      ) {
        throw idempotencyConflict();
      }
      return existing.journey;
    }
    const journey = await tx.subscriptionJourney.upsert({
      create: {
        applicationId,
        currentStepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
        steps: {
          create: {
            code: SubscriptionJourneyStepCode.APPLICATION_VALIDATION
          }
        }
      },
      update: {},
      where: { applicationId }
    });
    await tx.subscriptionJourneyEvent.upsert({
      create: {
        eventKey,
        eventType: SubscriptionJourneyEventType.JOURNEY_STARTED,
        journeyId: journey.id,
        payload,
        // Journey versions begin at zero. Keep the start event aligned with
        // that version so the first state transition can claim sequence 1.
        sequence: 0
      },
      update: {},
      where: { eventKey }
    });
    await this.writeOutbox(tx, {
      aggregateId: applicationId,
      aggregateType: "APPLICATION",
      eventKey: `${eventKey}:outbox`,
      eventType: SubscriptionJourneyEventType.JOURNEY_STARTED,
      journeyId: journey.id,
      payload
    });
    return journey;
  }

  async completeStep(
    tx: Tx,
    input: CompleteJourneyStepInput
  ): Promise<SubscriptionJourneyStep> {
    assertSafePayload(input.payload);
    const eventPayload = transitionPayload(
      "COMPLETE_STEP",
      input.stepId,
      input.payload
    );
    await lockIdempotencyKey(tx, "journey-event", input.eventKey);
    const duplicate = await tx.subscriptionJourneyEvent.findUnique({
      where: { eventKey: input.eventKey }
    });
    if (duplicate) {
      requireExactEvent(duplicate, {
        eventType: SubscriptionJourneyEventType.STEP_COMPLETED,
        journeyId: input.journeyId,
        payload: eventPayload
      });
      await this.resolveStepExceptions(tx, input.journeyId, input.stepId);
      return this.readStep(tx, input.stepId, input.journeyId);
    }

    const locked = await lockJourneyStep(tx, input.journeyId, input.stepId);
    validateCurrentStep(locked, input.expectedVersion);
    await this.advanceJourney(tx, input, locked);
    const step = await tx.subscriptionJourneyStep.update({
      data: {
        completedAt: new Date(),
        status: SubscriptionJourneyStepStatus.COMPLETED
      },
      where: {
        id_journeyId: { id: input.stepId, journeyId: input.journeyId }
      }
    });
    await this.resolveStepExceptions(tx, input.journeyId, input.stepId);
    await this.writeEventAndOutbox(tx, {
      eventKey: input.eventKey,
      eventType: SubscriptionJourneyEventType.STEP_COMPLETED,
      journeyId: input.journeyId,
      payload: eventPayload,
      sequence: input.expectedVersion + 1
    });
    return step;
  }

  async completeActivation(
    tx: Tx,
    input: CompleteJourneyActivationInput
  ): Promise<SubscriptionJourneyStep> {
    const eventBase = `journey:${input.journeyId}:activation`;
    const payload = safePayload(input.payload ?? {});
    const step = await this.completeStep(tx, {
      eventKey: `${eventBase}:step`,
      expectedVersion: input.expectedVersion,
      journeyId: input.journeyId,
      payload,
      stepId: input.stepId
    });
    const completionEventKey = `${eventBase}:completed`;
    await lockIdempotencyKey(tx, "journey-event", completionEventKey);
    const duplicate = await tx.subscriptionJourneyEvent.findUnique({
      where: { eventKey: completionEventKey }
    });
    const completionPayload = safePayload({
      operation: "COMPLETE_JOURNEY",
      payload,
      stepId: input.stepId
    });
    if (duplicate) {
      requireExactEvent(duplicate, {
        eventType: SubscriptionJourneyEventType.JOURNEY_COMPLETED,
        journeyId: input.journeyId,
        payload: completionPayload
      });
      return step;
    }
    await this.updateJourneyVersion(
      tx,
      input.journeyId,
      input.expectedVersion + 1,
      { version: { increment: 1 } }
    );
    await this.writeEventAndOutbox(tx, {
      eventKey: completionEventKey,
      eventType: SubscriptionJourneyEventType.JOURNEY_COMPLETED,
      journeyId: input.journeyId,
      payload: completionPayload,
      sequence: input.expectedVersion + 2
    });
    return step;
  }

  async waitForCustomer(
    tx: Tx,
    input: WaitForCustomerInput
  ): Promise<SubscriptionJourneyStep> {
    assertSafePayload(input.payload);
    const eventPayload = transitionPayload(
      "WAIT_FOR_CUSTOMER",
      input.stepId,
      input.payload
    );
    await lockIdempotencyKey(tx, "journey-event", input.eventKey);
    const duplicate = await tx.subscriptionJourneyEvent.findUnique({
      where: { eventKey: input.eventKey }
    });
    if (duplicate) {
      requireExactEvent(duplicate, {
        eventType: SubscriptionJourneyEventType.STEP_WAITING_CUSTOMER,
        journeyId: input.journeyId,
        payload: eventPayload
      });
      return this.readStep(tx, input.stepId, input.journeyId);
    }
    const locked = await lockJourneyStep(tx, input.journeyId, input.stepId);
    validateCurrentStep(locked, input.expectedVersion);
    await this.updateJourneyVersion(tx, input.journeyId, input.expectedVersion, {
      currentStepCode: locked.stepCode,
      currentStepStatus: SubscriptionJourneyStepStatus.WAITING_CUSTOMER,
      ...(input.factVersion === undefined
        ? {}
        : { lastApplicationFactVersion: input.factVersion }),
      status: SubscriptionJourneyStatus.WAITING_CUSTOMER,
      version: { increment: 1 }
    });
    const step = await tx.subscriptionJourneyStep.update({
      data: {
        status: SubscriptionJourneyStepStatus.WAITING_CUSTOMER,
        waitingAt: new Date(),
        ...(input.factVersion === undefined
          ? {}
          : { waitingReasonSnapshot: input.payload ?? { factVersion: input.factVersion } })
      },
      where: {
        id_journeyId: { id: input.stepId, journeyId: input.journeyId }
      }
    });
    await this.writeEventAndOutbox(tx, {
      eventKey: input.eventKey,
      eventType: SubscriptionJourneyEventType.STEP_WAITING_CUSTOMER,
      journeyId: input.journeyId,
      payload: eventPayload,
      sequence: input.expectedVersion + 1
    });
    return step;
  }

  async waitForManual(
    tx: Tx,
    input: WaitForManualInput
  ): Promise<SubscriptionJourneyStep> {
    assertSafePayload(input.payload);
    const eventPayload = transitionPayload(
      "WAIT_FOR_MANUAL",
      input.stepId,
      input.payload
    );
    await lockIdempotencyKey(tx, "journey-event", input.eventKey);
    const duplicate = await tx.subscriptionJourneyEvent.findUnique({
      where: { eventKey: input.eventKey }
    });
    if (duplicate) {
      requireExactEvent(duplicate, {
        eventType: SubscriptionJourneyEventType.STEP_WAITING_MANUAL,
        journeyId: input.journeyId,
        payload: eventPayload
      });
      return this.readStep(tx, input.stepId, input.journeyId);
    }
    const locked = await lockJourneyStep(tx, input.journeyId, input.stepId);
    validateCurrentStep(locked, input.expectedVersion);
    await this.updateJourneyVersion(tx, input.journeyId, input.expectedVersion, {
      currentStepCode: locked.stepCode,
      currentStepStatus: SubscriptionJourneyStepStatus.WAITING_MANUAL,
      lastApplicationFactVersion: input.factVersion,
      status: SubscriptionJourneyStatus.WAITING_MANUAL,
      version: { increment: 1 }
    });
    const step = await tx.subscriptionJourneyStep.update({
      data: {
        status: SubscriptionJourneyStepStatus.WAITING_MANUAL,
        waitingAt: new Date(),
        waitingReasonSnapshot: input.payload ?? { factVersion: input.factVersion }
      },
      where: {
        id_journeyId: { id: input.stepId, journeyId: input.journeyId }
      }
    });
    await this.writeEventAndOutbox(tx, {
      eventKey: input.eventKey,
      eventType: SubscriptionJourneyEventType.STEP_WAITING_MANUAL,
      journeyId: input.journeyId,
      payload: eventPayload,
      sequence: input.expectedVersion + 1
    });
    return step;
  }

  async rejectForApplication(
    tx: Tx,
    input: RejectJourneyForApplicationInput
  ): Promise<SubscriptionJourneyStep> {
    assertSafePayload(input.payload);
    const eventPayload = transitionPayload(
      "REJECT_APPLICATION",
      input.stepId,
      input.payload
    );
    await lockIdempotencyKey(tx, "journey-event", input.eventKey);
    const duplicate = await tx.subscriptionJourneyEvent.findUnique({
      where: { eventKey: input.eventKey }
    });
    if (duplicate) {
      requireExactEvent(duplicate, {
        eventType: SubscriptionJourneyEventType.JOURNEY_CANCELLED,
        journeyId: input.journeyId,
        payload: eventPayload
      });
      return this.readStep(tx, input.stepId, input.journeyId);
    }
    const locked = await lockJourneyStep(tx, input.journeyId, input.stepId);
    validateCurrentStep(locked, input.expectedVersion);
    await this.updateJourneyVersion(tx, input.journeyId, input.expectedVersion, {
      cancelledAt: new Date(),
      currentStepStatus: SubscriptionJourneyStepStatus.CANCELLED,
      lastApplicationFactVersion: input.factVersion,
      status: SubscriptionJourneyStatus.CANCELLED,
      version: { increment: 1 }
    });
    const step = await tx.subscriptionJourneyStep.update({
      data: {
        status: SubscriptionJourneyStepStatus.CANCELLED,
        waitingReasonSnapshot: input.payload ?? { factVersion: input.factVersion }
      },
      where: {
        id_journeyId: { id: input.stepId, journeyId: input.journeyId }
      }
    });
    await tx.subscriptionJourneyJob.updateMany({
      data: {
        completedAt: new Date(),
        leaseExpiresAt: null,
        leaseToken: null,
        status: SubscriptionJourneyJobStatus.CANCELLED
      },
      where: {
        ...(input.activeJobId ? { id: { not: input.activeJobId } } : {}),
        journeyId: input.journeyId,
        status: {
          notIn: [
            SubscriptionJourneyJobStatus.COMPLETED,
            SubscriptionJourneyJobStatus.CANCELLED
          ]
        }
      }
    });
    await tx.subscriptionJourneyOutbox.updateMany({
      data: {
        leaseExpiresAt: null,
        leaseToken: null,
        status: SubscriptionJourneyOutboxStatus.CANCELLED
      },
      where: {
        journeyId: input.journeyId,
        status: {
          in: [
            SubscriptionJourneyOutboxStatus.PENDING,
            SubscriptionJourneyOutboxStatus.PROCESSING
          ]
        }
      }
    });
    await tx.subscriptionJourneyManualTask.updateMany({
      data: { status: SubscriptionJourneyManualTaskStatus.CANCELLED },
      where: {
        journeyId: input.journeyId,
        status: SubscriptionJourneyManualTaskStatus.OPEN
      }
    });
    await tx.subscriptionJourneyStep.updateMany({
      data: { status: SubscriptionJourneyStepStatus.CANCELLED },
      where: {
        id: { not: input.stepId },
        journeyId: input.journeyId,
        status: {
          notIn: [
            SubscriptionJourneyStepStatus.COMPLETED,
            SubscriptionJourneyStepStatus.CANCELLED
          ]
        }
      }
    });
    await this.writeEventAndOutbox(tx, {
      eventKey: input.eventKey,
      eventType: SubscriptionJourneyEventType.JOURNEY_CANCELLED,
      journeyId: input.journeyId,
      payload: eventPayload,
      sequence: input.expectedVersion + 1
    });
    return step;
  }

  async openManualTask(
    tx: Tx,
    input: OpenManualTaskInput
  ): Promise<SubscriptionJourneyManualTask> {
    assertSafePayload(input.inputSnapshot);
    const locked = await lockJourneyStep(tx, input.journeyId, input.stepId);
    validateCurrentStep(locked, locked.journeyVersion);
    const taskType = manualTaskTypeFor(locked.stepCode);
    if (!taskType) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "This journey step does not support a manual task."
      );
    }
    const existing = await tx.subscriptionJourneyManualTask.findFirst({
      where: {
        journeyId: input.journeyId,
        status: SubscriptionJourneyManualTaskStatus.OPEN,
        taskType
      }
    });
    if (existing) return existing;
    try {
      const task = await tx.subscriptionJourneyManualTask.create({
        data: {
          inputSnapshot: input.inputSnapshot,
          journeyId: input.journeyId,
          stepId: input.stepId,
          taskType
        }
      });
      await this.updateJourneyVersion(
        tx,
        input.journeyId,
        locked.journeyVersion,
        {
          currentStepCode: locked.stepCode,
          currentStepStatus: SubscriptionJourneyStepStatus.WAITING_MANUAL,
          status: SubscriptionJourneyStatus.WAITING_MANUAL,
          version: { increment: 1 }
        }
      );
      await tx.subscriptionJourneyStep.update({
        data: {
          status: SubscriptionJourneyStepStatus.WAITING_MANUAL,
          waitingAt: new Date()
        },
        where: {
          id_journeyId: { id: input.stepId, journeyId: input.journeyId }
        }
      });
      await this.writeEventAndOutbox(tx, {
        eventKey: `journey:${input.journeyId}:step:${locked.stepCode}:waiting-manual`,
        eventType: SubscriptionJourneyEventType.STEP_WAITING_MANUAL,
        journeyId: input.journeyId,
        payload: safePayload({
          operation: "OPEN_MANUAL_TASK",
          stepId: input.stepId,
          taskId: task.id
        }),
        sequence: locked.journeyVersion + 1
      });
      return task;
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw journeyError(
          "JOURNEY_MANUAL_TASK_ALREADY_OPEN",
          "An open manual task already exists for this journey decision."
        );
      }
      throw error;
    }
  }

  async decideManualTask(
    tx: Tx,
    input: DecideManualTaskInput
  ): Promise<SubscriptionJourneyManualTask> {
    const updated = await tx.subscriptionJourneyManualTask.updateMany({
      data: {
        decidedAt: new Date(),
        decidedBy: input.decidedBy,
        decision: input.decision,
        decisionNotes: safeText(input.decisionNotes),
        status: SubscriptionJourneyManualTaskStatus.COMPLETED,
        version: { increment: 1 }
      },
      where: {
        id: input.taskId,
        journeyId: input.journeyId,
        status: SubscriptionJourneyManualTaskStatus.OPEN,
        version: input.expectedVersion
      }
    });
    if (updated.count !== 1) {
      throw optimisticConflict();
    }
    const task = await tx.subscriptionJourneyManualTask.findFirst({
      where: { id: input.taskId, journeyId: input.journeyId }
    });
    if (!task) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The subscription journey manual task was not found."
      );
    }
    return task;
  }

  async returnToCustomerConfirmation(
    tx: Tx,
    input: {
      eventKey: string;
      expectedVersion: number;
      journeyId: string;
      payload: Prisma.InputJsonValue;
      vehicleStepId: string;
    }
  ): Promise<SubscriptionJourneyStep> {
    assertSafePayload(input.payload);
    const eventPayload = safePayload({
      operation: "REQUIRE_PLAN_RECONFIRMATION",
      payload: input.payload,
      stepId: input.vehicleStepId
    });
    await lockIdempotencyKey(tx, "journey-event", input.eventKey);
    const duplicate = await tx.subscriptionJourneyEvent.findUnique({
      where: { eventKey: input.eventKey }
    });
    if (duplicate) {
      requireExactEvent(duplicate, {
        eventType: SubscriptionJourneyEventType.STEP_WAITING_CUSTOMER,
        journeyId: input.journeyId,
        payload: eventPayload
      });
      const existing = await tx.subscriptionJourneyStep.findUnique({
        where: {
          journeyId_code: {
            code: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
            journeyId: input.journeyId
          }
        }
      });
      if (!existing) {
        throw journeyError(
          "JOURNEY_NOT_FOUND",
          "The customer-confirmation step was not found."
        );
      }
      return existing;
    }

    const locked = await lockJourneyStep(
      tx,
      input.journeyId,
      input.vehicleStepId
    );
    validateCurrentStep(locked, input.expectedVersion);
    if (locked.stepCode !== SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "Only vehicle allocation can return to customer confirmation."
      );
    }
    const customerStep = await tx.subscriptionJourneyStep.upsert({
      create: {
        code: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
        journeyId: input.journeyId,
        status: SubscriptionJourneyStepStatus.WAITING_CUSTOMER,
        waitingAt: new Date()
      },
      update: {
        completedAt: null,
        status: SubscriptionJourneyStepStatus.WAITING_CUSTOMER,
        waitingAt: new Date()
      },
      where: {
        journeyId_code: {
          code: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
          journeyId: input.journeyId
        }
      }
    });
    await tx.subscriptionJourneyStep.update({
      data: {
        completedAt: new Date(),
        status: SubscriptionJourneyStepStatus.COMPLETED
      },
      where: {
        id_journeyId: {
          id: input.vehicleStepId,
          journeyId: input.journeyId
        }
      }
    });
    await this.updateJourneyVersion(
      tx,
      input.journeyId,
      input.expectedVersion,
      {
        currentStepCode: SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
        currentStepStatus: SubscriptionJourneyStepStatus.WAITING_CUSTOMER,
        status: SubscriptionJourneyStatus.WAITING_CUSTOMER,
        version: { increment: 1 }
      }
    );
    await this.writeEventAndOutbox(tx, {
      eventKey: input.eventKey,
      eventType: SubscriptionJourneyEventType.STEP_WAITING_CUSTOMER,
      journeyId: input.journeyId,
      payload: eventPayload,
      sequence: input.expectedVersion + 1
    });
    return customerStep;
  }

  async returnToHandoverEvidence(
    tx: Tx,
    input: {
      decisionStepId: string;
      eventKey: string;
      expectedVersion: number;
      journeyId: string;
      payload: Prisma.InputJsonValue;
    }
  ): Promise<SubscriptionJourneyStep> {
    assertSafePayload(input.payload);
    const eventPayload = safePayload({
      operation: "REJECT_DELIVERY_EVIDENCE",
      payload: input.payload,
      stepId: input.decisionStepId
    });
    await lockIdempotencyKey(tx, "journey-event", input.eventKey);
    const duplicate = await tx.subscriptionJourneyEvent.findUnique({
      where: { eventKey: input.eventKey }
    });
    if (duplicate) {
      requireExactEvent(duplicate, {
        eventType: SubscriptionJourneyEventType.MANUAL_TASK_DECIDED,
        journeyId: input.journeyId,
        payload: eventPayload
      });
      const existing = await tx.subscriptionJourneyStep.findUnique({
        where: {
          journeyId_code: {
            code: SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION,
            journeyId: input.journeyId
          }
        }
      });
      if (!existing) {
        throw journeyError(
          "JOURNEY_NOT_FOUND",
          "The handover evidence-preparation step was not found."
        );
      }
      return existing;
    }
    const locked = await lockJourneyStep(
      tx,
      input.journeyId,
      input.decisionStepId
    );
    validateCurrentStep(locked, input.expectedVersion);
    if (
      locked.stepCode !==
      SubscriptionJourneyStepCode.DELIVERY_EVIDENCE_DECISION
    ) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "Only a delivery-evidence rejection can return to handover preparation."
      );
    }
    const handoverStep = await tx.subscriptionJourneyStep.upsert({
      create: {
        code: SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION,
        journeyId: input.journeyId,
        startedAt: new Date(),
        status: SubscriptionJourneyStepStatus.RUNNING
      },
      update: {
        completedAt: null,
        startedAt: new Date(),
        status: SubscriptionJourneyStepStatus.RUNNING,
        waitingAt: null
      },
      where: {
        journeyId_code: {
          code: SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION,
          journeyId: input.journeyId
        }
      }
    });
    await tx.subscriptionJourneyStep.update({
      data: {
        completedAt: null,
        status: SubscriptionJourneyStepStatus.PENDING,
        waitingAt: null
      },
      where: {
        id_journeyId: {
          id: input.decisionStepId,
          journeyId: input.journeyId
        }
      }
    });
    await this.updateJourneyVersion(
      tx,
      input.journeyId,
      input.expectedVersion,
      {
        currentStepCode:
          SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION,
        currentStepStatus: SubscriptionJourneyStepStatus.RUNNING,
        status: SubscriptionJourneyStatus.RUNNING,
        version: { increment: 1 }
      }
    );
    await this.writeEventAndOutbox(tx, {
      eventKey: input.eventKey,
      eventType: SubscriptionJourneyEventType.MANUAL_TASK_DECIDED,
      journeyId: input.journeyId,
      payload: eventPayload,
      sequence: input.expectedVersion + 1
    });
    return handoverStep;
  }

  async enqueueJob(
    tx: Tx,
    input: EnqueueJourneyJobInput
  ): Promise<SubscriptionJourneyJob> {
    assertSafePayload(input.payload);
    await lockIdempotencyKey(tx, "journey-job", input.sourceKey);
    const existing = await tx.subscriptionJourneyJob.findUnique({
      where: { sourceKey: input.sourceKey }
    });
    if (existing) {
      if (
        existing.journeyId !== input.journeyId ||
        existing.stepId !== input.stepId ||
        existing.jobType !== input.jobType ||
        !sameJourneyJson(existing.payload, input.payload ?? null)
      ) {
        throw idempotencyConflict();
      }
      return existing;
    }
    return tx.subscriptionJourneyJob.upsert({
      create: {
        availableAt: input.availableAt,
        jobType: input.jobType,
        journeyId: input.journeyId,
        maxAttempts: input.maxAttempts,
        payload: input.payload,
        sourceKey: input.sourceKey,
        stepId: input.stepId
      },
      update: {},
      where: { sourceKey: input.sourceKey }
    });
  }

  async recordException(
    tx: Tx,
    input: RecordJourneyExceptionInput
  ): Promise<SubscriptionJourneyException> {
    const locked = await lockJourneyStep(tx, input.journeyId, input.stepId);
    return this.recordLockedException(tx, input, locked);
  }

  private async recordLockedException(
    tx: Tx,
    input: RecordJourneyExceptionInput,
    locked: LockedJourneyStep
  ): Promise<SubscriptionJourneyException> {
    const failure = safeFailure(input.error);
    const alreadyTerminal =
      ([
        SubscriptionJourneyStepStatus.COMPLETED,
        SubscriptionJourneyStepStatus.SKIPPED,
        SubscriptionJourneyStepStatus.CANCELLED
      ] as SubscriptionJourneyStepStatus[]).includes(locked.stepStatus) ||
      locked.journeyStatus === SubscriptionJourneyStatus.COMPLETED ||
      locked.journeyStatus === SubscriptionJourneyStatus.CANCELLED;
    const exception = await tx.subscriptionJourneyException.create({
      data: {
        code: failure.code,
        jobId: input.jobId,
        journeyId: input.journeyId,
        message: failure.message,
        ...(alreadyTerminal
          ? {
              resolutionNotes:
                "Automatically resolved because the journey or step was already terminal.",
              resolvedAt: new Date(),
              status: SubscriptionJourneyExceptionStatus.RESOLVED
            }
          : {}),
        retryable: failure.retryable,
        stepId: input.stepId
      }
    });
    if (
      alreadyTerminal ||
      locked.currentStepCode !== locked.stepCode
    ) {
      return exception;
    }
    await tx.subscriptionJourneyStep.update({
      data: {
        attemptCount: { increment: 1 },
        lastErrorCode: failure.code,
        status: SubscriptionJourneyStepStatus.EXCEPTION
      },
      where: {
        id_journeyId: { id: input.stepId, journeyId: input.journeyId }
      }
    });
    await this.updateJourneyVersion(
      tx,
      input.journeyId,
      locked.journeyVersion,
      locked.journeyStatus === SubscriptionJourneyStatus.PAUSED
        ? {
            currentStepStatus: SubscriptionJourneyStepStatus.EXCEPTION,
            pausedFromStatus: SubscriptionJourneyStatus.EXCEPTION,
            status: SubscriptionJourneyStatus.PAUSED,
            version: { increment: 1 }
          }
        : {
            currentStepStatus: SubscriptionJourneyStepStatus.EXCEPTION,
            status: SubscriptionJourneyStatus.EXCEPTION,
            version: { increment: 1 }
          }
    );
    await this.writeEventAndOutbox(tx, {
      eventKey: `journey:${input.journeyId}:exception:${exception.id}`,
      eventType: SubscriptionJourneyEventType.STEP_EXCEPTION,
      journeyId: input.journeyId,
      payload: safePayload({
        errorCode: failure.code,
        jobId: input.jobId ?? null,
        operation: "RECORD_EXCEPTION",
        retryable: failure.retryable,
        stepId: input.stepId
      }),
      sequence: locked.journeyVersion + 1
    });
    return exception;
  }

  async recordSignal(tx: Tx, input: JourneySignalInput): Promise<void> {
    assertSafePayload(input.payload);
    await lockIdempotencyKey(tx, "journey-event", input.eventKey);
    const journey = await tx.subscriptionJourney.findFirst({
      where: input.applicationId
        ? { applicationId: input.applicationId }
        : { orderId: input.orderId }
    });
    if (!journey) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The subscription journey was not found."
      );
    }
    const existing = await tx.subscriptionJourneyEvent.findUnique({
      where: { eventKey: input.eventKey }
    });
    const persistedPayload = existing?.payload;
    const journeyVersion =
      persistedPayload &&
      typeof persistedPayload === "object" &&
      !Array.isArray(persistedPayload) &&
      typeof persistedPayload.journeyVersion === "number"
        ? persistedPayload.journeyVersion
        : journey.version + 1;
    const sourcePayload = input.payload;
    const payload = safePayload({
      ...(sourcePayload &&
      typeof sourcePayload === "object" &&
      !Array.isArray(sourcePayload)
        ? sourcePayload
        : { value: sourcePayload ?? null }),
      journeyVersion,
      signalType: input.type
    });
    if (existing) {
      requireExactEvent(existing, {
        eventType: SubscriptionJourneyEventType.DOMAIN_FACT_OBSERVED,
        journeyId: journey.id,
        payload
      });
      return;
    }
    await this.updateJourneyVersion(tx, journey.id, journey.version, {
      version: { increment: 1 }
    });
    await this.writeEventAndOutbox(tx, {
      eventKey: input.eventKey,
      eventType: SubscriptionJourneyEventType.DOMAIN_FACT_OBSERVED,
      journeyId: journey.id,
      payload,
      sequence: journey.version + 1
    });
  }

  async claimJobs(tx: Tx, limit: number, leaseMs: number) {
    if (!validClaim(limit, leaseMs)) return [];
    const leaseToken = randomUUID();
    const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT job."id"
      FROM "subscription_journey_job" job
      JOIN "subscription_journey" journey ON journey."id" = job."journey_id"
      WHERE (
        (job."status" IN ('PENDING', 'RETRY_SCHEDULED') AND job."available_at" <= clock_timestamp())
        OR (job."status" = 'PROCESSING' AND job."lease_expires_at" <= clock_timestamp())
      )
        AND journey."status" NOT IN ('PAUSED', 'CANCELLED', 'COMPLETED')
      ORDER BY job."available_at" ASC, job."created_at" ASC
      LIMIT ${limit}
      FOR UPDATE OF job SKIP LOCKED
    `);
    const ids = candidates.map(({ id }) => id);
    if (ids.length === 0) return [];
    await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_journey_job"
      SET "status" = 'PROCESSING',
          "lease_token" = ${leaseToken},
          "lease_expires_at" = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
          "updated_at" = clock_timestamp()
      WHERE "id" IN (${Prisma.join(ids)})
        AND (
          ("status" IN ('PENDING', 'RETRY_SCHEDULED') AND "available_at" <= clock_timestamp())
          OR ("status" = 'PROCESSING' AND "lease_expires_at" <= clock_timestamp())
        )
    `);
    const rows = await tx.subscriptionJourneyJob.findMany({
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      where: { id: { in: ids }, leaseToken }
    });
    return rows.filter(hasLease);
  }

  async claimOutbox(
    tx: Tx,
    limit: number,
    leaseMs: number
  ): Promise<ClaimedJourneyOutbox[]> {
    return this.claimOutboxByMode(tx, limit, leaseMs, "all");
  }

  async claimSignalOutbox(
    tx: Tx,
    limit: number,
    leaseMs: number
  ): Promise<ClaimedJourneyOutbox[]> {
    return this.claimOutboxByMode(tx, limit, leaseMs, "signal");
  }

  async claimNotificationOutbox(
    tx: Tx,
    limit: number,
    leaseMs: number
  ): Promise<ClaimedJourneyOutbox[]> {
    return this.claimOutboxByMode(tx, limit, leaseMs, "notification");
  }

  private async claimOutboxByMode(
    tx: Tx,
    limit: number,
    leaseMs: number,
    mode: "all" | "notification" | "signal"
  ): Promise<ClaimedJourneyOutbox[]> {
    if (!validClaim(limit, leaseMs)) return [];
    const leaseToken = randomUUID();
    const typePredicate =
      mode === "signal"
        ? Prisma.sql`"aggregate_type" <> 'JOURNEY_NOTIFICATION'`
        : mode === "notification"
          ? Prisma.sql`"aggregate_type" = 'JOURNEY_NOTIFICATION'`
          : Prisma.sql`TRUE`;
    const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "subscription_journey_outbox"
      WHERE (
        ("status" = 'PENDING' AND "available_at" <= clock_timestamp())
        OR ("status" = 'PROCESSING' AND "lease_expires_at" <= clock_timestamp())
      )
        AND ${typePredicate}
      ORDER BY "available_at" ASC, "created_at" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    const ids = candidates.map(({ id }) => id);
    if (ids.length === 0) return [];
    await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_journey_outbox"
      SET "status" = 'PROCESSING',
          "lease_token" = ${leaseToken},
          "lease_expires_at" = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
          "updated_at" = clock_timestamp()
      WHERE "id" IN (${Prisma.join(ids)})
        AND (
          ("status" = 'PENDING' AND "available_at" <= clock_timestamp())
          OR ("status" = 'PROCESSING' AND "lease_expires_at" <= clock_timestamp())
        )
        AND ${typePredicate}
    `);
    const rows = await tx.subscriptionJourneyOutbox.findMany({
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      where: { id: { in: ids }, leaseToken }
    });
    return rows.filter(hasLease);
  }

  async enqueueNotificationOutbox(
    tx: Tx,
    source: ClaimedJourneyOutbox
  ): Promise<void> {
    if (!source.journeyId) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The subscription journey notification is missing its journey id."
      );
    }
    const payload = safePayload({
      eventKey: source.eventKey,
      eventType: source.eventType,
      sourceOutboxId: source.id
    });
    await tx.subscriptionJourneyOutbox.upsert({
      create: {
        aggregateId: source.journeyId,
        aggregateType: "JOURNEY_NOTIFICATION",
        eventKey: `journey-notification:${source.id}`,
        eventType: source.eventType,
        journeyId: source.journeyId,
        payload
      },
      update: {},
      where: { eventKey: `journey-notification:${source.id}` }
    });
  }

  async completeJob(
    tx: Tx,
    jobId: string,
    leaseToken: string,
    result?: Prisma.InputJsonValue
  ): Promise<void> {
    assertSafePayload(result);
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_journey_job"
      SET
        "status" = 'COMPLETED',
        "completed_at" = clock_timestamp(),
        "last_error_code" = NULL,
        "last_error_message" = NULL,
        "lease_expires_at" = NULL,
        "lease_token" = NULL,
        "updated_at" = clock_timestamp()
      WHERE "id" = ${jobId}
        AND "status" = 'PROCESSING'
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > clock_timestamp()
    `);
    requireLease(updated);
  }

  async completeOutbox(
    tx: Tx,
    outboxId: string,
    leaseToken: string
  ): Promise<void> {
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_journey_outbox"
      SET
        "status" = 'DELIVERED',
        "delivered_at" = clock_timestamp(),
        "last_error_code" = NULL,
        "last_error_message" = NULL,
        "lease_expires_at" = NULL,
        "lease_token" = NULL,
        "updated_at" = clock_timestamp()
      WHERE "id" = ${outboxId}
        AND "status" = 'PROCESSING'
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > clock_timestamp()
    `);
    requireLease(updated);
  }

  async rescheduleOutbox(
    tx: Tx,
    outboxId: string,
    leaseToken: string,
    input: RescheduleJourneyJobInput
  ): Promise<void> {
    if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0) {
      throw new RangeError("Journey retry delay must be a non-negative integer.");
    }
    const failure = safeFailure(input.error);
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_journey_outbox"
      SET
        "status" = 'PENDING',
        "attempt_count" = "attempt_count" + 1,
        "available_at" = clock_timestamp() + (${input.delayMs} * interval '1 millisecond'),
        "last_error_code" = ${failure.code},
        "last_error_message" = ${failure.message},
        "lease_expires_at" = NULL,
        "lease_token" = NULL,
        "updated_at" = clock_timestamp()
      WHERE "id" = ${outboxId}
        AND "status" = 'PROCESSING'
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > clock_timestamp()
    `);
    requireLease(updated);
  }

  async deadLetterOutbox(
    tx: Tx,
    outboxId: string,
    leaseToken: string,
    error: JourneyFailure
  ): Promise<void> {
    const failure = safeFailure(error);
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_journey_outbox"
      SET
        "status" = 'DEAD_LETTER',
        "attempt_count" = "attempt_count" + 1,
        "last_error_code" = ${failure.code},
        "last_error_message" = ${failure.message},
        "lease_expires_at" = NULL,
        "lease_token" = NULL,
        "updated_at" = clock_timestamp()
      WHERE "id" = ${outboxId}
        AND "status" = 'PROCESSING'
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > clock_timestamp()
    `);
    requireLease(updated);
  }

  async readOperationalMetrics(tx: Tx): Promise<JourneyOperationalMetrics> {
    const now = new Date();
    const jobActivity = await tx.subscriptionJourneyJob.aggregate({
      _max: { updatedAt: true }
    });
    const successfulJobs = await tx.subscriptionJourneyJob.aggregate({
      _max: { completedAt: true },
      where: { status: SubscriptionJourneyJobStatus.COMPLETED }
    });
    const lastEvent = await tx.subscriptionJourneyEvent.aggregate({
      _max: { createdAt: true }
    });
    const outboxActivity = await tx.subscriptionJourneyOutbox.aggregate({
      _max: { deliveredAt: true, updatedAt: true }
    });
    const pendingJobWhere: Prisma.SubscriptionJourneyJobWhereInput = {
      OR: [
        {
          availableAt: { lte: now },
          status: {
            in: [
              SubscriptionJourneyJobStatus.PENDING,
              SubscriptionJourneyJobStatus.RETRY_SCHEDULED
            ]
          }
        },
        {
          leaseExpiresAt: { lte: now },
          status: SubscriptionJourneyJobStatus.PROCESSING
        }
      ]
    };
    const pendingOutboxWhere: Prisma.SubscriptionJourneyOutboxWhereInput = {
      OR: [
        {
          availableAt: { lte: now },
          status: SubscriptionJourneyOutboxStatus.PENDING
        },
        {
          leaseExpiresAt: { lte: now },
          status: SubscriptionJourneyOutboxStatus.PROCESSING
        }
      ]
    };
    const oldestPendingJob = await tx.subscriptionJourneyJob.findFirst({
      orderBy: { availableAt: "asc" },
      select: { availableAt: true },
      where: pendingJobWhere
    });
    const oldestPendingOutbox = await tx.subscriptionJourneyOutbox.findFirst({
      orderBy: { availableAt: "asc" },
      select: { availableAt: true },
      where: pendingOutboxWhere
    });
    const oldestOpenException = await tx.subscriptionJourneyException.findFirst({
      orderBy: { firstOccurredAt: "asc" },
      select: { firstOccurredAt: true },
      where: { status: SubscriptionJourneyExceptionStatus.OPEN }
    });
    const pendingJobCount = await tx.subscriptionJourneyJob.count({
      where: pendingJobWhere
    });
    const pendingOutboxCount = await tx.subscriptionJourneyOutbox.count({
      where: pendingOutboxWhere
    });
    const openExceptionCount = await tx.subscriptionJourneyException.count({
      where: { status: SubscriptionJourneyExceptionStatus.OPEN }
    });
    return {
      lastEventAt: lastEvent._max.createdAt,
      lastSuccessfulJobAt: successfulJobs._max.completedAt,
      oldestOpenExceptionAt: oldestOpenException?.firstOccurredAt ?? null,
      oldestPendingJobAt: oldestPendingJob?.availableAt ?? null,
      oldestPendingOutboxAt: oldestPendingOutbox?.availableAt ?? null,
      openExceptionCount,
      pendingJobCount,
      pendingOutboxCount,
      workerHeartbeatAt: latestDate(
        jobActivity._max.updatedAt,
        outboxActivity._max.updatedAt
      )
    };
  }

  async rescheduleJob(
    tx: Tx,
    jobId: string,
    leaseToken: string,
    input: RescheduleJourneyJobInput
  ): Promise<void> {
    if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0) {
      throw new RangeError("Journey retry delay must be a non-negative integer.");
    }
    const failure = safeFailure(input.error);
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_journey_job"
      SET
        "status" = 'RETRY_SCHEDULED',
        "attempt_count" = "attempt_count" + 1,
        "available_at" = clock_timestamp() + (${input.delayMs} * interval '1 millisecond'),
        "last_error_code" = ${failure.code},
        "last_error_message" = ${failure.message},
        "lease_expires_at" = NULL,
        "lease_token" = NULL,
        "updated_at" = clock_timestamp()
      WHERE "id" = ${jobId}
        AND "status" = 'PROCESSING'
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > clock_timestamp()
    `);
    requireLease(updated);
  }

  async deadLetterJob(
    tx: Tx,
    input: DeadLetterJourneyJobInput
  ): Promise<SubscriptionJourneyException> {
    const failure = safeFailure(input.error);
    const locked = await lockJourneyStep(tx, input.journeyId, input.stepId);
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_journey_job"
      SET
        "status" = 'DEAD_LETTER',
        "attempt_count" = "attempt_count" + 1,
        "completed_at" = clock_timestamp(),
        "last_error_code" = ${failure.code},
        "last_error_message" = ${failure.message},
        "lease_expires_at" = NULL,
        "lease_token" = NULL,
        "updated_at" = clock_timestamp()
      WHERE "id" = ${input.jobId}
        AND "status" = 'PROCESSING'
        AND "lease_token" = ${input.leaseToken}
        AND "lease_expires_at" > clock_timestamp()
    `);
    requireLease(updated);
    return this.recordLockedException(tx, { ...input, error: failure }, locked);
  }

  private async advanceJourney(
    tx: Tx,
    input: CompleteJourneyStepInput,
    locked: LockedJourneyStep
  ) {
    let followingStep = nextStep(locked.stepCode, "COMPLETED");
    let skippedCompletedVehicleStep = false;
    if (
      followingStep === SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION
    ) {
      const vehicleStep = await tx.subscriptionJourneyStep.findUnique({
        where: {
          journeyId_code: {
            code: SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION,
            journeyId: input.journeyId
          }
        }
      });
      if (vehicleStep?.status === SubscriptionJourneyStepStatus.COMPLETED) {
        followingStep = nextStep(vehicleStep.code, "COMPLETED");
        skippedCompletedVehicleStep = true;
      }
    }
    if (followingStep && !skippedCompletedVehicleStep) {
      assertTransition(locked.stepCode, followingStep);
    }
    await this.updateJourneyVersion(tx, input.journeyId, input.expectedVersion, {
      completedAt: followingStep ? undefined : new Date(),
      currentStepCode: followingStep ?? locked.stepCode,
      currentStepStatus: followingStep
        ? SubscriptionJourneyStepStatus.PENDING
        : SubscriptionJourneyStepStatus.COMPLETED,
      ...(input.factVersion === undefined
        ? {}
        : { lastApplicationFactVersion: input.factVersion }),
      status: followingStep
        ? SubscriptionJourneyStatus.RUNNING
        : SubscriptionJourneyStatus.COMPLETED,
      version: { increment: 1 }
    });
  }

  private async updateJourneyVersion(
    tx: Tx,
    journeyId: string,
    expectedVersion: number,
    data: Prisma.SubscriptionJourneyUpdateManyMutationInput
  ) {
    const updated = await tx.subscriptionJourney.updateMany({
      data,
      where: { id: journeyId, version: expectedVersion }
    });
    if (updated.count !== 1) throw optimisticConflict();
  }

  private resolveStepExceptions(tx: Tx, journeyId: string, stepId: string) {
    return tx.subscriptionJourneyException.updateMany({
      data: {
        resolutionNotes: "Automatically resolved after successful step completion.",
        resolvedAt: new Date(),
        status: SubscriptionJourneyExceptionStatus.RESOLVED
      },
      where: {
        journeyId,
        status: {
          in: [
            SubscriptionJourneyExceptionStatus.OPEN,
            SubscriptionJourneyExceptionStatus.ACKNOWLEDGED
          ]
        },
        stepId
      }
    });
  }

  private async readStep(tx: Tx, stepId: string, journeyId: string) {
    const step = await tx.subscriptionJourneyStep.findUnique({
      where: { id_journeyId: { id: stepId, journeyId } }
    });
    if (!step) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The subscription journey step was not found."
      );
    }
    return step;
  }

  private async writeEventAndOutbox(
    tx: Tx,
    input: {
      eventKey: string;
      eventType: SubscriptionJourneyEventType;
      journeyId: string;
      payload: Prisma.InputJsonValue;
      sequence: number;
    }
  ) {
    const payload = safePayload(input.payload);
    await tx.subscriptionJourneyEvent.create({ data: { ...input, payload } });
    await this.writeOutbox(tx, {
      aggregateId: input.journeyId,
      aggregateType: "SUBSCRIPTION_JOURNEY",
      eventKey: `${input.eventKey}:outbox`,
      eventType: input.eventType,
      journeyId: input.journeyId,
      payload
    });
  }

  private writeOutbox(
    tx: Tx,
    input: {
      aggregateId: string;
      aggregateType: string;
      eventKey: string;
      eventType: string;
      journeyId: string;
      payload: Prisma.InputJsonValue;
    }
  ) {
    return tx.subscriptionJourneyOutbox.upsert({
      create: input,
      update: {},
      where: { eventKey: input.eventKey }
    });
  }
}

function latestDate(...values: Array<Date | null>): Date | null {
  return values.reduce<Date | null>((latest, value) => {
    if (!value) return latest;
    return !latest || value > latest ? value : latest;
  }, null);
}

function requireLease(count: number) {
  if (count !== 1) {
    throw journeyError(
      "JOURNEY_LEASE_LOST",
      "The subscription journey lease is no longer active.",
      true
    );
  }
}

function validClaim(limit: number, leaseMs: number) {
  return Number.isSafeInteger(limit) && limit > 0 && Number.isSafeInteger(leaseMs) && leaseMs > 0;
}

function hasLease<T extends { leaseExpiresAt: Date | null; leaseToken: string | null }>(
  row: T
): row is T & { leaseExpiresAt: Date; leaseToken: string } {
  return row.leaseExpiresAt instanceof Date && typeof row.leaseToken === "string";
}

function optimisticConflict() {
  return journeyError(
    "JOURNEY_OPTIMISTIC_LOCK_CONFLICT",
    "The subscription journey changed before this operation completed.",
    true
  );
}

function idempotencyConflict() {
  return journeyError(
    "JOURNEY_IDEMPOTENCY_CONFLICT",
    "The journey idempotency key is already assigned to another operation."
  );
}

async function lockIdempotencyKey(
  tx: Tx,
  namespace: string,
  key: string
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT
      pg_advisory_xact_lock(
        hashtextextended(${`${namespace}:${key}`}, 0)
      ) IS NULL AS "acquired"
  `);
}

async function lockJourneyStep(
  tx: Tx,
  journeyId: string,
  stepId: string
): Promise<LockedJourneyStep> {
  const [row] = await tx.$queryRaw<LockedJourneyStep[]>(Prisma.sql`
    SELECT
      journey."id" AS "journeyId",
      journey."status" AS "journeyStatus",
      journey."version" AS "journeyVersion",
      journey."current_step_code" AS "currentStepCode",
      journey."current_step_status" AS "currentStepStatus",
      step."id" AS "stepId",
      step."code" AS "stepCode",
      step."status" AS "stepStatus"
    FROM "subscription_journey" AS journey
    INNER JOIN "subscription_journey_step" AS step
      ON step."journey_id" = journey."id"
      AND step."id" = ${stepId}
    WHERE journey."id" = ${journeyId}
    FOR UPDATE OF journey, step
  `);
  if (!row) {
    throw journeyError(
      "JOURNEY_NOT_FOUND",
      "The subscription journey step was not found."
    );
  }
  return row;
}

function validateCurrentStep(
  locked: LockedJourneyStep,
  expectedVersion: number
): void {
  if (locked.journeyVersion !== expectedVersion) {
    throw optimisticConflict();
  }
  if (
    locked.journeyStatus === SubscriptionJourneyStatus.COMPLETED ||
    locked.journeyStatus === SubscriptionJourneyStatus.CANCELLED ||
    locked.journeyStatus === SubscriptionJourneyStatus.PAUSED ||
    locked.currentStepCode !== locked.stepCode ||
    locked.currentStepStatus !== locked.stepStatus ||
    !([
      SubscriptionJourneyStepStatus.PENDING,
      SubscriptionJourneyStepStatus.RUNNING,
      SubscriptionJourneyStepStatus.WAITING_CUSTOMER,
      SubscriptionJourneyStepStatus.WAITING_MANUAL,
      SubscriptionJourneyStepStatus.RETRY_SCHEDULED
    ] as SubscriptionJourneyStepStatus[]).includes(locked.stepStatus)
  ) {
    throw journeyError(
      "JOURNEY_INVALID_TRANSITION",
      "The persisted subscription journey step cannot make this transition."
    );
  }
}

function transitionPayload(
  operation:
    | "COMPLETE_STEP"
    | "REJECT_APPLICATION"
    | "WAIT_FOR_CUSTOMER"
    | "WAIT_FOR_MANUAL",
  stepId: string,
  payload: Prisma.InputJsonValue | undefined
): Prisma.InputJsonValue {
  return safePayload({ operation, payload: payload ?? null, stepId });
}

function requireExactEvent(
  existing: {
    eventType: SubscriptionJourneyEventType;
    journeyId: string;
    payload: Prisma.JsonValue;
  },
  expected: {
    eventType: SubscriptionJourneyEventType;
    journeyId: string;
    payload: Prisma.InputJsonValue;
  }
): void {
  if (
    existing.eventType !== expected.eventType ||
    existing.journeyId !== expected.journeyId ||
    !sameJourneyJson(existing.payload, expected.payload)
  ) {
    throw idempotencyConflict();
  }
}

function isUniqueConflict(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

const FORBIDDEN_KEYS = new Set([
  "accesstoken",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "customerphone",
  "headers",
  "idcard",
  "identitynumber",
  "bankcard",
  "cardnumber",
  "callbackbody",
  "cvv",
  "password",
  "privatekey",
  "providerbody",
  "providerresponse",
  "providertoken",
  "rawbody",
  "rawpayload",
  "rawresponse",
  "requestheaders",
  "responseheaders",
  "refreshtoken",
  "secret",
  "token"
]);

export function assertSafePayload(value: unknown, seen = new Set<object>()): void {
  if (typeof value === "string") {
    if (unsafeText(value)) {
      throw journeyError(
        "JOURNEY_SENSITIVE_PAYLOAD",
        "Journey payload must not contain credentials, raw provider data, or personal payment data."
      );
    }
    return;
  }
  if (value === null || value === undefined || typeof value !== "object") return;
  if (seen.has(value)) {
    throw journeyError(
      "JOURNEY_SENSITIVE_PAYLOAD",
      "Journey payload must be serializable and free of sensitive values."
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => assertSafePayload(item, seen));
    seen.delete(value);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (FORBIDDEN_KEYS.has(normalized)) {
      throw journeyError(
        "JOURNEY_SENSITIVE_PAYLOAD",
        "Journey payload must not contain credentials or secrets."
      );
    }
    assertSafePayload(item, seen);
  }
  seen.delete(value);
}

function safePayload(value: Prisma.InputJsonValue): Prisma.InputJsonValue {
  assertSafePayload(value);
  return value;
}

function safeFailure(error: JourneyFailure): JourneyFailure {
  const code = error.code.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
  const rawMessage = error.message.trim();
  const message =
    rawMessage && !unsafeText(rawMessage)
      ? safeText(rawMessage)!
      : "Journey operation failed.";
  return {
    code: code || "JOURNEY_OPERATION_FAILED",
    message,
    retryable: error.retryable
  };
}

function unsafeText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/\b(?:bearer|basic)\s+[a-z0-9+/_=.-]+/i.test(trimmed)) return true;
  if (
    /\b(?:password|secret|token|authorization|cookie|id\s*card|bank\s*card|card\s*number|cvv|phone|mobile)\s*[:=]/i.test(
      trimmed
    )
  ) {
    return true;
  }
  if (/\b1[3-9]\d{9}\b/.test(trimmed)) return true;
  if (/\b\d{13,19}\b/.test(trimmed)) return true;
  if (/^\s*(?:\[|\{)/.test(trimmed)) return true;
  return false;
}

function safeText(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 512) : undefined;
}
