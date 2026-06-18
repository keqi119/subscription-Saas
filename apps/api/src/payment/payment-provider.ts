export const PAYMENT_PROVIDER_CLIENT = Symbol("PAYMENT_PROVIDER_CLIENT");

export interface CreatePaymentInput {
  amount: bigint | number;
  clientIp?: string;
  description?: string;
  notifyUrl?: string;
  openId?: string;
  paymentOrderId?: string;
  paymentOrderNo: string;
  returnUrl?: string;
  subject?: string;
}

export interface WeChatJsapiPaymentParams {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: "RSA";
  paySign: string;
}

export interface CreatePaymentResult {
  cashierUrl?: string;
  cashierUrlExpiresAt?: Date;
  jsapiParams?: WeChatJsapiPaymentParams;
  providerPrepayId?: string;
  providerTradeNo: string;
  rawResponse?: unknown;
}

export interface VerifyPaymentCallbackResult {
  errorMessage?: string;
  eventType?: string;
  paidAmount?: number;
  paidAt?: Date;
  payload: unknown;
  providerTradeNo?: string;
  providerTransactionId?: string;
  verified: boolean;
}

export interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  verifyCallback(
    payload: unknown,
    headers?: Record<string, unknown>,
    rawBody?: Buffer
  ): Promise<VerifyPaymentCallbackResult>;
}
