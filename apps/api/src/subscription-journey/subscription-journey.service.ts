import { Injectable, Optional } from "@nestjs/common";
import {
  Prisma,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus
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
import { ESignService } from "../esign/esign.service";
import { FadadaSignedArtifactService } from "../esign/fadada/fadada-signed-artifact.service";
import { FinanceService } from "../finance/finance.service";
import { HandoverWorkOrderService } from "../handover-work-order/handover-work-order.service";
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
    @Optional() private readonly orderEntitlementService?: OrderEntitlementService,
    @Optional() private readonly esignService?: ESignService,
    @Optional() private readonly fadadaSignedArtifactService?: FadadaSignedArtifactService,
    @Optional() private readonly financeService?: FinanceService,
    @Optional() private readonly handoverWorkOrderService?: HandoverWorkOrderService
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
    if (
      current.currentStepCode ===
      SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE
    ) {
      const payload = isRecord(outbox.payload) ? outbox.payload : {};
      if (
        outbox.eventType === "DOMAIN_FACT_OBSERVED" &&
        payload.signalType === "FADADA_ARTIFACT_ARCHIVED" &&
        typeof payload.contractId === "string" &&
        typeof payload.taskId === "string"
      ) {
        await this.repository.completeStep(tx, {
          eventKey: `journey:${current.id}:step:FADADA_SIGNING_AND_ARCHIVE:contract:${payload.contractId}:archived`,
          expectedVersion: current.version,
          journeyId: current.id,
          payload: {
            contractId: payload.contractId,
            taskId: payload.taskId
          },
          stepId: current.step.id
        });
        return;
      }
      if (
        outbox.eventType === "DOMAIN_FACT_OBSERVED" &&
        payload.signalType === "FADADA_TASK_COMPLETED" &&
        typeof payload.contractId === "string" &&
        typeof payload.taskId === "string"
      ) {
        await this.repository.enqueueJob(tx, {
          jobType: SubscriptionJourneyJobType.RECONCILE_FADADA_SIGNING,
          journeyId: current.id,
          maxAttempts: 100,
          payload: {
            contractId: payload.contractId,
            orderId: current.orderId,
            taskId: payload.taskId
          },
          sourceKey: `journey:${current.id}:step:FADADA_SIGNING_AND_ARCHIVE:task:${payload.taskId}:reconcile`,
          stepId: current.step.id
        });
        return;
      }
    }
    if (
      current.currentStepCode ===
      SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION
    ) {
      const payload = isRecord(outbox.payload) ? outbox.payload : {};
      if (
        outbox.eventType === "DOMAIN_FACT_OBSERVED" &&
        payload.signalType === "HANDOVER_EVIDENCE_READY" &&
        typeof payload.handoverId === "string" &&
        typeof payload.manifestHash === "string" &&
        typeof payload.workOrderId === "string"
      ) {
        await this.repository.completeStep(tx, {
          eventKey: `journey:${current.id}:handover:${payload.workOrderId}:ready`,
          expectedVersion: current.version,
          journeyId: current.id,
          payload: {
            handoverId: payload.handoverId,
            manifestHash: payload.manifestHash,
            workOrderId: payload.workOrderId
          },
          stepId: current.step.id
        });
        return;
      }
    }
    if (manualTaskTypeFor(current.currentStepCode)) {
      const evidenceSnapshot =
        current.currentStepCode ===
        SubscriptionJourneyStepCode.DELIVERY_EVIDENCE_DECISION
          ? readHandoverEvidenceSnapshot(outbox.payload)
          : {};
      await this.repository.openManualTask(tx, {
        inputSnapshot: {
          applicationId: current.applicationId,
          finalPlanRevision: current.application.finalPlanRevision,
          ...evidenceSnapshot
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
        (current.currentStepCode ===
          SubscriptionJourneyStepCode.APPLICATION_VALIDATION ||
          current.currentStepCode ===
            SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT) &&
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

  async generateInitialBillsJob(
    job: ClaimedJourneyJob
  ): Promise<Prisma.InputJsonValue> {
    if (!this.prisma || !this.financeService) {
      throw journeyError(
        "JOURNEY_CONFIGURATION_ERROR",
        "The subscription journey initial billing service is not configured."
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const current = await this.readBillingJobContext(
        tx,
        job,
        SubscriptionJourneyStepCode.INITIAL_BILLING
      );
      if (current.alreadyCompleted) {
        return {
          action: "INITIAL_BILLING_ALREADY_COMPLETED",
          orderId: current.orderId
        };
      }
      const bills = await this.financeService!.generateInitialBillsInTransaction(
        tx,
        current.orderId,
        current.actorId,
        job.sourceKey
      );
      const billIds = bills.map(({ id }) => id);
      await this.repository.completeStep(tx, {
        eventKey: `${job.sourceKey}:completed`,
        expectedVersion: current.version,
        journeyId: current.journeyId,
        payload: { billIds, orderId: current.orderId },
        stepId: current.stepId
      });
      return {
        action: "INITIAL_BILLS_GENERATED",
        billIds,
        orderId: current.orderId
      };
    });
  }

  async evaluatePaymentSettlementJob(
    job: ClaimedJourneyJob
  ): Promise<Prisma.InputJsonValue> {
    if (!this.prisma || !this.financeService) {
      throw journeyError(
        "JOURNEY_CONFIGURATION_ERROR",
        "The subscription journey payment settlement evaluator is not configured."
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const current = await this.readBillingJobContext(
        tx,
        job,
        SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT
      );
      if (current.alreadyCompleted) {
        return {
          action: "PAYMENT_SETTLEMENT_ALREADY_COMPLETED",
          orderId: current.orderId
        };
      }
      const settlement =
        await this.financeService!.evaluateInitialBillSettlement(
          tx,
          current.orderId
        );
      if (settlement.paid) {
        await this.repository.completeStep(tx, {
          eventKey: `${job.sourceKey}:completed`,
          expectedVersion: current.version,
          journeyId: current.journeyId,
          payload: { orderId: current.orderId },
          stepId: current.stepId
        });
        return {
          action: "INITIAL_BILLS_SETTLED",
          orderId: current.orderId
        };
      }
      const remainingAmount = settlement.remainingAmount.toString();
      if (
        current.stepStatus !== SubscriptionJourneyStepStatus.WAITING_CUSTOMER
      ) {
        await this.repository.waitForCustomer(tx, {
          eventKey: `${job.sourceKey}:waiting`,
          expectedVersion: current.version,
          journeyId: current.journeyId,
          payload: { orderId: current.orderId, remainingAmount },
          stepId: current.stepId
        });
      }
      return {
        action: "WAITING_CUSTOMER_PAYMENT",
        orderId: current.orderId,
        remainingAmount
      };
    });
  }

  async createHandoverJob(
    job: ClaimedJourneyJob
  ): Promise<Prisma.InputJsonValue> {
    if (!this.prisma || !this.handoverWorkOrderService) {
      throw journeyError(
        "JOURNEY_CONFIGURATION_ERROR",
        "The subscription journey handover service is not configured."
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const current = await this.readHandoverJobContext(tx, job);
      if (current.alreadyCompleted) {
        return {
          action: "HANDOVER_ALREADY_COMPLETED",
          orderId: current.orderId
        };
      }
      const workOrder =
        await this.handoverWorkOrderService!.createJourneyHandoverInTransaction(
          tx,
          current.orderId,
          current.actorId,
          job.sourceKey
        );
      return {
        action: "HANDOVER_CREATED",
        handoverId: workOrder.handoverId ?? null,
        orderId: current.orderId,
        vehicleDeliveryId: workOrder.vehicleDeliveryId ?? null,
        workOrderId: workOrder.id
      };
    });
  }

  async startFadadaSigningJob(
    job: ClaimedJourneyJob
  ): Promise<Prisma.InputJsonValue> {
    if (!this.prisma || !this.esignService) {
      throw journeyError(
        "JOURNEY_CONFIGURATION_ERROR",
        "The subscription journey Fadada signer is not configured."
      );
    }
    const current = await this.prisma.$transaction((tx) =>
      this.readFadadaJobContext(tx, job)
    );
    const task = await this.esignService.startJourneyFadadaSigning(
      current.contractId,
      current.actorId
    );
    await this.prisma.$transaction((tx) =>
      this.repository.enqueueJob(tx, {
        availableAt: new Date(Date.now() + 300_000),
        jobType: SubscriptionJourneyJobType.RECONCILE_FADADA_SIGNING,
        journeyId: current.journeyId,
        maxAttempts: 100,
        payload: {
          contractId: current.contractId,
          orderId: current.orderId,
          taskId: task.id
        },
        sourceKey: `journey:${current.journeyId}:step:FADADA_SIGNING_AND_ARCHIVE:task:${task.id}:reconcile`,
        stepId: current.stepId
      })
    );
    return {
      action: "FADADA_SIGNING_STARTED",
      contractId: current.contractId,
      taskId: task.id,
      taskStatus: task.taskStatus
    };
  }

  async reconcileFadadaSigningJob(
    job: ClaimedJourneyJob
  ): Promise<Prisma.InputJsonValue> {
    if (!this.prisma || !this.esignService || !this.fadadaSignedArtifactService) {
      throw journeyError(
        "JOURNEY_CONFIGURATION_ERROR",
        "The subscription journey Fadada reconciler is not configured."
      );
    }
    const current = await this.prisma.$transaction((tx) =>
      this.readFadadaJobContext(tx, job)
    );
    const task = await this.esignService.reconcileJourneyFadadaSigning(
      current.contractId,
      current.actorId
    );
    if (task.taskStatus !== "COMPLETED") {
      throw journeyError(
        "JOURNEY_FADADA_SIGNING_PENDING",
        "The Fadada signing task has not completed.",
        true
      );
    }
    await this.fadadaSignedArtifactService.archiveSignedContract({
      actorId: current.actorId,
      taskId: task.id
    });
    return {
      action: "FADADA_ARTIFACT_ARCHIVED",
      contractId: current.contractId,
      taskId: task.id
    };
  }

  private async readBillingJobContext(
    tx: Tx,
    job: ClaimedJourneyJob,
    expectedStepCode: SubscriptionJourneyStepCode
  ) {
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
    if (!journey.orderId) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The subscription journey does not have an order."
      );
    }
    const step = journey.steps.find(({ code }) => code === expectedStepCode);
    if (!step || step.id !== job.stepId) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "The billing job does not match its subscription journey step."
      );
    }
    if (journey.currentStepCode !== expectedStepCode) {
      if (step.status === SubscriptionJourneyStepStatus.COMPLETED) {
        return {
          actorId: journey.application.salesUserId,
          alreadyCompleted: true,
          journeyId: journey.id,
          orderId: journey.orderId,
          stepId: step.id,
          stepStatus: step.status,
          version: journey.version
        };
      }
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "The subscription journey is not at the requested billing step."
      );
    }
    const payload = isRecord(job.payload) ? job.payload : {};
    if (
      payload.orderId !== journey.orderId ||
      payload.finalPlanRevision !== journey.application.finalPlanRevision
    ) {
      throw journeyError(
        "FINAL_PLAN_REVISION_STALE",
        "The billing job targets a stale order or final-plan revision."
      );
    }
    return {
      actorId: journey.application.salesUserId,
      alreadyCompleted: false,
      journeyId: journey.id,
      orderId: journey.orderId,
      stepId: step.id,
      stepStatus: journey.currentStepStatus,
      version: journey.version
    };
  }

  private async readHandoverJobContext(tx: Tx, job: ClaimedJourneyJob) {
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
    if (!journey || !journey.orderId) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The subscription journey handover order was not found."
      );
    }
    const expectedStepCode =
      SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION;
    const step = journey.steps.find(({ code }) => code === expectedStepCode);
    if (!step || step.id !== job.stepId) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "The handover job does not match its subscription journey step."
      );
    }
    if (journey.currentStepCode !== expectedStepCode) {
      if (step.status === SubscriptionJourneyStepStatus.COMPLETED) {
        return {
          actorId: journey.application.salesUserId,
          alreadyCompleted: true,
          orderId: journey.orderId
        };
      }
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "The subscription journey is not at the handover step."
      );
    }
    const payload = isRecord(job.payload) ? job.payload : {};
    if (
      payload.orderId !== journey.orderId ||
      payload.finalPlanRevision !== journey.application.finalPlanRevision
    ) {
      throw journeyError(
        "FINAL_PLAN_REVISION_STALE",
        "The handover job targets a stale order or final-plan revision."
      );
    }
    return {
      actorId: journey.application.salesUserId,
      alreadyCompleted: false,
      orderId: journey.orderId
    };
  }

  private async readFadadaJobContext(tx: Tx, job: ClaimedJourneyJob) {
    const journey = await tx.subscriptionJourney.findUnique({
      include: {
        application: {
          select: { finalPlanRevision: true, salesUserId: true }
        },
        order: {
          include: { contract: true }
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
      SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE
    ) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "The journey is not waiting for Fadada signing and archive."
      );
    }
    const step = journey.steps.find(
      ({ code }) => code === SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE
    );
    if (!step || step.id !== job.stepId) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "The Fadada job does not match the current journey step."
      );
    }
    const requestedRevision = isRecord(job.payload)
      ? job.payload.finalPlanRevision
      : undefined;
    if (
      requestedRevision !== undefined &&
      requestedRevision !== journey.application.finalPlanRevision
    ) {
      throw journeyError(
        "FINAL_PLAN_REVISION_STALE",
        "The Fadada job targets a stale final-plan revision."
      );
    }
    const order = journey.order;
    const contract = order?.contract;
    if (!order || !contract || order.contractId !== contract.id) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The journey does not have its current contract."
      );
    }
    if (
      contract.status === "CANCELLED" ||
      contract.status === "DRAFT"
    ) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "The journey contract is not signable."
      );
    }
    return {
      actorId: journey.application.salesUserId,
      contractId: contract.id,
      journeyId: journey.id,
      orderId: order.id,
      stepId: step.id
    };
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

function readHandoverEvidenceSnapshot(
  outboxPayload: Prisma.JsonValue
): {
  handoverId: string;
  manifestHash: string;
  workOrderId: string;
} {
  const transition = isRecord(outboxPayload) ? outboxPayload : {};
  const payload = isRecord(transition.payload) ? transition.payload : {};
  if (
    transition.operation !== "COMPLETE_STEP" ||
    typeof payload.handoverId !== "string" ||
    typeof payload.manifestHash !== "string" ||
    typeof payload.workOrderId !== "string"
  ) {
    throw journeyError(
      "JOURNEY_INVALID_TRANSITION",
      "The delivery-evidence decision is missing its exact evidence snapshot."
    );
  }
  return {
    handoverId: payload.handoverId,
    manifestHash: payload.manifestHash,
    workOrderId: payload.workOrderId
  };
}
