import { PaymentChannel, PaymentProviderType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { readPaymentRuntimeConfig } from "../src/payment/payment-runtime.config";

const PRODUCTION_WECHAT = {
  APP_ENV: "production",
  PAYMENT_DEFAULT_CHANNEL: "WECHAT_JSAPI",
  PAYMENT_MOCK_ENABLED: "false",
  PAYMENT_PROVIDER: "wechat_pay",
  WECHAT_PAY_ENABLED: "true"
} as const;

describe("readPaymentRuntimeConfig", () => {
  it("accepts the exact Production WeChat JSAPI tuple", () => {
    expect(readPaymentRuntimeConfig(PRODUCTION_WECHAT)).toEqual({
      defaultChannel: PaymentChannel.WECHAT_JSAPI,
      environment: "production",
      mockEnabled: false,
      provider: "wechat_pay",
      providerType: PaymentProviderType.WECHAT_PAY,
      wechatPayEnabled: true
    });
  });

  it("rejects a missing Production provider instead of defaulting to Mock", () => {
    expect(() =>
      readPaymentRuntimeConfig({
        ...PRODUCTION_WECHAT,
        PAYMENT_PROVIDER: undefined
      })
    ).toThrow("PAYMENT_RUNTIME_PROVIDER_REQUIRED");
  });

  it("rejects unknown and legacy provider aliases instead of falling through to Mock", () => {
    for (const provider of ["unknown", "wechat-pay", "wechat", "wxpay", "alipay"]) {
      expect(() =>
        readPaymentRuntimeConfig({
          ...PRODUCTION_WECHAT,
          PAYMENT_PROVIDER: provider
        })
      ).toThrow("PAYMENT_RUNTIME_PROVIDER_INVALID");
    }
  });

  it.each([
    ["Mock provider", { PAYMENT_PROVIDER: "mock" }, "PAYMENT_RUNTIME_PRODUCTION_PROVIDER_MUST_BE_WECHAT_PAY"],
    ["Mock enabled", { PAYMENT_MOCK_ENABLED: "true" }, "PAYMENT_RUNTIME_PRODUCTION_MOCK_MUST_BE_DISABLED"],
    [
      "non-JSAPI channel",
      { PAYMENT_DEFAULT_CHANNEL: "MOCK" },
      "PAYMENT_RUNTIME_PRODUCTION_CHANNEL_MUST_BE_WECHAT_JSAPI"
    ],
    [
      "disabled WeChat",
      { WECHAT_PAY_ENABLED: "false" },
      "PAYMENT_RUNTIME_PRODUCTION_WECHAT_PAY_MUST_BE_ENABLED"
    ]
  ])("rejects unsafe Production configuration: %s", (_name, override, errorCode) => {
    expect(() => readPaymentRuntimeConfig({ ...PRODUCTION_WECHAT, ...override })).toThrow(
      errorCode
    );
  });

  it("accepts explicit non-Production Mock mode", () => {
    expect(
      readPaymentRuntimeConfig({
        APP_ENV: "staging",
        PAYMENT_DEFAULT_CHANNEL: "MOCK",
        PAYMENT_MOCK_ENABLED: "true",
        PAYMENT_PROVIDER: "mock",
        WECHAT_PAY_ENABLED: "false"
      })
    ).toEqual({
      defaultChannel: PaymentChannel.MOCK,
      environment: "staging",
      mockEnabled: true,
      provider: "mock",
      providerType: PaymentProviderType.MOCK,
      wechatPayEnabled: false
    });
  });

  it("rejects an explicitly selected non-Production Mock provider when Mock is disabled", () => {
    expect(() =>
      readPaymentRuntimeConfig({
        APP_ENV: "staging",
        PAYMENT_DEFAULT_CHANNEL: "MOCK",
        PAYMENT_MOCK_ENABLED: "false",
        PAYMENT_PROVIDER: "mock",
        WECHAT_PAY_ENABLED: "false"
      })
    ).toThrow("PAYMENT_RUNTIME_MOCK_MUST_BE_ENABLED");
  });

  it("keeps an unconfigured test runtime inert rather than enabling Mock payment", () => {
    expect(readPaymentRuntimeConfig({ NODE_ENV: "test" })).toMatchObject({
      defaultChannel: PaymentChannel.MOCK,
      environment: "test",
      mockEnabled: false,
      provider: "mock",
      providerType: PaymentProviderType.MOCK,
      wechatPayEnabled: false
    });
  });
});
