import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import {
  AuditAction,
  BillStatus,
  BillType,
  ContractStatus,
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus,
  DeliveryStatus,
  Lease,
  LeaseStatus,
  VehicleInspectionStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { BillingAutomationService } from "../billing-automation/billing-automation.service";
import {
  DeliveryEvidenceReadiness,
  DeliveryEvidenceService
} from "../delivery-evidence/delivery-evidence.service";
import {
  isDeliveryHandoverArchived,
  isDeliveryHandoverSigned
} from "../delivery-handover/delivery-handover.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  LEASE_ACTIVATION_CLOCK,
  LeaseActivationClock,
  LeaseActivationCondition,
  LeaseActivationResult,
  LeaseActivationWarningCondition,
  LeaseStatusView
} from "./lease-activation.types";
import { activateLeaseRecord } from "./lease-activation.persistence";

const LEASE_ACTIVATION_REJECTED_REASON = "MISSING_LEASE_ACTIVATION_CONDITIONS";

@Injectable()
export class LeaseActivationEngine {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(LEASE_ACTIVATION_CLOCK)
    private readonly clock: LeaseActivationClock = () => new Date(),
    @Optional()
    private readonly deliveryEvidenceService?: DeliveryEvidenceService,
    @Optional()
    private readonly billingAutomationService?: BillingAutomationService
  ) {}

  async evaluate(orderId: string): Promise<LeaseActivationResult> {
    const order = await this.prisma.subscriptionOrder.findUnique({
      include: { contract: true },
      where: { id: orderId }
    });

    if (!order || order.deletedAt) {
      throw new NotFoundException("Order not found.");
    }

    const [bills, delivery, handover, inspection] = await Promise.all([
      this.prisma.receivableBill.findMany({
        orderBy: { createdAt: "asc" },
        where: {
          billStatus: { not: BillStatus.CANCELLED },
          billType: { in: [BillType.DEPOSIT, BillType.FIRST_MONTHLY_FEE] },
          deletedAt: null,
          orderId
        }
      }),
      this.prisma.vehicleDelivery.findUnique({ where: { orderId } }),
      this.prisma.vehicleDeliveryHandover.findFirst({
        orderBy: { createdAt: "desc" },
        where: {
          deletedAt: null,
          orderId,
          status: { notIn: [DeliveryHandoverStatus.CANCELLED, DeliveryHandoverStatus.FAILED] }
        }
      }),
      this.prisma.vehicleInspection.findUnique({ where: { orderId } })
    ]);

    const evidenceReadiness = await this.getDeliveryEvidenceService().validateEvidenceReadyForDeliveryConfirmation(
      orderId,
      handover?.id ?? null
    );
    const missingConditions: LeaseActivationCondition[] = [];
    const warningConditions: LeaseActivationWarningCondition[] = [];

    if (!order.contract || order.contract.deletedAt || order.contract.status !== ContractStatus.SIGNED) {
      missingConditions.push("CONTRACT_SIGNED");
    }

    if (!isBillTypePaid(bills, BillType.DEPOSIT)) {
      missingConditions.push("DEPOSIT_PAID");
    }

    if (!isBillTypePaid(bills, BillType.FIRST_MONTHLY_FEE)) {
      missingConditions.push("FIRST_RENT_PAID");
    }

    if (!order.actualDeliveryAt || !delivery || delivery.deletedAt || delivery.deliveryStatus !== DeliveryStatus.DELIVERED) {
      missingConditions.push("DELIVERY_CONFIRMED");
    }

    if (!isDeliveryHandoverSigned(handover)) {
      missingConditions.push("HANDOVER_SIGNED_MISSING");
    }

    appendEvidenceMissingConditions(missingConditions, evidenceReadiness);

    if (isDeliveryHandoverSigned(handover) && !isDeliveryHandoverArchived(handover)) {
      warningConditions.push(
        handover?.archiveStatus === DeliveryHandoverArchiveStatus.FAILED
          ? "HANDOVER_ARCHIVE_FAILED"
          : "HANDOVER_ARCHIVED_MISSING"
      );
    }

    if (!inspection || inspection.deletedAt || inspection.status !== VehicleInspectionStatus.PASSED) {
      missingConditions.push("INSPECTION_PASSED");
    }

    return {
      canActivate: missingConditions.length === 0,
      missingConditions,
      ...(missingConditions.length > 0 ? { reason: LEASE_ACTIVATION_REJECTED_REASON } : {}),
      ...(warningConditions.length > 0 ? { warningConditions } : {})
    };
  }

  async canActivate(orderId: string): Promise<boolean> {
    return (await this.evaluate(orderId)).canActivate;
  }

  async activate(orderId: string, user?: RequestUser, context?: RequestContext) {
    const result = await this.evaluate(orderId);

    if (!result.canActivate) {
      throw new BadRequestException({
        canActivate: false,
        missingConditions: result.missingConditions,
        reason: result.reason
      });
    }

    const { existing, lease } = await this.prisma.$transaction(
      async (tx) => {
        const order = await tx.subscriptionOrder.findUnique({
          select: {
            actualDeliveryAt: true,
            deletedAt: true,
            id: true
          },
          where: { id: orderId }
        });
        if (!order || order.deletedAt || !order.actualDeliveryAt) {
          throw new BadRequestException("DELIVERY_CONFIRMED");
        }
        const activatedAt = order.actualDeliveryAt;
        const { existing, lease } = await activateLeaseRecord(tx, {
          activatedAt,
          actorId: user?.id,
          orderId
        });
        if (!this.billingAutomationService) {
          throw new Error("Billing automation service is unavailable.");
        }
        await this.billingAutomationService.ensureActiveSchedule(
          tx,
          orderId,
          activatedAt
        );
        return { existing, lease };
      }
    );

    await this.auditService.write({
      action: existing ? AuditAction.UPDATE : AuditAction.CREATE,
      after: toLeaseView(lease),
      before: existing ? toLeaseView(existing) : undefined,
      entityId: lease.id,
      entityType: "lease",
      ipAddress: context?.ipAddress,
      module: "lease",
      operatorId: user?.id,
      userAgent: context?.userAgent
    });

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

  private getDeliveryEvidenceService() {
    return this.deliveryEvidenceService ?? new DeliveryEvidenceService(this.prisma);
  }
}

function isBillTypePaid(
  bills: Array<{ billStatus: BillStatus; billType: BillType; remainingAmount: bigint }>,
  billType: BillType
) {
  const typedBills = bills.filter((bill) => bill.billType === billType);
  return typedBills.length > 0 && typedBills.every((bill) => bill.billStatus === BillStatus.PAID || bill.remainingAmount === 0n);
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
  if (readiness.ready) {
    return;
  }
  for (const detail of readiness.blockingDetails) {
    pushUnique(missingConditions, mapEvidenceBlockingCondition(detail));
  }
}

function mapEvidenceBlockingCondition(detail: DeliveryEvidenceReadiness["blockingDetails"][number]): LeaseActivationCondition {
  if (detail.code === "HANDOVER_EVIDENCE_REJECTED" || detail.code === "DAMAGE_EVIDENCE_REJECTED") {
    return "HANDOVER_EVIDENCE_REJECTED";
  }
  if (detail.code === "HANDOVER_EVIDENCE_REVIEW_PENDING" || detail.code === "DAMAGE_EVIDENCE_REVIEW_PENDING") {
    return "HANDOVER_EVIDENCE_REVIEW_PENDING";
  }
  if (detail.code === "DAMAGE_EVIDENCE_MISSING" || detail.code === "DAMAGE_STATE_CONFLICT") {
    return "DAMAGE_EVIDENCE_MISSING";
  }
  return "HANDOVER_EVIDENCE_MISSING";
}

function pushUnique<T>(items: T[], item: T) {
  if (!items.includes(item)) {
    items.push(item);
  }
}
