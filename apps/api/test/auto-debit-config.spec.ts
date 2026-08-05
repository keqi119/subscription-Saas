import { describe, expect, it } from "vitest";

import { readAutoDebitConfig } from "../src/auto-debit/auto-debit.config";

describe("readAutoDebitConfig", () => {
  it("is disabled and provider-neutral by default", () => {
    expect(readAutoDebitConfig({ NODE_ENV: "development" })).toEqual({
      enabled: false,
      environment: "development",
      mockEnabled: false,
      provider: "disabled",
      runTime: "09:00",
      wechatTemplateId: null
    });
  });

  it("allows an explicitly enabled mock only outside production", () => {
    expect(
      readAutoDebitConfig({
        APP_ENV: "staging",
        AUTO_DEBIT_ENABLED: "true",
        NODE_ENV: "production",
        PAYMENT_MANDATE_MOCK_ENABLED: "true",
        PAYMENT_MANDATE_PROVIDER: "mock"
      })
    ).toMatchObject({
      enabled: true,
      mockEnabled: true,
      provider: "mock"
    });
  });

  it("fails closed when production selects the mock provider", () => {
    expect(() =>
      readAutoDebitConfig({
        APP_ENV: "production",
        AUTO_DEBIT_ENABLED: "true",
        NODE_ENV: "production",
        PAYMENT_MANDATE_MOCK_ENABLED: "true",
        PAYMENT_MANDATE_PROVIDER: "mock"
      })
    ).toThrow("AUTO_DEBIT_MOCK_FORBIDDEN_IN_PRODUCTION");
  });

  it("rejects enabled configurations without a usable provider", () => {
    expect(() =>
      readAutoDebitConfig({
        AUTO_DEBIT_ENABLED: "true",
        NODE_ENV: "staging",
        PAYMENT_MANDATE_PROVIDER: "disabled"
      })
    ).toThrow("AUTO_DEBIT_PROVIDER_REQUIRED");
  });

  it("rejects mock selection without its explicit safety switch", () => {
    expect(() =>
      readAutoDebitConfig({
        AUTO_DEBIT_ENABLED: "true",
        NODE_ENV: "staging",
        PAYMENT_MANDATE_MOCK_ENABLED: "false",
        PAYMENT_MANDATE_PROVIDER: "mock"
      })
    ).toThrow("AUTO_DEBIT_MOCK_NOT_ENABLED");
  });

  it("validates the local run time", () => {
    expect(() =>
      readAutoDebitConfig({
        AUTO_DEBIT_RUN_TIME: "25:70",
        NODE_ENV: "development"
      })
    ).toThrow("AUTO_DEBIT_RUN_TIME_INVALID");
  });
});
