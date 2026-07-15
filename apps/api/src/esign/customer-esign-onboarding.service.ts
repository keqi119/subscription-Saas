import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditAction,
  ESignProviderAccountStatus,
  ESignProviderAccountType,
  ESignProviderCertBindingStatus,
  ESignProviderRealNameStatusSource,
  ESignProviderType,
  ESignRealNameStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  CustomerESignProviderAccountService,
  CustomerESignProviderAccountView
} from "./customer-esign-provider-account.service";
import {
  CustomerESignOnboardingRetryStep,
  CustomerESignOnboardingTriggerSource,
  StartCustomerESignOnboardingRealNameDto
} from "./customer-esign-onboarding.dto";
import {
  FadadaCustomerReadiness,
  FadadaCustomerReadinessService
} from "./fadada-customer-readiness.service";

export enum CustomerESignOnboardingState {
  ACCOUNT_CREATED = "ACCOUNT_CREATED",
  CERT_BINDING_PENDING = "CERT_BINDING_PENDING",
  DISABLED = "DISABLED",
  FAILED = "FAILED",
  NOT_STARTED = "NOT_STARTED",
  ONBOARDING = "ONBOARDING",
  REALNAME_PENDING = "REALNAME_PENDING",
  REALNAME_PROVIDER_VERIFIED = "REALNAME_PROVIDER_VERIFIED",
  SIGNING_ENABLED = "SIGNING_ENABLED",
  UNKNOWN = "UNKNOWN",
  VERIFIED = "VERIFIED"
}

export type CustomerESignOnboardingNextAction =
  | "APPLY_CERT"
  | "CONTACT_SUPPORT"
  | "NONE"
  | "QUERY_PROVIDER_STATUS"
  | "REGISTER_PROVIDER_ACCOUNT"
  | "RETRY"
  | "START_ONBOARDING"
  | "START_REALNAME_VERIFICATION"
  | "WAIT_REALNAME_CALLBACK";

export interface CustomerESignOnboardingStatus {
  accountType: ESignProviderAccountType;
  blockingCode: string | null;
  blockingMessage: string | null;
  certBound: boolean;
  certSerialNoPresent: boolean;
  customerId: string;
  lastProviderCheckAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  nextAction: CustomerESignOnboardingNextAction;
  provider: ESignProviderType;
  providerCustomerId: string | null;
  providerCustomerIdPresent: boolean;
  providerOpenId: string | null;
  readyForSigning: boolean;
  realNameProviderVerified: boolean;
  realNameFlow?: {
    c2ServiceInvoked: boolean;
    mockOnly: boolean;
    providerCallExecuted: boolean;
  };
  realNameStatus: ESignRealNameStatus | null;
  realNameUrl?: string | null;
  registrationStatus: ESignProviderAccountStatus | null;
  signingEligible: boolean;
  source?: CustomerESignOnboardingTriggerSource;
  state: CustomerESignOnboardingState;
  verifiedAt: Date | null;
  verifyUrlMasked?: string;
  verifyUrlPresent?: boolean;
  verificationSerialNo: string | null;
  verificationTransactionNo: string | null;
}

export interface CustomerESignOnboardingEntryOptions {
  allowAlreadySigningEnabled?: boolean;
  includeRealNameUrl?: boolean;
  source?: CustomerESignOnboardingTriggerSource;
}

@Injectable()
export class CustomerESignOnboardingService {
  constructor(
    private readonly accountService: CustomerESignProviderAccountService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly prismaService?: PrismaService,
    @Optional() private readonly readinessService?: FadadaCustomerReadinessService
  ) {}

  async getOnboardingStatus(customerId: string, options: CustomerESignOnboardingEntryOptions = {}) {
    const account = await this.accountService.getFadadaPersonalBinding(customerId);
    const status = await this.withReadiness(customerId, this.toStatus(customerId, account, options.source));
    if (options.source) {
      await this.writeAudit({
        action: AuditAction.UPDATE,
        customerId,
        event: "esign.onboarding.status",
        nextStatus: status,
        source: options.source
      });
    }
    return status;
  }

  async canStartOnboarding(customerId: string, options: CustomerESignOnboardingEntryOptions = {}) {
    const status = await this.getOnboardingStatus(customerId);
    if (
      status.state === CustomerESignOnboardingState.SIGNING_ENABLED &&
      !options.allowAlreadySigningEnabled
    ) {
      return {
        allowed: false,
        reason: "ESIGN_ONBOARDING_ALREADY_SIGNING_ENABLED",
        status
      };
    }
    if (status.state === CustomerESignOnboardingState.DISABLED) {
      return {
        allowed: false,
        reason: "ESIGN_ONBOARDING_CUSTOMER_DISABLED",
        status
      };
    }
    return {
      allowed: true,
      reason: null,
      status
    };
  }

  async startOnboarding(
    customerId: string,
    actorId?: string,
    options: CustomerESignOnboardingEntryOptions = {}
  ) {
    const source = options.source ?? CustomerESignOnboardingTriggerSource.ADMIN;
    const gate = await this.canStartOnboarding(customerId, options);
    if (!gate.allowed) {
      throw new BadRequestException(`${gate.reason}: onboarding cannot start from ${source}`);
    }
    const account = await this.accountService.ensureFadadaPersonalPendingBinding(customerId, actorId);
    const status = await this.withReadiness(customerId, this.toStatus(customerId, account, source));
    await this.writeAudit({
      action: AuditAction.CREATE,
      actorId,
      customerId,
      event: "esign.onboarding.start",
      nextStatus: status,
      previousStatus: gate.status,
      source
    });
    return status;
  }

  async startOnboardingForOrder(orderId: string, actorId?: string) {
    if (!this.prismaService) {
      throw new BadRequestException("ESIGN_ONBOARDING_ORDER_LOOKUP_UNAVAILABLE");
    }
    const order = await this.prismaService.subscriptionOrder.findUnique({
      select: { customerId: true, id: true },
      where: { id: orderId }
    });
    if (!order) {
      throw new NotFoundException("ORDER_NOT_FOUND");
    }
    return this.startOnboarding(order.customerId, actorId, {
      source: CustomerESignOnboardingTriggerSource.ORDER
    });
  }

  async retryOnboarding(
    customerId: string,
    input: { step: CustomerESignOnboardingRetryStep | `${CustomerESignOnboardingRetryStep}` },
    actorId?: string,
    options: CustomerESignOnboardingEntryOptions = {}
  ) {
    switch (input.step) {
      case CustomerESignOnboardingRetryStep.START:
        return this.startOnboarding(customerId, actorId, options);
      case CustomerESignOnboardingRetryStep.REALNAME_VERIFY:
        return this.triggerRealNameFlow(customerId, actorId, options);
      case CustomerESignOnboardingRetryStep.STATUS_REFRESH:
        return this.refreshProviderBackedReadiness(customerId, actorId, options);
      default:
        throw new BadRequestException(`ESIGN_ONBOARDING_STEP_NOT_ALLOWED: ${input.step}`);
    }
  }

  async startRealNameVerification(
    customerId: string,
    input: StartCustomerESignOnboardingRealNameDto,
    actorId?: string,
    options: CustomerESignOnboardingEntryOptions = {}
  ) {
    if (!this.enabled("FADADA_ONBOARDING_REALNAME_C2_ENABLED")) {
      throw new BadRequestException(
        "ESIGN_ONBOARDING_REALNAME_C2_DISABLED: onboarding real-name C2 wiring is disabled"
      );
    }
    const source = options.source ?? CustomerESignOnboardingTriggerSource.ADMIN;
    const previousStatus = await this.getOnboardingStatus(customerId);
    const result = await this.accountService.startFadadaPersonalRealNameVerification(customerId, input, actorId);
    const baseStatus = await this.withReadiness(customerId, this.toStatus(customerId, result.account, source));
    const status: CustomerESignOnboardingStatus = {
      ...baseStatus,
      realNameFlow: {
        c2ServiceInvoked: true,
        mockOnly: false,
        providerCallExecuted: false
      },
      ...(options.includeRealNameUrl ? { realNameUrl: result.verifyUrl } : {}),
      verifyUrlMasked: result.verifyUrlMasked,
      verifyUrlPresent: result.verifyUrlPresent
    };
    await this.writeAudit({
      action: AuditAction.UPDATE,
      actorId,
      customerId,
      event: "esign.onboarding.c2.realname_start",
      nextStatus: status,
      previousStatus,
      source
    });
    return status;
  }

  async startPortalRealNameVerification(
    customerId: string,
    input: StartCustomerESignOnboardingRealNameDto,
    actorId?: string
  ) {
    const account = await this.accountService.getFadadaPersonalBinding(customerId);
    if (
      !account ||
      account.registrationStatus !== ESignProviderAccountStatus.REGISTERED ||
      !account.providerCustomerId
    ) {
      await this.accountService.registerFadadaPersonalAccount(customerId, actorId);
    }

    return this.startRealNameVerification(customerId, input, actorId, {
      includeRealNameUrl: true,
      source: CustomerESignOnboardingTriggerSource.PORTAL
    });
  }

  async refreshProviderBackedReadiness(
    customerId: string,
    actorId?: string,
    options: CustomerESignOnboardingEntryOptions = {}
  ) {
    const account = await this.accountService.getFadadaPersonalBinding(customerId);
    const serialNo = account?.verificationSerialNo ?? account?.verificationTransactionNo;
    if (
      account?.registrationStatus === ESignProviderAccountStatus.REGISTERED &&
      account.providerCustomerId &&
      serialNo
    ) {
      const refreshed = await this.accountService.refreshFadadaRealNameStatus(customerId, actorId);
      if (hasProviderBackedRealName(refreshed)) {
        await this.accountService.refreshFadadaCertBindingStatus(customerId, actorId);
      }
    }

    return this.getOnboardingStatus(customerId, options);
  }

  async triggerRealNameFlow(
    customerId: string,
    actorId?: string,
    options: CustomerESignOnboardingEntryOptions = {}
  ) {
    if (!this.isMockRealNameAllowed()) {
      throw new BadRequestException(
        "ESIGN_ONBOARDING_REALNAME_INPUT_REQUIRED: use the verify endpoint to invoke C2 real-name service"
      );
    }
    const source = options.source ?? CustomerESignOnboardingTriggerSource.ADMIN;
    const current = await this.getOnboardingStatus(customerId);
    const status: CustomerESignOnboardingStatus = {
      ...current,
      realNameFlow: {
        c2ServiceInvoked: false,
        mockOnly: true,
        providerCallExecuted: false
      },
      source
    };
    await this.writeAudit({
      action: AuditAction.UPDATE,
      actorId,
      customerId,
      event: "esign.onboarding.realname_mock",
      nextStatus: status,
      previousStatus: current,
      source
    });
    return status;
  }

  evaluateEligibility(account: CustomerESignProviderAccountView | null) {
    if (account?.registrationStatus === ESignProviderAccountStatus.DISABLED) {
      return { eligible: false, reasons: ["PROVIDER_ACCOUNT_DISABLED"] };
    }
    return { eligible: true, reasons: [] };
  }

  resolveState(
    account: CustomerESignProviderAccountView | null,
    eligibility = this.evaluateEligibility(account)
  ): CustomerESignOnboardingState {
    if (!eligibility.eligible) {
      return CustomerESignOnboardingState.DISABLED;
    }
    if (!account) {
      return CustomerESignOnboardingState.NOT_STARTED;
    }
    if (account.registrationStatus === ESignProviderAccountStatus.DISABLED) {
      return CustomerESignOnboardingState.DISABLED;
    }
    if (
      account.registrationStatus === ESignProviderAccountStatus.FAILED ||
      account.realNameStatus === ESignRealNameStatus.FAILED ||
      account.realNameStatus === ESignRealNameStatus.EXPIRED
    ) {
      return CustomerESignOnboardingState.FAILED;
    }
    if (account.registrationStatus === ESignProviderAccountStatus.PENDING) {
      return CustomerESignOnboardingState.ONBOARDING;
    }
    if (account.registrationStatus !== ESignProviderAccountStatus.REGISTERED || !account.providerCustomerId) {
      return CustomerESignOnboardingState.ONBOARDING;
    }
    if (account.realNameStatus === ESignRealNameStatus.PENDING) {
      return CustomerESignOnboardingState.REALNAME_PENDING;
    }
    if (account.realNameStatus === ESignRealNameStatus.VERIFIED) {
      if (!hasProviderBackedRealName(account)) {
        return CustomerESignOnboardingState.UNKNOWN;
      }
      if (account.certBindingStatus === ESignProviderCertBindingStatus.BOUND) {
        return CustomerESignOnboardingState.SIGNING_ENABLED;
      }
      return CustomerESignOnboardingState.CERT_BINDING_PENDING;
    }
    return CustomerESignOnboardingState.ACCOUNT_CREATED;
  }

  private toStatus(
    customerId: string,
    account: CustomerESignProviderAccountView | null,
    source?: CustomerESignOnboardingTriggerSource
  ): CustomerESignOnboardingStatus {
    const state = this.resolveState(account);
    const readyForSigning = state === CustomerESignOnboardingState.SIGNING_ENABLED;
    const realNameProviderVerified = Boolean(account && hasProviderBackedRealName(account));
    const certBound = account?.certBindingStatus === ESignProviderCertBindingStatus.BOUND;
    return {
      accountType: account?.accountType ?? ESignProviderAccountType.PERSONAL,
      blockingCode: account?.readinessBlockingCode ?? null,
      blockingMessage: sanitizeMessage(account?.readinessBlockingReason ?? null),
      certBound,
      certSerialNoPresent: Boolean(account?.certSerialNo),
      customerId: maskIdentifier(customerId) ?? "",
      lastProviderCheckAt: account?.providerStatusLastRefreshedAt ?? null,
      lastErrorCode: account?.lastErrorCode ?? null,
      lastErrorMessage: sanitizeMessage(account?.lastErrorMessage ?? null),
      nextAction: nextActionForState(state),
      provider: account?.provider ?? ESignProviderType.FADADA,
      providerCustomerId: maskIdentifier(account?.providerCustomerId),
      providerCustomerIdPresent: Boolean(account?.providerCustomerId),
      providerOpenId: maskIdentifier(account?.providerOpenId),
      readyForSigning,
      realNameProviderVerified,
      realNameStatus: account?.realNameStatus ?? null,
      registrationStatus: account?.registrationStatus ?? null,
      signingEligible: readyForSigning,
      source,
      state,
      verifiedAt: account?.verifiedAt ?? null,
      verificationSerialNo: account?.verificationSerialNo ?? null,
      verificationTransactionNo: account?.verificationTransactionNo ?? null
    };
  }

  private async withReadiness(
    customerId: string,
    status: CustomerESignOnboardingStatus
  ): Promise<CustomerESignOnboardingStatus> {
    if (!this.readinessService) {
      return status;
    }
    const readiness = await this.readinessService.getReadiness(customerId);
    return mergeReadiness(status, readiness);
  }

  private async writeAudit(input: {
    action: AuditAction;
    actorId?: string;
    customerId: string;
    event: string;
    nextStatus: CustomerESignOnboardingStatus;
    previousStatus?: CustomerESignOnboardingStatus;
    source?: CustomerESignOnboardingTriggerSource;
  }) {
    if (!this.auditService) {
      return;
    }
    await this.auditService.write({
      action: input.action,
      after: {
        customerId: maskIdentifier(input.customerId),
        event: input.event,
        source: input.source,
        status: redactOnboardingStatus(input.nextStatus)
      },
      before: input.previousStatus ? {
        customerId: maskIdentifier(input.customerId),
        event: input.event,
        source: input.source,
        status: redactOnboardingStatus(input.previousStatus)
      } : undefined,
      entityType: "customer_esign_onboarding",
      module: "esign",
      operatorId: input.actorId
    });
  }

  private isMockRealNameAllowed() {
    return this.enabled("FADADA_ONBOARDING_MOCK_REALNAME_ENABLED") &&
      this.configService?.get<string>("NODE_ENV") === "test";
  }

  private enabled(key: string) {
    const normalized = this.configService?.get<string>(key)?.trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(normalized ?? "");
  }
}

function nextActionForState(state: CustomerESignOnboardingState): CustomerESignOnboardingNextAction {
  switch (state) {
    case CustomerESignOnboardingState.NOT_STARTED:
      return "START_ONBOARDING";
    case CustomerESignOnboardingState.ONBOARDING:
      return "REGISTER_PROVIDER_ACCOUNT";
    case CustomerESignOnboardingState.ACCOUNT_CREATED:
      return "START_REALNAME_VERIFICATION";
    case CustomerESignOnboardingState.REALNAME_PENDING:
      return "WAIT_REALNAME_CALLBACK";
    case CustomerESignOnboardingState.REALNAME_PROVIDER_VERIFIED:
    case CustomerESignOnboardingState.CERT_BINDING_PENDING:
    case CustomerESignOnboardingState.VERIFIED:
      return "APPLY_CERT";
    case CustomerESignOnboardingState.SIGNING_ENABLED:
      return "NONE";
    case CustomerESignOnboardingState.FAILED:
      return "RETRY";
    case CustomerESignOnboardingState.DISABLED:
    case CustomerESignOnboardingState.UNKNOWN:
      return "CONTACT_SUPPORT";
    default:
      return "CONTACT_SUPPORT";
  }
}

function mergeReadiness(
  status: CustomerESignOnboardingStatus,
  readiness: FadadaCustomerReadiness
): CustomerESignOnboardingStatus {
  return {
    ...status,
    blockingCode: readiness.blockingCode,
    blockingMessage: sanitizeMessage(readiness.blockingMessage),
    certBound: readiness.certBound,
    certSerialNoPresent: readiness.certSerialNoPresent,
    lastProviderCheckAt: readiness.lastProviderCheckAt,
    nextAction: readiness.readyForSigning ? "NONE" : mapReadinessNextAction(readiness.nextAction, status.nextAction),
    provider: readiness.provider,
    providerCustomerIdPresent: readiness.providerCustomerIdPresent,
    readyForSigning: readiness.readyForSigning,
    realNameProviderVerified: readiness.realNameProviderVerified,
    signingEligible: readiness.readyForSigning,
    state: readiness.readyForSigning
      ? CustomerESignOnboardingState.SIGNING_ENABLED
      : mapReadinessState(readiness.state, status.state)
  };
}

function mapReadinessNextAction(
  nextAction: FadadaCustomerReadiness["nextAction"],
  fallback: CustomerESignOnboardingNextAction
): CustomerESignOnboardingNextAction {
  switch (nextAction) {
    case "APPLY_CERT":
    case "CONTACT_SUPPORT":
    case "NONE":
    case "QUERY_PROVIDER_STATUS":
    case "REGISTER_PROVIDER_ACCOUNT":
    case "START_ONBOARDING":
    case "START_REALNAME_VERIFICATION":
    case "WAIT_REALNAME_CALLBACK":
      return nextAction;
    default:
      return fallback;
  }
}

function mapReadinessState(
  readinessState: FadadaCustomerReadiness["state"],
  fallback: CustomerESignOnboardingState
): CustomerESignOnboardingState {
  switch (readinessState) {
    case "CERT_BINDING_PENDING":
      return CustomerESignOnboardingState.CERT_BINDING_PENDING;
    case "FAILED":
      return CustomerESignOnboardingState.FAILED;
    case "NOT_STARTED":
      return CustomerESignOnboardingState.NOT_STARTED;
    case "REALNAME_PENDING":
      return CustomerESignOnboardingState.REALNAME_PENDING;
    case "REGISTERED":
      return CustomerESignOnboardingState.ACCOUNT_CREATED;
    case "SIGNING_ENABLED":
      return CustomerESignOnboardingState.SIGNING_ENABLED;
    case "UNKNOWN":
      return CustomerESignOnboardingState.UNKNOWN;
    default:
      return fallback;
  }
}

function redactOnboardingStatus(status: CustomerESignOnboardingStatus): CustomerESignOnboardingStatus {
  const redacted = { ...status };
  delete redacted.realNameUrl;
  return redacted;
}

function hasProviderBackedRealName(account: CustomerESignProviderAccountView) {
  return account.realNameProviderVerifiedAt !== null &&
    (
      account.realNameProviderStatusSource === ESignProviderRealNameStatusSource.CALLBACK ||
      account.realNameProviderStatusSource === ESignProviderRealNameStatusSource.QUERY
    );
}

function maskIdentifier(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  if (value.includes("...") || value.includes("***")) {
    return value;
  }
  if (value.length <= 10) {
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

function sanitizeMessage(value: string | null) {
  if (!value) {
    return null;
  }
  return value
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[redacted-email]")
    .replace(/\b1\d{10}\b/g, "[redacted-mobile]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted-id]")
    .slice(0, 500);
}
