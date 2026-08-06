import { Injectable } from "@nestjs/common";
import {
  Prisma,
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
    await this.repository.recordSignal(tx, input);
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
