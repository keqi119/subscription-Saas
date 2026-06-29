import {
  ESignProviderAccountStatus,
  ESignProviderAccountSource,
  ESignProviderAccountType,
  ESignProviderType,
  ESignRealNameStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  CustomerESignOnboardingService,
  CustomerESignOnboardingState
} from "../src/esign/customer-esign-onboarding.service";
import { CustomerESignOnboardingRetryStep } from "../src/esign/customer-esign-onboarding.dto";
import type { CustomerESignProviderAccountView } from "../src/esign/customer-esign-provider-account.service";
import { CustomerESignOnboardingController } from "../src/esign/customer-esign-onboarding.controller";

describe("CustomerESignOnboardingService", () => {
  it("returns NOT_STARTED without creating binding or calling provider mechanics", async () => {
    const { accountService, service } = createFixture();
    accountService.getFadadaPersonalBinding.mockResolvedValueOnce(null);

    const status = await service.getOnboardingStatus("customer-1");

    expect(status).toMatchObject({
      nextAction: "START_ONBOARDING",
      signingEligible: false,
      state: CustomerESignOnboardingState.NOT_STARTED
    });
    expect(accountService.ensureFadadaPersonalPendingBinding).not.toHaveBeenCalled();
    expect(accountService.registerFadadaPersonalAccount).not.toHaveBeenCalled();
    expect(accountService.startFadadaPersonalRealNameVerification).not.toHaveBeenCalled();
    expect(accountService.applyFadadaPersonalCert).not.toHaveBeenCalled();
  });

  it("starts onboarding by creating a pending binding and writing a masked audit entry", async () => {
    const { accountService, auditService, service } = createFixture();
    accountService.ensureFadadaPersonalPendingBinding.mockResolvedValueOnce(fakeView({
      providerOpenId: "subauto_person_v1_abcdef1234567890abcdef12"
    }));

    const status = await service.startOnboarding("customer-1", "operator-1");

    expect(accountService.ensureFadadaPersonalPendingBinding).toHaveBeenCalledWith("customer-1", "operator-1");
    expect(status).toMatchObject({
      nextAction: "REGISTER_PROVIDER_ACCOUNT",
      signingEligible: false,
      state: CustomerESignOnboardingState.ONBOARDING
    });
    expect(status.providerOpenId).toMatch(/^subau.*ef12$/);
    expect(auditService.write).toHaveBeenCalledWith(expect.objectContaining({
      action: "CREATE",
      entityType: "customer_esign_onboarding",
      module: "esign",
      operatorId: "operator-1"
    }));
    expect(JSON.stringify(auditService.write.mock.calls[0]?.[0])).not.toContain("customer-1");
    expect(JSON.stringify(auditService.write.mock.calls[0]?.[0])).not.toContain("subauto_person_v1_abcdef1234567890abcdef12");
    expect(accountService.registerFadadaPersonalAccount).not.toHaveBeenCalled();
    expect(accountService.startFadadaPersonalRealNameVerification).not.toHaveBeenCalled();
  });

  it("derives SIGNING_ENABLED from a registered and verified binding without provider calls", async () => {
    const { accountService, service } = createFixture();
    accountService.getFadadaPersonalBinding.mockResolvedValueOnce(fakeView({
      providerCustomerId: "fadada-provider-customer-1234567890",
      registrationStatus: ESignProviderAccountStatus.REGISTERED,
      realNameStatus: ESignRealNameStatus.VERIFIED,
      verifiedAt: new Date("2026-06-29T00:00:00.000Z")
    }));

    const status = await service.getOnboardingStatus("customer-1");

    expect(status).toMatchObject({
      nextAction: "NONE",
      registrationStatus: ESignProviderAccountStatus.REGISTERED,
      realNameStatus: ESignRealNameStatus.VERIFIED,
      signingEligible: true,
      state: CustomerESignOnboardingState.SIGNING_ENABLED
    });
    expect(status.providerCustomerId).toMatch(/^fadad.*7890$/);
    expect(JSON.stringify(status)).not.toContain("fadada-provider-customer-1234567890");
    expect(accountService.registerFadadaPersonalAccount).not.toHaveBeenCalled();
    expect(accountService.startFadadaPersonalRealNameVerification).not.toHaveBeenCalled();
    expect(accountService.applyFadadaPersonalCert).not.toHaveBeenCalled();
  });

  it("keeps REALNAME_VERIFY retry mock-only and does not invoke C2 provider calls", async () => {
    const { accountService, auditService, service } = createFixture();
    accountService.getFadadaPersonalBinding.mockResolvedValueOnce(fakeView({
      providerCustomerId: "fadada-provider-customer-1234567890",
      registrationStatus: ESignProviderAccountStatus.REGISTERED,
      realNameStatus: ESignRealNameStatus.UNVERIFIED
    }));

    const status = await service.retryOnboarding(
      "customer-1",
      { step: CustomerESignOnboardingRetryStep.REALNAME_VERIFY },
      "operator-1"
    );

    expect(status).toMatchObject({
      nextAction: "START_REALNAME_VERIFICATION",
      realNameFlow: {
        mockOnly: true,
        providerCallExecuted: false
      },
      signingEligible: false,
      state: CustomerESignOnboardingState.ACCOUNT_CREATED
    });
    expect(accountService.startFadadaPersonalRealNameVerification).not.toHaveBeenCalled();
    expect(accountService.refreshFadadaRealNameStatus).not.toHaveBeenCalled();
    expect(accountService.applyFadadaPersonalCert).not.toHaveBeenCalled();
    expect(auditService.write).toHaveBeenCalledWith(expect.objectContaining({
      action: "UPDATE",
      entityType: "customer_esign_onboarding",
      module: "esign",
      operatorId: "operator-1"
    }));
  });
});

describe("CustomerESignOnboardingController", () => {
  it("maps internal admin endpoints to onboarding service methods", async () => {
    const service = {
      getOnboardingStatus: vi.fn(async () => ({ state: CustomerESignOnboardingState.NOT_STARTED })),
      retryOnboarding: vi.fn(async () => ({ state: CustomerESignOnboardingState.ACCOUNT_CREATED })),
      startOnboarding: vi.fn(async () => ({ state: CustomerESignOnboardingState.ONBOARDING }))
    };
    const controller = new CustomerESignOnboardingController(service as never);
    const request = { user: { id: "operator-1" } };

    await controller.getOnboardingStatus("customer-1");
    await controller.startOnboarding("customer-1", request as never);
    await controller.retryOnboarding(
      "customer-1",
      { step: CustomerESignOnboardingRetryStep.REALNAME_VERIFY },
      request as never
    );

    expect(service.getOnboardingStatus).toHaveBeenCalledWith("customer-1");
    expect(service.startOnboarding).toHaveBeenCalledWith("customer-1", "operator-1");
    expect(service.retryOnboarding).toHaveBeenCalledWith(
      "customer-1",
      { step: CustomerESignOnboardingRetryStep.REALNAME_VERIFY },
      "operator-1"
    );
  });
});

function createFixture() {
  const accountService = {
    applyFadadaPersonalCert: vi.fn(),
    ensureFadadaPersonalPendingBinding: vi.fn(),
    getFadadaPersonalBinding: vi.fn(),
    refreshFadadaRealNameStatus: vi.fn(),
    registerFadadaPersonalAccount: vi.fn(),
    startFadadaPersonalRealNameVerification: vi.fn()
  };
  const auditService = {
    write: vi.fn(async (input: unknown) => {
      void input;
    })
  };
  const ServiceCtor = CustomerESignOnboardingService as unknown as new (
    accountService: unknown,
    auditService: unknown
  ) => CustomerESignOnboardingService;
  const service = new ServiceCtor(accountService, auditService);

  return { accountService, auditService, service };
}

function fakeView(overrides: Partial<CustomerESignProviderAccountView> = {}): CustomerESignProviderAccountView {
  return {
    accountType: ESignProviderAccountType.PERSONAL,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    id: "binding-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    provider: ESignProviderType.FADADA,
    providerCustomerId: null,
    providerOpenId: "subau...base",
    registrationStatus: ESignProviderAccountStatus.PENDING,
    realNameStatus: ESignRealNameStatus.UNVERIFIED,
    source: ESignProviderAccountSource.SYSTEM_REGISTER,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    verifiedAt: null,
    verificationSerialNo: null,
    verificationTransactionNo: null,
    ...overrides
  };
}
