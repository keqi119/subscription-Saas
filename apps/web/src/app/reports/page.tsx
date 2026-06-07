"use client";

import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Empty,
  Form,
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
  DEPOSIT_TRANSACTION_TYPE_LABELS,
  ORDER_STATUS_LABELS,
  labelOf
} from "../../constants/labels";
import { API_BASE_URL, ApiError, apiFetch } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";

const { RangePicker } = DatePicker;

type ReportKey = "summary" | "orders" | "finance" | "deposit" | "collections" | "assets";
type ExportReportKey = Exclude<ReportKey, "summary">;

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

interface OrderFilterValues {
  orderSource?: string;
  orderStatus?: string;
  vehicleModel?: string;
}

const defaultDateRange = (): [Dayjs, Dayjs] => [dayjs().subtract(29, "day"), dayjs()];

const reportLabels: Record<ReportKey, string> = {
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

async function downloadCsv(path: string, defaultFilename: string) {
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      credentials: "include"
    });
  } catch {
    throw new ApiError("无法连接 API 服务，请确认后端 3001 端口已启动。", 0);
  }

  if (!response.ok) {
    throw new ApiError(await readExportError(response), response.status);
  }

  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get("Content-Disposition")) ?? defaultFilename;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function readExportError(response: Response) {
  const contentType = response.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (Array.isArray(body.message)) {
        return body.message.join(", ");
      }
      if (body.message) {
        return body.message;
      }
    } catch {
      return "导出失败，请稍后重试";
    }
  }

  const text = await response.text();
  return text.trim() || "导出失败，请稍后重试";
}

function filenameFromDisposition(disposition: string | null) {
  if (!disposition) {
    return null;
  }

  const encodedMatch = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encodedMatch?.[1]) {
    return decodeURIComponent(encodedMatch[1].trim());
  }

  const quotedMatch = /filename="([^"]+)"/i.exec(disposition);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  const plainMatch = /filename=([^;]+)/i.exec(disposition);
  return plainMatch?.[1]?.trim() ?? null;
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
  })} 元`;
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

function safeText(value?: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" && value.trim() ? value : "-";
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

function metric(title: string, value: string | number) {
  return { title, value };
}

export default function ReportsPage() {
  const { message } = App.useApp();
  const [orderFilterForm] = Form.useForm<OrderFilterValues>();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [loadingMe, setLoadingMe] = useState(true);
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>(() => defaultDateRange());
  const [activeTab, setActiveTab] = useState<ReportKey>("summary");
  const [loading, setLoading] = useState<Record<ReportKey, boolean>>({
    assets: false,
    collections: false,
    deposit: false,
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
  const [errors, setErrors] = useState<Partial<Record<ReportKey, string>>>({});
  const [dashboardSummary, setDashboardSummary] = useState<DashboardSummaryReport | null>(null);
  const [orderReport, setOrderReport] = useState<OrderReport | null>(null);
  const [financeReport, setFinanceReport] = useState<FinanceReport | null>(null);
  const [depositReport, setDepositReport] = useState<DepositPoolReport | null>(null);
  const [collectionReport, setCollectionReport] = useState<CollectionReport | null>(null);
  const [vehicleAssetReport, setVehicleAssetReport] = useState<VehicleAssetReport | null>(null);
  const permissions = useMemo(() => new Set(me?.user.permissions ?? []), [me]);
  const canViewReports = permissions.has("report:view");
  const canViewFinanceReports = permissions.has("report:finance");
  const canViewCollectionReport = canViewFinanceReports || permissions.has("collection:view");
  const canViewAssetReport = permissions.has("report:asset");

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
    return keys;
  }, [canViewAssetReport, canViewCollectionReport, canViewFinanceReports, canViewReports]);

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

  const loadOrderReport = useCallback(async () => {
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
            ...orderFilterForm.getFieldsValue()
          })}`
        )
      );
    } catch (error) {
      setReportError("orders", getErrorMessage(error));
    } finally {
      setReportLoading("orders", false);
    }
  }, [canViewReports, dateRange, orderFilterForm, setReportError, setReportLoading]);

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

  const loadVisibleReports = useCallback(async () => {
    await Promise.all([
      loadDashboardSummary(),
      loadOrderReport(),
      loadFinanceReport(),
      loadDepositReport(),
      loadCollectionReport(),
      loadVehicleAssetReport()
    ]);
  }, [
    loadCollectionReport,
    loadDashboardSummary,
    loadDepositReport,
    loadFinanceReport,
    loadOrderReport,
    loadVehicleAssetReport
  ]);

  const exportReportCsv = useCallback(
    async (key: ExportReportKey) => {
      setExporting((current) => ({ ...current, [key]: true }));
      try {
        await downloadCsv(
          exportReportPath(key, dateRange, orderFilterForm.getFieldsValue()),
          exportDefaultFilename(key, dateRange)
        );
      } catch (error) {
        void message.error(getExportErrorMessage(error));
      } finally {
        setExporting((current) => ({ ...current, [key]: false }));
      }
    },
    [dateRange, message, orderFilterForm]
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

  const tabItems = visibleReportKeys.map((key) => ({
    children: renderReportTab(key),
    forceRender: key === "orders",
    key,
    label: reportLabels[key]
  }));

  function renderReportTab(key: ReportKey) {
    if (key === "summary") {
      return (
        <ReportPanel data={dashboardSummary} error={errors.summary} loading={loading.summary}>
          <MetricGrid
            items={[
              metric("订单总数", formatInteger(dashboardSummary?.totalOrders)),
              metric("新增订单数", formatInteger(dashboardSummary?.newOrders)),
              metric("在租订单数", formatInteger(dashboardSummary?.activeOrders)),
              metric("已完成订单数", formatInteger(dashboardSummary?.completedOrders)),
              metric("已取消订单数", formatInteger(dashboardSummary?.cancelledOrders)),
              metric("车辆总数", formatInteger(dashboardSummary?.totalVehicles)),
              metric("可租车辆数", formatInteger(dashboardSummary?.availableVehicles)),
              metric("审核占用车辆数", formatInteger(dashboardSummary?.reviewReservedVehicles)),
              metric("签约锁定车辆数", formatInteger(dashboardSummary?.signingLockedVehicles)),
              metric("在租车辆数", formatInteger(dashboardSummary?.leasedVehicles)),
              metric("维修中车辆数", formatInteger(dashboardSummary?.maintenanceVehicles)),
              metric("已退回车辆数", formatInteger(dashboardSummary?.returnedVehicles)),
              metric("总应收", formatYuan(dashboardSummary?.totalReceivableAmount)),
              metric("总实收", formatYuan(dashboardSummary?.totalPaidAmount)),
              metric("总欠收", formatYuan(dashboardSummary?.totalUnpaidAmount)),
              metric("押金余额", formatYuan(dashboardSummary?.depositBalanceAmount)),
              metric("逾期金额", formatYuan(dashboardSummary?.overdueAmount)),
              metric("逾期订单数", formatInteger(dashboardSummary?.overdueOrderCount)),
              metric("催收案件数", formatInteger(dashboardSummary?.collectionCaseCount))
            ]}
          />
        </ReportPanel>
      );
    }

    if (key === "orders") {
      return (
        <ReportPanel data={orderReport} error={errors.orders} loading={loading.orders}>
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <ExportButton loading={exporting.orders} onClick={() => void exportReportCsv("orders")} />
            <Form form={orderFilterForm} layout="inline" onFinish={loadOrderReport}>
              <Form.Item label="订单来源" name="orderSource">
                <Select allowClear options={optionsFromLabels(orderSourceLabels)} style={{ width: 150 }} />
              </Form.Item>
              <Form.Item label="订单状态" name="orderStatus">
                <Select allowClear options={optionsFromLabels(ORDER_STATUS_LABELS)} style={{ width: 170 }} />
              </Form.Item>
              <Form.Item label="车型" name="vehicleModel">
                <Select allowClear options={vehicleModelOptions} style={{ width: 120 }} />
              </Form.Item>
              <Form.Item>
                <Space>
                  <Button icon={<ReloadOutlined />} loading={loading.orders} onClick={loadOrderReport}>
                    查询
                  </Button>
                  <Button
                    onClick={() => {
                      orderFilterForm.resetFields();
                      void loadOrderReport();
                    }}
                  >
                    重置
                  </Button>
                </Space>
              </Form.Item>
            </Form>
            <MetricGrid items={[metric("订单总数", formatInteger(orderReport?.totalOrders))]} />
            <ReportTablesGrid>
              <Table
                columns={orderStatusColumns}
                dataSource={orderReport?.byStatus ?? []}
                loading={loading.orders}
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
                metric("总应收金额", formatYuan(financeReport?.totalReceivableAmount)),
                metric("总已收金额", formatYuan(financeReport?.totalPaidAmount)),
                metric("总未收金额", formatYuan(financeReport?.totalUnpaidAmount))
              ]}
            />
            <ReportTablesGrid>
              <Table
                columns={billTypeColumns}
                dataSource={financeReport?.byBillType ?? []}
                loading={loading.finance}
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
                metric("累计收取保证金", formatYuan(depositReport?.collectedAmount)),
                metric("累计扣减保证金", formatYuan(depositReport?.deductedAmount)),
                metric("累计退款保证金", formatYuan(depositReport?.refundedAmount)),
                metric("当前保证金余额", formatYuan(depositReport?.currentBalanceAmount)),
                metric("保证金交易笔数", formatInteger(depositReport?.transactionCount))
              ]}
            />
            <Table
              columns={depositTransactionColumns}
              dataSource={depositReport?.byTransactionType ?? []}
              loading={loading.deposit}
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
                metric("逾期账单数", formatInteger(collectionReport?.overdueBillCount)),
                metric("逾期金额", formatYuan(collectionReport?.overdueAmount)),
                metric("逾期订单数", formatInteger(collectionReport?.overdueOrderCount)),
                metric("催收案件数", formatInteger(collectionReport?.collectionCaseCount)),
                metric("催收中案件数", formatInteger(collectionReport?.activeCaseCount)),
                metric("已关闭案件数", formatInteger(collectionReport?.closedCaseCount)),
                metric("催收动作数量", formatInteger(collectionReport?.actionCount)),
                metric("承诺付款金额", formatYuan(collectionReport?.promisedPaymentAmount))
              ]}
            />
            <ReportTablesGrid>
              <Table
                columns={collectionLevelColumns}
                dataSource={collectionReport?.byCollectionLevel ?? []}
                loading={loading.collections}
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
              metric("车辆总数", formatInteger(vehicleAssetReport?.totalVehicles)),
              metric("可租车辆数", formatInteger(vehicleAssetReport?.availableVehicles)),
              metric("在租车辆数", formatInteger(vehicleAssetReport?.leasedVehicles)),
              metric("维修中车辆数", formatInteger(vehicleAssetReport?.maintenanceVehicles)),
              metric("已退回车辆数", formatInteger(vehicleAssetReport?.returnedVehicles)),
              metric("已售车辆数", formatInteger(vehicleAssetReport?.soldVehicles)),
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

function ExportButton({ loading, onClick }: Readonly<{ loading: boolean; onClick: () => void }>) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <Button icon={<DownloadOutlined />} loading={loading} onClick={onClick}>
        导出 CSV
      </Button>
    </div>
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

function MetricGrid({ items }: Readonly<{ items: Array<{ title: string; value: string | number }> }>) {
  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))"
      }}
    >
      {items.map((item) => (
        <Card key={item.title} size="small">
          <Statistic title={item.title} value={item.value} />
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
