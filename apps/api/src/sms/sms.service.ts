import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CustomerVerificationCodePurpose,
  Prisma,
  SmsProviderType,
  SmsSendStatus
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import {
  SendSmsCodeInput,
  SendSmsCodeResult,
  SMS_PROVIDER_CLIENT,
  SmsProvider,
  SmsProviderName
} from "./sms-provider";

interface SendLoginCodeInput {
  allowDebugCode: boolean;
  code: string;
  expiresInSeconds: number;
  phone: string;
  verificationCodeId?: string;
}

export interface SmsSendResult extends SendSmsCodeResult {
  sendLogId?: string;
  sendStatus: SmsSendStatus;
}

@Injectable()
export class SmsService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(SMS_PROVIDER_CLIENT) private readonly provider: SmsProvider
  ) {}

  async sendLoginCode(input: SendLoginCodeInput): Promise<SmsSendResult> {
    const provider = this.getProviderName();
    const providerInput: SendSmsCodeInput = {
      code: input.code,
      expiresInSeconds: input.expiresInSeconds,
      phone: input.phone,
      purpose: CustomerVerificationCodePurpose.LOGIN
    };

    if (!this.isSmsEnabled()) {
      const result: SendSmsCodeResult = {
        errorCode: "SMS_DISABLED",
        errorMessage: "SMS_DISABLED",
        provider,
        providerResponse: {
          phoneMasked: maskPhone(input.phone),
          reason: "SMS_DISABLED",
          skipped: true
        },
        success: input.allowDebugCode
      };
      return this.createSendLog({
        input: providerInput,
        result,
        sendStatus: input.allowDebugCode ? SmsSendStatus.SKIPPED : SmsSendStatus.FAILED,
        verificationCodeId: input.verificationCodeId
      });
    }

    const result = await this.provider.sendCode(providerInput);
    return this.createSendLog({
      input: providerInput,
      result,
      sendStatus: result.success ? SmsSendStatus.SENT : SmsSendStatus.FAILED,
      verificationCodeId: input.verificationCodeId
    });
  }

  private async createSendLog(input: {
    input: SendSmsCodeInput;
    result: SendSmsCodeResult;
    sendStatus: SmsSendStatus;
    verificationCodeId?: string;
  }): Promise<SmsSendResult> {
    const log = await this.prisma.smsSendLog.create({
      data: {
        errorCode: input.result.errorCode,
        errorMessage: input.result.errorMessage,
        phone: input.input.phone,
        phoneMasked: maskPhone(input.input.phone),
        provider: toSmsProviderType(input.result.provider),
        providerMessageId: input.result.providerMessageId,
        providerRequestId: input.result.providerRequestId,
        providerResponse:
          input.result.providerResponse === undefined ? undefined : toJsonValue(input.result.providerResponse),
        purpose: input.input.purpose,
        sendStatus: input.sendStatus,
        verificationCodeId: input.verificationCodeId
      }
    });

    return {
      ...input.result,
      sendLogId: log.id,
      sendStatus: input.sendStatus
    };
  }

  private getProviderName(): SmsProviderName {
    return normalizeProviderName(this.configService.get<string>("PORTAL_SMS_PROVIDER"));
  }

  private isSmsEnabled() {
    return this.configService.get<string>("PORTAL_SMS_ENABLED") === "true";
  }
}

export function normalizeProviderName(value?: string): SmsProviderName {
  return value?.trim().toLowerCase() === "aliyun" ? "aliyun" : "mock";
}

function toSmsProviderType(provider: SmsProviderName) {
  return provider === "aliyun" ? SmsProviderType.ALIYUN : SmsProviderType.MOCK;
}

function maskPhone(phone: string) {
  if (phone.length < 7) {
    return phone;
  }

  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function toJsonValue(value: unknown) {
  const text = JSON.stringify(value);
  if (!text) {
    return undefined;
  }

  return JSON.parse(text) as Prisma.InputJsonValue;
}
