"use client";

import { DownloadOutlined, EyeOutlined, InfoCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
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
  CAPITAL_COST_SOURCE_LABELS,
  DELIVERY_STATUS_LABELS,
  FINANCING_ALLOCATION_STATUS_LABELS,
  FINANCING_INSTRUMENT_TYPE_LABELS,
  FINANCING_REPAYMENT_METHOD_LABELS,
  FORECAST_RESIDUAL_AMOUNT_SOURCE_LABELS,
  ORDER_STATUS_LABELS,
  RESIDUAL_FORECAST_INTERPOLATION_METHOD_LABELS,
  REVENUE_RIGHT_ASSIGNEE_TYPE_LABELS,
  REVENUE_RIGHT_ASSIGNMENT_STATUS_LABELS,
  REVENUE_RIGHT_ASSIGNMENT_TYPE_LABELS,
  REVENUE_RIGHT_TARGET_TYPE_LABELS,
  REVENUE_SHARE_BASIS_LABELS,
  REVENUE_SHARE_RULE_STATUS_LABELS,
  REVENUE_SHARE_RULE_TYPE_LABELS,
  SALE_PRICE_REVIEW_TYPE_LABELS,
  STATUS_LABELS,
  VEHICLE_ASSET_COST_PROFILE_STATUS_LABELS,
  VEHICLE_BATTERY_USAGE_TYPE_LABELS,
  VEHICLE_DAMAGE_LEVEL_LABELS,
  VEHICLE_DAMAGE_RESPONSIBLE_PARTY_LABELS,
  VEHICLE_DAMAGE_TYPE_LABELS,
  VEHICLE_DEPRECIATION_METHOD_LABELS,
  VEHICLE_RESIDUAL_CURVE_METHOD_LABELS,
  VEHICLE_RESIDUAL_CURVE_STATUS_LABELS,
  VEHICLE_RESIDUAL_FORECAST_METHOD_LABELS,
  VEHICLE_RESIDUAL_FORECAST_POINT_STATUS_LABELS,
  VEHICLE_RESIDUAL_FORECAST_STATUS_LABELS,
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
  annualizedRoeTrial?: number | null;
  assignedOutRevenueAmount?: number | null;
  capitalCostAmount?: number | null;
  capitalCostSource?: string | null;
  costCalculatedVehicleCount?: number | null;
  costUnavailableVehicleCount?: number | null;
  currentSalePriceAmount?: number | null;
  damagePaidAmount?: number | null;
  dateRange?: DateRangeResponse;
  debtInterestCostAmount?: number | null;
  debtPrincipalAmount?: number | null;
  depositCollectedAmount?: number | null;
  depreciationCostAmount?: number | null;
  externalLeaseCostAmount?: number | null;
  insuranceCostAmount?: number | null;
  maintenanceReserveCostAmount?: number | null;
  operatingCostAmount?: number | null;
  operatingRevenueAmount?: number | null;
  otherCostAmount?: number | null;
  otherPaidAmount?: number | null;
  ownerShareAmount?: number | null;
  platformNetIncomeAmount?: number | null;
  platformRetainedRevenueAmount?: number | null;
  pledgedRevenueAmount?: number | null;
  purchasePriceAmount?: number | null;
  rentalPaidAmount?: number | null;
  forecastLowerBoundAmount?: number | null;
  forecastResidualAmount?: number | null;
  forecastUpperBoundAmount?: number | null;
  residualDeltaToCostProfileAmount?: number | null;
  residualDeltaToCurrentSalePriceAmount?: number | null;
  residualForecastAdoptedVehicleCount?: number | null;
  residualForecastMissingVehicleCount?: number | null;
  residualForecastUnsupportedVehicleCount?: number | null;
  residualForecastVehicleCount?: number | null;
  residualForecastWarnings?: string[];
  residualSensitivityAnnualizedRoeTrial?: number | null;
  residualSensitivityNetIncomeAmount?: number | null;
  residualSensitivityRoeTrial?: number | null;
  roeCalculatedVehicleCount?: number | null;
  roeDataReady?: boolean | null;
  roeEquityBaseAmount?: number | null;
  roeMissingReasons?: string[];
  roeTrial?: number | null;
  roeUnavailableReason?: string | null;
  roeUnavailableVehicleCount?: number | null;
  roeWarnings?: string[];
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
  annualizedRoeTrial?: number | null;
  assignedOutRevenueAmount?: number | null;
  capitalCostAmount?: number | null;
  capitalCostSource?: string | null;
  costDays?: number | null;
  costProfileMissing?: boolean | null;
  costProfileStatus?: string | null;
  costUnavailableReason?: string | null;
  debtInterestCostAmount?: number | null;
  debtPrincipalAmount?: number | null;
  depreciationCostAmount?: number | null;
  externalLeaseCostAmount?: number | null;
  insuranceCostAmount?: number | null;
  maintenanceReserveCostAmount?: number | null;
  manualDepreciationUnsupported?: boolean | null;
  operatingCostAmount?: number | null;
  operatingRevenueAmount?: number | null;
  otherCostAmount?: number | null;
  otherPaidAmount?: number | null;
  ownerShareAmount?: number | null;
  platformNetIncomeAmount?: number | null;
  platformRetainedRevenueAmount?: number | null;
  pledgedRevenueAmount?: number | null;
  pledgedRevenueRatio?: number | null;
  costProfileResidualValueAmount?: number | null;
  forecastConfidenceScore?: number | null;
  forecastLowerBoundAmount?: number | null;
  forecastResidualAmount?: number | null;
  forecastResidualAmountSource?: string | null;
  forecastResidualRateBps?: number | null;
  forecastUpperBoundAmount?: number | null;
  residualDeltaToCostProfileAmount?: number | null;
  residualDeltaToCurrentSalePriceAmount?: number | null;
  residualForecastAsOfDate?: string | null;
  residualForecastAvailable?: boolean | null;
  residualForecastCurveNo?: string | null;
  residualForecastHorizonMonth?: number | null;
  residualForecastMethod?: string | null;
  residualForecastNo?: string | null;
  residualForecastStatus?: string | null;
  residualForecastTargetAgeMonth?: number | null;
  residualForecastTargetDate?: string | null;
  residualForecastUnavailableReason?: string | null;
  residualForecastWarnings?: string[];
  residualSensitivityAnnualizedRoeTrial?: number | null;
  residualSensitivityNetIncomeAmount?: number | null;
  residualSensitivityRoeTrial?: number | null;
  roeDataReady?: boolean | null;
  roeEquityBaseAmount?: number | null;
  roeMissingReasons?: string[];
  roeTrial?: number | null;
  roeUnavailableReason?: string | null;
  roeWarnings?: string[];
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
  capitalEvents?: ReturnTrialCapitalEventRow[];
  capitalStructureSummary?: ReturnTrialCapitalStructureSummary | null;
  costBreakdown?: ReturnTrialCostBreakdown | null;
  costPreview?: VehicleAssetCostPreview | null;
  costProfile?: VehicleAssetCostProfileInfo | null;
  dateRange?: DateRangeResponse;
  financingAllocations?: ReturnTrialFinancingAllocationRow[];
  incomeBreakdown?: ReturnTrialIncomeBreakdown | null;
  orderCycles?: ReturnTrialOrderCycleRow[];
  revenueRightAssignments?: ReturnTrialRevenueRightAssignmentRow[];
  revenueShareRules?: ReturnTrialRevenueShareRuleRow[];
  residualForecastCurveSummary?: ResidualForecastCurveSummary | null;
  residualForecastPoint?: ResidualForecastPoint | null;
  residualForecastSummary?: ResidualForecastSummary | null;
  roeBreakdown?: ReturnTrialRoeBreakdown | null;
  returns?: ReturnTrialMetrics | null;
  vehicle?: ReturnTrialVehicleInfo | null;
}

interface ResidualForecastSummary {
  amountSource?: string | null;
  asOfDate?: string | null;
  available?: boolean | null;
  curveNo?: string | null;
  forecastMethod?: string | null;
  forecastNo?: string | null;
  forecastStatus?: string | null;
  horizonMonth?: number | null;
  targetDate?: string | null;
  unavailableReason?: string | null;
  warnings?: string[];
}

interface ResidualForecastPoint {
  adoptedResidualAmount?: number | null;
  confidenceScore?: number | null;
  forecastResidualAmount?: number | null;
  interpolationMethod?: string | null;
  lowerBoundAmount?: number | null;
  matchedCurvePointAgeMonth?: number | null;
  pointId?: string | null;
  pointStatus?: string | null;
  predictedResidualAmount?: number | null;
  predictedResidualRateBps?: number | null;
  targetAgeMonth?: number | null;
  targetDate?: string | null;
  upperBoundAmount?: number | null;
}

interface ResidualForecastCurveSummary {
  batteryCapacityKwh?: number | null;
  batteryUsageType?: string | null;
  brand?: string | null;
  confidenceScore?: number | null;
  curveId?: string | null;
  curveMethod?: string | null;
  curveNo?: string | null;
  curveStatus?: string | null;
  model?: string | null;
  modelYear?: number | null;
  series?: string | null;
  trim?: string | null;
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
  assignedOutRevenueAmount?: number | null;
  damagePaidAmount?: number | null;
  depositCollectedAmount?: number | null;
  depositIncludedInOperatingRevenue?: boolean | null;
  operatingRevenueAmount?: number | null;
  otherPaidAmount?: number | null;
  ownerShareAmount?: number | null;
  platformRetainedRevenueAmount?: number | null;
  pledgedRevenueAmount?: number | null;
  rentalPaidAmount?: number | null;
}

interface ReturnTrialCostBreakdown {
  capitalCostAmount?: number | null;
  capitalCostSource?: string | null;
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
  annualizedRoeTrial?: number | null;
  annualizedTrialRoa?: number | null;
  capitalCostSource?: string | null;
  debtInterestCostAmount?: number | null;
  externalLeaseCostAmount?: number | null;
  platformNetIncomeAmount?: number | null;
  roeDataReady?: boolean | null;
  roeEquityBaseAmount?: number | null;
  roeMissingReasons?: string[];
  roeTrial?: number | null;
  roeUnavailableReason?: string | null;
  roeWarnings?: string[];
  residualDeltaToCostProfileAmount?: number | null;
  residualDeltaToCurrentSalePriceAmount?: number | null;
  residualForecastAvailable?: boolean | null;
  residualForecastUnavailableReason?: string | null;
  residualForecastWarnings?: string[];
  residualSensitivityAnnualizedRoeTrial?: number | null;
  residualSensitivityNetIncomeAmount?: number | null;
  residualSensitivityRoeTrial?: number | null;
  trialNetOperatingIncomeAmount?: number | null;
  trialRoa?: number | null;
}

interface ReturnTrialCapitalStructureSummary {
  capitalCostSource?: string | null;
  debtInterestCostAmount?: number | null;
  debtPrincipalAmount?: number | null;
  equityCapitalAmount?: number | null;
  roeDataReady?: boolean | null;
  roeMissingReasons?: string[];
  roeWarnings?: string[];
}

interface ReturnTrialRoeBreakdown {
  assignedOutRevenueAmount?: number | null;
  debtInterestCostAmount?: number | null;
  debtPrincipalAmount?: number | null;
  externalLeaseCostAmount?: number | null;
  operatingRevenueAmount?: number | null;
  ownerShareAmount?: number | null;
  platformNetIncomeAmount?: number | null;
  platformRetainedRevenueAmount?: number | null;
  pledgedRevenueAmount?: number | null;
  roeEquityBaseAmount?: number | null;
}

interface ReturnTrialCapitalEventRow {
  debtPrincipalAmount?: number | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  equityCapitalAmount?: number | null;
  eventNo?: string | null;
  eventStatus?: string | null;
  eventType?: string | null;
  financingInstrumentId?: string | null;
  id?: string | null;
  remark?: string | null;
  vehicleId?: string | null;
}

interface ReturnTrialFinancingAllocationRow {
  allocatedPrincipalAmount?: number | null;
  allocationNo?: string | null;
  allocationRatioBps?: number | null;
  allocationStatus?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  id?: string | null;
  instrument?: {
    annualRateBps?: number | null;
    id?: string | null;
    instrumentNo?: string | null;
    instrumentStatus?: string | null;
    instrumentType?: string | null;
    lenderName?: string | null;
    principalAmount?: number | null;
    repaymentMethod?: string | null;
  } | null;
  instrumentId?: string | null;
  remark?: string | null;
  vehicleId?: string | null;
}

interface ReturnTrialRevenueRightAssignmentRow {
  assigneeName?: string | null;
  assigneeType?: string | null;
  assignmentNo?: string | null;
  assignmentStatus?: string | null;
  assignmentType?: string | null;
  bill?: {
    billNo?: string | null;
    billType?: string | null;
    id?: string | null;
    orderId?: string | null;
    orderNo?: string | null;
    paidAmount?: number | null;
    vehicleId?: string | null;
  } | null;
  billId?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  financingInstrument?: {
    id?: string | null;
    instrumentNo?: string | null;
    instrumentType?: string | null;
    lenderName?: string | null;
  } | null;
  financingInstrumentId?: string | null;
  id?: string | null;
  order?: {
    id?: string | null;
    orderNo?: string | null;
    vehicleId?: string | null;
  } | null;
  orderId?: string | null;
  priority?: number | null;
  releasedAt?: string | null;
  releaseReason?: string | null;
  remark?: string | null;
  shareRatioBps?: number | null;
  targetType?: string | null;
  vehicleId?: string | null;
}

interface ReturnTrialRevenueShareRuleRow {
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  fixedMonthlyAmount?: number | null;
  id?: string | null;
  minimumGuaranteeAmount?: number | null;
  ownerName?: string | null;
  ownerShareBps?: number | null;
  platformShareBps?: number | null;
  remark?: string | null;
  ruleNo?: string | null;
  ruleStatus?: string | null;
  ruleType?: string | null;
  settlementCycle?: string | null;
  shareBasis?: string | null;
  vehicleId?: string | null;
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
const residualHorizonMonthOptions = [
  { label: "当前", value: 0 },
  { label: "未来 6 个月", value: 6 },
  { label: "未来 12 个月", value: 12 },
  { label: "未来 24 个月", value: 24 },
  { label: "未来 36 个月", value: 36 }
];
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

function exportDefaultFilename(
  kind: "detail" | "returnDetail" | "returnSummary" | "returnVehicles" | "summary" | "vehicles",
  dateRange: [Dayjs, Dayjs]
) {
  const prefixByKind = {
    detail: "asset-profitability-vehicle-detail",
    returnDetail: "asset-return-trial-vehicle-detail",
    returnSummary: "asset-return-trial-summary",
    returnVehicles: "asset-return-trial-vehicles",
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
  const [residualHorizonMonth, setResidualHorizonMonth] = useState(12);
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
  const [returnSummaryExporting, setReturnSummaryExporting] = useState(false);
  const [returnVehiclesExporting, setReturnVehiclesExporting] = useState(false);
  const [returnDetailExporting, setReturnDetailExporting] = useState(false);

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

  const returnQuery = useCallback(() => {
    return {
      ...baseQuery(),
      residualHorizonMonth
    };
  }, [baseQuery, residualHorizonMonth]);

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
          `/reports/asset-profitability/returns/summary${buildQuery(returnQuery())}`
        )
      );
    } catch (error) {
      setReturnSummaryError(normalizeErrorMessage(error));
    } finally {
      setReturnSummaryLoading(false);
    }
  }, [canViewAssetReport, returnQuery]);

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
            ...returnQuery(),
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
    canViewAssetReport,
    returnPage,
    returnPageSize,
    returnQuery,
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

  const exportReturnSummaryCsv = useCallback(async () => {
    if (!canViewAssetReport) {
      return;
    }

    setReturnSummaryExporting(true);
    try {
      await downloadCsv(
        `/reports/asset-profitability/returns/summary/export${buildQuery(baseQuery())}`,
        exportDefaultFilename("returnSummary", dateRange)
      );
    } catch (error) {
      void message.error(normalizeErrorMessage(error));
    } finally {
      setReturnSummaryExporting(false);
    }
  }, [baseQuery, canViewAssetReport, dateRange, message]);

  const exportReturnVehiclesCsv = useCallback(async () => {
    if (!canViewAssetReport) {
      return;
    }

    setReturnVehiclesExporting(true);
    try {
      await downloadCsv(
        `/reports/asset-profitability/returns/vehicles/export${buildQuery({
          ...baseQuery(),
          sortBy: returnSortBy,
          sortOrder: returnSortOrder
        })}`,
        exportDefaultFilename("returnVehicles", dateRange)
      );
    } catch (error) {
      void message.error(normalizeErrorMessage(error));
    } finally {
      setReturnVehiclesExporting(false);
    }
  }, [baseQuery, canViewAssetReport, dateRange, message, returnSortBy, returnSortOrder]);

  const exportReturnVehicleDetailCsv = useCallback(async () => {
    if (!canViewAssetReport || !selectedReturnVehicle) {
      return;
    }

    setReturnDetailExporting(true);
    try {
      await downloadCsv(
        `/reports/asset-profitability/returns/vehicles/${selectedReturnVehicle.vehicleId}/export${buildQuery({
          endDate: dateRange[1].format("YYYY-MM-DD"),
          startDate: dateRange[0].format("YYYY-MM-DD")
        })}`,
        exportDefaultFilename("returnDetail", dateRange)
      );
    } catch (error) {
      void message.error(normalizeErrorMessage(error));
    } finally {
      setReturnDetailExporting(false);
    }
  }, [canViewAssetReport, dateRange, message, selectedReturnVehicle]);

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
            residualHorizonMonth,
            startDate: dateRange[0].format("YYYY-MM-DD")
          })}`
        )
      );
    } catch (error) {
      setReturnDetailError(normalizeErrorMessage(error));
    } finally {
      setReturnDetailLoading(false);
    }
  }, [canViewAssetReport, dateRange, residualHorizonMonth]);

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
      {
        dataIndex: "platformRetainedRevenueAmount",
        render: formatYuan,
        title: "平台留存收入",
        width: 150
      },
      { dataIndex: "depositCollectedAmount", render: formatYuan, title: "押金收取", width: 130 },
      { dataIndex: "depreciationCostAmount", render: formatYuan, title: "折旧成本", width: 130 },
      { dataIndex: "capitalCostAmount", render: formatYuan, title: "资金成本", width: 130 },
      { dataIndex: "debtInterestCostAmount", render: formatYuan, title: "债务利息", width: 130 },
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
      { dataIndex: "roeEquityBaseAmount", render: formatYuan, title: "权益资本基数", width: 150 },
      { dataIndex: "platformNetIncomeAmount", render: formatYuan, title: "平台权益净收益", width: 160 },
      { dataIndex: "roeTrial", render: formatTrialRoe, title: "试算 ROE", width: 120 },
      { dataIndex: "annualizedRoeTrial", render: formatPercent, title: "年化试算 ROE", width: 150 },
      {
        render: (_value, record) => renderResidualForecastStatus(record),
        title: "残值预测状态",
        width: 150
      },
      {
        dataIndex: "residualForecastHorizonMonth",
        render: formatHorizonMonth,
        title: "预测周期",
        width: 120
      },
      { dataIndex: "forecastResidualAmount", render: formatYuan, title: "预测残值", width: 130 },
      {
        dataIndex: "forecastResidualAmountSource",
        render: (value?: string | null) => labelOf(FORECAST_RESIDUAL_AMOUNT_SOURCE_LABELS, value),
        title: "预测值来源",
        width: 120
      },
      {
        dataIndex: "residualDeltaToCostProfileAmount",
        render: renderSignedYuan,
        title: "相对成本残值差异",
        width: 170
      },
      {
        dataIndex: "residualSensitivityRoeTrial",
        render: formatPercent,
        title: "残值敏感性 ROE",
        width: 150
      },
      {
        render: (_value, record) => renderRoeStatus(record),
        title: "ROE 状态",
        width: 150
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
        exportSummaryLabel={activeTab === "returns" ? "导出收益汇总 CSV" : "导出汇总 CSV"}
        exportVehiclesLabel={
          activeTab === "returns" ? "导出车辆收益列表 CSV" : "导出车辆列表 CSV"
        }
        loading={
          activeTab === "returns"
            ? returnSummaryLoading || returnVehiclesLoading
            : summaryLoading || vehiclesLoading
        }
        onExportSummary={() =>
          void (activeTab === "returns" ? exportReturnSummaryCsv() : exportSummaryCsv())
        }
        onExportVehicles={() =>
          void (activeTab === "returns" ? exportReturnVehiclesCsv() : exportVehiclesCsv())
        }
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
        onResidualHorizonMonthChange={
          activeTab === "returns"
            ? (value) => {
                setResidualHorizonMonth(value);
                setReturnPage(1);
              }
            : undefined
        }
        residualHorizonMonth={activeTab === "returns" ? residualHorizonMonth : undefined}
        summaryExporting={activeTab === "returns" ? returnSummaryExporting : summaryExporting}
        vehicleModel={vehicleModel}
        vehiclesExporting={activeTab === "returns" ? returnVehiclesExporting : vehiclesExporting}
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
                  description="本页为经营分析试算口径，不构成会计凭证或正式财务报表。试算 ROE 使用 Stage 8.3D 主口径；残值敏感性 ROE 读取单车残值预测，优先使用人工采用值，其次使用曲线预测值，并在主口径基础上叠加预测残值相对成本参数预计残值的差异。残值预测不会自动覆盖车辆当前销售价，也不会写入销售价历史。"
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
                    scroll={{ x: 5400 }}
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
        extra={
          selectedReturnVehicle ? (
            <Button
              icon={<DownloadOutlined />}
              loading={returnDetailExporting}
              onClick={() => void exportReturnVehicleDetailCsv()}
            >
              导出单车收益详情 CSV
            </Button>
          ) : null
        }
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
  exportSummaryLabel,
  exportVehiclesLabel,
  loading,
  onExportSummary,
  onExportVehicles,
  onDateRangeChange,
  onRefresh,
  onResidualHorizonMonthChange,
  onVehicleModelChange,
  onVehicleStatusChange,
  residualHorizonMonth,
  summaryExporting,
  vehicleModel,
  vehiclesExporting,
  vehicleStatus
}: {
  dateRange: [Dayjs, Dayjs];
  exportSummaryLabel: string;
  exportVehiclesLabel: string;
  loading: boolean;
  onExportSummary: () => void;
  onExportVehicles: () => void;
  onDateRangeChange: (value: [Dayjs, Dayjs]) => void;
  onRefresh: () => void;
  onResidualHorizonMonthChange?: (value: number) => void;
  onVehicleModelChange: (value?: string) => void;
  onVehicleStatusChange: (value?: string) => void;
  residualHorizonMonth?: number;
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
        {onResidualHorizonMonthChange ? (
          <Space orientation="vertical" size={4}>
            <Typography.Text type="secondary">
              残值预测周期{" "}
              <Tooltip title="选择用于残值敏感性分析的预测周期。系统会读取该周期对应的单车残值预测点；如该周期没有预测点，将显示不可用原因。">
                <InfoCircleOutlined />
              </Tooltip>
            </Typography.Text>
            <Select
              onChange={onResidualHorizonMonthChange}
              options={residualHorizonMonthOptions}
              style={{ width: 150 }}
              value={residualHorizonMonth ?? 12}
            />
          </Space>
        ) : null}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>
          刷新
        </Button>
        <Button icon={<DownloadOutlined />} loading={summaryExporting} onClick={onExportSummary}>
          {exportSummaryLabel}
        </Button>
        <Button icon={<DownloadOutlined />} loading={vehiclesExporting} onClick={onExportVehicles}>
          {exportVehiclesLabel}
        </Button>
      </Space>
    </Card>
  );
}

function MetricGroupCard({
  children,
  description,
  loading,
  title
}: {
  children: ReactNode;
  description?: string;
  loading: boolean;
  title: string;
}) {
  return (
    <Card
      loading={loading}
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

function MetricCardGrid({
  items
}: {
  items: Array<{ title: string; value: string | number }>;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))"
      }}
    >
      {items.map((item) => (
        <Card key={item.title} size="small">
          <Statistic
            title={item.title}
            value={item.value}
            styles={{ content: { fontSize: 20, whiteSpace: "nowrap" } }}
          />
        </Card>
      ))}
    </div>
  );
}

function SummaryMetrics({
  loading,
  summary
}: {
  loading: boolean;
  summary: AssetProfitabilitySummary | null;
}) {
  const valueDelta = calculateDelta(
    summary?.totalCurrentSalePriceAmount,
    summary?.totalPurchasePriceAmount
  );

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <MetricGroupCard
        description="先看资产规模、出租效率、现金回收和简化回报，不把该指标误读为 ROA / ROE。"
        loading={loading}
        title="核心资产经营结果"
      >
        <MetricCardGrid
          items={[
            { title: "车辆总数", value: formatInteger(summary?.totalVehicles) },
            { title: "平均出租率", value: formatPercent(summary?.averageUtilizationRate) },
            { title: "租金实收", value: formatYuan(summary?.rentalPaidAmount) },
            { title: "当前销售价合计", value: formatYuan(summary?.totalCurrentSalePriceAmount) },
            { title: "简化经营回报率", value: formatPercent(summary?.averageSimpleReturnRate) }
          ]}
        />
      </MetricGroupCard>

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))"
        }}
      >
        <MetricGroupCard loading={loading} title="资产价值">
          <Descriptions
            bordered
            column={1}
            items={[
              { label: "采购成本合计", children: formatYuan(summary?.totalPurchasePriceAmount) },
              { label: "当前销售价合计", children: formatYuan(summary?.totalCurrentSalePriceAmount) },
              { label: "价值差异", children: renderSignedYuan(valueDelta) },
              { label: "车辆数", children: formatInteger(summary?.totalVehicles) }
            ]}
            size="small"
          />
        </MetricGroupCard>

        <MetricGroupCard loading={loading} title="出租与利用率">
          <Descriptions
            bordered
            column={1}
            items={[
              { label: "总出租天数", children: formatInteger(summary?.totalLeasedDays) },
              { label: "平均出租率", children: formatPercent(summary?.averageUtilizationRate) },
              { label: "出租率口径", children: "出租率 = 出租天数 / 可运营天数" }
            ]}
            size="small"
          />
        </MetricGroupCard>

        <MetricGroupCard loading={loading} title="收入与应收">
          <Descriptions
            bordered
            column={1}
            items={[
              { label: "租金实收", children: formatYuan(summary?.rentalPaidAmount) },
              { label: "损伤费用实收", children: formatYuan(summary?.damagePaidAmount) },
              { label: "押金收取", children: formatYuan(summary?.depositCollectedAmount) },
              { label: "总应收", children: formatYuan(summary?.totalReceivableAmount) },
              { label: "总已收", children: formatYuan(summary?.totalPaidAmount) },
              { label: "总未收", children: formatYuan(summary?.totalRemainingAmount) }
            ]}
            size="small"
          />
          <Typography.Text type="secondary">押金收取单独列示，不计入租金收入。</Typography.Text>
        </MetricGroupCard>
      </div>

      <Collapse
        items={[
          {
            children:
              "简化经营回报率 = 租金实收 / 车辆采购价。该指标只用于快速观察资产经营表现，不是会计 ROA / ROE；正式收益分析请查看“收益试算”Tab。",
            key: "simple-return-rate",
            label: "简化回报率口径说明"
          }
        ]}
        size="small"
      />
    </Space>
  );
}

function ReturnTrialSummaryMetrics({
  loading,
  summary
}: {
  loading: boolean;
  summary: AssetReturnTrialSummary | null;
}) {
  const missingReasons = normalizeReasonList(summary?.roeMissingReasons);
  if (missingReasons.length === 0 && summary?.roeUnavailableReason) {
    missingReasons.push(summary.roeUnavailableReason);
  }
  const warnings = normalizeReasonList(summary?.roeWarnings);
  const residualWarnings = normalizeReasonList(summary?.residualForecastWarnings);
  const roeStatus = summary?.roeTrial === null ? "ROE 暂不可用" : summary?.roeTrial === undefined ? "-" : "可试算";

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <MetricGroupCard
        description="核心区只展示结论：主 ROE 与残值敏感性 ROE 并列，但口径互不替换。"
        loading={loading}
        title="核心结果"
      >
        <MetricCardGrid
          items={[
            { title: "平台权益净收益", value: formatYuan(summary?.platformNetIncomeAmount) },
            { title: "试算 ROE", value: formatTrialRoe(summary?.roeTrial) },
            { title: "年化试算 ROE", value: formatPercent(summary?.annualizedRoeTrial) },
            { title: "残值敏感性 ROE", value: formatPercent(summary?.residualSensitivityRoeTrial) },
            { title: "ROE 状态", value: roeStatus }
          ]}
        />
        {missingReasons.length > 0 ? (
          <Typography.Text type="secondary">主要原因：{missingReasons.slice(0, 2).join("；")}</Typography.Text>
        ) : null}
      </MetricGroupCard>

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))"
        }}
      >
        <MetricGroupCard loading={loading} title="数据完整性 / 可计算性">
          <Descriptions
            bordered
            column={1}
            items={[
              { label: "车辆总数", children: formatInteger(summary?.vehicleCount) },
              { label: "已有成本参数车辆数", children: formatInteger(summary?.vehicleWithCostProfileCount) },
              { label: "缺少成本参数车辆数", children: formatInteger(summary?.vehicleMissingCostProfileCount) },
              { label: "成本可计算车辆数", children: formatInteger(summary?.costCalculatedVehicleCount) },
              { label: "成本不可计算车辆数", children: formatInteger(summary?.costUnavailableVehicleCount) },
              { label: "可计算 ROE 车辆数", children: formatInteger(summary?.roeCalculatedVehicleCount) },
              { label: "不可计算 ROE 车辆数", children: formatInteger(summary?.roeUnavailableVehicleCount) },
              { label: "可用残值预测车辆数", children: formatInteger(summary?.residualForecastVehicleCount) },
              { label: "缺少残值预测车辆数", children: formatInteger(summary?.residualForecastMissingVehicleCount) },
              {
                label: "不支持残值预测车辆数",
                children: formatInteger(summary?.residualForecastUnsupportedVehicleCount)
              },
              { label: "已采用残值预测车辆数", children: formatInteger(summary?.residualForecastAdoptedVehicleCount) }
            ]}
            size="small"
          />
        </MetricGroupCard>

        <MetricGroupCard loading={loading} title="收入归属拆解">
          <Descriptions
            bordered
            column={1}
            items={[
              { label: "租金实收", children: formatYuan(summary?.rentalPaidAmount) },
              { label: "损伤实收", children: formatYuan(summary?.damagePaidAmount) },
              { label: "其他实收", children: formatYuan(summary?.otherPaidAmount) },
              { label: "经营收入合计", children: formatYuan(summary?.operatingRevenueAmount) },
              { label: "转让 / 入池外流收入", children: formatYuan(summary?.assignedOutRevenueAmount) },
              { label: "质押收入金额", children: formatYuan(summary?.pledgedRevenueAmount) },
              { label: "车主分润金额", children: formatYuan(summary?.ownerShareAmount) },
              { label: "平台留存经营收入", children: formatYuan(summary?.platformRetainedRevenueAmount) },
              { label: "押金收取", children: formatYuan(summary?.depositCollectedAmount) }
            ]}
            size="small"
          />
          <Typography.Text type="secondary">
            质押收入金额不扣减平台收入；押金收取不计入经营收入。
          </Typography.Text>
        </MetricGroupCard>

        <MetricGroupCard loading={loading} title="成本与资本结构拆解">
          <Descriptions
            bordered
            column={1}
            items={[
              { label: "折旧成本", children: formatYuan(summary?.depreciationCostAmount) },
              { label: "资金成本", children: formatYuan(summary?.capitalCostAmount) },
              { label: "债务利息成本", children: formatYuan(summary?.debtInterestCostAmount) },
              { label: "保险成本", children: formatYuan(summary?.insuranceCostAmount) },
              { label: "维修准备金", children: formatYuan(summary?.maintenanceReserveCostAmount) },
              { label: "其他成本", children: formatYuan(summary?.otherCostAmount) },
              { label: "外部长租成本", children: formatYuan(summary?.externalLeaseCostAmount) },
              { label: "经营成本合计", children: formatYuan(summary?.operatingCostAmount) },
              { label: "债务本金", children: formatYuan(summary?.debtPrincipalAmount) },
              { label: "权益资本基数", children: formatYuan(summary?.roeEquityBaseAmount) },
              { label: "资金成本来源", children: labelOf(CAPITAL_COST_SOURCE_LABELS, summary?.capitalCostSource) }
            ]}
            size="small"
          />
        </MetricGroupCard>

        <MetricGroupCard loading={loading} title="资产价值与残值敏感性">
          <Descriptions
            bordered
            column={1}
            items={[
              { label: "采购价合计", children: formatYuan(summary?.purchasePriceAmount) },
              { label: "当前销售价合计", children: formatYuan(summary?.currentSalePriceAmount) },
              { label: "预测残值合计", children: formatYuan(summary?.forecastResidualAmount) },
              { label: "预测下界合计", children: formatYuan(summary?.forecastLowerBoundAmount) },
              { label: "预测上界合计", children: formatYuan(summary?.forecastUpperBoundAmount) },
              { label: "相对当前销售价差异", children: renderSignedYuan(summary?.residualDeltaToCurrentSalePriceAmount) },
              { label: "相对成本参数残值差异", children: renderSignedYuan(summary?.residualDeltaToCostProfileAmount) },
              { label: "残值敏感性净收益", children: formatYuan(summary?.residualSensitivityNetIncomeAmount) },
              { label: "残值敏感性 ROE", children: formatPercent(summary?.residualSensitivityRoeTrial) },
              { label: "年化残值敏感性 ROE", children: formatPercent(summary?.residualSensitivityAnnualizedRoeTrial) }
            ]}
            size="small"
          />
          <Typography.Text type="secondary">残值敏感性 ROE 不改变主试算 ROE。</Typography.Text>
        </MetricGroupCard>
      </div>

      <Collapse
        items={[
          {
            children: (
              <Space orientation="vertical" size={4}>
                <Typography.Text>经营收入合计 = 租金实收 + 损伤实收 + 其他实收</Typography.Text>
                <Typography.Text>
                  平台留存经营收入 = 经营收入合计 - 转让 / 入池外流收入 - 车主分润金额
                </Typography.Text>
                <Typography.Text>
                  经营成本合计 = 折旧成本 + 资金成本 / 债务利息 + 保险成本 + 维修准备金 + 其他成本 +
                  外部长租固定成本
                </Typography.Text>
                <Typography.Text>平台权益净收益 = 平台留存经营收入 - 经营成本合计</Typography.Text>
                <Typography.Text>试算 ROE = 平台权益净收益 / 权益资本基数</Typography.Text>
                <Typography.Text>
                  残值敏感性净收益 = 平台权益净收益 + 预测残值相对成本参数预计残值的差异
                </Typography.Text>
                <Typography.Text>残值敏感性 ROE = 残值敏感性净收益 / 权益资本基数</Typography.Text>
              </Space>
            ),
            key: "return-trial-chain",
            label: "计算链路 / 钩稽关系"
          }
        ]}
        size="small"
      />
      {missingReasons.length > 0 ? (
        <ReasonAlert items={missingReasons} title="ROE 不可用原因" type="warning" />
      ) : null}
      {warnings.length > 0 ? (
        <ReasonAlert items={warnings} title="ROE 试算提示" type="info" />
      ) : null}
      {residualWarnings.length > 0 ? (
        <ReasonAlert items={residualWarnings} title="残值预测敏感性提示" type="info" />
      ) : null}
    </Space>
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
  const capitalSummary = detail.capitalStructureSummary ?? {};
  const roeBreakdown = detail.roeBreakdown ?? {};
  const roeMissingReasons = normalizeReasonList(returns.roeMissingReasons);
  if (roeMissingReasons.length === 0 && returns.roeUnavailableReason) {
    roeMissingReasons.push(returns.roeUnavailableReason);
  }
  const roeWarnings = normalizeReasonList(returns.roeWarnings);
  const residualForecastSummary = detail.residualForecastSummary ?? null;
  const residualForecastPoint = detail.residualForecastPoint ?? null;
  const residualForecastCurveSummary = detail.residualForecastCurveSummary ?? null;
  const residualForecastWarnings = normalizeReasonList(
    returns.residualForecastWarnings?.length
      ? returns.residualForecastWarnings
      : residualForecastSummary?.warnings
  );

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
          <Alert
            showIcon
            type="info"
            message="押金收取单独列示，不计入经营收入；质押收入不扣减平台收入，仅作为现金流受限提示。"
          />
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "租金实收", children: formatYuan(income.rentalPaidAmount) },
              { label: "损伤实收", children: formatYuan(income.damagePaidAmount) },
              { label: "其他实收", children: formatYuan(income.otherPaidAmount) },
              { label: "转让 / 入池外流收入", children: formatYuan(income.assignedOutRevenueAmount) },
              { label: "质押收入金额", children: formatYuan(income.pledgedRevenueAmount) },
              { label: "车主分润金额", children: formatYuan(income.ownerShareAmount) },
              { label: "平台留存经营收入", children: formatYuan(income.platformRetainedRevenueAmount) },
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

      <DetailSection title="资本结构摘要">
        <Space orientation="vertical" size={8} style={{ width: "100%" }}>
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "债务本金", children: formatYuan(capitalSummary.debtPrincipalAmount) },
              { label: "债务利息成本", children: formatYuan(capitalSummary.debtInterestCostAmount) },
              { label: "权益资本基数", children: formatYuan(capitalSummary.equityCapitalAmount) },
              {
                label: "资金成本来源",
                children: labelOf(CAPITAL_COST_SOURCE_LABELS, capitalSummary.capitalCostSource)
              }
            ]}
            size="small"
          />
          <Table
            columns={financingAllocationColumns(detail.dateRange)}
            dataSource={detail.financingAllocations ?? []}
            locale={{ emptyText: "暂无融资工具分摊明细" }}
            pagination={false}
            rowKey={(record) => record.id ?? record.allocationNo ?? "financing-allocation"}
            scroll={{ x: 980 }}
            size="small"
          />
        </Space>
      </DetailSection>

      <DetailSection title="收益权 assignment 明细">
        <Space orientation="vertical" size={8} style={{ width: "100%" }}>
          <Alert
            showIcon
            type="info"
            message="PLEDGE 为收益权质押，不扣减平台收入；TRANSFER / SPV_POOL 会扣减平台留存收入。"
          />
          <Table
            columns={revenueRightAssignmentColumns}
            dataSource={detail.revenueRightAssignments ?? []}
            locale={{ emptyText: "暂无收益权 assignment 明细" }}
            pagination={false}
            rowKey={(record) => record.id ?? record.assignmentNo ?? "revenue-right-assignment"}
            scroll={{ x: 1180 }}
            size="small"
          />
        </Space>
      </DetailSection>

      <DetailSection title="分润规则摘要">
        <Space orientation="vertical" size={8} style={{ width: "100%" }}>
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "车主分润金额", children: formatYuan(roeBreakdown.ownerShareAmount) },
              { label: "平台留存金额", children: formatYuan(roeBreakdown.platformRetainedRevenueAmount) },
              { label: "外部长租成本", children: formatYuan(roeBreakdown.externalLeaseCostAmount) }
            ]}
            size="small"
          />
          <Table
            columns={revenueShareRuleColumns}
            dataSource={detail.revenueShareRules ?? []}
            locale={{ emptyText: "暂无分润规则" }}
            pagination={false}
            rowKey={(record) => record.id ?? record.ruleNo ?? "revenue-share-rule"}
            scroll={{ x: 980 }}
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
            { label: "平台权益净收益", children: formatYuan(returns.platformNetIncomeAmount) },
            { label: "权益资本基数", children: formatYuan(returns.roeEquityBaseAmount) },
            { label: "试算 ROE", children: formatTrialRoe(returns.roeTrial) },
            { label: "年化试算 ROE", children: formatPercent(returns.annualizedRoeTrial) },
            { label: "ROE 状态", children: returns.roeTrial === null ? "暂不可用" : "可试算" },
            { label: "ROE 不可用原因", children: safeText(returns.roeUnavailableReason) }
          ]}
          size="small"
        />
        {roeMissingReasons.length > 0 ? (
          <ReasonAlert items={roeMissingReasons} title="ROE 不可用原因" type="warning" />
        ) : null}
        {roeWarnings.length > 0 ? (
          <ReasonAlert items={roeWarnings} title="ROE 试算提示" type="info" />
        ) : null}
      </DetailSection>

      <DetailSection title="残值预测敏感性">
        <Space orientation="vertical" size={8} style={{ width: "100%" }}>
          <Alert
            showIcon
            type="info"
            message="残值敏感性 ROE 只作为收益试算补充分析，不替换主试算 ROE；预测残值不会自动覆盖车辆当前销售价，也不会写入销售价历史。"
          />
          <Descriptions
            bordered
            column={2}
            items={[
              {
                label: "是否有可用预测",
                children: renderResidualForecastAvailabilityValue(
                  residualForecastSummary?.available ?? returns.residualForecastAvailable,
                  residualForecastSummary?.unavailableReason ?? returns.residualForecastUnavailableReason
                )
              },
              {
                label: "不可用原因",
                children: safeText(
                  residualForecastSummary?.unavailableReason ?? returns.residualForecastUnavailableReason
                )
              },
              { label: "预测编号", children: safeText(residualForecastSummary?.forecastNo) },
              {
                label: "预测状态",
                children: labelOf(
                  VEHICLE_RESIDUAL_FORECAST_STATUS_LABELS,
                  residualForecastSummary?.forecastStatus
                )
              },
              {
                label: "预测方法",
                children: labelOf(
                  VEHICLE_RESIDUAL_FORECAST_METHOD_LABELS,
                  residualForecastSummary?.forecastMethod
                )
              },
              { label: "预测基准日", children: formatDate(residualForecastSummary?.asOfDate) },
              { label: "预测周期", children: formatHorizonMonth(residualForecastSummary?.horizonMonth) },
              { label: "目标日期", children: formatDate(residualForecastSummary?.targetDate) },
              { label: "目标车龄（月）", children: formatInteger(residualForecastPoint?.targetAgeMonth) },
              { label: "引用曲线编号", children: safeText(residualForecastSummary?.curveNo) },
              {
                label: "预测值来源",
                children: labelOf(FORECAST_RESIDUAL_AMOUNT_SOURCE_LABELS, residualForecastSummary?.amountSource)
              },
              { label: "预测残值", children: formatYuan(residualForecastPoint?.forecastResidualAmount) },
              { label: "预测残值率", children: formatBps(residualForecastPoint?.predictedResidualRateBps) },
              { label: "预测下界", children: formatYuan(residualForecastPoint?.lowerBoundAmount) },
              { label: "预测上界", children: formatYuan(residualForecastPoint?.upperBoundAmount) },
              { label: "置信度", children: formatScore(residualForecastPoint?.confidenceScore) }
            ]}
            size="small"
          />
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "当前内部销售价", children: formatYuan(vehicle.currentSalePriceAmount) },
              { label: "成本参数预计残值", children: formatYuan(costProfile?.residualValueAmount) },
              { label: "预测残值", children: formatYuan(residualForecastPoint?.forecastResidualAmount) },
              {
                label: "相对当前销售价差异",
                children: renderSignedYuan(returns.residualDeltaToCurrentSalePriceAmount)
              },
              {
                label: "相对成本参数残值差异",
                children: renderSignedYuan(returns.residualDeltaToCostProfileAmount)
              },
              {
                label: "说明",
                children: "相对成本参数残值差异用于残值敏感性 ROE 试算。"
              }
            ]}
            size="small"
          />
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "主平台权益净收益", children: formatYuan(returns.platformNetIncomeAmount) },
              {
                label: "残值敏感性净收益",
                children: formatYuan(returns.residualSensitivityNetIncomeAmount)
              },
              { label: "主试算 ROE", children: formatTrialRoe(returns.roeTrial) },
              { label: "残值敏感性 ROE", children: formatPercent(returns.residualSensitivityRoeTrial) },
              { label: "主年化试算 ROE", children: formatPercent(returns.annualizedRoeTrial) },
              {
                label: "年化残值敏感性 ROE",
                children: formatPercent(returns.residualSensitivityAnnualizedRoeTrial)
              }
            ]}
            size="small"
          />
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "曲线编号", children: safeText(residualForecastCurveSummary?.curveNo) },
              { label: "品牌", children: safeText(residualForecastCurveSummary?.brand) },
              { label: "车系", children: safeText(residualForecastCurveSummary?.series) },
              { label: "车型", children: safeText(residualForecastCurveSummary?.model) },
              { label: "年款", children: safeText(residualForecastCurveSummary?.modelYear) },
              { label: "电池容量", children: formatKwh(residualForecastCurveSummary?.batteryCapacityKwh) },
              {
                label: "电池使用方式",
                children: labelOf(
                  VEHICLE_BATTERY_USAGE_TYPE_LABELS,
                  residualForecastCurveSummary?.batteryUsageType
                )
              },
              {
                label: "曲线状态",
                children: labelOf(
                  VEHICLE_RESIDUAL_CURVE_STATUS_LABELS,
                  residualForecastCurveSummary?.curveStatus
                )
              },
              {
                label: "曲线方法",
                children: labelOf(
                  VEHICLE_RESIDUAL_CURVE_METHOD_LABELS,
                  residualForecastCurveSummary?.curveMethod
                )
              },
              { label: "曲线置信度", children: formatScore(residualForecastCurveSummary?.confidenceScore) }
            ]}
            size="small"
          />
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "曲线预测残值", children: formatYuan(residualForecastPoint?.predictedResidualAmount) },
              { label: "人工采用值", children: formatYuan(residualForecastPoint?.adoptedResidualAmount) },
              {
                label: "预测值来源",
                children: labelOf(FORECAST_RESIDUAL_AMOUNT_SOURCE_LABELS, residualForecastSummary?.amountSource)
              },
              { label: "下界", children: formatYuan(residualForecastPoint?.lowerBoundAmount) },
              { label: "上界", children: formatYuan(residualForecastPoint?.upperBoundAmount) },
              { label: "残值率", children: formatBps(residualForecastPoint?.predictedResidualRateBps) },
              { label: "置信度", children: formatScore(residualForecastPoint?.confidenceScore) },
              {
                label: "插值方法",
                children: labelOf(
                  RESIDUAL_FORECAST_INTERPOLATION_METHOD_LABELS,
                  residualForecastPoint?.interpolationMethod
                )
              },
              {
                label: "预测点状态",
                children: labelOf(
                  VEHICLE_RESIDUAL_FORECAST_POINT_STATUS_LABELS,
                  residualForecastPoint?.pointStatus
                )
              },
              {
                label: "匹配曲线点车龄",
                children: formatInteger(residualForecastPoint?.matchedCurvePointAgeMonth)
              }
            ]}
            size="small"
          />
          {residualForecastWarnings.length > 0 ? (
            <ReasonAlert items={residualForecastWarnings} title="残值预测敏感性提示" type="info" />
          ) : null}
        </Space>
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

function ReasonAlert({
  items,
  title,
  type
}: {
  items: string[];
  title: string;
  type: "info" | "warning";
}) {
  return (
    <Alert
      showIcon
      title={title}
      type={type}
      description={
        <Space size={[6, 6]} wrap>
          {items.map((item) => (
            <Tag key={item} color={type === "warning" ? "orange" : "blue"}>
              {item}
            </Tag>
          ))}
        </Space>
      }
    />
  );
}

function financingAllocationColumns(
  dateRange?: DateRangeResponse
): ColumnsType<ReturnTrialFinancingAllocationRow> {
  return [
    {
      render: (_value, record) => safeText(record.instrument?.instrumentNo ?? record.instrumentId),
      title: "融资工具编号",
      width: 160
    },
    {
      render: (_value, record) =>
        labelOf(FINANCING_INSTRUMENT_TYPE_LABELS, record.instrument?.instrumentType),
      title: "融资类型",
      width: 150
    },
    {
      render: (_value, record) => safeText(record.instrument?.lenderName),
      title: "资金方",
      width: 140
    },
    { dataIndex: "allocatedPrincipalAmount", render: formatYuan, title: "分摊本金", width: 130 },
    {
      render: (_value, record) => formatBps(record.instrument?.annualRateBps),
      title: "年化利率",
      width: 110
    },
    {
      render: (_value, record) => formatYuan(allocationDebtInterestAmount(record, dateRange)),
      title: "债务利息成本",
      width: 140
    },
    { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
    {
      dataIndex: "allocationStatus",
      render: (value?: string | null) => labelOf(FINANCING_ALLOCATION_STATUS_LABELS, value),
      title: "分摊状态",
      width: 110
    },
    {
      render: (_value, record) =>
        labelOf(FINANCING_REPAYMENT_METHOD_LABELS, record.instrument?.repaymentMethod),
      title: "还款方式",
      width: 140
    }
  ];
}

const revenueRightAssignmentColumns: ColumnsType<ReturnTrialRevenueRightAssignmentRow> = [
  { dataIndex: "assignmentNo", render: safeText, title: "收益权编号", width: 170 },
  {
    dataIndex: "assignmentType",
    render: (value?: string | null) => labelOf(REVENUE_RIGHT_ASSIGNMENT_TYPE_LABELS, value),
    title: "类型",
    width: 130
  },
  {
    dataIndex: "assignmentStatus",
    render: (value?: string | null) => labelOf(REVENUE_RIGHT_ASSIGNMENT_STATUS_LABELS, value),
    title: "状态",
    width: 100
  },
  {
    dataIndex: "targetType",
    render: (value?: string | null) => labelOf(REVENUE_RIGHT_TARGET_TYPE_LABELS, value),
    title: "目标类型",
    width: 120
  },
  { render: (_value, record) => revenueRightTargetText(record), title: "目标对象", width: 180 },
  {
    render: (_value, record) =>
      safeText(record.financingInstrument?.instrumentNo ?? record.financingInstrumentId),
    title: "融资工具",
    width: 160
  },
  {
    render: (_value, record) =>
      `${labelOf(REVENUE_RIGHT_ASSIGNEE_TYPE_LABELS, record.assigneeType)} / ${safeText(
        record.assigneeName
      )}`,
    title: "受让 / 质押方",
    width: 190
  },
  { dataIndex: "shareRatioBps", render: formatBps, title: "分配比例", width: 110 },
  { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
  { dataIndex: "releasedAt", render: formatDate, title: "解除日期", width: 120 }
];

const revenueShareRuleColumns: ColumnsType<ReturnTrialRevenueShareRuleRow> = [
  { dataIndex: "ruleNo", render: safeText, title: "规则编号", width: 170 },
  {
    dataIndex: "ruleType",
    render: (value?: string | null) => labelOf(REVENUE_SHARE_RULE_TYPE_LABELS, value),
    title: "规则类型",
    width: 140
  },
  {
    dataIndex: "ruleStatus",
    render: (value?: string | null) => labelOf(REVENUE_SHARE_RULE_STATUS_LABELS, value),
    title: "状态",
    width: 100
  },
  {
    dataIndex: "shareBasis",
    render: (value?: string | null) => labelOf(REVENUE_SHARE_BASIS_LABELS, value),
    title: "分润基础",
    width: 130
  },
  { dataIndex: "ownerName", render: safeText, title: "外部车主", width: 130 },
  { dataIndex: "ownerShareBps", render: formatBps, title: "车主分成比例", width: 130 },
  { dataIndex: "platformShareBps", render: formatBps, title: "平台分成比例", width: 130 },
  { dataIndex: "fixedMonthlyAmount", render: formatYuan, title: "固定月金额", width: 130 },
  {
    render: (_value, record) => revenueShareSupportText(record),
    title: "是否支持试算",
    width: 140
  },
  { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 }
];

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

function renderRoeStatus(
  record: Pick<AssetReturnTrialVehicleRow, "roeDataReady" | "roeMissingReasons" | "roeTrial" | "roeWarnings">
) {
  const missingReasons = normalizeReasonList(record.roeMissingReasons);
  const warnings = normalizeReasonList(record.roeWarnings);
  const ready = record.roeDataReady === true && record.roeTrial !== null && record.roeTrial !== undefined;
  const tooltip = (
    <Space orientation="vertical" size={4}>
      {missingReasons.length > 0 ? (
        <span>不可用原因：{missingReasons.join("；")}</span>
      ) : (
        <span>{ready ? "ROE 数据已满足试算条件。" : "ROE 暂不可用。"}</span>
      )}
      {warnings.length > 0 ? <span>提示：{warnings.join("；")}</span> : null}
    </Space>
  );

  return (
    <Space size={4}>
      <Tooltip title={tooltip}>
        <Tag color={ready ? "green" : "orange"}>{ready ? "可试算" : "暂不可用"}</Tag>
      </Tooltip>
      {warnings.length > 0 ? (
        <Tooltip title={warnings.join("；")}>
          <Tag color="blue" icon={<InfoCircleOutlined />}>
            有提示
          </Tag>
        </Tooltip>
      ) : null}
    </Space>
  );
}

function renderResidualForecastStatus(
  record: Pick<
    AssetReturnTrialVehicleRow,
    "residualForecastAvailable" | "residualForecastUnavailableReason" | "residualForecastWarnings"
  >
) {
  const warnings = normalizeReasonList(record.residualForecastWarnings);
  const available = record.residualForecastAvailable === true;
  const unavailableReason = safeText(record.residualForecastUnavailableReason);
  const tooltip = (
    <Space orientation="vertical" size={4}>
      <span>{available ? "该车辆有可用于本周期的残值预测点。" : unavailableReason}</span>
      {warnings.length > 0 ? <span>提示：{warnings.join("；")}</span> : null}
    </Space>
  );

  return (
    <Space size={4}>
      <Tooltip title={tooltip}>
        <Tag color={available ? "green" : "orange"}>{available ? "可用" : "不可用"}</Tag>
      </Tooltip>
      {warnings.length > 0 ? (
        <Tooltip title={warnings.join("；")}>
          <Tag color="blue" icon={<InfoCircleOutlined />}>
            有提示
          </Tag>
        </Tooltip>
      ) : null}
    </Space>
  );
}

function renderResidualForecastAvailabilityValue(available?: boolean | null, reason?: string | null) {
  if (available === true) {
    return <Tag color="green">可用</Tag>;
  }

  return (
    <Tooltip title={safeText(reason)}>
      <Tag color="orange">不可用</Tag>
    </Tooltip>
  );
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

function allocationDebtInterestAmount(
  record: ReturnTrialFinancingAllocationRow,
  dateRange?: DateRangeResponse
) {
  const principal = safeNumber(record.allocatedPrincipalAmount);
  const annualRateBps = safeNumber(record.instrument?.annualRateBps);
  const overlapDays = overlapDaysForDisplay(record.effectiveFrom, record.effectiveTo, dateRange);

  if (principal === null || annualRateBps === null || overlapDays === null) {
    return null;
  }

  return Math.round((principal * annualRateBps * overlapDays) / 10000 / 365);
}

function revenueRightTargetText(record: ReturnTrialRevenueRightAssignmentRow) {
  if (record.targetType === "ORDER") {
    return `订单：${safeText(record.order?.orderNo ?? record.orderId)}`;
  }
  if (record.targetType === "RECEIVABLE_BILL") {
    return `账单：${safeText(record.bill?.billNo ?? record.billId)}`;
  }
  if (record.targetType === "VEHICLE") {
    return `车辆：${safeText(record.vehicleId)}`;
  }
  if (record.targetType === "VEHICLE_POOL") {
    return "车辆池：暂未开放精算";
  }
  return "-";
}

function revenueShareSupportText(record: ReturnTrialRevenueShareRuleRow) {
  if (record.shareBasis === "GROSS_RECEIVABLE") {
    return (
      <Tooltip title="GROSS_RECEIVABLE 分润口径暂未接入 ROE 试算。">
        <Tag color="orange">暂不支持</Tag>
      </Tooltip>
    );
  }

  if (record.shareBasis === "MANUAL") {
    return (
      <Tooltip title="MANUAL 分润口径需人工结算，暂未接入 ROE 试算。">
        <Tag color="orange">暂不支持</Tag>
      </Tooltip>
    );
  }

  return <Tag color="green">支持试算</Tag>;
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

function calculateDelta(left?: number | null, right?: number | null) {
  const leftValue = safeNumber(left);
  const rightValue = safeNumber(right);
  if (leftValue === null || rightValue === null) {
    return null;
  }

  return leftValue - rightValue;
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
  })}\u00A0元`;
}

function formatSignedYuan(value?: number | null) {
  const numberValue = safeNumber(value);
  if (numberValue === null) {
    return "-";
  }

  const sign = numberValue > 0 ? "+" : numberValue < 0 ? "-" : "";
  return `${sign}${formatYuan(Math.abs(numberValue))}`;
}

function renderSignedYuan(value?: number | null) {
  const numberValue = safeNumber(value);
  if (numberValue === null) {
    return "-";
  }

  return (
    <Typography.Text type={numberValue > 0 ? "success" : numberValue < 0 ? "danger" : undefined}>
      {formatSignedYuan(numberValue)}
    </Typography.Text>
  );
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

function formatTrialRoe(value?: number | null) {
  return value === null ? "暂不可用" : formatPercent(value);
}

function formatHorizonMonth(value?: number | null) {
  const numberValue = safeNumber(value);
  if (numberValue === null) {
    return "-";
  }

  const horizonMonth = Math.trunc(numberValue);
  return horizonMonth === 0 ? "当前" : `未来 ${horizonMonth} 个月`;
}

function formatScore(value?: number | null) {
  const numberValue = safeNumber(value);
  if (numberValue === null) {
    return "-";
  }

  return `${Math.round(numberValue)} 分`;
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

function overlapDaysForDisplay(
  effectiveFrom?: string | null,
  effectiveTo?: string | null,
  dateRange?: DateRangeResponse
) {
  if (!effectiveFrom || !dateRange?.startDate || !dateRange.endDate) {
    return null;
  }

  const rangeStart = dayjs(dateRange.startDate).startOf("day");
  const rangeEnd = dayjs(dateRange.endDate).startOf("day");
  const eventStart = dayjs(effectiveFrom).startOf("day");
  const eventEnd = effectiveTo ? dayjs(effectiveTo).startOf("day") : rangeEnd;

  if (!rangeStart.isValid() || !rangeEnd.isValid() || !eventStart.isValid() || !eventEnd.isValid()) {
    return null;
  }

  const start = eventStart.isAfter(rangeStart) ? eventStart : rangeStart;
  const end = eventEnd.isBefore(rangeEnd) ? eventEnd : rangeEnd;

  if (start.isAfter(end)) {
    return 0;
  }

  return end.diff(start, "day") + 1;
}

function normalizeReasonList(values?: string[] | null) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
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
