export const SMS_PROVIDER_CLIENT = Symbol("SMS_PROVIDER_CLIENT");

export type SmsCodePurpose = "LOGIN" | "BIND_PHONE" | "FIELD_HANDOVER_LOGIN";
export type SmsProviderName = "aliyun" | "mock";

export interface SendSmsCodeInput {
  code: string;
  expiresInSeconds: number;
  phone: string;
  purpose: SmsCodePurpose;
}

export interface SendSmsCodeResult {
  errorCode?: string;
  errorMessage?: string;
  provider: SmsProviderName;
  providerMessageId?: string;
  providerRequestId?: string;
  providerResponse?: unknown;
  success: boolean;
}

export interface SmsProvider {
  sendCode(input: SendSmsCodeInput): Promise<SendSmsCodeResult>;
}
