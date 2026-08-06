import { Injectable } from "@nestjs/common";
import {
  Prisma,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStepCode
} from "@prisma/client";

import { journeyError } from "./subscription-journey.errors";
import { SubscriptionJourneyRepository } from "./subscription-journey.repository";
import {
  ClaimedJourneyOutbox,
  JourneyOperationalMetrics
} from "./subscription-journey.types";

type Tx = Prisma.TransactionClient;

const JOB_TYPE_BY_STEP: Partial<
  Record<SubscriptionJourneyStepCode, SubscriptionJourneyJobType>
> = {
  APPLICATION_VALIDATION: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
  AUTHORITATIVE_ACTIVATION:
    SubscriptionJourneyJobType.ACTIVATE_SUBSCRIPTION,
  CUSTOMER_JSAPI_PAYMENT:
    SubscriptionJourneyJobType.EVALUATE_PAYMENT_SETTLEMENT,
  FADADA_SIGNING_AND_ARCHIVE:
    SubscriptionJourneyJobType.START_FADADA_SIGNING,
  HANDOVER_AND_STAGE2_CREATION:
    SubscriptionJourneyJobType.CREATE_HANDOVER,
  INITIAL_BILLING: SubscriptionJourneyJobType.GENERATE_INITIAL_BILLS,
  ORDER_AND_CONTRACT_CREATION:
    SubscriptionJourneyJobType.CREATE_ORDER_AND_CONTRACT
};

@Injectable()
export class SubscriptionJourneyService {
  constructor(private readonly repository: SubscriptionJourneyRepository) {}

  async dispatchSignalOutbox(
    tx: Tx,
    outbox: ClaimedJourneyOutbox
  ): Promise<void> {
    if (!outbox.journeyId) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The subscription journey signal is missing its journey id."
      );
    }
    const current = await this.readCurrentJourney(tx, outbox.journeyId);
    await this.repository.enqueueNotificationOutbox(tx, outbox);
    const jobType = JOB_TYPE_BY_STEP[current.currentStepCode];
    if (!jobType) return;
    await this.repository.enqueueJob(tx, {
      jobType,
      journeyId: current.id,
      payload: {
        applicationId: current.applicationId,
        finalPlanRevision: current.application.finalPlanRevision,
        orderId: current.orderId,
        stepCode: current.currentStepCode
      },
      sourceKey: stableStepSourceKey(
        current.id,
        current.currentStepCode,
        current.application.finalPlanRevision
      ),
      stepId: current.step.id
    });
  }

  async dispatchNotificationOutbox(
    tx: Tx,
    outbox: ClaimedJourneyOutbox
  ): Promise<void> {
    if (!outbox.journeyId) return;
    const current = await this.readCurrentJourney(tx, outbox.journeyId);
    await this.repository.enqueueJob(tx, {
      jobType: SubscriptionJourneyJobType.DISPATCH_NOTIFICATION,
      journeyId: current.id,
      payload: {
        eventKey: outbox.eventKey,
        eventType: outbox.eventType,
        outboxId: outbox.id
      },
      sourceKey: `journey:${current.id}:notification:${outbox.id}`,
      stepId: current.step.id
    });
  }

  async attachOrder(tx: Tx, journeyId: string, orderId: string): Promise<void> {
    const updated = await tx.subscriptionJourney.updateMany({
      data: { orderId },
      where: {
        id: journeyId,
        OR: [{ orderId: null }, { orderId }]
      }
    });
    if (updated.count !== 1) {
      throw journeyError(
        "JOURNEY_IDEMPOTENCY_CONFLICT",
        "The subscription journey is already attached to another order."
      );
    }
  }

  getOperationalMetrics(tx: Tx): Promise<JourneyOperationalMetrics> {
    return this.repository.readOperationalMetrics(tx);
  }

  private async readCurrentJourney(tx: Tx, journeyId: string) {
    const journey = await tx.subscriptionJourney.findUnique({
      include: {
        application: { select: { finalPlanRevision: true } },
        steps: true
      },
      where: { id: journeyId }
    });
    if (!journey) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The subscription journey was not found."
      );
    }
    const step =
      journey.steps.find(({ code }) => code === journey.currentStepCode) ??
      (await tx.subscriptionJourneyStep.upsert({
        create: {
          code: journey.currentStepCode,
          journeyId: journey.id
        },
        update: {},
        where: {
          journeyId_code: {
            code: journey.currentStepCode,
            journeyId: journey.id
          }
        }
      }));
    return { ...journey, step };
  }
}

function stableStepSourceKey(
  journeyId: string,
  stepCode: SubscriptionJourneyStepCode,
  finalPlanRevision: number
) {
  return `journey:${journeyId}:step:${stepCode}:revision:${finalPlanRevision}`;
}
