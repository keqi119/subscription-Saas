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
  SendSmsTemplateInput,
  SMS_PROVIDER_CLIENT,
  SmsCodePurpose,
  SmsProvider,
  SmsProviderName,
  SmsSendResult as SmsProviderSendResult,
  SmsTemplatePurpose
} from "./sms-provider";

interface SendLoginCodeInput {
  allowDebugCode: boolean;
  code: string;
  expiresInSeconds: number;
  phone: string;
  verificationCodeId?: string;
}

type SendFieldHandoverLoginCodeInput = SendLoginCodeInput;

export interface SmsSendResult extends SendSmsCodeResult {
  sendLogId?: string;
  sendStatus: SmsSendStatus;
}

interface SendBusinessSmsInput {
  idempotencyKey: string;
  phone: string;
}

interface SendStage2FieldAssignedInput extends SendBusinessSmsInput {
  plateNo: string;
}

@Injectable()
export class SmsService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(SMS_PROVIDER_CLIENT) private readonly provider: SmsProvider
  ) {}

  async sendLoginCode(input: SendLoginCodeInput): Promise<SmsSendResult> {
    return this.sendCode({
      input,
      purpose: CustomerVerificationCodePurpose.LOGIN,
      smsEnabled: this.isSmsEnabled("PORTAL_SMS_ENABLED")
    });
  }

  async sendFieldHandoverLoginCode(input: SendFieldHandoverLoginCodeInput): Promise<SmsSendResult> {
    return this.sendCode({
      input,
      purpose: CustomerVerificationCodePurpose.FIELD_HANDOVER_LOGIN,
      smsEnabled: this.isSmsEnabled("FIELD_OPERATOR_SMS_ENABLED")
    });
  }

  async sendStage2FieldReady(
    input: SendBusinessSmsInput
  ): Promise<SmsSendResult> {
    return this.sendBusinessTemplate({
      enabled: this.isSmsEnabled("FIELD_OPERATOR_SMS_ENABLED"),
      input,
      purpose: "FIELD_HANDOVER_ESIGN_READY",
      templateCode: this.readRequiredTemplateCode(
        "ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE"
      ),
      templateParams: {}
    });
  }

  async sendStage2FieldAssigned(
    input: SendStage2FieldAssignedInput
  ): Promise<SmsSendResult> {
    const plateNo = input.plateNo.trim();
    if (plateNo.length < 1 || plateNo.length > 20) {
      throw new Error("FIELD_HANDOVER_PLATE_NO_INVALID");
    }
    return this.sendBusinessTemplate({
      enabled: this.isSmsEnabled("FIELD_OPERATOR_SMS_ENABLED"),
      input: {
        idempotencyKey: input.idempotencyKey,
        phone: input.phone
      },
      purpose: "FIELD_HANDOVER_ASSIGNED",
      templateCode: this.readRequiredTemplateCode(
        "ALIYUN_SMS_FIELD_HANDOVER_ASSIGNED_TEMPLATE_CODE"
      ),
      templateParams: { name: plateNo }
    });
  }

  async sendStage2CustomerReady(
    input: SendBusinessSmsInput
  ): Promise<SmsSendResult> {
    return this.sendBusinessTemplate({
      enabled: this.isSmsEnabled("PORTAL_SMS_ENABLED"),
      input,
      purpose: "CUSTOMER_HANDOVER_ESIGN_READY",
      templateCode: this.readRequiredTemplateCode(
        "ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE"
      ),
      templateParams: {}
    });
  }

  private async sendCode(input: {
    input: SendLoginCodeInput;
    purpose: SmsCodePurpose;
    smsEnabled: boolean;
  }): Promise<SmsSendResult> {
    const provider = this.getProviderName();
    const providerInput: SendSmsCodeInput = {
      code: input.input.code,
      expiresInSeconds: input.input.expiresInSeconds,
      phone: input.input.phone,
      purpose: input.purpose
    };

    if (!input.smsEnabled) {
      const result: SendSmsCodeResult = {
        errorCode: "SMS_DISABLED",
        errorMessage: "SMS_DISABLED",
        provider,
        providerResponse: {
          phoneMasked: maskPhone(input.input.phone),
          reason: "SMS_DISABLED",
          skipped: true
        },
        success: input.input.allowDebugCode
      };
      return this.createSendLog({
        input: providerInput,
        result,
        sendStatus: input.input.allowDebugCode ? SmsSendStatus.SKIPPED : SmsSendStatus.FAILED,
        verificationCodeId: input.input.verificationCodeId
      });
    }

    const result = await this.provider.sendCode(providerInput);
    return this.createSendLog({
      input: providerInput,
      result,
      sendStatus: result.success ? SmsSendStatus.SENT : SmsSendStatus.FAILED,
      verificationCodeId: input.input.verificationCodeId
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
          input.result.providerResponse === undefined
            ? undefined
            : toJsonValue(input.result.providerResponse),
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

  private async sendBusinessTemplate(input: {
    enabled: boolean;
    input: SendBusinessSmsInput;
    purpose: SmsTemplatePurpose;
    templateCode: string;
    templateParams: Record<string, string>;
  }): Promise<SmsSendResult> {
    const provider = this.getProviderName();
    let reservation: {
      id: string;
      idempotencyKey: null | string;
      phone: string;
      purpose: CustomerVerificationCodePurpose;
      sendStatus: SmsSendStatus;
    };
    try {
      reservation = await this.prisma.smsSendLog.create({
        data: {
          errorCode: "SMS_SEND_IN_PROGRESS",
          errorMessage: "SMS_SEND_IN_PROGRESS",
          idempotencyKey: input.input.idempotencyKey,
          phone: input.input.phone,
          phoneMasked: maskPhone(input.input.phone),
          provider: toSmsProviderType(provider),
          purpose: input.purpose,
          sendStatus: SmsSendStatus.SENDING
        }
      });
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }
      const existing = await this.prisma.smsSendLog.findUnique({
        where: { idempotencyKey: input.input.idempotencyKey }
      });
      if (!existing) {
        throw error;
      }
      if (
        existing.phone !== input.input.phone ||
        existing.purpose !== input.purpose
      ) {
        throw new Error("SMS_IDEMPOTENCY_KEY_CONFLICT", {
          cause: error
        });
      }
      if (existing.sendStatus !== SmsSendStatus.FAILED) {
        return toSmsSendResult(existing);
      }
      const claimed = await this.prisma.smsSendLog.updateMany({
        data: {
          errorCode: "SMS_SEND_IN_PROGRESS",
          errorMessage: "SMS_SEND_IN_PROGRESS",
          provider: toSmsProviderType(provider),
          providerMessageId: null,
          providerRequestId: null,
          providerResponse: Prisma.DbNull,
          sendStatus: SmsSendStatus.SENDING
        },
        where: {
          id: existing.id,
          sendStatus: SmsSendStatus.FAILED
        }
      });
      if (claimed.count !== 1) {
        const winner = await this.prisma.smsSendLog.findUnique({
          where: { idempotencyKey: input.input.idempotencyKey }
        });
        if (!winner) {
          throw new Error("SMS_IDEMPOTENCY_RECORD_MISSING", {
            cause: error
          });
        }
        return toSmsSendResult(winner);
      }
      reservation = existing;
    }

    const providerInput: SendSmsTemplateInput = {
      idempotencyKey: input.input.idempotencyKey,
      phone: input.input.phone,
      purpose: input.purpose,
      templateCode: input.templateCode,
      templateParams: input.templateParams
    };
    let result: SmsProviderSendResult;
    try {
      result = input.enabled
        ? await this.provider.sendTemplate(providerInput)
        : {
            errorCode: "SMS_DISABLED",
            errorMessage: "SMS_DISABLED",
            provider,
            providerAcceptance: "REJECTED",
            providerResponse: {
              reason: "SMS_DISABLED",
              skipped: true
            },
            success: false
          };
    } catch {
      result = {
        errorCode: "SMS_PROVIDER_RESULT_UNKNOWN",
        errorMessage: "SMS_PROVIDER_RESULT_UNKNOWN",
        provider,
        providerAcceptance: "UNKNOWN",
        success: false
      };
    }
    const sendStatus = result.success
      ? SmsSendStatus.SENT
      : result.providerAcceptance === "UNKNOWN"
        ? SmsSendStatus.UNCERTAIN
        : SmsSendStatus.FAILED;
    const resultData = {
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
      provider: toSmsProviderType(result.provider),
      providerMessageId: result.providerMessageId ?? null,
      providerRequestId: result.providerRequestId ?? null,
      providerResponse:
        result.providerResponse === undefined
          ? Prisma.DbNull
          : toJsonValue(result.providerResponse),
      sendStatus
    };
    let finalized: { count: number };
    try {
      finalized = await this.prisma.smsSendLog.updateMany({
        data: resultData,
        where: {
          id: reservation.id,
          sendStatus: SmsSendStatus.SENDING
        }
      });
    } catch {
      const errorCode = result.success
        ? "SMS_PROVIDER_ACCEPTED_FINALIZATION_UNCERTAIN"
        : "SMS_PROVIDER_RESULT_FINALIZATION_UNCERTAIN";
      try {
        await this.prisma.smsSendLog.updateMany({
          data: {
            ...resultData,
            errorCode,
            errorMessage: errorCode,
            sendStatus: SmsSendStatus.UNCERTAIN
          },
          where: {
            id: reservation.id,
            sendStatus: SmsSendStatus.SENDING
          }
        });
      } catch {
        // A persisted SENDING row is intentionally not auto-retryable.
      }
      const uncertain = await this.prisma.smsSendLog.findUnique({
        where: { idempotencyKey: input.input.idempotencyKey }
      });
      if (!uncertain) {
        throw new Error("SMS_IDEMPOTENCY_RECORD_MISSING");
      }
      return toSmsSendResult(uncertain);
    }
    if (finalized.count !== 1) {
      const winner = await this.prisma.smsSendLog.findUnique({
        where: { idempotencyKey: input.input.idempotencyKey }
      });
      if (!winner) {
        throw new Error("SMS_IDEMPOTENCY_RECORD_MISSING");
      }
      return toSmsSendResult(winner);
    }
    const updated = await this.prisma.smsSendLog.findUnique({
      where: { idempotencyKey: input.input.idempotencyKey }
    });
    if (!updated) {
      throw new Error("SMS_IDEMPOTENCY_RECORD_MISSING");
    }
    return toSmsSendResult(updated);
  }

  private getProviderName(): SmsProviderName {
    return normalizeProviderName(
      this.configService.get<string>("FIELD_OPERATOR_SMS_PROVIDER") ??
        this.configService.get<string>("PORTAL_SMS_PROVIDER")
    );
  }

  private isSmsEnabled(key: "FIELD_OPERATOR_SMS_ENABLED" | "PORTAL_SMS_ENABLED") {
    const value = this.configService.get<string>(key);
    if (value !== undefined) {
      return value === "true";
    }
    return key === "FIELD_OPERATOR_SMS_ENABLED"
      ? this.configService.get<string>("PORTAL_SMS_ENABLED") === "true"
      : false;
  }

  private readRequiredTemplateCode(
    key:
      | "ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE"
      | "ALIYUN_SMS_FIELD_HANDOVER_ASSIGNED_TEMPLATE_CODE"
      | "ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE"
  ) {
    const value = this.configService.get<string>(key)?.trim();
    if (!value || value === "<CHANGE_ME>") {
      throw new Error(`${key} is required for business SMS.`);
    }
    return value;
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

function isUniqueConflict(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function toSmsSendResult(log: {
  errorCode: null | string;
  errorMessage: null | string;
  id: string;
  provider: SmsProviderType;
  providerMessageId: null | string;
  providerRequestId: null | string;
  providerResponse: null | Prisma.JsonValue;
  sendStatus: SmsSendStatus;
}): SmsSendResult {
  return {
    errorCode: log.errorCode ?? undefined,
    errorMessage: log.errorMessage ?? undefined,
    provider: log.provider === SmsProviderType.ALIYUN ? "aliyun" : "mock",
    providerMessageId: log.providerMessageId ?? undefined,
    providerRequestId: log.providerRequestId ?? undefined,
    providerResponse: log.providerResponse ?? undefined,
    sendLogId: log.id,
    sendStatus: log.sendStatus,
    success: log.sendStatus === SmsSendStatus.SENT
  };
}
