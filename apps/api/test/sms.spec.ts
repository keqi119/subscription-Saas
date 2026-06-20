import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";

import { AliyunSmsClient, AliyunSmsProvider } from "../src/sms/aliyun-sms.provider";
import { MockSmsProvider } from "../src/sms/mock-sms.provider";

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
      provider: "aliyun",
      providerRequestId: "request-failed",
      success: false
    });
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
