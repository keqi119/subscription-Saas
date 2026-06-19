/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
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

import { NotificationModule } from "../src/notification/notification.module";
import { NotificationProvider } from "../src/notification/notification.provider";
import { NotificationService } from "../src/notification/notification.service";
import { WeChatOfficialAccountProvider } from "../src/notification/wechat-official-account.provider";
import { CurrentCustomer } from "../src/portal/portal-auth.types";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotificationModule", () => {
  it("compiles with its admin guard dependencies", async () => {
    process.env.CUSTOMER_JWT_SECRET ??= "notification-module-test-secret";
    process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/subscription_saas?schema=public";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        NotificationModule
      ]
    }).compile();

    await moduleRef.close();
  });
});

describe("NotificationService", () => {
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
    expect(harness.records.every((item) => item.notificationStatus === NotificationStatus.SENT)).toBe(true);
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

    const updated = await harness.service.markPortalNotificationRead("record-a", currentCustomer("customer-a"));
    expect(updated.readAt).toBeTruthy();
    expect(harness.records.find((item) => item.id === "record-a")?.notificationStatus).toBe(NotificationStatus.READ);
  });

  it("marks all unread portal notifications for the current customer", async () => {
    const harness = createNotificationHarness();
    harness.addRecord({ customerId: "customer-a", id: "record-a", readAt: null });
    harness.addRecord({ customerId: "customer-a", id: "record-b", readAt: null });
    harness.addRecord({ customerId: "customer-b", id: "record-c", readAt: null });

    const result = await harness.service.markAllPortalNotificationsRead(currentCustomer("customer-a"));

    expect(result.updatedCount).toBe(2);
    expect(harness.records.filter((item) => item.customerId === "customer-a").every((item) => item.readAt)).toBe(true);
    expect(harness.records.find((item) => item.id === "record-c")?.readAt).toBeNull();
  });
});

describe("WeChatOfficialAccountProvider", () => {
  it("gets access token and sends a template message with mocked HTTP", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      access_token: "token-a",
      expires_in: 7200
    })).mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      errmsg: "ok",
      msgid: "msg-a"
    }));
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
    const provider = new WeChatOfficialAccountProvider(new ConfigService({ NOTIFICATION_WECHAT_ENABLED: "false" }));

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
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      access_token: "token-a",
      expires_in: 7200
    })).mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      errmsg: "ok",
      msgid: 200228332
    }));
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

function createNotificationHarness(options: {
  providerSendResult?: { errorMessage?: string; providerMessageId?: string; providerResponse?: unknown; success: boolean };
  wechatOpenId?: string | null;
} = {}) {
  const events: any[] = [];
  const records: any[] = [];
  const templates = createTemplates();
  const provider: NotificationProvider = {
    send: vi.fn().mockResolvedValue(options.providerSendResult ?? {
      providerMessageId: "mock-message",
      providerResponse: { mock: true },
      success: true
    })
  };
  const prisma = {
    $transaction: vi.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
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
          id: `event-${events.length + 1}`,
          updatedAt: new Date()
        };
        events.push(event);
        return Promise.resolve(event);
      }),
      update: vi.fn(({ data, where }: any) => {
        const event = events.find((item) => item.id === where.id);
        Object.assign(event, data);
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
      findFirst: vi.fn(({ where }: any) => Promise.resolve(filterRecords(records, where)[0] ?? null)),
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
      findFirst: vi.fn(({ where }: any) => Promise.resolve(filterTemplates(templates, where)[0] ?? null)),
      findMany: vi.fn(({ where }: any) => Promise.resolve(filterTemplates(templates, where)))
    }
  };
  const service = new NotificationService(
    new ConfigService({
      NOTIFICATION_PROVIDER: "mock",
      NOTIFICATION_WECHAT_ENABLED: "false",
      PORTAL_BASE_URL: "https://app.subauto.keybox.cloud"
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
    events,
    provider,
    records,
    service,
    templates
  };
}

function createTemplates() {
  const pairs = [
    ["APPLICATION_SUBMITTED_IN_APP", NotificationChannel.IN_APP, NotificationTemplateType.APPLICATION_PROGRESS],
    ["APPLICATION_SUBMITTED_WECHAT", NotificationChannel.WECHAT_OFFICIAL_ACCOUNT, NotificationTemplateType.APPLICATION_PROGRESS],
    ["CONTRACT_PENDING_IN_APP", NotificationChannel.IN_APP, NotificationTemplateType.CONTRACT_PENDING],
    ["CONTRACT_PENDING_WECHAT", NotificationChannel.WECHAT_OFFICIAL_ACCOUNT, NotificationTemplateType.CONTRACT_PENDING],
    ["PAYMENT_PENDING_IN_APP", NotificationChannel.IN_APP, NotificationTemplateType.PAYMENT_PENDING],
    ["PAYMENT_PENDING_WECHAT", NotificationChannel.WECHAT_OFFICIAL_ACCOUNT, NotificationTemplateType.PAYMENT_PENDING]
  ] as const;

  return pairs.map(([templateCode, channel, templateType], index) => ({
    channel,
    content: "content",
    createdAt: new Date(),
    deletedAt: null,
    description: null,
    id: `template-${index + 1}`,
    providerConfig: null,
    providerTemplateId: channel === NotificationChannel.WECHAT_OFFICIAL_ACCOUNT ? `wechat-template-${index}` : null,
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
    if (typeof where.notificationStatus === "string" && record.notificationStatus !== where.notificationStatus) {
      return false;
    }
    if (where.notificationStatus?.not && record.notificationStatus === where.notificationStatus.not) return false;
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
