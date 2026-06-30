import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import {
  AuditAction,
  BillStatus,
  BillType,
  ContractStatus,
  DeliveryStatus,
  Lease,
  LeaseStatus,
  VehicleInspectionStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import {
  LEASE_ACTIVATION_CLOCK,
  LeaseActivationClock,
  LeaseActivationCondition,
  LeaseActivationResult,
  LeaseStatusView
} from "./lease-activation.types";

const LEASE_ACTIVATION_REJECTED_REASON = "MISSING_LEASE_ACTIVATION_CONDITIONS";

@Injectable()
export class LeaseActivationEngine {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(LEASE_ACTIVATION_CLOCK)
    private readonly clock: LeaseActivationClock = () => new Date()
  ) {}

  async evaluate(orderId: string): Promise<LeaseActivationResult> {
    const order = await this.prisma.subscriptionOrder.findUnique({
      include: { contract: true },
      where: { id: orderId }
    });

    if (!order || order.deletedAt) {
      throw new NotFoundException("Order not found.");
    }

    const [bills, delivery, inspection] = await Promise.all([
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
      this.prisma.vehicleInspection.findUnique({ where: { orderId } })
    ]);

    const missingConditions: LeaseActivationCondition[] = [];

    if (!order.contract || order.contract.deletedAt || order.contract.status !== ContractStatus.SIGNED) {
      missingConditions.push("CONTRACT_SIGNED");
    }

    if (!isBillTypePaid(bills, BillType.DEPOSIT)) {
      missingConditions.push("DEPOSIT_PAID");
    }

    if (!isBillTypePaid(bills, BillType.FIRST_MONTHLY_FEE)) {
      missingConditions.push("FIRST_RENT_PAID");
    }

    if (!delivery || delivery.deletedAt || delivery.deliveryStatus !== DeliveryStatus.DELIVERED) {
      missingConditions.push("DELIVERY_CONFIRMED");
    }

    if (!inspection || inspection.deletedAt || inspection.status !== VehicleInspectionStatus.PASSED) {
      missingConditions.push("INSPECTION_PASSED");
    }

    return {
      canActivate: missingConditions.length === 0,
      missingConditions,
      ...(missingConditions.length > 0 ? { reason: LEASE_ACTIVATION_REJECTED_REASON } : {})
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

    const existing = await this.prisma.lease.findUnique({ where: { orderId } });
    const activatedAt = this.clock();
    const lease =
      existing && !existing.deletedAt
        ? await this.prisma.lease.update({
            data: {
              activatedAt,
              status: LeaseStatus.ACTIVE,
              updatedBy: user?.id
            },
            where: { id: existing.id }
          })
        : await this.prisma.lease.create({
            data: {
              activatedAt,
              createdBy: user?.id,
              orderId,
              status: LeaseStatus.ACTIVE,
              updatedBy: user?.id
            }
          });

    await this.auditService.write({
      action: existing && !existing.deletedAt ? AuditAction.UPDATE : AuditAction.CREATE,
      after: toLeaseView(lease),
      before: existing && !existing.deletedAt ? toLeaseView(existing) : undefined,
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
        status: lease.status
      };
    }

    return {
      activatedAt: null,
      canActivate: result.canActivate,
      leaseId: null,
      missingConditions: result.missingConditions,
      orderId,
      status: result.canActivate ? LeaseStatus.READY : LeaseStatus.NOT_ACTIVE
    };
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
