import { createHash } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import {
  AuditAction,
  BusinessType,
  OrderStatus,
  Prisma,
  SubscriptionChangePricingMode,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType,
  VehicleStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import {
  SUBSCRIPTION_CHANGE_CONFIG,
  SubscriptionChangeConfig
} from "./subscription-change.config";
import { SubscriptionChangeError } from "./subscription-change.errors";
import { ContractSegmentService } from "./contract-segment.service";
import { SubscriptionExtensionPricingService } from "./subscription-extension-pricing.service";

const ACTIVE_CHANGE_STATUSES: SubscriptionChangeStatus[] = [
  SubscriptionChangeStatus.DRAFT,
  SubscriptionChangeStatus.QUOTED,
  SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
  SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
  SubscriptionChangeStatus.SCHEDULED,
  SubscriptionChangeStatus.EXECUTING,
  SubscriptionChangeStatus.MANUAL_TAKEOVER
];

const CANCELLABLE_STATUSES: SubscriptionChangeStatus[] = [
  SubscriptionChangeStatus.DRAFT,
  SubscriptionChangeStatus.QUOTED,
  SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
  SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
  SubscriptionChangeStatus.MANUAL_TAKEOVER
];

const changeDetailInclude = Prisma.validator<Prisma.SubscriptionChangeOrderInclude>()({
  automationJobs: { orderBy: { createdAt: "desc" } },
  confirmedQuote: true,
  contract: true,
  currentQuote: true,
  order: { include: { vehicle: true } },
  quotes: { orderBy: { revision: "desc" } },
  renewalConsideration: {
    include: { reminders: { orderBy: { scheduledAt: "asc" } } }
  },
  sourceSegment: true,
  targetSegment: true
});

type ChangeDetail = Prisma.SubscriptionChangeOrderGetPayload<{
  include: typeof changeDetailInclude;
}>;

export interface CreateExtensionInput {
  discountedMonthlyFeeAmount?: bigint;
  extensionMonths: number;
  idempotencyKey?: string;
  orderId: string;
  priceOverrideReason?: string;
  pricingMode: SubscriptionChangePricingMode;
  renewalConsiderationId?: string;
  requestedVehicleBaseFeeAmount?: bigint;
  subscriptionPlanId?: string;
}

export interface QuoteInput {
  discountedMonthlyFeeAmount?: bigint;
  idempotencyKey?: string;
  requestedVehicleBaseFeeAmount?: bigint;
  subscriptionPlanId?: string;
  version?: number;
}

interface VersionedCommandInput {
  idempotencyKey?: string;
  version: number;
}

interface ReasonedCommandInput extends VersionedCommandInput {
  reason: string;
}

@Injectable()
export class SubscriptionExtensionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly segmentService: ContractSegmentService,
    private readonly pricingService: SubscriptionExtensionPricingService,
    @Inject(SUBSCRIPTION_CHANGE_CONFIG)
    private readonly config: SubscriptionChangeConfig
  ) {}

  async createExtension(
    input: CreateExtensionInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_CREATE);
    assertIdempotencyKey(input.idempotencyKey);
    if (!Number.isSafeInteger(input.extensionMonths) || input.extensionMonths <= 0) {
      throw badRequest("EXTENSION_MONTHS_INVALID", "Extension months must be a positive integer.");
    }
    assertPricingSelection(input.pricingMode, input);

    const replay = await this.replayChange(
      "CREATE_EXTENSION",
      input.idempotencyKey!,
      actor.id,
      input
    );
    if (replay) return replay;

    const order = await this.prisma.subscriptionOrder.findUnique({
      include: { vehicle: true },
      where: { id: input.orderId }
    });
    if (!order || order.deletedAt) {
      throw new SubscriptionChangeError(
        "SUBSCRIPTION_ORDER_NOT_FOUND",
        "Subscription order was not found.",
        HttpStatus.NOT_FOUND
      );
    }
    if (!order.vehicle) {
      throw badRequest("ORDER_VEHICLE_REQUIRED", "A leased vehicle is required for extension pricing.");
    }
    if (
      order.businessType !== BusinessType.SUBSCRIPTION ||
      order.orderStatus !== OrderStatus.ACTIVE
    ) {
      throw stateConflict(
        "SUBSCRIPTION_ORDER_NOT_ACTIVE",
        "Only an active subscription order can be extended."
      );
    }
    if (order.vehicle.status !== VehicleStatus.LEASED) {
      throw stateConflict(
        "LEASED_VEHICLE_REQUIRED",
        "The subscription vehicle must remain leased while the extension is created."
      );
    }

    await this.segmentService.ensureBaseSegment(order.id, actor.id);
    const sourceSegment = await this.prisma.subscriptionContractSegment.findFirst({
      orderBy: { sequenceNo: "desc" },
      where: { orderId: order.id, status: { not: "CANCELLED" } }
    });
    if (!sourceSegment) {
      throw new SubscriptionChangeError(
        "SOURCE_CONTRACT_SEGMENT_NOT_FOUND",
        "A source contract segment is required before creating an extension."
      );
    }

    const targetStartDate = addUtcDays(sourceSegment.endDate, 1);
    const targetEndDate = addUtcDays(addCalendarMonths(targetStartDate, input.extensionMonths), -1);
    const completionDeadlineAt = shanghaiStartOfDate(targetStartDate);
    assertBeforeDeadline(this.config.now(), completionDeadlineAt);
    await this.segmentService.assertAppendableExtension(
      sourceSegment.id,
      targetStartDate,
      targetEndDate
    );

    const active = await this.prisma.subscriptionChangeOrder.findFirst({
      where: { orderId: order.id, status: { in: ACTIVE_CHANGE_STATUSES } }
    });
    if (active) {
      throw new SubscriptionChangeError(
        "ACTIVE_SUBSCRIPTION_CHANGE_EXISTS",
        "The order already has an active subscription change."
      );
    }

    const requestHash = commandHash(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const command = await reserveCommand(
          tx,
          actor.id,
          "CREATE_EXTENSION",
          input.idempotencyKey!,
          requestHash
        );
        const change = await tx.subscriptionChangeOrder.create({
          data: {
            changeNo: createBusinessNo("SCO"),
            changeType: SubscriptionChangeType.EXTENSION,
            completionDeadlineAt,
            createdBy: actor.id,
            extensionMonths: input.extensionMonths,
            orderId: order.id,
            priceOverrideReason: normalizedReason(input.priceOverrideReason),
            pricingMode: input.pricingMode,
            renewalConsiderationId: input.renewalConsiderationId,
            sourceSegmentId: sourceSegment.id,
            status: SubscriptionChangeStatus.DRAFT,
            targetEndDate,
            targetStartDate,
            updatedBy: actor.id
          },
          include: changeDetailInclude
        });
        await this.auditService.write(
          auditInput(AuditAction.CREATE, "subscription_change_order", change.id, actor, context, undefined, change),
          tx
        );
        await completeCommand(tx, command.id, "CHANGE", change.id, this.config.now());
        return change;
      }, serializableTransaction);
    } catch (error) {
      return this.resolveWriteConflict(error, "CREATE_EXTENSION", input.idempotencyKey!, actor.id, input);
    }
  }

  async previewQuote(id: string, input: QuoteInput, actor: RequestUser) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_QUOTE);
    const change = await this.findChangeOrThrow(id);
    assertQuoteMutable(change);
    assertBeforeDeadline(this.config.now(), change.completionDeadlineAt);
    return this.pricingService.calculate(pricingInput(change, input, this.config.now()));
  }

  async createFormalQuote(
    id: string,
    input: QuoteInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_QUOTE);
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);
    const replay = await this.replayQuote(
      "CREATE_FORMAL_QUOTE",
      input.idempotencyKey!,
      actor.id,
      { id, ...input }
    );
    if (replay) return replay;

    const requestHash = commandHash({ id, ...input });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const command = await reserveCommand(
          tx,
          actor.id,
          "CREATE_FORMAL_QUOTE",
          input.idempotencyKey!,
          requestHash
        );
        await lockChange(tx, id);
        const change = await tx.subscriptionChangeOrder.findUnique({
          include: changeDetailInclude,
          where: { id }
        });
        if (!change) throw changeNotFound();
        assertVersionMatches(change.version, input.version!);
        assertQuoteMutable(change);
        assertBeforeDeadline(this.config.now(), change.completionDeadlineAt);

        const pricing = await this.pricingService.calculate(
          pricingInput(change, input, this.config.now())
        );
        const latest = await tx.subscriptionChangeQuote.findFirst({
          orderBy: { revision: "desc" },
          where: { changeOrderId: id }
        });
        if (latest?.status === SubscriptionChangeQuoteStatus.FORMAL) {
          await tx.subscriptionChangeQuote.update({
            data: { status: SubscriptionChangeQuoteStatus.SUPERSEDED },
            where: { id: latest.id }
          });
        }
        const validUntil = minDate(
          new Date(this.config.now().getTime() + this.config.quoteValidityHours * 3_600_000),
          change.completionDeadlineAt
        );
        const quote = await tx.subscriptionChangeQuote.create({
          data: {
            changeOrderId: id,
            createdBy: actor.id,
            depositAmount: 0n,
            energyLimitCount: pricing.energyLimitCount,
            energyLimitKwh: pricing.energyLimitKwh,
            formalizedAt: this.config.now(),
            mileageLimitKm: pricing.mileageLimitKm,
            monthlyFeeAmount: pricing.monthlyFeeAmount,
            overMileageFeeAmount: pricing.overMileageFeeAmount,
            planSnapshot: pricing.planSnapshot,
            priceRuleSnapshot: pricing.priceRuleSnapshot,
            pricingMode: change.pricingMode,
            productId: pricing.productId,
            productVersionId: pricing.productVersionId,
            quoteNo: createBusinessNo("SCQ"),
            quoteSnapshot: pricing.quoteSnapshot,
            revision: (latest?.revision ?? 0) + 1,
            status: SubscriptionChangeQuoteStatus.FORMAL,
            subscriptionPlanId: pricing.subscriptionPlanId,
            validUntil
          }
        });
        await tx.subscriptionChangeOrder.update({
          data: {
            customerConfirmationPublishedAt: null,
            customerConfirmationPublishedBy: null,
            currentQuoteId: quote.id,
            priceOverrideApprovedAt: null,
            priceOverrideApprovedBy: null,
            status: SubscriptionChangeStatus.QUOTED,
            updatedBy: actor.id,
            version: { increment: 1 }
          },
          where: { id }
        });
        if (change.renewalConsiderationId) {
          await tx.renewalConsideration.updateMany({
            data: { status: "EXTENSION_IN_PROGRESS", version: { increment: 1 } },
            where: {
              id: change.renewalConsiderationId,
              status: "RENEWAL_REQUESTED"
            }
          });
        }
        await this.auditService.write(
          auditInput(AuditAction.CREATE, "subscription_change_quote", quote.id, actor, context, latest, quote),
          tx
        );
        await completeCommand(tx, command.id, "QUOTE", quote.id, this.config.now());
        return quote;
      }, serializableTransaction);
    } catch (error) {
      return this.resolveWriteConflict(error, "CREATE_FORMAL_QUOTE", input.idempotencyKey!, actor.id, { id, ...input }, "QUOTE");
    }
  }

  async approvePriceOverride(
    id: string,
    input: ReasonedCommandInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_PRICE_OVERRIDE_APPROVE);
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);
    return this.runChangeCommand("APPROVE_PRICE_OVERRIDE", id, input, actor, context, async (tx, change) => {
      if (change.pricingMode === SubscriptionChangePricingMode.CURRENT_VERSION) {
        throw badRequest(
          "PRICE_OVERRIDE_NOT_REQUIRED",
          "Current-version pricing does not require a price override approval."
        );
      }
      if (!change.currentQuote || change.currentQuote.status !== SubscriptionChangeQuoteStatus.FORMAL) {
        throw stateConflict(
          "CURRENT_FORMAL_QUOTE_REQUIRED",
          "A current formal quote is required before approving a price exception."
        );
      }
      if (change.currentQuote.createdBy === actor.id) {
        throw new SubscriptionChangeError(
          "PRICE_OVERRIDE_SELF_APPROVAL_FORBIDDEN",
          "The price override approver must differ from the extension submitter.",
          HttpStatus.FORBIDDEN
        );
      }
      const reason = normalizedReason(input.reason);
      if (!reason) throw badRequest("PRICE_OVERRIDE_REASON_REQUIRED", "Approval reason is required.");
      const updated = await tx.subscriptionChangeOrder.update({
        data: {
          priceOverrideApprovedAt: this.config.now(),
          priceOverrideApprovedBy: actor.id,
          priceOverrideReason: reason,
          updatedBy: actor.id,
          version: { increment: 1 }
        },
        include: changeDetailInclude,
        where: { id }
      });
      await this.auditService.write(
        auditInput(AuditAction.APPROVE, "subscription_change_order", id, actor, context, change, updated),
        tx
      );
      return updated;
    });
  }

  async submitCustomerConfirmation(
    id: string,
    input: VersionedCommandInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_SUBMIT);
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);
    return this.runChangeCommand("SUBMIT_CUSTOMER_CONFIRMATION", id, input, actor, context, async (tx, change) => {
      if (change.status !== SubscriptionChangeStatus.QUOTED) {
        throw stateConflict("CHANGE_NOT_READY_FOR_CUSTOMER", "Only a quoted change can be published to the customer.");
      }
      if (
        change.pricingMode !== SubscriptionChangePricingMode.CURRENT_VERSION &&
        (!change.priceOverrideApprovedBy || !change.priceOverrideApprovedAt)
      ) {
        throw stateConflict(
          "PRICE_OVERRIDE_APPROVAL_REQUIRED",
          "Original-price and discounted quotes require independent approval before customer publication."
        );
      }
      const quote = change.currentQuoteId
        ? await tx.subscriptionChangeQuote.findUnique({ where: { id: change.currentQuoteId } })
        : null;
      if (
        !quote ||
        quote.status !== SubscriptionChangeQuoteStatus.FORMAL ||
        quote.validUntil <= this.config.now()
      ) {
        throw stateConflict("CURRENT_QUOTE_NOT_PUBLISHABLE", "The current formal quote is missing or expired.");
      }
      const updated = await tx.subscriptionChangeOrder.update({
        data: {
          customerConfirmationPublishedAt: this.config.now(),
          customerConfirmationPublishedBy: actor.id,
          updatedBy: actor.id,
          version: { increment: 1 }
        },
        include: changeDetailInclude,
        where: { id }
      });
      await this.auditService.write(
        auditInput(AuditAction.UPDATE, "subscription_change_order", id, actor, context, change, {
          ...updated,
          publishedQuoteId: quote.id,
          publishedQuoteRevision: quote.revision
        }),
        tx
      );
      return updated;
    });
  }

  async cancel(
    id: string,
    input: ReasonedCommandInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_CANCEL);
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);
    return this.runChangeCommand("CANCEL_CHANGE", id, input, actor, context, async (tx, change) => {
      if (!CANCELLABLE_STATUSES.includes(change.status)) {
        throw stateConflict("SUBSCRIPTION_CHANGE_NOT_CANCELLABLE", "The change can no longer be cancelled directly.");
      }
      const reason = normalizedReason(input.reason);
      if (!reason) throw badRequest("CANCEL_REASON_REQUIRED", "A cancellation reason is required.");
      const updated = await tx.subscriptionChangeOrder.update({
        data: {
          cancelReason: reason,
          status: SubscriptionChangeStatus.CANCELLED,
          updatedBy: actor.id,
          version: { increment: 1 }
        },
        include: changeDetailInclude,
        where: { id }
      });
      await this.auditService.write(
        auditInput(AuditAction.UPDATE, "subscription_change_order", id, actor, context, change, updated),
        tx
      );
      return updated;
    });
  }

  async manualTakeover(
    id: string,
    input: ReasonedCommandInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_MANUAL_TAKEOVER);
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);
    return this.runChangeCommand("MANUAL_TAKEOVER", id, input, actor, context, async (tx, change) => {
      const finalStatuses: SubscriptionChangeStatus[] = [
        SubscriptionChangeStatus.COMPLETED,
        SubscriptionChangeStatus.CANCELLED
      ];
      if (finalStatuses.includes(change.status)) {
        throw stateConflict("SUBSCRIPTION_CHANGE_FINAL", "A final change cannot enter manual takeover.");
      }
      const reason = normalizedReason(input.reason);
      if (!reason) throw badRequest("MANUAL_TAKEOVER_REASON_REQUIRED", "A manual takeover reason is required.");
      const updated = await tx.subscriptionChangeOrder.update({
        data: {
          manualTakeoverAt: this.config.now(),
          manualTakeoverBy: actor.id,
          manualTakeoverReason: reason,
          status: SubscriptionChangeStatus.MANUAL_TAKEOVER,
          updatedBy: actor.id,
          version: { increment: 1 }
        },
        include: changeDetailInclude,
        where: { id }
      });
      await this.auditService.write(
        auditInput(AuditAction.UPDATE, "subscription_change_order", id, actor, context, change, updated),
        tx
      );
      return updated;
    });
  }

  async retryAutomationJob(
    id: string,
    jobId: string,
    input: VersionedCommandInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE);
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);
    const operation = `RETRY_AUTOMATION_JOB:${jobId}`;
    const replay = await this.replayChange(operation, input.idempotencyKey!, actor.id, {
      id,
      jobId,
      ...input
    });
    if (replay) return replay;

    const requestHash = commandHash({ id, jobId, ...input });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const command = await reserveCommand(
          tx,
          actor.id,
          operation,
          input.idempotencyKey!,
          requestHash
        );
        await lockChange(tx, id);
        const change = await tx.subscriptionChangeOrder.findUnique({
          include: changeDetailInclude,
          where: { id }
        });
        if (!change) throw changeNotFound();
        assertVersionMatches(change.version, input.version);
        if (change.status !== SubscriptionChangeStatus.MANUAL_TAKEOVER) {
          throw stateConflict(
            "SUBSCRIPTION_CHANGE_JOB_RETRY_NOT_ALLOWED",
            "Only a worker-owned manual takeover can retry an extension execution job."
          );
        }

        const job = await tx.subscriptionAutomationJob.findUnique({ where: { id: jobId } });
        if (!job || job.changeOrderId !== id) {
          throw new SubscriptionChangeError(
            "SUBSCRIPTION_CHANGE_JOB_NOT_FOUND",
            "The subscription change automation job was not found.",
            HttpStatus.NOT_FOUND
          );
        }
        if (
          job.jobStatus !== SubscriptionAutomationJobStatus.DEAD_LETTER ||
          !RETRYABLE_EXTENSION_JOB_TYPES.includes(job.jobType)
        ) {
          throw stateConflict(
            "SUBSCRIPTION_CHANGE_JOB_NOT_RETRYABLE",
            "Only dead-lettered extension execution jobs can be retried."
          );
        }
        if (
          job.contractSegmentId !== change.targetSegment?.id ||
          !job.lastErrorCode ||
          change.failureCode !== job.lastErrorCode
        ) {
          throw stateConflict(
            "SUBSCRIPTION_CHANGE_JOB_RETRY_NOT_ALLOWED",
            "The failed job does not match the current target-segment manual takeover."
          );
        }

        const retried = await tx.subscriptionAutomationJob.updateMany({
          data: {
            attemptCount: 0,
            availableAt: this.config.now(),
            completedAt: null,
            jobStatus: SubscriptionAutomationJobStatus.PENDING,
            lastErrorCode: null,
            lastErrorMessage: null,
            leaseExpiresAt: null,
            leaseToken: null,
            resultSnapshot: Prisma.DbNull,
            startedAt: null
          },
          where: {
            changeOrderId: id,
            id: jobId,
            jobStatus: SubscriptionAutomationJobStatus.DEAD_LETTER
          }
        });
        if (retried.count !== 1) {
          throw stateConflict(
            "SUBSCRIPTION_CHANGE_JOB_RETRY_CONFLICT",
            "The automation job changed before it could be retried."
          );
        }

        const updated = await tx.subscriptionChangeOrder.update({
          data: {
            failureCode: null,
            failureMessage: null,
            status:
              job.jobType === SubscriptionAutomationJobType.EXTENSION_SEGMENT_ACTIVATE
                ? SubscriptionChangeStatus.SCHEDULED
                : SubscriptionChangeStatus.EXECUTING,
            updatedBy: actor.id,
            version: { increment: 1 }
          },
          include: changeDetailInclude,
          where: { id }
        });
        await this.auditService.write(
          auditInput(
            AuditAction.UPDATE,
            "subscription_change_job_retry",
            jobId,
            actor,
            context,
            job,
            { ...job, jobStatus: SubscriptionAutomationJobStatus.PENDING }
          ),
          tx
        );
        await completeCommand(tx, command.id, "CHANGE", updated.id, this.config.now());
        return updated;
      }, serializableTransaction);
    } catch (error) {
      return this.resolveWriteConflict(
        error,
        operation,
        input.idempotencyKey!,
        actor.id,
        { id, jobId, ...input }
      );
    }
  }

  async get(id: string, actor: RequestUser) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_VIEW);
    return this.findChangeOrThrow(id);
  }

  async startOrRetryESign<T>(
    id: string,
    input: VersionedCommandInput,
    actor: RequestUser,
    start: (contractId: string) => Promise<T>
  ): Promise<T> {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_ESIGN_RETRY);
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);

    const change = await this.findChangeOrThrow(id);
    assertVersionMatches(change.version, input.version);
    assertBeforeDeadline(this.config.now(), change.completionDeadlineAt);
    if (change.status !== SubscriptionChangeStatus.SIGNING_OR_PAYMENT) {
      throw stateConflict(
        "SUBSCRIPTION_CHANGE_ESIGN_NOT_ALLOWED",
        "The subscription change is not ready for e-sign."
      );
    }
    if (!change.contract) {
      throw stateConflict(
        "SUBSCRIPTION_CHANGE_CONTRACT_MISSING",
        "The subscription extension contract is missing."
      );
    }
    return start(change.contract.id);
  }

  async listForOrder(orderId: string, actor: RequestUser) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_VIEW);
    return this.prisma.subscriptionChangeOrder.findMany({
      include: changeDetailInclude,
      orderBy: { createdAt: "desc" },
      where: { orderId }
    });
  }

  async timeline(id: string, actor: RequestUser) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_VIEW);
    const change = await this.findChangeOrThrow(id);
    const entityIds = [
      change.id,
      ...change.quotes.map((quote) => quote.id),
      ...change.automationJobs.map((job) => job.id)
    ];
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: "asc" },
      where: {
        entityId: { in: entityIds },
        entityType: {
          in: [
            "subscription_change_order",
            "subscription_change_quote",
            "subscription_change_job_retry"
          ]
        }
      }
    });
  }

  private async runChangeCommand(
    operation: string,
    id: string,
    input: VersionedCommandInput,
    actor: RequestUser,
    context: RequestContext,
    execute: (
      tx: Prisma.TransactionClient,
      change: ChangeDetail
    ) => Promise<ChangeDetail>
  ) {
    const replay = await this.replayChange(operation, input.idempotencyKey!, actor.id, { id, ...input });
    if (replay) return replay;
    const requestHash = commandHash({ id, ...input });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const command = await reserveCommand(
          tx,
          actor.id,
          operation,
          input.idempotencyKey!,
          requestHash
        );
        await lockChange(tx, id);
        const change = await tx.subscriptionChangeOrder.findUnique({
          include: changeDetailInclude,
          where: { id }
        });
        if (!change) throw changeNotFound();
        assertVersionMatches(change.version, input.version);
        assertBeforeDeadline(this.config.now(), change.completionDeadlineAt);
        const updated = await execute(tx, change);
        await completeCommand(tx, command.id, "CHANGE", updated.id, this.config.now());
        return updated;
      }, serializableTransaction);
    } catch (error) {
      return this.resolveWriteConflict(error, operation, input.idempotencyKey!, actor.id, { id, ...input });
    }
  }

  private async replayChange(operation: string, key: string, actorId: string, input: unknown) {
    const command = await this.findReplay(operation, key, actorId, input);
    if (!command) return null;
    if (command.resourceType !== "CHANGE" || !command.resourceId) {
      throw stateConflict("IDEMPOTENCY_COMMAND_IN_PROGRESS", "The idempotent command has not completed.");
    }
    return this.findChangeOrThrow(command.resourceId);
  }

  private async replayQuote(operation: string, key: string, actorId: string, input: unknown) {
    const command = await this.findReplay(operation, key, actorId, input);
    if (!command) return null;
    if (command.resourceType !== "QUOTE" || !command.resourceId) {
      throw stateConflict("IDEMPOTENCY_COMMAND_IN_PROGRESS", "The idempotent command has not completed.");
    }
    const quote = await this.prisma.subscriptionChangeQuote.findUnique({
      where: { id: command.resourceId }
    });
    if (!quote) throw stateConflict("IDEMPOTENCY_RESOURCE_MISSING", "The prior command result is missing.");
    return quote;
  }

  private async findReplay(operation: string, key: string, actorId: string, input: unknown) {
    const command = await this.prisma.subscriptionChangeCommand.findUnique({
      where: {
        actorId_operation_idempotencyKey: {
          actorId,
          idempotencyKey: key,
          operation
        }
      }
    });
    if (!command) return null;
    const hash = commandHash(input);
    if (typeof command.requestHash === "string" && command.requestHash !== hash) {
      throw stateConflict(
        "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
        "The Idempotency-Key was already used with a different request."
      );
    }
    return command;
  }

  private async resolveWriteConflict(
    error: unknown,
    operation: string,
    key: string,
    actorId: string,
    input: unknown,
    resourceType: "CHANGE" | "QUOTE" = "CHANGE"
  ): Promise<never> {
    if (error instanceof SubscriptionChangeError) throw error;
    if (isUniqueConstraintError(error)) {
      const replay =
        resourceType === "QUOTE"
          ? await this.replayQuote(operation, key, actorId, input)
          : await this.replayChange(operation, key, actorId, input);
      if (replay) return replay as never;
      throw stateConflict(
        "ACTIVE_SUBSCRIPTION_CHANGE_EXISTS",
        "The order already has an active subscription change."
      );
    }
    throw error;
  }

  private async findChangeOrThrow(id: string) {
    const change = await this.prisma.subscriptionChangeOrder.findUnique({
      include: changeDetailInclude,
      where: { id }
    });
    if (!change) throw changeNotFound();
    return change;
  }

  private assertWriteEnabled() {
    if (!this.config.enabled) {
      throw new SubscriptionChangeError(
        "SUBSCRIPTION_EXTENSION_DISABLED",
        "Subscription extensions are disabled.",
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
  }
}

const RETRYABLE_EXTENSION_JOB_TYPES: SubscriptionAutomationJobType[] = [
  SubscriptionAutomationJobType.EXTENSION_SEGMENT_ACTIVATE,
  SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME,
  SubscriptionAutomationJobType.EXTENSION_ENTITLEMENT_RENEW,
  SubscriptionAutomationJobType.EXTENSION_EFFECTIVE_NOTICE
];

function pricingInput(change: ChangeDetail, input: QuoteInput, asOf: Date) {
  if (!change.order.vehicle) {
    throw badRequest("ORDER_VEHICLE_REQUIRED", "A leased vehicle is required for extension pricing.");
  }
  return {
    asOf,
    discountedMonthlyFeeAmount: input.discountedMonthlyFeeAmount,
    extensionMonths: change.extensionMonths,
    pricingMode: change.pricingMode,
    requestedVehicleBaseFeeAmount: input.requestedVehicleBaseFeeAmount,
    sourceSegment: change.sourceSegment,
    subscriptionPlanId: input.subscriptionPlanId,
    vehicle: change.order.vehicle
  };
}

function assertPricingSelection(
  mode: SubscriptionChangePricingMode,
  input: Pick<CreateExtensionInput, "priceOverrideReason" | "subscriptionPlanId">
) {
  if (
    (mode === SubscriptionChangePricingMode.CURRENT_VERSION ||
      mode === SubscriptionChangePricingMode.APPROVED_DISCOUNT) &&
    !input.subscriptionPlanId
  ) {
    throw badRequest("SUBSCRIPTION_PLAN_REQUIRED", "A current subscription plan is required.");
  }
  if (
    mode !== SubscriptionChangePricingMode.CURRENT_VERSION &&
    !normalizedReason(input.priceOverrideReason)
  ) {
    throw badRequest(
      "PRICE_OVERRIDE_REASON_REQUIRED",
      "Original-price and discounted extensions require a price override reason."
    );
  }
}

function assertQuoteMutable(change: Pick<ChangeDetail, "confirmedQuoteId" | "status">) {
  if (change.confirmedQuoteId || change.status === SubscriptionChangeStatus.CUSTOMER_CONFIRMED) {
    throw stateConflict("CONFIRMED_QUOTE_IMMUTABLE", "A customer-confirmed quote cannot be replaced.");
  }
  const quotableStatuses: SubscriptionChangeStatus[] = [
    SubscriptionChangeStatus.DRAFT,
    SubscriptionChangeStatus.QUOTED
  ];
  if (!quotableStatuses.includes(change.status)) {
    throw stateConflict("SUBSCRIPTION_CHANGE_NOT_QUOTABLE", "The change is not in a quotable state.");
  }
}

function assertPermission(actor: RequestUser, permission: PermissionCode) {
  if (!actor.roles.includes("ADMIN") && !actor.permissions.includes(permission)) {
    throw new SubscriptionChangeError("PERMISSION_DENIED", "Permission denied.", HttpStatus.FORBIDDEN);
  }
}

function assertIdempotencyKey(value: string | undefined): asserts value is string {
  if (!value || !value.trim() || value.length > 128) {
    throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required.");
  }
}

function assertVersion(value: number | undefined): asserts value is number {
  if (!Number.isSafeInteger(value) || value! < 0) {
    throw badRequest("VERSION_INVALID", "A non-negative optimistic-lock version is required.");
  }
}

function assertVersionMatches(actual: number, expected: number) {
  if (actual !== expected) {
    throw stateConflict("VERSION_CONFLICT", "The subscription change was updated by another request.");
  }
}

function assertBeforeDeadline(now: Date, deadline: Date) {
  if (now >= deadline) {
    throw stateConflict(
      "EXTENSION_DEADLINE_PASSED",
      "The extension completion deadline has passed; the original contract must proceed to return."
    );
  }
}

async function reserveCommand(
  tx: Prisma.TransactionClient,
  actorId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string
) {
  return tx.subscriptionChangeCommand.create({
    data: { actorId, idempotencyKey, operation, requestHash }
  });
}

async function completeCommand(
  tx: Prisma.TransactionClient,
  commandId: string,
  resourceType: "CHANGE" | "QUOTE",
  resourceId: string,
  completedAt: Date
) {
  await tx.subscriptionChangeCommand.update({
    data: { completedAt, resourceId, resourceType },
    where: { id: commandId }
  });
}

async function lockChange(tx: Prisma.TransactionClient, id: string) {
  if (typeof tx.$queryRaw !== "function") return;
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "subscription_change_order" WHERE "id" = ${id}::uuid FOR UPDATE
  `);
}

function auditInput(
  action: AuditAction,
  entityType: string,
  entityId: string,
  actor: RequestUser,
  context: RequestContext,
  before: unknown,
  after: unknown
) {
  return {
    action,
    after: jsonSafe(after),
    before: jsonSafe(before),
    entityId,
    entityType,
    ipAddress: context.ipAddress,
    module: "subscription_change",
    operatorId: actor.id,
    userAgent: context.userAgent
  };
}

function commandHash(input: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

function jsonSafe(value: unknown) {
  return value === undefined
    ? undefined
    : JSON.parse(
        JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item))
      );
}

function normalizedReason(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function addUtcDays(value: Date, days: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function addCalendarMonths(value: Date, months: number) {
  const year = value.getUTCFullYear();
  const monthIndex = value.getUTCMonth() + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(value.getUTCDate(), lastDay)));
}

function shanghaiStartOfDate(value: Date) {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) - 8 * 3_600_000
  );
}

function minDate(left: Date, right: Date) {
  return left <= right ? left : right;
}

function badRequest(code: string, message: string) {
  return new SubscriptionChangeError(code, message, HttpStatus.BAD_REQUEST);
}

function stateConflict(code: string, message: string) {
  return new SubscriptionChangeError(code, message, HttpStatus.CONFLICT);
}

function changeNotFound() {
  return new SubscriptionChangeError(
    "SUBSCRIPTION_CHANGE_NOT_FOUND",
    "Subscription change was not found.",
    HttpStatus.NOT_FOUND
  );
}

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

const serializableTransaction = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable
};
