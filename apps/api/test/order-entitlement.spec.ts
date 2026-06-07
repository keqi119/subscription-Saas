import {
  ApplicationStatus,
  BusinessType,
  EntitlementAccountStatus,
  EntitlementGrantSource,
  EntitlementGrantStatus,
  EntitlementType,
  EntitlementUnit,
  EntitlementUsageSource,
  EntitlementUsageStatus,
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

  it("consumes an ACTIVE grant, decreases remaining amount, and records latest usage overview", async () => {
    const harness = createEntitlementHarness();
    const entitlements = (await harness.service.generateOrderEntitlements(
      harness.orderId,
      harness.user,
      harness.context
    )) as EntitlementResponse;
    const mileageGrant = entitlements.grants.find((grant) => grant.unit === EntitlementUnit.KM)!;

    const result = (await harness.service.consumeOrderEntitlement(
      harness.orderId,
      mileageGrant.id,
      {
        externalRefNo: "MILEAGE-20260610-001",
        occurredAt: "2026-06-10T10:00:00.000Z",
        remark: "use 100km",
        scenario: "客户里程核销",
        usageSource: EntitlementUsageSource.MANUAL,
        usedAmount: 100
      },
      harness.user,
      harness.context
    )) as ConsumeResponse;

    expect(result.usage.usageNo).toMatch(/^EU/);
    expect(result.usage.usedAmount).toBe(100);
    expect(result.usage.usageStatus).toBe(EntitlementUsageStatus.CONFIRMED);
    expect(result.grant.usedAmount).toBe(100);
    expect(result.grant.remainingAmount).toBe(1400);
    expect(result.grant.status).toBe(EntitlementGrantStatus.ACTIVE);
    expect(harness.state.usages).toHaveLength(1);

    const balance = (await harness.service.getOrderEntitlements(harness.orderId, harness.user)) as EntitlementResponse;
    expect(balance.grants.find((grant) => grant.id === mileageGrant.id)?.latestUsageAt).toBe("2026-06-10T10:00:00.000Z");
  });

  it("rejects entitlement consumption for non-ACTIVE orders", async () => {
    const harness = createEntitlementHarness({ orderStatus: OrderStatus.PENDING_DELIVERY });

    await expect(
      harness.service.consumeOrderEntitlement(
        harness.orderId,
        "grant-1",
        { usedAmount: 1 },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("当前订单尚未起租，不能消耗权益。");
  });

  it("rejects entitlement consumption when account or grant state is not active", async () => {
    const noAccountHarness = createEntitlementHarness();
    await expect(
      noAccountHarness.service.consumeOrderEntitlement(
        noAccountHarness.orderId,
        "grant-1",
        { usedAmount: 1 },
        noAccountHarness.user,
        noAccountHarness.context
      )
    ).rejects.toThrow("当前订单尚未生成权益账户，不能消耗权益。");

    const inactiveAccountHarness = createEntitlementHarness();
    const inactiveAccountEntitlements = (await inactiveAccountHarness.service.generateOrderEntitlements(
      inactiveAccountHarness.orderId,
      inactiveAccountHarness.user,
      inactiveAccountHarness.context
    )) as EntitlementResponse;
    inactiveAccountHarness.state.accounts[0]!.accountStatus = EntitlementAccountStatus.SUSPENDED;
    await expect(
      inactiveAccountHarness.service.consumeOrderEntitlement(
        inactiveAccountHarness.orderId,
        inactiveAccountEntitlements.grants[0]!.id,
        { usedAmount: 1 },
        inactiveAccountHarness.user,
        inactiveAccountHarness.context
      )
    ).rejects.toThrow("当前权益账户不是生效中，不能消耗权益。");

    const inactiveGrantHarness = createEntitlementHarness();
    const inactiveGrantEntitlements = (await inactiveGrantHarness.service.generateOrderEntitlements(
      inactiveGrantHarness.orderId,
      inactiveGrantHarness.user,
      inactiveGrantHarness.context
    )) as EntitlementResponse;
    inactiveGrantHarness.state.grants[0]!.status = EntitlementGrantStatus.EXPIRED;
    await expect(
      inactiveGrantHarness.service.consumeOrderEntitlement(
        inactiveGrantHarness.orderId,
        inactiveGrantEntitlements.grants[0]!.id,
        { usedAmount: 1 },
        inactiveGrantHarness.user,
        inactiveGrantHarness.context
      )
    ).rejects.toThrow("当前权益发放记录不是生效中，不能消耗权益。");
  });

  it("rejects TEXT grants and invalid or excessive amounts", async () => {
    const textHarness = createEntitlementHarness({
      finalPlanSnapshot: {
        packageSnapshot: buildPackageSnapshot({
          benefitPackage: {
            benefitCount: null,
            benefitType: "DRIVER_SERVICE",
            description: "service text"
          },
          energyPackage: null,
          mileagePackage: null
        })
      }
    });
    const textEntitlements = (await textHarness.service.generateOrderEntitlements(
      textHarness.orderId,
      textHarness.user,
      textHarness.context
    )) as EntitlementResponse;
    await expect(
      textHarness.service.consumeOrderEntitlement(
        textHarness.orderId,
        textEntitlements.grants[0]!.id,
        { usedAmount: 1 },
        textHarness.user,
        textHarness.context
      )
    ).rejects.toThrow("文本型权益不支持消耗核销");

    const amountHarness = createEntitlementHarness();
    const amountEntitlements = (await amountHarness.service.generateOrderEntitlements(
      amountHarness.orderId,
      amountHarness.user,
      amountHarness.context
    )) as EntitlementResponse;
    await expect(
      amountHarness.service.consumeOrderEntitlement(
        amountHarness.orderId,
        amountEntitlements.grants[0]!.id,
        { usedAmount: 0 },
        amountHarness.user,
        amountHarness.context
      )
    ).rejects.toThrow("权益消耗数量必须大于 0。");
    await expect(
      amountHarness.service.consumeOrderEntitlement(
        amountHarness.orderId,
        amountEntitlements.grants[0]!.id,
        { usedAmount: 2000 },
        amountHarness.user,
        amountHarness.context
      )
    ).rejects.toThrow("权益剩余额度不足，不能超额消耗。");
  });

  it("marks a grant EXHAUSTED when remaining amount reaches zero", async () => {
    const harness = createEntitlementHarness();
    const entitlements = (await harness.service.generateOrderEntitlements(
      harness.orderId,
      harness.user,
      harness.context
    )) as EntitlementResponse;

    const result = (await harness.service.consumeOrderEntitlement(
      harness.orderId,
      entitlements.grants[0]!.id,
      { usedAmount: 1500 },
      harness.user,
      harness.context
    )) as ConsumeResponse;

    expect(result.grant.usedAmount).toBe(1500);
    expect(result.grant.remainingAmount).toBe(0);
    expect(result.grant.status).toBe(EntitlementGrantStatus.EXHAUSTED);
  });

  it("lists entitlement usages with pagination", async () => {
    const harness = createEntitlementHarness();
    const entitlements = (await harness.service.generateOrderEntitlements(
      harness.orderId,
      harness.user,
      harness.context
    )) as EntitlementResponse;
    await harness.service.consumeOrderEntitlement(
      harness.orderId,
      entitlements.grants[0]!.id,
      { occurredAt: "2026-06-10T10:00:00.000Z", usedAmount: 100 },
      harness.user,
      harness.context
    );
    await harness.service.consumeOrderEntitlement(
      harness.orderId,
      entitlements.grants[1]!.id,
      { occurredAt: "2026-06-11T10:00:00.000Z", scenario: "客户补能核销", usedAmount: 20 },
      harness.user,
      harness.context
    );

    const result = (await harness.service.listOrderEntitlementUsages(
      harness.orderId,
      { page: 1, pageSize: 1 },
      harness.user
    )) as UsageListResponse;

    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.usageNo).toMatch(/^EU/);
    expect(result.items[0]!.scenario).toBe("客户补能核销");
  });

  it("uses externalRefNo idempotency without double-deducting remaining amount", async () => {
    const harness = createEntitlementHarness();
    const entitlements = (await harness.service.generateOrderEntitlements(
      harness.orderId,
      harness.user,
      harness.context
    )) as EntitlementResponse;

    const first = (await harness.service.consumeOrderEntitlement(
      harness.orderId,
      entitlements.grants[0]!.id,
      { externalRefNo: "IDEMPOTENT-001", usedAmount: 100 },
      harness.user,
      harness.context
    )) as ConsumeResponse;
    const second = (await harness.service.consumeOrderEntitlement(
      harness.orderId,
      entitlements.grants[0]!.id,
      { externalRefNo: "IDEMPOTENT-001", usedAmount: 100 },
      harness.user,
      harness.context
    )) as ConsumeResponse;

    expect(first.usage.id).toBe(second.usage.id);
    expect(harness.state.usages).toHaveLength(1);
    expect(second.grant.remainingAmount).toBe(1400);
    expect(harness.tx.orderEntitlementGrant.updateMany).toHaveBeenCalledTimes(1);
  });

  it("writes an audit log when consuming entitlements", async () => {
    const harness = createEntitlementHarness();
    const entitlements = (await harness.service.generateOrderEntitlements(
      harness.orderId,
      harness.user,
      harness.context
    )) as EntitlementResponse;

    await harness.service.consumeOrderEntitlement(
      harness.orderId,
      entitlements.grants[0]!.id,
      { externalRefNo: "AUDIT-001", usedAmount: 100 },
      harness.user,
      harness.context
    );

    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREATE",
        after: expect.objectContaining({
          externalRefNo: "AUDIT-001",
          grantId: entitlements.grants[0]!.id,
          orderId: harness.orderId,
          remainingAmount: 1400,
          source: EntitlementUsageSource.MANUAL,
          usedAmount: 100
        }),
        entityType: "order_entitlement_usage",
        module: "entitlement"
      })
    );
  });
});

type EntitlementResponse = {
  account: { accountNo: string; accountStatus: EntitlementAccountStatus; id: string; periodStart: string } | null;
  grants: Array<{
    entitlementName: string;
    entitlementType: EntitlementType;
    grantNo: string;
    grantSource: EntitlementGrantSource;
    id: string;
    latestUsageAt: string | null;
    remainingAmount: number | null;
    status: EntitlementGrantStatus;
    totalAmount: number | null;
    unit: EntitlementUnit;
    usedAmount: number | null;
  }>;
};

type ConsumeResponse = {
  grant: EntitlementResponse["grants"][number];
  usage: {
    externalRefNo: string | null;
    id: string;
    scenario: string | null;
    usageNo: string;
    usageSource: EntitlementUsageSource;
    usageStatus: EntitlementUsageStatus;
    usedAmount: number;
  };
};

type UsageListResponse = {
  items: Array<{
    scenario: string | null;
    usageNo: string;
  }>;
  page: number;
  pageSize: number;
  total: number;
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
    usages: UsageRecord[];
  } = {
    accounts: [],
    actualDeliveryAt: new Date("2026-06-10T03:00:00.000Z"),
    finalPlanSnapshot: { packageSnapshot: buildPackageSnapshot() },
    grants: [],
    orderStatus: OrderStatus.ACTIVE,
    quotePackageSnapshot: null,
    quoteSnapshot: { packageSnapshot: buildPackageSnapshot() },
    usages: [],
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

  function findAccount(args: { where?: Record<string, unknown> } = {}) {
    const where = args.where ?? {};
    return state.accounts.find((account) => {
      if (account.deletedAt) {
        return false;
      }
      if (where.orderId && account.orderId !== where.orderId) {
        return false;
      }
      if (where.accountStatus && account.accountStatus !== where.accountStatus) {
        return false;
      }
      return true;
    }) ?? null;
  }

  function accountWithGrants(account: AccountRecord) {
    return {
      ...account,
      grants: state.grants.filter((grant) => grant.accountId === account.id && !grant.deletedAt).map(grantWithUsages)
    };
  }

  function grantWithUsages(grant: GrantRecord) {
    return {
      ...grant,
      usages: state.usages
        .filter((usage) => usage.grantId === grant.id && !usage.deletedAt && usage.usageStatus === EntitlementUsageStatus.CONFIRMED)
        .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
        .slice(0, 1)
    };
  }

  function findGrant(args: { where?: Record<string, unknown> } = {}) {
    const where = args.where ?? {};
    return state.grants.find((grant) => {
      if (grant.deletedAt) {
        return false;
      }
      if (where.id && grant.id !== where.id) {
        return false;
      }
      if (where.orderId && grant.orderId !== where.orderId) {
        return false;
      }
      if (where.accountId && grant.accountId !== where.accountId) {
        return false;
      }
      if (where.status && grant.status !== where.status) {
        return false;
      }
      const remainingFilter = where.remainingAmount as { gte?: Prisma.Decimal } | undefined;
      if (remainingFilter?.gte && (!grant.remainingAmount || grant.remainingAmount.lt(remainingFilter.gte))) {
        return false;
      }
      return true;
    }) ?? null;
  }

  function findUsage(args: { where?: Record<string, unknown> } = {}) {
    const where = args.where ?? {};
    return state.usages.find((usage) => usageMatchesWhere(usage, where)) ?? null;
  }

  function usageMatchesWhere(usage: UsageRecord, where: Record<string, unknown>) {
    if (where.deletedAt === null && usage.deletedAt) {
      return false;
    }
    if (where.orderId && usage.orderId !== where.orderId) {
      return false;
    }
    if (where.grantId && usage.grantId !== where.grantId) {
      return false;
    }
    if (where.externalRefNo && usage.externalRefNo !== where.externalRefNo) {
      return false;
    }
    if (where.entitlementType && usage.entitlementType !== where.entitlementType) {
      return false;
    }
    const usageStatusWhere = where.usageStatus as EntitlementUsageStatus | { not?: EntitlementUsageStatus } | undefined;
    if (typeof usageStatusWhere === "string" && usage.usageStatus !== usageStatusWhere) {
      return false;
    }
    if (typeof usageStatusWhere === "object" && usageStatusWhere?.not && usage.usageStatus === usageStatusWhere.not) {
      return false;
    }
    const occurredAtWhere = where.occurredAt as { gte?: Date; lte?: Date } | undefined;
    if (occurredAtWhere?.gte && usage.occurredAt < occurredAtWhere.gte) {
      return false;
    }
    if (occurredAtWhere?.lte && usage.occurredAt > occurredAtWhere.lte) {
      return false;
    }
    return true;
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
      findFirst: vi.fn(async (args) => {
        const account = findAccount(args);
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
      }),
      findFirst: vi.fn(async (args) => {
        const grant = findGrant(args);
        return grant ? grantWithUsages(grant) : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const grant = state.grants.find((item) => item.id === where.id);
        if (!grant) {
          throw new Error("Grant not found");
        }
        return grantWithUsages(grant);
      }),
      updateMany: vi.fn(async ({ data, where }) => {
        const grant = findGrant({ where });
        if (!grant) {
          return { count: 0 };
        }
        Object.assign(grant, data, { updatedAt: now });
        return { count: 1 };
      })
    },
    orderEntitlementUsage: {
      create: vi.fn(async ({ data }) => {
        const usage: UsageRecord = {
          ...data,
          createdAt: now,
          deletedAt: null,
          id: `usage-${state.usages.length + 1}`,
          updatedAt: now
        };
        state.usages.push(usage);
        return usage;
      }),
      findFirst: vi.fn(async (args) => findUsage(args))
    }
  };

  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    orderEntitlementAccount: {
      findFirst: vi.fn(async (args) => {
        const account = findAccount(args);
        return account ? accountWithGrants(account) : null;
      })
    },
    orderEntitlementUsage: {
      count: vi.fn(async ({ where }) => state.usages.filter((usage) => usageMatchesWhere(usage, where)).length),
      findMany: vi.fn(async ({ skip = 0, take = 20, where }) => state.usages
        .filter((usage) => usageMatchesWhere(usage, where))
        .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
        .slice(skip, skip + take))
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

type UsageRecord = {
  accountId: string;
  createdAt: Date;
  createdBy?: string | null;
  customerId: string;
  deletedAt: Date | null;
  entitlementName: string;
  entitlementType: EntitlementType;
  externalRefNo: string | null;
  grantId: string;
  id: string;
  occurredAt: Date;
  orderId: string;
  remark: string | null;
  scenario: string | null;
  snapshot: unknown;
  unit: EntitlementUnit;
  updatedAt: Date;
  updatedBy?: string | null;
  usageNo: string;
  usageSource: EntitlementUsageSource;
  usageStatus: EntitlementUsageStatus;
  usedAmount: Prisma.Decimal;
};
