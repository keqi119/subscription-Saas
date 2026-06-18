import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readFileSync } from "node:fs";

import {
  buildWechatJsapiPaySign,
  buildWechatPayAuthorizationHeader,
  createWechatPayNonce,
  decryptWechatPayResource,
  verifyWechatPaySignature
} from "./wechat-pay.crypto";
import {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  VerifyPaymentCallbackResult
} from "./payment-provider";
import { WeChatPayCertificateStore } from "./wechat-pay-certificate-store";

const WECHAT_JSAPI_TRANSACTION_PATH = "/v3/pay/transactions/jsapi";
const WECHAT_PAY_API_BASE_URL = "https://api.mch.weixin.qq.com";

export class WeChatPayProvider implements PaymentProvider {
  private readonly certificateStore: WeChatPayCertificateStore;

  constructor(private readonly configService: ConfigService) {
    this.certificateStore = new WeChatPayCertificateStore(configService);
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!this.enabled) {
      throw new ServiceUnavailableException("WECHAT_PAY_DISABLED");
    }
    if (!input.openId) {
      throw new BadRequestException("WECHAT_OPENID_REQUIRED");
    }

    const appId = this.requiredConfig("WECHAT_PAY_APP_ID");
    const merchantId = this.requiredConfig("WECHAT_PAY_MCH_ID");
    const notifyUrl = input.notifyUrl ?? this.requiredConfig("WECHAT_PAY_NOTIFY_URL");
    const privateKeyPem = this.readPrivateKey();
    const serialNo = this.requiredConfig("WECHAT_PAY_MERCHANT_SERIAL_NO");
    const amount = toPositiveInteger(input.amount);
    const body = JSON.stringify({
      appid: appId,
      mchid: merchantId,
      description: truncateWechatDescription(input.subject ?? input.description ?? "订阅账单支付"),
      out_trade_no: input.paymentOrderNo,
      notify_url: notifyUrl,
      amount: {
        total: amount,
        currency: "CNY"
      },
      payer: {
        openid: input.openId
      }
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = createWechatPayNonce();
    const authorization = buildWechatPayAuthorizationHeader({
      body,
      merchantId,
      method: "POST",
      nonce,
      privateKeyPem,
      serialNo,
      timestamp,
      urlPathWithQuery: WECHAT_JSAPI_TRANSACTION_PATH
    });
    const response = await fetch(`${WECHAT_PAY_API_BASE_URL}${WECHAT_JSAPI_TRANSACTION_PATH}`, {
      body,
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        "Content-Type": "application/json",
        "User-Agent": "subscription-saas"
      },
      method: "POST"
    });
    const rawResponse = await safeParseJson(response);

    if (!response.ok) {
      throw new BadRequestException({
        code: "WECHAT_PAY_CREATE_FAILED",
        status: response.status,
        wechatCode: asRecord(rawResponse).code
      });
    }

    const prepayId = stringOrUndefined(asRecord(rawResponse).prepay_id);
    if (!prepayId) {
      throw new BadRequestException("WECHAT_PAY_PREPAY_ID_MISSING");
    }

    const packageValue = `prepay_id=${prepayId}`;
    const jsapiNonce = createWechatPayNonce();
    const jsapiTimeStamp = Math.floor(Date.now() / 1000).toString();
    const jsapiParams = {
      appId,
      timeStamp: jsapiTimeStamp,
      nonceStr: jsapiNonce,
      package: packageValue,
      signType: "RSA" as const,
      paySign: buildWechatJsapiPaySign({
        appId,
        nonceStr: jsapiNonce,
        packageValue,
        privateKeyPem,
        timeStamp: jsapiTimeStamp
      })
    };

    return {
      jsapiParams,
      providerPrepayId: prepayId,
      providerTradeNo: input.paymentOrderNo,
      rawResponse: {
        jsapiParams,
        prepayId,
        provider: "wechat_pay"
      }
    };
  }

  async verifyCallback(
    payload: unknown,
    headers?: Record<string, unknown>,
    rawBody?: Buffer
  ): Promise<VerifyPaymentCallbackResult> {
    const body = rawBody?.toString("utf8") ?? JSON.stringify(payload);
    const timestamp = headerValue(headers, "wechatpay-timestamp");
    const nonce = headerValue(headers, "wechatpay-nonce");
    const signature = headerValue(headers, "wechatpay-signature");
    const serial = headerValue(headers, "wechatpay-serial");

    if (!timestamp || !nonce || !signature || !serial) {
      return { errorMessage: "WECHATPAY_CALLBACK_HEADERS_MISSING", payload, verified: false };
    }
    const verifier = this.certificateStore.getVerifierPem(serial);
    if (!verifier.pem) {
      return { errorMessage: verifier.errorMessage, payload, verified: false };
    }

    const verified = verifyWechatPaySignature({
      body,
      nonce,
      publicKeyOrCertificatePem: verifier.pem,
      signature,
      timestamp
    });
    if (!verified) {
      return { errorMessage: "WECHATPAY_SIGNATURE_VERIFY_FAILED", payload, verified: false };
    }

    const record = asRecord(payload);
    const resource = asRecord(record.resource);
    const decrypted = decryptWechatPayResource({
      apiV3Key: this.requiredConfig("WECHAT_PAY_API_V3_KEY"),
      associatedData: stringOrUndefined(resource.associated_data),
      ciphertext: requiredString(resource.ciphertext, "resource.ciphertext"),
      nonce: requiredString(resource.nonce, "resource.nonce")
    });
    const result = asRecord(JSON.parse(decrypted));
    const appId = requiredString(result.appid, "appid");
    const merchantId = requiredString(result.mchid, "mchid");

    if (appId !== this.requiredConfig("WECHAT_PAY_APP_ID")) {
      throw new BadRequestException("WECHAT_PAY_APPID_MISMATCH");
    }
    if (merchantId !== this.requiredConfig("WECHAT_PAY_MCH_ID")) {
      throw new BadRequestException("WECHAT_PAY_MCHID_MISMATCH");
    }

    return {
      eventType: stringOrUndefined(result.trade_state),
      paidAmount: numberOrUndefined(asRecord(result.amount).payer_total),
      paidAt: dateOrUndefined(result.success_time),
      payload: result,
      providerTradeNo: stringOrUndefined(result.out_trade_no),
      providerTransactionId: stringOrUndefined(result.transaction_id),
      verified: true
    };
  }

  private get enabled() {
    return (this.configService.get<string>("WECHAT_PAY_ENABLED") ?? "false").toLowerCase() === "true";
  }

  private requiredConfig(key: string) {
    const value = this.configService.get<string>(key)?.trim();
    if (!value) {
      throw new ServiceUnavailableException(`${key}_MISSING`);
    }
    return value;
  }

  private readPrivateKey() {
    const privateKeyPath = this.requiredConfig("WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH");
    return readFileSync(privateKeyPath, "utf8");
  }
}

async function safeParseJson(response: Response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredString(value: unknown, field: string) {
  const text = stringOrUndefined(value);
  if (!text) {
    throw new BadRequestException(`WECHAT_PAY_${field}_MISSING`);
  }
  return text;
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

function headerValue(headers: Record<string, unknown> | undefined, name: string) {
  if (!headers) {
    return undefined;
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string" && Boolean(item.trim()));
  }
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toPositiveInteger(value: bigint | number) {
  const amount = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new BadRequestException("PAYMENT_AMOUNT_INVALID");
  }
  return amount;
}

function truncateWechatDescription(value: string) {
  return value.length > 120 ? value.slice(0, 120) : value;
}
