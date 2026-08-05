import { Injectable } from "@nestjs/common";
import {
  AuditAction,
  ContractSegmentStatus,
  EntitlementAccountStatus,
  EntitlementGrantSource,
  EntitlementGrantStatus,
  Prisma,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType,
  SubscriptionChangeStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { BillingAutomationRepository } from "../billing-automation/billing-automation.repository";
import { ClaimedBillingAutomationJob } from "../billing-automation/billing-automation.types";
import { BillingAutomationService } from "../billing-automation/billing-automation.service";
import { createBusinessNo } from "../common/business-number";
import { NotificationService } from "../notification/notification.service";
import {
  OrderEntitlementGrantInput,
  buildEntitlementGrantInputsFromSnapshot
} from "../order/order.service";
import { PrismaService } from "../prisma/prisma.service";
import { SubscriptionChangeError } from "./subscription-change.errors";

const CONTINUATION_JOB_TYPES = [
  SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME,
  SubscriptionAutomationJobType.EXTENSION_ENTITLEMENT_RENEW,
  SubscriptionAutomationJobType.EXTENSION_EFFECTIVE_NOTICE
] as const;

type ContinuationJobType = (typeof CONTINUATION_JOB_TYPES)[number];

@Injectable()
export class SubscriptionExtensionActivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: BillingAutomationRepository,
    private readonly billingAutomation: BillingAutomationService,
    private readonly notifications: NotificationService,
    private readonly auditService: AuditService
  ) {}

  async activate(segmentId: string, now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      await lockActivationRows(tx, segmentId);
      const segment = await tx.subscriptionContractSegment.findUnique({
        include: {
          sourceChangeOrder: {
            include: { sourceSegment: true }
          }
        },
        where: { id: segmentId }
      });
      const change = segment?.sourceChangeOrder;
      if (!segment || !change) {
        throw new SubscriptionChangeError(
          "EXTENSION_ACTIVATION_SOURCE_MISSING",
          "The scheduled extension segment and change order are required."
        );
      }
      if (now.getTime() < shanghaiStartOfDate(segment.startDate).getTime()) {
        throw new SubscriptionChangeError(
          "EXTENSION_ACTIVATION_NOT_DUE",
          "The extension segment has not reached its effective date."
        );
      }

      let transitioned = false;
      if (
        segment.status === ContractSegmentStatus.SCHEDULED &&
        change.status === SubscriptionChangeStatus.SCHEDULED
      ) {
        const prior = await tx.subscriptionContractSegment.updateMany({
          data: {
            completedAt: now,
            status: ContractSegmentStatus.COMPLETED
          },
          where: {
            id: change.sourceSegment.id,
            status: ContractSegmentStatus.ACTIVE
          }
        });
        const activated = await tx.subscriptionContractSegment.updateMany({
          data: {
            activatedAt: now,
            status: ContractSegmentStatus.ACTIVE
          },
          where: {
            id: segment.id,
            status: ContractSegmentStatus.SCHEDULED
          }
        });
        const executing = await tx.subscriptionChangeOrder.updateMany({
          data: {
            failureCode: null,
            failureMessage: null,
            status: SubscriptionChangeStatus.EXECUTING,
            version: { increment: 1 }
          },
          where: {
            id: change.id,
            status: SubscriptionChangeStatus.SCHEDULED,
            version: change.version
          }
        });
        if (prior.count !== 1 || activated.count !== 1 || executing.count !== 1) {
          throw new SubscriptionChangeError(
            "EXTENSION_ACTIVATION_CONFLICT",
            "The extension activation state changed concurrently.",
            409
          );
        }
        transitioned = true;
      } else if (
        segment.status !== ContractSegmentStatus.ACTIVE ||
        (change.status !== SubscriptionChangeStatus.EXECUTING &&
          change.status !== SubscriptionChangeStatus.COMPLETED)
      ) {
        throw new SubscriptionChangeError(
          "EXTENSION_ACTIVATION_STATE_INVALID",
          "The extension cannot be activated from its current state."
        );
      }

      await this.enqueueContinuationJobs(tx, {
        availableAt: now,
        changeOrderId: change.id,
        orderId: segment.orderId,
        periodStart: segment.startDate,
        planSnapshot: segment.planSnapshot,
        segmentId: segment.id
      });
      if (transitioned) {
        await this.auditService.write({
          action: AuditAction.UPDATE,
          after: {
            activatedAt: now,
            changeOrderId: change.id,
            changeStatus: SubscriptionChangeStatus.EXECUTING,
            priorSegmentId: change.sourceSegment.id,
            priorSegmentStatus: ContractSegmentStatus.COMPLETED,
            segmentStatus: ContractSegmentStatus.ACTIVE
          },
          entityId: segment.id,
          entityType: "subscription_contract_segment",
          module: "subscription_change"
        }, tx);
      }
      return {
        changeStatus:
          change.status === SubscriptionChangeStatus.COMPLETED
            ? SubscriptionChangeStatus.COMPLETED
            : SubscriptionChangeStatus.EXECUTING,
        segmentStatus: ContractSegmentStatus.ACTIVE
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async renewEntitlements(
    segmentId: string,
    periodStart: Date,
    entitlementKey?: string
  ): Promise<{ created: number; existing: number }> {
    return this.prisma.$transaction(async (tx) => {
      const segment = await tx.subscriptionContractSegment.findUnique({
        include: { order: { select: { customerId: true } } },
        where: { id: segmentId }
      });
      if (!segment || segment.status !== ContractSegmentStatus.ACTIVE) {
        throw new SubscriptionChangeError(
          "EXTENSION_ENTITLEMENT_SEGMENT_INACTIVE",
          "An active extension segment is required for entitlement renewal."
        );
      }
      if (
        periodStart.getTime() < segment.startDate.getTime() ||
        periodStart.getTime() > segment.endDate.getTime()
      ) {
        throw new SubscriptionChangeError(
          "EXTENSION_ENTITLEMENT_PERIOD_INVALID",
          "The entitlement period is outside the extension segment."
        );
      }
      const account = await tx.orderEntitlementAccount.findFirst({
        where: {
          accountStatus: EntitlementAccountStatus.ACTIVE,
          deletedAt: null,
          orderId: segment.orderId
        }
      });
      if (!account) {
        throw new SubscriptionChangeError(
          "EXTENSION_ENTITLEMENT_ACCOUNT_MISSING",
          "An active entitlement account is required for extension renewal."
        );
      }
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "order_entitlement_account"
        WHERE "id" = ${account.id}::uuid
        FOR UPDATE
      `);
      const lockedAccount = await tx.orderEntitlementAccount.findUnique({
        where: { id: account.id }
      });
      if (!lockedAccount || lockedAccount.accountStatus !== EntitlementAccountStatus.ACTIVE) {
        throw new SubscriptionChangeError(
          "EXTENSION_ENTITLEMENT_ACCOUNT_INACTIVE",
          "The entitlement account is no longer active."
        );
      }

      const periodEnd = minDate(
        addUtcDays(addMonthsClampedUtc(periodStart, 1), -1),
        segment.endDate
      );
      const allGrantInputs = buildEntitlementGrantInputsFromSnapshot(segment.planSnapshot);
      const grantInputs = entitlementKey
        ? allGrantInputs.filter((grant) => grantIdentity(grant) === entitlementKey)
        : allGrantInputs;
      if (entitlementKey && grantInputs.length === 0) {
        throw new SubscriptionChangeError(
          "EXTENSION_ENTITLEMENT_TYPE_MISSING",
          "The requested entitlement is absent from the extension segment snapshot."
        );
      }

      let created = 0;
      let existing = 0;
      for (const grant of grantInputs) {
        const idempotencyKey = entitlementIdempotencyKey(
          segment.orderId,
          segment.id,
          periodStart,
          grant
        );
        const found = await tx.orderEntitlementGrant.findFirst({
          where: {
            accountId: account.id,
            deletedAt: null,
            snapshot: { equals: idempotencyKey, path: ["idempotencyKey"] }
          }
        });
        if (found) {
          existing += 1;
          continue;
        }
        await tx.orderEntitlementGrant.create({
          data: {
            accountId: account.id,
            createdBy: null,
            customerId: segment.order.customerId,
            entitlementName: grant.entitlementName,
            entitlementType: grant.entitlementType,
            grantNo: createBusinessNo("EG"),
            grantPeriodEnd: periodEnd,
            grantPeriodStart: periodStart,
            grantSource: EntitlementGrantSource.MONTHLY_RENEWAL,
            orderId: segment.orderId,
            remainingAmount: grant.remainingAmount,
            snapshot: appendGrantIdentity(grant.snapshot, {
              contractSegmentId: segment.id,
              idempotencyKey
            }),
            status: EntitlementGrantStatus.ACTIVE,
            totalAmount: grant.totalAmount,
            unit: grant.unit,
            updatedBy: null,
            usedAmount: grant.usedAmount
          }
        });
        created += 1;
      }

      if (
        !lockedAccount.periodEnd ||
        lockedAccount.periodEnd.getTime() < segment.endDate.getTime()
      ) {
        await tx.orderEntitlementAccount.update({
          data: { periodEnd: segment.endDate },
          where: { id: account.id }
        });
      }
      if (created > 0) {
        await this.auditService.write({
          action: AuditAction.CREATE,
          after: {
            contractSegmentId: segment.id,
            created,
            periodEnd,
            periodStart
          },
          entityId: account.id,
          entityType: "order_entitlement_grant",
          module: "entitlement"
        }, tx);
      }
      return { created, existing };
    });
  }

  async resumeBilling(segmentId: string) {
    const segment = await this.prisma.subscriptionContractSegment.findUnique({
      select: { id: true, orderId: true },
      where: { id: segmentId }
    });
    if (!segment) {
      throw new SubscriptionChangeError(
        "EXTENSION_BILLING_SEGMENT_MISSING",
        "The extension segment was not found."
      );
    }
    await this.billingAutomation.resumeForExtension(segment.orderId, segment.id);
    return { resumed: true };
  }

  async sendEffectiveNotice(segmentId: string, idempotencyKey: string) {
    const segment = await this.prisma.subscriptionContractSegment.findUnique({
      include: {
        order: { select: { customerId: true, orderNo: true } },
        sourceChangeOrder: { select: { id: true } }
      },
      where: { id: segmentId }
    });
    if (!segment?.sourceChangeOrder) {
      throw new SubscriptionChangeError(
        "EXTENSION_NOTICE_SOURCE_MISSING",
        "The extension notice source was not found."
      );
    }
    await this.notifications.notifyExtensionEffectiveInApp({
      changeOrderId: segment.sourceChangeOrder.id,
      contractedThrough: dateKey(segment.endDate),
      customerId: segment.order.customerId,
      idempotencyKey,
      orderNo: segment.order.orderNo,
      segmentId: segment.id
    });
    return { sent: true };
  }

  async completeIfReady(changeOrderId: string) {
    return this.prisma.$transaction(async (tx) => {
      const change = await tx.subscriptionChangeOrder.findUnique({
        select: { id: true, status: true, version: true },
        where: { id: changeOrderId }
      });
      if (!change || change.status === SubscriptionChangeStatus.COMPLETED) {
        return { completed: change?.status === SubscriptionChangeStatus.COMPLETED };
      }
      if (change.status !== SubscriptionChangeStatus.EXECUTING) {
        return { completed: false };
      }
      const jobs = await tx.subscriptionAutomationJob.findMany({
        select: { jobStatus: true, jobType: true },
        where: {
          changeOrderId,
          jobType: { in: [...CONTINUATION_JOB_TYPES] }
        }
      });
      const completedTypes = new Set(
        jobs
          .filter((job) => job.jobStatus === SubscriptionAutomationJobStatus.COMPLETED)
          .map((job) => job.jobType)
      );
      const requiredBaseTypes: ContinuationJobType[] = [
        SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME,
        SubscriptionAutomationJobType.EXTENSION_EFFECTIVE_NOTICE
      ];
      if (
        requiredBaseTypes.some((jobType) => !completedTypes.has(jobType)) ||
        jobs.some((job) => job.jobStatus !== SubscriptionAutomationJobStatus.COMPLETED)
      ) {
        return { completed: false };
      }
      const updated = await tx.subscriptionChangeOrder.updateMany({
        data: {
          failureCode: null,
          failureMessage: null,
          status: SubscriptionChangeStatus.COMPLETED,
          version: { increment: 1 }
        },
        where: {
          id: change.id,
          status: SubscriptionChangeStatus.EXECUTING,
          version: change.version
        }
      });
      if (updated.count === 1) {
        await this.auditService.write({
          action: AuditAction.UPDATE,
          after: { status: SubscriptionChangeStatus.COMPLETED },
          entityId: change.id,
          entityType: "subscription_change_order",
          module: "subscription_change"
        }, tx);
      }
      return { completed: updated.count === 1 };
    });
  }

  async markManualTakeover(
    job: Pick<ClaimedBillingAutomationJob, "changeOrderId" | "id" | "jobType">,
    failure: { code: string; message: string }
  ) {
    if (!job.changeOrderId || !isExtensionExecutionJob(job.jobType)) return { updated: false };
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.subscriptionChangeOrder.updateMany({
        data: {
          failureCode: failure.code,
          failureMessage: failure.message,
          manualTakeoverAt: new Date(),
          manualTakeoverReason: `Automation job ${job.id} exhausted retries.`,
          status: SubscriptionChangeStatus.MANUAL_TAKEOVER,
          version: { increment: 1 }
        },
        where: {
          id: job.changeOrderId!,
          status: {
            in: [
              SubscriptionChangeStatus.SCHEDULED,
              SubscriptionChangeStatus.EXECUTING
            ]
          }
        }
      });
      if (updated.count === 1) {
        await this.auditService.write({
          action: AuditAction.UPDATE,
          after: {
            failureCode: failure.code,
            failureMessage: failure.message,
            jobId: job.id,
            jobType: job.jobType,
            status: SubscriptionChangeStatus.MANUAL_TAKEOVER
          },
          entityId: job.changeOrderId!,
          entityType: "subscription_change_order",
          module: "subscription_change"
        }, tx);
      }
      return { updated: updated.count === 1 };
    });
  }

  private async enqueueContinuationJobs(
    tx: Prisma.TransactionClient,
    input: {
      availableAt: Date;
      changeOrderId: string;
      orderId: string;
      periodStart: Date;
      planSnapshot: Prisma.JsonValue;
      segmentId: string;
    }
  ) {
    const common = {
      availableAt: input.availableAt,
      changeOrderId: input.changeOrderId,
      contractSegmentId: input.segmentId,
      orderId: input.orderId
    };
    await this.repository.enqueue(tx, {
      ...common,
      idempotencyKey: `extension-billing-resume:${input.orderId}:${input.segmentId}`,
      jobType: SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME
    });
    await this.repository.enqueue(tx, {
      ...common,
      idempotencyKey: `extension-effective-notice:${input.orderId}:${input.segmentId}`,
      jobType: SubscriptionAutomationJobType.EXTENSION_EFFECTIVE_NOTICE
    });
    const grants = buildEntitlementGrantInputsFromSnapshot(input.planSnapshot)
      .sort((left, right) => grantIdentity(left).localeCompare(grantIdentity(right)));
    if (grants.length === 0) {
      await this.repository.enqueue(tx, {
        ...common,
        idempotencyKey:
          `extension-entitlement:${input.orderId}:${input.segmentId}:${dateKey(input.periodStart)}:ACCOUNT`,
        jobType: SubscriptionAutomationJobType.EXTENSION_ENTITLEMENT_RENEW,
        payload: { periodStart: dateKey(input.periodStart) }
      });
    }
    for (const grant of grants) {
      const identity = grantIdentity(grant);
      await this.repository.enqueue(tx, {
        ...common,
        idempotencyKey: entitlementIdempotencyKey(
          input.orderId,
          input.segmentId,
          input.periodStart,
          grant
        ),
        jobType: SubscriptionAutomationJobType.EXTENSION_ENTITLEMENT_RENEW,
        payload: {
          entitlementKey: identity,
          periodStart: dateKey(input.periodStart)
        }
      });
    }
  }
}

async function lockActivationRows(tx: Prisma.TransactionClient, segmentId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "source_change_order_id" FROM "subscription_contract_segment"
    WHERE "id" = ${segmentId}::uuid
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT source."id" FROM "subscription_contract_segment" target
    JOIN "subscription_change_order" change_order
      ON change_order."id" = target."source_change_order_id"
    JOIN "subscription_contract_segment" source
      ON source."id" = change_order."source_segment_id"
    WHERE target."id" = ${segmentId}::uuid
    FOR UPDATE OF source
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT change_order."id", subscription_order."id"
    FROM "subscription_contract_segment" target
    JOIN "subscription_change_order" change_order
      ON change_order."id" = target."source_change_order_id"
    JOIN "subscription_order" subscription_order
      ON subscription_order."id" = target."order_id"
    WHERE target."id" = ${segmentId}::uuid
    FOR UPDATE OF change_order, subscription_order
  `);
}

function entitlementIdempotencyKey(
  orderId: string,
  segmentId: string,
  periodStart: Date,
  grant: OrderEntitlementGrantInput
) {
  return `extension-entitlement:${orderId}:${segmentId}:${dateKey(periodStart)}:${grantIdentity(grant)}`;
}

function grantIdentity(grant: OrderEntitlementGrantInput) {
  return `${grant.entitlementType}:${grant.unit}`;
}

function appendGrantIdentity(
  snapshot: Prisma.InputJsonValue,
  identity: { contractSegmentId: string; idempotencyKey: string }
): Prisma.InputJsonValue {
  const base = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot
    : {};
  return { ...base, ...identity };
}

function addMonthsClampedUtc(value: Date, months: number) {
  const targetMonth = value.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(value.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    value.getUTCFullYear(),
    targetMonth,
    Math.min(value.getUTCDate(), lastDay)
  ));
}

function addUtcDays(value: Date, days: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function minDate(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? left : right;
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function shanghaiStartOfDate(value: Date) {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) - 8 * 3_600_000
  );
}

function isExtensionExecutionJob(jobType: SubscriptionAutomationJobType) {
  return jobType === SubscriptionAutomationJobType.EXTENSION_SEGMENT_ACTIVATE ||
    CONTINUATION_JOB_TYPES.includes(jobType as ContinuationJobType);
}
