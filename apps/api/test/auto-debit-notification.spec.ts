import { ConfigService } from "@nestjs/config";
import {
  DebitAttemptStatus,
  DebitRetrySlot,
  NotificationChannel,
  NotificationEventStatus,
  NotificationEventType,
  NotificationStatus,
  NotificationTemplateStatus,
  NotificationTemplateType,
  NotificationType,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AutoDebitHandlers } from "../src/auto-debit/auto-debit.handlers";
import { ClaimedBillingAutomationJob } from "../src/billing-automation/billing-automation.types";
import { BillingAutomationHandlers } from "../src/billing-automation/billing-automation.handlers";
import { NotificationProvider } from "../src/notification/notification.provider";
import { NotificationService } from "../src/notification/notification.service";

describe("auto debit final failure notification", () => {
  it("creates one idempotent in-app, WeChat, and unconfigured SMS notification group", async () => {
    const harness = createNotificationHarness();

    await harness.service.notifyAutoDebitFailure({
      attemptId: "00000000-0000-4000-8000-000000000101",
      idempotencyKey: "debit-failure:00000000-0000-4000-8000-000000000101"
    });
    await harness.service.notifyAutoDebitFailure({
      attemptId: "00000000-0000-4000-8000-000000000101",
      idempotencyKey: "debit-failure:00000000-0000-4000-8000-000000000101"
    });

    expect(harness.records).toHaveLength(3);
    expect(harness.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: NotificationChannel.IN_APP,
          notificationStatus: NotificationStatus.SENT,
          notificationType: NotificationType.AUTO_DEBIT_FAILURE
        }),
        expect.objectContaining({
          channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
          notificationStatus: NotificationStatus.SENT,
          notificationType: NotificationType.AUTO_DEBIT_FAILURE
        }),
        expect.objectContaining({
          channel: NotificationChannel.SMS,
          errorMessage: "CHANNEL_NOT_CONFIGURED",
          notificationStatus: NotificationStatus.SKIPPED,
          notificationType: NotificationType.AUTO_DEBIT_FAILURE
        })
      ])
    );
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      attempts: 2,
      eventStatus: NotificationEventStatus.PROCESSED,
      eventType: NotificationEventType.AUTO_DEBIT_FAILED
    });
  });

  it("dispatches the durable failure-notice job without retrying the debit attempt", async () => {
    const debitAttempts = {
      queryDebitAttempt: vi.fn(),
      submitBillDebit: vi.fn()
    };
    const notifications = {
      notifyAutoDebitFailure: vi.fn().mockResolvedValue([{ channel: NotificationChannel.IN_APP }])
    };
    const handlers = new AutoDebitHandlers(debitAttempts as never, notifications as never);

    await expect(handlers.handle(failureNoticeJob())).resolves.toMatchObject({
      action: "NOTIFIED",
      attemptId: "00000000-0000-4000-8000-000000000101"
    });
    expect(notifications.notifyAutoDebitFailure).toHaveBeenCalledWith({
      attemptId: "00000000-0000-4000-8000-000000000101",
      idempotencyKey: "debit-failure:00000000-0000-4000-8000-000000000101"
    });
    expect(debitAttempts.submitBillDebit).not.toHaveBeenCalled();
    expect(debitAttempts.queryDebitAttempt).not.toHaveBeenCalled();
  });

  it("keeps historical failure notification handlers outside the shared billing worker", async () => {
    const handlers = new BillingAutomationHandlers({} as never, {} as never, {} as never);

    await expect(handlers.handle(failureNoticeJob())).rejects.toThrow(
      "Unsupported billing automation job type."
    );
    expect(handlers.supportedJobTypes).not.toContain(
      SubscriptionAutomationJobType.SEND_DEBIT_FAILURE_NOTICE
    );
  });
});

function createNotificationHarness() {
  const attemptId = "00000000-0000-4000-8000-000000000101";
  const customerId = "00000000-0000-4000-8000-000000000102";
  const billId = "00000000-0000-4000-8000-000000000103";
  const events: Array<{
    attempts: number;
    eventStatus: NotificationEventStatus;
    eventType: NotificationEventType;
    id: string;
    [key: string]: unknown;
  }> = [];
  const records: Array<{
    id: string;
    notificationNo?: string;
    notificationStatus: NotificationStatus;
    [key: string]: unknown;
  }> = [];
  const templates = [
    template("AUTO_DEBIT_FAILURE_IN_APP", NotificationChannel.IN_APP),
    template("AUTO_DEBIT_FAILURE_WECHAT", NotificationChannel.WECHAT_OFFICIAL_ACCOUNT),
    template("AUTO_DEBIT_FAILURE_SMS", NotificationChannel.SMS)
  ];
  const prisma = {
    customer: {
      findFirst: vi.fn().mockResolvedValue({
        id: customerId,
        mobile: "13800000000",
        name: "Auto debit customer"
      })
    },
    customerAccount: {
      findFirst: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000104",
        phone: "13800000000",
        wechatOpenId: "openid-auto-debit"
      })
    },
    debitAttempt: {
      findUnique: vi.fn().mockResolvedValue({
        bill: {
          billNo: "BIL-AUTO-DEBIT",
          id: billId,
          order: { orderNo: "ORD-AUTO-DEBIT" }
        },
        customerId,
        id: attemptId,
        lastErrorCode: "INSUFFICIENT_FUNDS",
        requestedAmount: 100n,
        retrySlot: DebitRetrySlot.D3,
        status: DebitAttemptStatus.FAILED_FINAL
      })
    },
    notificationEvent: {
      create: vi.fn(async ({ data }) => {
        const event = { ...data, id: data.id };
        events.push(event);
        return event;
      }),
      findUnique: vi.fn(({ where }) =>
        Promise.resolve(events.find((item) => item.id === where.id) ?? null)
      ),
      update: vi.fn(async ({ data, where }) => {
        const event = events.find((item) => item.id === where.id);
        if (!event) {
          throw new Error("notification event missing");
        }
        Object.assign(event, {
          ...data,
          attempts:
            typeof data.attempts === "object"
              ? event.attempts + data.attempts.increment
              : data.attempts
        });
        return event;
      })
    },
    notificationRecord: {
      create: vi.fn(async ({ data }) => {
        const record = {
          ...data,
          id: `record-${records.length + 1}`
        };
        records.push(record);
        return record;
      }),
      findUnique: vi.fn(({ where }) =>
        Promise.resolve(
          records.find(
            (item) => item.id === where.id || item.notificationNo === where.notificationNo
          ) ?? null
        )
      ),
      update: vi.fn(async ({ data, where }) => {
        const record = records.find((item) => item.id === where.id);
        if (!record) {
          throw new Error("notification record missing");
        }
        Object.assign(record, data);
        return record;
      }),
      updateMany: vi.fn(async ({ data, where }) => {
        const record = records.find((item) => item.id === where.id);
        if (!record || !where.notificationStatus.in.includes(record.notificationStatus)) {
          return { count: 0 };
        }
        Object.assign(record, data);
        return { count: 1 };
      })
    },
    notificationTemplate: {
      findFirst: vi.fn(({ where }) =>
        Promise.resolve(templates.find((item) => item.templateCode === where.templateCode) ?? null)
      )
    }
  };
  const provider: NotificationProvider = {
    send: vi.fn().mockResolvedValue({
      providerMessageId: "mock-message",
      providerResponse: { mock: true },
      success: true
    })
  };
  const service = new NotificationService(
    new ConfigService({
      NOTIFICATION_PROVIDER: "mock",
      NOTIFICATION_WECHAT_ENABLED: "false",
      PORTAL_BASE_URL: "https://staging-app.subauto.keybox.cloud"
    }),
    provider,
    prisma as never
  );
  return { events, records, service };
}

function template(templateCode: string, channel: NotificationChannel) {
  return {
    channel,
    content: "Auto debit failed",
    createdAt: new Date(),
    createdBy: null,
    deletedAt: null,
    description: null,
    id: `template-${templateCode}`,
    providerConfig: null,
    providerTemplateId: null,
    templateCode,
    templateStatus: NotificationTemplateStatus.ACTIVE,
    templateType: NotificationTemplateType.AUTO_DEBIT_FAILURE,
    title: "Auto debit failed",
    updatedAt: new Date(),
    updatedBy: null,
    variables: null
  };
}

function failureNoticeJob(): ClaimedBillingAutomationJob {
  const now = new Date("2026-08-05T01:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    billId: "00000000-0000-4000-8000-000000000103",
    billingScheduleId: null,
    changeOrderId: null,
    contractSegmentId: null,
    cancelledAt: null,
    completedAt: null,
    createdAt: now,
    id: "00000000-0000-4000-8000-000000000105",
    idempotencyKey: "debit-failure:00000000-0000-4000-8000-000000000101",
    jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
    jobType: SubscriptionAutomationJobType.SEND_DEBIT_FAILURE_NOTICE,
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date("2026-08-05T01:02:00.000Z"),
    leaseToken: "00000000-0000-4000-8000-000000000106",
    maxAttempts: 6,
    orderId: "00000000-0000-4000-8000-000000000107",
    payload: { debitAttemptId: "00000000-0000-4000-8000-000000000101" },
    renewalConsiderationId: null,
    resultSnapshot: null,
    startedAt: now,
    updatedAt: now
  };
}
