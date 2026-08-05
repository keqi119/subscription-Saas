import { Injectable } from "@nestjs/common";
import {
  AuditAction,
  BillingScheduleStatus,
  ContractSegmentStatus,
  EntitlementAccountStatus,
  LeaseStatus,
  OrderStatus,
  Prisma,
  RenewalConsiderationStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType,
  SubscriptionChangeStatus,
  VehicleReturnStatus,
  VehicleReturnType
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-number";
import { runSerializableTransaction } from "../common/serializable-transaction";
import { NotificationService } from "../notification/notification.service";
import { PrismaService } from "../prisma/prisma.service";
import { SubscriptionChangeError } from "./subscription-change.errors";

const CANCELLABLE_FUTURE_JOB_TYPES = [
  SubscriptionAutomationJobType.RENEWAL_REMINDER_D30,
  SubscriptionAutomationJobType.RENEWAL_REMINDER_D14,
  SubscriptionAutomationJobType.RENEWAL_REMINDER_D3,
  SubscriptionAutomationJobType.EXTENSION_SEGMENT_ACTIVATE,
  SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME,
  SubscriptionAutomationJobType.EXTENSION_ENTITLEMENT_RENEW,
  SubscriptionAutomationJobType.EXTENSION_INSURANCE_VALIDATION,
  SubscriptionAutomationJobType.EXTENSION_EFFECTIVE_NOTICE
] as const;

const EXPIRABLE_CHANGE_STATUSES: SubscriptionChangeStatus[] = [
  SubscriptionChangeStatus.DRAFT,
  SubscriptionChangeStatus.QUOTED,
  SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
  SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
  SubscriptionChangeStatus.SCHEDULED,
  SubscriptionChangeStatus.EXECUTING,
  SubscriptionChangeStatus.MANUAL_TAKEOVER
];

@Injectable()
export class SubscriptionExpiryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly auditService: AuditService
  ) {}

  async expireSegment(
    segmentId: string,
    now = new Date()
  ): Promise<{ outcome: "EXPIRED" | "EXTENDED" | "DUPLICATE"; returnId?: string }> {
    const decision = await runSerializableTransaction(this.prisma, async (tx) => {
      await lockExpiryRows(tx, segmentId);
      const segment = await tx.subscriptionContractSegment.findUnique({
        where: { id: segmentId }
      });
      if (!segment) {
        throw new SubscriptionChangeError(
          "SUBSCRIPTION_EXPIRY_SEGMENT_MISSING",
          "The expiring contract segment was not found."
        );
      }
      const deadline = shanghaiStartOfDate(addUtcDays(segment.endDate, 1));
      if (now.getTime() < deadline.getTime()) {
        throw new SubscriptionChangeError(
          "SUBSCRIPTION_EXPIRY_NOT_DUE",
          "The contract segment has not reached its expiry deadline."
        );
      }
      const nextSegment = await tx.subscriptionContractSegment.findFirst({
        orderBy: { sequenceNo: "asc" },
        where: {
          orderId: segment.orderId,
          sequenceNo: { gt: segment.sequenceNo },
          startDate: addUtcDays(segment.endDate, 1),
          status: {
            in: [ContractSegmentStatus.SCHEDULED, ContractSegmentStatus.ACTIVE]
          }
        }
      });
      if (nextSegment) return { outcome: "EXTENDED" as const };

      const order = await tx.subscriptionOrder.findUnique({
        include: {
          customer: { select: { mobile: true } },
          vehicle: { select: { plateNo: true } }
        },
        where: { id: segment.orderId }
      });
      if (!order?.vehicleId) {
        throw new SubscriptionChangeError(
          "SUBSCRIPTION_EXPIRY_ORDER_INCOMPLETE",
          "The expiring order and leased vehicle are required."
        );
      }
      const existingReturn = await tx.vehicleReturn.findUnique({
        where: { orderId: order.id }
      });
      if (
        segment.status === ContractSegmentStatus.COMPLETED &&
        order.orderStatus === OrderStatus.PENDING_RETURN &&
        existingReturn &&
        !existingReturn.deletedAt &&
        existingReturn.returnStatus !== VehicleReturnStatus.CANCELLED
      ) {
        return {
          considerationId: null,
          endDate: segment.endDate,
          order,
          outcome: "DUPLICATE" as const,
          returnId: existingReturn.id
        };
      }
      if (order.orderStatus !== OrderStatus.ACTIVE) {
        return {
          considerationId: null,
          endDate: segment.endDate,
          order,
          outcome: "DUPLICATE" as const,
          returnId: existingReturn?.id
        };
      }

      const consideration = await tx.renewalConsideration.findUnique({
        where: { segmentId: segment.id }
      });
      const change = await tx.subscriptionChangeOrder.findFirst({
        orderBy: { createdAt: "desc" },
        where: {
          orderId: order.id,
          sourceSegmentId: segment.id
        }
      });
      const lease = await tx.lease.findUnique({ where: { orderId: order.id } });
      if (!lease || lease.status !== LeaseStatus.ACTIVE) {
        throw new SubscriptionChangeError(
          "SUBSCRIPTION_EXPIRY_LEASE_INVALID",
          "An active lease is required before transitioning to return due."
        );
      }

      if (segment.status === ContractSegmentStatus.ACTIVE) {
        await tx.subscriptionContractSegment.updateMany({
          data: { completedAt: now, status: ContractSegmentStatus.COMPLETED },
          where: { id: segment.id, status: ContractSegmentStatus.ACTIVE }
        });
      }
      if (consideration && consideration.status !== RenewalConsiderationStatus.EXPIRED) {
        await tx.renewalConsideration.updateMany({
          data: {
            status: RenewalConsiderationStatus.EXPIRED,
            version: { increment: 1 }
          },
          where: { id: consideration.id, version: consideration.version }
        });
      }
      if (change && EXPIRABLE_CHANGE_STATUSES.includes(change.status)) {
        await tx.subscriptionChangeOrder.updateMany({
          data: {
            failureCode: "EXTENSION_DEADLINE_MISSED",
            failureMessage: "The extension agreement was not archived before the completion deadline.",
            status: SubscriptionChangeStatus.FAILED,
            version: { increment: 1 }
          },
          where: { id: change.id, status: change.status, version: change.version }
        });
      }
      await tx.subscriptionOrder.updateMany({
        data: { orderStatus: OrderStatus.PENDING_RETURN },
        where: { id: order.id, orderStatus: OrderStatus.ACTIVE }
      });
      await tx.lease.updateMany({
        data: { status: LeaseStatus.RETURN_DUE },
        where: { id: lease.id, status: LeaseStatus.ACTIVE }
      });

      const vehicleReturn = existingReturn
        ? existingReturn.returnStatus === VehicleReturnStatus.CANCELLED || existingReturn.deletedAt
          ? await tx.vehicleReturn.update({
              data: {
                deletedAt: null,
                returnStatus: VehicleReturnStatus.PENDING,
                returnType: VehicleReturnType.NORMAL_RETURN,
                scheduledAt: deadline
              },
              where: { id: existingReturn.id }
            })
          : existingReturn
        : await tx.vehicleReturn.create({
            data: {
              customerId: order.customerId,
              orderId: order.id,
              returnNo: createBusinessNo("RET"),
              returnStatus: VehicleReturnStatus.PENDING,
              returnType: VehicleReturnType.NORMAL_RETURN,
              scheduledAt: deadline,
              vehicleId: order.vehicleId
            }
          });

      const schedule = await tx.billingSchedule.findUnique({
        where: { orderId: order.id }
      });
      if (
        schedule &&
        (schedule.status === BillingScheduleStatus.ACTIVE ||
          schedule.status === BillingScheduleStatus.PAUSED)
      ) {
        const hasEarnedCycle =
          schedule.nextPeriodStart.getTime() <= segment.endDate.getTime();
        await tx.billingSchedule.updateMany({
          data: hasEarnedCycle
            ? {
                completedAt: null,
                pauseReason: null,
                status: BillingScheduleStatus.ACTIVE,
                version: { increment: 1 }
              }
            : {
                completedAt: now,
                pauseReason: null,
                status: BillingScheduleStatus.COMPLETED,
                version: { increment: 1 }
              },
          where: { id: schedule.id, status: schedule.status, version: schedule.version }
        });
      }
      await tx.orderEntitlementAccount.updateMany({
        data: { accountStatus: EntitlementAccountStatus.CLOSED },
        where: {
          accountStatus: EntitlementAccountStatus.ACTIVE,
          deletedAt: null,
          orderId: order.id
        }
      });
      await tx.subscriptionAutomationJob.updateMany({
        data: {
          cancelledAt: now,
          completedAt: now,
          jobStatus: SubscriptionAutomationJobStatus.CANCELLED,
          leaseExpiresAt: null,
          leaseToken: null
        },
        where: {
          billId: null,
          jobStatus: {
            in: [
              SubscriptionAutomationJobStatus.PENDING,
              SubscriptionAutomationJobStatus.PROCESSING
            ]
          },
          jobType: { in: [...CANCELLABLE_FUTURE_JOB_TYPES] },
          orderId: order.id
        }
      });
      await tx.subscriptionAutomationJob.updateMany({
        data: {
          cancelledAt: now,
          completedAt: now,
          jobStatus: SubscriptionAutomationJobStatus.CANCELLED,
          leaseExpiresAt: null,
          leaseToken: null
        },
        where: {
          billId: null,
          jobStatus: {
            in: [
              SubscriptionAutomationJobStatus.PENDING,
              SubscriptionAutomationJobStatus.PROCESSING
            ]
          },
          jobType: SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
          orderId: order.id,
          payload: { path: ["periodStart"], gt: dateKey(segment.endDate) }
        }
      });
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: {
          changeOrderId: change?.id ?? null,
          leaseStatus: LeaseStatus.RETURN_DUE,
          orderStatus: OrderStatus.PENDING_RETURN,
          outcome: "EXPIRED",
          returnId: vehicleReturn.id,
          segmentStatus: ContractSegmentStatus.COMPLETED
        },
        entityId: segment.id,
        entityType: "subscription_contract_segment",
        module: "subscription_change"
      }, tx);

      return {
        considerationId: consideration?.id ?? null,
        endDate: segment.endDate,
        order,
        outcome: "EXPIRED" as const,
        returnId: vehicleReturn.id
      };
    });

    if (decision.outcome !== "EXTENDED" && decision.returnId && "order" in decision) {
      await this.notifications.notifyRenewalExpiryInApp({
        considerationId: decision.considerationId,
        customerId: decision.order.customerId,
        endDate: dateKey(decision.endDate),
        idempotencyKey: `renewal-expiry-notice:${decision.order.id}:${dateKey(decision.endDate)}`,
        orderId: decision.order.id,
        orderNo: decision.order.orderNo,
        phone: decision.order.customer?.mobile,
        plateNo: decision.order.vehicle?.plateNo,
        returnId: decision.returnId
      });
    }
    return decision.outcome === "EXTENDED"
      ? { outcome: decision.outcome }
      : { outcome: decision.outcome, returnId: decision.returnId };
  }

  async flagOverdueReturn(orderId: string, now = new Date()) {
    const order = await this.prisma.subscriptionOrder.findUnique({
      include: {
        customer: { select: { mobile: true } },
        vehicle: { select: { plateNo: true } }
      },
      where: { id: orderId }
    });
    const vehicleReturn = await this.prisma.vehicleReturn.findUnique({
      where: { orderId }
    });
    if (
      !order ||
      order.orderStatus !== OrderStatus.PENDING_RETURN ||
      !vehicleReturn ||
      vehicleReturn.returnStatus === VehicleReturnStatus.CONFIRMED ||
      vehicleReturn.returnedAt
    ) {
      return { created: false };
    }
    const segment = await this.prisma.subscriptionContractSegment.findFirst({
      orderBy: { sequenceNo: "desc" },
      where: { orderId }
    });
    if (!segment || now.getTime() < shanghaiStartOfDate(addUtcDays(segment.endDate, 2)).getTime()) {
      return { created: false };
    }
    const result = await this.notifications.notifyRenewalReturnOverdueInApp({
      customerId: order.customerId,
      endDate: dateKey(segment.endDate),
      idempotencyKey: `renewal-return-overdue:${order.id}:${dateKey(segment.endDate)}:D1`,
      orderId: order.id,
      orderNo: order.orderNo,
      phone: order.customer?.mobile,
      plateNo: order.vehicle?.plateNo,
      returnId: vehicleReturn.id
    });
    return { created: result.created };
  }
}

async function lockExpiryRows(tx: Prisma.TransactionClient, segmentId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "subscription_change_order"
    WHERE "source_segment_id" = ${segmentId}::uuid
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "renewal_consideration"
    WHERE "segment_id" = ${segmentId}::uuid
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "subscription_contract_segment"
    WHERE "id" = ${segmentId}::uuid OR "source_change_order_id" IN (
      SELECT "id" FROM "subscription_change_order"
      WHERE "source_segment_id" = ${segmentId}::uuid
    )
    ORDER BY "sequence_no"
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT subscription_order."id"
    FROM "subscription_contract_segment" segment
    JOIN "subscription_order" subscription_order
      ON subscription_order."id" = segment."order_id"
    WHERE segment."id" = ${segmentId}::uuid
    FOR UPDATE OF subscription_order
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT lease."id"
    FROM "subscription_contract_segment" segment
    JOIN "lease" lease ON lease."order_id" = segment."order_id"
    WHERE segment."id" = ${segmentId}::uuid
    FOR UPDATE OF lease
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT vehicle_return."id"
    FROM "subscription_contract_segment" segment
    JOIN "vehicle_return" vehicle_return ON vehicle_return."order_id" = segment."order_id"
    WHERE segment."id" = ${segmentId}::uuid
    FOR UPDATE OF vehicle_return
  `);
}

function addUtcDays(value: Date, days: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function shanghaiStartOfDate(value: Date) {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) - 8 * 3_600_000
  );
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}
