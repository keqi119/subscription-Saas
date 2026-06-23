import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
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
  Prisma,
  RevenueRightAssignmentStatus,
  RevenueRightAssignmentType,
  RevenueRightTargetType,
  RevenueShareBasis,
  RevenueShareRuleStatus,
  RevenueShareRuleType,
  VehicleAssetCostProfileStatus,
  VehicleAcquisitionMode,
  VehicleBaasContractStatus,
  VehicleBaasCostRecordStatus,
  VehicleCapitalEventStatus,
  VehicleDepreciationMethod,
  VehicleDepreciationPolicyStatus,
  VehicleDepreciationRecordStatus,
  VehicleDepreciationScheduleStatus,
  VehicleModel,
  VehicleResidualForecastPointStatus,
  VehicleResidualForecastStatus,
  VehicleStatus
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import {
  buildVehicleAssetCostProfilePreview,
  buildVehicleAssetPeriodCost,
  MANUAL_DEPRECIATION_UNSUPPORTED_REASON
} from "../vehicle/asset-cost-profile-calculation";
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
  AssetProfitabilityQueryDto,
  AssetProfitabilityVehicleDetailQueryDto,
  AssetProfitabilityVehicleListQueryDto,
  AssetReturnTrialQueryDto,
  AssetReturnTrialVehicleDetailQueryDto,
  AssetReturnTrialVehicleListQueryDto,
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
  assetProfitabilityLifecycleNodeLabels,
  billStatusLabels,
  billTypeLabels,
  capitalCostSourceLabels,
  collectionCaseStatusLabels,
  collectionLevelLabels,
  contractStatusLabels,
  depositTransactionStatusLabels,
  depositTransactionTypeLabels,
  forecastResidualAmountSourceLabels,
  financingInstrumentTypeLabels,
  labelOf,
  marketResidualSourceLabels,
  orderSourceLabels,
  orderStatusLabels,
  residualForecastInterpolationMethodLabels,
  revenueRightAssigneeTypeLabels,
  revenueRightAssignmentStatusLabels,
  revenueRightAssignmentTypeLabels,
  revenueRightTargetTypeLabels,
  revenueShareBasisLabels,
  revenueShareRuleTypeLabels,
  salePriceStatusLabels,
  vehicleAssetCostProfileStatusLabels,
  vehicleBaasBillingCycleLabels,
  vehicleBaasContractStatusLabels,
  vehicleBaasCostSourceLabels,
  vehicleBaasCostRecordStatusLabels,
  vehicleDamageLevelLabels,
  vehicleDamageResponsiblePartyLabels,
  vehicleDamageTypeLabels,
  vehicleDepreciationSourceLabels,
  vehicleDepreciationMethodLabels,
  vehicleResidualCurveMethodLabels,
  vehicleResidualCurveStatusLabels,
  vehicleResidualForecastMethodLabels,
  vehicleResidualForecastPointStatusLabels,
  vehicleResidualForecastStatusLabels,
  vehicleReturnDamageStatusLabels,
  vehicleBatteryUsageTypeLabels,
  vehicleSalePriceReviewTypeLabels,
  vehicleStatusLabels
} from "./report-labels";

const BUSINESS_UTC_OFFSET_MINUTES = 8 * 60;
const DEFAULT_REPORT_RANGE_DAYS = 30;
const DETAIL_EXPORT_PAGE_SIZE = 100;
const MAX_DETAIL_EXPORT_ROWS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_OFFSET_MS = BUSINESS_UTC_OFFSET_MINUTES * 60 * 1000;

const reportModelDefinitionSelect = {
  customerDisplayName: true,
  deletedAt: true,
  displayName: true,
  id: true,
  legacyVehicleModel: true,
  modelCode: true
} satisfies Prisma.VehicleModelDefinitionSelect;

type ReportModelDefinition = Prisma.VehicleModelDefinitionGetPayload<{
  select: typeof reportModelDefinitionSelect;
}>;

@Injectable()
export class ReportService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveReportModelDefinition(modelDefinitionId: string | undefined, vehicleModel: VehicleModel | undefined) {
    if (!modelDefinitionId) {
      return null;
    }

    const definition = await this.prisma.vehicleModelDefinition.findFirst({
      select: reportModelDefinitionSelect,
      where: {
        deletedAt: null,
        id: modelDefinitionId
      }
    });

    if (!definition) {
      throw new BadRequestException("车型主数据不存在");
    }
    if (vehicleModel && vehicleModel !== definition.legacyVehicleModel) {
      throw new BadRequestException("modelDefinitionId 与 vehicleModel 不一致");
    }

    return definition;
  }

  private async reportVehicleModelWhere(
    query: Pick<AssetProfitabilityQueryDto, "modelDefinitionId" | "vehicleModel">
  ): Promise<Prisma.VehicleWhereInput> {
    const definition = await this.resolveReportModelDefinition(query.modelDefinitionId, query.vehicleModel);
    if (!definition) {
      return query.vehicleModel ? { vehicleModel: query.vehicleModel } : {};
    }

    return {
      OR: [
        { modelDefinitionId: definition.id },
        ...(definition.legacyVehicleModel
          ? [{ modelDefinitionId: null, vehicleModel: definition.legacyVehicleModel }]
          : [])
      ]
    };
  }

  private async reportOrderModelWhere(
    query: Pick<OrderReportQueryDto, "modelDefinitionId" | "vehicleModel">
  ): Promise<Prisma.SubscriptionOrderWhereInput> {
    const definition = await this.resolveReportModelDefinition(query.modelDefinitionId, query.vehicleModel);
    if (!definition) {
      return query.vehicleModel ? { vehicleModel: query.vehicleModel } : {};
    }

    return {
      OR: [
        { vehicle: { modelDefinitionId: definition.id } },
        ...(definition.legacyVehicleModel ? [{ vehicleModel: definition.legacyVehicleModel }] : [])
      ]
    };
  }

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
    const modelWhere = await this.reportOrderModelWhere(query);
    const where: Prisma.SubscriptionOrderWhereInput = {
      createdAt: range.dateTimeFilter,
      deletedAt: null,
      ...modelWhere,
      ...(query.orderSource ? { orderSource: query.orderSource } : {}),
      ...(query.orderStatus ? { orderStatus: query.orderStatus } : {}),
      ...(query.productId ? { productId: query.productId } : {})
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
      byVehicleModel: enumCountRows(
        VehicleModel,
        vehicleModelGroups,
        "vehicleModel",
        "vehicleModel"
      ).filter((row) => row.count > 0),
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
      byCollectionLevel: overdueGroupRows(
        CollectionLevel,
        levelGroups,
        "collectionLevel",
        "collectionLevel"
      ),
      byCaseStatus: overdueGroupRows(
        CollectionCaseStatus,
        statusGroups,
        "caseStatus",
        "caseStatus"
      ),
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

  async getAssetProfitabilitySummary(query: AssetProfitabilityQueryDto) {
    const { dateRange, rows } = await this.buildAssetProfitabilityVehicleRows(query);
    const simpleReturnRates = rows
      .map((row) => row.simpleReturnRate)
      .filter((value): value is number => value !== null);

    return {
      dateRange,
      totalVehicles: rows.length,
      totalPurchasePriceAmount: sumNumbers(rows.map((row) => row.purchasePriceAmount)),
      totalCurrentSalePriceAmount: sumNumbers(rows.map((row) => row.currentSalePriceAmount)),
      rentalPaidAmount: sumNumbers(rows.map((row) => row.rentalPaidAmount)),
      damagePaidAmount: sumNumbers(rows.map((row) => row.damagePaidAmount)),
      depositCollectedAmount: sumNumbers(rows.map((row) => row.depositCollectedAmount)),
      totalReceivableAmount: sumNumbers(rows.map((row) => row.totalReceivableAmount)),
      totalPaidAmount: sumNumbers(rows.map((row) => row.totalPaidAmount)),
      totalRemainingAmount: sumNumbers(rows.map((row) => row.totalRemainingAmount)),
      totalLeasedDays: sumNumbers(rows.map((row) => row.leasedDays)),
      averageUtilizationRate: average(rows.map((row) => row.utilizationRate)),
      // simpleReturnRate is a simplified operating return rate, not accounting ROA or ROE.
      averageSimpleReturnRate: averageNullable(simpleReturnRates)
    };
  }

  async getAssetProfitabilityVehicles(query: AssetProfitabilityVehicleListQueryDto) {
    const pagination = resolvePagination(query);
    const { rows } = await this.buildAssetProfitabilityVehicleRows(query);

    return pagedResult(
      rows.slice(pagination.skip, pagination.skip + pagination.pageSize),
      rows.length,
      pagination
    );
  }

  async getAssetProfitabilityVehicleDetail(
    id: string,
    query: AssetProfitabilityVehicleDetailQueryDto
  ) {
    const range = resolveReportDateRange(query);
    const vehicle = await this.prisma.vehicle.findFirst({
      select: assetProfitabilityVehicleDetailSelect,
      where: { deletedAt: null, id }
    });

    if (!vehicle) {
      throw new NotFoundException("Vehicle not found.");
    }

    const metricsByVehicleId = await this.buildAssetProfitabilityMetrics([vehicle], range);
    const metrics = metricsByVehicleId.get(vehicle.id) ?? emptyAssetProfitabilityMetrics();
    const baseRow = assetProfitabilityVehicleRow(vehicle, metrics);

    return {
      dateRange: range.output,
      vehicle: {
        vehicleId: vehicle.id,
        vehicleNo: vehicle.vehicleNo,
        vin: vehicle.vin,
        plateNo: vehicle.plateNo,
        brand: vehicle.brand,
        series: vehicle.series,
        model: vehicle.model,
        modelDefinition: reportModelDefinitionSummary(vehicle.modelDefinition),
        modelDefinitionId: vehicle.modelDefinitionId,
        modelDisplayName: reportVehicleModelDisplayName(vehicle.modelDefinition, vehicle.vehicleModel),
        vehicleModel: vehicle.vehicleModel,
        batteryCapacityKwh: decimalToNumber(vehicle.batteryCapacityKwh),
        batteryUsageType: vehicle.batteryUsageType,
        salePriceStatus: vehicle.salePriceStatus,
        vehicleStatus: vehicle.status
      },
      assetValue: {
        purchasePriceAmount: baseRow.purchasePriceAmount,
        currentSalePriceAmount: baseRow.currentSalePriceAmount,
        currentSalePriceReviewedAt: vehicle.currentSalePriceReviewedAt,
        currentSalePriceStatus: vehicle.salePriceStatus
      },
      summary: {
        rentalPaidAmount: baseRow.rentalPaidAmount,
        damagePaidAmount: baseRow.damagePaidAmount,
        otherPaidAmount: baseRow.otherPaidAmount,
        depositCollectedAmount: baseRow.depositCollectedAmount,
        totalReceivableAmount: baseRow.totalReceivableAmount,
        totalPaidAmount: baseRow.totalPaidAmount,
        totalRemainingAmount: baseRow.totalRemainingAmount,
        leasedDays: baseRow.leasedDays,
        operatingDays: baseRow.operatingDays,
        utilizationRate: baseRow.utilizationRate,
        // simpleReturnRate is a simplified operating return rate, not accounting ROA or ROE.
        simpleReturnRate: baseRow.simpleReturnRate
      },
      orderCycles: metrics.orders.map((order) => {
        const orderMetrics =
          metrics.orderMetricsById.get(order.id) ?? emptyOrderProfitabilityMetrics();

        return {
          orderId: order.id,
          orderNo: order.orderNo,
          customerName: order.customer.name,
          orderStatus: order.orderStatus,
          deliveredAt: order.actualDeliveryAt,
          returnedAt: order.actualReturnAt,
          leasedDays: leasedDaysForOrder(order, range),
          monthlyFeeAmount: toNumber(order.monthlyFeeAmount),
          rentalPaidAmount: orderMetrics.rentalPaidAmount,
          damagePaidAmount: orderMetrics.damagePaidAmount
        };
      }),
      bills: metrics.bills.map((bill) => ({
        billId: bill.id,
        billNo: bill.billNo,
        orderId: bill.orderId,
        orderNo: bill.order.orderNo,
        billType: bill.billType,
        billStatus: bill.billStatus,
        amount: toNumber(bill.amount),
        paidAmount: toNumber(bill.paidAmount),
        remainingAmount: toNumber(bill.remainingAmount),
        dueDate: bill.dueDate,
        periodStart: bill.billPeriodStart,
        periodEnd: bill.billPeriodEnd
      })),
      lifecycleNodes: assetProfitabilityLifecycleNodes(vehicle),
      damageRecords: vehicle.returnDamages.map((damage) => ({
        damageId: damage.id,
        orderId: damage.orderId,
        damageType: damage.damageType,
        damageLevel: damage.damageLevel,
        description: damage.description,
        estimatedRepairAmount: toNumber(damage.estimatedRepairAmount),
        responsibleParty: damage.responsibleParty,
        returnNo: damage.vehicleReturn?.returnNo ?? null,
        status: damage.status,
        createdAt: damage.createdAt
      })),
      salePriceHistory: vehicle.salePriceHistories.map((history) => ({
        id: history.id,
        beforeSalePriceAmount: toNumber(history.beforeSalePriceAmount),
        afterSalePriceAmount: toNumber(history.afterSalePriceAmount),
        reviewType: history.reviewType,
        effectiveFrom: history.effectiveFrom,
        effectiveTo: history.effectiveTo,
        reason: history.reason,
        reviewQuarter: history.reviewQuarter,
        remark: history.remark,
        createdAt: history.createdAt
      }))
    };
  }

  async getAssetReturnTrialSummary(query: AssetReturnTrialQueryDto) {
    const { dateRange, rows } = await this.buildAssetReturnTrialVehicleRows(query);
    const costCalculatedRows = rows.filter((row) => row.operatingCostAmount !== null);
    const roaRows = costCalculatedRows.filter(
      (row) => row.purchasePriceAmount > 0 && row.trialNetOperatingIncomeAmount !== null
    );
    const trialNetOperatingIncomeAmount =
      costCalculatedRows.length === 0
        ? null
        : sumNumbers(
            costCalculatedRows.map((row) => row.trialNetOperatingIncomeAmount ?? 0)
          );
    const roaPurchasePriceAmount = sumNumbers(roaRows.map((row) => row.purchasePriceAmount));
    const trialRoa =
      trialNetOperatingIncomeAmount === null || roaPurchasePriceAmount <= 0
        ? null
        : trialNetOperatingIncomeAmount / roaPurchasePriceAmount;
    const analysisDays = inclusiveBusinessDays(dateRange.startDate, dateRange.endDate);
    const roeCalculatedRows = rows.filter(
      (row) => row.roeTrial !== null && row.platformNetIncomeAmount !== null && row.roeEquityBaseAmount !== null
    );
    const platformNetIncomeAmount =
      roeCalculatedRows.length === 0
        ? null
        : sumNumbers(roeCalculatedRows.map((row) => row.platformNetIncomeAmount ?? 0));
    const roeEquityBaseAmount = sumNumbers(
      roeCalculatedRows.map((row) => row.roeEquityBaseAmount ?? 0)
    );
    const roeTrial =
      platformNetIncomeAmount === null || roeEquityBaseAmount <= 0
        ? null
        : platformNetIncomeAmount / roeEquityBaseAmount;
    const baasCostAmount = sumNumbers(rows.map((row) => row.baasCostAmount));
    const residualForecastRows = rows.filter((row) => row.forecastResidualAmount !== null);
    const residualForecastUnsupportedVehicleCount = rows.filter(
      (row) => row.residualForecastUnavailableReason === RESIDUAL_FORECAST_UNSUPPORTED_REASON
    ).length;
    const residualSensitivityRows = residualForecastRows.filter(
      (row) =>
        row.residualSensitivityNetIncomeAmount !== null &&
        row.roeEquityBaseAmount !== null &&
        row.roeEquityBaseAmount > 0
    );
    const residualSensitivityNetIncomeAmount =
      residualSensitivityRows.length === 0
        ? null
        : sumNumbers(
            residualSensitivityRows.map((row) => row.residualSensitivityNetIncomeAmount ?? 0)
          );
    const residualSensitivityEquityBaseAmount = sumNumbers(
      residualSensitivityRows.map((row) => row.roeEquityBaseAmount ?? 0)
    );
    const residualSensitivityRoeTrial =
      residualSensitivityNetIncomeAmount === null || residualSensitivityEquityBaseAmount <= 0
        ? null
        : residualSensitivityNetIncomeAmount / residualSensitivityEquityBaseAmount;
    const marketCalibratedRows = rows.filter(
      (row) =>
        row.marketCalibratedPlatformNetIncomeAmount !== null &&
        row.marketResidualDeltaAmount !== null
    );
    const marketCalibratedRoeRows = marketCalibratedRows.filter(
      (row) =>
        row.marketCalibratedRoeTrial !== null &&
        row.roeEquityBaseAmount !== null &&
        row.roeEquityBaseAmount > 0
    );
    const marketCalibratedRoaRows = marketCalibratedRows.filter(
      (row) =>
        row.marketCalibratedTrialRoa !== null &&
        row.purchasePriceAmount > 0
    );
    const marketResidualBaseAmount =
      marketCalibratedRows.length === 0
        ? null
        : sumNumbers(marketCalibratedRows.map((row) => row.marketResidualBaseAmount ?? 0));
    const marketCalibratedResidualAmount =
      marketCalibratedRows.length === 0
        ? null
        : sumNumbers(
            marketCalibratedRows.map((row) => row.marketCalibratedResidualAmount ?? 0)
          );
    const marketResidualDeltaAmount =
      marketCalibratedRows.length === 0
        ? null
        : sumNumbers(marketCalibratedRows.map((row) => row.marketResidualDeltaAmount ?? 0));
    const marketCalibratedPlatformNetIncomeAmount =
      marketCalibratedRows.length === 0
        ? null
        : sumNumbers(
            marketCalibratedRows.map((row) => row.marketCalibratedPlatformNetIncomeAmount ?? 0)
          );
    const marketCalibratedRoeEquityBaseAmount = sumNumbers(
      marketCalibratedRoeRows.map((row) => row.roeEquityBaseAmount ?? 0)
    );
    const marketCalibratedRoeNetIncomeAmount =
      marketCalibratedRoeRows.length === 0
        ? null
        : sumNumbers(
            marketCalibratedRoeRows.map((row) => row.marketCalibratedPlatformNetIncomeAmount ?? 0)
          );
    const marketCalibratedRoeTrial =
      marketCalibratedRoeNetIncomeAmount === null || marketCalibratedRoeEquityBaseAmount <= 0
        ? null
        : marketCalibratedRoeNetIncomeAmount / marketCalibratedRoeEquityBaseAmount;
    const marketCalibratedRoaPurchasePriceAmount = sumNumbers(
      marketCalibratedRoaRows.map((row) => row.purchasePriceAmount)
    );
    const marketCalibratedRoaNetIncomeAmount =
      marketCalibratedRoaRows.length === 0
        ? null
        : sumNumbers(
            marketCalibratedRoaRows.map((row) => row.marketCalibratedPlatformNetIncomeAmount ?? 0)
          );
    const marketCalibratedTrialRoa =
      marketCalibratedRoaNetIncomeAmount === null || marketCalibratedRoaPurchasePriceAmount <= 0
        ? null
        : marketCalibratedRoaNetIncomeAmount / marketCalibratedRoaPurchasePriceAmount;

    return {
      annualizedTrialRoa:
        trialRoa === null || analysisDays <= 0 ? null : (trialRoa * 365) / analysisDays,
      annualizedRoeTrial:
        roeTrial === null || analysisDays <= 0 ? null : (roeTrial * 365) / analysisDays,
      assignedOutRevenueAmount: sumNumbers(rows.map((row) => row.assignedOutRevenueAmount)),
      baasAdjustedAnnualizedRoeTrial:
        roeTrial === null || analysisDays <= 0 ? null : (roeTrial * 365) / analysisDays,
      baasAdjustedPlatformNetIncomeAmount: platformNetIncomeAmount,
      baasAdjustedRoeTrial: roeTrial,
      baasConfirmedCostAmount: sumNumbers(rows.map((row) => row.baasConfirmedCostAmount)),
      baasCostAmount,
      baasCostAllocationMethod: BAAS_COST_ALLOCATION_METHOD,
      baasCostFullRecordAmount: sumNumbers(rows.map((row) => row.baasCostFullRecordAmount)),
      baasCostRecordCount: sumNumbers(rows.map((row) => row.baasCostRecordCount)),
      baasCostVehicleCount: rows.filter((row) => row.baasCostRecordCount > 0).length,
      baasOverdueCostAmount: sumNumbers(rows.map((row) => row.baasOverdueCostAmount)),
      baasPaidCostAmount: sumNumbers(rows.map((row) => row.baasPaidCostAmount)),
      baasScheduledCostAmount: sumNumbers(rows.map((row) => row.baasScheduledCostAmount)),
      capitalCostAmount: sumNullable(costCalculatedRows.map((row) => row.capitalCostAmount)),
      costCalculatedVehicleCount: costCalculatedRows.length,
      costUnavailableVehicleCount: rows.length - costCalculatedRows.length,
      currentSalePriceAmount: sumNumbers(rows.map((row) => row.currentSalePriceAmount)),
      damagePaidAmount: sumNumbers(rows.map((row) => row.damagePaidAmount)),
      dateRange,
      debtInterestCostAmount: sumNullable(rows.map((row) => row.debtInterestCostAmount)),
      debtPrincipalAmount: sumNumbers(rows.map((row) => row.debtPrincipalAmount)),
      depositCollectedAmount: sumNumbers(rows.map((row) => row.depositCollectedAmount)),
      depreciationAmount: sumNullable(costCalculatedRows.map((row) => row.depreciationAmount)),
      depreciationCostAmount: sumNullable(
        costCalculatedRows.map((row) => row.depreciationCostAmount)
      ),
      depreciationRecordAmount: sumNumbers(rows.map((row) => row.recordDepreciationAmount)),
      depreciationRecordCount: sumNumbers(rows.map((row) => row.depreciationRecordCount)),
      depreciationSourceBreakdown: depreciationSourceBreakdownRows(rows),
      depreciationUnavailableVehicleCount: rows.filter(
        (row) => row.depreciationSource === DEPRECIATION_SOURCE_UNAVAILABLE
      ).length,
      depreciationVehicleCount: rows.filter((row) => row.depreciationRecordCount > 0).length,
      externalLeaseCostAmount: sumNumbers(rows.map((row) => row.externalLeaseCostAmount)),
      insuranceCostAmount: sumNullable(costCalculatedRows.map((row) => row.insuranceCostAmount)),
      legacyDepreciationAmount: sumNumbers(rows.map((row) => row.legacyDepreciationAmount ?? 0)),
      maintenanceReserveCostAmount: sumNullable(
        costCalculatedRows.map((row) => row.maintenanceReserveCostAmount)
      ),
      marketCalibratedAnnualizedRoeTrial:
        marketCalibratedRoeTrial === null || analysisDays <= 0
          ? null
          : (marketCalibratedRoeTrial * 365) / analysisDays,
      marketCalibratedPlatformNetIncomeAmount,
      marketCalibratedResidualAmount,
      marketCalibratedRoeTrial,
      marketCalibratedTrialRoa,
      marketCalibratedUnavailableVehicleCount: rows.length - marketCalibratedRows.length,
      marketCalibratedVehicleCount: marketCalibratedRows.length,
      marketResidualBaseAmount,
      marketResidualDeltaAmount,
      operatingCostAmount: sumNullable(costCalculatedRows.map((row) => row.operatingCostAmount)),
      operatingRevenueAmount: sumNumbers(rows.map((row) => row.operatingRevenueAmount)),
      otherCostAmount: sumNullable(costCalculatedRows.map((row) => row.otherCostAmount)),
      otherPaidAmount: sumNumbers(rows.map((row) => row.otherPaidAmount)),
      ownerShareAmount: sumNumbers(rows.map((row) => row.ownerShareAmount)),
      platformNetIncomeAmount,
      platformRetainedRevenueAmount: sumNumbers(rows.map((row) => row.platformRetainedRevenueAmount)),
      pledgedRevenueAmount: sumNumbers(rows.map((row) => row.pledgedRevenueAmount)),
      purchasePriceAmount: sumNumbers(rows.map((row) => row.purchasePriceAmount)),
      rentalPaidAmount: sumNumbers(rows.map((row) => row.rentalPaidAmount)),
      forecastResidualAmount: sumNullable(
        residualForecastRows.map((row) => row.forecastResidualAmount)
      ),
      forecastLowerBoundAmount: sumNullable(
        residualForecastRows.map((row) => row.forecastLowerBoundAmount)
      ),
      forecastUpperBoundAmount: sumNullable(
        residualForecastRows.map((row) => row.forecastUpperBoundAmount)
      ),
      residualDeltaToCostProfileAmount: sumNullable(
        residualForecastRows.map((row) => row.residualDeltaToCostProfileAmount)
      ),
      residualDeltaToCurrentSalePriceAmount: sumNullable(
        residualForecastRows.map((row) => row.residualDeltaToCurrentSalePriceAmount)
      ),
      residualForecastAdoptedVehicleCount: residualForecastRows.filter(
        (row) => row.forecastResidualAmountSource === "ADOPTED"
      ).length,
      residualForecastMissingVehicleCount:
        rows.length - residualForecastRows.length - residualForecastUnsupportedVehicleCount,
      residualForecastUnsupportedVehicleCount,
      residualForecastVehicleCount: residualForecastRows.length,
      residualForecastWarnings: uniqueStrings(
        rows.flatMap((row) => row.residualForecastWarnings)
      ),
      residualCalibrationPercent: resolveResidualCalibrationPercent(query),
      residualSensitivityAnnualizedRoeTrial:
        residualSensitivityRoeTrial === null || analysisDays <= 0
          ? null
          : (residualSensitivityRoeTrial * 365) / analysisDays,
      residualSensitivityNetIncomeAmount,
      residualSensitivityRoeTrial,
      roeCalculatedVehicleCount: roeCalculatedRows.length,
      roeDataReady: roeTrial !== null,
      roeEquityBaseAmount,
      roeMissingReasons: uniqueStrings(rows.flatMap((row) => row.roeMissingReasons)),
      roeTrial,
      roeUnavailableReason: roeTrial === null ? uniqueStrings(rows.flatMap((row) => row.roeMissingReasons)).join("；") || ROE_UNAVAILABLE_REASON : null,
      roeUnavailableVehicleCount: rows.length - roeCalculatedRows.length,
      roeWarnings: uniqueStrings(rows.flatMap((row) => row.roeWarnings)),
      trialNetOperatingIncomeAmount,
      trialRoa,
      vehicleCount: rows.length,
      vehicleMissingCostProfileCount: rows.filter((row) => row.costProfileMissing).length,
      vehicleWithCostProfileCount: rows.filter((row) => !row.costProfileMissing).length
    };
  }

  async getAssetReturnTrialVehicles(query: AssetReturnTrialVehicleListQueryDto) {
    const pagination = resolvePagination(query);
    const { rows } = await this.buildAssetReturnTrialVehicleRows(query);

    return pagedResult(
      rows.slice(pagination.skip, pagination.skip + pagination.pageSize),
      rows.length,
      pagination
    );
  }

  async getAssetReturnTrialVehicleDetail(
    id: string,
    query: AssetReturnTrialVehicleDetailQueryDto
  ) {
    const range = resolveReportDateRange(query);
    const vehicle = await this.prisma.vehicle.findFirst({
      select: assetReturnTrialVehicleDetailSelect,
      where: { ...assetProfitabilityVehicleWhere(query), id }
    });

    if (!vehicle) {
      throw new NotFoundException("Vehicle not found.");
    }

    const residualHorizonMonth = resolveResidualHorizonMonth(query);
    const residualCalibrationPercent = resolveResidualCalibrationPercent(query);
    const [
      metricsByVehicleId,
      roeContextsByVehicleId,
      residualContextsByVehicleId,
      depreciationContextsByVehicleId,
      baasContextsByVehicleId
    ] = await Promise.all([
      this.buildAssetProfitabilityMetrics([vehicle], range),
      this.buildAssetReturnRoeContexts([vehicle], range),
      this.buildAssetReturnResidualForecastContexts([vehicle], residualHorizonMonth),
      this.buildAssetReturnDepreciationContexts([vehicle], range),
      this.buildAssetReturnBaasContexts([vehicle], range)
    ]);
    const metrics = metricsByVehicleId.get(vehicle.id) ?? emptyAssetProfitabilityMetrics();
    const roeContext = roeContextsByVehicleId.get(vehicle.id) ?? emptyAssetReturnRoeContext(vehicle.id);
    const residualContext =
      residualContextsByVehicleId.get(vehicle.id) ??
      emptyAssetReturnResidualForecastContext(vehicle.id, residualHorizonMonth);
    const depreciationContext =
      depreciationContextsByVehicleId.get(vehicle.id) ??
      emptyAssetReturnDepreciationContext(vehicle.id);
    const baasContext =
      baasContextsByVehicleId.get(vehicle.id) ?? emptyAssetReturnBaasContext(vehicle.id);
    const analysisDays = inclusiveBusinessDays(range.output.startDate, range.output.endDate);
    const row = attachAssetReturnBaasFields(
      assetReturnTrialVehicleRow(
        vehicle,
        metrics,
        range,
        roeContext,
        residualContext,
        depreciationContext
      ),
      baasContext,
      analysisDays,
      residualCalibrationPercent
    );
    const profile = activeCostProfileFor(vehicle);
    const baasAdjustedReturn = {
      baasAdjustedAnnualizedRoeTrial: row.baasAdjustedAnnualizedRoeTrial,
      baasAdjustedPlatformNetIncomeAmount: row.baasAdjustedPlatformNetIncomeAmount,
      baasAdjustedRoeTrial: row.baasAdjustedRoeTrial,
      mainReturnAfterBaas: {
        annualizedRoeTrial: row.annualizedRoeTrial,
        annualizedTrialRoa: row.annualizedTrialRoa,
        platformNetIncomeAmount: row.platformNetIncomeAmount,
        roeTrial: row.roeTrial,
        trialNetOperatingIncomeAmount: row.trialNetOperatingIncomeAmount,
        trialRoa: row.trialRoa
      },
      platformNetIncomeAmount: row.platformNetIncomeAmount
    };

    return {
      baasAdjustedReturn,
      baasCostRecords: baasContext.records.map(assetReturnBaasCostRecordView),
      baasCostSummary: {
        allocationMethod: row.baasCostAllocationMethod,
        confirmedCostAmount: row.baasConfirmedCostAmount,
        costAmount: row.baasCostAmount,
        fullCostRecordAmount: row.baasCostFullRecordAmount,
        costRecordCount: row.baasCostRecordCount,
        overdueCostAmount: row.baasOverdueCostAmount,
        paidCostAmount: row.baasPaidCostAmount,
        scheduledCostAmount: row.baasScheduledCostAmount
      },
      baasCurrentContract: assetReturnBaasContractView(baasContext.currentContract),
      depreciationPolicy: assetReturnDepreciationPolicyView(depreciationContext.policy),
      depreciationRecords: depreciationContext.records.map(assetReturnDepreciationRecordView),
      depreciationSummary: {
        amount: row.depreciationAmount,
        legacyAmount: row.legacyDepreciationAmount,
        missingReasons: row.depreciationMissingReasons,
        policyId: row.depreciationPolicyId,
        policyNo: row.depreciationPolicyNo,
        recordAmount: row.recordDepreciationAmount,
        recordCount: row.depreciationRecordCount,
        source: row.depreciationSource,
        unconfirmedScheduleCount: depreciationContext.summary.unconfirmedScheduleCount,
        warnings: depreciationContext.summary.warnings
      },
      marketCalibratedDepreciation: {
        accountingPlatformNetIncomeAmount: row.platformNetIncomeAmount,
        accountingResidualBaselineAmount: row.accountingResidualBaselineAmount,
        accountingRoeTrial: row.roeTrial,
        accountingTrialRoa: row.trialRoa,
        marketCalibratedAnnualizedRoeTrial: row.marketCalibratedAnnualizedRoeTrial,
        marketCalibratedPlatformNetIncomeAmount: row.marketCalibratedPlatformNetIncomeAmount,
        marketCalibratedResidualAmount: row.marketCalibratedResidualAmount,
        marketCalibratedRoeTrial: row.marketCalibratedRoeTrial,
        marketCalibratedTrialRoa: row.marketCalibratedTrialRoa,
        marketResidualBaseAmount: row.marketResidualBaseAmount,
        marketResidualDeltaAmount: row.marketResidualDeltaAmount,
        residualCalibrationPercent: row.residualCalibrationPercent,
        residualHorizonMonth: row.residualForecastHorizonMonth,
        residualSource: row.marketResidualSource,
        unavailableReason: row.marketCalibrationUnavailableReason
      },
      bills: metrics.bills.map((bill) => ({
        amount: toNumber(bill.amount),
        billId: bill.id,
        billNo: bill.billNo,
        billStatus: bill.billStatus,
        billType: bill.billType,
        includedInOperatingRevenue: operatingRevenueBillTypes.includes(bill.billType),
        orderId: bill.orderId,
        orderNo: bill.order.orderNo,
        paidAmount: toNumber(bill.paidAmount),
        periodEnd: bill.billPeriodEnd,
        periodStart: bill.billPeriodStart,
        remainingAmount: toNumber(bill.remainingAmount)
      })),
      costBreakdown: {
        capitalCostAmount: row.capitalCostAmount,
        costDays: row.costDays,
        costProfileMissing: row.costProfileMissing,
        costUnavailableReason: row.costUnavailableReason,
        depreciationAmount: row.depreciationAmount,
        depreciationCostAmount: row.depreciationCostAmount,
        depreciationMissingReasons: row.depreciationMissingReasons,
        depreciationSource: row.depreciationSource,
        legacyDepreciationAmount: row.legacyDepreciationAmount,
        insuranceCostAmount: row.insuranceCostAmount,
        maintenanceReserveCostAmount: row.maintenanceReserveCostAmount,
        manualDepreciationUnsupported: row.manualDepreciationUnsupported,
        operatingCostAmount: row.operatingCostAmount,
        otherCostAmount: row.otherCostAmount,
        recordDepreciationAmount: row.recordDepreciationAmount
      },
      costPreview: profile ? buildVehicleAssetCostProfilePreview(vehicle, profile) : null,
      costProfile: profile ? assetCostProfileView(profile) : null,
      capitalEvents: roeContext.capitalEvents.map(assetReturnTrialCapitalEventView),
      capitalStructureSummary: {
        capitalCostSource: row.capitalCostSource,
        debtInterestCostAmount: row.debtInterestCostAmount,
        debtPrincipalAmount: row.debtPrincipalAmount,
        equityCapitalAmount: row.roeEquityBaseAmount,
        roeDataReady: row.roeDataReady,
        roeMissingReasons: row.roeMissingReasons,
        roeWarnings: row.roeWarnings
      },
      dateRange: range.output,
      financingAllocations: roeContext.financingAllocations.map(
        assetReturnTrialFinancingAllocationView
      ),
      incomeBreakdown: {
        assignedOutRevenueAmount: row.assignedOutRevenueAmount,
        damagePaidAmount: row.damagePaidAmount,
        depositCollectedAmount: row.depositCollectedAmount,
        depositIncludedInOperatingRevenue: false,
        operatingRevenueAmount: row.operatingRevenueAmount,
        otherPaidAmount: row.otherPaidAmount,
        ownerShareAmount: row.ownerShareAmount,
        platformRetainedRevenueAmount: row.platformRetainedRevenueAmount,
        pledgedRevenueAmount: row.pledgedRevenueAmount,
        rentalPaidAmount: row.rentalPaidAmount
      },
      orderCycles: metrics.orders.map((order) => {
        const orderMetrics =
          metrics.orderMetricsById.get(order.id) ?? emptyOrderProfitabilityMetrics();

        return {
          customerName: order.customer.name,
          damagePaidAmount: orderMetrics.damagePaidAmount,
          deliveredAt: order.actualDeliveryAt,
          leasedDays: leasedDaysForOrder(order, range),
          monthlyFeeAmount: toNumber(order.monthlyFeeAmount),
          orderId: order.id,
          orderNo: order.orderNo,
          orderStatus: order.orderStatus,
          otherPaidAmount: orderMetrics.otherPaidAmount,
          rentalPaidAmount: orderMetrics.rentalPaidAmount,
          returnedAt: order.actualReturnAt
        };
      }),
      returns: {
        annualizedTrialRoa: row.annualizedTrialRoa,
        annualizedRoeTrial: row.annualizedRoeTrial,
        capitalCostSource: row.capitalCostSource,
        debtInterestCostAmount: row.debtInterestCostAmount,
        externalLeaseCostAmount: row.externalLeaseCostAmount,
        platformNetIncomeAmount: row.platformNetIncomeAmount,
        baasAdjustedAnnualizedRoeTrial: row.baasAdjustedAnnualizedRoeTrial,
        baasAdjustedPlatformNetIncomeAmount: row.baasAdjustedPlatformNetIncomeAmount,
        baasAdjustedRoeTrial: row.baasAdjustedRoeTrial,
        roeDataReady: row.roeDataReady,
        roeEquityBaseAmount: row.roeEquityBaseAmount,
        roeMissingReasons: row.roeMissingReasons,
        roeTrial: row.roeTrial,
        roeUnavailableReason: row.roeUnavailableReason,
        roeWarnings: row.roeWarnings,
        residualDeltaToCostProfileAmount: row.residualDeltaToCostProfileAmount,
        residualDeltaToCurrentSalePriceAmount: row.residualDeltaToCurrentSalePriceAmount,
        residualForecastAvailable: row.residualForecastAvailable,
        residualForecastUnavailableReason: row.residualForecastUnavailableReason,
        residualForecastWarnings: row.residualForecastWarnings,
        residualSensitivityAnnualizedRoeTrial: row.residualSensitivityAnnualizedRoeTrial,
        residualSensitivityNetIncomeAmount: row.residualSensitivityNetIncomeAmount,
        residualSensitivityRoeTrial: row.residualSensitivityRoeTrial,
        marketResidualSource: row.marketResidualSource,
        marketResidualBaseAmount: row.marketResidualBaseAmount,
        marketCalibratedResidualAmount: row.marketCalibratedResidualAmount,
        marketResidualDeltaAmount: row.marketResidualDeltaAmount,
        marketCalibratedPlatformNetIncomeAmount: row.marketCalibratedPlatformNetIncomeAmount,
        marketCalibratedRoeTrial: row.marketCalibratedRoeTrial,
        marketCalibratedAnnualizedRoeTrial: row.marketCalibratedAnnualizedRoeTrial,
        marketCalibratedTrialRoa: row.marketCalibratedTrialRoa,
        marketCalibrationUnavailableReason: row.marketCalibrationUnavailableReason,
        residualCalibrationPercent: row.residualCalibrationPercent,
        trialNetOperatingIncomeAmount: row.trialNetOperatingIncomeAmount,
        trialRoa: row.trialRoa
      },
      residualForecastSummary: row.residualForecastSummary,
      residualForecastPoint: row.residualForecastPoint,
      residualForecastCurveSummary: row.residualForecastCurveSummary,
      revenueRightAssignments: roeContext.revenueRightAssignments.map(
        assetReturnTrialRevenueRightAssignmentView
      ),
      revenueShareRules: roeContext.revenueShareRules.map(assetReturnTrialRevenueShareRuleView),
      roeBreakdown: {
        assignedOutRevenueAmount: row.assignedOutRevenueAmount,
        debtInterestCostAmount: row.debtInterestCostAmount,
        debtPrincipalAmount: row.debtPrincipalAmount,
        externalLeaseCostAmount: row.externalLeaseCostAmount,
        operatingRevenueAmount: row.operatingRevenueAmount,
        ownerShareAmount: row.ownerShareAmount,
        platformNetIncomeAmount: row.platformNetIncomeAmount,
        platformRetainedRevenueAmount: row.platformRetainedRevenueAmount,
        pledgedRevenueAmount: row.pledgedRevenueAmount,
        roeEquityBaseAmount: row.roeEquityBaseAmount
      },
      vehicle: {
        acquisitionMode: vehicle.acquisitionMode,
        brand: vehicle.brand,
        currentSalePriceAmount: row.currentSalePriceAmount,
        model: vehicle.model,
        modelDefinition: row.modelDefinition,
        modelDefinitionId: row.modelDefinitionId,
        modelDisplayName: row.modelDisplayName,
        plateNo: vehicle.plateNo,
        purchasePriceAmount: row.purchasePriceAmount,
        series: vehicle.series,
        vehicleId: vehicle.id,
        vehicleModel: vehicle.vehicleModel,
        vehicleNo: vehicle.vehicleNo,
        vehicleStatus: vehicle.status,
        vin: vehicle.vin
      }
    };
  }

  async exportAssetReturnTrialSummary(query: AssetReturnTrialQueryDto) {
    const report = await this.getAssetReturnTrialSummary(query);
    const rows: CsvRow[] = [
      ["资产收益试算汇总"],
      ["统计周期", dateRangeText(report.dateRange)],
      ["残值预测周期", residualHorizonText(query.residualHorizonMonth)],
      ["残值校准比例", formatPercent(report.residualCalibrationPercent / 100)],
      ["车型筛选", query.vehicleModel ?? "全部"],
      ["车辆状态筛选", query.vehicleStatus ? labelOf(vehicleStatusLabels, query.vehicleStatus) : "全部"],
      [],
      ["核心结果"],
      ["指标", "值"],
      ["平台权益净收益（元）", formatMoneyYuan(report.platformNetIncomeAmount)],
      ["试算 ROE", roeExportValue(report.roeTrial)],
      ["年化试算 ROE", roeExportValue(report.annualizedRoeTrial)],
      ["残值敏感性净收益（元）", formatMoneyYuan(report.residualSensitivityNetIncomeAmount)],
      ["残值敏感性 ROE", formatPercent(report.residualSensitivityRoeTrial)],
      ["年化残值敏感性 ROE", formatPercent(report.residualSensitivityAnnualizedRoeTrial)],
      ["市场校准平台净收益（元）", formatMoneyYuan(report.marketCalibratedPlatformNetIncomeAmount)],
      ["市场校准 ROE", formatPercent(report.marketCalibratedRoeTrial)],
      ["市场校准年化 ROE", formatPercent(report.marketCalibratedAnnualizedRoeTrial)],
      ["ROE 状态", returnTrialRoeCoverageStatus(report)],
      [],
      ["BaaS 电池成本"],
      ["指标", "值"],
      ["BaaS 成本车辆数", report.baasCostVehicleCount],
      ["BaaS 成本记录数", report.baasCostRecordCount],
      ["BaaS 成本合计（元）", formatMoneyYuan(report.baasCostAmount)],
      ["BaaS 原始记录金额（元）", formatMoneyYuan(report.baasCostFullRecordAmount)],
      ["BaaS 成本分摊方法", report.baasCostAllocationMethod],
      ["BaaS 已计划成本（元）", formatMoneyYuan(report.baasScheduledCostAmount)],
      ["BaaS 已确认成本（元）", formatMoneyYuan(report.baasConfirmedCostAmount)],
      ["BaaS 已支付成本（元）", formatMoneyYuan(report.baasPaidCostAmount)],
      ["BaaS 逾期成本（元）", formatMoneyYuan(report.baasOverdueCostAmount)],
      ["口径说明", "BaaS 成本按服务期间纳入主平台权益净收益 / 主试算 ROE。"],
      [],
      ["数据完整性 / 可计算性"],
      ["指标", "值"],
      ["车辆总数", report.vehicleCount],
      ["已有成本参数车辆数", report.vehicleWithCostProfileCount],
      ["缺少成本参数车辆数", report.vehicleMissingCostProfileCount],
      ["成本可计算车辆数", report.costCalculatedVehicleCount],
      ["成本不可计算车辆数", report.costUnavailableVehicleCount],
      ["ROE 可计算车辆数", report.roeCalculatedVehicleCount],
      ["ROE 不可计算车辆数", report.roeUnavailableVehicleCount],
      ["可用残值预测车辆数", report.residualForecastVehicleCount],
      ["缺少残值预测车辆数", report.residualForecastMissingVehicleCount],
      ["不支持残值预测车辆数", report.residualForecastUnsupportedVehicleCount],
      ["已采用残值预测车辆数", report.residualForecastAdoptedVehicleCount],
      [],
      ["收入归属"],
      ["指标", "金额（元）"],
      ["租金实收", formatMoneyYuan(report.rentalPaidAmount)],
      ["损伤实收", formatMoneyYuan(report.damagePaidAmount)],
      ["其他实收", formatMoneyYuan(report.otherPaidAmount)],
      ["经营收入合计", formatMoneyYuan(report.operatingRevenueAmount)],
      ["转让 / 入池外流收入", formatMoneyYuan(report.assignedOutRevenueAmount)],
      ["质押收入金额", formatMoneyYuan(report.pledgedRevenueAmount)],
      ["车主分润金额", formatMoneyYuan(report.ownerShareAmount)],
      ["平台留存经营收入", formatMoneyYuan(report.platformRetainedRevenueAmount)],
      ["押金收取", formatMoneyYuan(report.depositCollectedAmount)],
      [],
      ["成本与资本结构"],
      ["指标", "金额（元）/值"],
      ["折旧成本", formatMoneyYuan(report.depreciationCostAmount)],
      ["折旧金额", formatMoneyYuan(report.depreciationAmount)],
      ["折旧记录金额", formatMoneyYuan(report.depreciationRecordAmount)],
      ["旧成本参数折旧金额", formatMoneyYuan(report.legacyDepreciationAmount)],
      ["折旧记录数", report.depreciationRecordCount],
      ["折旧车辆数", report.depreciationVehicleCount],
      ["折旧不可用车辆数", report.depreciationUnavailableVehicleCount],
      ["资金成本", formatMoneyYuan(report.capitalCostAmount)],
      ["债务利息成本", formatMoneyYuan(report.debtInterestCostAmount)],
      ["保险成本", formatMoneyYuan(report.insuranceCostAmount)],
      ["维修准备金", formatMoneyYuan(report.maintenanceReserveCostAmount)],
      ["其他成本", formatMoneyYuan(report.otherCostAmount)],
      ["外部长租固定成本", formatMoneyYuan(report.externalLeaseCostAmount)],
      ["BaaS 成本", formatMoneyYuan(report.baasCostAmount)],
      ["经营成本合计", formatMoneyYuan(report.operatingCostAmount)],
      ["债务本金", formatMoneyYuan(report.debtPrincipalAmount)],
      ["权益资本基数", formatMoneyYuan(report.roeEquityBaseAmount)],
      [
        "资金成本来源",
        capitalCostSourceText((report as { capitalCostSource?: unknown }).capitalCostSource)
      ],
      [],
      ["资产价值与残值敏感性"],
      ["指标", "值"],
      ["预测残值合计（元）", formatMoneyYuan(report.forecastResidualAmount)],
      ["预测下界合计（元）", formatMoneyYuan(report.forecastLowerBoundAmount)],
      ["预测上界合计（元）", formatMoneyYuan(report.forecastUpperBoundAmount)],
      ["相对当前销售价差异（元）", formatMoneyYuan(report.residualDeltaToCurrentSalePriceAmount)],
      [
        "相对成本参数预计残值差异（元）",
        formatMoneyYuan(report.residualDeltaToCostProfileAmount)
      ],
      ["残值敏感性净收益（元）", formatMoneyYuan(report.residualSensitivityNetIncomeAmount)],
      ["残值敏感性 ROE", formatPercent(report.residualSensitivityRoeTrial)],
      ["年化残值敏感性 ROE", formatPercent(report.residualSensitivityAnnualizedRoeTrial)],
      [],
      ["市场校准折旧 / 残值校准"],
      ["指标", "值"],
      ["残值校准比例", formatPercent(report.residualCalibrationPercent / 100)],
      ["市场校准车辆数", report.marketCalibratedVehicleCount],
      ["市场校准不可用车辆数", report.marketCalibratedUnavailableVehicleCount],
      ["市场残值基准合计（元）", formatMoneyYuan(report.marketResidualBaseAmount)],
      ["校准后残值合计（元）", formatMoneyYuan(report.marketCalibratedResidualAmount)],
      ["市场残值差异合计（元）", formatMoneyYuan(report.marketResidualDeltaAmount)],
      ["市场校准平台净收益（元）", formatMoneyYuan(report.marketCalibratedPlatformNetIncomeAmount)],
      ["市场校准 ROE", formatPercent(report.marketCalibratedRoeTrial)],
      ["市场校准年化 ROE", formatPercent(report.marketCalibratedAnnualizedRoeTrial)],
      ["市场校准 ROA", formatPercent(report.marketCalibratedTrialRoa)],
      [],
      ["计算链路 / 钩稽关系"],
      ["公式", "说明"],
      ["经营收入合计", "租金实收 + 损伤实收 + 其他实收"],
      [
        "平台留存经营收入",
        "经营收入合计 - 转让 / 入池外流收入 - 车主分润金额"
      ],
      [
        "经营成本合计",
        "折旧成本（折旧记录优先，未启用折旧策略时 fallback 旧成本参数） + 资金成本 / 债务利息 + 保险成本 + 维修准备金 + 其他成本 + 外部长租固定成本 + BaaS 成本"
      ],
      ["平台权益净收益", "平台留存经营收入 - 经营成本合计"],
      ["试算 ROE", "平台权益净收益 / 权益资本基数"],
      ["BaaS 成本", "按服务期间纳入经营成本，进而影响平台权益净收益 / ROA / ROE"],
      [
        "残值敏感性净收益",
        "平台权益净收益 + 预测残值相对成本参数残值差异"
      ],
      ["残值敏感性 ROE", "残值敏感性净收益 / 权益资本基数"],
      [
        "市场校准平台净收益",
        "主平台权益净收益 + 校准后市场残值相对成本参数残值差异"
      ],
      ["市场校准 ROE", "市场校准平台净收益 / 权益资本基数"],
      [],
      ["ROE 不可用原因"],
      ["原因"],
      ...csvTextListRows(report.roeMissingReasons),
      [],
      ["ROE 试算提示"],
      ["提示"],
      ...csvTextListRows(report.roeWarnings),
      [],
      ["残值预测提示"],
      ["提示"],
      ...csvTextListRows(report.residualForecastWarnings)
    ];

    return csvExport("asset-return-trial-summary", report.dateRange, rows);
  }

  async exportAssetReturnTrialVehicles(query: AssetReturnTrialVehicleListQueryDto) {
    const { dateRange, rows: vehicles } = await this.buildAssetReturnTrialVehicleRows(query);

    if (vehicles.length > MAX_DETAIL_EXPORT_ROWS) {
      throw new BadRequestException(
        `明细数据超过 ${MAX_DETAIL_EXPORT_ROWS} 行，请缩小筛选范围后再导出。`
      );
    }

    const rows: CsvRow[] = [
      ["资产收益试算车辆列表"],
      ["统计周期", dateRangeText(dateRange)],
      [],
      [
        "车辆编号",
        "VIN",
        "车牌号",
        "品牌",
        "车系",
        "车型代码",
        "车型显示名",
        "legacy 车型",
        "车辆状态",
        "BaaS 合同状态",
        "BaaS 服务商",
        "BaaS 合同编号",
        "采购价（元）",
        "当前销售价（元）",
        "租金实收（元）",
        "损伤实收（元）",
        "其他实收（元）",
        "经营收入（元）",
        "押金收取（元）",
        "转让 / 入池外流收入（元）",
        "质押收入金额（元）",
        "车主分润金额（元）",
        "平台留存经营收入（元）",
        "折旧成本（元）",
        "折旧来源",
        "折旧策略",
        "折旧方法",
        "折旧记录数",
        "折旧缺失原因",
        "资金成本（元）",
        "债务利息成本（元）",
        "保险成本（元）",
        "维修准备金（元）",
        "其他成本（元）",
        "外部长租固定成本（元）",
        "BaaS 成本记录数",
        "BaaS 成本合计（元）",
        "BaaS 已计划成本（元）",
        "BaaS 已确认成本（元）",
        "BaaS 已支付成本（元）",
        "BaaS 逾期成本（元）",
        "经营成本（元）",
        "试算经营净收益（元）",
        "平台权益净收益（元）",
        "试算 ROA",
        "年化试算 ROA",
        "试算 ROE",
        "年化试算 ROE",
        "残值预测状态",
        "残值预测周期",
        "预测值来源",
        "预测残值（元）",
        "预测下界（元）",
        "预测上界（元）",
        "预测残值率",
        "相对当前销售价差异（元）",
        "相对成本参数残值差异（元）",
        "残值敏感性净收益（元）",
        "残值敏感性 ROE",
        "年化残值敏感性 ROE",
        "残值来源",
        "残值校准比例",
        "市场残值基准（元）",
        "校准后残值（元）",
        "残值差异（元）",
        "市场校准平台净收益（元）",
        "市场校准 ROE",
        "市场校准年化 ROE",
        "市场校准 ROA",
        "市场校准不可用原因",
        "债务本金（元）",
        "权益资本基数（元）",
        "资金成本来源",
        "ROE 状态",
        "不可计算原因",
        "提示信息"
      ],
      ...vehicles.map((vehicle) => [
        vehicle.vehicleNo,
        vehicle.vin,
        vehicle.plateNo,
        vehicle.brand,
        vehicle.series,
        vehicle.modelDefinition?.modelCode ?? "",
        vehicle.modelDisplayName ?? vehicle.model ?? vehicle.vehicleModel,
        vehicle.vehicleModel,
        labelOf(vehicleStatusLabels, vehicle.vehicleStatus),
        labelOf(vehicleBaasContractStatusLabels, vehicle.baasContractStatus),
        vehicle.baasProviderName,
        vehicle.baasContractNo,
        formatMoneyYuan(vehicle.purchasePriceAmount),
        formatMoneyYuan(vehicle.currentSalePriceAmount),
        formatMoneyYuan(vehicle.rentalPaidAmount),
        formatMoneyYuan(vehicle.damagePaidAmount),
        formatMoneyYuan(vehicle.otherPaidAmount),
        formatMoneyYuan(vehicle.operatingRevenueAmount),
        formatMoneyYuan(vehicle.depositCollectedAmount),
        formatMoneyYuan(vehicle.assignedOutRevenueAmount),
        formatMoneyYuan(vehicle.pledgedRevenueAmount),
        formatMoneyYuan(vehicle.ownerShareAmount),
        formatMoneyYuan(vehicle.platformRetainedRevenueAmount),
        formatMoneyYuan(vehicle.depreciationCostAmount),
        labelOf(vehicleDepreciationSourceLabels, vehicle.depreciationSource),
        vehicle.depreciationPolicyNo,
        labelOf(vehicleDepreciationMethodLabels, vehicle.depreciationMethod),
        vehicle.depreciationRecordCount,
        csvTextList(vehicle.depreciationMissingReasons),
        formatMoneyYuan(vehicle.capitalCostAmount),
        formatMoneyYuan(vehicle.debtInterestCostAmount),
        formatMoneyYuan(vehicle.insuranceCostAmount),
        formatMoneyYuan(vehicle.maintenanceReserveCostAmount),
        formatMoneyYuan(vehicle.otherCostAmount),
        formatMoneyYuan(vehicle.externalLeaseCostAmount),
        vehicle.baasCostRecordCount,
        formatMoneyYuan(vehicle.baasCostAmount),
        formatMoneyYuan(vehicle.baasScheduledCostAmount),
        formatMoneyYuan(vehicle.baasConfirmedCostAmount),
        formatMoneyYuan(vehicle.baasPaidCostAmount),
        formatMoneyYuan(vehicle.baasOverdueCostAmount),
        formatMoneyYuan(vehicle.operatingCostAmount),
        formatMoneyYuan(vehicle.trialNetOperatingIncomeAmount),
        formatMoneyYuan(vehicle.platformNetIncomeAmount),
        formatPercent(vehicle.trialRoa),
        formatPercent(vehicle.annualizedTrialRoa),
        roeExportValue(vehicle.roeTrial),
        roeExportValue(vehicle.annualizedRoeTrial),
        residualForecastAvailabilityText(vehicle.residualForecastAvailable),
        residualHorizonText(vehicle.residualForecastHorizonMonth),
        residualForecastAmountSourceText(vehicle.forecastResidualAmountSource),
        formatMoneyYuan(vehicle.forecastResidualAmount),
        formatMoneyYuan(vehicle.forecastLowerBoundAmount),
        formatMoneyYuan(vehicle.forecastUpperBoundAmount),
        formatBps(vehicle.forecastResidualRateBps),
        formatMoneyYuan(vehicle.residualDeltaToCurrentSalePriceAmount),
        formatMoneyYuan(vehicle.residualDeltaToCostProfileAmount),
        formatMoneyYuan(vehicle.residualSensitivityNetIncomeAmount),
        formatPercent(vehicle.residualSensitivityRoeTrial),
        formatPercent(vehicle.residualSensitivityAnnualizedRoeTrial),
        marketResidualSourceText(vehicle.marketResidualSource),
        formatPercent(vehicle.residualCalibrationPercent / 100),
        formatMoneyYuan(vehicle.marketResidualBaseAmount),
        formatMoneyYuan(vehicle.marketCalibratedResidualAmount),
        formatMoneyYuan(vehicle.marketResidualDeltaAmount),
        formatMoneyYuan(vehicle.marketCalibratedPlatformNetIncomeAmount),
        formatPercent(vehicle.marketCalibratedRoeTrial),
        formatPercent(vehicle.marketCalibratedAnnualizedRoeTrial),
        formatPercent(vehicle.marketCalibratedTrialRoa),
        vehicle.marketCalibrationUnavailableReason,
        formatMoneyYuan(vehicle.debtPrincipalAmount),
        formatMoneyYuan(vehicle.roeEquityBaseAmount),
        capitalCostSourceText(vehicle.capitalCostSource),
        roeStatusText(vehicle),
        csvTextList([
          ...normalizeCsvTextItems(vehicle.roeMissingReasons),
          ...normalizeCsvTextItems(vehicle.residualForecastUnavailableReason)
        ]),
        csvTextList([
          ...normalizeCsvTextItems(vehicle.roeWarnings),
          ...normalizeCsvTextItems(vehicle.residualForecastWarnings)
        ])
      ])
    ];

    return csvExport("asset-return-trial-vehicles", dateRange, rows);
  }

  async exportAssetReturnTrialVehicleDetail(
    id: string,
    query: AssetReturnTrialVehicleDetailQueryDto
  ) {
    const detail = await this.getAssetReturnTrialVehicleDetail(id, query);
    const vehicle = detail.vehicle;
    const costProfile = detail.costProfile;
    const costPreview = detail.costPreview;
    const income = detail.incomeBreakdown;
    const cost = detail.costBreakdown;
    const returns = detail.returns;
    const baasCurrentContract = detail.baasCurrentContract;
    const baasCostSummary = detail.baasCostSummary;
    const depreciationPolicy = detail.depreciationPolicy;
    const depreciationRecords = detail.depreciationRecords ?? [];
    const depreciationSummary = detail.depreciationSummary;
    const marketCalibratedDepreciation = detail.marketCalibratedDepreciation;
    const residualForecastSummary = detail.residualForecastSummary;
    const residualForecastPoint = detail.residualForecastPoint;
    const residualForecastCurveSummary = detail.residualForecastCurveSummary;
    const rows: CsvRow[] = [
      ["单车收益试算详情"],
      ["统计周期", dateRangeText(detail.dateRange)],
      [],
      ["车辆基础信息"],
      ["字段", "值"],
      ["车辆编号", vehicle.vehicleNo],
      ["VIN", vehicle.vin],
      ["车牌号", vehicle.plateNo],
      ["品牌", vehicle.brand],
      ["车系", vehicle.series],
      ["车型代码", vehicle.modelDefinition?.modelCode ?? ""],
      ["车型显示名", vehicle.modelDisplayName ?? vehicle.model ?? vehicle.vehicleModel],
      ["legacy 车型", vehicle.vehicleModel],
      ["车辆状态", labelOf(vehicleStatusLabels, vehicle.vehicleStatus)],
      [],
      ["成本参数"],
      ["字段", "值"],
      ...(costProfile
        ? ([
            ["成本参数状态", labelOf(vehicleAssetCostProfileStatusLabels, costProfile.profileStatus)],
            ["折旧方法", labelOf(vehicleDepreciationMethodLabels, costProfile.depreciationMethod)],
            ["折旧起算日", formatDate(costProfile.depreciationStartDate)],
            ["预计使用月数", costProfile.usefulLifeMonths],
            ["预计残值（元）", formatMoneyYuan(costProfile.residualValueAmount)],
            ["资金成本率", formatBps(costProfile.capitalCostRateBps)],
            ["年度保险成本（元）", formatMoneyYuan(costProfile.annualInsuranceCostAmount)],
            [
              "年度维修准备金（元）",
              formatMoneyYuan(costProfile.annualMaintenanceReserveAmount)
            ],
            ["其他月度成本（元）", formatMoneyYuan(costProfile.otherMonthlyCostAmount)],
            ["备注", costProfile.remark]
          ] satisfies CsvRow[])
        : ([
            ["成本参数", "未配置"],
            ["不可计算原因", assetReturnTrialUnavailableReasonText(cost)]
          ] satisfies CsvRow[])),
      [],
      ["成本 Preview"],
      ["字段", "值"],
      ...(costPreview
        ? ([
            ["采购价（元）", formatMoneyYuan(costPreview.purchasePriceAmount)],
            ["预计残值（元）", formatMoneyYuan(costPreview.residualValueAmount)],
            ["可折旧金额（元）", formatMoneyYuan(costPreview.depreciableAmount)],
            ["月折旧（元）", formatMoneyYuan(costPreview.monthlyDepreciationAmount)],
            ["年度资金成本（元）", formatMoneyYuan(costPreview.annualCapitalCostAmount)],
            ["月资金成本（元）", formatMoneyYuan(costPreview.monthlyCapitalCostAmount)],
            ["月保险成本（元）", formatMoneyYuan(costPreview.monthlyInsuranceCostAmount)],
            [
              "月维修准备金（元）",
              formatMoneyYuan(costPreview.monthlyMaintenanceReserveAmount)
            ],
            ["其他月度成本（元）", formatMoneyYuan(costPreview.otherMonthlyCostAmount)],
            ["预估月成本（元）", formatMoneyYuan(costPreview.estimatedMonthlyCostAmount)]
          ] satisfies CsvRow[])
        : ([["成本 Preview", "-"]] satisfies CsvRow[])),
      [],
      ["折旧策略摘要"],
      ["字段", "值"],
      ["折旧来源", labelOf(vehicleDepreciationSourceLabels, depreciationSummary?.source)],
      ["折旧策略编号", depreciationPolicy?.policyNo],
      [
        "折旧方法",
        labelOf(vehicleDepreciationMethodLabels, depreciationPolicy?.depreciationMethod)
      ],
      ["折旧金额（元）", formatMoneyYuan(depreciationSummary?.amount)],
      ["折旧记录金额（元）", formatMoneyYuan(depreciationSummary?.recordAmount)],
      ["旧成本参数折旧金额（元）", formatMoneyYuan(depreciationSummary?.legacyAmount)],
      ["折旧记录数", depreciationSummary?.recordCount],
      ["未确认折旧计划数", depreciationSummary?.unconfirmedScheduleCount],
      ["折旧缺失原因", csvTextList(depreciationSummary?.missingReasons)],
      [],
      ["折旧记录分摊明细"],
      [
        "折旧记录编号",
        "账期",
        "期间开始",
        "期间结束",
        "原始折旧金额（元）",
        "纳入本分析周期金额（元）",
        "重叠天数",
        "总天数",
        "分摊比例",
        "记录状态",
        "记录来源"
      ],
      ...depreciationRecords.map((record) => [
        record.recordNo,
        record.costPeriod,
        formatDate(record.periodStart),
        formatDate(record.periodEnd),
        formatMoneyYuan(record.fullDepreciationAmount ?? record.depreciationAmount),
        formatMoneyYuan(record.includedProratedAmount),
        record.overlapDays,
        record.totalDays,
        formatPercent(record.allocationRatio),
        record.recordStatus,
        record.recordSource
      ]),
      ...(depreciationRecords.length === 0 ? ([["暂无数据"]] satisfies CsvRow[]) : []),
      [],
      ["平台留存收入"],
      ["指标", "金额（元）"],
      ["经营收入合计", formatMoneyYuan(income.operatingRevenueAmount)],
      ["转让 / 入池外流收入", formatMoneyYuan(income.assignedOutRevenueAmount)],
      ["质押收入金额", formatMoneyYuan(income.pledgedRevenueAmount)],
      ["车主分润金额", formatMoneyYuan(income.ownerShareAmount)],
      ["平台留存经营收入", formatMoneyYuan(income.platformRetainedRevenueAmount)],
      ["押金收取", formatMoneyYuan(income.depositCollectedAmount)],
      [],
      ["成本拆分"],
      ["指标", "金额（元）"],
      ["成本分摊天数", cost.costDays],
      ["折旧成本", formatMoneyYuan(cost.depreciationCostAmount)],
      ["资金成本", formatMoneyYuan(cost.capitalCostAmount)],
      ["债务利息成本", formatMoneyYuan(returns.debtInterestCostAmount)],
      ["保险成本", formatMoneyYuan(cost.insuranceCostAmount)],
      ["维修准备金", formatMoneyYuan(cost.maintenanceReserveCostAmount)],
      ["其他成本", formatMoneyYuan(cost.otherCostAmount)],
      ["外部长租固定成本", formatMoneyYuan(returns.externalLeaseCostAmount)],
      ["BaaS 成本", formatMoneyYuan(baasCostSummary.costAmount)],
      ["经营成本合计", formatMoneyYuan(cost.operatingCostAmount)],
      ["资金成本来源", capitalCostSourceText(returns.capitalCostSource)],
      ["不可计算原因", assetReturnTrialUnavailableReasonText(cost)],
      [],
      ["资本结构摘要"],
      ["字段", "值"],
      ["债务本金（元）", formatMoneyYuan(detail.roeBreakdown.debtPrincipalAmount)],
      ["债务利息成本（元）", formatMoneyYuan(returns.debtInterestCostAmount)],
      ["权益资本基数（元）", formatMoneyYuan(returns.roeEquityBaseAmount)],
      ["资金成本来源", capitalCostSourceText(returns.capitalCostSource)],
      [],
      ["融资工具分摊明细"],
      ...financingAllocationCsvRows(detail.financingAllocations, detail.dateRange),
      [],
      ["收益权 assignment 明细"],
      ["说明", "PLEDGE = 质押，不扣减平台收入；TRANSFER / SPV_POOL = 扣减平台留存收入"],
      ...revenueRightAssignmentCsvRows(detail.revenueRightAssignments),
      [],
      ["分润规则摘要"],
      ...revenueShareRuleCsvRows(detail.revenueShareRules, income, detail.dateRange),
      [],
      ["收益试算"],
      ["指标", "值"],
      ["试算经营净收益（元）", formatMoneyYuan(returns.trialNetOperatingIncomeAmount)],
      ["平台权益净收益（元）", formatMoneyYuan(returns.platformNetIncomeAmount)],
      ["试算 ROA", formatPercent(returns.trialRoa)],
      ["年化试算 ROA", formatPercent(returns.annualizedTrialRoa)],
      ["试算 ROE", roeExportValue(returns.roeTrial)],
      ["年化试算 ROE", roeExportValue(returns.annualizedRoeTrial)],
      ["ROE 状态", roeStatusText(returns)],
      ["不可计算原因", csvTextList(returns.roeMissingReasons)],
      ["提示信息", csvTextList(returns.roeWarnings)],
      [],
      ["BaaS 电池成本"],
      ["字段", "值"],
      ["合同编号", baasCurrentContract?.contractNo],
      ["合同状态", labelOf(vehicleBaasContractStatusLabels, baasCurrentContract?.contractStatus)],
      ["服务商", baasCurrentContract?.providerName],
      ["服务商合同号", baasCurrentContract?.providerContractNo],
      ["电池包名称", baasCurrentContract?.batteryPackageName],
      ["电池序列号", baasCurrentContract?.batterySerialNo],
      ["计费周期", labelOf(vehicleBaasBillingCycleLabels, baasCurrentContract?.billingCycle)],
      ["月租金（元）", formatMoneyYuan(baasCurrentContract?.rentalAmount)],
      ["每月支付日", baasCurrentContract?.paymentDayOfMonth],
      ["生效日期", formatDate(baasCurrentContract?.effectiveFrom)],
      ["到期日期", formatDate(baasCurrentContract?.effectiveTo)],
      [],
      ["BaaS 成本汇总"],
      ["指标", "值"],
      ["BaaS 成本记录数", baasCostSummary.costRecordCount],
      ["BaaS 成本合计（元）", formatMoneyYuan(baasCostSummary.costAmount)],
      ["BaaS 原始记录金额（元）", formatMoneyYuan(baasCostSummary.fullCostRecordAmount)],
      ["BaaS 成本分摊方法", baasCostSummary.allocationMethod],
      ["BaaS 已计划成本（元）", formatMoneyYuan(baasCostSummary.scheduledCostAmount)],
      ["BaaS 已确认成本（元）", formatMoneyYuan(baasCostSummary.confirmedCostAmount)],
      ["BaaS 已支付成本（元）", formatMoneyYuan(baasCostSummary.paidCostAmount)],
      ["BaaS 逾期成本（元）", formatMoneyYuan(baasCostSummary.overdueCostAmount)],
      [],
      ["BaaS 成本记录"],
      [
        "成本记录编号",
        "账期",
        "周期开始",
        "周期结束",
        "应付日期",
        "原始成本金额（元）",
        "纳入本分析周期金额（元）",
        "重叠天数",
        "总服务天数",
        "分摊比例",
        "成本状态",
        "成本来源",
        "支付日期",
        "付款参考号",
        "发票号"
      ],
      ...detail.baasCostRecords.map((record) => [
        record.costRecordNo,
        record.costPeriod,
        formatDate(record.periodStart),
        formatDate(record.periodEnd),
        formatDate(record.dueDate),
        formatMoneyYuan(record.fullCostRecordAmount ?? record.costAmount),
        formatMoneyYuan(record.includedProratedAmount),
        record.overlapDays,
        record.totalDays,
        formatPercent(record.allocationRatio),
        labelOf(vehicleBaasCostRecordStatusLabels, record.costStatus),
        labelOf(vehicleBaasCostSourceLabels, record.costSource),
        formatDate(record.paidAt),
        record.paymentRefNo,
        record.invoiceNo
      ]),
      ...(detail.baasCostRecords.length === 0 ? ([["暂无数据"]] satisfies CsvRow[]) : []),
      [],
      ["残值预测敏感性"],
      ["字段", "值"],
      [
        "残值预测状态",
        residualForecastAvailabilityText(residualForecastSummary?.available)
      ],
      [
        "不可用原因",
        residualForecastSummary?.unavailableReason ?? returns.residualForecastUnavailableReason
      ],
      ["预测编号", residualForecastSummary?.forecastNo],
      [
        "预测状态",
        labelOf(vehicleResidualForecastStatusLabels, residualForecastSummary?.forecastStatus)
      ],
      [
        "预测方法",
        labelOf(vehicleResidualForecastMethodLabels, residualForecastSummary?.forecastMethod)
      ],
      ["预测基准日", formatDate(residualForecastSummary?.asOfDate)],
      ["预测周期", residualHorizonText(residualForecastSummary?.horizonMonth)],
      ["目标日期", formatDate(residualForecastSummary?.targetDate)],
      ["目标车龄（月）", residualForecastPoint?.targetAgeMonth],
      ["引用曲线编号", residualForecastSummary?.curveNo],
      [
        "预测值来源",
        residualForecastAmountSourceText(residualForecastSummary?.amountSource)
      ],
      ["预测残值（元）", formatMoneyYuan(residualForecastPoint?.forecastResidualAmount)],
      ["预测残值率", formatBps(residualForecastPoint?.predictedResidualRateBps)],
      ["预测下界（元）", formatMoneyYuan(residualForecastPoint?.lowerBoundAmount)],
      ["预测上界（元）", formatMoneyYuan(residualForecastPoint?.upperBoundAmount)],
      ["置信度", scoreText(residualForecastPoint?.confidenceScore)],
      [
        "插值方法",
        labelOf(
          residualForecastInterpolationMethodLabels,
          residualForecastPoint?.interpolationMethod
        )
      ],
      [
        "预测点状态",
        labelOf(vehicleResidualForecastPointStatusLabels, residualForecastPoint?.pointStatus)
      ],
      ["曲线编号", residualForecastCurveSummary?.curveNo],
      [
        "曲线状态",
        labelOf(vehicleResidualCurveStatusLabels, residualForecastCurveSummary?.curveStatus)
      ],
      [
        "曲线方法",
        labelOf(vehicleResidualCurveMethodLabels, residualForecastCurveSummary?.curveMethod)
      ],
      ["曲线置信度", scoreText(residualForecastCurveSummary?.confidenceScore)],
      ["残值预测提示", csvTextList(residualForecastSummary?.warnings)],
      [],
      ["残值差异"],
      ["指标", "金额（元）"],
      ["当前内部销售价", formatMoneyYuan(vehicle.currentSalePriceAmount)],
      ["成本参数预计残值", formatMoneyYuan(costProfile?.residualValueAmount)],
      ["预测残值", formatMoneyYuan(residualForecastPoint?.forecastResidualAmount)],
      [
        "相对当前销售价差异",
        formatMoneyYuan(returns.residualDeltaToCurrentSalePriceAmount)
      ],
      [
        "相对成本参数残值差异",
        formatMoneyYuan(returns.residualDeltaToCostProfileAmount)
      ],
      [],
      ["残值敏感性收益"],
      ["指标", "值"],
      ["主平台权益净收益（元）", formatMoneyYuan(returns.platformNetIncomeAmount)],
      [
        "残值敏感性净收益（元）",
        formatMoneyYuan(returns.residualSensitivityNetIncomeAmount)
      ],
      ["主试算 ROE", roeExportValue(returns.roeTrial)],
      ["残值敏感性 ROE", formatPercent(returns.residualSensitivityRoeTrial)],
      ["主年化试算 ROE", roeExportValue(returns.annualizedRoeTrial)],
      [
        "年化残值敏感性 ROE",
        formatPercent(returns.residualSensitivityAnnualizedRoeTrial)
      ],
      [],
      ["残值敏感性说明"],
      ["项目", "说明"],
      [
        "残值敏感性净收益",
        "平台权益净收益 + 预测残值相对成本参数残值差异"
      ],
      ["残值敏感性 ROE", "残值敏感性净收益 / 权益资本基数"],
      ["注意", "残值敏感性 ROE 不改变主试算 ROE"],
      [],
      ["市场校准折旧说明"],
      ["字段", "值"],
      [
        "残值来源",
        marketResidualSourceText(marketCalibratedDepreciation?.residualSource)
      ],
      [
        "残值校准比例",
        formatPercent((marketCalibratedDepreciation?.residualCalibrationPercent ?? 0) / 100)
      ],
      [
        "会计残值基准（元）",
        formatMoneyYuan(marketCalibratedDepreciation?.accountingResidualBaselineAmount)
      ],
      [
        "市场残值基准（元）",
        formatMoneyYuan(marketCalibratedDepreciation?.marketResidualBaseAmount)
      ],
      [
        "校准后残值（元）",
        formatMoneyYuan(marketCalibratedDepreciation?.marketCalibratedResidualAmount)
      ],
      [
        "残值差异（元）",
        formatMoneyYuan(marketCalibratedDepreciation?.marketResidualDeltaAmount)
      ],
      [
        "会计平台权益净收益（元）",
        formatMoneyYuan(marketCalibratedDepreciation?.accountingPlatformNetIncomeAmount)
      ],
      [
        "市场校准平台权益净收益（元）",
        formatMoneyYuan(marketCalibratedDepreciation?.marketCalibratedPlatformNetIncomeAmount)
      ],
      ["会计 ROE", roeExportValue(marketCalibratedDepreciation?.accountingRoeTrial)],
      [
        "市场校准 ROE",
        formatPercent(marketCalibratedDepreciation?.marketCalibratedRoeTrial)
      ],
      ["会计 ROA", formatPercent(marketCalibratedDepreciation?.accountingTrialRoa)],
      [
        "市场校准 ROA",
        formatPercent(marketCalibratedDepreciation?.marketCalibratedTrialRoa)
      ],
      ["不可用原因", marketCalibratedDepreciation?.unavailableReason],
      [],
      ["订单周期明细"],
      [
        "订单编号",
        "客户",
        "订单状态",
        "交付时间",
        "退车时间",
        "出租天数",
        "套餐月费（元）",
        "实收租金（元）",
        "损伤费用（元）"
      ],
      ...detail.orderCycles.map((order) => [
        order.orderNo,
        order.customerName,
        labelOf(orderStatusLabels, order.orderStatus),
        formatDate(order.deliveredAt),
        formatDate(order.returnedAt),
        order.leasedDays,
        formatMoneyYuan(order.monthlyFeeAmount),
        formatMoneyYuan(order.rentalPaidAmount),
        formatMoneyYuan(order.damagePaidAmount)
      ]),
      [],
      ["账单明细"],
      [
        "账单编号",
        "账单类型",
        "应收（元）",
        "已收（元）",
        "未收（元）",
        "账期",
        "状态"
      ],
      ...detail.bills.map((bill) => [
        bill.billNo,
        labelOf(billTypeLabels, bill.billType),
        formatMoneyYuan(bill.amount),
        formatMoneyYuan(bill.paidAmount),
        formatMoneyYuan(bill.remainingAmount),
        billPeriodText(bill),
        labelOf(billStatusLabels, bill.billStatus)
      ])
    ];

    return csvExport("asset-return-trial-vehicle-detail", detail.dateRange, rows);
  }

  async exportAssetProfitabilitySummary(query: AssetProfitabilityQueryDto) {
    const report = await this.getAssetProfitabilitySummary(query);
    const rows: CsvRow[] = [
      ["资产经营汇总"],
      ["统计周期", dateRangeText(report.dateRange)],
      [],
      ["指标", "值"],
      ["车辆总数", report.totalVehicles],
      ["采购成本合计（元）", formatMoneyYuan(report.totalPurchasePriceAmount)],
      ["当前销售价合计（元）", formatMoneyYuan(report.totalCurrentSalePriceAmount)],
      ["租金实收合计（元）", formatMoneyYuan(report.rentalPaidAmount)],
      ["损伤费用实收合计（元）", formatMoneyYuan(report.damagePaidAmount)],
      ["押金收取合计（元）", formatMoneyYuan(report.depositCollectedAmount)],
      ["应收合计（元）", formatMoneyYuan(report.totalReceivableAmount)],
      ["未收合计（元）", formatMoneyYuan(report.totalRemainingAmount)],
      ["总出租天数", report.totalLeasedDays],
      ["平均出租率", formatPercent(report.averageUtilizationRate)],
      ["平均简化经营回报率", formatPercent(report.averageSimpleReturnRate)]
    ];

    return csvExport("asset-profitability-summary", report.dateRange, rows);
  }

  async exportAssetProfitabilityVehicles(query: AssetProfitabilityVehicleListQueryDto) {
    const { dateRange, rows: vehicles } = await this.buildAssetProfitabilityVehicleRows(query);

    if (vehicles.length > MAX_DETAIL_EXPORT_ROWS) {
      throw new BadRequestException(
        `明细数据超过 ${MAX_DETAIL_EXPORT_ROWS} 行，请缩小筛选范围后再导出。`
      );
    }

    const rows: CsvRow[] = [
      ["资产经营车辆列表"],
      ["统计周期", dateRangeText(dateRange)],
      [],
      [
        "车辆编号",
        "VIN",
        "车牌号",
        "品牌",
        "车系",
        "车型代码",
        "车型显示名",
        "legacy 车型",
        "车辆状态",
        "电池容量（kWh）",
        "电池使用方式",
        "采购价（元）",
        "当前销售价（元）",
        "租金实收（元）",
        "损伤实收（元）",
        "押金收取（元）",
        "总应收（元）",
        "总已收（元）",
        "总未收（元）",
        "出租天数",
        "可运营天数",
        "出租率",
        "简化经营回报率",
        "当前订单",
        "当前客户",
        "最近交付时间",
        "最近退车时间"
      ],
      ...vehicles.map((vehicle) => [
        vehicle.vehicleNo,
        vehicle.vin,
        vehicle.plateNo,
        vehicle.brand,
        vehicle.series,
        vehicle.modelDefinition?.modelCode ?? "",
        vehicle.modelDisplayName ?? vehicle.model ?? vehicle.vehicleModel,
        vehicle.vehicleModel,
        labelOf(vehicleStatusLabels, vehicle.vehicleStatus),
        vehicle.batteryCapacityKwh,
        labelOf(vehicleBatteryUsageTypeLabels, vehicle.batteryUsageType),
        formatMoneyYuan(vehicle.purchasePriceAmount),
        formatMoneyYuan(vehicle.currentSalePriceAmount),
        formatMoneyYuan(vehicle.rentalPaidAmount),
        formatMoneyYuan(vehicle.damagePaidAmount),
        formatMoneyYuan(vehicle.depositCollectedAmount),
        formatMoneyYuan(vehicle.totalReceivableAmount),
        formatMoneyYuan(vehicle.totalPaidAmount),
        formatMoneyYuan(vehicle.totalRemainingAmount),
        vehicle.leasedDays,
        vehicle.operatingDays,
        formatPercent(vehicle.utilizationRate),
        formatPercent(vehicle.simpleReturnRate),
        vehicle.currentOrderNo,
        vehicle.currentCustomerName,
        formatDate(vehicle.lastDeliveryAt),
        formatDate(vehicle.lastReturnAt)
      ])
    ];

    return csvExport("asset-profitability-vehicles", dateRange, rows);
  }

  async exportAssetProfitabilityVehicleDetail(
    id: string,
    query: AssetProfitabilityVehicleDetailQueryDto
  ) {
    const detail = await this.getAssetProfitabilityVehicleDetail(id, query);
    const vehicle = detail.vehicle;
    const assetValue = detail.assetValue;
    const summary = detail.summary;
    const latestSalePriceHistory = latestByDate(
      detail.salePriceHistory,
      (history) => history.createdAt ?? history.effectiveFrom
    );
    const rows: CsvRow[] = [
      ["单车经营详情"],
      ["统计周期", dateRangeText(detail.dateRange)],
      [],
      ["车辆基础信息"],
      ["字段", "值"],
      ["车辆编号", vehicle.vehicleNo],
      ["VIN", vehicle.vin],
      ["车牌号", vehicle.plateNo],
      ["品牌", vehicle.brand],
      ["车系", vehicle.series],
      ["车型代码", vehicle.modelDefinition?.modelCode ?? ""],
      ["车型显示名", vehicle.modelDisplayName ?? vehicle.model ?? vehicle.vehicleModel],
      ["legacy 车型", vehicle.vehicleModel],
      ["电池容量（kWh）", vehicle.batteryCapacityKwh],
      ["电池使用方式", labelOf(vehicleBatteryUsageTypeLabels, vehicle.batteryUsageType)],
      ["车辆状态", labelOf(vehicleStatusLabels, vehicle.vehicleStatus)],
      [],
      ["资产价值信息"],
      ["字段", "值"],
      ["采购价（元）", formatMoneyYuan(assetValue.purchasePriceAmount)],
      ["当前销售价（元）", formatMoneyYuan(assetValue.currentSalePriceAmount)],
      [
        "当前销售价最近复核时间",
        formatDate(assetValue.currentSalePriceReviewedAt ?? latestSalePriceHistory?.createdAt)
      ],
      ["当前销售价状态", labelOf(salePriceStatusLabels, assetValue.currentSalePriceStatus)],
      [],
      ["经营汇总"],
      ["指标", "值"],
      ["租金实收（元）", formatMoneyYuan(summary.rentalPaidAmount)],
      ["损伤费用实收（元）", formatMoneyYuan(summary.damagePaidAmount)],
      ["押金收取（元）", formatMoneyYuan(summary.depositCollectedAmount)],
      ["总应收（元）", formatMoneyYuan(summary.totalReceivableAmount)],
      ["总已收（元）", formatMoneyYuan(summary.totalPaidAmount)],
      ["总未收（元）", formatMoneyYuan(summary.totalRemainingAmount)],
      ["出租天数", summary.leasedDays],
      ["可运营天数", summary.operatingDays],
      ["出租率", formatPercent(summary.utilizationRate)],
      ["简化经营回报率", formatPercent(summary.simpleReturnRate)],
      [],
      ["订单周期明细"],
      [
        "订单编号",
        "客户",
        "订单状态",
        "交付时间",
        "退车时间",
        "出租天数",
        "套餐月费（元）",
        "实收租金（元）",
        "损伤费用（元）"
      ],
      ...detail.orderCycles.map((order) => [
        order.orderNo,
        order.customerName,
        labelOf(orderStatusLabels, order.orderStatus),
        formatDate(order.deliveredAt),
        formatDate(order.returnedAt),
        order.leasedDays,
        formatMoneyYuan(order.monthlyFeeAmount),
        formatMoneyYuan(order.rentalPaidAmount),
        formatMoneyYuan(order.damagePaidAmount)
      ]),
      [],
      ["账单明细"],
      ["账单编号", "账单类型", "应收（元）", "已收（元）", "未收（元）", "账期", "状态"],
      ...detail.bills.map((bill) => [
        bill.billNo,
        labelOf(billTypeLabels, bill.billType),
        formatMoneyYuan(bill.amount),
        formatMoneyYuan(bill.paidAmount),
        formatMoneyYuan(bill.remainingAmount),
        billPeriodText(bill),
        labelOf(billStatusLabels, bill.billStatus)
      ]),
      [],
      ["生命周期节点"],
      ["节点类型", "发生时间", "说明"],
      ...detail.lifecycleNodes.map((node) => [
        labelOf(assetProfitabilityLifecycleNodeLabels, node.type),
        formatDate(node.occurredAt),
        lifecycleNodeDescription(node)
      ]),
      [],
      ["损伤记录"],
      ["退车单号", "损伤类型", "损伤等级", "责任方", "预估维修金额（元）", "状态", "描述"],
      ...detail.damageRecords.map((damage) => [
        damage.returnNo,
        labelOf(vehicleDamageTypeLabels, damage.damageType),
        labelOf(vehicleDamageLevelLabels, damage.damageLevel),
        labelOf(vehicleDamageResponsiblePartyLabels, damage.responsibleParty),
        formatMoneyYuan(damage.estimatedRepairAmount),
        labelOf(vehicleReturnDamageStatusLabels, damage.status),
        damage.description
      ]),
      [],
      ["销售价历史"],
      ["复核类型", "调整前价格（元）", "调整后价格（元）", "生效日期", "复核季度", "原因", "创建时间"],
      ...detail.salePriceHistory.map((history) => [
        labelOf(vehicleSalePriceReviewTypeLabels, history.reviewType),
        formatMoneyYuan(history.beforeSalePriceAmount),
        formatMoneyYuan(history.afterSalePriceAmount),
        formatDate(history.effectiveFrom),
        history.reviewQuarter,
        history.reason ?? history.remark,
        formatDate(history.createdAt)
      ])
    ];

    return csvExport("asset-profitability-vehicle-detail", detail.dateRange, rows);
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
      byEntitlementTypeUnit: grantTypeUnitGroups
        .map((group) => ({
          entitlementType: group.entitlementType,
          grantCount: group._count._all,
          remainingAmount:
            group.unit === EntitlementUnit.TEXT ? null : amountToNumber(group._sum.remainingAmount),
          totalAmount:
            group.unit === EntitlementUnit.TEXT ? null : amountToNumber(group._sum.totalAmount),
          unit: group.unit,
          usedAmount:
            group.unit === EntitlementUnit.TEXT ? null : amountToNumber(group._sum.usedAmount)
        }))
        .map((row) => ({
          ...row,
          exhaustedCount: exhaustedCountForTypeUnit(
            exhaustedGrantTypeUnitGroups,
            row.entitlementType,
            row.unit
          )
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
    const modelWhere = await this.reportOrderModelWhere(query);
    const where: Prisma.SubscriptionOrderWhereInput = {
      createdAt: range.dateTimeFilter,
      deletedAt: null,
      ...modelWhere,
      ...(query.orderStatus ? { orderStatus: query.orderStatus } : {}),
      ...(query.orderSource ? { orderSource: query.orderSource } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.subscriptionPlanId
        ? { quote: { subscriptionPlanId: query.subscriptionPlanId } }
        : {})
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
          vehicle: {
            select: {
              modelDefinition: { select: reportModelDefinitionSelect },
              modelDefinitionId: true,
              plateNo: true,
              vehicleNo: true,
              vin: true
            }
          },
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
        modelDefinition: reportModelDefinitionSummary(order.vehicle?.modelDefinition ?? null),
        modelDefinitionId: order.vehicle?.modelDefinitionId ?? null,
        modelDisplayName: reportVehicleModelDisplayName(order.vehicle?.modelDefinition ?? null, order.vehicleModel),
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
        const overdueDays =
          caseBill?.overdueDays ?? overdueDaysBetween(bill.dueDate, range.endExclusive);

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
    const modelWhere = await this.reportVehicleModelWhere(query);
    const where: Prisma.VehicleWhereInput = {
      deletedAt: null,
      ...modelWhere,
      ...(query.vehicleStatus ? { status: query.vehicleStatus } : {}),
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
          modelDefinition: { select: reportModelDefinitionSelect },
          modelDefinitionId: true,
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
    const paidAmountByVehicleId = await this.paidAmountByVehicle(
      range,
      vehicles.map((vehicle) => vehicle.id)
    );

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
          modelDefinition: reportModelDefinitionSummary(vehicle.modelDefinition),
          modelDefinitionId: vehicle.modelDefinitionId,
          modelDisplayName: reportVehicleModelDisplayName(vehicle.modelDefinition, vehicle.vehicleModel),
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
      ...report.byCaseStatus.map((row) => [
        labelOf(collectionCaseStatusLabels, row.caseStatus),
        row.count
      ])
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
        "车型代码",
        "车型显示名",
        "legacy 车型",
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
        row.modelDefinition?.modelCode ?? "",
        row.modelDisplayName ?? row.vehicleModel,
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
        "车型代码",
        "车型显示名",
        "legacy 车型",
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
        row.modelDefinition?.modelCode ?? "",
        row.modelDisplayName ?? row.model ?? row.vehicleModel,
        row.vehicleModel,
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
      throw new BadRequestException(
        `明细数据超过 ${MAX_DETAIL_EXPORT_ROWS} 行，请缩小筛选范围后再导出。`
      );
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

  private async buildAssetProfitabilityVehicleRows(
    query: AssetProfitabilityQueryDto & Partial<Pick<AssetProfitabilityVehicleListQueryDto, "sortBy" | "sortOrder">>
  ) {
    const range = resolveReportDateRange(query);
    const modelWhere = await this.reportVehicleModelWhere(query);
    const vehicles = await this.prisma.vehicle.findMany({
      orderBy: { createdAt: "desc" },
      select: assetProfitabilityVehicleSelect,
      where: assetProfitabilityVehicleWhere(query, modelWhere)
    });
    const metricsByVehicleId = await this.buildAssetProfitabilityMetrics(vehicles, range);
    const rows = vehicles.map((vehicle) =>
      assetProfitabilityVehicleRow(
        vehicle,
        metricsByVehicleId.get(vehicle.id) ?? emptyAssetProfitabilityMetrics()
      )
    );

    if (query.sortBy) {
      rows.sort(assetProfitabilityComparator(query.sortBy, query.sortOrder ?? "desc"));
    }

    return {
      dateRange: range.output,
      rows
    };
  }

  private async buildAssetReturnTrialVehicleRows(
    query: AssetReturnTrialQueryDto & Partial<Pick<AssetReturnTrialVehicleListQueryDto, "sortBy" | "sortOrder">>
  ) {
    const range = resolveReportDateRange(query);
    const modelWhere = await this.reportVehicleModelWhere(query);
    const vehicles = await this.prisma.vehicle.findMany({
      orderBy: { createdAt: "desc" },
      select: assetReturnTrialVehicleSelect,
      where: assetProfitabilityVehicleWhere(query, modelWhere)
    });
    const residualHorizonMonth = resolveResidualHorizonMonth(query);
    const residualCalibrationPercent = resolveResidualCalibrationPercent(query);
    const [
      metricsByVehicleId,
      roeContextsByVehicleId,
      residualContextsByVehicleId,
      depreciationContextsByVehicleId,
      baasContextsByVehicleId
    ] = await Promise.all([
      this.buildAssetProfitabilityMetrics(vehicles, range),
      this.buildAssetReturnRoeContexts(vehicles, range),
      this.buildAssetReturnResidualForecastContexts(vehicles, residualHorizonMonth),
      this.buildAssetReturnDepreciationContexts(vehicles, range),
      this.buildAssetReturnBaasContexts(vehicles, range)
    ]);
    const analysisDays = inclusiveBusinessDays(range.output.startDate, range.output.endDate);
    const rows = vehicles.map((vehicle) =>
      attachAssetReturnBaasFields(
        assetReturnTrialVehicleRow(
          vehicle,
          metricsByVehicleId.get(vehicle.id) ?? emptyAssetProfitabilityMetrics(),
          range,
          roeContextsByVehicleId.get(vehicle.id) ?? emptyAssetReturnRoeContext(vehicle.id),
          residualContextsByVehicleId.get(vehicle.id) ??
            emptyAssetReturnResidualForecastContext(vehicle.id, residualHorizonMonth),
          depreciationContextsByVehicleId.get(vehicle.id) ??
            emptyAssetReturnDepreciationContext(vehicle.id)
        ),
        baasContextsByVehicleId.get(vehicle.id) ?? emptyAssetReturnBaasContext(vehicle.id),
        analysisDays,
        residualCalibrationPercent
      )
    );

    if (query.sortBy) {
      rows.sort(assetReturnTrialComparator(query.sortBy, query.sortOrder ?? "desc"));
    }

    return {
      dateRange: range.output,
      rows
    };
  }

  private async buildAssetProfitabilityMetrics(
    vehicles: AssetProfitabilityVehicleRecord[],
    range: ReturnType<typeof resolveReportDateRange>
  ) {
    const metricsByVehicleId = new Map(
      vehicles.map((vehicle) => [vehicle.id, emptyAssetProfitabilityMetrics()])
    );
    const vehicleIds = vehicles.map((vehicle) => vehicle.id);

    if (vehicleIds.length === 0) {
      return metricsByVehicleId;
    }

    const [orders, bills, depositLedgers] = await Promise.all([
      this.prisma.subscriptionOrder.findMany({
        orderBy: { createdAt: "desc" },
        select: assetProfitabilityOrderSelect,
        where: {
          deletedAt: null,
          vehicleId: { in: vehicleIds }
        }
      }),
      this.prisma.receivableBill.findMany({
        orderBy: { dueDate: "asc" },
        select: assetProfitabilityBillSelect,
        where: {
          deletedAt: null,
          dueDate: range.dateTimeFilter,
          order: { vehicleId: { in: vehicleIds } }
        }
      }),
      this.prisma.depositLedger.findMany({
        select: {
          amount: true,
          order: { select: { vehicleId: true } }
        },
        where: {
          deletedAt: null,
          occurredAt: range.dateTimeFilter,
          order: { vehicleId: { in: vehicleIds } },
          transactionStatus: DepositTransactionStatus.CONFIRMED,
          transactionType: DepositTransactionType.COLLECT
        }
      })
    ]);

    for (const order of orders) {
      if (!order.vehicleId) {
        continue;
      }

      const metrics = metricsByVehicleId.get(order.vehicleId);
      if (!metrics) {
        continue;
      }

      metrics.orders.push(order);
      metrics.leasedDays += leasedDaysForOrder(order, range);

      if (
        order.actualDeliveryAt &&
        (!metrics.lastDeliveryAt || order.actualDeliveryAt > metrics.lastDeliveryAt)
      ) {
        metrics.lastDeliveryAt = order.actualDeliveryAt;
      }
      if (
        order.actualReturnAt &&
        (!metrics.lastReturnAt || order.actualReturnAt > metrics.lastReturnAt)
      ) {
        metrics.lastReturnAt = order.actualReturnAt;
      }
      if (!metrics.currentOrder && currentVehicleOrderStatuses.includes(order.orderStatus)) {
        metrics.currentOrder = order;
      }
    }

    for (const bill of bills) {
      const vehicleId = bill.order.vehicleId;
      if (!vehicleId) {
        continue;
      }

      const metrics = metricsByVehicleId.get(vehicleId);
      if (!metrics) {
        continue;
      }

      const orderMetrics = orderMetricsFor(metrics, bill.orderId);
      const paidAmount = toNumber(bill.paidAmount);
      metrics.bills.push(bill);
      metrics.totalReceivableAmount += toNumber(bill.amount);
      metrics.totalPaidAmount += paidAmount;
      metrics.totalRemainingAmount += toNumber(bill.remainingAmount);

      if (bill.billType === BillType.FIRST_MONTHLY_FEE || bill.billType === BillType.MONTHLY_RENT) {
        metrics.rentalPaidAmount += paidAmount;
        orderMetrics.rentalPaidAmount += paidAmount;
      } else if (bill.billType === BillType.DAMAGE_FEE) {
        metrics.damagePaidAmount += paidAmount;
        orderMetrics.damagePaidAmount += paidAmount;
      } else if (bill.billType === BillType.OTHER) {
        metrics.otherPaidAmount += paidAmount;
        orderMetrics.otherPaidAmount += paidAmount;
      }
    }

    for (const ledger of depositLedgers) {
      const vehicleId = ledger.order.vehicleId;
      if (!vehicleId) {
        continue;
      }
      const metrics = metricsByVehicleId.get(vehicleId);
      if (metrics) {
        metrics.depositCollectedAmount += toNumber(ledger.amount);
      }
    }

    for (const vehicle of vehicles) {
      const metrics = metricsByVehicleId.get(vehicle.id);
      if (!metrics) {
        continue;
      }
      metrics.operatingDays = operatingDaysForVehicle(vehicle, range);
    }

    return metricsByVehicleId;
  }

  private async buildAssetReturnRoeContexts(
    vehicles: Pick<AssetReturnTrialVehicleRecord, "id">[],
    range: ReturnType<typeof resolveReportDateRange>
  ) {
    const vehicleIds = vehicles.map((vehicle) => vehicle.id);
    const contextsByVehicleId = new Map(
      vehicleIds.map((vehicleId) => [vehicleId, emptyAssetReturnRoeContext(vehicleId)])
    );

    if (vehicleIds.length === 0) {
      return contextsByVehicleId;
    }

    const startDate = dateOnlyUtc(range.output.startDate);
    const endDate = dateOnlyUtc(range.output.endDate);
    const overlapWhere = dateRangeOverlapWhere(startDate, endDate);

    const [
      capitalEvents,
      financingAllocations,
      revenueAssignments,
      vehiclePoolAssignments,
      revenueShareRules
    ] = await Promise.all([
      this.prisma.vehicleCapitalEvent.findMany({
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
        select: assetReturnTrialCapitalEventSelect,
        where: {
          ...overlapWhere,
          deletedAt: null,
          eventStatus: VehicleCapitalEventStatus.ACTIVE,
          vehicleId: { in: vehicleIds }
        }
      }),
      this.prisma.financingInstrumentVehicle.findMany({
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
        select: assetReturnTrialFinancingAllocationSelect,
        where: {
          ...overlapWhere,
          allocationStatus: FinancingAllocationStatus.ACTIVE,
          deletedAt: null,
          instrument: {
            deletedAt: null,
            instrumentStatus: FinancingInstrumentStatus.ACTIVE
          },
          vehicleId: { in: vehicleIds }
        }
      }),
      this.prisma.revenueRightAssignment.findMany({
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
        select: assetReturnTrialRevenueRightAssignmentSelect,
        where: {
          deletedAt: null,
          assignmentStatus: RevenueRightAssignmentStatus.ACTIVE,
          AND: [
            revenueRightAssignmentOverlapWhere(startDate, endDate),
            {
              OR: [
                { vehicleId: { in: vehicleIds } },
                { order: { vehicleId: { in: vehicleIds } } },
                { bill: { order: { vehicleId: { in: vehicleIds } } } }
              ]
            }
          ]
        }
      }),
      this.prisma.revenueRightAssignment.findMany({
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
        select: assetReturnTrialRevenueRightAssignmentSelect,
        where: {
          assignmentStatus: RevenueRightAssignmentStatus.ACTIVE,
          AND: [revenueRightAssignmentOverlapWhere(startDate, endDate)],
          deletedAt: null,
          targetType: RevenueRightTargetType.VEHICLE_POOL
        }
      }),
      this.prisma.revenueShareRule.findMany({
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
        select: assetReturnTrialRevenueShareRuleSelect,
        where: {
          ...overlapWhere,
          deletedAt: null,
          ruleStatus: RevenueShareRuleStatus.ACTIVE,
          vehicleId: { in: vehicleIds }
        }
      })
    ]);

    for (const event of capitalEvents) {
      contextsByVehicleId.get(event.vehicleId)?.capitalEvents.push(event);
    }
    for (const allocation of financingAllocations) {
      contextsByVehicleId.get(allocation.vehicleId)?.financingAllocations.push(allocation);
    }
    for (const assignment of revenueAssignments) {
      const vehicleId = vehicleIdForRevenueAssignment(assignment);
      if (vehicleId) {
        contextsByVehicleId.get(vehicleId)?.revenueRightAssignments.push(assignment);
      }
    }
    for (const rule of revenueShareRules) {
      contextsByVehicleId.get(rule.vehicleId)?.revenueShareRules.push(rule);
    }
    if (vehiclePoolAssignments.length > 0) {
      for (const context of contextsByVehicleId.values()) {
        context.vehiclePoolRevenueRightWarning = true;
      }
    }

    return contextsByVehicleId;
  }

  private async buildAssetReturnResidualForecastContexts(
    vehicles: Pick<AssetReturnTrialVehicleRecord, "id">[],
    horizonMonth: number
  ) {
    const vehicleIds = vehicles.map((vehicle) => vehicle.id);
    const contextsByVehicleId = new Map(
      vehicleIds.map((vehicleId) => [
        vehicleId,
        emptyAssetReturnResidualForecastContext(vehicleId, horizonMonth)
      ])
    );

    if (vehicleIds.length === 0) {
      return contextsByVehicleId;
    }

    const forecasts = await this.prisma.vehicleResidualForecast.findMany({
      orderBy: [{ createdAt: "desc" }, { asOfDate: "desc" }],
      select: assetReturnResidualForecastSelect,
      where: {
        deletedAt: null,
        forecastStatus: {
          in: [VehicleResidualForecastStatus.ADOPTED, VehicleResidualForecastStatus.GENERATED]
        },
        vehicleId: { in: vehicleIds }
      }
    });

    const forecastsByVehicleId = new Map<string, AssetReturnResidualForecastRecord[]>();
    for (const forecast of forecasts) {
      forecastsByVehicleId.set(forecast.vehicleId, [
        ...(forecastsByVehicleId.get(forecast.vehicleId) ?? []),
        forecast
      ]);
    }

    for (const vehicleId of vehicleIds) {
      const selectedForecast = selectAssetReturnResidualForecast(
        forecastsByVehicleId.get(vehicleId) ?? []
      );
      if (!selectedForecast) {
        continue;
      }

      const point =
        selectedForecast.points.find((candidate) => candidate.horizonMonth === horizonMonth) ??
        null;
      contextsByVehicleId.set(vehicleId, {
        forecast: selectedForecast,
        horizonMonth,
        point,
        unavailableReason: point ? null : RESIDUAL_FORECAST_POINT_MISSING_REASON,
        vehicleId
      });
    }

    return contextsByVehicleId;
  }

  private async buildAssetReturnDepreciationContexts(
    vehicles: Pick<AssetReturnTrialVehicleRecord, "id">[],
    range: ReturnType<typeof resolveReportDateRange>
  ) {
    const vehicleIds = vehicles.map((vehicle) => vehicle.id);
    const contextsByVehicleId = new Map(
      vehicleIds.map((vehicleId) => [vehicleId, emptyAssetReturnDepreciationContext(vehicleId)])
    );

    if (vehicleIds.length === 0) {
      return contextsByVehicleId;
    }

    const analysisStart = utcDateOnlyStart(range.output.startDate, "startDate");
    const analysisEnd = utcDateOnlyStart(range.output.endDate, "endDate");
    const policies = await this.prisma.vehicleDepreciationPolicy.findMany({
      orderBy: [{ activatedAt: "desc" }, { createdAt: "desc" }],
      select: assetReturnDepreciationPolicySelect,
      where: {
        deletedAt: null,
        policyStatus: VehicleDepreciationPolicyStatus.ACTIVE,
        vehicleId: { in: vehicleIds }
      }
    });

    const policyIds: string[] = [];
    for (const policy of policies) {
      const context = contextsByVehicleId.get(policy.vehicleId);
      if (!context || context.policy) {
        continue;
      }
      context.policy = policy;
      context.summary.policyId = policy.id;
      context.summary.policyNo = policy.policyNo;
      policyIds.push(policy.id);
    }

    if (policyIds.length === 0) {
      return contextsByVehicleId;
    }

    const [records, schedules] = await Promise.all([
      this.prisma.vehicleDepreciationRecord.findMany({
        orderBy: [{ periodStart: "asc" }, { costPeriod: "asc" }, { createdAt: "asc" }],
        select: assetReturnDepreciationRecordSelect,
        where: {
          deletedAt: null,
          periodEnd: { gte: analysisStart },
          periodStart: { lte: analysisEnd },
          policyId: { in: policyIds },
          recordStatus: { in: DEPRECIATION_RECORD_INCLUDED_STATUSES },
          vehicleId: { in: vehicleIds }
        }
      }),
      this.prisma.vehicleDepreciationSchedule.findMany({
        orderBy: [{ periodStart: "asc" }, { costPeriod: "asc" }, { createdAt: "asc" }],
        select: assetReturnDepreciationScheduleSelect,
        where: {
          deletedAt: null,
          periodEnd: { gte: analysisStart },
          periodStart: { lte: analysisEnd },
          policyId: { in: policyIds },
          scheduleStatus: VehicleDepreciationScheduleStatus.SCHEDULED,
          vehicleId: { in: vehicleIds }
        }
      })
    ]);

    for (const schedule of schedules) {
      const context = contextsByVehicleId.get(schedule.vehicleId);
      if (!context || context.policy?.id !== schedule.policyId) {
        continue;
      }
      context.schedules.push(schedule);
      context.summary.unconfirmedScheduleCount += 1;
    }

    for (const record of records) {
      const context = contextsByVehicleId.get(record.vehicleId);
      if (!context || context.policy?.id !== record.policyId) {
        continue;
      }

      const allocation = calculateProratedDepreciationForAnalysisWindow(record, range.output);
      const allocatedRecord = {
        ...record,
        fullDepreciationAmount: toNumber(record.depreciationAmount),
        ...allocation
      };
      context.records.push(allocatedRecord);
      context.summary.recordAmount += allocatedRecord.includedProratedAmount;
      context.summary.recordCount += 1;
      if (allocation.totalDays <= 0) {
        context.summary.warnings.push(INVALID_DEPRECIATION_RECORD_PERIOD_WARNING);
      }
    }

    for (const context of contextsByVehicleId.values()) {
      updateDepreciationContextSummary(context);
    }

    return contextsByVehicleId;
  }

  private async buildAssetReturnBaasContexts(
    vehicles: Pick<AssetReturnTrialVehicleRecord, "id">[],
    range: ReturnType<typeof resolveReportDateRange>
  ) {
    const vehicleIds = vehicles.map((vehicle) => vehicle.id);
    const contextsByVehicleId = new Map(
      vehicleIds.map((vehicleId) => [vehicleId, emptyAssetReturnBaasContext(vehicleId)])
    );

    if (vehicleIds.length === 0) {
      return contextsByVehicleId;
    }

    const analysisStart = utcDateOnlyStart(range.output.startDate, "startDate");
    const analysisEnd = utcDateOnlyStart(range.output.endDate, "endDate");
    const [contracts, records] = await Promise.all([
      this.prisma.vehicleBaasContract.findMany({
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
        select: assetReturnBaasContractSelect,
        where: {
          contractStatus: VehicleBaasContractStatus.ACTIVE,
          deletedAt: null,
          vehicleId: { in: vehicleIds }
        }
      }),
      this.prisma.vehicleBaasCostRecord.findMany({
        orderBy: [{ periodStart: "asc" }, { costPeriod: "asc" }, { createdAt: "asc" }],
        select: assetReturnBaasCostRecordSelect,
        where: {
          costStatus: { in: BAAS_COST_INCLUDED_STATUSES },
          deletedAt: null,
          periodEnd: { gte: analysisStart },
          periodStart: { lte: analysisEnd },
          vehicleId: { in: vehicleIds }
        }
      })
    ]);

    for (const contract of contracts) {
      const context = contextsByVehicleId.get(contract.vehicleId);
      if (context && !context.currentContract) {
        context.currentContract = contract;
      }
    }

    for (const record of records) {
      const context = contextsByVehicleId.get(record.vehicleId);
      if (!context) {
        continue;
      }

      const allocatedRecord = {
        ...record,
        fullCostRecordAmount: toNumber(record.costAmount),
        ...calculateProratedBaasCostForAnalysisWindow(record, range.output)
      };
      context.records.push(allocatedRecord);
      addBaasCostRecordToSummary(context.summary, allocatedRecord);
    }

    return contextsByVehicleId;
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
        result.set(
          bill.order.vehicleId,
          (result.get(bill.order.vehicleId) ?? 0) + toNumber(bill.paidAmount)
        );
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

const currentVehicleOrderStatuses: OrderStatus[] = [
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

function billPeriodText(bill: {
  dueDate?: Date | null;
  periodEnd?: Date | null;
  periodStart?: Date | null;
}) {
  if (bill.periodStart || bill.periodEnd) {
    return `${formatDate(bill.periodStart)} 至 ${formatDate(bill.periodEnd)}`;
  }

  return formatDate(bill.dueDate);
}

function formatBps(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? `${(value / 100).toFixed(2)}%` : "-";
}

function roeExportValue(value: unknown) {
  return formatPercent(value);
}

function capitalCostSourceText(value: unknown) {
  return labelOf(capitalCostSourceLabels, value);
}

function residualForecastAmountSourceText(value: unknown) {
  return labelOf(forecastResidualAmountSourceLabels, value);
}

function marketResidualSourceText(value: unknown) {
  return labelOf(marketResidualSourceLabels, value);
}

function residualForecastAvailabilityText(value: unknown) {
  return value === true ? "可用" : "不可用";
}

function residualHorizonText(value: unknown) {
  const month = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 12;
  return month === 0 ? "当前" : `未来 ${month} 个月`;
}

function returnTrialRoeCoverageStatus(report: {
  roeCalculatedVehicleCount?: number | null;
}) {
  return (report.roeCalculatedVehicleCount ?? 0) > 0 ? "部分或全部可试算" : "暂不可用";
}

function scoreText(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} 分` : "-";
}

function csvTextList(value: unknown) {
  if (!Array.isArray(value)) {
    return "-";
  }

  const items = value.map((item) => safeCell(item)).filter((item) => item !== "-");
  return items.length > 0 ? items.join("；") : "-";
}

function csvTextListRows(value: unknown): CsvRow[] {
  const text = csvTextList(value);
  return text === "-" ? [["-"]] : text.split("；").map((item) => [item]);
}

function normalizeCsvTextItems(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => safeCell(item)).filter((item) => item !== "-");
  }

  const item = safeCell(value);
  return item === "-" ? [] : [item];
}

function roeStatusText(row: { roeTrial?: unknown }) {
  return typeof row.roeTrial === "number" && Number.isFinite(row.roeTrial) ? "可试算" : "暂不可用";
}

function financingAllocationCsvRows(
  allocations: ReturnType<typeof assetReturnTrialFinancingAllocationView>[],
  dateRange: ReportDateRangeOutput
): CsvRow[] {
  if (allocations.length === 0) {
    return [["暂无数据"]];
  }

  return [
    [
      "融资工具编号",
      "融资类型",
      "资金方",
      "分摊本金（元）",
      "年化利率",
      "债务利息成本（元）",
      "生效日期"
    ],
    ...allocations.map((allocation) => [
      allocation.instrument.instrumentNo,
      labelOf(financingInstrumentTypeLabels, allocation.instrument.instrumentType),
      allocation.instrument.lenderName,
      formatMoneyYuan(allocation.allocatedPrincipalAmount),
      formatBps(allocation.instrument.annualRateBps),
      formatMoneyYuan(allocationDebtInterestAmount(allocation, dateRange)),
      formatDate(allocation.effectiveFrom)
    ])
  ];
}

function revenueRightAssignmentCsvRows(
  assignments: ReturnType<typeof assetReturnTrialRevenueRightAssignmentView>[]
): CsvRow[] {
  if (assignments.length === 0) {
    return [["暂无数据"]];
  }

  return [
    [
      "收益权编号",
      "类型",
      "状态",
      "目标类型",
      "融资工具",
      "受让方",
      "分配比例",
      "生效日期",
      "解除日期"
    ],
    ...assignments.map((assignment) => [
      assignment.assignmentNo,
      labelOf(revenueRightAssignmentTypeLabels, assignment.assignmentType),
      labelOf(revenueRightAssignmentStatusLabels, assignment.assignmentStatus),
      labelOf(revenueRightTargetTypeLabels, assignment.targetType),
      assignment.financingInstrument?.instrumentNo ?? "-",
      revenueRightAssigneeText(assignment),
      formatBps(assignment.shareRatioBps),
      formatDate(assignment.effectiveFrom),
      formatDate(assignment.releasedAt ?? assignment.effectiveTo)
    ])
  ];
}

function revenueShareRuleCsvRows(
  rules: ReturnType<typeof assetReturnTrialRevenueShareRuleView>[],
  income: {
    operatingRevenueAmount?: number | null;
    rentalPaidAmount?: number | null;
  },
  dateRange: ReportDateRangeOutput
): CsvRow[] {
  if (rules.length === 0) {
    return [["暂无数据"]];
  }

  return [
    [
      "规则类型",
      "分润基础",
      "车主分成比例",
      "固定月金额（元）",
      "车主分润金额（元）",
      "平台留存金额（元）",
      "是否支持试算",
      "不支持原因"
    ],
    ...rules.map((rule) => {
      const support = revenueShareRuleSupport(rule);
      const shareBaseAmount = revenueShareRuleBaseAmount(rule, income);
      const ownerShareAmount =
        shareBaseAmount !== null &&
        rule.ownerShareBps !== null &&
        rule.ownerShareBps !== undefined &&
        (rule.ruleType === RevenueShareRuleType.REVENUE_SHARE ||
          rule.ruleType === RevenueShareRuleType.MIXED)
          ? amountByBps(shareBaseAmount, rule.ownerShareBps)
          : null;
      const fixedCostAmount =
        rule.fixedMonthlyAmount !== null &&
        rule.fixedMonthlyAmount !== undefined &&
        (rule.ruleType === RevenueShareRuleType.FIXED_RENT ||
          rule.ruleType === RevenueShareRuleType.MIXED)
          ? Math.round(
              (rule.fixedMonthlyAmount *
                12 *
                overlapDaysForOutputRange(rule.effectiveFrom, rule.effectiveTo, dateRange)) /
                365
            )
          : 0;
      const platformRetainedAmount =
        shareBaseAmount !== null && ownerShareAmount !== null
          ? shareBaseAmount - ownerShareAmount - fixedCostAmount
          : null;

      return [
        labelOf(revenueShareRuleTypeLabels, rule.ruleType),
        labelOf(revenueShareBasisLabels, rule.shareBasis),
        formatBps(rule.ownerShareBps),
        formatMoneyYuan(rule.fixedMonthlyAmount),
        formatMoneyYuan(ownerShareAmount),
        formatMoneyYuan(platformRetainedAmount),
        support.supported ? "支持试算" : "暂不支持",
        support.reason
      ];
    })
  ];
}

function allocationDebtInterestAmount(
  allocation: ReturnType<typeof assetReturnTrialFinancingAllocationView>,
  dateRange: ReportDateRangeOutput
) {
  const annualRateBps = allocation.instrument.annualRateBps;

  if (
    annualRateBps === null ||
    annualRateBps === undefined ||
    (allocation.instrument.repaymentMethod !== FinancingRepaymentMethod.INTEREST_ONLY &&
      allocation.instrument.repaymentMethod !== FinancingRepaymentMethod.BULLET)
  ) {
    return null;
  }

  const overlapDays = overlapDaysForOutputRange(
    allocation.effectiveFrom,
    allocation.effectiveTo,
    dateRange
  );
  return Math.round((allocation.allocatedPrincipalAmount * annualRateBps * overlapDays) / 10000 / 365);
}

function revenueRightAssigneeText(
  assignment: ReturnType<typeof assetReturnTrialRevenueRightAssignmentView>
) {
  const assigneeType = labelOf(revenueRightAssigneeTypeLabels, assignment.assigneeType);
  const assigneeName = safeCell(assignment.assigneeName);
  return assigneeName === "-" ? assigneeType : `${assigneeType}：${assigneeName}`;
}

function revenueShareRuleSupport(rule: ReturnType<typeof assetReturnTrialRevenueShareRuleView>) {
  if (rule.shareBasis === RevenueShareBasis.GROSS_RECEIVABLE) {
    return {
      reason: "GROSS_RECEIVABLE 分润口径暂未接入 ROE 试算。",
      supported: false
    };
  }

  if (rule.shareBasis === RevenueShareBasis.MANUAL) {
    return {
      reason: "MANUAL 分润口径需人工结算，暂未接入 ROE 试算。",
      supported: false
    };
  }

  return { reason: "-", supported: true };
}

function revenueShareRuleBaseAmount(
  rule: ReturnType<typeof assetReturnTrialRevenueShareRuleView>,
  income: {
    operatingRevenueAmount?: number | null;
    rentalPaidAmount?: number | null;
  }
) {
  if (rule.shareBasis === RevenueShareBasis.RENTAL_PAID) {
    return income.rentalPaidAmount ?? null;
  }

  if (rule.shareBasis === RevenueShareBasis.OPERATING_REVENUE) {
    return income.operatingRevenueAmount ?? null;
  }

  return null;
}

function overlapDaysForOutputRange(
  effectiveFrom: Date,
  effectiveTo: Date | null | undefined,
  dateRange: ReportDateRangeOutput
) {
  const startDate = maxBusinessDate(dateRange.startDate, formatDateOnly(effectiveFrom));
  const endDate = minBusinessDate(
    dateRange.endDate,
    effectiveTo ? formatDateOnly(effectiveTo) : dateRange.endDate
  );
  return inclusiveBusinessDays(startDate, endDate);
}

function assetReturnTrialUnavailableReasonText(row: {
  costProfileMissing?: boolean | null;
  costUnavailableReason?: string | null;
  manualDepreciationUnsupported?: boolean | null;
}) {
  if (row.costProfileMissing) {
    return "该车辆尚未配置资产成本参数，无法试算 ROA。";
  }

  if (row.manualDepreciationUnsupported) {
    return row.costUnavailableReason ?? MANUAL_DEPRECIATION_UNSUPPORTED_REASON;
  }

  return row.costUnavailableReason ?? "-";
}

function lifecycleNodeDescription(node: {
  amount?: number | null;
  label?: string | null;
  status?: string | null;
  type?: string | null;
}) {
  const label =
    node.type === "INITIAL_POOL" ||
    node.type === "RETURN_REINIT" ||
    node.type === "SALE_PRICE_REVIEW"
      ? labelOf(vehicleSalePriceReviewTypeLabels, node.label)
      : safeCell(node.label);
  const value =
    node.amount !== undefined && node.amount !== null
      ? formatMoneyYuan(node.amount)
      : safeCell(node.status);

  if (label === "-") {
    return value;
  }
  if (value === "-") {
    return label;
  }

  return `${label} / ${value}`;
}

function latestByDate<TItem>(items: TItem[], getValue: (item: TItem) => Date | null | undefined) {
  return [...items].sort((left, right) => {
    const leftTime = getValue(left)?.getTime() ?? 0;
    const rightTime = getValue(right)?.getTime() ?? 0;
    return rightTime - leftTime;
  })[0];
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

function resolveResidualHorizonMonth(query: Pick<AssetReturnTrialQueryDto, "residualHorizonMonth">) {
  return query.residualHorizonMonth ?? DEFAULT_RESIDUAL_HORIZON_MONTH;
}

function resolveResidualCalibrationPercent(
  query: Pick<AssetReturnTrialQueryDto, "residualCalibrationPercent">
) {
  const value = query.residualCalibrationPercent ?? DEFAULT_RESIDUAL_CALIBRATION_PERCENT;
  if (
    !Number.isInteger(value) ||
    value < MIN_RESIDUAL_CALIBRATION_PERCENT ||
    value > MAX_RESIDUAL_CALIBRATION_PERCENT
  ) {
    throw new BadRequestException(
      `residualCalibrationPercent must be an integer between ${MIN_RESIDUAL_CALIBRATION_PERCENT} and ${MAX_RESIDUAL_CALIBRATION_PERCENT}.`
    );
  }

  return value;
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

function businessDateForInstant(value: Date) {
  return formatDateOnly(new Date(value.getTime() + BUSINESS_OFFSET_MS));
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
  const countByType = new Map(
    groups.map((group) => [String(group.transactionType), group._count._all])
  );
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
    {
      count: number;
      subscriptionPlanId: string | null;
      subscriptionPlanName: string | null;
      subscriptionPlanNo: string | null;
    }
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

const assetProfitabilityVehicleSelect = {
  acquisitionMode: true,
  batteryCapacityKwh: true,
  batteryUsageType: true,
  brand: true,
  createdAt: true,
  currentSalePriceAmount: true,
  currentSalePriceReviewedAt: true,
  id: true,
  model: true,
  modelDefinition: { select: reportModelDefinitionSelect },
  modelDefinitionId: true,
  plateNo: true,
  purchasePriceAmount: true,
  salePriceStatus: true,
  salePriceHistories: {
    orderBy: { effectiveFrom: "asc" as const },
    select: {
      afterSalePriceAmount: true,
      beforeSalePriceAmount: true,
      createdAt: true,
      effectiveFrom: true,
      effectiveTo: true,
      id: true,
      reason: true,
      remark: true,
      reviewQuarter: true,
      reviewType: true
    },
    where: {}
  },
  series: true,
  status: true,
  vehicleModel: true,
  vehicleNo: true,
  vin: true
} satisfies Prisma.VehicleSelect;

const assetProfitabilityVehicleDetailSelect = {
  ...assetProfitabilityVehicleSelect,
  deliveries: {
    orderBy: { deliveredAt: "asc" as const },
    select: {
      deliveredAt: true,
      deliveryNo: true,
      deliveryStatus: true,
      id: true,
      orderId: true,
      scheduledAt: true
    },
    where: { deletedAt: null }
  },
  returnDamages: {
    orderBy: { createdAt: "asc" as const },
    select: {
      createdAt: true,
      damageLevel: true,
      damageType: true,
      description: true,
      estimatedRepairAmount: true,
      id: true,
      orderId: true,
      responsibleParty: true,
      vehicleReturn: { select: { returnNo: true } },
      status: true
    },
    where: { deletedAt: null }
  },
  returns: {
    orderBy: { returnedAt: "asc" as const },
    select: {
      id: true,
      orderId: true,
      returnedAt: true,
      returnNo: true,
      returnStatus: true,
      scheduledAt: true
    },
    where: { deletedAt: null }
  }
} satisfies Prisma.VehicleSelect;

const assetCostProfileSelect = {
  annualInsuranceCostAmount: true,
  annualMaintenanceReserveAmount: true,
  capitalCostRateBps: true,
  createdAt: true,
  createdBy: true,
  deletedAt: true,
  depreciationMethod: true,
  depreciationStartDate: true,
  id: true,
  otherMonthlyCostAmount: true,
  profileStatus: true,
  remark: true,
  residualValueAmount: true,
  snapshot: true,
  updatedAt: true,
  updatedBy: true,
  usefulLifeMonths: true,
  vehicleId: true
} satisfies Prisma.VehicleAssetCostProfileSelect;

const activeAssetCostProfileRelationSelect = {
  orderBy: { updatedAt: "desc" as const },
  select: assetCostProfileSelect,
  take: 1,
  where: {
    deletedAt: null,
    profileStatus: VehicleAssetCostProfileStatus.ACTIVE
  }
};

const assetReturnTrialVehicleSelect = {
  ...assetProfitabilityVehicleSelect,
  assetCostProfiles: activeAssetCostProfileRelationSelect
} satisfies Prisma.VehicleSelect;

const assetReturnTrialVehicleDetailSelect = {
  ...assetProfitabilityVehicleDetailSelect,
  assetCostProfiles: activeAssetCostProfileRelationSelect
} satisfies Prisma.VehicleSelect;

const assetReturnDepreciationPolicySelect = {
  basisSource: true,
  currency: true,
  depreciationBasisAmount: true,
  depreciationEndDate: true,
  depreciationMethod: true,
  depreciationStartDate: true,
  id: true,
  monthlyDepreciationAmount: true,
  policyNo: true,
  policyStatus: true,
  residualValueAmount: true,
  usefulLifeMonths: true,
  vehicleId: true
} satisfies Prisma.VehicleDepreciationPolicySelect;

const assetReturnDepreciationRecordSelect = {
  confirmedAt: true,
  costPeriod: true,
  currency: true,
  depreciationAmount: true,
  id: true,
  lockedAt: true,
  periodEnd: true,
  periodStart: true,
  policyId: true,
  recordNo: true,
  recordSource: true,
  recordStatus: true,
  scheduleId: true,
  vehicleId: true,
  voidedAt: true
} satisfies Prisma.VehicleDepreciationRecordSelect;

const assetReturnDepreciationScheduleSelect = {
  costPeriod: true,
  id: true,
  periodEnd: true,
  periodStart: true,
  policyId: true,
  scheduleNo: true,
  scheduleStatus: true,
  vehicleId: true
} satisfies Prisma.VehicleDepreciationScheduleSelect;

const assetReturnBaasContractSelect = {
  batteryPackageName: true,
  batterySerialNo: true,
  billingCycle: true,
  contractNo: true,
  contractStatus: true,
  effectiveFrom: true,
  effectiveTo: true,
  id: true,
  paymentDayOfMonth: true,
  providerContractNo: true,
  providerName: true,
  rentalAmount: true,
  vehicleId: true
} satisfies Prisma.VehicleBaasContractSelect;

const assetReturnBaasCostRecordSelect = {
  confirmedAt: true,
  contractId: true,
  costAmount: true,
  costPeriod: true,
  costRecordNo: true,
  costSource: true,
  costStatus: true,
  currency: true,
  dueDate: true,
  id: true,
  invoiceNo: true,
  paidAt: true,
  paymentRefNo: true,
  periodEnd: true,
  periodStart: true,
  vehicleId: true,
  voidedAt: true
} satisfies Prisma.VehicleBaasCostRecordSelect;

const assetProfitabilityOrderSelect = {
  actualDeliveryAt: true,
  actualReturnAt: true,
  createdAt: true,
  customer: { select: { name: true } },
  endDate: true,
  id: true,
  monthlyFeeAmount: true,
  orderNo: true,
  orderStatus: true,
  vehicleId: true
} satisfies Prisma.SubscriptionOrderSelect;

const assetProfitabilityBillSelect = {
  amount: true,
  billNo: true,
  billPeriodEnd: true,
  billPeriodStart: true,
  billStatus: true,
  billType: true,
  dueDate: true,
  id: true,
  order: { select: { orderNo: true, vehicleId: true } },
  orderId: true,
  paidAmount: true,
  remainingAmount: true
} satisfies Prisma.ReceivableBillSelect;

const assetReturnTrialCapitalEventSelect = {
  debtPrincipalAmount: true,
  effectiveFrom: true,
  effectiveTo: true,
  equityCapitalAmount: true,
  eventNo: true,
  eventStatus: true,
  eventType: true,
  financingInstrumentId: true,
  id: true,
  remark: true,
  vehicleId: true
} satisfies Prisma.VehicleCapitalEventSelect;

const assetReturnTrialFinancingAllocationSelect = {
  allocatedPrincipalAmount: true,
  allocationNo: true,
  allocationRatioBps: true,
  allocationStatus: true,
  effectiveFrom: true,
  effectiveTo: true,
  id: true,
  instrument: {
    select: {
      annualRateBps: true,
      id: true,
      instrumentNo: true,
      instrumentStatus: true,
      instrumentType: true,
      lenderName: true,
      principalAmount: true,
      repaymentMethod: true
    }
  },
  instrumentId: true,
  remark: true,
  vehicleId: true
} satisfies Prisma.FinancingInstrumentVehicleSelect;

const assetReturnTrialRevenueRightAssignmentSelect = {
  assigneeName: true,
  assigneeType: true,
  assignmentNo: true,
  assignmentStatus: true,
  assignmentType: true,
  bill: {
    select: {
      billNo: true,
      billType: true,
      id: true,
      order: { select: { orderNo: true, vehicleId: true } },
      orderId: true,
      paidAmount: true
    }
  },
  billId: true,
  effectiveFrom: true,
  effectiveTo: true,
  financingInstrument: {
    select: {
      id: true,
      instrumentNo: true,
      instrumentType: true,
      lenderName: true
    }
  },
  financingInstrumentId: true,
  id: true,
  order: { select: { id: true, orderNo: true, vehicleId: true } },
  orderId: true,
  priority: true,
  releasedAt: true,
  releaseReason: true,
  remark: true,
  shareRatioBps: true,
  targetType: true,
  vehicleId: true
} satisfies Prisma.RevenueRightAssignmentSelect;

const assetReturnTrialRevenueShareRuleSelect = {
  effectiveFrom: true,
  effectiveTo: true,
  fixedMonthlyAmount: true,
  id: true,
  minimumGuaranteeAmount: true,
  ownerName: true,
  ownerShareBps: true,
  platformShareBps: true,
  remark: true,
  ruleNo: true,
  ruleStatus: true,
  ruleType: true,
  settlementCycle: true,
  shareBasis: true,
  vehicleId: true
} satisfies Prisma.RevenueShareRuleSelect;

const assetReturnResidualForecastSelect = {
  asOfDate: true,
  createdAt: true,
  curve: {
    select: {
      batteryCapacityKwh: true,
      batteryUsageType: true,
      brand: true,
      confidenceScore: true,
      curveMethod: true,
      curveNo: true,
      curveStatus: true,
      id: true,
      model: true,
      modelYear: true,
      series: true,
      trim: true
    }
  },
  curveId: true,
  forecastMethod: true,
  forecastNo: true,
  forecastStatus: true,
  id: true,
  points: {
    select: {
      adoptedResidualAmount: true,
      confidenceScore: true,
      horizonMonth: true,
      id: true,
      interpolationMethod: true,
      lowerBoundAmount: true,
      matchedCurvePointAgeMonth: true,
      pointStatus: true,
      predictedResidualAmount: true,
      predictedResidualRateBps: true,
      targetAgeMonth: true,
      targetDate: true,
      upperBoundAmount: true
    }
  },
  vehicleId: true
} satisfies Prisma.VehicleResidualForecastSelect;

type AssetProfitabilityVehicleRecord = Prisma.VehicleGetPayload<{
  select: typeof assetProfitabilityVehicleSelect;
}>;
type AssetProfitabilityVehicleDetailRecord = Prisma.VehicleGetPayload<{
  select: typeof assetProfitabilityVehicleDetailSelect;
}>;
type AssetReturnTrialVehicleRecord = Prisma.VehicleGetPayload<{
  select: typeof assetReturnTrialVehicleSelect;
}>;
type AssetCostProfileRecord = AssetReturnTrialVehicleRecord["assetCostProfiles"][number];
type AssetProfitabilityOrderRecord = Prisma.SubscriptionOrderGetPayload<{
  select: typeof assetProfitabilityOrderSelect;
}>;
type AssetProfitabilityBillRecord = Prisma.ReceivableBillGetPayload<{
  select: typeof assetProfitabilityBillSelect;
}>;
type AssetReturnTrialCapitalEventRecord = Prisma.VehicleCapitalEventGetPayload<{
  select: typeof assetReturnTrialCapitalEventSelect;
}>;
type AssetReturnTrialFinancingAllocationRecord =
  Prisma.FinancingInstrumentVehicleGetPayload<{
    select: typeof assetReturnTrialFinancingAllocationSelect;
  }>;
type AssetReturnTrialRevenueRightAssignmentRecord =
  Prisma.RevenueRightAssignmentGetPayload<{
    select: typeof assetReturnTrialRevenueRightAssignmentSelect;
  }>;
type AssetReturnTrialRevenueShareRuleRecord = Prisma.RevenueShareRuleGetPayload<{
  select: typeof assetReturnTrialRevenueShareRuleSelect;
}>;
type AssetReturnResidualForecastRecord = Prisma.VehicleResidualForecastGetPayload<{
  select: typeof assetReturnResidualForecastSelect;
}>;
type AssetReturnResidualForecastPointRecord = AssetReturnResidualForecastRecord["points"][number];
type AssetReturnBaasContractRecord = Prisma.VehicleBaasContractGetPayload<{
  select: typeof assetReturnBaasContractSelect;
}>;
type AssetReturnBaasCostRecord = Prisma.VehicleBaasCostRecordGetPayload<{
  select: typeof assetReturnBaasCostRecordSelect;
}>;
type AssetReturnBaasAllocatedCostRecord = AssetReturnBaasCostRecord & {
  allocationRatio: number | null;
  fullCostRecordAmount: number;
  includedProratedAmount: number;
  overlapDays: number;
  totalDays: number;
};
type AssetReturnDepreciationSource =
  | typeof DEPRECIATION_SOURCE_RECORDS
  | typeof DEPRECIATION_SOURCE_LEGACY_COST_PROFILE
  | typeof DEPRECIATION_SOURCE_NONE
  | typeof DEPRECIATION_SOURCE_UNAVAILABLE;
type AssetReturnDepreciationPolicyRecord = Prisma.VehicleDepreciationPolicyGetPayload<{
  select: typeof assetReturnDepreciationPolicySelect;
}>;
type AssetReturnDepreciationRecord = Prisma.VehicleDepreciationRecordGetPayload<{
  select: typeof assetReturnDepreciationRecordSelect;
}>;
type AssetReturnDepreciationScheduleRecord = Prisma.VehicleDepreciationScheduleGetPayload<{
  select: typeof assetReturnDepreciationScheduleSelect;
}>;
type AssetReturnDepreciationAllocatedRecord = AssetReturnDepreciationRecord & {
  allocationRatio: number | null;
  fullDepreciationAmount: number;
  includedProratedAmount: number;
  overlapDays: number;
  totalDays: number;
};
type AssetReturnPeriodCost = ReturnType<typeof buildVehicleAssetPeriodCost> & {
  depreciationMissingReasons: string[];
  depreciationWarnings: string[];
};
type AssetProfitabilitySortField = NonNullable<AssetProfitabilityVehicleListQueryDto["sortBy"]>;
type AssetReturnTrialSortField = NonNullable<AssetReturnTrialVehicleListQueryDto["sortBy"]>;

type AssetReturnRoeContext = {
  capitalEvents: AssetReturnTrialCapitalEventRecord[];
  financingAllocations: AssetReturnTrialFinancingAllocationRecord[];
  revenueRightAssignments: AssetReturnTrialRevenueRightAssignmentRecord[];
  revenueShareRules: AssetReturnTrialRevenueShareRuleRecord[];
  vehicleId: string;
  vehiclePoolRevenueRightWarning: boolean;
};

type AssetReturnResidualForecastContext = {
  forecast: AssetReturnResidualForecastRecord | null;
  horizonMonth: number;
  point: AssetReturnResidualForecastPointRecord | null;
  unavailableReason: string | null;
  vehicleId: string;
};

type AssetReturnBaasCostSummary = {
  confirmedCostAmount: number;
  costAmount: number;
  costRecordCount: number;
  fullCostRecordAmount: number;
  overdueCostAmount: number;
  paidCostAmount: number;
  scheduledCostAmount: number;
};

type AssetReturnBaasContext = {
  currentContract: AssetReturnBaasContractRecord | null;
  records: AssetReturnBaasAllocatedCostRecord[];
  summary: AssetReturnBaasCostSummary;
  vehicleId: string;
};

type AssetReturnDepreciationSummary = {
  amount: number | null;
  legacyAmount: number | null;
  missingReasons: string[];
  policyId: string | null;
  policyNo: string | null;
  recordAmount: number;
  recordCount: number;
  source: AssetReturnDepreciationSource;
  unconfirmedScheduleCount: number;
  warnings: string[];
};

type AssetReturnDepreciationContext = {
  policy: AssetReturnDepreciationPolicyRecord | null;
  records: AssetReturnDepreciationAllocatedRecord[];
  schedules: AssetReturnDepreciationScheduleRecord[];
  summary: AssetReturnDepreciationSummary;
  vehicleId: string;
};

const ROE_UNAVAILABLE_REASON = "缺少债务 / 自有资本拆分模型，暂不输出正式 ROE。";
const MISSING_COST_PROFILE_REASON = "缺少 ACTIVE 车辆资产成本参数，无法试算 ROA。";
const DEFAULT_RESIDUAL_HORIZON_MONTH = 12;
const DEFAULT_RESIDUAL_CALIBRATION_PERCENT = 0;
const MIN_RESIDUAL_CALIBRATION_PERCENT = -30;
const MAX_RESIDUAL_CALIBRATION_PERCENT = 30;
const RESIDUAL_FORECAST_MISSING_REASON = "未找到有效残值预测记录。";
const RESIDUAL_FORECAST_POINT_MISSING_REASON = "未找到指定预测周期的残值预测点。";
const RESIDUAL_FORECAST_UNSUPPORTED_REASON = "该预测点暂不支持，可能超出残值曲线范围。";
const RESIDUAL_FORECAST_AMOUNT_MISSING_REASON = "预测点缺少预测残值金额。";
const RESIDUAL_CURRENT_SALE_PRICE_MISSING_WARNING = "车辆缺少当前销售价，无法计算相对当前销售价差异。";
const RESIDUAL_COST_PROFILE_MISSING_WARNING = "车辆成本参数缺少预计残值，无法计算相对成本参数残值差异。";
const MARKET_CALIBRATION_RESIDUAL_MISSING_REASON =
  "缺少可用残值预测，无法计算市场校准折旧对比。";
const MARKET_CALIBRATION_BASELINE_MISSING_REASON =
  "车辆成本参数缺少预计残值，无法计算市场校准折旧对比。";
const MARKET_CALIBRATION_MAIN_RETURN_MISSING_REASON =
  "主平台权益净收益不可用，无法计算市场校准折旧对比。";
const BAAS_COST_INCLUDED_STATUSES: VehicleBaasCostRecordStatus[] = [
  VehicleBaasCostRecordStatus.SCHEDULED,
  VehicleBaasCostRecordStatus.CONFIRMED,
  VehicleBaasCostRecordStatus.PAID,
  VehicleBaasCostRecordStatus.OVERDUE
];
const BAAS_COST_ALLOCATION_METHOD = "PERIOD_PRORATED";
const DEPRECIATION_RECORD_INCLUDED_STATUSES: VehicleDepreciationRecordStatus[] = [
  VehicleDepreciationRecordStatus.CONFIRMED,
  VehicleDepreciationRecordStatus.LOCKED
];
const DEPRECIATION_ALLOCATION_METHOD = "PERIOD_PRORATED";
const DEPRECIATION_SOURCE_RECORDS = "RECORDS";
const DEPRECIATION_SOURCE_LEGACY_COST_PROFILE = "LEGACY_COST_PROFILE";
const DEPRECIATION_SOURCE_NONE = "NONE";
const DEPRECIATION_SOURCE_UNAVAILABLE = "UNAVAILABLE";
const DEPRECIATION_MISSING_RECORD_REASON = "缺少已确认折旧记录";
const MANUAL_DEPRECIATION_POLICY_MISSING_RECORD_REASON = "手工折旧策略缺少折旧记录";
const STRAIGHT_LINE_DEPRECIATION_UNCONFIRMED_SCHEDULE_REASON =
  "直线折旧策略存在未确认折旧计划";
const INVALID_DEPRECIATION_RECORD_PERIOD_WARNING = "折旧记录期间无效，已按 0 计入。";
const operatingRevenueBillTypes: BillType[] = [
  BillType.FIRST_MONTHLY_FEE,
  BillType.MONTHLY_RENT,
  BillType.DAMAGE_FEE,
  BillType.OTHER
];

type OrderProfitabilityMetrics = {
  damagePaidAmount: number;
  otherPaidAmount: number;
  rentalPaidAmount: number;
};

type AssetProfitabilityMetrics = {
  bills: AssetProfitabilityBillRecord[];
  currentOrder: AssetProfitabilityOrderRecord | null;
  damagePaidAmount: number;
  depositCollectedAmount: number;
  lastDeliveryAt: Date | null;
  lastReturnAt: Date | null;
  leasedDays: number;
  operatingDays: number;
  orderMetricsById: Map<string, OrderProfitabilityMetrics>;
  orders: AssetProfitabilityOrderRecord[];
  otherPaidAmount: number;
  rentalPaidAmount: number;
  totalPaidAmount: number;
  totalReceivableAmount: number;
  totalRemainingAmount: number;
};

function assetProfitabilityVehicleWhere(
  query: Pick<AssetProfitabilityQueryDto, "vehicleStatus">,
  modelWhere: Prisma.VehicleWhereInput = {}
): Prisma.VehicleWhereInput {
  return {
    deletedAt: null,
    ...modelWhere,
    ...(query.vehicleStatus ? { status: query.vehicleStatus } : {})
  };
}

function reportModelDefinitionSummary(definition: ReportModelDefinition | null | undefined) {
  if (!definition || definition.deletedAt) {
    return null;
  }

  return {
    customerDisplayName: definition.customerDisplayName,
    displayName: definition.displayName,
    id: definition.id,
    legacyVehicleModel: definition.legacyVehicleModel,
    modelCode: definition.modelCode
  };
}

function reportVehicleModelDisplayName(
  definition: ReportModelDefinition | null | undefined,
  vehicleModel: VehicleModel | string | null | undefined
) {
  const summary = reportModelDefinitionSummary(definition);
  return summary?.displayName ?? vehicleModel ?? null;
}

function assetProfitabilityVehicleRow(
  vehicle: AssetProfitabilityVehicleRecord,
  metrics: AssetProfitabilityMetrics
) {
  const purchasePriceAmount = toNumber(vehicle.purchasePriceAmount);
  const currentOrder = metrics.currentOrder;

  return {
    acquisitionMode: vehicle.acquisitionMode,
    vehicleId: vehicle.id,
    vehicleNo: vehicle.vehicleNo,
    vin: vehicle.vin,
    plateNo: vehicle.plateNo,
    brand: vehicle.brand,
    series: vehicle.series,
    model: vehicle.model,
    modelDefinition: reportModelDefinitionSummary(vehicle.modelDefinition),
    modelDefinitionId: vehicle.modelDefinitionId,
    modelDisplayName: reportVehicleModelDisplayName(vehicle.modelDefinition, vehicle.vehicleModel),
    vehicleModel: vehicle.vehicleModel,
    batteryCapacityKwh: decimalToNumber(vehicle.batteryCapacityKwh),
    batteryUsageType: vehicle.batteryUsageType,
    vehicleStatus: vehicle.status,
    purchasePriceAmount,
    currentSalePriceAmount: toNumber(vehicle.currentSalePriceAmount),
    rentalPaidAmount: metrics.rentalPaidAmount,
    damagePaidAmount: metrics.damagePaidAmount,
    otherPaidAmount: metrics.otherPaidAmount,
    depositCollectedAmount: metrics.depositCollectedAmount,
    totalReceivableAmount: metrics.totalReceivableAmount,
    totalPaidAmount: metrics.totalPaidAmount,
    totalRemainingAmount: metrics.totalRemainingAmount,
    leasedDays: metrics.leasedDays,
    operatingDays: metrics.operatingDays,
    utilizationRate: metrics.operatingDays === 0 ? 0 : metrics.leasedDays / metrics.operatingDays,
    // simpleReturnRate is a simplified operating return rate, not accounting ROA or ROE.
    simpleReturnRate:
      purchasePriceAmount <= 0 ? null : metrics.rentalPaidAmount / purchasePriceAmount,
    currentOrderNo: currentOrder?.orderNo ?? null,
    currentCustomerName: currentOrder?.customer.name ?? null,
    lastDeliveryAt: metrics.lastDeliveryAt,
    lastReturnAt: metrics.lastReturnAt
  };
}

function assetReturnTrialVehicleRow(
  vehicle: AssetReturnTrialVehicleRecord,
  metrics: AssetProfitabilityMetrics,
  range: ReturnType<typeof resolveReportDateRange>,
  roeContext: AssetReturnRoeContext = emptyAssetReturnRoeContext(vehicle.id),
  residualContext: AssetReturnResidualForecastContext = emptyAssetReturnResidualForecastContext(
    vehicle.id,
    DEFAULT_RESIDUAL_HORIZON_MONTH
  ),
  depreciationContext: AssetReturnDepreciationContext = emptyAssetReturnDepreciationContext(
    vehicle.id
  )
) {
  const baseRow = assetProfitabilityVehicleRow(vehicle, metrics);
  const profile = activeCostProfileFor(vehicle);
  const operatingRevenueAmount =
    baseRow.rentalPaidAmount + baseRow.damagePaidAmount + baseRow.otherPaidAmount;
  const analysisDays = inclusiveBusinessDays(range.output.startDate, range.output.endDate);

  if (!profile) {
    const depreciationFields = depreciationFieldsForMissingCostProfile(depreciationContext);
    const roeFields = buildAssetReturnRoeTrialFields({
      analysisDays,
      baseRow,
      depreciationMissingReasons: depreciationFields.depreciationMissingReasons,
      depreciationWarnings: depreciationFields.depreciationWarnings,
      metrics,
      operatingRevenueAmount,
      periodCost: null,
      range,
      roeContext,
      vehicle
    });
    const residualFields = buildAssetReturnResidualForecastFields({
      analysisDays,
      baseRow,
      profile: null,
      residualContext,
      roeFields,
      vehicle
    });

    return {
      ...baseRow,
      ...roeFields,
      ...residualFields,
      costDays: 0,
      costProfileMissing: true,
      costProfileStatus: null,
      costUnavailableReason: MISSING_COST_PROFILE_REASON,
      ...depreciationFields,
      depreciationCostAmount: null,
      insuranceCostAmount: null,
      maintenanceReserveCostAmount: null,
      manualDepreciationUnsupported: false,
      operatingRevenueAmount,
      otherCostAmount: null
    };
  }

  const costDays = costDaysForProfile(profile, range);
  const legacyPeriodCost = buildVehicleAssetPeriodCost(vehicle, profile, costDays);
  const { depreciationFields, periodCost } = applyDepreciationContextToPeriodCost(
    legacyPeriodCost,
    depreciationContext,
    profile
  );
  const roeFields = buildAssetReturnRoeTrialFields({
    analysisDays,
    baseRow,
    depreciationMissingReasons: depreciationFields.depreciationMissingReasons,
    depreciationWarnings: depreciationFields.depreciationWarnings,
    metrics,
    operatingRevenueAmount,
    periodCost,
    range,
    roeContext,
    vehicle
  });
  const residualFields = buildAssetReturnResidualForecastFields({
    analysisDays,
    baseRow,
    profile,
    residualContext,
    roeFields,
    vehicle
  });

  return {
    ...baseRow,
    ...periodCost,
    ...roeFields,
    ...residualFields,
    ...depreciationFields,
    costDays,
    costProfileMissing: false,
    costProfileStatus: profile.profileStatus,
    costUnavailableReason: periodCost.manualDepreciationUnsupported
      ? MANUAL_DEPRECIATION_UNSUPPORTED_REASON
      : depreciationFields.depreciationMissingReasons.join("；") || null,
    operatingRevenueAmount
  };
}

function buildAssetReturnRoeTrialFields({
  analysisDays,
  baseRow,
  depreciationMissingReasons,
  depreciationWarnings,
  metrics,
  operatingRevenueAmount,
  periodCost,
  range,
  roeContext,
  vehicle
}: {
  analysisDays: number;
  baseRow: ReturnType<typeof assetProfitabilityVehicleRow>;
  depreciationMissingReasons: string[];
  depreciationWarnings: string[];
  metrics: AssetProfitabilityMetrics;
  operatingRevenueAmount: number;
  periodCost: AssetReturnPeriodCost | null;
  range: ReturnType<typeof resolveReportDateRange>;
  roeContext: AssetReturnRoeContext;
  vehicle: AssetReturnTrialVehicleRecord;
}) {
  const missingReasons: string[] = [];
  const warnings: string[] = [...depreciationWarnings];

  if (!periodCost) {
    missingReasons.push(MISSING_COST_PROFILE_REASON);
  } else if (periodCost.manualDepreciationUnsupported) {
    missingReasons.push(MANUAL_DEPRECIATION_UNSUPPORTED_REASON);
  }
  missingReasons.push(...depreciationMissingReasons);

  if (roeContext.vehiclePoolRevenueRightWarning) {
    warnings.push("车辆池收益权归集暂未接入 ROE 试算。");
  }

  const revenueRightImpact = calculateRevenueRightImpact(
    roeContext.revenueRightAssignments,
    metrics,
    operatingRevenueAmount,
    warnings
  );
  const revenueShareImpact = calculateRevenueShareImpact(
    roeContext.revenueShareRules,
    baseRow,
    operatingRevenueAmount,
    range,
    missingReasons,
    warnings
  );
  const debtImpact = calculateDebtImpact(roeContext.financingAllocations, range, missingReasons);
  const equityImpact = calculateRoeEquityBaseAmount(
    vehicle,
    roeContext.capitalEvents,
    debtImpact.debtPrincipalAmount,
    warnings
  );

  if (equityImpact.roeEquityBaseAmount === null || equityImpact.roeEquityBaseAmount <= 0) {
    missingReasons.push("权益资本基数缺失或小于等于 0。");
  }

  const hasFinancingAllocation = roeContext.financingAllocations.length > 0;
  const capitalCostSource = hasFinancingAllocation
    ? "FINANCING_INSTRUMENT"
    : periodCost
      ? "COST_PROFILE"
      : null;
  const capitalCostAmount = hasFinancingAllocation
    ? debtImpact.debtInterestCostAmount
    : periodCost?.capitalCostAmount ?? null;
  const operatingCostAmount =
    periodCost &&
    periodCost.depreciationCostAmount !== null &&
    capitalCostAmount !== null
      ? periodCost.depreciationCostAmount +
        capitalCostAmount +
        periodCost.insuranceCostAmount +
        periodCost.maintenanceReserveCostAmount +
        periodCost.otherCostAmount
      : null;
  const trialNetOperatingIncomeAmount =
    operatingCostAmount === null ? null : operatingRevenueAmount - operatingCostAmount;
  const trialRoa =
    trialNetOperatingIncomeAmount === null || baseRow.purchasePriceAmount <= 0
      ? null
      : trialNetOperatingIncomeAmount / baseRow.purchasePriceAmount;
  const platformRetainedRevenueAmount =
    operatingRevenueAmount -
    revenueRightImpact.assignedOutRevenueAmount -
    revenueShareImpact.ownerShareAmount;
  const platformNetIncomeAmount =
    operatingCostAmount === null
      ? null
      : platformRetainedRevenueAmount -
        operatingCostAmount -
        revenueShareImpact.externalLeaseCostAmount;

  if (operatingCostAmount === null && !periodCost?.manualDepreciationUnsupported) {
    missingReasons.push("经营成本无法完整计算，暂不输出 ROE。");
  }

  const uniqueMissingReasons = uniqueStrings(missingReasons);
  const roeTrial =
    uniqueMissingReasons.length > 0 ||
    platformNetIncomeAmount === null ||
    equityImpact.roeEquityBaseAmount === null ||
    equityImpact.roeEquityBaseAmount <= 0
      ? null
      : platformNetIncomeAmount / equityImpact.roeEquityBaseAmount;

  return {
    annualizedRoeTrial:
      roeTrial === null || analysisDays <= 0 ? null : (roeTrial * 365) / analysisDays,
    annualizedTrialRoa:
      trialRoa === null || analysisDays <= 0 ? null : (trialRoa * 365) / analysisDays,
    assignedOutRevenueAmount: revenueRightImpact.assignedOutRevenueAmount,
    capitalCostAmount,
    capitalCostSource,
    debtInterestCostAmount: debtImpact.debtInterestCostAmount,
    debtPrincipalAmount: debtImpact.debtPrincipalAmount,
    externalLeaseCostAmount: revenueShareImpact.externalLeaseCostAmount,
    operatingCostAmount,
    ownerShareAmount: revenueShareImpact.ownerShareAmount,
    platformNetIncomeAmount,
    platformRetainedRevenueAmount,
    pledgedRevenueAmount: revenueRightImpact.pledgedRevenueAmount,
    pledgedRevenueRatio:
      operatingRevenueAmount <= 0
        ? null
        : revenueRightImpact.pledgedRevenueAmount / operatingRevenueAmount,
    roeDataReady: roeTrial !== null,
    roeEquityBaseAmount: equityImpact.roeEquityBaseAmount,
    roeMissingReasons: uniqueMissingReasons,
    roeTrial,
    roeUnavailableReason:
      roeTrial === null ? uniqueMissingReasons.join("；") || ROE_UNAVAILABLE_REASON : null,
    roeWarnings: uniqueStrings(warnings),
    trialNetOperatingIncomeAmount,
    trialRoa
  };
}

function buildAssetReturnResidualForecastFields({
  analysisDays,
  baseRow,
  profile,
  residualContext,
  roeFields,
  vehicle
}: {
  analysisDays: number;
  baseRow: ReturnType<typeof assetProfitabilityVehicleRow>;
  profile: AssetCostProfileRecord | null;
  residualContext: AssetReturnResidualForecastContext;
  roeFields: ReturnType<typeof buildAssetReturnRoeTrialFields>;
  vehicle: AssetReturnTrialVehicleRecord;
}) {
  const forecast = residualContext.forecast;
  const point = residualContext.point;
  const warnings: string[] = [];
  const costProfileResidualValueAmount = profile
    ? toNullableNumber(profile.residualValueAmount)
    : null;

  const baseFields = {
    costProfileResidualValueAmount,
    residualDeltaToCostProfileAmount: null as number | null,
    residualDeltaToCurrentSalePriceAmount: null as number | null,
    residualForecastAsOfDate: forecast?.asOfDate ?? null,
    residualForecastAvailable: false,
    residualForecastCurveNo: forecast?.curve?.curveNo ?? null,
    residualForecastHorizonMonth: residualContext.horizonMonth,
    residualForecastMethod: forecast?.forecastMethod ?? null,
    residualForecastNo: forecast?.forecastNo ?? null,
    residualForecastPoint: point ? residualForecastPointView(point, null) : null,
    residualForecastStatus: forecast?.forecastStatus ?? null,
    residualForecastSummary: null as ReturnType<typeof residualForecastSummaryView> | null,
    residualForecastTargetAgeMonth: point?.targetAgeMonth ?? null,
    residualForecastTargetDate: point?.targetDate ?? null,
    residualForecastUnavailableReason: residualContext.unavailableReason,
    residualForecastWarnings: warnings,
    residualForecastCurveSummary: forecast?.curve
      ? residualForecastCurveSummaryView(forecast.curve)
      : null,
    forecastConfidenceScore: point?.confidenceScore ?? null,
    forecastLowerBoundAmount: point ? toNullableNumber(point.lowerBoundAmount) : null,
    forecastResidualAmount: null as number | null,
    forecastResidualAmountSource: null as "ADOPTED" | "PREDICTED" | null,
    forecastResidualRateBps: null as number | null,
    forecastUpperBoundAmount: point ? toNullableNumber(point.upperBoundAmount) : null,
    residualSensitivityAnnualizedRoeTrial: null as number | null,
    residualSensitivityNetIncomeAmount: null as number | null,
    residualSensitivityRoeTrial: null as number | null
  };

  if (!forecast || !point) {
    return {
      ...baseFields,
      residualForecastSummary: residualForecastSummaryView(baseFields)
    };
  }

  if (point.pointStatus === VehicleResidualForecastPointStatus.UNSUPPORTED) {
    const unavailableFields = {
      ...baseFields,
      residualForecastUnavailableReason: RESIDUAL_FORECAST_UNSUPPORTED_REASON
    };
    return {
      ...unavailableFields,
      residualForecastSummary: residualForecastSummaryView(unavailableFields)
    };
  }

  const adoptedResidualAmount = toNullableNumber(point.adoptedResidualAmount);
  const predictedResidualAmount = toNullableNumber(point.predictedResidualAmount);
  const forecastResidualAmount = adoptedResidualAmount ?? predictedResidualAmount;
  if (forecastResidualAmount === null) {
    const unavailableFields = {
      ...baseFields,
      residualForecastUnavailableReason: RESIDUAL_FORECAST_AMOUNT_MISSING_REASON
    };
    return {
      ...unavailableFields,
      residualForecastSummary: residualForecastSummaryView(unavailableFields)
    };
  }

  const residualDeltaToCurrentSalePriceAmount =
    vehicle.currentSalePriceAmount === null
      ? null
      : forecastResidualAmount - Number(vehicle.currentSalePriceAmount);
  if (residualDeltaToCurrentSalePriceAmount === null) {
    warnings.push(RESIDUAL_CURRENT_SALE_PRICE_MISSING_WARNING);
  }

  const residualDeltaToCostProfileAmount =
    costProfileResidualValueAmount === null
      ? null
      : forecastResidualAmount - costProfileResidualValueAmount;
  if (residualDeltaToCostProfileAmount === null) {
    warnings.push(RESIDUAL_COST_PROFILE_MISSING_WARNING);
  }

  const residualSensitivityNetIncomeAmount =
    roeFields.platformNetIncomeAmount === null || residualDeltaToCostProfileAmount === null
      ? null
      : roeFields.platformNetIncomeAmount + residualDeltaToCostProfileAmount;
  const residualSensitivityRoeTrial =
    residualSensitivityNetIncomeAmount === null ||
    roeFields.roeEquityBaseAmount === null ||
    roeFields.roeEquityBaseAmount <= 0
      ? null
      : residualSensitivityNetIncomeAmount / roeFields.roeEquityBaseAmount;
  const availableFields = {
    ...baseFields,
    forecastResidualAmount,
    forecastResidualAmountSource:
      adoptedResidualAmount === null ? "PREDICTED" as const : "ADOPTED" as const,
    forecastResidualRateBps:
      baseRow.purchasePriceAmount <= 0
        ? null
        : Math.round((forecastResidualAmount / baseRow.purchasePriceAmount) * 10000),
    residualDeltaToCostProfileAmount,
    residualDeltaToCurrentSalePriceAmount,
    residualForecastAvailable: true,
    residualForecastPoint: residualForecastPointView(point, forecastResidualAmount),
    residualForecastUnavailableReason: null,
    residualSensitivityAnnualizedRoeTrial:
      residualSensitivityRoeTrial === null || analysisDays <= 0
        ? null
        : (residualSensitivityRoeTrial * 365) / analysisDays,
    residualSensitivityNetIncomeAmount,
    residualSensitivityRoeTrial
  };

  return {
    ...availableFields,
    residualForecastSummary: residualForecastSummaryView(availableFields)
  };
}

function residualForecastSummaryView(fields: {
  forecastResidualAmountSource: "ADOPTED" | "PREDICTED" | null;
  residualForecastAsOfDate: Date | null;
  residualForecastAvailable: boolean;
  residualForecastCurveNo: string | null;
  residualForecastHorizonMonth: number;
  residualForecastMethod: string | null;
  residualForecastNo: string | null;
  residualForecastStatus: string | null;
  residualForecastTargetDate: Date | null;
  residualForecastUnavailableReason: string | null;
  residualForecastWarnings: string[];
}) {
  return {
    amountSource: fields.forecastResidualAmountSource,
    asOfDate: fields.residualForecastAsOfDate,
    available: fields.residualForecastAvailable,
    curveNo: fields.residualForecastCurveNo,
    forecastMethod: fields.residualForecastMethod,
    forecastNo: fields.residualForecastNo,
    forecastStatus: fields.residualForecastStatus,
    horizonMonth: fields.residualForecastHorizonMonth,
    targetDate: fields.residualForecastTargetDate,
    unavailableReason: fields.residualForecastUnavailableReason,
    warnings: fields.residualForecastWarnings
  };
}

function residualForecastPointView(
  point: AssetReturnResidualForecastPointRecord,
  forecastResidualAmount: number | null
) {
  return {
    adoptedResidualAmount: toNullableNumber(point.adoptedResidualAmount),
    confidenceScore: point.confidenceScore,
    forecastResidualAmount,
    interpolationMethod: point.interpolationMethod,
    lowerBoundAmount: toNullableNumber(point.lowerBoundAmount),
    matchedCurvePointAgeMonth: point.matchedCurvePointAgeMonth,
    pointId: point.id,
    pointStatus: point.pointStatus,
    predictedResidualAmount: toNullableNumber(point.predictedResidualAmount),
    predictedResidualRateBps: point.predictedResidualRateBps,
    targetAgeMonth: point.targetAgeMonth,
    targetDate: point.targetDate,
    upperBoundAmount: toNullableNumber(point.upperBoundAmount)
  };
}

function residualForecastCurveSummaryView(
  curve: NonNullable<AssetReturnResidualForecastRecord["curve"]>
) {
  return {
    batteryCapacityKwh: decimalToNumber(curve.batteryCapacityKwh),
    batteryUsageType: curve.batteryUsageType,
    brand: curve.brand,
    confidenceScore: curve.confidenceScore,
    curveId: curve.id,
    curveMethod: curve.curveMethod,
    curveNo: curve.curveNo,
    curveStatus: curve.curveStatus,
    model: curve.model,
    modelYear: curve.modelYear,
    series: curve.series,
    trim: curve.trim
  };
}

function calculateRevenueRightImpact(
  assignments: AssetReturnTrialRevenueRightAssignmentRecord[],
  metrics: AssetProfitabilityMetrics,
  operatingRevenueAmount: number,
  warnings: string[]
) {
  let assignedOutRevenueAmount = 0;
  let pledgedRevenueAmount = 0;
  const hasRevenueShareRule = assignments.some(
    (assignment) => assignment.assignmentType === RevenueRightAssignmentType.REVENUE_SHARE
  );

  for (const assignment of assignments) {
    const baseAmount = revenueRightAssignmentBaseAmount(
      assignment,
      metrics,
      operatingRevenueAmount,
      warnings
    );
    const shareAmount = amountByBps(baseAmount, assignment.shareRatioBps ?? 10000);

    if (assignment.assignmentType === RevenueRightAssignmentType.PLEDGE) {
      pledgedRevenueAmount += shareAmount;
    } else if (
      assignment.assignmentType === RevenueRightAssignmentType.TRANSFER ||
      assignment.assignmentType === RevenueRightAssignmentType.SPV_POOL
    ) {
      assignedOutRevenueAmount += shareAmount;
    }
  }

  if (hasRevenueShareRule) {
    warnings.push("收益权 REVENUE_SHARE assignment 暂不直接扣减收入，请以分润规则计算为准。");
  }

  return {
    assignedOutRevenueAmount,
    pledgedRevenueAmount
  };
}

function revenueRightAssignmentBaseAmount(
  assignment: AssetReturnTrialRevenueRightAssignmentRecord,
  metrics: AssetProfitabilityMetrics,
  operatingRevenueAmount: number,
  warnings: string[]
) {
  if (assignment.targetType === RevenueRightTargetType.RECEIVABLE_BILL) {
    const bill = metrics.bills.find((candidate) => candidate.id === assignment.billId);
    return bill && operatingRevenueBillTypes.includes(bill.billType)
      ? toNumber(bill.paidAmount)
      : 0;
  }

  if (assignment.targetType === RevenueRightTargetType.ORDER) {
    return sumNumbers(
      metrics.bills
        .filter(
          (bill) =>
            bill.orderId === assignment.orderId && operatingRevenueBillTypes.includes(bill.billType)
        )
        .map((bill) => toNumber(bill.paidAmount))
    );
  }

  if (assignment.targetType === RevenueRightTargetType.VEHICLE) {
    return operatingRevenueAmount;
  }

  if (assignment.targetType === RevenueRightTargetType.VEHICLE_POOL) {
    warnings.push("车辆池收益权归集暂未接入 ROE 试算。");
  }

  return 0;
}

function calculateRevenueShareImpact(
  rules: AssetReturnTrialRevenueShareRuleRecord[],
  baseRow: ReturnType<typeof assetProfitabilityVehicleRow>,
  operatingRevenueAmount: number,
  range: ReturnType<typeof resolveReportDateRange>,
  missingReasons: string[],
  warnings: string[]
) {
  let externalLeaseCostAmount = 0;
  let ownerShareAmount = 0;

  if (rules.length > 1) {
    warnings.push("存在多条生效分润规则，ROE 试算按规则叠加，请确认口径。");
  }

  for (const rule of rules) {
    if (rule.shareBasis === RevenueShareBasis.GROSS_RECEIVABLE) {
      missingReasons.push("GROSS_RECEIVABLE 分润口径暂未接入 ROE 试算。");
      continue;
    }
    if (rule.shareBasis === RevenueShareBasis.MANUAL) {
      missingReasons.push("MANUAL 分润口径需人工结算，暂未接入 ROE 试算。");
      continue;
    }

    const shareBaseAmount =
      rule.shareBasis === RevenueShareBasis.RENTAL_PAID
        ? baseRow.rentalPaidAmount
        : operatingRevenueAmount;

    if (
      rule.ruleType === RevenueShareRuleType.REVENUE_SHARE ||
      rule.ruleType === RevenueShareRuleType.MIXED
    ) {
      if (rule.ownerShareBps === null || rule.ownerShareBps === undefined) {
        missingReasons.push("分润规则缺少车主分成比例，暂未接入 ROE 试算。");
      } else {
        ownerShareAmount += amountByBps(shareBaseAmount, rule.ownerShareBps);
      }
    }

    if (
      rule.ruleType === RevenueShareRuleType.FIXED_RENT ||
      rule.ruleType === RevenueShareRuleType.MIXED
    ) {
      const fixedMonthlyAmount = toNullableNumber(rule.fixedMonthlyAmount);
      if (fixedMonthlyAmount === null) {
        missingReasons.push("固定租金规则缺少固定月金额，暂未接入 ROE 试算。");
      } else {
        const overlapDays = overlapDaysForRange(rule.effectiveFrom, rule.effectiveTo, range);
        externalLeaseCostAmount += Math.round((fixedMonthlyAmount * 12 * overlapDays) / 365);
      }
    }
  }

  return {
    externalLeaseCostAmount,
    ownerShareAmount
  };
}

function calculateDebtImpact(
  allocations: AssetReturnTrialFinancingAllocationRecord[],
  range: ReturnType<typeof resolveReportDateRange>,
  missingReasons: string[]
) {
  let debtPrincipalAmount = 0;
  let debtInterestCostAmount = 0;
  let debtInterestUnavailable = false;

  for (const allocation of allocations) {
    const allocatedPrincipalAmount = toNumber(allocation.allocatedPrincipalAmount);
    debtPrincipalAmount += allocatedPrincipalAmount;
    const instrument = allocation.instrument;

    if (instrument.annualRateBps === null || instrument.annualRateBps === undefined) {
      missingReasons.push(`融资工具 ${instrument.instrumentNo} 缺少年化利率，无法计算债务利息。`);
      debtInterestUnavailable = true;
      continue;
    }

    if (
      instrument.repaymentMethod !== FinancingRepaymentMethod.INTEREST_ONLY &&
      instrument.repaymentMethod !== FinancingRepaymentMethod.BULLET
    ) {
      missingReasons.push("当前还款方式暂未实现精确利息试算。");
      debtInterestUnavailable = true;
      continue;
    }

    const overlapDays = overlapDaysForRange(allocation.effectiveFrom, allocation.effectiveTo, range);
    debtInterestCostAmount += Math.round(
      (allocatedPrincipalAmount * instrument.annualRateBps * overlapDays) / 10000 / 365
    );
  }

  return {
    debtInterestCostAmount: debtInterestUnavailable ? null : debtInterestCostAmount,
    debtPrincipalAmount
  };
}

function calculateRoeEquityBaseAmount(
  vehicle: AssetReturnTrialVehicleRecord,
  capitalEvents: AssetReturnTrialCapitalEventRecord[],
  debtPrincipalAmount: number,
  warnings: string[]
) {
  const explicitEquityEvent = capitalEvents.find(
    (event) => toNullableNumber(event.equityCapitalAmount) !== null
  );
  const explicitEquityAmount = explicitEquityEvent
    ? toNullableNumber(explicitEquityEvent.equityCapitalAmount)
    : null;

  if (explicitEquityAmount !== null) {
    return {
      roeEquityBaseAmount: explicitEquityAmount,
    };
  }

  const purchasePriceAmount = toNumber(vehicle.purchasePriceAmount);
  if (debtPrincipalAmount > 0) {
    warnings.push("未录入自有资金资本事件，按采购价扣除债务本金估算权益资本。");
    return {
      roeEquityBaseAmount: Math.max(purchasePriceAmount - debtPrincipalAmount, 0),
    };
  }

  if (vehicle.acquisitionMode === VehicleAcquisitionMode.OWNED_CASH) {
    warnings.push("未录入资本事件，按全自有资金假设试算 ROE。");
    return {
      roeEquityBaseAmount: purchasePriceAmount,
    };
  }

  return {
    roeEquityBaseAmount: null
  };
}

function amountByBps(amount: number, bps: number) {
  return Math.round((amount * bps) / 10000);
}

function vehicleIdForRevenueAssignment(
  assignment: AssetReturnTrialRevenueRightAssignmentRecord
) {
  if (assignment.targetType === RevenueRightTargetType.VEHICLE) {
    return assignment.vehicleId;
  }
  if (assignment.targetType === RevenueRightTargetType.ORDER) {
    return assignment.order?.vehicleId ?? null;
  }
  if (assignment.targetType === RevenueRightTargetType.RECEIVABLE_BILL) {
    return assignment.bill?.order.vehicleId ?? null;
  }
  return null;
}

function dateOnlyUtc(value: string) {
  return businessDateStartUtc(value, "date");
}

function dateRangeOverlapWhere(startDate: Date, endDate: Date) {
  return {
    effectiveFrom: { lte: endDate },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: startDate } }]
  };
}

function revenueRightAssignmentOverlapWhere(startDate: Date, endDate: Date) {
  return {
    AND: [{ OR: [{ releasedAt: null }, { releasedAt: { gte: startDate } }] }],
    effectiveFrom: { lte: endDate },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: startDate } }]
  };
}

function overlapDaysForRange(
  effectiveFrom: Date,
  effectiveTo: Date | null | undefined,
  range: ReturnType<typeof resolveReportDateRange>
) {
  const startDate = maxBusinessDate(range.output.startDate, formatDateOnly(effectiveFrom));
  const endDate = minBusinessDate(
    range.output.endDate,
    effectiveTo ? formatDateOnly(effectiveTo) : range.output.endDate
  );
  return inclusiveBusinessDays(startDate, endDate);
}

function activeCostProfileFor(
  vehicle: Pick<AssetReturnTrialVehicleRecord, "assetCostProfiles">
): AssetCostProfileRecord | null {
  return vehicle.assetCostProfiles[0] ?? null;
}

function costDaysForProfile(
  profile: Pick<AssetCostProfileRecord, "depreciationStartDate">,
  range: ReturnType<typeof resolveReportDateRange>
) {
  const costStart = maxBusinessDate(
    range.output.startDate,
    formatDateOnly(profile.depreciationStartDate)
  );

  if (costStart > range.output.endDate) {
    return 0;
  }

  return inclusiveBusinessDays(costStart, range.output.endDate);
}

function applyDepreciationContextToPeriodCost(
  legacyPeriodCost: ReturnType<typeof buildVehicleAssetPeriodCost>,
  depreciationContext: AssetReturnDepreciationContext,
  profile: AssetCostProfileRecord
) {
  if (!depreciationContext.policy) {
    const depreciationFields = {
      depreciationAmount: legacyPeriodCost.depreciationCostAmount,
      depreciationCostAmount: legacyPeriodCost.depreciationCostAmount,
      depreciationMethod: profile.depreciationMethod,
      depreciationMissingReasons: [] as string[],
      depreciationPolicyId: null,
      depreciationPolicyNo: null,
      depreciationRecordCount: 0,
      depreciationSource: DEPRECIATION_SOURCE_LEGACY_COST_PROFILE,
      depreciationWarnings: [] as string[],
      legacyDepreciationAmount: legacyPeriodCost.depreciationCostAmount,
      recordDepreciationAmount: 0
    };

    return {
      depreciationFields,
      periodCost: {
        ...legacyPeriodCost,
        depreciationMissingReasons: depreciationFields.depreciationMissingReasons,
        depreciationWarnings: depreciationFields.depreciationWarnings
      }
    };
  }

  const summary = depreciationContext.summary;
  const depreciationCostAmount = summary.amount;
  const depreciationFields = {
    depreciationAmount: depreciationCostAmount,
    depreciationCostAmount,
    depreciationMethod: depreciationContext.policy.depreciationMethod,
    depreciationMissingReasons: summary.missingReasons,
    depreciationPolicyId: depreciationContext.policy.id,
    depreciationPolicyNo: depreciationContext.policy.policyNo,
    depreciationRecordCount: summary.recordCount,
    depreciationSource: summary.source,
    depreciationWarnings: summary.warnings,
    legacyDepreciationAmount: legacyPeriodCost.depreciationCostAmount,
    recordDepreciationAmount: summary.recordAmount
  };
  const operatingCostAmount =
    depreciationCostAmount === null
      ? null
      : depreciationCostAmount +
        legacyPeriodCost.capitalCostAmount +
        legacyPeriodCost.insuranceCostAmount +
        legacyPeriodCost.maintenanceReserveCostAmount +
        legacyPeriodCost.otherCostAmount;

  return {
    depreciationFields,
    periodCost: {
      ...legacyPeriodCost,
      depreciationCostAmount,
      depreciationMissingReasons: depreciationFields.depreciationMissingReasons,
      depreciationWarnings: depreciationFields.depreciationWarnings,
      manualDepreciationUnsupported: false,
      operatingCostAmount
    }
  };
}

function depreciationFieldsForMissingCostProfile(
  depreciationContext: AssetReturnDepreciationContext
) {
  if (!depreciationContext.policy) {
    return {
      depreciationAmount: null,
      depreciationMethod: null,
      depreciationMissingReasons: [] as string[],
      depreciationPolicyId: null,
      depreciationPolicyNo: null,
      depreciationRecordCount: 0,
      depreciationSource: DEPRECIATION_SOURCE_LEGACY_COST_PROFILE,
      depreciationWarnings: [] as string[],
      legacyDepreciationAmount: null,
      recordDepreciationAmount: 0
    };
  }

  return {
    depreciationAmount: depreciationContext.summary.amount,
    depreciationMethod: depreciationContext.policy.depreciationMethod,
    depreciationMissingReasons: depreciationContext.summary.missingReasons,
    depreciationPolicyId: depreciationContext.policy.id,
    depreciationPolicyNo: depreciationContext.policy.policyNo,
    depreciationRecordCount: depreciationContext.summary.recordCount,
    depreciationSource: depreciationContext.summary.source,
    depreciationWarnings: depreciationContext.summary.warnings,
    legacyDepreciationAmount: null,
    recordDepreciationAmount: depreciationContext.summary.recordAmount
  };
}

function assetCostProfileView(profile: AssetCostProfileRecord) {
  return {
    annualInsuranceCostAmount: toNullableNumber(profile.annualInsuranceCostAmount),
    annualMaintenanceReserveAmount: toNullableNumber(profile.annualMaintenanceReserveAmount),
    capitalCostRateBps: profile.capitalCostRateBps,
    createdAt: profile.createdAt,
    createdBy: profile.createdBy,
    deletedAt: profile.deletedAt,
    depreciationMethod: profile.depreciationMethod,
    depreciationStartDate: profile.depreciationStartDate,
    id: profile.id,
    otherMonthlyCostAmount: toNullableNumber(profile.otherMonthlyCostAmount),
    profileStatus: profile.profileStatus,
    remark: profile.remark,
    residualValueAmount: Number(profile.residualValueAmount),
    snapshot: profile.snapshot,
    updatedAt: profile.updatedAt,
    updatedBy: profile.updatedBy,
    usefulLifeMonths: profile.usefulLifeMonths,
    vehicleId: profile.vehicleId
  };
}

function assetReturnTrialCapitalEventView(event: AssetReturnTrialCapitalEventRecord) {
  return {
    debtPrincipalAmount: toNullableNumber(event.debtPrincipalAmount),
    effectiveFrom: event.effectiveFrom,
    effectiveTo: event.effectiveTo,
    equityCapitalAmount: toNullableNumber(event.equityCapitalAmount),
    eventNo: event.eventNo,
    eventStatus: event.eventStatus,
    eventType: event.eventType,
    financingInstrumentId: event.financingInstrumentId,
    id: event.id,
    remark: event.remark,
    vehicleId: event.vehicleId
  };
}

function assetReturnTrialFinancingAllocationView(
  allocation: AssetReturnTrialFinancingAllocationRecord
) {
  return {
    allocatedPrincipalAmount: toNumber(allocation.allocatedPrincipalAmount),
    allocationNo: allocation.allocationNo,
    allocationRatioBps: allocation.allocationRatioBps,
    allocationStatus: allocation.allocationStatus,
    effectiveFrom: allocation.effectiveFrom,
    effectiveTo: allocation.effectiveTo,
    id: allocation.id,
    instrument: {
      annualRateBps: allocation.instrument.annualRateBps,
      id: allocation.instrument.id,
      instrumentNo: allocation.instrument.instrumentNo,
      instrumentStatus: allocation.instrument.instrumentStatus,
      instrumentType: allocation.instrument.instrumentType,
      lenderName: allocation.instrument.lenderName,
      principalAmount: toNumber(allocation.instrument.principalAmount),
      repaymentMethod: allocation.instrument.repaymentMethod
    },
    instrumentId: allocation.instrumentId,
    remark: allocation.remark,
    vehicleId: allocation.vehicleId
  };
}

function assetReturnTrialRevenueRightAssignmentView(
  assignment: AssetReturnTrialRevenueRightAssignmentRecord
) {
  return {
    assigneeName: assignment.assigneeName,
    assigneeType: assignment.assigneeType,
    assignmentNo: assignment.assignmentNo,
    assignmentStatus: assignment.assignmentStatus,
    assignmentType: assignment.assignmentType,
    bill: assignment.bill
      ? {
          billNo: assignment.bill.billNo,
          billType: assignment.bill.billType,
          id: assignment.bill.id,
          orderId: assignment.bill.orderId,
          orderNo: assignment.bill.order.orderNo,
          paidAmount: toNumber(assignment.bill.paidAmount),
          vehicleId: assignment.bill.order.vehicleId
        }
      : null,
    billId: assignment.billId,
    effectiveFrom: assignment.effectiveFrom,
    effectiveTo: assignment.effectiveTo,
    financingInstrument: assignment.financingInstrument,
    financingInstrumentId: assignment.financingInstrumentId,
    id: assignment.id,
    order: assignment.order,
    orderId: assignment.orderId,
    priority: assignment.priority,
    releasedAt: assignment.releasedAt,
    releaseReason: assignment.releaseReason,
    remark: assignment.remark,
    shareRatioBps: assignment.shareRatioBps,
    targetType: assignment.targetType,
    vehicleId: assignment.vehicleId
  };
}

function assetReturnTrialRevenueShareRuleView(rule: AssetReturnTrialRevenueShareRuleRecord) {
  return {
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    fixedMonthlyAmount: toNullableNumber(rule.fixedMonthlyAmount),
    id: rule.id,
    minimumGuaranteeAmount: toNullableNumber(rule.minimumGuaranteeAmount),
    ownerName: rule.ownerName,
    ownerShareBps: rule.ownerShareBps,
    platformShareBps: rule.platformShareBps,
    remark: rule.remark,
    ruleNo: rule.ruleNo,
    ruleStatus: rule.ruleStatus,
    ruleType: rule.ruleType,
    settlementCycle: rule.settlementCycle,
    shareBasis: rule.shareBasis,
    vehicleId: rule.vehicleId
  };
}

function emptyAssetProfitabilityMetrics(): AssetProfitabilityMetrics {
  return {
    bills: [],
    currentOrder: null,
    damagePaidAmount: 0,
    depositCollectedAmount: 0,
    lastDeliveryAt: null,
    lastReturnAt: null,
    leasedDays: 0,
    operatingDays: 0,
    orderMetricsById: new Map(),
    orders: [],
    otherPaidAmount: 0,
    rentalPaidAmount: 0,
    totalPaidAmount: 0,
    totalReceivableAmount: 0,
    totalRemainingAmount: 0
  };
}

function emptyAssetReturnRoeContext(vehicleId: string): AssetReturnRoeContext {
  return {
    capitalEvents: [],
    financingAllocations: [],
    revenueRightAssignments: [],
    revenueShareRules: [],
    vehicleId,
    vehiclePoolRevenueRightWarning: false
  };
}

function emptyAssetReturnResidualForecastContext(
  vehicleId: string,
  horizonMonth: number
): AssetReturnResidualForecastContext {
  return {
    forecast: null,
    horizonMonth,
    point: null,
    unavailableReason: RESIDUAL_FORECAST_MISSING_REASON,
    vehicleId
  };
}

function emptyAssetReturnBaasCostSummary(): AssetReturnBaasCostSummary {
  return {
    confirmedCostAmount: 0,
    costAmount: 0,
    costRecordCount: 0,
    fullCostRecordAmount: 0,
    overdueCostAmount: 0,
    paidCostAmount: 0,
    scheduledCostAmount: 0
  };
}

function emptyAssetReturnDepreciationSummary(): AssetReturnDepreciationSummary {
  return {
    amount: null,
    legacyAmount: null,
    missingReasons: [],
    policyId: null,
    policyNo: null,
    recordAmount: 0,
    recordCount: 0,
    source: DEPRECIATION_SOURCE_LEGACY_COST_PROFILE,
    unconfirmedScheduleCount: 0,
    warnings: []
  };
}

function emptyAssetReturnDepreciationContext(
  vehicleId: string
): AssetReturnDepreciationContext {
  return {
    policy: null,
    records: [],
    schedules: [],
    summary: emptyAssetReturnDepreciationSummary(),
    vehicleId
  };
}

function updateDepreciationContextSummary(context: AssetReturnDepreciationContext) {
  const policy = context.policy;
  if (!policy) {
    return;
  }

  context.summary.policyId = policy.id;
  context.summary.policyNo = policy.policyNo;

  if (policy.depreciationMethod === VehicleDepreciationMethod.NONE) {
    context.summary.amount = 0;
    context.summary.missingReasons = [];
    context.summary.source = DEPRECIATION_SOURCE_NONE;
    return;
  }

  if (context.summary.recordCount > 0) {
    context.summary.amount = context.summary.recordAmount;
    context.summary.missingReasons = [];
    context.summary.source = DEPRECIATION_SOURCE_RECORDS;
    return;
  }

  context.summary.amount = null;
  context.summary.source = DEPRECIATION_SOURCE_UNAVAILABLE;
  if (policy.depreciationMethod === VehicleDepreciationMethod.MANUAL) {
    context.summary.missingReasons = [MANUAL_DEPRECIATION_POLICY_MISSING_RECORD_REASON];
  } else if (
    policy.depreciationMethod === VehicleDepreciationMethod.STRAIGHT_LINE &&
    context.summary.unconfirmedScheduleCount > 0
  ) {
    context.summary.missingReasons = [STRAIGHT_LINE_DEPRECIATION_UNCONFIRMED_SCHEDULE_REASON];
  } else {
    context.summary.missingReasons = [DEPRECIATION_MISSING_RECORD_REASON];
  }
}

function assetReturnDepreciationPolicyView(
  policy: AssetReturnDepreciationPolicyRecord | null
) {
  if (!policy) {
    return null;
  }

  return {
    basisSource: policy.basisSource,
    currency: policy.currency,
    depreciationBasisAmount: toNumber(policy.depreciationBasisAmount),
    depreciationEndDate: policy.depreciationEndDate,
    depreciationMethod: policy.depreciationMethod,
    depreciationStartDate: policy.depreciationStartDate,
    id: policy.id,
    monthlyDepreciationAmount: toNullableNumber(policy.monthlyDepreciationAmount),
    policyNo: policy.policyNo,
    policyStatus: policy.policyStatus,
    residualValueAmount: toNumber(policy.residualValueAmount),
    usefulLifeMonths: policy.usefulLifeMonths,
    vehicleId: policy.vehicleId
  };
}

function assetReturnDepreciationRecordView(record: AssetReturnDepreciationAllocatedRecord) {
  return {
    allocationMethod: DEPRECIATION_ALLOCATION_METHOD,
    allocationRatio: record.allocationRatio,
    confirmedAt: record.confirmedAt,
    costPeriod: record.costPeriod,
    currency: record.currency,
    depreciationAmount: toNumber(record.depreciationAmount),
    fullDepreciationAmount: record.fullDepreciationAmount,
    id: record.id,
    includedProratedAmount: record.includedProratedAmount,
    lockedAt: record.lockedAt,
    overlapDays: record.overlapDays,
    periodEnd: record.periodEnd,
    periodStart: record.periodStart,
    policyId: record.policyId,
    recordNo: record.recordNo,
    recordSource: record.recordSource,
    recordStatus: record.recordStatus,
    scheduleId: record.scheduleId,
    totalDays: record.totalDays,
    vehicleId: record.vehicleId,
    voidedAt: record.voidedAt
  };
}

function emptyAssetReturnBaasContext(vehicleId: string): AssetReturnBaasContext {
  return {
    currentContract: null,
    records: [],
    summary: emptyAssetReturnBaasCostSummary(),
    vehicleId
  };
}

function addBaasCostRecordToSummary(
  summary: AssetReturnBaasCostSummary,
  record: Pick<
    AssetReturnBaasAllocatedCostRecord,
    "costStatus" | "fullCostRecordAmount" | "includedProratedAmount"
  >
) {
  const amount = record.includedProratedAmount;
  summary.costAmount += amount;
  summary.costRecordCount += 1;
  summary.fullCostRecordAmount += record.fullCostRecordAmount;

  if (record.costStatus === VehicleBaasCostRecordStatus.SCHEDULED) {
    summary.scheduledCostAmount += amount;
  } else if (record.costStatus === VehicleBaasCostRecordStatus.CONFIRMED) {
    summary.confirmedCostAmount += amount;
  } else if (record.costStatus === VehicleBaasCostRecordStatus.PAID) {
    summary.paidCostAmount += amount;
  } else if (record.costStatus === VehicleBaasCostRecordStatus.OVERDUE) {
    summary.overdueCostAmount += amount;
  }
}

function assetReturnBaasContractView(contract: AssetReturnBaasContractRecord | null) {
  if (!contract) {
    return null;
  }

  return {
    batteryPackageName: contract.batteryPackageName,
    batterySerialNo: contract.batterySerialNo,
    billingCycle: contract.billingCycle,
    contractId: contract.id,
    contractNo: contract.contractNo,
    contractStatus: contract.contractStatus,
    effectiveFrom: contract.effectiveFrom,
    effectiveTo: contract.effectiveTo,
    paymentDayOfMonth: contract.paymentDayOfMonth,
    providerContractNo: contract.providerContractNo,
    providerName: contract.providerName,
    rentalAmount: toNumber(contract.rentalAmount)
  };
}

function assetReturnBaasCostRecordView(record: AssetReturnBaasAllocatedCostRecord) {
  return {
    allocationMethod: BAAS_COST_ALLOCATION_METHOD,
    allocationRatio: record.allocationRatio,
    confirmedAt: record.confirmedAt,
    contractId: record.contractId,
    costAmount: toNumber(record.costAmount),
    costPeriod: record.costPeriod,
    costRecordNo: record.costRecordNo,
    costSource: record.costSource,
    costStatus: record.costStatus,
    currency: record.currency,
    dueDate: record.dueDate,
    fullCostRecordAmount: record.fullCostRecordAmount,
    id: record.id,
    includedProratedAmount: record.includedProratedAmount,
    invoiceNo: record.invoiceNo,
    overlapDays: record.overlapDays,
    paidAt: record.paidAt,
    paymentRefNo: record.paymentRefNo,
    periodEnd: record.periodEnd,
    periodStart: record.periodStart,
    totalDays: record.totalDays,
    vehicleId: record.vehicleId,
    voidedAt: record.voidedAt
  };
}

function calculateProratedBaasCostForAnalysisWindow(
  record: Pick<AssetReturnBaasCostRecord, "costAmount" | "periodEnd" | "periodStart">,
  analysisWindow: { endDate: string; startDate: string }
) {
  const periodStartDate = formatDateOnly(record.periodStart);
  const periodEndDate = formatDateOnly(record.periodEnd);
  const totalDays = inclusiveBusinessDays(periodStartDate, periodEndDate);

  if (totalDays <= 0) {
    return {
      allocationRatio: null,
      includedProratedAmount: 0,
      overlapDays: 0,
      totalDays
    };
  }

  const overlapStartDate = maxBusinessDate(periodStartDate, analysisWindow.startDate);
  const overlapEndDate = minBusinessDate(periodEndDate, analysisWindow.endDate);
  const overlapDays = inclusiveBusinessDays(overlapStartDate, overlapEndDate);

  if (overlapDays <= 0) {
    return {
      allocationRatio: 0,
      includedProratedAmount: 0,
      overlapDays: 0,
      totalDays
    };
  }

  const costAmount = bigintAmount(record.costAmount);
  const includedProratedAmount = Number(
    (costAmount * BigInt(overlapDays) + BigInt(totalDays) / 2n) / BigInt(totalDays)
  );

  return {
    allocationRatio: overlapDays / totalDays,
    includedProratedAmount,
    overlapDays,
    totalDays
  };
}

function calculateProratedDepreciationForAnalysisWindow(
  record: Pick<
    AssetReturnDepreciationRecord,
    "depreciationAmount" | "periodEnd" | "periodStart"
  >,
  analysisWindow: { endDate: string; startDate: string }
) {
  const periodStartDate = formatDateOnly(record.periodStart);
  const periodEndDate = formatDateOnly(record.periodEnd);
  const totalDays = inclusiveBusinessDays(periodStartDate, periodEndDate);

  if (totalDays <= 0) {
    return {
      allocationRatio: null,
      includedProratedAmount: 0,
      overlapDays: 0,
      totalDays
    };
  }

  const overlapStartDate = maxBusinessDate(periodStartDate, analysisWindow.startDate);
  const overlapEndDate = minBusinessDate(periodEndDate, analysisWindow.endDate);
  const overlapDays = inclusiveBusinessDays(overlapStartDate, overlapEndDate);

  if (overlapDays <= 0) {
    return {
      allocationRatio: 0,
      includedProratedAmount: 0,
      overlapDays: 0,
      totalDays
    };
  }

  const depreciationAmount = bigintAmount(record.depreciationAmount);
  const includedProratedAmount = Number(
    (depreciationAmount * BigInt(overlapDays) + BigInt(totalDays) / 2n) /
      BigInt(totalDays)
  );

  return {
    allocationRatio: overlapDays / totalDays,
    includedProratedAmount,
    overlapDays,
    totalDays
  };
}

function bigintAmount(value: bigint | number | null | undefined) {
  if (typeof value === "bigint") {
    return value;
  }
  if (value === null || value === undefined) {
    return 0n;
  }
  return BigInt(Math.round(Number(value)));
}

function utcDateOnlyStart(value: string, field: string) {
  const parts = parseDateOnly(value, field);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function applyBaasMainReturnFields({
  analysisDays,
  baasCostAmount,
  row,
  roeEquityBaseAmount
}: {
  analysisDays: number;
  baasCostAmount: number;
  row: ReturnType<typeof assetReturnTrialVehicleRow>;
  roeEquityBaseAmount: number | null;
}) {
  const platformNetIncomeAmount =
    row.platformNetIncomeAmount === null ? null : row.platformNetIncomeAmount - baasCostAmount;
  const trialNetOperatingIncomeAmount =
    row.trialNetOperatingIncomeAmount === null
      ? null
      : row.trialNetOperatingIncomeAmount - baasCostAmount;
  const operatingCostAmount =
    row.operatingCostAmount === null ? null : row.operatingCostAmount + baasCostAmount;
  const trialRoa =
    trialNetOperatingIncomeAmount === null || row.purchasePriceAmount <= 0
      ? null
      : trialNetOperatingIncomeAmount / row.purchasePriceAmount;
  const roeTrial =
    row.roeMissingReasons.length > 0 ||
    platformNetIncomeAmount === null ||
    roeEquityBaseAmount === null ||
    roeEquityBaseAmount <= 0
      ? null
      : platformNetIncomeAmount / roeEquityBaseAmount;
  const residualSensitivityNetIncomeAmount =
    platformNetIncomeAmount === null || row.residualDeltaToCostProfileAmount === null
      ? null
      : platformNetIncomeAmount + row.residualDeltaToCostProfileAmount;
  const residualSensitivityRoeTrial =
    residualSensitivityNetIncomeAmount === null ||
    roeEquityBaseAmount === null ||
    roeEquityBaseAmount <= 0
      ? null
      : residualSensitivityNetIncomeAmount / roeEquityBaseAmount;

  return {
    annualizedRoeTrial:
      roeTrial === null || analysisDays <= 0 ? null : (roeTrial * 365) / analysisDays,
    annualizedTrialRoa:
      trialRoa === null || analysisDays <= 0 ? null : (trialRoa * 365) / analysisDays,
    baasAdjustedAnnualizedRoeTrial:
      roeTrial === null || analysisDays <= 0
        ? null
        : (roeTrial * 365) / analysisDays,
    baasAdjustedPlatformNetIncomeAmount: platformNetIncomeAmount,
    baasAdjustedRoeTrial: roeTrial,
    operatingCostAmount,
    platformNetIncomeAmount,
    residualSensitivityAnnualizedRoeTrial:
      residualSensitivityRoeTrial === null || analysisDays <= 0
        ? null
        : (residualSensitivityRoeTrial * 365) / analysisDays,
    residualSensitivityNetIncomeAmount,
    residualSensitivityRoeTrial,
    roeDataReady: roeTrial !== null,
    roeTrial,
    roeUnavailableReason:
      roeTrial === null ? row.roeMissingReasons.join(" / ") || ROE_UNAVAILABLE_REASON : null,
    trialNetOperatingIncomeAmount,
    trialRoa
  };
}

function buildMarketCalibratedDepreciationFields({
  analysisDays,
  residualCalibrationPercent,
  row
}: {
  analysisDays: number;
  residualCalibrationPercent: number;
  row: ReturnType<typeof assetReturnTrialVehicleRow> &
    ReturnType<typeof applyBaasMainReturnFields>;
}) {
  const marketResidualBaseAmount = row.forecastResidualAmount;
  const marketResidualSource =
    row.forecastResidualAmountSource === "ADOPTED" ||
    row.forecastResidualAmountSource === "PREDICTED"
      ? row.forecastResidualAmountSource
      : "NONE";
  const accountingResidualBaselineAmount = row.costProfileResidualValueAmount;
  const marketCalibratedResidualAmount =
    marketResidualBaseAmount === null
      ? null
      : Math.round((marketResidualBaseAmount * (100 + residualCalibrationPercent)) / 100);
  const marketResidualDeltaAmount =
    marketCalibratedResidualAmount === null || accountingResidualBaselineAmount === null
      ? null
      : marketCalibratedResidualAmount - accountingResidualBaselineAmount;
  const marketCalibratedPlatformNetIncomeAmount =
    row.platformNetIncomeAmount === null || marketResidualDeltaAmount === null
      ? null
      : row.platformNetIncomeAmount + marketResidualDeltaAmount;
  const marketCalibratedRoeTrial =
    marketCalibratedPlatformNetIncomeAmount === null ||
    row.roeEquityBaseAmount === null ||
    row.roeEquityBaseAmount <= 0
      ? null
      : marketCalibratedPlatformNetIncomeAmount / row.roeEquityBaseAmount;
  const marketCalibratedTrialRoa =
    marketCalibratedPlatformNetIncomeAmount === null || row.purchasePriceAmount <= 0
      ? null
      : marketCalibratedPlatformNetIncomeAmount / row.purchasePriceAmount;
  const unavailableReason =
    marketResidualBaseAmount === null
      ? row.residualForecastUnavailableReason || MARKET_CALIBRATION_RESIDUAL_MISSING_REASON
      : accountingResidualBaselineAmount === null
        ? MARKET_CALIBRATION_BASELINE_MISSING_REASON
        : row.platformNetIncomeAmount === null
          ? row.roeUnavailableReason || MARKET_CALIBRATION_MAIN_RETURN_MISSING_REASON
          : null;

  return {
    accountingResidualBaselineAmount,
    marketCalibratedAnnualizedRoeTrial:
      marketCalibratedRoeTrial === null || analysisDays <= 0
        ? null
        : (marketCalibratedRoeTrial * 365) / analysisDays,
    marketCalibratedPlatformNetIncomeAmount,
    marketCalibratedResidualAmount,
    marketCalibratedRoeTrial,
    marketCalibratedTrialRoa,
    marketCalibrationUnavailableReason: unavailableReason,
    marketResidualBaseAmount,
    marketResidualDeltaAmount,
    marketResidualSource,
    residualCalibrationPercent
  };
}

function attachAssetReturnBaasFields<T extends ReturnType<typeof assetReturnTrialVehicleRow>>(
  row: T,
  context: AssetReturnBaasContext,
  analysisDays: number,
  residualCalibrationPercent: number
) {
  const mainReturnFields = applyBaasMainReturnFields({
    analysisDays,
    baasCostAmount: context.summary.costAmount,
    row,
    roeEquityBaseAmount: row.roeEquityBaseAmount
  });
  const rowWithMainReturnFields = {
    ...row,
    ...mainReturnFields
  };
  const marketCalibratedDepreciationFields = buildMarketCalibratedDepreciationFields({
    analysisDays,
    residualCalibrationPercent,
    row: rowWithMainReturnFields
  });

  return {
    ...rowWithMainReturnFields,
    ...marketCalibratedDepreciationFields,
    baasConfirmedCostAmount: context.summary.confirmedCostAmount,
    baasContractNo: context.currentContract?.contractNo ?? null,
    baasContractStatus: context.currentContract?.contractStatus ?? null,
    baasCostAmount: context.summary.costAmount,
    baasCostAllocationMethod: BAAS_COST_ALLOCATION_METHOD,
    baasCostFullRecordAmount: context.summary.fullCostRecordAmount,
    baasCostRecordCount: context.summary.costRecordCount,
    baasOverdueCostAmount: context.summary.overdueCostAmount,
    baasPaidCostAmount: context.summary.paidCostAmount,
    baasProviderName: context.currentContract?.providerName ?? null,
    baasScheduledCostAmount: context.summary.scheduledCostAmount
  };
}

function selectAssetReturnResidualForecast(forecasts: AssetReturnResidualForecastRecord[]) {
  return [...forecasts].sort((left, right) => {
    const leftPriority =
      left.forecastStatus === VehicleResidualForecastStatus.ADOPTED ? 0 : 1;
    const rightPriority =
      right.forecastStatus === VehicleResidualForecastStatus.ADOPTED ? 0 : 1;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    const createdDiff = right.createdAt.getTime() - left.createdAt.getTime();
    if (createdDiff !== 0) {
      return createdDiff;
    }
    return right.asOfDate.getTime() - left.asOfDate.getTime();
  })[0] ?? null;
}

function emptyOrderProfitabilityMetrics(): OrderProfitabilityMetrics {
  return {
    damagePaidAmount: 0,
    otherPaidAmount: 0,
    rentalPaidAmount: 0
  };
}

function orderMetricsFor(metrics: AssetProfitabilityMetrics, orderId: string) {
  const existing = metrics.orderMetricsById.get(orderId);
  if (existing) {
    return existing;
  }

  const created = emptyOrderProfitabilityMetrics();
  metrics.orderMetricsById.set(orderId, created);
  return created;
}

function assetProfitabilityComparator(field: AssetProfitabilitySortField, order: "asc" | "desc") {
  const direction = order === "asc" ? 1 : -1;

  return (
    left: ReturnType<typeof assetProfitabilityVehicleRow>,
    right: ReturnType<typeof assetProfitabilityVehicleRow>
  ) => {
    const leftValue = sortableNumber(left[field]);
    const rightValue = sortableNumber(right[field]);

    if (leftValue === rightValue) {
      return left.vehicleNo.localeCompare(right.vehicleNo);
    }

    return (leftValue - rightValue) * direction;
  };
}

function assetReturnTrialComparator(field: AssetReturnTrialSortField, order: "asc" | "desc") {
  const direction = order === "asc" ? 1 : -1;

  return (
    left: ReturnType<typeof assetReturnTrialVehicleRow>,
    right: ReturnType<typeof assetReturnTrialVehicleRow>
  ) => {
    const leftValue = sortableNumber(left[field]);
    const rightValue = sortableNumber(right[field]);

    if (leftValue === rightValue) {
      return left.vehicleNo.localeCompare(right.vehicleNo);
    }

    return (leftValue - rightValue) * direction;
  };
}

function depreciationSourceBreakdownRows(
  rows: Array<{
    depreciationAmount: number | null;
    depreciationSource: string;
  }>
) {
  const breakdown = new Map<string, { amount: number; count: number; source: string }>();

  for (const row of rows) {
    const current = breakdown.get(row.depreciationSource) ?? {
      amount: 0,
      count: 0,
      source: row.depreciationSource
    };
    current.amount += row.depreciationAmount ?? 0;
    current.count += 1;
    breakdown.set(row.depreciationSource, current);
  }

  return [...breakdown.values()].sort((left, right) => left.source.localeCompare(right.source));
}

function sortableNumber(value: number | null) {
  return value ?? Number.NEGATIVE_INFINITY;
}

function leasedDaysForOrder(
  order: Pick<AssetProfitabilityOrderRecord, "actualDeliveryAt" | "actualReturnAt" | "endDate">,
  range: ReturnType<typeof resolveReportDateRange>
) {
  if (!order.actualDeliveryAt) {
    return 0;
  }

  const startDate = maxBusinessDate(
    businessDateForInstant(order.actualDeliveryAt),
    range.output.startDate
  );
  const rawEndDate = order.actualReturnAt
    ? businessDateForInstant(order.actualReturnAt)
    : order.endDate
      ? formatDateOnly(order.endDate)
      : range.output.endDate;
  const endDate = minBusinessDate(rawEndDate, range.output.endDate);

  return inclusiveBusinessDays(startDate, endDate);
}

function operatingDaysForVehicle(
  vehicle: Pick<AssetProfitabilityVehicleRecord, "createdAt" | "salePriceHistories">,
  range: ReturnType<typeof resolveReportDateRange>
) {
  const initialPoolDate =
    vehicle.salePriceHistories
      .filter((history) => history.reviewType === "INITIAL_POOL")
      .map((history) => formatDateOnly(history.effectiveFrom))
      .sort()[0] ?? businessDateForInstant(vehicle.createdAt);
  const startDate = maxBusinessDate(initialPoolDate, range.output.startDate);

  return inclusiveBusinessDays(startDate, range.output.endDate);
}

function assetProfitabilityLifecycleNodes(vehicle: AssetProfitabilityVehicleDetailRecord) {
  const salePriceNodes = vehicle.salePriceHistories.map((history) => ({
    type:
      history.reviewType === "INITIAL_POOL"
        ? "INITIAL_POOL"
        : history.reviewType === "RETURN_REINIT"
          ? "RETURN_REINIT"
          : "SALE_PRICE_REVIEW",
    occurredAt: history.effectiveFrom,
    refId: history.id,
    label: history.reviewType,
    amount: toNumber(history.afterSalePriceAmount)
  }));
  const deliveryNodes = vehicle.deliveries.map((delivery) => ({
    type: "DELIVERY",
    occurredAt: delivery.deliveredAt ?? delivery.scheduledAt,
    refId: delivery.id,
    label: delivery.deliveryNo,
    status: delivery.deliveryStatus
  }));
  const returnNodes = vehicle.returns.map((vehicleReturn) => ({
    type: "RETURN",
    occurredAt: vehicleReturn.returnedAt ?? vehicleReturn.scheduledAt,
    refId: vehicleReturn.id,
    label: vehicleReturn.returnNo,
    status: vehicleReturn.returnStatus
  }));

  return [...salePriceNodes, ...deliveryNodes, ...returnNodes].sort(
    (left, right) => (left.occurredAt?.getTime() ?? 0) - (right.occurredAt?.getTime() ?? 0)
  );
}

function leasedVehicleCount(statusCount: Map<string, number>) {
  return (
    (statusCount.get(VehicleStatus.LEASED) ?? 0) + (statusCount.get(VehicleStatus.RENTED) ?? 0)
  );
}

function incomeMap(bills: Array<{ order: { vehicleModel: VehicleModel }; paidAmount: bigint }>) {
  const result = new Map<string, number>();

  for (const bill of bills) {
    result.set(
      bill.order.vehicleModel,
      (result.get(bill.order.vehicleModel) ?? 0) + Number(bill.paidAmount)
    );
  }

  return result;
}

function vehicleModelAssetRows(
  groups: Array<{
    _count: { _all: number };
    status: VehicleStatus;
    vehicleModel: VehicleModel | null;
  }>,
  incomeByVehicleModel: Map<string, number>
) {
  const rows = new Map<
    string,
    {
      availableVehicles: number;
      incomeAmount: number;
      leasedVehicles: number;
      totalVehicles: number;
      vehicleModel: VehicleModel | null;
    }
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

function toNullableNumber(value: bigint | number | null | undefined) {
  return value === null || value === undefined ? null : Number(value);
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

function sumNullable(values: Array<number | null>) {
  if (values.length === 0 || values.some((value) => value === null)) {
    return null;
  }
  return sumNumbers(values as number[]);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function average(values: number[]) {
  return values.length === 0 ? 0 : sumNumbers(values) / values.length;
}

function averageNullable(values: number[]) {
  return values.length === 0 ? null : average(values);
}

function minBusinessDate(left: string, right: string) {
  return left <= right ? left : right;
}

function maxBusinessDate(left: string, right: string) {
  return left >= right ? left : right;
}

function inclusiveBusinessDays(startDate: string, endDate: string) {
  if (startDate > endDate) {
    return 0;
  }

  const start = businessDateStartUtc(startDate, "startDate");
  const end = businessDateStartUtc(endDate, "endDate");
  return Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
}
