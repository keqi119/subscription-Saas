"use client";

import {
  CarOutlined,
  DollarOutlined,
  EditOutlined,
  EyeOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  SyncOutlined
} from "@ant-design/icons";
import {
  App,
  Alert,
  Button,
  Collapse,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  type FormInstance,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../components/action-button";
import { ProtectedShell } from "../../components/protected-shell";
import {
  FINANCING_INSTRUMENT_TYPE_LABELS,
  REVENUE_SHARE_BASIS_LABELS,
  REVENUE_SHARE_RULE_STATUS_LABELS,
  REVENUE_SHARE_RULE_TYPE_LABELS,
  REVENUE_SHARE_SETTLEMENT_CYCLE_LABELS,
  SALE_PRICE_REVIEW_TYPE_LABELS,
  STATUS_LABELS,
  RESIDUAL_FORECAST_INTERPOLATION_METHOD_LABELS,
  VEHICLE_ACQUISITION_MODE_LABELS,
  VEHICLE_BATTERY_USAGE_TYPE_LABELS,
  VEHICLE_CAPITAL_EVENT_STATUS_LABELS,
  VEHICLE_CAPITAL_EVENT_TYPE_LABELS,
  VEHICLE_RESIDUAL_CURVE_METHOD_LABELS,
  VEHICLE_RESIDUAL_CURVE_STATUS_LABELS,
  VEHICLE_RESIDUAL_FORECAST_METHOD_LABELS,
  VEHICLE_RESIDUAL_FORECAST_POINT_STATUS_LABELS,
  VEHICLE_RESIDUAL_FORECAST_STATUS_LABELS,
  VEHICLE_VALUATION_REVIEW_SOURCE_LABELS,
  VEHICLE_VALUATION_REVIEW_STATUS_LABELS,
  labelOf
} from "../../constants/labels";
import {
  actionAvailability,
  canInitializeVehicleSalePrice,
  canReviewVehicleSalePrice,
  canUpdateVehicleStatus
} from "../../lib/action-guards";
import { apiFetch, ApiError } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";
import {
  formatPercentFromBps,
  formatRatio,
  formatYuan as formatCapitalYuan,
  optionsFromLabels,
  percentToBps,
  toCentAmount
} from "../../lib/capital-format";

interface Vehicle {
  acquisitionMode?: string | null;
  assetLocation?: string | null;
  batteryCapacityKwh?: number | null;
  batteryUsageType?: string | null;
  batteryUsageTypeLabel?: string | null;
  brand: string;
  currentMileageKm: number;
  currentSalePriceAmount?: number | null;
  currentSalePriceInitializedAt?: string | null;
  currentSalePriceReviewedAt?: string | null;
  id: string;
  insuranceEndDate?: string | null;
  insuranceStartDate?: string | null;
  latestRegistrationDate?: string | null;
  model?: string | null;
  modelYear?: number | null;
  nextSalePriceReviewAt?: string | null;
  plateNo?: string | null;
  purchaseDate?: string | null;
  purchasePriceAmount: number;
  registrationDate?: string | null;
  remark?: string | null;
  salePriceHistories?: SalePriceHistory[];
  salePriceReinitRequiredAt?: string | null;
  salePriceStatus: string;
  series?: string | null;
  status: string;
  vehicleModel?: string | null;
  vehicleNo: string;
  vin?: string | null;
}

interface SalePriceHistory {
  afterSalePriceAmount: number;
  beforeSalePriceAmount?: number | null;
  createdAt: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  id: string;
  reason: string;
  remark?: string | null;
  reviewQuarter?: string | null;
  reviewType: string;
}

interface CreateVehicleValues {
  assetLocation?: string | null;
  batteryCapacityKwh?: number | null;
  batteryUsageType?: "BUYOUT" | "BAAS";
  brand: string;
  currentMileageKm?: number;
  model?: string | null;
  modelYear?: number | null;
  plateNo?: string | null;
  insuranceEndDate?: Dayjs | null;
  insuranceStartDate?: Dayjs | null;
  purchaseDate?: Dayjs | null;
  purchasePriceAmountYuan: number;
  registrationDate?: Dayjs | null;
  latestRegistrationDate?: Dayjs | null;
  remark?: string | null;
  series?: string | null;
  vehicleModel: "ET5" | "ET7" | "ES6";
  vin: string;
}

type EditVehicleValues = CreateVehicleValues;

interface InitializeSalePriceValues {
  currentSalePriceAmountYuan: number;
  effectiveFrom: Dayjs;
  reason: string;
  remark?: string | null;
  reviewType: "INITIAL_POOL" | "RETURN_REINIT";
}

interface ReviewSalePriceValues {
  effectiveFrom: Dayjs;
  newSalePriceAmountYuan: number;
  reason: string;
  remark?: string | null;
  reviewQuarter: string;
}

interface StatusValues {
  remark?: string | null;
  status: string;
}

interface FinancingInstrumentSummary {
  annualRateBps?: number | null;
  contractNo?: string | null;
  id: string;
  instrumentNo?: string | null;
  instrumentStatus?: string | null;
  instrumentType?: string | null;
  lenderName?: string | null;
  principalAmount?: number | null;
  repaymentMethod?: string | null;
}

interface FinancingInstrumentListResponse {
  items: FinancingInstrumentSummary[];
  page: number;
  pageSize: number;
  total: number;
}

interface CapitalEvent {
  acquisitionMode?: string | null;
  debtPrincipalAmount?: number | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  equityCapitalAmount?: number | null;
  eventNo: string;
  eventStatus: string;
  eventType: string;
  externalOwnerName?: string | null;
  financingInstrument?: FinancingInstrumentSummary | null;
  financingInstrumentId?: string | null;
  id: string;
  lessorName?: string | null;
  managedOwnerName?: string | null;
  remark?: string | null;
}

interface FinancingAllocation {
  allocationNo?: string | null;
  allocatedPrincipalAmount: number;
  allocationRatioBps?: number | null;
  allocationStatus: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  financingInstrument?: FinancingInstrumentSummary | null;
  id: string;
  instrumentId?: string | null;
  remark?: string | null;
}

interface CapitalStructurePreview {
  acquisitionMode?: string | null;
  activeCapitalEvents?: CapitalEvent[];
  activeFinancingAllocations?: FinancingAllocation[];
  annualDebtInterestAmount?: number | null;
  capitalCoverageAmount?: number | null;
  capitalCoverageIncomplete?: boolean;
  capitalCoverageRatio?: number | null;
  debtPrincipalAmount?: number | null;
  equityCapitalAmount?: number | null;
  financingInstruments?: FinancingInstrumentSummary[];
  missingReasons?: string[];
  monthlyDebtInterestAmount?: number | null;
  purchasePriceAmount?: number | null;
  roeDataReady?: boolean;
}

interface CapitalEventValues {
  acquisitionMode?: string | null;
  debtPrincipalAmountYuan?: number | null;
  effectiveFrom: Dayjs;
  effectiveTo?: Dayjs | null;
  equityCapitalAmountYuan?: number | null;
  eventType: string;
  externalOwnerName?: string | null;
  financingInstrumentId?: string | null;
  lessorName?: string | null;
  managedOwnerName?: string | null;
  remark?: string | null;
}

interface RevenueShareRule {
  effectiveFrom: string;
  effectiveTo?: string | null;
  fixedMonthlyAmount?: number | null;
  id: string;
  minimumGuaranteeAmount?: number | null;
  ownerContact?: string | null;
  ownerName?: string | null;
  ownerShareBps?: number | null;
  platformShareBps?: number | null;
  remark?: string | null;
  ruleNo: string;
  ruleStatus: string;
  ruleType: string;
  settlementCycle: string;
  shareBasis: string;
}

interface RevenueShareRuleValues {
  effectiveFrom: Dayjs;
  fixedMonthlyAmountYuan?: number | null;
  minimumGuaranteeAmountYuan?: number | null;
  ownerContact?: string | null;
  ownerName?: string | null;
  ownerSharePercent?: number | null;
  platformSharePercent?: number | null;
  remark?: string | null;
  ruleType: string;
  settlementCycle?: string | null;
  shareBasis: string;
}

interface DeactivateRevenueShareRuleValues {
  effectiveTo: Dayjs;
  remark?: string | null;
}

interface RevenueSharePreviewValues {
  endDate: Dayjs;
  startDate: Dayjs;
}

interface RevenueSharePreview {
  preview: {
    fixedCostAmount?: number | null;
    ownerShareAmount?: number | null;
    platformShareAmount?: number | null;
    previewSupported: boolean;
    shareBaseAmount?: number | null;
    unsupportedReason?: string | null;
    warnings?: string[];
  } | null;
  rule?: RevenueShareRule | null;
}

interface ResidualCurveSummary {
  batteryCapacityKwh?: number | null;
  batteryUsageType?: string | null;
  brand?: string | null;
  confidenceScore?: number | null;
  curveMethod?: string | null;
  curveNo?: string | null;
  curveStatus?: string | null;
  generatedAt?: string | null;
  id: string;
  model?: string | null;
  modelYear?: number | null;
  pointCount?: number | null;
  sampleCount?: number | null;
  series?: string | null;
  trim?: string | null;
}

interface ResidualCurveListResponse {
  items: ResidualCurveSummary[];
  page: number;
  pageSize: number;
  total: number;
}

interface VehicleResidualForecastPoint {
  adoptedAt?: string | null;
  adoptedBy?: string | null;
  adoptedResidualAmount?: number | null;
  adoptRemark?: string | null;
  confidenceScore?: number | null;
  forecastId?: string | null;
  horizonMonth: number;
  id?: string | null;
  interpolationMethod?: string | null;
  lowerBoundAmount?: number | null;
  matchedCurvePointAgeMonth?: number | null;
  pointSnapshot?: Record<string, unknown> | null;
  pointStatus: string;
  predictedResidualAmount?: number | null;
  predictedResidualRateBps?: number | null;
  targetAgeMonth?: number | null;
  targetDate: string;
  upperBoundAmount?: number | null;
}

interface VehicleResidualForecast {
  asOfDate: string;
  batteryCapacityKwh?: number | null;
  batteryUsageType?: string | null;
  brand?: string | null;
  createdAt?: string | null;
  currentMileageKm?: number | null;
  currentSalePriceAmount?: number | null;
  curve?: ResidualCurveSummary | null;
  curveId?: string | null;
  curveSnapshot?: Record<string, unknown> | null;
  forecastMethod: string;
  forecastNo?: string | null;
  forecastStatus: string;
  id?: string | null;
  inputSnapshot?: Record<string, unknown> | null;
  metrics?: Record<string, unknown> | null;
  model?: string | null;
  modelYear?: number | null;
  pointCount?: number | null;
  points?: VehicleResidualForecastPoint[];
  purchasePriceAmount?: number | null;
  remark?: string | null;
  series?: string | null;
  trim?: string | null;
  vehicleAgeMonths?: number | null;
  vehicleSnapshot?: Record<string, unknown> | null;
}

interface VehicleResidualForecastListResponse {
  items: VehicleResidualForecast[];
  page: number;
  pageSize: number;
  total: number;
}

interface VehicleResidualForecastGenerationResult {
  dryRun: boolean;
  forecast: VehicleResidualForecast;
  pointCount?: number | null;
  points?: VehicleResidualForecastPoint[];
}

interface VehicleValuationReviewVehicleSummary {
  brand?: string | null;
  currentSalePriceAmount?: number | null;
  currentSalePriceReviewedAt?: string | null;
  id: string;
  model?: string | null;
  nextSalePriceReviewAt?: string | null;
  plateNo?: string | null;
  salePriceStatus?: string | null;
  series?: string | null;
  status?: string | null;
  vehicleNo?: string | null;
  vin?: string | null;
}

interface VehicleValuationReviewForecastSummary {
  asOfDate?: string | null;
  forecastNo?: string | null;
  forecastStatus?: string | null;
  id: string;
  vehicleId?: string | null;
}

interface VehicleValuationReviewForecastPointSummary {
  adoptedResidualAmount?: number | null;
  confidenceScore?: number | null;
  horizonMonth?: number | null;
  id: string;
  pointStatus?: string | null;
  predictedResidualAmount?: number | null;
  targetDate?: string | null;
}

interface VehicleValuationReview {
  adoptedResidualAmount?: number | null;
  approvalSnapshot?: unknown;
  approvedAt?: string | null;
  approvedSalePriceAmount?: number | null;
  beforeSnapshot?: unknown;
  cancelReason?: string | null;
  cancelledAt?: string | null;
  createdAt?: string | null;
  createdBy?: string | null;
  forecast?: VehicleValuationReviewForecastSummary | null;
  forecastAmountSource?: string | null;
  forecastConfidenceScore?: number | null;
  forecastHorizonMonth?: number | null;
  forecastId?: string | null;
  forecastPoint?: VehicleValuationReviewForecastPointSummary | null;
  forecastPointId?: string | null;
  forecastResidualAmount?: number | null;
  forecastSnapshot?: unknown;
  forecastTargetDate?: string | null;
  id: string;
  originalSalePriceAmount?: number | null;
  reason?: string | null;
  rejectReason?: string | null;
  rejectedAt?: string | null;
  requestedAt?: string | null;
  requestedBy?: string | null;
  requestedSalePriceAmount: number;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  reviewNo: string;
  reviewRemark?: string | null;
  reviewSource: string;
  reviewStatus: string;
  snapshot?: unknown;
  updatedAt?: string | null;
  updatedBy?: string | null;
  vehicle?: VehicleValuationReviewVehicleSummary | null;
  vehicleId: string;
}

interface VehicleValuationReviewListResponse {
  items: VehicleValuationReview[];
  page: number;
  pageSize: number;
  total: number;
}

interface GenerateResidualForecastValues {
  asOfDate: Dayjs;
  curveId?: string | null;
  horizonMonthsText: string;
  remark?: string | null;
}

interface AdoptResidualForecastPointValues {
  adoptedResidualAmountYuan: number;
  adoptRemark?: string | null;
}

interface VoidResidualForecastValues {
  remark?: string | null;
}

interface CreateValuationReviewValues {
  reason?: string | null;
  requestedSalePriceAmountYuan: number;
  reviewRemark?: string | null;
}

interface CancelValuationReviewValues {
  cancelReason: string;
}

const salePriceStatusColors: Record<string, string> = {
  EFFECTIVE: "green",
  EXPIRED: "default",
  PENDING_INITIALIZE: "orange",
  REVIEW_DUE: "red"
};

const vehicleStatusColors: Record<string, string> = {
  AVAILABLE: "green",
  DRAFT: "default",
  IN_PREPARATION: "gold",
  LEASED: "purple",
  MAINTENANCE: "orange",
  RENTED: "purple",
  RESERVED: "blue",
  RETIRED: "default",
  RETURNED: "volcano"
};

const vehicleStatusOptions = [
  "DRAFT",
  "IN_PREPARATION",
  "AVAILABLE",
  "RESERVED",
  "LEASED",
  "RETURNED",
  "MAINTENANCE",
  "RETIRED"
].map((value) => ({ label: labelOf(STATUS_LABELS, value), value }));

const vehicleModelOptions = ["ET5", "ET7", "ES6"].map((value) => ({ label: value, value }));

const batteryUsageTypeOptions = [
  { label: "电池买断", value: "BUYOUT" },
  { label: "BaaS / 电池租用", value: "BAAS" }
];

const acquisitionModeOptions = optionsFromLabels(VEHICLE_ACQUISITION_MODE_LABELS);
const capitalEventTypeOptions = optionsFromLabels(VEHICLE_CAPITAL_EVENT_TYPE_LABELS);
const revenueShareRuleTypeOptions = optionsFromLabels(REVENUE_SHARE_RULE_TYPE_LABELS);
const revenueShareBasisOptions = optionsFromLabels(REVENUE_SHARE_BASIS_LABELS);
const revenueShareSettlementCycleOptions = optionsFromLabels(REVENUE_SHARE_SETTLEMENT_CYCLE_LABELS);
const financingCapitalEventTypes = new Set([
  "ADD_DEBT_FINANCING",
  "REFINANCE",
  "EARLY_SETTLEMENT",
  "FINANCING_RELEASE"
]);
const debtFinancingCapitalEventTypes = new Set(["ADD_DEBT_FINANCING", "REFINANCE"]);
const financingReleaseCapitalEventTypes = new Set(["EARLY_SETTLEMENT", "FINANCING_RELEASE"]);
const leaseCapitalEventTypes = new Set(["LEASE_IN", "LEASE_TERMINATION"]);
const managedCapitalEventTypes = new Set(["MANAGED_IN", "MANAGED_TERMINATION"]);

const returnReinitSourceStatuses = new Set(["RETURNED", "MAINTENANCE"]);
const defaultResidualForecastHorizons = "0,6,12,24,36";

const residualForecastStatusColors: Record<string, string> = {
  ADOPTED: "green",
  ARCHIVED: "default",
  GENERATED: "blue",
  VOIDED: "red"
};

const residualForecastPointStatusColors: Record<string, string> = {
  ADOPTED: "green",
  GENERATED: "blue",
  UNSUPPORTED: "orange"
};

const valuationReviewStatusColors: Record<string, string> = {
  APPROVED: "green",
  CANCELLED: "default",
  PENDING: "orange",
  REJECTED: "red"
};

const valuationReviewSourceColors: Record<string, string> = {
  MANUAL: "default",
  OTHER: "default",
  QUARTERLY_REVIEW: "blue",
  RESIDUAL_FORECAST: "purple",
  RETURN_REINIT: "cyan"
};

const valuationReviewAmountSourceLabels: Record<string, string> = {
  ADOPTED_RESIDUAL: "人工采用残值",
  PREDICTED_RESIDUAL: "预测残值"
};

function capitalEventVisibility(eventType?: string | null) {
  const isInitial = eventType === "INITIAL_EQUITY_PURCHASE";
  const isDebtFinancing = debtFinancingCapitalEventTypes.has(eventType ?? "");
  const isFinancingRelease = financingReleaseCapitalEventTypes.has(eventType ?? "");
  const isLease = leaseCapitalEventTypes.has(eventType ?? "");
  const isManaged = managedCapitalEventTypes.has(eventType ?? "");
  const isOther = eventType === "OTHER";

  return {
    showAcquisitionMode: isInitial || isLease || isManaged || isOther,
    showDebtAmount: isDebtFinancing || isOther,
    showEquityAmount: isInitial || isOther,
    showFinancingInstrument: isDebtFinancing || isFinancingRelease || isOther,
    showLessor: isLease,
    showManagedOwner: isManaged
  };
}

function buildCapitalEventPayload(values: CapitalEventValues) {
  const visibility = capitalEventVisibility(values.eventType);

  return {
    acquisitionMode: visibility.showAcquisitionMode ? values.acquisitionMode : null,
    debtPrincipalAmount: visibility.showDebtAmount ? toCentAmount(values.debtPrincipalAmountYuan) : null,
    effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
    equityCapitalAmount: visibility.showEquityAmount ? toCentAmount(values.equityCapitalAmountYuan) : null,
    eventType: values.eventType,
    externalOwnerName: visibility.showManagedOwner ? values.externalOwnerName : null,
    financingInstrumentId: visibility.showFinancingInstrument ? values.financingInstrumentId : null,
    lessorName: visibility.showLessor ? values.lessorName : null,
    managedOwnerName: visibility.showManagedOwner ? values.managedOwnerName : null,
    remark: values.remark
  };
}

function capitalEventFormValues(event: CapitalEvent): CapitalEventValues {
  return {
    acquisitionMode: event.acquisitionMode,
    debtPrincipalAmountYuan:
      event.debtPrincipalAmount === undefined || event.debtPrincipalAmount === null
        ? undefined
        : event.debtPrincipalAmount / 100,
    effectiveFrom: dayjs(event.effectiveFrom),
    equityCapitalAmountYuan:
      event.equityCapitalAmount === undefined || event.equityCapitalAmount === null
        ? undefined
        : event.equityCapitalAmount / 100,
    eventType: event.eventType,
    externalOwnerName: event.externalOwnerName,
    financingInstrumentId: event.financingInstrument?.id ?? event.financingInstrumentId ?? undefined,
    lessorName: event.lessorName,
    managedOwnerName: event.managedOwnerName,
    remark: event.remark
  };
}

function formatYuan(value?: number | null) {
  return value === undefined || value === null ? "-" : `¥${(value / 100).toFixed(2)}`;
}

function formatKwh(value?: number | null) {
  return value === undefined || value === null ? "-" : `${value.toLocaleString("zh-CN")} kWh`;
}

function batteryUsageTypeLabel(vehicle: Pick<Vehicle, "batteryUsageType" | "batteryUsageTypeLabel">) {
  return vehicle.batteryUsageTypeLabel ?? (vehicle.batteryUsageType ? labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, vehicle.batteryUsageType) : "-");
}

function formatDate(value?: string | null) {
  if (!value) {
    return "-";
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "-";
}

function formatInsurancePeriod(vehicle: Pick<Vehicle, "insuranceEndDate" | "insuranceStartDate">) {
  if (!vehicle.insuranceStartDate || !vehicle.insuranceEndDate) {
    return "-";
  }
  return `${formatDate(vehicle.insuranceStartDate)} 至 ${formatDate(vehicle.insuranceEndDate)}`;
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "-";
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD HH:mm") : "-";
}

function toCents(value: number) {
  return Math.round(value * 100);
}

function positiveYuanRule(message: string) {
  return {
    validator: (_: unknown, value?: number | null) =>
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? Promise.resolve()
        : Promise.reject(new Error(message))
  };
}

function formatScore(value?: number | null) {
  return value === undefined || value === null ? "-" : `${value} / 100`;
}

function formatNumber(value?: number | null) {
  return value === undefined || value === null ? "-" : value.toLocaleString("zh-CN");
}

function formatHorizon(value?: number | null) {
  if (value === undefined || value === null) {
    return "-";
  }
  return value === 0 ? "当前" : `未来 ${value} 个月`;
}

function snapshotValue(snapshot: Record<string, unknown> | null | undefined, key: string) {
  const value = snapshot?.[key];
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "-";
}

function formatSnapshot(value?: unknown) {
  if (value === undefined || value === null) {
    return "-";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "-";
  }
}

function snapshotPanel(key: string, label: string, value?: unknown) {
  const content = formatSnapshot(value);

  return {
    children:
      content === "-" ? (
        "-"
      ) : (
        <pre style={{ margin: 0, maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap" }}>
          {content}
        </pre>
      ),
    key,
    label
  };
}

function valuationReviewStatusTag(value?: string | null) {
  if (!value) {
    return "-";
  }
  return <Tag color={valuationReviewStatusColors[value] ?? "default"}>{labelOf(VEHICLE_VALUATION_REVIEW_STATUS_LABELS, value)}</Tag>;
}

function valuationReviewSourceTag(value?: string | null) {
  if (!value) {
    return "-";
  }
  return <Tag color={valuationReviewSourceColors[value] ?? "default"}>{labelOf(VEHICLE_VALUATION_REVIEW_SOURCE_LABELS, value)}</Tag>;
}

function canCreateValuationReviewFromPoint(point: VehicleResidualForecastPoint) {
  return point.pointStatus !== "UNSUPPORTED" && Boolean(point.id) && suggestedValuationReviewAmount(point) !== null;
}

function suggestedValuationReviewAmount(point: VehicleResidualForecastPoint) {
  return point.adoptedResidualAmount ?? point.predictedResidualAmount ?? null;
}

function vehicleValuationReviewTitle(review: VehicleValuationReview | null) {
  return review ? `${review.reviewNo} 估值复核详情` : "估值复核详情";
}

function parseHorizonMonths(value?: string | null) {
  const values = String(value ?? "")
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (values.length === 0) {
    throw new Error("请输入预测周期。");
  }

  const parsed = values.map((item) => {
    const numberValue = Number(item);
    if (!Number.isInteger(numberValue) || numberValue < 0) {
      throw new Error("预测周期必须是不小于 0 的整数。");
    }
    return numberValue;
  });

  const uniqueValues = Array.from(new Set(parsed)).sort((a, b) => a - b);
  if (uniqueValues.length !== parsed.length) {
    throw new Error("预测周期不能重复。");
  }
  if (uniqueValues.length > 10) {
    throw new Error("预测周期最多支持 10 个。");
  }

  return uniqueValues;
}

function buildResidualForecastPayload(values: GenerateResidualForecastValues, dryRun: boolean) {
  return {
    asOfDate: values.asOfDate.format("YYYY-MM-DD"),
    curveId: values.curveId || undefined,
    dryRun,
    horizonMonths: parseHorizonMonths(values.horizonMonthsText),
    remark: values.remark
  };
}

function residualCurveOptionLabel(curve: ResidualCurveSummary) {
  return [
    curve.curveNo,
    labelOf(VEHICLE_RESIDUAL_CURVE_STATUS_LABELS, curve.curveStatus),
    curve.brand,
    curve.series,
    curve.model,
    curve.modelYear,
    formatKwh(curve.batteryCapacityKwh),
    labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, curve.batteryUsageType),
    curve.confidenceScore === undefined || curve.confidenceScore === null ? null : `置信度 ${curve.confidenceScore}`
  ]
    .filter((item) => item && item !== "-")
    .join(" / ");
}

function residualForecastStatusTag(value?: string | null) {
  if (!value) {
    return "-";
  }
  return (
    <Tag color={residualForecastStatusColors[value] ?? "default"}>
      {labelOf(VEHICLE_RESIDUAL_FORECAST_STATUS_LABELS, value)}
    </Tag>
  );
}

function residualForecastPointStatusTag(value?: string | null) {
  if (!value) {
    return "-";
  }
  return (
    <Tag color={residualForecastPointStatusColors[value] ?? "default"}>
      {labelOf(VEHICLE_RESIDUAL_FORECAST_POINT_STATUS_LABELS, value)}
    </Tag>
  );
}

function isReturnReinitVehicle(vehicle: Pick<Vehicle, "status"> | null | undefined) {
  return Boolean(vehicle && returnReinitSourceStatuses.has(vehicle.status));
}

function hasReturnReinitForCurrentPool(vehicle: Vehicle) {
  const latestReturnReinit = vehicle.salePriceHistories?.find((history) => history.reviewType === "RETURN_REINIT");
  if (!latestReturnReinit) {
    return false;
  }
  if (!vehicle.salePriceReinitRequiredAt) {
    return true;
  }
  return dayjs(latestReturnReinit.createdAt).valueOf() >= dayjs(vehicle.salePriceReinitRequiredAt).valueOf();
}

function canRelistAfterReturn(vehicle: Vehicle) {
  return Boolean(
    isReturnReinitVehicle(vehicle) &&
      vehicle.currentSalePriceAmount &&
      vehicle.currentSalePriceAmount > 0 &&
      vehicle.salePriceStatus === "EFFECTIVE" &&
      hasReturnReinitForCurrentPool(vehicle)
  );
}

function getReturnReinitNotice(vehicle: Vehicle) {
  if (!isReturnReinitVehicle(vehicle)) {
    return null;
  }

  if (canRelistAfterReturn(vehicle)) {
    return "退车再入池重新定价已完成，可确认整备完成后设置为可租用。";
  }

  return vehicle.status === "MAINTENANCE"
    ? "该车辆维修中，完成整备并通过 RETURN_REINIT 重新初始化当前销售价后才能再次入池。"
    : "该车辆已退回，需重新初始化当前销售价后才能再次入池。";
}

function statusOptionsForVehicle(vehicle: Vehicle | null) {
  if (!vehicle || !isReturnReinitVehicle(vehicle) || canRelistAfterReturn(vehicle)) {
    return vehicleStatusOptions;
  }

  return vehicleStatusOptions.map((option) =>
    option.value === "AVAILABLE"
      ? { ...option, disabled: true, label: `${option.label}（需先 RETURN_REINIT）` }
      : option
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

function vehicleModelText(vehicle: Vehicle) {
  return [vehicle.brand, vehicle.series, vehicle.model, vehicle.vehicleModel].filter(Boolean).join(" / ") || "-";
}

function toReviewQuarter(date: Dayjs) {
  return `${date.year()}Q${Math.floor(date.month() / 3) + 1}`;
}

export default function VehiclesPage() {
  const { message } = App.useApp();
  const [createForm] = Form.useForm<CreateVehicleValues>();
  const [editForm] = Form.useForm<EditVehicleValues>();
  const [initializeForm] = Form.useForm<InitializeSalePriceValues>();
  const [reviewForm] = Form.useForm<ReviewSalePriceValues>();
  const [statusForm] = Form.useForm<StatusValues>();
  const [capitalEventForm] = Form.useForm<CapitalEventValues>();
  const [revenueShareRuleForm] = Form.useForm<RevenueShareRuleValues>();
  const [deactivateShareRuleForm] = Form.useForm<DeactivateRevenueShareRuleValues>();
  const [revenueSharePreviewForm] = Form.useForm<RevenueSharePreviewValues>();
  const [residualForecastGenerateForm] = Form.useForm<GenerateResidualForecastValues>();
  const [residualForecastAdoptForm] = Form.useForm<AdoptResidualForecastPointValues>();
  const [residualForecastVoidForm] = Form.useForm<VoidResidualForecastValues>();
  const [valuationReviewCreateForm] = Form.useForm<CreateValuationReviewValues>();
  const [valuationReviewCancelForm] = Form.useForm<CancelValuationReviewValues>();
  const [activeTab, setActiveTab] = useState("vehicles");
  const [capitalEvents, setCapitalEvents] = useState<CapitalEvent[]>([]);
  const [capitalEventOpen, setCapitalEventOpen] = useState(false);
  const [capitalStructure, setCapitalStructure] = useState<CapitalStructurePreview | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deactivatingShareRule, setDeactivatingShareRule] = useState<RevenueShareRule | null>(null);
  const [detailVehicle, setDetailVehicle] = useState<Vehicle | null>(null);
  const [dueReviews, setDueReviews] = useState<Vehicle[]>([]);
  const [editingCapitalEvent, setEditingCapitalEvent] = useState<CapitalEvent | null>(null);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [financingInstruments, setFinancingInstruments] = useState<FinancingInstrumentSummary[]>([]);
  const [financingInstrumentsLoading, setFinancingInstrumentsLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRows, setHistoryRows] = useState<SalePriceHistory[]>([]);
  const [historyVehicle, setHistoryVehicle] = useState<Vehicle | null>(null);
  const [initializingVehicle, setInitializingVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(false);
  const [reviewingVehicle, setReviewingVehicle] = useState<Vehicle | null>(null);
  const [revenueSharePreview, setRevenueSharePreview] = useState<RevenueSharePreview | null>(null);
  const [revenueShareRules, setRevenueShareRules] = useState<RevenueShareRule[]>([]);
  const [revenueShareRuleOpen, setRevenueShareRuleOpen] = useState(false);
  const [residualCurveOptions, setResidualCurveOptions] = useState<ResidualCurveSummary[]>([]);
  const [residualCurveOptionsLoading, setResidualCurveOptionsLoading] = useState(false);
  const [residualForecastAdoptSubmitting, setResidualForecastAdoptSubmitting] = useState(false);
  const [residualForecastAdoptTarget, setResidualForecastAdoptTarget] = useState<VehicleResidualForecastPoint | null>(null);
  const [residualForecastDetail, setResidualForecastDetail] = useState<VehicleResidualForecast | null>(null);
  const [residualForecastDetailLoading, setResidualForecastDetailLoading] = useState(false);
  const [residualForecastDetailOpen, setResidualForecastDetailOpen] = useState(false);
  const [residualForecastGenerateOpen, setResidualForecastGenerateOpen] = useState(false);
  const [residualForecastGenerateSubmitting, setResidualForecastGenerateSubmitting] = useState(false);
  const [residualForecastHistory, setResidualForecastHistory] = useState<VehicleResidualForecast[]>([]);
  const [residualForecastLatest, setResidualForecastLatest] = useState<VehicleResidualForecast | null>(null);
  const [residualForecastLoading, setResidualForecastLoading] = useState(false);
  const [residualForecastPage, setResidualForecastPage] = useState(1);
  const [residualForecastPageSize, setResidualForecastPageSize] = useState(5);
  const [residualForecastPreview, setResidualForecastPreview] = useState<VehicleResidualForecastGenerationResult | null>(null);
  const [residualForecastTotal, setResidualForecastTotal] = useState(0);
  const [residualForecastVoidSubmitting, setResidualForecastVoidSubmitting] = useState(false);
  const [residualForecastVoidTarget, setResidualForecastVoidTarget] = useState<VehicleResidualForecast | null>(null);
  const [valuationReviewCancelSubmitting, setValuationReviewCancelSubmitting] = useState(false);
  const [valuationReviewCancelTarget, setValuationReviewCancelTarget] = useState<VehicleValuationReview | null>(null);
  const [valuationReviewCreateSubmitting, setValuationReviewCreateSubmitting] = useState(false);
  const [valuationReviewCreateTarget, setValuationReviewCreateTarget] = useState<VehicleResidualForecastPoint | null>(null);
  const [valuationReviewDetail, setValuationReviewDetail] = useState<VehicleValuationReview | null>(null);
  const [valuationReviewDetailLoading, setValuationReviewDetailLoading] = useState(false);
  const [valuationReviewDetailOpen, setValuationReviewDetailOpen] = useState(false);
  const [valuationReviewLoading, setValuationReviewLoading] = useState(false);
  const [valuationReviewPage, setValuationReviewPage] = useState(1);
  const [valuationReviewPageSize, setValuationReviewPageSize] = useState(5);
  const [valuationReviewRows, setValuationReviewRows] = useState<VehicleValuationReview[]>([]);
  const [valuationReviewTotal, setValuationReviewTotal] = useState(0);
  const [statusVehicle, setStatusVehicle] = useState<Vehicle | null>(null);
  const [vehicleFinancialLoading, setVehicleFinancialLoading] = useState(false);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const permissions = useMemo(() => new Set(me?.user.permissions ?? []), [me]);
  const capitalEventType = Form.useWatch("eventType", capitalEventForm);
  const ownerSharePercent = Form.useWatch("ownerSharePercent", revenueShareRuleForm);
  const platformSharePercent = Form.useWatch("platformSharePercent", revenueShareRuleForm);
  const revenueShareRuleType = Form.useWatch("ruleType", revenueShareRuleForm);
  const canViewCapitalStructure = permissions.has("capital_structure:view") || permissions.has("vehicle:view") || permissions.has("report:asset");
  const canViewFinancing = permissions.has("financing:view");
  const canViewRevenueShareRules = permissions.has("revenue_share:view") || permissions.has("vehicle:view");
  const canViewRevenueSharePreview = permissions.has("revenue_share:view") || permissions.has("report:asset");
  const canViewResidualForecast = permissions.has("residual_forecast:view");
  const canGenerateResidualForecast = permissions.has("residual_forecast:generate");
  const canViewValuationReview = permissions.has("vehicle_valuation_review:view");
  const canCreateValuationReview = permissions.has("vehicle_valuation_review:create");
  const financingInstrumentOptions = useMemo(() => {
    const instrumentMap = new Map<string, FinancingInstrumentSummary>();

    for (const instrument of capitalStructure?.financingInstruments ?? []) {
      instrumentMap.set(instrument.id, instrument);
    }

    for (const allocation of capitalStructure?.activeFinancingAllocations ?? []) {
      if (allocation.financingInstrument) {
        instrumentMap.set(allocation.financingInstrument.id, allocation.financingInstrument);
      }
    }

    for (const instrument of financingInstruments) {
      instrumentMap.set(instrument.id, instrument);
    }

    return Array.from(instrumentMap.values()).map((instrument) => ({
      label: financingInstrumentOptionLabel(instrument),
      value: instrument.id
    }));
  }, [capitalStructure, financingInstruments]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [vehicleRows, dueRows, nextMe] = await Promise.all([
        apiFetch<Vehicle[]>("/vehicles"),
        apiFetch<Vehicle[]>("/vehicles/sale-price-reviews/due"),
        apiFetch<AuthMeResponse>("/auth/me")
      ]);
      setVehicles(vehicleRows);
      setDueReviews(dueRows);
      setMe(nextMe);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const loadFinancingInstruments = useCallback(async () => {
    setFinancingInstrumentsLoading(true);
    try {
      const result = await apiFetch<FinancingInstrumentListResponse>("/financing-instruments?instrumentStatus=ACTIVE&pageSize=100");
      setFinancingInstruments(result.items);
    } catch (error) {
      void message.error(getErrorMessage(error));
      setFinancingInstruments([]);
    } finally {
      setFinancingInstrumentsLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (canViewFinancing) {
      void loadFinancingInstruments();
    }
  }, [canViewFinancing, loadFinancingInstruments]);

  useEffect(() => {
    if (!capitalEventOpen || !capitalEventType) {
      return;
    }

    if (capitalEventType === "INITIAL_EQUITY_PURCHASE") {
      capitalEventForm.setFieldsValue({
        acquisitionMode: "OWNED_CASH",
        debtPrincipalAmountYuan: undefined,
        effectiveTo: undefined,
        externalOwnerName: undefined,
        financingInstrumentId: undefined,
        lessorName: undefined,
        managedOwnerName: undefined
      });
      return;
    }

    if (debtFinancingCapitalEventTypes.has(capitalEventType)) {
      capitalEventForm.setFieldsValue({
        acquisitionMode: undefined,
        effectiveTo: undefined,
        equityCapitalAmountYuan: undefined,
        externalOwnerName: undefined,
        lessorName: undefined,
        managedOwnerName: undefined
      });
      return;
    }

    if (financingReleaseCapitalEventTypes.has(capitalEventType)) {
      capitalEventForm.setFieldsValue({
        acquisitionMode: undefined,
        debtPrincipalAmountYuan: undefined,
        effectiveTo: undefined,
        equityCapitalAmountYuan: undefined,
        externalOwnerName: undefined,
        lessorName: undefined,
        managedOwnerName: undefined
      });
      return;
    }

    if (leaseCapitalEventTypes.has(capitalEventType)) {
      capitalEventForm.setFieldsValue({
        acquisitionMode: "LONG_TERM_LEASED",
        debtPrincipalAmountYuan: undefined,
        effectiveTo: undefined,
        equityCapitalAmountYuan: undefined,
        externalOwnerName: undefined,
        financingInstrumentId: undefined,
        managedOwnerName: undefined
      });
      return;
    }

    if (managedCapitalEventTypes.has(capitalEventType)) {
      capitalEventForm.setFieldsValue({
        acquisitionMode: "MANAGED_REVENUE_SHARE",
        debtPrincipalAmountYuan: undefined,
        effectiveTo: undefined,
        equityCapitalAmountYuan: undefined,
        financingInstrumentId: undefined,
        lessorName: undefined
      });
      return;
    }

    capitalEventForm.setFieldsValue({ effectiveTo: undefined });
  }, [capitalEventForm, capitalEventOpen, capitalEventType]);

  useEffect(() => {
    if (!revenueShareRuleOpen || !revenueShareRuleType) {
      return;
    }

    if (revenueShareRuleType === "REVENUE_SHARE") {
      revenueShareRuleForm.setFieldsValue({
        fixedMonthlyAmountYuan: undefined,
        minimumGuaranteeAmountYuan: undefined,
        shareBasis: revenueShareRuleForm.getFieldValue("shareBasis") ?? "RENTAL_PAID"
      });
      return;
    }

    if (revenueShareRuleType === "FIXED_RENT") {
      revenueShareRuleForm.setFieldsValue({
        fixedMonthlyAmountYuan: revenueShareRuleForm.getFieldValue("fixedMonthlyAmountYuan"),
        minimumGuaranteeAmountYuan: undefined,
        ownerSharePercent: undefined,
        platformSharePercent: undefined,
        shareBasis: "MANUAL"
      });
      return;
    }

    if (revenueShareRuleType === "MIXED") {
      revenueShareRuleForm.setFieldsValue({
        shareBasis: revenueShareRuleForm.getFieldValue("shareBasis") === "MANUAL"
          ? "RENTAL_PAID"
          : revenueShareRuleForm.getFieldValue("shareBasis") ?? "RENTAL_PAID"
      });
    }
  }, [revenueShareRuleForm, revenueShareRuleOpen, revenueShareRuleType]);

  const loadVehicleFinancialData = useCallback(
    async (vehicleId: string) => {
      setVehicleFinancialLoading(true);
      try {
        const previewValues = revenueSharePreviewForm.getFieldsValue();
        const startDate = previewValues.startDate ?? dayjs().startOf("month");
        const endDate = previewValues.endDate ?? dayjs().endOf("month");
        revenueSharePreviewForm.setFieldsValue({ endDate, startDate });

        const [nextCapitalStructure, nextCapitalEvents, nextRevenueShareRules, nextRevenueSharePreview] =
          await Promise.all([
            canViewCapitalStructure
              ? apiFetch<CapitalStructurePreview>(`/vehicles/${vehicleId}/capital-structure`)
              : Promise.resolve(null),
            canViewCapitalStructure
              ? apiFetch<CapitalEvent[]>(`/vehicles/${vehicleId}/capital-events`)
              : Promise.resolve([]),
            canViewRevenueShareRules
              ? apiFetch<RevenueShareRule[]>(`/vehicles/${vehicleId}/revenue-share-rules`)
              : Promise.resolve([]),
            canViewRevenueSharePreview
              ? apiFetch<RevenueSharePreview>(
                  `/vehicles/${vehicleId}/revenue-share-preview?startDate=${startDate.format("YYYY-MM-DD")}&endDate=${endDate.format("YYYY-MM-DD")}`
                )
              : Promise.resolve(null)
          ]);

        setCapitalStructure(nextCapitalStructure);
        setCapitalEvents(nextCapitalEvents);
        setRevenueShareRules(nextRevenueShareRules);
        setRevenueSharePreview(nextRevenueSharePreview);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setVehicleFinancialLoading(false);
      }
    },
    [
      canViewCapitalStructure,
      canViewRevenueSharePreview,
      canViewRevenueShareRules,
      message,
      revenueSharePreviewForm
    ]
  );

  const loadVehicleResidualForecastData = useCallback(
    async (vehicleId: string, page = residualForecastPage, pageSize = residualForecastPageSize) => {
      if (!canViewResidualForecast) {
        return;
      }

      setResidualForecastLoading(true);
      try {
        const [latest, history] = await Promise.all([
          apiFetch<VehicleResidualForecast | null>(`/vehicles/${vehicleId}/residual-forecasts/latest`),
          apiFetch<VehicleResidualForecastListResponse>(
            `/vehicles/${vehicleId}/residual-forecasts?page=${page}&pageSize=${pageSize}`
          )
        ]);
        setResidualForecastLatest(latest);
        setResidualForecastHistory(history.items);
        setResidualForecastTotal(history.total);
        setResidualForecastPage(history.page);
        setResidualForecastPageSize(history.pageSize);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setResidualForecastLoading(false);
      }
    },
    [canViewResidualForecast, message, residualForecastPage, residualForecastPageSize]
  );

  const loadVehicleValuationReviews = useCallback(
    async (vehicleId: string, page = valuationReviewPage, pageSize = valuationReviewPageSize) => {
      if (!canViewValuationReview) {
        return;
      }

      setValuationReviewLoading(true);
      try {
        const result = await apiFetch<VehicleValuationReviewListResponse>(
          `/vehicles/${vehicleId}/valuation-reviews?page=${page}&pageSize=${pageSize}`
        );
        setValuationReviewRows(result.items);
        setValuationReviewTotal(result.total);
        setValuationReviewPage(result.page);
        setValuationReviewPageSize(result.pageSize);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setValuationReviewLoading(false);
      }
    },
    [canViewValuationReview, message, valuationReviewPage, valuationReviewPageSize]
  );

  const loadResidualCurveOptions = useCallback(async () => {
    if (!canGenerateResidualForecast) {
      return;
    }

    setResidualCurveOptionsLoading(true);
    try {
      const result = await apiFetch<ResidualCurveListResponse>(
        "/residual-market/curves?curveStatus=ACTIVE&page=1&pageSize=100"
      );
      setResidualCurveOptions(result.items);
    } catch (error) {
      void message.error(getErrorMessage(error));
      setResidualCurveOptions([]);
    } finally {
      setResidualCurveOptionsLoading(false);
    }
  }, [canGenerateResidualForecast, message]);

  const columns = useMemo(
    () => buildVehicleColumns(openDetail, openEditVehicle, openInitialize, openReview, openHistory, openStatus, relistVehicle, permissions),
    [permissions]
  );

  function openCreateVehicle() {
    setCreateOpen(true);
    createForm.setFieldsValue({
      brand: "NIO",
      batteryUsageType: "BUYOUT",
      currentMileageKm: 0,
      insuranceEndDate: dayjs().add(1, "year"),
      insuranceStartDate: dayjs(),
      vehicleModel: "ET5"
    });
  }

  async function saveCreateVehicle(values: CreateVehicleValues) {
    try {
      await apiFetch<Vehicle>("/vehicles", {
        body: JSON.stringify({
          assetLocation: values.assetLocation,
          batteryCapacityKwh: values.batteryCapacityKwh,
          batteryUsageType: values.batteryUsageType,
          brand: values.brand,
          currentMileageKm: values.currentMileageKm ?? 0,
          insuranceEndDate: values.insuranceEndDate?.format("YYYY-MM-DD"),
          insuranceStartDate: values.insuranceStartDate?.format("YYYY-MM-DD"),
          latestRegistrationDate: values.latestRegistrationDate?.format("YYYY-MM-DD"),
          model: values.model,
          modelYear: values.modelYear,
          plateNo: values.plateNo,
          purchaseDate: values.purchaseDate?.format("YYYY-MM-DD"),
          purchasePriceAmount: toCents(values.purchasePriceAmountYuan),
          registrationDate: values.registrationDate?.format("YYYY-MM-DD"),
          remark: values.remark,
          series: values.series,
          vehicleModel: values.vehicleModel,
          vin: values.vin
        }),
        method: "POST"
      });
      void message.success("车辆已创建");
      setCreateOpen(false);
      createForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function openDetail(vehicle: Vehicle) {
    setDetailVehicle(vehicle);
    setCapitalStructure(null);
    setCapitalEvents([]);
    setRevenueShareRules([]);
    setRevenueSharePreview(null);
    setResidualForecastLatest(null);
    setResidualForecastHistory([]);
    setResidualForecastTotal(0);
    setResidualForecastPage(1);
    setResidualForecastPageSize(5);
    setResidualForecastPreview(null);
    setResidualForecastDetail(null);
    setValuationReviewRows([]);
    setValuationReviewTotal(0);
    setValuationReviewPage(1);
    setValuationReviewPageSize(5);
    setValuationReviewDetail(null);
    setValuationReviewCreateTarget(null);
    setValuationReviewCancelTarget(null);
    revenueSharePreviewForm.setFieldsValue({
      endDate: dayjs().endOf("month"),
      startDate: dayjs().startOf("month")
    });
    void loadVehicleFinancialData(vehicle.id);
    if (canViewResidualForecast) {
      void loadVehicleResidualForecastData(vehicle.id, 1, 5);
    }
    if (canViewValuationReview) {
      void loadVehicleValuationReviews(vehicle.id, 1, 5);
    }
  }

  function refreshResidualForecastData(page = residualForecastPage, pageSize = residualForecastPageSize) {
    if (!detailVehicle || !canViewResidualForecast) {
      return Promise.resolve();
    }
    return loadVehicleResidualForecastData(detailVehicle.id, page, pageSize);
  }

  function refreshValuationReviews(page = valuationReviewPage, pageSize = valuationReviewPageSize) {
    if (!detailVehicle || !canViewValuationReview) {
      return Promise.resolve();
    }
    return loadVehicleValuationReviews(detailVehicle.id, page, pageSize);
  }

  function openResidualForecastGenerate() {
    if (!detailVehicle) {
      return;
    }
    setResidualForecastPreview(null);
    residualForecastGenerateForm.setFieldsValue({
      asOfDate: dayjs(),
      curveId: undefined,
      horizonMonthsText: defaultResidualForecastHorizons,
      remark: undefined
    });
    setResidualForecastGenerateOpen(true);
    void loadResidualCurveOptions();
  }

  async function dryRunResidualForecast() {
    if (!detailVehicle) {
      return;
    }
    try {
      const values = await residualForecastGenerateForm.validateFields();
      const result = await apiFetch<VehicleResidualForecastGenerationResult>(
        `/vehicles/${detailVehicle.id}/residual-forecasts/generate`,
        {
          body: JSON.stringify(buildResidualForecastPayload(values, true)),
          method: "POST"
        }
      );
      setResidualForecastPreview(result);
      void message.success("残值预测试算已完成，当前结果尚未保存。");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : getErrorMessage(error));
    }
  }

  async function generateResidualForecast() {
    if (!detailVehicle) {
      return;
    }

    let values: GenerateResidualForecastValues;
    try {
      values = await residualForecastGenerateForm.validateFields();
      buildResidualForecastPayload(values, false);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : getErrorMessage(error));
      return;
    }

    Modal.confirm({
      content: "本操作会保存预测记录和预测点，但不会覆盖车辆当前销售价，也不会写入销售价历史。",
      okText: "确认生成",
      onOk: async () => {
        setResidualForecastGenerateSubmitting(true);
        try {
          const result = await apiFetch<VehicleResidualForecastGenerationResult>(
            `/vehicles/${detailVehicle.id}/residual-forecasts/generate`,
            {
              body: JSON.stringify(buildResidualForecastPayload(values, false)),
              method: "POST"
            }
          );
          void message.success("车辆残值预测已生成。");
          setResidualForecastGenerateOpen(false);
          setResidualForecastPreview(null);
          await refreshResidualForecastData(1, residualForecastPageSize);
          if (result.forecast?.id) {
            await openResidualForecastDetail(result.forecast);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setResidualForecastGenerateSubmitting(false);
        }
      },
      title: "确认正式生成该车辆残值预测？"
    });
  }

  async function openResidualForecastDetail(forecast: VehicleResidualForecast) {
    if (!forecast.id) {
      void message.error("该预测记录尚未保存，无法查看详情。");
      return;
    }
    setResidualForecastDetailOpen(true);
    setResidualForecastDetailLoading(true);
    try {
      const detail = await apiFetch<VehicleResidualForecast>(`/residual-market/vehicle-forecasts/${forecast.id}`);
      setResidualForecastDetail(detail);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setResidualForecastDetailLoading(false);
    }
  }

  function openResidualForecastAdopt(point: VehicleResidualForecastPoint) {
    setResidualForecastAdoptTarget(point);
    residualForecastAdoptForm.setFieldsValue({
      adoptedResidualAmountYuan: point.predictedResidualAmount ? point.predictedResidualAmount / 100 : undefined,
      adoptRemark: undefined
    });
  }

  async function submitResidualForecastAdopt(values: AdoptResidualForecastPointValues) {
    if (!residualForecastAdoptTarget?.id) {
      return;
    }

    Modal.confirm({
      content: "采用值只会记录在预测点上，不会覆盖车辆当前销售价，也不会写入销售价历史。",
      okText: "确认采用",
      onOk: async () => {
        setResidualForecastAdoptSubmitting(true);
        try {
          await apiFetch<VehicleResidualForecastPoint>(
            `/residual-market/vehicle-forecast-points/${residualForecastAdoptTarget.id}/adopt`,
            {
              body: JSON.stringify({
                adoptedResidualAmount: toCents(values.adoptedResidualAmountYuan),
                adoptRemark: values.adoptRemark
              }),
              method: "POST"
            }
          );
          void message.success("预测点已采用。");
          setResidualForecastAdoptTarget(null);
          residualForecastAdoptForm.resetFields();
          await refreshResidualForecastData();
          if (residualForecastDetail?.id) {
            await openResidualForecastDetail(residualForecastDetail);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setResidualForecastAdoptSubmitting(false);
        }
      },
      title: "确认采用该预测点？"
    });
  }

  function openResidualForecastVoid(forecast: VehicleResidualForecast) {
    setResidualForecastVoidTarget(forecast);
    residualForecastVoidForm.setFieldsValue({ remark: undefined });
  }

  async function submitResidualForecastVoid(values: VoidResidualForecastValues) {
    if (!residualForecastVoidTarget?.id) {
      return;
    }

    Modal.confirm({
      content: "作废后不会删除记录，但不再作为有效预测参考。",
      okText: "确认作废",
      onOk: async () => {
        setResidualForecastVoidSubmitting(true);
        try {
          await apiFetch<VehicleResidualForecast>(
            `/residual-market/vehicle-forecasts/${residualForecastVoidTarget.id}/void`,
            {
              body: JSON.stringify({ remark: values.remark }),
              method: "POST"
            }
          );
          void message.success("预测记录已作废。");
          setResidualForecastVoidTarget(null);
          residualForecastVoidForm.resetFields();
          await refreshResidualForecastData();
          if (residualForecastDetail?.id === residualForecastVoidTarget.id) {
            await openResidualForecastDetail(residualForecastVoidTarget);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setResidualForecastVoidSubmitting(false);
        }
      },
      title: "确认作废该预测记录？"
    });
  }

  function openValuationReviewCreate(point: VehicleResidualForecastPoint) {
    if (!detailVehicle || !point.id) {
      return;
    }
    if (!canCreateValuationReview) {
      void message.error("无车辆估值复核发起权限。");
      return;
    }

    const requestedAmount = suggestedValuationReviewAmount(point);
    if (requestedAmount === null || point.pointStatus === "UNSUPPORTED") {
      void message.warning(
        point.pointStatus === "UNSUPPORTED"
          ? "暂不支持的预测点不能发起估值复核。"
          : "预测点缺少可用的预测或采用残值金额，不能发起估值复核。"
      );
      return;
    }

    setValuationReviewCreateTarget(point);
    valuationReviewCreateForm.setFieldsValue({
      reason: `采用 ${point.horizonMonth} 个月残值预测作为当前估值复核参考`,
      requestedSalePriceAmountYuan: requestedAmount / 100,
      reviewRemark: undefined
    });
  }

  async function submitValuationReviewCreate(values: CreateValuationReviewValues) {
    if (!detailVehicle || !valuationReviewCreateTarget?.id) {
      return;
    }

    Modal.confirm({
      content: "本操作只会创建待审核复核记录，不会修改车辆当前销售价，也不会写入销售价历史。",
      okText: "确认发起",
      onOk: async () => {
        setValuationReviewCreateSubmitting(true);
        try {
          await apiFetch<VehicleValuationReview>(
            `/vehicles/${detailVehicle.id}/valuation-reviews/from-residual-forecast`,
            {
              body: JSON.stringify({
                forecastPointId: valuationReviewCreateTarget.id,
                reason: values.reason,
                requestedSalePriceAmount: toCents(values.requestedSalePriceAmountYuan),
                reviewRemark: values.reviewRemark
              }),
              method: "POST"
            }
          );
          void message.success("车辆估值复核已发起");
          setValuationReviewCreateTarget(null);
          valuationReviewCreateForm.resetFields();
          await refreshValuationReviews(1, valuationReviewPageSize);
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setValuationReviewCreateSubmitting(false);
        }
      },
      title: "确认发起车辆估值复核？"
    });
  }

  async function openValuationReviewDetail(review: VehicleValuationReview) {
    setValuationReviewDetailOpen(true);
    setValuationReviewDetailLoading(true);
    try {
      const detail = await apiFetch<VehicleValuationReview>(`/vehicle-valuation-reviews/${review.id}`);
      setValuationReviewDetail(detail);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setValuationReviewDetailLoading(false);
    }
  }

  function openValuationReviewCancel(review: VehicleValuationReview) {
    setValuationReviewCancelTarget(review);
    valuationReviewCancelForm.resetFields();
  }

  async function submitValuationReviewCancel(values: CancelValuationReviewValues) {
    if (!valuationReviewCancelTarget) {
      return;
    }

    Modal.confirm({
      content: "取消后不会修改车辆当前销售价，也不会写入销售价历史。",
      okText: "确认取消",
      onOk: async () => {
        setValuationReviewCancelSubmitting(true);
        try {
          await apiFetch<VehicleValuationReview>(`/vehicle-valuation-reviews/${valuationReviewCancelTarget.id}/cancel`, {
            body: JSON.stringify({ cancelReason: values.cancelReason }),
            method: "POST"
          });
          void message.success("估值复核已取消");
          const cancelledReviewId = valuationReviewCancelTarget.id;
          setValuationReviewCancelTarget(null);
          valuationReviewCancelForm.resetFields();
          await refreshValuationReviews();
          if (valuationReviewDetailOpen && valuationReviewDetail?.id === cancelledReviewId) {
            await openValuationReviewDetail(valuationReviewDetail);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setValuationReviewCancelSubmitting(false);
        }
      },
      title: "确认取消该车辆估值复核？"
    });
  }

  function openEditVehicle(vehicle: Vehicle) {
    setEditingVehicle(vehicle);
    editForm.setFieldsValue({
      assetLocation: vehicle.assetLocation,
      batteryCapacityKwh: vehicle.batteryCapacityKwh,
      batteryUsageType: (vehicle.batteryUsageType ?? "BUYOUT") as "BUYOUT" | "BAAS",
      brand: vehicle.brand,
      currentMileageKm: vehicle.currentMileageKm,
      model: vehicle.model,
      modelYear: vehicle.modelYear,
      plateNo: vehicle.plateNo,
      insuranceEndDate: vehicle.insuranceEndDate ? dayjs(vehicle.insuranceEndDate) : null,
      insuranceStartDate: vehicle.insuranceStartDate ? dayjs(vehicle.insuranceStartDate) : null,
      latestRegistrationDate: vehicle.latestRegistrationDate ? dayjs(vehicle.latestRegistrationDate) : null,
      purchaseDate: vehicle.purchaseDate ? dayjs(vehicle.purchaseDate) : null,
      purchasePriceAmountYuan: vehicle.purchasePriceAmount / 100,
      registrationDate: vehicle.registrationDate ? dayjs(vehicle.registrationDate) : null,
      remark: vehicle.remark,
      series: vehicle.series,
      vehicleModel: (vehicle.vehicleModel ?? "ET5") as "ET5" | "ET7" | "ES6",
      vin: vehicle.vin ?? ""
    });
  }

  async function saveEditVehicle(values: EditVehicleValues) {
    if (!editingVehicle) {
      return;
    }
    try {
      await apiFetch<Vehicle>(`/vehicles/${editingVehicle.id}`, {
        body: JSON.stringify({
          assetLocation: values.assetLocation,
          batteryCapacityKwh: values.batteryCapacityKwh,
          batteryUsageType: values.batteryUsageType,
          brand: values.brand,
          currentMileageKm: values.currentMileageKm ?? 0,
          insuranceEndDate: values.insuranceEndDate?.format("YYYY-MM-DD"),
          insuranceStartDate: values.insuranceStartDate?.format("YYYY-MM-DD"),
          latestRegistrationDate: values.latestRegistrationDate?.format("YYYY-MM-DD"),
          model: values.model,
          modelYear: values.modelYear,
          plateNo: values.plateNo,
          purchaseDate: values.purchaseDate?.format("YYYY-MM-DD"),
          purchasePriceAmount: toCents(values.purchasePriceAmountYuan),
          registrationDate: values.registrationDate?.format("YYYY-MM-DD"),
          remark: values.remark,
          series: values.series,
          vehicleModel: values.vehicleModel,
          vin: values.vin
        }),
        method: "PATCH"
      });
      void message.success("车辆已更新");
      setEditingVehicle(null);
      editForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function openInitialize(vehicle: Vehicle) {
    const reviewType = isReturnReinitVehicle(vehicle) ? "RETURN_REINIT" : "INITIAL_POOL";
    setInitializingVehicle(vehicle);
    initializeForm.setFieldsValue({
      currentSalePriceAmountYuan: vehicle.currentSalePriceAmount
        ? vehicle.currentSalePriceAmount / 100
        : undefined,
      effectiveFrom: dayjs(),
      reason: reviewType === "RETURN_REINIT" ? "退车整备后重新入池" : "新入池初始化",
      reviewType
    });
  }

  function openReview(vehicle: Vehicle) {
    const effectiveFrom = vehicle.nextSalePriceReviewAt ? dayjs(vehicle.nextSalePriceReviewAt) : dayjs();
    setReviewingVehicle(vehicle);
    reviewForm.setFieldsValue({
      effectiveFrom,
      newSalePriceAmountYuan: vehicle.currentSalePriceAmount ? vehicle.currentSalePriceAmount / 100 : undefined,
      reason: "季度市场价格复核",
      reviewQuarter: toReviewQuarter(effectiveFrom)
    });
  }

  async function openHistory(vehicle: Vehicle) {
    setHistoryVehicle(vehicle);
    setActiveTab("history");
    setHistoryLoading(true);
    try {
      setHistoryRows(await apiFetch<SalePriceHistory[]>(`/vehicles/${vehicle.id}/sale-price-history`));
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setHistoryLoading(false);
    }
  }

  function openStatus(vehicle: Vehicle) {
    setStatusVehicle(vehicle);
    statusForm.setFieldsValue({ remark: vehicle.salePriceReinitRequiredAt ? "退回车辆重新入池" : undefined, status: vehicle.status });
  }

  async function saveInitialize(values: InitializeSalePriceValues) {
    if (!initializingVehicle) {
      return;
    }
    try {
      await apiFetch<Vehicle>(`/vehicles/${initializingVehicle.id}/initialize-sale-price`, {
        body: JSON.stringify({
          currentSalePriceAmount: toCents(values.currentSalePriceAmountYuan),
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          reason: values.reason,
          remark: values.remark,
          reviewType: values.reviewType
        }),
        method: "POST"
      });
      void message.success(values.reviewType === "RETURN_REINIT" ? "退车再入池重新定价已完成" : "销售价已初始化");
      setInitializingVehicle(null);
      initializeForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function saveReview(values: ReviewSalePriceValues) {
    if (!reviewingVehicle) {
      return;
    }
    try {
      await apiFetch<Vehicle>(`/vehicles/${reviewingVehicle.id}/review-sale-price`, {
        body: JSON.stringify({
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          newSalePriceAmount: toCents(values.newSalePriceAmountYuan),
          reason: values.reason,
          remark: values.remark,
          reviewQuarter: values.reviewQuarter
        }),
        method: "POST"
      });
      void message.success("季度销售价复核已保存");
      setReviewingVehicle(null);
      reviewForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function saveStatus(values: StatusValues) {
    if (!statusVehicle) {
      return;
    }
    try {
      await apiFetch<Vehicle>(`/vehicles/${statusVehicle.id}/update-status`, {
        body: JSON.stringify(values),
        method: "POST"
      });
      void message.success("车辆状态已更新");
      setStatusVehicle(null);
      statusForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function openCapitalEventModal(allocation?: FinancingAllocation) {
    setEditingCapitalEvent(null);
    capitalEventForm.resetFields();
    capitalEventForm.setFieldsValue({
      debtPrincipalAmountYuan: allocation ? allocation.allocatedPrincipalAmount / 100 : undefined,
      effectiveFrom: allocation ? dayjs(allocation.effectiveFrom) : dayjs(),
      eventType: allocation ? "ADD_DEBT_FINANCING" : "INITIAL_EQUITY_PURCHASE",
      financingInstrumentId: allocation?.financingInstrument?.id ?? allocation?.instrumentId ?? undefined,
      remark: allocation
        ? `根据融资分摊${allocation.allocationNo ? ` ${allocation.allocationNo}` : ""}补录资本事件`
        : undefined
    });
    setCapitalEventOpen(true);
  }

  function openEditCapitalEvent(event: CapitalEvent) {
    setEditingCapitalEvent(event);
    capitalEventForm.resetFields();
    capitalEventForm.setFieldsValue(capitalEventFormValues(event));
    setCapitalEventOpen(true);
  }

  async function saveCapitalEvent(values: CapitalEventValues) {
    if (!detailVehicle) {
      return;
    }

    try {
      const payload = buildCapitalEventPayload(values);
      const url = editingCapitalEvent
        ? `/vehicles/${detailVehicle.id}/capital-events/${editingCapitalEvent.id}`
        : `/vehicles/${detailVehicle.id}/capital-events`;
      await apiFetch(url, {
        body: JSON.stringify(payload),
        method: editingCapitalEvent ? "PATCH" : "POST"
      });
      void message.success(editingCapitalEvent ? "资本事件已更新" : "资本事件已新增");
      setCapitalEventOpen(false);
      setEditingCapitalEvent(null);
      capitalEventForm.resetFields();
      await loadVehicleFinancialData(detailVehicle.id);
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function cancelCapitalEvent(event: CapitalEvent) {
    if (!detailVehicle) {
      return;
    }

    Modal.confirm({
      cancelText: "取消",
      content: "确认作废该资本事件？作废后该事件不会再参与资本结构 preview，但会保留审计记录。",
      okText: "确认作废",
      onOk: async () => {
        try {
          await apiFetch(`/vehicles/${detailVehicle.id}/capital-events/${event.id}/cancel`, {
            body: JSON.stringify({ remark: "人工作废资本事件" }),
            method: "POST"
          });
          void message.success("资本事件已作废");
          await loadVehicleFinancialData(detailVehicle.id);
        } catch (error) {
          void message.error(getErrorMessage(error));
        }
      },
      title: "作废资本事件"
    });
  }

  function openRevenueShareRuleModal() {
    revenueShareRuleForm.resetFields();
    revenueShareRuleForm.setFieldsValue({
      effectiveFrom: dayjs(),
      ownerSharePercent: 30,
      platformSharePercent: 70,
      ruleType: "REVENUE_SHARE",
      settlementCycle: "MONTHLY",
      shareBasis: "RENTAL_PAID"
    });
    setRevenueShareRuleOpen(true);
  }

  async function saveRevenueShareRule(values: RevenueShareRuleValues) {
    if (!detailVehicle) {
      return;
    }

    const isFixedRent = values.ruleType === "FIXED_RENT";
    const isMixed = values.ruleType === "MIXED";
    const shouldSubmitShareRatio = values.ruleType === "REVENUE_SHARE" || isMixed;
    const shouldSubmitFixedAmount = isFixedRent || isMixed;
    if (
      shouldSubmitShareRatio &&
      typeof values.ownerSharePercent === "number" &&
      typeof values.platformSharePercent === "number" &&
      Math.abs(values.ownerSharePercent + values.platformSharePercent - 100) > 0.0001
    ) {
      void message.warning("车主分成与平台分成合计不等于 100%，请确认。");
    }

    try {
      await apiFetch(`/vehicles/${detailVehicle.id}/revenue-share-rules`, {
        body: JSON.stringify({
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          fixedMonthlyAmount: shouldSubmitFixedAmount ? toCentAmount(values.fixedMonthlyAmountYuan) : undefined,
          minimumGuaranteeAmount: isMixed ? toCentAmount(values.minimumGuaranteeAmountYuan) : undefined,
          ownerContact: values.ownerContact,
          ownerName: values.ownerName,
          ownerShareBps: shouldSubmitShareRatio ? percentToBps(values.ownerSharePercent) : undefined,
          platformShareBps: shouldSubmitShareRatio ? percentToBps(values.platformSharePercent) : undefined,
          remark: values.remark,
          ruleType: values.ruleType,
          settlementCycle: values.settlementCycle,
          shareBasis: isFixedRent ? "MANUAL" : values.shareBasis
        }),
        method: "POST"
      });
      void message.success("分润规则已新增");
      setRevenueShareRuleOpen(false);
      revenueShareRuleForm.resetFields();
      await loadVehicleFinancialData(detailVehicle.id);
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function openDeactivateShareRule(rule: RevenueShareRule) {
    setDeactivatingShareRule(rule);
    deactivateShareRuleForm.resetFields();
    deactivateShareRuleForm.setFieldsValue({ effectiveTo: dayjs() });
  }

  async function deactivateRevenueShareRule() {
    if (!detailVehicle || !deactivatingShareRule) {
      return;
    }

    const values = await deactivateShareRuleForm.validateFields();
    Modal.confirm({
      cancelText: "取消",
      content: "确认停用该分润规则？",
      okText: "确认停用",
      onOk: async () => {
        try {
          await apiFetch(`/vehicles/${detailVehicle.id}/revenue-share-rules/${deactivatingShareRule.id}/deactivate`, {
            body: JSON.stringify({
              effectiveTo: values.effectiveTo.format("YYYY-MM-DD"),
              remark: values.remark
            }),
            method: "POST"
          });
          void message.success("分润规则已停用");
          setDeactivatingShareRule(null);
          deactivateShareRuleForm.resetFields();
          await loadVehicleFinancialData(detailVehicle.id);
        } catch (error) {
          void message.error(getErrorMessage(error));
        }
      },
      title: "停用分润规则"
    });
  }

  async function refreshRevenueSharePreview() {
    if (!detailVehicle) {
      return;
    }

    const values = await revenueSharePreviewForm.validateFields();
    try {
      setVehicleFinancialLoading(true);
      const nextPreview = await apiFetch<RevenueSharePreview>(
        `/vehicles/${detailVehicle.id}/revenue-share-preview?startDate=${values.startDate.format("YYYY-MM-DD")}&endDate=${values.endDate.format("YYYY-MM-DD")}`
      );
      setRevenueSharePreview(nextPreview);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setVehicleFinancialLoading(false);
    }
  }

  async function relistVehicle(vehicle: Vehicle) {
    try {
      await apiFetch<Vehicle>(`/vehicles/${vehicle.id}/update-status`, {
        body: JSON.stringify({
          remark: "退车整备完成后重新入池",
          status: "AVAILABLE"
        }),
        method: "POST"
      });
      void message.success("车辆已设置为可租用");
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  const isInitialCapitalEvent = capitalEventType === "INITIAL_EQUITY_PURCHASE";
  const isDebtFinancingCapitalEvent = debtFinancingCapitalEventTypes.has(capitalEventType ?? "");
  const isFinancingReleaseCapitalEvent = financingReleaseCapitalEventTypes.has(capitalEventType ?? "");
  const isLeaseCapitalEvent = leaseCapitalEventTypes.has(capitalEventType ?? "");
  const isManagedCapitalEvent = managedCapitalEventTypes.has(capitalEventType ?? "");
  const isOtherCapitalEvent = capitalEventType === "OTHER";
  const showCapitalAcquisitionMode =
    isInitialCapitalEvent || isLeaseCapitalEvent || isManagedCapitalEvent || isOtherCapitalEvent;
  const showCapitalFinancingInstrument =
    isDebtFinancingCapitalEvent || isFinancingReleaseCapitalEvent || isOtherCapitalEvent;
  const showCapitalEquityAmount = isInitialCapitalEvent || isOtherCapitalEvent;
  const showCapitalDebtAmount = isDebtFinancingCapitalEvent || isOtherCapitalEvent;
  const showCapitalLessor = isLeaseCapitalEvent;
  const showCapitalManagedOwner = isManagedCapitalEvent;
  const showRevenueShareBasis = revenueShareRuleType !== "FIXED_RENT";
  const showRevenueShareRatio = revenueShareRuleType === "REVENUE_SHARE" || revenueShareRuleType === "MIXED";
  const showRevenueShareFixedAmount = revenueShareRuleType === "FIXED_RENT" || revenueShareRuleType === "MIXED";
  const showRevenueShareMinimumGuarantee = revenueShareRuleType === "MIXED";
  const revenueShareRatioTotal =
    typeof ownerSharePercent === "number" && typeof platformSharePercent === "number"
      ? ownerSharePercent + platformSharePercent
      : null;
  const showRevenueShareRatioWarning =
    showRevenueShareRatio &&
    revenueShareRatioTotal !== null &&
    Math.abs(revenueShareRatioTotal - 100) > 0.0001;

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              车辆资产
            </Typography.Title>
            <Typography.Text type="secondary">销售价初始化、季度复核与退车再入池管理</Typography.Text>
          </div>
          <Space>
            <ActionButton
              icon={<PlusOutlined />}
              onClick={openCreateVehicle}
              permission="vehicle:create"
              permissions={permissions}
              type="primary"
            >
              新增车辆
            </ActionButton>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={loadData}>
              刷新
            </Button>
          </Space>
        </Space>

        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              children: <VehicleTable columns={columns} loading={loading} rows={vehicles} />,
              key: "vehicles",
              label: "车辆列表"
            },
            {
              children: <VehicleTable columns={columns} loading={loading} rows={dueReviews} />,
              key: "due",
              label: `待销售价复核 (${dueReviews.length})`
            },
            {
              children: (
                <HistoryTable
                  loading={historyLoading}
                  rows={historyRows}
                  vehicle={historyVehicle}
                />
              ),
              key: "history",
              label: "销售价历史"
            }
          ]}
        />
      </Space>

      <Modal
        okText="保存"
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
        onOk={() => createForm.submit()}
        open={createOpen}
        title="新增车辆"
        width={720}
      >
        <Form<CreateVehicleValues> form={createForm} layout="vertical" onFinish={saveCreateVehicle}>
          <Form.Item label="VIN" name="vin" rules={[{ required: true, message: "请输入 VIN" }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车牌号" name="plateNo">
            <Input maxLength={32} />
          </Form.Item>
          <Form.Item label="品牌" name="brand" rules={[{ required: true, message: "请输入品牌" }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车系" name="series">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车型" name="model">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车型代码" name="vehicleModel" rules={[{ required: true, message: "请选择车型代码" }]}>
            <Select options={vehicleModelOptions} />
          </Form.Item>
          <Form.Item label="电池容量（kWh）" name="batteryCapacityKwh" rules={[{ required: true, message: "请输入电池容量" }]}>
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="电池使用方式" name="batteryUsageType" rules={[{ required: true, message: "请选择电池使用方式" }]}>
            <Select options={batteryUsageTypeOptions} />
          </Form.Item>
          <Form.Item label="年款" name="modelYear">
            <InputNumber min={1900} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="采购价（元）" name="purchasePriceAmountYuan" rules={[{ required: true, message: "请输入采购价" }]}>
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="采购日期" name="purchaseDate">
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            extra="用于残值预测车龄计算，请填写车辆首次登记上牌日期。"
            label="初次上牌日期"
            name="registrationDate"
          >
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            extra="用于记录过户、换牌等最近一次登记上牌日期，不参与当前残值预测车龄计算。"
            label="最近一次上牌日期"
            name="latestRegistrationDate"
          >
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="保险起期" name="insuranceStartDate" rules={[{ required: true, message: "请选择保险起期" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="保险止期" name="insuranceEndDate" rules={[{ required: true, message: "请选择保险止期" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="当前里程" name="currentMileageKm">
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="资产位置" name="assetLocation">
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        footer={null}
        onCancel={() => setDetailVehicle(null)}
        open={Boolean(detailVehicle)}
        title={detailVehicle ? `${detailVehicle.vehicleNo} 车辆详情` : "车辆详情"}
        width={1120}
      >
        {detailVehicle ? (
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            {getReturnReinitNotice(detailVehicle) ? (
              <Alert
                message={getReturnReinitNotice(detailVehicle)}
                showIcon
                type={canRelistAfterReturn(detailVehicle) ? "success" : "warning"}
              />
            ) : null}
            <Descriptions
              bordered
              column={2}
              items={[
                { label: "车辆编号", children: detailVehicle.vehicleNo },
                { label: "VIN", children: detailVehicle.vin ?? "-" },
                { label: "车牌号", children: detailVehicle.plateNo ?? "-" },
                { label: "品牌", children: detailVehicle.brand },
                { label: "车系", children: detailVehicle.series ?? "-" },
                { label: "车型", children: vehicleModelText(detailVehicle) },
                { label: "电池容量", children: formatKwh(detailVehicle.batteryCapacityKwh) },
                { label: "电池使用方式", children: batteryUsageTypeLabel(detailVehicle) },
                { label: "采购价", children: formatYuan(detailVehicle.purchasePriceAmount) },
                { label: "初次上牌日期", children: formatDate(detailVehicle.registrationDate) },
                { label: "最近一次上牌日期", children: formatDate(detailVehicle.latestRegistrationDate) },
                { label: "取得方式", children: labelOf(VEHICLE_ACQUISITION_MODE_LABELS, detailVehicle.acquisitionMode) },
                { label: "保险有效期", children: formatInsurancePeriod(detailVehicle) },
                { label: "当前销售价", children: formatYuan(detailVehicle.currentSalePriceAmount) },
                { label: "当前里程", children: `${detailVehicle.currentMileageKm.toLocaleString("zh-CN")} km` },
                { label: "车辆状态", children: labelOf(STATUS_LABELS, detailVehicle.status) },
                { label: "销售价状态", children: labelOf(STATUS_LABELS, detailVehicle.salePriceStatus) },
                { label: "资产位置", children: detailVehicle.assetLocation ?? "-" },
                { label: "备注", children: detailVehicle.remark ?? "-" }
              ]}
            />
            {canViewResidualForecast ? (
              <VehicleResidualForecastBlock
                history={residualForecastHistory}
                latest={residualForecastLatest}
                loading={residualForecastLoading}
                onAdoptPoint={openResidualForecastAdopt}
                onCreateValuationReview={openValuationReviewCreate}
                onGenerate={openResidualForecastGenerate}
                onOpenDetail={openResidualForecastDetail}
                onPageChange={(page, pageSize) => {
                  void refreshResidualForecastData(page, pageSize);
                }}
                onVoidForecast={openResidualForecastVoid}
                page={residualForecastPage}
                pageSize={residualForecastPageSize}
                permissions={permissions}
                total={residualForecastTotal}
                vehicle={detailVehicle}
              />
            ) : null}
            {canViewValuationReview ? (
              <VehicleValuationReviewRecordsBlock
                loading={valuationReviewLoading}
                onCancel={openValuationReviewCancel}
                onOpenDetail={openValuationReviewDetail}
                onPageChange={(page, pageSize) => {
                  void refreshValuationReviews(page, pageSize);
                }}
                page={valuationReviewPage}
                pageSize={valuationReviewPageSize}
                permissions={permissions}
                rows={valuationReviewRows}
                total={valuationReviewTotal}
              />
            ) : null}
            <VehicleCapitalStructureBlock
              capitalStructure={capitalStructure}
              loading={vehicleFinancialLoading}
            />
            <VehicleCapitalEventsBlock
              activeFinancingAllocations={capitalStructure?.activeFinancingAllocations ?? []}
              capitalEvents={capitalEvents}
              loading={vehicleFinancialLoading}
              onCancel={cancelCapitalEvent}
              onCreate={openCapitalEventModal}
              onCreateFromAllocation={openCapitalEventModal}
              onEdit={openEditCapitalEvent}
              permissions={permissions}
            />
            <VehicleRevenueShareRulesBlock
              loading={vehicleFinancialLoading}
              onCreate={openRevenueShareRuleModal}
              onDeactivate={openDeactivateShareRule}
              permissions={permissions}
              rules={revenueShareRules}
            />
            <VehicleRevenueSharePreviewBlock
              form={revenueSharePreviewForm}
              loading={vehicleFinancialLoading}
              onRefresh={refreshRevenueSharePreview}
              permissions={permissions}
              preview={revenueSharePreview}
            />
          </Space>
        ) : null}
      </Modal>

      <ResidualForecastGenerateModal
        curveOptions={residualCurveOptions}
        curveOptionsLoading={residualCurveOptionsLoading}
        form={residualForecastGenerateForm}
        onCancel={() => {
          setResidualForecastGenerateOpen(false);
          setResidualForecastPreview(null);
        }}
        onDryRun={dryRunResidualForecast}
        onGenerate={generateResidualForecast}
        open={residualForecastGenerateOpen}
        preview={residualForecastPreview}
        submitting={residualForecastGenerateSubmitting}
      />

      <ResidualForecastDetailDrawer
        forecast={residualForecastDetail}
        loading={residualForecastDetailLoading}
        onAdoptPoint={openResidualForecastAdopt}
        onCreateValuationReview={openValuationReviewCreate}
        onClose={() => setResidualForecastDetailOpen(false)}
        open={residualForecastDetailOpen}
        permissions={permissions}
      />

      <VehicleValuationReviewDetailDrawer
        loading={valuationReviewDetailLoading}
        onCancel={openValuationReviewCancel}
        onClose={() => setValuationReviewDetailOpen(false)}
        open={valuationReviewDetailOpen}
        permissions={permissions}
        review={valuationReviewDetail}
      />

      <Modal
        destroyOnHidden
        okButtonProps={{ loading: valuationReviewCreateSubmitting }}
        okText="发起复核"
        onCancel={() => setValuationReviewCreateTarget(null)}
        onOk={() => valuationReviewCreateForm.submit()}
        open={Boolean(valuationReviewCreateTarget)}
        title="发起车辆估值复核"
        width={760}
      >
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Alert
            message="本操作只会创建待审核复核记录，不会修改车辆当前销售价，也不会写入销售价历史。"
            showIcon
            type="info"
          />
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "预测点", children: valuationReviewCreateTarget?.id ?? "-" },
              { label: "预测周期", children: formatHorizon(valuationReviewCreateTarget?.horizonMonth) },
              { label: "目标日期", children: formatDate(valuationReviewCreateTarget?.targetDate) },
              { label: "当前车辆销售价", children: formatYuan(detailVehicle?.currentSalePriceAmount) },
              { label: "预测残值", children: formatYuan(valuationReviewCreateTarget?.predictedResidualAmount) },
              { label: "人工采用残值", children: formatYuan(valuationReviewCreateTarget?.adoptedResidualAmount) }
            ]}
            size="small"
          />
          <Form<CreateValuationReviewValues>
            form={valuationReviewCreateForm}
            layout="vertical"
            onFinish={submitValuationReviewCreate}
          >
            <Form.Item
              label="建议复核销售价（元）"
              name="requestedSalePriceAmountYuan"
              rules={[{ required: true, message: "请输入建议复核销售价" }, positiveYuanRule("建议复核销售价必须大于 0")]}
            >
              <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="复核原因" name="reason">
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item label="复核备注" name="reviewRemark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Space>
      </Modal>

      <Modal
        destroyOnHidden
        okButtonProps={{ danger: true, loading: valuationReviewCancelSubmitting }}
        okText="取消复核"
        onCancel={() => setValuationReviewCancelTarget(null)}
        onOk={() => valuationReviewCancelForm.submit()}
        open={Boolean(valuationReviewCancelTarget)}
        title="取消车辆估值复核"
      >
        <Alert
          message="取消后不会修改车辆当前销售价，也不会写入销售价历史。"
          showIcon
          style={{ marginBottom: 12 }}
          type="warning"
        />
        <Form<CancelValuationReviewValues>
          form={valuationReviewCancelForm}
          layout="vertical"
          onFinish={submitValuationReviewCancel}
        >
          <Form.Item
            label="取消原因"
            name="cancelReason"
            rules={[{ required: true, message: "请输入取消原因" }]}
          >
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        destroyOnHidden
        okButtonProps={{ loading: residualForecastAdoptSubmitting }}
        okText="采用"
        onCancel={() => setResidualForecastAdoptTarget(null)}
        onOk={() => residualForecastAdoptForm.submit()}
        open={Boolean(residualForecastAdoptTarget)}
        title="采用预测点"
      >
        <Alert
          message="采用值只记录在预测点上，不会覆盖车辆当前销售价，也不会写入销售价历史。"
          showIcon
          style={{ marginBottom: 12 }}
          type="info"
        />
        <Form<AdoptResidualForecastPointValues>
          form={residualForecastAdoptForm}
          layout="vertical"
          onFinish={submitResidualForecastAdopt}
        >
          <Form.Item
            label="采用残值金额（元）"
            name="adoptedResidualAmountYuan"
            rules={[{ required: true, message: "请输入采用残值金额" }]}
          >
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="采用备注" name="adoptRemark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        destroyOnHidden
        okButtonProps={{ danger: true, loading: residualForecastVoidSubmitting }}
        okText="作废"
        onCancel={() => setResidualForecastVoidTarget(null)}
        onOk={() => residualForecastVoidForm.submit()}
        open={Boolean(residualForecastVoidTarget)}
        title="作废预测记录"
      >
        <Alert
          message="作废后不会删除记录，但不再作为有效预测参考。"
          showIcon
          style={{ marginBottom: 12 }}
          type="warning"
        />
        <Form<VoidResidualForecastValues>
          form={residualForecastVoidForm}
          layout="vertical"
          onFinish={submitResidualForecastVoid}
        >
          <Form.Item label="作废备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        destroyOnHidden
        okText="保存"
        onCancel={() => {
          setCapitalEventOpen(false);
          setEditingCapitalEvent(null);
        }}
        onOk={() => capitalEventForm.submit()}
        open={capitalEventOpen}
        title={editingCapitalEvent ? "编辑资本事件" : "新增资本事件"}
        width={720}
      >
        <Form<CapitalEventValues> form={capitalEventForm} layout="vertical" onFinish={saveCapitalEvent}>
          <Form.Item label="事件类型" name="eventType" rules={[{ required: true, message: "请选择事件类型" }]}>
            <Select options={capitalEventTypeOptions} />
          </Form.Item>
          <Form.Item label="事件时间" name="effectiveFrom" rules={[{ required: true, message: "请选择事件时间" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          {showCapitalAcquisitionMode ? (
            <Form.Item label="取得方式" name="acquisitionMode">
              <Select allowClear options={acquisitionModeOptions} />
            </Form.Item>
          ) : null}
          {showCapitalFinancingInstrument ? (
            <Form.Item
              extra={financingInstrumentOptions.length > 0 ? "请选择融资工具，提交时会自动使用系统融资工具 ID。" : "当前无法加载融资工具列表，请填写系统融资工具 ID（UUID），不要填写 FI 开头的融资工具编号。"}
              label="融资工具"
              name="financingInstrumentId"
              rules={[{ required: financingCapitalEventTypes.has(capitalEventType ?? ""), message: "请选择融资工具" }]}
            >
              {financingInstrumentOptions.length > 0 ? (
                <Select
                  loading={financingInstrumentsLoading}
                  optionFilterProp="label"
                  options={financingInstrumentOptions}
                  placeholder="搜索融资工具编号 / 类型 / 资金方 / 合同编号"
                  showSearch
                />
              ) : (
                <Input placeholder="系统融资工具 ID（UUID）" />
              )}
            </Form.Item>
          ) : null}
          {showCapitalEquityAmount ? (
            <Form.Item label="自有资金金额（元）" name="equityCapitalAmountYuan">
              <InputNumber min={0} precision={2} style={{ width: "100%" }} />
            </Form.Item>
          ) : null}
          {showCapitalDebtAmount ? (
            <Form.Item label="债务本金金额（元）" name="debtPrincipalAmountYuan">
              <InputNumber min={0} precision={2} style={{ width: "100%" }} />
            </Form.Item>
          ) : null}
          {showCapitalLessor ? (
            <Form.Item label="出租方名称" name="lessorName">
              <Input maxLength={128} />
            </Form.Item>
          ) : null}
          {showCapitalManagedOwner ? (
            <>
              <Form.Item label="外部车主名称" name="externalOwnerName">
                <Input maxLength={128} />
              </Form.Item>
              <Form.Item label="托管方名称" name="managedOwnerName">
                <Input maxLength={128} />
              </Form.Item>
            </>
          ) : null}
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        destroyOnHidden
        okText="保存"
        onCancel={() => setRevenueShareRuleOpen(false)}
        onOk={() => revenueShareRuleForm.submit()}
        open={revenueShareRuleOpen}
        title="新增分润规则"
        width={720}
      >
        <Form<RevenueShareRuleValues> form={revenueShareRuleForm} layout="vertical" onFinish={saveRevenueShareRule}>
          <Form.Item label="规则类型" name="ruleType" rules={[{ required: true, message: "请选择规则类型" }]}>
            <Select options={revenueShareRuleTypeOptions} />
          </Form.Item>
          {showRevenueShareBasis ? (
            <Form.Item label="分润基础" name="shareBasis" rules={[{ required: true, message: "请选择分润基础" }]}>
              <Select options={revenueShareBasisOptions} />
            </Form.Item>
          ) : null}
          <Form.Item label="外部车主名称" name="ownerName">
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item label="外部车主联系方式" name="ownerContact">
            <Input maxLength={128} />
          </Form.Item>
          {showRevenueShareRatio ? (
            <>
              <Form.Item
                label="车主分成比例（%）"
                name="ownerSharePercent"
                rules={[{ required: revenueShareRuleType === "REVENUE_SHARE", message: "请输入车主分成比例" }]}
              >
                <InputNumber max={100} min={0} precision={2} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="平台分成比例（%）" name="platformSharePercent">
                <InputNumber max={100} min={0} precision={2} style={{ width: "100%" }} />
              </Form.Item>
              {showRevenueShareRatioWarning ? (
                <Alert
                  message="车主分成与平台分成合计不等于 100%，请确认。"
                  showIcon
                  style={{ marginBottom: 16 }}
                  type="warning"
                />
              ) : null}
            </>
          ) : null}
          {showRevenueShareFixedAmount ? (
            <Form.Item
              label="固定月金额（元）"
              name="fixedMonthlyAmountYuan"
              rules={[{ required: revenueShareRuleType === "FIXED_RENT", message: "请输入固定月金额" }]}
            >
              <InputNumber min={0} precision={2} style={{ width: "100%" }} />
            </Form.Item>
          ) : null}
          {showRevenueShareMinimumGuarantee ? (
            <Form.Item label="最低保底金额（元）" name="minimumGuaranteeAmountYuan">
              <InputNumber min={0} precision={2} style={{ width: "100%" }} />
            </Form.Item>
          ) : null}
          <Form.Item label="结算周期" name="settlementCycle">
            <Select options={revenueShareSettlementCycleOptions} />
          </Form.Item>
          <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        destroyOnHidden
        okText="停用"
        onCancel={() => setDeactivatingShareRule(null)}
        onOk={deactivateRevenueShareRule}
        open={Boolean(deactivatingShareRule)}
        title="停用分润规则"
      >
        <Form<DeactivateRevenueShareRuleValues> form={deactivateShareRuleForm} layout="vertical">
          <Form.Item label="停用日期" name="effectiveTo" rules={[{ required: true, message: "请选择停用日期" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        okText="保存"
        onCancel={() => {
          setEditingVehicle(null);
          editForm.resetFields();
        }}
        onOk={() => editForm.submit()}
        open={Boolean(editingVehicle)}
        title={editingVehicle ? `${editingVehicle.vehicleNo} 编辑车辆` : "编辑车辆"}
        width={720}
      >
        <Form<EditVehicleValues> form={editForm} layout="vertical" onFinish={saveEditVehicle}>
          <Form.Item label="VIN" name="vin" rules={[{ required: true, message: "请输入 VIN" }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车牌号" name="plateNo">
            <Input maxLength={32} />
          </Form.Item>
          <Form.Item label="品牌" name="brand" rules={[{ required: true, message: "请输入品牌" }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车系" name="series">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车型" name="model">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车型代码" name="vehicleModel" rules={[{ required: true, message: "请选择车型代码" }]}>
            <Select options={vehicleModelOptions} />
          </Form.Item>
          <Form.Item label="电池容量（kWh）" name="batteryCapacityKwh" rules={[{ required: true, message: "请输入电池容量" }]}>
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="电池使用方式" name="batteryUsageType" rules={[{ required: true, message: "请选择电池使用方式" }]}>
            <Select options={batteryUsageTypeOptions} />
          </Form.Item>
          <Form.Item label="年款" name="modelYear">
            <InputNumber min={1900} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="采购价（元）" name="purchasePriceAmountYuan" rules={[{ required: true, message: "请输入采购价" }]}>
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="采购日期" name="purchaseDate">
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            extra="用于残值预测车龄计算，请填写车辆首次登记上牌日期。"
            label="初次上牌日期"
            name="registrationDate"
          >
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            extra="用于记录过户、换牌等最近一次登记上牌日期，不参与当前残值预测车龄计算。"
            label="最近一次上牌日期"
            name="latestRegistrationDate"
          >
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="保险起期" name="insuranceStartDate" rules={[{ required: true, message: "请选择保险起期" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="保险止期" name="insuranceEndDate" rules={[{ required: true, message: "请选择保险止期" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="当前里程" name="currentMileageKm">
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="资产位置" name="assetLocation">
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        okText="保存"
        onCancel={() => setInitializingVehicle(null)}
        onOk={() => initializeForm.submit()}
        open={Boolean(initializingVehicle)}
        title={
          initializingVehicle
            ? `${initializingVehicle.vehicleNo} ${isReturnReinitVehicle(initializingVehicle) ? "RETURN_REINIT 重新定价" : "初始化销售价"}`
            : "初始化销售价"
        }
        width={620}
      >
        <Form<InitializeSalePriceValues> form={initializeForm} layout="vertical" onFinish={saveInitialize}>
          <Form.Item label="初始化类型" name="reviewType" rules={[{ required: true, message: "请选择初始化类型" }]}>
            <Select
              options={[
                { label: "新入池初始化", value: "INITIAL_POOL" },
                { label: "退车再入池重新定价", value: "RETURN_REINIT" }
              ]}
              onChange={(value) =>
                initializeForm.setFieldValue(
                  "reason",
                  value === "RETURN_REINIT" ? "退车整备后重新入池" : "新入池初始化"
                )
              }
            />
          </Form.Item>
          <Form.Item
            label="当前销售价（元）"
            name="currentSalePriceAmountYuan"
            rules={[{ required: true, message: "请输入当前销售价" }]}
          >
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="原因" name="reason" rules={[{ required: true, message: "请输入原因" }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        okText="保存"
        onCancel={() => setReviewingVehicle(null)}
        onOk={() => reviewForm.submit()}
        open={Boolean(reviewingVehicle)}
        title={reviewingVehicle ? `${reviewingVehicle.vehicleNo} 季度复核` : "季度复核"}
        width={620}
      >
        <Form<ReviewSalePriceValues> form={reviewForm} layout="vertical" onFinish={saveReview}>
          <Form.Item
            label="新销售价（元）"
            name="newSalePriceAmountYuan"
            rules={[{ required: true, message: "请输入新销售价" }]}
          >
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="复核季度" name="reviewQuarter" rules={[{ required: true, message: "请输入复核季度" }]}>
            <Input placeholder="2026Q3" />
          </Form.Item>
          <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}>
            <DatePicker
              style={{ width: "100%" }}
              onChange={(value) => {
                if (value) {
                  reviewForm.setFieldValue("reviewQuarter", toReviewQuarter(value));
                }
              }}
            />
          </Form.Item>
          <Form.Item label="原因" name="reason" rules={[{ required: true, message: "请输入原因" }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        okText="保存"
        onCancel={() => setStatusVehicle(null)}
        onOk={() => statusForm.submit()}
        open={Boolean(statusVehicle)}
        title={statusVehicle ? `${statusVehicle.vehicleNo} 更新状态` : "更新状态"}
        width={520}
      >
        <Form<StatusValues> form={statusForm} layout="vertical" onFinish={saveStatus}>
          {statusVehicle && getReturnReinitNotice(statusVehicle) ? (
            <Alert
              message={getReturnReinitNotice(statusVehicle)}
              showIcon
              style={{ marginBottom: 16 }}
              type={canRelistAfterReturn(statusVehicle) ? "success" : "warning"}
            />
          ) : null}
          <Form.Item label="车辆状态" name="status" rules={[{ required: true, message: "请选择车辆状态" }]}>
            <Select options={statusOptionsForVehicle(statusVehicle)} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </ProtectedShell>
  );
}

function VehicleTable({
  columns,
  loading,
  rows
}: Readonly<{
  columns: ColumnsType<Vehicle>;
  loading: boolean;
  rows: Vehicle[];
}>) {
  return (
    <Table
      columns={columns}
      dataSource={rows}
      loading={loading}
      rowKey="id"
      scroll={{ x: 1830 }}
    />
  );
}

function HistoryTable({
  loading,
  rows,
  vehicle
}: Readonly<{
  loading: boolean;
  rows: SalePriceHistory[];
  vehicle: Vehicle | null;
}>) {
  if (!vehicle) {
    return <Empty description="请在车辆列表中选择查看历史" />;
  }

  const columns: ColumnsType<SalePriceHistory> = [
    { dataIndex: "reviewType", render: (value: string) => labelOf(SALE_PRICE_REVIEW_TYPE_LABELS, value), title: "类型", width: 150 },
    { dataIndex: "reviewQuarter", title: "季度", width: 110 },
    { dataIndex: "beforeSalePriceAmount", render: formatYuan, title: "复核前销售价", width: 150 },
    { dataIndex: "afterSalePriceAmount", render: formatYuan, title: "复核后销售价", width: 150 },
    { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
    { dataIndex: "reason", title: "原因", width: 260 },
    { dataIndex: "createdAt", render: formatDateTime, title: "记录时间", width: 170 }
  ];

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Typography.Text type="secondary">
        {vehicle.vehicleNo} / {vehicle.plateNo ?? vehicle.vin ?? "-"}
      </Typography.Text>
      <Table columns={columns} dataSource={rows} loading={loading} rowKey="id" scroll={{ x: 1100 }} />
    </Space>
  );
}

function statusTag(labels: Record<string, string>, value?: string | null) {
  if (!value) {
    return "-";
  }
  const color = value === "ACTIVE" ? "green" : value === "RELEASED" || value === "INACTIVE" ? "blue" : "default";
  return <Tag color={color}>{labelOf(labels, value)}</Tag>;
}

function financingInstrumentText(instrument?: FinancingInstrumentSummary | null, instrumentId?: string | null) {
  if (!instrument) {
    return instrumentId ?? "-";
  }

  return [instrument.instrumentNo, instrument.lenderName].filter(Boolean).join(" / ") || instrument.id;
}

function financingInstrumentOptionLabel(instrument: FinancingInstrumentSummary) {
  const typeLabel = instrument.instrumentType
    ? labelOf(FINANCING_INSTRUMENT_TYPE_LABELS, instrument.instrumentType)
    : null;

  return [instrument.instrumentNo, typeLabel, instrument.lenderName, instrument.contractNo]
    .filter(Boolean)
    .join(" / ");
}

function hasCapitalEventForAllocation(allocation: FinancingAllocation, capitalEvents: CapitalEvent[]) {
  const instrumentId = allocation.financingInstrument?.id ?? allocation.instrumentId ?? null;
  if (!instrumentId) {
    return false;
  }

  return capitalEvents.some(
    (event) =>
      event.eventStatus === "ACTIVE" &&
      event.eventType === "ADD_DEBT_FINANCING" &&
      event.financingInstrumentId === instrumentId &&
      event.debtPrincipalAmount === allocation.allocatedPrincipalAmount &&
      dateKey(event.effectiveFrom) === dateKey(allocation.effectiveFrom)
  );
}

function dateKey(value?: string | null) {
  return value ? String(value).slice(0, 10) : "";
}

function vehicleResidualForecastPointColumns(
  onAdoptPoint: (point: VehicleResidualForecastPoint) => void,
  permissions: ReadonlySet<string>,
  showActions = true,
  onCreateValuationReview?: (point: VehicleResidualForecastPoint) => void
): ColumnsType<VehicleResidualForecastPoint> {
  const columns: ColumnsType<VehicleResidualForecastPoint> = [
    { dataIndex: "horizonMonth", render: formatHorizon, title: "预测周期", width: 120 },
    { dataIndex: "targetDate", render: formatDate, title: "目标日期", width: 120 },
    { dataIndex: "targetAgeMonth", render: formatNumber, title: "目标车龄（月）", width: 130 },
    { dataIndex: "matchedCurvePointAgeMonth", render: formatNumber, title: "匹配曲线点车龄", width: 140 },
    {
      dataIndex: "interpolationMethod",
      render: (value: string | null) => labelOf(RESIDUAL_FORECAST_INTERPOLATION_METHOD_LABELS, value),
      title: "插值方法",
      width: 150
    },
    { dataIndex: "predictedResidualAmount", render: formatYuan, title: "预测残值", width: 130 },
    { dataIndex: "predictedResidualRateBps", render: formatPercentFromBps, title: "残值率", width: 100 },
    { dataIndex: "lowerBoundAmount", render: formatYuan, title: "下界", width: 130 },
    { dataIndex: "upperBoundAmount", render: formatYuan, title: "上界", width: 130 },
    { dataIndex: "confidenceScore", render: formatScore, title: "置信度", width: 110 },
    { dataIndex: "pointStatus", render: residualForecastPointStatusTag, title: "状态", width: 110 },
    { dataIndex: "adoptedResidualAmount", render: formatYuan, title: "采用值", width: 130 },
    { dataIndex: "adoptedBy", render: (value: string | null) => value ?? "-", title: "采用人", width: 180 },
    { dataIndex: "adoptedAt", render: formatDateTime, title: "采用时间", width: 160 },
    { dataIndex: "adoptRemark", render: (value: string | null) => value ?? "-", title: "采用备注", width: 180 },
  ];

  if (showActions) {
    columns.push({
      fixed: "right",
      render: (_, record) => (
        <Space size={8}>
          <ActionButton
            allowed={record.pointStatus !== "UNSUPPORTED" && Boolean(record.id)}
            disabledReason={
              record.pointStatus === "UNSUPPORTED"
                ? "暂不支持的预测点不能采用。"
                : "试算结果尚未保存，不能采用。"
            }
            onClick={() => onAdoptPoint(record)}
            permission="residual_forecast:manage"
            permissions={permissions}
            size="small"
          >
            采用
          </ActionButton>
          {onCreateValuationReview ? (
            <ActionButton
              allowed={canCreateValuationReviewFromPoint(record)}
              disabledReason={
                record.pointStatus === "UNSUPPORTED"
                  ? "暂不支持的预测点不能发起估值复核。"
                  : "预测点缺少可用的预测或采用残值金额，不能发起估值复核。"
              }
              onClick={() => onCreateValuationReview(record)}
              permission="vehicle_valuation_review:create"
              permissions={permissions}
              size="small"
            >
              发起估值复核
            </ActionButton>
          ) : null}
        </Space>
      ),
      title: "操作",
      width: onCreateValuationReview ? 210 : 90
    });
  }

  return columns;
}

function VehicleResidualForecastBlock({
  history,
  latest,
  loading,
  onAdoptPoint,
  onCreateValuationReview,
  onGenerate,
  onOpenDetail,
  onPageChange,
  onVoidForecast,
  page,
  pageSize,
  permissions,
  total,
  vehicle
}: Readonly<{
  history: VehicleResidualForecast[];
  latest: VehicleResidualForecast | null;
  loading: boolean;
  onAdoptPoint: (point: VehicleResidualForecastPoint) => void;
  onCreateValuationReview: (point: VehicleResidualForecastPoint) => void;
  onGenerate: () => void;
  onOpenDetail: (forecast: VehicleResidualForecast) => void;
  onPageChange: (page: number, pageSize: number) => void;
  onVoidForecast: (forecast: VehicleResidualForecast) => void;
  page: number;
  pageSize: number;
  permissions: ReadonlySet<string>;
  total: number;
  vehicle: Vehicle;
}>) {
  const pointColumns = vehicleResidualForecastPointColumns(onAdoptPoint, permissions, true, onCreateValuationReview);
  const historyColumns: ColumnsType<VehicleResidualForecast> = [
    { dataIndex: "forecastNo", render: (value: string | null) => value ?? "-", title: "预测编号", width: 190 },
    { dataIndex: "forecastStatus", render: residualForecastStatusTag, title: "状态", width: 110 },
    {
      dataIndex: "forecastMethod",
      render: (value: string) => labelOf(VEHICLE_RESIDUAL_FORECAST_METHOD_LABELS, value),
      title: "方法",
      width: 120
    },
    {
      render: (_, record) => record.curve?.curveNo ?? snapshotValue(record.curveSnapshot, "curveNo"),
      title: "引用曲线",
      width: 190
    },
    { dataIndex: "asOfDate", render: formatDate, title: "预测基准日", width: 120 },
    { dataIndex: "vehicleAgeMonths", render: formatNumber, title: "车辆车龄（月）", width: 130 },
    { dataIndex: "pointCount", render: formatNumber, title: "点数", width: 90 },
    { dataIndex: "createdAt", render: formatDateTime, title: "创建时间", width: 160 },
    { dataIndex: "remark", render: (value: string | null) => value ?? "-", title: "备注", width: 180 },
    {
      fixed: "right",
      render: (_, record) => (
        <Space size={8}>
          <ActionButton
            allowed={Boolean(record.id)}
            disabledReason="该预测记录尚未保存，无法查看详情。"
            onClick={() => onOpenDetail(record)}
            permission="residual_forecast:view"
            permissions={permissions}
            size="small"
          >
            查看详情
          </ActionButton>
          <ActionButton
            allowed={Boolean(record.id) && record.forecastStatus !== "VOIDED"}
            danger
            disabledReason="已作废的预测记录不能重复作废。"
            onClick={() => onVoidForecast(record)}
            permission="residual_forecast:manage"
            permissions={permissions}
            size="small"
          >
            作废
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 160
    }
  ];

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          残值预测
        </Typography.Title>
        <ActionButton onClick={onGenerate} permission="residual_forecast:generate" permissions={permissions} size="small">
          生成残值预测
        </ActionButton>
      </Space>
      <Alert
        message="单车残值预测基于已启用的市场残值曲线生成。当前版本使用统计曲线，不使用 AI / ML；预测结果不会自动覆盖车辆当前销售价，也不会写入销售价历史。人工采用值只记录在预测点上，后续可用于资产收益测算。"
        showIcon
        type="info"
      />
      {!vehicle.registrationDate ? (
        <Alert message="车辆缺少初次上牌日期时无法生成残值预测。" showIcon type="warning" />
      ) : null}
      {latest ? (
        <>
          <Descriptions
            bordered
            column={3}
            items={[
              { label: "预测编号", children: latest.forecastNo ?? "-" },
              { label: "预测状态", children: residualForecastStatusTag(latest.forecastStatus) },
              { label: "预测方法", children: labelOf(VEHICLE_RESIDUAL_FORECAST_METHOD_LABELS, latest.forecastMethod) },
              { label: "引用曲线", children: latest.curve?.curveNo ?? snapshotValue(latest.curveSnapshot, "curveNo") },
              { label: "预测基准日", children: formatDate(latest.asOfDate) },
              { label: "车辆当前车龄（月）", children: formatNumber(latest.vehicleAgeMonths) },
              {
                label: "当前里程",
                children:
                  latest.currentMileageKm === undefined || latest.currentMileageKm === null
                    ? "-"
                    : `${latest.currentMileageKm.toLocaleString("zh-CN")} km`
              },
              { label: "品牌", children: latest.brand ?? "-" },
              { label: "车系", children: latest.series ?? "-" },
              { label: "车型", children: latest.model ?? "-" },
              { label: "年款", children: latest.modelYear ?? "-" },
              { label: "电池容量", children: formatKwh(latest.batteryCapacityKwh) },
              { label: "电池使用方式", children: labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, latest.batteryUsageType) },
              { label: "创建时间", children: formatDateTime(latest.createdAt) },
              { label: "备注", children: latest.remark ?? "-" }
            ]}
            size="small"
          />
          <Table
            columns={pointColumns}
            dataSource={latest.points ?? []}
            pagination={false}
            rowKey={(record, index) => record.id ?? `${record.horizonMonth}-${index}`}
            scroll={{ x: 1900 }}
            size="small"
            title={() => "最新预测点"}
          />
        </>
      ) : (
        <Empty description={loading ? "正在加载残值预测" : "当前车辆暂无残值预测记录"} />
      )}
      <Table
        columns={historyColumns}
        dataSource={history}
        loading={loading}
        pagination={{
          current: page,
          onChange: onPageChange,
          pageSize,
          showSizeChanger: true,
          total
        }}
        rowKey={(record, index) => record.id ?? `${record.forecastNo}-${index}`}
        scroll={{ x: 1460 }}
        size="small"
        title={() => "预测历史记录"}
      />
    </Space>
  );
}

function ResidualForecastGenerateModal({
  curveOptions,
  curveOptionsLoading,
  form,
  onCancel,
  onDryRun,
  onGenerate,
  open,
  preview,
  submitting
}: Readonly<{
  curveOptions: ResidualCurveSummary[];
  curveOptionsLoading: boolean;
  form: FormInstance<GenerateResidualForecastValues>;
  onCancel: () => void;
  onDryRun: () => void;
  onGenerate: () => void;
  open: boolean;
  preview: VehicleResidualForecastGenerationResult | null;
  submitting: boolean;
}>) {
  const previewForecast = preview?.forecast;
  const previewPoints = preview?.points ?? previewForecast?.points ?? [];

  return (
    <Modal
      destroyOnHidden
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button key="dryRun" onClick={onDryRun}>
          试算
        </Button>,
        <Button key="generate" loading={submitting} onClick={onGenerate} type="primary">
          正式生成
        </Button>
      ]}
      onCancel={onCancel}
      open={open}
      title="生成残值预测"
      width={980}
    >
      <Space orientation="vertical" size={12} style={{ width: "100%" }}>
        <Form<GenerateResidualForecastValues> form={form} layout="vertical">
          <Form.Item label="预测基准日" name="asOfDate" rules={[{ required: true, message: "请选择预测基准日" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="指定残值曲线（可选）" name="curveId">
            <Select
              allowClear
              loading={curveOptionsLoading}
              optionFilterProp="label"
              options={curveOptions.map((curve) => ({
                label: residualCurveOptionLabel(curve),
                value: curve.id
              }))}
              placeholder="不选择时由后端自动匹配生效曲线"
              showSearch
            />
          </Form.Item>
          <Form.Item
            extra="多个周期可用逗号、空格或换行分隔，最多 10 个非负整数。"
            label="预测周期（月）"
            name="horizonMonthsText"
            rules={[{ required: true, message: "请输入预测周期" }]}
          >
            <Input placeholder={defaultResidualForecastHorizons} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
        {preview ? (
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            <Alert message="当前为试算结果，未保存预测记录。" showIcon type="success" />
            <Descriptions
              bordered
              column={3}
              items={[
                { label: "匹配曲线", children: previewForecast?.curve?.curveNo ?? snapshotValue(previewForecast?.curveSnapshot, "curveNo") },
                { label: "预测基准日", children: formatDate(previewForecast?.asOfDate) },
                { label: "车辆车龄（月）", children: formatNumber(previewForecast?.vehicleAgeMonths) },
                { label: "当前里程", children: formatNumber(previewForecast?.currentMileageKm) },
                { label: "预测点数", children: formatNumber(preview.pointCount ?? previewPoints.length) },
                { label: "备注", children: previewForecast?.remark ?? "-" }
              ]}
              size="small"
            />
            <Table
              columns={vehicleResidualForecastPointColumns(() => undefined, new Set(), false)}
              dataSource={previewPoints}
              pagination={false}
              rowKey={(record, index) => record.id ?? `${record.horizonMonth}-${index}`}
              scroll={{ x: 1900 }}
              size="small"
            />
          </Space>
        ) : null}
      </Space>
    </Modal>
  );
}

function ResidualForecastDetailDrawer({
  forecast,
  loading,
  onAdoptPoint,
  onCreateValuationReview,
  onClose,
  open,
  permissions
}: Readonly<{
  forecast: VehicleResidualForecast | null;
  loading: boolean;
  onAdoptPoint: (point: VehicleResidualForecastPoint) => void;
  onCreateValuationReview: (point: VehicleResidualForecastPoint) => void;
  onClose: () => void;
  open: boolean;
  permissions: ReadonlySet<string>;
}>) {
  return (
    <Drawer onClose={onClose} open={open} title="残值预测详情" width={1000}>
      {forecast ? (
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Descriptions
            bordered
            column={3}
            items={[
              { label: "预测编号", children: forecast.forecastNo ?? "-" },
              { label: "状态", children: residualForecastStatusTag(forecast.forecastStatus) },
              { label: "方法", children: labelOf(VEHICLE_RESIDUAL_FORECAST_METHOD_LABELS, forecast.forecastMethod) },
              { label: "基准日", children: formatDate(forecast.asOfDate) },
              { label: "车辆车龄", children: formatNumber(forecast.vehicleAgeMonths) },
              {
                label: "当前里程",
                children:
                  forecast.currentMileageKm === undefined || forecast.currentMileageKm === null
                    ? "-"
                    : `${forecast.currentMileageKm.toLocaleString("zh-CN")} km`
              },
              { label: "引用曲线", children: forecast.curve?.curveNo ?? snapshotValue(forecast.curveSnapshot, "curveNo") },
              { label: "创建时间", children: formatDateTime(forecast.createdAt) },
              { label: "备注", children: forecast.remark ?? "-" }
            ]}
            size="small"
            title="预测基础信息"
          />
          <Descriptions
            bordered
            column={3}
            items={[
              { label: "品牌", children: forecast.brand ?? "-" },
              { label: "车系", children: forecast.series ?? "-" },
              { label: "车型", children: forecast.model ?? "-" },
              { label: "年款", children: forecast.modelYear ?? "-" },
              { label: "电池容量", children: formatKwh(forecast.batteryCapacityKwh) },
              { label: "电池使用方式", children: labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, forecast.batteryUsageType) },
              { label: "采购价", children: formatYuan(forecast.purchasePriceAmount) },
              { label: "当前销售价", children: formatYuan(forecast.currentSalePriceAmount) }
            ]}
            size="small"
            title="车辆快照"
          />
          <Descriptions
            bordered
            column={3}
            items={[
              { label: "曲线编号", children: forecast.curve?.curveNo ?? snapshotValue(forecast.curveSnapshot, "curveNo") },
              { label: "曲线状态", children: labelOf(VEHICLE_RESIDUAL_CURVE_STATUS_LABELS, forecast.curve?.curveStatus) },
              { label: "曲线方法", children: labelOf(VEHICLE_RESIDUAL_CURVE_METHOD_LABELS, forecast.curve?.curveMethod) },
              { label: "样本数", children: formatNumber(forecast.curve?.sampleCount) },
              { label: "曲线点数", children: formatNumber(forecast.curve?.pointCount) },
              { label: "置信度", children: formatScore(forecast.curve?.confidenceScore) },
              { label: "生成时间", children: formatDateTime(forecast.curve?.generatedAt) }
            ]}
            size="small"
            title="曲线快照"
          />
          <Table
            columns={vehicleResidualForecastPointColumns(onAdoptPoint, permissions, true, onCreateValuationReview)}
            dataSource={forecast.points ?? []}
            loading={loading}
            pagination={false}
            rowKey={(record, index) => record.id ?? `${record.horizonMonth}-${index}`}
            scroll={{ x: 1900 }}
            size="small"
            title={() => "预测点列表"}
          />
        </Space>
      ) : (
        <Empty description={loading ? "正在加载预测详情" : "暂无预测详情"} />
      )}
    </Drawer>
  );
}

function VehicleValuationReviewRecordsBlock({
  loading,
  onCancel,
  onOpenDetail,
  onPageChange,
  page,
  pageSize,
  permissions,
  rows,
  total
}: Readonly<{
  loading: boolean;
  onCancel: (review: VehicleValuationReview) => void;
  onOpenDetail: (review: VehicleValuationReview) => void;
  onPageChange: (page: number, pageSize: number) => void;
  page: number;
  pageSize: number;
  permissions: ReadonlySet<string>;
  rows: VehicleValuationReview[];
  total: number;
}>) {
  const columns: ColumnsType<VehicleValuationReview> = [
    { dataIndex: "reviewNo", render: (value: string | null) => value ?? "-", title: "复核编号", width: 190 },
    { dataIndex: "reviewSource", render: valuationReviewSourceTag, title: "来源", width: 120 },
    { dataIndex: "reviewStatus", render: valuationReviewStatusTag, title: "状态", width: 110 },
    { dataIndex: "originalSalePriceAmount", render: formatYuan, title: "原销售价", width: 130 },
    { dataIndex: "forecastResidualAmount", render: formatYuan, title: "预测残值", width: 130 },
    { dataIndex: "adoptedResidualAmount", render: formatYuan, title: "人工采用残值", width: 140 },
    { dataIndex: "requestedSalePriceAmount", render: formatYuan, title: "请求销售价", width: 130 },
    { dataIndex: "approvedSalePriceAmount", render: formatYuan, title: "审核通过销售价", width: 150 },
    { dataIndex: "requestedAt", render: formatDateTime, title: "发起时间", width: 160 },
    { dataIndex: "reviewedAt", render: formatDateTime, title: "审核时间", width: 160 },
    { dataIndex: "reason", render: (value: string | null) => value ?? "-", title: "原因", width: 220 },
    {
      fixed: "right",
      render: (_, record) => (
        <Space size={8}>
          <ActionButton
            onClick={() => onOpenDetail(record)}
            permission="vehicle_valuation_review:view"
            permissions={permissions}
            size="small"
          >
            查看详情
          </ActionButton>
          <ActionButton
            allowed={record.reviewStatus === "PENDING"}
            danger
            disabledReason="只有待审核复核可以取消。"
            onClick={() => onCancel(record)}
            permission="vehicle_valuation_review:create"
            permissions={permissions}
            size="small"
          >
            取消
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 160
    }
  ];

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        估值复核记录
      </Typography.Title>
      <Alert
        message="发起估值复核只会创建待审核记录，不会修改车辆当前销售价；只有审核通过后才会更新当前销售价并写入销售价历史。"
        showIcon
        type="info"
      />
      <Table
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{
          current: page,
          onChange: onPageChange,
          pageSize,
          showSizeChanger: true,
          total
        }}
        rowKey="id"
        scroll={{ x: 1780 }}
        size="small"
      />
    </Space>
  );
}

function VehicleValuationReviewDetailDrawer({
  loading,
  onCancel,
  onClose,
  open,
  permissions,
  review
}: Readonly<{
  loading: boolean;
  onCancel: (review: VehicleValuationReview) => void;
  onClose: () => void;
  open: boolean;
  permissions: ReadonlySet<string>;
  review: VehicleValuationReview | null;
}>) {
  return (
    <Drawer
      extra={
        review ? (
          <ActionButton
            allowed={review.reviewStatus === "PENDING"}
            danger
            disabledReason="只有待审核复核可以取消。"
            onClick={() => onCancel(review)}
            permission="vehicle_valuation_review:create"
            permissions={permissions}
            size="small"
          >
            取消
          </ActionButton>
        ) : null
      }
      onClose={onClose}
      open={open}
      title={vehicleValuationReviewTitle(review)}
      width={1000}
    >
      {review ? (
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "复核编号", children: review.reviewNo },
              { label: "复核来源", children: valuationReviewSourceTag(review.reviewSource) },
              { label: "复核状态", children: valuationReviewStatusTag(review.reviewStatus) },
              { label: "发起人", children: review.requestedBy ?? "-" },
              { label: "发起时间", children: formatDateTime(review.requestedAt) },
              { label: "审核人", children: review.reviewedBy ?? "-" },
              { label: "审核时间", children: formatDateTime(review.reviewedAt) },
              { label: "原因", children: review.reason ?? "-" },
              { label: "复核备注", children: review.reviewRemark ?? "-" },
              { label: "拒绝原因", children: review.rejectReason ?? "-" },
              { label: "取消原因", children: review.cancelReason ?? "-" }
            ]}
            size="small"
            title="复核基础信息"
          />
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "车辆编号", children: review.vehicle?.vehicleNo ?? "-" },
              { label: "VIN", children: review.vehicle?.vin ?? "-" },
              { label: "车牌号", children: review.vehicle?.plateNo ?? "-" },
              { label: "品牌", children: review.vehicle?.brand ?? "-" },
              { label: "车系", children: review.vehicle?.series ?? "-" },
              { label: "车型", children: review.vehicle?.model ?? "-" },
              { label: "当前销售价", children: formatYuan(review.vehicle?.currentSalePriceAmount) },
              { label: "原销售价", children: formatYuan(review.originalSalePriceAmount) }
            ]}
            size="small"
            title="车辆摘要"
          />
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "预测编号", children: review.forecast?.forecastNo ?? "-" },
              { label: "预测点", children: review.forecastPointId ?? "-" },
              { label: "预测周期", children: formatHorizon(review.forecastHorizonMonth ?? review.forecastPoint?.horizonMonth) },
              { label: "目标日期", children: formatDate(review.forecastTargetDate ?? review.forecastPoint?.targetDate) },
              { label: "预测残值", children: formatYuan(review.forecastResidualAmount ?? review.forecastPoint?.predictedResidualAmount) },
              { label: "人工采用残值", children: formatYuan(review.adoptedResidualAmount ?? review.forecastPoint?.adoptedResidualAmount) },
              { label: "置信度", children: formatScore(review.forecastConfidenceScore ?? review.forecastPoint?.confidenceScore) },
              { label: "预测值来源", children: labelOf(valuationReviewAmountSourceLabels, review.forecastAmountSource) }
            ]}
            size="small"
            title="残值预测摘要"
          />
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "原销售价", children: formatYuan(review.originalSalePriceAmount) },
              { label: "预测残值", children: formatYuan(review.forecastResidualAmount) },
              { label: "人工采用残值", children: formatYuan(review.adoptedResidualAmount) },
              { label: "请求销售价", children: formatYuan(review.requestedSalePriceAmount) },
              { label: "审核通过销售价", children: formatYuan(review.approvedSalePriceAmount) }
            ]}
            size="small"
            title="价格复核信息"
          />
          <Collapse
            items={[
              snapshotPanel("beforeSnapshot", "beforeSnapshot", review.beforeSnapshot),
              snapshotPanel("forecastSnapshot", "forecastSnapshot", review.forecastSnapshot),
              snapshotPanel("approvalSnapshot", "approvalSnapshot", review.approvalSnapshot),
              snapshotPanel("snapshot", "snapshot", review.snapshot)
            ]}
          />
        </Space>
      ) : (
        <Empty description={loading ? "正在加载估值复核详情" : "暂无估值复核详情"} />
      )}
    </Drawer>
  );
}

function VehicleCapitalStructureBlock({
  capitalStructure,
  loading
}: Readonly<{
  capitalStructure: CapitalStructurePreview | null;
  loading: boolean;
}>) {
  if (!capitalStructure) {
    return <Alert showIcon title={loading ? "正在加载资本结构" : "尚未录入资本结构数据"} type="info" />;
  }

  const missingReasons = capitalStructure.missingReasons ?? [];

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        资本结构
      </Typography.Title>
      {missingReasons.length > 0 ? (
        <Alert message={missingReasons.join("；")} showIcon type="warning" />
      ) : null}
      <Descriptions
        bordered
        column={3}
        items={[
          { label: "取得方式", children: labelOf(VEHICLE_ACQUISITION_MODE_LABELS, capitalStructure.acquisitionMode) },
          { label: "自有资金金额", children: formatCapitalYuan(capitalStructure.equityCapitalAmount) },
          { label: "债务本金金额", children: formatCapitalYuan(capitalStructure.debtPrincipalAmount) },
          { label: "资本覆盖金额", children: formatCapitalYuan(capitalStructure.capitalCoverageAmount) },
          { label: "资本覆盖率", children: formatRatio(capitalStructure.capitalCoverageRatio) },
          { label: "年化债务利息试算", children: formatCapitalYuan(capitalStructure.annualDebtInterestAmount) },
          { label: "月度债务利息试算", children: formatCapitalYuan(capitalStructure.monthlyDebtInterestAmount) },
          { label: "ROE 数据是否完整", children: capitalStructure.roeDataReady ? <Tag color="green">完整</Tag> : <Tag color="orange">待补充</Tag> },
          {
            label: "融资工具列表",
            children:
              capitalStructure.financingInstruments?.map((instrument) => instrument.instrumentNo).filter(Boolean).join("，") || "-"
          }
        ]}
      />
    </Space>
  );
}

function VehicleCapitalEventsBlock({
  activeFinancingAllocations,
  capitalEvents,
  loading,
  onCancel,
  onCreate,
  onCreateFromAllocation,
  onEdit,
  permissions
}: Readonly<{
  activeFinancingAllocations: FinancingAllocation[];
  capitalEvents: CapitalEvent[];
  loading: boolean;
  onCancel: (event: CapitalEvent) => void;
  onCreate: () => void;
  onCreateFromAllocation: (allocation: FinancingAllocation) => void;
  onEdit: (event: CapitalEvent) => void;
  permissions: ReadonlySet<string>;
}>) {
  const allocationColumns: ColumnsType<FinancingAllocation> = [
    { dataIndex: "allocationNo", render: (value: string | null) => value ?? "-", title: "分摊编号", width: 190 },
    {
      render: (_, record) => financingInstrumentText(record.financingInstrument, record.instrumentId),
      title: "融资工具",
      width: 240
    },
    { dataIndex: "allocatedPrincipalAmount", render: formatCapitalYuan, title: "分摊本金金额", width: 140 },
    { dataIndex: "allocationRatioBps", render: formatPercentFromBps, title: "分摊比例", width: 110 },
    { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
    { dataIndex: "effectiveTo", render: formatDate, title: "解除日期", width: 120 },
    { dataIndex: "remark", render: (value: string | null) => value ?? "-", title: "备注", width: 180 },
    {
      fixed: "right",
      render: (_, record) => {
        const alreadyRecorded = hasCapitalEventForAllocation(record, capitalEvents);
        return (
          <ActionButton
            allowed={!alreadyRecorded}
            disabledReason="该融资分摊已补录资本事件，如需更正请编辑或作废对应资本事件。"
            onClick={() => onCreateFromAllocation(record)}
            permission="capital_structure:manage"
            permissions={permissions}
            size="small"
          >
            {alreadyRecorded ? "已补录" : "补录资本事件"}
          </ActionButton>
        );
      },
      title: "操作",
      width: 130
    }
  ];

  const columns: ColumnsType<CapitalEvent> = [
    { dataIndex: "eventNo", title: "事件编号", width: 190 },
    {
      dataIndex: "eventType",
      render: (value: string) => labelOf(VEHICLE_CAPITAL_EVENT_TYPE_LABELS, value),
      title: "事件类型",
      width: 150
    },
    {
      dataIndex: "eventStatus",
      render: (value: string) => statusTag(VEHICLE_CAPITAL_EVENT_STATUS_LABELS, value),
      title: "状态",
      width: 100
    },
    { dataIndex: "effectiveFrom", render: formatDate, title: "事件时间", width: 120 },
    { render: (_, record) => financingInstrumentText(record.financingInstrument, record.financingInstrumentId), title: "关联融资工具", width: 220 },
    { dataIndex: "equityCapitalAmount", render: formatCapitalYuan, title: "自有资金金额", width: 140 },
    { dataIndex: "debtPrincipalAmount", render: formatCapitalYuan, title: "债务本金金额", width: 140 },
    { dataIndex: "remark", render: (value: string | null) => value ?? "-", title: "备注", width: 180 },
    {
      fixed: "right",
      render: (_, record) =>
        record.eventStatus === "CANCELLED" ? (
          "-"
        ) : (
          <Space size={8}>
            <ActionButton
              onClick={() => onEdit(record)}
              permission="capital_structure:manage"
              permissions={permissions}
              size="small"
            >
              编辑
            </ActionButton>
            <ActionButton
              danger
              onClick={() => onCancel(record)}
              permission="capital_structure:manage"
              permissions={permissions}
              size="small"
            >
              作废
            </ActionButton>
          </Space>
        ),
      title: "操作",
      width: 140
    }
  ];

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          资本事件
        </Typography.Title>
        <ActionButton onClick={onCreate} permission="capital_structure:manage" permissions={permissions} size="small">
          新增资本事件
        </ActionButton>
      </Space>
      {activeFinancingAllocations.length > 0 ? (
        <Table
          columns={allocationColumns}
          dataSource={activeFinancingAllocations}
          loading={loading}
          pagination={false}
          rowKey="id"
          scroll={{ x: 1230 }}
          size="small"
          title={() => "当前融资分摊（来自融资工具车辆分摊）"}
        />
      ) : null}
      <Table columns={columns} dataSource={capitalEvents} loading={loading} pagination={false} rowKey="id" scroll={{ x: 1400 }} size="small" />
    </Space>
  );
}

function VehicleRevenueShareRulesBlock({
  loading,
  onCreate,
  onDeactivate,
  permissions,
  rules
}: Readonly<{
  loading: boolean;
  onCreate: () => void;
  onDeactivate: (rule: RevenueShareRule) => void;
  permissions: ReadonlySet<string>;
  rules: RevenueShareRule[];
}>) {
  const columns: ColumnsType<RevenueShareRule> = [
    { dataIndex: "ruleNo", title: "规则编号", width: 190 },
    {
      dataIndex: "ruleType",
      render: (value: string) => labelOf(REVENUE_SHARE_RULE_TYPE_LABELS, value),
      title: "规则类型",
      width: 150
    },
    {
      dataIndex: "ruleStatus",
      render: (value: string) => statusTag(REVENUE_SHARE_RULE_STATUS_LABELS, value),
      title: "状态",
      width: 100
    },
    {
      dataIndex: "shareBasis",
      render: (value: string) => labelOf(REVENUE_SHARE_BASIS_LABELS, value),
      title: "分润基础",
      width: 130
    },
    { dataIndex: "ownerName", render: (value: string | null) => value ?? "-", title: "外部车主", width: 150 },
    { dataIndex: "ownerShareBps", render: formatPercentFromBps, title: "车主分成比例", width: 130 },
    { dataIndex: "platformShareBps", render: formatPercentFromBps, title: "平台分成比例", width: 130 },
    { dataIndex: "fixedMonthlyAmount", render: formatCapitalYuan, title: "固定月金额", width: 130 },
    { dataIndex: "minimumGuaranteeAmount", render: formatCapitalYuan, title: "最低保底金额", width: 140 },
    {
      dataIndex: "settlementCycle",
      render: (value: string) => labelOf(REVENUE_SHARE_SETTLEMENT_CYCLE_LABELS, value),
      title: "结算周期",
      width: 120
    },
    { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
    { dataIndex: "effectiveTo", render: formatDate, title: "结束日期", width: 120 },
    { dataIndex: "remark", render: (value: string | null) => value ?? "-", title: "备注", width: 180 },
    {
      fixed: "right",
      render: (_, record) => (
        <ActionButton
          allowed={record.ruleStatus === "ACTIVE"}
          disabledReason="仅生效中的分润规则可以停用"
          onClick={() => onDeactivate(record)}
          permission="revenue_share:manage"
          permissions={permissions}
          size="small"
        >
          停用
        </ActionButton>
      ),
      title: "操作",
      width: 100
    }
  ];

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          分润规则
        </Typography.Title>
        <ActionButton onClick={onCreate} permission="revenue_share:manage" permissions={permissions} size="small">
          新增分润规则
        </ActionButton>
      </Space>
      <Table columns={columns} dataSource={rules} loading={loading} pagination={false} rowKey="id" scroll={{ x: 1800 }} size="small" />
    </Space>
  );
}

function VehicleRevenueSharePreviewBlock({
  form,
  loading,
  onRefresh,
  permissions,
  preview
}: Readonly<{
  form: FormInstance<RevenueSharePreviewValues>;
  loading: boolean;
  onRefresh: () => void;
  permissions: ReadonlySet<string>;
  preview: RevenueSharePreview | null;
}>) {
  const previewData = preview?.preview;

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          分润试算
        </Typography.Title>
        <Form form={form} layout="inline">
          <Form.Item label="开始日期" name="startDate" rules={[{ required: true, message: "请选择开始日期" }]}>
            <DatePicker />
          </Form.Item>
          <Form.Item label="结束日期" name="endDate" rules={[{ required: true, message: "请选择结束日期" }]}>
            <DatePicker />
          </Form.Item>
          <Form.Item>
            <ActionButton
              allowed={permissions.has("revenue_share:view") || permissions.has("report:asset")}
              disabledReason="无分润试算查看权限"
              loading={loading}
              onClick={onRefresh}
              size="small"
            >
              刷新试算
            </ActionButton>
          </Form.Item>
        </Form>
      </Space>
      {previewData ? (
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          {!previewData.previewSupported && previewData.unsupportedReason ? (
            <Alert message={previewData.unsupportedReason} showIcon type="warning" />
          ) : null}
          {previewData.warnings?.length ? <Alert message={previewData.warnings.join("；")} showIcon type="warning" /> : null}
          <Descriptions
            bordered
            column={3}
            items={[
              { label: "是否支持试算", children: previewData.previewSupported ? <Tag color="green">支持</Tag> : <Tag color="orange">暂不支持</Tag> },
              { label: "分润基础金额", children: formatCapitalYuan(previewData.shareBaseAmount) },
              { label: "固定成本金额", children: formatCapitalYuan(previewData.fixedCostAmount) },
              { label: "车主分润金额", children: formatCapitalYuan(previewData.ownerShareAmount) },
              { label: "平台留存金额", children: formatCapitalYuan(previewData.platformShareAmount) },
              { label: "不支持原因", children: previewData.unsupportedReason ?? "-" }
            ]}
          />
        </Space>
      ) : (
        <Alert showIcon title="尚无可展示的分润试算" type="info" />
      )}
    </Space>
  );
}

function buildVehicleColumns(
  openDetail: (vehicle: Vehicle) => void,
  openEdit: (vehicle: Vehicle) => void,
  openInitialize: (vehicle: Vehicle) => void,
  openReview: (vehicle: Vehicle) => void,
  openHistory: (vehicle: Vehicle) => void,
  openStatus: (vehicle: Vehicle) => void,
  relistVehicle: (vehicle: Vehicle) => void,
  permissions: ReadonlySet<string>
): ColumnsType<Vehicle> {
  return [
    { dataIndex: "vin", render: (value: string | null) => value ?? "-", title: "VIN", width: 180 },
    { dataIndex: "plateNo", render: (value: string | null) => value ?? "-", title: "车牌号", width: 120 },
    { render: (_, record) => vehicleModelText(record), title: "车型", width: 220 },
    { dataIndex: "batteryCapacityKwh", render: formatKwh, title: "电池容量", width: 120 },
    { render: (_, record) => batteryUsageTypeLabel(record), title: "电池使用方式", width: 140 },
    { dataIndex: "acquisitionMode", render: (value: string | null) => labelOf(VEHICLE_ACQUISITION_MODE_LABELS, value), title: "取得方式", width: 190 },
    { dataIndex: "currentSalePriceAmount", render: formatYuan, title: "当前销售价", width: 140 },
    { render: (_, record) => formatInsurancePeriod(record), title: "保险有效期", width: 230 },
    { dataIndex: "currentSalePriceReviewedAt", render: formatDateTime, title: "最近复核时间", width: 170 },
    { dataIndex: "nextSalePriceReviewAt", render: formatDate, title: "下次复核时间", width: 140 },
    {
      dataIndex: "salePriceStatus",
      render: (value: string) => <Tag color={salePriceStatusColors[value] ?? "default"}>{labelOf(STATUS_LABELS, value)}</Tag>,
      title: "销售价状态",
      width: 130
    },
    {
      dataIndex: "status",
      render: (value: string) => <Tag color={vehicleStatusColors[value] ?? "default"}>{labelOf(STATUS_LABELS, value)}</Tag>,
      title: "车辆状态",
      width: 120
    },
    {
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Button icon={<EyeOutlined />} onClick={() => openDetail(record)} size="small">
            详情
          </Button>
          <ActionButton
            icon={<EditOutlined />}
            onClick={() => openEdit(record)}
            permission="vehicle:update"
            permissions={permissions}
            size="small"
          >
            编辑
          </ActionButton>
          <ActionButton
            availability={canInitializeVehicleSalePrice(record, permissions)}
            icon={<DollarOutlined />}
            onClick={() => openInitialize(record)}
            size="small"
          >
            {isReturnReinitVehicle(record) ? "RETURN_REINIT 重新定价" : "初始化销售价"}
          </ActionButton>
          {isReturnReinitVehicle(record) ? (
            <ActionButton
              availability={actionAvailability({
                allowed: canRelistAfterReturn(record),
                disabledReason: "退回车辆需重新初始化当前销售价后才能入池",
                noPermissionReason: "无更新车辆状态权限",
                permission: "vehicle:update_status",
                permissions
              })}
              icon={<CarOutlined />}
              onClick={() => relistVehicle(record)}
              size="small"
            >
              设置为可租用
            </ActionButton>
          ) : null}
          <ActionButton
            availability={canReviewVehicleSalePrice(record, permissions)}
            icon={<SyncOutlined />}
            onClick={() => openReview(record)}
            size="small"
          >
            季度复核
          </ActionButton>
          <ActionButton
            icon={<HistoryOutlined />}
            onClick={() => openHistory(record)}
            permission="vehicle:history_view"
            permissions={permissions}
            size="small"
          >
            查看历史
          </ActionButton>
          <ActionButton
            availability={canUpdateVehicleStatus(record, permissions)}
            icon={<CarOutlined />}
            onClick={() => openStatus(record)}
            size="small"
          >
            更新状态
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 560
    }
  ];
}
