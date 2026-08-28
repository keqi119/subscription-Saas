import { createHash } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import {
  AuditAction,
  BusinessType,
  OrderStatus,
  Prisma,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType,
  VehicleStatus
} from "@prisma/client";

import {
  AssetOperationsService,
  type SubscriptionChangeVehicleReservationInput
} from "../asset-operations/asset-operations.service";
import { VehicleAvailabilityPurpose } from "../asset-operations/vehicle-availability";
import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import {
  isSubscriptionChangeTypeEnabled,
  SUBSCRIPTION_CHANGE_CONFIG,
  SubscriptionChangeConfig
} from "./subscription-change.config";
import { SubscriptionChangeError } from "./subscription-change.errors";
import { SubscriptionVehicleSwapPricingService } from "./subscription-vehicle-swap-pricing.service";

const swapChangeInclude = Prisma.validator<Prisma.SubscriptionChangeOrderInclude>()({
  confirmedQuote: true,
  currentQuote: true,
  order: { include: { vehicle: true } },
  quotes: { orderBy: { revision: "desc" } },
  sourceSegment: true,
  vehicleSwapDetail: {
    include: { sourceVehicle: true, targetVehicle: true }
  }
});

type SwapChange = Prisma.SubscriptionChangeOrderGetPayload<{
  include: typeof swapChangeInclude;
}>;

interface VersionedCommandInput {
  idempotencyKey?: string;
  version: number;
}

interface CancelVehicleSwapInput extends VersionedCommandInput {
  reason: string;
}

export interface ExactVehicleSwapQuoteInput {
  commercialSnapshotHash: string;
  idempotencyKey?: string;
  quoteId: string;
  revision: number;
  version: number;
}

export interface RejectVehicleSwapQuoteInput extends ExactVehicleSwapQuoteInput {
  reason: string;
}

export interface PortalSubscriptionChangeCustomer {
  customerId: string;
}

const CANCELLABLE_STATUSES: SubscriptionChangeStatus[] = [
  SubscriptionChangeStatus.DRAFT,
  SubscriptionChangeStatus.QUOTED,
  SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
  SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
  SubscriptionChangeStatus.MANUAL_TAKEOVER
];

@Injectable()
export class SubscriptionVehicleSwapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly assetOperations: AssetOperationsService,
    private readonly pricingService: SubscriptionVehicleSwapPricingService,
    @Inject(SUBSCRIPTION_CHANGE_CONFIG)
    private readonly config: SubscriptionChangeConfig
  ) {}

  async previewQuote(id: string, actor: RequestUser) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_QUOTE);
    return this.prisma.$transaction(async (tx) => {
      const change = await findSwapChange(tx, id);
      assertQuotable(change);
      assertBeforeDeadline(this.config.now(), change.completionDeadlineAt);
      assertActiveSwapSource(change);
      await this.assetOperations.assertVehicleAvailable(
        tx,
        change.vehicleSwapDetail.targetVehicleId,
        VehicleAvailabilityPurpose.ALLOCATION,
        this.config.now()
      );
      return this.pricingService.calculate(pricingInput(change));
    }, serializableTransaction);
  }

  async createFormalQuote(
    id: string,
    input: VersionedCommandInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_QUOTE);
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);
    const commandInput = { id, ...input };
    const replay = await this.replayQuote(
      "CREATE_VEHICLE_SWAP_FORMAL_QUOTE",
      input.idempotencyKey,
      actor.id,
      commandInput
    );
    if (replay) return replay;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const command = await reserveCommand(
          tx,
          actor.id,
          "CREATE_VEHICLE_SWAP_FORMAL_QUOTE",
          input.idempotencyKey!,
          commandHash(commandInput)
        );
        await lockChange(tx, id);
        const change = await findSwapChange(tx, id);
        assertVersionMatches(change.version, input.version);
        assertQuotable(change);
        assertBeforeDeadline(this.config.now(), change.completionDeadlineAt);
        assertActiveSwapSource(change);
        await this.assetOperations.assertVehicleAvailable(
          tx,
          change.vehicleSwapDetail.targetVehicleId,
          VehicleAvailabilityPurpose.ALLOCATION,
          this.config.now()
        );
        const pricing = await this.pricingService.calculate(pricingInput(change));
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
        const quote = await tx.subscriptionChangeQuote.create({
          data: {
            changeOrderId: id,
            createdBy: actor.id,
            depositAmount: pricing.depositAmount,
            energyLimitCount: pricing.energyLimitCount,
            energyLimitKwh: pricing.energyLimitKwh,
            formalizedAt: this.config.now(),
            mileageLimitKm: pricing.mileageLimitKm,
            monthlyFeeAmount: pricing.monthlyFeeAmount,
            overMileageFeeAmount: pricing.overMileageFeeAmount,
            planSnapshot: pricing.planSnapshot,
            priceRuleSnapshot: pricing.priceRuleSnapshot,
            pricingMode: pricing.pricingMode,
            productId: pricing.productId,
            productVersionId: pricing.productVersionId,
            quoteNo: createBusinessNo("SCQ"),
            quoteSnapshot: pricing.quoteSnapshot,
            revision: (latest?.revision ?? 0) + 1,
            status: SubscriptionChangeQuoteStatus.FORMAL,
            subscriptionPlanId: pricing.targetSubscriptionPlanId,
            validUntil: minDate(
              new Date(this.config.now().getTime() + this.config.quoteValidityHours * 3_600_000),
              change.completionDeadlineAt
            )
          }
        });
        await tx.subscriptionChangeOrder.update({
          data: {
            customerConfirmationPublishedAt: null,
            customerConfirmationPublishedBy: null,
            currentQuoteId: quote.id,
            status: SubscriptionChangeStatus.QUOTED,
            updatedBy: actor.id,
            version: change.version + 1
          },
          where: { id }
        });
        await this.auditService.write(
          adminAudit(
            AuditAction.CREATE,
            "subscription_change_quote",
            quote.id,
            actor,
            context,
            latest,
            quote
          ),
          tx
        );
        await completeCommand(tx, command.id, "QUOTE", quote.id, this.config.now());
        return { ...quote };
      }, serializableTransaction);
    } catch (error) {
      return this.resolveWriteConflict(
        error,
        "CREATE_VEHICLE_SWAP_FORMAL_QUOTE",
        input.idempotencyKey,
        actor.id,
        commandInput,
        "QUOTE"
      );
    }
  }

  async publishCustomerConfirmation(
    id: string,
    input: VersionedCommandInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_SUBMIT);
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);
    const operation = "PUBLISH_VEHICLE_SWAP_CUSTOMER_CONFIRMATION";
    const commandInput = { id, ...input };
    const replay = await this.replayChange(operation, input.idempotencyKey, actor.id, commandInput);
    if (replay) return replay;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const command = await reserveCommand(
          tx,
          actor.id,
          operation,
          input.idempotencyKey!,
          commandHash(commandInput)
        );
        await lockChange(tx, id);
        const change = await findSwapChange(tx, id);
        assertVersionMatches(change.version, input.version);
        assertPublishable(change, this.config.now());
        const reservation = reservationInput(change, actor.id, this.config.now());
        try {
          await this.assetOperations.reserveVehicleForSubscriptionChange(tx, reservation);
        } catch (error) {
          if (errorCode(error) === "TARGET_VEHICLE_RESERVATION_CONFLICT") throw error;
          if (errorCode(error) === "VEHICLE_NOT_AVAILABLE") {
            throw reservationConflict();
          }
          throw error;
        }
        const updated = await tx.subscriptionChangeOrder.update({
          data: {
            customerConfirmationPublishedAt: this.config.now(),
            customerConfirmationPublishedBy: actor.id,
            updatedBy: actor.id,
            version: change.version + 1
          },
          include: swapChangeInclude,
          where: { id }
        });
        await this.auditService.write(
          adminAudit(
            AuditAction.UPDATE,
            "subscription_change_order",
            id,
            actor,
            context,
            change,
            updated
          ),
          tx
        );
        await completeCommand(tx, command.id, "CHANGE", id, this.config.now());
        return updated;
      }, serializableTransaction);
    } catch (error) {
      if (errorCode(error) === "TARGET_VEHICLE_RESERVATION_CONFLICT") {
        throw reservationConflict();
      }
      return this.resolveWriteConflict(
        error,
        operation,
        input.idempotencyKey,
        actor.id,
        commandInput
      );
    }
  }

  async getPortalChange(id: string, customer: PortalSubscriptionChangeCustomer) {
    return toPortalSwapChange(
      await findOwnedSwapChange(this.prisma, id, customer.customerId),
      isSubscriptionChangeTypeEnabled(this.config, SubscriptionChangeType.VEHICLE_SWAP)
    );
  }

  async confirmQuote(
    id: string,
    input: ExactVehicleSwapQuoteInput,
    customer: PortalSubscriptionChangeCustomer,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);
    const operation = "PORTAL_CONFIRM_VEHICLE_SWAP_QUOTE";
    const commandInput = { id, ...input };
    const replay = await this.replayChange(
      operation,
      input.idempotencyKey,
      customer.customerId,
      commandInput
    );
    if (replay) return toPortalSwapChange(replay, true);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const command = await reserveCommand(
          tx,
          customer.customerId,
          operation,
          input.idempotencyKey!,
          commandHash(commandInput)
        );
        await lockChange(tx, id);
        const change = await findOwnedSwapChange(tx, id, customer.customerId);
        assertVersionMatches(change.version, input.version);
        const quote = assertExactPublishedQuote(change, input, this.config.now());
        if (requireSwapDetail(change).targetVehicle.status !== VehicleStatus.REVIEW_RESERVED) {
          throw reservationConflict();
        }
        await tx.subscriptionChangeQuote.update({
          data: {
            confirmedAt: this.config.now(),
            status: SubscriptionChangeQuoteStatus.CUSTOMER_CONFIRMED
          },
          where: { id: quote.id }
        });
        const updated = await tx.subscriptionChangeOrder.update({
          data: {
            confirmedQuoteId: quote.id,
            status: SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
            version: change.version + 1
          },
          include: swapChangeInclude,
          where: { id }
        });
        await this.auditService.write(
          portalAudit(AuditAction.UPDATE, id, customer.customerId, context, change, updated),
          tx
        );
        await completeCommand(tx, command.id, "CHANGE", id, this.config.now());
        return toPortalSwapChange(updated, true);
      }, serializableTransaction);
    } catch (error) {
      const recovered = await this.resolveWriteConflict(
        error,
        operation,
        input.idempotencyKey,
        customer.customerId,
        commandInput
      );
      return toPortalSwapChange(recovered, true);
    }
  }

  async rejectQuote(
    id: string,
    input: RejectVehicleSwapQuoteInput,
    customer: PortalSubscriptionChangeCustomer,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);
    const reason = normalizedReason(input.reason);
    if (!reason)
      throw badRequest("QUOTE_REJECTION_REASON_REQUIRED", "A rejection reason is required.");
    const operation = "PORTAL_REJECT_VEHICLE_SWAP_QUOTE";
    const commandInput = { id, ...input, reason };
    const replay = await this.replayChange(
      operation,
      input.idempotencyKey,
      customer.customerId,
      commandInput
    );
    if (replay) return toPortalSwapChange(replay, true);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const command = await reserveCommand(
          tx,
          customer.customerId,
          operation,
          input.idempotencyKey!,
          commandHash(commandInput)
        );
        await lockChange(tx, id);
        const change = await findOwnedSwapChange(tx, id, customer.customerId);
        assertVersionMatches(change.version, input.version);
        const quote = assertExactPublishedQuote(change, input, this.config.now());
        await tx.subscriptionChangeQuote.update({
          data: {
            rejectedAt: this.config.now(),
            status: SubscriptionChangeQuoteStatus.CUSTOMER_REJECTED
          },
          where: { id: quote.id }
        });
        await this.assetOperations.releaseVehicleReservationForSubscriptionChange(
          tx,
          reservationInput(change, undefined, this.config.now())
        );
        const updated = await tx.subscriptionChangeOrder.update({
          data: {
            cancelReason: `CUSTOMER_QUOTE_REJECTED: ${reason}`,
            status: SubscriptionChangeStatus.CANCELLED,
            version: change.version + 1
          },
          include: swapChangeInclude,
          where: { id }
        });
        await this.auditService.write(
          portalAudit(AuditAction.UPDATE, id, customer.customerId, context, change, updated),
          tx
        );
        await completeCommand(tx, command.id, "CHANGE", id, this.config.now());
        return toPortalSwapChange(updated, true);
      }, serializableTransaction);
    } catch (error) {
      const recovered = await this.resolveWriteConflict(
        error,
        operation,
        input.idempotencyKey,
        customer.customerId,
        commandInput
      );
      return toPortalSwapChange(recovered, true);
    }
  }

  async cancel(
    id: string,
    input: CancelVehicleSwapInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_CANCEL);
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);
    const reason = normalizedReason(input.reason);
    if (!reason) throw badRequest("CANCEL_REASON_REQUIRED", "A cancellation reason is required.");
    const operation = "CANCEL_VEHICLE_SWAP";
    const commandInput = { id, ...input, reason };
    const replay = await this.replayChange(operation, input.idempotencyKey, actor.id, commandInput);
    if (replay) return replay;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const command = await reserveCommand(
          tx,
          actor.id,
          operation,
          input.idempotencyKey!,
          commandHash(commandInput)
        );
        await lockChange(tx, id);
        const change = await findSwapChange(tx, id);
        assertVersionMatches(change.version, input.version);
        if (!CANCELLABLE_STATUSES.includes(change.status)) {
          throw stateConflict(
            "SUBSCRIPTION_CHANGE_NOT_CANCELLABLE",
            "The change can no longer be cancelled directly."
          );
        }
        if (change.customerConfirmationPublishedAt) {
          await this.assetOperations.releaseVehicleReservationForSubscriptionChange(
            tx,
            reservationInput(change, actor.id, this.config.now())
          );
        }
        const updated = await tx.subscriptionChangeOrder.update({
          data: {
            cancelReason: reason,
            status: SubscriptionChangeStatus.CANCELLED,
            updatedBy: actor.id,
            version: change.version + 1
          },
          include: swapChangeInclude,
          where: { id }
        });
        await this.auditService.write(
          adminAudit(
            AuditAction.UPDATE,
            "subscription_change_order",
            id,
            actor,
            context,
            change,
            updated
          ),
          tx
        );
        await completeCommand(tx, command.id, "CHANGE", id, this.config.now());
        return updated;
      }, serializableTransaction);
    } catch (error) {
      return this.resolveWriteConflict(
        error,
        operation,
        input.idempotencyKey,
        actor.id,
        commandInput
      );
    }
  }

  async expireQuote(id: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockChange(tx, id);
      const change = await findSwapChange(tx, id);
      const quote = change.currentQuote;
      if (
        change.status !== SubscriptionChangeStatus.QUOTED ||
        !quote ||
        quote.status !== SubscriptionChangeQuoteStatus.FORMAL ||
        quote.validUntil > this.config.now()
      ) {
        return change;
      }
      if (change.customerConfirmationPublishedAt) {
        await this.assetOperations.releaseVehicleReservationForSubscriptionChange(
          tx,
          reservationInput(change, undefined, this.config.now())
        );
      }
      await tx.subscriptionChangeQuote.update({
        data: { status: SubscriptionChangeQuoteStatus.EXPIRED },
        where: { id: quote.id }
      });
      return tx.subscriptionChangeOrder.update({
        data: {
          currentQuoteId: null,
          customerConfirmationPublishedAt: null,
          customerConfirmationPublishedBy: null,
          status: SubscriptionChangeStatus.DRAFT,
          version: change.version + 1
        },
        include: swapChangeInclude,
        where: { id }
      });
    }, serializableTransaction);
  }

  private async replayChange(operation: string, key: string, actorId: string, input: unknown) {
    const command = await this.findReplay(operation, key, actorId, input);
    if (!command) return null;
    if (command.resourceType !== "CHANGE" || !command.resourceId) {
      throw stateConflict(
        "IDEMPOTENCY_COMMAND_IN_PROGRESS",
        "The idempotent command has not completed."
      );
    }
    return findSwapChange(this.prisma, command.resourceId);
  }

  private async replayQuote(operation: string, key: string, actorId: string, input: unknown) {
    const command = await this.findReplay(operation, key, actorId, input);
    if (!command) return null;
    if (command.resourceType !== "QUOTE" || !command.resourceId) {
      throw stateConflict(
        "IDEMPOTENCY_COMMAND_IN_PROGRESS",
        "The idempotent command has not completed."
      );
    }
    const quote = await this.prisma.subscriptionChangeQuote.findUnique({
      where: { id: command.resourceId }
    });
    if (!quote)
      throw stateConflict("IDEMPOTENCY_RESOURCE_MISSING", "The prior command result is missing.");
    return quote;
  }

  private async findReplay(operation: string, key: string, actorId: string, input: unknown) {
    const command = await this.prisma.subscriptionChangeCommand.findUnique({
      where: { actorId_operation_idempotencyKey: { actorId, idempotencyKey: key, operation } }
    });
    if (!command) return null;
    if (command.requestHash !== commandHash(input)) {
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
    }
    throw error;
  }

  private assertWriteEnabled() {
    if (!isSubscriptionChangeTypeEnabled(this.config, SubscriptionChangeType.VEHICLE_SWAP)) {
      throw new SubscriptionChangeError(
        "SUBSCRIPTION_VEHICLE_SWAP_DISABLED",
        "Subscription vehicle swaps are disabled.",
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
  }
}

function pricingInput(change: SwapChange) {
  assertActiveSwapSource(change);
  return {
    currentDepositAmount: change.order.finalDepositAmount ?? change.order.depositAmount,
    plannedSwapAt: change.vehicleSwapDetail.plannedSwapAt,
    sourceSegment: change.sourceSegment,
    sourceVehicle: change.vehicleSwapDetail.sourceVehicle,
    targetSubscriptionPlanId: change.vehicleSwapDetail.targetSubscriptionPlanId,
    targetVehicle: change.vehicleSwapDetail.targetVehicle,
    targetVehiclePackageId: change.vehicleSwapDetail.targetVehiclePackageId
  };
}

function toPortalSwapChange(change: SwapChange, featureEnabled: boolean) {
  const detail = requireSwapDetail(change);
  const customerDecisionReady = Boolean(
    featureEnabled &&
    change.status === SubscriptionChangeStatus.QUOTED &&
    change.customerConfirmationPublishedAt &&
    change.currentQuote?.status === SubscriptionChangeQuoteStatus.FORMAL &&
    change.currentQuote.quoteSnapshot &&
    isRecord(change.currentQuote.quoteSnapshot) &&
    typeof change.currentQuote.quoteSnapshot.commercialSnapshotHash === "string"
  );
  return {
    allowedActions: customerDecisionReady ? ["CONFIRM_QUOTE", "REJECT_QUOTE"] : [],
    cancelReason: change.cancelReason,
    changeType: change.changeType,
    completionDeadlineAt: change.completionDeadlineAt.toISOString(),
    confirmedQuoteId: change.confirmedQuoteId,
    contractId: change.contractId,
    currentQuote: change.currentQuote ? toPortalSwapQuote(change.currentQuote) : null,
    customerConfirmationPublishedAt: change.customerConfirmationPublishedAt?.toISOString() ?? null,
    detail: {
      commercialSnapshotHash: detail.commercialSnapshotHash,
      plannedSwapAt: detail.plannedSwapAt.toISOString(),
      sourceVehicle: {
        id: detail.sourceVehicle.id,
        modelDefinitionId: detail.sourceVehicle.modelDefinitionId
      },
      targetSubscriptionPlanId: detail.targetSubscriptionPlanId,
      targetVehicle: {
        id: detail.targetVehicle.id,
        modelDefinitionId: detail.targetVehicle.modelDefinitionId
      },
      targetVehiclePackageId: detail.targetVehiclePackageId
    },
    featureAvailability: {
      enabled: featureEnabled,
      flagName: "SUBSCRIPTION_VEHICLE_SWAP_ENABLED"
    },
    id: change.id,
    orderId: change.orderId,
    orderNo: change.order.orderNo,
    quotes: change.quotes.map(toPortalSwapQuote),
    status: change.status,
    version: change.version
  };
}

function toPortalSwapQuote(quote: SwapChange["quotes"][number]) {
  return {
    commercialSnapshot:
      isRecord(quote.quoteSnapshot) && "commercialSnapshot" in quote.quoteSnapshot
        ? quote.quoteSnapshot.commercialSnapshot
        : null,
    commercialSnapshotHash:
      isRecord(quote.quoteSnapshot) &&
      typeof quote.quoteSnapshot.commercialSnapshotHash === "string"
        ? quote.quoteSnapshot.commercialSnapshotHash
        : null,
    depositAmount: quote.depositAmount.toString(),
    energyLimitCount: quote.energyLimitCount,
    energyLimitKwh: quote.energyLimitKwh,
    id: quote.id,
    mileageLimitKm: quote.mileageLimitKm,
    monthlyFeeAmount: quote.monthlyFeeAmount.toString(),
    overMileageFeeAmount: quote.overMileageFeeAmount.toString(),
    pricingMode: quote.pricingMode,
    quoteNo: quote.quoteNo,
    revision: quote.revision,
    status: quote.status,
    validUntil: quote.validUntil.toISOString()
  };
}

function reservationInput(
  change: SwapChange,
  actorId: string | undefined,
  asOf: Date
): SubscriptionChangeVehicleReservationInput {
  return {
    actorId,
    asOf,
    changeOrderId: change.id,
    vehicleId: requireSwapDetail(change).targetVehicleId
  };
}

function assertActiveSwapSource(change: SwapChange): asserts change is SwapChange & {
  sourceSegment: NonNullable<SwapChange["sourceSegment"]>;
  vehicleSwapDetail: NonNullable<SwapChange["vehicleSwapDetail"]>;
} {
  const detail = requireSwapDetail(change);
  if (
    change.order.businessType !== BusinessType.SUBSCRIPTION ||
    change.order.orderStatus !== OrderStatus.ACTIVE
  ) {
    throw stateConflict(
      "SUBSCRIPTION_ORDER_NOT_ACTIVE",
      "Only an active subscription order can be changed."
    );
  }
  if (
    !change.sourceSegment ||
    !change.order.vehicle ||
    change.order.vehicleId !== detail.sourceVehicleId ||
    detail.sourceVehicle.status !== VehicleStatus.LEASED
  ) {
    throw stateConflict(
      "LEASED_SOURCE_VEHICLE_REQUIRED",
      "The active leased source vehicle and contract segment are required."
    );
  }
  if (detail.targetVehicleId === detail.sourceVehicleId) {
    throw badRequest(
      "TARGET_VEHICLE_MUST_DIFFER",
      "The target vehicle must differ from the source vehicle."
    );
  }
}

function requireSwapDetail(change: SwapChange): NonNullable<SwapChange["vehicleSwapDetail"]> {
  if (change.changeType !== SubscriptionChangeType.VEHICLE_SWAP || !change.vehicleSwapDetail) {
    throw badRequest(
      "VEHICLE_SWAP_CHANGE_REQUIRED",
      "This operation requires a vehicle-swap subscription change."
    );
  }
  return change.vehicleSwapDetail;
}

function assertQuotable(change: SwapChange) {
  requireSwapDetail(change);
  if (change.confirmedQuoteId || change.status === SubscriptionChangeStatus.CUSTOMER_CONFIRMED) {
    throw stateConflict(
      "CONFIRMED_QUOTE_IMMUTABLE",
      "A customer-confirmed quote cannot be replaced."
    );
  }
  const quotableStatuses: SubscriptionChangeStatus[] = [
    SubscriptionChangeStatus.DRAFT,
    SubscriptionChangeStatus.QUOTED
  ];
  if (!quotableStatuses.includes(change.status)) {
    throw stateConflict(
      "SUBSCRIPTION_CHANGE_NOT_QUOTABLE",
      "The change is not in a quotable state."
    );
  }
  if (change.customerConfirmationPublishedAt) {
    throw stateConflict(
      "PUBLISHED_QUOTE_IMMUTABLE",
      "A published vehicle-swap quote cannot be replaced."
    );
  }
}

function assertPublishable(change: SwapChange, now: Date) {
  assertActiveSwapSource(change);
  assertBeforeDeadline(now, change.completionDeadlineAt);
  if (change.status !== SubscriptionChangeStatus.QUOTED || change.customerConfirmationPublishedAt) {
    throw stateConflict(
      "CHANGE_NOT_READY_FOR_CUSTOMER",
      "Only an unpublished quoted change can be published."
    );
  }
  const quote = change.currentQuote;
  if (!quote || quote.status !== SubscriptionChangeQuoteStatus.FORMAL || quote.validUntil <= now) {
    throw stateConflict(
      "CURRENT_QUOTE_NOT_PUBLISHABLE",
      "The current formal quote is missing or expired."
    );
  }
}

function assertExactPublishedQuote(
  change: SwapChange,
  input: ExactVehicleSwapQuoteInput,
  now: Date
) {
  assertActiveSwapSource(change);
  assertBeforeDeadline(now, change.completionDeadlineAt);
  const quote = change.currentQuote;
  const hash =
    quote && isRecord(quote.quoteSnapshot) ? quote.quoteSnapshot.commercialSnapshotHash : undefined;
  if (
    change.status !== SubscriptionChangeStatus.QUOTED ||
    !change.customerConfirmationPublishedAt ||
    !quote ||
    quote.status !== SubscriptionChangeQuoteStatus.FORMAL ||
    quote.validUntil <= now ||
    quote.id !== input.quoteId ||
    quote.revision !== input.revision ||
    hash !== input.commercialSnapshotHash
  ) {
    throw stateConflict(
      "VEHICLE_SWAP_QUOTE_STALE",
      "The published vehicle-swap quote revision or commercial snapshot is stale."
    );
  }
  return quote;
}

async function findSwapChange(client: PrismaService | Prisma.TransactionClient, id: string) {
  const change = await client.subscriptionChangeOrder.findUnique({
    include: swapChangeInclude,
    where: { id }
  });
  if (!change) throw changeNotFound();
  requireSwapDetail(change);
  return change;
}

async function findOwnedSwapChange(
  client: PrismaService | Prisma.TransactionClient,
  id: string,
  customerId: string
) {
  const change = await client.subscriptionChangeOrder.findFirst({
    include: swapChangeInclude,
    where: { id, order: { customerId } }
  });
  if (!change) throw changeNotFound();
  requireSwapDetail(change);
  return change;
}

function assertPermission(actor: RequestUser, permission: PermissionCode) {
  if (!actor.roles.includes("ADMIN") && !actor.permissions.includes(permission)) {
    throw new SubscriptionChangeError(
      "PERMISSION_DENIED",
      "Permission denied.",
      HttpStatus.FORBIDDEN
    );
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
    throw stateConflict(
      "VERSION_CONFLICT",
      "The subscription change was updated by another request."
    );
  }
}

function assertBeforeDeadline(now: Date, deadline: Date) {
  if (now >= deadline) {
    throw stateConflict(
      "SUBSCRIPTION_CHANGE_DEADLINE_PASSED",
      "The subscription-change deadline has passed."
    );
  }
}

async function lockChange(tx: Prisma.TransactionClient, id: string) {
  if (typeof tx.$queryRaw !== "function") return;
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "subscription_change_order" WHERE "id" = ${id}::uuid FOR UPDATE
  `);
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

function adminAudit(
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

function portalAudit(
  action: AuditAction,
  entityId: string,
  customerId: string,
  context: RequestContext,
  before: unknown,
  after: unknown
) {
  return {
    action,
    after: { customerId, value: jsonSafe(after) },
    before: jsonSafe(before),
    entityId,
    entityType: "subscription_change_order",
    ipAddress: context.ipAddress,
    module: "portal_subscription_change",
    userAgent: context.userAgent
  };
}

function commandHash(input: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
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

function errorCode(error: unknown) {
  if (!isRecord(error)) return undefined;
  if (typeof error.code === "string") return error.code;
  if (!("getResponse" in error) || typeof error.getResponse !== "function") return undefined;
  const response = error.getResponse();
  return isRecord(response) && typeof response.code === "string" ? response.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
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

function reservationConflict() {
  return stateConflict(
    "TARGET_VEHICLE_RESERVATION_CONFLICT",
    "The target vehicle could not be reserved for this subscription change."
  );
}

function changeNotFound() {
  return new SubscriptionChangeError(
    "SUBSCRIPTION_CHANGE_NOT_FOUND",
    "Subscription change was not found.",
    HttpStatus.NOT_FOUND
  );
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const serializableTransaction = {
  // AssetOperationsRepository deliberately accepts caller-owned READ COMMITTED
  // transactions and supplies its own row locks for vehicle authority.
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted
};
