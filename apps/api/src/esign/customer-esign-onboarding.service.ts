import { BadRequestException, Injectable, Optional } from "@nestjs/common";
import {
  AuditAction,
  ESignProviderAccountStatus,
  ESignProviderAccountType,
  ESignProviderType,
  ESignRealNameStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import {
  CustomerESignProviderAccountService,
  CustomerESignProviderAccountView
} from "./customer-esign-provider-account.service";
import { CustomerESignOnboardingRetryStep } from "./customer-esign-onboarding.dto";

export enum CustomerESignOnboardingState {
  ACCOUNT_CREATED = "ACCOUNT_CREATED",
  DISABLED = "DISABLED",
  FAILED = "FAILED",
  NOT_STARTED = "NOT_STARTED",
  ONBOARDING = "ONBOARDING",
  REALNAME_PENDING = "REALNAME_PENDING",
  SIGNING_ENABLED = "SIGNING_ENABLED",
  VERIFIED = "VERIFIED"
}

export type CustomerESignOnboardingNextAction =
  | "APPLY_CERT"
  | "CONTACT_SUPPORT"
  | "NONE"
  | "REGISTER_PROVIDER_ACCOUNT"
  | "RETRY"
  | "START_ONBOARDING"
  | "START_REALNAME_VERIFICATION"
  | "WAIT_REALNAME_CALLBACK";

export interface CustomerESignOnboardingStatus {
  accountType: ESignProviderAccountType;
  customerId: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  nextAction: CustomerESignOnboardingNextAction;
  provider: ESignProviderType;
  providerCustomerId: string | null;
  providerOpenId: string | null;
  realNameFlow?: {
    mockOnly: boolean;
    providerCallExecuted: boolean;
  };
  realNameStatus: ESignRealNameStatus | null;
  registrationStatus: ESignProviderAccountStatus | null;
  signingEligible: boolean;
  state: CustomerESignOnboardingState;
  verifiedAt: Date | null;
  verificationSerialNo: string | null;
  verificationTransactionNo: string | null;
}

@Injectable()
export class CustomerESignOnboardingService {
  constructor(
    private readonly accountService: CustomerESignProviderAccountService,
    @Optional() private readonly auditService?: AuditService
  ) {}

  async getOnboardingStatus(customerId: string) {
    const account = await this.accountService.getFadadaPersonalBinding(customerId);
    return this.toStatus(customerId, account);
  }

  async startOnboarding(customerId: string, actorId?: string) {
    const account = await this.accountService.ensureFadadaPersonalPendingBinding(customerId, actorId);
    const status = this.toStatus(customerId, account);
    await this.writeAudit({
      action: AuditAction.CREATE,
      actorId,
      customerId,
      event: "esign.onboarding.start",
      nextStatus: status
    });
    return status;
  }

  async retryOnboarding(
    customerId: string,
    input: { step: CustomerESignOnboardingRetryStep | `${CustomerESignOnboardingRetryStep}` },
    actorId?: string
  ) {
    switch (input.step) {
      case CustomerESignOnboardingRetryStep.START:
        return this.startOnboarding(customerId, actorId);
      case CustomerESignOnboardingRetryStep.REALNAME_VERIFY:
        return this.triggerRealNameFlow(customerId, actorId);
      case CustomerESignOnboardingRetryStep.STATUS_REFRESH:
        return this.getOnboardingStatus(customerId);
      default:
        throw new BadRequestException(`ESIGN_ONBOARDING_STEP_NOT_ALLOWED: ${input.step}`);
    }
  }

  async triggerRealNameFlow(customerId: string, actorId?: string) {
    const current = await this.getOnboardingStatus(customerId);
    const status: CustomerESignOnboardingStatus = {
      ...current,
      realNameFlow: {
        mockOnly: true,
        providerCallExecuted: false
      }
    };
    await this.writeAudit({
      action: AuditAction.UPDATE,
      actorId,
      customerId,
      event: "esign.onboarding.realname_mock",
      nextStatus: status,
      previousStatus: current
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
      return CustomerESignOnboardingState.SIGNING_ENABLED;
    }
    return CustomerESignOnboardingState.ACCOUNT_CREATED;
  }

  private toStatus(
    customerId: string,
    account: CustomerESignProviderAccountView | null
  ): CustomerESignOnboardingStatus {
    const state = this.resolveState(account);
    return {
      accountType: account?.accountType ?? ESignProviderAccountType.PERSONAL,
      customerId: maskIdentifier(customerId) ?? "",
      lastErrorCode: account?.lastErrorCode ?? null,
      lastErrorMessage: sanitizeMessage(account?.lastErrorMessage ?? null),
      nextAction: nextActionForState(state),
      provider: account?.provider ?? ESignProviderType.FADADA,
      providerCustomerId: maskIdentifier(account?.providerCustomerId),
      providerOpenId: maskIdentifier(account?.providerOpenId),
      realNameStatus: account?.realNameStatus ?? null,
      registrationStatus: account?.registrationStatus ?? null,
      signingEligible: state === CustomerESignOnboardingState.SIGNING_ENABLED,
      state,
      verifiedAt: account?.verifiedAt ?? null,
      verificationSerialNo: account?.verificationSerialNo ?? null,
      verificationTransactionNo: account?.verificationTransactionNo ?? null
    };
  }

  private async writeAudit(input: {
    action: AuditAction;
    actorId?: string;
    customerId: string;
    event: string;
    nextStatus: CustomerESignOnboardingStatus;
    previousStatus?: CustomerESignOnboardingStatus;
  }) {
    if (!this.auditService) {
      return;
    }
    await this.auditService.write({
      action: input.action,
      after: {
        customerId: maskIdentifier(input.customerId),
        event: input.event,
        status: input.nextStatus
      },
      before: input.previousStatus ? {
        customerId: maskIdentifier(input.customerId),
        event: input.event,
        status: input.previousStatus
      } : undefined,
      entityType: "customer_esign_onboarding",
      module: "esign",
      operatorId: input.actorId
    });
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
    case CustomerESignOnboardingState.VERIFIED:
      return "APPLY_CERT";
    case CustomerESignOnboardingState.SIGNING_ENABLED:
      return "NONE";
    case CustomerESignOnboardingState.FAILED:
      return "RETRY";
    case CustomerESignOnboardingState.DISABLED:
      return "CONTACT_SUPPORT";
    default:
      return "CONTACT_SUPPORT";
  }
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
