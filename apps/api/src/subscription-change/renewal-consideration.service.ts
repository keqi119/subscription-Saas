import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import {
  AuditAction,
  ContractSegmentStatus,
  NotificationStatus,
  OrderStatus,
  Prisma,
  RenewalConsiderationStatus,
  RenewalReminderSlot,
  RenewalReminderStatus,
  SmsSendStatus,
  SubscriptionAutomationJobType,
  VehicleStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { BillingAutomationRepository } from "../billing-automation/billing-automation.repository";
import { createBusinessNo } from "../common/business-number";
import { NotificationService } from "../notification/notification.service";
import { PrismaService } from "../prisma/prisma.service";
import { SmsService } from "../sms/sms.service";
import { dateKey, renewalSchedule, shanghaiBusinessDate } from "./renewal-calendar";
import { SUBSCRIPTION_CHANGE_CONFIG, SubscriptionChangeConfig } from "./subscription-change.config";
import { SubscriptionChangeError } from "./subscription-change.errors";

const reminderSlots = [
  RenewalReminderSlot.D30,
  RenewalReminderSlot.D14,
  RenewalReminderSlot.D3
] as const;

const considerationDetailInclude = Prisma.validator<Prisma.RenewalConsiderationInclude>()({
  automationJobs: { orderBy: { createdAt: "desc" } },
  changeOrder: true,
  order: {
    include: {
      customer: true,
      vehicle: true
    }
  },
  reminders: { orderBy: { scheduledAt: "asc" } },
  segment: true
});

type ConsiderationDetail = Prisma.RenewalConsiderationGetPayload<{
  include: typeof considerationDetailInclude;
}>;

export interface RenewalConsiderationQuery {
  page?: number;
  pageSize?: number;
  status?: RenewalConsiderationStatus;
  smsFailed?: boolean;
}

@Injectable()
export class RenewalConsiderationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: BillingAutomationRepository,
    private readonly notificationService: NotificationService,
    private readonly smsService: SmsService,
    private readonly auditService: AuditService,
    @Inject(SUBSCRIPTION_CHANGE_CONFIG)
    private readonly config: SubscriptionChangeConfig
  ) {}

  async enrollDueSegments(now = this.config.now()) {
    if (!this.config.enabled) return { created: 0, skipped: 0 };
    const businessDate = shanghaiBusinessDate(now);
    const dueThrough = addUtcDays(businessDate, 30);
    const segments = await this.prisma.subscriptionContractSegment.findMany({
      select: { id: true },
      take: 200,
      where: {
        endDate: { gte: businessDate, lte: dueThrough },
        renewalConsideration: null,
        status: ContractSegmentStatus.ACTIVE
      }
    });
    let created = 0;
    let skipped = 0;
    for (const segment of segments) {
      const consideration = await this.enrollSegment(segment.id, now);
      if (consideration) created += 1;
      else skipped += 1;
    }
    return { created, skipped };
  }

  async enrollSegment(segmentId: string, now = this.config.now()) {
    if (!this.config.enabled) return null;
    return this.prisma.$transaction(async (tx) => {
      const segment = await tx.subscriptionContractSegment.findUnique({
        include: {
          order: { include: { vehicle: true } },
          renewalConsideration: true
        },
        where: { id: segmentId }
      });
      if (
        !segment ||
        segment.status !== ContractSegmentStatus.ACTIVE ||
        segment.order.orderStatus !== OrderStatus.ACTIVE ||
        segment.order.vehicle?.status !== VehicleStatus.LEASED
      ) {
        return null;
      }
      const latest = await tx.subscriptionContractSegment.findFirst({
        orderBy: { sequenceNo: "desc" },
        where: {
          orderId: segment.orderId,
          status: { not: ContractSegmentStatus.CANCELLED }
        }
      });
      if (!latest || latest.id !== segment.id) return null;

      const schedule = renewalSchedule(segment.endDate);
      if (now >= schedule.completionDeadlineAt) return null;
      const consideration = await tx.renewalConsideration.upsert({
        create: {
          completionDeadlineAt: schedule.completionDeadlineAt,
          considerationNo: createBusinessNo("RNC"),
          considerationStartAt: schedule.considerationStartAt,
          orderId: segment.orderId,
          segmentId: segment.id,
          status: RenewalConsiderationStatus.PENDING_DECISION
        },
        update: {},
        where: { segmentId: segment.id }
      });

      const latestPastIndex = latestApplicableReminderIndex(schedule.reminders, now);
      const reminders = [];
      for (const [index, slot] of reminderSlots.entries()) {
        const originalScheduledAt = schedule.reminders[slot];
        const skippedLate = originalScheduledAt < now && index < latestPastIndex;
        const status = skippedLate
          ? RenewalReminderStatus.SKIPPED_LATE_ENROLLMENT
          : RenewalReminderStatus.PENDING;
        const scheduledAt = !skippedLate && originalScheduledAt < now ? now : originalScheduledAt;
        const reminder = await tx.renewalReminder.upsert({
          create: {
            renewalConsiderationId: consideration.id,
            scheduledAt,
            slot,
            status
          },
          update: {},
          where: {
            renewalConsiderationId_slot: {
              renewalConsiderationId: consideration.id,
              slot
            }
          }
        });
        reminders.push(reminder);
        if (reminder.status === RenewalReminderStatus.PENDING) {
          await this.repository.enqueue(tx, {
            availableAt: reminder.scheduledAt,
            contractSegmentId: segment.id,
            idempotencyKey: reminderJobKey(consideration.id, slot),
            jobType: reminderJobType(slot),
            orderId: segment.orderId,
            payload: { reminderId: reminder.id, slot },
            renewalConsiderationId: consideration.id
          });
        }
      }
      await this.repository.enqueue(tx, {
        availableAt: schedule.completionDeadlineAt,
        contractSegmentId: segment.id,
        idempotencyKey: `renewal-expiry:${segment.id}:${dateKey(segment.endDate)}`,
        jobType: SubscriptionAutomationJobType.RENEWAL_EXPIRY_PROCESS,
        orderId: segment.orderId,
        renewalConsiderationId: consideration.id
      });
      await this.repository.enqueue(tx, {
        availableAt: addDays(schedule.completionDeadlineAt, 1),
        contractSegmentId: segment.id,
        idempotencyKey: `renewal-return-overdue:${segment.orderId}:${dateKey(segment.endDate)}:D1`,
        jobType: SubscriptionAutomationJobType.RENEWAL_RETURN_OVERDUE_D1,
        orderId: segment.orderId,
        renewalConsiderationId: consideration.id
      });
      if (!segment.renewalConsideration) {
        await this.auditService.write(
          {
            action: AuditAction.CREATE,
            after: { ...consideration, reminders },
            entityId: consideration.id,
            entityType: "renewal_consideration",
            module: "subscription_change"
          },
          tx
        );
      }
      return { ...consideration, reminders };
    });
  }

  async dispatchReminder(
    considerationId: string,
    slot: RenewalReminderSlot,
    now = this.config.now()
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockConsideration(tx, considerationId);
      const consideration = await tx.renewalConsideration.findUnique({
        include: considerationDetailInclude,
        where: { id: considerationId }
      });
      if (!consideration) throw notFound();
      const reminder = consideration.reminders.find((item) => item.slot === slot);
      if (!reminder) {
        throw new SubscriptionChangeError(
          "RENEWAL_REMINDER_NOT_FOUND",
          "Renewal reminder was not found.",
          HttpStatus.NOT_FOUND
        );
      }
      const skippedStatus = skippedReminderStatus(consideration.status);
      if (skippedStatus) {
        return tx.renewalReminder.update({
          data: { status: skippedStatus },
          where: { id: reminder.id }
        });
      }
      if (reminder.status === RenewalReminderStatus.SENT) return reminder;
      if (reminder.scheduledAt > now) return reminder;

      const idempotencyKey = reminderJobKey(consideration.id, slot);
      const daysRemaining = slotDays(slot);
      const endDate = dateKey(consideration.segment.endDate);
      const plateMasked = maskPlate(consideration.order.vehicle?.plateNo);
      const portalPath = `/portal/renewals/${encodeURIComponent(consideration.id)}`;
      const inApp = await this.notificationService.notifyRenewalReminderInApp({
        considerationId: consideration.id,
        customerId: consideration.order.customerId,
        daysRemaining,
        endDate,
        idempotencyKey,
        orderNo: consideration.order.orderNo,
        plateMasked,
        slot
      });
      const sms = await this.smsService.sendRenewalReminder({
        daysRemaining,
        endDate,
        idempotencyKey,
        orderNo: consideration.order.orderNo,
        phone: consideration.order.customer.mobile,
        plateNo: plateMasked,
        portalPath,
        slot
      });
      const inAppStatus = inApp.record.notificationStatus;
      const sent =
        (inAppStatus === NotificationStatus.SENT || inAppStatus === NotificationStatus.READ) &&
        sms.sendStatus === SmsSendStatus.SENT;
      return tx.renewalReminder.update({
        data: {
          channelResult: jsonValue({
            inApp: { id: inApp.record.id, status: inAppStatus },
            sms: {
              errorCode: sms.errorCode ?? null,
              id: sms.sendLogId ?? null,
              status: sms.sendStatus
            }
          }),
          errorCode: sent ? null : (sms.errorCode ?? "SMS_SEND_FAILED"),
          errorMessage: sent ? null : (sms.errorMessage ?? "Renewal SMS delivery failed."),
          failedAt: sent ? null : now,
          inAppStatus,
          notificationEventId: inApp.event.id,
          sentAt: sent ? now : null,
          smsSendLogId: sms.sendLogId,
          smsStatus: sms.sendStatus,
          status: sent ? RenewalReminderStatus.SENT : RenewalReminderStatus.FAILED,
          templateCodeSnapshot: sms.templateCode
        },
        where: { id: reminder.id }
      });
    }, serializableTransaction);
  }

  async retryReminder(
    considerationId: string,
    slot: RenewalReminderSlot,
    actor: RequestUser,
    context: RequestContext = {}
  ) {
    assertPermission(actor, PermissionCode.NOTIFICATION_MANAGE);
    const before = await this.getInternal(considerationId);
    const reminder = before.reminders.find((item) => item.slot === slot);
    if (!reminder) throw notFound();
    if (reminder.status !== RenewalReminderStatus.FAILED) {
      throw new SubscriptionChangeError(
        "RENEWAL_REMINDER_NOT_RETRYABLE",
        "Only a failed renewal reminder can be retried.",
        HttpStatus.CONFLICT
      );
    }
    const updated = await this.dispatchReminder(considerationId, slot, this.config.now());
    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: updated,
      before: reminder,
      entityId: reminder.id,
      entityType: "renewal_reminder",
      ipAddress: context.ipAddress,
      module: "subscription_change",
      operatorId: actor.id,
      userAgent: context.userAgent
    });
    return updated;
  }

  async list(query: RenewalConsiderationQuery, actor: RequestUser) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_VIEW);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.RenewalConsiderationWhereInput = {
      status: query.status,
      ...(query.smsFailed ? { reminders: { some: { smsStatus: SmsSendStatus.FAILED } } } : {})
    };
    const [items, total] = await Promise.all([
      this.prisma.renewalConsideration.findMany({
        include: considerationDetailInclude,
        orderBy: [{ completionDeadlineAt: "asc" }, { createdAt: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      }),
      this.prisma.renewalConsideration.count({ where })
    ]);
    return { items, page, pageSize, total };
  }

  async get(id: string, actor: RequestUser) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_VIEW);
    return this.getInternal(id);
  }

  async reconcile(id: string, actor: RequestUser, context: RequestContext = {}) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE);
    const consideration = await this.getInternal(id);
    for (const reminder of consideration.reminders) {
      if (reminder.status !== RenewalReminderStatus.PENDING) continue;
      await this.repository.enqueue(this.prisma, {
        availableAt: reminder.scheduledAt,
        contractSegmentId: consideration.segmentId,
        idempotencyKey: reminderJobKey(consideration.id, reminder.slot),
        jobType: reminderJobType(reminder.slot),
        orderId: consideration.orderId,
        payload: { reminderId: reminder.id, slot: reminder.slot },
        renewalConsiderationId: consideration.id
      });
    }
    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: { reconciledAt: this.config.now() },
      entityId: consideration.id,
      entityType: "renewal_consideration",
      ipAddress: context.ipAddress,
      module: "subscription_change",
      operatorId: actor.id,
      userAgent: context.userAgent
    });
    return this.getInternal(id);
  }

  private async getInternal(id: string): Promise<ConsiderationDetail> {
    const consideration = await this.prisma.renewalConsideration.findUnique({
      include: considerationDetailInclude,
      where: { id }
    });
    if (!consideration) throw notFound();
    return consideration;
  }
}

function reminderJobKey(considerationId: string, slot: RenewalReminderSlot) {
  return `renewal-reminder:${considerationId}:${slot}`;
}

function reminderJobType(slot: RenewalReminderSlot) {
  switch (slot) {
    case RenewalReminderSlot.D30:
      return SubscriptionAutomationJobType.RENEWAL_REMINDER_D30;
    case RenewalReminderSlot.D14:
      return SubscriptionAutomationJobType.RENEWAL_REMINDER_D14;
    case RenewalReminderSlot.D3:
      return SubscriptionAutomationJobType.RENEWAL_REMINDER_D3;
  }
}

function latestApplicableReminderIndex(reminders: Record<"D30" | "D14" | "D3", Date>, now: Date) {
  let result = -1;
  reminderSlots.forEach((slot, index) => {
    if (reminders[slot] <= now) result = index;
  });
  return result;
}

function skippedReminderStatus(status: RenewalConsiderationStatus) {
  if (
    status === RenewalConsiderationStatus.RENEWAL_REQUESTED ||
    status === RenewalConsiderationStatus.EXPIRY_CONFIRMED ||
    status === RenewalConsiderationStatus.EXTENSION_IN_PROGRESS
  ) {
    return RenewalReminderStatus.SKIPPED_DECIDED;
  }
  if (status === RenewalConsiderationStatus.EXTENDED) {
    return RenewalReminderStatus.SKIPPED_EXTENDED;
  }
  if (
    status === RenewalConsiderationStatus.EXPIRED ||
    status === RenewalConsiderationStatus.CANCELLED
  ) {
    return RenewalReminderStatus.CANCELLED;
  }
  return null;
}

function slotDays(slot: RenewalReminderSlot) {
  return slot === RenewalReminderSlot.D30 ? 30 : slot === RenewalReminderSlot.D14 ? 14 : 3;
}

function maskPlate(value: string | null | undefined) {
  const plate = value?.trim().toUpperCase() ?? "";
  if (plate.length <= 2) return plate || "-";
  return `${plate.slice(0, 1)}${"*".repeat(Math.max(2, plate.length - 3))}${plate.slice(-2)}`;
}

function addUtcDays(value: Date, days: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 86_400_000);
}

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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

function notFound() {
  return new SubscriptionChangeError(
    "RENEWAL_CONSIDERATION_NOT_FOUND",
    "Renewal consideration was not found.",
    HttpStatus.NOT_FOUND
  );
}

async function lockConsideration(tx: Prisma.TransactionClient, id: string) {
  if (typeof tx.$queryRaw !== "function") return;
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "renewal_consideration" WHERE "id" = ${id}::uuid FOR UPDATE`
  );
}

const serializableTransaction = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable
};
