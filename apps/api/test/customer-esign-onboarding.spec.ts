import {
  ESignProviderAccountStatus,
  ESignProviderAccountSource,
  ESignProviderAccountType,
  ESignProviderType,
  ESignRealNameStatus
} from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";

import {
  CustomerESignOnboardingService,
  CustomerESignOnboardingState
} from "../src/esign/customer-esign-onboarding.service";
import {
  CustomerESignOnboardingRetryStep,
  CustomerESignOnboardingTriggerSource,
  StartCustomerESignOnboardingRealNameDto
} from "../src/esign/customer-esign-onboarding.dto";
import type { CustomerESignProviderAccountView } from "../src/esign/customer-esign-provider-account.service";
import { CustomerESignOnboardingController } from "../src/esign/customer-esign-onboarding.controller";
import { OrderController } from "../src/order/order.controller";
import { PortalESignOnboardingController } from "../src/portal/portal-esign-onboarding.controller";

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
    accountService.getFadadaPersonalBinding.mockResolvedValueOnce(null);
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
    expect(auditService.write.mock.calls[0]?.[0]).toMatchObject({
      after: expect.objectContaining({
        source: CustomerESignOnboardingTriggerSource.ADMIN
      })
    });
    expect(JSON.stringify(auditService.write.mock.calls[0]?.[0])).not.toContain("customer-1");
    expect(JSON.stringify(auditService.write.mock.calls[0]?.[0])).not.toContain("subauto_person_v1_abcdef1234567890abcdef12");
    expect(accountService.registerFadadaPersonalAccount).not.toHaveBeenCalled();
    expect(accountService.startFadadaPersonalRealNameVerification).not.toHaveBeenCalled();
  });

  it("rejects onboarding start for customers that are already signing enabled", async () => {
    const { accountService, service } = createFixture();
    accountService.getFadadaPersonalBinding.mockResolvedValueOnce(fakeView({
      providerCustomerId: "fadada-provider-customer-1234567890",
      registrationStatus: ESignProviderAccountStatus.REGISTERED,
      realNameStatus: ESignRealNameStatus.VERIFIED
    }));

    await expect(service.startOnboarding("customer-1", "operator-1", {
      source: CustomerESignOnboardingTriggerSource.ORDER
    })).rejects.toThrow("ESIGN_ONBOARDING_ALREADY_SIGNING_ENABLED");

    expect(accountService.ensureFadadaPersonalPendingBinding).not.toHaveBeenCalled();
    expect(accountService.startFadadaPersonalRealNameVerification).not.toHaveBeenCalled();
  });

  it("starts onboarding from an order entry without mutating the order", async () => {
    const { accountService, auditService, prismaService, service } = createFixture();
    prismaService.subscriptionOrder.findUnique.mockResolvedValueOnce({
      customerId: "customer-1",
      id: "order-1"
    });
    accountService.getFadadaPersonalBinding.mockResolvedValueOnce(null);
    accountService.ensureFadadaPersonalPendingBinding.mockResolvedValueOnce(fakeView());

    const status = await service.startOnboardingForOrder("order-1", "operator-1");

    expect(status).toMatchObject({
      nextAction: "REGISTER_PROVIDER_ACCOUNT",
      state: CustomerESignOnboardingState.ONBOARDING
    });
    expect(prismaService.subscriptionOrder.findUnique).toHaveBeenCalledWith({
      select: { customerId: true, id: true },
      where: { id: "order-1" }
    });
    expect(prismaService.subscriptionOrder.update).not.toHaveBeenCalled();
    expect(accountService.ensureFadadaPersonalPendingBinding).toHaveBeenCalledWith("customer-1", "operator-1");
    expect(auditService.write.mock.calls[0]?.[0]).toMatchObject({
      after: expect.objectContaining({
        source: CustomerESignOnboardingTriggerSource.ORDER
      })
    });
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

  it("starts real-name verification through the C2 service boundary and derives REALNAME_PENDING", async () => {
    const { accountService, auditService, service } = createFixture({
      env: { FADADA_ONBOARDING_REALNAME_C2_ENABLED: "true" }
    });
    const input: StartCustomerESignOnboardingRealNameDto = {
      idCardNo: "110101199001011234",
      mobile: "18616570212",
      name: "Controlled Tester"
    };
    accountService.startFadadaPersonalRealNameVerification.mockResolvedValueOnce({
      account: fakeView({
        providerCustomerId: "fadada-provider-customer-1234567890",
        registrationStatus: ESignProviderAccountStatus.REGISTERED,
        realNameStatus: ESignRealNameStatus.PENDING,
        verificationSerialNo: "VERIFY-TX-1",
        verificationTransactionNo: "VERIFY-TX-1"
      }),
      verifyUrlMasked: "https://verify.example.test/...",
      verifyUrlPresent: true
    });

    const status = await service.startRealNameVerification("customer-1", input, "operator-1");

    expect(accountService.startFadadaPersonalRealNameVerification).toHaveBeenCalledWith(
      "customer-1",
      input,
      "operator-1"
    );
    expect(status).toMatchObject({
      nextAction: "WAIT_REALNAME_CALLBACK",
      realNameFlow: {
        c2ServiceInvoked: true,
        mockOnly: false,
        providerCallExecuted: false
      },
      signingEligible: false,
      state: CustomerESignOnboardingState.REALNAME_PENDING,
      verificationSerialNo: "VERIFY-TX-1",
      verificationTransactionNo: "VERIFY-TX-1"
    });
    expect(JSON.stringify(status)).not.toContain("18616570212");
    expect(JSON.stringify(status)).not.toContain("110101199001011234");
    expect(auditService.write).toHaveBeenCalledWith(expect.objectContaining({
      action: "UPDATE",
      entityType: "customer_esign_onboarding",
      module: "esign",
      operatorId: "operator-1"
    }));
    expect(accountService.applyFadadaPersonalCert).not.toHaveBeenCalled();
  });

  it("does not invoke the C2 real-name service unless the onboarding wiring gate is enabled", async () => {
    const { accountService, service } = createFixture();
    const input: StartCustomerESignOnboardingRealNameDto = {
      idCardNo: "110101199001011234",
      mobile: "18616570212",
      name: "Controlled Tester"
    };

    await expect(service.startRealNameVerification("customer-1", input, "operator-1"))
      .rejects.toThrow("ESIGN_ONBOARDING_REALNAME_C2_DISABLED");

    expect(accountService.startFadadaPersonalRealNameVerification).not.toHaveBeenCalled();
    expect(accountService.applyFadadaPersonalCert).not.toHaveBeenCalled();
  });

  it("rejects REALNAME_VERIFY retry mock path unless explicit test mode is enabled", async () => {
    const { accountService, service } = createFixture({
      env: {
        FADADA_ONBOARDING_MOCK_REALNAME_ENABLED: "true",
        NODE_ENV: "production"
      }
    });
    accountService.getFadadaPersonalBinding.mockResolvedValueOnce(fakeView({
      providerCustomerId: "fadada-provider-customer-1234567890",
      registrationStatus: ESignProviderAccountStatus.REGISTERED,
      realNameStatus: ESignRealNameStatus.UNVERIFIED
    }));

    await expect(service.retryOnboarding(
      "customer-1",
      { step: CustomerESignOnboardingRetryStep.REALNAME_VERIFY },
      "operator-1"
    )).rejects.toThrow("ESIGN_ONBOARDING_REALNAME_INPUT_REQUIRED");

    expect(accountService.startFadadaPersonalRealNameVerification).not.toHaveBeenCalled();
    expect(accountService.refreshFadadaRealNameStatus).not.toHaveBeenCalled();
    expect(accountService.applyFadadaPersonalCert).not.toHaveBeenCalled();
  });

  it("keeps the mock real-name path test-only when explicitly enabled", async () => {
    const { accountService, auditService, service } = createFixture({
      env: {
        FADADA_ONBOARDING_MOCK_REALNAME_ENABLED: "true",
        NODE_ENV: "test"
      }
    });
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
        c2ServiceInvoked: false,
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
      startRealNameVerification: vi.fn(async () => ({ state: CustomerESignOnboardingState.REALNAME_PENDING })),
      startOnboarding: vi.fn(async () => ({ state: CustomerESignOnboardingState.ONBOARDING }))
    };
    const controller = new CustomerESignOnboardingController(service as never);
    const request = { user: { id: "operator-1" } };

    await controller.getOnboardingStatus("customer-1");
    await controller.startOnboarding("customer-1", request as never);
    await controller.startRealNameVerification("customer-1", {
      idCardNo: "110101199001011234",
      mobile: "18616570212",
      name: "Controlled Tester"
    }, request as never);
    await controller.retryOnboarding(
      "customer-1",
      { step: CustomerESignOnboardingRetryStep.REALNAME_VERIFY },
      request as never
    );

    expect(service.getOnboardingStatus).toHaveBeenCalledWith("customer-1", {
      source: CustomerESignOnboardingTriggerSource.ADMIN
    });
    expect(service.startOnboarding).toHaveBeenCalledWith("customer-1", "operator-1", {
      source: CustomerESignOnboardingTriggerSource.ADMIN
    });
    expect(service.startRealNameVerification).toHaveBeenCalledWith("customer-1", {
      idCardNo: "110101199001011234",
      mobile: "18616570212",
      name: "Controlled Tester"
    }, "operator-1", {
      source: CustomerESignOnboardingTriggerSource.ADMIN
    });
    expect(service.retryOnboarding).toHaveBeenCalledWith(
      "customer-1",
      { step: CustomerESignOnboardingRetryStep.REALNAME_VERIFY },
      "operator-1",
      { source: CustomerESignOnboardingTriggerSource.ADMIN }
    );
  });
});

describe("onboarding product entry controllers", () => {
  it("maps order entry to source-aware onboarding start", async () => {
    const orderService = {};
    const onboardingService = {
      startOnboardingForOrder: vi.fn(async () => ({ state: CustomerESignOnboardingState.ONBOARDING }))
    };
    const controller = new OrderController(orderService as never, onboardingService as never);

    const result = await controller.startOrderESignOnboarding("order-1", {
      user: { id: "operator-1" }
    } as never);

    expect(result).toEqual({ state: CustomerESignOnboardingState.ONBOARDING });
    expect(onboardingService.startOnboardingForOrder).toHaveBeenCalledWith("order-1", "operator-1");
  });

  it("maps portal status entry to a source-aware read without starting onboarding", async () => {
    const onboardingService = {
      getOnboardingStatus: vi.fn(async () => ({ state: CustomerESignOnboardingState.NOT_STARTED })),
      startOnboarding: vi.fn()
    };
    const controller = new PortalESignOnboardingController(onboardingService as never);

    const result = await controller.getOnboardingStatus({
      accountStatus: "ACTIVE",
      customerAccountId: "customer-account-1",
      customerId: "customer-1",
      phone: "18616570212"
    } as never);

    expect(result).toEqual({ state: CustomerESignOnboardingState.NOT_STARTED });
    expect(onboardingService.getOnboardingStatus).toHaveBeenCalledWith("customer-1", {
      source: CustomerESignOnboardingTriggerSource.PORTAL
    });
    expect(onboardingService.startOnboarding).not.toHaveBeenCalled();
  });
});

function createFixture(input: { env?: Record<string, string> } = {}) {
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
  const prismaService = {
    subscriptionOrder: {
      findUnique: vi.fn(),
      update: vi.fn()
    }
  };
  const ServiceCtor = CustomerESignOnboardingService as unknown as new (
    accountService: unknown,
    auditService: unknown,
    configService: unknown,
    prismaService: unknown
  ) => CustomerESignOnboardingService;
  const service = new ServiceCtor(accountService, auditService, new ConfigService(input.env ?? {}), prismaService);

  return { accountService, auditService, prismaService, service };
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
