import {
  ApplicationStatus,
  BusinessType,
  EntitlementAccountStatus,
  EntitlementGrantSource,
  EntitlementGrantStatus,
  EntitlementType,
  EntitlementUnit,
  OrderStatus,
  Prisma,
  ProductStatus,
  QuoteStatus,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { OrderService } from "../src/order/order.service";

describe("order entitlement grant backend loop", () => {
  it("generates an ACTIVE entitlement account and mileage, energy, and benefit grants", async () => {
    const harness = createEntitlementHarness();

    const result = (await harness.service.generateOrderEntitlements(
      harness.orderId,
      harness.user,
      harness.context
    )) as EntitlementResponse;

    expect(result.account?.accountStatus).toBe(EntitlementAccountStatus.ACTIVE);
    expect(result.account?.accountNo).toMatch(/^EA/);
    expect(result.account?.periodStart).toBe("2026-06-10T00:00:00.000Z");
    expect(result.grants).toHaveLength(4);
    expect(result.grants.map((grant) => [grant.entitlementType, grant.unit, grant.totalAmount])).toEqual([
      [EntitlementType.MILEAGE, EntitlementUnit.KM, 1500],
      [EntitlementType.ENERGY, EntitlementUnit.KWH, 120],
      [EntitlementType.ENERGY, EntitlementUnit.TIMES, 4],
      [EntitlementType.BENEFIT, EntitlementUnit.TIMES, 2]
    ]);
    expect(result.grants.every((grant) => grant.grantSource === EntitlementGrantSource.ORDER_START)).toBe(true);
    expect(result.grants.every((grant) => grant.status === EntitlementGrantStatus.ACTIVE)).toBe(true);
    expect(result.grants.every((grant) => grant.usedAmount === 0)).toBe(true);
    expect(result.grants.map((grant) => grant.grantNo).every((grantNo) => grantNo.startsWith("EG"))).toBe(true);
  });

  it("rejects non-ACTIVE orders", async () => {
    const harness = createEntitlementHarness({ orderStatus: OrderStatus.PENDING_DELIVERY });

    await expect(
      harness.service.generateOrderEntitlements(harness.orderId, harness.user, harness.context)
    ).rejects.toThrow("当前订单尚未起租，不能生成权益。");
  });

  it("rejects ACTIVE orders without actualDeliveryAt", async () => {
    const harness = createEntitlementHarness({ actualDeliveryAt: null });

    await expect(
      harness.service.generateOrderEntitlements(harness.orderId, harness.user, harness.context)
    ).rejects.toThrow("当前订单缺少实际交付时间，不能生成权益。");
  });

  it("is idempotent and does not create duplicate accounts or grants", async () => {
    const harness = createEntitlementHarness();

    const first = (await harness.service.generateOrderEntitlements(
      harness.orderId,
      harness.user,
      harness.context
    )) as EntitlementResponse;
    const second = (await harness.service.generateOrderEntitlements(
      harness.orderId,
      harness.user,
      harness.context
    )) as EntitlementResponse;

    expect(first.account?.id).toBe(second.account?.id);
    expect(harness.state.accounts).toHaveLength(1);
    expect(harness.state.grants).toHaveLength(4);
    expect(harness.tx.orderEntitlementAccount.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.orderEntitlementGrant.create).toHaveBeenCalledTimes(4);
  });

  it("generates TEXT service entitlement when benefitCount is empty", async () => {
    const snapshot = buildPackageSnapshot({
      benefitPackage: {
        benefitCount: null,
        benefitType: "DRIVER_SERVICE",
        description: "每月专属代驾服务说明",
        packageName: "代驾权益包"
      },
      energyPackage: null,
      mileagePackage: null
    });
    const harness = createEntitlementHarness({ finalPlanSnapshot: { packageSnapshot: snapshot } });

    const result = (await harness.service.generateOrderEntitlements(
      harness.orderId,
      harness.user,
      harness.context
    )) as EntitlementResponse;

    expect(result.grants).toEqual([
      expect.objectContaining({
        entitlementName: "每月专属代驾服务说明",
        entitlementType: EntitlementType.BENEFIT,
        remainingAmount: null,
        totalAmount: null,
        unit: EntitlementUnit.TEXT,
        usedAmount: null
      })
    ]);
  });

  it("returns account and grants when querying generated entitlements", async () => {
    const harness = createEntitlementHarness();
    await harness.service.generateOrderEntitlements(harness.orderId, harness.user, harness.context);

    const result = (await harness.service.getOrderEntitlements(harness.orderId, harness.user)) as EntitlementResponse;

    expect(result.account?.accountNo).toMatch(/^EA/);
    expect(result.grants).toHaveLength(4);
  });

  it("returns an empty entitlement response when the order has no account", async () => {
    const harness = createEntitlementHarness();

    const result = (await harness.service.getOrderEntitlements(harness.orderId, harness.user)) as EntitlementResponse;

    expect(result).toEqual({ account: null, grants: [] });
  });

  it("writes audit logs for account generation and grant generation", async () => {
    const harness = createEntitlementHarness();

    await harness.service.generateOrderEntitlements(harness.orderId, harness.user, harness.context);

    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CREATE", entityType: "order_entitlement_account", module: "entitlement" })
    );
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREATE",
        after: expect.objectContaining({
          customerId: harness.customerId,
          grantIds: expect.any(Array),
          orderId: harness.orderId,
          source: EntitlementGrantSource.ORDER_START
        }),
        entityType: "order_entitlement_grant",
        module: "entitlement"
      })
    );
  });

  it("throws a Chinese error when snapshots contain no entitlement components", async () => {
    const harness = createEntitlementHarness({ finalPlanSnapshot: {}, quoteSnapshot: {} });

    await expect(
      harness.service.generateOrderEntitlements(harness.orderId, harness.user, harness.context)
    ).rejects.toThrow("当前订单套餐快照缺少可生成权益的组件。");
  });

  it("uses quote.packageSnapshot fallback for historical snapshot structures without crashing", async () => {
    const snapshot = buildPackageSnapshot({
      benefitPackage: null,
      energyPackage: null,
      mileagePackage: { monthlyMileageKm: 800, overMileageFeeAmount: 150 }
    });
    const harness = createEntitlementHarness({
      finalPlanSnapshot: null,
      quotePackageSnapshot: snapshot,
      quoteSnapshot: null
    });

    const result = (await harness.service.generateOrderEntitlements(
      harness.orderId,
      harness.user,
      harness.context
    )) as EntitlementResponse;

    expect(result.grants).toEqual([
      expect.objectContaining({
        entitlementType: EntitlementType.MILEAGE,
        remainingAmount: 800,
        totalAmount: 800,
        unit: EntitlementUnit.KM
      })
    ]);
  });
});

type EntitlementResponse = {
  account: { accountNo: string; accountStatus: EntitlementAccountStatus; id: string; periodStart: string } | null;
  grants: Array<{
    entitlementName: string;
    entitlementType: EntitlementType;
    grantNo: string;
    grantSource: EntitlementGrantSource;
    remainingAmount: number | null;
    status: EntitlementGrantStatus;
    totalAmount: number | null;
    unit: EntitlementUnit;
    usedAmount: number | null;
  }>;
};

function createEntitlementHarness(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-07T08:00:00.000Z");
  const orderId = "order-1";
  const customerId = "customer-1";
  const vehicleId = "vehicle-1";
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: ["ADMIN"],
    username: "admin"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const state: {
    accounts: AccountRecord[];
    actualDeliveryAt: Date | null;
    finalPlanSnapshot: unknown;
    grants: GrantRecord[];
    orderStatus: OrderStatus;
    quotePackageSnapshot: unknown;
    quoteSnapshot: unknown;
  } = {
    accounts: [],
    actualDeliveryAt: new Date("2026-06-10T03:00:00.000Z"),
    finalPlanSnapshot: { packageSnapshot: buildPackageSnapshot() },
    grants: [],
    orderStatus: OrderStatus.ACTIVE,
    quotePackageSnapshot: null,
    quoteSnapshot: { packageSnapshot: buildPackageSnapshot() },
    ...overrides
  };

  function buildOrder() {
    return {
      actualDeliveryAt: state.actualDeliveryAt,
      actualReturnAt: null,
      application: {
        applicationNo: "APP202606070001",
        id: "application-1",
        salesUserId: user.id,
        status: ApplicationStatus.APPROVED
      },
      applicationId: "application-1",
      businessType: BusinessType.SUBSCRIPTION,
      changes: [],
      contract: null,
      contractId: null,
      contracts: [],
      createdAt: now,
      createdBy: user.id,
      customer: { grade: "A", id: customerId, mobile: "13800000000", name: "测试客户" },
      customerId,
      customerSelectedSnapshot: null,
      deletedAt: null,
      depositAmount: 500000n,
      depositStatus: "CONFIRMED",
      endDate: null,
      energyLimitCount: 4,
      energyLimitKwh: 120,
      finalDepositAmount: 500000n,
      finalPlanSnapshot: state.finalPlanSnapshot,
      finalPlanConfirmedAt: new Date("2026-06-09T08:00:00.000Z"),
      id: orderId,
      mileageLimitKm: 1500,
      monthlyFeeAmount: 300000n,
      orderNo: "ORD2026060700001",
      orderSource: "SALES_ASSISTED",
      orderStatus: state.orderStatus,
      overMileageFeeAmount: 100n,
      periodMonths: 12,
      productId: "product-1",
      productVersion: {
        product: { productType: BusinessType.SUBSCRIPTION, status: ProductStatus.ACTIVE }
      },
      productVersionId: "product-version-1",
      quote: {
        id: "quote-1",
        packageSnapshot: state.quotePackageSnapshot,
        quoteNo: "QUO2026060700001",
        status: QuoteStatus.CONFIRMED
      },
      quoteId: "quote-1",
      quoteSnapshot: state.quoteSnapshot,
      riskResult: null,
      riskResultId: null,
      startDate: null,
      updatedAt: now,
      updatedBy: user.id,
      vehicle: {
        brand: "NIO",
        id: vehicleId,
        plateNo: "沪A权益01",
        status: VehicleStatus.LEASED,
        vehicleNo: "VEH2026060700001",
        vin: "VINENTITLEMENT0001"
      },
      vehicleId,
      vehicleModel: "ET5",
      vehiclePurchasePriceAmount: 10000000n
    };
  }

  function activeAccount() {
    return state.accounts.find(
      (account) => account.accountStatus === EntitlementAccountStatus.ACTIVE && !account.deletedAt
    ) ?? null;
  }

  function accountWithGrants(account: AccountRecord) {
    return {
      ...account,
      grants: state.grants.filter((grant) => grant.accountId === account.id && !grant.deletedAt)
    };
  }

  const tx = {
    orderEntitlementAccount: {
      create: vi.fn(async ({ data }) => {
        const account: AccountRecord = {
          ...data,
          createdAt: now,
          deletedAt: null,
          id: `account-${state.accounts.length + 1}`,
          updatedAt: now
        };
        state.accounts.push(account);
        return account;
      }),
      findFirst: vi.fn(async () => {
        const account = activeAccount();
        return account ? accountWithGrants(account) : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const account = state.accounts.find((item) => item.id === where.id);
        if (!account) {
          throw new Error("Account not found");
        }
        return accountWithGrants(account);
      })
    },
    orderEntitlementGrant: {
      create: vi.fn(async ({ data }) => {
        const grant: GrantRecord = {
          ...data,
          createdAt: now,
          deletedAt: null,
          id: `grant-${state.grants.length + 1}`,
          updatedAt: now
        };
        state.grants.push(grant);
        return grant;
      })
    }
  };

  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    orderEntitlementAccount: {
      findFirst: vi.fn(async () => {
        const account = activeAccount();
        return account ? accountWithGrants(account) : null;
      })
    },
    subscriptionOrder: {
      findUnique: vi.fn(async () => buildOrder())
    }
  };
  const auditService = {
    write: vi.fn(async (entry: Record<string, unknown>) => {
      void entry;
    })
  };
  const service = new OrderService(auditService as never, prisma as never);

  return { auditService, context, customerId, orderId, prisma, service, state, tx, user };
}

function buildPackageSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    benefitPackage: {
      benefitCount: 2,
      benefitType: "WASH_CAR",
      description: "每月 2 次洗车权益",
      packageName: "洗车权益包"
    },
    energyPackage: {
      monthlyEnergyCount: 4,
      monthlyEnergyKwh: 120
    },
    mileagePackage: {
      monthlyMileageKm: 1500,
      overMileageFeeAmount: 100
    },
    pricing: {
      monthlyFeeAmount: 300000
    },
    subscriptionPlan: {
      id: "subscription-plan-1",
      planName: "ET5 标准订阅"
    },
    vehiclePackage: {
      vehicleModel: "ET5"
    },
    ...overrides
  };
}

type AccountRecord = {
  accountNo: string;
  accountStatus: EntitlementAccountStatus;
  createdAt: Date;
  createdBy?: string | null;
  customerId: string;
  deletedAt: Date | null;
  id: string;
  orderId: string;
  periodEnd: Date | null;
  periodStart: Date;
  snapshot: unknown;
  subscriptionPlanId?: string | null;
  updatedAt: Date;
  updatedBy?: string | null;
};

type GrantRecord = {
  accountId: string;
  createdAt: Date;
  createdBy?: string | null;
  customerId: string;
  deletedAt: Date | null;
  entitlementName: string;
  entitlementType: EntitlementType;
  grantNo: string;
  grantPeriodEnd: Date | null;
  grantPeriodStart: Date;
  grantSource: EntitlementGrantSource;
  id: string;
  orderId: string;
  remainingAmount: Prisma.Decimal | null;
  snapshot: unknown;
  status: EntitlementGrantStatus;
  totalAmount: Prisma.Decimal | null;
  unit: EntitlementUnit;
  updatedAt: Date;
  updatedBy?: string | null;
  usedAmount: Prisma.Decimal | null;
};
