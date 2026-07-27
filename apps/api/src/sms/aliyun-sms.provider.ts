import Credential from "@alicloud/credentials";
import DysmsapiClient, { SendSmsRequest } from "@alicloud/dysmsapi20170525";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import {
  SendSmsCodeInput,
  SendSmsCodeResult,
  SendSmsTemplateInput,
  SmsProvider,
  SmsSendResult
} from "./sms-provider";

const DEFAULT_ALIYUN_SMS_ENDPOINT = "dysmsapi.aliyuncs.com";
const DEFAULT_TEMPLATE_CODE_VARIABLE = "code";

export interface AliyunSmsClient {
  sendSms(request: SendSmsRequest): Promise<{
    body?: {
      bizId?: string;
      code?: string;
      message?: string;
      requestId?: string;
    };
  }>;
}

@Injectable()
export class AliyunSmsProvider implements SmsProvider {
  private client?: AliyunSmsClient;

  constructor(
    private readonly configService: ConfigService,
    client?: AliyunSmsClient
  ) {
    this.client = client;
  }

  async sendCode(input: SendSmsCodeInput): Promise<SendSmsCodeResult> {
    return this.send(() => this.createSendSmsRequest(input), true);
  }

  async sendTemplate(input: SendSmsTemplateInput): Promise<SmsSendResult> {
    return this.send(() => this.createSendSmsTemplateRequest(input), false);
  }

  createSendSmsRequest(input: SendSmsCodeInput) {
    const signName = this.readRequiredConfig("ALIYUN_SMS_SIGN_NAME");
    const templateCode = this.readRequiredConfig("ALIYUN_SMS_LOGIN_TEMPLATE_CODE");
    const templateVariable =
      readConfigValue(this.configService, "ALIYUN_SMS_TEMPLATE_CODE_VARIABLE") ?? DEFAULT_TEMPLATE_CODE_VARIABLE;

    return new SendSmsRequest({
      phoneNumbers: input.phone,
      signName,
      templateCode,
      templateParam: JSON.stringify({ [templateVariable]: input.code })
    });
  }

  createSendSmsTemplateRequest(input: SendSmsTemplateInput) {
    return new SendSmsRequest({
      phoneNumbers: input.phone,
      signName: this.readRequiredConfig("ALIYUN_SMS_SIGN_NAME"),
      templateCode: input.templateCode,
      templateParam: input.templateParams
        ? JSON.stringify(input.templateParams)
        : undefined
    });
  }

  private async send(
    createRequest: () => SendSmsRequest,
    preserveProviderMessage: boolean
  ): Promise<SmsSendResult> {
    try {
      const request = createRequest();
      const response = await this.getClient().sendSms(request);
      const body = response.body ?? {};
      const success = body.code === "OK";

      return {
        errorCode: success ? undefined : body.code,
        errorMessage: success
          ? undefined
          : preserveProviderMessage
            ? body.message
            : "ALIYUN_SMS_SEND_FAILED",
        provider: "aliyun",
        providerMessageId: body.bizId,
        providerRequestId: body.requestId,
        providerResponse: {
          bizId: body.bizId,
          code: body.code,
          ...(preserveProviderMessage ? { message: body.message } : {}),
          requestId: body.requestId
        },
        success
      };
    } catch (error) {
      return {
        errorCode: "ALIYUN_SMS_SEND_ERROR",
        errorMessage: preserveProviderMessage
          ? normalizeErrorMessage(error)
          : "ALIYUN_SMS_SEND_ERROR",
        provider: "aliyun",
        success: false
      };
    }
  }

  private getClient() {
    this.client ??= new DysmsapiClient(this.createClientConfig());
    return this.client;
  }

  private createClientConfig(): ConstructorParameters<typeof DysmsapiClient>[0] {
    const accessKeyId = readConfigValue(this.configService, "ALIYUN_SMS_ACCESS_KEY_ID");
    const accessKeySecret = readConfigValue(this.configService, "ALIYUN_SMS_ACCESS_KEY_SECRET");
    const endpoint = readConfigValue(this.configService, "ALIYUN_SMS_ENDPOINT") ?? DEFAULT_ALIYUN_SMS_ENDPOINT;

    if (accessKeyId && accessKeySecret) {
      return {
        accessKeyId,
        accessKeySecret,
        endpoint
      } as ConstructorParameters<typeof DysmsapiClient>[0];
    }

    return {
      credential: new Credential(),
      endpoint
    } as ConstructorParameters<typeof DysmsapiClient>[0];
  }

  private readRequiredConfig(key: string) {
    const value = readConfigValue(this.configService, key);
    if (!value) {
      throw new Error(`${key} is required for Aliyun SMS.`);
    }

    return value;
  }
}

function readConfigValue(configService: ConfigService, key: string) {
  const value = configService.get<string>(key);
  return stripWrappingQuotes(value);
}

function stripWrappingQuotes(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"]
  ];

  for (const [left, right] of quotePairs) {
    if (trimmed.startsWith(left) && trimmed.endsWith(right)) {
      return trimmed.slice(left.length, -right.length).trim();
    }
  }

  return trimmed;
}

function normalizeErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.slice(0, 500);
  }

  return "ALIYUN_SMS_SEND_ERROR";
}
