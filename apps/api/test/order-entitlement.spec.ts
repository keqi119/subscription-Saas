import {
  ApplicationStatus,
  BusinessType,
  ContractSegmentStatus,
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
    expect(result.account?.periodEnd).toBe("2026-07-09T00:00:00.000Z");
    expect(result.grants).toHaveLength(4);
    expect(
      result.grants.map((grant) => [grant.entitlementType, grant.unit, grant.totalAmount])
    ).toEqual([
      [EntitlementType.MILEAGE, EntitlementUnit.KM, 1500],
      [EntitlementType.ENERGY, EntitlementUnit.KWH, 120],
      [EntitlementType.ENERGY, EntitlementUnit.TIMES, 4],
      [EntitlementType.BENEFIT, EntitlementUnit.TIMES, 2]
    ]);
    expect(
      result.grants.every((grant) => grant.grantSource === EntitlementGrantSource.ORDER_START)
    ).toBe(true);
    expect(
      result.grants.every((grant) => grant.grantPeriodStart === "2026-06-10T00:00:00.000Z")
    ).toBe(true);
    expect(
      result.grants.every((grant) => grant.grantPeriodEnd === "2026-07-09T00:00:00.000Z")
    ).toBe(true);
    expect(result.grants.every((grant) => grant.status === EntitlementGrantStatus.ACTIVE)).toBe(
      true
    );
    expect(result.grants.every((grant) => grant.usedAmount === 0)).toBe(true);
    expect(
      result.grants.map((grant) => grant.grantNo).every((grantNo) => grantNo.startsWith("EG"))
    ).toBe(true);
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

    const result = (await harness.service.getOrderEntitlements(
      harness.orderId,
      harness.user
    )) as EntitlementResponse;

    expect(result.account?.accountNo).toMatch(/^EA/);
    expect(result.grants).toHaveLength(4);
  });

  it("returns an empty entitlement response when the order has no account", async () => {
    const harness = createEntitlementHarness();

    const result = (await harness.service.getOrderEntitlements(
      harness.orderId,
      harness.user
    )) as EntitlementResponse;

    expect(result).toEqual({ account: null, grants: [] });
  });

  it("writes audit logs for account generation and grant generation", async () => {
    const harness = createEntitlementHarness();

    await harness.service.generateOrderEntitlements(harness.orderId, harness.user, harness.context);

    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREATE",
        entityType: "order_entitlement_account",
        module: "entitlement"
      })
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

    const balance = (await harness.service.getOrderEntitlements(
      harness.orderId,
      harness.user
    )) as EntitlementResponse;
    expect(balance.grants.find((grant) => grant.id === mileageGrant.id)?.latestUsageAt).toBe(
      "2026-06-10T10:00:00.000Z"
    );
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
    const inactiveAccountEntitlements =
      (await inactiveAccountHarness.service.generateOrderEntitlements(
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
        { occurredAt: "2026-06-10T10:00:00.000Z", usedAmount: 2000 },
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
      { occurredAt: "2026-06-10T10:00:00.000Z", usedAmount: 1500 },
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
      { externalRefNo: "IDEMPOTENT-001", occurredAt: "2026-06-10T10:00:00.000Z", usedAmount: 100 },
      harness.user,
      harness.context
    )) as ConsumeResponse;
    const second = (await harness.service.consumeOrderEntitlement(
      harness.orderId,
      entitlements.grants[0]!.id,
      { externalRefNo: "IDEMPOTENT-001", occurredAt: "2026-06-10T10:00:00.000Z", usedAmount: 100 },
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
      { externalRefNo: "AUDIT-001", occurredAt: "2026-06-10T10:00:00.000Z", usedAmount: 100 },
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

  it("generates next monthly renewal entitlements for an ACTIVE order", async () => {
    const harness = createEntitlementHarness();
    await harness.service.generateOrderEntitlements(harness.orderId, harness.user, harness.context);

    const result = (await harness.service.renewOrderMonthlyEntitlements(
      harness.orderId,
      { asOfDate: "2026-07-10", dryRun: false },
      harness.user,
      harness.context
    )) as MonthlyRenewalResponse;

    expect(result.action).toBe("GENERATED");
    expect(result.periodStart).toBe("2026-07-10");
    expect(result.periodEnd).toBe("2026-08-09");
    expect(result.grantCount).toBe(4);
    expect(harness.state.grants).toHaveLength(8);
    expect(
      harness.state.grants
        .slice(4)
        .every((grant) => grant.grantSource === EntitlementGrantSource.MONTHLY_RENEWAL)
    ).toBe(true);
  });

  it("rejects monthly renewal when order, delivery, or active account prerequisites are missing", async () => {
    const inactiveOrderHarness = createEntitlementHarness({ orderStatus: OrderStatus.COMPLETED });
    await expect(
      inactiveOrderHarness.service.renewOrderMonthlyEntitlements(
        inactiveOrderHarness.orderId,
        { asOfDate: "2026-07-10" },
        inactiveOrderHarness.user,
        inactiveOrderHarness.context
      )
    ).rejects.toThrow();

    const noDeliveryHarness = createEntitlementHarness({ actualDeliveryAt: null });
    await expect(
      noDeliveryHarness.service.renewOrderMonthlyEntitlements(
        noDeliveryHarness.orderId,
        { asOfDate: "2026-07-10" },
        noDeliveryHarness.user,
        noDeliveryHarness.context
      )
    ).rejects.toThrow();

    const noAccountHarness = createEntitlementHarness();
    await expect(
      noAccountHarness.service.renewOrderMonthlyEntitlements(
        noAccountHarness.orderId,
        { asOfDate: "2026-07-10" },
        noAccountHarness.user,
        noAccountHarness.context
      )
    ).rejects.toThrow("当前订单缺少生效中的权益账户，不能续发。");
  });

  it("skips monthly renewal before the next period starts", async () => {
    const harness = createEntitlementHarness();
    await harness.service.generateOrderEntitlements(harness.orderId, harness.user, harness.context);

    const result = (await harness.service.renewOrderMonthlyEntitlements(
      harness.orderId,
      { asOfDate: "2026-07-09" },
      harness.user,
      harness.context
    )) as MonthlyRenewalResponse;

    expect(result.action).toBe("SKIPPED_NOT_DUE");
    expect(result.periodStart).toBe("2026-07-10");
    expect(harness.state.grants).toHaveLength(4);
  });

  it("does not duplicate the same monthly renewal period and can generate the following period", async () => {
    const harness = createEntitlementHarness();
    await harness.service.generateOrderEntitlements(harness.orderId, harness.user, harness.context);

    await harness.service.renewOrderMonthlyEntitlements(
      harness.orderId,
      { asOfDate: "2026-07-10" },
      harness.user,
      harness.context
    );
    const duplicate = (await harness.service.renewOrderMonthlyEntitlements(
      harness.orderId,
      { asOfDate: "2026-07-10" },
      harness.user,
      harness.context
    )) as MonthlyRenewalResponse;
    const next = (await harness.service.renewOrderMonthlyEntitlements(
      harness.orderId,
      { asOfDate: "2026-08-10" },
      harness.user,
      harness.context
    )) as MonthlyRenewalResponse;

    expect(duplicate.action).toBe("SKIPPED_EXISTING");
    expect(next.action).toBe("GENERATED");
    expect(next.periodStart).toBe("2026-08-10");
    expect(next.periodEnd).toBe("2026-09-09");
    expect(harness.state.grants).toHaveLength(12);
  });

  it("uses the active extension segment snapshot for later monthly renewals", async () => {
    const extensionSnapshot = buildPackageSnapshot({
      benefitPackage: {
        benefitCount: 5,
        benefitType: "WASH_CAR",
        description: "续期每月 5 次洗车权益",
        packageName: "续期洗车权益包"
      },
      energyPackage: null,
      mileagePackage: { monthlyMileageKm: 1800, overMileageFeeAmount: 80 }
    });
    const harness = createEntitlementHarness({
      contractSegments: [
        {
          endDate: new Date("2026-07-09T00:00:00.000Z"),
          id: "segment-base",
          planSnapshot: { packageSnapshot: buildPackageSnapshot() },
          sequenceNo: 1,
          startDate: new Date("2026-06-10T00:00:00.000Z"),
          status: ContractSegmentStatus.COMPLETED
        },
        {
          endDate: new Date("2026-09-09T00:00:00.000Z"),
          id: "segment-extension",
          planSnapshot: { packageSnapshot: extensionSnapshot },
          sequenceNo: 2,
          startDate: new Date("2026-07-10T00:00:00.000Z"),
          status: ContractSegmentStatus.ACTIVE
        }
      ]
    });
    await harness.service.generateOrderEntitlements(harness.orderId, harness.user, harness.context);

    await harness.service.renewOrderMonthlyEntitlements(
      harness.orderId,
      { asOfDate: "2026-07-10" },
      harness.user,
      harness.context
    );
    await harness.service.renewOrderMonthlyEntitlements(
      harness.orderId,
      { asOfDate: "2026-08-10" },
      harness.user,
      harness.context
    );

    const laterExtensionGrants = harness.state.grants.filter(
      (grant) =>
        grant.grantPeriodStart?.getTime() === new Date("2026-08-10T00:00:00.000Z").getTime()
    );
    expect(
      laterExtensionGrants.map((grant) => [
        grant.entitlementType,
        grant.unit,
        grant.totalAmount?.toNumber()
      ])
    ).toEqual([
      [EntitlementType.MILEAGE, EntitlementUnit.KM, 1800],
      [EntitlementType.BENEFIT, EntitlementUnit.TIMES, 5]
    ]);
  });

  it("keeps a future scheduled extension as not due before its entitlement period", async () => {
    const harness = createEntitlementHarness({
      contractSegments: [
        {
          endDate: new Date("2026-07-09T00:00:00.000Z"),
          id: "segment-base",
          planSnapshot: { packageSnapshot: buildPackageSnapshot() },
          sequenceNo: 1,
          startDate: new Date("2026-06-10T00:00:00.000Z"),
          status: ContractSegmentStatus.ACTIVE
        },
        {
          endDate: new Date("2026-09-09T00:00:00.000Z"),
          id: "segment-extension",
          planSnapshot: {
            packageSnapshot: buildPackageSnapshot({
              mileagePackage: { monthlyMileageKm: 1800, overMileageFeeAmount: 80 }
            })
          },
          sequenceNo: 2,
          startDate: new Date("2026-07-10T00:00:00.000Z"),
          status: ContractSegmentStatus.SCHEDULED
        }
      ]
    });
    await harness.service.generateOrderEntitlements(harness.orderId, harness.user, harness.context);

    await expect(
      harness.service.renewOrderMonthlyEntitlements(
        harness.orderId,
        { asOfDate: "2026-07-01" },
        harness.user,
        harness.context
      )
    ).resolves.toMatchObject({ action: "SKIPPED_NOT_DUE", periodStart: "2026-07-10" });
  });

  it("dry-runs batch monthly renewal without writing grants or audit logs", async () => {
    const harness = createEntitlementHarness();
    await harness.service.generateOrderEntitlements(harness.orderId, harness.user, harness.context);
    harness.auditService.write.mockClear();

    const result = (await harness.service.generateMonthlyEntitlements(
      { asOfDate: "2026-07-10", dryRun: true },
      harness.user,
      harness.context
    )) as MonthlyRenewalBatchResponse;

    expect(result.dryRun).toBe(true);
    expect(result.generatedCount).toBe(1);
    expect(result.items[0]?.action).toBe("DRY_RUN_GENERATE");
    expect(harness.state.grants).toHaveLength(4);
    expect(harness.auditService.write).not.toHaveBeenCalled();
  });

  it("batch monthly renewal writes due grants and reports single-order failures", async () => {
    const successHarness = createEntitlementHarness();
    await successHarness.service.generateOrderEntitlements(
      successHarness.orderId,
      successHarness.user,
      successHarness.context
    );
    successHarness.auditService.write.mockClear();

    const successResult = (await successHarness.service.generateMonthlyEntitlements(
      { asOfDate: "2026-07-10" },
      successHarness.user,
      successHarness.context
    )) as MonthlyRenewalBatchResponse;

    expect(successResult.generatedCount).toBe(1);
    expect(successResult.items[0]?.action).toBe("GENERATED");
    expect(successHarness.state.grants).toHaveLength(8);
    expect(successHarness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREATE",
        entityType: "order_entitlement_grant",
        module: "entitlement"
      })
    );

    const failedHarness = createEntitlementHarness();
    const failedResult = (await failedHarness.service.generateMonthlyEntitlements(
      { asOfDate: "2026-07-10" },
      failedHarness.user,
      failedHarness.context
    )) as MonthlyRenewalBatchResponse;
    expect(failedResult.failedCount).toBe(1);
    expect(failedResult.items[0]?.action).toBe("FAILED");
  });

  it("expires only overdue ACTIVE grants and supports dryRun", async () => {
    const harness = createEntitlementHarness();
    const entitlements = (await harness.service.generateOrderEntitlements(
      harness.orderId,
      harness.user,
      harness.context
    )) as EntitlementResponse;
    harness.state.grants[0]!.grantPeriodEnd = new Date("2026-07-09T00:00:00.000Z");
    harness.state.grants[1]!.grantPeriodEnd = new Date("2026-07-09T00:00:00.000Z");
    harness.state.grants[1]!.status = EntitlementGrantStatus.EXHAUSTED;
    harness.state.grants[2]!.grantPeriodEnd = new Date("2026-07-09T00:00:00.000Z");
    harness.state.grants[2]!.status = EntitlementGrantStatus.CANCELLED;

    const dryRun = (await harness.service.expireEntitlements(
      { asOfDate: "2026-07-10", dryRun: true },
      harness.user,
      harness.context
    )) as ExpireEntitlementsResponse;
    expect(dryRun.expiredCount).toBe(2);
    expect(harness.state.grants[0]!.status).toBe(EntitlementGrantStatus.ACTIVE);

    harness.auditService.write.mockClear();
    const result = (await harness.service.expireEntitlements(
      { asOfDate: "2026-07-10" },
      harness.user,
      harness.context
    )) as ExpireEntitlementsResponse;
    expect(result.expiredCount).toBe(2);
    expect(harness.state.grants[0]!.status).toBe(EntitlementGrantStatus.EXPIRED);
    expect(harness.state.grants[1]!.status).toBe(EntitlementGrantStatus.EXHAUSTED);
    expect(harness.state.grants[2]!.status).toBe(EntitlementGrantStatus.CANCELLED);
    expect(result.items.map((item) => item.grantId)).toContain(entitlements.grants[0]!.id);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE",
        entityType: "order_entitlement_grant",
        module: "entitlement"
      })
    );
  });

  it("rejects entitlement consumption outside the grant validity period", async () => {
    const harness = createEntitlementHarness();
    const entitlements = (await harness.service.generateOrderEntitlements(
      harness.orderId,
      harness.user,
      harness.context
    )) as EntitlementResponse;

    await expect(
      harness.service.consumeOrderEntitlement(
        harness.orderId,
        entitlements.grants[0]!.id,
        { occurredAt: "2026-07-10T10:00:00.000Z", usedAmount: 1 },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("权益不在有效期内，不能消耗");
  });

  it("uses the ORDER_START one-month fallback when legacy grants miss grantPeriodEnd", async () => {
    const harness = createEntitlementHarness();
    const entitlements = (await harness.service.generateOrderEntitlements(
      harness.orderId,
      harness.user,
      harness.context
    )) as EntitlementResponse;
    harness.state.grants[0]!.grantPeriodEnd = null;

    await harness.service.consumeOrderEntitlement(
      harness.orderId,
      entitlements.grants[0]!.id,
      { occurredAt: "2026-06-15T10:00:00.000Z", usedAmount: 1 },
      harness.user,
      harness.context
    );

    await expect(
      harness.service.consumeOrderEntitlement(
        harness.orderId,
        entitlements.grants[0]!.id,
        { occurredAt: "2026-07-10T10:00:00.000Z", usedAmount: 1 },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("权益不在有效期内，不能消耗");
  });
});

type EntitlementResponse = {
  account: {
    accountNo: string;
    accountStatus: EntitlementAccountStatus;
    id: string;
    periodEnd: string;
    periodStart: string;
  } | null;
  grants: Array<{
    entitlementName: string;
    entitlementType: EntitlementType;
    grantNo: string;
    grantPeriodEnd: string | null;
    grantPeriodStart: string;
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

type MonthlyRenewalResponse = {
  action: string;
  dryRun: boolean;
  grantCount: number;
  grantIds: string[];
  grants: Array<{
    entitlementName: string;
    entitlementType: EntitlementType;
    totalAmount: number | null;
    unit: EntitlementUnit;
  }>;
  periodEnd: string;
  periodStart: string;
  reason: string;
};

type MonthlyRenewalBatchResponse = {
  dryRun: boolean;
  failedCount: number;
  generatedCount: number;
  items: Array<{
    action: string;
    grantCount: number;
    orderId: string;
    periodEnd: string | null;
    periodStart: string | null;
    reason: string;
  }>;
  skippedCount: number;
};

type ExpireEntitlementsResponse = {
  dryRun: boolean;
  expiredCount: number;
  items: Array<{ grantId: string; status: EntitlementGrantStatus }>;
  skippedCount: number;
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
    contractSegments: Array<Record<string, unknown>>;
    finalPlanSnapshot: unknown;
    grants: GrantRecord[];
    orderStatus: OrderStatus;
    quotePackageSnapshot: unknown;
    quoteSnapshot: unknown;
    usages: UsageRecord[];
  } = {
    accounts: [],
    actualDeliveryAt: new Date("2026-06-10T03:00:00.000Z"),
    contractSegments: [],
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
      contractSegments: state.contractSegments,
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
    return (
      state.accounts.find((account) => {
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
      }) ?? null
    );
  }

  function accountWithGrants(account: AccountRecord) {
    return {
      ...account,
      grants: state.grants
        .filter((grant) => grant.accountId === account.id && !grant.deletedAt)
        .map(grantWithUsages)
    };
  }

  function grantWithUsages(grant: GrantRecord) {
    return {
      ...grant,
      usages: state.usages
        .filter(
          (usage) =>
            usage.grantId === grant.id &&
            !usage.deletedAt &&
            usage.usageStatus === EntitlementUsageStatus.CONFIRMED
        )
        .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
        .slice(0, 1)
    };
  }

  function findGrant(args: { where?: Record<string, unknown> } = {}) {
    const where = args.where ?? {};
    return (
      state.grants.find((grant) => {
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
        if (where.grantSource && grant.grantSource !== where.grantSource) {
          return false;
        }
        if (where.entitlementName && grant.entitlementName !== where.entitlementName) {
          return false;
        }
        if (where.entitlementType && grant.entitlementType !== where.entitlementType) {
          return false;
        }
        if (where.unit && grant.unit !== where.unit) {
          return false;
        }
        if (
          where.grantPeriodStart &&
          !sameDate(grant.grantPeriodStart, where.grantPeriodStart as Date)
        ) {
          return false;
        }
        if (
          where.grantPeriodEnd &&
          (!grant.grantPeriodEnd || !sameDate(grant.grantPeriodEnd, where.grantPeriodEnd as Date))
        ) {
          return false;
        }
        const remainingFilter = where.remainingAmount as { gte?: Prisma.Decimal } | undefined;
        if (
          remainingFilter?.gte &&
          (!grant.remainingAmount || grant.remainingAmount.lt(remainingFilter.gte))
        ) {
          return false;
        }
        return true;
      }) ?? null
    );
  }

  function grantsMatchingWhere(where: Record<string, unknown>) {
    return state.grants.filter((grant) => {
      if (where.deletedAt === null && grant.deletedAt) {
        return false;
      }
      if (where.status && grant.status !== where.status) {
        return false;
      }
      const periodEndWhere = where.grantPeriodEnd as { lt?: Date } | undefined;
      if (
        periodEndWhere?.lt &&
        (!grant.grantPeriodEnd || grant.grantPeriodEnd >= periodEndWhere.lt)
      ) {
        return false;
      }
      return true;
    });
  }

  function sameDate(left: Date, right: Date) {
    return left.toISOString().slice(0, 10) === right.toISOString().slice(0, 10);
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
    const usageStatusWhere = where.usageStatus as
      | EntitlementUsageStatus
      | { not?: EntitlementUsageStatus }
      | undefined;
    if (typeof usageStatusWhere === "string" && usage.usageStatus !== usageStatusWhere) {
      return false;
    }
    if (
      typeof usageStatusWhere === "object" &&
      usageStatusWhere?.not &&
      usage.usageStatus === usageStatusWhere.not
    ) {
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
      count: vi.fn(
        async ({ where }) => state.usages.filter((usage) => usageMatchesWhere(usage, where)).length
      ),
      findMany: vi.fn(async ({ skip = 0, take = 20, where }) =>
        state.usages
          .filter((usage) => usageMatchesWhere(usage, where))
          .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
          .slice(skip, skip + take)
      )
    },
    orderEntitlementGrant: {
      count: vi.fn(async ({ where }) => grantsMatchingWhere(where).length),
      findMany: vi.fn(async ({ where }) => grantsMatchingWhere(where)),
      updateMany: vi.fn(async ({ data, where }) => {
        const grants = grantsMatchingWhere(where);
        for (const grant of grants) {
          Object.assign(grant, data, { updatedAt: now });
        }
        return { count: grants.length };
      })
    },
    subscriptionOrder: {
      findMany: vi.fn(async () => [buildOrder()]),
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
