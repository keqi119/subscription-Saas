"use client";

import {
  CheckCircleOutlined,
  CopyOutlined,
  DownloadOutlined,
  EyeOutlined,
  LineChartOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
  UploadOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Collapse,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Col,
  Select,
  Skeleton,
  Space,
  Table,
  Tabs,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import {
  MARKET_PRICE_IMPORT_STATUS_LABELS,
  MARKET_PRICE_OBSERVATION_STATUS_LABELS,
  MARKET_PRICE_SOURCE_LABELS,
  MARKET_PRICE_TYPE_LABELS,
  MARKET_SELLER_TYPE_LABELS,
  RESIDUAL_MODEL_ALGORITHM_LABELS,
  RESIDUAL_MODEL_RUN_OUTPUT_STATUS_LABELS,
  RESIDUAL_MODEL_RUN_OUTPUT_TYPE_LABELS,
  RESIDUAL_MODEL_RUN_STATUS_LABELS,
  RESIDUAL_MODEL_RUN_TYPE_LABELS,
  RESIDUAL_MODEL_TARGET_TYPE_LABELS,
  VEHICLE_BATTERY_USAGE_TYPE_LABELS,
  VEHICLE_RESIDUAL_CURVE_METHOD_LABELS,
  VEHICLE_RESIDUAL_CURVE_STATUS_LABELS,
  labelOf
} from "../../constants/labels";
import { apiFetch } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";
import { buildQuery, formatDate, formatDateTime, getErrorMessage, optionsFromLabels, toCentAmount } from "../../lib/capital-format";

const CSV_HEADER =
  "observedAt,sourceListingId,brand,series,model,modelYear,trim,batteryCapacityKwh,batteryUsageType,mileageKm,registrationDate,vehicleAgeMonths,province,city,priceType,priceAmount,listingPriceAmount,transactionPriceAmount,listingDays,sellerType,conditionGrade,batteryHealthPercent,accidentFlag,sourceUrl,remark";

const CSV_TEMPLATE = `${CSV_HEADER}
2026-06-01,ET5-SH-001,NIO,ET5,ET5 75kWh,2024,标准续航,75,BUYOUT,18000,2024-06-01,24,上海,上海,LISTING,168000,168000,,12,PLATFORM,A,92.5,false,https://example.com/listing/ET5-SH-001,示例样本`;

const DEFAULT_CURVE_PRICE_TYPES = ["TRANSACTION", "AUCTION", "DEALER_QUOTE", "INTERNAL_SALE", "LISTING"];

const CSV_ENUM_FIELD_GUIDES = [
  {
    field: "batteryUsageType",
    label: "电池使用方式",
    values: [
      ["BUYOUT", "买断"],
      ["BAAS", "BaaS"]
    ]
  },
  {
    field: "priceType",
    label: "价格类型",
    values: [
      ["LISTING", "挂牌价"],
      ["TRANSACTION", "成交价"],
      ["AUCTION", "拍卖价"],
      ["DEALER_QUOTE", "经销商报价"],
      ["INTERNAL_SALE", "内部成交价"],
      ["ESTIMATE", "估算价"]
    ]
  },
  {
    field: "sellerType",
    label: "卖家类型",
    values: [
      ["INDIVIDUAL", "个人"],
      ["DEALER", "经销商"],
      ["PLATFORM", "平台"],
      ["AUCTION_HOUSE", "拍卖机构"],
      ["INTERNAL", "内部"],
      ["UNKNOWN", "未知"]
    ]
  }
];

const CSV_ENUM_GUIDE_TEXT = CSV_ENUM_FIELD_GUIDES.map(
  (item) => `${item.field}（${item.label}）：${item.values.map(([value, label]) => `${value} = ${label}`).join("；")}`
).join("\n");

const csvImportActionLabels: Record<string, string> = {
  FAILED: "失败",
  IMPORTED: "已导入",
  SKIPPED_DUPLICATE: "重复跳过"
};

const tagColors: Record<string, string> = {
  ACTIVE: "green",
  ARCHIVED: "default",
  CANCELLED: "default",
  COMPLETED: "green",
  CREATED: "blue",
  CSV_IMPORT: "blue",
  DRAFT: "blue",
  EXTERNAL_MODEL: "magenta",
  FAILED: "red",
  IGNORED: "orange",
  IMPORTED: "green",
  MANUAL: "cyan",
  MANUAL_IMPORT: "orange",
  ML_INFERENCE: "cyan",
  ML_TRAINING: "purple",
  ML_MODEL: "purple",
  PARTIAL_FAILED: "orange",
  RESIDUAL_CURVE: "blue",
  RUNNING: "processing",
  STATISTICAL_MEDIAN: "geekblue",
  STATISTICAL_BASELINE: "geekblue",
  SKIPPED_DUPLICATE: "orange",
  SUPERSEDED: "orange",
  VEHICLE_FORECAST: "cyan",
  VOIDED: "red"
};

interface ObservationRow {
  accidentFlag?: boolean | null;
  batchId?: string | null;
  batteryCapacityKwh?: number | null;
  batteryHealthPercent?: number | null;
  batteryUsageType?: string | null;
  brand: string;
  city?: string | null;
  conditionGrade?: string | null;
  confidenceScore?: number | null;
  createdAt: string;
  createdBy?: string | null;
  dedupeKey: string;
  id: string;
  listingDays?: number | null;
  listingPriceAmount?: number | null;
  mileageKm?: number | null;
  model: string;
  modelYear?: number | null;
  observationNo: string;
  observationStatus: string;
  observedAt: string;
  priceAmount: number;
  priceType: string;
  province?: string | null;
  rawSnapshot?: unknown;
  registrationDate?: string | null;
  remark?: string | null;
  sellerType?: string | null;
  series?: string | null;
  source: string;
  sourceListingId?: string | null;
  sourceUrlHash?: string | null;
  transactionPriceAmount?: number | null;
  trim?: string | null;
  updatedAt: string;
  updatedBy?: string | null;
  vehicleAgeMonths?: number | null;
}

interface ObservationListResponse {
  items: ObservationRow[];
  page: number;
  pageSize: number;
  total: number;
}

interface ImportBatchRow {
  batchNo: string;
  createdAt: string;
  errorSnapshot?: unknown;
  failedRows: number;
  fileName?: string | null;
  id: string;
  importedBy?: string | null;
  importedRows: number;
  importStatus: string;
  observationCount?: number | null;
  remark?: string | null;
  skippedRows: number;
  snapshot?: unknown;
  source: string;
  totalRows: number;
  updatedAt: string;
}

interface ImportBatchListResponse {
  items: ImportBatchRow[];
  page: number;
  pageSize: number;
  total: number;
}

interface CsvImportItem {
  action: string;
  observationId?: string;
  reason: string;
  rowNumber: number;
}

interface CsvImportResult {
  batch: ImportBatchRow;
  failedRows: number;
  importedRows: number;
  items: CsvImportItem[];
  skippedRows: number;
  totalRows: number;
}

interface CurvePointRow {
  ageMonth: number;
  averagePriceAmount?: number | null;
  confidenceScore?: number | null;
  curveId?: string | null;
  id?: string | null;
  lowerBoundAmount?: number | null;
  maxPriceAmount?: number | null;
  medianPriceAmount?: number | null;
  mileageBucketEndKm?: number | null;
  mileageBucketStartKm?: number | null;
  minPriceAmount?: number | null;
  p25PriceAmount?: number | null;
  p75PriceAmount?: number | null;
  pointSnapshot?: unknown;
  predictedResidualAmount?: number | null;
  predictedResidualRateBps?: number | null;
  sampleCount: number;
  upperBoundAmount?: number | null;
}

interface ResidualCurveRow {
  batteryCapacityKwh?: number | null;
  batteryUsageType?: string | null;
  brand: string;
  confidenceScore?: number | null;
  createdAt?: string;
  createdBy?: string | null;
  curveMethod: string;
  curveName?: string | null;
  curveNo?: string | null;
  curveStatus: string;
  curveVersion?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  generatedAt?: string | null;
  id?: string | null;
  metrics?: unknown;
  model: string;
  modelYear?: number | null;
  pointCount: number;
  points?: CurvePointRow[];
  priceTypes?: unknown;
  referencePriceAmount?: number | null;
  remark?: string | null;
  sampleCount: number;
  sampleEndDate?: string | null;
  sampleFilterSnapshot?: unknown;
  sampleStartDate?: string | null;
  series?: string | null;
  snapshot?: unknown;
  trim?: string | null;
  updatedAt?: string;
  updatedBy?: string | null;
}

interface ResidualCurveListResponse {
  items: ResidualCurveRow[];
  page: number;
  pageSize: number;
  total: number;
}

interface ResidualCurveGenerateResult {
  curve: ResidualCurveRow;
  dryRun: boolean;
  pointCount: number;
  points: CurvePointRow[];
  sampleCount: number;
  skippedReasons?: unknown;
  skippedSampleCount: number;
}

interface ResidualModelRunOutputRow {
  createdAt: string;
  curve?: {
    brand?: string | null;
    curveMethod?: string | null;
    curveNo?: string | null;
    curveStatus?: string | null;
    id?: string | null;
    model?: string | null;
  } | null;
  curveId?: string | null;
  forecast?: {
    asOfDate?: string | null;
    forecastMethod?: string | null;
    forecastNo?: string | null;
    forecastStatus?: string | null;
    id?: string | null;
    model?: string | null;
    vehicleId?: string | null;
  } | null;
  forecastId?: string | null;
  id: string;
  outputNo?: string | null;
  outputSnapshot?: unknown;
  outputStatus: string;
  outputType: string;
  remark?: string | null;
  runId: string;
  updatedAt: string;
  vehicle?: {
    brand?: string | null;
    id?: string | null;
    model?: string | null;
    series?: string | null;
    vehicleNo?: string | null;
  } | null;
  vehicleId?: string | null;
}

interface ResidualModelRunRow {
  algorithm?: string | null;
  artifactUri?: string | null;
  createdAt: string;
  createdBy?: string | null;
  errorSnapshot?: unknown;
  featureSnapshot?: unknown;
  filterSnapshot?: unknown;
  finishedAt?: string | null;
  id: string;
  metricsSnapshot?: unknown;
  modelName?: string | null;
  modelProvider?: string | null;
  modelVersion?: string | null;
  outputCount?: number | null;
  outputs?: ResidualModelRunOutputRow[];
  outputSnapshot?: unknown;
  parameterSnapshot?: unknown;
  remark?: string | null;
  runName?: string | null;
  runNo: string;
  runStatus: string;
  runType: string;
  sampleCount?: number | null;
  startedAt?: string | null;
  targetBatteryCapacityKwh?: number | null;
  targetBatteryUsageType?: string | null;
  targetBrand?: string | null;
  targetModel?: string | null;
  targetModelYear?: number | null;
  targetSeries?: string | null;
  targetTrim?: string | null;
  targetType: string;
  trainingDataEndDate?: string | null;
  trainingDataStartDate?: string | null;
  updatedAt: string;
  updatedBy?: string | null;
}

interface ResidualModelRunListResponse {
  items: ResidualModelRunRow[];
  page: number;
  pageSize: number;
  total: number;
}

interface ObservationFilterValues {
  brand?: string;
  city?: string;
  endDate?: Dayjs | null;
  maxMileageKm?: number | null;
  maxPriceYuan?: number | null;
  minMileageKm?: number | null;
  minPriceYuan?: number | null;
  model?: string;
  modelYear?: number | null;
  observationStatus?: string;
  priceType?: string;
  series?: string;
  source?: string;
  startDate?: Dayjs | null;
}

interface BatchFilterValues {
  endDate?: Dayjs | null;
  importStatus?: string;
  source?: string;
  startDate?: Dayjs | null;
}

interface CurveFilterValues {
  batteryUsageType?: string;
  brand?: string;
  curveMethod?: string;
  curveStatus?: string;
  model?: string;
  modelYear?: number | null;
  series?: string;
}

interface ModelRunFilterValues {
  endDate?: Dayjs | null;
  modelVersion?: string;
  runStatus?: string;
  runType?: string;
  startDate?: Dayjs | null;
  targetBrand?: string;
  targetModel?: string;
  targetSeries?: string;
  targetType?: string;
}

interface ObservationFormValues {
  accidentFlag?: "false" | "true";
  batteryCapacityKwh?: number | null;
  batteryHealthPercent?: number | null;
  batteryUsageType?: string;
  brand: string;
  city?: string;
  conditionGrade?: string;
  listingDays?: number | null;
  listingPriceAmountYuan?: number | null;
  mileageKm?: number | null;
  model: string;
  modelYear?: number | null;
  observedAt: Dayjs;
  priceAmountYuan: number;
  priceType: string;
  province?: string;
  registrationDate?: Dayjs | null;
  remark?: string;
  sellerType?: string;
  series?: string;
  source: string;
  sourceListingId?: string;
  sourceUrl?: string;
  transactionPriceAmountYuan?: number | null;
  trim?: string;
  vehicleAgeMonths?: number | null;
}

interface CsvImportFormValues {
  csvText: string;
  fileName?: string;
  remark?: string;
  source: string;
}

interface VoidFormValues {
  remark?: string;
}

interface CurveGenerateFormValues {
  batteryCapacityKwh?: number | null;
  batteryUsageType?: string;
  brand: string;
  minSamplePerPoint?: number | null;
  model: string;
  modelYear?: number | null;
  priceTypes?: string[];
  referencePriceYuan?: number | null;
  remark?: string;
  sampleEndDate?: Dayjs | null;
  sampleStartDate?: Dayjs | null;
  series?: string;
  trim?: string;
}

interface CurveActivateFormValues {
  effectiveFrom: Dayjs;
  remark?: string;
}

interface CurveArchiveFormValues {
  remark?: string;
}

interface ModelRunCreateFormValues {
  algorithm?: string;
  featureSnapshotText?: string;
  filterSnapshotText?: string;
  modelName?: string;
  modelProvider?: string;
  modelVersion?: string;
  parameterSnapshotText?: string;
  remark?: string;
  runName?: string;
  runStatus: string;
  runType: string;
  sampleCount?: number | null;
  targetBatteryCapacityKwh?: number | null;
  targetBatteryUsageType?: string;
  targetBrand?: string;
  targetModel?: string;
  targetModelYear?: number | null;
  targetSeries?: string;
  targetTrim?: string;
  targetType: string;
  trainingDataEndDate?: Dayjs | null;
  trainingDataStartDate?: Dayjs | null;
}

interface ModelRunCompleteFormValues {
  metricsSnapshotText?: string;
  outputSnapshotText?: string;
  outputsText?: string;
  remark?: string;
}

interface ModelRunFailFormValues {
  errorSnapshotText?: string;
  remark?: string;
}

interface ModelRunCancelFormValues {
  remark?: string;
}

function text(value?: unknown) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  return String(value);
}

function yuan(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `${(value / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })} 元`;
}

function currencyYuan(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `¥${(value / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}`;
}

function bpsPercent(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `${(value / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}%`;
}

function km(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("zh-CN")} km` : "-";
}

function kwh(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("zh-CN")} kWh` : "-";
}

function percent(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}%` : "-";
}

function yesNo(value?: boolean | null) {
  if (value === true) {
    return "是";
  }
  if (value === false) {
    return "否";
  }
  return "-";
}

function enumTag(labels: Record<string, string>, value?: string | null) {
  if (!value) {
    return "-";
  }
  return <Tag color={tagColors[value] ?? "default"}>{labelOf(labels, value)}</Tag>;
}

function confidenceTag(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  const color = value >= 80 ? "green" : value >= 60 ? "orange" : "red";
  return <Tag color={color}>{value}</Tag>;
}

function jsonBlock(value: unknown) {
  if (value === null || value === undefined) {
    return <Typography.Text type="secondary">-</Typography.Text>;
  }
  return (
    <pre
      style={{
        background: "#f8fafc",
        border: "1px solid #e5e7eb",
        borderRadius: 6,
        margin: 0,
        maxHeight: 360,
        overflow: "auto",
        padding: 12,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word"
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function downloadCsvTemplate() {
  const blob = new Blob([`\uFEFF${CSV_TEMPLATE}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "residual-market-template.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildObservationQuery(values: ObservationFilterValues, page: number, pageSize: number) {
  return buildQuery({
    brand: values.brand,
    city: values.city,
    endDate: values.endDate?.format("YYYY-MM-DD"),
    maxMileageKm: values.maxMileageKm,
    maxPriceAmount: toCentAmount(values.maxPriceYuan),
    minMileageKm: values.minMileageKm,
    minPriceAmount: toCentAmount(values.minPriceYuan),
    model: values.model,
    modelYear: values.modelYear,
    observationStatus: values.observationStatus,
    page,
    pageSize,
    priceType: values.priceType,
    series: values.series,
    source: values.source,
    startDate: values.startDate?.format("YYYY-MM-DD")
  });
}

function buildBatchQuery(values: BatchFilterValues, page: number, pageSize: number) {
  return buildQuery({
    endDate: values.endDate?.format("YYYY-MM-DD"),
    importStatus: values.importStatus,
    page,
    pageSize,
    source: values.source,
    startDate: values.startDate?.format("YYYY-MM-DD")
  });
}

function buildCurveQuery(values: CurveFilterValues, page: number, pageSize: number) {
  return buildQuery({
    batteryUsageType: values.batteryUsageType,
    brand: values.brand,
    curveMethod: values.curveMethod,
    curveStatus: values.curveStatus,
    model: values.model,
    modelYear: values.modelYear,
    page,
    pageSize,
    series: values.series
  });
}

function buildModelRunQuery(values: ModelRunFilterValues, page: number, pageSize: number) {
  return buildQuery({
    endDate: values.endDate?.format("YYYY-MM-DD"),
    modelVersion: values.modelVersion,
    page,
    pageSize,
    runStatus: values.runStatus,
    runType: values.runType,
    startDate: values.startDate?.format("YYYY-MM-DD"),
    targetBrand: values.targetBrand,
    targetModel: values.targetModel,
    targetSeries: values.targetSeries,
    targetType: values.targetType
  });
}

function parseJsonObjectText(value: string | undefined, fieldName: string) {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${fieldName} JSON 格式不正确`);
  }
}

function parseJsonArrayText(value: string | undefined, fieldName: string) {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>[];
  } catch {
    throw new Error(`${fieldName} 必须是合法 JSON 数组`);
  }
}

function curveGeneratePayload(values: CurveGenerateFormValues, dryRun: boolean) {
  return {
    batteryCapacityKwh: values.batteryCapacityKwh,
    batteryUsageType: values.batteryUsageType,
    brand: values.brand,
    dryRun,
    minSamplePerPoint: values.minSamplePerPoint ?? 3,
    model: values.model,
    modelYear: values.modelYear,
    priceTypes: values.priceTypes?.length ? values.priceTypes : undefined,
    referencePriceAmount: toCentAmount(values.referencePriceYuan),
    remark: values.remark,
    sampleEndDate: values.sampleEndDate?.format("YYYY-MM-DD"),
    sampleStartDate: values.sampleStartDate?.format("YYYY-MM-DD"),
    series: values.series,
    trim: values.trim
  };
}

function modelRunCreatePayload(values: ModelRunCreateFormValues) {
  return {
    algorithm: values.algorithm,
    featureSnapshot: parseJsonObjectText(values.featureSnapshotText, "featureSnapshot"),
    filterSnapshot: parseJsonObjectText(values.filterSnapshotText, "filterSnapshot"),
    modelName: values.modelName,
    modelProvider: values.modelProvider,
    modelVersion: values.modelVersion,
    parameterSnapshot: parseJsonObjectText(values.parameterSnapshotText, "parameterSnapshot"),
    remark: values.remark,
    runName: values.runName,
    runStatus: values.runStatus,
    runType: values.runType,
    sampleCount: values.sampleCount,
    targetBatteryCapacityKwh: values.targetBatteryCapacityKwh,
    targetBatteryUsageType: values.targetBatteryUsageType,
    targetBrand: values.targetBrand,
    targetModel: values.targetModel,
    targetModelYear: values.targetModelYear,
    targetSeries: values.targetSeries,
    targetTrim: values.targetTrim,
    targetType: values.targetType,
    trainingDataEndDate: values.trainingDataEndDate?.format("YYYY-MM-DD"),
    trainingDataStartDate: values.trainingDataStartDate?.format("YYYY-MM-DD")
  };
}

function modelRunCompletePayload(values: ModelRunCompleteFormValues) {
  return {
    metricsSnapshot: parseJsonObjectText(values.metricsSnapshotText, "metricsSnapshot"),
    outputSnapshot: parseJsonObjectText(values.outputSnapshotText, "outputSnapshot"),
    outputs: parseJsonArrayText(values.outputsText, "outputs"),
    remark: values.remark
  };
}

function isModelRunActionable(record?: ResidualModelRunRow | null) {
  return record ? ["CREATED", "RUNNING"].includes(record.runStatus) : false;
}

function formPayload(values: ObservationFormValues) {
  return {
    accidentFlag:
      values.accidentFlag === undefined ? undefined : values.accidentFlag === "true",
    batteryCapacityKwh: values.batteryCapacityKwh,
    batteryHealthPercent: values.batteryHealthPercent,
    batteryUsageType: values.batteryUsageType,
    brand: values.brand,
    city: values.city,
    conditionGrade: values.conditionGrade,
    listingDays: values.listingDays,
    listingPriceAmount: toCentAmount(values.listingPriceAmountYuan),
    mileageKm: values.mileageKm,
    model: values.model,
    modelYear: values.modelYear,
    observedAt: values.observedAt.format("YYYY-MM-DD"),
    priceAmount: toCentAmount(values.priceAmountYuan),
    priceType: values.priceType,
    province: values.province,
    registrationDate: values.registrationDate?.format("YYYY-MM-DD"),
    remark: values.remark,
    sellerType: values.sellerType,
    series: values.series,
    source: values.source,
    sourceListingId: values.sourceListingId,
    sourceUrl: values.sourceUrl,
    transactionPriceAmount: toCentAmount(values.transactionPriceAmountYuan),
    trim: values.trim,
    vehicleAgeMonths: values.vehicleAgeMonths
  };
}

export default function ResidualMarketPage() {
  const { message, modal } = App.useApp();
  const [observationFilterForm] = Form.useForm<ObservationFilterValues>();
  const [batchFilterForm] = Form.useForm<BatchFilterValues>();
  const [curveFilterForm] = Form.useForm<CurveFilterValues>();
  const [modelRunFilterForm] = Form.useForm<ModelRunFilterValues>();
  const [observationForm] = Form.useForm<ObservationFormValues>();
  const [csvImportForm] = Form.useForm<CsvImportFormValues>();
  const [curveGenerateForm] = Form.useForm<CurveGenerateFormValues>();
  const [curveActivateForm] = Form.useForm<CurveActivateFormValues>();
  const [curveArchiveForm] = Form.useForm<CurveArchiveFormValues>();
  const [modelRunCreateForm] = Form.useForm<ModelRunCreateFormValues>();
  const [modelRunCompleteForm] = Form.useForm<ModelRunCompleteFormValues>();
  const [modelRunFailForm] = Form.useForm<ModelRunFailFormValues>();
  const [modelRunCancelForm] = Form.useForm<ModelRunCancelFormValues>();
  const [voidForm] = Form.useForm<VoidFormValues>();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("observations");
  const [observations, setObservations] = useState<ObservationRow[]>([]);
  const [observationLoading, setObservationLoading] = useState(false);
  const [observationPage, setObservationPage] = useState(1);
  const [observationPageSize, setObservationPageSize] = useState(20);
  const [observationTotal, setObservationTotal] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<ObservationRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvSubmitting, setCsvSubmitting] = useState(false);
  const [csvResult, setCsvResult] = useState<CsvImportResult | null>(null);
  const csvImportInFlightRef = useRef(false);
  const [voidTarget, setVoidTarget] = useState<ObservationRow | null>(null);
  const [voidSubmitting, setVoidSubmitting] = useState(false);
  const [batches, setBatches] = useState<ImportBatchRow[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchPage, setBatchPage] = useState(1);
  const [batchPageSize, setBatchPageSize] = useState(20);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchDetailOpen, setBatchDetailOpen] = useState(false);
  const [batchDetailLoading, setBatchDetailLoading] = useState(false);
  const [batchDetail, setBatchDetail] = useState<ImportBatchRow | null>(null);
  const [curves, setCurves] = useState<ResidualCurveRow[]>([]);
  const [curveLoading, setCurveLoading] = useState(false);
  const [curvePage, setCurvePage] = useState(1);
  const [curvePageSize, setCurvePageSize] = useState(20);
  const [curveTotal, setCurveTotal] = useState(0);
  const [curveDetailOpen, setCurveDetailOpen] = useState(false);
  const [curveDetailLoading, setCurveDetailLoading] = useState(false);
  const [curveDetail, setCurveDetail] = useState<ResidualCurveRow | null>(null);
  const [curveGenerateOpen, setCurveGenerateOpen] = useState(false);
  const [curveGenerateSubmitting, setCurveGenerateSubmitting] = useState(false);
  const [curveDryRunLoading, setCurveDryRunLoading] = useState(false);
  const [curveGenerateResult, setCurveGenerateResult] = useState<ResidualCurveGenerateResult | null>(null);
  const [curveActivateTarget, setCurveActivateTarget] = useState<ResidualCurveRow | null>(null);
  const [curveActivateSubmitting, setCurveActivateSubmitting] = useState(false);
  const [curveArchiveTarget, setCurveArchiveTarget] = useState<ResidualCurveRow | null>(null);
  const [curveArchiveSubmitting, setCurveArchiveSubmitting] = useState(false);
  const [modelRuns, setModelRuns] = useState<ResidualModelRunRow[]>([]);
  const [modelRunLoading, setModelRunLoading] = useState(false);
  const [modelRunPage, setModelRunPage] = useState(1);
  const [modelRunPageSize, setModelRunPageSize] = useState(20);
  const [modelRunTotal, setModelRunTotal] = useState(0);
  const [modelRunDetailOpen, setModelRunDetailOpen] = useState(false);
  const [modelRunDetailLoading, setModelRunDetailLoading] = useState(false);
  const [modelRunDetail, setModelRunDetail] = useState<ResidualModelRunRow | null>(null);
  const [modelRunCreateOpen, setModelRunCreateOpen] = useState(false);
  const [modelRunCreateSubmitting, setModelRunCreateSubmitting] = useState(false);
  const [modelRunCompleteTarget, setModelRunCompleteTarget] = useState<ResidualModelRunRow | null>(null);
  const [modelRunCompleteSubmitting, setModelRunCompleteSubmitting] = useState(false);
  const [modelRunFailTarget, setModelRunFailTarget] = useState<ResidualModelRunRow | null>(null);
  const [modelRunFailSubmitting, setModelRunFailSubmitting] = useState(false);
  const [modelRunCancelTarget, setModelRunCancelTarget] = useState<ResidualModelRunRow | null>(null);
  const [modelRunCancelSubmitting, setModelRunCancelSubmitting] = useState(false);
  const permissions = useMemo(() => new Set(me?.user.permissions ?? []), [me]);
  const canView = permissions.has("residual_market:view");
  const canManage = permissions.has("residual_market:manage");
  const canImport = permissions.has("residual_market:import");
  const canViewCurve = permissions.has("residual_curve:view");
  const canGenerateCurve = permissions.has("residual_curve:generate");
  const canManageCurve = permissions.has("residual_curve:manage");
  const canViewModelRun = permissions.has("residual_model_run:view");
  const canManageModelRun = permissions.has("residual_model_run:manage");

  const loadObservations = useCallback(
    async (page = 1, pageSize = 20) => {
      setObservationLoading(true);
      try {
        const query = buildObservationQuery(observationFilterForm.getFieldsValue(), page, pageSize);
        const result = await apiFetch<ObservationListResponse>(`/residual-market/observations${query}`);
        setObservations(result.items);
        setObservationPage(result.page);
        setObservationPageSize(result.pageSize);
        setObservationTotal(result.total);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setObservationLoading(false);
      }
    },
    [message, observationFilterForm]
  );

  const loadBatches = useCallback(
    async (page = 1, pageSize = 20) => {
      setBatchLoading(true);
      try {
        const query = buildBatchQuery(batchFilterForm.getFieldsValue(), page, pageSize);
        const result = await apiFetch<ImportBatchListResponse>(`/residual-market/import-batches${query}`);
        setBatches(result.items);
        setBatchPage(result.page);
        setBatchPageSize(result.pageSize);
        setBatchTotal(result.total);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setBatchLoading(false);
      }
    },
    [batchFilterForm, message]
  );

  const loadObservationDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      try {
        const result = await apiFetch<ObservationRow>(`/residual-market/observations/${id}`);
        setDetail(result);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setDetailLoading(false);
      }
    },
    [message]
  );

  const loadBatchDetail = useCallback(
    async (id: string) => {
      setBatchDetailLoading(true);
      try {
        const result = await apiFetch<ImportBatchRow>(`/residual-market/import-batches/${id}`);
        setBatchDetail(result);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setBatchDetailLoading(false);
      }
    },
    [message]
  );

  const loadCurves = useCallback(
    async (page = 1, pageSize = 20) => {
      setCurveLoading(true);
      try {
        const query = buildCurveQuery(curveFilterForm.getFieldsValue(), page, pageSize);
        const result = await apiFetch<ResidualCurveListResponse>(`/residual-market/curves${query}`);
        setCurves(result.items);
        setCurvePage(result.page);
        setCurvePageSize(result.pageSize);
        setCurveTotal(result.total);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setCurveLoading(false);
      }
    },
    [curveFilterForm, message]
  );

  const loadCurveDetail = useCallback(
    async (id: string) => {
      setCurveDetailLoading(true);
      try {
        const result = await apiFetch<ResidualCurveRow>(`/residual-market/curves/${id}`);
        setCurveDetail(result);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setCurveDetailLoading(false);
      }
    },
    [message]
  );

  const loadModelRuns = useCallback(
    async (page = 1, pageSize = 20) => {
      setModelRunLoading(true);
      try {
        const query = buildModelRunQuery(modelRunFilterForm.getFieldsValue(), page, pageSize);
        const result = await apiFetch<ResidualModelRunListResponse>(`/residual-market/model-runs${query}`);
        setModelRuns(result.items);
        setModelRunPage(result.page);
        setModelRunPageSize(result.pageSize);
        setModelRunTotal(result.total);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setModelRunLoading(false);
      }
    },
    [message, modelRunFilterForm]
  );

  const loadModelRunDetail = useCallback(
    async (id: string) => {
      setModelRunDetailLoading(true);
      try {
        const result = await apiFetch<ResidualModelRunRow>(`/residual-market/model-runs/${id}`);
        setModelRunDetail(result);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setModelRunDetailLoading(false);
      }
    },
    [message]
  );

  useEffect(() => {
    apiFetch<AuthMeResponse>("/auth/me")
      .then(setMe)
      .catch((error) => {
        void message.error(getErrorMessage(error));
      })
      .finally(() => setAuthLoading(false));
  }, [message]);

  useEffect(() => {
    if (canView) {
      void loadObservations(1, observationPageSize);
    }
  }, [canView, loadObservations, observationPageSize]);

  function resetObservationFilters() {
    observationFilterForm.resetFields();
    void loadObservations(1, observationPageSize);
  }

  function resetBatchFilters() {
    batchFilterForm.resetFields();
    void loadBatches(1, batchPageSize);
  }

  function resetCurveFilters() {
    curveFilterForm.resetFields();
    void loadCurves(1, curvePageSize);
  }

  function resetModelRunFilters() {
    modelRunFilterForm.resetFields();
    void loadModelRuns(1, modelRunPageSize);
  }

  async function openDetail(record: ObservationRow) {
    setDetailOpen(true);
    setDetail(null);
    await loadObservationDetail(record.id);
  }

  function openCreate() {
    observationForm.resetFields();
    observationForm.setFieldsValue({
      observedAt: dayjs(),
      priceType: "LISTING",
      source: "MANUAL"
    });
    setCreateOpen(true);
  }

  async function submitObservation(values: ObservationFormValues) {
    setCreateSubmitting(true);
    try {
      await apiFetch<ObservationRow>("/residual-market/observations", {
        body: JSON.stringify(formPayload(values)),
        method: "POST"
      });
      void message.success("市场价格样本已创建");
      setCreateOpen(false);
      observationForm.resetFields();
      await loadObservations(1, observationPageSize);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setCreateSubmitting(false);
    }
  }

  function openCsvImport() {
    csvImportForm.resetFields();
    csvImportForm.setFieldsValue({
      source: "CSV_IMPORT"
    });
    setCsvResult(null);
    csvImportInFlightRef.current = false;
    setCsvOpen(true);
  }

  function onCsvFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      csvImportForm.setFieldsValue({
        csvText: String(reader.result ?? ""),
        fileName: file.name
      });
      setCsvResult(null);
      void message.success("CSV 文件已读取");
    };
    reader.onerror = () => {
      void message.error("CSV 文件读取失败");
    };
    reader.readAsText(file, "UTF-8");
  }

  async function submitCsvImport(values: CsvImportFormValues) {
    if (csvImportInFlightRef.current || csvResult) {
      return;
    }
    csvImportInFlightRef.current = true;
    setCsvSubmitting(true);
    try {
      const result = await apiFetch<CsvImportResult>("/residual-market/observations/import-csv", {
        body: JSON.stringify(values),
        method: "POST"
      });
      setCsvResult(result);
      void message.success("CSV 导入完成");
      await Promise.all([loadObservations(1, observationPageSize), loadBatches(1, batchPageSize)]);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setCsvSubmitting(false);
      csvImportInFlightRef.current = false;
    }
  }

  async function copyCsvHeader() {
    try {
      await navigator.clipboard.writeText(CSV_HEADER);
      void message.success("CSV 表头已复制");
    } catch {
      void message.error("CSV 表头复制失败");
    }
  }

  async function copyCsvEnumGuide() {
    try {
      await navigator.clipboard.writeText(CSV_ENUM_GUIDE_TEXT);
      void message.success("CSV 枚举取值已复制");
    } catch {
      void message.error("CSV 枚举取值复制失败");
    }
  }

  function openVoid(record: ObservationRow) {
    voidForm.resetFields();
    setVoidTarget(record);
  }

  async function submitVoid() {
    if (!voidTarget) {
      return;
    }
    const values = await voidForm.validateFields();
    modal.confirm({
      cancelText: "取消",
      content: "作废后该样本不会参与后续残值曲线统计，但会保留记录。",
      okText: "确认作废",
      okType: "danger",
      onOk: async () => {
        setVoidSubmitting(true);
        try {
          const updated = await apiFetch<ObservationRow>(`/residual-market/observations/${voidTarget.id}/void`, {
            body: JSON.stringify(values),
            method: "POST"
          });
          void message.success("市场价格样本已作废");
          setVoidTarget(null);
          await loadObservations(observationPage, observationPageSize);
          if (detail?.id === updated.id) {
            setDetail(updated);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setVoidSubmitting(false);
        }
      },
      title: "确认作废该市场价格样本？"
    });
  }

  async function openBatchDetail(record: ImportBatchRow) {
    setBatchDetailOpen(true);
    setBatchDetail(null);
    await loadBatchDetail(record.id);
  }

  async function openCurveDetail(record: ResidualCurveRow) {
    if (!record.id) {
      return;
    }
    setCurveDetailOpen(true);
    setCurveDetail(null);
    await loadCurveDetail(record.id);
  }

  function openCurveGenerate() {
    curveGenerateForm.resetFields();
    curveGenerateForm.setFieldsValue({
      minSamplePerPoint: 3,
      priceTypes: DEFAULT_CURVE_PRICE_TYPES
    });
    setCurveGenerateResult(null);
    setCurveGenerateOpen(true);
  }

  async function submitCurveDryRun() {
    const values = await curveGenerateForm.validateFields();
    setCurveDryRunLoading(true);
    try {
      const result = await apiFetch<ResidualCurveGenerateResult>("/residual-market/curves/generate", {
        body: JSON.stringify(curveGeneratePayload(values, true)),
        method: "POST"
      });
      setCurveGenerateResult(result);
      void message.success("残值曲线试算完成");
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setCurveDryRunLoading(false);
    }
  }

  async function submitCurveGenerate() {
    const values = await curveGenerateForm.validateFields();
    modal.confirm({
      cancelText: "取消",
      content: "正式生成会创建 DRAFT 曲线和曲线点，但不会自动启用，也不会覆盖车辆当前销售价。",
      okText: "正式生成",
      onOk: async () => {
        setCurveGenerateSubmitting(true);
        try {
          const result = await apiFetch<ResidualCurveGenerateResult>("/residual-market/curves/generate", {
            body: JSON.stringify(curveGeneratePayload(values, false)),
            method: "POST"
          });
          setCurveGenerateResult(result);
          setCurveGenerateOpen(false);
          void message.success("残值曲线已生成");
          await loadCurves(1, curvePageSize);
          if (result.curve.id) {
            setCurveDetailOpen(true);
            setCurveDetail(result.curve);
            await loadCurveDetail(result.curve.id);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setCurveGenerateSubmitting(false);
        }
      },
      title: "确认正式生成残值曲线？"
    });
  }

  function openCurveActivate(record: ResidualCurveRow) {
    curveActivateForm.resetFields();
    curveActivateForm.setFieldsValue({ effectiveFrom: dayjs() });
    setCurveActivateTarget(record);
  }

  async function submitCurveActivate() {
    if (!curveActivateTarget?.id) {
      return;
    }
    const values = await curveActivateForm.validateFields();
    modal.confirm({
      cancelText: "取消",
      content: "启用后，同品牌/车型/年款/电池规格维度下旧的 ACTIVE 曲线会被标记为已被替代。",
      okText: "确认启用",
      onOk: async () => {
        setCurveActivateSubmitting(true);
        try {
          const updated = await apiFetch<ResidualCurveRow>(`/residual-market/curves/${curveActivateTarget.id}/activate`, {
            body: JSON.stringify({
              effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
              remark: values.remark
            }),
            method: "POST"
          });
          void message.success("残值曲线已启用");
          setCurveActivateTarget(null);
          await loadCurves(curvePage, curvePageSize);
          if (curveDetail?.id === updated.id) {
            setCurveDetail(updated);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setCurveActivateSubmitting(false);
        }
      },
      title: "确认启用该残值曲线？"
    });
  }

  function openCurveArchive(record: ResidualCurveRow) {
    curveArchiveForm.resetFields();
    setCurveArchiveTarget(record);
  }

  async function submitCurveArchive() {
    if (!curveArchiveTarget?.id) {
      return;
    }
    const values = await curveArchiveForm.validateFields();
    modal.confirm({
      cancelText: "取消",
      content: "归档后该曲线不再作为可用残值曲线，不会物理删除记录。",
      okText: "确认归档",
      okType: "danger",
      onOk: async () => {
        setCurveArchiveSubmitting(true);
        try {
          const updated = await apiFetch<ResidualCurveRow>(`/residual-market/curves/${curveArchiveTarget.id}/archive`, {
            body: JSON.stringify(values),
            method: "POST"
          });
          void message.success("残值曲线已归档");
          setCurveArchiveTarget(null);
          await loadCurves(curvePage, curvePageSize);
          if (curveDetail?.id === updated.id) {
            setCurveDetail(updated);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setCurveArchiveSubmitting(false);
        }
      },
      title: "确认归档该残值曲线？"
    });
  }

  async function openModelRunDetail(record: ResidualModelRunRow) {
    setModelRunDetailOpen(true);
    setModelRunDetail(null);
    await loadModelRunDetail(record.id);
  }

  function openModelRunCreate() {
    modelRunCreateForm.resetFields();
    modelRunCreateForm.setFieldsValue({
      algorithm: "STATISTICAL_MEDIAN",
      featureSnapshotText: "{}",
      filterSnapshotText: "{}",
      parameterSnapshotText: "{}",
      runStatus: "CREATED",
      runType: "STATISTICAL_BASELINE",
      targetType: "RESIDUAL_CURVE"
    });
    setModelRunCreateOpen(true);
  }

  async function submitModelRunCreate(values: ModelRunCreateFormValues) {
    setModelRunCreateSubmitting(true);
    try {
      await apiFetch<ResidualModelRunRow>("/residual-market/model-runs", {
        body: JSON.stringify(modelRunCreatePayload(values)),
        method: "POST"
      });
      void message.success("模型运行记录已创建");
      setModelRunCreateOpen(false);
      modelRunCreateForm.resetFields();
      await loadModelRuns(1, modelRunPageSize);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : getErrorMessage(error));
    } finally {
      setModelRunCreateSubmitting(false);
    }
  }

  function openModelRunComplete(record: ResidualModelRunRow) {
    modelRunCompleteForm.resetFields();
    modelRunCompleteForm.setFieldsValue({
      metricsSnapshotText: "{}",
      outputSnapshotText: "{}",
      outputsText: "[]"
    });
    setModelRunCompleteTarget(record);
  }

  async function submitModelRunComplete() {
    if (!modelRunCompleteTarget) {
      return;
    }
    const values = await modelRunCompleteForm.validateFields();
    let payload: ReturnType<typeof modelRunCompletePayload>;
    try {
      payload = modelRunCompletePayload(values);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "JSON 格式不正确");
      return;
    }

    modal.confirm({
      cancelText: "取消",
      content: "本操作只记录运行状态、指标快照和输出关联，不会自动生成残值曲线或单车预测。",
      okText: "确认完成",
      onOk: async () => {
        setModelRunCompleteSubmitting(true);
        try {
          const updated = await apiFetch<ResidualModelRunRow>(`/residual-market/model-runs/${modelRunCompleteTarget.id}/complete`, {
            body: JSON.stringify(payload),
            method: "POST"
          });
          void message.success("模型运行记录已标记完成");
          setModelRunCompleteTarget(null);
          await loadModelRuns(modelRunPage, modelRunPageSize);
          if (modelRunDetail?.id === updated.id) {
            setModelRunDetail(updated);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setModelRunCompleteSubmitting(false);
        }
      },
      title: "确认标记该模型运行记录为已完成？"
    });
  }

  function openModelRunFail(record: ResidualModelRunRow) {
    modelRunFailForm.resetFields();
    modelRunFailForm.setFieldsValue({ errorSnapshotText: "{}" });
    setModelRunFailTarget(record);
  }

  async function submitModelRunFail() {
    if (!modelRunFailTarget) {
      return;
    }
    const values = await modelRunFailForm.validateFields();
    let errorSnapshot: Record<string, unknown> | undefined;
    try {
      errorSnapshot = parseJsonObjectText(values.errorSnapshotText, "errorSnapshot");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "JSON 格式不正确");
      return;
    }

    modal.confirm({
      cancelText: "取消",
      content: "失败状态只记录本次运行结果和错误快照，不会触发其他业务动作。",
      okText: "确认失败",
      okType: "danger",
      onOk: async () => {
        setModelRunFailSubmitting(true);
        try {
          const updated = await apiFetch<ResidualModelRunRow>(`/residual-market/model-runs/${modelRunFailTarget.id}/fail`, {
            body: JSON.stringify({ errorSnapshot, remark: values.remark }),
            method: "POST"
          });
          void message.success("模型运行记录已标记失败");
          setModelRunFailTarget(null);
          await loadModelRuns(modelRunPage, modelRunPageSize);
          if (modelRunDetail?.id === updated.id) {
            setModelRunDetail(updated);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setModelRunFailSubmitting(false);
        }
      },
      title: "确认标记该模型运行记录为失败？"
    });
  }

  function openModelRunCancel(record: ResidualModelRunRow) {
    modelRunCancelForm.resetFields();
    setModelRunCancelTarget(record);
  }

  async function submitModelRunCancel() {
    if (!modelRunCancelTarget) {
      return;
    }
    const values = await modelRunCancelForm.validateFields();

    modal.confirm({
      cancelText: "取消",
      content: "取消只改变模型运行记录状态，不会删除记录。",
      okText: "确认取消",
      okType: "danger",
      onOk: async () => {
        setModelRunCancelSubmitting(true);
        try {
          const updated = await apiFetch<ResidualModelRunRow>(`/residual-market/model-runs/${modelRunCancelTarget.id}/cancel`, {
            body: JSON.stringify(values),
            method: "POST"
          });
          void message.success("模型运行记录已取消");
          setModelRunCancelTarget(null);
          await loadModelRuns(modelRunPage, modelRunPageSize);
          if (modelRunDetail?.id === updated.id) {
            setModelRunDetail(updated);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setModelRunCancelSubmitting(false);
        }
      },
      title: "确认取消该模型运行记录？"
    });
  }

  const observationColumns: ColumnsType<ObservationRow> = [
    { dataIndex: "observationNo", fixed: "left", title: "样本编号", width: 170 },
    {
      dataIndex: "source",
      render: (value) => enumTag(MARKET_PRICE_SOURCE_LABELS, value),
      title: "来源",
      width: 120
    },
    {
      dataIndex: "priceType",
      render: (value) => enumTag(MARKET_PRICE_TYPE_LABELS, value),
      title: "价格类型",
      width: 120
    },
    {
      dataIndex: "observationStatus",
      render: (value) => enumTag(MARKET_PRICE_OBSERVATION_STATUS_LABELS, value),
      title: "状态",
      width: 110
    },
    { dataIndex: "observedAt", render: formatDate, title: "观测日期", width: 120 },
    { dataIndex: "brand", render: text, title: "品牌", width: 110 },
    { dataIndex: "series", render: text, title: "车系", width: 110 },
    { dataIndex: "model", render: text, title: "车型", width: 160 },
    { dataIndex: "modelYear", render: text, title: "年款", width: 90 },
    { dataIndex: "trim", render: text, title: "版本 / trim", width: 140 },
    { dataIndex: "batteryCapacityKwh", render: kwh, title: "电池容量", width: 120 },
    {
      dataIndex: "batteryUsageType",
      render: (value) => labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, value),
      title: "电池使用方式",
      width: 130
    },
    { dataIndex: "mileageKm", render: km, title: "里程", width: 120 },
    { dataIndex: "registrationDate", render: formatDate, title: "上牌日期", width: 120 },
    { dataIndex: "vehicleAgeMonths", render: text, title: "车龄（月）", width: 110 },
    { dataIndex: "province", render: text, title: "省份", width: 100 },
    { dataIndex: "city", render: text, title: "城市", width: 100 },
    { dataIndex: "priceAmount", render: yuan, title: "价格", width: 130 },
    { dataIndex: "listingPriceAmount", render: yuan, title: "挂牌价", width: 130 },
    { dataIndex: "transactionPriceAmount", render: yuan, title: "成交价", width: 130 },
    {
      dataIndex: "sellerType",
      render: (value) => labelOf(MARKET_SELLER_TYPE_LABELS, value),
      title: "卖家类型",
      width: 120
    },
    { dataIndex: "conditionGrade", render: text, title: "车况等级", width: 110 },
    { dataIndex: "batteryHealthPercent", render: percent, title: "电池健康度", width: 120 },
    { dataIndex: "accidentFlag", render: yesNo, title: "事故标识", width: 100 },
    { dataIndex: "confidenceScore", render: confidenceTag, title: "置信度", width: 100 },
    { dataIndex: "createdAt", render: formatDateTime, title: "创建时间", width: 150 },
    {
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Button icon={<EyeOutlined />} onClick={() => openDetail(record)} size="small">
            查看详情
          </Button>
          {canManage && record.observationStatus !== "VOIDED" ? (
            <Button danger icon={<StopOutlined />} onClick={() => openVoid(record)} size="small">
              作废
            </Button>
          ) : null}
        </Space>
      ),
      title: "操作",
      width: 180
    }
  ];

  const batchColumns: ColumnsType<ImportBatchRow> = [
    { dataIndex: "batchNo", fixed: "left", title: "批次编号", width: 170 },
    {
      dataIndex: "source",
      render: (value) => enumTag(MARKET_PRICE_SOURCE_LABELS, value),
      title: "来源",
      width: 120
    },
    { dataIndex: "fileName", render: text, title: "文件名", width: 220 },
    { dataIndex: "importedBy", render: text, title: "导入人", width: 180 },
    { dataIndex: "totalRows", title: "总行数", width: 90 },
    { dataIndex: "importedRows", title: "导入行数", width: 100 },
    { dataIndex: "skippedRows", title: "跳过行数", width: 100 },
    { dataIndex: "failedRows", title: "失败行数", width: 100 },
    {
      dataIndex: "importStatus",
      render: (value) => enumTag(MARKET_PRICE_IMPORT_STATUS_LABELS, value),
      title: "导入状态",
      width: 120
    },
    { dataIndex: "createdAt", render: formatDateTime, title: "创建时间", width: 150 },
    { dataIndex: "remark", render: text, title: "备注", width: 220 },
    {
      fixed: "right",
      render: (_, record) => (
        <Button icon={<EyeOutlined />} onClick={() => openBatchDetail(record)} size="small">
          查看详情
        </Button>
      ),
      title: "操作",
      width: 120
    }
  ];

  const curvePointColumns: ColumnsType<CurvePointRow> = [
    { dataIndex: "ageMonth", fixed: "left", title: "车龄（月）", width: 110 },
    { dataIndex: "sampleCount", title: "样本数", width: 90 },
    { dataIndex: "medianPriceAmount", render: currencyYuan, title: "中位数价格", width: 130 },
    { dataIndex: "p25PriceAmount", render: currencyYuan, title: "P25", width: 120 },
    { dataIndex: "p75PriceAmount", render: currencyYuan, title: "P75", width: 120 },
    { dataIndex: "averagePriceAmount", render: currencyYuan, title: "平均价", width: 130 },
    { dataIndex: "minPriceAmount", render: currencyYuan, title: "最低价", width: 130 },
    { dataIndex: "maxPriceAmount", render: currencyYuan, title: "最高价", width: 130 },
    { dataIndex: "predictedResidualAmount", render: currencyYuan, title: "预测残值", width: 130 },
    { dataIndex: "predictedResidualRateBps", render: bpsPercent, title: "残值率", width: 110 },
    { dataIndex: "lowerBoundAmount", render: currencyYuan, title: "下界", width: 120 },
    { dataIndex: "upperBoundAmount", render: currencyYuan, title: "上界", width: 120 },
    { dataIndex: "confidenceScore", render: confidenceTag, title: "置信度", width: 110 }
  ];

  const curveColumns: ColumnsType<ResidualCurveRow> = [
    { dataIndex: "curveNo", fixed: "left", render: text, title: "曲线编号", width: 170 },
    { dataIndex: "curveName", render: text, title: "曲线名称", width: 180 },
    {
      dataIndex: "curveStatus",
      render: (value) => enumTag(VEHICLE_RESIDUAL_CURVE_STATUS_LABELS, value),
      title: "状态",
      width: 110
    },
    {
      dataIndex: "curveMethod",
      render: (value) => enumTag(VEHICLE_RESIDUAL_CURVE_METHOD_LABELS, value),
      title: "方法",
      width: 130
    },
    { dataIndex: "brand", render: text, title: "品牌", width: 110 },
    { dataIndex: "series", render: text, title: "车系", width: 110 },
    { dataIndex: "model", render: text, title: "车型", width: 150 },
    { dataIndex: "modelYear", render: text, title: "年款", width: 90 },
    { dataIndex: "trim", render: text, title: "版本 / trim", width: 140 },
    { dataIndex: "batteryCapacityKwh", render: kwh, title: "电池容量", width: 120 },
    {
      dataIndex: "batteryUsageType",
      render: (value) => labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, value),
      title: "电池使用方式",
      width: 130
    },
    { dataIndex: "sampleCount", title: "样本数", width: 90 },
    { dataIndex: "pointCount", title: "曲线点数", width: 100 },
    { dataIndex: "confidenceScore", render: confidenceTag, title: "置信度", width: 110 },
    { dataIndex: "generatedAt", render: formatDateTime, title: "生成时间", width: 150 },
    { dataIndex: "effectiveFrom", render: formatDate, title: "生效时间", width: 120 },
    { dataIndex: "remark", render: text, title: "备注", width: 220 },
    {
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Button icon={<EyeOutlined />} onClick={() => openCurveDetail(record)} size="small">
            查看详情
          </Button>
          {canManageCurve && ["DRAFT", "SUPERSEDED"].includes(record.curveStatus) ? (
            <Button icon={<CheckCircleOutlined />} onClick={() => openCurveActivate(record)} size="small">
              启用
            </Button>
          ) : null}
          {canManageCurve && record.curveStatus !== "ARCHIVED" ? (
            <Button danger icon={<StopOutlined />} onClick={() => openCurveArchive(record)} size="small">
              归档
            </Button>
          ) : null}
        </Space>
      ),
      title: "操作",
      width: 240
    }
  ];

  const modelRunColumns: ColumnsType<ResidualModelRunRow> = [
    { dataIndex: "runNo", fixed: "left", title: "运行编号", width: 180 },
    { dataIndex: "runName", render: text, title: "运行名称", width: 220 },
    {
      dataIndex: "runType",
      render: (value) => enumTag(RESIDUAL_MODEL_RUN_TYPE_LABELS, value),
      title: "运行类型",
      width: 140
    },
    {
      dataIndex: "runStatus",
      render: (value) => enumTag(RESIDUAL_MODEL_RUN_STATUS_LABELS, value),
      title: "运行状态",
      width: 120
    },
    { dataIndex: "modelName", render: text, title: "模型名称", width: 180 },
    { dataIndex: "modelVersion", render: text, title: "模型版本", width: 150 },
    {
      dataIndex: "algorithm",
      render: (value) => enumTag(RESIDUAL_MODEL_ALGORITHM_LABELS, value),
      title: "算法",
      width: 150
    },
    {
      dataIndex: "targetType",
      render: (value) => enumTag(RESIDUAL_MODEL_TARGET_TYPE_LABELS, value),
      title: "目标类型",
      width: 130
    },
    { dataIndex: "targetBrand", render: text, title: "目标品牌", width: 110 },
    { dataIndex: "targetSeries", render: text, title: "目标车系", width: 120 },
    { dataIndex: "targetModel", render: text, title: "目标车型", width: 150 },
    { dataIndex: "targetModelYear", render: text, title: "年款", width: 90 },
    { dataIndex: "sampleCount", render: text, title: "样本数", width: 100 },
    { dataIndex: "startedAt", render: formatDateTime, title: "开始时间", width: 150 },
    { dataIndex: "finishedAt", render: formatDateTime, title: "完成时间", width: 150 },
    { dataIndex: "createdAt", render: formatDateTime, title: "创建时间", width: 150 },
    { dataIndex: "remark", render: text, title: "备注", width: 220 },
    {
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Button icon={<EyeOutlined />} onClick={() => openModelRunDetail(record)} size="small">
            查看详情
          </Button>
          {canManageModelRun && isModelRunActionable(record) ? (
            <>
              <Button icon={<CheckCircleOutlined />} onClick={() => openModelRunComplete(record)} size="small">
                标记完成
              </Button>
              <Button danger onClick={() => openModelRunFail(record)} size="small">
                标记失败
              </Button>
              <Button danger icon={<StopOutlined />} onClick={() => openModelRunCancel(record)} size="small">
                取消运行
              </Button>
            </>
          ) : null}
        </Space>
      ),
      title: "操作",
      width: 340
    }
  ];

  const modelRunOutputColumns: ColumnsType<ResidualModelRunOutputRow> = [
    {
      dataIndex: "outputType",
      render: (value) => enumTag(RESIDUAL_MODEL_RUN_OUTPUT_TYPE_LABELS, value),
      title: "输出类型",
      width: 130
    },
    {
      dataIndex: "outputStatus",
      render: (value) => enumTag(RESIDUAL_MODEL_RUN_OUTPUT_STATUS_LABELS, value),
      title: "输出状态",
      width: 120
    },
    {
      render: (_, record) => text(record.curve?.curveNo ?? record.curveId),
      title: "曲线",
      width: 180
    },
    {
      render: (_, record) => text(record.forecast?.forecastNo ?? record.forecastId),
      title: "预测",
      width: 180
    },
    {
      render: (_, record) => text(record.vehicle?.vehicleNo ?? record.vehicleId),
      title: "车辆",
      width: 180
    },
    { dataIndex: "outputNo", render: text, title: "输出编号", width: 170 },
    { dataIndex: "remark", render: text, title: "备注", width: 220 },
    { dataIndex: "createdAt", render: formatDateTime, title: "创建时间", width: 150 }
  ];

  const importResultColumns: ColumnsType<CsvImportItem> = [
    { dataIndex: "rowNumber", title: "行号", width: 90 },
    {
      dataIndex: "action",
      render: (value) => enumTag(csvImportActionLabels, value),
      title: "动作",
      width: 130
    },
    { dataIndex: "observationId", render: text, title: "样本 ID", width: 240 },
    { dataIndex: "reason", render: text, title: "原因" }
  ];

  if (authLoading) {
    return (
      <ProtectedShell>
        <Skeleton active />
      </ProtectedShell>
    );
  }

  if (!canView) {
    return (
      <ProtectedShell>
        <Alert message="无权访问市场残值样本库" showIcon type="error" />
      </ProtectedShell>
    );
  }

  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Space align="start" direction="vertical" size={4}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            市场残值样本库
          </Typography.Title>
          <Typography.Paragraph style={{ margin: 0, maxWidth: 1080 }}>
            本页面用于维护外部市场价格样本，包括挂牌价、成交价、拍卖价、经销商报价等。市场样本不会自动覆盖车辆当前销售价，也不会直接参与 ROE
            计算；后续将用于残值曲线和残值预测模型。
          </Typography.Paragraph>
        </Space>

        <Tabs
          activeKey={activeTab}
          onChange={(key) => {
            setActiveTab(key);
            if (key === "batches") {
              void loadBatches(1, batchPageSize);
            }
            if (key === "curves" && canViewCurve) {
              void loadCurves(1, curvePageSize);
            }
            if (key === "model-runs" && canViewModelRun) {
              void loadModelRuns(1, modelRunPageSize);
            }
          }}
          items={[
            {
              key: "observations",
              label: "市场价格样本",
              children: (
                <Space direction="vertical" size={16} style={{ width: "100%" }}>
                  <Form<ObservationFilterValues>
                    form={observationFilterForm}
                    layout="vertical"
                    onFinish={() => loadObservations(1, observationPageSize)}
                  >
                    <Row gutter={12}>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="来源" name="source">
                          <Select allowClear options={optionsFromLabels(MARKET_PRICE_SOURCE_LABELS)} />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="价格类型" name="priceType">
                          <Select allowClear options={optionsFromLabels(MARKET_PRICE_TYPE_LABELS)} />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="样本状态" name="observationStatus">
                          <Select allowClear options={optionsFromLabels(MARKET_PRICE_OBSERVATION_STATUS_LABELS)} />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="品牌" name="brand">
                          <Input allowClear />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="车系" name="series">
                          <Input allowClear />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="车型" name="model">
                          <Input allowClear />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="年款" name="modelYear">
                          <InputNumber min={1990} max={2100} precision={0} style={{ width: "100%" }} />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="城市" name="city">
                          <Input allowClear />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="观测开始日期" name="startDate">
                          <DatePicker style={{ width: "100%" }} />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="观测结束日期" name="endDate">
                          <DatePicker style={{ width: "100%" }} />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="最低里程" name="minMileageKm">
                          <InputNumber min={0} precision={0} style={{ width: "100%" }} />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="最高里程" name="maxMileageKm">
                          <InputNumber min={0} precision={0} style={{ width: "100%" }} />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="最低价格（元）" name="minPriceYuan">
                          <InputNumber min={0} precision={2} style={{ width: "100%" }} />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="最高价格（元）" name="maxPriceYuan">
                          <InputNumber min={0} precision={2} style={{ width: "100%" }} />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Space>
                      <Button htmlType="submit" icon={<SearchOutlined />} type="primary">
                        查询
                      </Button>
                      <Button onClick={resetObservationFilters}>重置</Button>
                    </Space>
                  </Form>

                  <Space wrap>
                    {canManage ? (
                      <Button icon={<PlusOutlined />} onClick={openCreate} type="primary">
                        新增市场样本
                      </Button>
                    ) : null}
                    {canImport ? (
                      <Button icon={<UploadOutlined />} onClick={openCsvImport}>
                        导入 CSV
                      </Button>
                    ) : null}
                    <Button
                      icon={<ReloadOutlined />}
                      loading={observationLoading}
                      onClick={() => loadObservations(observationPage, observationPageSize)}
                    >
                      刷新
                    </Button>
                  </Space>

                  <Table
                    columns={observationColumns}
                    dataSource={observations}
                    loading={observationLoading}
                    pagination={{
                      current: observationPage,
                      onChange: (page, pageSize) => loadObservations(page, pageSize),
                      pageSize: observationPageSize,
                      showSizeChanger: true,
                      total: observationTotal
                    }}
                    rowKey="id"
                    scroll={{ x: 3200 }}
                    size="small"
                  />
                </Space>
              )
            },
            {
              key: "batches",
              label: "导入批次",
              children: (
                <Space direction="vertical" size={16} style={{ width: "100%" }}>
                  <Form<BatchFilterValues> form={batchFilterForm} layout="vertical" onFinish={() => loadBatches(1, batchPageSize)}>
                    <Row gutter={12}>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="来源" name="source">
                          <Select allowClear options={optionsFromLabels(MARKET_PRICE_SOURCE_LABELS)} />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="导入状态" name="importStatus">
                          <Select allowClear options={optionsFromLabels(MARKET_PRICE_IMPORT_STATUS_LABELS)} />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="开始日期" name="startDate">
                          <DatePicker style={{ width: "100%" }} />
                        </Form.Item>
                      </Col>
                      <Col lg={4} md={8} sm={12} xs={24}>
                        <Form.Item label="结束日期" name="endDate">
                          <DatePicker style={{ width: "100%" }} />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Space>
                      <Button htmlType="submit" icon={<SearchOutlined />} type="primary">
                        查询
                      </Button>
                      <Button onClick={resetBatchFilters}>重置</Button>
                      <Button
                        icon={<ReloadOutlined />}
                        loading={batchLoading}
                        onClick={() => loadBatches(batchPage, batchPageSize)}
                      >
                        刷新
                      </Button>
                    </Space>
                  </Form>

                  <Table
                    columns={batchColumns}
                    dataSource={batches}
                    loading={batchLoading}
                    pagination={{
                      current: batchPage,
                      onChange: (page, pageSize) => loadBatches(page, pageSize),
                      pageSize: batchPageSize,
                      showSizeChanger: true,
                      total: batchTotal
                    }}
                    rowKey="id"
                    scroll={{ x: 1680 }}
                    size="small"
                  />
                </Space>
              )
            },
            ...(canViewCurve
              ? [
                  {
                    key: "curves",
                    label: "残值曲线",
                    children: (
                      <Space direction="vertical" size={16} style={{ width: "100%" }}>
                        <Alert
                          description="残值曲线基于市场价格样本生成，用于观察品牌 / 车系 / 车型 / 年款 / 电池规格维度下的市场残值变化趋势。当前版本使用统计中位数方法，不做 AI / ML，不会自动覆盖车辆当前销售价，也不会直接接入 ROE。"
                          showIcon
                          type="info"
                        />
                        <Form<CurveFilterValues> form={curveFilterForm} layout="vertical" onFinish={() => loadCurves(1, curvePageSize)}>
                          <Row gutter={12}>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="状态" name="curveStatus">
                                <Select allowClear options={optionsFromLabels(VEHICLE_RESIDUAL_CURVE_STATUS_LABELS)} />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="方法" name="curveMethod">
                                <Select allowClear options={optionsFromLabels(VEHICLE_RESIDUAL_CURVE_METHOD_LABELS)} />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="品牌" name="brand">
                                <Input allowClear />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="车系" name="series">
                                <Input allowClear />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="车型" name="model">
                                <Input allowClear />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="年款" name="modelYear">
                                <InputNumber min={1990} max={2100} precision={0} style={{ width: "100%" }} />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="电池使用方式" name="batteryUsageType">
                                <Select allowClear options={optionsFromLabels(VEHICLE_BATTERY_USAGE_TYPE_LABELS)} />
                              </Form.Item>
                            </Col>
                          </Row>
                          <Space>
                            <Button htmlType="submit" icon={<SearchOutlined />} type="primary">
                              查询
                            </Button>
                            <Button onClick={resetCurveFilters}>重置</Button>
                            <Button icon={<ReloadOutlined />} loading={curveLoading} onClick={() => loadCurves(curvePage, curvePageSize)}>
                              刷新
                            </Button>
                          </Space>
                        </Form>

                        <Space wrap>
                          {canGenerateCurve ? (
                            <Button icon={<LineChartOutlined />} onClick={openCurveGenerate} type="primary">
                              生成残值曲线
                            </Button>
                          ) : null}
                        </Space>

                        <Table
                          columns={curveColumns}
                          dataSource={curves}
                          loading={curveLoading}
                          pagination={{
                            current: curvePage,
                            onChange: (page, pageSize) => loadCurves(page, pageSize),
                            pageSize: curvePageSize,
                            showSizeChanger: true,
                            total: curveTotal
                          }}
                          rowKey={(record) => record.id ?? record.curveNo ?? `${record.brand}-${record.model}-${record.generatedAt}`}
                          scroll={{ x: 2500 }}
                          size="small"
                        />
                      </Space>
                    )
                  }
                ]
              : []),
            ...(canViewModelRun
              ? [
                  {
                    key: "model-runs",
                    label: "模型运行记录",
                    children: (
                      <Space direction="vertical" size={16} style={{ width: "100%" }}>
                        <Alert
                          description="模型运行记录用于记录残值预测模型的版本、样本范围、特征、参数、指标和输出关联。本阶段只记录模型运行过程，不执行真实 AI / ML 训练，也不会自动生成残值曲线或单车预测。"
                          showIcon
                          type="info"
                        />
                        <Form<ModelRunFilterValues>
                          form={modelRunFilterForm}
                          layout="vertical"
                          onFinish={() => loadModelRuns(1, modelRunPageSize)}
                        >
                          <Row gutter={12}>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="运行类型" name="runType">
                                <Select allowClear options={optionsFromLabels(RESIDUAL_MODEL_RUN_TYPE_LABELS)} />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="运行状态" name="runStatus">
                                <Select allowClear options={optionsFromLabels(RESIDUAL_MODEL_RUN_STATUS_LABELS)} />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="目标类型" name="targetType">
                                <Select allowClear options={optionsFromLabels(RESIDUAL_MODEL_TARGET_TYPE_LABELS)} />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="模型版本" name="modelVersion">
                                <Input allowClear />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="目标品牌" name="targetBrand">
                                <Input allowClear />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="目标车系" name="targetSeries">
                                <Input allowClear />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="目标车型" name="targetModel">
                                <Input allowClear />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="开始日期" name="startDate">
                                <DatePicker style={{ width: "100%" }} />
                              </Form.Item>
                            </Col>
                            <Col lg={4} md={8} sm={12} xs={24}>
                              <Form.Item label="结束日期" name="endDate">
                                <DatePicker style={{ width: "100%" }} />
                              </Form.Item>
                            </Col>
                          </Row>
                          <Space>
                            <Button htmlType="submit" icon={<SearchOutlined />} type="primary">
                              查询
                            </Button>
                            <Button onClick={resetModelRunFilters}>重置</Button>
                            <Button
                              icon={<ReloadOutlined />}
                              loading={modelRunLoading}
                              onClick={() => loadModelRuns(modelRunPage, modelRunPageSize)}
                            >
                              刷新
                            </Button>
                          </Space>
                        </Form>

                        <Space wrap>
                          {canManageModelRun ? (
                            <Button icon={<PlusOutlined />} onClick={openModelRunCreate} type="primary">
                              新增模型运行记录
                            </Button>
                          ) : null}
                        </Space>

                        <Table
                          columns={modelRunColumns}
                          dataSource={modelRuns}
                          loading={modelRunLoading}
                          pagination={{
                            current: modelRunPage,
                            onChange: (page, pageSize) => loadModelRuns(page, pageSize),
                            pageSize: modelRunPageSize,
                            showSizeChanger: true,
                            total: modelRunTotal
                          }}
                          rowKey="id"
                          scroll={{ x: 3000 }}
                          size="small"
                        />
                      </Space>
                    )
                  }
                ]
              : [])
          ]}
        />

        <Drawer
          destroyOnHidden
          loading={detailLoading}
          onClose={() => {
            setDetailOpen(false);
            setDetail(null);
          }}
          open={detailOpen}
          size="large"
          title={detail ? `${detail.observationNo} 样本详情` : "样本详情"}
        >
          {detail ? (
            <Space direction="vertical" size={18} style={{ width: "100%" }}>
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "样本编号", children: detail.observationNo },
                  { label: "来源", children: enumTag(MARKET_PRICE_SOURCE_LABELS, detail.source) },
                  { label: "来源 listing ID", children: text(detail.sourceListingId) },
                  { label: "价格类型", children: enumTag(MARKET_PRICE_TYPE_LABELS, detail.priceType) },
                  { label: "样本状态", children: enumTag(MARKET_PRICE_OBSERVATION_STATUS_LABELS, detail.observationStatus) },
                  { label: "观测日期", children: formatDate(detail.observedAt) },
                  { label: "置信度", children: confidenceTag(detail.confidenceScore) },
                  { label: "批次 ID", children: text(detail.batchId) }
                ]}
                size="small"
                title="基础信息"
              />
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "品牌", children: text(detail.brand) },
                  { label: "车系", children: text(detail.series) },
                  { label: "车型", children: text(detail.model) },
                  { label: "年款", children: text(detail.modelYear) },
                  { label: "版本 / trim", children: text(detail.trim) },
                  { label: "电池容量", children: kwh(detail.batteryCapacityKwh) },
                  { label: "电池使用方式", children: labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, detail.batteryUsageType) },
                  { label: "里程", children: km(detail.mileageKm) },
                  { label: "上牌日期", children: formatDate(detail.registrationDate) },
                  { label: "车龄（月）", children: text(detail.vehicleAgeMonths) },
                  { label: "省份", children: text(detail.province) },
                  { label: "城市", children: text(detail.city) }
                ]}
                size="small"
                title="车辆信息"
              />
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "价格", children: yuan(detail.priceAmount) },
                  { label: "挂牌价", children: yuan(detail.listingPriceAmount) },
                  { label: "成交价", children: yuan(detail.transactionPriceAmount) },
                  { label: "卖家类型", children: labelOf(MARKET_SELLER_TYPE_LABELS, detail.sellerType) },
                  { label: "车况等级", children: text(detail.conditionGrade) },
                  { label: "电池健康度", children: percent(detail.batteryHealthPercent) },
                  { label: "事故标识", children: yesNo(detail.accidentFlag) },
                  { label: "挂牌天数", children: text(detail.listingDays) }
                ]}
                size="small"
                title="价格信息"
              />
              <Descriptions
                bordered
                column={1}
                items={[
                  { label: "dedupeKey", children: text(detail.dedupeKey) },
                  { label: "sourceUrlHash", children: text(detail.sourceUrlHash) },
                  { label: "备注", children: text(detail.remark) }
                ]}
                size="small"
                title="去重和备注"
              />
              <Collapse
                items={[
                  {
                    children: jsonBlock(detail.rawSnapshot),
                    key: "rawSnapshot",
                    label: "rawSnapshot"
                  }
                ]}
              />
            </Space>
          ) : null}
        </Drawer>

        <Drawer
          destroyOnHidden
          loading={batchDetailLoading}
          onClose={() => {
            setBatchDetailOpen(false);
            setBatchDetail(null);
          }}
          open={batchDetailOpen}
          size="large"
          title={batchDetail ? `${batchDetail.batchNo} 导入批次详情` : "导入批次详情"}
        >
          {batchDetail ? (
            <Space direction="vertical" size={18} style={{ width: "100%" }}>
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "批次编号", children: batchDetail.batchNo },
                  { label: "来源", children: enumTag(MARKET_PRICE_SOURCE_LABELS, batchDetail.source) },
                  { label: "文件名", children: text(batchDetail.fileName) },
                  { label: "导入人", children: text(batchDetail.importedBy) },
                  { label: "总行数", children: batchDetail.totalRows },
                  { label: "导入行数", children: batchDetail.importedRows },
                  { label: "跳过行数", children: batchDetail.skippedRows },
                  { label: "失败行数", children: batchDetail.failedRows },
                  { label: "导入状态", children: enumTag(MARKET_PRICE_IMPORT_STATUS_LABELS, batchDetail.importStatus) },
                  { label: "样本数量", children: text(batchDetail.observationCount) },
                  { label: "创建时间", children: formatDateTime(batchDetail.createdAt) },
                  { label: "备注", children: text(batchDetail.remark) }
                ]}
                size="small"
              />
              <Collapse
                items={[
                  { children: jsonBlock(batchDetail.errorSnapshot), key: "errorSnapshot", label: "错误摘要" },
                  { children: jsonBlock(batchDetail.snapshot), key: "snapshot", label: "导入配置快照" }
                ]}
              />
            </Space>
          ) : null}
        </Drawer>

        <Drawer
          destroyOnHidden
          loading={curveDetailLoading}
          onClose={() => {
            setCurveDetailOpen(false);
            setCurveDetail(null);
          }}
          open={curveDetailOpen}
          title={curveDetail ? `${curveDetail.curveNo ?? curveDetail.id} 残值曲线详情` : "残值曲线详情"}
          size="80vw"
        >
          {curveDetail ? (
            <Space direction="vertical" size={18} style={{ width: "100%" }}>
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "曲线编号", children: text(curveDetail.curveNo) },
                  { label: "曲线名称", children: text(curveDetail.curveName) },
                  { label: "状态", children: enumTag(VEHICLE_RESIDUAL_CURVE_STATUS_LABELS, curveDetail.curveStatus) },
                  { label: "方法", children: enumTag(VEHICLE_RESIDUAL_CURVE_METHOD_LABELS, curveDetail.curveMethod) },
                  { label: "品牌", children: text(curveDetail.brand) },
                  { label: "车系", children: text(curveDetail.series) },
                  { label: "车型", children: text(curveDetail.model) },
                  { label: "年款", children: text(curveDetail.modelYear) },
                  { label: "版本 / trim", children: text(curveDetail.trim) },
                  { label: "电池容量", children: kwh(curveDetail.batteryCapacityKwh) },
                  { label: "电池使用方式", children: labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, curveDetail.batteryUsageType) },
                  { label: "参考价格", children: currencyYuan(curveDetail.referencePriceAmount) },
                  { label: "样本开始日期", children: formatDate(curveDetail.sampleStartDate) },
                  { label: "样本结束日期", children: formatDate(curveDetail.sampleEndDate) },
                  { label: "样本数", children: curveDetail.sampleCount },
                  { label: "点数", children: curveDetail.pointCount },
                  { label: "置信度", children: confidenceTag(curveDetail.confidenceScore) },
                  { label: "生成时间", children: formatDateTime(curveDetail.generatedAt) },
                  { label: "生效时间", children: formatDate(curveDetail.effectiveFrom) },
                  { label: "失效时间", children: formatDate(curveDetail.effectiveTo) },
                  { label: "备注", children: text(curveDetail.remark) }
                ]}
                size="small"
                title="曲线基础信息"
              />
              <Collapse
                items={[
                  { children: jsonBlock(curveDetail.priceTypes), key: "priceTypes", label: "priceTypes" },
                  { children: jsonBlock(curveDetail.sampleFilterSnapshot), key: "sampleFilterSnapshot", label: "sampleFilterSnapshot" },
                  { children: jsonBlock(curveDetail.metrics), key: "metrics", label: "metrics" },
                  { children: jsonBlock(curveDetail.snapshot), key: "snapshot", label: "snapshot" }
                ]}
              />
              <Table
                columns={curvePointColumns}
                dataSource={curveDetail.points ?? []}
                locale={{ emptyText: "暂无曲线点" }}
                pagination={false}
                rowKey={(record) => record.id ?? `${record.ageMonth}-${record.sampleCount}-${record.medianPriceAmount ?? "-"}`}
                scroll={{ x: 1600 }}
                size="small"
                title={() => "曲线点列表"}
              />
            </Space>
          ) : null}
        </Drawer>

        <Drawer
          destroyOnHidden
          loading={modelRunDetailLoading}
          onClose={() => {
            setModelRunDetailOpen(false);
            setModelRunDetail(null);
          }}
          open={modelRunDetailOpen}
          size="80vw"
          title={modelRunDetail ? `${modelRunDetail.runNo} 模型运行详情` : "模型运行详情"}
        >
          {modelRunDetail ? (
            <Space direction="vertical" size={18} style={{ width: "100%" }}>
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "运行编号", children: text(modelRunDetail.runNo) },
                  { label: "运行名称", children: text(modelRunDetail.runName) },
                  { label: "运行类型", children: enumTag(RESIDUAL_MODEL_RUN_TYPE_LABELS, modelRunDetail.runType) },
                  { label: "运行状态", children: enumTag(RESIDUAL_MODEL_RUN_STATUS_LABELS, modelRunDetail.runStatus) },
                  { label: "模型名称", children: text(modelRunDetail.modelName) },
                  { label: "模型版本", children: text(modelRunDetail.modelVersion) },
                  { label: "模型提供方", children: text(modelRunDetail.modelProvider) },
                  { label: "算法", children: enumTag(RESIDUAL_MODEL_ALGORITHM_LABELS, modelRunDetail.algorithm) },
                  { label: "目标类型", children: enumTag(RESIDUAL_MODEL_TARGET_TYPE_LABELS, modelRunDetail.targetType) },
                  { label: "开始时间", children: formatDateTime(modelRunDetail.startedAt) },
                  { label: "完成时间", children: formatDateTime(modelRunDetail.finishedAt) },
                  { label: "创建时间", children: formatDateTime(modelRunDetail.createdAt) },
                  { label: "备注", children: text(modelRunDetail.remark) }
                ]}
                size="small"
                title="基础信息"
              />
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "目标品牌", children: text(modelRunDetail.targetBrand) },
                  { label: "目标车系", children: text(modelRunDetail.targetSeries) },
                  { label: "目标车型", children: text(modelRunDetail.targetModel) },
                  { label: "目标年款", children: text(modelRunDetail.targetModelYear) },
                  { label: "目标版本", children: text(modelRunDetail.targetTrim) },
                  { label: "目标电池容量", children: kwh(modelRunDetail.targetBatteryCapacityKwh) },
                  {
                    label: "目标电池使用方式",
                    children: labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, modelRunDetail.targetBatteryUsageType)
                  }
                ]}
                size="small"
                title="目标维度"
              />
              <Descriptions
                bordered
                column={3}
                items={[
                  { label: "训练数据开始日期", children: formatDate(modelRunDetail.trainingDataStartDate) },
                  { label: "训练数据结束日期", children: formatDate(modelRunDetail.trainingDataEndDate) },
                  { label: "样本数", children: text(modelRunDetail.sampleCount) }
                ]}
                size="small"
                title="样本范围"
              />
              <Collapse
                items={[
                  { children: jsonBlock(modelRunDetail.featureSnapshot), key: "featureSnapshot", label: "featureSnapshot" },
                  { children: jsonBlock(modelRunDetail.parameterSnapshot), key: "parameterSnapshot", label: "parameterSnapshot" },
                  { children: jsonBlock(modelRunDetail.filterSnapshot), key: "filterSnapshot", label: "filterSnapshot" },
                  { children: jsonBlock(modelRunDetail.metricsSnapshot), key: "metricsSnapshot", label: "metricsSnapshot" },
                  { children: jsonBlock(modelRunDetail.outputSnapshot), key: "outputSnapshot", label: "outputSnapshot" },
                  { children: jsonBlock(modelRunDetail.errorSnapshot), key: "errorSnapshot", label: "errorSnapshot" }
                ]}
              />
              <Table
                columns={modelRunOutputColumns}
                dataSource={modelRunDetail.outputs ?? []}
                locale={{ emptyText: "暂无输出关联" }}
                pagination={false}
                rowKey="id"
                scroll={{ x: 1400 }}
                size="small"
                title={() => "输出关联"}
              />
            </Space>
          ) : null}
        </Drawer>

        <Modal
          destroyOnHidden
          okText="保存"
          onCancel={() => setModelRunCreateOpen(false)}
          onOk={() => modelRunCreateForm.submit()}
          open={modelRunCreateOpen}
          confirmLoading={modelRunCreateSubmitting}
          title="新增模型运行记录"
          width={1040}
        >
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              description="创建运行记录不会触发真实模型训练。本阶段只记录模型版本、样本范围、特征、参数和筛选快照。"
              showIcon
              type="info"
            />
            <Form<ModelRunCreateFormValues> form={modelRunCreateForm} layout="vertical" onFinish={submitModelRunCreate}>
              <Row gutter={12}>
                <Col md={8} xs={24}>
                  <Form.Item label="运行名称" name="runName">
                    <Input maxLength={128} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="运行类型" name="runType" rules={[{ required: true, message: "请选择运行类型" }]}>
                    <Select options={optionsFromLabels(RESIDUAL_MODEL_RUN_TYPE_LABELS)} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="初始状态" name="runStatus" rules={[{ required: true, message: "请选择初始状态" }]}>
                    <Select
                      options={[
                        { label: labelOf(RESIDUAL_MODEL_RUN_STATUS_LABELS, "CREATED"), value: "CREATED" },
                        { label: labelOf(RESIDUAL_MODEL_RUN_STATUS_LABELS, "RUNNING"), value: "RUNNING" }
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="模型名称" name="modelName">
                    <Input maxLength={128} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="模型版本" name="modelVersion">
                    <Input maxLength={64} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="模型提供方" name="modelProvider">
                    <Input maxLength={64} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="算法" name="algorithm">
                    <Select allowClear options={optionsFromLabels(RESIDUAL_MODEL_ALGORITHM_LABELS)} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="目标类型" name="targetType" rules={[{ required: true, message: "请选择目标类型" }]}>
                    <Select options={optionsFromLabels(RESIDUAL_MODEL_TARGET_TYPE_LABELS)} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="目标品牌" name="targetBrand">
                    <Input maxLength={64} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="目标车系" name="targetSeries">
                    <Input maxLength={64} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="目标车型" name="targetModel">
                    <Input maxLength={128} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="目标年款" name="targetModelYear">
                    <InputNumber min={1990} max={2100} precision={0} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="目标版本 / trim" name="targetTrim">
                    <Input maxLength={128} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="目标电池容量（kWh）" name="targetBatteryCapacityKwh">
                    <InputNumber min={0} precision={2} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="目标电池使用方式" name="targetBatteryUsageType">
                    <Select allowClear options={optionsFromLabels(VEHICLE_BATTERY_USAGE_TYPE_LABELS)} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="训练数据开始日期" name="trainingDataStartDate">
                    <DatePicker style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="训练数据结束日期" name="trainingDataEndDate">
                    <DatePicker style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="样本数" name="sampleCount">
                    <InputNumber min={0} precision={0} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="featureSnapshot" name="featureSnapshotText">
                    <Input.TextArea rows={4} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="parameterSnapshot" name="parameterSnapshotText">
                    <Input.TextArea rows={4} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="filterSnapshot" name="filterSnapshotText">
                    <Input.TextArea rows={4} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="备注" name="remark">
                    <Input.TextArea rows={3} />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          </Space>
        </Modal>

        <Modal
          destroyOnHidden
          okText="提交完成"
          okButtonProps={{ loading: modelRunCompleteSubmitting }}
          onCancel={() => setModelRunCompleteTarget(null)}
          onOk={submitModelRunComplete}
          open={Boolean(modelRunCompleteTarget)}
          title="标记模型运行完成"
          width={900}
        >
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              description="标记完成只记录运行结果和输出关联，不会自动生成曲线或预测。如需生成残值曲线，请使用“残值曲线”Tab 的生成功能。"
              showIcon
              type="info"
            />
            <Form<ModelRunCompleteFormValues> form={modelRunCompleteForm} layout="vertical">
              <Form.Item label="metricsSnapshot" name="metricsSnapshotText">
                <Input.TextArea rows={5} />
              </Form.Item>
              <Form.Item label="outputSnapshot" name="outputSnapshotText">
                <Input.TextArea rows={5} />
              </Form.Item>
              <Form.Item
                extra='示例：[{"outputType":"RESIDUAL_CURVE","curveId":"xxx","outputSnapshot":{"curveNo":"RVC..."}}]'
                label="outputs"
                name="outputsText"
              >
                <Input.TextArea rows={6} />
              </Form.Item>
              <Form.Item label="备注" name="remark">
                <Input.TextArea rows={3} />
              </Form.Item>
            </Form>
          </Space>
        </Modal>

        <Modal
          destroyOnHidden
          okText="提交失败"
          okButtonProps={{ danger: true, loading: modelRunFailSubmitting }}
          onCancel={() => setModelRunFailTarget(null)}
          onOk={submitModelRunFail}
          open={Boolean(modelRunFailTarget)}
          title="标记模型运行失败"
          width={760}
        >
          <Form<ModelRunFailFormValues> form={modelRunFailForm} layout="vertical">
            <Form.Item label="errorSnapshot" name="errorSnapshotText">
              <Input.TextArea rows={6} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          okText="提交取消"
          okButtonProps={{ danger: true, loading: modelRunCancelSubmitting }}
          onCancel={() => setModelRunCancelTarget(null)}
          onOk={submitModelRunCancel}
          open={Boolean(modelRunCancelTarget)}
          title="取消模型运行"
        >
          <Form<ModelRunCancelFormValues> form={modelRunCancelForm} layout="vertical">
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={4} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          footer={[
            <Button key="cancel" onClick={() => setCurveGenerateOpen(false)}>
              取消
            </Button>,
            <Button icon={<SearchOutlined />} key="dryRun" loading={curveDryRunLoading} onClick={submitCurveDryRun}>
              试算
            </Button>,
            <Button
              icon={<LineChartOutlined />}
              key="generate"
              loading={curveGenerateSubmitting}
              onClick={submitCurveGenerate}
              type="primary"
            >
              正式生成
            </Button>
          ]}
          onCancel={() => setCurveGenerateOpen(false)}
          open={curveGenerateOpen}
          title="生成残值曲线"
          width={1080}
        >
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              description="先试算可预览匹配样本数和曲线点；正式生成只创建 DRAFT 曲线，不会自动启用，也不会覆盖车辆当前销售价。参考价格按元输入，提交后按分传给后端。"
              showIcon
              type="info"
            />
            <Form<CurveGenerateFormValues> form={curveGenerateForm} layout="vertical">
              <Row gutter={12}>
                <Col md={8} xs={24}>
                  <Form.Item label="方法">
                    <Input disabled value={labelOf(VEHICLE_RESIDUAL_CURVE_METHOD_LABELS, "STATISTICAL_MEDIAN")} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="品牌" name="brand" rules={[{ required: true, message: "请输入品牌" }]}>
                    <Input maxLength={64} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="车系" name="series">
                    <Input maxLength={64} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="车型" name="model" rules={[{ required: true, message: "请输入车型" }]}>
                    <Input maxLength={128} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="年款" name="modelYear">
                    <InputNumber min={1990} max={2100} precision={0} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="版本 / trim" name="trim">
                    <Input maxLength={128} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="电池容量（kWh）" name="batteryCapacityKwh">
                    <InputNumber min={0} precision={2} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="电池使用方式" name="batteryUsageType">
                    <Select allowClear options={optionsFromLabels(VEHICLE_BATTERY_USAGE_TYPE_LABELS)} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="单点最小样本数" name="minSamplePerPoint">
                    <InputNumber min={1} precision={0} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col md={12} xs={24}>
                  <Form.Item label="价格类型" name="priceTypes">
                    <Select mode="multiple" options={optionsFromLabels(MARKET_PRICE_TYPE_LABELS)} />
                  </Form.Item>
                </Col>
                <Col md={6} xs={24}>
                  <Form.Item label="样本开始日期" name="sampleStartDate">
                    <DatePicker style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col md={6} xs={24}>
                  <Form.Item label="样本结束日期" name="sampleEndDate">
                    <DatePicker style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col md={8} xs={24}>
                  <Form.Item label="参考价格（元）" name="referencePriceYuan">
                    <InputNumber min={0} precision={2} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="备注" name="remark">
                    <Input.TextArea rows={3} />
                  </Form.Item>
                </Col>
              </Row>
            </Form>

            {curveGenerateResult ? (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Descriptions
                  bordered
                  column={4}
                  items={[
                    { label: "模式", children: curveGenerateResult.dryRun ? "试算" : "正式生成" },
                    { label: "匹配样本数", children: curveGenerateResult.sampleCount },
                    { label: "生成点数", children: curveGenerateResult.pointCount },
                    { label: "跳过样本数", children: curveGenerateResult.skippedSampleCount }
                  ]}
                  size="small"
                  title="生成结果"
                />
                <Collapse items={[{ children: jsonBlock(curveGenerateResult.skippedReasons), key: "skippedReasons", label: "跳过原因" }]} />
                <Table
                  columns={curvePointColumns}
                  dataSource={curveGenerateResult.points}
                  pagination={false}
                  rowKey={(record) => record.id ?? `${record.ageMonth}-${record.sampleCount}-${record.medianPriceAmount ?? "-"}`}
                  scroll={{ x: 1600 }}
                  size="small"
                  title={() => "曲线点预览"}
                />
              </Space>
            ) : null}
          </Space>
        </Modal>

        <Modal
          destroyOnHidden
          okText="提交启用"
          okButtonProps={{ loading: curveActivateSubmitting }}
          onCancel={() => setCurveActivateTarget(null)}
          onOk={submitCurveActivate}
          open={Boolean(curveActivateTarget)}
          title="启用残值曲线"
        >
          <Form<CurveActivateFormValues> form={curveActivateForm} layout="vertical">
            <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}>
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={4} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          okText="提交归档"
          okButtonProps={{ danger: true, loading: curveArchiveSubmitting }}
          onCancel={() => setCurveArchiveTarget(null)}
          onOk={submitCurveArchive}
          open={Boolean(curveArchiveTarget)}
          title="归档残值曲线"
        >
          <Form<CurveArchiveFormValues> form={curveArchiveForm} layout="vertical">
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={4} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          okText="保存"
          onCancel={() => setCreateOpen(false)}
          onOk={() => observationForm.submit()}
          open={createOpen}
          confirmLoading={createSubmitting}
          title="新增市场样本"
          width={920}
        >
          <Form<ObservationFormValues> form={observationForm} layout="vertical" onFinish={submitObservation}>
            <Row gutter={12}>
              <Col md={8} xs={24}>
                <Form.Item label="来源" name="source" rules={[{ required: true, message: "请选择来源" }]}>
                  <Select options={optionsFromLabels(MARKET_PRICE_SOURCE_LABELS)} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="来源 listing ID" name="sourceListingId">
                  <Input maxLength={128} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="观测日期" name="observedAt" rules={[{ required: true, message: "请选择观测日期" }]}>
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="品牌" name="brand" rules={[{ required: true, message: "请输入品牌" }]}>
                  <Input maxLength={64} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="车系" name="series">
                  <Input maxLength={64} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="车型" name="model" rules={[{ required: true, message: "请输入车型" }]}>
                  <Input maxLength={128} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="年款" name="modelYear">
                  <InputNumber min={1990} max={2100} precision={0} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="版本 / trim" name="trim">
                  <Input maxLength={128} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="电池容量（kWh）" name="batteryCapacityKwh">
                  <InputNumber min={0} precision={2} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="电池使用方式" name="batteryUsageType">
                  <Select allowClear options={optionsFromLabels(VEHICLE_BATTERY_USAGE_TYPE_LABELS)} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="里程（km）" name="mileageKm">
                  <InputNumber min={0} precision={0} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="上牌日期" name="registrationDate">
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="车龄（月）" name="vehicleAgeMonths">
                  <InputNumber min={0} precision={0} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="省份" name="province">
                  <Input maxLength={64} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="城市" name="city">
                  <Input maxLength={64} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="价格类型" name="priceType" rules={[{ required: true, message: "请选择价格类型" }]}>
                  <Select options={optionsFromLabels(MARKET_PRICE_TYPE_LABELS)} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="价格（元）" name="priceAmountYuan" rules={[{ required: true, message: "请输入价格" }]}>
                  <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="挂牌价（元）" name="listingPriceAmountYuan">
                  <InputNumber min={0} precision={2} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="成交价（元）" name="transactionPriceAmountYuan">
                  <InputNumber min={0} precision={2} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="挂牌天数" name="listingDays">
                  <InputNumber min={0} precision={0} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="卖家类型" name="sellerType">
                  <Select allowClear options={optionsFromLabels(MARKET_SELLER_TYPE_LABELS)} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="车况等级" name="conditionGrade">
                  <Input maxLength={64} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="电池健康度（%）" name="batteryHealthPercent">
                  <InputNumber min={0} max={100} precision={2} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col md={8} xs={24}>
                <Form.Item label="事故标识" name="accidentFlag">
                  <Select
                    allowClear
                    options={[
                      { label: "是", value: "true" },
                      { label: "否", value: "false" }
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item label="sourceUrl" name="sourceUrl">
                  <Input maxLength={512} />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item label="备注" name="remark">
                  <Input.TextArea rows={3} />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          okText="执行导入"
          onCancel={() => setCsvOpen(false)}
          onOk={() => csvImportForm.submit()}
          okButtonProps={{ disabled: Boolean(csvResult) || csvSubmitting }}
          open={csvOpen}
          confirmLoading={csvSubmitting}
          title="导入 CSV"
          width={1040}
        >
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              description="金额字段按元填写；日期格式为 YYYY-MM-DD；必填字段为 observedAt、brand、model、priceType、priceAmount。前端读取本地 CSV 为文本后提交，不使用 multipart 上传。"
              showIcon
              type="info"
            />
            <Alert
              description="CSV 是纯文本格式，不能内置下拉选项或单元格校验；batteryUsageType、priceType、sellerType 请严格填写下方英文枚举值。"
              showIcon
              type="warning"
            />
            <Descriptions
              bordered
              column={1}
              items={CSV_ENUM_FIELD_GUIDES.map((item) => ({
                children: item.values.map(([value, label]) => `${value} = ${label}`).join("；"),
                label: `${item.field}（${item.label}）`
              }))}
              size="small"
              title="CSV 枚举字段取值说明"
            />
            {csvResult ? (
              <Alert
                description="本次 CSV 已导入完成。为避免同一文件重复生成导入批次，当前弹窗已禁用再次执行导入；如需导入新内容，请重新选择文件或编辑 CSV 文本。"
                showIcon
                type="success"
              />
            ) : null}
            <Space wrap>
              <Button icon={<DownloadOutlined />} onClick={downloadCsvTemplate}>
                下载 CSV 模板
              </Button>
              <Button icon={<CopyOutlined />} onClick={copyCsvHeader}>
                复制 CSV 表头
              </Button>
              <Button icon={<CopyOutlined />} onClick={copyCsvEnumGuide}>
                复制枚举取值
              </Button>
            </Space>
            <Form<CsvImportFormValues>
              form={csvImportForm}
              layout="vertical"
              onFinish={submitCsvImport}
              onValuesChange={(changedValues) => {
                if ("csvText" in changedValues) {
                  setCsvResult(null);
                }
              }}
            >
              <Row gutter={12}>
                <Col md={8} xs={24}>
                  <Form.Item label="来源" name="source" rules={[{ required: true, message: "请选择来源" }]}>
                    <Select options={optionsFromLabels(MARKET_PRICE_SOURCE_LABELS)} />
                  </Form.Item>
                </Col>
                <Col md={16} xs={24}>
                  <Form.Item label="文件名" name="fileName">
                    <Input maxLength={255} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="CSV 文件">
                    <input accept=".csv,text/csv" onChange={onCsvFileChange} type="file" />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="CSV 文本" name="csvText" rules={[{ required: true, message: "请选择 CSV 文件或粘贴 CSV 文本" }]}>
                    <Input.TextArea rows={8} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="备注" name="remark">
                    <Input.TextArea rows={3} />
                  </Form.Item>
                </Col>
              </Row>
            </Form>

            {csvResult ? (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Descriptions
                  bordered
                  column={3}
                  items={[
                    { label: "批次编号", children: csvResult.batch.batchNo },
                    { label: "总行数", children: csvResult.totalRows },
                    { label: "导入行数", children: csvResult.importedRows },
                    { label: "跳过行数", children: csvResult.skippedRows },
                    { label: "失败行数", children: csvResult.failedRows },
                    { label: "导入状态", children: enumTag(MARKET_PRICE_IMPORT_STATUS_LABELS, csvResult.batch.importStatus) }
                  ]}
                  size="small"
                  title="导入结果"
                />
                {csvResult.items.length > 100 ? (
                  <Alert message="导入明细较多，当前仅展示前 100 条。" showIcon type="info" />
                ) : null}
                <Table
                  columns={importResultColumns}
                  dataSource={csvResult.items.slice(0, 100)}
                  pagination={false}
                  rowKey={(record) => `${record.rowNumber}-${record.action}-${record.observationId ?? record.reason}`}
                  size="small"
                />
              </Space>
            ) : null}
          </Space>
        </Modal>

        <Modal
          destroyOnHidden
          okText="提交作废"
          okButtonProps={{ danger: true, loading: voidSubmitting }}
          onCancel={() => setVoidTarget(null)}
          onOk={submitVoid}
          open={Boolean(voidTarget)}
          title="作废市场价格样本"
        >
          <Form<VoidFormValues> form={voidForm} layout="vertical">
            <Form.Item label="作废原因 / 备注" name="remark">
              <Input.TextArea rows={4} />
            </Form.Item>
          </Form>
        </Modal>
      </Space>
    </ProtectedShell>
  );
}
