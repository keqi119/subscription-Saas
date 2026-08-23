import { PaymentChannel, PaymentProviderType } from "@prisma/client";

export type PaymentProviderName = "mock" | "wechat_pay";

export interface PaymentRuntimeConfig {
  defaultChannel: PaymentChannel;
  environment: string;
  mockEnabled: boolean;
  provider: PaymentProviderName;
  providerType: PaymentProviderType;
  wechatPayEnabled: boolean;
}

interface ConfigReader {
  get<T = string>(key: string): T | undefined;
}

export function readPaymentRuntimeConfig(
  environment: Record<string, string | undefined>
): PaymentRuntimeConfig {
  const runtimeEnvironment =
    normalize(environment.APP_ENV) || normalize(environment.NODE_ENV) || "development";
  const production = runtimeEnvironment === "production";
  const rawProvider = normalize(environment.PAYMENT_PROVIDER);
  if (production && !rawProvider) {
    throw new Error("PAYMENT_RUNTIME_PROVIDER_REQUIRED");
  }
  if (rawProvider && rawProvider !== "mock" && rawProvider !== "wechat_pay") {
    throw new Error("PAYMENT_RUNTIME_PROVIDER_INVALID");
  }

  const provider = (rawProvider || "mock") as PaymentProviderName;
  const mockEnabled = booleanValue(environment.PAYMENT_MOCK_ENABLED);
  const wechatPayEnabled = booleanValue(environment.WECHAT_PAY_ENABLED);
  const channelName =
    normalize(environment.PAYMENT_DEFAULT_CHANNEL)?.toUpperCase() ||
    (production ? "MOCK" : provider === "wechat_pay" ? "WECHAT_JSAPI" : "MOCK");
  const defaultChannel = Object.values(PaymentChannel).includes(channelName as PaymentChannel)
    ? (channelName as PaymentChannel)
    : null;

  if (production && provider !== "wechat_pay") {
    throw new Error("PAYMENT_RUNTIME_PRODUCTION_PROVIDER_MUST_BE_WECHAT_PAY");
  }
  if (production && mockEnabled) {
    throw new Error("PAYMENT_RUNTIME_PRODUCTION_MOCK_MUST_BE_DISABLED");
  }
  if (production && defaultChannel !== PaymentChannel.WECHAT_JSAPI) {
    throw new Error("PAYMENT_RUNTIME_PRODUCTION_CHANNEL_MUST_BE_WECHAT_JSAPI");
  }
  if (production && !wechatPayEnabled) {
    throw new Error("PAYMENT_RUNTIME_PRODUCTION_WECHAT_PAY_MUST_BE_ENABLED");
  }
  if (!defaultChannel) {
    throw new Error("PAYMENT_RUNTIME_CHANNEL_INVALID");
  }
  if (
    (provider === "mock" && defaultChannel !== PaymentChannel.MOCK) ||
    (provider === "wechat_pay" && defaultChannel !== PaymentChannel.WECHAT_JSAPI)
  ) {
    throw new Error("PAYMENT_RUNTIME_CHANNEL_PROVIDER_MISMATCH");
  }
  if (provider === "wechat_pay" && !wechatPayEnabled) {
    throw new Error("PAYMENT_RUNTIME_WECHAT_PAY_MUST_BE_ENABLED");
  }
  if (provider !== "mock" && mockEnabled) {
    throw new Error("PAYMENT_RUNTIME_MOCK_PROVIDER_MISMATCH");
  }
  if (rawProvider === "mock" && !mockEnabled) {
    throw new Error("PAYMENT_RUNTIME_MOCK_MUST_BE_ENABLED");
  }

  return {
    defaultChannel,
    environment: runtimeEnvironment,
    mockEnabled,
    provider,
    providerType:
      provider === "wechat_pay" ? PaymentProviderType.WECHAT_PAY : PaymentProviderType.MOCK,
    wechatPayEnabled
  };
}

export function readPaymentRuntimeConfigFromConfig(config: ConfigReader) {
  return readPaymentRuntimeConfig({
    APP_ENV: config.get<string>("APP_ENV"),
    NODE_ENV: config.get<string>("NODE_ENV"),
    PAYMENT_DEFAULT_CHANNEL: config.get<string>("PAYMENT_DEFAULT_CHANNEL"),
    PAYMENT_MOCK_ENABLED: config.get<string>("PAYMENT_MOCK_ENABLED"),
    PAYMENT_PROVIDER: config.get<string>("PAYMENT_PROVIDER"),
    WECHAT_PAY_ENABLED: config.get<string>("WECHAT_PAY_ENABLED")
  });
}

function booleanValue(value?: string) {
  return normalize(value) === "true";
}

function normalize(value?: string) {
  return value?.trim().toLowerCase();
}
