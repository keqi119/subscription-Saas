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
  FinancingAllocationStatus,
  FinancingInstrumentStatus,
  FinancingRepaymentMethod,
  OrderSource,
  OrderStatus,
  RevenueRightAssignmentStatus,
  RevenueRightAssignmentType,
  RevenueRightAssigneeType,
  RevenueRightTargetType,
  RevenueShareBasis,
  RevenueShareRuleStatus,
  RevenueShareRuleType,
  VehicleAssetCostProfileStatus,
  VehicleAcquisitionMode,
  VehicleBaasBillingCycle,
  VehicleBaasContractStatus,
  VehicleBaasCostRecordStatus,
  VehicleBaasCostSource,
  VehicleCapitalEventStatus,
  VehicleDepreciationMethod,
  VehicleDepreciationPolicyStatus,
  VehicleDepreciationRecordSource,
  VehicleDepreciationRecordStatus,
  VehicleDepreciationScheduleStatus,
  VehicleModel,
  VehicleResidualCurveMethod,
  VehicleResidualCurveStatus,
  VehicleResidualForecastMethod,
  VehicleResidualForecastPointStatus,
  VehicleResidualForecastStatus,
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

  it("asset return trial marks missing cost profiles and excludes deposits from operating revenue", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      bills: [
        assetBill({ billType: BillType.MONTHLY_RENT, paidAmount: 100000n }),
        assetBill({
          billNo: "BILL-DAMAGE",
          billType: BillType.DAMAGE_FEE,
          id: "bill-damage",
          paidAmount: 30000n
        }),
        assetBill({
          billNo: "BILL-OTHER",
          billType: BillType.OTHER,
          id: "bill-other",
          paidAmount: 20000n
        }),
        assetBill({
          billNo: "BILL-DEPOSIT",
          billType: BillType.DEPOSIT,
          id: "bill-deposit",
          paidAmount: 500000n
        })
      ],
      profiles: []
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });

    expect(result.items[0]).toMatchObject({
      costProfileMissing: true,
      depositCollectedAmount: 500000,
      operatingCostAmount: null,
      operatingRevenueAmount: 150000,
      trialRoa: null
    });
  });

  it("asset return trial calculates STRAIGHT_LINE costs, net income, ROA, and annualized ROA", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma);

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result.items[0]).toMatchObject({
      capitalCostAmount: 120000,
      depreciationCostAmount: 1080000,
      insuranceCostAmount: 36500,
      maintenanceReserveCostAmount: 73000,
      operatingCostAmount: 1321500,
      operatingRevenueAmount: 650000,
      otherCostAmount: 12000,
      trialNetOperatingIncomeAmount: -671500
    });
    expect(result.items[0]?.trialRoa).toBeCloseTo(-671500 / 1200000);
    expect(result.items[0]?.annualizedTrialRoa).toBeCloseTo(-671500 / 1200000);
    expect(result.items[0]?.roeTrial).toBeCloseTo(-671500 / 1200000);
    expect(result.items[0]?.roeWarnings).toContain("未录入资本事件，按全自有资金假设试算 ROE。");
  });

  it("asset return trial exposes default 12-month residual forecast sensitivity without changing main ROE", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      forecasts: [assetResidualForecast()]
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });
    const row = result.items[0];

    expect(row).toMatchObject({
      costProfileResidualValueAmount: 120000,
      forecastLowerBoundAmount: 130000,
      forecastResidualAmount: 180000,
      forecastResidualAmountSource: "PREDICTED",
      forecastResidualRateBps: 1500,
      forecastUpperBoundAmount: 220000,
      residualDeltaToCostProfileAmount: 60000,
      residualDeltaToCurrentSalePriceAmount: -820000,
      residualForecastAvailable: true,
      residualForecastHorizonMonth: 12,
      residualSensitivityNetIncomeAmount: -611500
    });
    expect(row?.roeTrial).toBeCloseTo(-671500 / 1200000);
    expect(row?.residualSensitivityRoeTrial).toBeCloseTo(-611500 / 1200000);
    expect(row?.residualSensitivityAnnualizedRoeTrial).toBeCloseTo(-611500 / 1200000);
    expect(JSON.stringify(row)).toContain("forecastResidualAmount");
  });

  it("asset return trial includes BaaS costs in main return metrics", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      baasContracts: [assetBaasContract()],
      baasCostRecords: [
        assetBaasCostRecord({
          costAmount: 30000n,
          costRecordNo: "BCR-SCHEDULED",
          costStatus: VehicleBaasCostRecordStatus.SCHEDULED,
          id: "baas-cost-scheduled"
        }),
        assetBaasCostRecord({
          costAmount: 20000n,
          costPeriod: "2026-07",
          costRecordNo: "BCR-CONFIRMED",
          costStatus: VehicleBaasCostRecordStatus.CONFIRMED,
          id: "baas-cost-confirmed"
        }),
        assetBaasCostRecord({
          costAmount: 40000n,
          costPeriod: "2026-08",
          costRecordNo: "BCR-PAID",
          costStatus: VehicleBaasCostRecordStatus.PAID,
          id: "baas-cost-paid"
        })
      ]
    });

    const vehicles = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });
    const row = vehicles.items[0];

    expect(row).toMatchObject({
      baasAdjustedPlatformNetIncomeAmount: -761500,
      baasConfirmedCostAmount: 20000,
      baasContractNo: "BAAS202606010001",
      baasContractStatus: VehicleBaasContractStatus.ACTIVE,
      baasCostAmount: 90000,
      baasCostAllocationMethod: "PERIOD_PRORATED",
      baasCostFullRecordAmount: 90000,
      baasCostRecordCount: 3,
      baasPaidCostAmount: 40000,
      baasProviderName: "蔚来能源",
      baasScheduledCostAmount: 30000,
      operatingCostAmount: 1411500,
      platformNetIncomeAmount: -761500,
      trialNetOperatingIncomeAmount: -761500
    });
    expect(row?.roeTrial).toBeCloseTo(-761500 / 1200000);
    expect(row?.trialRoa).toBeCloseTo(-761500 / 1200000);
    expect(row?.baasAdjustedRoeTrial).toBeCloseTo(-761500 / 1200000);
    expect(row?.baasAdjustedAnnualizedRoeTrial).toBeCloseTo(-761500 / 1200000);

    const summary = await service.getAssetReturnTrialSummary({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(summary).toMatchObject({
      baasAdjustedPlatformNetIncomeAmount: -761500,
      baasCostAmount: 90000,
      baasCostAllocationMethod: "PERIOD_PRORATED",
      baasCostFullRecordAmount: 90000,
      baasCostRecordCount: 3,
      baasCostVehicleCount: 1,
      platformNetIncomeAmount: -761500
    });
    expect(summary.roeTrial).toBeCloseTo(-761500 / 1200000);
    expect(summary.baasAdjustedRoeTrial).toBeCloseTo(-761500 / 1200000);
    expect(prisma.vehicleBaasCostRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ periodStart: "asc" }, { costPeriod: "asc" }, { createdAt: "asc" }],
        where: expect.objectContaining({
          costStatus: {
            in: [
              VehicleBaasCostRecordStatus.SCHEDULED,
              VehicleBaasCostRecordStatus.CONFIRMED,
              VehicleBaasCostRecordStatus.PAID,
              VehicleBaasCostRecordStatus.OVERDUE
            ]
          },
          periodEnd: { gte: expect.any(Date) },
          periodStart: { lte: expect.any(Date) }
        })
      })
    );
  });

  it("asset return trial prorates BaaS costs by service period instead of due date", async () => {
    const { prisma, service } = createReportHarness();
    const allBaasCostRecords = [
      assetBaasCostRecord({
        costAmount: 31000n,
        costRecordNo: "BCR-PRORATED",
        costStatus: VehicleBaasCostRecordStatus.SCHEDULED,
        dueDate: new Date("2026-02-10T00:00:00.000Z"),
        id: "baas-cost-prorated",
        periodEnd: new Date("2026-01-31T00:00:00.000Z"),
        periodStart: new Date("2026-01-01T00:00:00.000Z")
      }),
      assetBaasCostRecord({
        costAmount: 28000n,
        costRecordNo: "BCR-DUE-ONLY",
        costStatus: VehicleBaasCostRecordStatus.PAID,
        dueDate: new Date("2026-01-20T00:00:00.000Z"),
        id: "baas-cost-due-only",
        periodEnd: new Date("2026-02-28T00:00:00.000Z"),
        periodStart: new Date("2026-02-01T00:00:00.000Z")
      }),
      assetBaasCostRecord({
        costAmount: 10000n,
        costRecordNo: "BCR-VOIDED",
        costStatus: VehicleBaasCostRecordStatus.VOIDED,
        dueDate: new Date("2026-01-18T00:00:00.000Z"),
        id: "baas-cost-voided",
        periodEnd: new Date("2026-01-31T00:00:00.000Z"),
        periodStart: new Date("2026-01-01T00:00:00.000Z")
      }),
      assetBaasCostRecord({
        costAmount: 16000n,
        costRecordNo: "BCR-OVERDUE",
        costStatus: VehicleBaasCostRecordStatus.OVERDUE,
        dueDate: new Date("2026-03-10T00:00:00.000Z"),
        id: "baas-cost-overdue",
        periodEnd: new Date("2026-01-31T00:00:00.000Z"),
        periodStart: new Date("2026-01-16T00:00:00.000Z")
      })
    ];
    mockAssetReturnTrial(prisma, {
      baasContracts: [assetBaasContract()]
    });
    prisma.vehicleBaasCostRecord.findMany.mockImplementation(async (args) => {
      const where = args.where as {
        costStatus: { in: VehicleBaasCostRecordStatus[] };
        periodEnd: { gte: Date };
        periodStart: { lte: Date };
      };

      return allBaasCostRecords.filter((record) => {
        const costStatus = record.costStatus as VehicleBaasCostRecordStatus;
        return (
          where.costStatus.in.includes(costStatus) &&
          (record.periodStart as Date) <= where.periodStart.lte &&
          (record.periodEnd as Date) >= where.periodEnd.gte
        );
      });
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-01-31",
      startDate: "2026-01-16"
    });
    const row = result.items[0];

    expect(row?.baasCostAmount).toBe(32000);
    expect(row?.baasCostFullRecordAmount).toBe(47000);
    expect(row?.baasCostRecordCount).toBe(2);
    expect(row?.baasScheduledCostAmount).toBe(16000);
    expect(row?.baasOverdueCostAmount).toBe(16000);
  });

  it("asset return trial falls back to legacy depreciation without an active depreciation policy", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma);

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });
    const row = result.items[0];

    expect(row).toMatchObject({
      depreciationAmount: 1080000,
      depreciationCostAmount: 1080000,
      depreciationRecordCount: 0,
      depreciationSource: "LEGACY_COST_PROFILE",
      legacyDepreciationAmount: 1080000,
      operatingCostAmount: 1321500,
      recordDepreciationAmount: 0
    });
  });

  it("asset return trial uses NONE active depreciation policy as zero depreciation", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      depreciationPolicies: [
        assetDepreciationPolicy({
          depreciationMethod: VehicleDepreciationMethod.NONE
        })
      ]
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });
    const row = result.items[0];

    expect(row).toMatchObject({
      depreciationAmount: 0,
      depreciationCostAmount: 0,
      depreciationSource: "NONE",
      operatingCostAmount: 241500,
      roeUnavailableReason: null
    });
  });

  it("asset return trial uses confirmed manual depreciation records and avoids legacy manual blocking", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      depreciationPolicies: [
        assetDepreciationPolicy({
          depreciationMethod: VehicleDepreciationMethod.MANUAL
        })
      ],
      depreciationRecords: [
        assetDepreciationRecord({
          depreciationAmount: 240000n,
          recordSource: VehicleDepreciationRecordSource.MANUAL,
          scheduleId: null
        })
      ],
      profiles: [
        assetCostProfile({
          depreciationMethod: VehicleDepreciationMethod.MANUAL
        })
      ]
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });
    const row = result.items[0];

    expect(row).toMatchObject({
      depreciationAmount: 240000,
      depreciationRecordCount: 1,
      depreciationSource: "RECORDS",
      manualDepreciationUnsupported: false,
      operatingCostAmount: 481500,
      recordDepreciationAmount: 240000
    });
    expect(row?.roeTrial).not.toBeNull();
    expect(row?.roeMissingReasons).not.toContain(
      "MANUAL 折旧方法暂未配置手工折旧明细，无法试算 ROA。"
    );
  });

  it("asset return trial marks active manual depreciation policy unavailable without records", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      depreciationPolicies: [
        assetDepreciationPolicy({
          depreciationMethod: VehicleDepreciationMethod.MANUAL
        })
      ]
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });
    const row = result.items[0];

    expect(row).toMatchObject({
      depreciationAmount: null,
      depreciationCostAmount: null,
      depreciationSource: "UNAVAILABLE",
      operatingCostAmount: null,
      roeTrial: null
    });
    expect(row?.roeMissingReasons).toContain("手工折旧策略缺少折旧记录");
  });

  it("asset return trial marks straight-line policy unavailable when schedules are not confirmed", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      depreciationPolicies: [assetDepreciationPolicy()],
      depreciationSchedules: [assetDepreciationSchedule()]
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-06-30",
      startDate: "2026-06-01"
    });
    const row = result.items[0];

    expect(row).toMatchObject({
      depreciationSource: "UNAVAILABLE",
      operatingCostAmount: null,
      roeTrial: null
    });
    expect(row?.roeMissingReasons).toContain("直线折旧策略存在未确认折旧计划");
  });

  it("asset return trial includes confirmed and locked depreciation records by period window", async () => {
    const { prisma, service } = createReportHarness();
    const allRecords = [
      assetDepreciationRecord({
        costPeriod: "2026-02",
        depreciationAmount: 31000n,
        id: "dep-confirmed",
        periodEnd: new Date("2026-01-31T00:00:00.000Z"),
        periodStart: new Date("2026-01-01T00:00:00.000Z"),
        recordNo: "VDR-CONFIRMED",
        recordStatus: VehicleDepreciationRecordStatus.CONFIRMED
      }),
      assetDepreciationRecord({
        depreciationAmount: 16000n,
        id: "dep-locked",
        periodEnd: new Date("2026-01-31T00:00:00.000Z"),
        periodStart: new Date("2026-01-16T00:00:00.000Z"),
        recordNo: "VDR-LOCKED",
        recordStatus: VehicleDepreciationRecordStatus.LOCKED
      }),
      assetDepreciationRecord({
        depreciationAmount: 99999n,
        id: "dep-draft",
        recordNo: "VDR-DRAFT",
        recordStatus: VehicleDepreciationRecordStatus.DRAFT
      }),
      assetDepreciationRecord({
        depreciationAmount: 99999n,
        id: "dep-voided",
        recordNo: "VDR-VOIDED",
        recordStatus: VehicleDepreciationRecordStatus.VOIDED
      })
    ];
    mockAssetReturnTrial(prisma, {
      depreciationPolicies: [assetDepreciationPolicy()]
    });
    prisma.vehicleDepreciationRecord.findMany.mockImplementation(async (args) => {
      const where = args.where as {
        periodEnd: { gte: Date };
        periodStart: { lte: Date };
        recordStatus: { in: VehicleDepreciationRecordStatus[] };
      };

      return allRecords.filter((record) => {
        const status = record.recordStatus as VehicleDepreciationRecordStatus;
        return (
          where.recordStatus.in.includes(status) &&
          (record.periodStart as Date) <= where.periodStart.lte &&
          (record.periodEnd as Date) >= where.periodEnd.gte
        );
      });
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-01-31",
      startDate: "2026-01-16"
    });
    const row = result.items[0];

    expect(row).toMatchObject({
      depreciationAmount: 32000,
      depreciationRecordCount: 2,
      depreciationSource: "RECORDS",
      recordDepreciationAmount: 32000
    });
    expect(prisma.vehicleDepreciationRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recordStatus: {
            in: [
              VehicleDepreciationRecordStatus.CONFIRMED,
              VehicleDepreciationRecordStatus.LOCKED
            ]
          },
          periodEnd: { gte: expect.any(Date) },
          periodStart: { lte: expect.any(Date) }
        })
      })
    );
  });

  it("asset return trial uses adopted residual amount before predicted amount", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      forecasts: [
        assetResidualForecast({
          createdAt: new Date("2026-06-05T00:00:00.000Z"),
          forecastStatus: VehicleResidualForecastStatus.GENERATED,
          id: "forecast-generated",
          points: [assetResidualForecastPoint({ predictedResidualAmount: 180000n })]
        }),
        assetResidualForecast({
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          forecastNo: "VRF-ADOPTED",
          forecastStatus: VehicleResidualForecastStatus.ADOPTED,
          id: "forecast-adopted",
          points: [
            assetResidualForecastPoint({
              adoptedResidualAmount: 210000n,
              pointStatus: VehicleResidualForecastPointStatus.ADOPTED,
              predictedResidualAmount: 180000n
            })
          ]
        })
      ]
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result.items[0]).toMatchObject({
      forecastResidualAmount: 210000,
      forecastResidualAmountSource: "ADOPTED",
      residualDeltaToCostProfileAmount: 90000,
      residualForecastNo: "VRF-ADOPTED",
      residualForecastStatus: VehicleResidualForecastStatus.ADOPTED,
      residualSensitivityNetIncomeAmount: -581500
    });
    expect(result.items[0]?.roeTrial).toBeCloseTo(-671500 / 1200000);
  });

  it("asset return trial respects residualHorizonMonth and reports missing target points", async () => {
    const missingHarness = createReportHarness();
    mockAssetReturnTrial(missingHarness.prisma, {
      forecasts: [assetResidualForecast()]
    });

    const missingResult = await missingHarness.service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      residualHorizonMonth: 24,
      startDate: "2026-01-01"
    });

    expect(missingResult.items[0]).toMatchObject({
      forecastResidualAmount: null,
      residualForecastAvailable: false,
      residualForecastHorizonMonth: 24,
      residualForecastUnavailableReason: "未找到指定预测周期的残值预测点。"
    });

    const matchedHarness = createReportHarness();
    mockAssetReturnTrial(matchedHarness.prisma, {
      forecasts: [
        assetResidualForecast({
          points: [
            assetResidualForecastPoint({
              horizonMonth: 24,
              id: "forecast-point-24",
              predictedResidualAmount: 250000n
            })
          ]
        })
      ]
    });

    const matchedResult = await matchedHarness.service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      residualHorizonMonth: 24,
      startDate: "2026-01-01"
    });

    expect(matchedResult.items[0]).toMatchObject({
      forecastResidualAmount: 250000,
      residualForecastAvailable: true,
      residualForecastHorizonMonth: 24
    });
  });

  it("asset return trial reports unavailable residual forecast states", async () => {
    const missingHarness = createReportHarness();
    mockAssetReturnTrial(missingHarness.prisma);
    const missingResult = await missingHarness.service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });
    expect(missingResult.items[0]).toMatchObject({
      residualForecastAvailable: false,
      residualForecastUnavailableReason: "未找到有效残值预测记录。"
    });

    const unsupportedHarness = createReportHarness();
    mockAssetReturnTrial(unsupportedHarness.prisma, {
      forecasts: [
        assetResidualForecast({
          points: [
            assetResidualForecastPoint({
              pointStatus: VehicleResidualForecastPointStatus.UNSUPPORTED,
              predictedResidualAmount: null
            })
          ]
        })
      ]
    });
    const unsupportedResult = await unsupportedHarness.service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });
    expect(unsupportedResult.items[0]).toMatchObject({
      forecastResidualAmount: null,
      residualForecastAvailable: false,
      residualForecastUnavailableReason: "该预测点暂不支持，可能超出残值曲线范围。"
    });
  });

  it("asset return trial uses financing allocation interest instead of cost profile capital cost", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      financingAllocations: [assetFinancingAllocation()]
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result.items[0]).toMatchObject({
      capitalCostAmount: 72000,
      capitalCostSource: "FINANCING_INSTRUMENT",
      debtInterestCostAmount: 72000,
      debtPrincipalAmount: 600000,
      operatingCostAmount: 1273500,
      platformNetIncomeAmount: -623500,
      roeEquityBaseAmount: 600000,
      trialNetOperatingIncomeAmount: -623500
    });
    expect(result.items[0]?.roeTrial).toBeCloseTo(-623500 / 600000);
    expect(result.items[0]?.roeWarnings).toContain(
      "未录入自有资金资本事件，按采购价扣除债务本金估算权益资本。"
    );
  });

  it("asset return trial keeps PLEDGE revenue in platform revenue but tracks pledged amount", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      revenueRightAssignments: [assetRevenueRightAssignment()]
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result.items[0]).toMatchObject({
      assignedOutRevenueAmount: 0,
      operatingRevenueAmount: 650000,
      platformRetainedRevenueAmount: 650000,
      pledgedRevenueAmount: 650000
    });
  });

  it("asset return trial deducts TRANSFER and SPV_POOL revenue from platform retained revenue", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      revenueRightAssignments: [
        assetRevenueRightAssignment({
          assignmentType: RevenueRightAssignmentType.TRANSFER,
          shareRatioBps: 5000
        })
      ]
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result.items[0]).toMatchObject({
      assignedOutRevenueAmount: 325000,
      platformNetIncomeAmount: -996500,
      platformRetainedRevenueAmount: 325000,
      pledgedRevenueAmount: 0
    });
    expect(result.items[0]?.roeTrial).toBeCloseTo(-996500 / 1200000);
  });

  it("asset return trial applies RENTAL_PAID and OPERATING_REVENUE revenue share rules", async () => {
    const rentalHarness = createReportHarness();
    mockAssetReturnTrial(rentalHarness.prisma, {
      revenueShareRules: [assetRevenueShareRule()]
    });
    const rentalResult = await rentalHarness.service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(rentalResult.items[0]).toMatchObject({
      ownerShareAmount: 150000,
      platformRetainedRevenueAmount: 500000
    });

    const operatingHarness = createReportHarness();
    mockAssetReturnTrial(operatingHarness.prisma, {
      revenueShareRules: [
        assetRevenueShareRule({ shareBasis: RevenueShareBasis.OPERATING_REVENUE })
      ]
    });
    const operatingResult = await operatingHarness.service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(operatingResult.items[0]).toMatchObject({
      ownerShareAmount: 195000,
      platformRetainedRevenueAmount: 455000
    });
  });

  it("asset return trial applies FIXED_RENT as external lease cost", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      revenueShareRules: [
        assetRevenueShareRule({
          fixedMonthlyAmount: 100000n,
          ownerShareBps: null,
          ruleType: RevenueShareRuleType.FIXED_RENT,
          shareBasis: RevenueShareBasis.RENTAL_PAID
        })
      ]
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result.items[0]).toMatchObject({
      externalLeaseCostAmount: 1200000,
      ownerShareAmount: 0,
      platformNetIncomeAmount: -1871500
    });
  });

  it("asset return trial returns missing reasons for unsupported share basis and repayment method", async () => {
    const shareHarness = createReportHarness();
    mockAssetReturnTrial(shareHarness.prisma, {
      revenueShareRules: [
        assetRevenueShareRule({ shareBasis: RevenueShareBasis.GROSS_RECEIVABLE })
      ]
    });
    const shareResult = await shareHarness.service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(shareResult.items[0]?.roeTrial).toBeNull();
    expect(shareResult.items[0]?.roeMissingReasons).toContain(
      "GROSS_RECEIVABLE 分润口径暂未接入 ROE 试算。"
    );

    const debtHarness = createReportHarness();
    mockAssetReturnTrial(debtHarness.prisma, {
      financingAllocations: [
        assetFinancingAllocation({
          instrument: {
            annualRateBps: 1200,
            id: "financing-instrument-1",
            instrumentNo: "FI202601010001",
            instrumentStatus: FinancingInstrumentStatus.ACTIVE,
            instrumentType: "BANK_PROJECT_LOAN",
            lenderName: "测试银行",
            principalAmount: 600000n,
            repaymentMethod: FinancingRepaymentMethod.EQUAL_PRINCIPAL
          }
        })
      ]
    });
    const debtResult = await debtHarness.service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(debtResult.items[0]).toMatchObject({
      capitalCostSource: "FINANCING_INSTRUMENT",
      debtInterestCostAmount: null,
      roeTrial: null
    });
    expect(debtResult.items[0]?.roeMissingReasons).toContain("当前还款方式暂未实现精确利息试算。");
  });

  it("asset return trial supports NONE and MANUAL depreciation methods", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      vehicles: [
        assetReturnVehicle({
          assetCostProfiles: [
            assetCostProfile({
              depreciationMethod: VehicleDepreciationMethod.NONE,
              id: "profile-none"
            })
          ],
          id: "vehicle-none",
          vehicleNo: "VH-NONE"
        }),
        assetReturnVehicle({
          assetCostProfiles: [
            assetCostProfile({
              depreciationMethod: VehicleDepreciationMethod.MANUAL,
              id: "profile-manual"
            })
          ],
          id: "vehicle-manual",
          vehicleNo: "VH-MANUAL"
        })
      ],
      bills: [
        assetBill({ orderId: "order-none", paidAmount: 200000n, vehicleId: "vehicle-none" }),
        assetBill({
          orderId: "order-manual",
          orderNo: "SO-MANUAL",
          paidAmount: 200000n,
          vehicleId: "vehicle-manual"
        })
      ],
      orders: [
        assetOrder({ id: "order-none", orderNo: "SO-NONE", vehicleId: "vehicle-none" }),
        assetOrder({ id: "order-manual", orderNo: "SO-MANUAL", vehicleId: "vehicle-manual" })
      ]
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      sortBy: "operatingCostAmount",
      sortOrder: "asc",
      startDate: "2026-01-01"
    });
    const none = result.items.find((item) => item.vehicleId === "vehicle-none");
    const manual = result.items.find((item) => item.vehicleId === "vehicle-manual");

    expect(none).toMatchObject({
      depreciationCostAmount: 0,
      manualDepreciationUnsupported: false
    });
    expect(manual).toMatchObject({
      depreciationCostAmount: null,
      manualDepreciationUnsupported: true,
      operatingCostAmount: null,
      trialRoa: null
    });
    expect(manual?.costUnavailableReason).toContain("MANUAL 折旧方法暂未配置手工折旧明细");
  });

  it("asset return trial returns null ROA when purchase price is zero", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      vehicles: [
        assetReturnVehicle({
          assetCostProfiles: [assetCostProfile({ residualValueAmount: 0n })],
          purchasePriceAmount: 0n
        })
      ]
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result.items[0]?.trialNetOperatingIncomeAmount).not.toBeNull();
    expect(result.items[0]?.trialRoa).toBeNull();
    expect(result.items[0]?.annualizedTrialRoa).toBeNull();
  });

  it("asset return trial summary aggregates income, costs, counts, and ROE availability", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      vehicles: [
        assetReturnVehicle(),
        assetReturnVehicle({ assetCostProfiles: [], id: "vehicle-missing", vehicleNo: "VH-MISS" })
      ],
      bills: [
        assetBill({ paidAmount: 500000n }),
        assetBill({
          billNo: "BILL-MISS",
          id: "bill-miss",
          orderId: "order-missing",
          orderNo: "SO-MISS",
          paidAmount: 100000n,
          vehicleId: "vehicle-missing"
        })
      ],
      orders: [
        assetOrder({ vehicleId: "vehicle-1" }),
        assetOrder({ id: "order-missing", orderNo: "SO-MISS", vehicleId: "vehicle-missing" })
      ]
    });

    const result = await service.getAssetReturnTrialSummary({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result).toMatchObject({
      costCalculatedVehicleCount: 1,
      costUnavailableVehicleCount: 1,
      operatingRevenueAmount: 600000,
      rentalPaidAmount: 600000,
      roeCalculatedVehicleCount: 1,
      roeUnavailableReason: null,
      roeUnavailableVehicleCount: 1,
      vehicleCount: 2,
      vehicleMissingCostProfileCount: 1,
      vehicleWithCostProfileCount: 1
    });
    expect(result.operatingCostAmount).toBe(1321500);
    expect(result.trialRoa).toBeCloseTo((500000 - 1321500) / 1200000);
    expect(result.roeTrial).toBeCloseTo((500000 - 1321500) / 1200000);
    expect(result.roeMissingReasons).toContain("缺少 ACTIVE 车辆资产成本参数，无法试算 ROA。");
  });

  it("asset return trial summary aggregates residual forecast sensitivity", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      vehicles: [
        assetReturnVehicle(),
        assetReturnVehicle({ id: "vehicle-missing", vehicleNo: "VH-MISS" })
      ],
      bills: [
        assetBill({ paidAmount: 500000n }),
        assetBill({
          billNo: "BILL-MISS",
          id: "bill-miss",
          orderId: "order-missing",
          orderNo: "SO-MISS",
          paidAmount: 100000n,
          vehicleId: "vehicle-missing"
        })
      ],
      forecasts: [assetResidualForecast()],
      orders: [
        assetOrder({ vehicleId: "vehicle-1" }),
        assetOrder({ id: "order-missing", orderNo: "SO-MISS", vehicleId: "vehicle-missing" })
      ]
    });

    const result = await service.getAssetReturnTrialSummary({
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result).toMatchObject({
      forecastResidualAmount: 180000,
      residualDeltaToCostProfileAmount: 60000,
      residualForecastAdoptedVehicleCount: 0,
      residualForecastMissingVehicleCount: 1,
      residualForecastUnsupportedVehicleCount: 0,
      residualForecastVehicleCount: 1,
      residualSensitivityNetIncomeAmount: -761500
    });
    expect(result.residualSensitivityRoeTrial).toBeCloseTo(-761500 / 1200000);
  });

  it("asset return trial detail returns residual forecast summary, point, and curve summary", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.findFirst.mockResolvedValue(assetReturnVehicleDetail());
    mockAssetReturnTrial(prisma, {
      forecasts: [
        assetResidualForecast({
          forecastStatus: VehicleResidualForecastStatus.ADOPTED,
          points: [
            assetResidualForecastPoint({
              adoptedResidualAmount: 210000n,
              pointStatus: VehicleResidualForecastPointStatus.ADOPTED
            })
          ]
        })
      ]
    });

    const result = await service.getAssetReturnTrialVehicleDetail("vehicle-1", {
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result.residualForecastSummary).toMatchObject({
      amountSource: "ADOPTED",
      available: true,
      curveNo: "VRC202606020001",
      forecastStatus: VehicleResidualForecastStatus.ADOPTED,
      horizonMonth: 12
    });
    expect(result.residualForecastPoint).toMatchObject({
      adoptedResidualAmount: 210000,
      forecastResidualAmount: 210000,
      pointStatus: VehicleResidualForecastPointStatus.ADOPTED,
      predictedResidualAmount: 180000
    });
    expect(result.residualForecastCurveSummary).toMatchObject({
      curveNo: "VRC202606020001",
      curveStatus: VehicleResidualCurveStatus.ACTIVE
    });
    expect(result.returns).toMatchObject({
      residualDeltaToCostProfileAmount: 90000,
      residualSensitivityNetIncomeAmount: -581500
    });
  });

  it("asset return trial vehicle list supports pagination, sorting, and date-range cost allocation", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      vehicles: [
        assetReturnVehicle({ id: "vehicle-low", vehicleNo: "VH-LOW" }),
        assetReturnVehicle({ id: "vehicle-high", vehicleNo: "VH-HIGH" })
      ],
      bills: [
        assetBill({ orderId: "order-low", paidAmount: 100000n, vehicleId: "vehicle-low" }),
        assetBill({
          orderId: "order-high",
          orderNo: "SO-HIGH",
          paidAmount: 900000n,
          vehicleId: "vehicle-high"
        })
      ],
      orders: [
        assetOrder({ id: "order-low", orderNo: "SO-LOW", vehicleId: "vehicle-low" }),
        assetOrder({ id: "order-high", orderNo: "SO-HIGH", vehicleId: "vehicle-high" })
      ]
    });

    const result = await service.getAssetReturnTrialVehicles({
      endDate: "2026-01-30",
      page: 1,
      pageSize: 1,
      sortBy: "trialNetOperatingIncomeAmount",
      sortOrder: "desc",
      startDate: "2026-01-01"
    });

    expect(result).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    expect(result.items[0]?.vehicleId).toBe("vehicle-high");
    expect(result.items[0]?.costDays).toBe(30);
  });

  it("asset return trial vehicle detail returns profile, preview, income details, cost breakdown, and ROE reason", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.findFirst.mockResolvedValue(assetReturnVehicleDetail());
    prisma.subscriptionOrder.findMany.mockResolvedValue([assetOrder()]);
    prisma.receivableBill.findMany.mockResolvedValue([
      assetBill({ billType: BillType.MONTHLY_RENT, paidAmount: 500000n }),
      assetBill({
        billNo: "BILL-DAMAGE",
        billType: BillType.DAMAGE_FEE,
        id: "bill-damage",
        paidAmount: 100000n
      })
    ]);
    prisma.depositLedger.findMany.mockResolvedValue([
      { amount: 500000n, order: { vehicleId: "vehicle-1" } }
    ]);

    const result = await service.getAssetReturnTrialVehicleDetail("vehicle-1", {
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result.vehicle).toMatchObject({ vehicleId: "vehicle-1", vehicleNo: "VH-001" });
    expect(result.costProfile).toMatchObject({
      depreciationMethod: VehicleDepreciationMethod.STRAIGHT_LINE,
      residualValueAmount: 120000
    });
    expect(result.costPreview).toMatchObject({
      monthlyDepreciationAmount: 90000,
      monthlyCapitalCostAmount: 10000
    });
    expect(result.incomeBreakdown).toMatchObject({
      depositIncludedInOperatingRevenue: false,
      operatingRevenueAmount: 600000
    });
    expect(result.costBreakdown).toMatchObject({
      capitalCostAmount: 120000,
      depreciationCostAmount: 1080000,
      operatingCostAmount: 1321500
    });
    expect(result.returns).toMatchObject({
      platformNetIncomeAmount: -721500,
      roeUnavailableReason: null
    });
    expect(result.returns.roeTrial).toBeCloseTo(-721500 / 1200000);
    expect(result.bills).toEqual([
      expect.objectContaining({
        billType: BillType.MONTHLY_RENT,
        includedInOperatingRevenue: true
      }),
      expect.objectContaining({
        billType: BillType.DAMAGE_FEE,
        includedInOperatingRevenue: true
      })
    ]);
  });

  it("asset return trial vehicle detail returns depreciation policy and allocated records", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.findFirst.mockResolvedValue(assetReturnVehicleDetail());
    prisma.subscriptionOrder.findMany.mockResolvedValue([assetOrder()]);
    prisma.receivableBill.findMany.mockResolvedValue([
      assetBill({ billType: BillType.MONTHLY_RENT, paidAmount: 500000n })
    ]);
    prisma.depositLedger.findMany.mockResolvedValue([]);
    prisma.vehicleDepreciationPolicy.findMany.mockResolvedValue([assetDepreciationPolicy()]);
    prisma.vehicleDepreciationRecord.findMany.mockResolvedValue([
      assetDepreciationRecord({
        depreciationAmount: 31000n,
        periodEnd: new Date("2026-01-31T00:00:00.000Z"),
        periodStart: new Date("2026-01-01T00:00:00.000Z")
      })
    ]);

    const result = await service.getAssetReturnTrialVehicleDetail("vehicle-1", {
      endDate: "2026-01-31",
      startDate: "2026-01-16"
    });

    expect(result.depreciationPolicy).toMatchObject({
      depreciationMethod: VehicleDepreciationMethod.STRAIGHT_LINE,
      policyNo: "VDP202606001"
    });
    expect(result.depreciationSummary).toMatchObject({
      amount: 16000,
      recordAmount: 16000,
      recordCount: 1,
      source: "RECORDS"
    });
    expect(result.depreciationRecords).toEqual([
      expect.objectContaining({
        allocationMethod: "PERIOD_PRORATED",
        includedProratedAmount: 16000,
        overlapDays: 16,
        totalDays: 31
      })
    ]);
    expect(result.costBreakdown).toMatchObject({
      depreciationCostAmount: 16000,
      depreciationSource: "RECORDS"
    });
  });

  it("asset return trial vehicle detail returns BaaS contract, cost records, and adjusted metrics", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.findFirst.mockResolvedValue(assetReturnVehicleDetail());
    prisma.subscriptionOrder.findMany.mockResolvedValue([assetOrder()]);
    prisma.receivableBill.findMany.mockResolvedValue([
      assetBill({ billType: BillType.MONTHLY_RENT, paidAmount: 500000n }),
      assetBill({
        billNo: "BILL-DAMAGE",
        billType: BillType.DAMAGE_FEE,
        id: "bill-damage",
        paidAmount: 100000n
      })
    ]);
    prisma.depositLedger.findMany.mockResolvedValue([]);
    prisma.vehicleBaasContract.findMany.mockResolvedValue([assetBaasContract()]);
    prisma.vehicleBaasCostRecord.findMany.mockResolvedValue([
      assetBaasCostRecord({
        costAmount: 30000n,
        costStatus: VehicleBaasCostRecordStatus.PAID,
        paidAt: new Date("2026-06-11T00:00:00.000Z")
      })
    ]);

    const result = await service.getAssetReturnTrialVehicleDetail("vehicle-1", {
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result.baasCurrentContract).toMatchObject({
      contractNo: "BAAS202606010001",
      contractStatus: VehicleBaasContractStatus.ACTIVE,
      providerName: "蔚来能源",
      rentalAmount: 30000
    });
    expect(result.baasCostSummary).toMatchObject({
      allocationMethod: "PERIOD_PRORATED",
      costAmount: 30000,
      fullCostRecordAmount: 30000,
      costRecordCount: 1,
      paidCostAmount: 30000
    });
    expect(result.baasCostRecords).toEqual([
      expect.objectContaining({
        allocationMethod: "PERIOD_PRORATED",
        costAmount: 30000,
        costStatus: VehicleBaasCostRecordStatus.PAID,
        fullCostRecordAmount: 30000,
        includedProratedAmount: 30000,
        overlapDays: 30,
        totalDays: 30
      })
    ]);
    expect(result.baasAdjustedReturn).toMatchObject({
      baasAdjustedPlatformNetIncomeAmount: -751500,
      platformNetIncomeAmount: -751500
    });
    expect(result.baasAdjustedReturn.baasAdjustedRoeTrial).toBeCloseTo(-751500 / 1200000);
    expect(result.returns.roeTrial).toBeCloseTo(-751500 / 1200000);
  });

  it("asset return trial vehicle detail returns capital, financing, revenue right, and sharing details", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.findFirst.mockResolvedValue(assetReturnVehicleDetail());
    prisma.subscriptionOrder.findMany.mockResolvedValue([assetOrder()]);
    prisma.receivableBill.findMany.mockResolvedValue([
      assetBill({ billType: BillType.MONTHLY_RENT, paidAmount: 500000n })
    ]);
    prisma.depositLedger.findMany.mockResolvedValue([]);
    prisma.vehicleCapitalEvent.findMany.mockResolvedValue([assetCapitalEvent()]);
    prisma.financingInstrumentVehicle.findMany.mockResolvedValue([assetFinancingAllocation()]);
    prisma.revenueRightAssignment.findMany
      .mockResolvedValueOnce([
        assetRevenueRightAssignment({ assignmentType: RevenueRightAssignmentType.TRANSFER })
      ])
      .mockResolvedValueOnce([]);
    prisma.revenueShareRule.findMany.mockResolvedValue([assetRevenueShareRule()]);

    const result = await service.getAssetReturnTrialVehicleDetail("vehicle-1", {
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result.capitalEvents).toEqual([
      expect.objectContaining({ eventNo: "VCE202601010001", equityCapitalAmount: 600000 })
    ]);
    expect(result.financingAllocations).toEqual([
      expect.objectContaining({ allocatedPrincipalAmount: 600000 })
    ]);
    expect(result.revenueRightAssignments).toEqual([
      expect.objectContaining({ assignmentType: RevenueRightAssignmentType.TRANSFER })
    ]);
    expect(result.revenueShareRules).toEqual([
      expect.objectContaining({ ruleType: RevenueShareRuleType.REVENUE_SHARE })
    ]);
    expect(result.roeBreakdown).toMatchObject({
      assignedOutRevenueAmount: 500000,
      debtInterestCostAmount: 72000,
      debtPrincipalAmount: 600000,
      ownerShareAmount: 150000,
      roeEquityBaseAmount: 600000
    });
  });

  it("keeps asset return trial report and CSV export APIs read-only", async () => {
    const query = {
      endDate: "2026-12-31",
      residualHorizonMonth: 12,
      startDate: "2026-01-01"
    };

    const summaryHarness = createReportHarness();
    mockAssetReturnTrial(summaryHarness.prisma, { forecasts: [assetResidualForecast()] });
    const summary = await summaryHarness.service.getAssetReturnTrialSummary(query);
    expect(() => JSON.stringify(summary)).not.toThrow();
    expectReportWriteGuardsNotCalled(summaryHarness.prisma);

    const vehiclesHarness = createReportHarness();
    mockAssetReturnTrial(vehiclesHarness.prisma, { forecasts: [assetResidualForecast()] });
    const vehicles = await vehiclesHarness.service.getAssetReturnTrialVehicles(query);
    expect(vehicles.items[0]?.forecastResidualAmount).toBe(180000);
    expectReportWriteGuardsNotCalled(vehiclesHarness.prisma);

    const detailHarness = createReportHarness();
    detailHarness.prisma.vehicle.findFirst.mockResolvedValue(assetReturnVehicleDetail());
    mockAssetReturnTrial(detailHarness.prisma, { forecasts: [assetResidualForecast()] });
    const detail = await detailHarness.service.getAssetReturnTrialVehicleDetail("vehicle-1", query);
    expect(detail.residualForecastSummary?.available).toBe(true);
    expectReportWriteGuardsNotCalled(detailHarness.prisma);

    const summaryExportHarness = createReportHarness();
    mockAssetReturnTrial(summaryExportHarness.prisma, { forecasts: [assetResidualForecast()] });
    const summaryExport = await summaryExportHarness.service.exportAssetReturnTrialSummary(query);
    expect(summaryExport.filename).toBe("asset-return-trial-summary-20260101-20261231.csv");
    expectReportWriteGuardsNotCalled(summaryExportHarness.prisma);

    const vehiclesExportHarness = createReportHarness();
    mockAssetReturnTrial(vehiclesExportHarness.prisma, { forecasts: [assetResidualForecast()] });
    const vehiclesExport = await vehiclesExportHarness.service.exportAssetReturnTrialVehicles(query);
    expect(vehiclesExport.filename).toBe("asset-return-trial-vehicles-20260101-20261231.csv");
    expectReportWriteGuardsNotCalled(vehiclesExportHarness.prisma);

    const detailExportHarness = createReportHarness();
    detailExportHarness.prisma.vehicle.findFirst.mockResolvedValue(assetReturnVehicleDetail());
    mockAssetReturnTrial(detailExportHarness.prisma, { forecasts: [assetResidualForecast()] });
    const detailExport = await detailExportHarness.service.exportAssetReturnTrialVehicleDetail("vehicle-1", query);
    expect(detailExport.filename).toBe("asset-return-trial-vehicle-detail-20260101-20261231.csv");
    expectReportWriteGuardsNotCalled(detailExportHarness.prisma);
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

  it("asset return trial summary export returns BOM CSV with yuan amounts, percentages, and ROE reason", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      forecasts: [assetResidualForecast()]
    });

    const result = await service.exportAssetReturnTrialSummary({
      endDate: "2026-12-31",
      residualHorizonMonth: 12,
      startDate: "2026-01-01"
    });

    expect(result.filename).toBe("asset-return-trial-summary-20260101-20261231.csv");
    expect(result.content.charCodeAt(0)).toBe(0xfeff);
    expect(result.content).toContain("资产收益试算汇总");
    expect(result.content).toContain("残值预测周期,未来 12 个月");
    expect(result.content).toContain("核心结果");
    expect(result.content).toContain("数据完整性 / 可计算性");
    expect(result.content).toContain("收入归属");
    expect(result.content).toContain("ROE 可计算车辆数,1");
    expect(result.content).toContain("可用残值预测车辆数,1");
    expect(result.content).toContain("缺少残值预测车辆数,0");
    expect(result.content).toContain("经营收入合计,6500.00");
    expect(result.content).toContain("质押收入金额,0.00");
    expect(result.content).toContain("平台留存经营收入,6500.00");
    expect(result.content).toContain("债务利息成本,0.00");
    expect(result.content).toContain("成本与资本结构");
    expect(result.content).toContain("折旧记录金额,0.00");
    expect(result.content).toContain("旧成本参数折旧金额,10800.00");
    expect(result.content).toContain("折旧记录数,0");
    expect(result.content).toContain("债务本金,0.00");
    expect(result.content).toContain("权益资本基数,12000.00");
    expect(result.content).toContain("经营成本合计,13215.00");
    expect(result.content).toContain("平台权益净收益（元）,-6715.00");
    expect(result.content).toContain("试算 ROE,-55.96%");
    expect(result.content).toContain("年化试算 ROE,-55.96%");
    expect(result.content).toContain("资产价值与残值敏感性");
    expect(result.content).toContain("预测残值合计（元）,1800.00");
    expect(result.content).toContain("相对成本参数预计残值差异（元）,600.00");
    expect(result.content).toContain("残值敏感性 ROE,-50.96%");
    expect(result.content).toContain("BaaS 电池成本");
    expect(result.content).toContain("BaaS 成本车辆数,0");
    expect(result.content).toContain("BaaS 成本分摊方法,PERIOD_PRORATED");
    expect(result.content).toContain("BaaS 成本按服务期间纳入主平台权益净收益 / 主试算 ROE。");
    expect(result.content).toContain("计算链路 / 钩稽关系");
    expect(result.content).toContain("ROE 不可用原因");
    expect(result.content).toContain("ROE 试算提示");
    expect(result.content).toContain("残值预测提示");
    expect(result.content).toContain("未录入资本事件，按全自有资金假设试算 ROE。");
    expect(result.content).not.toMatch(/undefined|null|\[object Object\]|NaN|Invalid Date/);
  });

  it("asset return trial vehicles export returns all filtered rows with localized labels and escaped cells", async () => {
    const { prisma, service } = createReportHarness();
    mockAssetReturnTrial(prisma, {
      forecasts: [assetResidualForecast()]
    });
    prisma.vehicle.findMany.mockResolvedValueOnce([
      assetReturnVehicle({
        brand: 'NIO, "Premium"\nLine',
        vehicleNo: "VH-CSV",
        vin: "VIN-CSV"
      })
    ]);

    const result = await service.exportAssetReturnTrialVehicles({
      endDate: "2026-12-31",
      residualHorizonMonth: 12,
      sortBy: "trialNetOperatingIncomeAmount",
      sortOrder: "desc",
      startDate: "2026-01-01",
      vehicleModel: VehicleModel.ET5,
      vehicleStatus: VehicleStatus.LEASED
    });

    expect(result.filename).toBe("asset-return-trial-vehicles-20260101-20261231.csv");
    expect(result.content.charCodeAt(0)).toBe(0xfeff);
    expect(result.content).toContain("资产收益试算车辆列表");
    expect(result.content).toContain("车辆编号,VIN,车牌号");
    expect(result.content).toContain("平台留存经营收入（元）");
    expect(result.content).toContain("折旧来源");
    expect(result.content).toContain("折旧记录数");
    expect(result.content).toContain("旧成本参数");
    expect(result.content).toContain("债务利息成本（元）");
    expect(result.content).toContain("权益资本基数（元）");
    expect(result.content).toContain("ROE 状态");
    expect(result.content).toContain("残值预测状态");
    expect(result.content).toContain("预测值来源");
    expect(result.content).toContain("预测残值（元）");
    expect(result.content).toContain("相对成本参数残值差异（元）");
    expect(result.content).toContain("残值敏感性 ROE");
    expect(result.content).toContain("BaaS 合同状态");
    expect(result.content).toContain("BaaS 成本合计（元）");
    expect(result.content).toContain('"NIO, ""Premium""\nLine"');
    expect(result.content).toContain("已出租");
    expect(result.content).toContain("6500.00");
    expect(result.content).toContain("-55.96%");
    expect(result.content).toContain("可用");
    expect(result.content).toContain("未来 12 个月");
    expect(result.content).toContain("曲线预测");
    expect(result.content).toContain("1800.00");
    expect(result.content).toContain("600.00");
    expect(result.content).toContain("-50.96%");
    expect(result.content).toContain("可试算");
    expect(result.content).toContain("未录入资本事件，按全自有资金假设试算 ROE。");
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

  it("asset return trial vehicles export rejects more than 5000 rows", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.findMany.mockResolvedValue(
      Array.from({ length: 5001 }, (_value, index) =>
        assetReturnVehicle({ id: `vehicle-${index}`, vehicleNo: `VH-${index}` })
      )
    );
    prisma.subscriptionOrder.findMany.mockResolvedValue([]);
    prisma.receivableBill.findMany.mockResolvedValue([]);
    prisma.depositLedger.findMany.mockResolvedValue([]);

    await expect(
      service.exportAssetReturnTrialVehicles({
        endDate: "2026-12-31",
        startDate: "2026-01-01"
      })
    ).rejects.toThrow("明细数据超过 5000 行，请缩小筛选范围后再导出。");
  });

  it("asset return trial vehicle detail export contains profile, preview, income, costs, orders, and bills", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.findFirst.mockResolvedValue(assetReturnVehicleDetail());
    prisma.vehicleResidualForecast.findMany.mockResolvedValue([assetResidualForecast()]);
    prisma.subscriptionOrder.findMany.mockResolvedValue([assetOrder()]);
    prisma.receivableBill.findMany.mockResolvedValue([
      assetBill({ billType: BillType.MONTHLY_RENT, paidAmount: 500000n }),
      assetBill({
        billNo: "BILL-DAMAGE",
        billType: BillType.DAMAGE_FEE,
        id: "bill-damage",
        paidAmount: 100000n
      })
    ]);
    prisma.depositLedger.findMany.mockResolvedValue([
      { amount: 500000n, order: { vehicleId: "vehicle-1" } }
    ]);

    const result = await service.exportAssetReturnTrialVehicleDetail("vehicle-1", {
      endDate: "2026-12-31",
      residualHorizonMonth: 12,
      startDate: "2026-01-01"
    });

    expect(result.filename).toBe("asset-return-trial-vehicle-detail-20260101-20261231.csv");
    expect(result.content.charCodeAt(0)).toBe(0xfeff);
    expect(result.content).toContain("单车收益试算详情");
    expect(result.content).toContain("车辆基础信息");
    expect(result.content).toContain("成本参数");
    expect(result.content).toContain("折旧方法,直线法");
    expect(result.content).toContain("成本 Preview");
    expect(result.content).toContain("月折旧（元）,900.00");
    expect(result.content).toContain("折旧策略摘要");
    expect(result.content).toContain("折旧来源,旧成本参数");
    expect(result.content).toContain("折旧记录分摊明细");
    expect(result.content).toContain("平台留存收入");
    expect(result.content).toContain("经营收入合计,6000.00");
    expect(result.content).toContain("质押收入金额,0.00");
    expect(result.content).toContain("平台留存经营收入,6000.00");
    expect(result.content).toContain("成本拆分");
    expect(result.content).toContain("经营成本合计,13215.00");
    expect(result.content).toContain("资本结构摘要");
    expect(result.content).toContain("债务本金（元）,0.00");
    expect(result.content).toContain("融资工具分摊明细");
    expect(result.content).toContain("收益权 assignment 明细");
    expect(result.content).toContain("PLEDGE = 质押，不扣减平台收入");
    expect(result.content).toContain("分润规则摘要");
    expect(result.content).toContain("收益试算");
    expect(result.content).toContain("平台权益净收益（元）,-7215.00");
    expect(result.content).toContain("试算 ROE,-60.12%");
    expect(result.content).toContain("ROE 状态,可试算");
    expect(result.content).toContain("BaaS 电池成本");
    expect(result.content).toContain("BaaS 成本汇总");
    expect(result.content).toContain("BaaS 成本记录");
    expect(result.content).toContain("纳入本分析周期金额");
    expect(result.content).toContain("残值预测敏感性");
    expect(result.content).toContain("残值预测状态,可用");
    expect(result.content).toContain("预测值来源,曲线预测");
    expect(result.content).toContain("预测残值（元）,1800.00");
    expect(result.content).toContain("残值差异");
    expect(result.content).toContain("相对成本参数残值差异,600.00");
    expect(result.content).toContain("残值敏感性收益");
    expect(result.content).toContain("残值敏感性 ROE,-55.13%");
    expect(result.content).toContain("残值敏感性说明");
    expect(result.content).toContain("订单周期明细");
    expect(result.content).toContain("账单明细");
    expect(result.content).toContain("在租");
    expect(result.content).toContain("月租账单");
    expect(result.content).not.toMatch(/undefined|null|\[object Object\]|NaN|Invalid Date/);
  });

  it("asset return trial vehicle detail export includes financing, revenue right, and sharing sections", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.findFirst.mockResolvedValue(assetReturnVehicleDetail());
    prisma.subscriptionOrder.findMany.mockResolvedValue([assetOrder()]);
    prisma.receivableBill.findMany.mockResolvedValue([
      assetBill({ billType: BillType.MONTHLY_RENT, paidAmount: 500000n }),
      assetBill({
        billNo: "BILL-DAMAGE",
        billType: BillType.DAMAGE_FEE,
        id: "bill-damage",
        paidAmount: 100000n
      })
    ]);
    prisma.depositLedger.findMany.mockResolvedValue([]);
    prisma.vehicleCapitalEvent.findMany.mockResolvedValue([assetCapitalEvent()]);
    prisma.financingInstrumentVehicle.findMany.mockResolvedValue([assetFinancingAllocation()]);
    prisma.revenueRightAssignment.findMany
      .mockResolvedValueOnce([
        assetRevenueRightAssignment({
          assignmentType: RevenueRightAssignmentType.TRANSFER,
          shareRatioBps: 5000
        })
      ])
      .mockResolvedValueOnce([]);
    prisma.revenueShareRule.findMany.mockResolvedValue([assetRevenueShareRule()]);

    const result = await service.exportAssetReturnTrialVehicleDetail("vehicle-1", {
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(result.content).toContain("资本结构摘要");
    expect(result.content).toContain("债务本金（元）,6000.00");
    expect(result.content).toContain("资金成本来源,融资工具");
    expect(result.content).toContain("融资工具分摊明细");
    expect(result.content).toContain("FI202601010001,银行项目贷款,测试银行,6000.00,12.00%,720.00");
    expect(result.content).toContain("收益权 assignment 明细");
    expect(result.content).toContain("收益权转让");
    expect(result.content).toContain("资方：测试资方");
    expect(result.content).toContain("PLEDGE = 质押，不扣减平台收入");
    expect(result.content).toContain("分润规则摘要");
    expect(result.content).toContain("收益分成,租金实收,30.00%");
    expect(result.content).toContain("支持试算");
    expect(result.content).not.toMatch(/undefined|null|\[object Object\]|NaN|Invalid Date/);
  });

  it("asset return trial vehicle detail export includes missing and MANUAL depreciation reasons", async () => {
    const { prisma, service } = createReportHarness();
    prisma.vehicle.findFirst.mockResolvedValue(
      assetReturnVehicleDetail({
        assetCostProfiles: [
          assetCostProfile({
            depreciationMethod: VehicleDepreciationMethod.MANUAL
          })
        ]
      })
    );
    prisma.subscriptionOrder.findMany.mockResolvedValue([assetOrder()]);
    prisma.receivableBill.findMany.mockResolvedValue([
      assetBill({ billType: BillType.MONTHLY_RENT, paidAmount: 500000n })
    ]);
    prisma.depositLedger.findMany.mockResolvedValue([]);

    const manualResult = await service.exportAssetReturnTrialVehicleDetail("vehicle-1", {
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(manualResult.content).toContain("折旧方法,手工口径");
    expect(manualResult.content).toContain("MANUAL 折旧方法暂未配置手工折旧明细");
    expect(manualResult.content).toContain("试算 ROA,-");

    prisma.vehicle.findFirst.mockResolvedValueOnce(assetReturnVehicleDetail({ assetCostProfiles: [] }));
    const missingResult = await service.exportAssetReturnTrialVehicleDetail("vehicle-1", {
      endDate: "2026-12-31",
      startDate: "2026-01-01"
    });

    expect(missingResult.content).toContain("成本参数,未配置");
    expect(missingResult.content).toContain("该车辆尚未配置资产成本参数，无法试算 ROA。");
    expect(missingResult.content).not.toMatch(/undefined|null|\[object Object\]|NaN|Invalid Date/);
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
      exportAssetReturnTrialSummary: vi
        .fn()
        .mockResolvedValue(csvFile("asset-return-trial-summary-20260601-20260630.csv")),
      exportAssetReturnTrialVehicles: vi
        .fn()
        .mockResolvedValue(csvFile("asset-return-trial-vehicles-20260601-20260630.csv")),
      exportAssetReturnTrialVehicleDetail: vi
        .fn()
        .mockResolvedValue(csvFile("asset-return-trial-vehicle-detail-20260601-20260630.csv")),
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
    const assetReturnTrialSummaryResponse = mockResponse();
    await expectCsvResponse(
      "asset-return-trial-summary-20260601-20260630.csv",
      assetReturnTrialSummaryResponse,
      controller.exportAssetReturnTrialSummary({}, assetReturnTrialSummaryResponse as never)
    );
    const assetReturnTrialVehiclesResponse = mockResponse();
    await expectCsvResponse(
      "asset-return-trial-vehicles-20260601-20260630.csv",
      assetReturnTrialVehiclesResponse,
      controller.exportAssetReturnTrialVehicles({}, assetReturnTrialVehiclesResponse as never)
    );
    const assetReturnTrialVehicleDetailResponse = mockResponse();
    await expectCsvResponse(
      "asset-return-trial-vehicle-detail-20260601-20260630.csv",
      assetReturnTrialVehicleDetailResponse,
      controller.exportAssetReturnTrialVehicleDetail(
        "vehicle-1",
        {},
        assetReturnTrialVehicleDetailResponse as never
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
    auditLog: {
      create: reportWriteGuard("auditLog.create"),
      createMany: reportWriteGuard("auditLog.createMany")
    },
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
    financingInstrumentVehicle: {
      findMany: vi.fn().mockResolvedValue([])
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
    revenueRightAssignment: {
      findMany: vi.fn().mockResolvedValue([])
    },
    revenueShareRule: {
      findMany: vi.fn().mockResolvedValue([])
    },
    subscriptionOrder: {
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn()
    },
    vehicleCapitalEvent: {
      findMany: vi.fn().mockResolvedValue([])
    },
    vehicle: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
      update: reportWriteGuard("vehicle.update"),
      updateMany: reportWriteGuard("vehicle.updateMany")
    },
    vehicleBaasContract: {
      findMany: vi.fn().mockResolvedValue([])
    },
    vehicleBaasCostRecord: {
      findMany: vi.fn().mockResolvedValue([])
    },
    vehicleDepreciationPolicy: {
      findMany: vi.fn().mockResolvedValue([])
    },
    vehicleDepreciationRecord: {
      findMany: vi.fn().mockResolvedValue([])
    },
    vehicleDepreciationSchedule: {
      findMany: vi.fn().mockResolvedValue([])
    },
    vehicleMarketPriceObservation: {
      create: reportWriteGuard("vehicleMarketPriceObservation.create"),
      update: reportWriteGuard("vehicleMarketPriceObservation.update")
    },
    vehicleResidualCurve: {
      create: reportWriteGuard("vehicleResidualCurve.create"),
      update: reportWriteGuard("vehicleResidualCurve.update"),
      updateMany: reportWriteGuard("vehicleResidualCurve.updateMany")
    },
    vehicleResidualForecast: {
      create: reportWriteGuard("vehicleResidualForecast.create"),
      findMany: vi.fn().mockResolvedValue([]),
      update: reportWriteGuard("vehicleResidualForecast.update")
    },
    vehicleResidualForecastPoint: {
      update: reportWriteGuard("vehicleResidualForecastPoint.update")
    },
    vehicleSalePriceHistory: {
      create: reportWriteGuard("vehicleSalePriceHistory.create")
    },
    vehicleValuationReview: {
      create: reportWriteGuard("vehicleValuationReview.create"),
      update: reportWriteGuard("vehicleValuationReview.update")
    },
    residualModelRun: {
      create: reportWriteGuard("residualModelRun.create"),
      update: reportWriteGuard("residualModelRun.update")
    },
    residualModelRunOutput: {
      create: reportWriteGuard("residualModelRunOutput.create"),
      createMany: reportWriteGuard("residualModelRunOutput.createMany")
    }
  };

  return {
    prisma,
    service: new ReportService(prisma as never)
  };
}

type ReportPrismaMock = ReturnType<typeof createReportHarness>["prisma"];

function reportWriteGuard(methodName: string) {
  return vi.fn(() => {
    throw new Error(`Report APIs must stay read-only: ${methodName}`);
  });
}

function expectReportWriteGuardsNotCalled(prisma: ReportPrismaMock) {
  const writeMethods = new Set(["create", "createMany", "update", "updateMany", "delete", "deleteMany", "upsert"]);
  for (const delegate of Object.values(prisma as Record<string, Record<string, unknown>>)) {
    for (const [methodName, method] of Object.entries(delegate)) {
      if (writeMethods.has(methodName) && typeof method === "function" && vi.isMockFunction(method)) {
        expect(method).not.toHaveBeenCalled();
      }
    }
  }
}

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

function mockAssetReturnTrial(
  prisma: ReportPrismaMock,
  overrides: {
    bills?: Array<Record<string, unknown>>;
    baasContracts?: Array<Record<string, unknown>>;
    baasCostRecords?: Array<Record<string, unknown>>;
    capitalEvents?: Array<Record<string, unknown>>;
    depreciationPolicies?: Array<Record<string, unknown>>;
    depreciationRecords?: Array<Record<string, unknown>>;
    depreciationSchedules?: Array<Record<string, unknown>>;
    financingAllocations?: Array<Record<string, unknown>>;
    forecasts?: Array<Record<string, unknown>>;
    orders?: Array<Record<string, unknown>>;
    profiles?: Array<Record<string, unknown>>;
    revenueRightAssignments?: Array<Record<string, unknown>>;
    revenueShareRules?: Array<Record<string, unknown>>;
    vehicles?: Array<Record<string, unknown>>;
  } = {}
) {
  const vehicles = overrides.vehicles ?? [
    assetReturnVehicle({
      assetCostProfiles: overrides.profiles ?? [assetCostProfile()]
    })
  ];
  prisma.vehicle.findMany.mockResolvedValue(vehicles);
  prisma.subscriptionOrder.findMany.mockResolvedValue(overrides.orders ?? [assetOrder()]);
  prisma.receivableBill.findMany.mockResolvedValue(
    overrides.bills ?? [
      assetBill({ billType: BillType.MONTHLY_RENT, paidAmount: 500000n }),
      assetBill({
        billNo: "BILL-DAMAGE",
        billType: BillType.DAMAGE_FEE,
        id: "bill-damage",
        paidAmount: 100000n
      }),
      assetBill({
        billNo: "BILL-OTHER",
        billType: BillType.OTHER,
        id: "bill-other",
        paidAmount: 50000n
      }),
      assetBill({
        billNo: "BILL-DEPOSIT",
        billType: BillType.DEPOSIT,
        id: "bill-deposit",
        paidAmount: 800000n
      })
    ]
  );
  prisma.depositLedger.findMany.mockResolvedValue([
    { amount: 500000n, order: { vehicleId: "vehicle-1" } }
  ]);
  prisma.vehicleCapitalEvent.findMany.mockResolvedValue(overrides.capitalEvents ?? []);
  prisma.financingInstrumentVehicle.findMany.mockResolvedValue(
    overrides.financingAllocations ?? []
  );
  prisma.revenueRightAssignment.findMany
    .mockResolvedValueOnce(overrides.revenueRightAssignments ?? [])
    .mockResolvedValueOnce([]);
  prisma.revenueShareRule.findMany.mockResolvedValue(overrides.revenueShareRules ?? []);
  prisma.vehicleResidualForecast.findMany.mockResolvedValue(overrides.forecasts ?? []);
  prisma.vehicleBaasContract.findMany.mockResolvedValue(overrides.baasContracts ?? []);
  prisma.vehicleBaasCostRecord.findMany.mockResolvedValue(overrides.baasCostRecords ?? []);
  prisma.vehicleDepreciationPolicy.findMany.mockResolvedValue(overrides.depreciationPolicies ?? []);
  prisma.vehicleDepreciationRecord.findMany.mockResolvedValue(overrides.depreciationRecords ?? []);
  prisma.vehicleDepreciationSchedule.findMany.mockResolvedValue(
    overrides.depreciationSchedules ?? []
  );
}

function assetVehicle(overrides: Record<string, unknown> = {}) {
  return {
    acquisitionMode: VehicleAcquisitionMode.OWNED_CASH,
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

function assetReturnVehicle(overrides: Record<string, unknown> = {}) {
  return {
    ...assetVehicle({
      currentSalePriceAmount: 1000000n,
      purchasePriceAmount: 1200000n
    }),
    assetCostProfiles: [assetCostProfile()],
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

function assetReturnVehicleDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...assetVehicleDetail({
      currentSalePriceAmount: 1000000n,
      purchasePriceAmount: 1200000n
    }),
    assetCostProfiles: [assetCostProfile()],
    ...overrides
  };
}

function assetCostProfile(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-01-01T00:00:00.000Z");

  return {
    annualInsuranceCostAmount: 36500n,
    annualMaintenanceReserveAmount: 73000n,
    capitalCostRateBps: 1000,
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    depreciationMethod: VehicleDepreciationMethod.STRAIGHT_LINE,
    depreciationStartDate: new Date("2026-01-01T00:00:00.000Z"),
    id: "asset-cost-profile-1",
    otherMonthlyCostAmount: 1000n,
    profileStatus: VehicleAssetCostProfileStatus.ACTIVE,
    remark: "trial profile",
    residualValueAmount: 120000n,
    snapshot: null,
    updatedAt: now,
    updatedBy: "user-1",
    usefulLifeMonths: 12,
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function assetResidualForecast(overrides: Record<string, unknown> = {}) {
  return {
    asOfDate: new Date("2026-06-01T00:00:00.000Z"),
    createdAt: new Date("2026-06-02T00:00:00.000Z"),
    curve: assetResidualCurve(),
    curveId: "curve-1",
    forecastMethod: VehicleResidualForecastMethod.CURVE_STATISTICAL,
    forecastNo: "VRF202606020001",
    forecastStatus: VehicleResidualForecastStatus.GENERATED,
    id: "forecast-1",
    points: [assetResidualForecastPoint()],
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function assetResidualForecastPoint(overrides: Record<string, unknown> = {}) {
  return {
    adoptedResidualAmount: null,
    confidenceScore: 82,
    horizonMonth: 12,
    id: "forecast-point-12",
    interpolationMethod: "EXACT",
    lowerBoundAmount: 130000n,
    matchedCurvePointAgeMonth: 36,
    pointStatus: VehicleResidualForecastPointStatus.GENERATED,
    predictedResidualAmount: 180000n,
    predictedResidualRateBps: 1500,
    targetAgeMonth: 36,
    targetDate: new Date("2027-06-01T00:00:00.000Z"),
    upperBoundAmount: 220000n,
    ...overrides
  };
}

function assetResidualCurve(overrides: Record<string, unknown> = {}) {
  return {
    batteryCapacityKwh: decimalLike(75),
    batteryUsageType: "BUYOUT",
    brand: "NIO",
    confidenceScore: 78,
    curveMethod: VehicleResidualCurveMethod.STATISTICAL_MEDIAN,
    curveNo: "VRC202606020001",
    curveStatus: VehicleResidualCurveStatus.ACTIVE,
    id: "curve-1",
    model: "ET5 75kWh",
    modelYear: 2024,
    series: "ET",
    trim: null,
    ...overrides
  };
}

function assetBaasContract(overrides: Record<string, unknown> = {}) {
  return {
    batteryPackageName: "75kWh BaaS",
    batterySerialNo: "BATTERY-001",
    billingCycle: VehicleBaasBillingCycle.MONTHLY,
    contractNo: "BAAS202606010001",
    contractStatus: VehicleBaasContractStatus.ACTIVE,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    id: "baas-contract-1",
    paymentDayOfMonth: 10,
    providerContractNo: "PROVIDER-BAAS-001",
    providerName: "蔚来能源",
    rentalAmount: 30000n,
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function assetBaasCostRecord(overrides: Record<string, unknown> = {}) {
  return {
    confirmedAt: null,
    contractId: "baas-contract-1",
    costAmount: 30000n,
    costPeriod: "2026-06",
    costRecordNo: "BCR202606001",
    costSource: VehicleBaasCostSource.GENERATED,
    costStatus: VehicleBaasCostRecordStatus.SCHEDULED,
    currency: "CNY",
    dueDate: new Date("2026-06-10T00:00:00.000Z"),
    id: "baas-cost-record-1",
    invoiceNo: null,
    paidAt: null,
    paymentRefNo: null,
    periodEnd: new Date("2026-06-30T00:00:00.000Z"),
    periodStart: new Date("2026-06-01T00:00:00.000Z"),
    vehicleId: "vehicle-1",
    voidedAt: null,
    ...overrides
  };
}

function assetDepreciationPolicy(overrides: Record<string, unknown> = {}) {
  return {
    basisSource: "PURCHASE_COST",
    currency: "CNY",
    depreciationBasisAmount: 1200000n,
    depreciationEndDate: new Date("2026-12-31T00:00:00.000Z"),
    depreciationMethod: VehicleDepreciationMethod.STRAIGHT_LINE,
    depreciationStartDate: new Date("2026-01-01T00:00:00.000Z"),
    id: "depreciation-policy-1",
    monthlyDepreciationAmount: 100000n,
    policyNo: "VDP202606001",
    policyStatus: VehicleDepreciationPolicyStatus.ACTIVE,
    residualValueAmount: 0n,
    usefulLifeMonths: 12,
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function assetDepreciationRecord(overrides: Record<string, unknown> = {}) {
  return {
    confirmedAt: new Date("2026-06-30T00:00:00.000Z"),
    costPeriod: "2026-06",
    currency: "CNY",
    depreciationAmount: 100000n,
    id: "depreciation-record-1",
    lockedAt: null,
    periodEnd: new Date("2026-06-30T00:00:00.000Z"),
    periodStart: new Date("2026-06-01T00:00:00.000Z"),
    policyId: "depreciation-policy-1",
    recordNo: "VDR202606001",
    recordSource: VehicleDepreciationRecordSource.SCHEDULED,
    recordStatus: VehicleDepreciationRecordStatus.CONFIRMED,
    scheduleId: "depreciation-schedule-1",
    vehicleId: "vehicle-1",
    voidedAt: null,
    ...overrides
  };
}

function assetDepreciationSchedule(overrides: Record<string, unknown> = {}) {
  return {
    costPeriod: "2026-06",
    id: "depreciation-schedule-1",
    periodEnd: new Date("2026-06-30T00:00:00.000Z"),
    periodStart: new Date("2026-06-01T00:00:00.000Z"),
    policyId: "depreciation-policy-1",
    scheduleNo: "VDS202606001",
    scheduleStatus: VehicleDepreciationScheduleStatus.SCHEDULED,
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function assetCapitalEvent(overrides: Record<string, unknown> = {}) {
  return {
    debtPrincipalAmount: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    equityCapitalAmount: 600000n,
    eventNo: "VCE202601010001",
    eventStatus: VehicleCapitalEventStatus.ACTIVE,
    eventType: "INITIAL_EQUITY_PURCHASE",
    financingInstrumentId: null,
    id: "capital-event-1",
    remark: null,
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function assetFinancingAllocation(overrides: Record<string, unknown> = {}) {
  return {
    allocatedPrincipalAmount: 600000n,
    allocationNo: "FIA202601010001",
    allocationRatioBps: 5000,
    allocationStatus: FinancingAllocationStatus.ACTIVE,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    id: "allocation-1",
    instrument: {
      annualRateBps: 1200,
      id: "financing-instrument-1",
      instrumentNo: "FI202601010001",
      instrumentStatus: FinancingInstrumentStatus.ACTIVE,
      instrumentType: "BANK_PROJECT_LOAN",
      lenderName: "测试银行",
      principalAmount: 600000n,
      repaymentMethod: FinancingRepaymentMethod.INTEREST_ONLY
    },
    instrumentId: "financing-instrument-1",
    remark: null,
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function assetRevenueRightAssignment(overrides: Record<string, unknown> = {}) {
  return {
    assigneeName: "测试资方",
    assigneeType: RevenueRightAssigneeType.FINANCIER,
    assignmentNo: "RRA202601010001",
    assignmentStatus: RevenueRightAssignmentStatus.ACTIVE,
    assignmentType: RevenueRightAssignmentType.PLEDGE,
    bill: null,
    billId: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    financingInstrument: {
      id: "financing-instrument-1",
      instrumentNo: "FI202601010001",
      instrumentType: "BANK_PROJECT_LOAN",
      lenderName: "测试银行"
    },
    financingInstrumentId: "financing-instrument-1",
    id: "revenue-right-assignment-1",
    order: { id: "order-1", orderNo: "SO-001", vehicleId: "vehicle-1" },
    orderId: "order-1",
    priority: 1,
    releasedAt: null,
    releaseReason: null,
    remark: null,
    shareRatioBps: 10000,
    targetType: RevenueRightTargetType.ORDER,
    vehicleId: null,
    ...overrides
  };
}

function assetRevenueShareRule(overrides: Record<string, unknown> = {}) {
  return {
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    fixedMonthlyAmount: null,
    id: "revenue-share-rule-1",
    minimumGuaranteeAmount: null,
    ownerName: "外部车主",
    ownerShareBps: 3000,
    platformShareBps: 7000,
    remark: null,
    ruleNo: "RSR202601010001",
    ruleStatus: RevenueShareRuleStatus.ACTIVE,
    ruleType: RevenueShareRuleType.REVENUE_SHARE,
    settlementCycle: "MONTHLY",
    shareBasis: RevenueShareBasis.RENTAL_PAID,
    vehicleId: "vehicle-1",
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
