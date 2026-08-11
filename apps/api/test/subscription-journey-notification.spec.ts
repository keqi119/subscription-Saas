import { ConfigService } from "@nestjs/config";
import {
  NotificationChannel,
  NotificationEventType,
  NotificationStatus,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStepCode
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { NotificationService } from "../src/notification/notification.service";
import { SubscriptionJourneyHandlers } from "../src/subscription-journey/subscription-journey.handlers";
import { SubscriptionJourneyNotificationService } from "../src/subscription-journey/subscription-journey-notification.service";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";
import type { ClaimedJourneyJob } from "../src/subscription-journey/subscription-journey.types";

describe("SubscriptionJourneyNotificationService", () => {
  it.each([
    [
      SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
      NotificationEventType.FINAL_PLAN_READY,
      "/portal/applications/application-1",
      { applicationNo: "APP-1", plateNo: "沪PLAN1" },
      { aggregateId: "application-1", aggregateType: "Application" }
    ],
    [
      SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
      NotificationEventType.CONTRACT_PENDING,
      "/portal/contracts/contract-1/sign",
      { modelDisplayName: "NIO ES6 2024款", orderNo: "ORD-1", plateNo: "沪ORDER1" },
      { aggregateId: "order-1", aggregateType: "SubscriptionOrder" }
    ],
    [
      SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT,
      NotificationEventType.PAYMENT_PENDING,
      "/portal/orders/order-1#bills",
      {
        hasDepositBill: true,
        initialBillAmountCents: "540000",
        initialBillDueAt: "2026-08-12T10:30:00.000Z",
        initialBillRemainingCents: "440000",
        plateNo: "沪ORDER1"
      },
      { aggregateId: "order-1", aggregateType: "SubscriptionOrder" }
    ],
    [
      SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION,
      NotificationEventType.HANDOVER_ESIGN_PENDING,
      "/portal/orders/order-1",
      { modelDisplayName: "NIO ES6 2024款", orderNo: "ORD-1", plateNo: "沪ORDER1" },
      { aggregateId: "order-1", aggregateType: "SubscriptionOrder" }
    ]
  ] as const)(
    "sends the sanitized %s customer action once",
    async (stepCode, eventType, url, expectedData, expectedAggregate) => {
      const harness = notificationHarness();

      await expect(harness.service.dispatch(notificationJob(stepCode))).resolves.toMatchObject({
        action: "NOTIFIED"
      });

      expect(harness.notifyCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          ...expectedAggregate,
          customerId: "customer-1",
          eventType,
          idempotencyKey: expect.stringContaining("journey:event:customer-1:"),
          requireWechatSuccess: true,
          url,
          data: expect.objectContaining(expectedData)
        })
      );
      expect(harness.notifyCustomer).not.toHaveBeenCalledWith(
        expect.objectContaining({ aggregateId: "journey-1" })
      );
      const input = harness.notifyCustomer.mock.calls[0]?.[0];
      expect(JSON.stringify(input)).not.toMatch(/signUrl|prepay|openid|providerPayload|secret/i);
    }
  );

  it("rejects a post-order notification when the order aggregate is missing", async () => {
    const harness = notificationHarness({}, [], { order: null });

    await expect(
      harness.service.dispatch(
        notificationJob(SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE)
      )
    ).rejects.toMatchObject({ code: "JOURNEY_INVALID_TRANSITION" });
    expect(harness.notifyCustomer).not.toHaveBeenCalled();
  });

  it("uses a retryable delivery failure when the final vehicle has no usable plate", async () => {
    const harness = notificationHarness({}, [], { finalVehicle: null });

    await expect(
      harness.service.dispatch(
        notificationJob(SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION)
      )
    ).rejects.toMatchObject({
      code: "JOURNEY_NOTIFICATION_DELIVERY_FAILED",
      retryable: true
    });
    expect(harness.notifyCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ plateNo: undefined })
      })
    );
  });

  it("passes missing initial bills to the notification fail-closed boundary", async () => {
    const harness = notificationHarness({}, [], {
      order: { receivableBills: [] }
    });

    await expect(
      harness.service.dispatch(
        notificationJob(SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT)
      )
    ).rejects.toMatchObject({
      code: "JOURNEY_NOTIFICATION_DELIVERY_FAILED",
      retryable: true
    });
    expect(harness.notifyCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          initialBillAmountCents: undefined,
          initialBillDueAt: undefined,
          initialBillRemainingCents: undefined
        })
      })
    );
  });

  it("fails closed on a non-official-account production provider", async () => {
    const harness = notificationHarness({
      NODE_ENV: "production",
      NOTIFICATION_PROVIDER: "mock"
    });

    await expect(
      harness.service.dispatch(notificationJob(SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION))
    ).rejects.toMatchObject({ code: "JOURNEY_CONFIGURATION_ERROR", retryable: false });
    expect(harness.notifyCustomer).not.toHaveBeenCalled();
  });

  it("raises a retryable notification-only failure when WeChat delivery fails", async () => {
    const harness = notificationHarness({}, []);

    await expect(
      harness.service.dispatch(notificationJob(SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT))
    ).rejects.toMatchObject({
      code: "JOURNEY_NOTIFICATION_DELIVERY_FAILED",
      retryable: true
    });
  });

  it("delegates DISPATCH_NOTIFICATION jobs without invoking a domain handler", async () => {
    const notification = { dispatch: vi.fn(async () => ({ action: "NOTIFIED" })) };
    const handlers = new SubscriptionJourneyHandlers(
      {} as SubscriptionJourneyService,
      notification as never
    );
    const job = notificationJob(SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION);

    await expect(handlers.handle(job)).resolves.toEqual({ action: "NOTIFIED" });
    expect(notification.dispatch).toHaveBeenCalledWith(job);
  });
});

function notificationHarness(
  config: Record<string, string> = {},
  records: Array<Record<string, unknown>> = [
    {
      channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      notificationStatus: NotificationStatus.SENT
    }
  ],
  options: {
    finalVehicle?: { plateNo: string | null } | null;
    order?: { receivableBills?: Array<Record<string, unknown>> } | null;
  } = {}
) {
  const notifyCustomer = vi.fn(async (input: Record<string, unknown>) => {
    void input;
    return records;
  });
  const defaultOrder = {
    contractId: "contract-1",
    id: "order-1",
    modelDisplayNameSnapshot: "NIO ES6 2024款",
    orderNo: "ORD-1",
    receivableBills: [
      {
        amount: 300000n,
        billType: "DEPOSIT",
        dueDate: new Date("2026-08-12T10:30:00.000Z"),
        remainingAmount: 200000n
      },
      {
        amount: 240000n,
        billType: "FIRST_MONTHLY_FEE",
        dueDate: new Date("2026-08-13T10:30:00.000Z"),
        remainingAmount: 240000n
      }
    ],
    vehicle: { plateNo: "沪ORDER1" }
  };
  const prisma = {
    subscriptionJourney: {
      findUnique: vi.fn(async () => ({
        application: {
          applicationNo: "APP-1",
          customerId: "customer-1",
          finalVehicleId: "vehicle-plan-1",
          finalPlanRevision: 3,
          id: "application-1"
        },
        order:
          options.order === null
            ? null
            : {
                ...defaultOrder,
                ...(options.order ?? {}),
                receivableBills:
                  options.order?.receivableBills ?? defaultOrder.receivableBills
              }
      }))
    },
    vehicle: {
      findUnique: vi.fn(async () =>
        options.finalVehicle === undefined ? { plateNo: "沪PLAN1" } : options.finalVehicle
      )
    }
  };
  const service = new SubscriptionJourneyNotificationService(
    new ConfigService({
      NODE_ENV: "test",
      NOTIFICATION_PROVIDER: "mock",
      ...config
    }),
    { notifyCustomer } as unknown as NotificationService,
    prisma as never
  );
  return { notifyCustomer, service };
}

function notificationJob(stepCode: SubscriptionJourneyStepCode): ClaimedJourneyJob {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    completedAt: null,
    createdAt: now,
    id: "notification-job-1",
    jobType: SubscriptionJourneyJobType.DISPATCH_NOTIFICATION,
    journeyId: "journey-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date(now.getTime() + 120_000),
    leaseToken: "lease-1",
    maxAttempts: 5,
    payload: {
      eventKey: "journey:event",
      finalPlanRevision: 3,
      stepCode
    },
    sourceKey: "journey:journey-1:notification:source-1",
    status: SubscriptionJourneyJobStatus.PROCESSING,
    stepId: "step-1",
    updatedAt: now
  };
}
