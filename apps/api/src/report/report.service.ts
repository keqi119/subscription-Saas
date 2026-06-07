import { BadRequestException, Injectable } from "@nestjs/common";
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
  Prisma,
  VehicleModel,
  VehicleStatus
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import {
  compactDate,
  CsvRow,
  formatDate,
  formatMoneyYuan,
  formatPercent,
  safeCell,
  toCsv,
  withUtf8Bom
} from "./report-csv";
import {
  BillDetailQueryDto,
  CollectionCaseDetailQueryDto,
  DepositLedgerDetailQueryDto,
  EntitlementGrantDetailQueryDto,
  EntitlementReportQueryDto,
  EntitlementUsageDetailQueryDto,
  OrderDetailQueryDto,
  OrderReportQueryDto,
  OverdueBillDetailQueryDto,
  ReportDateRangeQueryDto,
  VehicleDetailQueryDto
} from "./dto/report.dto";
import {
  billStatusLabels,
  billTypeLabels,
  collectionCaseStatusLabels,
  collectionLevelLabels,
  contractStatusLabels,
  depositTransactionStatusLabels,
  depositTransactionTypeLabels,
  labelOf,
  orderSourceLabels,
  orderStatusLabels,
  vehicleBatteryUsageTypeLabels,
  vehicleStatusLabels
} from "./report-labels";

const BUSINESS_UTC_OFFSET_MINUTES = 8 * 60;
const DEFAULT_REPORT_RANGE_DAYS = 30;
const DETAIL_EXPORT_PAGE_SIZE = 100;
const MAX_DETAIL_EXPORT_ROWS = 5000;
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

  async getEntitlementReport(query: EntitlementReportQueryDto) {
    const range = resolveReportDateRange(query);
    const accountWhere: Prisma.OrderEntitlementAccountWhereInput = {
      createdAt: range.dateTimeFilter,
      deletedAt: null,
      ...(query.orderStatus ? { order: { orderStatus: query.orderStatus } } : {})
    };
    const grantWhere = entitlementGrantReportWhere(query, range);
    const usageWhere = entitlementUsageReportWhere(query, range);
    const exhaustedGrantWhere: Prisma.OrderEntitlementGrantWhereInput =
      query.grantStatus && query.grantStatus !== EntitlementGrantStatus.EXHAUSTED
        ? { ...grantWhere, id: { in: [] } }
        : { ...grantWhere, status: EntitlementGrantStatus.EXHAUSTED };

    const [
      accountStatusGroups,
      grantStatusGroups,
      grantTypeUnitGroups,
      exhaustedGrantTypeUnitGroups,
      usageUnitGroups,
      usageSourceGroups,
      usageStatusGroups,
      recentlyExhaustedGrants
    ] = await Promise.all([
      this.prisma.orderEntitlementAccount.groupBy({
        by: ["accountStatus"],
        where: accountWhere,
        _count: { _all: true }
      }),
      this.prisma.orderEntitlementGrant.groupBy({
        by: ["status"],
        where: grantWhere,
        _count: { _all: true }
      }),
      this.prisma.orderEntitlementGrant.groupBy({
        by: ["entitlementType", "unit"],
        where: grantWhere,
        _count: { _all: true },
        _sum: { remainingAmount: true, totalAmount: true, usedAmount: true }
      }),
      this.prisma.orderEntitlementGrant.groupBy({
        by: ["entitlementType", "unit"],
        where: exhaustedGrantWhere,
        _count: { _all: true }
      }),
      this.prisma.orderEntitlementUsage.groupBy({
        by: ["unit"],
        where: usageWhere,
        _count: { _all: true },
        _sum: { usedAmount: true }
      }),
      this.prisma.orderEntitlementUsage.groupBy({
        by: ["usageSource"],
        where: usageWhere,
        _count: { _all: true },
        _sum: { usedAmount: true }
      }),
      this.prisma.orderEntitlementUsage.groupBy({
        by: ["usageStatus"],
        where: usageWhere,
        _count: { _all: true },
        _sum: { usedAmount: true }
      }),
      this.prisma.orderEntitlementGrant.findMany({
        orderBy: { updatedAt: "desc" },
        select: {
          customer: { select: { name: true } },
          entitlementName: true,
          entitlementType: true,
          grantNo: true,
          id: true,
          order: { select: { id: true, orderNo: true } },
          remainingAmount: true,
          totalAmount: true,
          unit: true,
          updatedAt: true,
          usedAmount: true,
          usages: {
            orderBy: { occurredAt: "desc" },
            select: { occurredAt: true },
            take: 1,
            where: { deletedAt: null, usageStatus: EntitlementUsageStatus.CONFIRMED }
          }
        },
        take: 10,
        where: exhaustedGrantWhere
      })
    ]);

    const accountStatusCount = countMap(accountStatusGroups, "accountStatus");
    const grantStatusCount = countMap(grantStatusGroups, "status");
    const usageSourceCount = countMap(usageSourceGroups, "usageSource");

    return {
      dateRange: range.output,
      accountOverview: {
        activeAccountCount: accountStatusCount.get(EntitlementAccountStatus.ACTIVE) ?? 0,
        closedAccountCount: accountStatusCount.get(EntitlementAccountStatus.CLOSED) ?? 0,
        suspendedAccountCount: accountStatusCount.get(EntitlementAccountStatus.SUSPENDED) ?? 0,
        totalAccountCount: sumNumbers([...accountStatusCount.values()])
      },
      grantOverview: {
        activeGrantCount: grantStatusCount.get(EntitlementGrantStatus.ACTIVE) ?? 0,
        cancelledGrantCount: grantStatusCount.get(EntitlementGrantStatus.CANCELLED) ?? 0,
        exhaustedGrantCount: grantStatusCount.get(EntitlementGrantStatus.EXHAUSTED) ?? 0,
        expiredGrantCount: grantStatusCount.get(EntitlementGrantStatus.EXPIRED) ?? 0,
        totalGrantCount: sumNumbers([...grantStatusCount.values()])
      },
      byEntitlementTypeUnit: grantTypeUnitGroups.map((group) => ({
        entitlementType: group.entitlementType,
        grantCount: group._count._all,
        remainingAmount: group.unit === EntitlementUnit.TEXT ? null : amountToNumber(group._sum.remainingAmount),
        totalAmount: group.unit === EntitlementUnit.TEXT ? null : amountToNumber(group._sum.totalAmount),
        unit: group.unit,
        usedAmount: group.unit === EntitlementUnit.TEXT ? null : amountToNumber(group._sum.usedAmount)
      })).map((row) => ({
        ...row,
        exhaustedCount: exhaustedCountForTypeUnit(exhaustedGrantTypeUnitGroups, row.entitlementType, row.unit)
      })),
      usageOverview: {
        manualUsageCount: usageSourceCount.get(EntitlementUsageSource.MANUAL) ?? 0,
        systemUsageCount: usageSourceCount.get(EntitlementUsageSource.SYSTEM) ?? 0,
        thirdPartyUsageCount: usageSourceCount.get(EntitlementUsageSource.THIRD_PARTY) ?? 0,
        totalUsageCount: sumNumbers([...usageSourceCount.values()]),
        bySource: usageAmountRows(EntitlementUsageSource, usageSourceGroups, "usageSource"),
        byStatus: usageAmountRows(EntitlementUsageStatus, usageStatusGroups, "usageStatus"),
        byUnit: usageAmountRows(EntitlementUnit, usageUnitGroups, "unit")
      },
      recentlyExhausted: recentlyExhaustedGrants.map((grant) => ({
        customerName: grant.customer.name,
        entitlementName: grant.entitlementName,
        entitlementType: grant.entitlementType,
        grantNo: grant.grantNo,
        id: grant.id,
        latestUsageAt: grant.usages[0]?.occurredAt ?? grant.updatedAt,
        orderId: grant.order.id,
        orderNo: grant.order.orderNo,
        remainingAmount: nullableAmount(grant.remainingAmount),
        totalAmount: nullableAmount(grant.totalAmount),
        unit: grant.unit,
        usedAmount: nullableAmount(grant.usedAmount)
      }))
    };
  }

  async getEntitlementGrantDetails(query: EntitlementGrantDetailQueryDto) {
    const range = resolveReportDateRange(query);
    const pagination = resolvePagination(query);
    const where: Prisma.OrderEntitlementGrantWhereInput = {
      createdAt: range.dateTimeFilter,
      deletedAt: null,
      ...(query.entitlementType ? { entitlementType: query.entitlementType } : {}),
      ...(query.unit ? { unit: query.unit } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.orderNo ? { order: { orderNo: containsText(query.orderNo) } } : {}),
      ...(query.customerName ? { customer: { name: containsText(query.customerName) } } : {})
    };

    const [total, items] = await Promise.all([
      this.prisma.orderEntitlementGrant.count({ where }),
      this.prisma.orderEntitlementGrant.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          createdAt: true,
          customer: { select: { name: true } },
          entitlementName: true,
          entitlementType: true,
          grantNo: true,
          grantPeriodEnd: true,
          grantPeriodStart: true,
          grantSource: true,
          id: true,
          order: { select: { id: true, orderNo: true } },
          remainingAmount: true,
          status: true,
          totalAmount: true,
          unit: true,
          usedAmount: true
        },
        skip: pagination.skip,
        take: pagination.pageSize,
        where
      })
    ]);

    return pagedResult(
      items.map((grant) => ({
        id: grant.id,
        grantNo: grant.grantNo,
        orderId: grant.order.id,
        orderNo: grant.order.orderNo,
        customerName: grant.customer.name,
        entitlementType: grant.entitlementType,
        entitlementName: grant.entitlementName,
        totalAmount: nullableAmount(grant.totalAmount),
        usedAmount: nullableAmount(grant.usedAmount),
        remainingAmount: nullableAmount(grant.remainingAmount),
        unit: grant.unit,
        status: grant.status,
        grantSource: grant.grantSource,
        grantPeriodStart: grant.grantPeriodStart,
        grantPeriodEnd: grant.grantPeriodEnd,
        createdAt: grant.createdAt
      })),
      total,
      pagination
    );
  }

  async getEntitlementUsageDetails(query: EntitlementUsageDetailQueryDto) {
    const range = resolveReportDateRange(query);
    const pagination = resolvePagination(query);
    const where: Prisma.OrderEntitlementUsageWhereInput = {
      deletedAt: null,
      occurredAt: range.dateTimeFilter,
      ...(query.entitlementType ? { entitlementType: query.entitlementType } : {}),
      ...(query.unit ? { unit: query.unit } : {}),
      ...(query.usageSource ? { usageSource: query.usageSource } : {}),
      ...(query.usageStatus ? { usageStatus: query.usageStatus } : {}),
      ...(query.orderNo ? { order: { orderNo: containsText(query.orderNo) } } : {}),
      ...(query.customerName ? { customer: { name: containsText(query.customerName) } } : {})
    };

    const [total, items] = await Promise.all([
      this.prisma.orderEntitlementUsage.count({ where }),
      this.prisma.orderEntitlementUsage.findMany({
        orderBy: { occurredAt: "desc" },
        select: {
          createdAt: true,
          customer: { select: { name: true } },
          entitlementName: true,
          entitlementType: true,
          externalRefNo: true,
          id: true,
          occurredAt: true,
          order: { select: { id: true, orderNo: true } },
          remark: true,
          scenario: true,
          unit: true,
          usageNo: true,
          usageSource: true,
          usageStatus: true,
          usedAmount: true
        },
        skip: pagination.skip,
        take: pagination.pageSize,
        where
      })
    ]);

    return pagedResult(
      items.map((usage) => ({
        id: usage.id,
        usageNo: usage.usageNo,
        orderId: usage.order.id,
        orderNo: usage.order.orderNo,
        customerName: usage.customer.name,
        entitlementType: usage.entitlementType,
        entitlementName: usage.entitlementName,
        usedAmount: amountToNumber(usage.usedAmount),
        unit: usage.unit,
        usageSource: usage.usageSource,
        usageStatus: usage.usageStatus,
        occurredAt: usage.occurredAt,
        externalRefNo: usage.externalRefNo,
        scenario: usage.scenario,
        remark: usage.remark,
        createdAt: usage.createdAt
      })),
      total,
      pagination
    );
  }

  async getOrderDetails(query: OrderDetailQueryDto) {
    const range = resolveReportDateRange(query);
    const pagination = resolvePagination(query);
    const where: Prisma.SubscriptionOrderWhereInput = {
      createdAt: range.dateTimeFilter,
      deletedAt: null,
      ...(query.orderStatus ? { orderStatus: query.orderStatus } : {}),
      ...(query.orderSource ? { orderSource: query.orderSource } : {}),
      ...(query.vehicleModel ? { vehicleModel: query.vehicleModel } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.subscriptionPlanId ? { quote: { subscriptionPlanId: query.subscriptionPlanId } } : {})
    };

    const [total, items] = await Promise.all([
      this.prisma.subscriptionOrder.count({ where }),
      this.prisma.subscriptionOrder.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          actualReturnAt: true,
          contract: { select: { status: true } },
          createdAt: true,
          customer: { select: { mobile: true, name: true } },
          depositAmount: true,
          id: true,
          monthlyFeeAmount: true,
          orderNo: true,
          orderSource: true,
          orderStatus: true,
          quote: {
            select: {
              subscriptionPlan: { select: { id: true, planName: true, planNo: true } },
              subscriptionPlanId: true
            }
          },
          startDate: true,
          vehicle: { select: { plateNo: true, vehicleNo: true, vin: true } },
          vehicleModel: true
        },
        skip: pagination.skip,
        take: pagination.pageSize,
        where
      })
    ]);

    return pagedResult(
      items.map((order) => ({
        id: order.id,
        orderNo: order.orderNo,
        customerName: order.customer.name,
        mobile: order.customer.mobile,
        orderSource: order.orderSource,
        orderStatus: order.orderStatus,
        vehicleVin: order.vehicle?.vin ?? null,
        vehicleNo: order.vehicle?.vehicleNo ?? null,
        plateNo: order.vehicle?.plateNo ?? null,
        vehicleModel: order.vehicleModel,
        subscriptionPlanId: order.quote.subscriptionPlanId,
        subscriptionPlanName: order.quote.subscriptionPlan?.planName ?? null,
        subscriptionPlanNo: order.quote.subscriptionPlan?.planNo ?? null,
        monthlyFeeAmount: toNumber(order.monthlyFeeAmount),
        depositAmount: toNumber(order.depositAmount),
        contractStatus: order.contract?.status ?? null,
        leaseStartDate: order.startDate,
        returnAt: order.actualReturnAt,
        createdAt: order.createdAt
      })),
      total,
      pagination
    );
  }

  async getBillDetails(query: BillDetailQueryDto) {
    const range = resolveReportDateRange(query);
    const pagination = resolvePagination(query);
    const where: Prisma.ReceivableBillWhereInput = {
      deletedAt: null,
      dueDate: range.dateTimeFilter,
      ...(query.billType ? { billType: query.billType } : {}),
      ...(query.billStatus ? { billStatus: query.billStatus } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.customerName ? { customer: { name: containsText(query.customerName) } } : {})
    };

    const [total, items] = await Promise.all([
      this.prisma.receivableBill.count({ where }),
      this.prisma.receivableBill.findMany({
        orderBy: { dueDate: "desc" },
        select: {
          amount: true,
          billNo: true,
          billPeriodEnd: true,
          billPeriodStart: true,
          billStatus: true,
          billType: true,
          createdAt: true,
          customer: { select: { name: true } },
          dueDate: true,
          id: true,
          order: { select: { id: true, orderNo: true } },
          orderId: true,
          paidAmount: true,
          remainingAmount: true
        },
        skip: pagination.skip,
        take: pagination.pageSize,
        where
      })
    ]);

    return pagedResult(
      items.map((bill) => ({
        id: bill.id,
        billNo: bill.billNo,
        orderId: bill.orderId,
        orderNo: bill.order.orderNo,
        customerName: bill.customer.name,
        billType: bill.billType,
        billStatus: bill.billStatus,
        amount: toNumber(bill.amount),
        paidAmount: toNumber(bill.paidAmount),
        remainingAmount: toNumber(bill.remainingAmount),
        dueDate: bill.dueDate,
        periodStart: bill.billPeriodStart,
        periodEnd: bill.billPeriodEnd,
        createdAt: bill.createdAt
      })),
      total,
      pagination
    );
  }

  async getDepositLedgerDetails(query: DepositLedgerDetailQueryDto) {
    const range = resolveReportDateRange(query);
    const pagination = resolvePagination(query);
    const where: Prisma.DepositLedgerWhereInput = {
      deletedAt: null,
      occurredAt: range.dateTimeFilter,
      transactionStatus: query.transactionStatus ?? DepositTransactionStatus.CONFIRMED,
      ...(query.transactionType ? { transactionType: query.transactionType } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.customerName ? { customer: { name: containsText(query.customerName) } } : {})
    };

    const [total, items] = await Promise.all([
      this.prisma.depositLedger.count({ where }),
      this.prisma.depositLedger.findMany({
        orderBy: { occurredAt: "desc" },
        select: {
          amount: true,
          balanceAfter: true,
          bill: { select: { billNo: true } },
          customer: { select: { name: true } },
          id: true,
          ledgerNo: true,
          occurredAt: true,
          order: { select: { id: true, orderNo: true } },
          orderId: true,
          remark: true,
          transactionStatus: true,
          transactionType: true
        },
        skip: pagination.skip,
        take: pagination.pageSize,
        where
      })
    ]);

    return pagedResult(
      items.map((ledger) => ({
        id: ledger.id,
        ledgerNo: ledger.ledgerNo,
        orderId: ledger.orderId,
        orderNo: ledger.order.orderNo,
        customerName: ledger.customer.name,
        transactionType: ledger.transactionType,
        transactionStatus: ledger.transactionStatus,
        amount: toNumber(ledger.amount),
        balanceAfterAmount: toNumber(ledger.balanceAfter),
        relatedBillNo: ledger.bill?.billNo ?? null,
        occurredAt: ledger.occurredAt,
        remark: ledger.remark
      })),
      total,
      pagination
    );
  }

  async getOverdueBillDetails(query: OverdueBillDetailQueryDto) {
    const range = resolveReportDateRange(query);
    const pagination = resolvePagination(query);
    const where: Prisma.ReceivableBillWhereInput = {
      billStatus: BillStatus.OVERDUE,
      deletedAt: null,
      dueDate: overdueDueDateFilter(query, range),
      remainingAmount: { gt: 0n },
      ...(query.billType ? { billType: query.billType } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.customerName ? { customer: { name: containsText(query.customerName) } } : {}),
      ...(query.collectionLevel
        ? {
            collectionCaseBills: {
              some: {
                case: { collectionLevel: query.collectionLevel, deletedAt: null },
                deletedAt: null
              }
            }
          }
        : {})
    };

    const [total, items] = await Promise.all([
      this.prisma.receivableBill.count({ where }),
      this.prisma.receivableBill.findMany({
        orderBy: { dueDate: "asc" },
        select: {
          billNo: true,
          billType: true,
          collectionCaseBills: {
            orderBy: { createdAt: "desc" },
            select: {
              case: { select: { caseNo: true, caseStatus: true, collectionLevel: true } },
              overdueDays: true
            },
            take: 1,
            where: { deletedAt: null }
          },
          customer: { select: { name: true } },
          dueDate: true,
          id: true,
          order: { select: { id: true, orderNo: true } },
          orderId: true,
          remainingAmount: true
        },
        skip: pagination.skip,
        take: pagination.pageSize,
        where
      })
    ]);

    return pagedResult(
      items.map((bill) => {
        const caseBill = bill.collectionCaseBills[0];
        const overdueDays = caseBill?.overdueDays ?? overdueDaysBetween(bill.dueDate, range.endExclusive);

        return {
          id: bill.id,
          billNo: bill.billNo,
          orderId: bill.orderId,
          orderNo: bill.order.orderNo,
          customerName: bill.customer.name,
          billType: bill.billType,
          remainingAmount: toNumber(bill.remainingAmount),
          dueDate: bill.dueDate,
          overdueDays,
          collectionLevel: caseBill?.case.collectionLevel ?? collectionLevelForDays(overdueDays),
          caseNo: caseBill?.case.caseNo ?? null,
          caseStatus: caseBill?.case.caseStatus ?? null
        };
      }),
      total,
      pagination
    );
  }

  async getCollectionCaseDetails(query: CollectionCaseDetailQueryDto) {
    const range = resolveReportDateRange(query);
    const pagination = resolvePagination(query);
    const where: Prisma.CollectionCaseWhereInput = {
      createdAt: range.dateTimeFilter,
      deletedAt: null,
      ...(query.caseStatus ? { caseStatus: query.caseStatus } : {}),
      ...(query.collectionLevel ? { collectionLevel: query.collectionLevel } : {}),
      ...(query.assignedTo ? { assignedTo: query.assignedTo } : {}),
      ...(query.customerName ? { customer: { name: containsText(query.customerName) } } : {}),
      ...(query.orderNo ? { order: { orderNo: containsText(query.orderNo) } } : {})
    };

    const [total, items] = await Promise.all([
      this.prisma.collectionCase.count({ where }),
      this.prisma.collectionCase.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          assignedTo: true,
          caseNo: true,
          caseStatus: true,
          closedAt: true,
          collectionLevel: true,
          createdAt: true,
          customer: { select: { name: true } },
          id: true,
          maxOverdueDays: true,
          nextFollowUpAt: true,
          order: { select: { id: true, orderNo: true } },
          orderId: true,
          totalOverdueAmount: true
        },
        skip: pagination.skip,
        take: pagination.pageSize,
        where
      })
    ]);

    return pagedResult(
      items.map((collectionCase) => ({
        id: collectionCase.id,
        caseNo: collectionCase.caseNo,
        customerName: collectionCase.customer.name,
        orderId: collectionCase.orderId,
        orderNo: collectionCase.order.orderNo,
        totalOverdueAmount: toNumber(collectionCase.totalOverdueAmount),
        maxOverdueDays: collectionCase.maxOverdueDays,
        collectionLevel: collectionCase.collectionLevel,
        caseStatus: collectionCase.caseStatus,
        assignedTo: collectionCase.assignedTo,
        nextFollowUpAt: collectionCase.nextFollowUpAt,
        createdAt: collectionCase.createdAt,
        closedAt: collectionCase.closedAt
      })),
      total,
      pagination
    );
  }

  async getVehicleDetails(query: VehicleDetailQueryDto) {
    const range = resolveReportDateRange(query);
    const pagination = resolvePagination(query);
    const where: Prisma.VehicleWhereInput = {
      deletedAt: null,
      ...(query.vehicleStatus ? { status: query.vehicleStatus } : {}),
      ...(query.vehicleModel ? { vehicleModel: query.vehicleModel } : {}),
      ...(query.brand ? { brand: containsText(query.brand) } : {}),
      ...(query.series ? { series: containsText(query.series) } : {})
    };

    const [total, vehicles] = await Promise.all([
      this.prisma.vehicle.count({ where }),
      this.prisma.vehicle.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          batteryCapacityKwh: true,
          batteryUsageType: true,
          brand: true,
          createdAt: true,
          currentSalePriceAmount: true,
          deliveries: {
            orderBy: { deliveredAt: "desc" },
            select: { deliveredAt: true },
            take: 1,
            where: { deletedAt: null, deliveredAt: { not: null } }
          },
          id: true,
          model: true,
          orders: {
            orderBy: { createdAt: "desc" },
            select: {
              customer: { select: { name: true } },
              id: true,
              orderNo: true
            },
            take: 1,
            where: { deletedAt: null, orderStatus: { in: currentVehicleOrderStatuses } }
          },
          plateNo: true,
          purchasePriceAmount: true,
          returns: {
            orderBy: { returnedAt: "desc" },
            select: { returnedAt: true },
            take: 1,
            where: { deletedAt: null, returnedAt: { not: null } }
          },
          series: true,
          status: true,
          vehicleModel: true,
          vehicleNo: true,
          vin: true
        },
        skip: pagination.skip,
        take: pagination.pageSize,
        where
      })
    ]);
    const paidAmountByVehicleId = await this.paidAmountByVehicle(range, vehicles.map((vehicle) => vehicle.id));

    return pagedResult(
      vehicles.map((vehicle) => {
        const currentOrder = vehicle.orders[0];

        return {
          id: vehicle.id,
          vehicleNo: vehicle.vehicleNo,
          vin: vehicle.vin,
          plateNo: vehicle.plateNo,
          brand: vehicle.brand,
          series: vehicle.series,
          model: vehicle.model,
          vehicleModel: vehicle.vehicleModel,
          batteryCapacityKwh: decimalToNumber(vehicle.batteryCapacityKwh),
          batteryUsageType: vehicle.batteryUsageType,
          vehicleStatus: vehicle.status,
          purchasePriceAmount: toNumber(vehicle.purchasePriceAmount),
          currentSalePriceAmount: toNumber(vehicle.currentSalePriceAmount),
          currentOrderId: currentOrder?.id ?? null,
          currentOrderNo: currentOrder?.orderNo ?? null,
          currentCustomerName: currentOrder?.customer.name ?? null,
          totalPaidAmount: paidAmountByVehicleId.get(vehicle.id) ?? 0,
          latestDeliveredAt: vehicle.deliveries[0]?.deliveredAt ?? null,
          latestReturnedAt: vehicle.returns[0]?.returnedAt ?? null,
          createdAt: vehicle.createdAt
        };
      }),
      total,
      pagination
    );
  }

  async exportOrderReport(query: OrderReportQueryDto) {
    const report = await this.getOrderReport(query);
    const rows: CsvRow[] = [
      ["订单报表"],
      ["统计周期", dateRangeText(report.dateRange)],
      [],
      ["订单总数", report.totalOrders],
      [],
      ["订单状态统计"],
      ["状态", "数量"],
      ...report.byStatus.map((row) => [labelOf(orderStatusLabels, row.orderStatus), row.count]),
      [],
      ["订单来源统计"],
      ["来源", "数量"],
      ...report.bySource.map((row) => [labelOf(orderSourceLabels, row.orderSource), row.count]),
      [],
      ["车型统计"],
      ["车型", "数量"],
      ...report.byVehicleModel.map((row) => [row.vehicleModel, row.count]),
      [],
      ["订阅套餐统计"],
      ["套餐", "数量"],
      ...report.bySubscriptionPlan.map((row) => [
        safeCell(row.subscriptionPlanName ?? row.subscriptionPlanNo),
        row.count
      ])
    ];

    return csvExport("orders-report", report.dateRange, rows);
  }

  async exportFinanceReport(query: ReportDateRangeQueryDto) {
    const report = await this.getFinanceReport(query);
    const rows: CsvRow[] = [
      ["财务报表"],
      ["统计周期", dateRangeText(report.dateRange)],
      [],
      ["汇总"],
      ["指标", "金额（元）"],
      ["总应收金额", formatMoneyYuan(report.totalReceivableAmount)],
      ["总已收金额", formatMoneyYuan(report.totalPaidAmount)],
      ["总未收金额", formatMoneyYuan(report.totalUnpaidAmount)],
      [],
      ["按账单类型统计"],
      ["账单类型", "应收金额（元）", "已收金额（元）", "未收金额（元）", "数量"],
      ...report.byBillType.map((row) => [
        labelOf(billTypeLabels, row.billType),
        formatMoneyYuan(row.totalReceivableAmount),
        formatMoneyYuan(row.totalPaidAmount),
        formatMoneyYuan(row.totalUnpaidAmount),
        row.count
      ]),
      [],
      ["按账单状态统计"],
      ["账单状态", "应收金额（元）", "已收金额（元）", "未收金额（元）", "数量"],
      ...report.byBillStatus.map((row) => [
        labelOf(billStatusLabels, row.billStatus),
        formatMoneyYuan(row.totalReceivableAmount),
        formatMoneyYuan(row.totalPaidAmount),
        formatMoneyYuan(row.totalUnpaidAmount),
        row.count
      ])
    ];

    return csvExport("finance-report", report.dateRange, rows);
  }

  async exportDepositPoolReport(query: ReportDateRangeQueryDto) {
    const report = await this.getDepositPoolReport(query);
    const rows: CsvRow[] = [
      ["保证金池报表"],
      ["统计周期", dateRangeText(report.dateRange)],
      [],
      ["汇总"],
      ["指标", "金额（元）/数量"],
      ["累计收取保证金", formatMoneyYuan(report.collectedAmount)],
      ["累计扣减保证金", formatMoneyYuan(report.deductedAmount)],
      ["累计退款保证金", formatMoneyYuan(report.refundedAmount)],
      ["当前保证金余额", formatMoneyYuan(report.currentBalanceAmount)],
      ["保证金交易笔数", report.transactionCount],
      [],
      ["按交易类型统计"],
      ["交易类型", "金额（元）", "数量"],
      ...report.byTransactionType.map((row) => [
        labelOf(depositTransactionTypeLabels, row.transactionType),
        formatMoneyYuan(row.amount),
        row.count
      ])
    ];

    return csvExport("deposit-pool-report", report.dateRange, rows);
  }

  async exportCollectionReport(query: ReportDateRangeQueryDto) {
    const report = await this.getCollectionReport(query);
    const rows: CsvRow[] = [
      ["逾期催收报表"],
      ["统计周期", dateRangeText(report.dateRange)],
      [],
      ["汇总"],
      ["指标", "金额（元）/数量"],
      ["逾期账单数", report.overdueBillCount],
      ["逾期金额", formatMoneyYuan(report.overdueAmount)],
      ["逾期订单数", report.overdueOrderCount],
      ["催收案件数", report.collectionCaseCount],
      ["催收中案件数", report.activeCaseCount],
      ["已关闭案件数", report.closedCaseCount],
      ["催收动作数量", report.actionCount],
      ["承诺付款金额", formatMoneyYuan(report.promisedPaymentAmount)],
      [],
      ["按逾期等级统计"],
      ["逾期等级", "逾期金额（元）", "案件数", "账单数"],
      ...report.byCollectionLevel.map((row) => [
        labelOf(collectionLevelLabels, row.collectionLevel),
        formatMoneyYuan(row.totalOverdueAmount),
        row.count,
        "-"
      ]),
      [],
      ["按案件状态统计"],
      ["案件状态", "案件数"],
      ...report.byCaseStatus.map((row) => [labelOf(collectionCaseStatusLabels, row.caseStatus), row.count])
    ];

    return csvExport("collections-report", report.dateRange, rows);
  }

  async exportVehicleAssetReport(query: ReportDateRangeQueryDto) {
    const report = await this.getVehicleAssetReport(query);
    const rows: CsvRow[] = [
      ["车辆资产报表"],
      ["统计周期", dateRangeText(report.dateRange)],
      [],
      ["汇总"],
      ["指标", "值"],
      ["车辆总数", report.totalVehicles],
      ["可租车辆数", report.availableVehicles],
      ["在租车辆数", report.leasedVehicles],
      ["维修中车辆数", report.maintenanceVehicles],
      ["已退回车辆数", report.returnedVehicles],
      ["已售车辆数", report.soldVehicles],
      ["出租率", formatPercent(report.rentalRate)],
      ["平均当前车辆销售价（元）", formatMoneyYuan(report.averageCurrentSalePriceAmount)],
      ["采购成本合计（元）", formatMoneyYuan(report.totalPurchasePriceAmount)],
      ["当前销售价合计（元）", formatMoneyYuan(report.totalCurrentSalePriceAmount)],
      [],
      ["按车型统计"],
      ["车型", "车辆数", "在租数", "可租数", "收入（元）"],
      ...report.byVehicleModel.map((row) => [
        row.vehicleModel,
        row.totalVehicles,
        row.leasedVehicles,
        row.availableVehicles,
        formatMoneyYuan(row.incomeAmount)
      ])
    ];

    return csvExport("vehicle-assets-report", report.dateRange, rows);
  }

  async exportOrderDetails(query: OrderDetailQueryDto) {
    const { dateRange, items } = await this.collectDetailExportRows(query, (pageQuery) =>
      this.getOrderDetails(pageQuery)
    );
    const rows: CsvRow[] = [
      ["订单明细"],
      ["统计周期", dateRangeText(dateRange)],
      [],
      [
        "订单编号",
        "客户姓名",
        "手机号",
        "订单来源",
        "订单状态",
        "车辆VIN",
        "车牌号",
        "车型",
        "订阅套餐",
        "月费（元）",
        "押金（元）",
        "合同状态",
        "起租时间",
        "退车时间",
        "创建时间"
      ],
      ...items.map((row) => [
        row.orderNo,
        row.customerName,
        row.mobile,
        labelOf(orderSourceLabels, row.orderSource),
        labelOf(orderStatusLabels, row.orderStatus),
        row.vehicleVin,
        row.plateNo,
        row.vehicleModel,
        row.subscriptionPlanName ?? row.subscriptionPlanNo,
        formatMoneyYuan(row.monthlyFeeAmount),
        formatMoneyYuan(row.depositAmount),
        labelOf(contractStatusLabels, row.contractStatus),
        formatDate(row.leaseStartDate),
        formatDate(row.returnAt),
        formatDate(row.createdAt)
      ])
    ];

    return csvExport("orders-detail", dateRange, rows);
  }

  async exportBillDetails(query: BillDetailQueryDto) {
    const { dateRange, items } = await this.collectDetailExportRows(query, (pageQuery) =>
      this.getBillDetails(pageQuery)
    );
    const rows: CsvRow[] = [
      ["账单明细"],
      ["统计周期", dateRangeText(dateRange)],
      [],
      [
        "账单编号",
        "订单编号",
        "客户姓名",
        "账单类型",
        "账单状态",
        "应收金额（元）",
        "已收金额（元）",
        "剩余金额（元）",
        "到期日",
        "账期开始",
        "账期结束",
        "创建时间"
      ],
      ...items.map((row) => [
        row.billNo,
        row.orderNo,
        row.customerName,
        labelOf(billTypeLabels, row.billType),
        labelOf(billStatusLabels, row.billStatus),
        formatMoneyYuan(row.amount),
        formatMoneyYuan(row.paidAmount),
        formatMoneyYuan(row.remainingAmount),
        formatDate(row.dueDate),
        formatDate(row.periodStart),
        formatDate(row.periodEnd),
        formatDate(row.createdAt)
      ])
    ];

    return csvExport("bills-detail", dateRange, rows);
  }

  async exportDepositLedgerDetails(query: DepositLedgerDetailQueryDto) {
    const { dateRange, items } = await this.collectDetailExportRows(query, (pageQuery) =>
      this.getDepositLedgerDetails(pageQuery)
    );
    const rows: CsvRow[] = [
      ["保证金台账明细"],
      ["统计周期", dateRangeText(dateRange)],
      [],
      [
        "台账编号",
        "订单编号",
        "客户姓名",
        "交易类型",
        "交易状态",
        "金额（元）",
        "交易后余额（元）",
        "关联账单编号",
        "发生时间",
        "备注"
      ],
      ...items.map((row) => [
        row.ledgerNo,
        row.orderNo,
        row.customerName,
        labelOf(depositTransactionTypeLabels, row.transactionType),
        labelOf(depositTransactionStatusLabels, row.transactionStatus),
        formatMoneyYuan(row.amount),
        formatMoneyYuan(row.balanceAfterAmount),
        row.relatedBillNo,
        formatDate(row.occurredAt),
        row.remark
      ])
    ];

    return csvExport("deposit-ledgers-detail", dateRange, rows);
  }

  async exportOverdueBillDetails(query: OverdueBillDetailQueryDto) {
    const { dateRange, items } = await this.collectDetailExportRows(query, (pageQuery) =>
      this.getOverdueBillDetails(pageQuery)
    );
    const rows: CsvRow[] = [
      ["逾期账单明细"],
      ["统计周期", dateRangeText(dateRange)],
      [],
      [
        "账单编号",
        "订单编号",
        "客户姓名",
        "账单类型",
        "剩余金额（元）",
        "到期日",
        "逾期天数",
        "逾期等级",
        "案件编号",
        "案件状态"
      ],
      ...items.map((row) => [
        row.billNo,
        row.orderNo,
        row.customerName,
        labelOf(billTypeLabels, row.billType),
        formatMoneyYuan(row.remainingAmount),
        formatDate(row.dueDate),
        row.overdueDays,
        labelOf(collectionLevelLabels, row.collectionLevel),
        row.caseNo,
        labelOf(collectionCaseStatusLabels, row.caseStatus)
      ])
    ];

    return csvExport("overdue-bills-detail", dateRange, rows);
  }

  async exportCollectionCaseDetails(query: CollectionCaseDetailQueryDto) {
    const { dateRange, items } = await this.collectDetailExportRows(query, (pageQuery) =>
      this.getCollectionCaseDetails(pageQuery)
    );
    const rows: CsvRow[] = [
      ["催收案件明细"],
      ["统计周期", dateRangeText(dateRange)],
      [],
      [
        "案件编号",
        "客户姓名",
        "订单编号",
        "逾期总金额（元）",
        "最大逾期天数",
        "逾期等级",
        "案件状态",
        "负责人",
        "下次跟进时间",
        "创建时间",
        "关闭时间"
      ],
      ...items.map((row) => [
        row.caseNo,
        row.customerName,
        row.orderNo,
        formatMoneyYuan(row.totalOverdueAmount),
        row.maxOverdueDays,
        labelOf(collectionLevelLabels, row.collectionLevel),
        labelOf(collectionCaseStatusLabels, row.caseStatus),
        row.assignedTo,
        formatDate(row.nextFollowUpAt),
        formatDate(row.createdAt),
        formatDate(row.closedAt)
      ])
    ];

    return csvExport("collection-cases-detail", dateRange, rows);
  }

  async exportVehicleDetails(query: VehicleDetailQueryDto) {
    const { dateRange, items } = await this.collectDetailExportRows(query, (pageQuery) =>
      this.getVehicleDetails(pageQuery)
    );
    const rows: CsvRow[] = [
      ["车辆明细"],
      ["统计周期", dateRangeText(dateRange)],
      [],
      [
        "车辆编号",
        "VIN",
        "车牌号",
        "品牌",
        "车系",
        "车型",
        "电池容量（kWh）",
        "电池使用方式",
        "车辆状态",
        "采购价（元）",
        "当前销售价（元）",
        "当前订单编号",
        "当前客户",
        "累计已收金额（元）",
        "最近交付时间",
        "最近退车时间",
        "创建时间"
      ],
      ...items.map((row) => [
        row.vehicleNo,
        row.vin,
        row.plateNo,
        row.brand,
        row.series,
        row.model ?? row.vehicleModel,
        row.batteryCapacityKwh,
        labelOf(vehicleBatteryUsageTypeLabels, row.batteryUsageType),
        labelOf(vehicleStatusLabels, row.vehicleStatus),
        formatMoneyYuan(row.purchasePriceAmount),
        formatMoneyYuan(row.currentSalePriceAmount),
        row.currentOrderNo,
        row.currentCustomerName,
        formatMoneyYuan(row.totalPaidAmount),
        formatDate(row.latestDeliveredAt),
        formatDate(row.latestReturnedAt),
        formatDate(row.createdAt)
      ])
    ];

    return csvExport("vehicles-detail", dateRange, rows);
  }

  private async collectDetailExportRows<TQuery extends ReportDateRangeQueryDto, TItem>(
    query: TQuery,
    loadPage: (query: TQuery & PaginationQuery) => Promise<PagedResult<TItem>>
  ) {
    const dateRange = resolveReportDateRange(query).output;
    const firstPage = await loadPage({
      ...query,
      page: 1,
      pageSize: DETAIL_EXPORT_PAGE_SIZE
    });

    if (firstPage.total > MAX_DETAIL_EXPORT_ROWS) {
      throw new BadRequestException(`明细数据超过 ${MAX_DETAIL_EXPORT_ROWS} 行，请缩小筛选范围后再导出。`);
    }

    const items = [...firstPage.items];
    for (let page = 2; items.length < firstPage.total; page += 1) {
      const nextPage = await loadPage({
        ...query,
        page,
        pageSize: DETAIL_EXPORT_PAGE_SIZE
      });
      if (nextPage.items.length === 0) {
        break;
      }
      items.push(...nextPage.items);
    }

    return { dateRange, items };
  }

  private async paidAmountByVehicle(
    range: ReturnType<typeof resolveReportDateRange>,
    vehicleIds: string[]
  ) {
    const result = new Map<string, number>();
    if (vehicleIds.length === 0) {
      return result;
    }

    const bills = await this.prisma.receivableBill.findMany({
      where: {
        deletedAt: null,
        dueDate: range.dateTimeFilter,
        order: { vehicleId: { in: vehicleIds } }
      },
      select: {
        order: { select: { vehicleId: true } },
        paidAmount: true
      }
    });

    for (const bill of bills) {
      if (bill.order.vehicleId) {
        result.set(bill.order.vehicleId, (result.get(bill.order.vehicleId) ?? 0) + toNumber(bill.paidAmount));
      }
    }

    return result;
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

const currentVehicleOrderStatuses = [
  OrderStatus.ACTIVE,
  OrderStatus.PENDING_DELIVERY,
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PENDING_SIGN,
  OrderStatus.PENDING_VEHICLE,
  OrderStatus.SUSPENDED
];

type CountGroup = { _count: { _all: number } } & Record<string, unknown>;
type AmountGroup = {
  _count: { _all: number };
  _sum: Record<string, bigint | number | null | undefined>;
} & Record<string, unknown>;
type EntitlementAmountGroup = {
  _count: { _all: number };
  _sum: Record<string, unknown>;
} & Record<string, unknown>;
type EntitlementCountGroup = { _count: { _all: number } } & Record<string, unknown>;
type ReportDateRangeOutput = { endDate: string; startDate: string };
type PaginationQuery = { page?: number; pageSize?: number };
type ResolvedPagination = { page: number; pageSize: number; skip: number };
type PagedResult<T> = { items: T[]; page: number; pageSize: number; total: number };

function csvExport(prefix: string, dateRange: ReportDateRangeOutput, rows: CsvRow[]) {
  return {
    content: withUtf8Bom(toCsv(rows)),
    filename: `${prefix}-${compactDate(dateRange.startDate)}-${compactDate(dateRange.endDate)}.csv`
  };
}

function dateRangeText(dateRange: ReportDateRangeOutput) {
  return `${dateRange.startDate} 至 ${dateRange.endDate}`;
}

function resolvePagination(query: PaginationQuery): ResolvedPagination {
  const page = clampInteger(query.page, 1, Number.MAX_SAFE_INTEGER, 1);
  const pageSize = clampInteger(query.pageSize, 1, 100, 20);

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize
  };
}

function pagedResult<T>(items: T[], total: number, pagination: ResolvedPagination) {
  return {
    items,
    total,
    page: pagination.page,
    pageSize: pagination.pageSize
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numberValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numberValue));
}

function containsText(value: string) {
  return { contains: value.trim(), mode: "insensitive" as const };
}

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

function overdueDueDateFilter(
  query: Pick<OverdueBillDetailQueryDto, "maxOverdueDays" | "minOverdueDays">,
  range: ReturnType<typeof resolveReportDateRange>
) {
  const filter: Prisma.DateTimeFilter = { ...range.dateTimeFilter };

  if (query.minOverdueDays) {
    filter.lte = new Date(range.endExclusive.getTime() - query.minOverdueDays * DAY_MS);
  }
  if (query.maxOverdueDays) {
    filter.gt = new Date(range.endExclusive.getTime() - (query.maxOverdueDays + 1) * DAY_MS);
  }

  return filter;
}

function overdueDaysBetween(dueDate: Date, endExclusive: Date) {
  return Math.max(0, Math.floor((endExclusive.getTime() - dueDate.getTime()) / DAY_MS));
}

function collectionLevelForDays(overdueDays: number) {
  if (overdueDays <= 3) {
    return CollectionLevel.D1;
  }
  if (overdueDays <= 7) {
    return CollectionLevel.D2;
  }
  if (overdueDays <= 15) {
    return CollectionLevel.D3;
  }
  if (overdueDays <= 30) {
    return CollectionLevel.D4;
  }
  return CollectionLevel.D5;
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

function entitlementGrantReportWhere(
  query: EntitlementReportQueryDto,
  range: ReturnType<typeof resolveReportDateRange>
): Prisma.OrderEntitlementGrantWhereInput {
  return {
    createdAt: range.dateTimeFilter,
    deletedAt: null,
    ...(query.entitlementType ? { entitlementType: query.entitlementType } : {}),
    ...(query.unit ? { unit: query.unit } : {}),
    ...(query.grantStatus ? { status: query.grantStatus } : {}),
    ...(query.orderStatus ? { order: { orderStatus: query.orderStatus } } : {})
  };
}

function entitlementUsageReportWhere(
  query: EntitlementReportQueryDto,
  range: ReturnType<typeof resolveReportDateRange>
): Prisma.OrderEntitlementUsageWhereInput {
  return {
    deletedAt: null,
    occurredAt: range.dateTimeFilter,
    ...(query.entitlementType ? { entitlementType: query.entitlementType } : {}),
    ...(query.unit ? { unit: query.unit } : {}),
    ...(query.grantStatus ? { grant: { status: query.grantStatus } } : {}),
    ...(query.orderStatus ? { order: { orderStatus: query.orderStatus } } : {})
  };
}

function usageAmountRows<T extends Record<string, string>>(
  enumObject: T,
  rows: EntitlementAmountGroup[],
  sourceField: string
) {
  const groupByKey = new Map(rows.map((row) => [String(row[sourceField]), row]));

  return Object.values(enumObject).map((value) => {
    const row = groupByKey.get(value);

    return {
      [sourceField]: value,
      count: row?._count._all ?? 0,
      usedAmount: amountToNumber(row?._sum.usedAmount)
    };
  });
}

function exhaustedCountForTypeUnit(
  rows: EntitlementCountGroup[],
  entitlementType: EntitlementType,
  unit: EntitlementUnit
) {
  const row = rows.find((item) => item.entitlementType === entitlementType && item.unit === unit);
  return row?._count._all ?? 0;
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

function amountToNumber(value: unknown) {
  return decimalToNumber(value) ?? 0;
}

function nullableAmount(value: unknown) {
  return decimalToNumber(value);
}

function decimalToNumber(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function sumNumbers(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0);
}
