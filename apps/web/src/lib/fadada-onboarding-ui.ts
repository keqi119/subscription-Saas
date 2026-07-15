import type { ActionAvailability } from "./action-guards";

export type FadadaReadinessTone = "error" | "info" | "success" | "warning";

export interface FadadaOnboardingReadiness {
  blockingCode?: string | null;
  blockingMessage?: string | null;
  certBound?: boolean;
  certSerialNoPresent?: boolean;
  lastProviderCheckAt?: string | null;
  nextAction?: string | null;
  providerCustomerIdPresent?: boolean;
  readyForSigning?: boolean;
  realNameProviderVerified?: boolean;
  realNameUrl?: string | null;
  signingEligible?: boolean;
  state?: string | null;
  verifyUrlMasked?: string | null;
  verifyUrlPresent?: boolean;
}

export const FADADA_SIGNING_READY_MESSAGE = "法大大实名认证与实名证书已就绪";
export const FADADA_BLOCKING_FALLBACK_MESSAGE = "请先完成法大大实名认证并绑定实名证书";

export const FADADA_CERT_BINDING_MESSAGE = "实名已完成，请刷新并绑定法大大实名证书";
export const FADADA_CERT_BINDING_ACTION_LABEL = "刷新并绑定实名证书";

export const FADADA_BLOCKING_CODE_MESSAGES: Record<string, string> = {
  FADADA_ACCOUNT_MISSING: "尚未创建法大大实名账户，请先发起实名认证",
  FADADA_ACCOUNT_NOT_REGISTERED: "法大大账户尚未开户注册，请先发起实名认证",
  FADADA_CERT_NOT_BOUND: FADADA_BLOCKING_FALLBACK_MESSAGE,
  FADADA_MANUAL_ONLY_NOT_SIGNING_READY: "已绑定法大大客户号，但缺少供应商实名与证书绑定证据，请先完成实名认证并绑定实名证书",
  FADADA_PROVIDER_CUSTOMER_ID_MISSING: "法大大客户号缺失，请重新发起实名认证",
  FADADA_PROVIDER_STATUS_STALE: "法大大实名状态已过期，请刷新认证状态",
  FADADA_PROVIDER_STATUS_UNKNOWN: "暂无法确认法大大实名状态，请刷新认证状态",
  FADADA_REALNAME_FAILED: "法大大实名认证未通过，请重新认证",
  FADADA_REALNAME_NOT_STARTED: "请先完成法大大实名认证",
  FADADA_REALNAME_PENDING: "法大大实名认证处理中，请稍后刷新"
};

export function getFadadaBlockingMessage(readiness?: FadadaOnboardingReadiness | null) {
  if (!readiness) {
    return FADADA_BLOCKING_FALLBACK_MESSAGE;
  }
  if (readiness.readyForSigning || readiness.signingEligible) {
    return FADADA_SIGNING_READY_MESSAGE;
  }
  if (isApplyCertReadiness(readiness)) {
    return FADADA_CERT_BINDING_MESSAGE;
  }
  const code = readiness.blockingCode ?? undefined;
  return (code ? FADADA_BLOCKING_CODE_MESSAGES[code] : null) ??
    readiness.blockingMessage ??
    FADADA_BLOCKING_FALLBACK_MESSAGE;
}

export function getFadadaReadinessAvailability(readiness?: FadadaOnboardingReadiness | null): ActionAvailability {
  if (readiness?.readyForSigning || readiness?.signingEligible) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: getFadadaBlockingMessage(readiness)
  };
}

export function getFadadaReadinessTone(readiness?: FadadaOnboardingReadiness | null): FadadaReadinessTone {
  if (readiness?.readyForSigning || readiness?.signingEligible) {
    return "success";
  }
  if (readiness?.blockingCode === "FADADA_REALNAME_FAILED") {
    return "error";
  }
  if (
    readiness?.blockingCode === "FADADA_REALNAME_PENDING" ||
    readiness?.nextAction === "WAIT_REALNAME_CALLBACK"
  ) {
    return "info";
  }
  return "warning";
}

export function getFadadaNextActionLabel(readiness?: FadadaOnboardingReadiness | null) {
  if (readiness?.readyForSigning || readiness?.signingEligible) {
    return "去签署";
  }
  switch (readiness?.nextAction) {
    case "APPLY_CERT":
      return FADADA_CERT_BINDING_ACTION_LABEL;
    case "QUERY_PROVIDER_STATUS":
      return "刷新认证状态";
    case "WAIT_REALNAME_CALLBACK":
      return "继续实名认证";
    case "START_REALNAME_VERIFICATION":
    case "START_ONBOARDING":
    case "REGISTER_PROVIDER_ACCOUNT":
      return "去完成实名认证";
    default:
      return "去完成实名认证";
  }
}

export function isApplyCertReadiness(readiness?: FadadaOnboardingReadiness | null) {
  return readiness?.nextAction === "APPLY_CERT" ||
    (
      readiness?.blockingCode === "FADADA_CERT_NOT_BOUND" &&
      readiness.realNameProviderVerified === true
    );
}
