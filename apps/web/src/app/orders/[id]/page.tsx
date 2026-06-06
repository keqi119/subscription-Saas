"use client";

import { ArrowLeftOutlined, DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Checkbox, DatePicker, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Spin, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../../components/action-button";
import { ProtectedShell } from "../../../components/protected-shell";
import {
  DELIVERY_STATUS_LABELS,
  ORDER_CHANGE_TYPE_LABELS,
  STATUS_LABELS,
  VEHICLE_BASE_FEE_MODE_LABELS,
  VEHICLE_BATTERY_USAGE_TYPE_LABELS,
  VEHICLE_DAMAGE_LEVEL_LABELS,
  VEHICLE_DAMAGE_RESPONSIBLE_PARTY_LABELS,
  VEHICLE_DAMAGE_TYPE_LABELS,
  VEHICLE_RETURN_DAMAGE_STATUS_LABELS,
  VEHICLE_RETURN_STATUS_LABELS,
  VEHICLE_RETURN_TYPE_LABELS,
  labelOf
} from "../../../constants/labels";
import {
  actionAvailability,
  canExecuteOrderChange,
  canGenerateContract as getGenerateContractAvailability
} from "../../../lib/action-guards";
import { apiFetch, ApiError } from "../../../lib/api";
import type { AuthMeResponse } from "../../../lib/auth";

interface OrderDetail {
  actualDeliveryAt?: string | null;
  actualReturnAt?: string | null;
  application?: { applicationNo: string; id: string } | null;
  contract?: { contractNo: string; id: string; status: string } | null;
  createdAt: string;
  creditReviewStatus?: string;
  customer: { name: string; mobile: string };
  customerConfirmedAt?: string | null;
  depositAmount: number;
  depositStatus?: string;
  finalDepositAmount?: number | null;
  finalPlanConfirmedAt?: string | null;
  id: string;
  mileageLimitKm: number;
  monthlyFeeAmount: number;
  orderNo: string;
  orderSource?: string;
  orderStatus: string;
  periodMonths: number;
  productReviewStatus?: string;
  quote?: { quoteNo: string; id: string } | null;
  quoteSnapshot?: unknown;
  vehicle?: {
    batteryCapacityKwh?: number | null;
    batteryUsageType?: string | null;
    batteryUsageTypeLabel?: string | null;
    currentMileageKm?: number | null;
    currentSalePriceAmount?: number | null;
    plateNo?: string | null;
    status?: string | null;
    vehicleModel?: string | null;
    vehicleNo?: string;
    vin?: string | null;
  } | null;
  vehicleModel: string;
  vehiclePurchasePriceAmount: number;
  vehicleReviewStatus?: string;
}

interface OrderChangeRow {
  afterSnapshot?: unknown;
  changeType: string;
  createdAt: string;
  createdBy?: string | null;
  creator?: { name: string } | null;
  executedAt?: string | null;
  id: string;
  reason: string;
  status: string;
}

interface ChangeFormValues {
  reason: string;
}

interface DeliveryCheck {
  alreadyDelivered?: boolean;
  blockingReasons: string[];
  canConfirmDelivery: boolean;
  canPrepareDelivery: boolean;
  contractSigned: boolean;
  currentSalePriceInitialized: boolean;
  deliveryStatus?: string | null;
  depositReceivedConfirmed: boolean;
  firstMonthlyFeeReceivedConfirmed: boolean;
  insuranceValid: boolean;
  orderId: string;
  orderNo: string;
  orderStatus: string;
  vehiclePrepared: boolean;
  vehicleStatus?: string | null;
}

interface VehicleDelivery {
  contractSignedConfirmed?: boolean;
  customerIdentityConfirmed?: boolean;
  deliveredAt?: string | null;
  deliveryLocation?: string | null;
  deliveryNo: string;
  deliveryStatus: string;
  depositReceivedConfirmed?: boolean;
  firstMonthlyFeeReceivedConfirmed?: boolean;
  handoverDocumentsConfirmed?: boolean;
  handoverMileageKm?: number | null;
  id: string;
  insuranceValidConfirmed?: boolean;
  remark?: string | null;
  scheduledAt?: string | null;
  vehiclePhotosConfirmed?: boolean;
  vehiclePreparedConfirmed?: boolean;
}

interface PrepareDeliveryFormValues {
  customerIdentityConfirmed?: boolean;
  deliveryLocation?: string;
  depositReceivedConfirmed?: boolean;
  firstMonthlyFeeReceivedConfirmed?: boolean;
  handoverDocumentsConfirmed?: boolean;
  insuranceValidConfirmed?: boolean;
  remark?: string;
  scheduledAt?: Dayjs;
  vehiclePhotosConfirmed?: boolean;
  vehiclePreparedConfirmed?: boolean;
}

interface ConfirmDeliveryFormValues {
  deliveredAt?: Dayjs;
  handoverMileageKm?: number;
  remark?: string;
}

interface ReturnCheck {
  alreadyReturned?: boolean;
  blockingReasons: string[];
  canConfirmReturn: boolean;
  canPrepareReturn: boolean;
  orderId: string;
  orderNo: string;
  orderStatus: string;
  returnStatus?: string | null;
  vehicleId?: string | null;
  vehicleStatus?: string | null;
}

interface VehicleReturnDamage {
  damageLevel: string;
  damageType: string;
  description?: string | null;
  estimatedRepairAmount?: number | null;
  id: string;
  photoUrls?: string[] | null;
  responsibleParty?: string | null;
  status: string;
}

interface VehicleReturn {
  batteryCheckedConfirmed?: boolean;
  chargingEquipmentReturnedConfirmed?: boolean;
  cleaningRequired?: boolean;
  customerItemsClearedConfirmed?: boolean;
  damageFound?: boolean;
  damages?: VehicleReturnDamage[];
  exteriorCheckedConfirmed?: boolean;
  id: string;
  interiorCheckedConfirmed?: boolean;
  keysReturnedConfirmed?: boolean;
  maintenanceRequired?: boolean;
  mileageConfirmed?: boolean;
  remark?: string | null;
  returnLocation?: string | null;
  returnMileageKm?: number | null;
  returnNo: string;
  returnStatus: string;
  returnType: string;
  returnedAt?: string | null;
  scheduledAt?: string | null;
  vehicleDocumentsReturnedConfirmed?: boolean;
  violationCheckedConfirmed?: boolean;
}

interface PrepareReturnFormValues {
  remark?: string;
  returnLocation?: string;
  returnType?: string;
  scheduledAt?: Dayjs;
}

interface ConfirmReturnDamageFormValues {
  damageLevel?: string;
  damageType?: string;
  description?: string;
  estimatedRepairAmount?: number;
  photoUrlsText?: string;
  responsibleParty?: string;
}

interface ConfirmReturnFormValues {
  batteryCheckedConfirmed?: boolean;
  chargingEquipmentReturnedConfirmed?: boolean;
  cleaningRequired?: boolean;
  customerItemsClearedConfirmed?: boolean;
  damageFound?: boolean;
  damages?: ConfirmReturnDamageFormValues[];
  exteriorCheckedConfirmed?: boolean;
  interiorCheckedConfirmed?: boolean;
  keysReturnedConfirmed?: boolean;
  maintenanceRequired?: boolean;
  mileageConfirmed?: boolean;
  remark?: string;
  returnMileageKm?: number;
  returnType?: string;
  returnedAt?: Dayjs;
  vehicleDocumentsReturnedConfirmed?: boolean;
  violationCheckedConfirmed?: boolean;
}

type SnapshotRecord = Record<string, unknown>;

const ORDER_SOURCE_LABELS: Record<string, string> = {
  CUSTOMER_SELF_SERVICE: "客户自动下单",
  SALES_ASSISTED: "销售手动下单"
};

const PRE_CONTRACT_CHANGE_ORDER_STATUSES = new Set([
  "PENDING_REVIEW",
  "PENDING_CUSTOMER_CONFIRMATION",
  "PENDING_CONTRACT",
  "PENDING_SIGN",
  "PENDING_PAYMENT",
  "PENDING_VEHICLE",
  "PENDING_DELIVERY"
]);

const DELIVERY_PREPARE_ORDER_STATUSES = new Set([
  "PENDING_PAYMENT",
  "PENDING_VEHICLE",
  "PENDING_DELIVERY"
]);

const returnTypeOptions = [
  { label: "正常到期退车", value: "NORMAL_RETURN" },
  { label: "提前终止退车", value: "EARLY_TERMINATION" }
];

const damageTypeOptions = [
  { label: "外观", value: "EXTERIOR" },
  { label: "内饰", value: "INTERIOR" },
  { label: "电池", value: "BATTERY" },
  { label: "轮胎", value: "TIRE" },
  { label: "玻璃", value: "GLASS" },
  { label: "底盘", value: "CHASSIS" },
  { label: "随车设备", value: "EQUIPMENT" },
  { label: "其他", value: "OTHER" }
];

const damageLevelOptions = [
  { label: "轻微", value: "MINOR" },
  { label: "中等", value: "MEDIUM" },
  { label: "严重", value: "SEVERE" }
];

const responsiblePartyOptions = [
  { label: "客户", value: "CUSTOMER" },
  { label: "平台", value: "PLATFORM" },
  { label: "第三方", value: "THIRD_PARTY" },
  { label: "未确认", value: "UNKNOWN" }
];

const reviewStatusColors: Record<string, string> = {
  APPROVED: "green",
  CONFIRMED: "green",
  NEED_MORE_INFO: "orange",
  PENDING: "blue",
  PENDING_CONFIRM: "orange",
  REJECTED: "red"
};

const customerGradeOptions = [
  { label: "A", value: "A" },
  { label: "B", value: "B" },
  { label: "C", value: "C" }
];

function formatYuan(value?: unknown) {
  const amount = toNumber(value);
  if (amount === null) {
    return "-";
  }

  return `${(amount / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })} 元`;
}

function centsToYuan(value?: unknown) {
  const amount = toNumber(value);
  return amount === null ? undefined : Number((amount / 100).toFixed(2));
}

function yuanToCents(value?: unknown) {
  const amount = toNumber(value);
  return amount === null ? undefined : Math.round(amount * 100);
}

function formatTime(value?: unknown) {
  return typeof value === "string" && value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function formatPercent(value?: unknown) {
  if (typeof value === "string" && value.trim().endsWith("%")) {
    const percent = Number(value.trim().slice(0, -1).replace(/,/g, ""));
    return Number.isFinite(percent) ? `${percent.toFixed(2)}%` : "-";
  }

  const rate = toNumber(value);
  if (rate === null) {
    return "-";
  }

  return `${(rate * 100).toFixed(2)}%`;
}

function formatKilometers(value?: unknown) {
  const kilometers = toNumber(value);
  return kilometers === null ? "-" : `${kilometers.toLocaleString("zh-CN")} km`;
}

function formatKwh(value?: unknown) {
  const kwh = toNumber(value);
  return kwh === null ? "-" : `${kwh.toLocaleString("zh-CN")} kWh`;
}

function formatBatteryUsageType(type?: unknown, label?: unknown) {
  const labelText = safeText(label);
  if (labelText !== "-") {
    return labelText;
  }
  const typeText = safeText(type);
  return typeText === "-" ? "-" : labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, typeText);
}

function formatCount(value?: unknown) {
  const count = toNumber(value);
  return count === null ? "-" : `${count.toLocaleString("zh-CN")} 次`;
}

function formatMonths(value?: unknown) {
  const months = toNumber(value);
  return months === null ? "-" : `${months.toLocaleString("zh-CN")} 个月`;
}

function safeText(value?: unknown) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (typeof value === "object") {
    return "-";
  }
  return String(value);
}

function parsePhotoUrls(value?: string) {
  if (!value) {
    return [];
  }
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function photoUrlsToText(value?: string[] | null) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function normalizePhotoUrls(value?: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function toNumber(value?: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(/,/g, "").replace(/%$/, "");
    if (!normalized) {
      return null;
    }
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function toSnapshotRecord(value: unknown): SnapshotRecord | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return toSnapshotRecord(parsed);
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as SnapshotRecord;
  }
  return null;
}

function getSnapshotValue(snapshot: unknown, ...paths: string[]) {
  for (const path of paths) {
    const value = readSnapshotPath(snapshot, path);
    if (value !== null && value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

function readSnapshotPath(source: unknown, path: string) {
  let current: unknown = source;

  for (const key of path.split(".")) {
    const record = toSnapshotRecord(current);
    if (!record || !(key in record)) {
      return undefined;
    }
    current = record[key];
  }

  return current;
}

function joinText(...values: unknown[]) {
  const parts = values
    .map((value) => safeText(value))
    .filter((value, index, array) => value !== "-" && array.indexOf(value) === index);

  return parts.length > 0 ? parts.join(" / ") : "-";
}

function formatVehicleBaseFeeModeLabel(mode?: unknown, label?: unknown) {
  const explicitLabel = safeText(label);
  if (explicitLabel !== "-") {
    return explicitLabel;
  }
  const modeKey = safeText(mode);
  if (modeKey === "-") {
    return "-";
  }
  return VEHICLE_BASE_FEE_MODE_LABELS[modeKey] ?? modeKey;
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

function ReviewStatusTag({ value }: { value?: string }) {
  return value ? (
    <Tag color={reviewStatusColors[value]}>{labelOf(STATUS_LABELS, value)}</Tag>
  ) : (
    <Tag>-</Tag>
  );
}

function BooleanTag({ checked }: { checked?: boolean }) {
  return checked ? <Tag color="green">已确认</Tag> : <Tag>未确认</Tag>;
}

function DeliveryStatusTag({ value }: { value?: string | null }) {
  if (!value) {
    return <Tag>-</Tag>;
  }

  const colors: Record<string, string> = {
    CANCELLED: "red",
    DELIVERED: "green",
    PENDING: "blue",
    READY: "orange"
  };

  return <Tag color={colors[value]}>{labelOf(DELIVERY_STATUS_LABELS, value)}</Tag>;
}

function ReturnStatusTag({ value }: { value?: string | null }) {
  if (!value) {
    return <Tag>-</Tag>;
  }

  const colors: Record<string, string> = {
    CANCELLED: "red",
    CONFIRMED: "green",
    PENDING: "blue",
    READY: "orange"
  };

  return <Tag color={colors[value]}>{labelOf(VEHICLE_RETURN_STATUS_LABELS, value)}</Tag>;
}

function DamageStatusTag({ value }: { value?: string | null }) {
  if (!value) {
    return <Tag>-</Tag>;
  }

  const colors: Record<string, string> = {
    CONFIRMED: "green",
    RECORDED: "blue",
    SETTLED: "purple",
    WAIVED: "default"
  };

  return <Tag color={colors[value]}>{labelOf(VEHICLE_RETURN_DAMAGE_STATUS_LABELS, value)}</Tag>;
}

function canFinalizeOrder(order: OrderDetail) {
  return (
    ["PENDING_REVIEW", "PENDING_CUSTOMER_CONFIRMATION"].includes(order.orderStatus) &&
    order.creditReviewStatus === "APPROVED" &&
    order.productReviewStatus === "APPROVED" &&
    order.vehicleReviewStatus === "APPROVED" &&
    order.depositStatus === "CONFIRMED" &&
    order.finalDepositAmount !== null &&
    order.finalDepositAmount !== undefined
  );
}

function ReviewPanel({
  canConfirmFinalPlan,
  canRejectOrder,
  canReviewCredit,
  canReviewProduct,
  canReviewVehicle,
  creditForm,
  onConfirmCustomer,
  onFinalizePlan,
  onRejectOrder,
  onReview,
  order
}: {
  canConfirmFinalPlan: boolean;
  canRejectOrder: boolean;
  canReviewCredit: boolean;
  canReviewProduct: boolean;
  canReviewVehicle: boolean;
  creditForm: ReturnType<typeof Form.useForm<{ customerGrade: string }>>[0];
  onConfirmCustomer: () => Promise<void>;
  onFinalizePlan: () => Promise<void>;
  onRejectOrder: () => Promise<void>;
  onReview: (type: "credit" | "product" | "vehicle", status: "APPROVED" | "NEED_MORE_INFO" | "REJECTED") => Promise<void>;
  order: OrderDetail;
}) {
  if (order.orderSource !== "CUSTOMER_SELF_SERVICE") {
    return null;
  }

  const canReviewPendingOrder = order.orderStatus === "PENDING_REVIEW";

  return (
    <Card title="订单申请审核">
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Descriptions
          bordered
          column={3}
          items={[
            { label: "订单来源", children: ORDER_SOURCE_LABELS[order.orderSource] ?? order.orderSource },
            { label: "客户资质审核", children: <ReviewStatusTag value={order.creditReviewStatus} /> },
            { label: "产品匹配审核", children: <ReviewStatusTag value={order.productReviewStatus} /> },
            { label: "车辆库存审核", children: <ReviewStatusTag value={order.vehicleReviewStatus} /> },
            { label: "押金状态", children: <ReviewStatusTag value={order.depositStatus} /> },
            { label: "最终押金", children: formatYuan(order.finalDepositAmount ?? order.depositAmount) },
            { label: "最终方案确认时间", children: formatTime(order.finalPlanConfirmedAt) },
            { label: "客户确认时间", children: formatTime(order.customerConfirmedAt) },
            { label: "车辆", children: order.vehicle ? joinText(order.vehicle.vehicleNo, order.vehicle.plateNo, order.vehicle.vin) : "-" }
          ]}
        />

        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          {canReviewCredit && canReviewPendingOrder ? (
            <Space wrap>
              <Typography.Text strong>客户资质审核</Typography.Text>
              <Form form={creditForm} initialValues={{ customerGrade: "A" }} layout="inline">
                <Form.Item name="customerGrade" rules={[{ required: true, message: "请选择客户等级" }]}>
                  <Select options={customerGradeOptions} style={{ width: 96 }} />
                </Form.Item>
              </Form>
              <Button onClick={() => onReview("credit", "APPROVED")} size="small" type="primary">
                通过
              </Button>
              <Button onClick={() => onReview("credit", "NEED_MORE_INFO")} size="small">
                补资料
              </Button>
              <Button danger onClick={() => onReview("credit", "REJECTED")} size="small">
                拒绝
              </Button>
            </Space>
          ) : null}

          {canReviewProduct && canReviewPendingOrder ? (
            <Space wrap>
              <Typography.Text strong>产品匹配审核</Typography.Text>
              <Button onClick={() => onReview("product", "APPROVED")} size="small" type="primary">
                通过
              </Button>
              <Button danger onClick={() => onReview("product", "REJECTED")} size="small">
                拒绝
              </Button>
            </Space>
          ) : null}

          {canReviewVehicle && canReviewPendingOrder ? (
            <Space wrap>
              <Typography.Text strong>车辆库存审核</Typography.Text>
              <Button onClick={() => onReview("vehicle", "APPROVED")} size="small" type="primary">
                通过
              </Button>
              <Button danger onClick={() => onReview("vehicle", "REJECTED")} size="small">
                拒绝
              </Button>
            </Space>
          ) : null}

          <Space wrap>
            <Typography.Text strong>最终方案确认</Typography.Text>
            {canConfirmFinalPlan && canFinalizeOrder(order) ? (
              <Button onClick={onFinalizePlan} size="small" type="primary">
                确认最终方案
              </Button>
            ) : null}
            {canConfirmFinalPlan && order.orderStatus === "PENDING_CUSTOMER_CONFIRMATION" ? (
              <Button onClick={onConfirmCustomer} size="small">
                后台代客户确认并进入签约
              </Button>
            ) : null}
            {canRejectOrder && ["PENDING_REVIEW", "PENDING_CUSTOMER_CONFIRMATION"].includes(order.orderStatus) ? (
              <Button danger onClick={onRejectOrder} size="small">
                拒绝订单
              </Button>
            ) : null}
          </Space>
        </Space>
      </Space>
    </Card>
  );
}

function QuoteSnapshotSection({ order }: { order: OrderDetail | null }) {
  if (!order) {
    return null;
  }

  const snapshot = toSnapshotRecord(order.quoteSnapshot);
  const quoteStatus = safeText(getSnapshotValue(snapshot, "status"));
  const vehicleSnapshot = getSnapshotValue(snapshot, "vehicleSnapshot", "vehicle");
  const packageSnapshot = getSnapshotValue(snapshot, "packageSnapshot");
  const depositRuleSnapshot = getSnapshotValue(snapshot, "depositRuleSnapshot");
  const riskSnapshot = getSnapshotValue(snapshot, "riskResult");

  const currentVehicleSalePrice = getSnapshotValue(
    snapshot,
    "vehicleSnapshot.currentSalePriceAmount",
    "vehicle.currentSalePriceAmount",
    "vehicleSalePriceAmount"
  );
  const vehiclePackageRate = getSnapshotValue(
    snapshot,
    "packageSnapshot.vehiclePackage.monthlyFeeRate",
    "monthlyFeeRate",
    "packageSnapshot.subscriptionPlan.monthlyFeeRate"
  );
  const vehicleBaseFeeMode = getSnapshotValue(
    snapshot,
    "vehicleBaseFeeMode",
    "packageSnapshot.pricing.vehicleBaseFeeMode",
    "packageSnapshot.vehicleBaseFeeMode",
    "packageSnapshot.subscriptionPlan.monthlyFeeMode"
  );
  const vehicleBaseFeeModeLabel = formatVehicleBaseFeeModeLabel(
    vehicleBaseFeeMode,
    getSnapshotValue(
      snapshot,
      "vehicleBaseFeeModeLabel",
      "packageSnapshot.pricing.vehicleBaseFeeModeLabel",
      "packageSnapshot.vehicleBaseFeeModeLabel",
      "packageSnapshot.subscriptionPlan.monthlyFeeModeLabel"
    )
  );
  const fixedRate =
    getSnapshotValue(snapshot, "fixedRate", "packageSnapshot.pricing.fixedRate") ??
    (vehicleBaseFeeMode === "RATE_FORMULA"
      ? getSnapshotValue(snapshot, "packageSnapshot.subscriptionPlan.monthlyFeeRate", "monthlyFeeRate")
      : undefined);

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <Card title="报价基础信息">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "报价编号", children: safeText(getSnapshotValue(snapshot, "quoteNo") ?? order.quote?.quoteNo) },
            {
              label: "订阅套餐",
              children: joinText(
                getSnapshotValue(snapshot, "subscriptionPlan.planNo", "packageSnapshot.subscriptionPlan.planNo"),
                getSnapshotValue(snapshot, "subscriptionPlan.planName", "packageSnapshot.subscriptionPlan.planName")
              )
            },
            { label: "产品名称", children: safeText(getSnapshotValue(snapshot, "productVersion.product.name", "product.name")) },
            { label: "产品版本", children: safeText(getSnapshotValue(snapshot, "productVersion.versionNo", "productVersion.versionName")) },
            { label: "订阅周期", children: formatMonths(getSnapshotValue(snapshot, "periodMonths") ?? order.periodMonths) },
            {
              label: "报价状态",
              children: quoteStatus === "-" ? "-" : <Tag>{labelOf(STATUS_LABELS, quoteStatus)}</Tag>
            },
            { label: "创建时间", children: formatTime(getSnapshotValue(snapshot, "createdAt")) },
            { label: "确认时间", children: formatTime(getSnapshotValue(snapshot, "confirmedAt")) }
          ]}
        />
      </Card>

      <Card title="车辆信息快照">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "VIN", children: safeText(getSnapshotValue(vehicleSnapshot, "vin") ?? getSnapshotValue(snapshot, "vin")) },
            { label: "车牌号", children: safeText(getSnapshotValue(vehicleSnapshot, "plateNo") ?? getSnapshotValue(snapshot, "plateNo")) },
            { label: "品牌", children: safeText(getSnapshotValue(vehicleSnapshot, "brand") ?? getSnapshotValue(snapshot, "brand")) },
            { label: "车系", children: safeText(getSnapshotValue(vehicleSnapshot, "series") ?? getSnapshotValue(snapshot, "series")) },
            {
              label: "车型",
              children: safeText(
                getSnapshotValue(vehicleSnapshot, "vehicleModel", "model") ??
                  getSnapshotValue(snapshot, "vehicleModel", "model") ??
                  order.vehicleModel
              )
            },
            {
              label: "电池容量",
              children: formatKwh(
                getSnapshotValue(vehicleSnapshot, "batteryCapacityKwh") ??
                  getSnapshotValue(snapshot, "batteryCapacityKwh")
              )
            },
            {
              label: "电池使用方式",
              children: formatBatteryUsageType(
                getSnapshotValue(vehicleSnapshot, "batteryUsageType") ??
                  getSnapshotValue(snapshot, "batteryUsageType"),
                getSnapshotValue(vehicleSnapshot, "batteryUsageTypeLabel") ??
                  getSnapshotValue(snapshot, "batteryUsageTypeLabel")
              )
            },
            { label: "当前车辆销售价", children: formatYuan(currentVehicleSalePrice) },
            {
              label: "当前里程",
              children: formatKilometers(getSnapshotValue(vehicleSnapshot, "currentMileageKm") ?? getSnapshotValue(snapshot, "currentMileageKm"))
            },
            {
              label: "资产位置",
              children: safeText(getSnapshotValue(vehicleSnapshot, "assetLocation") ?? getSnapshotValue(snapshot, "assetLocation"))
            }
          ]}
        />
      </Card>

      <Card title="套餐与价格明细">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "当前车辆销售价", children: formatYuan(currentVehicleSalePrice) },
            { label: "车辆基础月费模式", children: vehicleBaseFeeModeLabel },
            { label: "车型包系数", children: formatPercent(vehiclePackageRate) },
            { label: "固定费率", children: formatPercent(fixedRate) },
            {
              label: "车辆基础费上限",
              children: formatYuan(
                getSnapshotValue(snapshot, "vehicleBaseFeeCapAmount", "monthlyFeeCapAmount", "packageSnapshot.pricing.vehicleBaseFeeCapAmount")
              )
            },
            {
              label: "车辆基础费报价",
              children: formatYuan(getSnapshotValue(snapshot, "vehicleBaseFeeAmount", "packageSnapshot.pricing.vehicleBaseFeeAmount"))
            },
            {
              label: "里程包价格",
              children: formatYuan(
                getSnapshotValue(snapshot, "mileagePackagePriceAmount", "packageSnapshot.pricing.mileagePackagePriceAmount", "packageSnapshot.mileagePackage.priceAmount")
              )
            },
            {
              label: "补能包价格",
              children: formatYuan(
                getSnapshotValue(snapshot, "energyPackagePriceAmount", "packageSnapshot.pricing.energyPackagePriceAmount", "packageSnapshot.energyPackage.priceAmount")
              )
            },
            {
              label: "权益包价格",
              children: formatYuan(
                getSnapshotValue(snapshot, "benefitPackagePriceAmount", "packageSnapshot.pricing.benefitPackagePriceAmount", "packageSnapshot.benefitPackage.priceAmount")
              )
            },
            {
              label: "套餐月费合计",
              children: formatYuan(getSnapshotValue(snapshot, "monthlyFeeAmount", "packageSnapshot.pricing.monthlyFeeAmount") ?? order.monthlyFeeAmount)
            },
            {
              label: "押金金额",
              children: formatYuan(getSnapshotValue(snapshot, "depositAmount", "depositRuleSnapshot.depositAmount") ?? order.depositAmount)
            },
            {
              label: "违约率",
              children: formatPercent(getSnapshotValue(depositRuleSnapshot, "defaultRate") ?? getSnapshotValue(snapshot, "defaultRate"))
            }
          ]}
        />
        <Typography.Paragraph style={{ marginTop: 16, marginBottom: 0 }}>
          车辆基础费上限 = 当前车辆销售价 × 车型包系数。
        </Typography.Paragraph>
        <Typography.Text type="secondary">
          套餐月费合计 = 车辆基础费 + 里程包价格 + 补能包价格 + 权益包价格；车型包系数只约束车辆基础费，不约束套餐月费合计。
        </Typography.Text>
      </Card>

      <Card title="套餐组件快照">
        <Descriptions
          bordered
          column={2}
          items={[
            {
              label: "车型包名称",
              children: joinText(
                getSnapshotValue(packageSnapshot, "vehiclePackage.packageNo"),
                getSnapshotValue(packageSnapshot, "vehiclePackage.packageName")
              )
            },
            {
              label: "里程包名称",
              children: joinText(
                getSnapshotValue(packageSnapshot, "mileagePackage.packageNo"),
                getSnapshotValue(packageSnapshot, "mileagePackage.packageName")
              )
            },
            {
              label: "补能包名称",
              children: joinText(
                getSnapshotValue(packageSnapshot, "energyPackage.packageNo"),
                getSnapshotValue(packageSnapshot, "energyPackage.packageName")
              )
            },
            {
              label: "权益包名称",
              children: joinText(
                getSnapshotValue(packageSnapshot, "benefitPackage.packageNo"),
                getSnapshotValue(packageSnapshot, "benefitPackage.packageName")
              )
            },
            { label: "月里程额度", children: formatKilometers(getSnapshotValue(packageSnapshot, "mileagePackage.monthlyMileageKm") ?? order.mileageLimitKm) },
            { label: "超里程单价", children: formatYuan(getSnapshotValue(packageSnapshot, "mileagePackage.overMileageFeeAmount")) },
            { label: "月补能额度", children: formatKwh(getSnapshotValue(packageSnapshot, "energyPackage.monthlyEnergyKwh")) },
            { label: "月补能次数", children: formatCount(getSnapshotValue(packageSnapshot, "energyPackage.monthlyEnergyCount")) },
            { label: "权益说明", children: safeText(getSnapshotValue(packageSnapshot, "benefitPackage.description")) }
          ]}
        />
      </Card>

      <Card title="押金 / 风控快照">
        <Descriptions
          bordered
          column={2}
          items={[
            {
              label: "客户等级",
              children: safeText(
                getSnapshotValue(snapshot, "customer.grade") ??
                  getSnapshotValue(depositRuleSnapshot, "customerGrade", "grade")
              )
            },
            {
              label: "押金金额",
              children: formatYuan(getSnapshotValue(snapshot, "depositAmount", "depositRuleSnapshot.depositAmount") ?? order.depositAmount)
            },
            {
              label: "违约率",
              children: formatPercent(getSnapshotValue(depositRuleSnapshot, "defaultRate") ?? getSnapshotValue(snapshot, "defaultRate"))
            },
            {
              label: "风控评分",
              children: safeText(
                getSnapshotValue(riskSnapshot, "score", "riskScore") ??
                  getSnapshotValue(snapshot, "riskScore")
              )
            }
          ]}
        />
      </Card>

    </Space>
  );
}

function OrderInfoSections({
  currentVehicleSalePrice,
  order
}: {
  currentVehicleSalePrice: number | null;
  order: OrderDetail;
}) {
  const snapshot = toSnapshotRecord(order.quoteSnapshot);
  const vehicleSnapshot = getSnapshotValue(snapshot, "vehicleSnapshot", "vehicle");
  const vehicleBaseFeeMode = getSnapshotValue(
    snapshot,
    "vehicleBaseFeeMode",
    "packageSnapshot.pricing.vehicleBaseFeeMode",
    "packageSnapshot.vehicleBaseFeeMode",
    "packageSnapshot.subscriptionPlan.monthlyFeeMode"
  );
  const vehicleBaseFeeModeLabel = formatVehicleBaseFeeModeLabel(
    vehicleBaseFeeMode,
    getSnapshotValue(
      snapshot,
      "vehicleBaseFeeModeLabel",
      "packageSnapshot.pricing.vehicleBaseFeeModeLabel",
      "packageSnapshot.vehicleBaseFeeModeLabel",
      "packageSnapshot.subscriptionPlan.monthlyFeeModeLabel"
    )
  );
  const vehicleBaseFeeCapAmount = getSnapshotValue(
    snapshot,
    "vehicleBaseFeeCapAmount",
    "packageSnapshot.pricing.vehicleBaseFeeCapAmount",
    "monthlyFeeCapAmount"
  );
  const vehicleBaseFeeAmount = getSnapshotValue(
    snapshot,
    "vehicleBaseFeeAmount",
    "packageSnapshot.pricing.vehicleBaseFeeAmount"
  );

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <Card title="订单基础信息">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "订单编号", children: safeText(order.orderNo) },
            { label: "订单状态", children: <Tag>{labelOf(STATUS_LABELS, order.orderStatus)}</Tag> },
            { label: "订单来源", children: labelOf(ORDER_SOURCE_LABELS, order.orderSource) },
            { label: "订阅周期", children: formatMonths(order.periodMonths) },
            {
              label: "关联进件",
              children: order.application ? (
                <Link href={`/applications/${order.application.id}`}>{order.application.applicationNo}</Link>
              ) : "-"
            },
            {
              label: "关联报价",
              children: order.quote ? <Link href={`/quotes/${order.quote.id}`}>{order.quote.quoteNo}</Link> : "-"
            },
            { label: "创建时间", children: formatTime(order.createdAt) },
            { label: "最终方案确认时间", children: formatTime(order.finalPlanConfirmedAt) }
          ]}
        />
      </Card>

      <Card title="客户信息">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "客户姓名", children: safeText(order.customer.name) },
            { label: "手机号", children: safeText(order.customer.mobile) },
            { label: "客户确认时间", children: formatTime(order.customerConfirmedAt) },
            { label: "押金状态", children: order.depositStatus ? labelOf(STATUS_LABELS, order.depositStatus) : "-" },
            { label: "押金金额", children: formatYuan(order.finalDepositAmount ?? order.depositAmount) },
            { label: "客户资质审核", children: <ReviewStatusTag value={order.creditReviewStatus} /> }
          ]}
        />
      </Card>

      <Card title="车辆信息">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "车辆编号", children: safeText(order.vehicle?.vehicleNo ?? getSnapshotValue(vehicleSnapshot, "vehicleNo")) },
            { label: "VIN", children: safeText(order.vehicle?.vin ?? getSnapshotValue(vehicleSnapshot, "vin")) },
            { label: "车牌号", children: safeText(order.vehicle?.plateNo ?? getSnapshotValue(vehicleSnapshot, "plateNo")) },
            { label: "车型", children: safeText(order.vehicle?.vehicleModel ?? getSnapshotValue(vehicleSnapshot, "vehicleModel") ?? order.vehicleModel) },
            { label: "电池容量", children: formatKwh(order.vehicle?.batteryCapacityKwh ?? getSnapshotValue(vehicleSnapshot, "batteryCapacityKwh")) },
            {
              label: "电池使用方式",
              children: formatBatteryUsageType(
                order.vehicle?.batteryUsageType ?? getSnapshotValue(vehicleSnapshot, "batteryUsageType"),
                order.vehicle?.batteryUsageTypeLabel ?? getSnapshotValue(vehicleSnapshot, "batteryUsageTypeLabel")
              )
            },
            { label: "车辆状态", children: safeText(order.vehicle?.status ?? getSnapshotValue(vehicleSnapshot, "status")) },
            { label: "当前车辆销售价", children: formatYuan(currentVehicleSalePrice) },
            { label: "当前里程", children: formatKilometers(order.vehicle?.currentMileageKm ?? getSnapshotValue(vehicleSnapshot, "currentMileageKm")) },
            { label: "车辆库存审核", children: <ReviewStatusTag value={order.vehicleReviewStatus} /> }
          ]}
        />
      </Card>

      <Card title="合同信息">
        <Descriptions
          bordered
          column={2}
          items={[
            {
              label: "合同编号",
              children: order.contract ? <Link href={`/contracts/${order.contract.id}`}>{order.contract.contractNo}</Link> : "-"
            },
            { label: "合同状态", children: order.contract?.status ? labelOf(STATUS_LABELS, order.contract.status) : "-" },
            { label: "产品匹配审核", children: <ReviewStatusTag value={order.productReviewStatus} /> },
            { label: "车辆基础月费模式", children: vehicleBaseFeeModeLabel },
            { label: "车辆基础费上限", children: formatYuan(vehicleBaseFeeCapAmount) },
            { label: "车辆基础费", children: formatYuan(vehicleBaseFeeAmount) }
          ]}
        />
      </Card>
    </Space>
  );
}

function DeliveryPanel({
  confirmAvailability,
  delivery,
  deliveryCheck,
  onOpenConfirm,
  onOpenPrepare,
  prepareAvailability
}: {
  confirmAvailability: ReturnType<typeof actionAvailability>;
  delivery: VehicleDelivery | null;
  deliveryCheck: DeliveryCheck | null;
  onOpenConfirm: () => void;
  onOpenPrepare: () => void;
  prepareAvailability: ReturnType<typeof actionAvailability>;
}) {
  const blockingReasons = deliveryCheck?.blockingReasons ?? [];
  const deliveryStatus = deliveryCheck?.deliveryStatus ?? delivery?.deliveryStatus ?? null;
  const alreadyDelivered = Boolean(
    deliveryCheck?.alreadyDelivered || deliveryStatus === "DELIVERED" || delivery?.deliveredAt
  );
  const readyForDelivery = !alreadyDelivered && deliveryStatus === "READY";
  const checklistItems = [
    { label: "合同签署确认", value: delivery?.contractSignedConfirmed ?? deliveryCheck?.contractSigned },
    { label: "押金收取确认", value: delivery?.depositReceivedConfirmed },
    { label: "首期月费收取确认", value: delivery?.firstMonthlyFeeReceivedConfirmed },
    { label: "保险有效确认", value: delivery?.insuranceValidConfirmed },
    { label: "车辆整备完成确认", value: delivery?.vehiclePreparedConfirmed },
    { label: "车辆照片确认", value: delivery?.vehiclePhotosConfirmed },
    { label: "客户身份核验确认", value: delivery?.customerIdentityConfirmed },
    { label: "交付文件确认", value: delivery?.handoverDocumentsConfirmed }
  ];

  return (
    <Card
      extra={
        <Space wrap>
          <ActionButton availability={prepareAvailability} onClick={onOpenPrepare} type="primary">
            准备交付
          </ActionButton>
          <ActionButton availability={confirmAvailability} onClick={onOpenConfirm} type="primary">
            确认交付
          </ActionButton>
        </Space>
      }
      title="车辆交付"
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          description={
            alreadyDelivered ? (
              <Space orientation="vertical" size={4}>
                <Typography.Text>订单已进入在租状态</Typography.Text>
                <Typography.Text>
                  车辆状态：
                  {deliveryCheck?.vehicleStatus === "LEASED"
                    ? "已出租（LEASED）"
                    : deliveryCheck?.vehicleStatus
                      ? labelOf(STATUS_LABELS, deliveryCheck.vehicleStatus)
                      : "-"}
                </Typography.Text>
              </Space>
            ) : readyForDelivery ? (
              "交付准备已完成，待确认交付"
            ) : blockingReasons.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {blockingReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : undefined
          }
          message={
            alreadyDelivered
              ? "交付已完成"
              : readyForDelivery
                ? "交付准备已完成，待确认交付"
                : blockingReasons.length > 0
                  ? "暂不可交付"
                  : "交付条件已满足"
          }
          showIcon
          type={alreadyDelivered || readyForDelivery || blockingReasons.length === 0 ? "success" : "warning"}
        />

        {!alreadyDelivered ? (
          <Typography.Text type="secondary">
            签约锁定（RESERVED）：车辆已被订单锁定，处于合同 / 付款 / 交付前流程中，不能被其他订单选择；交付完成后车辆进入已出租（LEASED）状态。
          </Typography.Text>
        ) : null}

        {!alreadyDelivered ? (
          <Descriptions
            bordered
            column={2}
            title="交付条件检查"
            items={[
              { label: "合同签署状态", children: <BooleanTag checked={deliveryCheck?.contractSigned} /> },
              { label: "押金确认状态", children: <BooleanTag checked={deliveryCheck?.depositReceivedConfirmed} /> },
              { label: "首期月费确认状态", children: <BooleanTag checked={deliveryCheck?.firstMonthlyFeeReceivedConfirmed} /> },
              { label: "保险有效状态", children: <BooleanTag checked={deliveryCheck?.insuranceValid} /> },
              { label: "车辆整备状态", children: <BooleanTag checked={deliveryCheck?.vehiclePrepared} /> },
              {
                label: "车辆状态",
                children: deliveryCheck?.vehicleStatus ? labelOf(STATUS_LABELS, deliveryCheck.vehicleStatus) : "-"
              },
              {
                label: "车辆当前销售价初始化状态",
                children: <BooleanTag checked={deliveryCheck?.currentSalePriceInitialized} />
              },
              { label: "是否可准备交付", children: <BooleanTag checked={deliveryCheck?.canPrepareDelivery} /> },
              { label: "是否可确认交付", children: <BooleanTag checked={deliveryCheck?.canConfirmDelivery} /> }
            ]}
          />
        ) : null}

        <Descriptions
          bordered
          column={2}
          title="当前交付记录"
          items={[
            { label: "交付单号", children: safeText(delivery?.deliveryNo) },
            { label: "交付状态", children: <DeliveryStatusTag value={delivery?.deliveryStatus} /> },
            { label: "预约交付时间", children: formatTime(delivery?.scheduledAt) },
            { label: "交付地点", children: safeText(delivery?.deliveryLocation) },
            { label: "实际交付时间", children: formatTime(delivery?.deliveredAt) },
            { label: "交付里程", children: formatKilometers(delivery?.handoverMileageKm) },
            { label: "备注", children: safeText(delivery?.remark) }
          ]}
        />

        <Descriptions
          bordered
          column={4}
          title="交付检查项"
          items={checklistItems.map((item) => ({
            label: item.label,
            children: <BooleanTag checked={item.value} />
          }))}
        />
      </Space>
    </Card>
  );
}

function ReturnPanel({
  confirmAvailability,
  onOpenConfirm,
  onOpenPrepare,
  order,
  prepareAvailability,
  returnCheck,
  vehicleReturn
}: {
  confirmAvailability: ReturnType<typeof actionAvailability>;
  onOpenConfirm: () => void;
  onOpenPrepare: () => void;
  order: OrderDetail;
  prepareAvailability: ReturnType<typeof actionAvailability>;
  returnCheck: ReturnCheck | null;
  vehicleReturn: VehicleReturn | null;
}) {
  const returnStatus = returnCheck?.returnStatus ?? vehicleReturn?.returnStatus ?? null;
  const alreadyReturned = Boolean(
    returnCheck?.alreadyReturned || order.actualReturnAt || returnStatus === "CONFIRMED" || vehicleReturn?.returnedAt
  );
  const readyForReturn = !alreadyReturned && returnStatus === "READY";
  const blockingReasons = alreadyReturned ? [] : returnCheck?.blockingReasons ?? [];
  const vehicleStatus = returnCheck?.vehicleStatus ?? order.vehicle?.status ?? null;
  const checklistItems = [
    { label: "钥匙已归还", value: vehicleReturn?.keysReturnedConfirmed },
    { label: "充电设备已归还", value: vehicleReturn?.chargingEquipmentReturnedConfirmed },
    { label: "车辆文件已归还", value: vehicleReturn?.vehicleDocumentsReturnedConfirmed },
    { label: "客户物品已清空", value: vehicleReturn?.customerItemsClearedConfirmed },
    { label: "外观已检查", value: vehicleReturn?.exteriorCheckedConfirmed },
    { label: "内饰已检查", value: vehicleReturn?.interiorCheckedConfirmed },
    { label: "电池已检查", value: vehicleReturn?.batteryCheckedConfirmed },
    { label: "里程已确认", value: vehicleReturn?.mileageConfirmed },
    { label: "违章已检查", value: vehicleReturn?.violationCheckedConfirmed },
    { label: "是否需要清洁", value: vehicleReturn?.cleaningRequired },
    { label: "是否需要维修", value: vehicleReturn?.maintenanceRequired },
    { label: "是否发现损伤", value: vehicleReturn?.damageFound }
  ];
  const damageColumns: ColumnsType<VehicleReturnDamage> = [
    {
      dataIndex: "damageType",
      render: (value: string) => labelOf(VEHICLE_DAMAGE_TYPE_LABELS, value),
      title: "损伤类型"
    },
    {
      dataIndex: "damageLevel",
      render: (value: string) => labelOf(VEHICLE_DAMAGE_LEVEL_LABELS, value),
      title: "损伤等级"
    },
    { dataIndex: "description", render: safeText, title: "损伤描述" },
    {
      dataIndex: "responsibleParty",
      render: (value?: string | null) => labelOf(VEHICLE_DAMAGE_RESPONSIBLE_PARTY_LABELS, value ?? "UNKNOWN"),
      title: "责任方"
    },
    {
      dataIndex: "estimatedRepairAmount",
      render: formatYuan,
      title: "预估维修金额"
    },
    {
      dataIndex: "photoUrls",
      render: (value?: string[] | null) => {
        const urls = normalizePhotoUrls(value);
        return urls.length > 0 ? (
          <Space direction="vertical" size={2}>
            {urls.map((url, index) => (
              <Typography.Link href={url} key={`${url}-${index}`} rel="noreferrer" target="_blank">
                照片 {index + 1}
              </Typography.Link>
            ))}
          </Space>
        ) : "-";
      },
      title: "照片"
    },
    {
      dataIndex: "status",
      render: (value: string) => <DamageStatusTag value={value} />,
      title: "状态"
    }
  ];

  return (
    <Card
      extra={
        <Space wrap>
          <ActionButton availability={prepareAvailability} onClick={onOpenPrepare} type="primary">
            准备退车
          </ActionButton>
          <ActionButton availability={confirmAvailability} onClick={onOpenConfirm} type="primary">
            确认退车
          </ActionButton>
        </Space>
      }
      title="车辆退回 / 退车验收"
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          description={
            alreadyReturned ? (
              <Space orientation="vertical" size={4}>
                <Typography.Text>
                  {vehicleStatus === "MAINTENANCE" ? "车辆需维修" : vehicleStatus === "RETURNED" ? "车辆已退回" : "该订单已完成退车"}
                </Typography.Text>
                <Typography.Text>订单状态：{labelOf(STATUS_LABELS, order.orderStatus)}</Typography.Text>
                <Typography.Text>
                  车辆状态：{vehicleStatus ? labelOf(STATUS_LABELS, vehicleStatus) : "-"}
                </Typography.Text>
                {vehicleStatus === "MAINTENANCE" ? (
                  <Typography.Text type="secondary">
                    车辆需完成整备并通过 RETURN_REINIT 重新初始化销售价后，才能再次入池。
                  </Typography.Text>
                ) : null}
              </Space>
            ) : readyForReturn ? (
              "退车准备已完成，待确认退车"
            ) : blockingReasons.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {blockingReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : undefined
          }
          message={
            alreadyReturned
              ? "该订单已完成退车"
              : readyForReturn
                ? "退车准备已完成，待确认退车"
                : blockingReasons.length > 0
                  ? "暂不可退车"
                  : "退车条件已满足"
          }
          showIcon
          type={alreadyReturned || readyForReturn || blockingReasons.length === 0 ? "success" : "warning"}
        />

        <Descriptions
          bordered
          column={2}
          title="退车条件检查"
          items={[
            { label: "订单状态", children: labelOf(STATUS_LABELS, returnCheck?.orderStatus ?? order.orderStatus) },
            { label: "车辆状态", children: vehicleStatus ? labelOf(STATUS_LABELS, vehicleStatus) : "-" },
            { label: "是否已交付", children: <BooleanTag checked={Boolean(order.actualDeliveryAt)} /> },
            { label: "是否已退车", children: <BooleanTag checked={alreadyReturned} /> },
            { label: "是否可准备退车", children: <BooleanTag checked={returnCheck?.canPrepareReturn} /> },
            { label: "是否可确认退车", children: <BooleanTag checked={returnCheck?.canConfirmReturn} /> }
          ]}
        />

        <Descriptions
          bordered
          column={2}
          title="当前退车记录"
          items={[
            { label: "退车单号", children: safeText(vehicleReturn?.returnNo) },
            { label: "退车状态", children: <ReturnStatusTag value={vehicleReturn?.returnStatus} /> },
            {
              label: "退车类型",
              children: vehicleReturn?.returnType ? labelOf(VEHICLE_RETURN_TYPE_LABELS, vehicleReturn.returnType) : "-"
            },
            { label: "预约退车时间", children: formatTime(vehicleReturn?.scheduledAt) },
            { label: "退车地点", children: safeText(vehicleReturn?.returnLocation) },
            { label: "实际退车时间", children: formatTime(vehicleReturn?.returnedAt) },
            { label: "退车里程", children: formatKilometers(vehicleReturn?.returnMileageKm) },
            { label: "是否需清洁", children: <BooleanTag checked={vehicleReturn?.cleaningRequired} /> },
            { label: "是否需维修", children: <BooleanTag checked={vehicleReturn?.maintenanceRequired} /> },
            { label: "是否发现损伤", children: <BooleanTag checked={vehicleReturn?.damageFound} /> },
            { label: "备注", children: safeText(vehicleReturn?.remark) }
          ]}
        />

        <Descriptions
          bordered
          column={4}
          title="退车检查项"
          items={checklistItems.map((item) => ({
            label: item.label,
            children: <BooleanTag checked={item.value} />
          }))}
        />

        <Table
          columns={damageColumns}
          dataSource={vehicleReturn?.damages ?? []}
          locale={{ emptyText: "-" }}
          pagination={false}
          rowKey="id"
          size="small"
          title={() => "损伤记录"}
        />
      </Space>
    </Card>
  );
}

function getPrepareDeliveryDisabledReason(
  order: OrderDetail | null,
  deliveryCheck: DeliveryCheck | null,
  delivery: VehicleDelivery | null,
  orderChangeLocked: boolean
) {
  if (!order) {
    return "数据加载完成后才可操作";
  }
  if (orderChangeLocked) {
    return "当前订单存在进行中的变更申请";
  }
  if (deliveryCheck?.alreadyDelivered || isOrderDelivered(order) || delivery?.deliveryStatus === "DELIVERED") {
    return "订单已交付，不能重新准备交付";
  }
  if (!DELIVERY_PREPARE_ORDER_STATUSES.has(order.orderStatus)) {
    return "当前订单状态不允许准备交付";
  }
  if (!(deliveryCheck?.contractSigned ?? isContractSigned(order.contract?.status))) {
    return "请先完成合同签署";
  }
  if ((deliveryCheck?.vehicleStatus ?? order.vehicle?.status) !== "RESERVED") {
    return "交付前车辆必须处于“签约锁定（RESERVED）”状态。";
  }
  if (deliveryCheck && !deliveryCheck.canPrepareDelivery) {
    return deliveryCheck.blockingReasons[0] ?? "当前订单不满足准备交付条件";
  }
  if (!deliveryCheck) {
    return "交付条件检查加载完成后才可操作";
  }
  return null;
}

function getConfirmDeliveryDisabledReason(
  order: OrderDetail | null,
  deliveryCheck: DeliveryCheck | null,
  delivery: VehicleDelivery | null,
  orderChangeLocked: boolean
) {
  if (!order) {
    return "数据加载完成后才可操作";
  }
  if (orderChangeLocked) {
    return "当前订单存在进行中的变更申请";
  }
  if (deliveryCheck?.alreadyDelivered || isOrderDelivered(order) || delivery?.deliveryStatus === "DELIVERED") {
    return "订单已交付，不能重复确认交付";
  }
  if (delivery?.deliveryStatus !== "READY") {
    return "请先完成准备交付";
  }
  if ((deliveryCheck?.vehicleStatus ?? order.vehicle?.status) !== "RESERVED") {
    return "交付前车辆必须处于“签约锁定（RESERVED）”状态。";
  }
  if (!deliveryCheck) {
    return "交付条件检查加载完成后才可操作";
  }
  if (!deliveryCheck.canConfirmDelivery) {
    return "交付条件未全部满足";
  }
  return null;
}

function getPrepareReturnDisabledReason(
  order: OrderDetail | null,
  returnCheck: ReturnCheck | null,
  vehicleReturn: VehicleReturn | null,
  orderChangeLocked: boolean
) {
  if (!order) {
    return "数据加载完成后才可操作";
  }
  if (orderChangeLocked) {
    return "当前订单存在进行中的变更申请";
  }
  if (returnCheck?.alreadyReturned || isOrderReturned(order) || vehicleReturn?.returnStatus === "CONFIRMED") {
    return "该订单已完成退车";
  }
  if (order.orderStatus !== "ACTIVE" || !order.actualDeliveryAt) {
    return "订单尚未起租，不能退车";
  }
  if ((returnCheck?.vehicleStatus ?? order.vehicle?.status) !== "LEASED") {
    return "车辆状态不是已出租，不能退车";
  }
  if (returnCheck && !returnCheck.canPrepareReturn) {
    return returnCheck.blockingReasons[0] ?? "当前订单不满足准备退车条件";
  }
  if (!returnCheck) {
    return "退车条件检查加载完成后才可操作";
  }
  return null;
}

function getConfirmReturnDisabledReason(
  order: OrderDetail | null,
  returnCheck: ReturnCheck | null,
  vehicleReturn: VehicleReturn | null,
  orderChangeLocked: boolean
) {
  if (!order) {
    return "数据加载完成后才可操作";
  }
  if (orderChangeLocked) {
    return "当前订单存在进行中的变更申请";
  }
  if (returnCheck?.alreadyReturned || isOrderReturned(order) || vehicleReturn?.returnStatus === "CONFIRMED") {
    return "该订单已完成退车";
  }
  if (vehicleReturn?.returnStatus !== "READY") {
    return "请先准备退车";
  }
  if (order.orderStatus !== "ACTIVE" || !order.actualDeliveryAt) {
    return "当前订单尚未起租";
  }
  if ((returnCheck?.vehicleStatus ?? order.vehicle?.status) !== "LEASED") {
    return "当前车辆不是已出租状态";
  }
  if (!returnCheck) {
    return "退车条件检查加载完成后才可操作";
  }
  if (!returnCheck.canConfirmReturn) {
    return returnCheck.blockingReasons[0] ?? "退车条件未全部满足";
  }
  return null;
}

function isOrderDelivered(order: OrderDetail) {
  return Boolean(order.actualDeliveryAt || order.orderStatus === "ACTIVE");
}

function isOrderReturned(order: OrderDetail) {
  return Boolean(order.actualReturnAt || order.orderStatus === "COMPLETED" || order.orderStatus === "TERMINATED");
}

function isContractSigned(status?: string | null) {
  return status === "SIGNED" || status === "ARCHIVED";
}

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const [changeForm] = Form.useForm<ChangeFormValues>();
  const [confirmDeliveryForm] = Form.useForm<ConfirmDeliveryFormValues>();
  const [confirmReturnForm] = Form.useForm<ConfirmReturnFormValues>();
  const [creditForm] = Form.useForm<{ customerGrade: string }>();
  const [prepareDeliveryForm] = Form.useForm<PrepareDeliveryFormValues>();
  const [prepareReturnForm] = Form.useForm<PrepareReturnFormValues>();
  const [changeModalOpen, setChangeModalOpen] = useState(false);
  const [changes, setChanges] = useState<OrderChangeRow[]>([]);
  const [confirmDeliveryModalOpen, setConfirmDeliveryModalOpen] = useState(false);
  const [confirmReturnModalOpen, setConfirmReturnModalOpen] = useState(false);
  const [delivery, setDelivery] = useState<VehicleDelivery | null>(null);
  const [deliveryCheck, setDeliveryCheck] = useState<DeliveryCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [prepareDeliveryModalOpen, setPrepareDeliveryModalOpen] = useState(false);
  const [prepareReturnModalOpen, setPrepareReturnModalOpen] = useState(false);
  const [returnCheck, setReturnCheck] = useState<ReturnCheck | null>(null);
  const [vehicleReturn, setVehicleReturn] = useState<VehicleReturn | null>(null);
  const [autoOpenChangeModalDone, setAutoOpenChangeModalDone] = useState(false);
  const permissions = useMemo(() => new Set(me?.user.permissions ?? []), [me]);
  const roles = useMemo(() => new Set(me?.user.roles ?? []), [me]);
  const hasDeliveryViewPermission = permissions.has("delivery:view");
  const hasReturnViewPermission = permissions.has("vehicle_return:view");
  const canRecordReturnDamage = permissions.has("vehicle_return:damage_record");
  const canCreateChange = permissions.has("order_change:create");
  const canRejectChange = permissions.has("order_change:reject") || permissions.has("order_change:approve");
  const isAdminOrOperator = roles.has("ADMIN") || roles.has("OP") || roles.has("GM");
  const hasOrderReviewPermission = permissions.has("order:review");
  const canReviewCredit = hasOrderReviewPermission && (isAdminOrOperator || roles.has("RC"));
  const canReviewProduct = hasOrderReviewPermission && isAdminOrOperator;
  const canReviewVehicle = hasOrderReviewPermission && (isAdminOrOperator || roles.has("AS"));
  const canConfirmFinalPlan = permissions.has("order:confirm_final_plan");
  const canRejectCustomerOrder = permissions.has("order:reject") || isAdminOrOperator;
  const currentVehicleSalePrice = toNumber(
    order?.vehicle?.currentSalePriceAmount ??
      getSnapshotValue(order?.quoteSnapshot, "vehicleSnapshot.currentSalePriceAmount", "vehicleSalePriceAmount")
  );
  const isCustomerSelfServiceOrder = order?.orderSource === "CUSTOMER_SELF_SERVICE";
  const returnToPlanHint = isCustomerSelfServiceOrder
    ? "客户需重新提交订单申请。"
    : "返回进件详情重新生成订阅报价和订阅订单。";
  const activeOrderChange = changes.find(
    (change) =>
      !change.executedAt &&
      (change.status === "PENDING" || change.status === "APPROVED")
  );
  const orderChangeLocked = Boolean(activeOrderChange);
  const canCancelActiveChange = Boolean(
    activeOrderChange &&
      activeOrderChange.status === "PENDING" &&
      (roles.has("ADMIN") || activeOrderChange.createdBy === me?.user.id)
  );
  const generateContractAvailability = orderChangeLocked
    ? { allowed: false, reason: "当前订单存在进行中的变更申请，请先处理后再生成合同" }
    : getGenerateContractAvailability(order, permissions);
  const applyChangeAvailability = actionAvailability({
    allowed: Boolean(order && !orderChangeLocked && PRE_CONTRACT_CHANGE_ORDER_STATUSES.has(order.orderStatus)),
    disabledReason: orderChangeLocked ? "该订单已有进行中的变更申请" : "当前订单状态不允许发起变更",
    noPermissionReason: "无创建订单变更权限",
    permission: "order_change:create",
    permissions
  });
  const cancelOrderAvailability = actionAvailability({
    allowed: Boolean(
      order &&
        ["PENDING_CONTRACT", "PENDING_SIGN", "PENDING_PAYMENT"].includes(order.orderStatus) &&
        !orderChangeLocked
    ),
    disabledReason: orderChangeLocked ? "该订单已有进行中的变更申请" : "当前订单状态不允许取消",
    noPermissionReason: "无取消订单权限",
    permission: "order:cancel",
    permissions
  });
  const prepareDeliveryDisabledReason = getPrepareDeliveryDisabledReason(order, deliveryCheck, delivery, orderChangeLocked);
  const prepareDeliveryAvailability = actionAvailability({
    allowed: prepareDeliveryDisabledReason === null,
    disabledReason: prepareDeliveryDisabledReason ?? "当前订单状态不允许准备交付",
    noPermissionReason: "无准备交付权限",
    permission: "delivery:prepare",
    permissions
  });
  const confirmDeliveryDisabledReason = getConfirmDeliveryDisabledReason(order, deliveryCheck, delivery, orderChangeLocked);
  const confirmDeliveryAvailability = actionAvailability({
    allowed: confirmDeliveryDisabledReason === null,
    disabledReason: confirmDeliveryDisabledReason ?? "当前订单状态不允许交付",
    noPermissionReason: "无确认交付权限",
    permission: "delivery:confirm",
    permissions
  });
  const prepareReturnDisabledReason = getPrepareReturnDisabledReason(order, returnCheck, vehicleReturn, orderChangeLocked);
  const prepareReturnAvailability = actionAvailability({
    allowed: prepareReturnDisabledReason === null,
    disabledReason: prepareReturnDisabledReason ?? "当前订单状态不允许准备退车",
    noPermissionReason: "无准备退车权限",
    permission: "vehicle_return:prepare",
    permissions
  });
  const confirmReturnDisabledReason = getConfirmReturnDisabledReason(order, returnCheck, vehicleReturn, orderChangeLocked);
  const confirmReturnAvailability = actionAvailability({
    allowed: confirmReturnDisabledReason === null,
    disabledReason: confirmReturnDisabledReason ?? "当前订单状态不允许确认退车",
    noPermissionReason: "无确认退车权限",
    permission: "vehicle_return:confirm",
    permissions
  });

  const loadOrder = useCallback(async () => {
    setLoading(true);
    try {
      const nextMe = await apiFetch<AuthMeResponse>("/auth/me");
      const canViewDelivery = nextMe.user.permissions.includes("delivery:view");
      const canViewReturn = nextMe.user.permissions.includes("vehicle_return:view");
      const [nextOrder, nextChanges, nextDeliveryCheck, nextDelivery, nextReturnCheck, nextReturn] = await Promise.all([
        apiFetch<OrderDetail>(`/orders/${params.id}`),
        apiFetch<OrderChangeRow[]>(`/orders/${params.id}/changes`).catch(() => []),
        canViewDelivery ? apiFetch<DeliveryCheck>(`/orders/${params.id}/delivery-check`) : Promise.resolve(null),
        canViewDelivery ? apiFetch<VehicleDelivery | null>(`/orders/${params.id}/delivery`) : Promise.resolve(null),
        canViewReturn ? apiFetch<ReturnCheck>(`/orders/${params.id}/return-check`) : Promise.resolve(null),
        canViewReturn ? apiFetch<VehicleReturn | null>(`/orders/${params.id}/return`) : Promise.resolve(null)
      ]);
      setOrder(nextOrder);
      setChanges(nextChanges);
      setMe(nextMe);
      setDeliveryCheck(nextDeliveryCheck);
      setDelivery(nextDelivery);
      setReturnCheck(nextReturnCheck);
      setVehicleReturn(nextReturn);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [message, params.id]);

  useEffect(() => {
    void loadOrder();
  }, [loadOrder]);

  const openChangeModal = useCallback(async () => {
    if (!order || !canCreateChange) {
      return;
    }
    if (orderChangeLocked) {
      void message.error("该订单已有进行中的变更申请，请先处理后再发起新的变更。");
      return;
    }
    changeForm.resetFields();
    setChangeModalOpen(true);
  }, [canCreateChange, changeForm, message, order, orderChangeLocked]);

  useEffect(() => {
    if (
      searchParams.get("createChange") === "1" &&
      order &&
      canCreateChange &&
      !changeModalOpen &&
      !autoOpenChangeModalDone
    ) {
      setAutoOpenChangeModalDone(true);
      void openChangeModal();
    }
  }, [autoOpenChangeModalDone, canCreateChange, changeModalOpen, openChangeModal, order, searchParams]);

  function closeChangeModal() {
    setChangeModalOpen(false);
    changeForm.resetFields();
  }

  function openPrepareDeliveryModal() {
    prepareDeliveryForm.setFieldsValue({
      customerIdentityConfirmed: delivery?.customerIdentityConfirmed ?? false,
      deliveryLocation: delivery?.deliveryLocation ?? undefined,
      depositReceivedConfirmed: delivery?.depositReceivedConfirmed ?? false,
      firstMonthlyFeeReceivedConfirmed: delivery?.firstMonthlyFeeReceivedConfirmed ?? false,
      handoverDocumentsConfirmed: delivery?.handoverDocumentsConfirmed ?? false,
      insuranceValidConfirmed: delivery?.insuranceValidConfirmed ?? false,
      remark: delivery?.remark ?? undefined,
      scheduledAt: delivery?.scheduledAt ? dayjs(delivery.scheduledAt) : undefined,
      vehiclePhotosConfirmed: delivery?.vehiclePhotosConfirmed ?? false,
      vehiclePreparedConfirmed: delivery?.vehiclePreparedConfirmed ?? false
    });
    setPrepareDeliveryModalOpen(true);
  }

  function closePrepareDeliveryModal() {
    setPrepareDeliveryModalOpen(false);
    prepareDeliveryForm.resetFields();
  }

  function openConfirmDeliveryModal() {
    confirmDeliveryForm.setFieldsValue({
      deliveredAt: dayjs(),
      handoverMileageKm: order?.vehicle?.currentMileageKm ?? undefined,
      remark: delivery?.remark ?? undefined
    });
    setConfirmDeliveryModalOpen(true);
  }

  function closeConfirmDeliveryModal() {
    setConfirmDeliveryModalOpen(false);
    confirmDeliveryForm.resetFields();
  }

  function openPrepareReturnModal() {
    prepareReturnForm.setFieldsValue({
      remark: vehicleReturn?.remark ?? undefined,
      returnLocation: vehicleReturn?.returnLocation ?? undefined,
      returnType: vehicleReturn?.returnType ?? "NORMAL_RETURN",
      scheduledAt: vehicleReturn?.scheduledAt ? dayjs(vehicleReturn.scheduledAt) : undefined
    });
    setPrepareReturnModalOpen(true);
  }

  function closePrepareReturnModal() {
    setPrepareReturnModalOpen(false);
    prepareReturnForm.resetFields();
  }

  function openConfirmReturnModal() {
    confirmReturnForm.setFieldsValue({
      batteryCheckedConfirmed: vehicleReturn?.batteryCheckedConfirmed ?? false,
      chargingEquipmentReturnedConfirmed: vehicleReturn?.chargingEquipmentReturnedConfirmed ?? false,
      cleaningRequired: vehicleReturn?.cleaningRequired ?? false,
      customerItemsClearedConfirmed: vehicleReturn?.customerItemsClearedConfirmed ?? false,
      damageFound: vehicleReturn?.damageFound ?? false,
      damages: (vehicleReturn?.damages ?? []).map((damage) => ({
        damageLevel: damage.damageLevel,
        damageType: damage.damageType,
        description: damage.description ?? undefined,
        estimatedRepairAmount: centsToYuan(damage.estimatedRepairAmount),
        photoUrlsText: photoUrlsToText(damage.photoUrls),
        responsibleParty: damage.responsibleParty ?? "UNKNOWN"
      })),
      exteriorCheckedConfirmed: vehicleReturn?.exteriorCheckedConfirmed ?? false,
      interiorCheckedConfirmed: vehicleReturn?.interiorCheckedConfirmed ?? false,
      keysReturnedConfirmed: vehicleReturn?.keysReturnedConfirmed ?? false,
      maintenanceRequired: vehicleReturn?.maintenanceRequired ?? false,
      mileageConfirmed: vehicleReturn?.mileageConfirmed ?? false,
      remark: vehicleReturn?.remark ?? undefined,
      returnMileageKm: order?.vehicle?.currentMileageKm ?? undefined,
      returnType: vehicleReturn?.returnType ?? "NORMAL_RETURN",
      returnedAt: dayjs(),
      vehicleDocumentsReturnedConfirmed: vehicleReturn?.vehicleDocumentsReturnedConfirmed ?? false,
      violationCheckedConfirmed: vehicleReturn?.violationCheckedConfirmed ?? false
    });
    setConfirmReturnModalOpen(true);
  }

  function closeConfirmReturnModal() {
    setConfirmReturnModalOpen(false);
    confirmReturnForm.resetFields();
  }

  async function generateContract() {
    if (!order) {
      return;
    }
    try {
      await apiFetch(`/orders/${order.id}/generate-contract`, { method: "POST" });
      void message.success("合同已生成");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function cancelOrder() {
    if (!order) {
      return;
    }
    try {
      await apiFetch(`/orders/${order.id}/cancel`, {
        body: JSON.stringify({ reason: "运营取消订单" }),
        method: "POST"
      });
      void message.success("订单已取消");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function prepareDelivery() {
    if (!order) {
      return;
    }
    const values = await prepareDeliveryForm.validateFields();
    try {
      await apiFetch(`/orders/${order.id}/prepare-delivery`, {
        body: JSON.stringify({
          customerIdentityConfirmed: Boolean(values.customerIdentityConfirmed),
          deliveryLocation: values.deliveryLocation,
          depositReceivedConfirmed: Boolean(values.depositReceivedConfirmed),
          firstMonthlyFeeReceivedConfirmed: Boolean(values.firstMonthlyFeeReceivedConfirmed),
          handoverDocumentsConfirmed: Boolean(values.handoverDocumentsConfirmed),
          insuranceValidConfirmed: Boolean(values.insuranceValidConfirmed),
          remark: values.remark,
          scheduledAt: values.scheduledAt?.toISOString(),
          vehiclePhotosConfirmed: Boolean(values.vehiclePhotosConfirmed),
          vehiclePreparedConfirmed: Boolean(values.vehiclePreparedConfirmed)
        }),
        method: "POST"
      });
      void message.success("交付准备信息已保存");
      closePrepareDeliveryModal();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function confirmDelivery() {
    if (!order) {
      return;
    }
    const values = await confirmDeliveryForm.validateFields();
    try {
      await apiFetch(`/orders/${order.id}/confirm-delivery`, {
        body: JSON.stringify({
          deliveredAt: values.deliveredAt?.toISOString(),
          handoverMileageKm: values.handoverMileageKm,
          remark: values.remark
        }),
        method: "POST"
      });
      void message.success("车辆已确认交付");
      closeConfirmDeliveryModal();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function prepareReturn() {
    if (!order) {
      return;
    }
    const values = await prepareReturnForm.validateFields();
    try {
      await apiFetch(`/orders/${order.id}/prepare-return`, {
        body: JSON.stringify({
          remark: values.remark,
          returnLocation: values.returnLocation,
          returnType: values.returnType ?? "NORMAL_RETURN",
          scheduledAt: values.scheduledAt?.toISOString()
        }),
        method: "POST"
      });
      void message.success("退车准备信息已保存");
      closePrepareReturnModal();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function confirmReturn() {
    if (!order) {
      return;
    }
    const values = await confirmReturnForm.validateFields();
    const damageRows = canRecordReturnDamage ? values.damages ?? [] : [];
    const damages = damageRows
      .filter(
        (damage) =>
          Boolean(damage.damageType) ||
          Boolean(damage.damageLevel) ||
          Boolean(damage.description) ||
          damage.estimatedRepairAmount !== undefined
      )
      .map((damage) => ({
        damageLevel: damage.damageLevel,
        damageType: damage.damageType,
        description: damage.description,
        estimatedRepairAmount: yuanToCents(damage.estimatedRepairAmount),
        photoUrls: parsePhotoUrls(damage.photoUrlsText),
        responsibleParty: damage.responsibleParty ?? "UNKNOWN"
      }));

    try {
      await apiFetch(`/orders/${order.id}/confirm-return`, {
        body: JSON.stringify({
          batteryCheckedConfirmed: Boolean(values.batteryCheckedConfirmed),
          chargingEquipmentReturnedConfirmed: Boolean(values.chargingEquipmentReturnedConfirmed),
          cleaningRequired: Boolean(values.cleaningRequired),
          customerItemsClearedConfirmed: Boolean(values.customerItemsClearedConfirmed),
          damageFound: Boolean(values.damageFound) || damages.length > 0,
          damages,
          exteriorCheckedConfirmed: Boolean(values.exteriorCheckedConfirmed),
          interiorCheckedConfirmed: Boolean(values.interiorCheckedConfirmed),
          keysReturnedConfirmed: Boolean(values.keysReturnedConfirmed),
          maintenanceRequired: Boolean(values.maintenanceRequired),
          mileageConfirmed: Boolean(values.mileageConfirmed),
          remark: values.remark,
          returnMileageKm: values.returnMileageKm,
          returnType: values.returnType ?? vehicleReturn?.returnType ?? "NORMAL_RETURN",
          returnedAt: values.returnedAt?.toISOString(),
          vehicleDocumentsReturnedConfirmed: Boolean(values.vehicleDocumentsReturnedConfirmed),
          violationCheckedConfirmed: Boolean(values.violationCheckedConfirmed)
        }),
        method: "POST"
      });
      void message.success("退车验收已确认");
      closeConfirmReturnModal();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function reviewOrder(
    type: "credit" | "product" | "vehicle",
    status: "APPROVED" | "NEED_MORE_INFO" | "REJECTED"
  ) {
    if (!order) {
      return;
    }
    const body: Record<string, unknown> = { status };
    if (type === "credit" && status === "APPROVED") {
      const values = await creditForm.validateFields();
      body.customerGrade = values.customerGrade;
    }
    try {
      await apiFetch(`/orders/${order.id}/reviews/${type}`, {
        body: JSON.stringify(body),
        method: "POST"
      });
      void message.success("审核状态已更新");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function finalizePlan() {
    if (!order) {
      return;
    }
    try {
      await apiFetch(`/orders/${order.id}/finalize-plan`, { method: "POST" });
      void message.success("最终方案已确认");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function confirmCustomerOrder() {
    if (!order) {
      return;
    }
    try {
      await apiFetch(`/orders/${order.id}/customer-confirm`, { method: "POST" });
      void message.success("订单已进入合同签约");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function rejectCustomerOrder() {
    if (!order) {
      return;
    }
    try {
      await apiFetch(`/orders/${order.id}/reject`, {
        body: JSON.stringify({ remark: "后台审核拒绝", status: "REJECTED" }),
        method: "POST"
      });
      void message.success("订单已拒绝");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function createChange() {
    if (!order) {
      return;
    }
    const values = await changeForm.validateFields();
    try {
      await apiFetch(`/orders/${order.id}/changes`, {
        body: JSON.stringify({
          changeType: "PLAN_CHANGE",
          reason: values.reason
        }),
        method: "POST"
      });
      void message.success("退回重做方案申请已创建");
      closeChangeModal();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function reviewChange(changeId: string, action: "approve" | "reject") {
    try {
      await apiFetch(`/order-changes/${changeId}/${action}`, { method: "POST" });
      void message.success(action === "approve" ? "订单变更已通过" : "订单变更已拒绝");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function cancelChange(changeId: string) {
    try {
      await apiFetch(`/order-changes/${changeId}/cancel`, { method: "POST" });
      void message.success("订单变更申请已取消");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function returnChangeToPlan(changeId: string) {
    try {
      await apiFetch(`/order-changes/${changeId}/return-to-plan`, { method: "POST" });
      void message.success("当前订单已取消，已退回方案生成环节");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  const changeColumns: ColumnsType<OrderChangeRow> = [
    { dataIndex: "changeType", render: (value: string) => labelOf(ORDER_CHANGE_TYPE_LABELS, value), title: "变更类型" },
    { dataIndex: "reason", title: "变更原因" },
    { dataIndex: "status", render: (value: string) => <Tag>{labelOf(STATUS_LABELS, value)}</Tag>, title: "状态" },
    { dataIndex: "creator", render: (value?: OrderChangeRow["creator"]) => value?.name ?? "-", title: "创建人" },
    { dataIndex: "createdAt", render: formatTime, title: "创建时间" },
    {
      dataIndex: "executedAt",
      render: (value?: string | null) => value ? <Tag color="green">已退回 / {formatTime(value)}</Tag> : <Tag>未退回</Tag>,
      title: "退回状态"
    },
    {
      render: (_, record) => {
        const cancelChangeAvailability = actionAvailability({
          allowed: Boolean(record.status === "PENDING" && !record.executedAt && (roles.has("ADMIN") || record.createdBy === me?.user.id)),
          disabledReason: record.executedAt ? "该变更已执行" : "当前变更状态不允许取消",
          permissions
        });
        const approveChangeAvailability = actionAvailability({
          allowed: record.status === "PENDING",
          disabledReason: "当前变更状态不允许审批",
          noPermissionReason: "无审批订单变更权限",
          permission: "order_change:approve",
          permissions
        });
        const rejectChangeAvailability = canRejectChange
          ? actionAvailability({
              allowed: record.status === "PENDING",
              disabledReason: "当前变更状态不允许拒绝",
              permissions
            })
          : { allowed: false, reason: "无拒绝订单变更权限" };

        return (
          <Space>
            <ActionButton
              availability={cancelChangeAvailability}
              onClick={() => cancelChange(record.id)}
              size="small"
            >
              取消变更申请
            </ActionButton>
            <ActionButton
              availability={approveChangeAvailability}
              onClick={() => reviewChange(record.id, "approve")}
              size="small"
              type="primary"
            >
              同意变更
            </ActionButton>
            <ActionButton
              availability={rejectChangeAvailability}
              danger
              onClick={() => reviewChange(record.id, "reject")}
              size="small"
            >
              拒绝
            </ActionButton>
            <ActionButton
              availability={canExecuteOrderChange(record, order, permissions)}
              onClick={() => returnChangeToPlan(record.id)}
              size="small"
              type="primary"
            >
              取消当前订单并退回方案生成环节
            </ActionButton>
          </Space>
        );
      },
      title: "操作"
    }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={20} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Space>
            <Button aria-label="返回订单列表" icon={<ArrowLeftOutlined />} onClick={() => router.push("/orders")} />
            <Typography.Title level={4} style={{ margin: 0 }}>
              {order?.orderNo ?? "订阅订单详情"}
            </Typography.Title>
            {order ? <Tag color="blue">{labelOf(STATUS_LABELS, order.orderStatus)}</Tag> : null}
          </Space>
          {order ? (
            <Space>
              <ActionButton
                availability={generateContractAvailability}
                onClick={generateContract}
                type="primary"
              >
                生成合同
              </ActionButton>
              {order.contract ? (
                <Button onClick={() => router.push(`/contracts/${order.contract?.id}`)}>查看合同</Button>
              ) : null}
              <ActionButton
                availability={applyChangeAvailability}
                onClick={openChangeModal}
              >
                申请变更方案
              </ActionButton>
              <ActionButton
                availability={cancelOrderAvailability}
                danger
                onClick={cancelOrder}
              >
                取消订单
              </ActionButton>
              {order.orderStatus === "CANCELLED" && order.application && !isCustomerSelfServiceOrder ? (
                <Button onClick={() => router.push(`/applications/${order.application?.id}`)}>
                  返回进件重新生成方案
                </Button>
              ) : null}
            </Space>
          ) : null}
        </Space>

        {activeOrderChange ? (
          <Card>
            <Space orientation="vertical" size={8}>
              <Typography.Text strong>当前订单存在进行中的变更申请，暂不能继续后续操作。</Typography.Text>
              <Typography.Text>
                状态：{labelOf(STATUS_LABELS, activeOrderChange.status)} / 创建时间：{formatTime(activeOrderChange.createdAt)}
              </Typography.Text>
              <Space wrap>
                <ActionButton
                  allowed={canCancelActiveChange}
                  disabledReason="当前变更不允许取消"
                  onClick={() => cancelChange(activeOrderChange.id)}
                >
                  取消变更申请
                </ActionButton>
                <ActionButton
                  allowed={activeOrderChange.status === "PENDING"}
                  disabledReason="当前变更状态不允许审批"
                  noPermissionReason="无审批订单变更权限"
                  onClick={() => reviewChange(activeOrderChange.id, "approve")}
                  permission="order_change:approve"
                  permissions={permissions}
                  type="primary"
                >
                  同意变更
                </ActionButton>
                <ActionButton
                  availability={
                    canRejectChange
                      ? actionAvailability({
                          allowed: activeOrderChange.status === "PENDING",
                          disabledReason: "当前变更状态不允许拒绝",
                          permissions
                        })
                      : { allowed: false, reason: "无拒绝订单变更权限" }
                  }
                  danger
                  onClick={() => reviewChange(activeOrderChange.id, "reject")}
                >
                  拒绝变更
                </ActionButton>
                <ActionButton
                  availability={canExecuteOrderChange(activeOrderChange, order, permissions)}
                  onClick={() => returnChangeToPlan(activeOrderChange.id)}
                  type="primary"
                >
                  取消当前订单并退回方案生成环节
                </ActionButton>
              </Space>
            </Space>
          </Card>
        ) : null}

        {order?.orderStatus === "CANCELLED" ? (
          <Card>
            <Space orientation="vertical" size={8}>
              <Typography.Text strong>方案变更已退回</Typography.Text>
              <Typography.Text>{returnToPlanHint}</Typography.Text>
              {!isCustomerSelfServiceOrder && order.application ? (
                <Link href={`/applications/${order.application.id}`}>返回进件重新生成方案</Link>
              ) : null}
            </Space>
          </Card>
        ) : null}

        {loading ? <Spin /> : order ? <OrderInfoSections currentVehicleSalePrice={currentVehicleSalePrice} order={order} /> : null}

        {order && hasDeliveryViewPermission ? (
          <DeliveryPanel
            confirmAvailability={confirmDeliveryAvailability}
            delivery={delivery}
            deliveryCheck={deliveryCheck}
            onOpenConfirm={openConfirmDeliveryModal}
            onOpenPrepare={openPrepareDeliveryModal}
            prepareAvailability={prepareDeliveryAvailability}
          />
        ) : null}

        {order && hasReturnViewPermission ? (
          <ReturnPanel
            confirmAvailability={confirmReturnAvailability}
            onOpenConfirm={openConfirmReturnModal}
            onOpenPrepare={openPrepareReturnModal}
            order={order}
            prepareAvailability={prepareReturnAvailability}
            returnCheck={returnCheck}
            vehicleReturn={vehicleReturn}
          />
        ) : null}

        {/*
          <Descriptions
            bordered
            column={3}
            items={
              order
              ? [
                  { label: "订单编号", children: order.orderNo },
                  { label: "客户信息", children: `${order.customer.name} / ${order.customer.mobile}` },
                  {
                    label: "关联进件",
                    children: order.application ? (
                      <Link href={`/applications/${order.application.id}`}>{order.application.applicationNo}</Link>
                    ) : "-"
                  },
                  {
                    label: "关联报价",
                    children: order.quote ? <Link href={`/quotes/${order.quote.id}`}>{order.quote.quoteNo}</Link> : "-"
                  },
                  { label: "车型", children: order.vehicleModel },
                  { label: "车辆采购价", children: formatYuan(order.vehiclePurchasePriceAmount) },
                  { label: "月费", children: formatYuan(order.monthlyFeeAmount) },
                  { label: "押金", children: formatYuan(order.depositAmount) },
                  { label: "订阅周期", children: `${order.periodMonths} 个月` },
                  { label: "月里程额度", children: `${order.mileageLimitKm} km` },
                  { label: "订单状态", children: <Tag>{labelOf(STATUS_LABELS, order.orderStatus)}</Tag> },
                  {
                    label: "合同信息",
                    children: order.contract ? (
                      <Link href={`/contracts/${order.contract.id}`}>{order.contract.contractNo}</Link>
                    ) : "-"
                  },
                  { label: "创建时间", children: formatTime(order.createdAt) }
                ]
              : []
            }
          />
        */}

        {order ? (
          <ReviewPanel
            canConfirmFinalPlan={canConfirmFinalPlan}
            canRejectOrder={canRejectCustomerOrder}
            canReviewCredit={canReviewCredit}
            canReviewProduct={canReviewProduct}
            canReviewVehicle={canReviewVehicle}
            creditForm={creditForm}
            onConfirmCustomer={confirmCustomerOrder}
            onFinalizePlan={finalizePlan}
            onRejectOrder={rejectCustomerOrder}
            onReview={reviewOrder}
            order={order}
          />
        ) : null}

        <Typography.Title level={5} style={{ margin: 0 }}>
          报价快照
        </Typography.Title>
        <QuoteSnapshotSection order={order} />

        <Typography.Title level={5} style={{ margin: 0 }}>
          订单变更记录
        </Typography.Title>
        <Card title="订单变更记录">
          <Table columns={changeColumns} dataSource={changes} pagination={false} rowKey="id" />
        </Card>

        <Modal
          destroyOnHidden
          onCancel={closePrepareDeliveryModal}
          onOk={prepareDelivery}
          open={prepareDeliveryModalOpen}
          title="准备交付"
        >
          <Form form={prepareDeliveryForm} layout="vertical">
            <Form.Item label="预约交付时间" name="scheduledAt">
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="交付地点" name="deliveryLocation">
              <Input placeholder="静安旺旺大厦" />
            </Form.Item>
            <Form.Item name="depositReceivedConfirmed" valuePropName="checked">
              <Checkbox>押金收取确认</Checkbox>
            </Form.Item>
            <Form.Item name="firstMonthlyFeeReceivedConfirmed" valuePropName="checked">
              <Checkbox>首期月费收取确认</Checkbox>
            </Form.Item>
            <Form.Item name="insuranceValidConfirmed" valuePropName="checked">
              <Checkbox>保险有效确认</Checkbox>
            </Form.Item>
            <Form.Item name="vehiclePreparedConfirmed" valuePropName="checked">
              <Checkbox>车辆整备完成确认</Checkbox>
            </Form.Item>
            <Form.Item name="vehiclePhotosConfirmed" valuePropName="checked">
              <Checkbox>车辆照片确认</Checkbox>
            </Form.Item>
            <Form.Item name="customerIdentityConfirmed" valuePropName="checked">
              <Checkbox>客户身份核验确认</Checkbox>
            </Form.Item>
            <Form.Item name="handoverDocumentsConfirmed" valuePropName="checked">
              <Checkbox>交付文件确认</Checkbox>
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          onCancel={closeConfirmDeliveryModal}
          onOk={confirmDelivery}
          open={confirmDeliveryModalOpen}
          title="确认交付"
        >
          <Form form={confirmDeliveryForm} layout="vertical">
            <Form.Item label="实际交付时间" name="deliveredAt" rules={[{ required: true, message: "请选择实际交付时间" }]}>
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="交付里程" name="handoverMileageKm" rules={[{ required: true, message: "请填写交付里程" }]}>
              <InputNumber min={0} addonAfter="km" style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          onCancel={closePrepareReturnModal}
          onOk={prepareReturn}
          open={prepareReturnModalOpen}
          title="准备退车"
        >
          <Form form={prepareReturnForm} layout="vertical">
            <Form.Item label="退车类型" name="returnType" rules={[{ required: true, message: "请选择退车类型" }]}>
              <Select options={returnTypeOptions} />
            </Form.Item>
            <Form.Item label="预约退车时间" name="scheduledAt">
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="退车地点" name="returnLocation">
              <Input placeholder="静安旺旺大厦" />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          onCancel={closeConfirmReturnModal}
          onOk={confirmReturn}
          open={confirmReturnModalOpen}
          title="确认退车"
          width={860}
        >
          <Form form={confirmReturnForm} layout="vertical">
            <Form.Item label="退车类型" name="returnType" rules={[{ required: true, message: "请选择退车类型" }]}>
              <Select options={returnTypeOptions} />
            </Form.Item>
            <Form.Item label="实际退车时间" name="returnedAt" rules={[{ required: true, message: "请选择实际退车时间" }]}>
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="退车里程" name="returnMileageKm" rules={[{ required: true, message: "请填写退车里程" }]}>
              <InputNumber min={0} precision={0} addonAfter="km" style={{ width: "100%" }} />
            </Form.Item>
            <Space orientation="vertical" size={0} style={{ width: "100%" }}>
              <Form.Item name="keysReturnedConfirmed" valuePropName="checked">
                <Checkbox>钥匙已归还</Checkbox>
              </Form.Item>
              <Form.Item name="chargingEquipmentReturnedConfirmed" valuePropName="checked">
                <Checkbox>充电设备已归还</Checkbox>
              </Form.Item>
              <Form.Item name="vehicleDocumentsReturnedConfirmed" valuePropName="checked">
                <Checkbox>车辆文件已归还</Checkbox>
              </Form.Item>
              <Form.Item name="customerItemsClearedConfirmed" valuePropName="checked">
                <Checkbox>客户物品已清空</Checkbox>
              </Form.Item>
              <Form.Item name="exteriorCheckedConfirmed" valuePropName="checked">
                <Checkbox>外观已检查</Checkbox>
              </Form.Item>
              <Form.Item name="interiorCheckedConfirmed" valuePropName="checked">
                <Checkbox>内饰已检查</Checkbox>
              </Form.Item>
              <Form.Item name="batteryCheckedConfirmed" valuePropName="checked">
                <Checkbox>电池已检查</Checkbox>
              </Form.Item>
              <Form.Item name="mileageConfirmed" valuePropName="checked">
                <Checkbox>里程已确认</Checkbox>
              </Form.Item>
              <Form.Item name="violationCheckedConfirmed" valuePropName="checked">
                <Checkbox>违章已检查</Checkbox>
              </Form.Item>
              <Form.Item name="cleaningRequired" valuePropName="checked">
                <Checkbox>是否需要清洁</Checkbox>
              </Form.Item>
              <Form.Item name="maintenanceRequired" valuePropName="checked">
                <Checkbox>是否需要维修</Checkbox>
              </Form.Item>
              <Form.Item name="damageFound" valuePropName="checked">
                <Checkbox>是否发现损伤</Checkbox>
              </Form.Item>
            </Space>

            <Form.List name="damages">
              {(fields, { add, remove }) => (
                <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                  <Space style={{ justifyContent: "space-between", width: "100%" }}>
                    <Typography.Text strong>损伤记录</Typography.Text>
                    <ActionButton
                      allowed={canRecordReturnDamage}
                      disabledReason="无损伤记录权限"
                      icon={<PlusOutlined />}
                      onClick={() => add({ responsibleParty: "UNKNOWN" })}
                    >
                      新增损伤
                    </ActionButton>
                  </Space>
                  {!canRecordReturnDamage ? (
                    <Alert message="无损伤记录权限，仅可提交退车检查项。" showIcon type="info" />
                  ) : null}
                  {fields.map((field, index) => (
                    <Card
                      extra={
                        <Button
                          aria-label="删除损伤记录"
                          icon={<DeleteOutlined />}
                          onClick={() => remove(field.name)}
                          size="small"
                        />
                      }
                      key={field.key}
                      size="small"
                      title={`损伤 ${index + 1}`}
                    >
                      <Form.Item
                        label="损伤类型"
                        name={[field.name, "damageType"]}
                        rules={[{ required: true, message: "请选择损伤类型" }]}
                      >
                        <Select options={damageTypeOptions} />
                      </Form.Item>
                      <Form.Item
                        label="损伤等级"
                        name={[field.name, "damageLevel"]}
                        rules={[{ required: true, message: "请选择损伤等级" }]}
                      >
                        <Select options={damageLevelOptions} />
                      </Form.Item>
                      <Form.Item
                        label="描述"
                        name={[field.name, "description"]}
                        rules={[{ required: true, message: "请填写损伤描述" }]}
                      >
                        <Input.TextArea rows={2} />
                      </Form.Item>
                      <Form.Item label="责任方" name={[field.name, "responsibleParty"]}>
                        <Select options={responsiblePartyOptions} />
                      </Form.Item>
                      <Form.Item label="预估维修金额" name={[field.name, "estimatedRepairAmount"]}>
                        <InputNumber min={0} precision={2} addonAfter="元" style={{ width: "100%" }} />
                      </Form.Item>
                      <Form.Item label="照片 URL" name={[field.name, "photoUrlsText"]}>
                        <Input.TextArea placeholder="多个 URL 可用逗号或换行分隔" rows={2} />
                      </Form.Item>
                    </Card>
                  ))}
                </Space>
              )}
            </Form.List>

            <Form.Item label="备注" name="remark" style={{ marginTop: 16 }}>
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          onCancel={closeChangeModal}
          onOk={createChange}
          open={changeModalOpen}
          title="申请变更方案 / 退回重做方案"
        >
          <Form form={changeForm} layout="vertical">
            <Form.Item label="变更类型">
              <Input disabled value="退回重做方案" />
            </Form.Item>
            <Space orientation="vertical" size={4} style={{ marginBottom: 12 }}>
              <Typography.Text strong>处理方式</Typography.Text>
              <Typography.Text>审批通过后，由运营取消当前订单、作废未签署合同并释放车辆。</Typography.Text>
              <Typography.Text>{returnToPlanHint}</Typography.Text>
              <Typography.Text strong>当前订单车辆</Typography.Text>
              <Typography.Text>
                车辆：{order?.vehicle ? joinText(order.vehicle.vehicleNo, order.vehicle.plateNo, order.vehicle.vin) : "-"}
              </Typography.Text>
              <Typography.Text>车辆状态：{order?.vehicle?.status ?? "-"}</Typography.Text>
              <Typography.Text>车型：{order?.vehicle?.vehicleModel ?? order?.vehicleModel ?? "-"}</Typography.Text>
              <Typography.Text>当前销售价：{formatYuan(currentVehicleSalePrice)}</Typography.Text>
            </Space>
            <Form.Item label="变更原因" name="reason" rules={[{ required: true, message: "请填写变更原因" }]}>
              <Input.TextArea rows={4} />
            </Form.Item>
          </Form>
        </Modal>
      </Space>
    </ProtectedShell>
  );
}
