import { BadRequestException, ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ESignProviderAccountStatus,
  ESignProviderAccountSource,
  ESignProviderAccountType,
  ESignProviderType,
  ESignRealNameStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  CustomerESignProviderAccountService,
  FADADA_ACCOUNT_REGISTER_DISABLED
} from "../src/esign/customer-esign-provider-account.service";

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

  it("manual attach creates a registered manual binding without calling provider", async () => {
    const { apiClient, service, state } = createServiceFixture();

    const view = await service.manuallyAttachFadadaPersonalAccount({
      customerId: "customer-1",
      providerCustomerId: "fadada-manual-1",
      realNameStatus: ESignRealNameStatus.VERIFIED
    }, "operator-1");

    expect(apiClient.registerAccount).not.toHaveBeenCalled();
    expect(state.accounts[0]).toMatchObject({
      providerCustomerId: "fadada-manual-1",
      realNameStatus: ESignRealNameStatus.VERIFIED,
      registrationStatus: ESignProviderAccountStatus.REGISTERED,
      source: ESignProviderAccountSource.MANUAL
    });
    expect(view.providerCustomerId).toMatch(/^fadad.*al-1$/);
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
    const { service, state } = createServiceFixture();
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
    registerAccount: vi.fn()
  };
  const service = new CustomerESignProviderAccountService(
    prisma as never,
    new ConfigService(input.env ?? {}),
    apiClient as never
  );

  return { apiClient, prisma, service, state };
}

interface FakeAccount {
  accountType: ESignProviderAccountType;
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
  registrationStatus: ESignProviderAccountStatus;
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
    registrationStatus: ESignProviderAccountStatus.PENDING,
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
