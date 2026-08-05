export const AUTO_DEBIT_CONFIG = Symbol("AUTO_DEBIT_CONFIG");
export const MANDATE_DEBIT_PROVIDER = Symbol("MANDATE_DEBIT_PROVIDER");

export type PaymentMandateProviderName =
  | "disabled"
  | "mock"
  | "wechat_auto_renew";

export type MandateProviderStatus =
  | "PENDING"
  | "ACTIVE"
  | "SUSPENDED"
  | "REVOKED"
  | "EXPIRED"
  | "FAILED";

export type DebitProviderStatus =
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED_RETRYABLE"
  | "FAILED_FINAL"
  | "UNKNOWN";

export type ProviderSnapshot = Record<string, unknown>;

export interface CreateMandateProviderInput {
  customerId: string;
  mandateNo: string;
  orderId: string;
  providerTemplateId: string;
}

export interface QueryMandateProviderInput {
  providerMandateId: string;
  providerSnapshot: ProviderSnapshot;
}

export type RevokeMandateProviderInput = QueryMandateProviderInput;

export interface MandateProviderResult {
  effectiveAt?: Date;
  errorCode?: string;
  errorMessage?: string;
  expiresAt?: Date;
  providerMandateId: string;
  providerSnapshot: ProviderSnapshot;
  signedAt?: Date;
  status: MandateProviderStatus;
}

export interface SubmitDebitProviderInput {
  amount: bigint;
  currency: "CNY";
  providerMandateId: string;
  providerOutTradeNo: string;
  subject: string;
}

export interface QueryDebitProviderInput {
  providerOutTradeNo: string;
  providerSnapshot: ProviderSnapshot;
  providerTransactionId?: string;
}

export interface DebitProviderResult {
  confirmedAmount: bigint;
  errorCode?: string;
  errorMessage?: string;
  providerOutTradeNo: string;
  providerSnapshot: ProviderSnapshot;
  providerTransactionId: string;
  resolvedAt?: Date;
  status: DebitProviderStatus;
}

export interface VerifyAutoDebitCallbackResult {
  payload: unknown;
  providerOutTradeNo?: string;
  providerTransactionId?: string;
  status?: DebitProviderStatus;
  verified: boolean;
}

export interface MandateDebitProvider {
  createMandate(
    input: CreateMandateProviderInput
  ): Promise<MandateProviderResult>;
  queryMandate(
    input: QueryMandateProviderInput
  ): Promise<MandateProviderResult>;
  revokeMandate(
    input: RevokeMandateProviderInput
  ): Promise<MandateProviderResult>;
  submitDebit(input: SubmitDebitProviderInput): Promise<DebitProviderResult>;
  queryDebit(input: QueryDebitProviderInput): Promise<DebitProviderResult>;
  verifyCallback(
    payload: unknown,
    headers?: Record<string, unknown>,
    rawBody?: Buffer
  ): Promise<VerifyAutoDebitCallbackResult>;
}
