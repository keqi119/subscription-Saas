"use client";

import { DownloadOutlined, EyeOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Select,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography
} from "antd";
import type { ColumnsType, TableProps } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { ProtectedShell } from "../../../components/protected-shell";
import {
  BILL_STATUS_LABELS,
  BILL_TYPE_LABELS,
  DELIVERY_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  SALE_PRICE_REVIEW_TYPE_LABELS,
  STATUS_LABELS,
  VEHICLE_ASSET_COST_PROFILE_STATUS_LABELS,
  VEHICLE_BATTERY_USAGE_TYPE_LABELS,
  VEHICLE_DAMAGE_LEVEL_LABELS,
  VEHICLE_DAMAGE_RESPONSIBLE_PARTY_LABELS,
  VEHICLE_DAMAGE_TYPE_LABELS,
  VEHICLE_DEPRECIATION_METHOD_LABELS,
  VEHICLE_RETURN_DAMAGE_STATUS_LABELS,
  VEHICLE_RETURN_STATUS_LABELS,
  VEHICLE_STATUS_LABELS,
  labelOf
} from "../../../constants/labels";
import { ApiError, apiFetch } from "../../../lib/api";
import type { AuthMeResponse } from "../../../lib/auth";
import { downloadCsv } from "../../../lib/csv-download";

const { RangePicker } = DatePicker;

const assetSortFields = [
  "rentalPaidAmount",
  "utilizationRate",
  "simpleReturnRate",
  "currentSalePriceAmount",
  "purchasePriceAmount",
  "leasedDays"
] as const;

type AssetSortField = (typeof assetSortFields)[number];
type BackendSortOrder = "asc" | "desc";

const assetReturnSortFields = [
  "trialRoa",
  "annualizedTrialRoa",
  "trialNetOperatingIncomeAmount",
  "operatingRevenueAmount",
  "operatingCostAmount",
  "rentalPaidAmount"
] as const;

type AssetReturnSortField = (typeof assetReturnSortFields)[number];

interface DateRangeResponse {
  endDate?: string | null;
  startDate?: string | null;
}

interface AssetProfitabilitySummary {
  averageSimpleReturnRate?: number | null;
  averageUtilizationRate?: number | null;
  damagePaidAmount?: number | null;
  dateRange?: DateRangeResponse;
  depositCollectedAmount?: number | null;
  rentalPaidAmount?: number | null;
  totalCurrentSalePriceAmount?: number | null;
  totalLeasedDays?: number | null;
  totalPaidAmount?: number | null;
  totalPurchasePriceAmount?: number | null;
  totalReceivableAmount?: number | null;
  totalRemainingAmount?: number | null;
  totalVehicles?: number | null;
}

interface PagedResult<TItem> {
  items: TItem[];
  page: number;
  pageSize: number;
  total: number;
}

interface AssetReturnTrialSummary {
  annualizedTrialRoa?: number | null;
  capitalCostAmount?: number | null;
  costCalculatedVehicleCount?: number | null;
  costUnavailableVehicleCount?: number | null;
  currentSalePriceAmount?: number | null;
  damagePaidAmount?: number | null;
  dateRange?: DateRangeResponse;
  depositCollectedAmount?: number | null;
  depreciationCostAmount?: number | null;
  insuranceCostAmount?: number | null;
  maintenanceReserveCostAmount?: number | null;
  operatingCostAmount?: number | null;
  operatingRevenueAmount?: number | null;
  otherCostAmount?: number | null;
  otherPaidAmount?: number | null;
  purchasePriceAmount?: number | null;
  rentalPaidAmount?: number | null;
  roeTrial?: number | null;
  roeUnavailableReason?: string | null;
  trialNetOperatingIncomeAmount?: number | null;
  trialRoa?: number | null;
  vehicleCount?: number | null;
  vehicleMissingCostProfileCount?: number | null;
  vehicleWithCostProfileCount?: number | null;
}

interface AssetProfitabilityVehicleRow {
  batteryCapacityKwh?: number | null;
  batteryUsageType?: string | null;
  brand?: string | null;
  currentCustomerName?: string | null;
  currentOrderNo?: string | null;
  currentSalePriceAmount?: number | null;
  damagePaidAmount?: number | null;
  depositCollectedAmount?: number | null;
  lastDeliveryAt?: string | null;
  lastReturnAt?: string | null;
  leasedDays?: number | null;
  model?: string | null;
  operatingDays?: number | null;
  plateNo?: string | null;
  purchasePriceAmount?: number | null;
  rentalPaidAmount?: number | null;
  series?: string | null;
  simpleReturnRate?: number | null;
  totalPaidAmount?: number | null;
  totalReceivableAmount?: number | null;
  totalRemainingAmount?: number | null;
  utilizationRate?: number | null;
  vehicleId: string;
  vehicleModel?: string | null;
  vehicleNo?: string | null;
  vehicleStatus?: string | null;
  vin?: string | null;
}

interface AssetReturnTrialVehicleRow extends AssetProfitabilityVehicleRow {
  annualizedTrialRoa?: number | null;
  capitalCostAmount?: number | null;
  costDays?: number | null;
  costProfileMissing?: boolean | null;
  costProfileStatus?: string | null;
  costUnavailableReason?: string | null;
  depreciationCostAmount?: number | null;
  insuranceCostAmount?: number | null;
  maintenanceReserveCostAmount?: number | null;
  manualDepreciationUnsupported?: boolean | null;
  operatingCostAmount?: number | null;
  operatingRevenueAmount?: number | null;
  otherCostAmount?: number | null;
  otherPaidAmount?: number | null;
  roeTrial?: number | null;
  roeUnavailableReason?: string | null;
  trialNetOperatingIncomeAmount?: number | null;
  trialRoa?: number | null;
}

interface AssetProfitabilityVehicleDetail {
  assetValue?: AssetValueInfo | null;
  bills?: BillDetailRow[];
  damageRecords?: DamageRecordRow[];
  dateRange?: DateRangeResponse;
  lifecycleNodes?: LifecycleNodeRow[];
  orderCycles?: OrderCycleRow[];
  salePriceHistory?: SalePriceHistoryRow[];
  summary?: VehicleSummaryInfo | null;
  vehicle?: VehicleBaseInfo | null;
}

interface AssetReturnTrialVehicleDetail {
  bills?: ReturnTrialBillRow[];
  costBreakdown?: ReturnTrialCostBreakdown | null;
  costPreview?: VehicleAssetCostPreview | null;
  costProfile?: VehicleAssetCostProfileInfo | null;
  dateRange?: DateRangeResponse;
  incomeBreakdown?: ReturnTrialIncomeBreakdown | null;
  orderCycles?: ReturnTrialOrderCycleRow[];
  returns?: ReturnTrialMetrics | null;
  vehicle?: ReturnTrialVehicleInfo | null;
}

interface VehicleBaseInfo {
  batteryCapacityKwh?: number | null;
  batteryUsageType?: string | null;
  brand?: string | null;
  model?: string | null;
  plateNo?: string | null;
  salePriceStatus?: string | null;
  series?: string | null;
  vehicleId?: string | null;
  vehicleModel?: string | null;
  vehicleNo?: string | null;
  vehicleStatus?: string | null;
  vin?: string | null;
}

interface ReturnTrialVehicleInfo extends VehicleBaseInfo {
  currentSalePriceAmount?: number | null;
  purchasePriceAmount?: number | null;
}

interface AssetValueInfo {
  currentSalePriceAmount?: number | null;
  currentSalePriceStatus?: string | null;
  purchasePriceAmount?: number | null;
}

interface VehicleSummaryInfo {
  damagePaidAmount?: number | null;
  depositCollectedAmount?: number | null;
  leasedDays?: number | null;
  operatingDays?: number | null;
  rentalPaidAmount?: number | null;
  simpleReturnRate?: number | null;
  totalPaidAmount?: number | null;
  totalReceivableAmount?: number | null;
  totalRemainingAmount?: number | null;
  utilizationRate?: number | null;
}

interface OrderCycleRow {
  customerName?: string | null;
  damagePaidAmount?: number | null;
  deliveredAt?: string | null;
  leasedDays?: number | null;
  monthlyFeeAmount?: number | null;
  orderId?: string | null;
  orderNo?: string | null;
  orderStatus?: string | null;
  rentalPaidAmount?: number | null;
  returnedAt?: string | null;
}

interface ReturnTrialOrderCycleRow extends OrderCycleRow {
  otherPaidAmount?: number | null;
}

interface BillDetailRow {
  amount?: number | null;
  billId?: string | null;
  billNo?: string | null;
  billStatus?: string | null;
  billType?: string | null;
  dueDate?: string | null;
  orderId?: string | null;
  orderNo?: string | null;
  paidAmount?: number | null;
  periodEnd?: string | null;
  periodStart?: string | null;
  remainingAmount?: number | null;
}

interface ReturnTrialBillRow extends BillDetailRow {
  includedInOperatingRevenue?: boolean | null;
}

interface VehicleAssetCostProfileInfo {
  annualInsuranceCostAmount?: number | null;
  annualMaintenanceReserveAmount?: number | null;
  capitalCostRateBps?: number | null;
  depreciationMethod?: string | null;
  depreciationStartDate?: string | null;
  id?: string | null;
  otherMonthlyCostAmount?: number | null;
  profileStatus?: string | null;
  remark?: string | null;
  residualValueAmount?: number | null;
  usefulLifeMonths?: number | null;
}

interface VehicleAssetCostPreview {
  annualCapitalCostAmount?: number | null;
  depreciableAmount?: number | null;
  estimatedMonthlyCostAmount?: number | null;
  monthlyCapitalCostAmount?: number | null;
  monthlyDepreciationAmount?: number | null;
  monthlyInsuranceCostAmount?: number | null;
  monthlyMaintenanceReserveAmount?: number | null;
  otherMonthlyCostAmount?: number | null;
  purchasePriceAmount?: number | null;
  residualValueAmount?: number | null;
}

interface ReturnTrialIncomeBreakdown {
  damagePaidAmount?: number | null;
  depositCollectedAmount?: number | null;
  depositIncludedInOperatingRevenue?: boolean | null;
  operatingRevenueAmount?: number | null;
  otherPaidAmount?: number | null;
  rentalPaidAmount?: number | null;
}

interface ReturnTrialCostBreakdown {
  capitalCostAmount?: number | null;
  costDays?: number | null;
  costProfileMissing?: boolean | null;
  costUnavailableReason?: string | null;
  depreciationCostAmount?: number | null;
  insuranceCostAmount?: number | null;
  maintenanceReserveCostAmount?: number | null;
  manualDepreciationUnsupported?: boolean | null;
  operatingCostAmount?: number | null;
  otherCostAmount?: number | null;
}

interface ReturnTrialMetrics {
  annualizedTrialRoa?: number | null;
  roeTrial?: number | null;
  roeUnavailableReason?: string | null;
  trialNetOperatingIncomeAmount?: number | null;
  trialRoa?: number | null;
}

interface LifecycleNodeRow {
  amount?: number | null;
  label?: string | null;
  occurredAt?: string | null;
  refId?: string | null;
  status?: string | null;
  type?: string | null;
}

interface DamageRecordRow {
  createdAt?: string | null;
  damageId?: string | null;
  damageLevel?: string | null;
  damageType?: string | null;
  description?: string | null;
  estimatedRepairAmount?: number | null;
  responsibleParty?: string | null;
  returnNo?: string | null;
  status?: string | null;
}

interface SalePriceHistoryRow {
  afterSalePriceAmount?: number | null;
  beforeSalePriceAmount?: number | null;
  createdAt?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  id?: string | null;
  reason?: string | null;
  remark?: string | null;
  reviewQuarter?: string | null;
  reviewType?: string | null;
}

const vehicleModelOptions = ["ET5", "ET7", "ES6"].map((value) => ({ label: value, value }));
const vehicleStatusFilterOptions = [
  "AVAILABLE",
  "REVIEW_RESERVED",
  "RESERVED",
  "LEASED",
  "RENTED",
  "RETURNED",
  "MAINTENANCE",
  "RETIRED",
  "DRAFT",
  "IN_PREPARATION"
].map((value) => ({ label: labelOf(VEHICLE_STATUS_LABELS, value), value }));

const vehicleStatusColors: Record<string, string> = {
  AVAILABLE: "green",
  DRAFT: "default",
  IN_PREPARATION: "cyan",
  LEASED: "blue",
  MAINTENANCE: "red",
  RENTED: "blue",
  RESERVED: "orange",
  RETIRED: "default",
  RETURNED: "purple",
  REVIEW_RESERVED: "gold",
  SOLD: "default"
};

const lifecycleNodeLabels: Record<string, string> = {
  DELIVERY: "交付",
  INITIAL_POOL: "首次入池",
  RETURN: "退车",
  RETURN_REINIT: "再入池",
  SALE_PRICE_REVIEW: "重新定价"
};

const defaultDateRange = (): [Dayjs, Dayjs] => [dayjs().subtract(29, "day"), dayjs()];

function exportDefaultFilename(kind: "detail" | "summary" | "vehicles", dateRange: [Dayjs, Dayjs]) {
  const prefixByKind = {
    detail: "asset-profitability-vehicle-detail",
    summary: "asset-profitability-summary",
    vehicles: "asset-profitability-vehicles"
  };
  const startDate = dateRange[0].format("YYYYMMDD");
  const endDate = dateRange[1].format("YYYYMMDD");

  return `${prefixByKind[kind]}-${startDate}-${endDate}.csv`;
}

export default function AssetProfitabilityPage() {
  const { message } = App.useApp();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>(defaultDateRange);
  const [vehicleModel, setVehicleModel] = useState<string | undefined>();
  const [vehicleStatus, setVehicleStatus] = useState<string | undefined>();
  const [summary, setSummary] = useState<AssetProfitabilitySummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [vehiclePage, setVehiclePage] = useState<PagedResult<AssetProfitabilityVehicleRow>>({
    items: [],
    page: 1,
    pageSize: 20,
    total: 0
  });
  const [vehicleError, setVehicleError] = useState<string | null>(null);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState<AssetSortField | undefined>();
  const [sortOrder, setSortOrder] = useState<BackendSortOrder | undefined>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedVehicle, setSelectedVehicle] = useState<AssetProfitabilityVehicleRow | null>(null);
  const [detail, setDetail] = useState<AssetProfitabilityVehicleDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [summaryExporting, setSummaryExporting] = useState(false);
  const [vehiclesExporting, setVehiclesExporting] = useState(false);
  const [detailExporting, setDetailExporting] = useState(false);
  const [activeTab, setActiveTab] = useState<"asset" | "returns">("asset");
  const [returnSummary, setReturnSummary] = useState<AssetReturnTrialSummary | null>(null);
  const [returnSummaryError, setReturnSummaryError] = useState<string | null>(null);
  const [returnSummaryLoading, setReturnSummaryLoading] = useState(false);
  const [returnVehiclePage, setReturnVehiclePage] = useState<PagedResult<AssetReturnTrialVehicleRow>>({
    items: [],
    page: 1,
    pageSize: 20,
    total: 0
  });
  const [returnVehicleError, setReturnVehicleError] = useState<string | null>(null);
  const [returnVehiclesLoading, setReturnVehiclesLoading] = useState(false);
  const [returnPage, setReturnPage] = useState(1);
  const [returnPageSize, setReturnPageSize] = useState(20);
  const [returnSortBy, setReturnSortBy] = useState<AssetReturnSortField | undefined>();
  const [returnSortOrder, setReturnSortOrder] = useState<BackendSortOrder | undefined>();
  const [returnDetailOpen, setReturnDetailOpen] = useState(false);
  const [selectedReturnVehicle, setSelectedReturnVehicle] =
    useState<AssetReturnTrialVehicleRow | null>(null);
  const [returnDetail, setReturnDetail] = useState<AssetReturnTrialVehicleDetail | null>(null);
  const [returnDetailError, setReturnDetailError] = useState<string | null>(null);
  const [returnDetailLoading, setReturnDetailLoading] = useState(false);

  const permissions = useMemo(() => new Set(me?.user.permissions ?? []), [me?.user.permissions]);
  const canViewAssetReport = permissions.has("report:asset");

  useEffect(() => {
    apiFetch<AuthMeResponse>("/auth/me")
      .then(setMe)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          return;
        }
        void message.error(normalizeErrorMessage(error));
      })
      .finally(() => setAuthLoading(false));
  }, [message]);

  const baseQuery = useCallback(() => {
    return {
      endDate: dateRange[1].format("YYYY-MM-DD"),
      startDate: dateRange[0].format("YYYY-MM-DD"),
      vehicleModel,
      vehicleStatus
    };
  }, [dateRange, vehicleModel, vehicleStatus]);

  const loadSummary = useCallback(async () => {
    if (!canViewAssetReport) {
      return;
    }

    setSummaryError(null);
    setSummaryLoading(true);
    try {
      setSummary(
        await apiFetch<AssetProfitabilitySummary>(
          `/reports/asset-profitability/summary${buildQuery(baseQuery())}`
        )
      );
    } catch (error) {
      setSummaryError(normalizeErrorMessage(error));
    } finally {
      setSummaryLoading(false);
    }
  }, [baseQuery, canViewAssetReport]);

  const loadVehicles = useCallback(async () => {
    if (!canViewAssetReport) {
      return;
    }

    setVehicleError(null);
    setVehiclesLoading(true);
    try {
      setVehiclePage(
        await apiFetch<PagedResult<AssetProfitabilityVehicleRow>>(
          `/reports/asset-profitability/vehicles${buildQuery({
            ...baseQuery(),
            page,
            pageSize,
            sortBy,
            sortOrder
          })}`
        )
      );
    } catch (error) {
      setVehicleError(normalizeErrorMessage(error));
    } finally {
      setVehiclesLoading(false);
    }
  }, [baseQuery, canViewAssetReport, page, pageSize, sortBy, sortOrder]);

  const loadReturnSummary = useCallback(async () => {
    if (!canViewAssetReport) {
      return;
    }

    setReturnSummaryError(null);
    setReturnSummaryLoading(true);
    try {
      setReturnSummary(
        await apiFetch<AssetReturnTrialSummary>(
          `/reports/asset-profitability/returns/summary${buildQuery(baseQuery())}`
        )
      );
    } catch (error) {
      setReturnSummaryError(normalizeErrorMessage(error));
    } finally {
      setReturnSummaryLoading(false);
    }
  }, [baseQuery, canViewAssetReport]);

  const loadReturnVehicles = useCallback(async () => {
    if (!canViewAssetReport) {
      return;
    }

    setReturnVehicleError(null);
    setReturnVehiclesLoading(true);
    try {
      setReturnVehiclePage(
        await apiFetch<PagedResult<AssetReturnTrialVehicleRow>>(
          `/reports/asset-profitability/returns/vehicles${buildQuery({
            ...baseQuery(),
            page: returnPage,
            pageSize: returnPageSize,
            sortBy: returnSortBy,
            sortOrder: returnSortOrder
          })}`
        )
      );
    } catch (error) {
      setReturnVehicleError(normalizeErrorMessage(error));
    } finally {
      setReturnVehiclesLoading(false);
    }
  }, [
    baseQuery,
    canViewAssetReport,
    returnPage,
    returnPageSize,
    returnSortBy,
    returnSortOrder
  ]);

  useEffect(() => {
    if (authLoading || !canViewAssetReport) {
      return;
    }

    void loadSummary();
    void loadVehicles();
  }, [authLoading, canViewAssetReport, loadSummary, loadVehicles]);

  useEffect(() => {
    if (authLoading || !canViewAssetReport || activeTab !== "returns") {
      return;
    }

    void loadReturnSummary();
    void loadReturnVehicles();
  }, [
    activeTab,
    authLoading,
    canViewAssetReport,
    loadReturnSummary,
    loadReturnVehicles
  ]);

  const refresh = useCallback(async () => {
    if (activeTab === "returns") {
      await Promise.all([loadReturnSummary(), loadReturnVehicles()]);
      return;
    }

    await Promise.all([loadSummary(), loadVehicles()]);
  }, [activeTab, loadReturnSummary, loadReturnVehicles, loadSummary, loadVehicles]);

  const exportSummaryCsv = useCallback(async () => {
    if (!canViewAssetReport) {
      return;
    }

    setSummaryExporting(true);
    try {
      await downloadCsv(
        `/reports/asset-profitability/summary/export${buildQuery(baseQuery())}`,
        exportDefaultFilename("summary", dateRange)
      );
    } catch (error) {
      void message.error(normalizeErrorMessage(error));
    } finally {
      setSummaryExporting(false);
    }
  }, [baseQuery, canViewAssetReport, dateRange, message]);

  const exportVehiclesCsv = useCallback(async () => {
    if (!canViewAssetReport) {
      return;
    }

    setVehiclesExporting(true);
    try {
      await downloadCsv(
        `/reports/asset-profitability/vehicles/export${buildQuery({
          ...baseQuery(),
          sortBy,
          sortOrder
        })}`,
        exportDefaultFilename("vehicles", dateRange)
      );
    } catch (error) {
      void message.error(normalizeErrorMessage(error));
    } finally {
      setVehiclesExporting(false);
    }
  }, [baseQuery, canViewAssetReport, dateRange, message, sortBy, sortOrder]);

  const exportVehicleDetailCsv = useCallback(async () => {
    if (!canViewAssetReport || !selectedVehicle) {
      return;
    }

    setDetailExporting(true);
    try {
      await downloadCsv(
        `/reports/asset-profitability/vehicles/${selectedVehicle.vehicleId}/export${buildQuery({
          endDate: dateRange[1].format("YYYY-MM-DD"),
          startDate: dateRange[0].format("YYYY-MM-DD")
        })}`,
        exportDefaultFilename("detail", dateRange)
      );
    } catch (error) {
      void message.error(normalizeErrorMessage(error));
    } finally {
      setDetailExporting(false);
    }
  }, [canViewAssetReport, dateRange, message, selectedVehicle]);

  const openDetail = useCallback(async (record: AssetProfitabilityVehicleRow) => {
    if (!canViewAssetReport) {
      return;
    }

    setSelectedVehicle(record);
    setDetail(null);
    setDetailError(null);
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      setDetail(
        await apiFetch<AssetProfitabilityVehicleDetail>(
          `/reports/asset-profitability/vehicles/${record.vehicleId}${buildQuery({
            endDate: dateRange[1].format("YYYY-MM-DD"),
            startDate: dateRange[0].format("YYYY-MM-DD")
          })}`
        )
      );
    } catch (error) {
      setDetailError(normalizeErrorMessage(error));
    } finally {
      setDetailLoading(false);
    }
  }, [canViewAssetReport, dateRange]);

  const openReturnDetail = useCallback(async (record: AssetReturnTrialVehicleRow) => {
    if (!canViewAssetReport) {
      return;
    }

    setSelectedReturnVehicle(record);
    setReturnDetail(null);
    setReturnDetailError(null);
    setReturnDetailOpen(true);
    setReturnDetailLoading(true);
    try {
      setReturnDetail(
        await apiFetch<AssetReturnTrialVehicleDetail>(
          `/reports/asset-profitability/returns/vehicles/${record.vehicleId}${buildQuery({
            endDate: dateRange[1].format("YYYY-MM-DD"),
            startDate: dateRange[0].format("YYYY-MM-DD")
          })}`
        )
      );
    } catch (error) {
      setReturnDetailError(normalizeErrorMessage(error));
    } finally {
      setReturnDetailLoading(false);
    }
  }, [canViewAssetReport, dateRange]);

  const handleTableChange: TableProps<AssetProfitabilityVehicleRow>["onChange"] = (
    nextPagination,
    _filters,
    sorter
  ) => {
    setPage(nextPagination.current ?? 1);
    setPageSize(nextPagination.pageSize ?? 20);

    const sortResult = Array.isArray(sorter) ? sorter[0] : sorter;
    const field = sortResult?.field;
    if (sortResult?.order && typeof field === "string" && isAssetSortField(field)) {
      setSortBy(field);
      setSortOrder(sortResult.order === "ascend" ? "asc" : "desc");
      return;
    }

    setSortBy(undefined);
    setSortOrder(undefined);
  };

  const handleReturnTableChange: TableProps<AssetReturnTrialVehicleRow>["onChange"] = (
    nextPagination,
    _filters,
    sorter
  ) => {
    setReturnPage(nextPagination.current ?? 1);
    setReturnPageSize(nextPagination.pageSize ?? 20);

    const sortResult = Array.isArray(sorter) ? sorter[0] : sorter;
    const field = sortResult?.field;
    if (sortResult?.order && typeof field === "string" && isAssetReturnSortField(field)) {
      setReturnSortBy(field);
      setReturnSortOrder(sortResult.order === "ascend" ? "asc" : "desc");
      return;
    }

    setReturnSortBy(undefined);
    setReturnSortOrder(undefined);
  };

  const columns = useMemo<ColumnsType<AssetProfitabilityVehicleRow>>(
    () => [
      { dataIndex: "vehicleNo", fixed: "left", render: safeText, title: "车辆编号", width: 130 },
      { dataIndex: "vin", render: safeText, title: "VIN", width: 180 },
      { dataIndex: "plateNo", render: safeText, title: "车牌号", width: 110 },
      { dataIndex: "brand", render: safeText, title: "品牌", width: 100 },
      { dataIndex: "series", render: safeText, title: "车系", width: 110 },
      { dataIndex: "vehicleModel", render: safeText, title: "车型", width: 90 },
      {
        dataIndex: "vehicleStatus",
        render: renderVehicleStatus,
        title: "车辆状态",
        width: 120
      },
      { dataIndex: "batteryCapacityKwh", render: formatKwh, title: "电池容量", width: 110 },
      {
        dataIndex: "batteryUsageType",
        render: (value?: string | null) => labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, value),
        title: "电池使用方式",
        width: 130
      },
      {
        dataIndex: "purchasePriceAmount",
        render: formatYuan,
        sortOrder: sortOrderFor("purchasePriceAmount", sortBy, sortOrder),
        sorter: true,
        title: "采购价",
        width: 130
      },
      {
        dataIndex: "currentSalePriceAmount",
        render: formatYuan,
        sortOrder: sortOrderFor("currentSalePriceAmount", sortBy, sortOrder),
        sorter: true,
        title: "当前销售价",
        width: 140
      },
      {
        dataIndex: "rentalPaidAmount",
        render: formatYuan,
        sortOrder: sortOrderFor("rentalPaidAmount", sortBy, sortOrder),
        sorter: true,
        title: "租金实收",
        width: 130
      },
      { dataIndex: "damagePaidAmount", render: formatYuan, title: "损伤实收", width: 130 },
      { dataIndex: "depositCollectedAmount", render: formatYuan, title: "押金收取", width: 130 },
      { dataIndex: "totalReceivableAmount", render: formatYuan, title: "总应收", width: 130 },
      { dataIndex: "totalPaidAmount", render: formatYuan, title: "总已收", width: 130 },
      { dataIndex: "totalRemainingAmount", render: formatYuan, title: "总未收", width: 130 },
      {
        dataIndex: "leasedDays",
        render: formatInteger,
        sortOrder: sortOrderFor("leasedDays", sortBy, sortOrder),
        sorter: true,
        title: "出租天数",
        width: 110
      },
      { dataIndex: "operatingDays", render: formatInteger, title: "可运营天数", width: 120 },
      {
        dataIndex: "utilizationRate",
        render: formatPercent,
        sortOrder: sortOrderFor("utilizationRate", sortBy, sortOrder),
        sorter: true,
        title: "出租率",
        width: 110
      },
      {
        dataIndex: "simpleReturnRate",
        render: formatPercent,
        sortOrder: sortOrderFor("simpleReturnRate", sortBy, sortOrder),
        sorter: true,
        title: "简化经营回报率",
        width: 150
      },
      { dataIndex: "currentOrderNo", render: safeText, title: "当前订单", width: 150 },
      { dataIndex: "currentCustomerName", render: safeText, title: "当前客户", width: 130 },
      { dataIndex: "lastDeliveryAt", render: formatDateTime, title: "最近交付时间", width: 170 },
      { dataIndex: "lastReturnAt", render: formatDateTime, title: "最近退车时间", width: 170 },
      {
        fixed: "right",
        render: (_value, record) => (
          <Button icon={<EyeOutlined />} onClick={() => void openDetail(record)} size="small" type="link">
            查看详情
          </Button>
        ),
        title: "操作",
        width: 110
      }
    ],
    [openDetail, sortBy, sortOrder]
  );

  const returnColumns = useMemo<ColumnsType<AssetReturnTrialVehicleRow>>(
    () => [
      { dataIndex: "vehicleNo", fixed: "left", render: safeText, title: "车辆编号", width: 130 },
      { dataIndex: "vin", render: safeText, title: "VIN", width: 180 },
      { dataIndex: "plateNo", render: safeText, title: "车牌号", width: 110 },
      { dataIndex: "vehicleModel", render: safeText, title: "车型", width: 90 },
      {
        dataIndex: "vehicleStatus",
        render: renderVehicleStatus,
        title: "车辆状态",
        width: 120
      },
      { dataIndex: "purchasePriceAmount", render: formatYuan, title: "采购价", width: 130 },
      { dataIndex: "currentSalePriceAmount", render: formatYuan, title: "当前销售价", width: 140 },
      {
        dataIndex: "rentalPaidAmount",
        render: formatYuan,
        sortOrder: sortOrderForReturn("rentalPaidAmount", returnSortBy, returnSortOrder),
        sorter: true,
        title: "租金实收",
        width: 130
      },
      { dataIndex: "damagePaidAmount", render: formatYuan, title: "损伤实收", width: 130 },
      { dataIndex: "otherPaidAmount", render: formatYuan, title: "其他实收", width: 130 },
      {
        dataIndex: "operatingRevenueAmount",
        render: formatYuan,
        sortOrder: sortOrderForReturn("operatingRevenueAmount", returnSortBy, returnSortOrder),
        sorter: true,
        title: "经营收入",
        width: 130
      },
      { dataIndex: "depositCollectedAmount", render: formatYuan, title: "押金收取", width: 130 },
      { dataIndex: "depreciationCostAmount", render: formatYuan, title: "折旧成本", width: 130 },
      { dataIndex: "capitalCostAmount", render: formatYuan, title: "资金成本", width: 130 },
      { dataIndex: "insuranceCostAmount", render: formatYuan, title: "保险成本", width: 130 },
      { dataIndex: "maintenanceReserveCostAmount", render: formatYuan, title: "维修准备金", width: 140 },
      { dataIndex: "otherCostAmount", render: formatYuan, title: "其他成本", width: 130 },
      {
        dataIndex: "operatingCostAmount",
        render: formatYuan,
        sortOrder: sortOrderForReturn("operatingCostAmount", returnSortBy, returnSortOrder),
        sorter: true,
        title: "经营成本",
        width: 130
      },
      {
        dataIndex: "trialNetOperatingIncomeAmount",
        render: formatYuan,
        sortOrder: sortOrderForReturn("trialNetOperatingIncomeAmount", returnSortBy, returnSortOrder),
        sorter: true,
        title: "试算经营净收益",
        width: 150
      },
      {
        dataIndex: "trialRoa",
        render: formatPercent,
        sortOrder: sortOrderForReturn("trialRoa", returnSortBy, returnSortOrder),
        sorter: true,
        title: "试算 ROA",
        width: 120
      },
      {
        dataIndex: "annualizedTrialRoa",
        render: formatPercent,
        sortOrder: sortOrderForReturn("annualizedTrialRoa", returnSortBy, returnSortOrder),
        sorter: true,
        title: "年化试算 ROA",
        width: 140
      },
      {
        render: (_value, record) => renderCostProfileStatus(record),
        title: "成本参数状态",
        width: 170
      },
      {
        render: (_value, record) => renderCostUnavailableReason(record),
        title: "不可计算原因",
        width: 240
      },
      {
        fixed: "right",
        render: (_value, record) => (
          <Button icon={<EyeOutlined />} onClick={() => void openReturnDetail(record)} size="small" type="link">
            查看收益详情
          </Button>
        ),
        title: "操作",
        width: 130
      }
    ],
    [openReturnDetail, returnSortBy, returnSortOrder]
  );

  const content = authLoading ? (
    <Skeleton active />
  ) : !canViewAssetReport ? (
    <Alert showIcon title="无权限查看资产经营分析" type="warning" />
  ) : (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <FilterBar
        dateRange={dateRange}
        loading={
          activeTab === "returns"
            ? returnSummaryLoading || returnVehiclesLoading
            : summaryLoading || vehiclesLoading
        }
        onExportSummary={() => void exportSummaryCsv()}
        onExportVehicles={() => void exportVehiclesCsv()}
        onDateRangeChange={(nextRange) => {
          setDateRange(nextRange);
          setPage(1);
          setReturnPage(1);
        }}
        onRefresh={() => void refresh()}
        onVehicleModelChange={(value) => {
          setVehicleModel(value);
          setPage(1);
          setReturnPage(1);
        }}
        onVehicleStatusChange={(value) => {
          setVehicleStatus(value);
          setPage(1);
          setReturnPage(1);
        }}
        summaryExporting={summaryExporting}
        vehicleModel={vehicleModel}
        vehiclesExporting={vehiclesExporting}
        vehicleStatus={vehicleStatus}
      />
      <Tabs
        activeKey={activeTab}
        items={[
          {
            children: (
              <Space orientation="vertical" size={16} style={{ width: "100%" }}>
                <Alert
                  title="口径说明"
                  showIcon
                  type="info"
                  description="租金实收仅统计 FIRST_MONTHLY_FEE 和 MONTHLY_RENT 的 paidAmount；损伤费用单独列示；押金收取单独列示，不计入租金收入；简化经营回报率 = 租金实收 / 车辆采购价，不是会计 ROA / ROE。ROA / ROE 后续需要引入折旧、资金成本、残值和费用模型。"
                />
                {summaryError ? <Alert showIcon title={summaryError} type="error" /> : null}
                <SummaryMetrics loading={summaryLoading} summary={summary} />
                {vehicleError ? <Alert showIcon title={vehicleError} type="error" /> : null}
                <Card title="单车经营列表">
                  <Table
                    columns={columns}
                    dataSource={vehiclePage.items}
                    loading={vehiclesLoading}
                    locale={{ emptyText: "暂无数据" }}
                    onChange={handleTableChange}
                    pagination={{
                      current: vehiclePage.page,
                      pageSize: vehiclePage.pageSize,
                      showSizeChanger: true,
                      showTotal: (total) => `共 ${total.toLocaleString("zh-CN")} 台车`,
                      total: vehiclePage.total
                    }}
                    rowKey="vehicleId"
                    scroll={{ x: 3100 }}
                  />
                </Card>
              </Space>
            ),
            key: "asset",
            label: "资产经营"
          },
          {
            children: (
              <Space orientation="vertical" size={16} style={{ width: "100%" }}>
                <Alert
                  title="收益试算口径"
                  showIcon
                  type="info"
                  description="本页为经营分析试算口径，不构成会计凭证或正式财务报表。试算 ROA = 试算经营净收益 / 车辆采购价；年化试算 ROA 基于查询天数折算；押金不计入经营收入；ROE 当前缺少债务 / 自有资本拆分模型，暂不输出正式值。"
                />
                {returnSummaryError ? (
                  <Alert showIcon title={returnSummaryError} type="error" />
                ) : null}
                <ReturnTrialSummaryMetrics loading={returnSummaryLoading} summary={returnSummary} />
                {returnVehicleError ? (
                  <Alert showIcon title={returnVehicleError} type="error" />
                ) : null}
                <Card title="单车收益试算列表">
                  <Table
                    columns={returnColumns}
                    dataSource={returnVehiclePage.items}
                    loading={returnVehiclesLoading}
                    locale={{ emptyText: "暂无数据" }}
                    onChange={handleReturnTableChange}
                    pagination={{
                      current: returnVehiclePage.page,
                      pageSize: returnVehiclePage.pageSize,
                      showSizeChanger: true,
                      showTotal: (total) => `共 ${total.toLocaleString("zh-CN")} 台车`,
                      total: returnVehiclePage.total
                    }}
                    rowKey="vehicleId"
                    scroll={{ x: 3600 }}
                  />
                </Card>
              </Space>
            ),
            key: "returns",
            label: "收益试算"
          }
        ]}
        onChange={(key) => setActiveTab(key === "returns" ? "returns" : "asset")}
      />
    </Space>
  );

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space align="start" style={{ justifyContent: "space-between", width: "100%" }}>
          <div>
            <Typography.Title level={3} style={{ marginBottom: 4 }}>
              资产经营分析
            </Typography.Title>
            <Typography.Text type="secondary">
              从车辆资产维度查看投入成本、估值、出租利用和回款质量
            </Typography.Text>
          </div>
        </Space>
        {content}
      </Space>

      <Drawer
        destroyOnClose
        extra={
          selectedVehicle ? (
            <Button
              icon={<DownloadOutlined />}
              loading={detailExporting}
              onClick={() => void exportVehicleDetailCsv()}
            >
              导出单车详情 CSV
            </Button>
          ) : null
        }
        onClose={() => setDetailOpen(false)}
        open={detailOpen}
        size="min(960px, calc(100vw - 32px))"
        title={`${safeText(selectedVehicle?.vehicleNo)} 单车经营详情`}
      >
        <VehicleDetailContent detail={detail} error={detailError} loading={detailLoading} />
      </Drawer>

      <Drawer
        destroyOnClose
        onClose={() => setReturnDetailOpen(false)}
        open={returnDetailOpen}
        size="min(1120px, calc(100vw - 32px))"
        title={`${safeText(selectedReturnVehicle?.vehicleNo)} 单车收益试算详情`}
      >
        <ReturnTrialDetailContent
          detail={returnDetail}
          error={returnDetailError}
          loading={returnDetailLoading}
        />
      </Drawer>
    </ProtectedShell>
  );
}

function FilterBar({
  dateRange,
  loading,
  onExportSummary,
  onExportVehicles,
  onDateRangeChange,
  onRefresh,
  onVehicleModelChange,
  onVehicleStatusChange,
  summaryExporting,
  vehicleModel,
  vehiclesExporting,
  vehicleStatus
}: {
  dateRange: [Dayjs, Dayjs];
  loading: boolean;
  onExportSummary: () => void;
  onExportVehicles: () => void;
  onDateRangeChange: (value: [Dayjs, Dayjs]) => void;
  onRefresh: () => void;
  onVehicleModelChange: (value?: string) => void;
  onVehicleStatusChange: (value?: string) => void;
  summaryExporting: boolean;
  vehicleModel?: string;
  vehiclesExporting: boolean;
  vehicleStatus?: string;
}) {
  return (
    <Card>
      <Space align="end" size={16} wrap>
        <Space orientation="vertical" size={4}>
          <Typography.Text type="secondary">日期范围</Typography.Text>
          <RangePicker
            allowClear={false}
            onChange={(value) => {
              if (value?.[0] && value[1]) {
                onDateRangeChange([value[0], value[1]]);
              }
            }}
            value={dateRange}
          />
        </Space>
        <Space orientation="vertical" size={4}>
          <Typography.Text type="secondary">车型</Typography.Text>
          <Select
            allowClear
            onChange={onVehicleModelChange}
            options={vehicleModelOptions}
            placeholder="全部车型"
            style={{ width: 140 }}
            value={vehicleModel}
          />
        </Space>
        <Space orientation="vertical" size={4}>
          <Typography.Text type="secondary">车辆状态</Typography.Text>
          <Select
            allowClear
            onChange={onVehicleStatusChange}
            options={vehicleStatusFilterOptions}
            placeholder="全部状态"
            style={{ width: 160 }}
            value={vehicleStatus}
          />
        </Space>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>
          刷新
        </Button>
        <Button icon={<DownloadOutlined />} loading={summaryExporting} onClick={onExportSummary}>
          导出汇总 CSV
        </Button>
        <Button icon={<DownloadOutlined />} loading={vehiclesExporting} onClick={onExportVehicles}>
          导出车辆列表 CSV
        </Button>
      </Space>
    </Card>
  );
}

function SummaryMetrics({
  loading,
  summary
}: {
  loading: boolean;
  summary: AssetProfitabilitySummary | null;
}) {
  const items = [
    { title: "车辆总数", value: formatInteger(summary?.totalVehicles) },
    { title: "采购成本合计", value: formatYuan(summary?.totalPurchasePriceAmount) },
    { title: "当前销售价合计", value: formatYuan(summary?.totalCurrentSalePriceAmount) },
    { title: "租金实收合计", value: formatYuan(summary?.rentalPaidAmount) },
    { title: "损伤费用实收合计", value: formatYuan(summary?.damagePaidAmount) },
    { title: "押金收取合计", value: formatYuan(summary?.depositCollectedAmount) },
    { title: "应收合计", value: formatYuan(summary?.totalReceivableAmount) },
    { title: "未收合计", value: formatYuan(summary?.totalRemainingAmount) },
    { title: "总出租天数", value: formatInteger(summary?.totalLeasedDays) },
    { title: "平均出租率", value: formatPercent(summary?.averageUtilizationRate) },
    { title: "平均简化回报率", value: formatPercent(summary?.averageSimpleReturnRate) }
  ];

  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))"
      }}
    >
      {items.map((item) => (
        <Card key={item.title} loading={loading} size="small">
          <Statistic title={item.title} value={item.value} styles={{ content: { fontSize: 20 } }} />
        </Card>
      ))}
    </div>
  );
}

function ReturnTrialSummaryMetrics({
  loading,
  summary
}: {
  loading: boolean;
  summary: AssetReturnTrialSummary | null;
}) {
  const items = [
    { title: "车辆总数", value: formatInteger(summary?.vehicleCount) },
    { title: "已有成本参数车辆数", value: formatInteger(summary?.vehicleWithCostProfileCount) },
    { title: "缺少成本参数车辆数", value: formatInteger(summary?.vehicleMissingCostProfileCount) },
    { title: "成本可计算车辆数", value: formatInteger(summary?.costCalculatedVehicleCount) },
    { title: "成本不可计算车辆数", value: formatInteger(summary?.costUnavailableVehicleCount) },
    { title: "采购价合计", value: formatYuan(summary?.purchasePriceAmount) },
    { title: "当前销售价合计", value: formatYuan(summary?.currentSalePriceAmount) },
    { title: "租金实收", value: formatYuan(summary?.rentalPaidAmount) },
    { title: "损伤实收", value: formatYuan(summary?.damagePaidAmount) },
    { title: "其他实收", value: formatYuan(summary?.otherPaidAmount) },
    { title: "经营收入合计", value: formatYuan(summary?.operatingRevenueAmount) },
    { title: "押金收取", value: formatYuan(summary?.depositCollectedAmount) },
    { title: "折旧成本", value: formatYuan(summary?.depreciationCostAmount) },
    { title: "资金成本", value: formatYuan(summary?.capitalCostAmount) },
    { title: "保险成本", value: formatYuan(summary?.insuranceCostAmount) },
    { title: "维修准备金", value: formatYuan(summary?.maintenanceReserveCostAmount) },
    { title: "其他成本", value: formatYuan(summary?.otherCostAmount) },
    { title: "经营成本合计", value: formatYuan(summary?.operatingCostAmount) },
    { title: "试算经营净收益", value: formatYuan(summary?.trialNetOperatingIncomeAmount) },
    { title: "试算 ROA", value: formatPercent(summary?.trialRoa) },
    { title: "年化试算 ROA", value: formatPercent(summary?.annualizedTrialRoa) }
  ];

  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))"
      }}
    >
      {items.map((item) => (
        <Card key={item.title} loading={loading} size="small">
          <Statistic title={item.title} value={item.value} styles={{ content: { fontSize: 20 } }} />
        </Card>
      ))}
      <Card loading={loading} size="small">
        <Statistic title="ROE" value="暂不可用" styles={{ content: { fontSize: 20 } }} />
        <Typography.Text type="secondary">
          {safeText(summary?.roeUnavailableReason)}
        </Typography.Text>
      </Card>
    </div>
  );
}

function VehicleDetailContent({
  detail,
  error,
  loading
}: {
  detail: AssetProfitabilityVehicleDetail | null;
  error: string | null;
  loading: boolean;
}) {
  if (loading) {
    return <Skeleton active />;
  }

  if (error) {
    return <Alert showIcon title={error} type="error" />;
  }

  if (!detail) {
    return <Alert showIcon title="暂无数据" type="info" />;
  }

  const latestSalePriceHistory = latestByDate(detail.salePriceHistory ?? [], (item) => item.createdAt);
  const assetValue = detail.assetValue ?? {};
  const vehicle = detail.vehicle ?? {};
  const summary = detail.summary ?? {};

  return (
    <Space orientation="vertical" size={18} style={{ width: "100%" }}>
      <DetailSection title="车辆基础信息">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "车辆编号", children: safeText(vehicle.vehicleNo) },
            { label: "VIN", children: safeText(vehicle.vin) },
            { label: "车牌号", children: safeText(vehicle.plateNo) },
            { label: "品牌", children: safeText(vehicle.brand) },
            { label: "车系", children: safeText(vehicle.series) },
            { label: "车型", children: safeText(vehicle.vehicleModel ?? vehicle.model) },
            { label: "电池容量", children: formatKwh(vehicle.batteryCapacityKwh) },
            {
              label: "电池使用方式",
              children: labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, vehicle.batteryUsageType)
            },
            { label: "车辆状态", children: renderVehicleStatus(vehicle.vehicleStatus) }
          ]}
          size="small"
        />
      </DetailSection>

      <DetailSection title="资产价值信息">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "采购价", children: formatYuan(assetValue.purchasePriceAmount) },
            { label: "当前销售价", children: formatYuan(assetValue.currentSalePriceAmount) },
            {
              label: "当前销售价最近复核时间",
              children: formatDateTime(latestSalePriceHistory?.createdAt ?? latestSalePriceHistory?.effectiveFrom)
            },
            {
              label: "当前销售价状态",
              children: labelOf(STATUS_LABELS, assetValue.currentSalePriceStatus ?? vehicle.salePriceStatus)
            }
          ]}
          size="small"
        />
      </DetailSection>

      <DetailSection title="经营汇总">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "租金实收", children: formatYuan(summary.rentalPaidAmount) },
            { label: "损伤费用实收", children: formatYuan(summary.damagePaidAmount) },
            { label: "押金收取", children: formatYuan(summary.depositCollectedAmount) },
            { label: "总应收", children: formatYuan(summary.totalReceivableAmount) },
            { label: "总已收", children: formatYuan(summary.totalPaidAmount) },
            { label: "总未收", children: formatYuan(summary.totalRemainingAmount) },
            { label: "出租天数", children: formatInteger(summary.leasedDays) },
            { label: "可运营天数", children: formatInteger(summary.operatingDays) },
            { label: "出租率", children: formatPercent(summary.utilizationRate) },
            { label: "简化经营回报率", children: formatPercent(summary.simpleReturnRate) }
          ]}
          size="small"
        />
      </DetailSection>

      <DetailSection title="订单周期明细">
        <Table
          columns={orderCycleColumns}
          dataSource={detail.orderCycles ?? []}
          locale={{ emptyText: "暂无数据" }}
          pagination={false}
          rowKey={(record) => record.orderId ?? record.orderNo ?? "order-cycle"}
          scroll={{ x: 980 }}
          size="small"
        />
      </DetailSection>

      <DetailSection title="账单明细">
        <Table
          columns={billColumns}
          dataSource={detail.bills ?? []}
          locale={{ emptyText: "暂无数据" }}
          pagination={false}
          rowKey={(record) => record.billId ?? record.billNo ?? "bill"}
          scroll={{ x: 960 }}
          size="small"
        />
      </DetailSection>

      <DetailSection title="生命周期节点">
        <Table
          columns={lifecycleColumns}
          dataSource={detail.lifecycleNodes ?? []}
          locale={{ emptyText: "暂无生命周期节点" }}
          pagination={false}
          rowKey={(record) => record.refId ?? `${record.type}-${record.occurredAt}`}
          scroll={{ x: 760 }}
          size="small"
        />
      </DetailSection>

      <DetailSection title="损伤记录">
        <Table
          columns={damageColumns}
          dataSource={detail.damageRecords ?? []}
          locale={{ emptyText: "暂无数据" }}
          pagination={false}
          rowKey={(record) => record.damageId ?? "damage"}
          scroll={{ x: 980 }}
          size="small"
        />
      </DetailSection>

      <DetailSection title="销售价历史">
        <Table
          columns={salePriceHistoryColumns}
          dataSource={detail.salePriceHistory ?? []}
          locale={{ emptyText: "暂无数据" }}
          pagination={false}
          rowKey={(record) => record.id ?? `${record.reviewType}-${record.effectiveFrom}`}
          scroll={{ x: 980 }}
          size="small"
        />
      </DetailSection>
    </Space>
  );
}

function ReturnTrialDetailContent({
  detail,
  error,
  loading
}: {
  detail: AssetReturnTrialVehicleDetail | null;
  error: string | null;
  loading: boolean;
}) {
  if (loading) {
    return <Skeleton active />;
  }

  if (error) {
    return <Alert showIcon title={error} type="error" />;
  }

  if (!detail) {
    return <Alert showIcon title="暂无数据" type="info" />;
  }

  const vehicle = detail.vehicle ?? {};
  const costProfile = detail.costProfile ?? null;
  const costPreview = detail.costPreview ?? null;
  const income = detail.incomeBreakdown ?? {};
  const cost = detail.costBreakdown ?? {};
  const returns = detail.returns ?? {};

  return (
    <Space orientation="vertical" size={18} style={{ width: "100%" }}>
      <DetailSection title="车辆基础信息">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "车辆编号", children: safeText(vehicle.vehicleNo) },
            { label: "VIN", children: safeText(vehicle.vin) },
            { label: "车牌号", children: safeText(vehicle.plateNo) },
            { label: "品牌", children: safeText(vehicle.brand) },
            { label: "车系", children: safeText(vehicle.series) },
            { label: "车型", children: safeText(vehicle.vehicleModel ?? vehicle.model) },
            { label: "车辆状态", children: renderVehicleStatus(vehicle.vehicleStatus) },
            { label: "采购价", children: formatYuan(vehicle.purchasePriceAmount) },
            { label: "当前销售价", children: formatYuan(vehicle.currentSalePriceAmount) }
          ]}
          size="small"
        />
      </DetailSection>

      <DetailSection title="成本参数">
        {costProfile ? (
          <Descriptions
            bordered
            column={2}
            items={[
              {
                label: "成本参数状态",
                children: labelOf(
                  VEHICLE_ASSET_COST_PROFILE_STATUS_LABELS,
                  costProfile.profileStatus
                )
              },
              {
                label: "折旧方法",
                children: labelOf(VEHICLE_DEPRECIATION_METHOD_LABELS, costProfile.depreciationMethod)
              },
              { label: "折旧起算日", children: formatDate(costProfile.depreciationStartDate) },
              { label: "预计使用月数", children: formatInteger(costProfile.usefulLifeMonths) },
              { label: "预计残值", children: formatYuan(costProfile.residualValueAmount) },
              { label: "资金成本率", children: formatBps(costProfile.capitalCostRateBps) },
              { label: "年度保险成本", children: formatYuan(costProfile.annualInsuranceCostAmount) },
              {
                label: "年度维修准备金",
                children: formatYuan(costProfile.annualMaintenanceReserveAmount)
              },
              { label: "其他月度成本", children: formatYuan(costProfile.otherMonthlyCostAmount) },
              { label: "备注", children: safeText(costProfile.remark) }
            ]}
            size="small"
          />
        ) : (
          <Alert showIcon title="该车辆尚未配置资产成本参数。" type="warning" />
        )}
      </DetailSection>

      <DetailSection title="成本 preview">
        {costPreview ? (
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "采购价", children: formatYuan(costPreview.purchasePriceAmount) },
              { label: "预计残值", children: formatYuan(costPreview.residualValueAmount) },
              { label: "可折旧金额", children: formatYuan(costPreview.depreciableAmount) },
              { label: "月折旧", children: formatYuan(costPreview.monthlyDepreciationAmount) },
              { label: "年度资金成本", children: formatYuan(costPreview.annualCapitalCostAmount) },
              { label: "月资金成本", children: formatYuan(costPreview.monthlyCapitalCostAmount) },
              { label: "月保险成本", children: formatYuan(costPreview.monthlyInsuranceCostAmount) },
              {
                label: "月维修准备金",
                children: formatYuan(costPreview.monthlyMaintenanceReserveAmount)
              },
              { label: "其他月度成本", children: formatYuan(costPreview.otherMonthlyCostAmount) },
              { label: "预估月成本", children: formatYuan(costPreview.estimatedMonthlyCostAmount) }
            ]}
            size="small"
          />
        ) : (
          <Alert showIcon title="暂无成本 preview。" type="info" />
        )}
      </DetailSection>

      <DetailSection title="收入明细">
        <Space orientation="vertical" size={8} style={{ width: "100%" }}>
          <Alert showIcon type="info" message="押金收取单独列示，不计入经营收入。" />
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "租金实收", children: formatYuan(income.rentalPaidAmount) },
              { label: "损伤实收", children: formatYuan(income.damagePaidAmount) },
              { label: "其他实收", children: formatYuan(income.otherPaidAmount) },
              { label: "押金收取", children: formatYuan(income.depositCollectedAmount) },
              { label: "经营收入合计", children: formatYuan(income.operatingRevenueAmount) }
            ]}
            size="small"
          />
        </Space>
      </DetailSection>

      <DetailSection title="成本拆分">
        <Space orientation="vertical" size={8} style={{ width: "100%" }}>
          {cost.costProfileMissing ? (
            <Alert
              showIcon
              title="缺少成本参数"
              description="该车辆尚未配置资产成本参数，无法试算 ROA。"
              type="warning"
            />
          ) : null}
          {cost.manualDepreciationUnsupported ? (
            <Alert
              showIcon
              title="手工折旧暂不支持试算"
              description={
                safeText(cost.costUnavailableReason) === "-"
                  ? "MANUAL 折旧方法暂未配置手工折旧明细，无法试算 ROA。"
                  : safeText(cost.costUnavailableReason)
              }
              type="warning"
            />
          ) : null}
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "成本分摊天数", children: formatInteger(cost.costDays) },
              { label: "折旧成本", children: formatYuan(cost.depreciationCostAmount) },
              { label: "资金成本", children: formatYuan(cost.capitalCostAmount) },
              { label: "保险成本", children: formatYuan(cost.insuranceCostAmount) },
              { label: "维修准备金", children: formatYuan(cost.maintenanceReserveCostAmount) },
              { label: "其他成本", children: formatYuan(cost.otherCostAmount) },
              { label: "经营成本合计", children: formatYuan(cost.operatingCostAmount) },
              { label: "不可计算原因", children: safeText(cost.costUnavailableReason) }
            ]}
            size="small"
          />
        </Space>
      </DetailSection>

      <DetailSection title="收益试算">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "试算经营净收益", children: formatYuan(returns.trialNetOperatingIncomeAmount) },
            { label: "试算 ROA", children: formatPercent(returns.trialRoa) },
            { label: "年化试算 ROA", children: formatPercent(returns.annualizedTrialRoa) },
            { label: "ROE", children: "暂不可用" },
            { label: "ROE 不可用原因", children: safeText(returns.roeUnavailableReason) }
          ]}
          size="small"
        />
      </DetailSection>

      <DetailSection title="订单周期明细">
        <Table
          columns={returnOrderCycleColumns}
          dataSource={detail.orderCycles ?? []}
          locale={{ emptyText: "暂无数据" }}
          pagination={false}
          rowKey={(record) => record.orderId ?? record.orderNo ?? "return-order-cycle"}
          scroll={{ x: 1120 }}
          size="small"
        />
      </DetailSection>

      <DetailSection title="账单明细">
        <Table
          columns={returnBillColumns}
          dataSource={detail.bills ?? []}
          locale={{ emptyText: "暂无数据" }}
          pagination={false}
          rowKey={(record) => record.billId ?? record.billNo ?? "return-bill"}
          scroll={{ x: 1080 }}
          size="small"
        />
      </DetailSection>
    </Space>
  );
}

function DetailSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <Space orientation="vertical" size={8} style={{ width: "100%" }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        {title}
      </Typography.Title>
      {children}
    </Space>
  );
}

const orderCycleColumns: ColumnsType<OrderCycleRow> = [
  {
    dataIndex: "orderNo",
    render: (value, record) => renderOrderLink(record.orderId, value),
    title: "订单编号",
    width: 150
  },
  { dataIndex: "customerName", render: safeText, title: "客户", width: 130 },
  {
    dataIndex: "orderStatus",
    render: (value?: string | null) => labelOf(ORDER_STATUS_LABELS, value),
    title: "订单状态",
    width: 120
  },
  { dataIndex: "deliveredAt", render: formatDateTime, title: "交付时间", width: 160 },
  { dataIndex: "returnedAt", render: formatDateTime, title: "退车时间", width: 160 },
  { dataIndex: "leasedDays", render: formatInteger, title: "出租天数", width: 100 },
  { dataIndex: "monthlyFeeAmount", render: formatYuan, title: "套餐月费", width: 130 },
  { dataIndex: "rentalPaidAmount", render: formatYuan, title: "实收租金", width: 130 },
  { dataIndex: "damagePaidAmount", render: formatYuan, title: "损伤费用", width: 130 }
];

const returnOrderCycleColumns: ColumnsType<ReturnTrialOrderCycleRow> = [
  ...orderCycleColumns,
  { dataIndex: "otherPaidAmount", render: formatYuan, title: "其他实收", width: 130 }
];

const billColumns: ColumnsType<BillDetailRow> = [
  { dataIndex: "billNo", render: safeText, title: "账单编号", width: 150 },
  {
    dataIndex: "billType",
    render: (value?: string | null) => labelOf(BILL_TYPE_LABELS, value),
    title: "账单类型",
    width: 130
  },
  { dataIndex: "amount", render: formatYuan, title: "应收", width: 120 },
  { dataIndex: "paidAmount", render: formatYuan, title: "已收", width: 120 },
  { dataIndex: "remainingAmount", render: formatYuan, title: "未收", width: 120 },
  { render: (_value, record) => formatBillPeriod(record), title: "账期", width: 190 },
  {
    dataIndex: "billStatus",
    render: (value?: string | null) => labelOf(BILL_STATUS_LABELS, value),
    title: "状态",
    width: 110
  }
];

const returnBillColumns: ColumnsType<ReturnTrialBillRow> = [
  ...billColumns,
  {
    dataIndex: "includedInOperatingRevenue",
    render: (value?: boolean | null) =>
      value ? <Tag color="green">计入经营收入</Tag> : <Tag>不计入经营收入</Tag>,
    title: "收益口径",
    width: 150
  }
];

const lifecycleColumns: ColumnsType<LifecycleNodeRow> = [
  {
    dataIndex: "type",
    render: (value?: string | null) => labelOf(lifecycleNodeLabels, value),
    title: "节点",
    width: 130
  },
  { dataIndex: "occurredAt", render: formatDateTime, title: "发生时间", width: 170 },
  { render: (_value, record) => lifecycleReference(record), title: "引用", width: 220 },
  { render: (_value, record) => lifecycleValue(record), title: "状态 / 金额", width: 160 }
];

const damageColumns: ColumnsType<DamageRecordRow> = [
  { dataIndex: "returnNo", render: safeText, title: "退车单号", width: 140 },
  {
    dataIndex: "damageType",
    render: (value?: string | null) => labelOf(VEHICLE_DAMAGE_TYPE_LABELS, value),
    title: "损伤类型",
    width: 120
  },
  {
    dataIndex: "damageLevel",
    render: (value?: string | null) => labelOf(VEHICLE_DAMAGE_LEVEL_LABELS, value),
    title: "损伤等级",
    width: 110
  },
  {
    dataIndex: "responsibleParty",
    render: (value?: string | null) => labelOf(VEHICLE_DAMAGE_RESPONSIBLE_PARTY_LABELS, value),
    title: "责任方",
    width: 120
  },
  { dataIndex: "estimatedRepairAmount", render: formatYuan, title: "预估维修金额", width: 140 },
  {
    dataIndex: "status",
    render: (value?: string | null) => labelOf(VEHICLE_RETURN_DAMAGE_STATUS_LABELS, value),
    title: "状态",
    width: 110
  },
  { dataIndex: "description", render: safeText, title: "描述", width: 240 }
];

const salePriceHistoryColumns: ColumnsType<SalePriceHistoryRow> = [
  {
    dataIndex: "reviewType",
    render: (value?: string | null) => labelOf(SALE_PRICE_REVIEW_TYPE_LABELS, value),
    title: "复核类型",
    width: 170
  },
  { dataIndex: "beforeSalePriceAmount", render: formatYuan, title: "调整前价格", width: 130 },
  { dataIndex: "afterSalePriceAmount", render: formatYuan, title: "调整后价格", width: 130 },
  { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
  { dataIndex: "reviewQuarter", render: safeText, title: "复核季度", width: 110 },
  { render: (_value, record) => safeText(record.reason ?? record.remark), title: "原因", width: 220 },
  { dataIndex: "createdAt", render: formatDateTime, title: "创建时间", width: 160 }
];

function renderVehicleStatus(value?: string | null) {
  if (!value) {
    return "-";
  }

  return <Tag color={vehicleStatusColors[value] ?? "default"}>{labelOf(VEHICLE_STATUS_LABELS, value)}</Tag>;
}

function renderCostProfileStatus(record: Pick<
  AssetReturnTrialVehicleRow,
  "costProfileMissing" | "costProfileStatus" | "manualDepreciationUnsupported"
>) {
  if (record.costProfileMissing) {
    return (
      <Tooltip title="该车辆尚未配置资产成本参数，无法试算 ROA。">
        <Tag color="warning">缺少成本参数</Tag>
      </Tooltip>
    );
  }

  if (record.manualDepreciationUnsupported) {
    return (
      <Tooltip title="MANUAL 折旧方法暂未配置手工折旧明细，无法试算 ROA。">
        <Tag color="orange">手工折旧暂不支持试算</Tag>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      title={`成本参数状态：${labelOf(
        VEHICLE_ASSET_COST_PROFILE_STATUS_LABELS,
        record.costProfileStatus
      )}`}
    >
      <Tag color="green">可试算</Tag>
    </Tooltip>
  );
}

function renderCostUnavailableReason(
  record: Pick<
    AssetReturnTrialVehicleRow,
    "costProfileMissing" | "costUnavailableReason" | "manualDepreciationUnsupported"
  >
) {
  if (record.costProfileMissing) {
    return (
      <Tooltip title="该车辆尚未配置资产成本参数，无法试算 ROA。">
        <Typography.Text type="secondary">缺少成本参数</Typography.Text>
      </Tooltip>
    );
  }

  if (record.manualDepreciationUnsupported) {
    const reason =
      record.costUnavailableReason ?? "MANUAL 折旧方法暂未配置手工折旧明细，无法试算 ROA。";
    return (
      <Tooltip title={reason}>
        <Typography.Text type="secondary">{reason}</Typography.Text>
      </Tooltip>
    );
  }

  return safeText(record.costUnavailableReason);
}

function renderOrderLink(orderId?: string | null, orderNo?: unknown) {
  const label = safeText(orderNo);
  if (!orderId || label === "-") {
    return label;
  }

  return <Link href={`/orders/${orderId}`}>{label}</Link>;
}

function lifecycleReference(record: LifecycleNodeRow) {
  if (record.type === "INITIAL_POOL" || record.type === "RETURN_REINIT" || record.type === "SALE_PRICE_REVIEW") {
    return labelOf(SALE_PRICE_REVIEW_TYPE_LABELS, record.label);
  }

  return safeText(record.label);
}

function lifecycleValue(record: LifecycleNodeRow) {
  if (record.amount !== undefined && record.amount !== null) {
    return formatYuan(record.amount);
  }

  if (record.type === "DELIVERY") {
    return labelOf({ ...STATUS_LABELS, ...DELIVERY_STATUS_LABELS }, record.status);
  }

  if (record.type === "RETURN") {
    return labelOf({ ...STATUS_LABELS, ...VEHICLE_RETURN_STATUS_LABELS }, record.status);
  }

  return safeText(record.status);
}

function formatBillPeriod(record: BillDetailRow) {
  if (record.periodStart || record.periodEnd) {
    return `${formatDate(record.periodStart)} 至 ${formatDate(record.periodEnd)}`;
  }

  return formatDate(record.dueDate);
}

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

function isAssetSortField(value: string): value is AssetSortField {
  return assetSortFields.includes(value as AssetSortField);
}

function isAssetReturnSortField(value: string): value is AssetReturnSortField {
  return assetReturnSortFields.includes(value as AssetReturnSortField);
}

function sortOrderFor(field: AssetSortField, sortBy?: AssetSortField, sortOrder?: BackendSortOrder) {
  if (sortBy !== field || !sortOrder) {
    return undefined;
  }
  return sortOrder === "asc" ? "ascend" : "descend";
}

function sortOrderForReturn(
  field: AssetReturnSortField,
  sortBy?: AssetReturnSortField,
  sortOrder?: BackendSortOrder
) {
  if (sortBy !== field || !sortOrder) {
    return undefined;
  }
  return sortOrder === "asc" ? "ascend" : "descend";
}

function latestByDate<TItem>(items: TItem[], getValue: (item: TItem) => unknown) {
  return [...items].sort((left, right) => {
    const leftTime = dateValue(getValue(left));
    const rightTime = dateValue(getValue(right));
    return rightTime - leftTime;
  })[0];
}

function dateValue(value: unknown) {
  if (!value) {
    return 0;
  }
  const parsed = dayjs(value as string | number | Date);
  return parsed.isValid() ? parsed.valueOf() : 0;
}

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatInteger(value?: number | null) {
  const numberValue = safeNumber(value);
  return numberValue === null ? "-" : Math.trunc(numberValue).toLocaleString("zh-CN");
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

function formatKwh(value?: number | null) {
  const numberValue = safeNumber(value);
  if (numberValue === null) {
    return "-";
  }
  return `${numberValue.toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0
  })} kWh`;
}

function formatBps(value?: number | null) {
  const numberValue = safeNumber(value);
  if (numberValue === null) {
    return "-";
  }

  return `${(numberValue / 100).toLocaleString("zh-CN", {
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

function formatDateTime(value?: unknown) {
  if (!value) {
    return "-";
  }
  const parsed = dayjs(value as string | number | Date);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD HH:mm") : "-";
}

function safeText(value?: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString("zh-CN");
  }

  return typeof value === "string" && value.trim() ? value : "-";
}

function normalizeErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.message === "Internal Server Error") {
      return "后端服务异常，请稍后重试";
    }
    if (error.message === "Bad Request") {
      return "请求参数不正确，请检查筛选条件";
    }
    return error.message;
  }

  return "请求失败，请稍后重试";
}
