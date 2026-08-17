import { Injectable } from "@nestjs/common";
import {
  BillStatus,
  NotificationEventType,
  NotificationType,
  SubscriptionAutomationJobType
} from "@prisma/client";

import { NotificationService } from "../notification/notification.service";
import { PrismaService } from "../prisma/prisma.service";
import { BillingAutomationService } from "./billing-automation.service";
import { ClaimedBillingAutomationJob } from "./billing-automation.types";

@Injectable()
export class BillingAutomationHandlers {
  readonly supportedJobTypes = [
    SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
    SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE,
    SubscriptionAutomationJobType.MARK_BILL_OVERDUE,
    SubscriptionAutomationJobType.SEND_BILL_OVERDUE_NOTICE
  ] as const;

  constructor(
    private readonly service: BillingAutomationService,
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService
  ) {}

  async handle(job: ClaimedBillingAutomationJob) {
    switch (job.jobType) {
      case SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL:
        return this.service.generateScheduledMonthlyRent(job);
      case SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE:
        return this.sendBillNotice(job, "DUE");
      case SubscriptionAutomationJobType.MARK_BILL_OVERDUE:
        return normalizeOverdueResult(await this.service.markScheduledBillOverdue(job));
      case SubscriptionAutomationJobType.SEND_BILL_OVERDUE_NOTICE:
        return this.sendBillNotice(job, "OVERDUE");
      default:
        throw new Error("Unsupported billing automation job type.");
    }
  }

  private async sendBillNotice(job: ClaimedBillingAutomationJob, kind: "DUE" | "OVERDUE") {
    if (!job.billId) {
      return { action: "SKIPPED", reason: "BILL_ID_MISSING" };
    }
    const bill = await this.prisma.receivableBill.findUnique({
      select: {
        amount: true,
        billNo: true,
        billStatus: true,
        customerId: true,
        deletedAt: true,
        dueDate: true,
        id: true,
        remainingAmount: true
      },
      where: { id: job.billId }
    });
    if (
      !bill ||
      bill.deletedAt ||
      bill.remainingAmount <= 0n ||
      bill.billStatus === BillStatus.PAID ||
      bill.billStatus === BillStatus.CANCELLED
    ) {
      return { action: "SKIPPED", reason: "BILL_SETTLED_OR_MISSING" };
    }
    if (kind === "OVERDUE" && bill.billStatus !== BillStatus.OVERDUE) {
      return { action: "SKIPPED", reason: "BILL_NOT_OVERDUE" };
    }

    const overdue = kind === "OVERDUE";
    const records = await this.notificationService.notifyBillLifecycle({
      aggregateId: bill.id,
      aggregateType: "ReceivableBill",
      billId: bill.id,
      content: overdue
        ? `账单 ${bill.billNo} 已逾期，请尽快完成付款。`
        : `账单 ${bill.billNo} 将于 ${dateKey(bill.dueDate)} 到期，请按时完成付款。`,
      customerId: bill.customerId,
      data: {
        aggregateNo: bill.billNo,
        amountCents: bill.amount.toString(),
        dueDate: dateKey(bill.dueDate),
        remainingAmountCents: bill.remainingAmount.toString()
      },
      eventType: overdue ? NotificationEventType.BILL_OVERDUE : NotificationEventType.BILL_DUE,
      idempotencyKey: job.idempotencyKey,
      notificationType: overdue ? NotificationType.BILL_OVERDUE : NotificationType.BILL_DUE,
      title: overdue ? "账单逾期提醒" : "账单到期提醒",
      url: "/portal/billing"
    });

    return {
      action: "NOTIFIED",
      notificationIds: records.map((record) => record.id)
    };
  }
}

function normalizeOverdueResult(result: {
  action: string;
  bill: { id: string };
  collectionCase?: { id: string };
}) {
  return {
    action: result.action,
    billId: result.bill.id,
    collectionCaseId: result.collectionCase?.id ?? null
  };
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}
