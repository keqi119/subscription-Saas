"use client";

import { ArrowLeftOutlined } from "@ant-design/icons";
import { App, Button, Card, Descriptions, Space, Spin, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../../components/action-button";
import { ProtectedShell } from "../../../components/protected-shell";
import { STATUS_LABELS, VEHICLE_BASE_FEE_MODE_LABELS, VEHICLE_BATTERY_USAGE_TYPE_LABELS, labelOf } from "../../../constants/labels";
import { actionAvailability } from "../../../lib/action-guards";
import { apiFetch, ApiError } from "../../../lib/api";
import type { AuthMeResponse } from "../../../lib/auth";

interface UserSummary {
  name?: string | null;
  realName?: string | null;
  username?: string | null;
}

interface CustomerSummary {
  certificateNo?: string | null;
  customerNo?: string | null;
  grade?: string | null;
  id?: string | null;
  idCardNo?: string | null;
  identityNo?: string | null;
  mobile?: string | null;
  name?: string | null;
  source?: string | null;
  sourceChannel?: string | null;
}

interface PackageSummary {
  description?: string | null;
  monthlyEnergyCount?: number | null;
  monthlyEnergyKwh?: number | null;
  monthlyMileageKm?: number | null;
  overMileageFeeAmount?: number | null;
  packageName?: string | null;
  packageNo?: string | null;
}

interface PackageSnapshot {
  benefitPackage?: PackageSummary | null;
  energyPackage?: PackageSummary | null;
  mileagePackage?: PackageSummary | null;
  monthlyFeeCapAmount?: number | string | null;
  pricing?: {
    benefitPackagePriceAmount?: number | string | null;
    currentSalePriceAmount?: number | string | null;
    energyPackagePriceAmount?: number | string | null;
    fixedRate?: number | string | null;
    mileagePackagePriceAmount?: number | string | null;
    monthlyFeeAmount?: number | string | null;
    vehicleBaseFeeAmount?: number | string | null;
    vehicleBaseFeeCapAmount?: number | string | null;
    vehicleBaseFeeMode?: string | null;
    vehicleBaseFeeModeLabel?: string | null;
  } | null;
  subscriptionPlan?: {
    monthlyFeeMode?: string | null;
    monthlyFeeModeLabel?: string | null;
    planName?: string | null;
    planNo?: string | null;
  } | null;
  vehicleBaseFeeAmount?: number | string | null;
  vehicleBaseFeeCapAmount?: number | string | null;
  vehicleBaseFeeMode?: string | null;
  vehicleBaseFeeModeLabel?: string | null;
  vehiclePackage?: {
    monthlyFeeRate?: number | string | null;
    packageName?: string | null;
    packageNo?: string | null;
    vehicleModel?: string | null;
  } | null;
}

interface VehicleSnapshot {
  assetLocation?: string | null;
  batteryCapacityKwh?: number | string | null;
  batteryUsageType?: string | null;
  batteryUsageTypeLabel?: string | null;
  brand?: string | null;
  currentMileageKm?: number | string | null;
  currentSalePriceAmount?: number | string | null;
  plateNo?: string | null;
  series?: string | null;
  status?: string | null;
  vehicleModel?: string | null;
  vehicleNo?: string | null;
  vin?: string | null;
}

interface RiskResult {
  approvalOpinion?: string | null;
  approvalStatus?: string | null;
  approvedAt?: string | null;
  approver?: UserSummary | string | null;
  comment?: string | null;
  defaultRate?: number | string | null;
  depositAmount?: number | string | null;
  depositStatus?: string | null;
  grade?: string | null;
  reviewStatus?: string | null;
  reviewedAt?: string | null;
  reviewer?: UserSummary | string | null;
  riskScore?: number | string | null;
  score?: number | string | null;
}

interface QuoteDetail {
  application?: { applicationNo?: string | null; id?: string | null } | null;
  benefitPackagePriceAmount?: number | string | null;
  cancelledAt?: string | null;
  cancelledBy?: UserSummary | string | null;
  canceller?: UserSummary | string | null;
  cancelReason?: string | null;
  confirmedAt?: string | null;
  confirmedBy?: UserSummary | string | null;
  confirmer?: UserSummary | null;
  contract?: { contractNo?: string | null; id?: string | null; status?: string | null } | null;
  createdAt?: string | null;
  createdBy?: UserSummary | string | null;
  creator?: UserSummary | null;
  customer?: CustomerSummary | null;
  depositAmount?: number | string | null;
  depositRuleSnapshot?: {
    defaultRate?: number | string | null;
    depositAmount?: number | string | null;
    grade?: string | null;
    status?: string | null;
  } | null;
  energyLimitCount?: number | string | null;
  energyLimitKwh?: number | string | null;
  energyPackagePriceAmount?: number | string | null;
  id: string;
  mileagePackagePriceAmount?: number | string | null;
  mileageLimitKm?: number | string | null;
  monthlyFeeAmount?: number | string | null;
  monthlyFeeCapAmount?: number | string | null;
  monthlyFeeRate?: number | string | null;
  notes?: string | null;
  order?: {
    contract?: { contractNo?: string | null; id?: string | null; status?: string | null } | null;
    id: string;
    orderNo?: string | null;
    orderStatus?: string | null;
  } | null;
  overMileageFeeAmount?: number | string | null;
  packageSnapshot?: PackageSnapshot | null;
  periodMonths?: number | string | null;
  productVersion?: { product?: { name?: string | null } | null; versionNo?: string | null } | null;
  quoteNo?: string | null;
  remark?: string | null;
  riskResult?: RiskResult | null;
  status?: string | null;
  subscriptionPlan?: {
    monthlyFeeMode?: string | null;
    monthlyFeeModeLabel?: string | null;
    planName?: string | null;
    planNo?: string | null;
  } | null;
  subscriptionPlanId?: string | null;
  vehicle?: VehicleSnapshot | null;
  vehicleBaseFeeAmount?: number | string | null;
  vehicleBaseFeeCapAmount?: number | string | null;
  vehicleId?: string | null;
  vehicleModel?: string | null;
  vehicleSalePriceAmount?: number | string | null;
  vehicleSnapshot?: VehicleSnapshot | null;
}

interface OrderDetail {
  id: string;
}

const statusColors: Record<string, string> = {
  CANCELLED: "red",
  CONFIRMED: "green",
  DRAFT: "blue",
  EXPIRED: "default"
};

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeText(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (typeof value === "object") {
    return "-";
  }
  return String(value);
}

function joinText(...values: unknown[]) {
  const parts = values.map(safeText).filter((value) => value !== "-");
  return parts.length > 0 ? parts.join(" / ") : "-";
}

function formatTime(value?: unknown) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  const date = dayjs(String(value));
  return date.isValid() ? date.format("YYYY-MM-DD HH:mm") : "-";
}

function formatAmount(value?: unknown) {
  const n = toNumber(value);
  if (n === null) {
    return "-";
  }
  return `${(n / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })} 元`;
}

function formatPercent(value?: unknown) {
  const n = toNumber(value);
  if (n === null) {
    return "-";
  }
  return `${(n * 100).toFixed(2)}%`;
}

function formatNumberWithUnit(value: unknown, unit: string) {
  const n = toNumber(value);
  if (n === null) {
    return "-";
  }
  return `${n.toLocaleString("zh-CN")} ${unit}`;
}

function formatBatteryUsageType(type?: string | null, label?: string | null) {
  return label ?? (type ? labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, type) : "-");
}

function formatVehicleBaseFeeModeLabel(mode?: string | null, label?: string | null) {
  if (label) {
    return label;
  }
  if (!mode) {
    return "-";
  }
  return VEHICLE_BASE_FEE_MODE_LABELS[mode] ?? mode;
}

function formatUser(value?: UserSummary | string | null) {
  if (typeof value === "string") {
    return safeText(value);
  }
  return safeText(value?.name ?? value?.realName ?? value?.username);
}

function renderStatusTag(status?: string | null) {
  if (!status) {
    return "-";
  }
  return <Tag color={statusColors[status]}>{labelOf(STATUS_LABELS, status)}</Tag>;
}

function getQuoteVehicleBaseFeeMode(quote: QuoteDetail) {
  return (
    quote.packageSnapshot?.pricing?.vehicleBaseFeeMode ??
    quote.packageSnapshot?.vehicleBaseFeeMode ??
    quote.subscriptionPlan?.monthlyFeeMode ??
    quote.packageSnapshot?.subscriptionPlan?.monthlyFeeMode ??
    null
  );
}

function getQuoteVehicleBaseFeeModeLabel(quote: QuoteDetail) {
  return formatVehicleBaseFeeModeLabel(
    getQuoteVehicleBaseFeeMode(quote),
    quote.packageSnapshot?.pricing?.vehicleBaseFeeModeLabel ??
      quote.packageSnapshot?.vehicleBaseFeeModeLabel ??
      quote.subscriptionPlan?.monthlyFeeModeLabel ??
      quote.packageSnapshot?.subscriptionPlan?.monthlyFeeModeLabel ??
      null
  );
}

function getQuoteFixedRate(quote: QuoteDetail) {
  const snapshotRate = quote.packageSnapshot?.pricing?.fixedRate;
  if (snapshotRate !== undefined && snapshotRate !== null) {
    return snapshotRate;
  }
  return getQuoteVehicleBaseFeeMode(quote) === "RATE_FORMULA" ? quote.monthlyFeeRate : null;
}

function getVehiclePackageRate(quote: QuoteDetail) {
  return quote.packageSnapshot?.vehiclePackage?.monthlyFeeRate ?? quote.monthlyFeeRate ?? null;
}

function getCurrentSalePriceAmount(quote: QuoteDetail) {
  return (
    quote.vehicleSalePriceAmount ??
    quote.packageSnapshot?.pricing?.currentSalePriceAmount ??
    quote.vehicleSnapshot?.currentSalePriceAmount ??
    quote.vehicle?.currentSalePriceAmount ??
    null
  );
}

function getVehicleBaseFeeAmount(quote: QuoteDetail) {
  return quote.vehicleBaseFeeAmount ?? quote.packageSnapshot?.pricing?.vehicleBaseFeeAmount ?? quote.packageSnapshot?.vehicleBaseFeeAmount ?? null;
}

function getVehicleBaseFeeCapAmount(quote: QuoteDetail) {
  const explicitCap =
    quote.vehicleBaseFeeCapAmount ??
    quote.packageSnapshot?.pricing?.vehicleBaseFeeCapAmount ??
    quote.packageSnapshot?.vehicleBaseFeeCapAmount ??
    quote.monthlyFeeCapAmount ??
    quote.packageSnapshot?.monthlyFeeCapAmount ??
    null;
  if (explicitCap !== null && explicitCap !== undefined) {
    return explicitCap;
  }

  const salePrice = toNumber(getCurrentSalePriceAmount(quote));
  const packageRate = toNumber(getVehiclePackageRate(quote));
  return salePrice !== null && packageRate !== null ? Math.round(salePrice * packageRate) : null;
}

function getPackagePrice(quote: QuoteDetail, key: "benefit" | "energy" | "mileage") {
  if (key === "benefit") {
    return quote.benefitPackagePriceAmount ?? quote.packageSnapshot?.pricing?.benefitPackagePriceAmount ?? null;
  }
  if (key === "energy") {
    return quote.energyPackagePriceAmount ?? quote.packageSnapshot?.pricing?.energyPackagePriceAmount ?? null;
  }
  return quote.mileagePackagePriceAmount ?? quote.packageSnapshot?.pricing?.mileagePackagePriceAmount ?? null;
}

function getMonthlyFeeAmount(quote: QuoteDetail) {
  const explicit = quote.monthlyFeeAmount ?? quote.packageSnapshot?.pricing?.monthlyFeeAmount ?? null;
  if (explicit !== null && explicit !== undefined) {
    return explicit;
  }

  const parts = [
    getVehicleBaseFeeAmount(quote),
    getPackagePrice(quote, "mileage"),
    getPackagePrice(quote, "energy"),
    getPackagePrice(quote, "benefit")
  ].map(toNumber);

  return parts.every((part) => part !== null) ? parts.reduce((sum, part) => sum + (part ?? 0), 0) : null;
}

function getPlanLabel(quote: QuoteDetail) {
  return joinText(
    quote.subscriptionPlan?.planNo ?? quote.packageSnapshot?.subscriptionPlan?.planNo,
    quote.subscriptionPlan?.planName ?? quote.packageSnapshot?.subscriptionPlan?.planName
  );
}

function getVehicleLabel(quote: QuoteDetail) {
  return joinText(
    quote.vehicleSnapshot?.vehicleNo ?? quote.vehicle?.vehicleNo,
    quote.vehicleSnapshot?.plateNo ?? quote.vehicle?.plateNo,
    quote.vehicleSnapshot?.vehicleModel ?? quote.vehicle?.vehicleModel ?? quote.vehicleModel
  );
}

function getVehicleModel(quote: QuoteDetail) {
  return safeText(quote.vehicleSnapshot?.vehicleModel ?? quote.vehicle?.vehicleModel ?? quote.vehicleModel);
}

function getDepositAmount(quote: QuoteDetail) {
  return quote.depositAmount ?? quote.depositRuleSnapshot?.depositAmount ?? quote.riskResult?.depositAmount ?? null;
}

function getDepositStatus(quote: QuoteDetail) {
  const status = quote.depositRuleSnapshot?.status ?? quote.riskResult?.depositStatus ?? null;
  if (status) {
    return labelOf(STATUS_LABELS, status);
  }
  return getDepositAmount(quote) === null ? "待资质审核确认" : "已确认";
}

function getRiskScore(quote: QuoteDetail) {
  return quote.riskResult?.score ?? quote.riskResult?.riskScore ?? null;
}

function getApprovalStatus(quote: QuoteDetail) {
  return quote.riskResult?.reviewStatus ?? quote.riskResult?.approvalStatus ?? null;
}

function getApprovalOpinion(quote: QuoteDetail) {
  return quote.riskResult?.approvalOpinion ?? quote.riskResult?.comment ?? quote.cancelReason ?? null;
}

function getApprovalTime(quote: QuoteDetail) {
  return quote.riskResult?.reviewedAt ?? quote.riskResult?.approvedAt ?? null;
}

function getApprover(quote: QuoteDetail) {
  return quote.riskResult?.reviewer ?? quote.riskResult?.approver ?? null;
}

function getCustomerIdentity(customer?: CustomerSummary | null) {
  return safeText(customer?.identityNo ?? customer?.idCardNo ?? customer?.certificateNo);
}

function getModeDetail(quote: QuoteDetail) {
  const mode = getQuoteVehicleBaseFeeMode(quote);
  if (mode === "FIXED_AMOUNT") {
    return formatAmount(getVehicleBaseFeeAmount(quote));
  }
  if (mode === "RATE_FORMULA") {
    return formatPercent(getQuoteFixedRate(quote));
  }
  if (mode === "MANUAL_QUOTE") {
    return "现场报价";
  }
  return "-";
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

export default function QuoteDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me]);

  const loadQuote = useCallback(async () => {
    setLoading(true);
    try {
      const [nextQuote, nextMe] = await Promise.all([
        apiFetch<QuoteDetail>(`/quotes/${params.id}`),
        apiFetch<AuthMeResponse>("/auth/me")
      ]);
      setQuote(nextQuote);
      setMe(nextMe);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [message, params.id]);

  useEffect(() => {
    void loadQuote();
  }, [loadQuote]);

  async function transition(action: "confirm" | "cancel") {
    if (!quote) {
      return;
    }
    try {
      await apiFetch<QuoteDetail>(`/quotes/${quote.id}/${action}`, { method: "POST" });
      void message.success(action === "confirm" ? "报价已确认" : "报价已取消");
      await loadQuote();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function createOrder() {
    if (!quote) {
      return;
    }
    modal.confirm({
      content: `确认基于报价 ${quote.quoteNo ?? "-"} 创建订阅订单？`,
      okText: "创建订阅订单",
      onOk: async () => {
        try {
          const order = await apiFetch<OrderDetail>(`/orders/from-quote/${quote.id}`, {
            body: JSON.stringify({ businessType: "SUBSCRIPTION" }),
            method: "POST"
          });
          void message.success("订阅订单已创建");
          router.push(`/orders/${order.id}`);
        } catch (error) {
          void message.error(getErrorMessage(error));
        }
      },
      title: "创建订阅订单"
    });
  }

  const quoteSections = useMemo(() => {
    if (!quote) {
      return null;
    }

    const vehicleBaseFeeAmount = getVehicleBaseFeeAmount(quote);
    const mileagePackagePriceAmount = getPackagePrice(quote, "mileage");
    const energyPackagePriceAmount = getPackagePrice(quote, "energy");
    const benefitPackagePriceAmount = getPackagePrice(quote, "benefit");
    const monthlyFeeAmount = getMonthlyFeeAmount(quote);
    const currentSalePriceAmount = getCurrentSalePriceAmount(quote);
    const vehicleBaseFeeCapAmount = getVehicleBaseFeeCapAmount(quote);
    const orderContract = quote.order?.contract ?? quote.contract ?? null;

    return {
      benefitPackagePriceAmount,
      currentSalePriceAmount,
      energyPackagePriceAmount,
      mileagePackagePriceAmount,
      monthlyFeeAmount,
      orderContract,
      vehicleBaseFeeAmount,
      vehicleBaseFeeCapAmount
    };
  }, [quote]);

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={20} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Space>
            <Button aria-label="返回报价列表" icon={<ArrowLeftOutlined />} onClick={() => router.push("/quotes")} />
            <Typography.Title level={4} style={{ margin: 0 }}>
              {quote?.quoteNo ?? "订阅报价详情"}
            </Typography.Title>
            {quote ? renderStatusTag(quote.status) : null}
          </Space>
          <Space>
            {quote ? (
              <>
                <ActionButton
                  allowed={quote.status === "DRAFT"}
                  disabledReason="当前报价状态不允许确认"
                  noPermissionReason="无确认报价权限"
                  onClick={() => transition("confirm")}
                  permission="quote:confirm"
                  permissions={permissions}
                  type="primary"
                >
                  确认报价
                </ActionButton>
                <ActionButton
                  allowed={quote.status === "DRAFT"}
                  danger
                  disabledReason="当前报价状态不允许取消"
                  noPermissionReason="无取消报价权限"
                  onClick={() => transition("cancel")}
                  permission="quote:cancel"
                  permissions={permissions}
                >
                  取消报价
                </ActionButton>
                <ActionButton
                  availability={actionAvailability({
                    allowed: quote.status === "CONFIRMED" && !quote.order,
                    disabledReason: quote.order ? "该报价已生成订单" : "请先确认报价",
                    noPermissionReason: "无创建订单权限",
                    permission: "order:create",
                    permissions
                  })}
                  onClick={createOrder}
                  type="primary"
                >
                  创建订阅订单
                </ActionButton>
              </>
            ) : null}
            {quote?.order ? <Button onClick={() => router.push(`/orders/${quote.order?.id}`)}>查看订单</Button> : null}
          </Space>
        </Space>

        {loading ? (
          <Spin />
        ) : quote && quoteSections ? (
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <Card title="报价摘要">
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "报价编号", children: safeText(quote.quoteNo) },
                  { label: "报价状态", children: renderStatusTag(quote.status) },
                  { label: "客户姓名", children: safeText(quote.customer?.name) },
                  { label: "车辆", children: getVehicleLabel(quote) },
                  { label: "套餐名称", children: getPlanLabel(quote) },
                  { label: "套餐月费合计", children: formatAmount(quoteSections.monthlyFeeAmount) },
                  { label: "押金金额", children: formatAmount(getDepositAmount(quote)) },
                  { label: "订阅周期", children: formatNumberWithUnit(quote.periodMonths, "个月") }
                ]}
              />
            </Card>

            <Card title="客户信息">
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "客户姓名", children: safeText(quote.customer?.name) },
                  { label: "手机号", children: safeText(quote.customer?.mobile) },
                  { label: "客户编号", children: safeText(quote.customer?.customerNo ?? quote.customer?.id) },
                  { label: "证件信息", children: getCustomerIdentity(quote.customer) },
                  { label: "客户来源", children: safeText(quote.customer?.sourceChannel ?? quote.customer?.source) },
                  { label: "关联进件编号", children: safeText(quote.application?.applicationNo) }
                ]}
              />
            </Card>

            <Card title="资质 / 风控 / 押金信息">
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "客户等级", children: safeText(quote.customer?.grade ?? quote.depositRuleSnapshot?.grade ?? quote.riskResult?.grade) },
                  { label: "风控评分", children: safeText(getRiskScore(quote)) },
                  { label: "审批状态", children: getApprovalStatus(quote) ? renderStatusTag(getApprovalStatus(quote)) : "-" },
                  { label: "押金状态", children: getDepositStatus(quote) },
                  {
                    label: "押金规则",
                    children: joinText(
                      quote.depositRuleSnapshot?.grade ?? quote.riskResult?.grade,
                      formatPercent(quote.depositRuleSnapshot?.defaultRate ?? quote.riskResult?.defaultRate)
                    )
                  },
                  { label: "押金金额", children: formatAmount(getDepositAmount(quote)) },
                  { label: "违约率", children: formatPercent(quote.depositRuleSnapshot?.defaultRate ?? quote.riskResult?.defaultRate) },
                  { label: "审批意见", children: safeText(getApprovalOpinion(quote)) },
                  { label: "审批时间", children: formatTime(getApprovalTime(quote)) },
                  { label: "审批人", children: formatUser(getApprover(quote)) }
                ]}
              />
            </Card>

            <Card title="车辆信息">
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "VIN", children: safeText(quote.vehicleSnapshot?.vin ?? quote.vehicle?.vin) },
                  { label: "车牌号", children: safeText(quote.vehicleSnapshot?.plateNo ?? quote.vehicle?.plateNo) },
                  { label: "品牌", children: safeText(quote.vehicleSnapshot?.brand ?? quote.vehicle?.brand) },
                  { label: "车系", children: safeText(quote.vehicleSnapshot?.series ?? quote.vehicle?.series) },
                  { label: "车型", children: getVehicleModel(quote) },
                  { label: "电池容量", children: formatNumberWithUnit(quote.vehicleSnapshot?.batteryCapacityKwh ?? quote.vehicle?.batteryCapacityKwh, "kWh") },
                  {
                    label: "电池使用方式",
                    children: formatBatteryUsageType(
                      quote.vehicleSnapshot?.batteryUsageType ?? quote.vehicle?.batteryUsageType,
                      quote.vehicleSnapshot?.batteryUsageTypeLabel ?? quote.vehicle?.batteryUsageTypeLabel
                    )
                  },
                  { label: "当前车辆销售价", children: formatAmount(quoteSections.currentSalePriceAmount) },
                  { label: "当前里程", children: formatNumberWithUnit(quote.vehicleSnapshot?.currentMileageKm ?? quote.vehicle?.currentMileageKm, "km") },
                  {
                    label: "车辆状态",
                    children: quote.vehicleSnapshot?.status ?? quote.vehicle?.status ? renderStatusTag(quote.vehicleSnapshot?.status ?? quote.vehicle?.status) : "-"
                  },
                  { label: "资产位置", children: safeText(quote.vehicleSnapshot?.assetLocation ?? quote.vehicle?.assetLocation) }
                ]}
              />
            </Card>

            <Card title="套餐与价格明细">
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "车辆基础月费模式", children: getQuoteVehicleBaseFeeModeLabel(quote) },
                  { label: "固定金额 / 固定费率 / 现场报价", children: getModeDetail(quote) },
                  { label: "车型包系数", children: formatPercent(getVehiclePackageRate(quote)) },
                  { label: "车辆基础费上限", children: formatAmount(quoteSections.vehicleBaseFeeCapAmount) },
                  { label: "车辆基础费", children: formatAmount(quoteSections.vehicleBaseFeeAmount) },
                  {
                    label: "里程包名称",
                    children: joinText(quote.packageSnapshot?.mileagePackage?.packageNo, quote.packageSnapshot?.mileagePackage?.packageName)
                  },
                  { label: "里程包价格", children: formatAmount(quoteSections.mileagePackagePriceAmount) },
                  {
                    label: "补能包名称",
                    children: joinText(quote.packageSnapshot?.energyPackage?.packageNo, quote.packageSnapshot?.energyPackage?.packageName)
                  },
                  { label: "补能包价格", children: formatAmount(quoteSections.energyPackagePriceAmount) },
                  {
                    label: "权益包名称",
                    children: joinText(quote.packageSnapshot?.benefitPackage?.packageNo, quote.packageSnapshot?.benefitPackage?.packageName)
                  },
                  { label: "权益包价格", children: formatAmount(quoteSections.benefitPackagePriceAmount) },
                  { label: "套餐月费合计", children: formatAmount(quoteSections.monthlyFeeAmount) }
                ]}
              />
              <Typography.Paragraph style={{ marginTop: 16, marginBottom: 0 }}>
                车辆基础费上限 = 当前车辆销售价 × 车型包系数。
              </Typography.Paragraph>
              <Typography.Paragraph style={{ marginBottom: 0 }}>
                套餐月费合计 = 车辆基础费 + 里程包价格 + 补能包价格 + 权益包价格。
              </Typography.Paragraph>
              <Typography.Text type="secondary">车型包系数只约束车辆基础费，不约束套餐月费合计。</Typography.Text>
            </Card>

            <Card title="制单与状态流转信息">
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "报价创建人", children: formatUser(quote.creator ?? quote.createdBy) },
                  { label: "创建时间", children: formatTime(quote.createdAt) },
                  { label: "确认人", children: formatUser(quote.confirmer ?? quote.confirmedBy) },
                  { label: "确认时间", children: formatTime(quote.confirmedAt) },
                  { label: "取消人", children: formatUser(quote.canceller ?? quote.cancelledBy) },
                  { label: "取消时间", children: formatTime(quote.cancelledAt) },
                  { label: "状态", children: renderStatusTag(quote.status) },
                  { label: "关联订单编号", children: safeText(quote.order?.orderNo) },
                  { label: "关联合同编号", children: safeText(quoteSections.orderContract?.contractNo) },
                  { label: "备注", children: safeText(quote.remark ?? quote.notes ?? quote.cancelReason) }
                ]}
              />
            </Card>
          </Space>
        ) : null}
      </Space>
    </ProtectedShell>
  );
}
