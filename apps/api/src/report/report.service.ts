import { BadRequestException, Injectable } from "@nestjs/common";
import {
  BillStatus,
  BillType,
  CollectionCaseStatus,
  CollectionLevel,
  DepositTransactionStatus,
  DepositTransactionType,
  OrderSource,
  OrderStatus,
  Prisma,
  VehicleModel,
  VehicleStatus
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { OrderReportQueryDto, ReportDateRangeQueryDto } from "./dto/report.dto";

const BUSINESS_UTC_OFFSET_MINUTES = 8 * 60;
const DEFAULT_REPORT_RANGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_OFFSET_MS = BUSINESS_UTC_OFFSET_MINUTES * 60 * 1000;

@Injectable()
export class ReportService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboardSummary(query: ReportDateRangeQueryDto) {
    const range = resolveReportDateRange(query);
    const orderWhere: Prisma.SubscriptionOrderWhereInput = {
      createdAt: range.dateTimeFilter,
      deletedAt: null
    };
    const billWhere: Prisma.ReceivableBillWhereInput = {
      deletedAt: null,
      dueDate: range.dateTimeFilter
    };
    const overdueBillWhere: Prisma.ReceivableBillWhereInput = {
      ...billWhere,
      billStatus: BillStatus.OVERDUE,
      remainingAmount: { gt: 0n }
    };
    const depositWhere: Prisma.DepositLedgerWhereInput = {
      deletedAt: null,
      occurredAt: range.dateTimeFilter,
      transactionStatus: DepositTransactionStatus.CONFIRMED
    };

    const [
      totalOrders,
      orderStatusGroups,
      totalVehicles,
      vehicleStatusGroups,
      billTotals,
      overdueTotals,
      overdueOrderGroups,
      collectionCaseCount,
      depositTypeGroups
    ] = await Promise.all([
      this.prisma.subscriptionOrder.count({ where: orderWhere }),
      this.prisma.subscriptionOrder.groupBy({
        by: ["orderStatus"],
        where: orderWhere,
        _count: { _all: true }
      }),
      this.prisma.vehicle.count({ where: { deletedAt: null } }),
      this.prisma.vehicle.groupBy({
        by: ["status"],
        where: { deletedAt: null },
        _count: { _all: true }
      }),
      this.prisma.receivableBill.aggregate({
        where: billWhere,
        _sum: { amount: true, paidAmount: true, remainingAmount: true }
      }),
      this.prisma.receivableBill.aggregate({
        where: overdueBillWhere,
        _sum: { remainingAmount: true }
      }),
      this.prisma.receivableBill.groupBy({
        by: ["orderId"],
        where: overdueBillWhere,
        _count: { _all: true }
      }),
      this.prisma.collectionCase.count({
        where: { createdAt: range.dateTimeFilter, deletedAt: null }
      }),
      this.prisma.depositLedger.groupBy({
        by: ["transactionType"],
        where: depositWhere,
        _count: { _all: true },
        _sum: { amount: true }
      })
    ]);

    const orderStatusCount = countMap(orderStatusGroups, "orderStatus");
    const vehicleStatusCount = countMap(vehicleStatusGroups, "status");
    const depositSummary = summarizeDepositGroups(depositTypeGroups);

    return {
      dateRange: range.output,
      totalOrders,
      newOrders: totalOrders,
      activeOrders: orderStatusCount.get(OrderStatus.ACTIVE) ?? 0,
      completedOrders: orderStatusCount.get(OrderStatus.COMPLETED) ?? 0,
      cancelledOrders: orderStatusCount.get(OrderStatus.CANCELLED) ?? 0,
      totalVehicles,
      availableVehicles: vehicleStatusCount.get(VehicleStatus.AVAILABLE) ?? 0,
      reviewReservedVehicles: vehicleStatusCount.get(VehicleStatus.REVIEW_RESERVED) ?? 0,
      signingLockedVehicles: vehicleStatusCount.get(VehicleStatus.RESERVED) ?? 0,
      leasedVehicles: leasedVehicleCount(vehicleStatusCount),
      maintenanceVehicles: vehicleStatusCount.get(VehicleStatus.MAINTENANCE) ?? 0,
      returnedVehicles: vehicleStatusCount.get(VehicleStatus.RETURNED) ?? 0,
      totalReceivableAmount: toNumber(billTotals._sum.amount),
      totalPaidAmount: toNumber(billTotals._sum.paidAmount),
      totalUnpaidAmount: toNumber(billTotals._sum.remainingAmount),
      depositBalanceAmount: depositSummary.currentBalanceAmount,
      overdueAmount: toNumber(overdueTotals._sum.remainingAmount),
      overdueOrderCount: overdueOrderGroups.length,
      collectionCaseCount
    };
  }

  async getOrderReport(query: OrderReportQueryDto) {
    const range = resolveReportDateRange(query);
    const where: Prisma.SubscriptionOrderWhereInput = {
      createdAt: range.dateTimeFilter,
      deletedAt: null,
      ...(query.orderSource ? { orderSource: query.orderSource } : {}),
      ...(query.orderStatus ? { orderStatus: query.orderStatus } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.vehicleModel ? { vehicleModel: query.vehicleModel } : {})
    };

    const [totalOrders, statusGroups, sourceGroups, vehicleModelGroups, ordersWithPlans] =
      await Promise.all([
        this.prisma.subscriptionOrder.count({ where }),
        this.prisma.subscriptionOrder.groupBy({
          by: ["orderStatus"],
          where,
          _count: { _all: true }
        }),
        this.prisma.subscriptionOrder.groupBy({
          by: ["orderSource"],
          where,
          _count: { _all: true }
        }),
        this.prisma.subscriptionOrder.groupBy({
          by: ["vehicleModel"],
          where,
          _count: { _all: true }
        }),
        this.prisma.subscriptionOrder.findMany({
          where,
          select: {
            quote: {
              select: {
                subscriptionPlan: { select: { id: true, planName: true, planNo: true } },
                subscriptionPlanId: true
              }
            }
          }
        })
      ]);

    return {
      dateRange: range.output,
      totalOrders,
      byStatus: enumCountRows(OrderStatus, statusGroups, "orderStatus", "orderStatus"),
      bySource: enumCountRows(OrderSource, sourceGroups, "orderSource", "orderSource"),
      byVehicleModel: enumCountRows(VehicleModel, vehicleModelGroups, "vehicleModel", "vehicleModel").filter(
        (row) => row.count > 0
      ),
      bySubscriptionPlan: subscriptionPlanRows(ordersWithPlans)
    };
  }

  async getFinanceReport(query: ReportDateRangeQueryDto) {
    const range = resolveReportDateRange(query);
    const where: Prisma.ReceivableBillWhereInput = {
      deletedAt: null,
      dueDate: range.dateTimeFilter
    };

    const [totals, typeGroups, statusGroups] = await Promise.all([
      this.prisma.receivableBill.aggregate({
        where,
        _sum: { amount: true, paidAmount: true, remainingAmount: true }
      }),
      this.prisma.receivableBill.groupBy({
        by: ["billType"],
        where,
        _count: { _all: true },
        _sum: { amount: true, paidAmount: true, remainingAmount: true }
      }),
      this.prisma.receivableBill.groupBy({
        by: ["billStatus"],
        where,
        _count: { _all: true },
        _sum: { amount: true, paidAmount: true, remainingAmount: true }
      })
    ]);

    return {
      dateRange: range.output,
      totalReceivableAmount: toNumber(totals._sum.amount),
      totalPaidAmount: toNumber(totals._sum.paidAmount),
      totalUnpaidAmount: toNumber(totals._sum.remainingAmount),
      byBillType: amountGroupRows(BillType, typeGroups, "billType", "billType"),
      byBillStatus: amountGroupRows(BillStatus, statusGroups, "billStatus", "billStatus")
    };
  }

  async getDepositPoolReport(query: ReportDateRangeQueryDto) {
    const range = resolveReportDateRange(query);
    const groups = await this.prisma.depositLedger.groupBy({
      by: ["transactionType"],
      where: {
        deletedAt: null,
        occurredAt: range.dateTimeFilter,
        transactionStatus: DepositTransactionStatus.CONFIRMED
      },
      _count: { _all: true },
      _sum: { amount: true }
    });
    const summary = summarizeDepositGroups(groups);

    return {
      dateRange: range.output,
      ...summary,
      byTransactionType: amountOnlyGroupRows(
        DepositTransactionType,
        groups,
        "transactionType",
        "transactionType"
      )
    };
  }

  async getCollectionReport(query: ReportDateRangeQueryDto) {
    const range = resolveReportDateRange(query);
    const overdueBillWhere: Prisma.ReceivableBillWhereInput = {
      billStatus: BillStatus.OVERDUE,
      deletedAt: null,
      dueDate: range.dateTimeFilter,
      remainingAmount: { gt: 0n }
    };
    const caseWhere: Prisma.CollectionCaseWhereInput = {
      createdAt: range.dateTimeFilter,
      deletedAt: null
    };
    const actionWhere: Prisma.CollectionActionWhereInput = {
      createdAt: range.dateTimeFilter,
      deletedAt: null
    };

    const [
      overdueBillCount,
      overdueTotals,
      overdueOrderGroups,
      collectionCaseCount,
      activeCaseCount,
      closedCaseCount,
      levelGroups,
      statusGroups,
      actionCount,
      promisedTotals
    ] = await Promise.all([
      this.prisma.receivableBill.count({ where: overdueBillWhere }),
      this.prisma.receivableBill.aggregate({
        where: overdueBillWhere,
        _sum: { remainingAmount: true }
      }),
      this.prisma.receivableBill.groupBy({
        by: ["orderId"],
        where: overdueBillWhere,
        _count: { _all: true }
      }),
      this.prisma.collectionCase.count({ where: caseWhere }),
      this.prisma.collectionCase.count({
        where: { ...caseWhere, caseStatus: CollectionCaseStatus.ACTIVE }
      }),
      this.prisma.collectionCase.count({
        where: { ...caseWhere, caseStatus: CollectionCaseStatus.CLOSED }
      }),
      this.prisma.collectionCase.groupBy({
        by: ["collectionLevel"],
        where: caseWhere,
        _count: { _all: true },
        _sum: { totalOverdueAmount: true }
      }),
      this.prisma.collectionCase.groupBy({
        by: ["caseStatus"],
        where: caseWhere,
        _count: { _all: true },
        _sum: { totalOverdueAmount: true }
      }),
      this.prisma.collectionAction.count({ where: actionWhere }),
      this.prisma.collectionAction.aggregate({
        where: actionWhere,
        _sum: { promisedAmount: true }
      })
    ]);

    return {
      dateRange: range.output,
      overdueBillCount,
      overdueAmount: toNumber(overdueTotals._sum.remainingAmount),
      overdueOrderCount: overdueOrderGroups.length,
      collectionCaseCount,
      activeCaseCount,
      closedCaseCount,
      byCollectionLevel: overdueGroupRows(CollectionLevel, levelGroups, "collectionLevel", "collectionLevel"),
      byCaseStatus: overdueGroupRows(CollectionCaseStatus, statusGroups, "caseStatus", "caseStatus"),
      actionCount,
      promisedPaymentAmount: toNumber(promisedTotals._sum.promisedAmount)
    };
  }

  async getVehicleAssetReport(query: ReportDateRangeQueryDto) {
    const range = resolveReportDateRange(query);
    const vehicleWhere: Prisma.VehicleWhereInput = { deletedAt: null };
    const billWhere: Prisma.ReceivableBillWhereInput = {
      deletedAt: null,
      dueDate: range.dateTimeFilter,
      order: { vehicleId: { not: null } }
    };

    const [
      totalVehicles,
      statusGroups,
      vehicleTotals,
      vehiclesWithCurrentSalePrice,
      vehicleModelGroups,
      vehicleIncomeBills
    ] = await Promise.all([
      this.prisma.vehicle.count({ where: vehicleWhere }),
      this.prisma.vehicle.groupBy({
        by: ["status"],
        where: vehicleWhere,
        _count: { _all: true }
      }),
      this.prisma.vehicle.aggregate({
        where: vehicleWhere,
        _sum: { currentSalePriceAmount: true, purchasePriceAmount: true }
      }),
      this.prisma.vehicle.count({
        where: { ...vehicleWhere, currentSalePriceAmount: { not: null } }
      }),
      this.prisma.vehicle.groupBy({
        by: ["vehicleModel", "status"],
        where: vehicleWhere,
        _count: { _all: true }
      }),
      this.prisma.receivableBill.findMany({
        where: billWhere,
        select: {
          order: { select: { vehicleModel: true } },
          paidAmount: true
        }
      })
    ]);

    const statusCount = countMap(statusGroups, "status");
    const leasedVehicles = leasedVehicleCount(statusCount);
    const operationalVehicleCount = operationalVehicleStatuses.reduce(
      (sum, status) => sum + (statusCount.get(status) ?? 0),
      0
    );
    const totalCurrentSalePriceAmount = toNumber(vehicleTotals._sum.currentSalePriceAmount);
    const incomeByVehicleModel = incomeMap(vehicleIncomeBills);

    // Full ROA/ROE needs funding cost, depreciation, lifecycle revenue, residual value, and expenses.
    return {
      dateRange: range.output,
      totalVehicles,
      availableVehicles: statusCount.get(VehicleStatus.AVAILABLE) ?? 0,
      leasedVehicles,
      maintenanceVehicles: statusCount.get(VehicleStatus.MAINTENANCE) ?? 0,
      returnedVehicles: statusCount.get(VehicleStatus.RETURNED) ?? 0,
      soldVehicles: 0,
      rentalRate: operationalVehicleCount === 0 ? 0 : leasedVehicles / operationalVehicleCount,
      averageCurrentSalePriceAmount:
        vehiclesWithCurrentSalePrice === 0
          ? 0
          : Math.floor(totalCurrentSalePriceAmount / vehiclesWithCurrentSalePrice),
      totalPurchasePriceAmount: toNumber(vehicleTotals._sum.purchasePriceAmount),
      totalCurrentSalePriceAmount,
      totalPaidAmount: sumNumbers([...incomeByVehicleModel.values()]),
      byVehicleModel: vehicleModelAssetRows(vehicleModelGroups, incomeByVehicleModel)
    };
  }
}

const operationalVehicleStatuses = [
  VehicleStatus.AVAILABLE,
  VehicleStatus.REVIEW_RESERVED,
  VehicleStatus.RESERVED,
  VehicleStatus.LEASED,
  VehicleStatus.RENTED,
  VehicleStatus.RETURNED,
  VehicleStatus.MAINTENANCE
];

type CountGroup = { _count: { _all: number } } & Record<string, unknown>;
type AmountGroup = {
  _count: { _all: number };
  _sum: Record<string, bigint | number | null | undefined>;
} & Record<string, unknown>;

function resolveReportDateRange(query: ReportDateRangeQueryDto) {
  const endDate = query.endDate ?? businessDateForNow(new Date());
  const startDate = query.startDate ?? addBusinessDays(endDate, -(DEFAULT_REPORT_RANGE_DAYS - 1));
  const start = businessDateStartUtc(startDate, "startDate");
  const endExclusive = businessDateStartUtc(addBusinessDays(endDate, 1), "endDate");

  if (start.getTime() >= endExclusive.getTime()) {
    throw new BadRequestException("startDate must be earlier than or equal to endDate.");
  }

  return {
    dateTimeFilter: { gte: start, lt: endExclusive },
    endExclusive,
    output: { endDate, startDate },
    start
  };
}

function businessDateForNow(now: Date) {
  return formatDateOnly(new Date(now.getTime() + BUSINESS_OFFSET_MS));
}

function businessDateStartUtc(value: string, field: string) {
  const parts = parseDateOnly(value, field);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - BUSINESS_OFFSET_MS);
}

function addBusinessDays(value: string, days: number) {
  const parts = parseDateOnly(value, "date");
  return formatDateOnly(new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * DAY_MS));
}

function parseDateOnly(value: string, field: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    throw new BadRequestException(`${field} must be a YYYY-MM-DD date.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new BadRequestException(`${field} must be a valid calendar date.`);
  }

  return { day, month, year };
}

function formatDateOnly(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function countMap(rows: CountGroup[], field: string) {
  const result = new Map<string, number>();

  for (const row of rows) {
    const key = row[field];
    if (key !== null && key !== undefined) {
      result.set(String(key), row._count._all);
    }
  }

  return result;
}

function enumCountRows<T extends Record<string, string>>(
  enumObject: T,
  rows: CountGroup[],
  sourceField: string,
  outputField: string
) {
  const counts = countMap(rows, sourceField);

  return Object.values(enumObject).map((value) => ({
    [outputField]: value,
    count: counts.get(value) ?? 0
  }));
}

function amountGroupRows<T extends Record<string, string>>(
  enumObject: T,
  rows: AmountGroup[],
  sourceField: string,
  outputField: string,
  amountField = "amount"
) {
  const groupByKey = new Map(rows.map((row) => [String(row[sourceField]), row]));

  return Object.values(enumObject).map((value) => {
    const row = groupByKey.get(value);

    return {
      [outputField]: value,
      count: row?._count._all ?? 0,
      totalPaidAmount: toNumber(row?._sum.paidAmount),
      totalReceivableAmount: toNumber(row?._sum[amountField]),
      totalUnpaidAmount: toNumber(row?._sum.remainingAmount)
    };
  });
}

function amountOnlyGroupRows<T extends Record<string, string>>(
  enumObject: T,
  rows: AmountGroup[],
  sourceField: string,
  outputField: string
) {
  const groupByKey = new Map(rows.map((row) => [String(row[sourceField]), row]));

  return Object.values(enumObject).map((value) => {
    const row = groupByKey.get(value);

    return {
      [outputField]: value,
      amount: toNumber(row?._sum.amount),
      count: row?._count._all ?? 0
    };
  });
}

function overdueGroupRows<T extends Record<string, string>>(
  enumObject: T,
  rows: AmountGroup[],
  sourceField: string,
  outputField: string
) {
  const groupByKey = new Map(rows.map((row) => [String(row[sourceField]), row]));

  return Object.values(enumObject).map((value) => {
    const row = groupByKey.get(value);

    return {
      [outputField]: value,
      count: row?._count._all ?? 0,
      totalOverdueAmount: toNumber(row?._sum.totalOverdueAmount)
    };
  });
}

function summarizeDepositGroups(groups: AmountGroup[]) {
  const amountByType = new Map(
    groups.map((group) => [String(group.transactionType), toNumber(group._sum.amount)])
  );
  const countByType = new Map(groups.map((group) => [String(group.transactionType), group._count._all]));
  const collectedAmount = amountByType.get(DepositTransactionType.COLLECT) ?? 0;
  const deductedAmount = amountByType.get(DepositTransactionType.DEDUCT) ?? 0;
  const refundedAmount = amountByType.get(DepositTransactionType.REFUND) ?? 0;
  const releasedAmount = amountByType.get(DepositTransactionType.RELEASE) ?? 0;

  return {
    collectedAmount,
    deductedAmount,
    refundedAmount,
    releasedAmount,
    currentBalanceAmount: collectedAmount - deductedAmount - refundedAmount - releasedAmount,
    transactionCount: sumNumbers([...countByType.values()])
  };
}

function subscriptionPlanRows(
  orders: Array<{
    quote: {
      subscriptionPlan: { id: string; planName: string; planNo: string } | null;
      subscriptionPlanId: string | null;
    };
  }>
) {
  const groups = new Map<
    string,
    { count: number; subscriptionPlanId: string | null; subscriptionPlanName: string | null; subscriptionPlanNo: string | null }
  >();

  for (const order of orders) {
    const plan = order.quote.subscriptionPlan;
    const key = order.quote.subscriptionPlanId ?? "UNASSIGNED";
    const current = groups.get(key) ?? {
      count: 0,
      subscriptionPlanId: order.quote.subscriptionPlanId,
      subscriptionPlanName: plan?.planName ?? null,
      subscriptionPlanNo: plan?.planNo ?? null
    };
    current.count += 1;
    groups.set(key, current);
  }

  return [...groups.values()];
}

function leasedVehicleCount(statusCount: Map<string, number>) {
  return (statusCount.get(VehicleStatus.LEASED) ?? 0) + (statusCount.get(VehicleStatus.RENTED) ?? 0);
}

function incomeMap(bills: Array<{ order: { vehicleModel: VehicleModel }; paidAmount: bigint }>) {
  const result = new Map<string, number>();

  for (const bill of bills) {
    result.set(bill.order.vehicleModel, (result.get(bill.order.vehicleModel) ?? 0) + Number(bill.paidAmount));
  }

  return result;
}

function vehicleModelAssetRows(
  groups: Array<{ _count: { _all: number }; status: VehicleStatus; vehicleModel: VehicleModel | null }>,
  incomeByVehicleModel: Map<string, number>
) {
  const rows = new Map<
    string,
    { availableVehicles: number; incomeAmount: number; leasedVehicles: number; totalVehicles: number; vehicleModel: VehicleModel | null }
  >();

  for (const group of groups) {
    const key = group.vehicleModel ?? "UNSPECIFIED";
    const row = rows.get(key) ?? {
      availableVehicles: 0,
      incomeAmount: incomeByVehicleModel.get(key) ?? 0,
      leasedVehicles: 0,
      totalVehicles: 0,
      vehicleModel: group.vehicleModel
    };

    row.totalVehicles += group._count._all;
    if (group.status === VehicleStatus.AVAILABLE) {
      row.availableVehicles += group._count._all;
    }
    if (group.status === VehicleStatus.LEASED || group.status === VehicleStatus.RENTED) {
      row.leasedVehicles += group._count._all;
    }
    rows.set(key, row);
  }

  for (const [vehicleModel, incomeAmount] of incomeByVehicleModel.entries()) {
    if (!rows.has(vehicleModel)) {
      rows.set(vehicleModel, {
        availableVehicles: 0,
        incomeAmount,
        leasedVehicles: 0,
        totalVehicles: 0,
        vehicleModel: vehicleModel as VehicleModel
      });
    }
  }

  return [...rows.values()];
}

function toNumber(value: bigint | number | null | undefined) {
  return value === null || value === undefined ? 0 : Number(value);
}

function sumNumbers(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0);
}
