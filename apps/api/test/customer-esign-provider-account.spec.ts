import { BadRequestException, ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditAction,
  ESignProviderCertBindingSource,
  ESignProviderCertBindingStatus,
  ESignProviderAccountStatus,
  ESignProviderAccountSource,
  ESignProviderAccountType,
  ESignProviderType,
  ESignProviderRealNameStatusSource,
  ESignRealNameStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  CustomerESignProviderAccountService,
  FADADA_ACCOUNT_REGISTER_DISABLED,
  FADADA_REALNAME_VERIFY_DISABLED
} from "../src/esign/customer-esign-provider-account.service";
import { buildFadadaMsgDigest } from "../src/esign/fadada/fadada-digest";

describe("CustomerESignProviderAccountService", () => {
  it("initializes a pending Fadada personal binding idempotently without provider calls", async () => {
    const { apiClient, prisma, service, state } = createServiceFixture();

    const first = await service.ensureFadadaPersonalPendingBinding("customer-1", "operator-1");
    const second = await service.ensureFadadaPersonalPendingBinding("customer-1", "operator-1");

    expect(state.accounts).toHaveLength(1);
    expect(first).toMatchObject({
      accountType: ESignProviderAccountType.PERSONAL,
      provider: ESignProviderType.FADADA,
      providerCustomerId: null,
      registrationStatus: ESignProviderAccountStatus.PENDING,
      realNameStatus: ESignRealNameStatus.UNVERIFIED
    });
    expect(second.id).toBe(first.id);
    expect(first.providerOpenId).toMatch(/^subau.*[a-f0-9]{4}$/);
    expect(first.providerOpenId).not.toContain("subauto_person_v1_ad8de196e9a8021ec9a7ac8a");
    expect(apiClient.registerAccount).not.toHaveBeenCalled();
    expect(prisma.customer.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "customer-1" } }));
  });

  it("does not register when FADADA_ACCOUNT_REGISTER_ENABLED is false", async () => {
    const { apiClient, service } = createServiceFixture({
      env: { FADADA_ACCOUNT_REGISTER_ENABLED: "false" }
    });
    await service.ensureFadadaPersonalPendingBinding("customer-1", "operator-1");

    await expect(service.registerFadadaPersonalAccount("customer-1", "operator-1")).rejects.toThrow(
      FADADA_ACCOUNT_REGISTER_DISABLED
    );
    expect(apiClient.registerAccount).not.toHaveBeenCalled();
  });

  it("registers a pending account through the injected Fadada client and stores a sanitized snapshot", async () => {
    const { apiClient, service, state } = createServiceFixture({
      env: { FADADA_ACCOUNT_REGISTER_ENABLED: "true" }
    });
    vi.mocked(apiClient.registerAccount).mockResolvedValueOnce({
      openId: "subauto_person_v1_abc",
      providerCustomerId: "fadada-customer-1234567890",
      raw: {
        code: "1",
        data: { customer_id: "fadada-customer-1234567890", mobile: "18616570212" },
        msg: "ok"
      },
      resultCode: "1",
      resultDesc: "ok"
    });
    await service.ensureFadadaPersonalPendingBinding("customer-1", "operator-1");

    const view = await service.registerFadadaPersonalAccount("customer-1", "operator-1");

    expect(apiClient.registerAccount).toHaveBeenCalledWith({
      accountType: "PERSONAL",
      openId: expect.stringMatching(/^subauto_person_v1_[a-f0-9]{24}$/)
    });
    expect(state.accounts[0]).toMatchObject({
      providerCustomerId: "fadada-customer-1234567890",
      registrationStatus: ESignProviderAccountStatus.REGISTERED
    });
    expect(state.accounts[0]?.providerSnapshot).toMatchObject({
      code: "1",
      data: { customer_id: "[redacted]", mobile: "[redacted]" },
      msg: "ok"
    });
    expect(view.providerCustomerId).toMatch(/^fadad.*7890$/);
  });

  it("records a sanitized failure and allows retry for a failed binding", async () => {
    const { apiClient, service, state } = createServiceFixture({
      env: { FADADA_ACCOUNT_REGISTER_ENABLED: "true" }
    });
    vi.mocked(apiClient.registerAccount)
      .mockRejectedValueOnce(new Error("FADADA_HTTP_ERROR: mobile 18616570212 token abcdefghijklmnopqrstuvwxyz"))
      .mockResolvedValueOnce({
        openId: "subauto_person_v1_abc",
        providerCustomerId: "fadada-customer-retry",
        raw: { code: "1", msg: "ok" },
        resultCode: "1",
        resultDesc: "ok"
      });
    await service.ensureFadadaPersonalPendingBinding("customer-1", "operator-1");

    await expect(service.registerFadadaPersonalAccount("customer-1", "operator-1")).rejects.toThrow(/FADADA_HTTP_ERROR/);
    expect(state.accounts[0]).toMatchObject({
      lastErrorCode: "FADADA_HTTP_ERROR",
      registrationStatus: ESignProviderAccountStatus.FAILED
    });
    expect(state.accounts[0]?.lastErrorMessage).toContain("[redacted-mobile]");
    expect(state.accounts[0]?.lastErrorMessage).toContain("[redacted-id]");

    const retried = await service.retryFadadaPersonalAccount("customer-1", "operator-1");

    expect(apiClient.registerAccount).toHaveBeenCalledTimes(2);
    expect(retried.registrationStatus).toBe(ESignProviderAccountStatus.REGISTERED);
  });

  it("does not call provider again for an already registered binding", async () => {
    const { apiClient, service } = createServiceFixture({
      env: { FADADA_ACCOUNT_REGISTER_ENABLED: "true" },
      accounts: [{
        providerCustomerId: "fadada-existing-1",
        registrationStatus: ESignProviderAccountStatus.REGISTERED
      }]
    });

    const view = await service.registerFadadaPersonalAccount("customer-1", "operator-1");

    expect(apiClient.registerAccount).not.toHaveBeenCalled();
    expect(view.providerCustomerId).toMatch(/^fadad.*ng-1$/);
  });

  it("manual attach only binds the provider customer id and cannot mark signing-ready evidence", async () => {
    const { apiClient, auditService, service, state } = createServiceFixture();

    const view = await service.manuallyAttachFadadaPersonalAccount({
      customerId: "customer-1",
      providerCustomerId: "fadada-manual-1",
      realNameStatus: ESignRealNameStatus.VERIFIED
    }, "operator-1");

    expect(apiClient.registerAccount).not.toHaveBeenCalled();
    expect(state.accounts[0]).toMatchObject({
      certBindingSource: ESignProviderCertBindingSource.UNKNOWN,
      certBindingStatus: ESignProviderCertBindingStatus.UNKNOWN,
      providerCustomerId: "fadada-manual-1",
      realNameProviderStatusSource: ESignProviderRealNameStatusSource.MANUAL_ATTACH_PROVIDER_ID_ONLY,
      realNameStatus: ESignRealNameStatus.UNVERIFIED,
      registrationStatus: ESignProviderAccountStatus.REGISTERED,
      source: ESignProviderAccountSource.MANUAL
    });
    expect(view.providerCustomerId).toMatch(/^fadad.*al-1$/);
    expect(auditService.write).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.UPDATE,
      entityId: "binding-1",
      entityType: "customer_esign_provider_account",
      module: "esign",
      operatorId: "operator-1"
    }));
    expect(JSON.stringify(auditService.write.mock.calls[0]?.[0])).not.toContain("fadada-manual-1");
    expect(JSON.stringify(auditService.write.mock.calls[0]?.[0])).not.toContain("18616570212");
  });

  it("manual attach refuses to overwrite an existing provider customer id", async () => {
    const { service } = createServiceFixture({
      accounts: [{
        customerId: "customer-1",
        providerCustomerId: "fadada-existing-1",
        registrationStatus: ESignProviderAccountStatus.REGISTERED
      }]
    });

    await expect(service.manuallyAttachFadadaPersonalAccount({
      customerId: "customer-1",
      providerCustomerId: "fadada-new-2",
      realNameStatus: ESignRealNameStatus.VERIFIED
    }, "operator-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("marks real-name status without storing PII", async () => {
    const { auditService, service, state } = createServiceFixture();
    await service.ensureFadadaPersonalPendingBinding("customer-1", "operator-1");

    const view = await service.markRealNameStatus({
      customerId: "customer-1",
      realNameStatus: ESignRealNameStatus.VERIFIED,
      verificationSerialNo: "verify-serial-1"
    }, "operator-1");

    expect(state.accounts[0]).toMatchObject({
      realNameStatus: ESignRealNameStatus.VERIFIED,
      verificationSerialNo: "verify-serial-1"
    });
    expect(view.realNameStatus).toBe(ESignRealNameStatus.VERIFIED);
    expect(JSON.stringify(view)).not.toContain("18616570212");
    expect(auditService.write).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.UPDATE,
      entityId: "binding-1",
      entityType: "customer_esign_provider_account",
      module: "esign",
      operatorId: "operator-1"
    }));
    expect(JSON.stringify(auditService.write.mock.calls[0]?.[0])).not.toContain("18616570212");
  });

  it("does not start real-name verification when FADADA_REALNAME_VERIFY_ENABLED is false", async () => {
    const { apiClient, service } = createServiceFixture({
      accounts: [{
        providerCustomerId: "fadada-registered-1",
        registrationStatus: ESignProviderAccountStatus.REGISTERED
      }],
      env: { FADADA_REALNAME_VERIFY_ENABLED: "false" }
    });

    await expect(service.startFadadaPersonalRealNameVerification("customer-1", {
      idCardNo: "110101199001011234",
      mobile: "18616570212",
      name: "Controlled Tester"
    }, "operator-1")).rejects.toThrow(FADADA_REALNAME_VERIFY_DISABLED);

    expect(apiClient.getPersonVerifyUrl).not.toHaveBeenCalled();
  });

  it("starts real-name verification with a masked URL and stores only transaction metadata", async () => {
    const { apiClient, service, state } = createServiceFixture({
      accounts: [{
        providerCustomerId: "fadada-registered-1",
        registrationStatus: ESignProviderAccountStatus.REGISTERED
      }],
      env: realNameEnv()
    });
    vi.mocked(apiClient.getPersonVerifyUrl).mockResolvedValueOnce({
      customerId: "fadada-registered-1",
      raw: {
        code: "1",
        data: {
          transactionNo: "VERIFY-TX-1",
          url: "https://verify.example.test/realname?token=secret"
        },
        msg: "ok"
      },
      resultCode: "1",
      resultDesc: "ok",
      transactionNo: "VERIFY-TX-1",
      verifyUrl: "https://verify.example.test/realname?token=secret"
    });

    const result = await service.startFadadaPersonalRealNameVerification("customer-1", {
      idCardNo: "110101199001011234",
      mobile: "18616570212",
      name: "Controlled Tester"
    }, "operator-1");

    expect(apiClient.getPersonVerifyUrl).toHaveBeenCalledWith(expect.objectContaining({
      customerId: "fadada-registered-1",
      idCardNo: "110101199001011234",
      mobile: "18616570212",
      name: "Controlled Tester",
      notifyUrl: "https://api.example.test/api/esign/callback/fadada/verify",
      returnUrl: "https://app.example.test/portal/contracts"
    }));
    expect(result).toMatchObject({
      account: {
        realNameStatus: ESignRealNameStatus.PENDING,
        verificationSerialNo: "VERIFY-TX-1",
        verificationTransactionNo: "VERIFY-TX-1"
      },
      verifyUrlMasked: "https://verify.example.test/..."
    });
    expect(state.accounts[0]).toMatchObject({
      realNameStatus: ESignRealNameStatus.PENDING,
      verificationSerialNo: "VERIFY-TX-1",
      verificationTransactionNo: "VERIFY-TX-1"
    });
    expect(JSON.stringify(state.accounts[0]?.providerSnapshot)).not.toContain("18616570212");
    expect(JSON.stringify(state.accounts[0]?.providerSnapshot)).not.toContain("110101199001011234");
    expect(JSON.stringify(state.accounts[0]?.providerSnapshot)).not.toContain("Controlled Tester");
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });

  it("handles verified real-name callback idempotently without signing side effects", async () => {
    const { service, state } = createServiceFixture({
      accounts: [{
        providerCustomerId: "fadada-registered-1",
        registrationStatus: ESignProviderAccountStatus.REGISTERED,
        realNameStatus: ESignRealNameStatus.PENDING,
        verificationSerialNo: "VERIFY-TX-1",
        verificationTransactionNo: "VERIFY-TX-1"
      }],
      env: realNameEnv()
    });
    const payload = fadadaVerifyCallbackPayload({
      resultCode: "2",
      transactionNo: "VERIFY-TX-1"
    });

    const first = await service.handleFadadaVerifyCallback(payload);
    const second = await service.handleFadadaVerifyCallback(payload);

    expect(first).toMatchObject({ handled: true, realNameStatus: ESignRealNameStatus.VERIFIED, verified: true });
    expect(second).toMatchObject({ handled: true, realNameStatus: ESignRealNameStatus.VERIFIED, verified: true });
    expect(state.accounts[0]).toMatchObject({
      realNameStatus: ESignRealNameStatus.VERIFIED,
      verificationSerialNo: "VERIFY-TX-1"
    });
    expect(state.accounts[0]?.verifiedAt).toBeInstanceOf(Date);
  });

  it("keeps VERIFIED terminal when later failed or expired callbacks arrive", async () => {
    const { service, state } = createServiceFixture({
      accounts: [{
        providerCustomerId: "fadada-registered-1",
        registrationStatus: ESignProviderAccountStatus.REGISTERED,
        realNameStatus: ESignRealNameStatus.VERIFIED,
        verificationSerialNo: "VERIFY-TX-1",
        verificationTransactionNo: "VERIFY-TX-1",
        verifiedAt: new Date("2026-01-02T00:00:00.000Z")
      }],
      env: realNameEnv()
    });

    const failed = await service.handleFadadaVerifyCallback(fadadaVerifyCallbackPayload({
      resultCode: "3",
      transactionNo: "VERIFY-TX-1"
    }));
    const expired = await service.handleFadadaVerifyCallback(fadadaVerifyCallbackPayload({
      resultCode: "4",
      transactionNo: "VERIFY-TX-1"
    }));

    expect(failed).toMatchObject({ handled: true, realNameStatus: ESignRealNameStatus.VERIFIED, verified: true });
    expect(expired).toMatchObject({ handled: true, realNameStatus: ESignRealNameStatus.VERIFIED, verified: true });
    expect(state.accounts[0]).toMatchObject({
      realNameStatus: ESignRealNameStatus.VERIFIED,
      verificationSerialNo: "VERIFY-TX-1"
    });
    expect(state.accounts[0]?.verifiedAt).toEqual(new Date("2026-01-02T00:00:00.000Z"));
  });

  it("refreshes real-name status from find_personCertInfo.api", async () => {
    const { apiClient, service, state } = createServiceFixture({
      accounts: [{
        providerCustomerId: "fadada-registered-1",
        registrationStatus: ESignProviderAccountStatus.REGISTERED,
        realNameStatus: ESignRealNameStatus.PENDING,
        verificationSerialNo: "VERIFY-TX-1",
        verificationTransactionNo: "VERIFY-TX-1"
      }],
      env: realNameEnv()
    });
    vi.mocked(apiClient.findPersonCertInfo).mockResolvedValueOnce({
      raw: { code: "1", data: { person: { status: "2" } }, msg: "ok" },
      realNameStatus: "2",
      resultCode: "1",
      resultDesc: "ok",
      verifiedSerialNo: "VERIFY-TX-1"
    });

    const view = await service.refreshFadadaRealNameStatus("customer-1", "operator-1");

    expect(apiClient.findPersonCertInfo).toHaveBeenCalledWith({ verifiedSerialNo: "VERIFY-TX-1" });
    expect(view.realNameStatus).toBe(ESignRealNameStatus.VERIFIED);
    expect(state.accounts[0]).toMatchObject({
      certBindingStatus: ESignProviderCertBindingStatus.PENDING,
      realNameProviderStatus: "2",
      realNameProviderStatusSource: ESignProviderRealNameStatusSource.QUERY,
      realNameStatus: ESignRealNameStatus.VERIFIED
    });
    expect(state.accounts[0]?.providerStatusLastRefreshedAt).toBeInstanceOf(Date);
  });

  it("rejects invalid real-name callback digest without updating account state", async () => {
    const { service, state } = createServiceFixture({
      accounts: [{
        providerCustomerId: "fadada-registered-1",
        registrationStatus: ESignProviderAccountStatus.REGISTERED,
        realNameStatus: ESignRealNameStatus.PENDING,
        verificationSerialNo: "VERIFY-TX-1",
        verificationTransactionNo: "VERIFY-TX-1"
      }],
      env: realNameEnv()
    });

    const result = await service.handleFadadaVerifyCallback({
      msg_digest: "invalid",
      result_code: "2",
      timestamp: "20260102030405",
      transaction_no: "VERIFY-TX-1"
    });

    expect(result).toMatchObject({ handled: false, reason: "UNVERIFIED", verified: false });
    expect(state.accounts[0]?.realNameStatus).toBe(ESignRealNameStatus.PENDING);
  });

  it("applies the verified personal certificate without invoking signing APIs", async () => {
    const { apiClient, service, state } = createServiceFixture({
      accounts: [{
        certBindingStatus: ESignProviderCertBindingStatus.PENDING,
        providerCustomerId: "fadada-registered-1",
        registrationStatus: ESignProviderAccountStatus.REGISTERED,
        realNameProviderStatusSource: ESignProviderRealNameStatusSource.QUERY,
        realNameStatus: ESignRealNameStatus.VERIFIED,
        verificationSerialNo: "VERIFY-TX-1",
        verificationTransactionNo: "VERIFY-TX-1"
      }],
      env: realNameEnv()
    });
    vi.mocked(apiClient.applyCert).mockResolvedValueOnce({
      customerId: "fadada-registered-1",
      raw: { code: "1", customer_id: "fadada-registered-1", msg: "ok" },
      resultCode: "1",
      resultDesc: "ok",
      verifiedSerialNo: "VERIFY-TX-1"
    });

    const view = await service.applyFadadaPersonalCert("customer-1", "operator-1");

    expect(apiClient.applyCert).toHaveBeenCalledWith({
      customerId: "fadada-registered-1",
      verifiedSerialNo: "VERIFY-TX-1"
    });
    expect(apiClient.getPersonVerifyUrl).not.toHaveBeenCalled();
    expect(view.realNameStatus).toBe(ESignRealNameStatus.VERIFIED);
    expect(state.accounts[0]).toMatchObject({
      certBindingSource: ESignProviderCertBindingSource.APPLY_CERT,
      certBindingStatus: ESignProviderCertBindingStatus.BOUND
    });
    expect(state.accounts[0]?.certBoundAt).toBeInstanceOf(Date);
    expect(JSON.stringify(state.accounts[0]?.providerSnapshot)).not.toContain("fadada-registered-1");
  });

  it("marks cert binding from query_cert provider evidence", async () => {
    const { apiClient, service, state } = createServiceFixture({
      accounts: [{
        providerCustomerId: "fadada-registered-1",
        registrationStatus: ESignProviderAccountStatus.REGISTERED,
        realNameProviderStatusSource: ESignProviderRealNameStatusSource.QUERY,
        realNameStatus: ESignRealNameStatus.VERIFIED,
        verificationSerialNo: "VERIFY-TX-1",
        verificationTransactionNo: "VERIFY-TX-1"
      }],
      env: realNameEnv()
    });
    vi.mocked(apiClient.queryCert).mockResolvedValueOnce({
      certBound: true,
      certSerialNo: "CERT-SEQUENCE-1",
      customerId: "fadada-registered-1",
      raw: { code: "1", data: { cert: { sequenceNo: "CERT-SEQUENCE-1" } }, msg: "ok" },
      resultCode: "1",
      resultDesc: "ok"
    });

    const view = await service.refreshFadadaCertBindingStatus("customer-1", "operator-1");

    expect(apiClient.queryCert).toHaveBeenCalledWith({ customerId: "fadada-registered-1" });
    expect(view.certBindingStatus).toBe(ESignProviderCertBindingStatus.BOUND);
    expect(state.accounts[0]).toMatchObject({
      certBindingSource: ESignProviderCertBindingSource.QUERY_CERT,
      certBindingStatus: ESignProviderCertBindingStatus.BOUND,
      certSerialNo: "CERT-SEQUENCE-1"
    });
    expect(state.accounts[0]?.providerStatusLastRefreshedAt).toBeInstanceOf(Date);
  });
});

function createServiceFixture(input: {
  accounts?: Partial<FakeAccount>[];
  env?: Record<string, string>;
} = {}) {
  const state = {
    accounts: (input.accounts ?? []).map((account, index) => fakeAccount({
      id: `binding-${index + 1}`,
      ...account
    }))
  };
  const prisma = fakePrisma(state);
  const apiClient = {
    applyCert: vi.fn(),
    findPersonCertInfo: vi.fn(),
    getPersonVerifyUrl: vi.fn(),
    queryCert: vi.fn(),
    registerAccount: vi.fn()
  };
  const auditService = {
    write: vi.fn(async (input: unknown) => {
      void input;
    })
  };
  const ServiceCtor = CustomerESignProviderAccountService as unknown as new (
    prisma: unknown,
    configService: ConfigService,
    apiClient: unknown,
    auditService: unknown
  ) => CustomerESignProviderAccountService;
  const service = new ServiceCtor(
    prisma as never,
    new ConfigService(input.env ?? {}),
    apiClient as never,
    auditService as never
  );

  return { apiClient, auditService, prisma, service, state };
}

interface FakeAccount {
  accountType: ESignProviderAccountType;
  certBindingSource: ESignProviderCertBindingSource;
  certBindingStatus: ESignProviderCertBindingStatus;
  certBoundAt: Date | null;
  certSerialNo: string | null;
  createdAt: Date;
  createdBy: string | null;
  customerId: string;
  deletedAt: Date | null;
  id: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  provider: ESignProviderType;
  providerCustomerId: string | null;
  providerOpenId: string;
  providerSnapshot: unknown;
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
  updatedBy: string | null;
  verifiedAt: Date | null;
  verificationSerialNo: string | null;
  verificationTransactionNo: string | null;
}

function fakeAccount(overrides: Partial<FakeAccount> = {}): FakeAccount {
  return {
    accountType: ESignProviderAccountType.PERSONAL,
    certBindingSource: ESignProviderCertBindingSource.UNKNOWN,
    certBindingStatus: ESignProviderCertBindingStatus.UNKNOWN,
    certBoundAt: null,
    certSerialNo: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    createdBy: null,
    customerId: "customer-1",
    deletedAt: null,
    id: "binding-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    provider: ESignProviderType.FADADA,
    providerCustomerId: null,
    providerOpenId: "subauto_person_v1_existing",
    providerSnapshot: null,
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
    updatedBy: null,
    verifiedAt: null,
    verificationSerialNo: null,
    verificationTransactionNo: null,
    ...overrides
  };
}

function fakePrisma(state: { accounts: FakeAccount[] }) {
  const matches = (account: FakeAccount, where: Record<string, unknown>) => {
    if (where.id && account.id !== where.id) {
      return false;
    }
    if (where.customerId && account.customerId !== where.customerId) {
      return false;
    }
    if (where.provider && account.provider !== where.provider) {
      return false;
    }
    if (where.accountType && account.accountType !== where.accountType) {
      return false;
    }
    if (where.registrationStatus && account.registrationStatus !== where.registrationStatus) {
      return false;
    }
    if (where.realNameStatus && account.realNameStatus !== where.realNameStatus) {
      return false;
    }
    if (where.providerCustomerId && account.providerCustomerId !== where.providerCustomerId) {
      return false;
    }
    if (where.verificationSerialNo && account.verificationSerialNo !== where.verificationSerialNo) {
      return false;
    }
    if (where.verificationTransactionNo && account.verificationTransactionNo !== where.verificationTransactionNo) {
      return false;
    }
    if (where.deletedAt === null && account.deletedAt !== null) {
      return false;
    }
    if (where.NOT && typeof where.NOT === "object" && "customerId" in where.NOT && account.customerId === where.NOT.customerId) {
      return false;
    }
    return true;
  };

  return {
    customer: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (
        where.id === "customer-1"
          ? { id: "customer-1", mobile: "18616570212", name: "Controlled Tester" }
          : null
      ))
    },
    customerESignProviderAccount: {
      create: vi.fn(async ({ data }: { data: Partial<FakeAccount> }) => {
        const created = fakeAccount({
          ...data,
          id: `binding-${state.accounts.length + 1}`
        });
        state.accounts.push(created);
        return created;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.accounts.find((account) => matches(account, where)) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.accounts.filter((account) => matches(account, where))
      ),
      update: vi.fn(async ({ data, where }: { data: Partial<FakeAccount>; where: { id: string } }) => {
        const account = state.accounts.find((item) => item.id === where.id);
        if (!account) {
          throw new BadRequestException("missing account");
        }
        Object.assign(account, data, { updatedAt: new Date("2026-01-02T00:00:00.000Z") });
        return account;
      })
    }
  };
}

function realNameEnv() {
  return {
    FADADA_APP_ID: "app-123",
    FADADA_APP_SECRET: "secret-xyz",
    FADADA_REALNAME_VERIFY_ENABLED: "true",
    FADADA_VERIFY_NOTIFY_URL: "https://api.example.test/api/esign/callback/fadada/verify",
    FADADA_VERIFY_RETURN_URL: "https://app.example.test/portal/contracts"
  };
}

function fadadaVerifyCallbackPayload(input: {
  resultCode: string;
  transactionNo: string;
}) {
  const timestamp = "20260102030405";
  const msgDigest = buildFadadaMsgDigest({
    appId: "app-123",
    appSecret: "secret-xyz",
    explicitSortString: input.transactionNo,
    timestamp
  });
  return {
    msg_digest: msgDigest,
    result_code: input.resultCode,
    timestamp,
    transaction_no: input.transactionNo,
    verified_serialno: input.transactionNo
  };
}
