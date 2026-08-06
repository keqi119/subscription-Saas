import { Injectable, Optional } from "@nestjs/common";
import {
  Prisma,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStepCode
} from "@prisma/client";

import { journeyError } from "./subscription-journey.errors";
import { SubscriptionJourneyRepository } from "./subscription-journey.repository";
import { manualTaskTypeFor } from "./subscription-journey-state-machine";
import {
  ClaimedJourneyJob,
  ClaimedJourneyOutbox,
  JourneyOperationalMetrics
} from "./subscription-journey.types";
import { CustomerService } from "../customer/customer.service";
import { OrderEntitlementService } from "../order/order-entitlement.service";
import { OrderService } from "../order/order.service";
import { PrismaService } from "../prisma/prisma.service";

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
  constructor(
    private readonly repository: SubscriptionJourneyRepository,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly customerService?: CustomerService,
    @Optional() private readonly orderService?: OrderService,
    @Optional() private readonly orderEntitlementService?: OrderEntitlementService
  ) {}

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
    if (
      current.currentStepCode ===
      SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION
    ) {
      const isExactConfirmation =
        outbox.eventType === "DOMAIN_FACT_OBSERVED" &&
        isRecord(outbox.payload) &&
        outbox.payload.signalType === "CUSTOMER_PLAN_CONFIRMED" &&
        outbox.payload.revision === current.application.finalPlanRevision;
      if (isExactConfirmation) {
        await this.repository.completeStep(tx, {
          eventKey: `journey:${current.id}:step:CUSTOMER_PLAN_CONFIRMATION:revision:${current.application.finalPlanRevision}:completed`,
          expectedVersion: current.version,
          journeyId: current.id,
          payload: {
            finalPlanRevision: current.application.finalPlanRevision
          },
          stepId: current.step.id
        });
        return;
      }
      if (
        current.currentStepStatus ===
        "WAITING_CUSTOMER"
      ) {
        return;
      }
      await this.repository.waitForCustomer(tx, {
        eventKey: `journey:${current.id}:step:CUSTOMER_PLAN_CONFIRMATION:revision:${current.application.finalPlanRevision}:waiting`,
        expectedVersion: current.version,
        journeyId: current.id,
        payload: { finalPlanRevision: current.application.finalPlanRevision },
        stepId: current.step.id
      });
      return;
    }
    if (manualTaskTypeFor(current.currentStepCode)) {
      await this.repository.openManualTask(tx, {
        inputSnapshot: {
          applicationId: current.applicationId,
          finalPlanRevision: current.application.finalPlanRevision
        },
        journeyId: current.id,
        stepId: current.step.id
      });
      return;
    }
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
        current.application.finalPlanRevision,
        current.currentStepCode ===
          SubscriptionJourneyStepCode.APPLICATION_VALIDATION &&
          isRecord(outbox.payload) &&
          typeof outbox.payload.journeyVersion === "number"
          ? outbox.payload.journeyVersion
          : undefined
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

  async validateApplicationJob(
    job: ClaimedJourneyJob
  ): Promise<Prisma.InputJsonValue> {
    if (!this.prisma || !this.customerService) {
      throw journeyError(
        "JOURNEY_CONFIGURATION_ERROR",
        "The subscription journey application validator is not configured."
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const journey = await tx.subscriptionJourney.findUnique({
        include: { steps: true },
        where: { id: job.journeyId }
      });
      if (!journey) {
        throw journeyError(
          "JOURNEY_NOT_FOUND",
          "The subscription journey was not found."
        );
      }
      if (
        journey.currentStepCode !==
        SubscriptionJourneyStepCode.APPLICATION_VALIDATION
      ) {
        return {
          action: "APPLICATION_VALIDATION_ALREADY_COMPLETED",
          applicationId: journey.applicationId
        };
      }
      const step = journey.steps.find(
        ({ code }) => code === SubscriptionJourneyStepCode.APPLICATION_VALIDATION
      );
      if (!step || step.id !== job.stepId) {
        throw journeyError(
          "JOURNEY_INVALID_TRANSITION",
          "The application validation job does not match the current journey step."
        );
      }
      await this.customerService!.validateJourneyApplication(
        tx,
        journey.applicationId
      );
      await this.repository.completeStep(tx, {
        eventKey: `journey:${journey.id}:step:APPLICATION_VALIDATION:completed`,
        expectedVersion: journey.version,
        journeyId: journey.id,
        payload: { applicationId: journey.applicationId },
        stepId: step.id
      });
      return {
        action: "APPLICATION_VALIDATED",
        applicationId: journey.applicationId
      };
    });
  }

  async createOrderAndContractJob(
    job: ClaimedJourneyJob
  ): Promise<Prisma.InputJsonValue> {
    if (
      !this.prisma ||
      !this.customerService ||
      !this.orderService ||
      !this.orderEntitlementService
    ) {
      throw journeyError(
        "JOURNEY_CONFIGURATION_ERROR",
        "The subscription journey order bootstrap is not configured."
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "subscription_journey"
        WHERE "id" = ${job.journeyId}
        FOR UPDATE
      `);
      const journey = await tx.subscriptionJourney.findUnique({
        include: {
          application: {
            select: { finalPlanRevision: true, salesUserId: true }
          },
          steps: true
        },
        where: { id: job.journeyId }
      });
      if (!journey) {
        throw journeyError(
          "JOURNEY_NOT_FOUND",
          "The subscription journey was not found."
        );
      }
      if (
        journey.currentStepCode !==
        SubscriptionJourneyStepCode.ORDER_AND_CONTRACT_CREATION
      ) {
        if (!journey.orderId) {
          throw journeyError(
            "JOURNEY_IDEMPOTENCY_CONFLICT",
            "The journey advanced without an attached order."
          );
        }
        return {
          action: "ORDER_AND_CONTRACT_ALREADY_COMPLETED",
          applicationId: journey.applicationId,
          orderId: journey.orderId
        };
      }
      const step = journey.steps.find(
        ({ code }) =>
          code === SubscriptionJourneyStepCode.ORDER_AND_CONTRACT_CREATION
      );
      if (!step || step.id !== job.stepId) {
        throw journeyError(
          "JOURNEY_INVALID_TRANSITION",
          "The order bootstrap job does not match the current journey step."
        );
      }
      const requestedRevision = isRecord(job.payload)
        ? job.payload.finalPlanRevision
        : undefined;
      if (
        requestedRevision !== journey.application.finalPlanRevision ||
        requestedRevision < 1
      ) {
        throw journeyError(
          "FINAL_PLAN_REVISION_STALE",
          "The order bootstrap job targets a stale final-plan revision."
        );
      }
      const actor = {
        id: journey.application.salesUserId,
        menus: [],
        name: "Journey Automation",
        permissions: [],
        roles: ["ADMIN"],
        username: "subscription-journey-worker"
      };
      const context = {
        ipAddress: "127.0.0.1",
        userAgent: "subscription-journey-worker"
      };
      const order = await this.customerService!.createOrderFromApplicationInTransaction(
        tx,
        journey.applicationId,
        actor,
        context
      );
      await this.attachOrder(tx, journey.id, order.id);
      const contract = await this.orderService!.createJourneyContractInTransaction(
        tx,
        order.id,
        actor.id,
        job.sourceKey
      );
      await this.orderEntitlementService!.ensureInitialEntitlements(
        tx,
        order.id,
        actor.id
      );
      await this.repository.completeStep(tx, {
        eventKey: `${job.sourceKey}:completed`,
        expectedVersion: journey.version,
        journeyId: journey.id,
        payload: { contractId: contract.id, orderId: order.id },
        stepId: step.id
      });
      return {
        action: "ORDER_AND_CONTRACT_CREATED",
        applicationId: journey.applicationId,
        contractId: contract.id,
        orderId: order.id
      };
    });
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
  finalPlanRevision: number,
  factVersion?: number
) {
  const base = `journey:${journeyId}:step:${stepCode}:revision:${finalPlanRevision}`;
  return factVersion === undefined ? base : `${base}:facts:${factVersion}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
