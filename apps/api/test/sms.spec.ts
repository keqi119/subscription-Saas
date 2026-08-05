import { ConfigService } from "@nestjs/config";
import { RenewalReminderSlot, SmsSendStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AliyunSmsClient, AliyunSmsProvider } from "../src/sms/aliyun-sms.provider";
import { MockSmsProvider } from "../src/sms/mock-sms.provider";
import { SmsProvider } from "../src/sms/sms-provider";
import { SmsService } from "../src/sms/sms.service";

describe("MockSmsProvider", () => {
  it("sends a mock sms code without echoing the plaintext code in providerResponse", async () => {
    const provider = new MockSmsProvider();

    const result = await provider.sendCode({
      code: "123456",
      expiresInSeconds: 300,
      phone: "13800000000",
      purpose: "LOGIN"
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("mock");
    expect(JSON.stringify(result.providerResponse)).not.toContain("123456");
  });
});

describe("AliyunSmsProvider", () => {
  it("calls SendSms with phone, sign name, template code, and code template param", async () => {
    const sentRequests: Array<{
      phoneNumbers?: string;
      signName?: string;
      templateCode?: string;
      templateParam?: string;
    }> = [];
    const client: AliyunSmsClient = {
      sendSms: vi.fn(async (request) => {
        sentRequests.push(request);
        return {
          body: {
            bizId: "biz-1",
            code: "OK",
            message: "OK",
            requestId: "request-1"
          }
        };
      })
    };
    const provider = new AliyunSmsProvider(createConfig() as unknown as ConfigService, client);

    const result = await provider.sendCode({
      code: "654321",
      expiresInSeconds: 300,
      phone: "13800000000",
      purpose: "LOGIN"
    });

    expect(client.sendSms).toHaveBeenCalledTimes(1);
    expect(sentRequests[0]).toMatchObject({
      phoneNumbers: "13800000000",
      signName: "TestSign",
      templateCode: "SMS_TEST"
    });
    expect(JSON.parse(sentRequests[0]?.templateParam ?? "{}")).toEqual({ code: "654321" });
    expect(result).toMatchObject({
      provider: "aliyun",
      providerMessageId: "biz-1",
      providerRequestId: "request-1",
      success: true
    });
    expect(JSON.stringify(result.providerResponse)).not.toContain("654321");
  });

  it("maps non-OK SendSms responses to a failed result", async () => {
    const client: AliyunSmsClient = {
      sendSms: vi.fn(async () => ({
        body: {
          code: "isv.BUSINESS_LIMIT_CONTROL",
          message: "业务限流",
          requestId: "request-failed"
        }
      }))
    };
    const provider = new AliyunSmsProvider(createConfig() as unknown as ConfigService, client);

    const result = await provider.sendCode({
      code: "654321",
      expiresInSeconds: 300,
      phone: "13800000000",
      purpose: "LOGIN"
    });

    expect(result).toMatchObject({
      errorCode: "isv.BUSINESS_LIMIT_CONTROL",
      errorMessage: "业务限流",
      providerAcceptance: "REJECTED",
      provider: "aliyun",
      providerRequestId: "request-failed",
      success: false
    });
  });

  it("marks transport failures as unknown acceptance instead of claiming a safe retry", async () => {
    const client: AliyunSmsClient = {
      sendSms: vi.fn(async () => {
        throw new Error("connection closed after request write");
      })
    };
    const provider = new AliyunSmsProvider(
      createConfig() as unknown as ConfigService,
      client
    );

    await expect(provider.sendTemplate({
      idempotencyKey: "customer-sms:esign-task-1:transaction-1",
      phone: "13900000000",
      purpose: "CUSTOMER_HANDOVER_ESIGN_READY",
      templateCode: "SMS_CUSTOMER_READY",
      templateParams: {
        instruction: "Log in to Portal."
      }
    })).resolves.toMatchObject({
      errorCode: "ALIYUN_SMS_SEND_ERROR",
      providerAcceptance: "UNKNOWN",
      success: false
    });
  });

  it("uses the Field business template without template variables", async () => {
    const sentRequests: Array<{
      phoneNumbers?: string;
      signName?: string;
      templateCode?: string;
      templateParam?: string;
    }> = [];
    const client: AliyunSmsClient = {
      sendSms: vi.fn(async (request) => {
        sentRequests.push(request);
        return {
          body: {
            bizId: "biz-field",
            code: "OK",
            message: "Accepted 13800000000 Customer Sensitive Name",
            requestId: "request-field"
          }
        };
      })
    };
    const provider = new AliyunSmsProvider(createConfig() as unknown as ConfigService, client);

    const result = await provider.sendTemplate({
      idempotencyKey: "field-notify:work-order-1:1",
      phone: "13800000000",
      purpose: "FIELD_HANDOVER_ESIGN_READY",
      templateCode: "SMS_FIELD_READY",
      templateParams: {}
    });

    expect(sentRequests).toEqual([
      expect.objectContaining({
        phoneNumbers: "13800000000",
        signName: "TestSign",
        templateCode: "SMS_FIELD_READY",
        templateParam: JSON.stringify({})
      })
    ]);
    expect(sentRequests[0]).not.toHaveProperty("outId");
    expect(result).toMatchObject({
      provider: "aliyun",
      providerMessageId: "biz-field",
      success: true
    });
    expect(JSON.stringify(result.providerResponse)).not.toContain("13800000000");
  });

  it("uses the customer business template without template variables", async () => {
    const sentRequests: Array<{
      templateCode?: string;
      templateParam?: string;
    }> = [];
    const client: AliyunSmsClient = {
      sendSms: vi.fn(async (request) => {
        sentRequests.push(request);
        return {
          body: {
            bizId: "biz-customer",
            code: "OK",
            message: "OK",
            requestId: "request-customer"
          }
        };
      })
    };
    const provider = new AliyunSmsProvider(createConfig() as unknown as ConfigService, client);

    await provider.sendTemplate({
      idempotencyKey: "customer-sms:esign-task-1:transaction-1",
      phone: "13900000000",
      purpose: "CUSTOMER_HANDOVER_ESIGN_READY",
      templateCode: "SMS_CUSTOMER_READY",
      templateParams: {}
    });

    expect(sentRequests).toEqual([
      expect.objectContaining({
        templateCode: "SMS_CUSTOMER_READY",
        templateParam: JSON.stringify({})
      })
    ]);
  });
});

describe("SmsService business templates", () => {
  it("reports CONFIG_MISSING without calling the provider for an unconfigured renewal slot", async () => {
    const harness = createBusinessSmsHarness();

    const result = await harness.service.sendRenewalReminder({
      daysRemaining: 30,
      endDate: "2026-09-02",
      idempotencyKey: "renewal-reminder:consideration-1:D30",
      orderNo: "ORD-1",
      phone: "13800000000",
      plateNo: "沪***81",
      portalPath: "/portal/renewals/consideration-1",
      slot: RenewalReminderSlot.D30
    });

    expect(result).toMatchObject({
      errorCode: "CONFIG_MISSING",
      sendStatus: SmsSendStatus.FAILED,
      success: false
    });
    expect(harness.provider.sendTemplate).not.toHaveBeenCalled();
  });

  it("sends all approved renewal reminder variables with the configured slot template", async () => {
    const harness = createBusinessSmsHarness({
      config: { RENEWAL_REMINDER_D14_TEMPLATE_CODE: "SMS_RENEWAL_D14" }
    });

    await harness.service.sendRenewalReminder({
      daysRemaining: 14,
      endDate: "2026-09-02",
      idempotencyKey: "renewal-reminder:consideration-1:D14",
      orderNo: "ORD-1",
      phone: "13800000000",
      plateNo: "沪***81",
      portalPath: "/portal/renewals/consideration-1",
      slot: RenewalReminderSlot.D14
    });

    expect(harness.provider.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "RENEWAL_REMINDER_D14",
        templateCode: "SMS_RENEWAL_D14",
        templateParams: {
          daysRemaining: "14",
          endDate: "2026-09-02",
          orderNo: "ORD-1",
          plateNo: "沪***81",
          portalPath: "/portal/renewals/consideration-1"
        }
      })
    );
  });

  it("sends expiry and D+1 return lifecycle templates with auditable variables", async () => {
    const harness = createBusinessSmsHarness({
      config: {
        RENEWAL_EXPIRY_RETURN_TEMPLATE_CODE: "SMS_RENEWAL_EXPIRY",
        RENEWAL_RETURN_OVERDUE_D1_TEMPLATE_CODE: "SMS_RENEWAL_RETURN_D1"
      }
    });
    const common = {
      endDate: "2026-09-02",
      orderNo: "ORD-1",
      phone: "13800000000",
      plateNo: "沪***81",
      portalPath: "/portal/orders/order-1"
    };

    await harness.service.sendRenewalExpiryReturn({
      ...common,
      idempotencyKey: "renewal-expiry:order-1:sms"
    });
    await harness.service.sendRenewalReturnOverdueD1({
      ...common,
      idempotencyKey: "renewal-return-d1:order-1:sms"
    });

    expect(harness.provider.sendTemplate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        purpose: "RENEWAL_EXPIRY_RETURN",
        templateCode: "SMS_RENEWAL_EXPIRY",
        templateParams: expect.objectContaining({ daysRemaining: "0" })
      })
    );
    expect(harness.provider.sendTemplate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        purpose: "RENEWAL_RETURN_OVERDUE_D1",
        templateCode: "SMS_RENEWAL_RETURN_D1",
        templateParams: expect.objectContaining({ daysRemaining: "-1" })
      })
    );
  });

  it("exposes missing expiry template configuration without calling the provider", async () => {
    const harness = createBusinessSmsHarness();

    const result = await harness.service.sendRenewalExpiryReturn({
      endDate: "2026-09-02",
      idempotencyKey: "renewal-expiry:order-1:sms",
      orderNo: "ORD-1",
      phone: "13800000000",
      plateNo: "沪***81",
      portalPath: "/portal/orders/order-1"
    });

    expect(result).toMatchObject({
      errorCode: "CONFIG_MISSING",
      sendStatus: SmsSendStatus.FAILED
    });
    expect(harness.provider.sendTemplate).not.toHaveBeenCalled();
  });

  it("sends the approved Field assignment template with the full plate as name", async () => {
    const harness = createBusinessSmsHarness();

    await harness.service.sendStage2FieldAssigned({
      idempotencyKey: "field-assigned:work-order-1:event-1",
      phone: "13900001111",
      plateNo: "沪DGU580"
    });

    expect(harness.provider.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "13900001111",
        purpose: "FIELD_HANDOVER_ASSIGNED",
        templateCode: "SMS_FIELD_ASSIGNED",
        templateParams: { name: "沪DGU580" }
      })
    );
  });

  it.each(["", " ", "沪A12345678901234567890"])(
    "rejects invalid assignment plate %j before calling the provider",
    async (plateNo) => {
      const harness = createBusinessSmsHarness();

      await expect(harness.service.sendStage2FieldAssigned({
        idempotencyKey: "field-assigned:work-order-1:event-1",
        phone: "13900001111",
        plateNo
      })).rejects.toThrow("FIELD_HANDOVER_PLATE_NO_INVALID");
      expect(harness.provider.sendTemplate).not.toHaveBeenCalled();
    }
  );

  it("sends both approved eSign templates without variables", async () => {
    const harness = createBusinessSmsHarness();

    await harness.service.sendStage2FieldReady({
      idempotencyKey: "field-ready:work-order-1:2",
      phone: "13900001111"
    });
    await harness.service.sendStage2CustomerReady({
      idempotencyKey: "customer-ready:task-1:transaction-1",
      phone: "13800002222"
    });

    expect(harness.provider.sendTemplate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ templateParams: {} })
    );
    expect(harness.provider.sendTemplate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ templateParams: {} })
    );
  });

  it("commits a SENDING reservation before invoking the provider", async () => {
    const harness = createBusinessSmsHarness({
      onSend: (logs) => {
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({
          errorCode: "SMS_SEND_IN_PROGRESS",
          sendStatus: SmsSendStatus.SENDING
        });
      }
    });

    await expect(harness.service.sendStage2FieldReady({
      idempotencyKey: "field-notify:work-order-1:1",
      phone: "13800000000"
    })).resolves.toMatchObject({
      sendStatus: SmsSendStatus.SENT
    });
  });

  it("returns the existing SENT log for a duplicate SMS idempotency key", async () => {
    const harness = createBusinessSmsHarness();
    const input = {
      idempotencyKey: "field-notify:work-order-1:1",
      phone: "13800000000"
    };

    const first = await harness.service.sendStage2FieldReady(input);
    const duplicate = await harness.service.sendStage2FieldReady(input);

    expect(first.sendStatus).toBe(SmsSendStatus.SENT);
    expect(duplicate).toEqual(first);
    expect(harness.provider.sendTemplate).toHaveBeenCalledTimes(1);
    expect(harness.logs).toHaveLength(1);
  });

  it("retries only a failed SMS channel", async () => {
    const harness = createBusinessSmsHarness({
      sendResults: [
        {
          errorCode: "TEMPORARY_FAILURE",
          errorMessage: "Temporary provider failure.",
          provider: "mock",
          success: false
        },
        {
          provider: "mock",
          providerMessageId: "mock-retry-success",
          providerResponse: { mock: true },
          success: true
        }
      ]
    });
    const input = {
      idempotencyKey: "customer-sms:esign-task-1:transaction-1",
      phone: "13900000000"
    };

    const failed = await harness.service.sendStage2CustomerReady(input);
    const retried = await harness.service.sendStage2CustomerReady(input);

    expect(failed.sendStatus).toBe(SmsSendStatus.FAILED);
    expect(retried.sendStatus).toBe(SmsSendStatus.SENT);
    expect(retried.sendLogId).toBe(failed.sendLogId);
    expect(harness.provider.sendTemplate).toHaveBeenCalledTimes(2);
    expect(harness.logs).toHaveLength(1);
  });

  it("fails closed after provider acceptance when local finalization fails", async () => {
    const harness = createBusinessSmsHarness({
      failFirstFinalization: true
    });
    const input = {
      idempotencyKey: "customer-sms:esign-task-accepted:transaction-1",
      phone: "13900000000"
    };

    const interrupted =
      await harness.service.sendStage2CustomerReady(input);
    const automaticRetry =
      await harness.service.sendStage2CustomerReady(input);

    expect(interrupted).toMatchObject({
      errorCode: "SMS_PROVIDER_ACCEPTED_FINALIZATION_UNCERTAIN",
      sendStatus: SmsSendStatus.UNCERTAIN,
      success: false
    });
    expect(automaticRetry).toEqual(interrupted);
    expect(harness.provider.sendTemplate).toHaveBeenCalledTimes(1);
    expect(harness.logs).toHaveLength(1);
  });

  it.each([
    SmsSendStatus.SENDING,
    SmsSendStatus.UNCERTAIN
  ])("does not resend an existing %s reservation", async (sendStatus) => {
    const harness = createBusinessSmsHarness({
      existingLog: {
        errorCode: "SMS_SEND_IN_PROGRESS",
        errorMessage: "SMS_SEND_IN_PROGRESS",
        id: "sms-log-in-flight",
        idempotencyKey: "customer-sms:esign-task-in-flight:transaction-1",
        phone: "13900000000",
        phoneMasked: "139****0000",
        provider: "ALIYUN",
        providerMessageId: null,
        providerRequestId: null,
        providerResponse: null,
        purpose: "CUSTOMER_HANDOVER_ESIGN_READY",
        sendStatus
      },
      rejectFirstCreateWithUniqueConflict: true
    });

    const result = await harness.service.sendStage2CustomerReady({
      idempotencyKey: "customer-sms:esign-task-in-flight:transaction-1",
      phone: "13900000000"
    });

    expect(result.sendStatus).toBe(sendStatus);
    expect(result.success).toBe(false);
    expect(harness.provider.sendTemplate).not.toHaveBeenCalled();
  });

  it("reuses the concurrent winner after the SMS idempotency insert conflicts", async () => {
    const harness = createBusinessSmsHarness({
      existingLog: {
        id: "sms-log-winner",
        idempotencyKey: "customer-sms:esign-task-1:transaction-1",
        phone: "13900000000",
        phoneMasked: "139****0000",
        provider: "MOCK",
        providerMessageId: "mock-winner",
        providerRequestId: null,
        providerResponse: { mock: true },
        purpose: "CUSTOMER_HANDOVER_ESIGN_READY",
        sendStatus: SmsSendStatus.SENT
      },
      rejectFirstCreateWithUniqueConflict: true
    });

    const result = await harness.service.sendStage2CustomerReady({
      idempotencyKey: "customer-sms:esign-task-1:transaction-1",
      phone: "13900000000"
    });

    expect(result).toMatchObject({
      providerMessageId: "mock-winner",
      sendLogId: "sms-log-winner",
      sendStatus: SmsSendStatus.SENT,
      success: true
    });
    expect(harness.provider.sendTemplate).not.toHaveBeenCalled();
  });

  it("does not serialize a task token, provider URL, evidence URL, name, mobile, VIN, or plate", async () => {
    const harness = createBusinessSmsHarness();

    const result = await harness.service.sendStage2CustomerReady({
      idempotencyKey: "customer-sms:esign-task-1:transaction-1",
      phone: "13912345678"
    });
    const providerInput = vi.mocked(harness.provider.sendTemplate).mock.calls[0]?.[0];
    const serialized = JSON.stringify({
      providerResponse: result.providerResponse,
      templateParams: providerInput?.templateParams
    });

    expect(providerInput?.templateParams).toEqual({});
    for (const forbidden of [
      "task-token-secret",
      "https://provider.example/sign",
      "https://evidence.example/file",
      "Customer Sensitive Name",
      "13912345678",
      "VIN-SENSITIVE-001",
      "沪A12345"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

function createConfig(overrides: Record<string, string> = {}) {
  return {
    get: <T = string>(key: string) =>
      ({
        ALIYUN_SMS_ACCESS_KEY_ID: "test-access-key-id",
        ALIYUN_SMS_ACCESS_KEY_SECRET: "test-access-key-secret",
        ALIYUN_SMS_ENDPOINT: "dysmsapi.aliyuncs.com",
        ALIYUN_SMS_LOGIN_TEMPLATE_CODE: "SMS_TEST",
        ALIYUN_SMS_SIGN_NAME: "TestSign",
        ALIYUN_SMS_TEMPLATE_CODE_VARIABLE: "code",
        ...overrides
      })[key] as T | undefined
  };
}

function createBusinessSmsHarness(options: {
  config?: Record<string, string>;
  existingLog?: Record<string, unknown>;
  failFirstFinalization?: boolean;
  onSend?: (logs: Array<Record<string, unknown>>) => void;
  rejectFirstCreateWithUniqueConflict?: boolean;
  sendResults?: Array<{
    errorCode?: string;
    errorMessage?: string;
    provider: "aliyun" | "mock";
    providerMessageId?: string;
    providerRequestId?: string;
    providerResponse?: unknown;
    success: boolean;
  }>;
} = {}) {
  type SmsLogRow = Record<string, unknown> & {
    id: string;
    idempotencyKey: null | string;
  };
  const logs: SmsLogRow[] = options.existingLog
    ? [{ ...options.existingLog } as SmsLogRow]
    : [];
  let rejectCreate = options.rejectFirstCreateWithUniqueConflict ?? false;
  const sendResults = [...(options.sendResults ?? [{
    provider: "mock" as const,
    providerMessageId: "mock-business-message",
    providerResponse: { mock: true },
    success: true
  }])];
  const provider: SmsProvider = {
    sendCode: vi.fn(),
    sendTemplate: vi.fn(async () => {
      options.onSend?.(logs);
      return sendResults.shift() ?? {
        provider: "mock" as const,
        providerMessageId: "mock-business-message",
        providerResponse: { mock: true },
        success: true
      };
    })
  };
  let failFirstFinalization = options.failFirstFinalization ?? false;
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
      operation(prisma)
    ),
    smsSendLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (rejectCreate) {
          rejectCreate = false;
          throw Object.assign(new Error("unique conflict"), { code: "P2002" });
        }
        if (logs.some((log) => log.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error("unique conflict"), { code: "P2002" });
        }
        const log = {
          ...data,
          createdAt: new Date("2026-07-27T08:00:00.000Z"),
          id: `sms-log-${logs.length + 1}`
        } as unknown as SmsLogRow;
        logs.push(log);
        return log;
      }),
      findUnique: vi.fn(async ({
        where
      }: {
        where: { id?: string; idempotencyKey?: string };
      }) =>
        logs.find((log) =>
          where.id !== undefined
            ? log.id === where.id
            : log.idempotencyKey === where.idempotencyKey
        ) ?? null
      ),
      updateMany: vi.fn(async ({
        data,
        where
      }: {
        data: Record<string, unknown>;
        where: { id: string; sendStatus?: SmsSendStatus };
      }) => {
        if (
          failFirstFinalization &&
          data.sendStatus === SmsSendStatus.SENT
        ) {
          failFirstFinalization = false;
          throw new Error("simulated local commit interruption");
        }
        const log = logs.find((item) =>
          item.id === where.id &&
          (
            where.sendStatus === undefined ||
            item.sendStatus === where.sendStatus
          )
        );
        if (!log) {
          return { count: 0 };
        }
        Object.assign(log, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({
        data,
        where
      }: {
        data: Record<string, unknown>;
        where: { id: string };
      }) => {
        const log = logs.find((item) => item.id === where.id);
        if (!log) throw new Error("SMS log not found");
        Object.assign(log, data);
        return log;
      })
    }
  };
  const service = new SmsService(
    new ConfigService({
      ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE: "SMS_CUSTOMER_READY",
      ALIYUN_SMS_FIELD_HANDOVER_ASSIGNED_TEMPLATE_CODE: "SMS_FIELD_ASSIGNED",
      ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE: "SMS_FIELD_READY",
      FIELD_OPERATOR_SMS_ENABLED: "true",
      FIELD_OPERATOR_SMS_PROVIDER: "mock",
      PORTAL_SMS_ENABLED: "true",
      PORTAL_SMS_PROVIDER: "mock",
      ...(options.config ?? {})
    }),
    prisma as never,
    provider
  );

  return { logs, prisma, provider, service };
}
