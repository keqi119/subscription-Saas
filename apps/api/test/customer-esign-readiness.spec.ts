import { ConfigService } from "@nestjs/config";
import {
  ESignProviderAccountSource,
  ESignProviderAccountStatus,
  ESignProviderAccountType,
  ESignProviderCertBindingSource,
  ESignProviderCertBindingStatus,
  ESignProviderRealNameStatusSource,
  ESignProviderType,
  ESignRealNameStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { FadadaCustomerReadinessService } from "../src/esign/fadada-customer-readiness.service";

describe("FadadaCustomerReadinessService", () => {
  it("returns account-missing when no Fadada personal provider account exists", async () => {
    const service = createService();

    await expect(service.getReadiness("customer-1")).resolves.toMatchObject({
      blockingCode: "FADADA_ACCOUNT_MISSING",
      certBound: false,
      provider: ESignProviderType.FADADA,
      providerCustomerIdPresent: false,
      readyForSigning: false,
      realNameProviderVerified: false,
      state: "NOT_STARTED"
    });
  });

  it("does not treat manual local VERIFIED as signing-ready evidence", async () => {
    const service = createService([fakeAccount({
      providerCustomerId: "fadada-manual-1",
      realNameProviderStatusSource: ESignProviderRealNameStatusSource.MANUAL_ATTACH_PROVIDER_ID_ONLY,
      realNameStatus: ESignRealNameStatus.VERIFIED,
      source: ESignProviderAccountSource.MANUAL
    })]);

    await expect(service.getReadiness("customer-1")).resolves.toMatchObject({
      blockingCode: "FADADA_MANUAL_ONLY_NOT_SIGNING_READY",
      certBound: false,
      providerCustomerIdPresent: true,
      readyForSigning: false,
      realNameProviderVerified: false,
      state: "UNKNOWN"
    });
  });

  it("blocks provider-confirmed real-name when cert binding is not confirmed", async () => {
    const service = createService([fakeAccount({
      certBindingStatus: ESignProviderCertBindingStatus.PENDING,
      providerCustomerId: "fadada-customer-1",
      providerStatusLastRefreshedAt: new Date("2026-07-14T00:00:00.000Z"),
      realNameProviderStatus: "2",
      realNameProviderStatusSource: ESignProviderRealNameStatusSource.QUERY,
      realNameProviderVerifiedAt: new Date("2026-07-14T00:00:00.000Z"),
      realNameStatus: ESignRealNameStatus.VERIFIED
    })]);

    await expect(service.getReadiness("customer-1")).resolves.toMatchObject({
      blockingCode: "FADADA_CERT_NOT_BOUND",
      certBound: false,
      providerCustomerIdPresent: true,
      readyForSigning: false,
      realNameProviderVerified: true,
      state: "CERT_BINDING_PENDING"
    });
  });

  it("allows signing only when provider real-name and cert binding are both confirmed", async () => {
    const service = createService([fakeAccount({
      certBindingSource: ESignProviderCertBindingSource.QUERY_CERT,
      certBindingStatus: ESignProviderCertBindingStatus.BOUND,
      certBoundAt: new Date("2026-07-14T00:05:00.000Z"),
      certSerialNo: "CERT-SEQUENCE-1",
      providerCustomerId: "fadada-customer-1",
      providerStatusLastRefreshedAt: new Date("2026-07-14T00:05:00.000Z"),
      realNameProviderStatus: "2",
      realNameProviderStatusSource: ESignProviderRealNameStatusSource.QUERY,
      realNameProviderVerifiedAt: new Date("2026-07-14T00:00:00.000Z"),
      realNameStatus: ESignRealNameStatus.VERIFIED
    })]);

    await expect(service.getReadiness("customer-1")).resolves.toMatchObject({
      blockingCode: null,
      certBound: true,
      certSerialNoPresent: true,
      providerCustomerIdPresent: true,
      readyForSigning: true,
      realNameProviderVerified: true,
      state: "SIGNING_ENABLED"
    });
  });

  it("fails closed when provider readiness evidence is stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
    try {
      const service = createService([fakeAccount({
        certBindingSource: ESignProviderCertBindingSource.QUERY_CERT,
        certBindingStatus: ESignProviderCertBindingStatus.BOUND,
        certBoundAt: new Date("2026-06-01T00:00:00.000Z"),
        providerCustomerId: "fadada-customer-1",
        providerStatusLastRefreshedAt: new Date("2026-06-01T00:00:00.000Z"),
        realNameProviderStatus: "2",
        realNameProviderStatusSource: ESignProviderRealNameStatusSource.QUERY,
        realNameProviderVerifiedAt: new Date("2026-06-01T00:00:00.000Z"),
        realNameStatus: ESignRealNameStatus.VERIFIED
      })], { FADADA_PROVIDER_STATUS_FRESHNESS_DAYS: "30" });

      await expect(service.getReadiness("customer-1")).resolves.toMatchObject({
        blockingCode: "FADADA_PROVIDER_STATUS_STALE",
        readyForSigning: false,
        state: "UNKNOWN"
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function createService(accounts: FakeReadinessAccount[] = [], env: Record<string, string> = {}) {
  const prisma = {
    customerESignProviderAccount: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        accounts.find((account) => matchesWhere(account, where)) ?? null
      )
    }
  };
  return new FadadaCustomerReadinessService(prisma as never, new ConfigService(env));
}

interface FakeReadinessAccount extends Record<string, unknown> {
  accountType: ESignProviderAccountType;
  certBindingSource: ESignProviderCertBindingSource;
  certBindingStatus: ESignProviderCertBindingStatus;
  certBoundAt: Date | null;
  certSerialNo: string | null;
  customerId: string;
  deletedAt: Date | null;
  id: string;
  provider: ESignProviderType;
  providerCustomerId: string | null;
  providerStatusLastRefreshedAt: Date | null;
  registrationStatus: ESignProviderAccountStatus;
  realNameProviderStatus: string | null;
  realNameProviderStatusSource: ESignProviderRealNameStatusSource;
  realNameProviderVerifiedAt: Date | null;
  realNameStatus: ESignRealNameStatus;
  source: ESignProviderAccountSource;
}

function fakeAccount(overrides: Partial<FakeReadinessAccount> = {}): FakeReadinessAccount {
  return {
    accountType: ESignProviderAccountType.PERSONAL,
    certBindingSource: ESignProviderCertBindingSource.UNKNOWN,
    certBindingStatus: ESignProviderCertBindingStatus.UNKNOWN,
    certBoundAt: null,
    certSerialNo: null,
    customerId: "customer-1",
    deletedAt: null,
    id: "binding-1",
    provider: ESignProviderType.FADADA,
    providerCustomerId: null,
    providerStatusLastRefreshedAt: null,
    registrationStatus: ESignProviderAccountStatus.REGISTERED,
    realNameProviderStatus: null,
    realNameProviderStatusSource: ESignProviderRealNameStatusSource.UNKNOWN,
    realNameProviderVerifiedAt: null,
    realNameStatus: ESignRealNameStatus.UNVERIFIED,
    source: ESignProviderAccountSource.SYSTEM_REGISTER,
    ...overrides
  };
}

function matchesWhere(row: FakeReadinessAccount, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === "deletedAt" && expected === null) return row.deletedAt === null;
    return row[key] === expected;
  });
}
