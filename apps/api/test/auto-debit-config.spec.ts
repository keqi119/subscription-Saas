import { describe, expect, it } from "vitest";

import { readAutoDebitConfig } from "../src/auto-debit/auto-debit.config";

describe("readAutoDebitConfig", () => {
  it("uses the active-payment-only Stage 1 baseline by default", () => {
    expect(readAutoDebitConfig({ NODE_ENV: "development" })).toEqual({
      collectionMode: "ACTIVE_PAYMENT_ONLY",
      enabled: false,
      environment: "development",
      mockEnabled: false,
      provider: "disabled",
      runTime: "09:00",
      wechatTemplateId: null
    });
  });

  it.each([
    { AUTO_DEBIT_ENABLED: "true", PAYMENT_MANDATE_PROVIDER: "disabled" },
    {
      AUTO_DEBIT_ENABLED: "true",
      PAYMENT_MANDATE_MOCK_ENABLED: "true",
      PAYMENT_MANDATE_PROVIDER: "mock"
    },
    {
      AUTO_DEBIT_ENABLED: "true",
      PAYMENT_MANDATE_PROVIDER: "wechat_auto_renew",
      WECHAT_AUTO_RENEW_TEMPLATE_ID: "approved-template-id"
    }
  ])("rejects delegated debit enablement: %o", (environment) => {
    expect(() => readAutoDebitConfig(environment)).toThrow("AUTO_DEBIT_STAGE1_BASELINE_DISABLED");
  });

  it("rejects a dormant non-disabled provider", () => {
    expect(() =>
      readAutoDebitConfig({
        AUTO_DEBIT_ENABLED: "false",
        PAYMENT_MANDATE_MOCK_ENABLED: "true",
        PAYMENT_MANDATE_PROVIDER: "mock"
      })
    ).toThrow("AUTO_DEBIT_STAGE1_PROVIDER_MUST_BE_DISABLED");
  });

  it("rejects the legacy mock safety switch even while disabled", () => {
    expect(() =>
      readAutoDebitConfig({
        AUTO_DEBIT_ENABLED: "false",
        PAYMENT_MANDATE_MOCK_ENABLED: "true",
        PAYMENT_MANDATE_PROVIDER: "disabled"
      })
    ).toThrow("AUTO_DEBIT_STAGE1_MOCK_MUST_BE_DISABLED");
  });

  it("validates the local run time", () => {
    expect(() =>
      readAutoDebitConfig({
        AUTO_DEBIT_RUN_TIME: "25:70",
        NODE_ENV: "development"
      })
    ).toThrow("AUTO_DEBIT_RUN_TIME_INVALID");
  });

  it("reports the Stage 1 baseline before validating retired scheduler settings", () => {
    expect(() =>
      readAutoDebitConfig({
        AUTO_DEBIT_ENABLED: "true",
        AUTO_DEBIT_RUN_TIME: "25:70",
        PAYMENT_MANDATE_PROVIDER: "disabled"
      })
    ).toThrow("AUTO_DEBIT_STAGE1_BASELINE_DISABLED");
  });
});
