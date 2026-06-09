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
  DatePicker,
  Descriptions,
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
  VEHICLE_ACQUISITION_MODE_LABELS,
  VEHICLE_BATTERY_USAGE_TYPE_LABELS,
  VEHICLE_CAPITAL_EVENT_STATUS_LABELS,
  VEHICLE_CAPITAL_EVENT_TYPE_LABELS,
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
  model?: string | null;
  modelYear?: number | null;
  nextSalePriceReviewAt?: string | null;
  plateNo?: string | null;
  purchaseDate?: string | null;
  purchasePriceAmount: number;
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
  return value ? dayjs(value).format("YYYY-MM-DD") : "-";
}

function formatInsurancePeriod(vehicle: Pick<Vehicle, "insuranceEndDate" | "insuranceStartDate">) {
  if (!vehicle.insuranceStartDate || !vehicle.insuranceEndDate) {
    return "-";
  }
  return `${formatDate(vehicle.insuranceStartDate)} 至 ${formatDate(vehicle.insuranceEndDate)}`;
}

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function toCents(value: number) {
  return Math.round(value * 100);
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
  const [activeTab, setActiveTab] = useState("vehicles");
  const [capitalEvents, setCapitalEvents] = useState<CapitalEvent[]>([]);
  const [capitalEventOpen, setCapitalEventOpen] = useState(false);
  const [capitalStructure, setCapitalStructure] = useState<CapitalStructurePreview | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deactivatingShareRule, setDeactivatingShareRule] = useState<RevenueShareRule | null>(null);
  const [detailVehicle, setDetailVehicle] = useState<Vehicle | null>(null);
  const [dueReviews, setDueReviews] = useState<Vehicle[]>([]);
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
          model: values.model,
          modelYear: values.modelYear,
          plateNo: values.plateNo,
          purchaseDate: values.purchaseDate?.format("YYYY-MM-DD"),
          purchasePriceAmount: toCents(values.purchasePriceAmountYuan),
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
    revenueSharePreviewForm.setFieldsValue({
      endDate: dayjs().endOf("month"),
      startDate: dayjs().startOf("month")
    });
    void loadVehicleFinancialData(vehicle.id);
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
      purchaseDate: vehicle.purchaseDate ? dayjs(vehicle.purchaseDate) : null,
      purchasePriceAmountYuan: vehicle.purchasePriceAmount / 100,
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
          model: values.model,
          modelYear: values.modelYear,
          plateNo: values.plateNo,
          purchaseDate: values.purchaseDate?.format("YYYY-MM-DD"),
          purchasePriceAmount: toCents(values.purchasePriceAmountYuan),
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

  async function saveCapitalEvent(values: CapitalEventValues) {
    if (!detailVehicle) {
      return;
    }

    try {
      await apiFetch(`/vehicles/${detailVehicle.id}/capital-events`, {
        body: JSON.stringify({
          acquisitionMode: values.acquisitionMode,
          debtPrincipalAmount: toCentAmount(values.debtPrincipalAmountYuan),
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          equityCapitalAmount: toCentAmount(values.equityCapitalAmountYuan),
          eventType: values.eventType,
          externalOwnerName: values.externalOwnerName,
          financingInstrumentId: values.financingInstrumentId,
          lessorName: values.lessorName,
          managedOwnerName: values.managedOwnerName,
          remark: values.remark
        }),
        method: "POST"
      });
      void message.success("资本事件已新增");
      setCapitalEventOpen(false);
      capitalEventForm.resetFields();
      await loadVehicleFinancialData(detailVehicle.id);
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
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
            <VehicleCapitalStructureBlock
              capitalStructure={capitalStructure}
              loading={vehicleFinancialLoading}
            />
            <VehicleCapitalEventsBlock
              activeFinancingAllocations={capitalStructure?.activeFinancingAllocations ?? []}
              capitalEvents={capitalEvents}
              loading={vehicleFinancialLoading}
              onCreate={openCapitalEventModal}
              onCreateFromAllocation={openCapitalEventModal}
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

      <Modal
        destroyOnHidden
        okText="保存"
        onCancel={() => setCapitalEventOpen(false)}
        onOk={() => capitalEventForm.submit()}
        open={capitalEventOpen}
        title="新增资本事件"
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
  onCreate,
  onCreateFromAllocation,
  permissions
}: Readonly<{
  activeFinancingAllocations: FinancingAllocation[];
  capitalEvents: CapitalEvent[];
  loading: boolean;
  onCreate: () => void;
  onCreateFromAllocation: (allocation: FinancingAllocation) => void;
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
      render: (_, record) => (
        <ActionButton
          onClick={() => onCreateFromAllocation(record)}
          permission="capital_structure:manage"
          permissions={permissions}
          size="small"
        >
          补录资本事件
        </ActionButton>
      ),
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
    { dataIndex: "remark", render: (value: string | null) => value ?? "-", title: "备注", width: 180 }
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
      <Table columns={columns} dataSource={capitalEvents} loading={loading} pagination={false} rowKey="id" scroll={{ x: 1260 }} size="small" />
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
