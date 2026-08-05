export const SMS_PROVIDER_CLIENT = Symbol("SMS_PROVIDER_CLIENT");

export type SmsCodePurpose =
  | "LOGIN"
  | "BIND_PHONE"
  | "FIELD_HANDOVER_LOGIN";
export type SmsTemplatePurpose =
  | "FIELD_HANDOVER_ASSIGNED"
  | "FIELD_HANDOVER_ESIGN_READY"
  | "CUSTOMER_HANDOVER_ESIGN_READY"
  | "RENEWAL_REMINDER_D30"
  | "RENEWAL_REMINDER_D14"
  | "RENEWAL_REMINDER_D3"
  | "RENEWAL_EXPIRY_RETURN"
  | "RENEWAL_RETURN_OVERDUE_D1";
export type SmsProviderName = "aliyun" | "mock";
export type SmsProviderAcceptance = "ACCEPTED" | "REJECTED" | "UNKNOWN";

export interface SendSmsCodeInput {
  code: string;
  expiresInSeconds: number;
  phone: string;
  purpose: SmsCodePurpose;
}

export interface SmsSendResult {
  errorCode?: string;
  errorMessage?: string;
  provider: SmsProviderName;
  providerAcceptance?: SmsProviderAcceptance;
  providerMessageId?: string;
  providerRequestId?: string;
  providerResponse?: unknown;
  success: boolean;
}

export type SendSmsCodeResult = SmsSendResult;

export interface SendSmsTemplateInput {
  idempotencyKey: string;
  phone: string;
  purpose: SmsTemplatePurpose;
  templateCode: string;
  templateParams?: Record<string, string>;
}

export interface SmsProvider {
  sendCode(input: SendSmsCodeInput): Promise<SendSmsCodeResult>;
  sendTemplate(input: SendSmsTemplateInput): Promise<SmsSendResult>;
}
