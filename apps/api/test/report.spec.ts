import {
  BillStatus,
  BillType,
  CollectionCaseStatus,
  CollectionLevel,
  DepositTransactionStatus,
  DepositTransactionType,
  EntitlementAccountStatus,
  EntitlementGrantStatus,
  EntitlementType,
  EntitlementUnit,
  EntitlementUsageSource,
  EntitlementUsageStatus,
  OrderSource,
  OrderStatus,
  VehicleModel,
  VehicleStatus
} from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReportController } from "../src/report/report.controller";
import { escapeCsvCell, toCsv } from "../src/report/report-csv";
import { ReportService } from "../src/report/report.service";

describe("reporting dashboard APIs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns dashboard-summary order, vehicle, finance, overdue, and collection totals", async () => {
    const { prisma, service } = createReportHarness();

    prisma.subscriptionOrder.count.mockResolvedValue(2);
    prisma.subscriptionOrder.groupBy.mockResolvedValue([
      countGroup("orderStatus", OrderStatus.ACTIVE, 1),
      countGroup("orderStatus", OrderStatus.COMPLETED, 1)
    ]);
    prisma.vehicle.count.mockResolvedValue(4);
    prisma.vehicle.groupBy.mockResolvedValue([
      countGroup("status", VehicleStatus.AVAILABLE, 1),
      countGroup("status", VehicleStatus.REVIEW_RESERVED, 1),
      countGroup("status", VehicleStatus.RESERVED, 1),
      countGroup("status", VehicleStatus.LEASED, 1)
    ]);
    prisma.receivableBill.aggregate
      .mockResolvedValueOnce(sumResult({ amount: 1000n, paidAmount: 700n, remainingAmount: 300n }))
      .mockResolvedValueOnce(sumResult({ remainingAmount: 200n }));
    prisma.receivableBill.groupBy.mockResolvedValue([countGroup("orderId", "order-1", 1)]);
    prisma.collectionCase.count.mockResolvedValue(2);
    prisma.depositLedger.groupBy.mockResolvedValue([
      amountGroup("transactionType", DepositTransactionType.COLLECT, 1, { amount: 1000n }),
      amountGroup("transactionType", DepositTransactionType.DEDUCT, 1, { amount: 300n }),
      amountGroup("transactionType", DepositTransactionType.REFUND, 1, { amount: 200n }),
      amountGroup("transactionType", DepositTransactionType.RELEASE, 1, { amount: 100n })
    ]);

    const result = await service.getDashboardSummary({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result).toMatchObject({
      activeOrders: 1,
      availableVehicles: 1,
      cancelledOrders: 0,
      collectionCaseCount: 2,
      completedOrders: 1,
      depositBalanceAmount: 400,
      leasedVehicles: 1,
      newOrders: 2,
      overdueAmount: 200,
      overdueOrderCount: 1,
      reviewReservedVehicles: 1,
      signingLockedVehicles: 1,
      totalOrders: 2,
      totalPaidAmount: 700,
      totalReceivableAmount: 1000,
      totalUnpaidAmount: 300,
      totalVehicles: 4
    });
  });

  it("orders report counts by status", async () => {
    const { prisma, service } = createReportHarness();
    mockOrderReport(prisma);

    const result = await service.getOrderReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.totalOrders).toBe(3);
    expect(findBy(result.byStatus, "orderStatus", OrderStatus.PENDING_CONTRACT)).toMatchObject({
      count: 2
    });
    expect(findBy(result.byStatus, "orderStatus", OrderStatus.CANCELLED)).toMatchObject({
      count: 1
    });
  });

  it("orders report counts by source, vehicle model, and subscription plan", async () => {
    const { prisma, service } = createReportHarness();
    mockOrderReport(prisma);

    const result = await service.getOrderReport({
      endDate: "2026-06-30",
      orderSource: OrderSource.SALES_ASSISTED,
      startDate: "2026-06-01",
      vehicleModel: VehicleModel.ET5
    });

    expect(findBy(result.bySource, "orderSource", OrderSource.SALES_ASSISTED)).toMatchObject({
      count: 2
    });
    expect(findBy(result.bySource, "orderSource", OrderSource.CUSTOMER_SELF_SERVICE)).toMatchObject(
      {
        count: 1
      }
    );
    expect(result.byVehicleModel).toEqual([
      { count: 2, vehicleModel: VehicleModel.ET5 },
      { count: 1, vehicleModel: VehicleModel.ES6 }
    ]);
    expect(result.bySubscriptionPlan).toEqual([
      {
        count: 2,
        subscriptionPlanId: "plan-1",
        subscriptionPlanName: "Standard",
        subscriptionPlanNo: "PLAN-001"
      },
      {
        count: 1,
        subscriptionPlanId: null,
        subscriptionPlanName: null,
        subscriptionPlanNo: null
      }
    ]);
  });

  it("finance report calculates receivable, paid, and unpaid totals from ReceivableBill", async () => {
    const { prisma, service } = createReportHarness();

    prisma.receivableBill.aggregate.mockResolvedValue(
      sumResult({ amount: 5000n, paidAmount: 3200n, remainingAmount: 1800n })
    );
    prisma.receivableBill.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await service.getFinanceReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result).toMatchObject({
      totalPaidAmount: 3200,
      totalReceivableAmount: 5000,
      totalUnpaidAmount: 1800
    });
  });

  it("finance report counts by BillType and BillStatus", async () => {
    const { prisma, service } = createReportHarness();

    prisma.receivableBill.aggregate.mockResolvedValue(
      sumResult({ amount: 5000n, paidAmount: 3200n, remainingAmount: 1800n })
    );
    prisma.receivableBill.groupBy
      .mockResolvedValueOnce([
        amountGroup("billType", BillType.DEPOSIT, 1, {
          amount: 2000n,
          paidAmount: 2000n,
          remainingAmount: 0n
        }),
        amountGroup("billType", BillType.MONTHLY_RENT, 2, {
          amount: 3000n,
          paidAmount: 1200n,
          remainingAmount: 1800n
        })
      ])
      .mockResolvedValueOnce([
        amountGroup("billStatus", BillStatus.PAID, 1, {
          amount: 2000n,
          paidAmount: 2000n,
          remainingAmount: 0n
        }),
        amountGroup("billStatus", BillStatus.PARTIALLY_PAID, 2, {
          amount: 3000n,
          paidAmount: 1200n,
          remainingAmount: 1800n
        })
      ]);

    const result = await service.getFinanceReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(findBy(result.byBillType, "billType", BillType.DEPOSIT)).toMatchObject({
      count: 1,
      totalPaidAmount: 2000,
      totalReceivableAmount: 2000,
      totalUnpaidAmount: 0
    });
    expect(findBy(result.byBillType, "billType", BillType.FIRST_MONTHLY_FEE)).toMatchObject({
      count: 0,
      totalReceivableAmount: 0
    });
    expect(findBy(result.byBillStatus, "billStatus", BillStatus.PARTIALLY_PAID)).toMatchObject({
      count: 2,
      totalUnpaidAmount: 1800
    });
  });

  it("deposit-pool report calculates COLLECT, DEDUCT, REFUND, and RELEASE balance", async () => {
    const { prisma, service } = createReportHarness();

    prisma.depositLedger.groupBy.mockResolvedValue([
      amountGroup("transactionType", DepositTransactionType.COLLECT, 2, { amount: 10000n }),
      amountGroup("transactionType", DepositTransactionType.DEDUCT, 1, { amount: 2000n }),
      amountGroup("transactionType", DepositTransactionType.REFUND, 1, { amount: 1500n }),
      amountGroup("transactionType", DepositTransactionType.RELEASE, 1, { amount: 500n }),
      amountGroup("transactionType", DepositTransactionType.FREEZE, 1, { amount: 900n })
    ]);

    const result = await service.getDepositPoolReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result).toMatchObject({
      collectedAmount: 10000,
      currentBalanceAmount: 6000,
      deductedAmount: 2000,
      refundedAmount: 1500,
      releasedAmount: 500,
      transactionCount: 6
    });
    expect(
      findBy(result.byTransactionType, "transactionType", DepositTransactionType.FREEZE)
    ).toMatchObject({
      amount: 900,
      count: 1
    });
  });

  it("collection report calculates overdue amount, case counts, actions, and promises", async () => {
    const { prisma, service } = createReportHarness();

    prisma.receivableBill.count.mockResolvedValue(2);
    prisma.receivableBill.aggregate.mockResolvedValue(sumResult({ remainingAmount: 5000n }));
    prisma.receivableBill.groupBy.mockResolvedValue([
      countGroup("orderId", "order-1", 1),
      countGroup("orderId", "order-2", 1)
    ]);
    prisma.collectionCase.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    prisma.collectionCase.groupBy
      .mockResolvedValueOnce([
        amountGroup("collectionLevel", CollectionLevel.D1, 2, { totalOverdueAmount: 3000n }),
        amountGroup("collectionLevel", CollectionLevel.D3, 1, { totalOverdueAmount: 2000n })
      ])
      .mockResolvedValueOnce([
        amountGroup("caseStatus", CollectionCaseStatus.ACTIVE, 2, { totalOverdueAmount: 3000n }),
        amountGroup("caseStatus", CollectionCaseStatus.CLOSED, 1, { totalOverdueAmount: 2000n })
      ]);
    prisma.collectionAction.count.mockResolvedValue(4);
    prisma.collectionAction.aggregate.mockResolvedValue(sumResult({ promisedAmount: 1800n }));

    const result = await service.getCollectionReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result).toMatchObject({
      actionCount: 4,
      activeCaseCount: 2,
      closedCaseCount: 1,
      collectionCaseCount: 3,
      overdueAmount: 5000,
      overdueBillCount: 2,
      overdueOrderCount: 2,
      promisedPaymentAmount: 1800
    });
    expect(findBy(result.byCollectionLevel, "collectionLevel", CollectionLevel.D1)).toMatchObject({
      count: 2,
      totalOverdueAmount: 3000
    });
    expect(findBy(result.byCaseStatus, "caseStatus", CollectionCaseStatus.CLOSED)).toMatchObject({
      count: 1,
      totalOverdueAmount: 2000
    });
  });

  it("vehicle-assets report calculates vehicle status counts and lifecycle light fields", async () => {
    const { prisma, service } = createReportHarness();
    mockVehicleAssetReport(prisma);

    const result = await service.getVehicleAssetReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result).toMatchObject({
      availableVehicles: 2,
      averageCurrentSalePriceAmount: 2000,
      leasedVehicles: 2,
      maintenanceVehicles: 1,
      returnedVehicles: 1,
      soldVehicles: 0,
      totalCurrentSalePriceAmount: 8000,
      totalPaidAmount: 1500,
      totalPurchasePriceAmount: 10000,
      totalVehicles: 6
    });
    expect(findBy(result.byVehicleModel, "vehicleModel", VehicleModel.ET5)).toMatchObject({
      availableVehicles: 1,
      incomeAmount: 1000,
      leasedVehicles: 2,
      totalVehicles: 3
    });
  });

  it("vehicle-assets report calculates rental rate as leased over operational vehicles", async () => {
    const { prisma, service } = createReportHarness();
    mockVehicleAssetReport(prisma);

    const result = await service.getVehicleAssetReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.rentalRate).toBeCloseTo(2 / 6);
  });

  it("asset-profitability summary returns asset amounts and excludes deposits from rental income", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetProfitability(prisma);

    const result = await service.getAssetProfitabilitySummary({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result).toMatchObject({
      damagePaidAmount: 30000,
      depositCollectedAmount: 500000,
      rentalPaidAmount: 250000,
      totalCurrentSalePriceAmount: 2300000,
      totalLeasedDays: 17,
      totalPaidAmount: 780000,
      totalPurchasePriceAmount: 3000000,
      totalReceivableAmount: 800000,
      totalRemainingAmount: 20000,
      totalVehicles: 2
    });
    expect(result.averageUtilizationRate).toBeCloseTo((6 / 30 + 11 / 21) / 2);
    expect(result.averageSimpleReturnRate).toBeCloseTo((100000 / 1000000 + 150000 / 2000000) / 2);
  });

  it("asset-profitability vehicles returns paged rows with filters, utilization, and simplified return rate", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetProfitability(prisma);

    const result = await service.getAssetProfitabilityVehicles({
      endDate: "2026-06-30",
      page: 1,
      pageSize: 1,
      sortBy: "rentalPaidAmount",
      sortOrder: "desc",
      startDate: "2026-06-01",
      vehicleModel: VehicleModel.ET5,
      vehicleStatus: VehicleStatus.LEASED
    });

    expect(result).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 2,
      items: [
        {
          currentCustomerName: "李四",
          currentOrderNo: "SO-002",
          leasedDays: 11,
          operatingDays: 21,
          rentalPaidAmount: 150000,
          simpleReturnRate: 150000 / 2000000,
          vehicleId: "vehicle-2",
          vehicleNo: "VH-002"
        }
      ]
    });
    expect(result.items[0]?.utilizationRate).toBeCloseTo(11 / 21);
    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: VehicleStatus.LEASED,
          vehicleModel: VehicleModel.ET5
        })
      })
    );
  });

  it("asset-profitability vehicles clips days to date range and returns null simpleReturnRate for zero cost", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.findMany.mockResolvedValue([
      assetVehicle({
        currentSalePriceAmount: 0n,
        id: "vehicle-zero",
        purchasePriceAmount: 0n,
        salePriceHistories: [
          salePriceHistory({ effectiveFrom: new Date("2026-06-01T00:00:00.000Z") })
        ],
        vehicleNo: "VH-ZERO"
      })
    ]);
    prisma.subscriptionOrder.findMany.mockResolvedValue([
      assetOrder({
        actualDeliveryAt: new Date("2026-06-01T02:00:00.000Z"),
        actualReturnAt: new Date("2026-07-10T02:00:00.000Z"),
        id: "order-zero",
        vehicleId: "vehicle-zero"
      })
    ]);
    prisma.receivableBill.findMany.mockResolvedValue([
      assetBill({
        billType: BillType.MONTHLY_RENT,
        orderId: "order-zero",
        orderNo: "SO-ZERO",
        paidAmount: 88000n,
        vehicleId: "vehicle-zero"
      })
    ]);
    prisma.depositLedger.findMany.mockResolvedValue([]);

    const result = await service.getAssetProfitabilityVehicles({
      endDate: "2026-06-20",
      startDate: "2026-06-10"
    });

    expect(result.items[0]).toMatchObject({
      leasedDays: 11,
      operatingDays: 11,
      simpleReturnRate: null,
      vehicleId: "vehicle-zero"
    });
    expect(result.items[0]?.utilizationRate).toBe(1);
    expect(prisma.receivableBill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dueDate: expect.objectContaining({
            gte: new Date("2026-06-09T16:00:00.000Z"),
            lt: new Date("2026-06-20T16:00:00.000Z")
          })
        })
      })
    );
  });

  it("asset-profitability vehicle detail returns order cycles, bills, lifecycle nodes, and sale price history", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.findFirst.mockResolvedValue(
      assetVehicleDetail({
        deliveries: [
          {
            deliveredAt: new Date("2026-06-05T02:00:00.000Z"),
            deliveryNo: "DLV-001",
            deliveryStatus: "COMPLETED",
            id: "delivery-1",
            orderId: "order-1",
            scheduledAt: new Date("2026-06-05T02:00:00.000Z")
          }
        ],
        returnDamages: [
          {
            createdAt: new Date("2026-06-12T02:00:00.000Z"),
            damageLevel: "MINOR",
            damageType: "SCRATCH",
            description: "rear bumper",
            estimatedRepairAmount: 30000n,
            id: "damage-1",
            orderId: "order-1",
            responsibleParty: "CUSTOMER",
            status: "RECORDED"
          }
        ],
        returns: [
          {
            id: "return-1",
            orderId: "order-1",
            returnedAt: new Date("2026-06-10T02:00:00.000Z"),
            returnNo: "RET-001",
            returnStatus: "COMPLETED",
            scheduledAt: new Date("2026-06-10T02:00:00.000Z")
          }
        ]
      })
    );
    prisma.subscriptionOrder.findMany.mockResolvedValue([
      assetOrder({
        actualDeliveryAt: new Date("2026-06-05T02:00:00.000Z"),
        actualReturnAt: new Date("2026-06-10T02:00:00.000Z"),
        id: "order-1",
        orderNo: "SO-001",
        vehicleId: "vehicle-1"
      })
    ]);
    prisma.receivableBill.findMany.mockResolvedValue([
      assetBill({
        billType: BillType.MONTHLY_RENT,
        orderId: "order-1",
        paidAmount: 100000n,
        vehicleId: "vehicle-1"
      }),
      assetBill({
        billNo: "BILL-DAMAGE",
        billType: BillType.DAMAGE_FEE,
        id: "bill-damage",
        orderId: "order-1",
        paidAmount: 30000n,
        vehicleId: "vehicle-1"
      })
    ]);
    prisma.depositLedger.findMany.mockResolvedValue([
      { amount: 500000n, order: { vehicleId: "vehicle-1" } }
    ]);

    const result = await service.getAssetProfitabilityVehicleDetail("vehicle-1", {
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.vehicle).toMatchObject({ vehicleId: "vehicle-1", vehicleNo: "VH-001" });
    expect(result.summary).toMatchObject({
      damagePaidAmount: 30000,
      depositCollectedAmount: 500000,
      leasedDays: 6,
      rentalPaidAmount: 100000,
      simpleReturnRate: 100000 / 1000000
    });
    expect(result.orderCycles).toEqual([
      expect.objectContaining({
        damagePaidAmount: 30000,
        leasedDays: 6,
        orderNo: "SO-001",
        rentalPaidAmount: 100000
      })
    ]);
    expect(result.bills).toEqual([
      expect.objectContaining({ billNo: "BILL-001", billType: BillType.MONTHLY_RENT }),
      expect.objectContaining({ billNo: "BILL-DAMAGE", billType: BillType.DAMAGE_FEE })
    ]);
    expect(result.salePriceHistory).toEqual([
      expect.objectContaining({ reviewType: "INITIAL_POOL" })
    ]);
    expect(result.lifecycleNodes.map((node) => node.type)).toEqual([
      "INITIAL_POOL",
      "DELIVERY",
      "RETURN"
    ]);
    expect(result.damageRecords).toEqual([
      expect.objectContaining({ damageId: "damage-1", estimatedRepairAmount: 30000 })
    ]);
  });

  it("entitlements report returns account, grant, usage, and exhausted summaries", async () => {
    const { prisma, service } = createReportHarness();
    mockEntitlementReport(prisma);

    const result = await service.getEntitlementReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.accountOverview).toMatchObject({
      activeAccountCount: 2,
      closedAccountCount: 1,
      suspendedAccountCount: 0,
      totalAccountCount: 3
    });
    expect(result.grantOverview).toMatchObject({
      activeGrantCount: 3,
      exhaustedGrantCount: 1,
      totalGrantCount: 4
    });
    expect(findBy(result.byEntitlementTypeUnit, "unit", EntitlementUnit.KM)).toMatchObject({
      entitlementType: EntitlementType.MILEAGE,
      grantCount: 2,
      totalAmount: 3000,
      usedAmount: 1200,
      remainingAmount: 1800,
      exhaustedCount: 1
    });
    expect(result.usageOverview).toMatchObject({
      manualUsageCount: 2,
      systemUsageCount: 1,
      totalUsageCount: 3
    });
    expect(result.recentlyExhausted).toEqual([
      expect.objectContaining({
        customerName: "寮犱笁",
        entitlementName: "月里程额度",
        latestUsageAt: new Date("2026-06-12T08:00:00.000Z"),
        orderNo: "SO-001"
      })
    ]);
  });

  it("entitlements report groups by entitlementType + unit and keeps TEXT amounts null", async () => {
    const { prisma, service } = createReportHarness();
    mockEntitlementReport(prisma);

    const result = await service.getEntitlementReport({
      endDate: "2026-06-30",
      entitlementType: EntitlementType.BENEFIT,
      startDate: "2026-06-01",
      unit: EntitlementUnit.TEXT
    });

    expect(findBy(result.byEntitlementTypeUnit, "unit", EntitlementUnit.TEXT)).toMatchObject({
      entitlementType: EntitlementType.BENEFIT,
      grantCount: 1,
      totalAmount: null,
      usedAmount: null,
      remainingAmount: null
    });
    expect(prisma.orderEntitlementGrant.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entitlementType: EntitlementType.BENEFIT,
          unit: EntitlementUnit.TEXT
        })
      })
    );
  });

  it("entitlements report counts usageSource and usageStatus", async () => {
    const { prisma, service } = createReportHarness();
    mockEntitlementReport(prisma);

    const result = await service.getEntitlementReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(
      findBy(result.usageOverview.bySource, "usageSource", EntitlementUsageSource.MANUAL)
    ).toMatchObject({
      count: 2,
      usedAmount: 101
    });
    expect(
      findBy(result.usageOverview.byStatus, "usageStatus", EntitlementUsageStatus.CONFIRMED)
    ).toMatchObject({
      count: 3,
      usedAmount: 121
    });
  });

  it("entitlement-grants detail supports pagination and entitlementType / unit filters", async () => {
    const { prisma, service } = createReportHarness();
    prisma.orderEntitlementGrant.count.mockResolvedValue(1);
    prisma.orderEntitlementGrant.findMany.mockResolvedValue([
      entitlementGrantRecord({
        entitlementType: EntitlementType.ENERGY,
        unit: EntitlementUnit.KWH
      })
    ]);

    const result = await service.getEntitlementGrantDetails({
      endDate: "2026-06-30",
      entitlementType: EntitlementType.ENERGY,
      page: 2,
      pageSize: 10,
      startDate: "2026-06-01",
      unit: EntitlementUnit.KWH
    });

    expect(result).toMatchObject({
      page: 2,
      pageSize: 10,
      total: 1,
      items: [
        { entitlementType: EntitlementType.ENERGY, grantNo: "EG-001", unit: EntitlementUnit.KWH }
      ]
    });
    expect(prisma.orderEntitlementGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
        where: expect.objectContaining({
          entitlementType: EntitlementType.ENERGY,
          unit: EntitlementUnit.KWH
        })
      })
    );
  });

  it("entitlement-usages detail supports pagination and usageSource filtering", async () => {
    const { prisma, service } = createReportHarness();
    prisma.orderEntitlementUsage.count.mockResolvedValue(1);
    prisma.orderEntitlementUsage.findMany.mockResolvedValue([
      entitlementUsageRecord({ usageSource: EntitlementUsageSource.THIRD_PARTY })
    ]);

    const result = await service.getEntitlementUsageDetails({
      endDate: "2026-06-30",
      pageSize: 5,
      startDate: "2026-06-01",
      usageSource: EntitlementUsageSource.THIRD_PARTY
    });

    expect(result).toMatchObject({
      page: 1,
      pageSize: 5,
      total: 1,
      items: [{ usageNo: "EU-001", usageSource: EntitlementUsageSource.THIRD_PARTY }]
    });
    expect(prisma.orderEntitlementUsage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 5,
        where: expect.objectContaining({
          usageSource: EntitlementUsageSource.THIRD_PARTY
        })
      })
    );
  });

  it("entitlements report applies date range to grants and usages", async () => {
    const { prisma, service } = createReportHarness();
    mockEntitlementReport(prisma);

    await service.getEntitlementReport({
      endDate: "2026-06-02",
      startDate: "2026-06-01"
    });

    const grantGroupCall = prisma.orderEntitlementGrant.groupBy.mock.calls[0];
    const usageGroupCall = prisma.orderEntitlementUsage.groupBy.mock.calls[0];
    expect(grantGroupCall?.[0].where.createdAt.gte.toISOString()).toBe("2026-05-31T16:00:00.000Z");
    expect(grantGroupCall?.[0].where.createdAt.lt.toISOString()).toBe("2026-06-02T16:00:00.000Z");
    expect(usageGroupCall?.[0].where.occurredAt.gte.toISOString()).toBe("2026-05-31T16:00:00.000Z");
    expect(usageGroupCall?.[0].where.occurredAt.lt.toISOString()).toBe("2026-06-02T16:00:00.000Z");
  });

  it("applies startDate and endDate as Asia business natural days", async () => {
    const { prisma, service } = createReportHarness();
    mockOrderReport(prisma);

    await service.getOrderReport({
      endDate: "2026-06-02",
      startDate: "2026-06-01"
    });

    const countCall = prisma.subscriptionOrder.count.mock.calls[0];
    expect(countCall).toBeDefined();
    const where = countCall![0].where;
    expect(where.createdAt.gte.toISOString()).toBe("2026-05-31T16:00:00.000Z");
    expect(where.createdAt.lt.toISOString()).toBe("2026-06-02T16:00:00.000Z");
  });

  it("defaults to the latest 30 Asia business natural days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-07T02:00:00.000Z"));
    const { prisma, service } = createReportHarness();

    prisma.receivableBill.aggregate.mockResolvedValue(
      sumResult({ amount: 0n, paidAmount: 0n, remainingAmount: 0n })
    );
    prisma.receivableBill.groupBy.mockResolvedValue([]);

    const result = await service.getFinanceReport({});
    const aggregateCall = prisma.receivableBill.aggregate.mock.calls[0];
    expect(aggregateCall).toBeDefined();
    const where = aggregateCall![0].where;

    expect(result.dateRange).toEqual({
      endDate: "2026-06-07",
      startDate: "2026-05-09"
    });
    expect(where.dueDate.gte.toISOString()).toBe("2026-05-08T16:00:00.000Z");
    expect(where.dueDate.lt.toISOString()).toBe("2026-06-07T16:00:00.000Z");
  });

  it("orders export returns UTF-8 BOM CSV with Chinese headers, escaped cells, and filename", async () => {
    const { prisma, service } = createReportHarness();
    mockOrderReport(prisma, '标准,套餐"豪华\n版');

    const result = await service.exportOrderReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.filename).toBe("orders-report-20260601-20260630.csv");
    expect(result.content.charCodeAt(0)).toBe(0xfeff);
    expect(result.content).toContain("订单报表");
    expect(result.content).toContain("状态,数量");
    expect(result.content).toContain('"标准,套餐""豪华\n版"');
    expect(result.content).not.toMatch(/undefined|null|\[object Object\]|NaN/);
  });

  it("finance export returns amounts in yuan", async () => {
    const { prisma, service } = createReportHarness();

    prisma.receivableBill.aggregate.mockResolvedValue(
      sumResult({ amount: 123456n, paidAmount: 120000n, remainingAmount: 3456n })
    );
    prisma.receivableBill.groupBy
      .mockResolvedValueOnce([
        amountGroup("billType", BillType.DEPOSIT, 1, {
          amount: 123456n,
          paidAmount: 120000n,
          remainingAmount: 3456n
        })
      ])
      .mockResolvedValueOnce([]);

    const result = await service.exportFinanceReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.filename).toBe("finance-report-20260601-20260630.csv");
    expect(result.content).toContain("财务报表");
    expect(result.content).toContain("总应收金额,1234.56");
    expect(result.content).toContain("押金,1234.56,1200.00,34.56,1");
  });

  it("deposit-pool export returns text rows with yuan amounts", async () => {
    const { prisma, service } = createReportHarness();

    prisma.depositLedger.groupBy.mockResolvedValue([
      amountGroup("transactionType", DepositTransactionType.COLLECT, 1, { amount: 123456n }),
      amountGroup("transactionType", DepositTransactionType.DEDUCT, 1, { amount: 10000n }),
      amountGroup("transactionType", DepositTransactionType.REFUND, 1, { amount: 20000n })
    ]);

    const result = await service.exportDepositPoolReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.filename).toBe("deposit-pool-report-20260601-20260630.csv");
    expect(result.content).toContain("保证金池报表");
    expect(result.content).toContain("累计收取保证金,1234.56");
    expect(result.content).toContain("收取,1234.56,1");
  });

  it("collections export returns overdue and case sections", async () => {
    const { prisma, service } = createReportHarness();

    prisma.receivableBill.count.mockResolvedValue(2);
    prisma.receivableBill.aggregate.mockResolvedValue(sumResult({ remainingAmount: 5000n }));
    prisma.receivableBill.groupBy.mockResolvedValue([countGroup("orderId", "order-1", 1)]);
    prisma.collectionCase.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    prisma.collectionCase.groupBy
      .mockResolvedValueOnce([
        amountGroup("collectionLevel", CollectionLevel.D1, 2, { totalOverdueAmount: 3000n })
      ])
      .mockResolvedValueOnce([
        amountGroup("caseStatus", CollectionCaseStatus.ACTIVE, 1, { totalOverdueAmount: 3000n })
      ]);
    prisma.collectionAction.count.mockResolvedValue(3);
    prisma.collectionAction.aggregate.mockResolvedValue(sumResult({ promisedAmount: 1500n }));

    const result = await service.exportCollectionReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.filename).toBe("collections-report-20260601-20260630.csv");
    expect(result.content).toContain("逾期催收报表");
    expect(result.content).toContain("逾期金额,50.00");
    expect(result.content).toContain("D1：1-3天,30.00,2,-");
    expect(result.content).toContain("催收中,1");
  });

  it("vehicle-assets export returns status summary, rental rate, and model income", async () => {
    const { prisma, service } = createReportHarness();
    mockVehicleAssetReport(prisma);

    const result = await service.exportVehicleAssetReport({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.filename).toBe("vehicle-assets-report-20260601-20260630.csv");
    expect(result.content).toContain("车辆资产报表");
    expect(result.content).toContain("出租率,33.33%");
    expect(result.content).toContain("采购成本合计（元）,100.00");
    expect(result.content).toContain("ET5,3,2,1,10.00");
  });

  it("asset-profitability summary export returns BOM CSV with yuan amounts and percentages", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetProfitability(prisma);

    const result = await service.exportAssetProfitabilitySummary({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.filename).toBe("asset-profitability-summary-20260601-20260630.csv");
    expect(result.content.charCodeAt(0)).toBe(0xfeff);
    expect(result.content).toContain("资产经营汇总");
    expect(result.content).toContain("采购成本合计（元）,30000.00");
    expect(result.content).toContain("押金收取合计（元）,5000.00");
    expect(result.content).toContain("平均出租率,36.19%");
    expect(result.content).not.toMatch(/undefined|null|\[object Object\]|NaN/);
  });

  it("asset-profitability vehicles export returns all filtered rows with localized labels", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetProfitability(prisma);
    prisma.vehicle.findMany.mockResolvedValueOnce([
      assetVehicle({
        brand: 'NIO, "Premium"\nLine',
        vehicleNo: "VH-CSV",
        vin: "VIN-CSV"
      })
    ]);

    const result = await service.exportAssetProfitabilityVehicles({
      endDate: "2026-06-30",
      sortBy: "rentalPaidAmount",
      sortOrder: "desc",
      startDate: "2026-06-01",
      vehicleModel: VehicleModel.ET5,
      vehicleStatus: VehicleStatus.LEASED
    });

    expect(result.filename).toBe("asset-profitability-vehicles-20260601-20260630.csv");
    expect(result.content.charCodeAt(0)).toBe(0xfeff);
    expect(result.content).toContain("车辆编号,VIN,车牌号");
    expect(result.content).toContain('"NIO, ""Premium""\nLine"');
    expect(result.content).toContain("已出租");
    expect(result.content).toContain("买断");
    expect(result.content).toContain("10000.00");
    expect(result.content).toContain("20.00%");
    expect(result.content).not.toMatch(/undefined|null|\[object Object\]|NaN|Invalid Date/);
    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: VehicleStatus.LEASED,
          vehicleModel: VehicleModel.ET5
        })
      })
    );
  });

  it("asset-profitability vehicles export rejects more than 5000 rows", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.findMany.mockResolvedValue(
      Array.from({ length: 5001 }, (_value, index) =>
        assetVehicle({ id: `vehicle-${index}`, vehicleNo: `VH-${index}` })
      )
    );
    prisma.subscriptionOrder.findMany.mockResolvedValue([]);
    prisma.receivableBill.findMany.mockResolvedValue([]);
    prisma.depositLedger.findMany.mockResolvedValue([]);

    await expect(
      service.exportAssetProfitabilityVehicles({
        endDate: "2026-06-30",
        startDate: "2026-06-01"
      })
    ).rejects.toThrow("明细数据超过 5000 行，请缩小筛选范围后再导出。");
  });

  it("asset-profitability vehicle detail export contains all sections and localized statuses", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.findFirst.mockResolvedValue(
      assetVehicleDetail({
        returnDamages: [
          {
            createdAt: new Date("2026-06-12T02:00:00.000Z"),
            damageLevel: "MINOR",
            damageType: "EXTERIOR",
            description: "rear bumper",
            estimatedRepairAmount: 30000n,
            id: "damage-1",
            orderId: "order-1",
            responsibleParty: "CUSTOMER",
            status: "RECORDED",
            vehicleReturn: { returnNo: "RET-001" }
          }
        ],
        salePriceHistories: [
          salePriceHistory({
            reviewQuarter: "2026Q2",
            reviewType: "RETURN_REINIT"
          })
        ]
      })
    );
    prisma.subscriptionOrder.findMany.mockResolvedValue([
      assetOrder({
        actualDeliveryAt: new Date("2026-06-05T02:00:00.000Z"),
        actualReturnAt: new Date("2026-06-10T02:00:00.000Z"),
        id: "order-1",
        orderNo: "SO-001",
        vehicleId: "vehicle-1"
      })
    ]);
    prisma.receivableBill.findMany.mockResolvedValue([
      assetBill({
        billType: BillType.MONTHLY_RENT,
        orderId: "order-1",
        paidAmount: 100000n,
        vehicleId: "vehicle-1"
      }),
      assetBill({
        billNo: "BILL-DAMAGE",
        billType: BillType.DAMAGE_FEE,
        id: "bill-damage",
        orderId: "order-1",
        paidAmount: 30000n,
        vehicleId: "vehicle-1"
      })
    ]);
    prisma.depositLedger.findMany.mockResolvedValue([
      { amount: 500000n, order: { vehicleId: "vehicle-1" } }
    ]);

    const result = await service.exportAssetProfitabilityVehicleDetail("vehicle-1", {
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.filename).toBe("asset-profitability-vehicle-detail-20260601-20260630.csv");
    expect(result.content.charCodeAt(0)).toBe(0xfeff);
    expect(result.content).toContain("单车经营详情");
    expect(result.content).toContain("车辆基础信息");
    expect(result.content).toContain("资产价值信息");
    expect(result.content).toContain("经营汇总");
    expect(result.content).toContain("订单周期明细");
    expect(result.content).toContain("账单明细");
    expect(result.content).toContain("生命周期节点");
    expect(result.content).toContain("损伤记录");
    expect(result.content).toContain("销售价历史");
    expect(result.content).toContain("在租");
    expect(result.content).toContain("月租账单");
    expect(result.content).toContain("退车再入池重新定价");
    expect(result.content).toContain("RET-001,外观,轻微,客户,300.00,已记录,rear bumper");
    expect(result.content).not.toMatch(/undefined|null|\[object Object\]|NaN|Invalid Date/);
  });

  it("orders export applies date range parameters", async () => {
    const { prisma, service } = createReportHarness();
    mockOrderReport(prisma);

    await service.exportOrderReport({
      endDate: "2026-06-02",
      startDate: "2026-06-01"
    });

    const countCall = prisma.subscriptionOrder.count.mock.calls[0];
    expect(countCall).toBeDefined();
    const where = countCall![0].where;
    expect(where.createdAt.gte.toISOString()).toBe("2026-05-31T16:00:00.000Z");
    expect(where.createdAt.lt.toISOString()).toBe("2026-06-02T16:00:00.000Z");
  });

  it("CSV escape handles comma, quote, newline, and unsafe values", () => {
    expect(toCsv([["包含,逗号", '包含"引号', "第一行\n第二行"]])).toBe(
      '"包含,逗号","包含""引号","第一行\n第二行"'
    );
    expect(escapeCsvCell({ value: "object" })).toBe("-");
    expect(escapeCsvCell(Number.NaN)).toBe("-");
  });

  it("export controller returns text/csv headers and attachment filenames", async () => {
    const controller = new ReportController({
      exportBillDetails: vi.fn().mockResolvedValue(csvFile("bills-detail-20260601-20260630.csv")),
      exportCollectionReport: vi
        .fn()
        .mockResolvedValue(csvFile("collections-report-20260601-20260630.csv")),
      exportCollectionCaseDetails: vi
        .fn()
        .mockResolvedValue(csvFile("collection-cases-detail-20260601-20260630.csv")),
      exportDepositLedgerDetails: vi
        .fn()
        .mockResolvedValue(csvFile("deposit-ledgers-detail-20260601-20260630.csv")),
      exportDepositPoolReport: vi
        .fn()
        .mockResolvedValue(csvFile("deposit-pool-report-20260601-20260630.csv")),
      exportFinanceReport: vi
        .fn()
        .mockResolvedValue(csvFile("finance-report-20260601-20260630.csv")),
      exportOrderDetails: vi.fn().mockResolvedValue(csvFile("orders-detail-20260601-20260630.csv")),
      exportOrderReport: vi.fn().mockResolvedValue(csvFile("orders-report-20260601-20260630.csv")),
      exportOverdueBillDetails: vi
        .fn()
        .mockResolvedValue(csvFile("overdue-bills-detail-20260601-20260630.csv")),
      exportAssetProfitabilitySummary: vi
        .fn()
        .mockResolvedValue(csvFile("asset-profitability-summary-20260601-20260630.csv")),
      exportAssetProfitabilityVehicles: vi
        .fn()
        .mockResolvedValue(csvFile("asset-profitability-vehicles-20260601-20260630.csv")),
      exportAssetProfitabilityVehicleDetail: vi
        .fn()
        .mockResolvedValue(csvFile("asset-profitability-vehicle-detail-20260601-20260630.csv")),
      exportVehicleDetails: vi
        .fn()
        .mockResolvedValue(csvFile("vehicles-detail-20260601-20260630.csv")),
      exportVehicleAssetReport: vi
        .fn()
        .mockResolvedValue(csvFile("vehicle-assets-report-20260601-20260630.csv"))
    } as never);

    const ordersResponse = mockResponse();
    await expectCsvResponse(
      "orders-report-20260601-20260630.csv",
      ordersResponse,
      controller.exportOrderReport({}, ordersResponse as never)
    );
    const financeResponse = mockResponse();
    await expectCsvResponse(
      "finance-report-20260601-20260630.csv",
      financeResponse,
      controller.exportFinanceReport({}, financeResponse as never)
    );
    const depositResponse = mockResponse();
    await expectCsvResponse(
      "deposit-pool-report-20260601-20260630.csv",
      depositResponse,
      controller.exportDepositPoolReport({}, depositResponse as never)
    );
    const collectionsResponse = mockResponse();
    await expectCsvResponse(
      "collections-report-20260601-20260630.csv",
      collectionsResponse,
      controller.exportCollectionReport({}, collectionsResponse as never)
    );
    const assetsResponse = mockResponse();
    await expectCsvResponse(
      "vehicle-assets-report-20260601-20260630.csv",
      assetsResponse,
      controller.exportVehicleAssetReport({}, assetsResponse as never)
    );
    const assetProfitabilitySummaryResponse = mockResponse();
    await expectCsvResponse(
      "asset-profitability-summary-20260601-20260630.csv",
      assetProfitabilitySummaryResponse,
      controller.exportAssetProfitabilitySummary({}, assetProfitabilitySummaryResponse as never)
    );
    const assetProfitabilityVehiclesResponse = mockResponse();
    await expectCsvResponse(
      "asset-profitability-vehicles-20260601-20260630.csv",
      assetProfitabilityVehiclesResponse,
      controller.exportAssetProfitabilityVehicles({}, assetProfitabilityVehiclesResponse as never)
    );
    const assetProfitabilityVehicleDetailResponse = mockResponse();
    await expectCsvResponse(
      "asset-profitability-vehicle-detail-20260601-20260630.csv",
      assetProfitabilityVehicleDetailResponse,
      controller.exportAssetProfitabilityVehicleDetail(
        "vehicle-1",
        {},
        assetProfitabilityVehicleDetailResponse as never
      )
    );
    const orderDetailsResponse = mockResponse();
    await expectCsvResponse(
      "orders-detail-20260601-20260630.csv",
      orderDetailsResponse,
      controller.exportOrderDetails({}, orderDetailsResponse as never)
    );
    const billDetailsResponse = mockResponse();
    await expectCsvResponse(
      "bills-detail-20260601-20260630.csv",
      billDetailsResponse,
      controller.exportBillDetails({}, billDetailsResponse as never)
    );
    const depositLedgerDetailsResponse = mockResponse();
    await expectCsvResponse(
      "deposit-ledgers-detail-20260601-20260630.csv",
      depositLedgerDetailsResponse,
      controller.exportDepositLedgerDetails({}, depositLedgerDetailsResponse as never)
    );
    const overdueBillDetailsResponse = mockResponse();
    await expectCsvResponse(
      "overdue-bills-detail-20260601-20260630.csv",
      overdueBillDetailsResponse,
      controller.exportOverdueBillDetails({}, overdueBillDetailsResponse as never)
    );
    const collectionCaseDetailsResponse = mockResponse();
    await expectCsvResponse(
      "collection-cases-detail-20260601-20260630.csv",
      collectionCaseDetailsResponse,
      controller.exportCollectionCaseDetails({}, collectionCaseDetailsResponse as never)
    );
    const vehicleDetailsResponse = mockResponse();
    await expectCsvResponse(
      "vehicles-detail-20260601-20260630.csv",
      vehicleDetailsResponse,
      controller.exportVehicleDetails({}, vehicleDetailsResponse as never)
    );
  });

  it("orders detail API returns paginated items and filters by orderStatus", async () => {
    const { prisma, service } = createReportHarness();
    prisma.subscriptionOrder.count.mockResolvedValue(21);
    prisma.subscriptionOrder.findMany.mockResolvedValue([
      {
        actualReturnAt: null,
        contract: { status: "SIGNED" },
        createdAt: new Date("2026-06-10T08:00:00.000Z"),
        customer: { mobile: "13800000000", name: "张三" },
        depositAmount: 200000n,
        id: "order-1",
        monthlyFeeAmount: 300000n,
        orderNo: "SO-001",
        orderSource: OrderSource.SALES_ASSISTED,
        orderStatus: OrderStatus.ACTIVE,
        quote: {
          subscriptionPlan: { id: "plan-1", planName: "标准套餐", planNo: "PLAN-001" },
          subscriptionPlanId: "plan-1"
        },
        startDate: new Date("2026-06-01T00:00:00.000Z"),
        vehicle: { plateNo: "沪A12345", vehicleNo: "VH-001", vin: "VIN001" },
        vehicleModel: VehicleModel.ET5
      }
    ]);

    const result = await service.getOrderDetails({
      endDate: "2026-06-30",
      orderStatus: OrderStatus.ACTIVE,
      page: 2,
      pageSize: 10,
      startDate: "2026-06-01"
    });

    expect(result).toMatchObject({
      page: 2,
      pageSize: 10,
      total: 21,
      items: [
        {
          contractStatus: "SIGNED",
          customerName: "张三",
          depositAmount: 200000,
          id: "order-1",
          monthlyFeeAmount: 300000,
          orderNo: "SO-001",
          orderStatus: OrderStatus.ACTIVE,
          subscriptionPlanName: "标准套餐"
        }
      ]
    });
    expect(prisma.subscriptionOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
        where: expect.objectContaining({ orderStatus: OrderStatus.ACTIVE })
      })
    );
  });

  it("bills detail API filters by billType and billStatus", async () => {
    const { prisma, service } = createReportHarness();
    prisma.receivableBill.count.mockResolvedValue(1);
    prisma.receivableBill.findMany.mockResolvedValue([
      {
        amount: 123456n,
        billNo: "BILL-001",
        billPeriodEnd: new Date("2026-06-30T00:00:00.000Z"),
        billPeriodStart: new Date("2026-06-01T00:00:00.000Z"),
        billStatus: BillStatus.PAID,
        billType: BillType.MONTHLY_RENT,
        createdAt: new Date("2026-06-01T08:00:00.000Z"),
        customer: { name: "张三" },
        dueDate: new Date("2026-06-05T08:00:00.000Z"),
        id: "bill-1",
        order: { id: "order-1", orderNo: "SO-001" },
        orderId: "order-1",
        paidAmount: 123456n,
        remainingAmount: 0n
      }
    ]);

    const result = await service.getBillDetails({
      billStatus: BillStatus.PAID,
      billType: BillType.MONTHLY_RENT,
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 1,
      items: [
        {
          amount: 123456,
          billNo: "BILL-001",
          billStatus: BillStatus.PAID,
          billType: BillType.MONTHLY_RENT
        }
      ]
    });
    expect(prisma.receivableBill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          billStatus: BillStatus.PAID,
          billType: BillType.MONTHLY_RENT
        })
      })
    );
  });

  it("deposit-ledgers detail API filters by transactionType and defaults to confirmed ledgers", async () => {
    const { prisma, service } = createReportHarness();
    prisma.depositLedger.count.mockResolvedValue(1);
    prisma.depositLedger.findMany.mockResolvedValue([
      {
        amount: 50000n,
        balanceAfter: 150000n,
        bill: { billNo: "BILL-001" },
        customer: { name: "张三" },
        id: "ledger-1",
        ledgerNo: "DL-001",
        occurredAt: new Date("2026-06-10T08:00:00.000Z"),
        order: { id: "order-1", orderNo: "SO-001" },
        orderId: "order-1",
        remark: "扣减",
        transactionStatus: DepositTransactionStatus.CONFIRMED,
        transactionType: DepositTransactionType.DEDUCT
      }
    ]);

    const result = await service.getDepositLedgerDetails({
      endDate: "2026-06-30",
      startDate: "2026-06-01",
      transactionType: DepositTransactionType.DEDUCT
    });

    expect(result).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 1,
      items: [{ amount: 50000, balanceAfterAmount: 150000, ledgerNo: "DL-001" }]
    });
    expect(prisma.depositLedger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          transactionStatus: DepositTransactionStatus.CONFIRMED,
          transactionType: DepositTransactionType.DEDUCT
        })
      })
    );
  });

  it("overdue-bills detail API filters by collectionLevel", async () => {
    const { prisma, service } = createReportHarness();
    prisma.receivableBill.count.mockResolvedValue(1);
    prisma.receivableBill.findMany.mockResolvedValue([
      {
        billNo: "BILL-OD-001",
        billType: BillType.MONTHLY_RENT,
        collectionCaseBills: [
          {
            case: {
              caseNo: "CC-001",
              caseStatus: CollectionCaseStatus.ACTIVE,
              collectionLevel: CollectionLevel.D3
            },
            overdueDays: 8
          }
        ],
        customer: { name: "张三" },
        dueDate: new Date("2026-06-01T08:00:00.000Z"),
        id: "bill-1",
        order: { id: "order-1", orderNo: "SO-001" },
        orderId: "order-1",
        remainingAmount: 80000n
      }
    ]);

    const result = await service.getOverdueBillDetails({
      collectionLevel: CollectionLevel.D3,
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 1,
      items: [
        {
          billNo: "BILL-OD-001",
          collectionLevel: CollectionLevel.D3,
          overdueDays: 8,
          remainingAmount: 80000
        }
      ]
    });
    expect(prisma.receivableBill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          collectionCaseBills: {
            some: {
              case: { collectionLevel: CollectionLevel.D3, deletedAt: null },
              deletedAt: null
            }
          }
        })
      })
    );
  });

  it("collection-cases detail API filters by caseStatus", async () => {
    const { prisma, service } = createReportHarness();
    prisma.collectionCase.count.mockResolvedValue(1);
    prisma.collectionCase.findMany.mockResolvedValue([
      {
        assignedTo: "user-1",
        caseNo: "CC-001",
        caseStatus: CollectionCaseStatus.CLOSED,
        closedAt: new Date("2026-06-20T08:00:00.000Z"),
        collectionLevel: CollectionLevel.D2,
        createdAt: new Date("2026-06-10T08:00:00.000Z"),
        customer: { name: "张三" },
        id: "case-1",
        maxOverdueDays: 6,
        nextFollowUpAt: null,
        order: { id: "order-1", orderNo: "SO-001" },
        orderId: "order-1",
        totalOverdueAmount: 60000n
      }
    ]);

    const result = await service.getCollectionCaseDetails({
      caseStatus: CollectionCaseStatus.CLOSED,
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 1,
      items: [
        { caseNo: "CC-001", caseStatus: CollectionCaseStatus.CLOSED, totalOverdueAmount: 60000 }
      ]
    });
    expect(prisma.collectionCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ caseStatus: CollectionCaseStatus.CLOSED })
      })
    );
  });

  it("vehicles detail API filters by vehicleStatus and returns paginated asset fields", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.count.mockResolvedValue(1);
    prisma.vehicle.findMany.mockResolvedValue([
      {
        batteryCapacityKwh: { toNumber: () => 75.5 },
        batteryUsageType: "BUYOUT",
        brand: "NIO",
        createdAt: new Date("2026-06-01T08:00:00.000Z"),
        currentSalePriceAmount: 20000000n,
        deliveries: [{ deliveredAt: new Date("2026-06-03T08:00:00.000Z") }],
        id: "vehicle-1",
        model: "ET5 75kWh",
        orders: [{ customer: { name: "张三" }, id: "order-1", orderNo: "SO-001" }],
        plateNo: "沪A12345",
        purchasePriceAmount: 25000000n,
        returns: [],
        series: "ET",
        status: VehicleStatus.LEASED,
        vehicleModel: VehicleModel.ET5,
        vehicleNo: "VH-001",
        vin: "VIN001"
      }
    ]);
    prisma.receivableBill.findMany.mockResolvedValue([
      { order: { vehicleId: "vehicle-1" }, paidAmount: 300000n }
    ]);

    const result = await service.getVehicleDetails({
      endDate: "2026-06-30",
      pageSize: 100,
      startDate: "2026-06-01",
      vehicleStatus: VehicleStatus.LEASED
    });

    expect(result).toMatchObject({
      page: 1,
      pageSize: 100,
      total: 1,
      items: [
        {
          batteryCapacityKwh: 75.5,
          currentCustomerName: "张三",
          currentOrderNo: "SO-001",
          totalPaidAmount: 300000,
          vehicleNo: "VH-001",
          vehicleStatus: VehicleStatus.LEASED
        }
      ]
    });
    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
        where: expect.objectContaining({ status: VehicleStatus.LEASED })
      })
    );
  });

  it("orders detail export returns CSV for all filtered rows with Chinese labels and escaped cells", async () => {
    const { prisma, service } = createReportHarness();
    prisma.subscriptionOrder.count.mockResolvedValue(1);
    prisma.subscriptionOrder.findMany.mockResolvedValue([
      {
        actualReturnAt: null,
        contract: { status: "SIGNED" },
        createdAt: new Date("2026-06-10T08:00:00.000Z"),
        customer: { mobile: "13800000000", name: "张三" },
        depositAmount: 200000n,
        id: "order-1",
        monthlyFeeAmount: 300000n,
        orderNo: "SO-001",
        orderSource: OrderSource.SALES_ASSISTED,
        orderStatus: OrderStatus.ACTIVE,
        quote: {
          subscriptionPlan: { id: "plan-1", planName: '标准,套餐"豪华\n版', planNo: "PLAN-001" },
          subscriptionPlanId: "plan-1"
        },
        startDate: new Date("2026-06-01T00:00:00.000Z"),
        vehicle: { plateNo: "沪A12345", vehicleNo: "VH-001", vin: "VIN001" },
        vehicleModel: VehicleModel.ET5
      }
    ]);

    const result = await service.exportOrderDetails({
      endDate: "2026-06-30",
      orderStatus: OrderStatus.ACTIVE,
      startDate: "2026-06-01"
    });

    expect(result.filename).toBe("orders-detail-20260601-20260630.csv");
    expect(result.content.charCodeAt(0)).toBe(0xfeff);
    expect(result.content).toContain("订单编号,客户姓名,手机号,订单来源,订单状态");
    expect(result.content).toContain("销售人工,在租");
    expect(result.content).toContain('"标准,套餐""豪华\n版"');
    expect(result.content).toContain("3000.00,2000.00,已签署");
    expect(result.content).not.toMatch(/undefined|null|\[object Object\]|NaN/);
    expect(prisma.subscriptionOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
        where: expect.objectContaining({ orderStatus: OrderStatus.ACTIVE })
      })
    );
  });

  it("bills detail export returns CSV with yuan amounts and bill labels", async () => {
    const { prisma, service } = createReportHarness();
    prisma.receivableBill.count.mockResolvedValue(1);
    prisma.receivableBill.findMany.mockResolvedValue([
      {
        amount: 123456n,
        billNo: "BILL-001",
        billPeriodEnd: new Date("2026-06-30T00:00:00.000Z"),
        billPeriodStart: new Date("2026-06-01T00:00:00.000Z"),
        billStatus: BillStatus.PAID,
        billType: BillType.MONTHLY_RENT,
        createdAt: new Date("2026-06-01T08:00:00.000Z"),
        customer: { name: "张三" },
        dueDate: new Date("2026-06-05T08:00:00.000Z"),
        id: "bill-1",
        order: { id: "order-1", orderNo: "SO-001" },
        orderId: "order-1",
        paidAmount: 120000n,
        remainingAmount: 3456n
      }
    ]);

    const result = await service.exportBillDetails({
      billStatus: BillStatus.PAID,
      billType: BillType.MONTHLY_RENT,
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.filename).toBe("bills-detail-20260601-20260630.csv");
    expect(result.content).toContain("账单编号,订单编号,客户姓名,账单类型,账单状态");
    expect(result.content).toContain("月租账单,已收款,1234.56,1200.00,34.56");
    expect(result.content).not.toMatch(/undefined|null|\[object Object\]|NaN/);
    expect(prisma.receivableBill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          billStatus: BillStatus.PAID,
          billType: BillType.MONTHLY_RENT
        })
      })
    );
  });

  it("deposit-ledgers detail export returns CSV with transaction labels and escaped remarks", async () => {
    const { prisma, service } = createReportHarness();
    prisma.depositLedger.count.mockResolvedValue(1);
    prisma.depositLedger.findMany.mockResolvedValue([
      {
        amount: 50000n,
        balanceAfter: 150000n,
        bill: { billNo: "BILL-001" },
        customer: { name: "张三" },
        id: "ledger-1",
        ledgerNo: "DL-001",
        occurredAt: new Date("2026-06-10T08:00:00.000Z"),
        order: { id: "order-1", orderNo: "SO-001" },
        orderId: "order-1",
        remark: '包含,逗号"引号\n换行',
        transactionStatus: DepositTransactionStatus.CONFIRMED,
        transactionType: DepositTransactionType.DEDUCT
      }
    ]);

    const result = await service.exportDepositLedgerDetails({
      endDate: "2026-06-30",
      startDate: "2026-06-01",
      transactionType: DepositTransactionType.DEDUCT
    });

    expect(result.filename).toBe("deposit-ledgers-detail-20260601-20260630.csv");
    expect(result.content).toContain("台账编号,订单编号,客户姓名,交易类型,交易状态");
    expect(result.content).toContain("扣减,已确认,500.00,1500.00");
    expect(result.content).toContain('"包含,逗号""引号\n换行"');
    expect(result.content).not.toMatch(/undefined|null|\[object Object\]|NaN/);
  });

  it("overdue-bills detail export returns CSV with collection level and case status labels", async () => {
    const { prisma, service } = createReportHarness();
    prisma.receivableBill.count.mockResolvedValue(1);
    prisma.receivableBill.findMany.mockResolvedValue([
      {
        billNo: "BILL-OD-001",
        billType: BillType.MONTHLY_RENT,
        collectionCaseBills: [
          {
            case: {
              caseNo: "CC-001",
              caseStatus: CollectionCaseStatus.ACTIVE,
              collectionLevel: CollectionLevel.D3
            },
            overdueDays: 8
          }
        ],
        customer: { name: "张三" },
        dueDate: new Date("2026-06-01T08:00:00.000Z"),
        id: "bill-1",
        order: { id: "order-1", orderNo: "SO-001" },
        orderId: "order-1",
        remainingAmount: 80000n
      }
    ]);

    const result = await service.exportOverdueBillDetails({
      collectionLevel: CollectionLevel.D3,
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.filename).toBe("overdue-bills-detail-20260601-20260630.csv");
    expect(result.content).toContain("账单编号,订单编号,客户姓名,账单类型,剩余金额（元）");
    expect(result.content).toContain("月租账单,800.00,2026-06-01,8,D3：8-15天,CC-001,催收中");
    expect(result.content).not.toMatch(/undefined|null|\[object Object\]|NaN/);
  });

  it("collection-cases detail export returns CSV with case labels and yuan amounts", async () => {
    const { prisma, service } = createReportHarness();
    prisma.collectionCase.count.mockResolvedValue(1);
    prisma.collectionCase.findMany.mockResolvedValue([
      {
        assignedTo: "user-1",
        caseNo: "CC-001",
        caseStatus: CollectionCaseStatus.CLOSED,
        closedAt: new Date("2026-06-20T08:00:00.000Z"),
        collectionLevel: CollectionLevel.D2,
        createdAt: new Date("2026-06-10T08:00:00.000Z"),
        customer: { name: "张三" },
        id: "case-1",
        maxOverdueDays: 6,
        nextFollowUpAt: null,
        order: { id: "order-1", orderNo: "SO-001" },
        orderId: "order-1",
        totalOverdueAmount: 60000n
      }
    ]);

    const result = await service.exportCollectionCaseDetails({
      caseStatus: CollectionCaseStatus.CLOSED,
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.filename).toBe("collection-cases-detail-20260601-20260630.csv");
    expect(result.content).toContain("案件编号,客户姓名,订单编号,逾期总金额（元）");
    expect(result.content).toContain("CC-001,张三,SO-001,600.00,6,D2：4-7天,已关闭");
    expect(result.content).not.toMatch(/undefined|null|\[object Object\]|NaN/);
  });

  it("vehicles detail export returns CSV with vehicle labels and paid amounts", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.count.mockResolvedValue(1);
    prisma.vehicle.findMany.mockResolvedValue([
      {
        batteryCapacityKwh: { toNumber: () => 75.5 },
        batteryUsageType: "BUYOUT",
        brand: "NIO",
        createdAt: new Date("2026-06-01T08:00:00.000Z"),
        currentSalePriceAmount: 20000000n,
        deliveries: [{ deliveredAt: new Date("2026-06-03T08:00:00.000Z") }],
        id: "vehicle-1",
        model: "ET5 75kWh",
        orders: [{ customer: { name: "张三" }, id: "order-1", orderNo: "SO-001" }],
        plateNo: "沪A12345",
        purchasePriceAmount: 25000000n,
        returns: [],
        series: "ET",
        status: VehicleStatus.LEASED,
        vehicleModel: VehicleModel.ET5,
        vehicleNo: "VH-001",
        vin: "VIN001"
      }
    ]);
    prisma.receivableBill.findMany.mockResolvedValue([
      { order: { vehicleId: "vehicle-1" }, paidAmount: 300000n }
    ]);

    const result = await service.exportVehicleDetails({
      endDate: "2026-06-30",
      startDate: "2026-06-01",
      vehicleStatus: VehicleStatus.LEASED
    });

    expect(result.filename).toBe("vehicles-detail-20260601-20260630.csv");
    expect(result.content).toContain("车辆编号,VIN,车牌号,品牌,车系,车型");
    expect(result.content).toContain("买断,已出租,250000.00,200000.00,SO-001,张三,3000.00");
    expect(result.content).not.toMatch(/undefined|null|\[object Object\]|NaN/);
  });

  it("detail export rejects when the filtered result exceeds maxExportRows", async () => {
    const { prisma, service } = createReportHarness();
    prisma.receivableBill.count.mockResolvedValue(5001);
    prisma.receivableBill.findMany.mockResolvedValue([]);

    await expect(
      service.exportBillDetails({
        endDate: "2026-06-30",
        startDate: "2026-06-01"
      })
    ).rejects.toThrow("明细数据超过 5000 行，请缩小筛选范围后再导出。");
  });
});

function createReportHarness() {
  const prisma = {
    collectionAction: {
      aggregate: vi.fn(),
      count: vi.fn()
    },
    collectionCase: {
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn()
    },
    depositLedger: {
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn()
    },
    orderEntitlementAccount: {
      groupBy: vi.fn()
    },
    orderEntitlementGrant: {
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn()
    },
    orderEntitlementUsage: {
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn()
    },
    receivableBill: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn()
    },
    subscriptionOrder: {
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn()
    },
    vehicle: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn()
    }
  };

  return {
    prisma,
    service: new ReportService(prisma as never)
  };
}

type ReportPrismaMock = ReturnType<typeof createReportHarness>["prisma"];

function mockOrderReport(prisma: ReportPrismaMock, planName = "Standard") {
  prisma.subscriptionOrder.count.mockResolvedValue(3);
  prisma.subscriptionOrder.groupBy
    .mockResolvedValueOnce([
      countGroup("orderStatus", OrderStatus.PENDING_CONTRACT, 2),
      countGroup("orderStatus", OrderStatus.CANCELLED, 1)
    ])
    .mockResolvedValueOnce([
      countGroup("orderSource", OrderSource.SALES_ASSISTED, 2),
      countGroup("orderSource", OrderSource.CUSTOMER_SELF_SERVICE, 1)
    ])
    .mockResolvedValueOnce([
      countGroup("vehicleModel", VehicleModel.ET5, 2),
      countGroup("vehicleModel", VehicleModel.ES6, 1)
    ]);
  prisma.subscriptionOrder.findMany.mockResolvedValue([
    {
      quote: {
        subscriptionPlan: { id: "plan-1", planName, planNo: "PLAN-001" },
        subscriptionPlanId: "plan-1"
      }
    },
    {
      quote: {
        subscriptionPlan: { id: "plan-1", planName, planNo: "PLAN-001" },
        subscriptionPlanId: "plan-1"
      }
    },
    {
      quote: {
        subscriptionPlan: null,
        subscriptionPlanId: null
      }
    }
  ]);
}

function mockVehicleAssetReport(prisma: ReportPrismaMock) {
  prisma.vehicle.count.mockResolvedValueOnce(6).mockResolvedValueOnce(4);
  prisma.vehicle.groupBy
    .mockResolvedValueOnce([
      countGroup("status", VehicleStatus.AVAILABLE, 2),
      countGroup("status", VehicleStatus.LEASED, 2),
      countGroup("status", VehicleStatus.MAINTENANCE, 1),
      countGroup("status", VehicleStatus.RETURNED, 1)
    ])
    .mockResolvedValueOnce([
      {
        ...countGroup("vehicleModel", VehicleModel.ET5, 1),
        status: VehicleStatus.AVAILABLE
      },
      {
        ...countGroup("vehicleModel", VehicleModel.ET5, 2),
        status: VehicleStatus.LEASED
      },
      {
        ...countGroup("vehicleModel", VehicleModel.ES6, 1),
        status: VehicleStatus.AVAILABLE
      },
      {
        ...countGroup("vehicleModel", VehicleModel.ES6, 1),
        status: VehicleStatus.MAINTENANCE
      }
    ]);
  prisma.vehicle.aggregate.mockResolvedValue(
    sumResult({
      currentSalePriceAmount: 8000n,
      purchasePriceAmount: 10000n
    })
  );
  prisma.receivableBill.findMany.mockResolvedValue([
    { order: { vehicleModel: VehicleModel.ET5 }, paidAmount: 1000n },
    { order: { vehicleModel: VehicleModel.ES6 }, paidAmount: 500n }
  ]);
}

function mockAssetProfitability(prisma: ReportPrismaMock) {
  prisma.vehicle.findMany.mockResolvedValue([
    assetVehicle(),
    assetVehicle({
      currentSalePriceAmount: 1500000n,
      id: "vehicle-2",
      purchasePriceAmount: 2000000n,
      salePriceHistories: [
        salePriceHistory({ effectiveFrom: new Date("2026-06-10T00:00:00.000Z") })
      ],
      vehicleNo: "VH-002"
    })
  ]);
  prisma.subscriptionOrder.findMany.mockResolvedValue([
    assetOrder({
      actualDeliveryAt: new Date("2026-06-05T02:00:00.000Z"),
      actualReturnAt: new Date("2026-06-10T02:00:00.000Z"),
      customer: { name: "张三" },
      id: "order-1",
      orderNo: "SO-001",
      vehicleId: "vehicle-1"
    }),
    assetOrder({
      actualDeliveryAt: new Date("2026-06-20T02:00:00.000Z"),
      actualReturnAt: null,
      customer: { name: "李四" },
      endDate: new Date("2026-06-30T00:00:00.000Z"),
      id: "order-2",
      orderNo: "SO-002",
      vehicleId: "vehicle-2"
    })
  ]);
  prisma.receivableBill.findMany.mockResolvedValue([
    assetBill({
      amount: 120000n,
      billType: BillType.MONTHLY_RENT,
      orderId: "order-1",
      paidAmount: 100000n,
      remainingAmount: 20000n,
      vehicleId: "vehicle-1"
    }),
    assetBill({
      amount: 500000n,
      billNo: "BILL-DEPOSIT",
      billType: BillType.DEPOSIT,
      id: "bill-deposit",
      orderId: "order-1",
      paidAmount: 500000n,
      remainingAmount: 0n,
      vehicleId: "vehicle-1"
    }),
    assetBill({
      amount: 30000n,
      billNo: "BILL-DAMAGE",
      billType: BillType.DAMAGE_FEE,
      id: "bill-damage",
      orderId: "order-1",
      paidAmount: 30000n,
      remainingAmount: 0n,
      vehicleId: "vehicle-1"
    }),
    assetBill({
      amount: 150000n,
      billNo: "BILL-FIRST",
      billType: BillType.FIRST_MONTHLY_FEE,
      id: "bill-first",
      orderId: "order-2",
      orderNo: "SO-002",
      paidAmount: 150000n,
      remainingAmount: 0n,
      vehicleId: "vehicle-2"
    })
  ]);
  prisma.depositLedger.findMany.mockResolvedValue([
    { amount: 500000n, order: { vehicleId: "vehicle-1" } }
  ]);
}

function assetVehicle(overrides: Record<string, unknown> = {}) {
  return {
    batteryCapacityKwh: decimalLike(75),
    batteryUsageType: "BUYOUT",
    brand: "NIO",
    createdAt: new Date("2026-06-01T02:00:00.000Z"),
    currentSalePriceAmount: 800000n,
    currentSalePriceReviewedAt: new Date("2026-06-01T02:00:00.000Z"),
    id: "vehicle-1",
    model: "ET5 75kWh",
    plateNo: "沪A10001",
    purchasePriceAmount: 1000000n,
    salePriceStatus: "EFFECTIVE",
    salePriceHistories: [salePriceHistory()],
    series: "ET",
    status: VehicleStatus.LEASED,
    vehicleModel: VehicleModel.ET5,
    vehicleNo: "VH-001",
    vin: "VIN001",
    ...overrides
  };
}

function assetVehicleDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...assetVehicle(),
    deliveries: [],
    returnDamages: [],
    returns: [],
    ...overrides
  };
}

function salePriceHistory(overrides: Record<string, unknown> = {}) {
  return {
    afterSalePriceAmount: 800000n,
    beforeSalePriceAmount: null,
    createdAt: new Date("2026-06-01T02:00:00.000Z"),
    effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
    effectiveTo: null,
    id: "sale-price-1",
    reason: "initial pool",
    remark: null,
    reviewQuarter: "2026Q2",
    reviewType: "INITIAL_POOL",
    ...overrides
  };
}

function assetOrder(overrides: Record<string, unknown> = {}) {
  return {
    actualDeliveryAt: new Date("2026-06-05T02:00:00.000Z"),
    actualReturnAt: new Date("2026-06-10T02:00:00.000Z"),
    createdAt: new Date("2026-06-04T02:00:00.000Z"),
    customer: { name: "张三" },
    endDate: new Date("2026-06-30T00:00:00.000Z"),
    id: "order-1",
    monthlyFeeAmount: 300000n,
    orderNo: "SO-001",
    orderStatus: OrderStatus.ACTIVE,
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function assetBill(overrides: Record<string, unknown> = {}) {
  const orderId = String(overrides.orderId ?? "order-1");
  const orderNo = String(overrides.orderNo ?? "SO-001");
  const vehicleId = String(overrides.vehicleId ?? "vehicle-1");

  return {
    amount: 100000n,
    billNo: "BILL-001",
    billPeriodEnd: new Date("2026-06-30T00:00:00.000Z"),
    billPeriodStart: new Date("2026-06-01T00:00:00.000Z"),
    billStatus: BillStatus.PAID,
    billType: BillType.MONTHLY_RENT,
    dueDate: new Date("2026-06-15T02:00:00.000Z"),
    id: "bill-1",
    orderId,
    paidAmount: 100000n,
    remainingAmount: 0n,
    ...overrides,
    order: { orderNo, vehicleId }
  };
}

function mockEntitlementReport(prisma: ReportPrismaMock) {
  prisma.orderEntitlementAccount.groupBy.mockResolvedValue([
    countGroup("accountStatus", EntitlementAccountStatus.ACTIVE, 2),
    countGroup("accountStatus", EntitlementAccountStatus.CLOSED, 1)
  ]);
  prisma.orderEntitlementGrant.groupBy
    .mockResolvedValueOnce([
      countGroup("status", EntitlementGrantStatus.ACTIVE, 3),
      countGroup("status", EntitlementGrantStatus.EXHAUSTED, 1)
    ])
    .mockResolvedValueOnce([
      entitlementAmountGroup(EntitlementType.MILEAGE, EntitlementUnit.KM, 2, {
        remainingAmount: decimalLike(1800),
        totalAmount: decimalLike(3000),
        usedAmount: decimalLike(1200)
      }),
      entitlementAmountGroup(EntitlementType.BENEFIT, EntitlementUnit.TEXT, 1, {
        remainingAmount: null,
        totalAmount: null,
        usedAmount: null
      })
    ])
    .mockResolvedValueOnce([
      { entitlementType: EntitlementType.MILEAGE, unit: EntitlementUnit.KM, _count: { _all: 1 } }
    ]);
  prisma.orderEntitlementUsage.groupBy
    .mockResolvedValueOnce([
      usageAmountGroup("unit", EntitlementUnit.KM, 2, 100),
      usageAmountGroup("unit", EntitlementUnit.KWH, 1, 21)
    ])
    .mockResolvedValueOnce([
      usageAmountGroup("usageSource", EntitlementUsageSource.MANUAL, 2, 101),
      usageAmountGroup("usageSource", EntitlementUsageSource.SYSTEM, 1, 20)
    ])
    .mockResolvedValueOnce([
      usageAmountGroup("usageStatus", EntitlementUsageStatus.CONFIRMED, 3, 121),
      usageAmountGroup("usageStatus", EntitlementUsageStatus.CANCELLED, 0, 0)
    ]);
  prisma.orderEntitlementGrant.findMany.mockResolvedValue([
    entitlementGrantRecord({
      status: EntitlementGrantStatus.EXHAUSTED,
      usages: [{ occurredAt: new Date("2026-06-12T08:00:00.000Z") }]
    })
  ]);
}

function entitlementGrantRecord(
  overrides: Partial<ReturnType<typeof baseEntitlementGrantRecord>> = {}
) {
  return {
    ...baseEntitlementGrantRecord(),
    ...overrides
  };
}

function baseEntitlementGrantRecord() {
  return {
    createdAt: new Date("2026-06-10T08:00:00.000Z"),
    customer: { name: "寮犱笁" },
    entitlementName: "月里程额度",
    entitlementType: EntitlementType.MILEAGE as EntitlementType,
    grantNo: "EG-001",
    grantPeriodEnd: new Date("2026-06-30T00:00:00.000Z"),
    grantPeriodStart: new Date("2026-06-01T00:00:00.000Z"),
    grantSource: "ORDER_START",
    id: "grant-1",
    order: { id: "order-1", orderNo: "SO-001" },
    remainingAmount: decimalLike(0),
    status: EntitlementGrantStatus.ACTIVE as EntitlementGrantStatus,
    totalAmount: decimalLike(1500),
    unit: EntitlementUnit.KM as EntitlementUnit,
    updatedAt: new Date("2026-06-12T08:00:00.000Z"),
    usedAmount: decimalLike(1500),
    usages: [] as Array<{ occurredAt: Date }>
  };
}

function entitlementUsageRecord(
  overrides: Partial<ReturnType<typeof baseEntitlementUsageRecord>> = {}
) {
  return {
    ...baseEntitlementUsageRecord(),
    ...overrides
  };
}

function baseEntitlementUsageRecord() {
  return {
    createdAt: new Date("2026-06-12T08:00:00.000Z"),
    customer: { name: "寮犱笁" },
    entitlementName: "月补能额度",
    entitlementType: EntitlementType.ENERGY as EntitlementType,
    externalRefNo: "EXT-001",
    id: "usage-1",
    occurredAt: new Date("2026-06-12T08:00:00.000Z"),
    order: { id: "order-1", orderNo: "SO-001" },
    remark: "测试消耗",
    scenario: "补能核销",
    unit: EntitlementUnit.KWH as EntitlementUnit,
    usageNo: "EU-001",
    usageSource: EntitlementUsageSource.MANUAL as EntitlementUsageSource,
    usageStatus: EntitlementUsageStatus.CONFIRMED as EntitlementUsageStatus,
    usedAmount: decimalLike(20)
  };
}

function entitlementAmountGroup(
  entitlementType: EntitlementType,
  unit: EntitlementUnit,
  count: number,
  sums: Record<string, unknown>
) {
  return {
    entitlementType,
    unit,
    _count: { _all: count },
    _sum: sums
  };
}

function usageAmountGroup(field: string, value: unknown, count: number, usedAmount: number) {
  return {
    [field]: value,
    _count: { _all: count },
    _sum: { usedAmount: decimalLike(usedAmount) }
  };
}

function decimalLike(value: number) {
  return { toNumber: () => value };
}

function countGroup(field: string, value: unknown, count: number) {
  return {
    [field]: value,
    _count: { _all: count }
  };
}

function amountGroup(field: string, value: unknown, count: number, sums: Record<string, bigint>) {
  return {
    [field]: value,
    _count: { _all: count },
    _sum: sums
  };
}

function sumResult(sums: Record<string, bigint>) {
  return { _sum: sums };
}

function findBy<T extends Record<string, unknown>>(rows: T[], field: keyof T, value: unknown) {
  const row = rows.find((item) => item[field] === value);
  expect(row).toBeDefined();
  return row;
}

function csvFile(filename: string) {
  return {
    content: "\uFEFF测试",
    filename
  };
}

function mockResponse() {
  const headers = new Map<string, string>();

  return {
    headers,
    setHeader(name: string, value: string) {
      headers.set(name, value);
    }
  };
}

async function expectCsvResponse(
  filename: string,
  response: ReturnType<typeof mockResponse>,
  responsePromise: Promise<string>
) {
  const content = await responsePromise;

  expect(content.charCodeAt(0)).toBe(0xfeff);
  expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename="${filename}"`);
  expect(response.headers.get("Access-Control-Expose-Headers")).toBe("Content-Disposition");
}
