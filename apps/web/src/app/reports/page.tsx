"use client";

import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Select,
  Space,
  Skeleton,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import {
  BILL_STATUS_LABELS,
  BILL_TYPE_LABELS,
  COLLECTION_CASE_STATUS_LABELS,
  COLLECTION_LEVEL_LABELS,
  DEPOSIT_TRANSACTION_STATUS_LABELS,
  DEPOSIT_TRANSACTION_TYPE_LABELS,
  ENTITLEMENT_GRANT_STATUS_LABELS,
  ENTITLEMENT_TYPE_LABELS,
  ENTITLEMENT_UNIT_LABELS,
  ENTITLEMENT_USAGE_SOURCE_LABELS,
  ENTITLEMENT_USAGE_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  STATUS_LABELS,
  VEHICLE_BATTERY_USAGE_TYPE_LABELS,
  labelOf
} from "../../constants/labels";
import { ApiError, apiFetch } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";
import { downloadCsv } from "../../lib/csv-download";

const { RangePicker } = DatePicker;

type ReportKey = "summary" | "orders" | "finance" | "deposit" | "collections" | "assets" | "entitlements";
type ExportReportKey = Exclude<ReportKey, "summary" | "entitlements">;

interface DateRangeResponse {
  endDate?: string | null;
  startDate?: string | null;
}

interface DashboardSummaryReport {
  activeOrders?: number | null;
  availableVehicles?: number | null;
  cancelledOrders?: number | null;
  collectionCaseCount?: number | null;
  completedOrders?: number | null;
  dateRange?: DateRangeResponse;
  depositBalanceAmount?: number | null;
  leasedVehicles?: number | null;
  maintenanceVehicles?: number | null;
  newOrders?: number | null;
  overdueAmount?: number | null;
  overdueOrderCount?: number | null;
  returnedVehicles?: number | null;
  reviewReservedVehicles?: number | null;
  signingLockedVehicles?: number | null;
  totalOrders?: number | null;
  totalPaidAmount?: number | null;
  totalReceivableAmount?: number | null;
  totalUnpaidAmount?: number | null;
  totalVehicles?: number | null;
}

interface CountRow {
  count?: number | null;
}

interface OrderStatusRow extends CountRow {
  orderStatus?: string | null;
}

interface OrderSourceRow extends CountRow {
  orderSource?: string | null;
}

interface VehicleModelCountRow extends CountRow {
  vehicleModel?: string | null;
}

interface SubscriptionPlanCountRow extends CountRow {
  subscriptionPlanId?: string | null;
  subscriptionPlanName?: string | null;
  subscriptionPlanNo?: string | null;
}

interface OrderReport {
  bySource?: OrderSourceRow[];
  byStatus?: OrderStatusRow[];
  bySubscriptionPlan?: SubscriptionPlanCountRow[];
  byVehicleModel?: VehicleModelCountRow[];
  dateRange?: DateRangeResponse;
  totalOrders?: number | null;
}

interface AmountGroupRow extends CountRow {
  totalPaidAmount?: number | null;
  totalReceivableAmount?: number | null;
  totalUnpaidAmount?: number | null;
}

interface BillTypeReportRow extends AmountGroupRow {
  billType?: string | null;
}

interface BillStatusReportRow extends AmountGroupRow {
  billStatus?: string | null;
}

interface FinanceReport {
  byBillStatus?: BillStatusReportRow[];
  byBillType?: BillTypeReportRow[];
  dateRange?: DateRangeResponse;
  totalPaidAmount?: number | null;
  totalReceivableAmount?: number | null;
  totalUnpaidAmount?: number | null;
}

interface DepositTransactionTypeRow extends CountRow {
  amount?: number | null;
  transactionType?: string | null;
}

interface DepositPoolReport {
  byTransactionType?: DepositTransactionTypeRow[];
  collectedAmount?: number | null;
  currentBalanceAmount?: number | null;
  dateRange?: DateRangeResponse;
  deductedAmount?: number | null;
  refundedAmount?: number | null;
  transactionCount?: number | null;
}

interface CollectionLevelRow extends CountRow {
  collectionLevel?: string | null;
  totalOverdueAmount?: number | null;
}

interface CollectionCaseStatusRow extends CountRow {
  caseStatus?: string | null;
  totalOverdueAmount?: number | null;
}

interface CollectionReport {
  actionCount?: number | null;
  activeCaseCount?: number | null;
  byCaseStatus?: CollectionCaseStatusRow[];
  byCollectionLevel?: CollectionLevelRow[];
  closedCaseCount?: number | null;
  collectionCaseCount?: number | null;
  dateRange?: DateRangeResponse;
  overdueAmount?: number | null;
  overdueBillCount?: number | null;
  overdueOrderCount?: number | null;
  promisedPaymentAmount?: number | null;
}

interface VehicleModelAssetRow {
  availableVehicles?: number | null;
  incomeAmount?: number | null;
  leasedVehicles?: number | null;
  totalVehicles?: number | null;
  vehicleModel?: string | null;
}

interface VehicleAssetReport {
  availableVehicles?: number | null;
  averageCurrentSalePriceAmount?: number | null;
  byVehicleModel?: VehicleModelAssetRow[];
  dateRange?: DateRangeResponse;
  leasedVehicles?: number | null;
  maintenanceVehicles?: number | null;
  rentalRate?: number | null;
  returnedVehicles?: number | null;
  soldVehicles?: number | null;
  totalCurrentSalePriceAmount?: number | null;
  totalPaidAmount?: number | null;
  totalPurchasePriceAmount?: number | null;
  totalVehicles?: number | null;
}

interface EntitlementTypeUnitRow {
  entitlementType?: string | null;
  exhaustedCount?: number | null;
  grantCount?: number | null;
  remainingAmount?: number | null;
  totalAmount?: number | null;
  unit?: string | null;
  usedAmount?: number | null;
}

interface EntitlementUsageGroupRow extends CountRow {
  unit?: string | null;
  usageSource?: string | null;
  usageStatus?: string | null;
  usedAmount?: number | null;
}

interface RecentlyExhaustedEntitlementRow {
  customerName?: string | null;
  entitlementName?: string | null;
  entitlementType?: string | null;
  grantNo?: string | null;
  id?: string | null;
  latestUsageAt?: string | null;
  orderId?: string | null;
  orderNo?: string | null;
  remainingAmount?: number | null;
  totalAmount?: number | null;
  unit?: string | null;
  usedAmount?: number | null;
}

interface EntitlementReport {
  accountOverview?: {
    activeAccountCount?: number | null;
    closedAccountCount?: number | null;
    suspendedAccountCount?: number | null;
    totalAccountCount?: number | null;
  };
  byEntitlementTypeUnit?: EntitlementTypeUnitRow[];
  dateRange?: DateRangeResponse;
  grantOverview?: {
    activeGrantCount?: number | null;
    cancelledGrantCount?: number | null;
    exhaustedGrantCount?: number | null;
    expiredGrantCount?: number | null;
    totalGrantCount?: number | null;
  };
  recentlyExhausted?: RecentlyExhaustedEntitlementRow[];
  usageOverview?: {
    bySource?: EntitlementUsageGroupRow[];
    byStatus?: EntitlementUsageGroupRow[];
    byUnit?: EntitlementUsageGroupRow[];
    manualUsageCount?: number | null;
    systemUsageCount?: number | null;
    thirdPartyUsageCount?: number | null;
    totalUsageCount?: number | null;
  };
}

interface OrderFilterValues {
  orderSource?: string;
  orderStatus?: string;
  vehicleModel?: string;
}

type DetailKind =
  | "orders"
  | "bills"
  | "depositLedgers"
  | "overdueBills"
  | "collectionCases"
  | "vehicles"
  | "entitlementGrants"
  | "entitlementUsages";
type DetailRow = Record<string, unknown>;

interface PagedDetailResponse {
  items: DetailRow[];
  page: number;
  pageSize: number;
  total: number;
}

interface DrilldownState {
  filters?: Array<{ label: string; value: string }>;
  kind: DetailKind;
  page: number;
  pageSize: number;
  path: string;
  query?: Record<string, unknown>;
  title: string;
}

const defaultDateRange = (): [Dayjs, Dayjs] => [dayjs().subtract(29, "day"), dayjs()];

const reportLabels: Record<ReportKey, string> = {
  entitlements: "权益报表",
  assets: "车辆资产",
  collections: "逾期催收",
  deposit: "保证金池",
  finance: "财务报表",
  orders: "订单报表",
  summary: "经营总览"
};

const orderSourceLabels: Record<string, string> = {
  CUSTOMER_SELF_SERVICE: "客户自助",
  SALES_ASSISTED: "销售人工",
  SELF_SERVICE: "客户自助"
};

const collectionLevelLabels: Record<string, string> = {
  D1: "D1：1-3天",
  D2: "D2：4-7天",
  D3: "D3：8-15天",
  D4: "D4：16-30天",
  D5: "D5：31天以上"
};

const collectionCaseStatusLabels: Record<string, string> = {
  ACTIVE: "催收中",
  CLOSED: "已关闭",
  PAUSED: "暂停催收"
};

const vehicleModelOptions = ["ET5", "ET7", "ES6"].map((value) => ({ label: value, value }));
const detailDrawerSize = "min(1472px, calc(100vw - 32px))";

function buildQuery(values: Record<string, unknown>) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(key, String(value));
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

function dateRangeParams(dateRange: [Dayjs, Dayjs]) {
  return {
    endDate: dateRange[1].format("YYYY-MM-DD"),
    startDate: dateRange[0].format("YYYY-MM-DD")
  };
}

function exportReportPath(
  key: ExportReportKey,
  dateRange: [Dayjs, Dayjs],
  orderFilters: OrderFilterValues
) {
  const dateParams = dateRangeParams(dateRange);
  const endpointByKey: Record<ExportReportKey, string> = {
    assets: "/reports/vehicle-assets/export",
    collections: "/reports/collections/export",
    deposit: "/reports/deposit-pool/export",
    finance: "/reports/finance/export",
    orders: "/reports/orders/export"
  };

  return `${endpointByKey[key]}${buildQuery({
    ...dateParams,
    ...(key === "orders" ? orderFilters : {})
  })}`;
}

function exportDefaultFilename(key: ExportReportKey, dateRange: [Dayjs, Dayjs]) {
  const prefixByKey: Record<ExportReportKey, string> = {
    assets: "vehicle-assets-report",
    collections: "collections-report",
    deposit: "deposit-pool-report",
    finance: "finance-report",
    orders: "orders-report"
  };
  const startDate = dateRange[0].format("YYYYMMDD");
  const endDate = dateRange[1].format("YYYYMMDD");

  return `${prefixByKey[key]}-${startDate}-${endDate}.csv`;
}

function detailExportDefaultFilename(kind: DetailKind, dateRange: [Dayjs, Dayjs]) {
  const prefixByKind: Record<DetailKind, string> = {
    bills: "bills-detail",
    collectionCases: "collection-cases-detail",
    depositLedgers: "deposit-ledgers-detail",
    entitlementGrants: "entitlement-grants-detail",
    entitlementUsages: "entitlement-usages-detail",
    orders: "orders-detail",
    overdueBills: "overdue-bills-detail",
    vehicles: "vehicles-detail"
  };
  const startDate = dateRange[0].format("YYYYMMDD");
  const endDate = dateRange[1].format("YYYYMMDD");

  return `${prefixByKind[kind]}-${startDate}-${endDate}.csv`;
}

function canExportDetailKind(
  kind: DetailKind | undefined,
  access: {
    canViewAssetReport: boolean;
    canViewCollectionReport: boolean;
    canViewFinanceReports: boolean;
    canViewReports: boolean;
  }
) {
  switch (kind) {
    case "orders":
      return access.canViewReports;
    case "bills":
    case "depositLedgers":
      return access.canViewFinanceReports;
    case "overdueBills":
    case "collectionCases":
      return access.canViewCollectionReport;
    case "vehicles":
      return access.canViewAssetReport;
    case "entitlementGrants":
    case "entitlementUsages":
      return false;
    default:
      return false;
  }
}

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatInteger(value?: number | null) {
  const numberValue = safeNumber(value);
  return numberValue === null ? "-" : numberValue.toLocaleString("zh-CN");
}

function formatYuan(value?: number | null) {
  const numberValue = safeNumber(value);
  if (numberValue === null) {
    return "-";
  }

  return `${(numberValue / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}\u00A0元`;
}

function formatEntitlementAmount(value?: number | null) {
  const numberValue = safeNumber(value);
  if (numberValue === null) {
    return "-";
  }

  return numberValue.toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0
  });
}

function formatEntitlementAmountWithUnit(value?: number | null, unit?: string | null) {
  const amount = formatEntitlementAmount(value);
  if (amount === "-") {
    return "-";
  }
  return `${amount} ${labelOf(ENTITLEMENT_UNIT_LABELS, unit)}`;
}

function formatPercent(value?: number | null) {
  const numberValue = safeNumber(value);
  if (numberValue === null) {
    return "-";
  }

  return `${(numberValue * 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}%`;
}

function formatDate(value?: unknown) {
  if (!value) {
    return "-";
  }
  const parsed = dayjs(value as string | number | Date);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "-";
}

function safeText(value?: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" && value.trim() ? value : "-";
}

function detailValue(record: DetailRow, key: string) {
  return record[key];
}

function detailText(record: DetailRow, key: string) {
  return safeText(detailValue(record, key));
}

function detailNumber(record: DetailRow, key: string) {
  return safeNumber(detailValue(record, key));
}

function detailId(record: DetailRow, key: string) {
  const value = detailValue(record, key);
  return typeof value === "string" && value.trim() ? value : null;
}

function detailLink(href: string | null, text: unknown) {
  const label = safeText(text);
  if (!href || label === "-") {
    return label;
  }

  return (
    <Button href={href} size="small" type="link">
      {label}
    </Button>
  );
}

function detailTableRowKey(record: DetailRow) {
  return (
    detailId(record, "id") ??
    detailId(record, "orderNo") ??
    detailId(record, "billNo") ??
    detailId(record, "ledgerNo") ??
    detailId(record, "caseNo") ??
    detailId(record, "vehicleNo") ??
    detailId(record, "grantNo") ??
    detailId(record, "usageNo") ??
    JSON.stringify(record)
  );
}

function clickableRow<T>(onClick: (record: T) => void) {
  return (record: T) => ({
    onClick: () => onClick(record),
    style: { cursor: "pointer" }
  });
}

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const message = error.message.trim();
    if (!message || message === "Internal Server Error" || message === "Bad Request") {
      return "报表加载失败，请检查筛选条件或稍后重试";
    }
    return message;
  }

  return "报表加载失败，请稍后重试";
}

function getExportErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const message = error.message.trim();
    if (!message || message === "Internal Server Error" || message === "Bad Request") {
      return error.status === 403 ? "无导出权限" : "导出失败，请稍后重试";
    }
    return message;
  }

  return "导出失败，请稍后重试";
}

function optionsFromLabels(labels: Record<string, string>) {
  return Object.entries(labels).map(([value, label]) => ({ label, value }));
}

function formatTag(labels: Record<string, string>, value?: string | null, color?: string) {
  if (!value) {
    return "-";
  }

  return <Tag color={color}>{labelOf(labels, value)}</Tag>;
}

function metric(title: string, value: string | number, onClick?: () => void) {
  return { onClick, title, value };
}

function safeRatio(numerator?: number | null, denominator?: number | null) {
  const numeratorValue = safeNumber(numerator);
  const denominatorValue = safeNumber(denominator);
  if (numeratorValue === null || denominatorValue === null || denominatorValue <= 0) {
    return null;
  }

  return numeratorValue / denominatorValue;
}

export default function ReportsPage() {
  const { message } = App.useApp();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [loadingMe, setLoadingMe] = useState(true);
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>(() => defaultDateRange());
  const [orderFilters, setOrderFilters] = useState<OrderFilterValues>({});
  const [activeTab, setActiveTab] = useState<ReportKey>("summary");
  const [loading, setLoading] = useState<Record<ReportKey, boolean>>({
    assets: false,
    collections: false,
    deposit: false,
    entitlements: false,
    finance: false,
    orders: false,
    summary: false
  });
  const [exporting, setExporting] = useState<Record<ExportReportKey, boolean>>({
    assets: false,
    collections: false,
    deposit: false,
    finance: false,
    orders: false
  });
  const [exportingDetail, setExportingDetail] = useState(false);
  const [drilldown, setDrilldown] = useState<DrilldownState | null>(null);
  const [detailData, setDetailData] = useState<PagedDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | undefined>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<ReportKey, string>>>({});
  const [dashboardSummary, setDashboardSummary] = useState<DashboardSummaryReport | null>(null);
  const [orderReport, setOrderReport] = useState<OrderReport | null>(null);
  const [financeReport, setFinanceReport] = useState<FinanceReport | null>(null);
  const [depositReport, setDepositReport] = useState<DepositPoolReport | null>(null);
  const [collectionReport, setCollectionReport] = useState<CollectionReport | null>(null);
  const [vehicleAssetReport, setVehicleAssetReport] = useState<VehicleAssetReport | null>(null);
  const [entitlementReport, setEntitlementReport] = useState<EntitlementReport | null>(null);
  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me]);
  const canViewReports = permissions.has("report:view");
  const canViewFinanceReports = permissions.has("report:finance");
  const canViewCollectionReport = canViewFinanceReports || permissions.has("collection:view");
  const canViewAssetReport = permissions.has("report:asset");
  const canViewEntitlementReport = canViewReports && permissions.has("entitlement:view");
  const canExportCurrentDetail = canExportDetailKind(drilldown?.kind, {
    canViewAssetReport,
    canViewCollectionReport,
    canViewFinanceReports,
    canViewReports
  });

  const visibleReportKeys = useMemo(() => {
    if (!canViewReports) {
      return [];
    }

    const keys: ReportKey[] = [];
    keys.push("summary", "orders");
    if (canViewFinanceReports) {
      keys.push("finance", "deposit");
    }
    if (canViewCollectionReport) {
      keys.push("collections");
    }
    if (canViewAssetReport) {
      keys.push("assets");
    }
    if (canViewEntitlementReport) {
      keys.push("entitlements");
    }
    return keys;
  }, [canViewAssetReport, canViewCollectionReport, canViewEntitlementReport, canViewFinanceReports, canViewReports]);

  const setReportLoading = useCallback((key: ReportKey, value: boolean) => {
    setLoading((current) => ({ ...current, [key]: value }));
  }, []);

  const setReportError = useCallback((key: ReportKey, value?: string) => {
    setErrors((current) => ({ ...current, [key]: value }));
  }, []);

  const loadDashboardSummary = useCallback(async () => {
    if (!canViewReports) {
      return;
    }
    setReportLoading("summary", true);
    setReportError("summary", undefined);
    try {
      setDashboardSummary(
        await apiFetch<DashboardSummaryReport>(
          `/reports/dashboard-summary${buildQuery(dateRangeParams(dateRange))}`
        )
      );
    } catch (error) {
      setReportError("summary", getErrorMessage(error));
    } finally {
      setReportLoading("summary", false);
    }
  }, [canViewReports, dateRange, setReportError, setReportLoading]);

  const loadOrderReport = useCallback(async (filters: OrderFilterValues = orderFilters) => {
    if (!canViewReports) {
      return;
    }
    setReportLoading("orders", true);
    setReportError("orders", undefined);
    try {
      setOrderReport(
        await apiFetch<OrderReport>(
          `/reports/orders${buildQuery({
            ...dateRangeParams(dateRange),
            ...filters
          })}`
        )
      );
    } catch (error) {
      setReportError("orders", getErrorMessage(error));
    } finally {
      setReportLoading("orders", false);
    }
  }, [canViewReports, dateRange, orderFilters, setReportError, setReportLoading]);

  const loadFinanceReport = useCallback(async () => {
    if (!canViewReports || !canViewFinanceReports) {
      return;
    }
    setReportLoading("finance", true);
    setReportError("finance", undefined);
    try {
      setFinanceReport(
        await apiFetch<FinanceReport>(`/reports/finance${buildQuery(dateRangeParams(dateRange))}`)
      );
    } catch (error) {
      setReportError("finance", getErrorMessage(error));
    } finally {
      setReportLoading("finance", false);
    }
  }, [canViewFinanceReports, canViewReports, dateRange, setReportError, setReportLoading]);

  const loadDepositReport = useCallback(async () => {
    if (!canViewReports || !canViewFinanceReports) {
      return;
    }
    setReportLoading("deposit", true);
    setReportError("deposit", undefined);
    try {
      setDepositReport(
        await apiFetch<DepositPoolReport>(`/reports/deposit-pool${buildQuery(dateRangeParams(dateRange))}`)
      );
    } catch (error) {
      setReportError("deposit", getErrorMessage(error));
    } finally {
      setReportLoading("deposit", false);
    }
  }, [canViewFinanceReports, canViewReports, dateRange, setReportError, setReportLoading]);

  const loadCollectionReport = useCallback(async () => {
    if (!canViewReports || !canViewCollectionReport) {
      return;
    }
    setReportLoading("collections", true);
    setReportError("collections", undefined);
    try {
      setCollectionReport(
        await apiFetch<CollectionReport>(`/reports/collections${buildQuery(dateRangeParams(dateRange))}`)
      );
    } catch (error) {
      setReportError("collections", getErrorMessage(error));
    } finally {
      setReportLoading("collections", false);
    }
  }, [canViewCollectionReport, canViewReports, dateRange, setReportError, setReportLoading]);

  const loadVehicleAssetReport = useCallback(async () => {
    if (!canViewReports || !canViewAssetReport) {
      return;
    }
    setReportLoading("assets", true);
    setReportError("assets", undefined);
    try {
      setVehicleAssetReport(
        await apiFetch<VehicleAssetReport>(`/reports/vehicle-assets${buildQuery(dateRangeParams(dateRange))}`)
      );
    } catch (error) {
      setReportError("assets", getErrorMessage(error));
    } finally {
      setReportLoading("assets", false);
    }
  }, [canViewAssetReport, canViewReports, dateRange, setReportError, setReportLoading]);

  const loadEntitlementReport = useCallback(async () => {
    if (!canViewEntitlementReport) {
      return;
    }
    setReportLoading("entitlements", true);
    setReportError("entitlements", undefined);
    try {
      setEntitlementReport(
        await apiFetch<EntitlementReport>(`/reports/entitlements${buildQuery(dateRangeParams(dateRange))}`)
      );
    } catch (error) {
      setReportError("entitlements", getErrorMessage(error));
    } finally {
      setReportLoading("entitlements", false);
    }
  }, [canViewEntitlementReport, dateRange, setReportError, setReportLoading]);

  const loadVisibleReports = useCallback(async () => {
    await Promise.all([
      loadDashboardSummary(),
      loadOrderReport(),
      loadFinanceReport(),
      loadDepositReport(),
      loadCollectionReport(),
      loadVehicleAssetReport(),
      loadEntitlementReport()
    ]);
  }, [
    loadCollectionReport,
    loadDashboardSummary,
    loadDepositReport,
    loadEntitlementReport,
    loadFinanceReport,
    loadOrderReport,
    loadVehicleAssetReport
  ]);

  const exportReportCsv = useCallback(
    async (key: ExportReportKey) => {
      setExporting((current) => ({ ...current, [key]: true }));
      try {
        await downloadCsv(
          exportReportPath(key, dateRange, orderFilters),
          exportDefaultFilename(key, dateRange)
        );
      } catch (error) {
        void message.error(getExportErrorMessage(error));
      } finally {
        setExporting((current) => ({ ...current, [key]: false }));
      }
    },
    [dateRange, message, orderFilters]
  );

  const exportCurrentDetailCsv = useCallback(async () => {
    if (!drilldown) {
      return;
    }

    setExportingDetail(true);
    try {
      await downloadCsv(
        `${drilldown.path}/export${buildQuery({
          ...dateRangeParams(dateRange),
          ...drilldown.query
        })}`,
        detailExportDefaultFilename(drilldown.kind, dateRange)
      );
    } catch (error) {
      void message.error(getExportErrorMessage(error));
    } finally {
      setExportingDetail(false);
    }
  }, [dateRange, drilldown, message]);

  const openDrilldown = useCallback((config: Omit<DrilldownState, "page" | "pageSize">) => {
    setDetailData(null);
    setDetailError(undefined);
    setDrilldown({
      ...config,
      page: 1,
      pageSize: 20
    });
  }, []);

  const closeDrilldown = useCallback(() => {
    setDrilldown(null);
    setDetailData(null);
    setDetailError(undefined);
  }, []);

  const changeDrilldownPage = useCallback((page: number, pageSize: number) => {
    setDrilldown((current) => (current ? { ...current, page, pageSize } : current));
  }, []);

  const loadDrilldown = useCallback(
    async (config: DrilldownState) => {
      setDetailLoading(true);
      setDetailError(undefined);
      try {
        setDetailData(
          await apiFetch<PagedDetailResponse>(
            `${config.path}${buildQuery({
              ...dateRangeParams(dateRange),
              ...config.query,
              page: config.page,
              pageSize: config.pageSize
            })}`
          )
        );
      } catch (error) {
        setDetailError(getErrorMessage(error));
      } finally {
        setDetailLoading(false);
      }
    },
    [dateRange]
  );

  useEffect(() => {
    apiFetch<AuthMeResponse>("/auth/me")
      .then(setMe)
      .catch((error) => {
        void message.error(getErrorMessage(error));
      })
      .finally(() => setLoadingMe(false));
  }, [message]);

  useEffect(() => {
    if (!loadingMe) {
      void loadVisibleReports();
    }
  }, [loadVisibleReports, loadingMe]);

  useEffect(() => {
    if (visibleReportKeys.length && !visibleReportKeys.includes(activeTab)) {
      setActiveTab(visibleReportKeys[0]!);
    }
  }, [activeTab, visibleReportKeys]);

  useEffect(() => {
    if (drilldown) {
      void loadDrilldown(drilldown);
    }
  }, [drilldown, loadDrilldown]);

  const tabItems = visibleReportKeys.map((key) => ({
    children: renderReportTab(key),
    forceRender: key === "orders",
    key,
    label: reportLabels[key]
  }));

  function openOrderDetails(title: string, query: Record<string, unknown> = {}, filters: DrilldownState["filters"] = []) {
    openDrilldown({
      filters,
      kind: "orders",
      path: "/reports/details/orders",
      query,
      title
    });
  }

  function openBillDetails(title: string, query: Record<string, unknown> = {}, filters: DrilldownState["filters"] = []) {
    if (!canViewFinanceReports) {
      return;
    }
    openDrilldown({
      filters,
      kind: "bills",
      path: "/reports/details/bills",
      query,
      title
    });
  }

  function openDepositLedgerDetails(
    title: string,
    query: Record<string, unknown> = {},
    filters: DrilldownState["filters"] = []
  ) {
    if (!canViewFinanceReports) {
      return;
    }
    openDrilldown({
      filters,
      kind: "depositLedgers",
      path: "/reports/details/deposit-ledgers",
      query,
      title
    });
  }

  function openOverdueBillDetails(
    title: string,
    query: Record<string, unknown> = {},
    filters: DrilldownState["filters"] = []
  ) {
    if (!canViewCollectionReport) {
      return;
    }
    openDrilldown({
      filters,
      kind: "overdueBills",
      path: "/reports/details/overdue-bills",
      query,
      title
    });
  }

  function openCollectionCaseDetails(
    title: string,
    query: Record<string, unknown> = {},
    filters: DrilldownState["filters"] = []
  ) {
    if (!canViewCollectionReport) {
      return;
    }
    openDrilldown({
      filters,
      kind: "collectionCases",
      path: "/reports/details/collection-cases",
      query,
      title
    });
  }

  function openVehicleDetails(title: string, query: Record<string, unknown> = {}, filters: DrilldownState["filters"] = []) {
    if (!canViewAssetReport) {
      return;
    }
    openDrilldown({
      filters,
      kind: "vehicles",
      path: "/reports/details/vehicles",
      query,
      title
    });
  }

  function openEntitlementGrantDetails(
    title: string,
    query: Record<string, unknown> = {},
    filters: DrilldownState["filters"] = []
  ) {
    if (!canViewEntitlementReport) {
      return;
    }
    openDrilldown({
      filters,
      kind: "entitlementGrants",
      path: "/reports/details/entitlement-grants",
      query,
      title
    });
  }

  function openEntitlementUsageDetails(
    title: string,
    query: Record<string, unknown> = {},
    filters: DrilldownState["filters"] = []
  ) {
    if (!canViewEntitlementReport) {
      return;
    }
    openDrilldown({
      filters,
      kind: "entitlementUsages",
      path: "/reports/details/entitlement-usages",
      query,
      title
    });
  }

  function currentOrderFilters(extra: Record<string, unknown> = {}) {
    return {
      ...orderFilters,
      ...extra
    };
  }

  function currentOrderFilterEntries(extra: Record<string, unknown> = {}) {
    const values = currentOrderFilters(extra);
    const entries: Array<{ label: string; value: string }> = [];
    if (typeof values.orderSource === "string") {
      entries.push({ label: "订单来源", value: labelOf(orderSourceLabels, values.orderSource) });
    }
    if (typeof values.orderStatus === "string") {
      entries.push({ label: "订单状态", value: labelOf(ORDER_STATUS_LABELS, values.orderStatus) });
    }
    if (typeof values.vehicleModel === "string") {
      entries.push({ label: "车型", value: values.vehicleModel });
    }
    return entries;
  }

  function renderReportTab(key: ReportKey) {
    if (key === "summary") {
      return (
        <ReportPanel data={dashboardSummary} error={errors.summary} loading={loading.summary}>
          <DashboardSummaryContent
            canViewAssetReport={canViewAssetReport}
            canViewCollectionReport={canViewCollectionReport}
            canViewFinanceReports={canViewFinanceReports}
            onBillDetails={openBillDetails}
            onCollectionCaseDetails={openCollectionCaseDetails}
            onDepositLedgerDetails={openDepositLedgerDetails}
            onOrderDetails={openOrderDetails}
            onOverdueBillDetails={openOverdueBillDetails}
            onVehicleDetails={openVehicleDetails}
            summary={dashboardSummary}
          />
        </ReportPanel>
      );
    }

    if (key === "orders") {
      return (
        <ReportPanel data={orderReport} error={errors.orders} loading={loading.orders}>
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <ExportButton loading={exporting.orders} onClick={() => void exportReportCsv("orders")} />
            <Space align="end" size={16} wrap>
              <Space orientation="vertical" size={4}>
                <Typography.Text type="secondary">订单来源</Typography.Text>
                <Select
                  allowClear
                  onChange={(value) =>
                    setOrderFilters((current) => ({ ...current, orderSource: value }))
                  }
                  options={optionsFromLabels(orderSourceLabels)}
                  style={{ width: 150 }}
                  value={orderFilters.orderSource}
                />
              </Space>
              <Space orientation="vertical" size={4}>
                <Typography.Text type="secondary">订单状态</Typography.Text>
                <Select
                  allowClear
                  onChange={(value) =>
                    setOrderFilters((current) => ({ ...current, orderStatus: value }))
                  }
                  options={optionsFromLabels(ORDER_STATUS_LABELS)}
                  style={{ width: 170 }}
                  value={orderFilters.orderStatus}
                />
              </Space>
              <Space orientation="vertical" size={4}>
                <Typography.Text type="secondary">车型</Typography.Text>
                <Select
                  allowClear
                  onChange={(value) =>
                    setOrderFilters((current) => ({ ...current, vehicleModel: value }))
                  }
                  options={vehicleModelOptions}
                  style={{ width: 120 }}
                  value={orderFilters.vehicleModel}
                />
              </Space>
              <Button
                icon={<ReloadOutlined />}
                loading={loading.orders}
                onClick={() => void loadOrderReport()}
              >
                查询
              </Button>
              <Button
                onClick={() => {
                  setOrderFilters({});
                  void loadOrderReport({});
                }}
              >
                重置
              </Button>
            </Space>
            <MetricGrid
              items={[
                metric("订单总数", formatInteger(orderReport?.totalOrders), () =>
                  openOrderDetails("订单报表明细", currentOrderFilters(), currentOrderFilterEntries())
                )
              ]}
            />
            <ReportTablesGrid>
              <Table
                columns={orderStatusColumns}
                dataSource={orderReport?.byStatus ?? []}
                loading={loading.orders}
                onRow={clickableRow((record: OrderStatusRow) =>
                  openOrderDetails(
                    `${labelOf(ORDER_STATUS_LABELS, record.orderStatus)}订单明细`,
                    currentOrderFilters({ orderStatus: record.orderStatus }),
                    currentOrderFilterEntries({ orderStatus: record.orderStatus })
                  )
                )}
                pagination={false}
                rowKey={(record) => record.orderStatus ?? "unknown"}
                size="small"
                title={() => "按订单状态统计"}
                locale={{ emptyText: "暂无数据" }}
              />
              <Table
                columns={orderSourceColumns}
                dataSource={orderReport?.bySource ?? []}
                loading={loading.orders}
                onRow={clickableRow((record: OrderSourceRow) =>
                  openOrderDetails(
                    `${labelOf(orderSourceLabels, record.orderSource)}订单明细`,
                    currentOrderFilters({ orderSource: record.orderSource }),
                    currentOrderFilterEntries({ orderSource: record.orderSource })
                  )
                )}
                pagination={false}
                rowKey={(record) => record.orderSource ?? "unknown"}
                size="small"
                title={() => "按订单来源统计"}
                locale={{ emptyText: "暂无数据" }}
              />
              <Table
                columns={vehicleModelCountColumns}
                dataSource={orderReport?.byVehicleModel ?? []}
                loading={loading.orders}
                onRow={clickableRow((record: VehicleModelCountRow) =>
                  openOrderDetails(
                    `${safeText(record.vehicleModel)}订单明细`,
                    currentOrderFilters({ vehicleModel: record.vehicleModel }),
                    currentOrderFilterEntries({ vehicleModel: record.vehicleModel })
                  )
                )}
                pagination={false}
                rowKey={(record) => record.vehicleModel ?? "unknown"}
                size="small"
                title={() => "按车型统计"}
                locale={{ emptyText: "暂无数据" }}
              />
              <Table
                columns={subscriptionPlanColumns}
                dataSource={orderReport?.bySubscriptionPlan ?? []}
                loading={loading.orders}
                onRow={clickableRow((record: SubscriptionPlanCountRow) => {
                  if (!record.subscriptionPlanId) {
                    return;
                  }
                  openOrderDetails(
                    `${safeText(record.subscriptionPlanName ?? record.subscriptionPlanNo)}订单明细`,
                    currentOrderFilters({ subscriptionPlanId: record.subscriptionPlanId }),
                    [
                      ...currentOrderFilterEntries(),
                      { label: "订阅套餐", value: safeText(record.subscriptionPlanName ?? record.subscriptionPlanNo) }
                    ]
                  );
                })}
                pagination={false}
                rowKey={(record) => record.subscriptionPlanId ?? record.subscriptionPlanName ?? "unassigned"}
                size="small"
                title={() => "按订阅套餐统计"}
                locale={{ emptyText: "暂无数据" }}
              />
            </ReportTablesGrid>
          </Space>
        </ReportPanel>
      );
    }

    if (key === "finance") {
      return (
        <ReportPanel data={financeReport} error={errors.finance} loading={loading.finance}>
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <ExportButton loading={exporting.finance} onClick={() => void exportReportCsv("finance")} />
            <Alert
              showIcon
              title="应收金额来自 ReceivableBill.amount；已收金额来自 ReceivableBill.paidAmount；未收金额来自 ReceivableBill.remainingAmount。收款记录 PaymentRecord 不直接等同收入，需通过核销确认到具体账单。"
              type="info"
            />
            <MetricGrid
              items={[
                metric("总应收金额", formatYuan(financeReport?.totalReceivableAmount), () => openBillDetails("财务账单明细")),
                metric("总已收金额", formatYuan(financeReport?.totalPaidAmount), () => openBillDetails("已收账单明细")),
                metric("总未收金额", formatYuan(financeReport?.totalUnpaidAmount), () => openBillDetails("未收账单明细"))
              ]}
            />
            <ReportTablesGrid>
              <Table
                columns={billTypeColumns}
                dataSource={financeReport?.byBillType ?? []}
                loading={loading.finance}
                onRow={clickableRow((record: BillTypeReportRow) =>
                  openBillDetails(
                    `${labelOf(BILL_TYPE_LABELS, record.billType)}账单明细`,
                    { billType: record.billType },
                    [{ label: "账单类型", value: labelOf(BILL_TYPE_LABELS, record.billType) }]
                  )
                )}
                pagination={false}
                rowKey={(record) => record.billType ?? "unknown"}
                scroll={{ x: 640 }}
                size="small"
                title={() => "按账单类型统计"}
                locale={{ emptyText: "暂无数据" }}
              />
              <Table
                columns={billStatusColumns}
                dataSource={financeReport?.byBillStatus ?? []}
                loading={loading.finance}
                onRow={clickableRow((record: BillStatusReportRow) =>
                  openBillDetails(
                    `${labelOf(BILL_STATUS_LABELS, record.billStatus)}账单明细`,
                    { billStatus: record.billStatus },
                    [{ label: "账单状态", value: labelOf(BILL_STATUS_LABELS, record.billStatus) }]
                  )
                )}
                pagination={false}
                rowKey={(record) => record.billStatus ?? "unknown"}
                scroll={{ x: 640 }}
                size="small"
                title={() => "按账单状态统计"}
                locale={{ emptyText: "暂无数据" }}
              />
            </ReportTablesGrid>
          </Space>
        </ReportPanel>
      );
    }

    if (key === "deposit") {
      return (
        <ReportPanel data={depositReport} error={errors.deposit} loading={loading.deposit}>
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <ExportButton loading={exporting.deposit} onClick={() => void exportReportCsv("deposit")} />
            <Alert
              showIcon
              title="仅统计 CONFIRMED 且未删除的 DepositLedger。COLLECT 增加余额，DEDUCT / REFUND / RELEASE 减少余额，FREEZE 第一版不影响可用余额。"
              type="info"
            />
            <MetricGrid
              items={[
                metric("累计收取保证金", formatYuan(depositReport?.collectedAmount), () =>
                  openDepositLedgerDetails("保证金收取明细", { transactionType: "COLLECT" }, [
                    { label: "交易类型", value: "收取" }
                  ])
                ),
                metric("累计扣减保证金", formatYuan(depositReport?.deductedAmount), () =>
                  openDepositLedgerDetails("保证金扣减明细", { transactionType: "DEDUCT" }, [
                    { label: "交易类型", value: "扣减" }
                  ])
                ),
                metric("累计退款保证金", formatYuan(depositReport?.refundedAmount), () =>
                  openDepositLedgerDetails("保证金退款明细", { transactionType: "REFUND" }, [
                    { label: "交易类型", value: "退还" }
                  ])
                ),
                metric("当前保证金余额", formatYuan(depositReport?.currentBalanceAmount), () =>
                  openDepositLedgerDetails("保证金台账明细")
                ),
                metric("保证金交易笔数", formatInteger(depositReport?.transactionCount), () =>
                  openDepositLedgerDetails("保证金交易明细")
                )
              ]}
            />
            <Table
              columns={depositTransactionColumns}
              dataSource={depositReport?.byTransactionType ?? []}
              loading={loading.deposit}
              onRow={clickableRow((record: DepositTransactionTypeRow) =>
                openDepositLedgerDetails(
                  `${labelOf(DEPOSIT_TRANSACTION_TYPE_LABELS, record.transactionType)}保证金明细`,
                  { transactionType: record.transactionType },
                  [{ label: "交易类型", value: labelOf(DEPOSIT_TRANSACTION_TYPE_LABELS, record.transactionType) }]
                )
              )}
              pagination={false}
              rowKey={(record) => record.transactionType ?? "unknown"}
              size="small"
              title={() => "按交易类型统计"}
              locale={{ emptyText: "暂无数据" }}
            />
          </Space>
        </ReportPanel>
      );
    }

    if (key === "collections") {
      return (
        <ReportPanel data={collectionReport} error={errors.collections} loading={loading.collections}>
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <ExportButton loading={exporting.collections} onClick={() => void exportReportCsv("collections")} />
            <MetricGrid
              items={[
                metric("逾期账单数", formatInteger(collectionReport?.overdueBillCount), () =>
                  openOverdueBillDetails("逾期账单明细")
                ),
                metric("逾期金额", formatYuan(collectionReport?.overdueAmount), () => openOverdueBillDetails("逾期金额明细")),
                metric("逾期订单数", formatInteger(collectionReport?.overdueOrderCount), () =>
                  openOverdueBillDetails("逾期订单账单明细")
                ),
                metric("催收案件数", formatInteger(collectionReport?.collectionCaseCount), () =>
                  openCollectionCaseDetails("催收案件明细")
                ),
                metric("催收中案件数", formatInteger(collectionReport?.activeCaseCount), () =>
                  openCollectionCaseDetails("催收中案件明细", { caseStatus: "ACTIVE" }, [
                    { label: "案件状态", value: "催收中" }
                  ])
                ),
                metric("已关闭案件数", formatInteger(collectionReport?.closedCaseCount), () =>
                  openCollectionCaseDetails("已关闭案件明细", { caseStatus: "CLOSED" }, [
                    { label: "案件状态", value: "已关闭" }
                  ])
                ),
                metric("催收动作数量", formatInteger(collectionReport?.actionCount)),
                metric("承诺付款金额", formatYuan(collectionReport?.promisedPaymentAmount))
              ]}
            />
            <ReportTablesGrid>
              <Table
                columns={collectionLevelColumns}
                dataSource={collectionReport?.byCollectionLevel ?? []}
                loading={loading.collections}
                onRow={clickableRow((record: CollectionLevelRow) =>
                  openOverdueBillDetails(
                    `${labelOf(collectionLevelLabels, record.collectionLevel)}逾期账单明细`,
                    { collectionLevel: record.collectionLevel },
                    [{ label: "逾期等级", value: labelOf(collectionLevelLabels, record.collectionLevel) }]
                  )
                )}
                pagination={false}
                rowKey={(record) => record.collectionLevel ?? "unknown"}
                size="small"
                title={() => "按逾期等级统计"}
                locale={{ emptyText: "暂无数据" }}
              />
              <Table
                columns={collectionCaseStatusColumns}
                dataSource={collectionReport?.byCaseStatus ?? []}
                loading={loading.collections}
                onRow={clickableRow((record: CollectionCaseStatusRow) =>
                  openCollectionCaseDetails(
                    `${labelOf(collectionCaseStatusLabels, record.caseStatus)}案件明细`,
                    { caseStatus: record.caseStatus },
                    [{ label: "案件状态", value: labelOf(collectionCaseStatusLabels, record.caseStatus) }]
                  )
                )}
                pagination={false}
                rowKey={(record) => record.caseStatus ?? "unknown"}
                size="small"
                title={() => "按案件状态统计"}
                locale={{ emptyText: "暂无数据" }}
              />
            </ReportTablesGrid>
          </Space>
        </ReportPanel>
      );
    }

    if (key === "entitlements") {
      return (
        <ReportPanel data={entitlementReport} error={errors.entitlements} loading={loading.entitlements}>
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              showIcon
              title="权益报表按权益发放 createdAt 与权益消耗 occurredAt 统计。TEXT 权益只统计发放数量，不参与余额扣减；不同单位权益不直接相加。"
              type="info"
            />
            <MetricGrid
              items={[
                metric("权益账户总数", formatInteger(entitlementReport?.accountOverview?.totalAccountCount), () =>
                  openEntitlementGrantDetails("权益发放明细")
                ),
                metric("生效中账户数", formatInteger(entitlementReport?.accountOverview?.activeAccountCount), () =>
                  openEntitlementGrantDetails("生效账户权益发放明细")
                ),
                metric("权益发放总数", formatInteger(entitlementReport?.grantOverview?.totalGrantCount), () =>
                  openEntitlementGrantDetails("权益发放明细")
                ),
                metric("可用权益数", formatInteger(entitlementReport?.grantOverview?.activeGrantCount), () =>
                  openEntitlementGrantDetails("可用权益发放明细", { status: "ACTIVE" }, [
                    { label: "权益状态", value: labelOf(ENTITLEMENT_GRANT_STATUS_LABELS, "ACTIVE") }
                  ])
                ),
                metric("已用尽权益数", formatInteger(entitlementReport?.grantOverview?.exhaustedGrantCount), () =>
                  openEntitlementGrantDetails("已用尽权益发放明细", { status: "EXHAUSTED" }, [
                    { label: "权益状态", value: labelOf(ENTITLEMENT_GRANT_STATUS_LABELS, "EXHAUSTED") }
                  ])
                ),
                metric("消耗流水数", formatInteger(entitlementReport?.usageOverview?.totalUsageCount), () =>
                  openEntitlementUsageDetails("权益消耗明细")
                )
              ]}
            />
            <Table
              columns={entitlementTypeUnitColumns}
              dataSource={entitlementReport?.byEntitlementTypeUnit ?? []}
              loading={loading.entitlements}
              onRow={clickableRow((record: EntitlementTypeUnitRow) =>
                openEntitlementGrantDetails(
                  `${labelOf(ENTITLEMENT_TYPE_LABELS, record.entitlementType)} ${labelOf(ENTITLEMENT_UNIT_LABELS, record.unit)} 发放明细`,
                  { entitlementType: record.entitlementType, unit: record.unit },
                  [
                    { label: "权益类型", value: labelOf(ENTITLEMENT_TYPE_LABELS, record.entitlementType) },
                    { label: "单位", value: labelOf(ENTITLEMENT_UNIT_LABELS, record.unit) }
                  ]
                )
              )}
              pagination={false}
              rowKey={(record) => `${record.entitlementType ?? "unknown"}-${record.unit ?? "unknown"}`}
              scroll={{ x: 760 }}
              size="small"
              title={() => "按权益类型 / 单位统计"}
              locale={{ emptyText: "暂无权益发放记录" }}
            />
            <ReportTablesGrid>
              <Table
                columns={entitlementUsageSourceColumns}
                dataSource={entitlementReport?.usageOverview?.bySource ?? []}
                loading={loading.entitlements}
                onRow={clickableRow((record: EntitlementUsageGroupRow) =>
                  openEntitlementUsageDetails(
                    `${labelOf(ENTITLEMENT_USAGE_SOURCE_LABELS, record.usageSource)}权益消耗明细`,
                    { usageSource: record.usageSource },
                    [{ label: "消耗来源", value: labelOf(ENTITLEMENT_USAGE_SOURCE_LABELS, record.usageSource) }]
                  )
                )}
                pagination={false}
                rowKey={(record) => record.usageSource ?? "unknown"}
                size="small"
                title={() => "消耗来源统计"}
                locale={{ emptyText: "暂无权益消耗记录" }}
              />
              <Table
                columns={recentlyExhaustedEntitlementColumns}
                dataSource={entitlementReport?.recentlyExhausted ?? []}
                loading={loading.entitlements}
                pagination={false}
                rowKey={(record) => record.id ?? record.grantNo ?? "unknown"}
                scroll={{ x: 920 }}
                size="small"
                title={() => "最近用尽权益"}
                locale={{ emptyText: "暂无用尽权益" }}
              />
            </ReportTablesGrid>
          </Space>
        </ReportPanel>
      );
    }

    return (
      <ReportPanel data={vehicleAssetReport} error={errors.assets} loading={loading.assets}>
        <Space orientation="vertical" size={16} style={{ width: "100%" }}>
          <ExportButton loading={exporting.assets} onClick={() => void exportReportCsv("assets")} />
          <Alert
            showIcon
            title="出租率 = 在租车辆数 / 可运营车辆数。可运营车辆不包含已售和待退出车辆。收入第一版使用 ReceivableBill.paidAmount。ROA / ROE 后续需要引入资金成本、折旧、生命周期收入、残值和费用，本阶段暂不计算。"
            type="info"
          />
          <MetricGrid
            items={[
              metric("车辆总数", formatInteger(vehicleAssetReport?.totalVehicles), () => openVehicleDetails("车辆明细")),
              metric("可租车辆数", formatInteger(vehicleAssetReport?.availableVehicles), () =>
                openVehicleDetails("可租车辆明细", { vehicleStatus: "AVAILABLE" }, [
                  { label: "车辆状态", value: "可用" }
                ])
              ),
              metric("在租车辆数", formatInteger(vehicleAssetReport?.leasedVehicles), () =>
                openVehicleDetails("在租车辆明细", { vehicleStatus: "LEASED" }, [
                  { label: "车辆状态", value: "已出租" }
                ])
              ),
              metric("维修中车辆数", formatInteger(vehicleAssetReport?.maintenanceVehicles), () =>
                openVehicleDetails("维修中车辆明细", { vehicleStatus: "MAINTENANCE" }, [
                  { label: "车辆状态", value: "维修 / 整备" }
                ])
              ),
              metric("已退回车辆数", formatInteger(vehicleAssetReport?.returnedVehicles), () =>
                openVehicleDetails("已退回车辆明细", { vehicleStatus: "RETURNED" }, [
                  { label: "车辆状态", value: "已退回" }
                ])
              ),
              metric("已售车辆数", formatInteger(vehicleAssetReport?.soldVehicles), () =>
                openVehicleDetails("已售车辆明细", { vehicleStatus: "RETIRED" }, [
                  { label: "车辆状态", value: "已退役" }
                ])
              ),
              metric("出租率", formatPercent(vehicleAssetReport?.rentalRate)),
              metric("平均当前车辆销售价", formatYuan(vehicleAssetReport?.averageCurrentSalePriceAmount)),
              metric("采购成本合计", formatYuan(vehicleAssetReport?.totalPurchasePriceAmount)),
              metric("当前销售价合计", formatYuan(vehicleAssetReport?.totalCurrentSalePriceAmount))
            ]}
          />
          <Table
            columns={vehicleAssetColumns}
            dataSource={vehicleAssetReport?.byVehicleModel ?? []}
            loading={loading.assets}
            onRow={clickableRow((record: VehicleModelAssetRow) =>
              openVehicleDetails(
                `${safeText(record.vehicleModel)}车辆明细`,
                { vehicleModel: record.vehicleModel },
                [{ label: "车型", value: safeText(record.vehicleModel) }]
              )
            )}
            pagination={false}
            rowKey={(record) => record.vehicleModel ?? "unknown"}
            size="small"
            title={() => "按车型统计"}
            locale={{ emptyText: "暂无数据" }}
          />
        </Space>
      </ReportPanel>
    );
  }

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space align="start" style={{ justifyContent: "space-between", width: "100%" }} wrap>
          <Space orientation="vertical" size={4}>
            <Typography.Title level={3} style={{ margin: 0 }}>
              经营看板
            </Typography.Title>
            <Typography.Text type="secondary">
              展示订单、财务、保证金、催收和车辆资产运营概览。
            </Typography.Text>
          </Space>
          <Space wrap>
            <RangePicker
              allowClear={false}
              value={dateRange}
              onChange={(values) => {
                if (values?.[0] && values[1]) {
                  setDateRange([values[0], values[1]]);
                }
              }}
            />
            <Button icon={<ReloadOutlined />} loading={Object.values(loading).some(Boolean)} onClick={loadVisibleReports}>
              刷新
            </Button>
          </Space>
        </Space>

        {!loadingMe && visibleReportKeys.length === 0 ? (
          <Alert showIcon title="无权限查看经营报表" type="warning" />
        ) : null}

        {visibleReportKeys.length > 0 ? (
          <Tabs activeKey={activeTab} items={tabItems} onChange={(key) => setActiveTab(key as ReportKey)} />
        ) : null}

        <Drawer
          destroyOnClose
          open={Boolean(drilldown)}
          size={detailDrawerSize}
          title={drilldown?.title}
          onClose={closeDrilldown}
        >
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            <Typography.Text type="secondary">
              统计周期：{dateRange[0].format("YYYY-MM-DD")} 至 {dateRange[1].format("YYYY-MM-DD")}
              {drilldown?.filters?.length ? (
                <>
                  {"；筛选："}
                  {drilldown.filters.map((filter) => `${filter.label}=${filter.value}`).join("，")}
                </>
              ) : null}
            </Typography.Text>
            <Space align="start" style={{ justifyContent: "space-between", width: "100%" }} wrap>
              <Typography.Text type="secondary">导出当前下钻条件下的全部明细，非仅当前分页。</Typography.Text>
              {canExportCurrentDetail ? (
                <Button
                  icon={<DownloadOutlined />}
                  loading={exportingDetail}
                  onClick={() => void exportCurrentDetailCsv()}
                >
                  导出当前明细
                </Button>
              ) : null}
            </Space>
            {detailError ? <Alert showIcon title={detailError} type="error" /> : null}
            <Table<DetailRow>
              columns={drilldown ? detailColumnsByKind[drilldown.kind] : []}
              dataSource={detailData?.items ?? []}
              loading={detailLoading}
              pagination={{
                current: detailData?.page ?? drilldown?.page ?? 1,
                onChange: changeDrilldownPage,
                pageSize: detailData?.pageSize ?? drilldown?.pageSize ?? 20,
                showSizeChanger: true,
                total: detailData?.total ?? 0
              }}
              rowKey={detailTableRowKey}
              scroll={{ x: 1200 }}
              size="small"
              locale={{ emptyText: "暂无数据" }}
            />
          </Space>
        </Drawer>
      </Space>
    </ProtectedShell>
  );
}

const orderStatusColumns: ColumnsType<OrderStatusRow> = [
  {
    dataIndex: "orderStatus",
    render: (value?: string | null) => formatTag(ORDER_STATUS_LABELS, value),
    title: "订单状态",
    width: 180
  },
  { dataIndex: "count", render: formatInteger, title: "订单数", width: 110 }
];

const orderSourceColumns: ColumnsType<OrderSourceRow> = [
  {
    dataIndex: "orderSource",
    render: (value?: string | null) => labelOf(orderSourceLabels, value),
    title: "订单来源",
    width: 180
  },
  { dataIndex: "count", render: formatInteger, title: "订单数", width: 110 }
];

const vehicleModelCountColumns: ColumnsType<VehicleModelCountRow> = [
  { dataIndex: "vehicleModel", render: safeText, title: "车型", width: 120 },
  { dataIndex: "count", render: formatInteger, title: "订单数", width: 110 }
];

const subscriptionPlanColumns: ColumnsType<SubscriptionPlanCountRow> = [
  { dataIndex: "subscriptionPlanNo", render: safeText, title: "套餐编号", width: 160 },
  { dataIndex: "subscriptionPlanName", render: safeText, title: "套餐名称", width: 220 },
  { dataIndex: "count", render: formatInteger, title: "订单数", width: 110 }
];

const billTypeColumns: ColumnsType<BillTypeReportRow> = [
  {
    dataIndex: "billType",
    render: (value?: string | null) => labelOf(BILL_TYPE_LABELS, value),
    title: "账单类型",
    width: 140
  },
  { dataIndex: "count", render: formatInteger, title: "账单数", width: 100 },
  { dataIndex: "totalReceivableAmount", render: formatYuan, title: "应收金额", width: 150 },
  { dataIndex: "totalPaidAmount", render: formatYuan, title: "已收金额", width: 150 },
  { dataIndex: "totalUnpaidAmount", render: formatYuan, title: "未收金额", width: 150 }
];

const billStatusColumns: ColumnsType<BillStatusReportRow> = [
  {
    dataIndex: "billStatus",
    render: (value?: string | null) => labelOf(BILL_STATUS_LABELS, value),
    title: "账单状态",
    width: 140
  },
  { dataIndex: "count", render: formatInteger, title: "账单数", width: 100 },
  { dataIndex: "totalReceivableAmount", render: formatYuan, title: "应收金额", width: 150 },
  { dataIndex: "totalPaidAmount", render: formatYuan, title: "已收金额", width: 150 },
  { dataIndex: "totalUnpaidAmount", render: formatYuan, title: "未收金额", width: 150 }
];

const depositTransactionColumns: ColumnsType<DepositTransactionTypeRow> = [
  {
    dataIndex: "transactionType",
    render: (value?: string | null) => labelOf(DEPOSIT_TRANSACTION_TYPE_LABELS, value),
    title: "交易类型",
    width: 140
  },
  { dataIndex: "count", render: formatInteger, title: "笔数", width: 100 },
  { dataIndex: "amount", render: formatYuan, title: "金额", width: 160 }
];

const collectionLevelColumns: ColumnsType<CollectionLevelRow> = [
  {
    dataIndex: "collectionLevel",
    render: (value?: string | null) => labelOf(collectionLevelLabels, value) || labelOf(COLLECTION_LEVEL_LABELS, value),
    title: "逾期等级",
    width: 160
  },
  { dataIndex: "count", render: formatInteger, title: "案件数", width: 100 },
  { dataIndex: "totalOverdueAmount", render: formatYuan, title: "逾期金额", width: 160 }
];

const collectionCaseStatusColumns: ColumnsType<CollectionCaseStatusRow> = [
  {
    dataIndex: "caseStatus",
    render: (value?: string | null) =>
      labelOf(collectionCaseStatusLabels, value) || labelOf(COLLECTION_CASE_STATUS_LABELS, value),
    title: "案件状态",
    width: 150
  },
  { dataIndex: "count", render: formatInteger, title: "案件数", width: 100 },
  { dataIndex: "totalOverdueAmount", render: formatYuan, title: "逾期金额", width: 160 }
];

const vehicleAssetColumns: ColumnsType<VehicleModelAssetRow> = [
  { dataIndex: "vehicleModel", render: safeText, title: "车型", width: 120 },
  { dataIndex: "totalVehicles", render: formatInteger, title: "车辆数", width: 110 },
  { dataIndex: "leasedVehicles", render: formatInteger, title: "在租数", width: 110 },
  { dataIndex: "availableVehicles", render: formatInteger, title: "可租数", width: 110 },
  { dataIndex: "incomeAmount", render: formatYuan, title: "收入", width: 160 }
];

const entitlementTypeUnitColumns: ColumnsType<EntitlementTypeUnitRow> = [
  {
    dataIndex: "entitlementType",
    render: (value?: string | null) => labelOf(ENTITLEMENT_TYPE_LABELS, value),
    title: "权益类型",
    width: 130
  },
  {
    dataIndex: "unit",
    render: (value?: string | null) => labelOf(ENTITLEMENT_UNIT_LABELS, value),
    title: "单位",
    width: 100
  },
  { dataIndex: "grantCount", render: formatInteger, title: "发放数量", width: 110 },
  { dataIndex: "totalAmount", render: formatEntitlementAmount, title: "总量", width: 120 },
  { dataIndex: "usedAmount", render: formatEntitlementAmount, title: "已用", width: 120 },
  { dataIndex: "remainingAmount", render: formatEntitlementAmount, title: "剩余", width: 120 },
  { dataIndex: "exhaustedCount", render: formatInteger, title: "已用尽数量", width: 120 }
];

const entitlementUsageSourceColumns: ColumnsType<EntitlementUsageGroupRow> = [
  {
    dataIndex: "usageSource",
    render: (value?: string | null) => labelOf(ENTITLEMENT_USAGE_SOURCE_LABELS, value),
    title: "消耗来源",
    width: 140
  },
  { dataIndex: "count", render: formatInteger, title: "数量", width: 100 },
  { dataIndex: "usedAmount", render: formatEntitlementAmount, title: "消耗总量", width: 130 }
];

const recentlyExhaustedEntitlementColumns: ColumnsType<RecentlyExhaustedEntitlementRow> = [
  {
    render: (_value, record) => detailLink(orderHrefFrom(record as DetailRow, "orderId"), safeText(record.orderNo)),
    title: "订单编号",
    width: 160
  },
  { dataIndex: "customerName", render: safeText, title: "客户", width: 120 },
  { dataIndex: "entitlementName", render: safeText, title: "权益名称", width: 180 },
  {
    dataIndex: "entitlementType",
    render: (value?: string | null) => labelOf(ENTITLEMENT_TYPE_LABELS, value),
    title: "权益类型",
    width: 120
  },
  {
    dataIndex: "unit",
    render: (value?: string | null) => labelOf(ENTITLEMENT_UNIT_LABELS, value),
    title: "单位",
    width: 100
  },
  {
    render: (_value, record) => formatEntitlementAmountWithUnit(record.totalAmount, record.unit),
    title: "总量",
    width: 120
  },
  { dataIndex: "usedAmount", render: formatEntitlementAmount, title: "已用", width: 110 },
  { dataIndex: "remainingAmount", render: formatEntitlementAmount, title: "剩余", width: 110 },
  { dataIndex: "latestUsageAt", render: formatDate, title: "最近消耗时间", width: 140 }
];

const detailColumnsByKind: Record<DetailKind, ColumnsType<DetailRow>> = {
  entitlementGrants: [
    { render: (_value, record) => detailText(record, "grantNo"), title: "权益编号", width: 170 },
    { render: (_value, record) => detailLink(orderHref(record), detailText(record, "orderNo")), title: "订单编号", width: 160 },
    { render: (_value, record) => detailText(record, "customerName"), title: "客户姓名", width: 120 },
    {
      render: (_value, record) => labelOf(ENTITLEMENT_TYPE_LABELS, detailId(record, "entitlementType")),
      title: "权益类型",
      width: 120
    },
    { render: (_value, record) => detailText(record, "entitlementName"), title: "权益名称", width: 180 },
    { render: (_value, record) => formatEntitlementAmount(detailNumber(record, "totalAmount")), title: "总量", width: 110 },
    { render: (_value, record) => formatEntitlementAmount(detailNumber(record, "usedAmount")), title: "已用", width: 110 },
    { render: (_value, record) => formatEntitlementAmount(detailNumber(record, "remainingAmount")), title: "剩余", width: 110 },
    {
      render: (_value, record) => labelOf(ENTITLEMENT_UNIT_LABELS, detailId(record, "unit")),
      title: "单位",
      width: 100
    },
    {
      render: (_value, record) => formatTag(ENTITLEMENT_GRANT_STATUS_LABELS, detailId(record, "status")),
      title: "状态",
      width: 110
    },
    { render: (_value, record) => detailText(record, "grantSource"), title: "来源", width: 120 },
    { render: (_value, record) => formatDate(detailValue(record, "grantPeriodStart")), title: "有效期开始", width: 130 },
    { render: (_value, record) => formatDate(detailValue(record, "grantPeriodEnd")), title: "有效期结束", width: 130 },
    { render: (_value, record) => formatDate(detailValue(record, "createdAt")), title: "创建时间", width: 120 }
  ],
  entitlementUsages: [
    { render: (_value, record) => detailText(record, "usageNo"), title: "流水编号", width: 170 },
    { render: (_value, record) => detailLink(orderHref(record), detailText(record, "orderNo")), title: "订单编号", width: 160 },
    { render: (_value, record) => detailText(record, "customerName"), title: "客户姓名", width: 120 },
    {
      render: (_value, record) => labelOf(ENTITLEMENT_TYPE_LABELS, detailId(record, "entitlementType")),
      title: "权益类型",
      width: 120
    },
    { render: (_value, record) => detailText(record, "entitlementName"), title: "权益名称", width: 180 },
    { render: (_value, record) => formatEntitlementAmount(detailNumber(record, "usedAmount")), title: "消耗数量", width: 120 },
    {
      render: (_value, record) => labelOf(ENTITLEMENT_UNIT_LABELS, detailId(record, "unit")),
      title: "单位",
      width: 100
    },
    {
      render: (_value, record) => labelOf(ENTITLEMENT_USAGE_SOURCE_LABELS, detailId(record, "usageSource")),
      title: "消耗来源",
      width: 120
    },
    {
      render: (_value, record) => formatTag(ENTITLEMENT_USAGE_STATUS_LABELS, detailId(record, "usageStatus")),
      title: "消耗状态",
      width: 120
    },
    { render: (_value, record) => formatDate(detailValue(record, "occurredAt")), title: "发生时间", width: 130 },
    { render: (_value, record) => detailText(record, "externalRefNo"), title: "外部流水号", width: 150 },
    { render: (_value, record) => detailText(record, "scenario"), title: "使用场景", width: 150 },
    { render: (_value, record) => detailText(record, "remark"), title: "备注", width: 180 },
    { render: (_value, record) => formatDate(detailValue(record, "createdAt")), title: "创建时间", width: 120 }
  ],
  bills: [
    {
      render: (_value, record) => detailLink(orderHref(record), detailText(record, "billNo")),
      title: "账单编号",
      width: 160
    },
    { render: (_value, record) => detailLink(orderHref(record), detailText(record, "orderNo")), title: "订单编号", width: 150 },
    { render: (_value, record) => detailText(record, "customerName"), title: "客户姓名", width: 120 },
    {
      render: (_value, record) => labelOf(BILL_TYPE_LABELS, detailId(record, "billType")),
      title: "账单类型",
      width: 120
    },
    {
      render: (_value, record) => formatTag(BILL_STATUS_LABELS, detailId(record, "billStatus")),
      title: "账单状态",
      width: 120
    },
    { render: (_value, record) => formatYuan(detailNumber(record, "amount")), title: "应收金额", width: 130 },
    { render: (_value, record) => formatYuan(detailNumber(record, "paidAmount")), title: "已收金额", width: 130 },
    { render: (_value, record) => formatYuan(detailNumber(record, "remainingAmount")), title: "剩余金额", width: 130 },
    { render: (_value, record) => formatDate(detailValue(record, "dueDate")), title: "到期日", width: 120 },
    { render: (_value, record) => formatDate(detailValue(record, "periodStart")), title: "账期开始", width: 120 },
    { render: (_value, record) => formatDate(detailValue(record, "periodEnd")), title: "账期结束", width: 120 },
    { render: (_value, record) => formatDate(detailValue(record, "createdAt")), title: "创建时间", width: 120 }
  ],
  collectionCases: [
    {
      render: (_value, record) => detailLink("/billing/collections", detailText(record, "caseNo")),
      title: "案件编号",
      width: 160
    },
    { render: (_value, record) => detailText(record, "customerName"), title: "客户姓名", width: 120 },
    { render: (_value, record) => detailLink(orderHref(record), detailText(record, "orderNo")), title: "订单编号", width: 150 },
    {
      render: (_value, record) => formatYuan(detailNumber(record, "totalOverdueAmount")),
      title: "逾期总金额",
      width: 140
    },
    { render: (_value, record) => formatInteger(detailNumber(record, "maxOverdueDays")), title: "最大逾期天数", width: 130 },
    {
      render: (_value, record) => labelOf(collectionLevelLabels, detailId(record, "collectionLevel")),
      title: "逾期等级",
      width: 140
    },
    {
      render: (_value, record) => formatTag(collectionCaseStatusLabels, detailId(record, "caseStatus")),
      title: "案件状态",
      width: 120
    },
    { render: (_value, record) => detailText(record, "assignedTo"), title: "负责人", width: 180 },
    { render: (_value, record) => formatDate(detailValue(record, "nextFollowUpAt")), title: "下次跟进", width: 120 },
    { render: (_value, record) => formatDate(detailValue(record, "createdAt")), title: "创建时间", width: 120 },
    { render: (_value, record) => formatDate(detailValue(record, "closedAt")), title: "关闭时间", width: 120 }
  ],
  depositLedgers: [
    { render: (_value, record) => detailText(record, "ledgerNo"), title: "台账编号", width: 160 },
    { render: (_value, record) => detailLink(orderHref(record), detailText(record, "orderNo")), title: "订单编号", width: 150 },
    { render: (_value, record) => detailText(record, "customerName"), title: "客户姓名", width: 120 },
    {
      render: (_value, record) => labelOf(DEPOSIT_TRANSACTION_TYPE_LABELS, detailId(record, "transactionType")),
      title: "交易类型",
      width: 120
    },
    {
      render: (_value, record) => labelOf(DEPOSIT_TRANSACTION_STATUS_LABELS, detailId(record, "transactionStatus")),
      title: "交易状态",
      width: 120
    },
    { render: (_value, record) => formatYuan(detailNumber(record, "amount")), title: "金额", width: 130 },
    { render: (_value, record) => formatYuan(detailNumber(record, "balanceAfterAmount")), title: "交易后余额", width: 140 },
    { render: (_value, record) => detailText(record, "relatedBillNo"), title: "关联账单", width: 150 },
    { render: (_value, record) => formatDate(detailValue(record, "occurredAt")), title: "发生时间", width: 120 },
    { render: (_value, record) => detailText(record, "remark"), title: "备注", width: 200 }
  ],
  orders: [
    { render: (_value, record) => detailLink(orderHref(record), detailText(record, "orderNo")), title: "订单编号", width: 150 },
    { render: (_value, record) => detailText(record, "customerName"), title: "客户姓名", width: 120 },
    { render: (_value, record) => detailText(record, "mobile"), title: "手机号", width: 130 },
    { render: (_value, record) => labelOf(orderSourceLabels, detailId(record, "orderSource")), title: "订单来源", width: 120 },
    {
      render: (_value, record) => formatTag(ORDER_STATUS_LABELS, detailId(record, "orderStatus")),
      title: "订单状态",
      width: 140
    },
    { render: (_value, record) => detailText(record, "vehicleVin"), title: "车辆 VIN", width: 170 },
    { render: (_value, record) => detailText(record, "plateNo"), title: "车牌号", width: 110 },
    { render: (_value, record) => detailText(record, "vehicleModel"), title: "车型", width: 100 },
    { render: (_value, record) => detailText(record, "subscriptionPlanName"), title: "订阅套餐", width: 180 },
    { render: (_value, record) => formatYuan(detailNumber(record, "monthlyFeeAmount")), title: "月费", width: 120 },
    { render: (_value, record) => formatYuan(detailNumber(record, "depositAmount")), title: "押金", width: 120 },
    { render: (_value, record) => labelOf(STATUS_LABELS, detailId(record, "contractStatus")), title: "合同状态", width: 120 },
    { render: (_value, record) => formatDate(detailValue(record, "leaseStartDate")), title: "起租时间", width: 120 },
    { render: (_value, record) => formatDate(detailValue(record, "returnAt")), title: "退车时间", width: 120 },
    { render: (_value, record) => formatDate(detailValue(record, "createdAt")), title: "创建时间", width: 120 }
  ],
  overdueBills: [
    { render: (_value, record) => detailLink(orderHref(record), detailText(record, "billNo")), title: "账单编号", width: 160 },
    { render: (_value, record) => detailLink(orderHref(record), detailText(record, "orderNo")), title: "订单编号", width: 150 },
    { render: (_value, record) => detailText(record, "customerName"), title: "客户姓名", width: 120 },
    { render: (_value, record) => labelOf(BILL_TYPE_LABELS, detailId(record, "billType")), title: "账单类型", width: 120 },
    { render: (_value, record) => formatYuan(detailNumber(record, "remainingAmount")), title: "剩余金额", width: 130 },
    { render: (_value, record) => formatDate(detailValue(record, "dueDate")), title: "到期日", width: 120 },
    { render: (_value, record) => formatInteger(detailNumber(record, "overdueDays")), title: "逾期天数", width: 110 },
    {
      render: (_value, record) => labelOf(collectionLevelLabels, detailId(record, "collectionLevel")),
      title: "逾期等级",
      width: 140
    },
    { render: (_value, record) => detailLink("/billing/collections", detailText(record, "caseNo")), title: "案件编号", width: 150 },
    {
      render: (_value, record) => formatTag(collectionCaseStatusLabels, detailId(record, "caseStatus")),
      title: "案件状态",
      width: 120
    }
  ],
  vehicles: [
    { render: (_value, record) => detailLink("/vehicles", detailText(record, "vehicleNo")), title: "车辆编号", width: 140 },
    { render: (_value, record) => detailLink("/vehicles", detailText(record, "vin")), title: "VIN", width: 170 },
    { render: (_value, record) => detailText(record, "plateNo"), title: "车牌号", width: 110 },
    { render: (_value, record) => detailText(record, "brand"), title: "品牌", width: 100 },
    { render: (_value, record) => detailText(record, "series"), title: "车系", width: 100 },
    { render: (_value, record) => detailText(record, "model"), title: "车型配置", width: 140 },
    { render: (_value, record) => detailText(record, "vehicleModel"), title: "车型", width: 100 },
    { render: (_value, record) => safeText(detailNumber(record, "batteryCapacityKwh")), title: "电池容量", width: 110 },
    {
      render: (_value, record) => labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, detailId(record, "batteryUsageType")),
      title: "电池使用方式",
      width: 140
    },
    { render: (_value, record) => formatTag(STATUS_LABELS, detailId(record, "vehicleStatus")), title: "车辆状态", width: 130 },
    { render: (_value, record) => formatYuan(detailNumber(record, "purchasePriceAmount")), title: "采购价", width: 130 },
    { render: (_value, record) => formatYuan(detailNumber(record, "currentSalePriceAmount")), title: "当前销售价", width: 140 },
    { render: (_value, record) => detailLink(orderHrefFrom(record, "currentOrderId"), detailText(record, "currentOrderNo")), title: "当前订单", width: 150 },
    { render: (_value, record) => detailText(record, "currentCustomerName"), title: "当前客户", width: 120 },
    { render: (_value, record) => formatYuan(detailNumber(record, "totalPaidAmount")), title: "累计已收金额", width: 140 },
    { render: (_value, record) => formatDate(detailValue(record, "latestDeliveredAt")), title: "最近交付", width: 120 },
    { render: (_value, record) => formatDate(detailValue(record, "latestReturnedAt")), title: "最近退车", width: 120 },
    { render: (_value, record) => formatDate(detailValue(record, "createdAt")), title: "创建时间", width: 120 }
  ]
};

function orderHref(record: DetailRow) {
  return orderHrefFrom(record, "orderId") ?? orderHrefFrom(record, "id");
}

function orderHrefFrom(record: DetailRow, key: string) {
  const id = detailId(record, key);
  return id ? `/orders/${id}` : null;
}

function ExportButton({ loading, onClick }: Readonly<{ loading: boolean; onClick: () => void }>) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <Button icon={<DownloadOutlined />} loading={loading} onClick={onClick}>
        导出 CSV
      </Button>
    </div>
  );
}

function DashboardSummaryContent({
  canViewAssetReport,
  canViewCollectionReport,
  canViewFinanceReports,
  onBillDetails,
  onCollectionCaseDetails,
  onDepositLedgerDetails,
  onOrderDetails,
  onOverdueBillDetails,
  onVehicleDetails,
  summary
}: Readonly<{
  canViewAssetReport: boolean;
  canViewCollectionReport: boolean;
  canViewFinanceReports: boolean;
  onBillDetails: (title: string, query?: Record<string, unknown>, filters?: DrilldownState["filters"]) => void;
  onCollectionCaseDetails: (title: string, query?: Record<string, unknown>, filters?: DrilldownState["filters"]) => void;
  onDepositLedgerDetails: (title: string, query?: Record<string, unknown>, filters?: DrilldownState["filters"]) => void;
  onOrderDetails: (title: string, query?: Record<string, unknown>, filters?: DrilldownState["filters"]) => void;
  onOverdueBillDetails: (title: string, query?: Record<string, unknown>, filters?: DrilldownState["filters"]) => void;
  onVehicleDetails: (title: string, query?: Record<string, unknown>, filters?: DrilldownState["filters"]) => void;
  summary: DashboardSummaryReport | null;
}>) {
  const rentalRate = safeRatio(summary?.leasedVehicles, summary?.totalVehicles);
  const collectionRate = safeRatio(summary?.totalPaidAmount, summary?.totalReceivableAmount);
  const pendingItems = [
    {
      active: (summary?.overdueAmount ?? 0) > 0,
      label: "有逾期账单",
      onClick: canViewCollectionReport ? () => onOverdueBillDetails("逾期账单明细") : undefined
    },
    {
      active: (summary?.collectionCaseCount ?? 0) > 0,
      label: "有催收案件",
      onClick: canViewCollectionReport ? () => onCollectionCaseDetails("催收案件明细") : undefined
    },
    {
      active: (summary?.totalUnpaidAmount ?? 0) > 0,
      label: "有未收账款",
      onClick: canViewFinanceReports ? () => onBillDetails("欠收账单明细") : undefined
    },
    {
      active: (summary?.maintenanceVehicles ?? 0) > 0,
      label: "有维修车辆",
      onClick: canViewAssetReport
        ? () =>
            onVehicleDetails("维修中车辆明细", { vehicleStatus: "MAINTENANCE" }, [
              { label: "车辆状态", value: "维修 / 整备" }
            ])
        : undefined
    }
  ].filter((item) => item.active);

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <DashboardBlock
        description="先看经营结果，再向下定位订单、车辆、收款、押金和风险来源。"
        title="核心经营结果"
      >
        <MetricGrid
          items={[
            metric("在租订单", formatInteger(summary?.activeOrders), () =>
              onOrderDetails("在租订单明细", { orderStatus: "ACTIVE" }, [{ label: "订单状态", value: "在租" }])
            ),
            metric(
              "已出租车辆 / 出租率",
              `${formatInteger(summary?.leasedVehicles)} / ${formatPercent(rentalRate)}`,
              canViewAssetReport
                ? () =>
                    onVehicleDetails("在租车辆明细", { vehicleStatus: "LEASED" }, [
                      { label: "车辆状态", value: "已出租" }
                    ])
                : undefined
            ),
            metric(
              "实收金额",
              formatYuan(summary?.totalPaidAmount),
              canViewFinanceReports ? () => onBillDetails("已收账单明细") : undefined
            ),
            metric(
              "未收 / 逾期金额",
              `${formatYuan(summary?.totalUnpaidAmount)} / ${formatYuan(summary?.overdueAmount)}`,
              canViewCollectionReport ? () => onOverdueBillDetails("逾期账单明细") : undefined
            ),
            metric(
              "催收案件数",
              formatInteger(summary?.collectionCaseCount),
              canViewCollectionReport ? () => onCollectionCaseDetails("催收案件明细") : undefined
            ),
            metric(
              "押金余额",
              formatYuan(summary?.depositBalanceAmount),
              canViewFinanceReports ? () => onDepositLedgerDetails("保证金台账明细") : undefined
            )
          ]}
        />
      </DashboardBlock>

      <ReportTablesGrid>
        <DashboardBlock title="订单与履约链路">
          <Descriptions
            bordered
            column={1}
            items={[
              { label: "订单总数", children: formatInteger(summary?.totalOrders) },
              { label: "新增订单", children: formatInteger(summary?.newOrders) },
              { label: "在租订单", children: formatInteger(summary?.activeOrders) },
              { label: "已完成订单", children: formatInteger(summary?.completedOrders) },
              { label: "已取消订单", children: formatInteger(summary?.cancelledOrders) }
            ]}
            size="small"
          />
        </DashboardBlock>

        <DashboardBlock title="车辆运营状态">
          <Descriptions
            bordered
            column={1}
            items={[
              { label: "车辆总数", children: formatInteger(summary?.totalVehicles) },
              { label: "可租用", children: formatInteger(summary?.availableVehicles) },
              { label: "审核占用", children: formatInteger(summary?.reviewReservedVehicles) },
              { label: "签约锁定", children: formatInteger(summary?.signingLockedVehicles) },
              { label: "已出租", children: formatInteger(summary?.leasedVehicles) },
              { label: "维修中", children: formatInteger(summary?.maintenanceVehicles) },
              { label: "已退回", children: formatInteger(summary?.returnedVehicles) },
              { label: "出租率", children: formatPercent(rentalRate) }
            ]}
            size="small"
          />
        </DashboardBlock>

        <DashboardBlock title="财务收款">
          <Descriptions
            bordered
            column={1}
            items={[
              { label: "应收合计", children: formatYuan(summary?.totalReceivableAmount) },
              { label: "实收合计", children: formatYuan(summary?.totalPaidAmount) },
              { label: "未收合计", children: formatYuan(summary?.totalUnpaidAmount) },
              { label: "收款率", children: formatPercent(collectionRate) },
              { label: "钩稽关系", children: "未收金额 = 应收合计 - 实收合计" }
            ]}
            size="small"
          />
        </DashboardBlock>

        <DashboardBlock title="押金与保证金">
          <Descriptions
            bordered
            column={1}
            items={[
              { label: "押金余额", children: formatYuan(summary?.depositBalanceAmount) },
              { label: "说明", children: "押金余额单独列示，不计入经营收入。" }
            ]}
            size="small"
          />
        </DashboardBlock>

        <DashboardBlock title="逾期与催收风险">
          <Descriptions
            bordered
            column={1}
            items={[
              { label: "逾期金额", children: formatYuan(summary?.overdueAmount) },
              { label: "逾期订单数", children: formatInteger(summary?.overdueOrderCount) },
              { label: "催收案件数", children: formatInteger(summary?.collectionCaseCount) }
            ]}
            size="small"
          />
        </DashboardBlock>

        <DashboardBlock title="待处理事项">
          {pendingItems.length > 0 ? (
            <Space size={[8, 8]} wrap>
              {pendingItems.map((item) => (
                <Tag
                  color="orange"
                  key={item.label}
                  onClick={item.onClick}
                  style={{ cursor: item.onClick ? "pointer" : "default" }}
                >
                  {item.label}
                </Tag>
              ))}
            </Space>
          ) : (
            <Typography.Text type="secondary">暂无可由当前数据判断的待处理事项</Typography.Text>
          )}
        </DashboardBlock>
      </ReportTablesGrid>

      <Collapse
        items={[
          {
            children:
              "经营总览按核心结果、订单履约、车辆运营、财务收款、押金和逾期催收分区展示。押金不计入经营收入；未收金额来自应收与实收差额；出租率按已出租车辆 / 车辆总数展示，若分母缺失则显示 -。",
            key: "summary-calculation",
            label: "经营总览口径说明"
          }
        ]}
        size="small"
      />
    </Space>
  );
}

function DashboardBlock({
  children,
  description,
  title
}: Readonly<{ children: React.ReactNode; description?: string; title: string }>) {
  return (
    <Card
      size="small"
      title={
        <Space orientation="vertical" size={0}>
          <Typography.Text strong>{title}</Typography.Text>
          {description ? <Typography.Text type="secondary">{description}</Typography.Text> : null}
        </Space>
      }
    >
      {children}
    </Card>
  );
}

function ReportPanel({
  children,
  data,
  error,
  loading
}: Readonly<{
  children: React.ReactNode;
  data: unknown;
  error?: string;
  loading: boolean;
}>) {
  if (error) {
    return <Alert showIcon title={error} type="error" />;
  }

  if (loading && !data) {
    return <Skeleton active />;
  }

  if (!loading && !data) {
    return <Empty description="暂无数据" />;
  }

  return <>{children}</>;
}

function MetricGrid({
  items
}: Readonly<{ items: Array<{ onClick?: () => void; title: string; value: string | number }> }>) {
  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))"
      }}
    >
      {items.map((item) => (
        <Card
          hoverable={Boolean(item.onClick)}
          key={item.title}
          role={item.onClick ? "button" : undefined}
          size="small"
          style={{ cursor: item.onClick ? "pointer" : "default" }}
          tabIndex={item.onClick ? 0 : undefined}
          onClick={item.onClick}
          onKeyDown={(event) => {
            if (item.onClick && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              item.onClick();
            }
          }}
        >
          <Statistic
            title={item.title}
            value={item.value}
            styles={{ content: { whiteSpace: "nowrap" } }}
          />
        </Card>
      ))}
    </div>
  );
}

function ReportTablesGrid({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div
      style={{
        display: "grid",
        gap: 16,
        gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))"
      }}
    >
      {children}
    </div>
  );
}
