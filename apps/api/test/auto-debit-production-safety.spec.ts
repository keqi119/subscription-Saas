import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readAutoDebitConfig } from "../src/auto-debit/auto-debit.config";

const repoRoot = join(__dirname, "..", "..", "..");

describe("auto debit deployment safety", () => {
  it("keeps production disabled and rejects any mock provider selection", () => {
    const production = readEnvironment(".env.production.images.example");

    expect(readAutoDebitConfig(production)).toMatchObject({
      enabled: false,
      environment: "production",
      mockEnabled: false,
      provider: "disabled"
    });
    expect(() =>
      readAutoDebitConfig({
        ...production,
        PAYMENT_MANDATE_MOCK_ENABLED: "true",
        PAYMENT_MANDATE_PROVIDER: "mock"
      })
    ).toThrow("AUTO_DEBIT_MOCK_FORBIDDEN_IN_PRODUCTION");
  });

  it("enables the explicit persistent mock only in staging", () => {
    const staging = readEnvironment(".env.staging.images.example");

    expect(readAutoDebitConfig(staging)).toMatchObject({
      enabled: true,
      environment: "staging",
      mockEnabled: true,
      provider: "mock"
    });
  });

  it("requires an approved template before a real WeChat mandate provider can start", () => {
    const base = {
      APP_ENV: "staging",
      AUTO_DEBIT_ENABLED: "true",
      PAYMENT_MANDATE_MOCK_ENABLED: "false",
      PAYMENT_MANDATE_PROVIDER: "wechat_auto_renew"
    };

    expect(() => readAutoDebitConfig(base)).toThrow(
      "AUTO_DEBIT_WECHAT_TEMPLATE_REQUIRED"
    );
    expect(
      readAutoDebitConfig({
        ...base,
        WECHAT_AUTO_RENEW_TEMPLATE_ID: "approved-template-id"
      })
    ).toMatchObject({ provider: "wechat_auto_renew" });
  });

  it("keeps recurring billing and active payment independent from the auto debit switch", () => {
    const production = readEnvironment(".env.production.images.example");

    expect(production.AUTO_DEBIT_ENABLED).toBe("false");
    expect(production.BILLING_AUTOMATION_WORKER_ENABLED).toBe("true");
    expect(production.PAYMENT_PROVIDER).toBe("wechat_pay");
  });

  it("serializes the PostgreSQL settlement integration with other database suites", () => {
    const vitestConfig = readFileSync(
      join(repoRoot, "apps/api/vitest.config.ts"),
      "utf8"
    );

    expect(vitestConfig).toContain(
      '"test/auto-debit-settlement.integration.spec.ts"'
    );
  });
});

function readEnvironment(file: string) {
  const result: Record<string, string> = {};
  for (const line of readFileSync(join(repoRoot, file), "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator > 0) {
      result[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
    }
  }
  return result;
}
