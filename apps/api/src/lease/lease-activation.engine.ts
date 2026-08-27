import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional
} from "@nestjs/common";
import {
  AuditAction,
  BillStatus,
  BillType,
  ContractStatus,
  DeliveryStatus,
  EntitlementAccountStatus,
  Lease,
  LeaseStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  SubscriptionJourneyStatus,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus,
  VehicleSubscriptionPeriodStartReason,
  VehicleHandoverOpsReviewStatus,
  VehicleHandoverType,
  VehicleHandoverWorkOrderStatus,
  VehicleInspectionStatus,
  VehicleMileageSourceType,
  VehicleStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { AssetFactsService } from "../asset-facts/asset-facts.service";
import { AssetOperationsService } from "../asset-operations/asset-operations.service";
import { VehicleAvailabilityPurpose } from "../asset-operations/vehicle-availability";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { BillingAutomationService } from "../billing-automation/billing-automation.service";
import { resolveVehicleInsuranceCoverage } from "../common/vehicle-insurance-coverage";
import {
  DeliveryEvidenceReadiness,
  DeliveryEvidenceService
} from "../delivery-evidence/delivery-evidence.service";
import {
  findDeliveryHandoverForConfirmation,
  isDeliveryHandoverArchived,
  isDeliveryHandoverSigned
} from "../delivery-handover/delivery-handover.service";
import { FinanceService } from "../finance/finance.service";
import { HandoverWorkOrderService } from "../handover-work-order/handover-work-order.service";
import { MileageReviewService } from "../mileage-review/mileage-review.service";
import { OrderEntitlementService } from "../order/order-entitlement.service";
import { lockDeliveryConfirmationGateRows } from "../order/delivery-confirmation-gate-lock";
import { PrismaService } from "../prisma/prisma.service";
import { SubscriptionJourneyRepository } from "../subscription-journey/subscription-journey.repository";
import { ContractSegmentService } from "../subscription-change/contract-segment.service";
import { VehicleMileageService } from "../vehicle-mileage/vehicle-mileage.service";
import { activateLeaseRecord } from "./lease-activation.persistence";
import { deriveOriginalSubscriptionPeriod } from "./subscription-performance-calendar";
import {
  LEASE_ACTIVATION_CLOCK,
  LeaseActivationClock,
  LeaseActivationCondition,
  LeaseActivationEvaluation,
  LeaseStatusView,
  SubscriptionActivationResult
} from "./lease-activation.types";

const LEASE_ACTIVATION_REJECTED_REASON = "MISSING_LEASE_ACTIVATION_CONDITIONS";

type Tx = Prisma.TransactionClient;

type AuthorityFacts = Awaited<ReturnType<LeaseActivationEngine["readAuthorityFacts"]>>;

@Injectable()
export class LeaseActivationEngine {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
    private readonly assetFactsService: AssetFactsService,
    private readonly contractSegmentService: ContractSegmentService,
    @Optional()
    @Inject(LEASE_ACTIVATION_CLOCK)
    private readonly clock: LeaseActivationClock = () => new Date(),
    @Optional()
    private readonly deliveryEvidenceService?: DeliveryEvidenceService,
    @Optional()
    private readonly billingAutomationService?: BillingAutomationService,
    @Optional()
    private readonly financeService?: FinanceService,
    @Optional()
    private readonly handoverWorkOrderService?: HandoverWorkOrderService,
    @Optional()
    private readonly vehicleMileageService?: VehicleMileageService,
    @Optional()
    private readonly mileageReviewService?: MileageReviewService,
    @Optional()
    private readonly orderEntitlementService?: OrderEntitlementService,
    @Optional()
    private readonly journeyRepository?: SubscriptionJourneyRepository,
    @Optional() private readonly assetOperationsService?: AssetOperationsService
  ) {}

  async evaluate(orderId: string): Promise<LeaseActivationEvaluation> {
    return this.prisma.$transaction((tx) => this.evaluateInTransaction(tx, orderId));
  }

  async evaluateInTransaction(tx: Tx, orderId: string): Promise<LeaseActivationEvaluation> {
    await lockDeliveryConfirmationGateRows(tx, orderId);
    const facts = await this.readAuthorityFacts(tx, orderId);
    return this.evaluateFacts(facts);
  }

  async canActivate(orderId: string): Promise<boolean> {
    return (await this.evaluate(orderId)).canActivate;
  }

  async activateFromAuthoritativeHandover(
    tx: Tx,
    input: { actorId: string; journeyId?: string; orderId: string }
  ): Promise<SubscriptionActivationResult> {
    await lockDeliveryConfirmationGateRows(tx, input.orderId);
    const facts = await this.readAuthorityFacts(tx, input.orderId);
    if (!isCompletedActivationReplay(facts)) {
      const vehicleId = facts.order.vehicleId;
      if (vehicleId) {
        await this.assetOperationsService?.assertVehicleAvailable(
          tx,
          vehicleId,
          VehicleAvailabilityPurpose.DELIVERY,
          new Date()
        );
      }
    }
    const evaluation = this.evaluateFacts(facts);
    if (!evaluation.canActivate) {
      throw new BadRequestException(evaluation);
    }
    if (!facts.delivery || !facts.handover || !facts.workOrder) {
      throw new BadRequestException({
        canActivate: false,
        missingConditions: ["DELIVERY_NOT_READY"],
        reason: LEASE_ACTIVATION_REJECTED_REASON
      });
    }
    const journey = facts.order.subscriptionJourney;
    if (input.journeyId && (!journey || journey.id !== input.journeyId)) {
      throw new BadRequestException("JOURNEY_ORDER_MISMATCH");
    }

    const activatedAt = facts.handover.completedAt!;
    const { endDate, startDate } = deriveOriginalSubscriptionPeriod(
      activatedAt,
      facts.order.periodMonths
    );
    const mileageKm = facts.workOrder.handoverMileageKm!;
    const actorId = input.actorId;
    const mileageService = this.requireDependency(
      this.vehicleMileageService,
      "Vehicle mileage service"
    );
    const mileageReviewService = this.requireDependency(
      this.mileageReviewService,
      "Mileage review service"
    );
    const billingAutomationService = this.requireDependency(
      this.billingAutomationService,
      "Billing automation service"
    );
    const entitlementService = this.requireDependency(
      this.orderEntitlementService,
      "Order entitlement service"
    );

    const deliveryReading = await mileageService.appendConfirmedReading(tx, {
      confirmedBy: actorId,
      evidenceSnapshot: {
        handoverId: facts.handover.id,
        manifestHash: facts.handover.manifestHash,
        source: "APPROVED_STAGE2_HANDOVER",
        workOrderId: facts.workOrder.id
      },
      mileageKm,
      orderId: input.orderId,
      recordedAt: activatedAt,
      sourceRecordId: facts.delivery.id,
      sourceType: VehicleMileageSourceType.DELIVERY_BASELINE,
      vehicleId: facts.order.vehicleId!
    });
    await mileageReviewService.createFirstReview(tx, {
      actualDeliveryAt: activatedAt,
      actorId,
      deliveryReadingId: deliveryReading.id,
      orderId: input.orderId,
      vehicleId: facts.order.vehicleId!
    });

    const delivery = await tx.vehicleDelivery.update({
      data: {
        deliveredAt: activatedAt,
        deliveryStatus: DeliveryStatus.DELIVERED,
        handoverMileageKm: mileageKm,
        updatedBy: actorId
      },
      where: { id: facts.delivery.id }
    });
    const order = await tx.subscriptionOrder.update({
      data: {
        actualDeliveryAt: activatedAt,
        endDate,
        orderStatus: OrderStatus.ACTIVE,
        startDate,
        updatedBy: actorId
      },
      where: { id: input.orderId }
    });
    const vehicle = await tx.vehicle.update({
      data: { status: VehicleStatus.LEASED, updatedBy: actorId },
      where: { id: facts.order.vehicleId! }
    });
    const { existing: leaseBefore, lease } = await activateLeaseRecord(tx, {
      activatedAt,
      actorId,
      orderId: input.orderId
    });
    const baseSegment = await this.contractSegmentService.ensureBaseSegmentInTransaction(
      tx,
      order.id,
      actorId
    );
    const subscriptionPeriodSource = {
      id: facts.delivery.id,
      key: `authoritative-delivery:${facts.delivery.id}:subscription-open`,
      type: "VEHICLE_DELIVERY"
    } as const;
    const subscriptionPeriodCapability = await this.assetFactsService.prepareCallerOwnedTransaction(
      tx,
      "subscription",
      "start",
      subscriptionPeriodSource
    );
    const subscriptionPeriod = await this.assetFactsService.openSubscriptionPeriodInTransaction(
      tx,
      {
        confirmedAt: activatedAt.toISOString(),
        contractId: order.contractId,
        contractSegmentId: baseSegment.id,
        customerId: order.customerId,
        orderId: order.id,
        reason: VehicleSubscriptionPeriodStartReason.DELIVERY_CONFIRMED,
        snapshot: {
          deliveryId: facts.delivery.id,
          handoverId: facts.handover.id
        },
        source: subscriptionPeriodSource,
        startedAt: activatedAt.toISOString(),
        vehicleId: order.vehicleId!
      },
      { actorId },
      subscriptionPeriodCapability
    );
    await billingAutomationService.ensureActiveSchedule(tx, input.orderId, activatedAt);
    await entitlementService.ensureInitialEntitlements(tx, input.orderId, actorId);
    await tx.orderEntitlementAccount.updateMany({
      data: {
        accountStatus: EntitlementAccountStatus.ACTIVE,
        updatedBy: actorId
      },
      where: {
        deletedAt: null,
        orderId: input.orderId
      }
    });

    if (journey) {
      const activationStep = journey.steps.find(
        ({ code }) => code === SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION
      );
      if (!activationStep || !this.journeyRepository) {
        throw new Error("Subscription journey activation is unavailable.");
      }
      if (journey.status !== SubscriptionJourneyStatus.COMPLETED) {
        if (
          journey.currentStepCode !== SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION ||
          journey.currentStepStatus === SubscriptionJourneyStepStatus.COMPLETED
        ) {
          throw new BadRequestException("JOURNEY_ACTIVATION_STEP_MISMATCH");
        }
        await this.journeyRepository.completeActivation(tx, {
          expectedVersion: journey.version,
          journeyId: journey.id,
          payload: {
            deliveryId: delivery.id,
            leaseId: lease.id,
            orderId: order.id,
            vehicleId: vehicle.id
          },
          stepId: activationStep.id
        });
      }
    }

    await this.auditService.write(
      {
        action: leaseBefore ? AuditAction.UPDATE : AuditAction.CREATE,
        after: {
          activatedAt: activatedAt.toISOString(),
          baseSegmentId: baseSegment.id,
          deliveryId: delivery.id,
          endDate: endDate.toISOString(),
          leaseId: lease.id,
          orderId: order.id,
          source: "AUTHORITATIVE_STAGE2_HANDOVER",
          startDate: startDate.toISOString(),
          subscriptionPeriodId: subscriptionPeriod.id,
          vehicleId: vehicle.id
        },
        before: leaseBefore
          ? {
              activatedAt: leaseBefore.activatedAt?.toISOString() ?? null,
              leaseId: leaseBefore.id,
              status: leaseBefore.status
            }
          : undefined,
        entityId: lease.id,
        entityType: "subscription_activation",
        module: "lease",
        operatorId: actorId
      },
      tx
    );

    return {
      activatedAt: activatedAt.toISOString(),
      baseSegmentId: baseSegment.id,
      deliveryId: delivery.id,
      deliveryStatus: "DELIVERED",
      endDate: endDate.toISOString(),
      journeyStatus: journey ? "COMPLETED" : null,
      leaseId: lease.id,
      leaseStatus: "ACTIVE",
      orderId: order.id,
      orderStatus: "ACTIVE",
      startDate: startDate.toISOString(),
      subscriptionPeriodId: subscriptionPeriod.id,
      vehicleId: vehicle.id,
      vehicleStatus: "LEASED"
    };
  }

  async activate(orderId: string, user?: RequestUser, context?: RequestContext) {
    void context;
    const actorId = user?.id;
    if (!actorId) {
      throw new BadRequestException("ACTIVATION_ACTOR_REQUIRED");
    }
    const result = await this.prisma.$transaction((tx) =>
      this.activateFromAuthoritativeHandover(tx, { actorId, orderId })
    );
    const lease = await this.prisma.lease.findUnique({
      where: { id: result.leaseId }
    });
    if (!lease) throw new NotFoundException("Lease not found.");
    return toLeaseView(lease);
  }

  async getStatus(orderId: string): Promise<LeaseStatusView> {
    const [result, lease] = await Promise.all([
      this.evaluate(orderId),
      this.prisma.lease.findUnique({ where: { orderId } })
    ]);
    if (lease && !lease.deletedAt) {
      return {
        activatedAt: toIsoDateTime(lease.activatedAt),
        canActivate: result.canActivate,
        leaseId: lease.id,
        missingConditions: result.missingConditions,
        orderId,
        status: lease.status,
        warningConditions: result.warningConditions
      };
    }
    return {
      activatedAt: null,
      canActivate: result.canActivate,
      leaseId: null,
      missingConditions: result.missingConditions,
      orderId,
      status: result.canActivate ? LeaseStatus.READY : LeaseStatus.NOT_ACTIVE,
      warningConditions: result.warningConditions
    };
  }

  async readAuthorityFacts(tx: Tx, orderId: string) {
    const order = await tx.subscriptionOrder.findUnique({
      include: {
        contract: true,
        subscriptionJourney: { include: { steps: true } },
        vehicle: { include: { insurancePolicies: true } }
      },
      where: { id: orderId }
    });
    if (!order || order.deletedAt) {
      throw new NotFoundException("Order not found.");
    }
    const [delivery, handover, inspection, bills] = await Promise.all([
      tx.vehicleDelivery.findUnique({ where: { orderId } }),
      findDeliveryHandoverForConfirmation(tx, orderId),
      tx.vehicleInspection.findUnique({ where: { orderId } }),
      tx.receivableBill.findMany({
        include: {
          writeOffs: {
            include: { payment: { select: { paymentStatus: true } } },
            where: { deletedAt: null }
          }
        },
        orderBy: { createdAt: "asc" },
        where: {
          billStatus: { not: BillStatus.CANCELLED },
          billType: { in: [BillType.DEPOSIT, BillType.FIRST_MONTHLY_FEE] },
          deletedAt: null,
          orderId
        }
      })
    ]);
    const [contractFile, workOrder, evidenceReadiness, settlement, handoverAuthorityValid] =
      await Promise.all([
        order.contract?.fileId
          ? tx.fileObject.findUnique({ where: { id: order.contract.fileId } })
          : null,
        tx.vehicleHandoverWorkOrder.findFirst({
          orderBy: { createdAt: "desc" },
          where: {
            handoverType: VehicleHandoverType.DELIVERY_OUTBOUND,
            orderId
          }
        }),
        this.getDeliveryEvidenceService().validateEvidenceReadyForDeliveryConfirmation(
          orderId,
          handover?.id ?? null,
          undefined,
          tx
        ),
        this.financeService
          ? this.financeService.evaluateInitialBillSettlement(tx, orderId)
          : Promise.resolve({
              paid: true,
              remainingAmount: 0n
            }),
        this.validateHandoverAuthority(tx, orderId, handover?.id ?? null)
      ]);
    return {
      bills,
      contractFile,
      delivery,
      evidenceReadiness,
      handover,
      handoverAuthorityValid,
      inspection,
      order,
      settlement,
      workOrder
    };
  }

  private evaluateFacts(facts: AuthorityFacts): LeaseActivationEvaluation {
    const missingConditions: LeaseActivationCondition[] = [];
    const { order, delivery, handover, inspection, workOrder } = facts;
    if (
      !order.contract ||
      order.contract.deletedAt ||
      order.contract.status !== ContractStatus.ARCHIVED ||
      !order.contract.archivedAt ||
      !order.contract.fileId ||
      !facts.contractFile
    ) {
      pushUnique(missingConditions, "CONTRACT_ARCHIVED_ARTIFACT_MISSING");
    }

    const requiredDeposit = order.finalDepositAmount ?? order.depositAmount;
    if (
      requiredDeposit > 0n &&
      !isAuthoritativelySettled(facts.bills, BillType.DEPOSIT, requiredDeposit)
    ) {
      pushUnique(missingConditions, "DEPOSIT_PAYMENT_MISSING");
    }
    if (
      !isAuthoritativelySettled(facts.bills, BillType.FIRST_MONTHLY_FEE, order.monthlyFeeAmount) ||
      !facts.settlement.paid
    ) {
      pushUnique(missingConditions, "FIRST_RENT_PAYMENT_MISSING");
    }

    const retryingCompletedActivation =
      order.orderStatus === OrderStatus.ACTIVE &&
      delivery?.deliveryStatus === DeliveryStatus.DELIVERED &&
      order.vehicle?.status === VehicleStatus.LEASED;
    if (
      !delivery ||
      delivery.deletedAt ||
      (delivery.deliveryStatus !== DeliveryStatus.READY &&
        delivery.deliveryStatus !== DeliveryStatus.DELIVERED)
    ) {
      pushUnique(missingConditions, "DELIVERY_NOT_READY");
    }
    if (
      delivery &&
      (!delivery.vehiclePreparedConfirmed ||
        !delivery.vehiclePhotosConfirmed ||
        !delivery.customerIdentityConfirmed ||
        !delivery.handoverDocumentsConfirmed)
    ) {
      pushUnique(missingConditions, "DELIVERY_CHECKLIST_INCOMPLETE");
    }
    if (
      !handover ||
      !isDeliveryHandoverSigned(handover) ||
      !isDeliveryHandoverArchived(handover) ||
      !handover.archivedAt ||
      !handover.signedDocumentFileId ||
      !handover.signedDocumentFile ||
      !handover.handoverContract ||
      handover.handoverContract.status !== ContractStatus.ARCHIVED ||
      handover.handoverContract.fileId !== handover.signedDocumentFileId
    ) {
      pushUnique(missingConditions, "HANDOVER_ARCHIVED_ARTIFACT_MISSING");
    }
    appendEvidenceMissingConditions(missingConditions, facts.evidenceReadiness);
    if (
      !workOrder ||
      !facts.handoverAuthorityValid ||
      workOrder.status !== VehicleHandoverWorkOrderStatus.OPS_REVIEWED ||
      workOrder.opsReviewStatus !== VehicleHandoverOpsReviewStatus.APPROVED ||
      !sameManifest(workOrder.metadata, handover?.manifestHash)
    ) {
      pushUnique(missingConditions, "HANDOVER_EVIDENCE_NOT_APPROVED");
    }
    if (!workOrder || workOrder.handoverMileageKm === null) {
      pushUnique(missingConditions, "DELIVERY_MILEAGE_MISSING");
    }
    const vehicleId = order.vehicleId;
    if (
      !vehicleId ||
      !order.vehicle ||
      order.vehicle.deletedAt ||
      delivery?.vehicleId !== vehicleId ||
      handover?.vehicleDeliveryId !== delivery?.id ||
      workOrder?.vehicleDeliveryId !== delivery?.id ||
      workOrder?.handoverId !== handover?.id
    ) {
      pushUnique(missingConditions, "VEHICLE_MISMATCH");
    }
    if (
      order.vehicle &&
      order.vehicle.status !== VehicleStatus.RESERVED &&
      !retryingCompletedActivation
    ) {
      pushUnique(missingConditions, "VEHICLE_NOT_RESERVED");
    }
    const deliveryAt = handover?.completedAt ?? null;
    if (
      !deliveryAt ||
      !order.vehicle ||
      !resolveVehicleInsuranceCoverage(order.vehicle.insurancePolicies, deliveryAt).covered
    ) {
      pushUnique(missingConditions, "INSURANCE_NOT_COVERED");
    }
    if (
      !inspection ||
      inspection.deletedAt ||
      inspection.status !== VehicleInspectionStatus.PASSED
    ) {
      pushUnique(missingConditions, "INSPECTION_PASSED");
    }
    return {
      canActivate: missingConditions.length === 0,
      missingConditions,
      ...(missingConditions.length > 0 ? { reason: LEASE_ACTIVATION_REJECTED_REASON } : {})
    };
  }

  private getDeliveryEvidenceService() {
    return this.deliveryEvidenceService ?? new DeliveryEvidenceService(this.prisma);
  }

  private async validateHandoverAuthority(tx: Tx, orderId: string, handoverId: string | null) {
    if (!this.handoverWorkOrderService) return true;
    try {
      await this.handoverWorkOrderService.assertDeliveryCanBeConfirmed(orderId, handoverId, tx);
      return true;
    } catch {
      return false;
    }
  }

  private requireDependency<T>(value: T | undefined, name: string): T {
    if (!value) throw new Error(`${name} is unavailable.`);
    return value;
  }
}

function isAuthoritativelySettled(
  bills: AuthorityFacts["bills"],
  billType: BillType,
  requiredAmount: bigint
) {
  const bill = bills.find(
    (candidate) => candidate.billType === billType && candidate.amount === requiredAmount
  );
  if (!bill || bill.billStatus !== BillStatus.PAID || bill.remainingAmount !== 0n) {
    return false;
  }
  const confirmedWriteOffAmount = bill.writeOffs.reduce(
    (total, writeOff) =>
      writeOff.payment.paymentStatus === PaymentStatus.CONFIRMED
        ? total + writeOff.writeOffAmount
        : total,
    0n
  );
  return confirmedWriteOffAmount >= requiredAmount;
}

function isCompletedActivationReplay(facts: AuthorityFacts) {
  return (
    facts.order.orderStatus === OrderStatus.ACTIVE &&
    facts.delivery?.deliveryStatus === DeliveryStatus.DELIVERED &&
    facts.order.vehicle?.status === VehicleStatus.LEASED
  );
}

function sameManifest(metadata: Prisma.JsonValue, manifestHash?: string | null) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const approvedManifestHash = normalizeSha256(metadata.journeyEvidenceManifestHash);
  const archivedManifestHash = normalizeSha256(manifestHash);
  return (
    approvedManifestHash !== null &&
    archivedManifestHash !== null &&
    approvedManifestHash === archivedManifestHash
  );
}

function normalizeSha256(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .trim()
    .replace(/^sha256:/i, "")
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function toLeaseView(lease: Lease) {
  return {
    activatedAt: toIsoDateTime(lease.activatedAt),
    createdAt: toIsoDateTime(lease.createdAt),
    id: lease.id,
    orderId: lease.orderId,
    status: lease.status,
    updatedAt: toIsoDateTime(lease.updatedAt)
  };
}

function toIsoDateTime(value: Date | null) {
  return value ? value.toISOString() : null;
}

function appendEvidenceMissingConditions(
  missingConditions: LeaseActivationCondition[],
  readiness: DeliveryEvidenceReadiness
) {
  if (readiness.ready) return;
  for (const detail of readiness.blockingDetails) {
    if (
      detail.code === "HANDOVER_EVIDENCE_REJECTED" ||
      detail.code === "DAMAGE_EVIDENCE_REJECTED"
    ) {
      pushUnique(missingConditions, "HANDOVER_EVIDENCE_REJECTED");
    } else if (
      detail.code === "HANDOVER_EVIDENCE_REVIEW_PENDING" ||
      detail.code === "DAMAGE_EVIDENCE_REVIEW_PENDING"
    ) {
      pushUnique(missingConditions, "HANDOVER_EVIDENCE_REVIEW_PENDING");
    } else if (
      detail.code === "DAMAGE_EVIDENCE_MISSING" ||
      detail.code === "DAMAGE_STATE_CONFLICT"
    ) {
      pushUnique(missingConditions, "DAMAGE_EVIDENCE_MISSING");
    } else {
      pushUnique(missingConditions, "HANDOVER_EVIDENCE_MISSING");
    }
  }
}

function pushUnique<T>(items: T[], item: T) {
  if (!items.includes(item)) items.push(item);
}
