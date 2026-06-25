import { ConfigService } from "@nestjs/config";

import { FadadaConfig, FadadaEnv } from "./fadada.types";

const DEFAULT_API_VERSION = "2.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

export function loadFadadaConfig(configService: ConfigService): FadadaConfig {
  const baseUrl = requiredValue(configService, "FADADA_BASE_URL");
  const appId = requiredValue(configService, "FADADA_APP_ID");
  const appSecret = requiredValue(configService, "FADADA_APP_SECRET");
  const missing = [
    ["FADADA_BASE_URL", baseUrl],
    ["FADADA_APP_ID", appId],
    ["FADADA_APP_SECRET", appSecret]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`FADADA_CONFIG_MISSING: ${missing.join(", ")}`);
  }

  return {
    apiVersion: trimmed(configService.get<string>("FADADA_API_VERSION")) ?? DEFAULT_API_VERSION,
    appId: appId!,
    appSecret: appSecret!,
    authPersonCustomerId: trimmed(configService.get<string>("FADADA_AUTH_PERSON_CUSTOMER_ID")),
    baseUrl: normalizeBaseUrl(baseUrl!),
    enabled: parseBoolean(configService.get<string>("FADADA_ENABLED"), false),
    env: parseFadadaEnv(configService.get<string>("FADADA_ENV")),
    platformCustomerId: trimmed(configService.get<string>("FADADA_PLATFORM_CUSTOMER_ID")),
    platformSignatureId: trimmed(configService.get<string>("FADADA_PLATFORM_SIGNATURE_ID")),
    requestTimeoutMs: parsePositiveInt(
      configService.get<string>("FADADA_REQUEST_TIMEOUT_MS"),
      DEFAULT_REQUEST_TIMEOUT_MS
    ),
    signNotifyUrl: trimmed(configService.get<string>("FADADA_SIGN_NOTIFY_URL")),
    signReturnUrl: trimmed(configService.get<string>("FADADA_SIGN_RETURN_URL")),
    verifyNotifyUrl: trimmed(configService.get<string>("FADADA_VERIFY_NOTIFY_URL")),
    verifyReturnUrl: trimmed(configService.get<string>("FADADA_VERIFY_RETURN_URL"))
  };
}

export function selectedESignProvider(configService: ConfigService) {
  return (trimmed(configService.get<string>("ESIGN_PROVIDER")) ?? "mock").toLowerCase();
}

function normalizeBaseUrl(value: string) {
  return `${value.replace(/\/+$/, "")}/`;
}

function parseBoolean(value: string | undefined, defaultValue: boolean) {
  const normalized = trimmed(value)?.toLowerCase();
  if (normalized === undefined) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseFadadaEnv(value: string | undefined): FadadaEnv {
  const normalized = trimmed(value)?.toLowerCase();
  if (normalized === "production") {
    return "production";
  }
  return "sandbox";
}

function parsePositiveInt(value: string | undefined, defaultValue: number) {
  const parsed = Number.parseInt(trimmed(value) ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

function requiredValue(configService: ConfigService, key: string) {
  return trimmed(configService.get<string>(key));
}

function trimmed(value: string | undefined) {
  const result = value?.trim();
  return result ? result : undefined;
}
