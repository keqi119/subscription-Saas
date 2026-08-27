import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  AssetWorkOrderEvidenceAction,
  AssetWorkOrderEvidenceType,
  AssetWorkOrderEventType,
  AssetWorkOrderPriority,
  AssetWorkOrderStatus,
  AssetWorkOrderType,
  AuditAction,
  BillStatus,
  BillType,
  ContractSegmentStatus,
  ContractSegmentType,
  ContractStatus,
  Prisma,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
  VehicleOperationalRestrictionStatus,
  VehicleOperationalRestrictionType,
  VehicleStatus,
  VehicleSubscriptionPeriodEndReason,
  VehicleSubscriptionPeriodStartReason
} from "@prisma/client";

import { AssetFactsService } from "../asset-facts/asset-facts.service";
import { AssetOperationsService } from "../asset-operations/asset-operations.service";
import { VehicleAvailabilityPurpose } from "../asset-operations/vehicle-availability";
import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-number";
import { OrderEntitlementService } from "../order/order-entitlement.service";
import { PrismaService } from "../prisma/prisma.service";
import { shanghaiBusinessDate } from "./renewal-calendar";
import { SubscriptionChangeError } from "./subscription-change.errors";

export const VEHICLE_SWAP_READINESS_FIELDS = [
  "conditionConfirmed",
  "mileageConfirmed",
  "keysConfirmed",
  "registrationConfirmed",
  "accessoriesConfirmed",
  "physicalControlConfirmed"
] as const;

export const VEHICLE_SWAP_ACTIVATION_FAILURE_POINTS = [
  "AFTER_OLD_PERIOD_CLOSED",
  "AFTER_SOURCE_RESTRICTION_CREATED",
  "AFTER_CONTRACT_SEGMENT_SWITCHED",
  "AFTER_ORDER_VEHICLE_SWITCHED",
  "AFTER_VEHICLE_STATUSES_SWITCHED",
  "AFTER_NEW_PERIOD_OPENED",
  "AFTER_FUTURE_ENTITLEMENTS_REPLACED",
  "AFTER_CHANGE_COMPLETED"
] as const;

export type VehicleSwapActivationFailurePoint =
  (typeof VEHICLE_SWAP_ACTIVATION_FAILURE_POINTS)[number];

export const VEHICLE_SWAP_ACTIVATION_FAILURE_INJECTOR = Symbol(
  "VEHICLE_SWAP_ACTIVATION_FAILURE_INJECTOR"
);

export interface VehicleSwapActivationFailureInjector {
  after(point: VehicleSwapActivationFailurePoint): Promise<void> | void;
}

type ReadinessWorkOrder = {
  evidence: ReadonlyArray<{
    action: AssetWorkOrderEvidenceAction;
    contentSha256: string | null;
    evidenceType: AssetWorkOrderEvidenceType;
    fileId: string | null;
    supersededBy: unknown | null;
  }>;
  events: ReadonlyArray<{
    detailSnapshot: unknown;
    eventType: AssetWorkOrderEventType;
    sequence: number;
  }>;
  status: AssetWorkOrderStatus;
  vehicleId: string;
  workOrderType: AssetWorkOrderType;
};

export function evaluateVehicleSwapWorkOrderReadiness(
  workOrder: ReadinessWorkOrder,
  expected: { vehicleId: string; workOrderType: AssetWorkOrderType }
) {
  const blockers: string[] = [];
  if (workOrder.status !== AssetWorkOrderStatus.CLOSED) {
    blockers.push("WORK_ORDER_NOT_CLOSED");
  }
  if (workOrder.workOrderType !== expected.workOrderType) {
    blockers.push("WORK_ORDER_TYPE_MISMATCH");
  }
  if (workOrder.vehicleId !== expected.vehicleId) {
    blockers.push("WORK_ORDER_VEHICLE_MISMATCH");
  }
  const closedEvent = [...workOrder.events]
    .filter(({ eventType }) => eventType === AssetWorkOrderEventType.CLOSED)
    .sort((left, right) => right.sequence - left.sequence)[0];
  const readiness = asRecord(asRecord(closedEvent?.detailSnapshot)?.swapReadiness);
  for (const field of VEHICLE_SWAP_READINESS_FIELDS) {
    if (readiness?.[field] !== true) {
      blockers.push(`HANDOVER_FACT_${field.toUpperCase()}_MISSING`);
    }
  }
  const activeEvidence = workOrder.evidence.filter(isDurableActiveEvidence);
  if (!activeEvidence.some(({ evidenceType }) => CONDITION_EVIDENCE_TYPES.has(evidenceType))) {
    blockers.push("CONDITION_EVIDENCE_MISSING");
  }
  if (
    !activeEvidence.some(({ evidenceType }) => SIGNED_DOCUMENT_EVIDENCE_TYPES.has(evidenceType))
  ) {
    blockers.push("SIGNED_DOCUMENT_EVIDENCE_MISSING");
  }
  return { blockers, ready: blockers.length === 0 };
}

const CONDITION_EVIDENCE_TYPES = new Set<AssetWorkOrderEvidenceType>([
  AssetWorkOrderEvidenceType.INSPECTION_REPORT,
  AssetWorkOrderEvidenceType.PHOTO,
  AssetWorkOrderEvidenceType.VIDEO
]);
const SIGNED_DOCUMENT_EVIDENCE_TYPES = new Set<AssetWorkOrderEvidenceType>([
  AssetWorkOrderEvidenceType.DOCUMENT,
  AssetWorkOrderEvidenceType.SIGNATURE
]);

const workOrderInclude = Prisma.validator<Prisma.AssetWorkOrderInclude>()({
  evidence: { include: { supersededBy: { select: { id: true } } } },
  events: { orderBy: { sequence: "desc" } }
});

const swapActivationInclude = Prisma.validator<Prisma.SubscriptionChangeOrderInclude>()({
  confirmedQuote: true,
  contract: true,
  order: true,
  sourceSegment: true,
  targetSegment: true,
  vehicleSwapDetail: {
    include: {
      inboundWorkOrder: { include: workOrderInclude },
      outboundWorkOrder: { include: workOrderInclude },
      sourceVehicle: {
        include: {
          operationalRestrictions: {
            where: {
              severity: VehicleOperationalRestrictionSeverity.BLOCKING,
              status: VehicleOperationalRestrictionStatus.ACTIVE
            }
          }
        }
      },
      targetVehicle: {
        include: {
          operationalRestrictions: {
            where: {
              severity: VehicleOperationalRestrictionSeverity.BLOCKING,
              status: VehicleOperationalRestrictionStatus.ACTIVE
            }
          }
        }
      }
    }
  }
});

type SwapActivationChange = Prisma.SubscriptionChangeOrderGetPayload<{
  include: typeof swapActivationInclude;
}>;
type SwapDetail = NonNullable<SwapActivationChange["vehicleSwapDetail"]>;

type VehicleSwapProgressResult =
  | {
      blockers: string[];
      changeOrderId: string;
      outcome: "WAITING";
    }
  | {
      changeOrderId: string;
      inboundWorkOrderId: string;
      outcome: "EXECUTING";
      outboundWorkOrderId: string;
      settlementBillIds: string[];
    }
  | {
      changeOrderId: string;
      contractSegmentId: string;
      inboundWorkOrderId: string;
      outcome: "COMPLETED";
      outboundWorkOrderId: string;
      targetSubscriptionPeriodId: string;
    };

@Injectable()
export class SubscriptionVehicleSwapActivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly assetOperations: AssetOperationsService,
    private readonly assetFacts: AssetFactsService,
    private readonly entitlements: OrderEntitlementService,
    @Optional()
    @Inject(VEHICLE_SWAP_ACTIVATION_FAILURE_INJECTOR)
    private readonly failureInjector?: VehicleSwapActivationFailureInjector
  ) {}

  async progress(changeOrderId: string): Promise<VehicleSwapProgressResult> {
    const change = await this.prisma.subscriptionChangeOrder.findUnique({
      select: { changeType: true, status: true },
      where: { id: changeOrderId }
    });
    if (!change || change.changeType !== SubscriptionChangeType.VEHICLE_SWAP) {
      throw new SubscriptionChangeError(
        "VEHICLE_SWAP_CHANGE_NOT_FOUND",
        "The vehicle-swap change was not found.",
        404
      );
    }
    if (change.status === SubscriptionChangeStatus.SCHEDULED) {
      return this.coordinate(changeOrderId);
    }
    return this.activateIfReady(changeOrderId);
  }

  async coordinate(changeOrderId: string): Promise<VehicleSwapProgressResult> {
    return this.prisma.$transaction(
      async (tx) => {
        await lockVehicleSwapRows(tx, changeOrderId);
        const change = await findVehicleSwapChange(tx, changeOrderId);
        const detail = requireSwapDetail(change);
        if (
          (change.status === SubscriptionChangeStatus.EXECUTING ||
            change.status === SubscriptionChangeStatus.COMPLETED) &&
          detail.inboundWorkOrderId &&
          detail.outboundWorkOrderId
        ) {
          if (change.status === SubscriptionChangeStatus.COMPLETED) {
            return completedReplay(tx, change, detail);
          }
          return executingResult(tx, change.id, detail);
        }
        assertCoordinatable(change, detail);
        const now = await readDatabaseClock(tx);
        const context = { actorId: null, permissions: [] as const };
        const inboundSource = workOrderSource(change.id, "inbound");
        const inboundCapability = await this.assetOperations.prepareCallerOwnedTransaction(
          tx,
          inboundSource
        );
        const inbound = await this.assetOperations.createWorkOrderInTransaction(
          tx,
          {
            assetOwnerId: null,
            contractId: change.order.contractId,
            costConfirmationRequired: false,
            customerId: change.order.customerId,
            description: "Vehicle-swap source vehicle return and evidence confirmation.",
            metadata: workOrderMetadata(change, detail, "INBOUND"),
            occurredAt: now,
            orderId: change.orderId,
            priority: AssetWorkOrderPriority.HIGH,
            relatedWorkOrderId: null,
            source: inboundSource,
            vehicleId: detail.sourceVehicleId,
            workOrderType: AssetWorkOrderType.SWAP_INBOUND
          },
          context,
          inboundCapability
        );
        const outboundSource = workOrderSource(change.id, "outbound");
        const outboundCapability = await this.assetOperations.prepareCallerOwnedTransaction(
          tx,
          outboundSource
        );
        const outbound = await this.assetOperations.createWorkOrderInTransaction(
          tx,
          {
            assetOwnerId: null,
            contractId: change.contractId,
            costConfirmationRequired: false,
            customerId: change.order.customerId,
            description: "Vehicle-swap target vehicle delivery and evidence confirmation.",
            metadata: workOrderMetadata(change, detail, "OUTBOUND"),
            occurredAt: now,
            orderId: null,
            priority: AssetWorkOrderPriority.HIGH,
            relatedWorkOrderId: null,
            source: outboundSource,
            vehicleId: detail.targetVehicleId,
            workOrderType: AssetWorkOrderType.SWAP_OUTBOUND
          },
          context,
          outboundCapability
        );
        const settlementBillIds = await ensureSettlementBills(tx, change, now);
        await tx.subscriptionVehicleSwapChangeDetail.update({
          data: {
            inboundWorkOrderId: inbound.workOrder.id,
            outboundWorkOrderId: outbound.workOrder.id
          },
          where: { id: detail.id }
        });
        await tx.subscriptionChangeOrder.update({
          data: {
            failureCode: null,
            failureMessage: null,
            status: SubscriptionChangeStatus.EXECUTING,
            version: { increment: 1 }
          },
          where: { id: change.id }
        });
        await this.auditService.write(
          {
            action: AuditAction.UPDATE,
            after: {
              inboundWorkOrderId: inbound.workOrder.id,
              outboundWorkOrderId: outbound.workOrder.id,
              settlementBillIds,
              status: SubscriptionChangeStatus.EXECUTING
            },
            entityId: change.id,
            entityType: "subscription_vehicle_swap_execution",
            module: "subscription_change"
          },
          tx
        );
        return {
          changeOrderId: change.id,
          inboundWorkOrderId: inbound.workOrder.id,
          outcome: "EXECUTING",
          outboundWorkOrderId: outbound.workOrder.id,
          settlementBillIds
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  async activateIfReady(changeOrderId: string): Promise<VehicleSwapProgressResult> {
    return this.prisma.$transaction(
      async (tx) => {
        await lockVehicleSwapRows(tx, changeOrderId);
        const change = await findVehicleSwapChange(tx, changeOrderId);
        const detail = requireSwapDetail(change);
        if (change.status === SubscriptionChangeStatus.COMPLETED) {
          return completedReplay(tx, change, detail);
        }
        if (change.status !== SubscriptionChangeStatus.EXECUTING) {
          return waiting(change.id, ["CHANGE_NOT_EXECUTING"]);
        }
        const now = await readDatabaseClock(tx);
        const blockers = await this.activationBlockers(tx, change, detail, now);
        if (blockers.length > 0) return waiting(change.id, blockers);

        const inboundWorkOrder = detail.inboundWorkOrder!;
        const outboundWorkOrder = detail.outboundWorkOrder!;
        const sourcePeriod = await tx.vehicleSubscriptionPeriod.findFirst({
          where: {
            endedAt: null,
            orderId: change.orderId,
            vehicleId: detail.sourceVehicleId
          }
        });
        if (!sourcePeriod) return waiting(change.id, ["SOURCE_SUBSCRIPTION_PERIOD_MISSING"]);
        const sourceSegment = change.sourceSegment!;
        const effectiveDate = shanghaiBusinessDate(now);
        if (effectiveDate <= sourceSegment.startDate || effectiveDate > sourceSegment.endDate) {
          return waiting(change.id, ["SOURCE_SEGMENT_DOES_NOT_COVER_SWAP_DATE"]);
        }

        const context = { actorId: null };
        const closeSource = factSource(change.id, "source-period-close");
        const closeCapability = await this.assetFacts.prepareCallerOwnedTransaction(
          tx,
          "subscription",
          "end",
          closeSource
        );
        await this.assetFacts.closeSubscriptionPeriodInTransaction(
          tx,
          {
            confirmedAt: now.toISOString(),
            endedAt: now.toISOString(),
            periodId: sourcePeriod.id,
            reason: VehicleSubscriptionPeriodEndReason.VEHICLE_SWAP,
            snapshot: {
              inboundWorkOrderId: inboundWorkOrder.id,
              sourceVehicleId: detail.sourceVehicleId,
              targetVehicleId: detail.targetVehicleId
            },
            source: closeSource
          },
          context,
          closeCapability
        );
        await this.inject("AFTER_OLD_PERIOD_CLOSED");

        const restrictionSource = workOrderSource(change.id, "source-reconditioning-restriction");
        const restrictionCapability = await this.assetOperations.prepareCallerOwnedTransaction(
          tx,
          restrictionSource
        );
        await this.assetOperations.createWorkOrderRestrictionInTransaction(
          tx,
          {
            conditionsSnapshot: {
              changeOrderId: change.id,
              reason: "VEHICLE_SWAP_RETURN_REQUIRES_RECONDITIONING_RELEASE",
              sourceVehicleId: detail.sourceVehicleId
            },
            evidenceSnapshot: {
              evidenceIds: inboundWorkOrder.evidence.map(({ id }) => id),
              inboundWorkOrderId: inboundWorkOrder.id
            },
            occurredAt: now,
            restrictionType: VehicleOperationalRestrictionType.RECONDITIONING_PENDING,
            scopes: [
              VehicleOperationalRestrictionScope.ALLOCATION,
              VehicleOperationalRestrictionScope.DELIVERY,
              VehicleOperationalRestrictionScope.INVENTORY_RELEASE
            ],
            severity: VehicleOperationalRestrictionSeverity.BLOCKING,
            source: restrictionSource,
            startedAt: now,
            vehicleId: detail.sourceVehicleId,
            workOrderId: inboundWorkOrder.id
          },
          { actorId: null, permissions: [] },
          restrictionCapability
        );
        await this.inject("AFTER_SOURCE_RESTRICTION_CREATED");

        await tx.subscriptionContractSegment.update({
          data: {
            completedAt: now,
            endDate: addUtcDays(effectiveDate, -1),
            status: ContractSegmentStatus.COMPLETED
          },
          where: { id: sourceSegment.id }
        });
        const segment = await tx.subscriptionContractSegment.create({
          data: {
            activatedAt: now,
            contractSnapshot: change.contract!.contractSnapshot as Prisma.InputJsonValue,
            createdBy: null,
            endDate: sourceSegment.endDate,
            energyLimitCount: change.confirmedQuote!.energyLimitCount,
            energyLimitKwh: change.confirmedQuote!.energyLimitKwh,
            mileageLimitKm: change.confirmedQuote!.mileageLimitKm,
            monthlyFeeAmount: change.confirmedQuote!.monthlyFeeAmount,
            orderId: change.orderId,
            overMileageFeeAmount: change.confirmedQuote!.overMileageFeeAmount,
            planSnapshot: change.confirmedQuote!.planSnapshot as Prisma.InputJsonValue,
            productId: change.confirmedQuote!.productId,
            productVersionId: change.confirmedQuote!.productVersionId,
            quoteSnapshot: change.confirmedQuote!.quoteSnapshot as Prisma.InputJsonValue,
            segmentNo: createBusinessNo("SEG", now),
            segmentType: ContractSegmentType.VEHICLE_SWAP,
            sequenceNo: sourceSegment.sequenceNo + 1,
            sourceChangeOrderId: change.id,
            sourceContractId: change.contractId,
            startDate: effectiveDate,
            status: ContractSegmentStatus.ACTIVE,
            subscriptionPlanId: change.confirmedQuote!.subscriptionPlanId
          }
        });
        await this.inject("AFTER_CONTRACT_SEGMENT_SWITCHED");

        const orderUpdated = await tx.subscriptionOrder.updateMany({
          data: { updatedBy: null, vehicleId: detail.targetVehicleId },
          where: {
            deletedAt: null,
            id: change.orderId,
            vehicleId: detail.sourceVehicleId
          }
        });
        assertSingleMutation(orderUpdated.count, "ORDER_VEHICLE_SWITCH_CONFLICT");
        await this.inject("AFTER_ORDER_VEHICLE_SWITCHED");

        const sourceUpdated = await tx.vehicle.updateMany({
          data: { status: VehicleStatus.RETURNED, updatedBy: null },
          where: {
            deletedAt: null,
            id: detail.sourceVehicleId,
            status: { in: [VehicleStatus.LEASED, VehicleStatus.RENTED] }
          }
        });
        const targetUpdated = await tx.vehicle.updateMany({
          data: { status: VehicleStatus.LEASED, updatedBy: null },
          where: {
            deletedAt: null,
            id: detail.targetVehicleId,
            status: VehicleStatus.REVIEW_RESERVED
          }
        });
        assertSingleMutation(sourceUpdated.count, "SOURCE_VEHICLE_STATUS_CONFLICT");
        assertSingleMutation(targetUpdated.count, "TARGET_VEHICLE_STATUS_CONFLICT");
        await this.inject("AFTER_VEHICLE_STATUSES_SWITCHED");

        const openSource = factSource(change.id, "target-period-open");
        const openCapability = await this.assetFacts.prepareCallerOwnedTransaction(
          tx,
          "subscription",
          "start",
          openSource
        );
        const targetPeriod = await this.assetFacts.openSubscriptionPeriodInTransaction(
          tx,
          {
            confirmedAt: now.toISOString(),
            contractId: change.contractId,
            contractSegmentId: segment.id,
            customerId: change.order.customerId,
            orderId: change.orderId,
            reason: VehicleSubscriptionPeriodStartReason.VEHICLE_SWAP,
            snapshot: {
              outboundWorkOrderId: outboundWorkOrder.id,
              sourceVehicleId: detail.sourceVehicleId,
              targetVehicleId: detail.targetVehicleId
            },
            source: openSource,
            startedAt: now.toISOString(),
            vehicleId: detail.targetVehicleId
          },
          context,
          openCapability
        );
        await this.inject("AFTER_NEW_PERIOD_OPENED");

        await this.entitlements.replaceFutureGrantsForVehicleSwap(tx, {
          actorId: null,
          changeOrderId: change.id,
          effectiveDate,
          orderId: change.orderId,
          planSnapshot: change.confirmedQuote!.planSnapshot,
          subscriptionPlanId: change.confirmedQuote!.subscriptionPlanId,
          targetVehicleId: detail.targetVehicleId
        });
        await this.inject("AFTER_FUTURE_ENTITLEMENTS_REPLACED");

        await tx.subscriptionVehicleSwapChangeDetail.update({
          data: { actualSwapAt: now },
          where: { id: detail.id }
        });
        await tx.subscriptionChangeOrder.update({
          data: {
            failureCode: null,
            failureMessage: null,
            status: SubscriptionChangeStatus.COMPLETED,
            version: { increment: 1 }
          },
          where: { id: change.id }
        });
        await this.auditService.write(
          {
            action: AuditAction.UPDATE,
            after: {
              actualSwapAt: now,
              contractSegmentId: segment.id,
              sourcePeriodId: sourcePeriod.id,
              sourceVehicleId: detail.sourceVehicleId,
              status: SubscriptionChangeStatus.COMPLETED,
              targetPeriodId: targetPeriod.id,
              targetVehicleId: detail.targetVehicleId
            },
            entityId: change.id,
            entityType: "subscription_vehicle_swap_activation",
            module: "subscription_change"
          },
          tx
        );
        await this.inject("AFTER_CHANGE_COMPLETED");
        return {
          changeOrderId: change.id,
          contractSegmentId: segment.id,
          inboundWorkOrderId: inboundWorkOrder.id,
          outcome: "COMPLETED",
          outboundWorkOrderId: outboundWorkOrder.id,
          targetSubscriptionPeriodId: targetPeriod.id
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  async markManualTakeover(changeOrderId: string, failure: { code: string; message: string }) {
    return this.prisma.$transaction(
      async (tx) => {
        await lockVehicleSwapRows(tx, changeOrderId);
        const change = await findVehicleSwapChange(tx, changeOrderId);
        if (
          change.status !== SubscriptionChangeStatus.SCHEDULED &&
          change.status !== SubscriptionChangeStatus.EXECUTING
        ) {
          return { updated: false };
        }
        await tx.subscriptionChangeOrder.update({
          data: {
            failureCode: failure.code,
            failureMessage: failure.message,
            manualTakeoverAt: await readDatabaseClock(tx),
            manualTakeoverReason: "Vehicle-swap orchestration requires governed intervention.",
            status: SubscriptionChangeStatus.MANUAL_TAKEOVER,
            version: { increment: 1 }
          },
          where: { id: change.id }
        });
        await this.auditService.write(
          {
            action: AuditAction.UPDATE,
            after: {
              failureCode: failure.code,
              failureMessage: failure.message,
              status: SubscriptionChangeStatus.MANUAL_TAKEOVER
            },
            entityId: change.id,
            entityType: "subscription_vehicle_swap_execution",
            module: "subscription_change"
          },
          tx
        );
        return { updated: true };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  private async activationBlockers(
    tx: Prisma.TransactionClient,
    change: SwapActivationChange,
    detail: SwapDetail,
    now: Date
  ) {
    const blockers: string[] = [];
    if (
      !change.contract ||
      change.contract.status !== ContractStatus.ARCHIVED ||
      !change.contract.fileId
    ) {
      blockers.push("SIGNED_SUPPLEMENT_NOT_ARCHIVED");
    }
    if (
      !change.confirmedQuote ||
      change.confirmedQuote.status !== SubscriptionChangeQuoteStatus.CUSTOMER_CONFIRMED
    ) {
      blockers.push("CONFIRMED_QUOTE_MISSING");
    }
    if (!change.sourceSegment || change.sourceSegment.status !== ContractSegmentStatus.ACTIVE) {
      blockers.push("SOURCE_SEGMENT_NOT_ACTIVE");
    }
    if (change.order.vehicleId !== detail.sourceVehicleId) {
      blockers.push("ORDER_SOURCE_VEHICLE_MISMATCH");
    }
    if (detail.targetVehicle.status !== VehicleStatus.REVIEW_RESERVED) {
      blockers.push("TARGET_RESERVATION_INVALID");
    } else {
      try {
        await this.assetOperations.assertVehicleAvailable(
          tx,
          detail.targetVehicleId,
          VehicleAvailabilityPurpose.DELIVERY,
          now,
          VehicleStatus.RESERVED
        );
      } catch {
        blockers.push("TARGET_VEHICLE_NOT_DELIVERABLE");
      }
    }
    if (
      detail.sourceVehicle.operationalRestrictions.length > 0 ||
      detail.targetVehicle.operationalRestrictions.length > 0
    ) {
      blockers.push("BLOCKING_VEHICLE_RESTRICTION_ACTIVE");
    }
    if (now < detail.plannedSwapAt) blockers.push("PLANNED_SWAP_TIME_NOT_REACHED");
    if (!detail.inboundWorkOrder) {
      blockers.push("INBOUND_WORK_ORDER_MISSING");
    } else {
      blockers.push(
        ...evaluateVehicleSwapWorkOrderReadiness(detail.inboundWorkOrder, {
          vehicleId: detail.sourceVehicleId,
          workOrderType: AssetWorkOrderType.SWAP_INBOUND
        }).blockers.map((blocker) => `INBOUND_${blocker}`)
      );
    }
    if (!detail.outboundWorkOrder) {
      blockers.push("OUTBOUND_WORK_ORDER_MISSING");
    } else {
      blockers.push(
        ...evaluateVehicleSwapWorkOrderReadiness(detail.outboundWorkOrder, {
          vehicleId: detail.targetVehicleId,
          workOrderType: AssetWorkOrderType.SWAP_OUTBOUND
        }).blockers.map((blocker) => `OUTBOUND_${blocker}`)
      );
    }
    const depositDelta = positiveDepositDelta(change);
    if (depositDelta > 0n) {
      const bill = await tx.receivableBill.findUnique({
        where: { sourceKey: depositDifferenceSourceKey(change.id) }
      });
      if (
        !bill ||
        bill.amount !== depositDelta ||
        bill.billStatus !== BillStatus.PAID ||
        bill.remainingAmount !== 0n
      ) {
        blockers.push("DEPOSIT_DIFFERENCE_NOT_SETTLED");
      }
    }
    const priceDelta = positiveMonthlyFeeDelta(change);
    if (priceDelta > 0n) {
      const bill = await tx.receivableBill.findUnique({
        where: { sourceKey: priceDifferenceSourceKey(change.id) }
      });
      if (
        !bill ||
        bill.amount !== priceDelta ||
        bill.billStatus !== BillStatus.PAID ||
        bill.remainingAmount !== 0n
      ) {
        blockers.push("PRICE_DIFFERENCE_NOT_SETTLED");
      }
    }
    return [...new Set(blockers)];
  }

  private async inject(point: VehicleSwapActivationFailurePoint) {
    await this.failureInjector?.after(point);
  }
}

async function findVehicleSwapChange(tx: Prisma.TransactionClient, changeOrderId: string) {
  const change = await tx.subscriptionChangeOrder.findUnique({
    include: swapActivationInclude,
    where: { id: changeOrderId }
  });
  if (!change || change.changeType !== SubscriptionChangeType.VEHICLE_SWAP) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_CHANGE_NOT_FOUND",
      "The vehicle-swap change was not found.",
      404
    );
  }
  return change;
}

function requireSwapDetail(change: SwapActivationChange): SwapDetail {
  if (!change.vehicleSwapDetail) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_DETAIL_MISSING",
      "The vehicle-swap detail is missing."
    );
  }
  return change.vehicleSwapDetail;
}

function assertCoordinatable(change: SwapActivationChange, detail: SwapDetail) {
  if (
    change.status !== SubscriptionChangeStatus.SCHEDULED ||
    !change.contract ||
    change.contract.status !== ContractStatus.ARCHIVED ||
    !change.contract.fileId ||
    !change.confirmedQuote ||
    change.confirmedQuote.status !== SubscriptionChangeQuoteStatus.CUSTOMER_CONFIRMED ||
    !change.sourceSegment ||
    change.order.vehicleId !== detail.sourceVehicleId ||
    detail.targetVehicle.status !== VehicleStatus.REVIEW_RESERVED
  ) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_COORDINATION_STATE_INVALID",
      "The vehicle-swap work orders cannot be coordinated from the current state."
    );
  }
}

async function ensureSettlementBills(
  tx: Prisma.TransactionClient,
  change: SwapActivationChange,
  now: Date
) {
  const bills: string[] = [];
  const depositDelta = positiveDepositDelta(change);
  if (depositDelta > 0n) {
    bills.push(
      await ensureSettlementBill(tx, change, now, {
        amount: depositDelta,
        billType: BillType.DEPOSIT,
        label: "deposit difference",
        sourceKey: depositDifferenceSourceKey(change.id)
      })
    );
  }
  const priceDelta = positiveMonthlyFeeDelta(change);
  if (priceDelta > 0n) {
    bills.push(
      await ensureSettlementBill(tx, change, now, {
        amount: priceDelta,
        billType: BillType.OTHER,
        label: "first-cycle price difference",
        sourceKey: priceDifferenceSourceKey(change.id)
      })
    );
  }
  return bills.sort();
}

async function ensureSettlementBill(
  tx: Prisma.TransactionClient,
  change: SwapActivationChange,
  now: Date,
  input: { amount: bigint; billType: BillType; label: string; sourceKey: string }
) {
  const { amount, sourceKey } = input;
  const existing = await tx.receivableBill.findUnique({ where: { sourceKey } });
  if (existing) {
    if (
      existing.orderId !== change.orderId ||
      existing.customerId !== change.order.customerId ||
      existing.amount !== amount
    ) {
      throw new SubscriptionChangeError(
        "VEHICLE_SWAP_SETTLEMENT_BILL_CONFLICT",
        `The vehicle-swap ${input.label} bill conflicts with the confirmed quote.`
      );
    }
    return existing.id;
  }
  const bill = await tx.receivableBill.create({
    data: {
      amount,
      billNo: createBusinessNo("BILL", now),
      billStatus: BillStatus.PENDING,
      billType: input.billType,
      customerId: change.order.customerId,
      dueDate: change.vehicleSwapDetail!.plannedSwapAt,
      orderId: change.orderId,
      paidAmount: 0n,
      remainingAmount: amount,
      remark: `Vehicle-swap ${input.label}`,
      snapshot: {
        changeOrderId: change.id,
        confirmedQuoteId: change.confirmedQuoteId,
        source: `VEHICLE_SWAP_${input.label.toUpperCase().replaceAll(" ", "_")}`
      },
      sourceKey
    }
  });
  return bill.id;
}

function positiveDepositDelta(change: SwapActivationChange) {
  const currentDeposit = change.order.finalDepositAmount ?? change.order.depositAmount;
  const delta = (change.confirmedQuote?.depositAmount ?? 0n) - currentDeposit;
  return delta > 0n ? delta : 0n;
}

function positiveMonthlyFeeDelta(change: SwapActivationChange) {
  const delta =
    (change.confirmedQuote?.monthlyFeeAmount ?? 0n) -
    (change.sourceSegment?.monthlyFeeAmount ?? 0n);
  return delta > 0n ? delta : 0n;
}

function depositDifferenceSourceKey(changeOrderId: string) {
  return `vehicle-swap:${changeOrderId}:deposit-difference`;
}

function priceDifferenceSourceKey(changeOrderId: string) {
  return `vehicle-swap:${changeOrderId}:first-cycle-price-difference`;
}

function workOrderSource(changeOrderId: string, key: string) {
  return { id: changeOrderId, key, type: "SUBSCRIPTION_VEHICLE_SWAP" } as const;
}

function factSource(changeOrderId: string, key: string) {
  return { id: changeOrderId, key, type: "SUBSCRIPTION_VEHICLE_SWAP" };
}

function workOrderMetadata(
  change: SwapActivationChange,
  detail: SwapDetail,
  direction: "INBOUND" | "OUTBOUND"
): Prisma.InputJsonObject {
  return {
    changeOrderId: change.id,
    changeNo: change.changeNo,
    commercialSnapshotHash: detail.commercialSnapshotHash,
    direction,
    orderId: change.orderId,
    plannedSwapAt: detail.plannedSwapAt.toISOString(),
    requiredConfirmations: [...VEHICLE_SWAP_READINESS_FIELDS],
    sourceVehicleId: detail.sourceVehicleId,
    supplementContractId: change.contractId,
    targetVehicleId: detail.targetVehicleId
  };
}

async function executingResult(
  tx: Prisma.TransactionClient,
  changeOrderId: string,
  detail: SwapDetail
): Promise<VehicleSwapProgressResult> {
  const bills = await tx.receivableBill.findMany({
    select: { id: true },
    where: {
      sourceKey: {
        in: [depositDifferenceSourceKey(changeOrderId), priceDifferenceSourceKey(changeOrderId)]
      }
    }
  });
  return {
    changeOrderId,
    inboundWorkOrderId: detail.inboundWorkOrderId!,
    outcome: "EXECUTING",
    outboundWorkOrderId: detail.outboundWorkOrderId!,
    settlementBillIds: bills.map(({ id }) => id).sort()
  };
}

async function completedReplay(
  tx: Prisma.TransactionClient,
  change: SwapActivationChange,
  detail: SwapDetail
): Promise<VehicleSwapProgressResult> {
  if (!change.targetSegment || !detail.inboundWorkOrderId || !detail.outboundWorkOrderId) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_COMPLETION_FACTS_MISSING",
      "The completed vehicle swap is missing authoritative completion facts."
    );
  }
  const targetPeriod = await tx.vehicleSubscriptionPeriod.findFirst({
    where: {
      contractSegmentId: change.targetSegment.id,
      orderId: change.orderId,
      vehicleId: detail.targetVehicleId
    }
  });
  if (!targetPeriod) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_COMPLETION_FACTS_MISSING",
      "The completed vehicle swap is missing its target subscription period."
    );
  }
  return {
    changeOrderId: change.id,
    contractSegmentId: change.targetSegment.id,
    inboundWorkOrderId: detail.inboundWorkOrderId,
    outcome: "COMPLETED",
    outboundWorkOrderId: detail.outboundWorkOrderId,
    targetSubscriptionPeriodId: targetPeriod.id
  };
}

function waiting(changeOrderId: string, blockers: string[]): VehicleSwapProgressResult {
  return { blockers, changeOrderId, outcome: "WAITING" };
}

async function lockVehicleSwapRows(tx: Prisma.TransactionClient, changeOrderId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "subscription_change_order"
    WHERE "id" = ${changeOrderId}::uuid
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "subscription_vehicle_swap_change_detail"
    WHERE "change_order_id" = ${changeOrderId}::uuid
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT subscription_order."id"
    FROM "subscription_order" subscription_order
    JOIN "subscription_change_order" change_order
      ON change_order."order_id" = subscription_order."id"
    WHERE change_order."id" = ${changeOrderId}::uuid
    FOR UPDATE OF subscription_order
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT vehicle."id"
    FROM "vehicle" vehicle
    JOIN "subscription_vehicle_swap_change_detail" detail
      ON vehicle."id" = detail."source_vehicle_id"
      OR vehicle."id" = detail."target_vehicle_id"
    WHERE detail."change_order_id" = ${changeOrderId}::uuid
    ORDER BY vehicle."id"
    FOR UPDATE OF vehicle
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT segment."id"
    FROM "subscription_contract_segment" segment
    WHERE segment."id" = (
      SELECT "source_segment_id"
      FROM "subscription_change_order"
      WHERE "id" = ${changeOrderId}::uuid
    )
       OR segment."source_change_order_id" = ${changeOrderId}::uuid
    ORDER BY segment."sequence_no"
    FOR UPDATE OF segment
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT work_order."id"
    FROM "asset_work_order" work_order
    JOIN "subscription_vehicle_swap_change_detail" detail
      ON work_order."id" = detail."inbound_work_order_id"
      OR work_order."id" = detail."outbound_work_order_id"
    WHERE detail."change_order_id" = ${changeOrderId}::uuid
    ORDER BY work_order."id"
    FOR UPDATE OF work_order
  `);
}

async function readDatabaseClock(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT transaction_timestamp() AS "now"
  `);
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_DATABASE_CLOCK_UNAVAILABLE",
      "The database decision time is unavailable."
    );
  }
  return now;
}

function isDurableActiveEvidence(evidence: ReadinessWorkOrder["evidence"][number]) {
  return (
    evidence.action !== AssetWorkOrderEvidenceAction.REMOVE &&
    evidence.supersededBy === null &&
    Boolean(evidence.fileId) &&
    typeof evidence.contentSha256 === "string" &&
    /^[a-f\d]{64}$/i.test(evidence.contentSha256)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertSingleMutation(count: number, code: string) {
  if (count !== 1) {
    throw new SubscriptionChangeError(
      code,
      "The vehicle-swap aggregate changed concurrently. Review the current state and retry."
    );
  }
}

function addUtcDays(value: Date, days: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}
