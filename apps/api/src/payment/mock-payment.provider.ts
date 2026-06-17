import { ConfigService } from "@nestjs/config";

import {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  VerifyPaymentCallbackResult
} from "./payment-provider";

export class MockPaymentProvider implements PaymentProvider {
  constructor(private readonly configService: ConfigService) {}

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const cashierUrl = this.buildMockCashierUrl(input.paymentOrderId);

    return {
      cashierUrl,
      cashierUrlExpiresAt: this.cashierUrlExpiresAt(),
      providerPrepayId: `mock_prepay_${input.paymentOrderNo}`,
      providerTradeNo: `mock_${input.paymentOrderNo}`,
      rawResponse: {
        cashierUrl,
        mock: true
      }
    };
  }

  async verifyCallback(payload: unknown): Promise<VerifyPaymentCallbackResult> {
    const record = asRecord(payload);

    return {
      eventType: stringOrUndefined(record.eventType) ?? stringOrUndefined(record.event),
      paidAmount: numberOrUndefined(record.paidAmount),
      paidAt: dateOrUndefined(record.paidAt),
      payload,
      providerTradeNo: stringOrUndefined(record.providerTradeNo),
      providerTransactionId: stringOrUndefined(record.providerTransactionId),
      verified: true
    };
  }

  private buildMockCashierUrl(paymentOrderId?: string) {
    const portalBaseUrl = trimTrailingSlash(
      this.configService.get<string>("PORTAL_BASE_URL") ?? "http://localhost:3000"
    );
    const paymentOrderSegment = encodeURIComponent(paymentOrderId ?? "");

    return `${portalBaseUrl}/portal/payment-orders/${paymentOrderSegment}/mock-pay`;
  }

  private cashierUrlExpiresAt() {
    const seconds = Number(this.configService.get<string>("PAYMENT_CASHIER_URL_EXPIRES_SECONDS") ?? "1800");
    return new Date(Date.now() + Math.max(seconds, 60) * 1000);
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberOrUndefined(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function dateOrUndefined(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
