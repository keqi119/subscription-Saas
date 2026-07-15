import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditAction,
  CustomerESignProviderAccount,
  ESignProviderAccountSource,
  ESignProviderAccountStatus,
  ESignProviderAccountType,
  ESignProviderCertBindingSource,
  ESignProviderCertBindingStatus,
  ESignProviderRealNameStatusSource,
  ESignProviderType,
  ESignRealNameStatus,
  Prisma
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
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
  verifyUrl: string | null;
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
  certBindingSource: ESignProviderCertBindingSource;
  certBindingStatus: ESignProviderCertBindingStatus;
  certBoundAt: Date | null;
  certSerialNo: string | null;
  createdAt: Date;
  id: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  provider: ESignProviderType;
  providerCustomerId: string | null;
  providerOpenId: string;
  providerStatusLastRefreshedAt: Date | null;
  readinessBlockingCode: string | null;
  readinessBlockingReason: string | null;
  registrationStatus: ESignProviderAccountStatus;
  realNameProviderStatus: string | null;
  realNameProviderStatusSource: ESignProviderRealNameStatusSource;
  realNameProviderVerifiedAt: Date | null;
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
      "applyCert" | "findPersonCertInfo" | "getPersonVerifyUrl" | "queryCert" | "registerAccount"
    >,
    @Optional() private readonly auditService?: AuditService
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
    if (existing) {
      if (existing.providerCustomerId && existing.providerCustomerId !== providerCustomerId) {
        throw new ConflictException(`${FADADA_PROVIDER_ACCOUNT_ALREADY_ATTACHED}: provider customer id already exists`);
      }

      const updated = await this.prisma.customerESignProviderAccount.update({
        data: {
          lastErrorCode: null,
          lastErrorMessage: null,
          providerCustomerId,
          certBindingSource: ESignProviderCertBindingSource.UNKNOWN,
          certBindingStatus: ESignProviderCertBindingStatus.UNKNOWN,
          certBoundAt: null,
          certSerialNo: null,
          providerStatusLastRefreshedAt: null,
          realNameProviderStatus: null,
          realNameProviderStatusSource: ESignProviderRealNameStatusSource.MANUAL_ATTACH_PROVIDER_ID_ONLY,
          realNameProviderVerifiedAt: null,
          realNameStatus: ESignRealNameStatus.UNVERIFIED,
          registrationStatus: ESignProviderAccountStatus.REGISTERED,
          source: ESignProviderAccountSource.MANUAL,
          updatedBy: actorId,
          verifiedAt: null
        },
        where: { id: existing.id }
      });
      await this.auditProviderAccountOverride("manual_attach", updated, actorId, existing);
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
        certBindingSource: ESignProviderCertBindingSource.UNKNOWN,
        certBindingStatus: ESignProviderCertBindingStatus.UNKNOWN,
        realNameProviderStatusSource: ESignProviderRealNameStatusSource.MANUAL_ATTACH_PROVIDER_ID_ONLY,
        realNameStatus: ESignRealNameStatus.UNVERIFIED,
        registrationStatus: ESignProviderAccountStatus.REGISTERED,
        source: ESignProviderAccountSource.MANUAL,
        updatedBy: actorId
      }
    });
    await this.auditProviderAccountOverride("manual_attach", created, actorId);
    return toView(created);
  }

  async markRealNameStatus(input: FadadaRealNameStatusInput, actorId?: string) {
    const binding = await this.getOrCreateFadadaPersonalBinding(input.customerId, actorId);
    const updated = await this.prisma.customerESignProviderAccount.update({
      data: {
        certBindingSource: ESignProviderCertBindingSource.UNKNOWN,
        certBindingStatus: ESignProviderCertBindingStatus.UNKNOWN,
        certBoundAt: null,
        certSerialNo: null,
        providerStatusLastRefreshedAt: null,
        realNameProviderStatus: null,
        realNameProviderStatusSource: ESignProviderRealNameStatusSource.UNKNOWN,
        realNameProviderVerifiedAt: null,
        realNameStatus: input.realNameStatus,
        updatedBy: actorId,
        verificationSerialNo: input.verificationSerialNo,
        verificationTransactionNo: input.verificationTransactionNo,
        ...(input.realNameStatus === ESignRealNameStatus.VERIFIED ? { verifiedAt: new Date() } : {})
      },
      where: { id: binding.id }
    });
    await this.auditProviderAccountOverride("manual_real_name_status", updated, actorId, binding);
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
        certBindingSource: ESignProviderCertBindingSource.UNKNOWN,
        certBindingStatus: ESignProviderCertBindingStatus.UNKNOWN,
        certBoundAt: null,
        certSerialNo: null,
        providerStatusLastRefreshedAt: null,
        realNameProviderStatus: null,
        realNameProviderStatusSource: ESignProviderRealNameStatusSource.UNKNOWN,
        realNameProviderVerifiedAt: null,
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
      verifyUrl: result.verifyUrl ?? null,
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
    const providerStatus = result.realNameStatus ?? result.resultCode ?? null;
    const nextStatus = transitionRealNameStatus(
      binding.realNameStatus,
      mapFadadaRealNameStatus(providerStatus ?? undefined)
    );
    const now = new Date();
    const updated = await this.prisma.customerESignProviderAccount.update({
      data: {
        lastErrorCode: null,
        lastErrorMessage: null,
        providerSnapshot: mergeProviderSnapshot(binding.providerSnapshot, {
          realNameStatusQuery: {
            raw: result.raw,
            resultCode: result.resultCode,
            resultDesc: result.resultDesc
          }
        }),
        providerStatusLastRefreshedAt: now,
        realNameProviderStatus: providerStatus,
        realNameProviderStatusSource: ESignProviderRealNameStatusSource.QUERY,
        ...(nextStatus === ESignRealNameStatus.VERIFIED ? {
          certBindingStatus: binding.certBindingStatus === ESignProviderCertBindingStatus.BOUND
            ? ESignProviderCertBindingStatus.BOUND
            : ESignProviderCertBindingStatus.PENDING,
          realNameProviderVerifiedAt: binding.realNameProviderVerifiedAt ?? now,
          verifiedAt: binding.verifiedAt ?? now
        } : {}),
        realNameStatus: nextStatus,
        updatedBy: actorId
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
    if (!hasProviderBackedRealNameEvidence(binding)) {
      throw new BadRequestException("FADADA_REALNAME_PROVIDER_EVIDENCE_MISSING: provider query or callback is required before binding cert");
    }
    const verifiedSerialNo = binding.verificationSerialNo ?? binding.verificationTransactionNo;
    if (!verifiedSerialNo) {
      throw new BadRequestException(`${FADADA_REALNAME_VERIFY_SERIAL_MISSING}: verification serial no is required`);
    }

    let result: Awaited<ReturnType<FadadaApiClient["applyCert"]>>;
    try {
      result = await this.createFadadaApiClient().applyCert({
        customerId: binding.providerCustomerId!,
        verifiedSerialNo
      });
    } catch (error) {
      await this.recordApplyCertFailure(binding, {
        actorId,
        error
      });
      throw error;
    }
    if (result.resultCode && !isFadadaSuccessCode(result.resultCode)) {
      await this.recordApplyCertFailure(binding, {
        actorId,
        result
      });
      throw new BadRequestException(`FADADA_CERT_BINDING_FAILED: ${result.resultCode}`);
    }
    const now = new Date();
    const updated = await this.prisma.customerESignProviderAccount.update({
      data: {
        certBindingSource: ESignProviderCertBindingSource.APPLY_CERT,
        certBindingStatus: ESignProviderCertBindingStatus.BOUND,
        certBoundAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        providerStatusLastRefreshedAt: now,
        providerSnapshot: mergeProviderSnapshot(binding.providerSnapshot, {
          applyCert: {
            raw: result.raw,
            resultCode: result.resultCode,
            resultDesc: result.resultDesc
          }
        }),
        realNameStatus: ESignRealNameStatus.VERIFIED,
        updatedBy: actorId,
        verifiedAt: binding.verifiedAt ?? now
      },
      where: { id: binding.id }
    });
    return toView(updated);
  }

  async refreshFadadaCertBindingStatus(customerId: string, actorId?: string) {
    if (!this.isRealNameVerifyEnabled()) {
      throw new BadRequestException(`${FADADA_REALNAME_VERIFY_DISABLED}: real-name verification is disabled`);
    }
    const binding = await this.getRegisteredFadadaPersonalBinding(customerId);
    if (!hasProviderBackedRealNameEvidence(binding)) {
      throw new BadRequestException("FADADA_REALNAME_PROVIDER_EVIDENCE_MISSING: provider query or callback is required before querying cert");
    }

    const result = await this.createFadadaApiClient().queryCert({
      customerId: binding.providerCustomerId!
    });
    const now = new Date();
    const updated = await this.prisma.customerESignProviderAccount.update({
      data: {
        certBindingSource: ESignProviderCertBindingSource.QUERY_CERT,
        certBindingStatus: result.certBound
          ? ESignProviderCertBindingStatus.BOUND
          : ESignProviderCertBindingStatus.UNBOUND,
        certBoundAt: result.certBound ? binding.certBoundAt ?? now : null,
        certSerialNo: result.certBound ? result.certSerialNo ?? binding.certSerialNo : null,
        lastErrorCode: result.certBound ? null : result.resultCode ?? "FADADA_CERT_NOT_BOUND",
        lastErrorMessage: result.certBound ? null : sanitizeErrorMessage(result.resultDesc ?? "certificate binding not confirmed"),
        providerStatusLastRefreshedAt: now,
        providerSnapshot: mergeProviderSnapshot(binding.providerSnapshot, {
          queryCert: {
            raw: result.raw,
            resultCode: result.resultCode,
            resultDesc: result.resultDesc
          }
        }),
        readinessBlockingCode: result.certBound ? null : "FADADA_CERT_NOT_BOUND",
        readinessBlockingReason: result.certBound ? null : "certificate binding is not provider-confirmed",
        updatedBy: actorId
      },
      where: { id: binding.id }
    });
    return toView(updated);
  }

  private async recordApplyCertFailure(
    binding: CustomerESignProviderAccount,
    input: {
      actorId?: string;
      error?: unknown;
      result?: {
        raw?: unknown;
        resultCode?: string;
        resultDesc?: string;
      };
    }
  ) {
    const now = new Date();
    const code = input.result?.resultCode
      ? "FADADA_CERT_BINDING_FAILED"
      : errorCode(input.error);
    const message = input.result?.resultCode
      ? `FADADA_CERT_BINDING_FAILED: ${input.result.resultCode}${input.result.resultDesc ? ` ${input.result.resultDesc}` : ""}`
      : input.error;
    await this.prisma.customerESignProviderAccount.update({
      data: {
        certBindingSource: ESignProviderCertBindingSource.APPLY_CERT,
        certBindingStatus: ESignProviderCertBindingStatus.UNBOUND,
        certBoundAt: null,
        certSerialNo: null,
        lastErrorCode: code,
        lastErrorMessage: sanitizeErrorMessage(message),
        providerSnapshot: mergeProviderSnapshot(binding.providerSnapshot, {
          applyCert: {
            error: input.error ? sanitizeErrorMessage(input.error) : undefined,
            raw: input.result?.raw,
            resultCode: input.result?.resultCode,
            resultDesc: input.result?.resultDesc
          }
        }),
        providerStatusLastRefreshedAt: now,
        readinessBlockingCode: "FADADA_CERT_NOT_BOUND",
        readinessBlockingReason: "certificate binding is not provider-confirmed",
        updatedBy: input.actorId
      },
      where: { id: binding.id }
    });
  }

  async handleFadadaVerifyCallback(payload: unknown): Promise<FadadaVerifyCallbackResult> {
    const record = normalizeCallbackPayload(payload);
    const transactionNo = stringOrUndefined(record.transaction_no) ??
      stringOrUndefined(record.transactionNo) ??
      stringOrUndefined(record.verified_serialno) ??
      stringOrUndefined(record.verifiedSerialNo) ??
      stringOrUndefined(record.serialNo);
    const timestamp = stringOrUndefined(record.timestamp);
    const receivedMsgDigest = stringOrUndefined(record.msg_digest) ?? stringOrUndefined(record.sign);
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
    const providerStatus = stringOrUndefined(record.realname_status) ??
      stringOrUndefined(record.realNameStatus) ??
      stringOrUndefined(record.status) ??
      stringOrUndefined(record.result_code) ??
      null;
    const certStatus = stringOrUndefined(record.certStatus) ?? stringOrUndefined(record.cert_status);
    const certBoundFromCallback = nextStatus === ESignRealNameStatus.VERIFIED && certStatus === "1";
    const now = new Date();
    const updated = await this.prisma.customerESignProviderAccount.update({
      data: {
        providerSnapshot: sanitizeProviderSnapshot({
          realNameCallback: record
        }),
        providerStatusLastRefreshedAt: now,
        realNameProviderStatus: providerStatus,
        realNameProviderStatusSource: ESignProviderRealNameStatusSource.CALLBACK,
        ...(nextStatus === ESignRealNameStatus.VERIFIED ? {
          certBindingSource: certBoundFromCallback
            ? ESignProviderCertBindingSource.CALLBACK_CERT_STATUS
            : binding.certBindingSource,
          certBindingStatus: certBoundFromCallback
            ? ESignProviderCertBindingStatus.BOUND
            : binding.certBindingStatus === ESignProviderCertBindingStatus.BOUND
              ? ESignProviderCertBindingStatus.BOUND
              : ESignProviderCertBindingStatus.PENDING,
          certBoundAt: certBoundFromCallback ? binding.certBoundAt ?? now : binding.certBoundAt,
          realNameProviderVerifiedAt: binding.realNameProviderVerifiedAt ?? now
        } : {}),
        realNameStatus: nextStatus,
        verificationSerialNo: binding.verificationSerialNo ?? transactionNo,
        verificationTransactionNo: binding.verificationTransactionNo ?? transactionNo,
        ...(nextStatus === ESignRealNameStatus.VERIFIED ? { verifiedAt: binding.verifiedAt ?? now } : {})
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

  private async auditProviderAccountOverride(
    overrideType: "manual_attach" | "manual_real_name_status",
    after: CustomerESignProviderAccount,
    actorId?: string,
    before?: CustomerESignProviderAccount
  ) {
    if (!this.auditService) {
      return;
    }
    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: {
        account: toView(after),
        overrideType
      },
      before: before ? {
        account: toView(before),
        overrideType
      } : undefined,
      entityId: after.id,
      entityType: "customer_esign_provider_account",
      module: "esign",
      operatorId: actorId
    });
  }
}

function toView(account: CustomerESignProviderAccount): CustomerESignProviderAccountView {
  return {
    accountType: account.accountType,
    certBindingSource: account.certBindingSource,
    certBindingStatus: account.certBindingStatus,
    certBoundAt: account.certBoundAt,
    certSerialNo: maskIdentifier(account.certSerialNo),
    createdAt: account.createdAt,
    id: account.id,
    lastErrorCode: account.lastErrorCode,
    lastErrorMessage: account.lastErrorMessage,
    provider: account.provider,
    providerCustomerId: maskIdentifier(account.providerCustomerId),
    providerOpenId: maskIdentifier(account.providerOpenId) ?? "",
    providerStatusLastRefreshedAt: account.providerStatusLastRefreshedAt,
    readinessBlockingCode: account.readinessBlockingCode,
    readinessBlockingReason: account.readinessBlockingReason,
    registrationStatus: account.registrationStatus,
    realNameProviderStatus: account.realNameProviderStatus,
    realNameProviderStatusSource: account.realNameProviderStatusSource,
    realNameProviderVerifiedAt: account.realNameProviderVerifiedAt,
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

function mergeProviderSnapshot(existing: unknown, patch: Record<string, unknown>): Prisma.InputJsonValue {
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  return sanitizeProviderSnapshot({
    ...base,
    ...patch
  });
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

function isFadadaSuccessCode(code: string | undefined) {
  return code === "1" || code === "1000" || code?.toLowerCase() === "success";
}

function hasProviderBackedRealNameEvidence(account: CustomerESignProviderAccount) {
  if (account.realNameStatus !== ESignRealNameStatus.VERIFIED) {
    return false;
  }
  return account.realNameProviderStatusSource === ESignProviderRealNameStatusSource.CALLBACK ||
    account.realNameProviderStatusSource === ESignProviderRealNameStatusSource.QUERY;
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
