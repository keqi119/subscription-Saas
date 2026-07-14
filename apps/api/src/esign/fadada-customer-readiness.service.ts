import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CustomerESignProviderAccount,
  ESignProviderAccountSource,
  ESignProviderAccountStatus,
  ESignProviderAccountType,
  ESignProviderCertBindingSource,
  ESignProviderCertBindingStatus,
  ESignProviderRealNameStatusSource,
  ESignProviderType,
  ESignRealNameStatus
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

export type FadadaReadinessState =
  | "CERT_BINDING_PENDING"
  | "FAILED"
  | "NOT_STARTED"
  | "REALNAME_PENDING"
  | "REGISTERED"
  | "SIGNING_ENABLED"
  | "UNKNOWN";

export type FadadaReadinessNextAction =
  | "APPLY_CERT"
  | "CONTACT_SUPPORT"
  | "NONE"
  | "QUERY_PROVIDER_STATUS"
  | "REGISTER_PROVIDER_ACCOUNT"
  | "START_ONBOARDING"
  | "START_REALNAME_VERIFICATION"
  | "WAIT_REALNAME_CALLBACK";

export interface FadadaCustomerReadiness {
  blockingCode: string | null;
  blockingMessage: string | null;
  certBound: boolean;
  certSerialNoPresent: boolean;
  lastProviderCheckAt: Date | null;
  nextAction: FadadaReadinessNextAction;
  provider: ESignProviderType;
  providerCustomerIdPresent: boolean;
  readyForSigning: boolean;
  realNameProviderVerified: boolean;
  state: FadadaReadinessState;
}

const DEFAULT_BLOCKING_MESSAGE = "请先完成法大大实名认证并绑定实名证书";

@Injectable()
export class FadadaCustomerReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService
  ) {}

  async getReadiness(customerId: string): Promise<FadadaCustomerReadiness> {
    const account = await this.prisma.customerESignProviderAccount.findFirst({
      where: {
        accountType: ESignProviderAccountType.PERSONAL,
        customerId,
        deletedAt: null,
        provider: ESignProviderType.FADADA
      }
    });

    if (!account) {
      return notReady("NOT_STARTED", "FADADA_ACCOUNT_MISSING", "START_ONBOARDING", {
        certBound: false,
        providerCustomerIdPresent: false,
        realNameProviderVerified: false
      });
    }

    const providerCustomerIdPresent = Boolean(account.providerCustomerId);
    const realNameProviderVerified = hasProviderBackedRealName(account);
    const certBound = hasProviderBackedCert(account);
    const lastProviderCheckAt = account.providerStatusLastRefreshedAt ?? account.certBoundAt ?? account.realNameProviderVerifiedAt;

    if (account.registrationStatus !== ESignProviderAccountStatus.REGISTERED) {
      return notReady("REGISTERED", "FADADA_ACCOUNT_NOT_REGISTERED", "REGISTER_PROVIDER_ACCOUNT", {
        certBound,
        lastProviderCheckAt,
        providerCustomerIdPresent,
        realNameProviderVerified
      });
    }

    if (!providerCustomerIdPresent) {
      return notReady("REGISTERED", "FADADA_PROVIDER_CUSTOMER_ID_MISSING", "REGISTER_PROVIDER_ACCOUNT", {
        certBound,
        lastProviderCheckAt,
        providerCustomerIdPresent,
        realNameProviderVerified
      });
    }

    if (account.realNameStatus === ESignRealNameStatus.FAILED || account.realNameStatus === ESignRealNameStatus.EXPIRED) {
      return notReady("FAILED", "FADADA_REALNAME_FAILED", "CONTACT_SUPPORT", {
        certBound,
        lastProviderCheckAt,
        providerCustomerIdPresent,
        realNameProviderVerified
      });
    }

    if (isManualOnly(account) && !realNameProviderVerified) {
      return notReady("UNKNOWN", "FADADA_MANUAL_ONLY_NOT_SIGNING_READY", "QUERY_PROVIDER_STATUS", {
        certBound,
        lastProviderCheckAt,
        providerCustomerIdPresent,
        realNameProviderVerified
      });
    }

    if (!realNameProviderVerified && account.realNameStatus === ESignRealNameStatus.PENDING) {
      return notReady("REALNAME_PENDING", "FADADA_REALNAME_PENDING", "WAIT_REALNAME_CALLBACK", {
        certBound,
        lastProviderCheckAt,
        providerCustomerIdPresent,
        realNameProviderVerified
      });
    }

    if (!realNameProviderVerified && account.realNameStatus !== ESignRealNameStatus.VERIFIED) {
      return notReady("REGISTERED", "FADADA_REALNAME_NOT_STARTED", "START_REALNAME_VERIFICATION", {
        certBound,
        lastProviderCheckAt,
        providerCustomerIdPresent,
        realNameProviderVerified
      });
    }

    if (!certBound) {
      return notReady("CERT_BINDING_PENDING", "FADADA_CERT_NOT_BOUND", "APPLY_CERT", {
        certBound,
        lastProviderCheckAt,
        providerCustomerIdPresent,
        realNameProviderVerified
      });
    }

    if (!lastProviderCheckAt) {
      return notReady("UNKNOWN", "FADADA_PROVIDER_STATUS_UNKNOWN", "QUERY_PROVIDER_STATUS", {
        certBound,
        lastProviderCheckAt,
        providerCustomerIdPresent,
        realNameProviderVerified
      });
    }

    if (this.isStale(lastProviderCheckAt)) {
      return notReady("UNKNOWN", "FADADA_PROVIDER_STATUS_STALE", "QUERY_PROVIDER_STATUS", {
        certBound,
        lastProviderCheckAt,
        providerCustomerIdPresent,
        realNameProviderVerified
      });
    }

    return {
      blockingCode: null,
      blockingMessage: null,
      certBound,
      certSerialNoPresent: Boolean(account.certSerialNo),
      lastProviderCheckAt,
      nextAction: "NONE",
      provider: ESignProviderType.FADADA,
      providerCustomerIdPresent,
      readyForSigning: true,
      realNameProviderVerified,
      state: "SIGNING_ENABLED"
    };
  }

  private isStale(lastProviderCheckAt: Date) {
    const freshnessDays = Number(this.configService.get<string>("FADADA_PROVIDER_STATUS_FRESHNESS_DAYS"));
    if (!Number.isFinite(freshnessDays) || freshnessDays <= 0) {
      return false;
    }
    return Date.now() - lastProviderCheckAt.getTime() > freshnessDays * 24 * 60 * 60 * 1000;
  }
}

function hasProviderBackedRealName(account: CustomerESignProviderAccount) {
  return account.realNameStatus === ESignRealNameStatus.VERIFIED &&
    account.realNameProviderVerifiedAt !== null &&
    (
      account.realNameProviderStatusSource === ESignProviderRealNameStatusSource.CALLBACK ||
      account.realNameProviderStatusSource === ESignProviderRealNameStatusSource.QUERY
    );
}

function hasProviderBackedCert(account: CustomerESignProviderAccount) {
  return account.certBindingStatus === ESignProviderCertBindingStatus.BOUND &&
    account.certBoundAt !== null &&
    (
      account.certBindingSource === ESignProviderCertBindingSource.APPLY_CERT ||
      account.certBindingSource === ESignProviderCertBindingSource.CALLBACK_CERT_STATUS ||
      account.certBindingSource === ESignProviderCertBindingSource.QUERY_CERT
    );
}

function isManualOnly(account: CustomerESignProviderAccount) {
  return account.source === ESignProviderAccountSource.MANUAL ||
    account.realNameProviderStatusSource === ESignProviderRealNameStatusSource.MANUAL_ATTACH_PROVIDER_ID_ONLY;
}

function notReady(
  state: FadadaReadinessState,
  blockingCode: string,
  nextAction: FadadaReadinessNextAction,
  evidence: {
    certBound: boolean;
    lastProviderCheckAt?: Date | null;
    providerCustomerIdPresent: boolean;
    realNameProviderVerified: boolean;
  }
): FadadaCustomerReadiness {
  return {
    blockingCode,
    blockingMessage: DEFAULT_BLOCKING_MESSAGE,
    certBound: evidence.certBound,
    certSerialNoPresent: false,
    lastProviderCheckAt: evidence.lastProviderCheckAt ?? null,
    nextAction,
    provider: ESignProviderType.FADADA,
    providerCustomerIdPresent: evidence.providerCustomerIdPresent,
    readyForSigning: false,
    realNameProviderVerified: evidence.realNameProviderVerified,
    state
  };
}
