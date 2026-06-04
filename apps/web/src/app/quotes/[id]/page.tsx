"use client";

import { ArrowLeftOutlined } from "@ant-design/icons";
import { App, Button, Descriptions, Space, Spin, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../../components/protected-shell";
import { STATUS_LABELS, labelOf } from "../../../constants/labels";
import { apiFetch, ApiError } from "../../../lib/api";

interface PackageSnapshot {
  benefitPackage?: { description?: string | null; packageName?: string; packageNo?: string } | null;
  energyPackage?: { monthlyEnergyCount?: number | null; monthlyEnergyKwh?: number | null; packageName?: string; packageNo?: string } | null;
  mileagePackage?: { monthlyMileageKm?: number; overMileageFeeAmount?: number; packageName?: string; packageNo?: string } | null;
  monthlyFeeCapAmount?: number;
  pricing?: {
    benefitPackagePriceAmount?: number;
    energyPackagePriceAmount?: number;
    mileagePackagePriceAmount?: number;
    monthlyFeeAmount?: number;
    vehicleBaseFeeAmount?: number;
    vehicleBaseFeeCapAmount?: number;
  };
  subscriptionPlan?: { planName?: string; planNo?: string } | null;
  vehiclePackage?: { packageName?: string; packageNo?: string; vehicleModel?: string } | null;
}

interface VehicleSnapshot {
  currentMileageKm?: number | null;
  currentSalePriceAmount?: number | null;
  plateNo?: string | null;
  vehicleModel?: string | null;
  vehicleNo?: string | null;
  vin?: string | null;
}

interface QuoteDetail {
  application: { applicationNo: string; id: string };
  confirmedAt?: string | null;
  confirmer?: { name: string } | null;
  createdAt: string;
  customer: { grade?: string | null; mobile: string; name: string };
  depositAmount: number;
  depositRuleSnapshot?: { defaultRate?: number; depositAmount?: number; grade?: string } | null;
  benefitPackagePriceAmount?: number | null;
  energyPackagePriceAmount?: number | null;
  energyLimitCount?: number | null;
  energyLimitKwh?: number | null;
  id: string;
  mileagePackagePriceAmount?: number | null;
  mileageLimitKm: number;
  monthlyFeeAmount: number;
  monthlyFeeCapAmount: number;
  monthlyFeeRate: number;
  order?: { id: string; orderNo: string; orderStatus: string } | null;
  overMileageFeeAmount: number;
  packageSnapshot?: PackageSnapshot | null;
  periodMonths: number;
  productVersion: { product: { name: string }; versionNo: string };
  quoteNo: string;
  status: string;
  subscriptionPlan?: { planName: string; planNo: string } | null;
  subscriptionPlanId?: string | null;
  vehicle?: VehicleSnapshot | null;
  vehicleBaseFeeAmount?: number | null;
  vehicleBaseFeeCapAmount?: number | null;
  vehicleId?: string | null;
  vehicleModel: string;
  vehiclePurchasePriceAmount: number;
  vehicleSalePriceAmount?: number | null;
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

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function formatYuan(value?: number | null) {
  return value === undefined || value === null ? "-" : `¥${(value / 100).toFixed(2)}`;
}

function formatRate(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatOptionalRate(value?: number | null) {
  return value === undefined || value === null ? "-" : `${(value * 100).toFixed(2)}%`;
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

export default function QuoteDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [quote, setQuote] = useState<QuoteDetail | null>(null);

  const loadQuote = useCallback(async () => {
    setLoading(true);
    try {
      setQuote(await apiFetch<QuoteDetail>(`/quotes/${params.id}`));
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
      content: `确认基于报价 ${quote.quoteNo} 创建订阅订单？`,
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

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={20} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Space>
            <Button aria-label="返回报价列表" icon={<ArrowLeftOutlined />} onClick={() => router.push("/quotes")} />
            <Typography.Title level={4} style={{ margin: 0 }}>
              {quote?.quoteNo ?? "订阅报价详情"}
            </Typography.Title>
            {quote ? (
              <Tag color={statusColors[quote.status]}>{labelOf(STATUS_LABELS, quote.status)}</Tag>
            ) : null}
          </Space>
          <Space>
            {quote?.status === "DRAFT" ? (
              <>
                <Button onClick={() => transition("confirm")} type="primary">
                  确认报价
                </Button>
                <Button danger onClick={() => transition("cancel")}>
                  取消报价
                </Button>
              </>
            ) : null}
            {quote?.status === "CONFIRMED" && !quote.order ? (
              <Button onClick={createOrder} type="primary">
                创建订阅订单
              </Button>
            ) : null}
            {quote?.order ? (
              <Button onClick={() => router.push(`/orders/${quote.order?.id}`)}>查看订单</Button>
            ) : null}
          </Space>
        </Space>

        {loading ? (
          <Spin />
        ) : quote ? (
          <Space orientation="vertical" size={20} style={{ width: "100%" }}>
            <Descriptions
              bordered
              column={3}
              items={[
                { label: "报价编号", children: quote.quoteNo },
                { label: "关联进件", children: quote.application.applicationNo },
                { label: "客户信息", children: `${quote.customer.name} / ${quote.customer.mobile}` },
                { label: "客户等级", children: quote.customer.grade ?? "-" },
                { label: "产品版本", children: `${quote.productVersion.product.name} / ${quote.productVersion.versionNo}` },
                { label: "车型", children: quote.vehicleModel },
                { label: "车辆采购价", children: formatYuan(quote.vehiclePurchasePriceAmount) },
                { label: "月费率", children: formatRate(quote.monthlyFeeRate) },
                { label: "月费金额", children: formatYuan(quote.monthlyFeeAmount) },
                { label: "月费上限", children: formatYuan(quote.monthlyFeeCapAmount) },
                { label: "押金", children: formatYuan(quote.depositAmount) },
                { label: "订阅周期", children: `${quote.periodMonths} 个月` },
                { label: "月里程额度", children: `${quote.mileageLimitKm} km` },
                { label: "超里程单价", children: formatYuan(quote.overMileageFeeAmount) },
                { label: "补能额度", children: quote.energyLimitKwh ?? "-" },
                { label: "补能次数", children: quote.energyLimitCount ?? "-" },
                {
                  label: "状态",
                  children: <Tag color={statusColors[quote.status]}>{labelOf(STATUS_LABELS, quote.status)}</Tag>
                },
                { label: "关联订单", children: quote.order?.orderNo ?? "-" },
                { label: "确认人", children: quote.confirmer?.name ?? "-" },
                { label: "确认时间", children: formatTime(quote.confirmedAt) },
                { label: "创建时间", children: formatTime(quote.createdAt) }
              ]}
            />
            {quote.vehicleId || quote.vehicleSnapshot || quote.vehicleBaseFeeAmount !== undefined && quote.vehicleBaseFeeAmount !== null ? (
              <section>
                <Typography.Title level={5}>车辆与报价价格快照</Typography.Title>
                <Descriptions
                  bordered
                  column={2}
                  items={[
                    { label: "车辆编号", children: quote.vehicleSnapshot?.vehicleNo ?? quote.vehicle?.vehicleNo ?? "-" },
                    { label: "VIN", children: quote.vehicleSnapshot?.vin ?? quote.vehicle?.vin ?? "-" },
                    { label: "车牌号", children: quote.vehicleSnapshot?.plateNo ?? quote.vehicle?.plateNo ?? "-" },
                    { label: "车型", children: quote.vehicleSnapshot?.vehicleModel ?? quote.vehicle?.vehicleModel ?? quote.vehicleModel },
                    { label: "当前车辆销售价快照", children: formatYuan(quote.vehicleSalePriceAmount ?? quote.vehicleSnapshot?.currentSalePriceAmount ?? quote.vehicle?.currentSalePriceAmount) },
                    { label: "当前里程快照", children: `${quote.vehicleSnapshot?.currentMileageKm ?? quote.vehicle?.currentMileageKm ?? "-"} km` },
                    { label: "车型包系数", children: formatRate(quote.monthlyFeeRate) },
                    { label: "车辆基础费上限", children: formatYuan(quote.vehicleBaseFeeCapAmount ?? quote.monthlyFeeCapAmount) },
                    { label: "车辆基础费报价", children: formatYuan(quote.vehicleBaseFeeAmount) },
                    { label: "里程包价格", children: formatYuan(quote.mileagePackagePriceAmount ?? quote.packageSnapshot?.pricing?.mileagePackagePriceAmount) },
                    { label: "补能包价格", children: formatYuan(quote.energyPackagePriceAmount ?? quote.packageSnapshot?.pricing?.energyPackagePriceAmount) },
                    { label: "权益包价格", children: formatYuan(quote.benefitPackagePriceAmount ?? quote.packageSnapshot?.pricing?.benefitPackagePriceAmount) },
                    { label: "套餐月费合计", children: formatYuan(quote.monthlyFeeAmount ?? quote.packageSnapshot?.pricing?.monthlyFeeAmount) },
                    { label: "押金", children: formatYuan(quote.depositAmount) },
                    { label: "违约率", children: formatOptionalRate(quote.depositRuleSnapshot?.defaultRate) }
                  ]}
                />
              </section>
            ) : null}
            {quote.subscriptionPlanId || quote.packageSnapshot ? (
              <section>
                <Typography.Title level={5}>订阅套餐与快照</Typography.Title>
                <Descriptions
                  bordered
                  column={2}
                  items={[
                    {
                      label: "订阅套餐",
                      children:
                        quote.subscriptionPlan
                          ? `${quote.subscriptionPlan.planNo} / ${quote.subscriptionPlan.planName}`
                          : quote.packageSnapshot?.subscriptionPlan
                            ? `${quote.packageSnapshot.subscriptionPlan.planNo ?? "-"} / ${quote.packageSnapshot.subscriptionPlan.planName ?? "-"}`
                            : "-"
                    },
                    { label: "套餐编号", children: quote.subscriptionPlan?.planNo ?? quote.packageSnapshot?.subscriptionPlan?.planNo ?? "-" },
                    {
                      label: "车辆使用费快照",
                      children: quote.packageSnapshot?.vehiclePackage
                        ? `${quote.packageSnapshot.vehiclePackage.packageNo ?? "-"} / ${quote.packageSnapshot.vehiclePackage.packageName ?? "-"} / ${quote.packageSnapshot.vehiclePackage.vehicleModel ?? "-"}`
                        : "-"
                    },
                    {
                      label: "里程包快照",
                      children: quote.packageSnapshot?.mileagePackage
                        ? `${quote.packageSnapshot.mileagePackage.packageNo ?? "-"} / ${quote.packageSnapshot.mileagePackage.packageName ?? "-"} / ${quote.packageSnapshot.mileagePackage.monthlyMileageKm ?? "-"} km`
                        : "-"
                    },
                    {
                      label: "补能包快照",
                      children: quote.packageSnapshot?.energyPackage
                        ? `${quote.packageSnapshot.energyPackage.packageNo ?? "-"} / ${quote.packageSnapshot.energyPackage.packageName ?? "-"} / ${quote.packageSnapshot.energyPackage.monthlyEnergyKwh ?? "-"} kWh / ${quote.packageSnapshot.energyPackage.monthlyEnergyCount ?? "-"} 次`
                        : "-"
                    },
                    {
                      label: "权益包快照",
                      children: quote.packageSnapshot?.benefitPackage
                        ? `${quote.packageSnapshot.benefitPackage.packageNo ?? "-"} / ${quote.packageSnapshot.benefitPackage.packageName ?? "-"} / ${quote.packageSnapshot.benefitPackage.description ?? "-"}`
                        : "-"
                    },
                    {
                      label: "押金规则快照",
                      children: quote.depositRuleSnapshot
                        ? `${quote.depositRuleSnapshot.grade ?? "-"} / ${formatYuan(quote.depositRuleSnapshot.depositAmount)} / ${formatOptionalRate(quote.depositRuleSnapshot.defaultRate)}`
                        : "-"
                    },
                    { label: "月费上限", children: formatYuan(quote.monthlyFeeCapAmount ?? quote.packageSnapshot?.monthlyFeeCapAmount) }
                  ]}
                />
              </section>
            ) : null}
          </Space>
        ) : null}
      </Space>
    </ProtectedShell>
  );
}
