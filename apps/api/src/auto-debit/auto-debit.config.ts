import { PaymentMandateProviderName } from "./auto-debit-provider";
import {
  STAGE1_AUTO_DEBIT_DISABLED_CODE,
  STAGE1_COLLECTION_MODE
} from "./auto-debit.policy";

export interface AutoDebitConfig {
  enabled: boolean;
  environment: string;
  mockEnabled: boolean;
  provider: PaymentMandateProviderName;
  runTime: string;
  wechatTemplateId: string | null;
}

export interface Stage1AutoDebitRuntimeConfig extends AutoDebitConfig {
  collectionMode: typeof STAGE1_COLLECTION_MODE;
  enabled: false;
  mockEnabled: false;
  provider: "disabled";
}

export function readAutoDebitConfig(
  environment: Record<string, string | undefined>
): Stage1AutoDebitRuntimeConfig {
  const nodeEnvironment =
    normalize(environment.APP_ENV) || normalize(environment.NODE_ENV) || "development";
  const enabled = booleanValue(environment.AUTO_DEBIT_ENABLED);
  if (enabled) {
    throw new Error(STAGE1_AUTO_DEBIT_DISABLED_CODE);
  }
  const provider = providerName(environment.PAYMENT_MANDATE_PROVIDER);
  const mockEnabled = booleanValue(environment.PAYMENT_MANDATE_MOCK_ENABLED);
  if (provider !== "disabled") {
    throw new Error("AUTO_DEBIT_STAGE1_PROVIDER_MUST_BE_DISABLED");
  }
  if (mockEnabled) {
    throw new Error("AUTO_DEBIT_STAGE1_MOCK_MUST_BE_DISABLED");
  }
  const runTime = normalize(environment.AUTO_DEBIT_RUN_TIME) || "09:00";
  if (!isValidLocalTime(runTime)) {
    throw new Error("AUTO_DEBIT_RUN_TIME_INVALID");
  }

  return {
    collectionMode: STAGE1_COLLECTION_MODE,
    enabled: false,
    environment: nodeEnvironment,
    mockEnabled: false,
    provider: "disabled",
    runTime,
    wechatTemplateId: null
  };
}

function providerName(value?: string): PaymentMandateProviderName {
  const normalized = normalize(value) || "disabled";
  if (normalized !== "disabled" && normalized !== "mock" && normalized !== "wechat_auto_renew") {
    throw new Error("AUTO_DEBIT_PROVIDER_INVALID");
  }
  return normalized;
}

function booleanValue(value?: string) {
  return normalize(value) === "true";
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
