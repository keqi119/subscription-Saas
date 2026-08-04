import { PaymentMandateProviderName } from "./auto-debit-provider";

export interface AutoDebitConfig {
  enabled: boolean;
  environment: string;
  mockEnabled: boolean;
  provider: PaymentMandateProviderName;
  runTime: string;
  wechatTemplateId: string | null;
}

export function readAutoDebitConfig(
  environment: Record<string, string | undefined>
): AutoDebitConfig {
  const nodeEnvironment =
    normalize(environment.APP_ENV) ||
    normalize(environment.NODE_ENV) ||
    "development";
  const provider = providerName(environment.PAYMENT_MANDATE_PROVIDER);
  const enabled = booleanValue(environment.AUTO_DEBIT_ENABLED);
  const mockEnabled = booleanValue(environment.PAYMENT_MANDATE_MOCK_ENABLED);
  const runTime = normalize(environment.AUTO_DEBIT_RUN_TIME) || "09:00";
  const wechatTemplateId = configuredValue(
    environment.WECHAT_AUTO_RENEW_TEMPLATE_ID
  );

  if (!isValidLocalTime(runTime)) {
    throw new Error("AUTO_DEBIT_RUN_TIME_INVALID");
  }
  if (nodeEnvironment === "production" && provider === "mock") {
    throw new Error("AUTO_DEBIT_MOCK_FORBIDDEN_IN_PRODUCTION");
  }
  if (provider === "mock" && !mockEnabled) {
    throw new Error("AUTO_DEBIT_MOCK_NOT_ENABLED");
  }
  if (enabled && provider === "disabled") {
    throw new Error("AUTO_DEBIT_PROVIDER_REQUIRED");
  }
  if (enabled && provider === "wechat_auto_renew" && !wechatTemplateId) {
    throw new Error("AUTO_DEBIT_WECHAT_TEMPLATE_REQUIRED");
  }

  return {
    enabled,
    environment: nodeEnvironment,
    mockEnabled,
    provider,
    runTime,
    wechatTemplateId
  };
}

function providerName(value?: string): PaymentMandateProviderName {
  const normalized = normalize(value) || "disabled";
  if (
    normalized !== "disabled" &&
    normalized !== "mock" &&
    normalized !== "wechat_auto_renew"
  ) {
    throw new Error("AUTO_DEBIT_PROVIDER_INVALID");
  }
  return normalized;
}

function booleanValue(value?: string) {
  return normalize(value) === "true";
}

function configuredValue(value?: string) {
  const normalized = value?.trim();
  if (!normalized || normalized === "<CHANGE_ME>") {
    return null;
  }
  return normalized;
}

function normalize(value?: string) {
  return value?.trim().toLowerCase();
}

function isValidLocalTime(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}
