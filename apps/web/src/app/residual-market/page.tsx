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
import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import {
  MARKET_PRICE_IMPORT_STATUS_LABELS,
  MARKET_PRICE_OBSERVATION_STATUS_LABELS,
  MARKET_PRICE_SOURCE_LABELS,
  MARKET_PRICE_TYPE_LABELS,
  MARKET_SELLER_TYPE_LABELS,
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
  COMPLETED: "green",
  CSV_IMPORT: "blue",
  DRAFT: "blue",
  FAILED: "red",
  IGNORED: "orange",
  IMPORTED: "green",
  MANUAL: "cyan",
  ML_MODEL: "purple",
  PARTIAL_FAILED: "orange",
  STATISTICAL_MEDIAN: "geekblue",
  SKIPPED_DUPLICATE: "orange",
  SUPERSEDED: "orange",
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
  const [observationForm] = Form.useForm<ObservationFormValues>();
  const [csvImportForm] = Form.useForm<CsvImportFormValues>();
  const [curveGenerateForm] = Form.useForm<CurveGenerateFormValues>();
  const [curveActivateForm] = Form.useForm<CurveActivateFormValues>();
  const [curveArchiveForm] = Form.useForm<CurveArchiveFormValues>();
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
  const permissions = useMemo(() => new Set(me?.user.permissions ?? []), [me]);
  const canView = permissions.has("residual_market:view");
  const canManage = permissions.has("residual_market:manage");
  const canImport = permissions.has("residual_market:import");
  const canViewCurve = permissions.has("residual_curve:view");
  const canGenerateCurve = permissions.has("residual_curve:generate");
  const canManageCurve = permissions.has("residual_curve:manage");

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
      void message.success("CSV 文件已读取");
    };
    reader.onerror = () => {
      void message.error("CSV 文件读取失败");
    };
    reader.readAsText(file, "UTF-8");
  }

  async function submitCsvImport(values: CsvImportFormValues) {
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
            <Form<CsvImportFormValues> form={csvImportForm} layout="vertical" onFinish={submitCsvImport}>
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
