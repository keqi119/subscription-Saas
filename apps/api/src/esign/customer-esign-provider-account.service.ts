import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CustomerESignProviderAccount,
  ESignProviderAccountSource,
  ESignProviderAccountStatus,
  ESignProviderAccountType,
  ESignProviderType,
  ESignRealNameStatus,
  Prisma
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { createFadadaProviderOpenId } from "./esign-provider-open-id";
import { FadadaApiClient } from "./fadada/fadada-api.client";
import { verifyFadadaCallbackDigest } from "./fadada/fadada-digest";
import { loadFadadaConfig } from "./fadada/fadada.config";
import { FadadaHttpClient } from "./fadada/fadada-http-client";

export const FADADA_ACCOUNT_REGISTER_DISABLED = "FADADA_ACCOUNT_REGISTER_DISABLED";
export const FADADA_ACCOUNT_API_CLIENT = Symbol("FADADA_ACCOUNT_API_CLIENT");
export const FADADA_PROVIDER_ACCOUNT_ALREADY_ATTACHED = "FADADA_PROVIDER_ACCOUNT_ALREADY_ATTACHED";
export const FADADA_PROVIDER_ACCOUNT_CONFLICT = "FADADA_PROVIDER_ACCOUNT_CONFLICT";
export const FADADA_PROVIDER_ACCOUNT_NOT_FOUND = "FADADA_PROVIDER_ACCOUNT_NOT_FOUND";
export const FADADA_PROVIDER_ACCOUNT_NOT_REGISTERED = "FADADA_PROVIDER_ACCOUNT_NOT_REGISTERED";
export const FADADA_REALNAME_ALREADY_VERIFIED = "FADADA_REALNAME_ALREADY_VERIFIED";
export const FADADA_REALNAME_VERIFY_DISABLED = "FADADA_REALNAME_VERIFY_DISABLED";
export const FADADA_REALNAME_VERIFY_CONFIG_MISSING = "FADADA_REALNAME_VERIFY_CONFIG_MISSING";
export const FADADA_REALNAME_VERIFY_SERIAL_MISSING = "FADADA_REALNAME_VERIFY_SERIAL_MISSING";

export interface FadadaManualAttachInput {
  customerId: string;
  providerCustomerId: string;
  realNameStatus?: ESignRealNameStatus;
}

export interface FadadaRealNameStatusInput {
  customerId: string;
  realNameStatus: ESignRealNameStatus;
  verificationSerialNo?: string;
  verificationTransactionNo?: string;
}

export interface StartFadadaRealNameVerificationInput {
  certFlag?: boolean;
  idCardNo: string;
  mobile: string;
  name: string;
  option?: string;
  pageModify?: string;
  verifiedWay?: string;
}

export interface StartFadadaRealNameVerificationResult {
  account: CustomerESignProviderAccountView;
  verifyUrlMasked: string;
  verifyUrlPresent: boolean;
}

export interface FadadaVerifyCallbackResult {
  handled: boolean;
  reason?: "ACCOUNT_NOT_FOUND" | "UNVERIFIED";
  realNameStatus?: ESignRealNameStatus;
  verified: boolean;
  verificationSerialNo?: string;
  verificationTransactionNo?: string;
}

export interface CustomerESignProviderAccountView {
  accountType: ESignProviderAccountType;
  createdAt: Date;
  id: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  provider: ESignProviderType;
  providerCustomerId: string | null;
  providerOpenId: string;
  registrationStatus: ESignProviderAccountStatus;
  realNameStatus: ESignRealNameStatus;
  source: ESignProviderAccountSource;
  updatedAt: Date;
  verifiedAt: Date | null;
  verificationSerialNo: string | null;
  verificationTransactionNo: string | null;
}

@Injectable()
export class CustomerESignProviderAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(FADADA_ACCOUNT_API_CLIENT)
    private readonly fadadaApiClient?: Pick<
      FadadaApiClient,
      "applyCert" | "findPersonCertInfo" | "getPersonVerifyUrl" | "registerAccount"
    >
  ) {}

  async listCustomerProviderAccounts(customerId: string) {
    await this.assertCustomerExists(customerId);
    const accounts = await this.prisma.customerESignProviderAccount.findMany({
      orderBy: { createdAt: "desc" },
      where: {
        customerId,
        deletedAt: null
      }
    });

    return accounts.map(toView);
  }

  async getFadadaPersonalBinding(customerId: string) {
    await this.assertCustomerExists(customerId);
    const account = await this.findFadadaPersonalBinding(customerId);
    return account ? toView(account) : null;
  }

  async ensureFadadaPersonalPendingBinding(customerId: string, actorId?: string) {
    await this.assertCustomerExists(customerId);
    const existing = await this.findFadadaPersonalBinding(customerId);
    if (existing) {
      return toView(existing);
    }

    const created = await this.prisma.customerESignProviderAccount.create({
      data: {
        accountType: ESignProviderAccountType.PERSONAL,
        createdBy: actorId,
        customerId,
        provider: ESignProviderType.FADADA,
        providerOpenId: createFadadaProviderOpenId(customerId),
        registrationStatus: ESignProviderAccountStatus.PENDING,
        realNameStatus: ESignRealNameStatus.UNVERIFIED,
        source: ESignProviderAccountSource.SYSTEM_REGISTER,
        updatedBy: actorId
      }
    });

    return toView(created);
  }

  async registerFadadaPersonalAccount(customerId: string, actorId?: string) {
    if (!this.isAccountRegisterEnabled()) {
      throw new BadRequestException(`${FADADA_ACCOUNT_REGISTER_DISABLED}: account_register.api is disabled`);
    }

    const binding = await this.getOrCreateFadadaPersonalBinding(customerId, actorId);
    if (binding.providerCustomerId && binding.registrationStatus === ESignProviderAccountStatus.REGISTERED) {
      return toView(binding);
    }
    if (binding.providerCustomerId) {
      throw new ConflictException(`${FADADA_PROVIDER_ACCOUNT_ALREADY_ATTACHED}: provider customer id already exists`);
    }

    try {
      const result = await this.createFadadaApiClient().registerAccount({
        accountType: "PERSONAL",
        openId: binding.providerOpenId
      });
      const updated = await this.prisma.customerESignProviderAccount.update({
        data: {
          lastErrorCode: null,
          lastErrorMessage: null,
          providerCustomerId: result.providerCustomerId,
          providerSnapshot: sanitizeProviderSnapshot(result.raw),
          registrationStatus: ESignProviderAccountStatus.REGISTERED,
          updatedBy: actorId
        },
        where: { id: binding.id }
      });
      return toView(updated);
    } catch (error) {
      await this.prisma.customerESignProviderAccount.update({
        data: {
          lastErrorCode: errorCode(error),
          lastErrorMessage: sanitizeErrorMessage(error),
          registrationStatus: ESignProviderAccountStatus.FAILED,
          updatedBy: actorId
        },
        where: { id: binding.id }
      });
      throw error;
    }
  }

  async retryFadadaPersonalAccount(customerId: string, actorId?: string) {
    const binding = await this.getOrCreateFadadaPersonalBinding(customerId, actorId);
    if (binding.registrationStatus === ESignProviderAccountStatus.REGISTERED && binding.providerCustomerId) {
      return toView(binding);
    }
    if (
      binding.registrationStatus !== ESignProviderAccountStatus.PENDING &&
      binding.registrationStatus !== ESignProviderAccountStatus.FAILED
    ) {
      throw new BadRequestException(`FADADA_PROVIDER_ACCOUNT_RETRY_NOT_ALLOWED: ${binding.registrationStatus}`);
    }
    return this.registerFadadaPersonalAccount(customerId, actorId);
  }

  async manuallyAttachFadadaPersonalAccount(input: FadadaManualAttachInput, actorId?: string) {
    const providerCustomerId = input.providerCustomerId.trim();
    if (!providerCustomerId) {
      throw new BadRequestException("FADADA_PROVIDER_CUSTOMER_ID_MISSING");
    }

    await this.assertCustomerExists(input.customerId);
    const conflict = await this.prisma.customerESignProviderAccount.findFirst({
      where: {
        NOT: { customerId: input.customerId },
        deletedAt: null,
        provider: ESignProviderType.FADADA,
        providerCustomerId
      }
    });
    if (conflict) {
      throw new ConflictException(`${FADADA_PROVIDER_ACCOUNT_CONFLICT}: provider customer id is already attached`);
    }

    const existing = await this.findFadadaPersonalBinding(input.customerId);
    const realNameStatus = input.realNameStatus ?? ESignRealNameStatus.UNVERIFIED;
    const verifiedAt = realNameStatus === ESignRealNameStatus.VERIFIED ? new Date() : undefined;
    if (existing) {
      if (existing.providerCustomerId && existing.providerCustomerId !== providerCustomerId) {
        throw new ConflictException(`${FADADA_PROVIDER_ACCOUNT_ALREADY_ATTACHED}: provider customer id already exists`);
      }

      const updated = await this.prisma.customerESignProviderAccount.update({
        data: {
          lastErrorCode: null,
          lastErrorMessage: null,
          providerCustomerId,
          realNameStatus,
          registrationStatus: ESignProviderAccountStatus.REGISTERED,
          source: ESignProviderAccountSource.MANUAL,
          updatedBy: actorId,
          ...(verifiedAt ? { verifiedAt } : {})
        },
        where: { id: existing.id }
      });
      return toView(updated);
    }

    const created = await this.prisma.customerESignProviderAccount.create({
      data: {
        accountType: ESignProviderAccountType.PERSONAL,
        createdBy: actorId,
        customerId: input.customerId,
        provider: ESignProviderType.FADADA,
        providerCustomerId,
        providerOpenId: createFadadaProviderOpenId(input.customerId),
        realNameStatus,
        registrationStatus: ESignProviderAccountStatus.REGISTERED,
        source: ESignProviderAccountSource.MANUAL,
        updatedBy: actorId,
        ...(verifiedAt ? { verifiedAt } : {})
      }
    });
    return toView(created);
  }

  async markRealNameStatus(input: FadadaRealNameStatusInput, actorId?: string) {
    const binding = await this.getOrCreateFadadaPersonalBinding(input.customerId, actorId);
    const updated = await this.prisma.customerESignProviderAccount.update({
      data: {
        realNameStatus: input.realNameStatus,
        updatedBy: actorId,
        verificationSerialNo: input.verificationSerialNo,
        verificationTransactionNo: input.verificationTransactionNo,
        ...(input.realNameStatus === ESignRealNameStatus.VERIFIED ? { verifiedAt: new Date() } : {})
      },
      where: { id: binding.id }
    });
    return toView(updated);
  }

  async startFadadaPersonalRealNameVerification(
    customerId: string,
    input: StartFadadaRealNameVerificationInput,
    actorId?: string
  ): Promise<StartFadadaRealNameVerificationResult> {
    if (!this.isRealNameVerifyEnabled()) {
      throw new BadRequestException(`${FADADA_REALNAME_VERIFY_DISABLED}: real-name verification is disabled`);
    }
    const binding = await this.getRegisteredFadadaPersonalBinding(customerId);
    if (binding.realNameStatus === ESignRealNameStatus.VERIFIED) {
      throw new BadRequestException(`${FADADA_REALNAME_ALREADY_VERIFIED}: real-name status is already verified`);
    }

    const urls = this.realNameUrls();
    const result = await this.createFadadaApiClient().getPersonVerifyUrl({
      certFlag: input.certFlag,
      customerId: binding.providerCustomerId!,
      idCardNo: input.idCardNo,
      mobile: input.mobile,
      name: input.name,
      notifyUrl: urls.notifyUrl,
      option: input.option ?? this.configService.get<string>("FADADA_VERIFY_OPTION") ?? "add",
      pageModify: input.pageModify ?? this.configService.get<string>("FADADA_VERIFY_PAGE_MODIFY") ?? "1",
      returnUrl: urls.returnUrl,
      verifiedWay: input.verifiedWay ?? this.configService.get<string>("FADADA_PERSON_VERIFY_WAY") ?? "1"
    });
    const verificationNo = result.transactionNo;
    const updated = await this.prisma.customerESignProviderAccount.update({
      data: {
        lastErrorCode: null,
        lastErrorMessage: null,
        providerSnapshot: sanitizeProviderSnapshot({
          realNameVerifyUrl: {
            raw: result.raw,
            resultCode: result.resultCode,
            resultDesc: result.resultDesc,
            verifyUrl: result.verifyUrl
          }
        }),
        realNameStatus: ESignRealNameStatus.PENDING,
        updatedBy: actorId,
        ...(verificationNo ? {
          verificationSerialNo: verificationNo,
          verificationTransactionNo: verificationNo
        } : {})
      },
      where: { id: binding.id }
    });

    return {
      account: toView(updated),
      verifyUrlMasked: maskUrl(result.verifyUrl),
      verifyUrlPresent: Boolean(result.verifyUrl)
    };
  }

  async refreshFadadaRealNameStatus(customerId: string, actorId?: string) {
    if (!this.isRealNameVerifyEnabled()) {
      throw new BadRequestException(`${FADADA_REALNAME_VERIFY_DISABLED}: real-name verification is disabled`);
    }
    const binding = await this.getRegisteredFadadaPersonalBinding(customerId);
    const verifiedSerialNo = binding.verificationSerialNo ?? binding.verificationTransactionNo;
    if (!verifiedSerialNo) {
      throw new BadRequestException(`${FADADA_REALNAME_VERIFY_SERIAL_MISSING}: verification serial no is required`);
    }

    const result = await this.createFadadaApiClient().findPersonCertInfo({ verifiedSerialNo });
    const nextStatus = transitionRealNameStatus(
      binding.realNameStatus,
      mapFadadaRealNameStatus(result.realNameStatus ?? result.resultCode)
    );
    const updated = await this.prisma.customerESignProviderAccount.update({
      data: {
        lastErrorCode: null,
        lastErrorMessage: null,
        providerSnapshot: sanitizeProviderSnapshot({
          realNameStatusQuery: {
            raw: result.raw,
            resultCode: result.resultCode,
            resultDesc: result.resultDesc
          }
        }),
        realNameStatus: nextStatus,
        updatedBy: actorId,
        ...(nextStatus === ESignRealNameStatus.VERIFIED ? { verifiedAt: new Date() } : {})
      },
      where: { id: binding.id }
    });

    return toView(updated);
  }

  async applyFadadaPersonalCert(customerId: string, actorId?: string) {
    if (!this.isRealNameVerifyEnabled()) {
      throw new BadRequestException(`${FADADA_REALNAME_VERIFY_DISABLED}: real-name verification is disabled`);
    }
    const binding = await this.getRegisteredFadadaPersonalBinding(customerId);
    if (binding.realNameStatus !== ESignRealNameStatus.VERIFIED) {
      throw new BadRequestException(`FADADA_REALNAME_NOT_VERIFIED: current status ${binding.realNameStatus}`);
    }
    const verifiedSerialNo = binding.verificationSerialNo ?? binding.verificationTransactionNo;
    if (!verifiedSerialNo) {
      throw new BadRequestException(`${FADADA_REALNAME_VERIFY_SERIAL_MISSING}: verification serial no is required`);
    }

    const result = await this.createFadadaApiClient().applyCert({
      customerId: binding.providerCustomerId!,
      verifiedSerialNo
    });
    const updated = await this.prisma.customerESignProviderAccount.update({
      data: {
        lastErrorCode: null,
        lastErrorMessage: null,
        providerSnapshot: sanitizeProviderSnapshot({
          applyCert: {
            raw: result.raw,
            resultCode: result.resultCode,
            resultDesc: result.resultDesc
          }
        }),
        realNameStatus: ESignRealNameStatus.VERIFIED,
        updatedBy: actorId,
        verifiedAt: binding.verifiedAt ?? new Date()
      },
      where: { id: binding.id }
    });
    return toView(updated);
  }

  async handleFadadaVerifyCallback(payload: unknown): Promise<FadadaVerifyCallbackResult> {
    const record = normalizeCallbackPayload(payload);
    const transactionNo = stringOrUndefined(record.transaction_no) ??
      stringOrUndefined(record.transactionNo) ??
      stringOrUndefined(record.verified_serialno) ??
      stringOrUndefined(record.verifiedSerialNo);
    const timestamp = stringOrUndefined(record.timestamp);
    const receivedMsgDigest = stringOrUndefined(record.msg_digest);
    const verified = Boolean(transactionNo && timestamp && receivedMsgDigest) &&
      this.verifyCallbackDigest(record, transactionNo!, timestamp!, receivedMsgDigest!);

    if (!verified) {
      return {
        handled: false,
        reason: "UNVERIFIED",
        verified: false,
        verificationSerialNo: transactionNo,
        verificationTransactionNo: transactionNo
      };
    }

    const binding = transactionNo ? await this.findFadadaPersonalBindingByVerificationNo(transactionNo) : null;
    if (!binding) {
      return {
        handled: false,
        reason: "ACCOUNT_NOT_FOUND",
        verified: true,
        verificationSerialNo: transactionNo,
        verificationTransactionNo: transactionNo
      };
    }

    const incomingStatus = mapFadadaRealNameStatus(
      stringOrUndefined(record.realname_status) ??
      stringOrUndefined(record.realNameStatus) ??
      stringOrUndefined(record.status) ??
      stringOrUndefined(record.result_code)
    );
    const nextStatus = transitionRealNameStatus(binding.realNameStatus, incomingStatus);
    const updated = await this.prisma.customerESignProviderAccount.update({
      data: {
        providerSnapshot: sanitizeProviderSnapshot({
          realNameCallback: record
        }),
        realNameStatus: nextStatus,
        verificationSerialNo: binding.verificationSerialNo ?? transactionNo,
        verificationTransactionNo: binding.verificationTransactionNo ?? transactionNo,
        ...(nextStatus === ESignRealNameStatus.VERIFIED ? { verifiedAt: binding.verifiedAt ?? new Date() } : {})
      },
      where: { id: binding.id }
    });

    return {
      handled: true,
      realNameStatus: updated.realNameStatus,
      verified: true,
      verificationSerialNo: updated.verificationSerialNo ?? undefined,
      verificationTransactionNo: updated.verificationTransactionNo ?? undefined
    };
  }

  private async getOrCreateFadadaPersonalBinding(customerId: string, actorId?: string) {
    await this.assertCustomerExists(customerId);
    const existing = await this.findFadadaPersonalBinding(customerId);
    if (existing) {
      return existing;
    }

    return this.prisma.customerESignProviderAccount.create({
      data: {
        accountType: ESignProviderAccountType.PERSONAL,
        createdBy: actorId,
        customerId,
        provider: ESignProviderType.FADADA,
        providerOpenId: createFadadaProviderOpenId(customerId),
        registrationStatus: ESignProviderAccountStatus.PENDING,
        realNameStatus: ESignRealNameStatus.UNVERIFIED,
        source: ESignProviderAccountSource.SYSTEM_REGISTER,
        updatedBy: actorId
      }
    });
  }

  private async findFadadaPersonalBinding(customerId: string) {
    return this.prisma.customerESignProviderAccount.findFirst({
      where: {
        accountType: ESignProviderAccountType.PERSONAL,
        customerId,
        deletedAt: null,
        provider: ESignProviderType.FADADA
      }
    });
  }

  private async findFadadaPersonalBindingByVerificationNo(verificationNo: string) {
    const byTransactionNo = await this.prisma.customerESignProviderAccount.findFirst({
      where: {
        deletedAt: null,
        provider: ESignProviderType.FADADA,
        verificationTransactionNo: verificationNo
      }
    });
    if (byTransactionNo) {
      return byTransactionNo;
    }
    return this.prisma.customerESignProviderAccount.findFirst({
      where: {
        deletedAt: null,
        provider: ESignProviderType.FADADA,
        verificationSerialNo: verificationNo
      }
    });
  }

  private async getRegisteredFadadaPersonalBinding(customerId: string) {
    await this.assertCustomerExists(customerId);
    const binding = await this.findFadadaPersonalBinding(customerId);
    if (!binding?.providerCustomerId || binding.registrationStatus !== ESignProviderAccountStatus.REGISTERED) {
      throw new BadRequestException(`${FADADA_PROVIDER_ACCOUNT_NOT_REGISTERED}: registered provider customer id is required`);
    }
    return binding;
  }

  private async assertCustomerExists(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      select: { id: true },
      where: { id: customerId }
    });
    if (!customer) {
      throw new NotFoundException("CUSTOMER_NOT_FOUND");
    }
  }

  private isAccountRegisterEnabled() {
    const normalized = this.configService.get<string>("FADADA_ACCOUNT_REGISTER_ENABLED")?.trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(normalized ?? "");
  }

  private isRealNameVerifyEnabled() {
    const normalized = this.configService.get<string>("FADADA_REALNAME_VERIFY_ENABLED")?.trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(normalized ?? "");
  }

  private realNameUrls() {
    const notifyUrl = this.configService.get<string>("FADADA_VERIFY_NOTIFY_URL")?.trim();
    const returnUrl = this.configService.get<string>("FADADA_VERIFY_RETURN_URL")?.trim();
    if (!notifyUrl || !returnUrl) {
      throw new BadRequestException(`${FADADA_REALNAME_VERIFY_CONFIG_MISSING}: verify notify and return URLs are required`);
    }
    return { notifyUrl, returnUrl };
  }

  private createFadadaApiClient() {
    if (this.fadadaApiClient) {
      return this.fadadaApiClient;
    }
    const config = loadFadadaConfig(this.configService);
    return new FadadaApiClient(config, new FadadaHttpClient(config));
  }

  private verifyCallbackDigest(
    record: Record<string, unknown>,
    transactionNo: string,
    timestamp: string,
    receivedMsgDigest: string
  ) {
    const appId = this.configService.get<string>("FADADA_APP_ID")?.trim();
    const appSecret = this.configService.get<string>("FADADA_APP_SECRET")?.trim();
    if (!appId || !appSecret) {
      return false;
    }
    return verifyFadadaCallbackDigest({
      appId,
      appSecret,
      businessParams: record,
      explicitSortString: transactionNo,
      receivedMsgDigest,
      timestamp
    });
  }
}

function toView(account: CustomerESignProviderAccount): CustomerESignProviderAccountView {
  return {
    accountType: account.accountType,
    createdAt: account.createdAt,
    id: account.id,
    lastErrorCode: account.lastErrorCode,
    lastErrorMessage: account.lastErrorMessage,
    provider: account.provider,
    providerCustomerId: maskIdentifier(account.providerCustomerId),
    providerOpenId: maskIdentifier(account.providerOpenId) ?? "",
    registrationStatus: account.registrationStatus,
    realNameStatus: account.realNameStatus,
    source: account.source,
    updatedAt: account.updatedAt,
    verifiedAt: account.verifiedAt,
    verificationSerialNo: account.verificationSerialNo,
    verificationTransactionNo: account.verificationTransactionNo
  };
}

function maskIdentifier(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  if (value.length <= 10) {
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

function maskUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}/...`;
  } catch {
    return "[redacted-url]";
  }
}

function sanitizeProviderSnapshot(value: unknown): Prisma.InputJsonValue {
  if (value === null || value === undefined) {
    return {};
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProviderSnapshot(item)) as Prisma.InputJsonValue;
  }
  if (typeof value === "object") {
    const sanitized: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = isSensitiveProviderKey(key)
        ? "[redacted]"
        : sanitizeProviderSnapshot(item);
    }
    return sanitized;
  }
  if (typeof value === "string") {
    return value.length > 512 ? `${value.slice(0, 509)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

function isSensitiveProviderKey(key: string) {
  const normalized = key.toLowerCase();
  return [
    "customer_id",
    "customerid",
    "idcard",
    "id_card",
    "identno",
    "ident_no",
    "mobile",
    "phone",
    "secret",
    "token",
    "url",
    "name"
  ].some((part) => normalized.includes(part));
}

function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(":")[0]?.slice(0, 128) || "FADADA_ACCOUNT_REGISTER_FAILED";
}

function sanitizeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[redacted-email]")
    .replace(/\b1\d{10}\b/g, "[redacted-mobile]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted-id]")
    .slice(0, 500);
}

function mapFadadaRealNameStatus(value: string | undefined): ESignRealNameStatus {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return ESignRealNameStatus.PENDING;
  }
  if (["2", "verified", "success", "passed", "pass", "true", "3000"].includes(normalized)) {
    return ESignRealNameStatus.VERIFIED;
  }
  if (["3", "failed", "fail", "rejected", "reject", "false", "3001"].includes(normalized)) {
    return ESignRealNameStatus.FAILED;
  }
  if (["4", "expired", "expire", "3003"].includes(normalized)) {
    return ESignRealNameStatus.EXPIRED;
  }
  return ESignRealNameStatus.PENDING;
}

function transitionRealNameStatus(
  current: ESignRealNameStatus,
  incoming: ESignRealNameStatus
): ESignRealNameStatus {
  if (current === ESignRealNameStatus.VERIFIED) {
    return ESignRealNameStatus.VERIFIED;
  }
  return incoming;
}

function normalizeCallbackPayload(value: unknown): Record<string, unknown> {
  if (value instanceof URLSearchParams) {
    return Object.fromEntries(value.entries());
  }
  if (typeof value === "string") {
    return Object.fromEntries(new URLSearchParams(value).entries());
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      Array.isArray(item) ? item[0] : item
    ])
  );
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
