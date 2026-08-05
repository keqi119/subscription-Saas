import {
  NotificationStatus,
  RenewalConsiderationStatus,
  RenewalReminderSlot,
  RenewalReminderStatus,
  SmsSendStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { RenewalConsiderationService } from "../src/subscription-change/renewal-consideration.service";

describe("renewal reminder channel results", () => {
  it("keeps the in-app success when the SMS template is not configured", async () => {
    const harness = reminderHarness();

    const result = await harness.service.dispatchReminder(
      "consideration-1",
      RenewalReminderSlot.D30,
      new Date("2026-08-03T01:00:00.000Z")
    );

    expect(result).toMatchObject({
      channelResult: {
        inApp: { status: NotificationStatus.SENT },
        sms: { errorCode: "CONFIG_MISSING", status: SmsSendStatus.FAILED }
      },
      inAppStatus: NotificationStatus.SENT,
      smsStatus: SmsSendStatus.FAILED,
      status: RenewalReminderStatus.FAILED
    });
  });

  it("skips reminder delivery after a customer expiry decision", async () => {
    const harness = reminderHarness({ status: RenewalConsiderationStatus.EXPIRY_CONFIRMED });

    await expect(
      harness.service.dispatchReminder(
        "consideration-1",
        RenewalReminderSlot.D14,
        new Date("2026-08-19T01:00:00.000Z")
      )
    ).resolves.toMatchObject({ status: RenewalReminderStatus.SKIPPED_DECIDED });
    expect(harness.notification.notifyRenewalReminderInApp).not.toHaveBeenCalled();
  });

  it("skips a reminder already claimed when the customer has chosen renewal", async () => {
    const harness = reminderHarness({ status: RenewalConsiderationStatus.RENEWAL_REQUESTED });

    await expect(
      harness.service.dispatchReminder(
        "consideration-1",
        RenewalReminderSlot.D14,
        new Date("2026-08-19T01:00:00.000Z")
      )
    ).resolves.toMatchObject({ status: RenewalReminderStatus.SKIPPED_DECIDED });
    expect(harness.notification.notifyRenewalReminderInApp).not.toHaveBeenCalled();
    expect(harness.sms.sendRenewalReminder).not.toHaveBeenCalled();
  });

  it("never sends a reminder after a concurrent customer decision commits", async () => {
    const harness = reminderHarness();
    const events: string[] = [];
    let releaseInApp: () => void = () => {};
    let notifyStarted: () => void = () => {};
    const notificationStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const continueNotification = new Promise<void>((resolve) => {
      releaseInApp = resolve;
    });
    harness.notification.notifyRenewalReminderInApp.mockImplementationOnce(async () => {
      notifyStarted();
      await continueNotification;
      return {
        event: { id: "event-1" },
        record: { id: "notification-1", notificationStatus: NotificationStatus.SENT }
      };
    });
    harness.sms.sendRenewalReminder.mockImplementationOnce(async () => {
      events.push("send");
      return {
        provider: "mock",
        sendLogId: "sms-log-1",
        sendStatus: SmsSendStatus.SENT,
        success: true,
        templateCode: "SMS_RENEWAL_D14"
      };
    });

    const dispatch = harness.service.dispatchReminder(
      "consideration-1",
      RenewalReminderSlot.D14,
      new Date("2026-08-19T01:00:00.000Z")
    );
    await notificationStarted;
    const decision = harness.prisma.$transaction(async () => {
      harness.consideration.status = RenewalConsiderationStatus.RENEWAL_REQUESTED;
      events.push("decision");
    });
    await Promise.resolve();
    releaseInApp();
    await Promise.all([dispatch, decision]);

    expect(events).toEqual(["send", "decision"]);
  });

  it("retries the same slot and idempotency key after SMS configuration is fixed", async () => {
    const harness = reminderHarness();
    await harness.service.dispatchReminder(
      "consideration-1",
      RenewalReminderSlot.D30,
      new Date("2026-08-03T01:00:00.000Z")
    );
    harness.sms.sendRenewalReminder.mockResolvedValueOnce({
      provider: "mock",
      sendLogId: "sms-log-1",
      sendStatus: SmsSendStatus.SENT,
      success: true,
      templateCode: "SMS_RENEWAL_D30"
    });

    const result = await harness.service.retryReminder(
      "consideration-1",
      RenewalReminderSlot.D30,
      user()
    );

    expect(result.status).toBe(RenewalReminderStatus.SENT);
    expect(harness.sms.sendRenewalReminder).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idempotencyKey: "renewal-reminder:consideration-1:D30",
        slot: RenewalReminderSlot.D30
      })
    );
  });
});

function reminderHarness(options: { status?: RenewalConsiderationStatus } = {}) {
  const reminder = {
    id: "reminder-D30",
    renewalConsiderationId: "consideration-1",
    scheduledAt: new Date("2026-08-03T01:00:00.000Z"),
    slot: RenewalReminderSlot.D30,
    status: RenewalReminderStatus.PENDING
  } as Record<string, unknown>;
  const reminders = [
    reminder,
    {
      ...reminder,
      id: "reminder-D14",
      scheduledAt: new Date("2026-08-19T01:00:00.000Z"),
      slot: RenewalReminderSlot.D14
    },
    {
      ...reminder,
      id: "reminder-D3",
      scheduledAt: new Date("2026-08-30T01:00:00.000Z"),
      slot: RenewalReminderSlot.D3
    }
  ];
  const consideration = {
    completionDeadlineAt: new Date("2026-09-02T16:00:00.000Z"),
    id: "consideration-1",
    order: {
      customer: { mobile: "13800138000" },
      customerId: "customer-1",
      id: "order-1",
      orderNo: "ORD-1",
      vehicle: { plateNo: "沪DGU581" }
    },
    reminders,
    segment: { endDate: new Date("2026-09-02T00:00:00.000Z") },
    status: options.status ?? RenewalConsiderationStatus.PENDING_DECISION
  };
  let transactionTail = Promise.resolve();
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => {
      const previous = transactionTail;
      let release: () => void = () => {};
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation(prisma);
      } finally {
        release();
      }
    }),
    renewalConsideration: { findUnique: vi.fn(async () => consideration) },
    renewalReminder: {
      update: vi.fn(
        async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
          const target = reminders.find((item) => item.id === where.id)!;
          Object.assign(target, data);
          return target;
        }
      ),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(reminder, data);
        return { count: 1 };
      })
    }
  };
  const notification = {
    notifyRenewalReminderInApp: vi.fn(async () => ({
      event: { id: "event-1" },
      record: { id: "notification-1", notificationStatus: NotificationStatus.SENT }
    }))
  };
  const sms = {
    sendRenewalReminder: vi.fn(
      async (): Promise<{
        errorCode?: string;
        provider: "mock";
        sendLogId?: string;
        sendStatus: SmsSendStatus;
        success: boolean;
        templateCode?: string;
      }> => ({
        errorCode: "CONFIG_MISSING",
        provider: "mock",
        sendStatus: SmsSendStatus.FAILED,
        success: false
      })
    )
  };
  const service = new RenewalConsiderationService(
    prisma as never,
    { enqueue: vi.fn() } as never,
    notification as never,
    sms as never,
    { write: vi.fn() } as never,
    { enabled: true, now: () => new Date("2026-08-03T01:00:00.000Z"), quoteValidityHours: 72 }
  );
  return { consideration, notification, prisma, service, sms };
}

function user() {
  return {
    id: "admin-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: ["ADMIN"],
    username: "admin"
  };
}
