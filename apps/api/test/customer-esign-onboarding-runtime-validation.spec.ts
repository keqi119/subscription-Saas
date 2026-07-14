import { ConfigService } from "@nestjs/config";
import {
  ESignProviderAccountStatus,
  ESignProviderAccountSource,
  ESignProviderAccountType,
  ESignProviderCertBindingSource,
  ESignProviderCertBindingStatus,
  ESignProviderRealNameStatusSource,
  ESignProviderType,
  ESignRealNameStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { CustomerESignOnboardingController } from "../src/esign/customer-esign-onboarding.controller";
import {
  CustomerESignOnboardingRetryStep,
  CustomerESignOnboardingTriggerSource
} from "../src/esign/customer-esign-onboarding.dto";
import type { CustomerESignProviderAccountView } from "../src/esign/customer-esign-provider-account.service";
import {
  CustomerESignOnboardingService,
  CustomerESignOnboardingState
} from "../src/esign/customer-esign-onboarding.service";
import { OrderController } from "../src/order/order.controller";
import { PortalESignOnboardingController } from "../src/portal/portal-esign-onboarding.controller";

describe("Stage 10D-C3-F onboarding runtime validation", () => {
  it("validates Admin, Order, and Portal entries without signing, order, contract, or payment side effects", async () => {
    const harness = createRuntimeHarness();
    harness.accountService.getFadadaPersonalBinding
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fakeView({
        certBindingSource: ESignProviderCertBindingSource.QUERY_CERT,
        certBindingStatus: ESignProviderCertBindingStatus.BOUND,
        certBoundAt: new Date("2026-06-30T00:05:00.000Z"),
        providerCustomerId: "fadada-provider-customer-1234567890",
        providerStatusLastRefreshedAt: new Date("2026-06-30T00:05:00.000Z"),
        realNameProviderStatus: "2",
        realNameProviderStatusSource: ESignProviderRealNameStatusSource.QUERY,
        realNameProviderVerifiedAt: new Date("2026-06-30T00:00:00.000Z"),
        registrationStatus: ESignProviderAccountStatus.REGISTERED,
        realNameStatus: ESignRealNameStatus.VERIFIED,
        verifiedAt: new Date("2026-06-30T00:00:00.000Z")
      }));
    harness.accountService.ensureFadadaPersonalPendingBinding
      .mockResolvedValueOnce(fakeView({ providerOpenId: "subauto_person_v1_admin1234567890" }))
      .mockResolvedValueOnce(fakeView({ providerOpenId: "subauto_person_v1_order1234567890" }));
    harness.prismaService.subscriptionOrder.findUnique.mockResolvedValueOnce({
      customerId: "customer-runtime-activation-1234567890",
      id: "order-runtime-1"
    });

    const adminStart = await harness.adminController.startOnboarding("customer-runtime-activation-1234567890", {
      user: { id: "operator-admin" }
    } as never);
    const orderStart = await harness.orderController.startOrderESignOnboarding("order-runtime-1", {
      user: { id: "operator-order" }
    } as never);
    const portalStatus = await harness.portalController.getOnboardingStatus({
      accountStatus: "ACTIVE",
      customerAccountId: "customer-account-runtime-1",
      customerId: "customer-runtime-activation-1234567890",
      phone: "18616570212"
    } as never);

    expect(adminStart).toMatchObject({
      source: CustomerESignOnboardingTriggerSource.ADMIN,
      state: CustomerESignOnboardingState.ONBOARDING
    });
    expect(orderStart).toMatchObject({
      source: CustomerESignOnboardingTriggerSource.ORDER,
      state: CustomerESignOnboardingState.ONBOARDING
    });
    expect(portalStatus).toMatchObject({
      source: CustomerESignOnboardingTriggerSource.PORTAL,
      state: CustomerESignOnboardingState.SIGNING_ENABLED
    });
    expect(harness.prismaService.subscriptionOrder.findUnique).toHaveBeenCalledWith({
      select: { customerId: true, id: true },
      where: { id: "order-runtime-1" }
    });
    expect(harness.auditSources()).toEqual([
      CustomerESignOnboardingTriggerSource.ADMIN,
      CustomerESignOnboardingTriggerSource.ORDER,
      CustomerESignOnboardingTriggerSource.PORTAL
    ]);
    expect(harness.auditJson()).not.toContain("customer-runtime-activation-1234567890");
    expect(harness.auditJson()).not.toContain("fadada-provider-customer-1234567890");
    expect(harness.auditJson()).not.toContain("18616570212");
    expect(harness.accountService.startFadadaPersonalRealNameVerification).not.toHaveBeenCalled();
    expectNoForbiddenSideEffects(harness);
  });

  it("validates C3 to C2 to C1 real-name boundary while keeping provider/signing side effects disabled", async () => {
    const harness = createRuntimeHarness({
      env: { FADADA_ONBOARDING_REALNAME_C2_ENABLED: "true" }
    });
    harness.accountService.getFadadaPersonalBinding.mockResolvedValueOnce(fakeView({
      providerCustomerId: "fadada-provider-customer-1234567890",
      registrationStatus: ESignProviderAccountStatus.REGISTERED,
      realNameStatus: ESignRealNameStatus.UNVERIFIED
    }));
    harness.accountService.startFadadaPersonalRealNameVerification.mockResolvedValueOnce({
      account: fakeView({
        providerCustomerId: "fadada-provider-customer-1234567890",
        registrationStatus: ESignProviderAccountStatus.REGISTERED,
        realNameStatus: ESignRealNameStatus.PENDING,
        verificationSerialNo: "VERIFY-SERIAL-1",
        verificationTransactionNo: "VERIFY-TX-1"
      }),
      verifyUrlMasked: "https://verify.example.test/...",
      verifyUrlPresent: true
    });

    const status = await harness.adminController.startRealNameVerification("customer-runtime-activation-1234567890", {
      idCardNo: "110101199001011234",
      mobile: "18616570212",
      name: "Runtime Tester"
    }, {
      user: { id: "operator-admin" }
    } as never);

    expect(status).toMatchObject({
      nextAction: "WAIT_REALNAME_CALLBACK",
      realNameFlow: {
        c2ServiceInvoked: true,
        mockOnly: false,
        providerCallExecuted: false
      },
      source: CustomerESignOnboardingTriggerSource.ADMIN,
      state: CustomerESignOnboardingState.REALNAME_PENDING,
      verificationSerialNo: "VERIFY-SERIAL-1",
      verificationTransactionNo: "VERIFY-TX-1"
    });
    expect(harness.accountService.startFadadaPersonalRealNameVerification).toHaveBeenCalledWith(
      "customer-runtime-activation-1234567890",
      {
        idCardNo: "110101199001011234",
        mobile: "18616570212",
        name: "Runtime Tester"
      },
      "operator-admin"
    );
    expect(harness.auditSources()).toEqual([CustomerESignOnboardingTriggerSource.ADMIN]);
    expect(harness.auditJson()).not.toContain("Runtime Tester");
    expect(harness.auditJson()).not.toContain("110101199001011234");
    expect(harness.auditJson()).not.toContain("18616570212");
    expect(harness.accountService.applyFadadaPersonalCert).not.toHaveBeenCalled();
    expectNoForbiddenSideEffects(harness);
  });

  it("validates C3 state derivation from C1 and C2 fields without duplicate state storage", () => {
    const harness = createRuntimeHarness();

    expect(harness.service.resolveState(null)).toBe(CustomerESignOnboardingState.NOT_STARTED);
    expect(harness.service.resolveState(fakeView({
      registrationStatus: ESignProviderAccountStatus.PENDING,
      realNameStatus: ESignRealNameStatus.UNVERIFIED
    }))).toBe(CustomerESignOnboardingState.ONBOARDING);
    expect(harness.service.resolveState(fakeView({
      providerCustomerId: "fadada-provider-customer-1234567890",
      registrationStatus: ESignProviderAccountStatus.REGISTERED,
      realNameStatus: ESignRealNameStatus.UNVERIFIED
    }))).toBe(CustomerESignOnboardingState.ACCOUNT_CREATED);
    expect(harness.service.resolveState(fakeView({
      providerCustomerId: "fadada-provider-customer-1234567890",
      registrationStatus: ESignProviderAccountStatus.REGISTERED,
      realNameStatus: ESignRealNameStatus.PENDING
    }))).toBe(CustomerESignOnboardingState.REALNAME_PENDING);
    expect(harness.service.resolveState(fakeView({
      providerCustomerId: "fadada-provider-customer-1234567890",
      registrationStatus: ESignProviderAccountStatus.REGISTERED,
      realNameStatus: ESignRealNameStatus.VERIFIED
    }))).toBe(CustomerESignOnboardingState.UNKNOWN);
    expect(harness.service.resolveState(fakeView({
      certBindingSource: ESignProviderCertBindingSource.QUERY_CERT,
      certBindingStatus: ESignProviderCertBindingStatus.BOUND,
      certBoundAt: new Date("2026-06-30T00:05:00.000Z"),
      providerCustomerId: "fadada-provider-customer-1234567890",
      providerStatusLastRefreshedAt: new Date("2026-06-30T00:05:00.000Z"),
      realNameProviderStatus: "2",
      realNameProviderStatusSource: ESignProviderRealNameStatusSource.QUERY,
      realNameProviderVerifiedAt: new Date("2026-06-30T00:00:00.000Z"),
      registrationStatus: ESignProviderAccountStatus.REGISTERED,
      realNameStatus: ESignRealNameStatus.VERIFIED
    }))).toBe(CustomerESignOnboardingState.SIGNING_ENABLED);
    expect(harness.service.resolveState(fakeView({
      registrationStatus: ESignProviderAccountStatus.DISABLED
    }))).toBe(CustomerESignOnboardingState.DISABLED);
    expectNoForbiddenSideEffects(harness);
  });

  it("validates retry/status refresh paths preserve source audit and do not start signing", async () => {
    const harness = createRuntimeHarness();
    harness.accountService.getFadadaPersonalBinding.mockResolvedValueOnce(fakeView({
      providerCustomerId: "fadada-provider-customer-1234567890",
      registrationStatus: ESignProviderAccountStatus.REGISTERED,
      realNameStatus: ESignRealNameStatus.PENDING,
      verificationSerialNo: "VERIFY-SERIAL-1",
      verificationTransactionNo: "VERIFY-TX-1"
    }));

    const refreshed = await harness.adminController.retryOnboarding(
      "customer-runtime-activation-1234567890",
      { step: CustomerESignOnboardingRetryStep.STATUS_REFRESH },
      { user: { id: "operator-admin" } } as never
    );

    expect(refreshed).toMatchObject({
      source: CustomerESignOnboardingTriggerSource.ADMIN,
      state: CustomerESignOnboardingState.REALNAME_PENDING
    });
    expect(harness.auditSources()).toEqual([CustomerESignOnboardingTriggerSource.ADMIN]);
    expect(harness.accountService.ensureFadadaPersonalPendingBinding).not.toHaveBeenCalled();
    expect(harness.accountService.startFadadaPersonalRealNameVerification).not.toHaveBeenCalled();
    expectNoForbiddenSideEffects(harness);
  });
});

function createRuntimeHarness(input: { env?: Record<string, string> } = {}) {
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
    contract: {
      update: vi.fn(),
      updateMany: vi.fn()
    },
    paymentRecord: {
      create: vi.fn()
    },
    paymentWriteOff: {
      create: vi.fn()
    },
    receivableBill: {
      update: vi.fn(),
      updateMany: vi.fn()
    },
    subscriptionOrder: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    }
  };
  const service = new CustomerESignOnboardingService(
    accountService as never,
    auditService as never,
    new ConfigService(input.env ?? {}),
    prismaService as never
  );
  const adminController = new CustomerESignOnboardingController(service);
  const orderController = new OrderController({} as never, service);
  const portalController = new PortalESignOnboardingController(service);

  return {
    accountService,
    adminController,
    auditJson: () => JSON.stringify(auditService.write.mock.calls.map((call) => call[0])),
    auditService,
    auditSources: () => auditService.write.mock.calls.map((call) =>
      (call[0] as { after?: { source?: CustomerESignOnboardingTriggerSource } }).after?.source
    ),
    orderController,
    portalController,
    prismaService,
    service
  };
}

function expectNoForbiddenSideEffects(harness: ReturnType<typeof createRuntimeHarness>) {
  expect(harness.prismaService.subscriptionOrder.update).not.toHaveBeenCalled();
  expect(harness.prismaService.subscriptionOrder.updateMany).not.toHaveBeenCalled();
  expect(harness.prismaService.contract.update).not.toHaveBeenCalled();
  expect(harness.prismaService.contract.updateMany).not.toHaveBeenCalled();
  expect(harness.prismaService.paymentRecord.create).not.toHaveBeenCalled();
  expect(harness.prismaService.paymentWriteOff.create).not.toHaveBeenCalled();
  expect(harness.prismaService.receivableBill.update).not.toHaveBeenCalled();
  expect(harness.prismaService.receivableBill.updateMany).not.toHaveBeenCalled();
}

function fakeView(overrides: Partial<CustomerESignProviderAccountView> = {}): CustomerESignProviderAccountView {
  return {
    accountType: ESignProviderAccountType.PERSONAL,
    certBindingSource: ESignProviderCertBindingSource.UNKNOWN,
    certBindingStatus: ESignProviderCertBindingStatus.UNKNOWN,
    certBoundAt: null,
    certSerialNo: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    id: "binding-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    provider: ESignProviderType.FADADA,
    providerCustomerId: null,
    providerOpenId: "subauto_person_v1_runtime1234567890",
    providerStatusLastRefreshedAt: null,
    readinessBlockingCode: null,
    readinessBlockingReason: null,
    registrationStatus: ESignProviderAccountStatus.PENDING,
    realNameProviderStatus: null,
    realNameProviderStatusSource: ESignProviderRealNameStatusSource.UNKNOWN,
    realNameProviderVerifiedAt: null,
    realNameStatus: ESignRealNameStatus.UNVERIFIED,
    source: ESignProviderAccountSource.SYSTEM_REGISTER,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    verifiedAt: null,
    verificationSerialNo: null,
    verificationTransactionNo: null,
    ...overrides
  };
}
