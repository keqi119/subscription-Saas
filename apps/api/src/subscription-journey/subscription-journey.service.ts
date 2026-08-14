import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional
} from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import {
  ApplicationStatus,
  AuditAction,
  ContractStatus,
  OrderStatus,
  Prisma,
  SubscriptionJourneyEventType,
  SubscriptionJourneyExceptionStatus,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyManualTaskStatus,
  SubscriptionJourneyOutboxStatus,
  SubscriptionJourneyStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus,
  VehicleStatus
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
import { LeaseActivationEngine } from "../lease/lease-activation.engine";
import { OrderEntitlementService } from "../order/order-entitlement.service";
import { OrderService } from "../order/order.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { CurrentCustomer } from "../portal/portal-auth.types";
import {
  DeliveryEvidenceDecisionDto,
  FinalPlanDecisionDto,
  JourneyReasonDto,
  ListSubscriptionJourneysQueryDto,
  VehicleAllocationDecisionDto
} from "./subscription-journey.dto";

type Tx = Prisma.TransactionClient;

const adminJourneyInclude = {
  application: {
    select: {
      applicationNo: true,
      applicationSource: true,
      customerId: true,
      finalPlanSnapshot: true,
      finalPlanRevision: true,
      finalVehicleId: true,
      id: true,
      softReservedVehicleId: true,
      status: true
    }
  },
  events: { orderBy: { sequence: "asc" as const }, take: 100 },
  exceptions: { orderBy: { lastOccurredAt: "desc" as const } },
  jobs: { orderBy: { createdAt: "desc" as const }, take: 50 },
  manualTasks: { orderBy: { createdAt: "desc" as const } },
  order: {
    select: {
      contract: { select: { id: true, status: true } },
      id: true,
      orderNo: true,
      orderStatus: true,
      vehicleId: true
    }
  },
  steps: { orderBy: { createdAt: "asc" as const } }
} satisfies Prisma.SubscriptionJourneyInclude;

type AdminJourney = Prisma.SubscriptionJourneyGetPayload<{
  include: typeof adminJourneyInclude;
}>;

const portalJourneySelect = {
  application: {
    select: {
      applicationNo: true,
      customerId: true,
      finalPlanRevision: true,
      id: true
    }
  },
  currentStepCode: true,
  currentStepStatus: true,
  id: true,
  order: {
    select: {
      contractId: true,
      id: true,
      orderNo: true,
      receivableBills: {
        select: { billStatus: true, id: true },
        where: { deletedAt: null }
      }
    }
  },
  status: true,
  version: true
} satisfies Prisma.SubscriptionJourneySelect;

type PortalJourney = Prisma.SubscriptionJourneyGetPayload<{
  select: typeof portalJourneySelect;
}>;

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

const CUSTOMER_NOTIFICATION_STEPS = new Set<SubscriptionJourneyStepCode>([
  SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
  SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
  SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT,
  SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION
]);

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
    @Optional() private readonly handoverWorkOrderService?: HandoverWorkOrderService,
    @Optional() private readonly leaseActivationEngine?: LeaseActivationEngine,
    @Optional() private readonly auditService?: AuditService
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
    if (
      outbox.eventType !== SubscriptionJourneyEventType.STEP_COMPLETED ||
      !CUSTOMER_NOTIFICATION_STEPS.has(current.currentStepCode)
    ) {
      return;
    }
    const sourcePayload = isRecord(outbox.payload) ? outbox.payload : {};
    await this.repository.enqueueJob(tx, {
      jobType: SubscriptionJourneyJobType.DISPATCH_NOTIFICATION,
      journeyId: current.id,
      payload: {
        eventKey:
          typeof sourcePayload.eventKey === "string"
            ? sourcePayload.eventKey
            : outbox.eventKey,
        finalPlanRevision: current.application.finalPlanRevision,
        stepCode: current.currentStepCode
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

  async getByApplication(applicationId: string, user: RequestUser) {
    return this.readAdminJourney({ applicationId }, user);
  }

  async getByOrder(orderId: string, user: RequestUser) {
    return this.readAdminJourney({ orderId }, user);
  }

  async getPortalByApplication(
    applicationId: string,
    currentCustomer: CurrentCustomer
  ) {
    return this.readPortalJourney(
      { applicationId },
      currentCustomer.customerId
    );
  }

  async getPortalByOrder(orderId: string, currentCustomer: CurrentCustomer) {
    return this.readPortalJourney({ orderId }, currentCustomer.customerId);
  }

  async listJourneys(
    query: ListSubscriptionJourneysQueryDto,
    user: RequestUser
  ) {
    const prisma = this.requirePrisma();
    const rows = await prisma.subscriptionJourney.findMany({
      include: adminJourneyInclude,
      orderBy: { updatedAt: "desc" },
      where: query.status ? { status: query.status } : undefined
    });
    return rows.map((row) => toAdminJourneyProjection(row, user));
  }

  async getAdminMetrics() {
    const prisma = this.requirePrisma();
    const automatedSteps = [
      SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
      SubscriptionJourneyStepCode.ORDER_AND_CONTRACT_CREATION,
      SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
      SubscriptionJourneyStepCode.INITIAL_BILLING,
      SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT,
      SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION,
      SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION
    ];
    const [journeys, steps, oldestException, retryAggregate, completed, failed] =
      await Promise.all([
        prisma.subscriptionJourney.groupBy({
          _count: { _all: true },
          by: ["status"]
        }),
        prisma.subscriptionJourneyStep.groupBy({
          _count: { _all: true },
          by: ["code", "status"]
        }),
        prisma.subscriptionJourneyException.findFirst({
          orderBy: { firstOccurredAt: "asc" },
          select: { firstOccurredAt: true },
          where: { status: SubscriptionJourneyExceptionStatus.OPEN }
        }),
        prisma.subscriptionJourneyJob.aggregate({
          _sum: { attemptCount: true }
        }),
        prisma.subscriptionJourneyStep.count({
          where: {
            code: { in: automatedSteps },
            status: SubscriptionJourneyStepStatus.COMPLETED
          }
        }),
        prisma.subscriptionJourneyStep.count({
          where: {
            code: { in: automatedSteps },
            status: {
              in: [
                SubscriptionJourneyStepStatus.EXCEPTION,
                SubscriptionJourneyStepStatus.RETRY_SCHEDULED
              ]
            }
          }
        })
      ]);
    const denominator = completed + failed;
    return {
      automatedProgressRate:
        denominator === 0 ? 1 : Number((completed / denominator).toFixed(4)),
      journeyCounts: Object.fromEntries(
        journeys.map((row) => [row.status, row._count._all])
      ),
      oldestOpenExceptionAt: oldestException?.firstOccurredAt ?? null,
      retryCount: retryAggregate._sum.attemptCount ?? 0,
      stepCounts: steps.map((row) => ({
        code: row.code,
        count: row._count._all,
        status: row.status
      }))
    };
  }

  async decideFinalPlan(
    journeyId: string,
    dto: FinalPlanDecisionDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const prisma = this.requirePrisma();
    if (!this.customerService) {
      throw new Error("Journey application decision service is unavailable.");
    }
    return prisma.$transaction(async (tx) => {
      const journey = await this.lockAdminJourney(tx, journeyId, dto.version);
      this.requireCurrentStep(
        journey,
        SubscriptionJourneyStepCode.FINAL_PLAN_DECISION
      );
      const application = await this.customerService!.applyJourneyFinalPlanDecision(
        tx,
        journey.applicationId,
        {
          finalPeriodMonths: dto.finalPeriodMonths,
          finalSubscriptionPlanId: dto.finalSubscriptionPlanId,
          finalVehicleId: dto.finalVehicleId
        },
        user,
        context
      );
      await this.writeAdminAudit(
        tx,
        journey,
        "FINAL_PLAN_DECISION",
        user,
        context
      );
      return { applicationId: application.id, journeyId };
    });
  }

  async allocateVehicle(
    journeyId: string,
    dto: VehicleAllocationDecisionDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const prisma = this.requirePrisma();
    if (!this.customerService) {
      throw new Error("Journey vehicle allocation service is unavailable.");
    }
    return prisma.$transaction(async (tx) => {
      const journey = await this.lockAdminJourney(tx, journeyId, dto.version);
      this.requireCurrentStep(
        journey,
        SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION
      );
      const result = await this.customerService!.allocateJourneyVehicle(
        tx,
        journey.applicationId,
        dto.vehicleId,
        user,
        context
      );
      await this.writeAdminAudit(
        tx,
        journey,
        "FINAL_VEHICLE_ALLOCATION",
        user,
        context
      );
      return {
        applicationId: result.application.id,
        journeyId,
        requiresCustomerReconfirmation: result.requiresCustomerReconfirmation
      };
    });
  }

  async decideDeliveryEvidence(
    journeyId: string,
    dto: DeliveryEvidenceDecisionDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const prisma = this.requirePrisma();
    if (!this.handoverWorkOrderService) {
      throw new Error("Journey evidence decision service is unavailable.");
    }
    return prisma.$transaction(async (tx) => {
      const journey = await this.lockAdminJourney(tx, journeyId, dto.version);
      this.requireCurrentStep(
        journey,
        SubscriptionJourneyStepCode.DELIVERY_EVIDENCE_DECISION
      );
      if (!journey.orderId) {
        throw new BadRequestException("JOURNEY_ORDER_REQUIRED");
      }
      const workOrder = await this.handoverWorkOrderService!.decideJourneyDeliveryEvidence(
        tx,
        dto.workOrderId,
        dto.decision,
        user.id,
        dto.notes,
        dto.manifestHash
      );
      if (workOrder.orderId !== journey.orderId) {
        throw new ConflictException("JOURNEY_EVIDENCE_BINDING_CONFLICT");
      }
      await this.writeAdminAudit(
        tx,
        journey,
        "DELIVERY_EVIDENCE_DECISION",
        user,
        context
      );
      return { journeyId, workOrderId: workOrder.id };
    });
  }

  async pauseJourney(
    journeyId: string,
    dto: JourneyReasonDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const prisma = this.requirePrisma();
    return prisma.$transaction(async (tx) => {
      const journey = await this.lockAdminJourney(tx, journeyId, dto.version);
      if (
        journey.status === SubscriptionJourneyStatus.PAUSED ||
        journey.status === SubscriptionJourneyStatus.COMPLETED ||
        journey.status === SubscriptionJourneyStatus.CANCELLED
      ) {
        throw new BadRequestException("JOURNEY_PAUSE_NOT_ALLOWED");
      }
      await this.updateJourneyVersioned(tx, journey, {
        pausedFromStatus: journey.status,
        status: SubscriptionJourneyStatus.PAUSED,
        version: { increment: 1 }
      });
      await this.writeAdminEvent(tx, journey, {
        eventType: SubscriptionJourneyEventType.JOURNEY_PAUSED,
        operation: "PAUSE",
        reason: dto.reason,
        user
      });
      await this.writeAdminAudit(tx, journey, "PAUSE", user, context, {
        reason: dto.reason,
        status: SubscriptionJourneyStatus.PAUSED
      });
      return {
        id: journey.id,
        status: SubscriptionJourneyStatus.PAUSED,
        version: journey.version + 1
      };
    });
  }

  async resumeJourney(
    journeyId: string,
    dto: JourneyReasonDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const prisma = this.requirePrisma();
    return prisma.$transaction(async (tx) => {
      const journey = await this.lockAdminJourney(tx, journeyId, dto.version);
      if (
        journey.status !== SubscriptionJourneyStatus.PAUSED ||
        !journey.pausedFromStatus
      ) {
        throw new BadRequestException("JOURNEY_RESUME_NOT_ALLOWED");
      }
      await this.assertResumeFacts(tx, journey);
      const restoredStatus = journey.pausedFromStatus;
      await this.updateJourneyVersioned(tx, journey, {
        pausedFromStatus: null,
        status: restoredStatus,
        version: { increment: 1 }
      });
      if (restoredStatus === SubscriptionJourneyStatus.RUNNING) {
        const jobType = JOB_TYPE_BY_STEP[journey.currentStepCode];
        const step = journey.steps.find(
          ({ code }) => code === journey.currentStepCode
        );
        if (jobType && step) {
          await this.repository.enqueueJob(tx, {
            jobType,
            journeyId: journey.id,
            payload: {
              applicationId: journey.applicationId,
              orderId: journey.orderId,
              recoveryVersion: journey.version + 1
            },
            sourceKey: `journey:${journey.id}:resume:${journey.version + 1}`,
            stepId: step.id
          });
        }
      }
      await this.writeAdminEvent(tx, journey, {
        eventType: SubscriptionJourneyEventType.JOURNEY_RESUMED,
        operation: "RESUME",
        reason: dto.reason,
        user
      });
      await this.writeAdminAudit(tx, journey, "RESUME", user, context, {
        reason: dto.reason,
        status: restoredStatus
      });
      return {
        id: journey.id,
        status: restoredStatus,
        version: journey.version + 1
      };
    });
  }

  async retryJourney(
    journeyId: string,
    dto: JourneyReasonDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const prisma = this.requirePrisma();
    return prisma.$transaction(async (tx) => {
      const journey = await this.lockAdminJourney(tx, journeyId, dto.version);
      if (journey.status !== SubscriptionJourneyStatus.EXCEPTION) {
        throw new BadRequestException("JOURNEY_RETRY_NOT_ALLOWED");
      }
      const exception = await tx.subscriptionJourneyException.findFirst({
        orderBy: { lastOccurredAt: "desc" },
        where: {
          journeyId,
          status: SubscriptionJourneyExceptionStatus.OPEN
        }
      });
      if (!exception?.jobId) {
        throw new BadRequestException("JOURNEY_OPEN_EXCEPTION_REQUIRED");
      }
      const job = await tx.subscriptionJourneyJob.findFirst({
        where: {
          id: exception.jobId,
          journeyId,
          status: SubscriptionJourneyJobStatus.DEAD_LETTER
        }
      });
      if (!job) {
        throw new BadRequestException("JOURNEY_DEAD_LETTER_JOB_REQUIRED");
      }
      await tx.subscriptionJourneyJob.update({
        data: {
          availableAt: new Date(),
          completedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          leaseExpiresAt: null,
          leaseToken: null,
          status: SubscriptionJourneyJobStatus.RETRY_SCHEDULED
        },
        where: { id: job.id }
      });
      await tx.subscriptionJourneyException.update({
        data: {
          resolutionNotes: dto.reason,
          resolvedAt: new Date(),
          resolvedBy: user.id,
          status: SubscriptionJourneyExceptionStatus.RESOLVED
        },
        where: { id: exception.id }
      });
      await tx.subscriptionJourneyStep.updateMany({
        data: {
          lastErrorCode: null,
          status: SubscriptionJourneyStepStatus.RETRY_SCHEDULED
        },
        where: { id: exception.stepId, journeyId }
      });
      await this.updateJourneyVersioned(tx, journey, {
        currentStepStatus: SubscriptionJourneyStepStatus.RETRY_SCHEDULED,
        status: SubscriptionJourneyStatus.RETRY_SCHEDULED,
        version: { increment: 1 }
      });
      await this.writeAdminEvent(tx, journey, {
        eventType: SubscriptionJourneyEventType.EXCEPTION_RESOLVED,
        operation: "RETRY",
        reason: dto.reason,
        user
      });
      await this.writeAdminAudit(tx, journey, "RETRY", user, context, {
        exceptionId: exception.id,
        jobId: job.id,
        reason: dto.reason
      });
      return {
        id: journey.id,
        status: SubscriptionJourneyStatus.RETRY_SCHEDULED,
        version: journey.version + 1
      };
    });
  }

  async cancelJourney(
    journeyId: string,
    dto: JourneyReasonDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const prisma = this.requirePrisma();
    return prisma.$transaction(async (tx) => {
      const journey = await this.lockAdminJourney(tx, journeyId, dto.version);
      if (
        journey.status === SubscriptionJourneyStatus.COMPLETED ||
        journey.status === SubscriptionJourneyStatus.CANCELLED
      ) {
        throw new BadRequestException("JOURNEY_CANCEL_NOT_ALLOWED");
      }
      const contract = journey.order?.contract;
      if (
        contract &&
        (contract.status === ContractStatus.SIGNED ||
          contract.status === ContractStatus.ARCHIVED)
      ) {
        throw new BadRequestException(
          "JOURNEY_CONTRACT_TERMINATION_REQUIRED"
        );
      }
      await this.cancelJourneyBusinessFacts(tx, journey, dto.reason, user.id);
      await tx.subscriptionJourneyJob.updateMany({
        data: {
          completedAt: new Date(),
          leaseExpiresAt: null,
          leaseToken: null,
          status: SubscriptionJourneyJobStatus.CANCELLED
        },
        where: {
          journeyId,
          status: { notIn: [SubscriptionJourneyJobStatus.COMPLETED, SubscriptionJourneyJobStatus.CANCELLED] }
        }
      });
      await tx.subscriptionJourneyOutbox.updateMany({
        data: {
          leaseExpiresAt: null,
          leaseToken: null,
          status: SubscriptionJourneyOutboxStatus.CANCELLED
        },
        where: {
          journeyId,
          status: { in: [SubscriptionJourneyOutboxStatus.PENDING, SubscriptionJourneyOutboxStatus.PROCESSING] }
        }
      });
      await tx.subscriptionJourneyManualTask.updateMany({
        data: { status: SubscriptionJourneyManualTaskStatus.CANCELLED },
        where: {
          journeyId,
          status: SubscriptionJourneyManualTaskStatus.OPEN
        }
      });
      await tx.subscriptionJourneyStep.updateMany({
        data: { status: SubscriptionJourneyStepStatus.CANCELLED },
        where: {
          journeyId,
          status: { notIn: [SubscriptionJourneyStepStatus.COMPLETED, SubscriptionJourneyStepStatus.CANCELLED] }
        }
      });
      await this.updateJourneyVersioned(tx, journey, {
        cancelledAt: new Date(),
        currentStepStatus: SubscriptionJourneyStepStatus.CANCELLED,
        status: SubscriptionJourneyStatus.CANCELLED,
        version: { increment: 1 }
      });
      await this.writeAdminEvent(tx, journey, {
        eventType: SubscriptionJourneyEventType.JOURNEY_CANCELLED,
        operation: "CANCEL",
        reason: dto.reason,
        user
      });
      await this.writeAdminAudit(tx, journey, "CANCEL", user, context, {
        reason: dto.reason,
        status: SubscriptionJourneyStatus.CANCELLED
      });
      return {
        id: journey.id,
        status: SubscriptionJourneyStatus.CANCELLED,
        version: journey.version + 1
      };
    });
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

  async activateSubscriptionJob(
    job: ClaimedJourneyJob
  ): Promise<Prisma.InputJsonValue> {
    if (!this.prisma || !this.leaseActivationEngine) {
      throw journeyError(
        "JOURNEY_CONFIGURATION_ERROR",
        "The subscription journey activation service is not configured."
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
      if (!journey || !journey.orderId) {
        throw journeyError(
          "JOURNEY_NOT_FOUND",
          "The subscription journey activation order was not found."
        );
      }
      const step = journey.steps.find(
        ({ code }) =>
          code === SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION
      );
      if (!step || step.id !== job.stepId) {
        throw journeyError(
          "JOURNEY_INVALID_TRANSITION",
          "The activation job does not match its subscription journey step."
        );
      }
      if (journey.status === "COMPLETED" && step.status === "COMPLETED") {
        return {
          action: "SUBSCRIPTION_ALREADY_ACTIVATED",
          orderId: journey.orderId
        };
      }
      if (
        journey.currentStepCode !==
        SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION
      ) {
        throw journeyError(
          "JOURNEY_INVALID_TRANSITION",
          "The journey is not at authoritative activation."
        );
      }
      const payload = isRecord(job.payload) ? job.payload : {};
      if (
        payload.orderId !== journey.orderId ||
        payload.finalPlanRevision !== journey.application.finalPlanRevision
      ) {
        throw journeyError(
          "FINAL_PLAN_REVISION_STALE",
          "The activation job targets a stale order or final-plan revision."
        );
      }
      const result =
        await this.leaseActivationEngine!.activateFromAuthoritativeHandover(
          tx,
          {
            actorId: journey.application.salesUserId,
            journeyId: journey.id,
            orderId: journey.orderId
          }
        );
      return {
        action: "SUBSCRIPTION_ACTIVATED",
        deliveryId: result.deliveryId,
        leaseId: result.leaseId,
        orderId: result.orderId,
        vehicleId: result.vehicleId
      };
    });
  }

  async startFadadaSigningJob(
    job: ClaimedJourneyJob
  ): Promise<Prisma.InputJsonValue> {
    if (!this.prisma || !this.orderService || !this.esignService) {
      throw journeyError(
        "JOURNEY_CONFIGURATION_ERROR",
        "The subscription journey Fadada signer is not configured."
      );
    }
    const current = await this.prisma.$transaction((tx) =>
      this.readFadadaJobContext(tx, job)
    );
    await this.orderService.ensureJourneyContractPdfArtifact(
      current.contractId,
      current.actorId
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

  private requirePrisma(): PrismaService {
    if (!this.prisma) {
      throw new Error("Subscription journey persistence is unavailable.");
    }
    return this.prisma;
  }

  private async readAdminJourney(
    where: { applicationId: string } | { orderId: string },
    user: RequestUser
  ) {
    const journey = await this.requirePrisma().subscriptionJourney.findUnique({
      include: adminJourneyInclude,
      where
    });
    if (!journey) {
      throw new NotFoundException("Subscription journey not found.");
    }
    return toAdminJourneyProjection(journey, user);
  }

  private async readPortalJourney(
    where: { applicationId: string } | { orderId: string },
    customerId: string
  ) {
    const journey = await this.requirePrisma().subscriptionJourney.findFirst({
      select: portalJourneySelect,
      where: { ...where, application: { customerId } }
    });
    if (!journey) {
      throw new NotFoundException("订阅流程不存在或不属于当前客户。");
    }
    return toPortalJourneyProjection(journey);
  }

  private async lockAdminJourney(
    tx: Tx,
    journeyId: string,
    expectedVersion: number
  ): Promise<AdminJourney> {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "subscription_journey"
      WHERE "id" = ${journeyId}
      FOR UPDATE
    `);
    const journey = await tx.subscriptionJourney.findUnique({
      include: adminJourneyInclude,
      where: { id: journeyId }
    });
    if (!journey) {
      throw new NotFoundException("Subscription journey not found.");
    }
    if (journey.version !== expectedVersion) {
      throw new ConflictException("JOURNEY_OPTIMISTIC_LOCK_CONFLICT");
    }
    return journey;
  }

  private requireCurrentStep(
    journey: AdminJourney,
    expected: SubscriptionJourneyStepCode
  ) {
    if (
      journey.currentStepCode !== expected ||
      !journey.steps.some(({ code }) => code === expected)
    ) {
      throw new BadRequestException("JOURNEY_INVALID_TRANSITION");
    }
  }

  private async updateJourneyVersioned(
    tx: Tx,
    journey: AdminJourney,
    data: Prisma.SubscriptionJourneyUpdateManyMutationInput
  ) {
    const updated = await tx.subscriptionJourney.updateMany({
      data,
      where: { id: journey.id, version: journey.version }
    });
    if (updated.count !== 1) {
      throw new ConflictException("JOURNEY_OPTIMISTIC_LOCK_CONFLICT");
    }
  }

  private async writeAdminEvent(
    tx: Tx,
    journey: AdminJourney,
    input: {
      eventType: SubscriptionJourneyEventType;
      operation: string;
      reason: string;
      user: RequestUser;
    }
  ) {
    const eventKey = `journey:${journey.id}:admin:${input.operation.toLowerCase()}:${journey.version + 1}`;
    const payload = {
      operation: input.operation,
      reason: input.reason,
      stepCode: journey.currentStepCode
    } satisfies Prisma.InputJsonValue;
    await tx.subscriptionJourneyEvent.create({
      data: {
        actorId: input.user.id,
        actorType: "ADMIN",
        eventKey,
        eventType: input.eventType,
        journeyId: journey.id,
        payload,
        sequence: journey.version + 1
      }
    });
    await tx.subscriptionJourneyOutbox.upsert({
      create: {
        aggregateId: journey.id,
        aggregateType: "SUBSCRIPTION_JOURNEY",
        eventKey: `${eventKey}:outbox`,
        eventType: input.eventType,
        journeyId: journey.id,
        payload
      },
      update: {},
      where: { eventKey: `${eventKey}:outbox` }
    });
  }

  private async writeAdminAudit(
    tx: Tx,
    journey: AdminJourney,
    operation: string,
    user: RequestUser,
    context: RequestContext,
    after: Record<string, unknown> = {}
  ) {
    if (!this.auditService) return;
    await this.auditService.write(
      {
        action: AuditAction.UPDATE,
        after: {
          applicationId: journey.applicationId,
          journeyId: journey.id,
          operation,
          version: journey.version + 1,
          ...after
        },
        before: {
          currentStepCode: journey.currentStepCode,
          status: journey.status,
          version: journey.version
        },
        entityId: journey.applicationId,
        entityType: "subscription_journey",
        ipAddress: context.ipAddress,
        module: "subscription_journey",
        operatorId: user.id,
        userAgent: context.userAgent
      },
      tx
    );
  }

  private async assertResumeFacts(tx: Tx, journey: AdminJourney) {
    const application = await tx.application.findUnique({
      select: { id: true },
      where: { id: journey.applicationId }
    });
    if (!application) {
      throw new BadRequestException("JOURNEY_APPLICATION_NOT_FOUND");
    }
    if (journey.orderId) {
      const order = await tx.subscriptionOrder.findUnique({
        select: { deletedAt: true, id: true },
        where: { id: journey.orderId }
      });
      if (!order || order.deletedAt) {
        throw new BadRequestException("JOURNEY_ORDER_NOT_FOUND");
      }
    }
  }

  private async cancelJourneyBusinessFacts(
    tx: Tx,
    journey: AdminJourney,
    reason: string,
    actorId: string
  ) {
    if (!journey.orderId) {
      const vehicleId = journey.application.softReservedVehicleId;
      if (vehicleId) {
        await tx.vehicle.updateMany({
          data: { status: VehicleStatus.AVAILABLE, updatedBy: actorId },
          where: {
            id: vehicleId,
            status: VehicleStatus.REVIEW_RESERVED
          }
        });
      }
      await tx.application.update({
        data: {
          rejectedReason: reason,
          softReservationExpiresAt: null,
          softReservedAt: null,
          softReservedVehicleId: null,
          status: ApplicationStatus.CANCELLED,
          updatedBy: actorId
        },
        where: { id: journey.applicationId }
      });
      return;
    }

    await tx.subscriptionOrder.update({
      data: {
        orderStatus: OrderStatus.CANCELLED,
        updatedBy: actorId
      },
      where: { id: journey.orderId }
    });
    await tx.contract.updateMany({
      data: { status: ContractStatus.CANCELLED, updatedBy: actorId },
      where: {
        orderId: journey.orderId,
        status: {
          notIn: [
            ContractStatus.SIGNED,
            ContractStatus.ARCHIVED,
            ContractStatus.CANCELLED,
            ContractStatus.TERMINATED
          ]
        }
      }
    });
    if (journey.order?.vehicleId) {
      const otherOccupants = await tx.subscriptionOrder.count({
        where: {
          deletedAt: null,
          id: { not: journey.orderId },
          orderStatus: {
            notIn: [
              OrderStatus.CANCELLED,
              OrderStatus.REJECTED,
              OrderStatus.TERMINATED,
              OrderStatus.COMPLETED
            ]
          },
          vehicleId: journey.order.vehicleId
        }
      });
      if (otherOccupants === 0) {
        await tx.vehicle.updateMany({
          data: { status: VehicleStatus.AVAILABLE, updatedBy: actorId },
          where: {
            id: journey.order.vehicleId,
            status: VehicleStatus.RESERVED
          }
        });
      }
    }
    await tx.application.update({
      data: {
        rejectedReason: reason,
        status: ApplicationStatus.CANCELLED,
        updatedBy: actorId
      },
      where: { id: journey.applicationId }
    });
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

const SAFE_JOURNEY_PAYLOAD_KEYS = new Set([
  "applicationId",
  "contractId",
  "decision",
  "deliveryId",
  "finalPlanRevision",
  "handoverId",
  "jobId",
  "journeyVersion",
  "leaseId",
  "manifestHash",
  "operation",
  "orderId",
  "remainingAmount",
  "signalType",
  "stepCode",
  "stepId",
  "taskId",
  "vehicleId",
  "workOrderId"
]);

function toAdminJourneyProjection(journey: AdminJourney, user: RequestUser) {
  const currentTask = journey.manualTasks.find(
    ({ status }) => status === SubscriptionJourneyManualTaskStatus.OPEN
  );
  return {
    application: journey.application,
    availableActions: availableJourneyActions(journey, user),
    cancelledAt: journey.cancelledAt,
    completedAt: journey.completedAt,
    currentStepCode: journey.currentStepCode,
    currentStepStatus: journey.currentStepStatus,
    currentTask: currentTask
      ? {
          id: currentTask.id,
          inputSnapshot: sanitizeJourneyPayload(currentTask.inputSnapshot),
          status: currentTask.status,
          taskType: currentTask.taskType,
          version: currentTask.version
        }
      : null,
    customerNextAction: customerNextAction(journey),
    events: journey.events.map((event) => ({
      actorType: event.actorType,
      createdAt: event.createdAt,
      eventType: event.eventType,
      id: event.id,
      payload: sanitizeJourneyPayload(event.payload),
      sequence: event.sequence
    })),
    exceptions: journey.exceptions.map((exception) => ({
      code: exception.code,
      firstOccurredAt: exception.firstOccurredAt,
      id: exception.id,
      lastOccurredAt: exception.lastOccurredAt,
      message: "Journey operation failed.",
      occurrenceCount: exception.occurrenceCount,
      retryable: exception.retryable,
      status: exception.status
    })),
    id: journey.id,
    jobs: journey.jobs.map((job) => ({
      attemptCount: job.attemptCount,
      availableAt: job.availableAt,
      id: job.id,
      jobType: job.jobType,
      lastErrorCode: job.lastErrorCode,
      status: job.status
    })),
    order: journey.order,
    orderId: journey.orderId,
    pausedFromStatus: journey.pausedFromStatus,
    startedAt: journey.startedAt,
    status: journey.status,
    steps: journey.steps.map((step) => ({
      attemptCount: step.attemptCount,
      code: step.code,
      completedAt: step.completedAt,
      id: step.id,
      lastErrorCode: step.lastErrorCode,
      startedAt: step.startedAt,
      status: step.status,
      waitingAt: step.waitingAt
    })),
    version: journey.version
  };
}

function toPortalJourneyProjection(journey: PortalJourney) {
  const applicationHref = `/portal/applications/${encodeURIComponent(journey.application.id)}`;
  const orderHref = journey.order
    ? `/portal/orders/${encodeURIComponent(journey.order.id)}`
    : null;
  const contractHref = journey.order?.contractId
    ? `/portal/contracts/${encodeURIComponent(journey.order.contractId)}`
    : null;
  const links = {
    application: applicationHref,
    bills: (journey.order?.receivableBills ?? []).map(
      ({ id }) => `/portal/bills/${encodeURIComponent(id)}`
    ),
    contract: contractHref,
    contractSign: contractHref ? `${contractHref}/sign` : null,
    order: orderHref
  };
  return {
    blockerText: portalBlockerText(journey),
    currentStepCode: journey.currentStepCode,
    currentStepStatus: journey.currentStepStatus,
    finalPlanRevision: journey.application.finalPlanRevision,
    id: journey.id,
    links,
    nextAction: portalJourneyNextAction(journey, links),
    polling: {
      enabled:
        journey.status === SubscriptionJourneyStatus.RUNNING &&
        journey.currentStepCode ===
          SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
      intervalMs: 5_000,
      maxAttempts: 24
    },
    status: journey.status,
    version: journey.version
  };
}

function portalJourneyNextAction(
  journey: PortalJourney,
  links: {
    application: string;
    contractSign: string | null;
    order: string | null;
  }
) {
  if (
    journey.status === SubscriptionJourneyStatus.COMPLETED ||
    journey.status === SubscriptionJourneyStatus.CANCELLED ||
    journey.status === SubscriptionJourneyStatus.PAUSED ||
    journey.status === SubscriptionJourneyStatus.RETRY_SCHEDULED
  ) {
    return null;
  }
  if (journey.status === SubscriptionJourneyStatus.EXCEPTION) {
    const suffix = journey.order ? `?orderId=${encodeURIComponent(journey.order.id)}` : "";
    return {
      href: `/portal/service-cases/new${suffix}`,
      label: "联系客户支持",
      type: "CONTACT_SUPPORT"
    };
  }
  if (
    journey.currentStepCode ===
      SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION &&
    journey.currentStepStatus ===
      SubscriptionJourneyStepStatus.WAITING_CUSTOMER
  ) {
    return {
      href: links.application,
      label: "确认最终方案",
      type: "CONFIRM_FINAL_PLAN"
    };
  }
  if (
    journey.currentStepCode ===
      SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE &&
    links.contractSign
  ) {
    return {
      href: links.contractSign,
      label: "完成电子签署",
      type: "SIGN_CONTRACT"
    };
  }
  if (
    journey.currentStepCode ===
      SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT &&
    links.order
  ) {
    return {
      href: `${links.order}#bills`,
      label: "支付首期账单",
      type: "PAY_INITIAL_BILLS"
    };
  }
  if (
    journey.currentStepCode ===
      SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION &&
    links.order
  ) {
    return {
      href: links.order,
      label: "查看交付安排",
      type: "COOPERATE_HANDOVER"
    };
  }
  return null;
}

function portalBlockerText(journey: PortalJourney) {
  if (journey.status === SubscriptionJourneyStatus.EXCEPTION) {
    return "流程暂时受阻，请联系客户支持，我们会协助处理。";
  }
  if (journey.status === SubscriptionJourneyStatus.RETRY_SCHEDULED) {
    return "系统正在自动重试，无需重复提交操作。";
  }
  if (journey.status === SubscriptionJourneyStatus.PAUSED) {
    return "流程已暂停，请联系客户支持了解后续安排。";
  }
  if (journey.status === SubscriptionJourneyStatus.CANCELLED) {
    return "该订阅流程已取消。";
  }
  return null;
}

function sanitizeJourneyPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => SAFE_JOURNEY_PAYLOAD_KEYS.has(key))
      .map(([key, entry]) => [key, sanitizeJourneyValue(entry)])
  );
}

function sanitizeJourneyValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") return value.slice(0, 256);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(sanitizeJourneyValue);
  }
  return sanitizeJourneyPayload(value);
}

function availableJourneyActions(journey: AdminJourney, user: RequestUser) {
  const actions: string[] = [];
  if (
    journey.currentStepCode === SubscriptionJourneyStepCode.FINAL_PLAN_DECISION &&
    can(user, PermissionCode.SUBSCRIPTION_JOURNEY_PLAN_DECIDE)
  ) {
    actions.push("FINAL_PLAN_DECISION");
  }
  if (
    journey.currentStepCode ===
      SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION &&
    can(user, PermissionCode.SUBSCRIPTION_JOURNEY_VEHICLE_ALLOCATE)
  ) {
    actions.push("FINAL_VEHICLE_ALLOCATION");
  }
  if (
    journey.currentStepCode ===
      SubscriptionJourneyStepCode.DELIVERY_EVIDENCE_DECISION &&
    can(user, PermissionCode.SUBSCRIPTION_JOURNEY_DELIVERY_EVIDENCE_DECIDE)
  ) {
    actions.push("DELIVERY_EVIDENCE_DECISION");
  }
  if (can(user, PermissionCode.SUBSCRIPTION_JOURNEY_RECOVER)) {
    if (journey.status === SubscriptionJourneyStatus.EXCEPTION) {
      actions.push("RETRY");
    }
    if (journey.status === SubscriptionJourneyStatus.PAUSED) {
      actions.push("RESUME");
    } else if (
      journey.status !== SubscriptionJourneyStatus.COMPLETED &&
      journey.status !== SubscriptionJourneyStatus.CANCELLED
    ) {
      actions.push("PAUSE");
    }
  }
  if (
    can(user, PermissionCode.SUBSCRIPTION_JOURNEY_CANCEL) &&
    journey.status !== SubscriptionJourneyStatus.COMPLETED &&
    journey.status !== SubscriptionJourneyStatus.CANCELLED &&
    journey.order?.contract?.status !== ContractStatus.SIGNED &&
    journey.order?.contract?.status !== ContractStatus.ARCHIVED
  ) {
    actions.push("CANCEL");
  }
  return actions;
}

function customerNextAction(journey: AdminJourney) {
  if (journey.currentStepStatus !== SubscriptionJourneyStepStatus.WAITING_CUSTOMER) {
    return null;
  }
  if (
    journey.currentStepCode ===
    SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION
  ) {
    return "CONFIRM_FINAL_PLAN";
  }
  if (
    journey.currentStepCode ===
    SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT
  ) {
    return "PAY_INITIAL_BILLS";
  }
  return "CONTINUE_IN_PORTAL";
}

function can(user: RequestUser, permission: PermissionCode) {
  return (
    user.roles.includes("ADMIN") || user.permissions.includes(permission)
  );
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
