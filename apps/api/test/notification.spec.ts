/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { PermissionCode } from "@subscription-saas/shared";
import {
  CustomerAccountStatus,
  NotificationChannel,
  NotificationEventStatus,
  NotificationEventType,
  NotificationStatus,
  NotificationTemplateStatus,
  NotificationTemplateType,
  NotificationType
} from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { NotificationProcessingResolution } from "../src/notification/dto/notification.dto";
import { NotificationAdminController } from "../src/notification/notification.controller";
import { NotificationModule } from "../src/notification/notification.module";
import { NotificationProvider } from "../src/notification/notification.provider";
import { NotificationService } from "../src/notification/notification.service";
import { WeChatOfficialAccountProvider } from "../src/notification/wechat-official-account.provider";
import { CurrentCustomer } from "../src/portal/portal-auth.types";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotificationModule", () => {
  it("exposes the auto debit failure notification contract", () => {
    expect(NotificationTemplateType.AUTO_DEBIT_FAILURE).toBe(
      "AUTO_DEBIT_FAILURE"
    );
    expect(NotificationType.AUTO_DEBIT_FAILURE).toBe("AUTO_DEBIT_FAILURE");
    expect(NotificationEventType.AUTO_DEBIT_FAILED).toBe("AUTO_DEBIT_FAILED");
  });

  it("compiles with its admin guard dependencies", async () => {
    process.env.CUSTOMER_JWT_SECRET ??= "notification-module-test-secret";
    process.env.DATABASE_URL ??=
      "postgresql://test:test@127.0.0.1:5432/subscription_saas?schema=public";

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), NotificationModule]
    }).compile();

    await moduleRef.close();
  });
});

describe("NotificationAdminController", () => {
  it("requires notification manage permission for uncertain-send disposition", () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        NotificationAdminController.prototype.resolveProcessingRecord
      )
    ).toEqual([PermissionCode.NOTIFICATION_MANAGE]);
  });
});

describe("NotificationService", () => {
  it("reuses the same mileage reminder records and event for a local reminder day", async () => {
    const harness = createNotificationHarness();
    const input = {
      customerId: "customer-a",
      cycleNo: 1,
      idempotencyKey:
        "mileage-review:00000000-0000-4000-8000-000000000010:due:2026-08-03",
      orderNo: "ORD-1",
      reviewId: "00000000-0000-4000-8000-000000000010"
    };

    const first = await harness.service.notifyMileageReviewDue(input);
    const second = await harness.service.notifyMileageReviewDue(input);

    expect(first.map((record) => record.id)).toEqual(
      second.map((record) => record.id)
    );
    expect(harness.records).toHaveLength(2);
    expect(harness.events).toHaveLength(1);
    expect(harness.records[0]).toMatchObject({
      channel: NotificationChannel.IN_APP,
      notificationStatus: NotificationStatus.SENT,
      notificationType: NotificationType.MILEAGE_REVIEW_DUE,
      url: "https://app.subauto.keybox.cloud/portal/mileage-reviews/00000000-0000-4000-8000-000000000010"
    });
  });

  it("reuses the same bill lifecycle records and event across worker retries", async () => {
    const harness = createNotificationHarness();
    const input = {
      aggregateId: "00000000-0000-4000-8000-000000000001",
      aggregateType: "ReceivableBill",
      billId: "00000000-0000-4000-8000-000000000001",
      content: "月租账单将于 2026-08-10 到期。",
      customerId: "customer-a",
      data: {
        aggregateNo: "BIL-1",
        dueDate: "2026-08-10"
      },
      eventType: NotificationEventType.BILL_DUE,
      idempotencyKey: "bill-due-notice:00000000-0000-4000-8000-000000000001",
      notificationType: NotificationType.BILL_DUE,
      title: "月租账单到期提醒",
      url: "/portal/billing"
    };

    const first = await harness.service.notifyBillLifecycle(input);
    const second = await harness.service.notifyBillLifecycle(input);

    expect(first.map((record) => record.id)).toEqual(second.map((record) => record.id));
    expect(harness.records).toHaveLength(2);
    expect(harness.events).toHaveLength(1);
    expect(harness.provider.send).toHaveBeenCalledTimes(1);
  });

  it("retries a failed bill provider send without creating new notification identities", async () => {
    const harness = createNotificationHarness();
    vi.mocked(harness.provider.send)
      .mockResolvedValueOnce({
        errorMessage: "provider unavailable",
        success: false
      })
      .mockResolvedValueOnce({
        providerMessageId: "provider-message-2",
        success: true
      });
    const input = {
      aggregateId: "00000000-0000-4000-8000-000000000002",
      aggregateType: "ReceivableBill",
      billId: "00000000-0000-4000-8000-000000000002",
      content: "月租账单已逾期。",
      customerId: "customer-a",
      eventType: NotificationEventType.BILL_OVERDUE,
      idempotencyKey: "bill-overdue-notice:00000000-0000-4000-8000-000000000002",
      notificationType: NotificationType.BILL_OVERDUE,
      title: "月租账单逾期提醒",
      url: "/portal/billing"
    };

    await expect(harness.service.notifyBillLifecycle(input)).rejects.toThrow(
      "BILL_NOTIFICATION_INCOMPLETE"
    );
    const recordIds = harness.records.map((record) => record.id);

    await expect(harness.service.notifyBillLifecycle(input)).resolves.toHaveLength(2);
    expect(harness.records.map((record) => record.id)).toEqual(recordIds);
    expect(harness.records).toHaveLength(2);
    expect(harness.events).toHaveLength(1);
    expect(harness.provider.send).toHaveBeenCalledTimes(2);
  });

  it("does not resend after provider success when persisting the result fails", async () => {
    const harness = createNotificationHarness();
    harness.prisma.notificationRecord.update.mockRejectedValueOnce(
      new Error("database unavailable after provider success")
    );
    const input = {
      aggregateId: "00000000-0000-4000-8000-000000000003",
      aggregateType: "ReceivableBill",
      billId: "00000000-0000-4000-8000-000000000003",
      content: "月租账单即将到期。",
      customerId: "customer-a",
      eventType: NotificationEventType.BILL_DUE,
      idempotencyKey:
        "bill-due-notice:00000000-0000-4000-8000-000000000003",
      notificationType: NotificationType.BILL_DUE,
      title: "月租账单到期提醒",
      url: "/portal/billing"
    };

    await expect(
      harness.service.notifyBillLifecycle(input)
    ).rejects.toThrow("database unavailable after provider success");
    await expect(
      harness.service.notifyBillLifecycle(input)
    ).rejects.toThrow("BILL_NOTIFICATION_INCOMPLETE");

    expect(harness.provider.send).toHaveBeenCalledTimes(1);
    expect(
      harness.records.find(
        (record) =>
          record.channel ===
          NotificationChannel.WECHAT_OFFICIAL_ACCOUNT
      )
    ).toMatchObject({
      notificationStatus: NotificationStatus.PROCESSING
    });
  });

  it("lets an audited operator resolve an uncertain processing notification", async () => {
    const harness = createNotificationHarness();
    harness.addRecord({
      channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      notificationStatus: NotificationStatus.PROCESSING
    });
    const processing = harness.records[0]!;

    await harness.service.resolveProcessingRecord(
      processing.id,
      {
        reason: "已核对微信渠道回执，确认未发送",
        resolution:
          NotificationProcessingResolution.CONFIRMED_NOT_SENT
      },
      testUser(),
      {
        ipAddress: "127.0.0.1",
        userAgent: "vitest"
      }
    );

    expect(processing).toMatchObject({
      errorMessage: "MANUAL_CONFIRMED_NOT_SENT",
      notificationStatus: NotificationStatus.FAILED
    });
    expect(harness.audits).toEqual([
      expect.objectContaining({
        entityId: processing.id,
        entityType: "notification_record",
        operatorId: testUser().id
      })
    ]);
  });

  it("records a manually confirmed provider success without resending", async () => {
    const harness = createNotificationHarness();
    harness.addRecord({
      channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      notificationStatus: NotificationStatus.PROCESSING,
      sentAt: null
    });
    const processing = harness.records[0]!;

    await harness.service.resolveProcessingRecord(
      processing.id,
      {
        reason: "已核对微信渠道回执，确认发送成功",
        resolution: NotificationProcessingResolution.CONFIRMED_SENT
      },
      testUser(),
      {}
    );

    expect(processing.notificationStatus).toBe(NotificationStatus.SENT);
    expect(processing.sentAt).toBeInstanceOf(Date);
    expect(harness.provider.send).not.toHaveBeenCalled();
  });

  it("creates in-app and mock WeChat notifications for a customer event", async () => {
    const harness = createNotificationHarness();

    const records = await harness.service.notifyCustomer({
      aggregateId: "application-a",
      aggregateType: "Application",
      content: "申请已提交，平台将尽快审核。",
      customerId: "customer-a",
      eventType: NotificationEventType.APPLICATION_SUBMITTED,
      notificationType: NotificationType.APPLICATION_PROGRESS,
      title: "申请已提交",
      url: "/portal/applications/application-a"
    });

    expect(records).toHaveLength(2);
    expect(harness.records).toHaveLength(2);
    expect(harness.records.map((item) => item.channel)).toEqual([
      NotificationChannel.IN_APP,
      NotificationChannel.WECHAT_OFFICIAL_ACCOUNT
    ]);
    expect(
      harness.records.every((item) => item.notificationStatus === NotificationStatus.SENT)
    ).toBe(true);
    expect(harness.provider.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
        recipientOpenId: "openid-a"
      })
    );
    expect(harness.events[0]).toMatchObject({
      eventStatus: NotificationEventStatus.PROCESSED,
      eventType: NotificationEventType.APPLICATION_SUBMITTED
    });
  });

  it("skips WeChat notification when the customer has no bound openid", async () => {
    const harness = createNotificationHarness({ wechatOpenId: null });

    await harness.service.notifyCustomer({
      aggregateId: "contract-a",
      aggregateType: "Contract",
      content: "合同待签署。",
      customerId: "customer-a",
      eventType: NotificationEventType.CONTRACT_PENDING,
      notificationType: NotificationType.CONTRACT_PENDING,
      title: "合同待签署",
      url: "/portal/contracts/contract-a"
    });

    expect(harness.provider.send).not.toHaveBeenCalled();
    expect(harness.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
          errorMessage: "WECHAT_OPENID_MISSING",
          notificationStatus: NotificationStatus.SKIPPED
        })
      ])
    );
  });

  it("records provider failure without throwing or rolling back in-app notification", async () => {
    const harness = createNotificationHarness({
      providerSendResult: {
        errorMessage: "MOCK_FAIL",
        success: false
      }
    });

    await expect(
      harness.service.notifyCustomer({
        aggregateId: "order-a",
        aggregateType: "SubscriptionOrder",
        content: "订单待支付。",
        customerId: "customer-a",
        eventType: NotificationEventType.PAYMENT_PENDING,
        notificationType: NotificationType.PAYMENT_PENDING,
        title: "待支付",
        url: "/portal/orders/order-a"
      })
    ).resolves.toHaveLength(2);

    expect(harness.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: NotificationChannel.IN_APP,
          notificationStatus: NotificationStatus.SENT
        }),
        expect.objectContaining({
          channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
          errorMessage: "MOCK_FAIL",
          notificationStatus: NotificationStatus.FAILED
        })
      ])
    );
  });

  it("skips WeChat service case notifications when the status enum is not approved", async () => {
    const harness = createNotificationHarness({
      config: {
        NOTIFICATION_PROVIDER: "wechat_official_account",
        NOTIFICATION_WECHAT_ENABLED: "true",
        WECHAT_TEMPLATE_SERVICE_CASE_UPDATE: "wechat-service-case-template"
      }
    });

    await harness.service.notifyCustomer({
      aggregateId: "service-case-a",
      aggregateType: "ServiceCase",
      content: "您的服务工单有新的处理进度。",
      customerId: "customer-a",
      data: {
        aggregateNo: "SC202606200711389G2K",
        status: "RESOLVED"
      },
      eventType: NotificationEventType.SERVICE_CASE_UPDATED,
      notificationType: NotificationType.SERVICE_CASE_UPDATE,
      title: "服务工单更新",
      url: "/portal/service-cases/service-case-a"
    });

    expect(harness.provider.send).not.toHaveBeenCalled();
    expect(harness.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: NotificationChannel.IN_APP,
          notificationStatus: NotificationStatus.SENT,
          payload: expect.objectContaining({
            const4: "已解决",
            status: "RESOLVED"
          })
        }),
        expect.objectContaining({
          channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
          errorMessage: "WECHAT_TEMPLATE_CONST4_NOT_APPROVED:已解决",
          notificationStatus: NotificationStatus.SKIPPED,
          payload: expect.objectContaining({
            const4: "已解决",
            status: "RESOLVED"
          })
        })
      ])
    );
  });

  it("sends WeChat service case notifications when the status enum is approved", async () => {
    const harness = createNotificationHarness({
      config: {
        NOTIFICATION_PROVIDER: "wechat_official_account",
        NOTIFICATION_WECHAT_ENABLED: "true",
        WECHAT_TEMPLATE_SERVICE_CASE_UPDATE: "wechat-service-case-template"
      }
    });

    await harness.service.notifyCustomer({
      aggregateId: "service-case-a",
      aggregateType: "ServiceCase",
      content: "您的服务工单有新的处理进度。",
      customerId: "customer-a",
      data: {
        aggregateNo: "SC202606200711389G2K",
        status: "IN_PROGRESS"
      },
      eventType: NotificationEventType.SERVICE_CASE_UPDATED,
      notificationType: NotificationType.SERVICE_CASE_UPDATE,
      title: "服务工单更新",
      url: "/portal/service-cases/service-case-a"
    });

    expect(harness.provider.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          character_string2: "SC202606200711389G2K",
          const3: "事故报案",
          const4: "处理中",
          status: "IN_PROGRESS"
        })
      })
    );
    expect(
      harness.records.find(
        (record) => record.channel === NotificationChannel.WECHAT_OFFICIAL_ACCOUNT
      )
    ).toMatchObject({
      notificationStatus: NotificationStatus.SENT,
      payload: expect.objectContaining({
        const4: "处理中",
        status: "IN_PROGRESS"
      })
    });
  });

  it("lists and marks only the current customer's portal notifications", async () => {
    const harness = createNotificationHarness();
    harness.addRecord({ customerId: "customer-a", id: "record-a", readAt: null, title: "A" });
    harness.addRecord({ customerId: "customer-b", id: "record-b", readAt: null, title: "B" });

    const list = await harness.service.listPortalNotifications(currentCustomer("customer-a"), {});

    expect(list.total).toBe(1);
    expect(list.unreadCount).toBe(1);
    expect(list.items[0]?.notificationId).toBe("record-a");
    await expect(
      harness.service.getPortalNotification("record-b", currentCustomer("customer-a"))
    ).rejects.toBeInstanceOf(NotFoundException);

    const updated = await harness.service.markPortalNotificationRead(
      "record-a",
      currentCustomer("customer-a")
    );
    expect(updated.readAt).toBeTruthy();
    expect(harness.records.find((item) => item.id === "record-a")?.notificationStatus).toBe(
      NotificationStatus.READ
    );
  });

  it("marks all unread portal notifications for the current customer", async () => {
    const harness = createNotificationHarness();
    harness.addRecord({ customerId: "customer-a", id: "record-a", readAt: null });
    harness.addRecord({ customerId: "customer-a", id: "record-b", readAt: null });
    harness.addRecord({ customerId: "customer-b", id: "record-c", readAt: null });

    const result = await harness.service.markAllPortalNotificationsRead(
      currentCustomer("customer-a")
    );

    expect(result.updatedCount).toBe(2);
    expect(
      harness.records
        .filter((item) => item.customerId === "customer-a")
        .every((item) => item.readAt)
    ).toBe(true);
    expect(harness.records.find((item) => item.id === "record-c")?.readAt).toBeNull();
  });
});

describe("WeChatOfficialAccountProvider", () => {
  it("gets access token and sends a template message with mocked HTTP", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "token-a",
          expires_in: 7200
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          errcode: 0,
          errmsg: "ok",
          msgid: "msg-a"
        })
      );
    const provider = new WeChatOfficialAccountProvider(
      new ConfigService({
        NOTIFICATION_WECHAT_ENABLED: "true",
        WECHAT_OFFICIAL_ACCOUNT_APP_ID: "wx-test",
        WECHAT_OFFICIAL_ACCOUNT_APP_SECRET: "secret-test"
      })
    );

    const result = await provider.send({
      channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      data: { first: "合同待签署" },
      providerTemplateId: "template-a",
      recipientOpenId: "openid-a",
      title: "合同待签署",
      url: "https://app.subauto.keybox.cloud/portal/contracts/contract-a"
    });

    expect(result).toMatchObject({ providerMessageId: "msg-a", success: true });
    const tokenUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(tokenUrl.pathname).toBe("/cgi-bin/token");
    expect(tokenUrl.searchParams.get("grant_type")).toBe("client_credential");
    expect(tokenUrl.searchParams.get("appid")).toBe("wx-test");
    expect(tokenUrl.searchParams.get("secret")).toBe("secret-test");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/cgi-bin/message/template/send?access_token=token-a"),
      expect.objectContaining({
        method: "POST"
      })
    );
    const [, sendInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse((sendInit as RequestInit).body as string)).toMatchObject({
      template_id: "template-a",
      touser: "openid-a",
      url: "https://app.subauto.keybox.cloud/portal/contracts/contract-a"
    });
  });

  it("does not call WeChat when disabled", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const provider = new WeChatOfficialAccountProvider(
      new ConfigService({ NOTIFICATION_WECHAT_ENABLED: "false" })
    );

    const result = await provider.send({
      channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      providerTemplateId: "template-a",
      recipientOpenId: "openid-a"
    });

    expect(result).toEqual({
      errorMessage: "WECHAT_OFFICIAL_ACCOUNT_DISABLED",
      success: false
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records numeric WeChat msgid values as provider message IDs", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "token-a",
          expires_in: 7200
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          errcode: 0,
          errmsg: "ok",
          msgid: 200228332
        })
      );
    const provider = new WeChatOfficialAccountProvider(
      new ConfigService({
        NOTIFICATION_WECHAT_ENABLED: "true",
        WECHAT_OFFICIAL_ACCOUNT_APP_ID: "wx-test",
        WECHAT_OFFICIAL_ACCOUNT_APP_SECRET: "secret-test"
      })
    );

    const result = await provider.send({
      channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      providerTemplateId: "template-a",
      recipientOpenId: "openid-a"
    });

    expect(result).toMatchObject({ providerMessageId: "200228332", success: true });
  });

  it("throws a safe error when access token retrieval fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ errcode: 40013 }, false));
    const provider = new WeChatOfficialAccountProvider(
      new ConfigService({
        NOTIFICATION_WECHAT_ENABLED: "true",
        WECHAT_OFFICIAL_ACCOUNT_APP_ID: "wx-test",
        WECHAT_OFFICIAL_ACCOUNT_APP_SECRET: "secret-test"
      })
    );

    await expect(
      provider.send({
        channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
        providerTemplateId: "template-a",
        recipientOpenId: "openid-a"
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

function createNotificationHarness(
  options: {
    config?: Record<string, string>;
    providerSendResult?: {
      errorMessage?: string;
      providerMessageId?: string;
      providerResponse?: unknown;
      success: boolean;
    };
    wechatOpenId?: string | null;
  } = {}
) {
  const audits: any[] = [];
  const events: any[] = [];
  const records: any[] = [];
  const templates = createTemplates();
  const provider: NotificationProvider = {
    send: vi.fn().mockResolvedValue(
      options.providerSendResult ?? {
        providerMessageId: "mock-message",
        providerResponse: { mock: true },
        success: true
      }
    )
  };
  const prisma = {
    $transaction: vi.fn((input: Promise<unknown>[] | ((tx: any) => Promise<unknown>)) =>
      typeof input === "function" ? input(prisma) : Promise.all(input)
    ),
    auditLog: {
      create: vi.fn(({ data }: any) => {
        audits.push(data);
        return Promise.resolve(data);
      })
    },
    customer: {
      findFirst: vi.fn(({ where }: any) =>
        where.id === "customer-a"
          ? Promise.resolve({ id: "customer-a", mobile: "13800000000", name: "测试客户" })
          : Promise.resolve(null)
      )
    },
    customerAccount: {
      findFirst: vi.fn(({ where }: any) =>
        where.customerId === "customer-a"
          ? Promise.resolve({
              id: "account-a",
              phone: "13800000000",
              wechatOpenId: options.wechatOpenId === undefined ? "openid-a" : options.wechatOpenId
            })
          : Promise.resolve(null)
      )
    },
    notificationEvent: {
      create: vi.fn(({ data }: any) => {
        const event = {
          ...data,
          createdAt: new Date(),
          id: data.id ?? `event-${events.length + 1}`,
          updatedAt: new Date()
        };
        events.push(event);
        return Promise.resolve(event);
      }),
      findUnique: vi.fn(({ where }: any) =>
        Promise.resolve(events.find((item) => item.id === where.id) ?? null)
      ),
      update: vi.fn(({ data, where }: any) => {
        const event = events.find((item) => item.id === where.id);
        Object.assign(event, {
          ...data,
          attempts:
            typeof data.attempts === "object"
              ? event.attempts + data.attempts.increment
              : data.attempts
        });
        return Promise.resolve(event);
      })
    },
    notificationRecord: {
      count: vi.fn(({ where }: any) => Promise.resolve(filterRecords(records, where).length)),
      create: vi.fn(({ data }: any) => {
        const record = {
          ...data,
          createdAt: new Date(),
          deletedAt: null,
          id: `record-${records.length + 1}`,
          updatedAt: new Date()
        };
        records.push(record);
        return Promise.resolve(record);
      }),
      findFirst: vi.fn(({ where }: any) =>
        Promise.resolve(filterRecords(records, where)[0] ?? null)
      ),
      findUnique: vi.fn(({ where }: any) =>
        Promise.resolve(
          records.find(
            (record) =>
              (where.id && record.id === where.id) ||
              (where.notificationNo && record.notificationNo === where.notificationNo)
          ) ?? null
        )
      ),
      findMany: vi.fn(({ where }: any) => Promise.resolve(filterRecords(records, where))),
      update: vi.fn(({ data, where }: any) => {
        const record = records.find((item) => item.id === where.id);
        Object.assign(record, data);
        return Promise.resolve(record);
      }),
      updateMany: vi.fn(({ data, where }: any) => {
        const matches = filterRecords(records, where);
        for (const record of matches) {
          Object.assign(record, data);
        }
        return Promise.resolve({ count: matches.length });
      })
    },
    notificationTemplate: {
      count: vi.fn(({ where }: any) => Promise.resolve(filterTemplates(templates, where).length)),
      findFirst: vi.fn(({ where }: any) =>
        Promise.resolve(filterTemplates(templates, where)[0] ?? null)
      ),
      findMany: vi.fn(({ where }: any) => Promise.resolve(filterTemplates(templates, where)))
    }
  };
  const service = new NotificationService(
    new ConfigService({
      NOTIFICATION_PROVIDER: "mock",
      NOTIFICATION_WECHAT_ENABLED: "false",
      PORTAL_BASE_URL: "https://app.subauto.keybox.cloud",
      ...options.config
    }),
    provider,
    prisma as any
  );

  return {
    addRecord(input: Partial<any>) {
      records.push({
        channel: NotificationChannel.IN_APP,
        content: "内容",
        createdAt: new Date(),
        customerId: "customer-a",
        deletedAt: null,
        id: `record-${records.length + 1}`,
        notificationNo: `NTF-${records.length + 1}`,
        notificationStatus: NotificationStatus.SENT,
        notificationType: NotificationType.SYSTEM,
        readAt: null,
        title: "标题",
        updatedAt: new Date(),
        url: null,
        ...input
      });
    },
    audits,
    events,
    prisma,
    provider,
    records,
    service,
    templates
  };
}

function testUser() {
  return {
    id: "00000000-0000-4000-8000-000000000099",
    menus: [],
    name: "运营管理员",
    permissions: [PermissionCode.NOTIFICATION_MANAGE],
    roles: ["OP"],
    username: "operator"
  };
}

function createTemplates() {
  const pairs = [
    [
      "APPLICATION_SUBMITTED_IN_APP",
      NotificationChannel.IN_APP,
      NotificationTemplateType.APPLICATION_PROGRESS
    ],
    [
      "APPLICATION_SUBMITTED_WECHAT",
      NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      NotificationTemplateType.APPLICATION_PROGRESS
    ],
    [
      "CONTRACT_PENDING_IN_APP",
      NotificationChannel.IN_APP,
      NotificationTemplateType.CONTRACT_PENDING
    ],
    [
      "CONTRACT_PENDING_WECHAT",
      NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      NotificationTemplateType.CONTRACT_PENDING
    ],
    [
      "PAYMENT_PENDING_IN_APP",
      NotificationChannel.IN_APP,
      NotificationTemplateType.PAYMENT_PENDING
    ],
    [
      "PAYMENT_PENDING_WECHAT",
      NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      NotificationTemplateType.PAYMENT_PENDING
    ],
    ["BILL_DUE_IN_APP", NotificationChannel.IN_APP, NotificationTemplateType.BILL_DUE],
    [
      "BILL_DUE_WECHAT",
      NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      NotificationTemplateType.BILL_DUE
    ],
    ["BILL_OVERDUE_IN_APP", NotificationChannel.IN_APP, NotificationTemplateType.BILL_OVERDUE],
    [
      "BILL_OVERDUE_WECHAT",
      NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      NotificationTemplateType.BILL_OVERDUE
    ],
    [
      "SERVICE_CASE_UPDATE_IN_APP",
      NotificationChannel.IN_APP,
      NotificationTemplateType.SERVICE_CASE_UPDATE
    ],
    [
      "SERVICE_CASE_UPDATE_WECHAT",
      NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      NotificationTemplateType.SERVICE_CASE_UPDATE
    ],
    [
      "MILEAGE_REVIEW_DUE_IN_APP",
      NotificationChannel.IN_APP,
      NotificationTemplateType.MILEAGE_REVIEW_DUE
    ],
    [
      "MILEAGE_REVIEW_DUE_WECHAT",
      NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      NotificationTemplateType.MILEAGE_REVIEW_DUE
    ]
  ] as const;

  return pairs.map(([templateCode, channel, templateType], index) => ({
    channel,
    content: "content",
    createdAt: new Date(),
    deletedAt: null,
    description: null,
    id: `template-${index + 1}`,
    providerConfig: null,
    providerTemplateId:
      channel === NotificationChannel.WECHAT_OFFICIAL_ACCOUNT ? `wechat-template-${index}` : null,
    templateCode,
    templateStatus: NotificationTemplateStatus.ACTIVE,
    templateType,
    title: templateCode,
    updatedAt: new Date(),
    variables: null
  }));
}

function filterRecords(records: any[], where: any = {}) {
  return records.filter((record) => {
    if (where.id && record.id !== where.id) return false;
    if (where.channel && record.channel !== where.channel) return false;
    if (where.customerId && record.customerId !== where.customerId) return false;
    if (where.deletedAt === null && record.deletedAt !== null) return false;
    if (where.readAt === null && record.readAt !== null) return false;
    if (
      typeof where.notificationStatus === "string" &&
      record.notificationStatus !== where.notificationStatus
    ) {
      return false;
    }
    if (where.notificationStatus?.not && record.notificationStatus === where.notificationStatus.not)
      return false;
    if (
      where.notificationStatus?.in &&
      !where.notificationStatus.in.includes(record.notificationStatus)
    )
      return false;
    return true;
  });
}

function filterTemplates(templates: any[], where: any = {}) {
  return templates.filter((template) => {
    if (where.templateCode && template.templateCode !== where.templateCode) return false;
    if (where.deletedAt === null && template.deletedAt !== null) return false;
    if (where.templateStatus && template.templateStatus !== where.templateStatus) return false;
    return true;
  });
}

function currentCustomer(customerId: string): CurrentCustomer {
  return {
    accountStatus: CustomerAccountStatus.ACTIVE,
    customerAccountId: `account-${customerId}`,
    customerId,
    phone: "13800000000"
  };
}

function jsonResponse(body: Record<string, unknown>, ok = true) {
  return {
    json: () => Promise.resolve(body),
    ok
  } as Response;
}
