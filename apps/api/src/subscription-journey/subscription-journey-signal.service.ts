import { Injectable } from "@nestjs/common";
import {
  Prisma,
  SubscriptionJourneyStatus,
  SubscriptionJourneyManualDecision,
  SubscriptionJourneyManualTaskStatus,
  SubscriptionJourneyStepCode
} from "@prisma/client";

import { journeyError } from "./subscription-journey.errors";
import { SubscriptionJourneyRepository } from "./subscription-journey.repository";
import { JourneySignalInput } from "./subscription-journey.types";
import { SubscriptionJourneyRuntimeConfig } from "./subscription-journey.config";

@Injectable()
export class SubscriptionJourneySignalService {
  constructor(
    private readonly repository: SubscriptionJourneyRepository,
    private readonly config: SubscriptionJourneyRuntimeConfig
  ) {}

  async record(
    tx: Prisma.TransactionClient,
    input: JourneySignalInput
  ): Promise<void> {
    if (input.type === "APPLICATION_SUBMITTED") {
      if (!input.applicationId) {
        throw journeyError(
          "JOURNEY_NOT_FOUND",
          "An application id is required to start a subscription journey."
        );
      }
      const existingJourney = await tx.subscriptionJourney.findUnique({
        where: { applicationId: input.applicationId }
      });
      if (!existingJourney) {
        if (!this.config.enabled) return;
        const application = await tx.application.findUnique({
          select: { customerId: true },
          where: { id: input.applicationId }
        });
        if (!application) {
          throw journeyError(
            "JOURNEY_NOT_FOUND",
            "The subscription application was not found."
          );
        }
        if (
          !this.config.permitsEnrollment(
            input.applicationId,
            application.customerId
          )
        ) {
          return;
        }
      }
      await this.repository.createOrGetForApplication(
        tx,
        input.applicationId,
        input.eventKey
      );
      return;
    }
    if (!input.applicationId && !input.orderId) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "An application or order id is required to record a journey signal."
      );
    }
    if (input.applicationId) {
      const existingJourney = await tx.subscriptionJourney.findUnique({
        where: { applicationId: input.applicationId }
      });
      if (!existingJourney) return;
    }
    if (input.orderId) {
      const existingJourney = await tx.subscriptionJourney.findUnique({
        where: { orderId: input.orderId }
      });
      if (!existingJourney) return;
    }
    await this.repository.recordSignal(tx, input);
  }

  async terminateApplication(
    tx: Prisma.TransactionClient,
    input: {
      actionId: string;
      applicationId: string;
      factVersion: number;
      outcome: "CANCELLED" | "REJECTED";
      reason: string;
    }
  ): Promise<void> {
    const journey = await tx.subscriptionJourney.findUnique({
      include: { steps: true },
      where: { applicationId: input.applicationId }
    });
    if (!journey || journey.status === SubscriptionJourneyStatus.CANCELLED) {
      return;
    }
    if (journey.status === SubscriptionJourneyStatus.COMPLETED) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "A completed subscription journey cannot be terminated from the application."
      );
    }
    const step = journey.steps.find(({ code }) => code === journey.currentStepCode);
    if (!step) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The current subscription journey step was not found."
      );
    }
    await this.repository.rejectForApplication(tx, {
      eventKey:
        `application:${input.applicationId}:terminated:` +
        `${input.outcome.toLowerCase()}:${input.actionId}`,
      expectedVersion: journey.version,
      factVersion: input.factVersion,
      journeyId: journey.id,
      payload: {
        decision: input.outcome,
        factVersion: input.factVersion,
        reasonCodes: [`APPLICATION_${input.outcome}`]
      },
      stepId: step.id
    });
  }

  async completeManualDecision(
    tx: Prisma.TransactionClient,
    input: {
      actorId: string;
      applicationId: string;
      expectedStepCode: SubscriptionJourneyStepCode;
      payload: Prisma.InputJsonValue;
    }
  ): Promise<void> {
    const journey = await tx.subscriptionJourney.findUnique({
      include: {
        manualTasks: {
          where: { status: SubscriptionJourneyManualTaskStatus.OPEN }
        },
        steps: true
      },
      where: { applicationId: input.applicationId }
    });
    if (!journey) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The subscription journey was not found."
      );
    }
    if (journey.currentStepCode !== input.expectedStepCode) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "The manual decision does not match the current journey step."
      );
    }
    const step = journey.steps.find(({ code }) => code === input.expectedStepCode);
    const task = journey.manualTasks.find(({ stepId }) => stepId === step?.id);
    if (!step || !task) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The open subscription journey manual task was not found."
      );
    }
    await this.repository.decideManualTask(tx, {
      decidedBy: input.actorId,
      decision: SubscriptionJourneyManualDecision.APPROVED,
      expectedVersion: task.version,
      journeyId: journey.id,
      taskId: task.id
    });
    const revision =
      typeof input.payload === "object" &&
      input.payload !== null &&
      !Array.isArray(input.payload) &&
      "finalPlanRevision" in input.payload
        ? String(input.payload.finalPlanRevision)
        : "approved";
    await this.repository.completeStep(tx, {
      eventKey: `journey:${journey.id}:step:${input.expectedStepCode}:decision:${revision}`,
      expectedVersion: journey.version,
      journeyId: journey.id,
      payload: input.payload,
      stepId: step.id
    });
  }

  async completeFinalPlanAndVehicleAllocation(
    tx: Prisma.TransactionClient,
    input: {
      actorId: string;
      applicationId: string;
      finalPlanCommercialHash: string;
      finalPlanRevision: number;
      vehicleId: string;
    }
  ): Promise<void> {
    const journey = await tx.subscriptionJourney.findUnique({
      include: {
        manualTasks: {
          where: { status: SubscriptionJourneyManualTaskStatus.OPEN }
        },
        steps: true
      },
      where: { applicationId: input.applicationId }
    });
    if (!journey) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The subscription journey was not found."
      );
    }
    if (
      journey.currentStepCode !==
      SubscriptionJourneyStepCode.FINAL_PLAN_DECISION
    ) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "The final-plan publication does not match the current journey step."
      );
    }
    if (
      input.finalPlanRevision < 1 ||
      !/^sha256:[0-9a-f]{64}$/i.test(input.finalPlanCommercialHash)
    ) {
      throw journeyError(
        "JOURNEY_IDEMPOTENCY_CONFLICT",
        "The final-plan publication identity is invalid."
      );
    }

    const finalPlanStep = journey.steps.find(
      ({ code }) => code === SubscriptionJourneyStepCode.FINAL_PLAN_DECISION
    );
    const task = journey.manualTasks.find(
      ({ stepId }) => stepId === finalPlanStep?.id
    );
    if (!finalPlanStep || !task) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The open final-plan decision task was not found."
      );
    }
    const vehicleStep = await tx.subscriptionJourneyStep.upsert({
      create: {
        code: SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION,
        journeyId: journey.id
      },
      update: {},
      where: {
        journeyId_code: {
          code: SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION,
          journeyId: journey.id
        }
      }
    });
    const payload = {
      finalPlanCommercialHash: input.finalPlanCommercialHash,
      finalPlanRevision: input.finalPlanRevision,
      vehicleId: input.vehicleId
    } satisfies Prisma.InputJsonValue;
    const hashKey = input.finalPlanCommercialHash.slice("sha256:".length, 23);

    await this.repository.decideManualTask(tx, {
      decidedBy: input.actorId,
      decision: SubscriptionJourneyManualDecision.APPROVED,
      expectedVersion: task.version,
      journeyId: journey.id,
      taskId: task.id
    });
    await this.repository.completeStep(tx, {
      eventKey:
        `journey:${journey.id}:step:FINAL_PLAN_DECISION:` +
        `revision:${input.finalPlanRevision}:hash:${hashKey}`,
      expectedVersion: journey.version,
      journeyId: journey.id,
      payload,
      stepId: finalPlanStep.id
    });
    await this.repository.completeStep(tx, {
      eventKey:
        `journey:${journey.id}:step:FINAL_VEHICLE_ALLOCATION:` +
        `revision:${input.finalPlanRevision}:hash:${hashKey}`,
      expectedVersion: journey.version + 1,
      journeyId: journey.id,
      payload,
      stepId: vehicleStep.id
    });
  }

  async completeHandoverEvidenceDecision(
    tx: Prisma.TransactionClient,
    input: {
      actorId: string;
      decision: SubscriptionJourneyManualDecision;
      manifestHash: string;
      notes?: string;
      orderId: string;
      workOrderId: string;
    }
  ): Promise<void> {
    const journey = await tx.subscriptionJourney.findUnique({
      include: {
        manualTasks: {
          where: { status: SubscriptionJourneyManualTaskStatus.OPEN }
        },
        steps: true
      },
      where: { orderId: input.orderId }
    });
    if (!journey) return;
    if (
      journey.currentStepCode !==
      SubscriptionJourneyStepCode.DELIVERY_EVIDENCE_DECISION
    ) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "The aggregate delivery-evidence decision does not match the current journey step."
      );
    }
    const step = journey.steps.find(
      ({ code }) =>
        code === SubscriptionJourneyStepCode.DELIVERY_EVIDENCE_DECISION
    );
    const task = journey.manualTasks.find(({ stepId }) => stepId === step?.id);
    if (!step || !task) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The open delivery-evidence decision task was not found."
      );
    }
    const snapshot = readRecord(task.inputSnapshot);
    if (
      snapshot?.workOrderId !== input.workOrderId ||
      snapshot?.manifestHash !== input.manifestHash
    ) {
      throw journeyError(
        "JOURNEY_IDEMPOTENCY_CONFLICT",
        "The aggregate delivery-evidence decision does not match the queued evidence snapshot."
      );
    }
    const decision = input.decision;
    const manifestKey = input.manifestHash.slice(0, 16);
    await this.repository.recordSignal(tx, {
      eventKey: `handover:${input.workOrderId}:ops:${decision.toLowerCase()}:${manifestKey}`,
      orderId: input.orderId,
      payload: {
        decision,
        manifestHash: input.manifestHash,
        workOrderId: input.workOrderId
      },
      type: "HANDOVER_OPS_REVIEWED"
    });
    await this.repository.decideManualTask(tx, {
      decidedBy: input.actorId,
      decision,
      decisionNotes: input.notes,
      expectedVersion: task.version,
      journeyId: journey.id,
      taskId: task.id
    });
    const expectedVersion = journey.version + 1;
    const eventKey =
      `journey:${journey.id}:dr:${input.workOrderId}:` +
      `${manifestKey.slice(0, 12)}:${decision === SubscriptionJourneyManualDecision.APPROVED ? "a" : "r"}`;
    const payload = {
      decision,
      manifestHash: input.manifestHash,
      workOrderId: input.workOrderId
    } as Prisma.InputJsonValue;
    if (decision === SubscriptionJourneyManualDecision.APPROVED) {
      await this.repository.completeStep(tx, {
        eventKey,
        expectedVersion,
        journeyId: journey.id,
        payload,
        stepId: step.id
      });
      return;
    }
    await this.repository.returnToHandoverEvidence(tx, {
      decisionStepId: step.id,
      eventKey,
      expectedVersion,
      journeyId: journey.id,
      payload
    });
  }

  async requireCustomerReconfirmationAfterManualDecision(
    tx: Prisma.TransactionClient,
    input: {
      actorId: string;
      applicationId: string;
      finalPlanRevision: number;
      vehicleId: string;
    }
  ): Promise<void> {
    const journey = await tx.subscriptionJourney.findUnique({
      include: {
        manualTasks: {
          where: { status: SubscriptionJourneyManualTaskStatus.OPEN }
        },
        steps: true
      },
      where: { applicationId: input.applicationId }
    });
    if (!journey) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The subscription journey was not found."
      );
    }
    if (
      journey.currentStepCode ===
      SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION
    ) {
      return;
    }
    if (
      journey.currentStepCode !==
      SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION
    ) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "Vehicle reconfirmation does not match the current journey step."
      );
    }
    const vehicleStep = journey.steps.find(
      ({ code }) => code === SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION
    );
    const task = journey.manualTasks.find(
      ({ stepId }) => stepId === vehicleStep?.id
    );
    if (!vehicleStep || !task) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The open vehicle-allocation task was not found."
      );
    }
    await this.repository.decideManualTask(tx, {
      decidedBy: input.actorId,
      decision: SubscriptionJourneyManualDecision.APPROVED,
      expectedVersion: task.version,
      journeyId: journey.id,
      taskId: task.id
    });
    await this.repository.returnToCustomerConfirmation(tx, {
      eventKey: `journey:${journey.id}:step:FINAL_VEHICLE_ALLOCATION:revision:${input.finalPlanRevision}:reconfirmation`,
      expectedVersion: journey.version,
      journeyId: journey.id,
      payload: {
        finalPlanRevision: input.finalPlanRevision,
        vehicleId: input.vehicleId
      },
      vehicleStepId: vehicleStep.id
    });
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
