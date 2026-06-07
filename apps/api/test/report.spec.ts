import {
  BillStatus,
  BillType,
  CollectionCaseStatus,
  CollectionLevel,
  DepositTransactionType,
  OrderSource,
  OrderStatus,
  VehicleModel,
  VehicleStatus
} from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    expect(findBy(result.bySource, "orderSource", OrderSource.CUSTOMER_SELF_SERVICE)).toMatchObject({
      count: 1
    });
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
    prisma.receivableBill.groupBy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

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
    expect(findBy(result.byTransactionType, "transactionType", DepositTransactionType.FREEZE)).toMatchObject({
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

    prisma.receivableBill.aggregate.mockResolvedValue(sumResult({ amount: 0n, paidAmount: 0n, remainingAmount: 0n }));
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
});

function createReportHarness() {
  const prisma = {
    collectionAction: {
      aggregate: vi.fn(),
      count: vi.fn()
    },
    collectionCase: {
      count: vi.fn(),
      groupBy: vi.fn()
    },
    depositLedger: {
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
      groupBy: vi.fn()
    }
  };

  return {
    prisma,
    service: new ReportService(prisma as never)
  };
}

type ReportPrismaMock = ReturnType<typeof createReportHarness>["prisma"];

function mockOrderReport(prisma: ReportPrismaMock) {
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
        subscriptionPlan: { id: "plan-1", planName: "Standard", planNo: "PLAN-001" },
        subscriptionPlanId: "plan-1"
      }
    },
    {
      quote: {
        subscriptionPlan: { id: "plan-1", planName: "Standard", planNo: "PLAN-001" },
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
