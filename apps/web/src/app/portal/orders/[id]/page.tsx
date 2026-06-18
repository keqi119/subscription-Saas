"use client";

import { ArrowLeftOutlined, FileTextOutlined, GiftOutlined, PayCircleOutlined } from "@ant-design/icons";
import { Alert, App, Button, Descriptions, Empty, Flex, Space, Spin, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  BILL_STATUS_LABELS,
  BILL_TYPE_LABELS,
  ORDER_STATUS_LABELS,
  STATUS_LABELS,
  labelOf
} from "../../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../../lib/portal-api";
import { PortalOrderDetail, PortalPaymentOrder } from "../../../../lib/portal-types";

export default function PortalOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [order, setOrder] = useState<PortalOrderDetail>();
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);

  const loadOrder = useCallback(async () => {
    if (!params.id) {
      return;
    }
    setLoading(true);
    try {
      setOrder(await portalApiFetch<PortalOrderDetail>(`/portal/orders/${params.id}`));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/orders/${params.id}`)}`);
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "无法加载订单详情");
    } finally {
      setLoading(false);
    }
  }, [message, params.id, router]);

  useEffect(() => {
    void loadOrder();
  }, [loadOrder]);

  async function createPaymentOrder() {
    if (!order) {
      return;
    }
    const billIds = order.billingSummary.bills.filter((bill) => bill.canPay).map((bill) => bill.billId);
    if (!billIds.length) {
      void message.info("当前订单暂无待支付账单");
      return;
    }

    setPaying(true);
    try {
      const result = await portalApiFetch<PortalPaymentOrder>("/portal/payment-orders", {
        body: JSON.stringify({ billIds }),
        method: "POST"
      });
      router.push(`/portal/payment-orders/${result.id}`);
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "无法创建支付单");
    } finally {
      setPaying(false);
    }
  }

  if (loading) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: 32 }}>
        <Flex justify="center">
          <Spin />
        </Flex>
      </main>
    );
  }

  if (!order) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: 32 }}>
        <Empty description="订单不存在" />
      </main>
    );
  }

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 900 }}>
        <Flex justify="space-between" style={{ marginBottom: 16 }} wrap="wrap">
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/orders")}>
            返回订单列表
          </Button>
          <Button onClick={() => router.push("/portal")}>返回门户</Button>
        </Flex>

        <section style={sectionStyle}>
          <Flex align="flex-start" justify="space-between" gap={16} wrap="wrap">
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>
                {order.orderNo}
              </Typography.Title>
              <Typography.Text type="secondary">{order.vehicleSummary?.displayName ?? "车辆待确认"}</Typography.Text>
            </div>
            <Space size={[6, 6]} wrap>
              <Tag color="blue">{labelOf(ORDER_STATUS_LABELS, order.orderStatus)}</Tag>
              <Tag>{labelOf(STATUS_LABELS, order.paymentStatus)}</Tag>
            </Space>
          </Flex>
          <Alert message={nextActionText(order.nextAction)} showIcon style={{ marginTop: 16 }} type="info" />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            订单信息
          </Typography.Title>
          <Descriptions
            column={1}
            items={[
              { label: "订单编号", children: order.orderNo },
              { label: "订单状态", children: labelOf(ORDER_STATUS_LABELS, order.orderStatus) },
              { label: "订阅周期", children: `${order.order.periodMonths} 个月` },
              { label: "月租", children: formatMoney(order.order.monthlyFeeAmount) },
              { label: "起租日期", children: order.order.startDate ?? "-" },
              { label: "结束日期", children: order.order.endDate ?? "-" },
              { label: "交付时间", children: formatTime(order.order.actualDeliveryAt) }
            ]}
          />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            车辆与套餐
          </Typography.Title>
          <Descriptions
            column={1}
            items={[
              { label: "车辆", children: order.vehicleSummary?.displayName ?? "-" },
              { label: "城市", children: order.vehicleSummary?.city ?? "-" },
              { label: "当前里程", children: order.vehicleSummary?.currentMileageKm === null || order.vehicleSummary?.currentMileageKm === undefined ? "-" : `${order.vehicleSummary.currentMileageKm.toLocaleString("zh-CN")} km` },
              { label: "套餐", children: order.subscriptionPlanSummary.planName ?? order.subscriptionPlanSummary.productName },
              { label: "里程额度", children: `${order.subscriptionPlanSummary.mileageLimitKm.toLocaleString("zh-CN")} km` },
              { label: "超里程费", children: formatMoney(order.subscriptionPlanSummary.overMileageFeeAmount) }
            ]}
          />
        </section>

        <section style={sectionStyle}>
          <Flex align="center" justify="space-between" gap={12} style={{ marginBottom: 12 }} wrap="wrap">
            <Typography.Title level={4} style={{ margin: 0 }}>
              合同与支付
            </Typography.Title>
            <Space wrap>
              {order.contractSummary ? (
                <Button
                  icon={<FileTextOutlined />}
                  onClick={() => router.push(`/portal/contracts/${order.contractSummary?.contractId}`)}
                >
                  查看合同
                </Button>
              ) : null}
              <Button
                disabled={order.billingSummary.payableBillCount === 0}
                icon={<PayCircleOutlined />}
                loading={paying}
                onClick={createPaymentOrder}
                type="primary"
              >
                去支付
              </Button>
            </Space>
          </Flex>
          <Descriptions
            column={1}
            items={[
              { label: "合同状态", children: order.contractSummary ? labelOf(STATUS_LABELS, order.contractSummary.contractStatus) : "待生成" },
              { label: "应付合计", children: formatMoney(order.billingSummary.totalAmount) },
              { label: "已付合计", children: formatMoney(order.billingSummary.paidAmount) },
              { label: "待付合计", children: formatMoney(order.billingSummary.remainingAmount) },
              { label: "押金余额", children: formatMoney(order.depositSummary.remainingAmount) }
            ]}
          />
        </section>

        <section style={sectionStyle}>
          <Flex align="center" justify="space-between" style={{ marginBottom: 12 }} wrap="wrap">
            <Typography.Title level={4} style={{ margin: 0 }}>
              账单摘要
            </Typography.Title>
            <Button onClick={() => router.push(`/portal/bills?orderId=${encodeURIComponent(order.id)}`)} type="link">
              查看全部账单
            </Button>
          </Flex>
          <Table
            columns={billColumns}
            dataSource={order.billingSummary.bills}
            pagination={false}
            rowKey="billId"
            size="small"
          />
        </section>

        <section style={sectionStyle}>
          <Flex align="center" justify="space-between" style={{ marginBottom: 12 }} wrap="wrap">
            <div>
              <Typography.Title level={4} style={{ margin: 0 }}>
                权益摘要
              </Typography.Title>
              <Typography.Text type="secondary">
                已发放 {order.entitlementSummary.grantCount} 项，可用 {order.entitlementSummary.activeGrantCount} 项
              </Typography.Text>
            </div>
            <Button icon={<GiftOutlined />} onClick={() => router.push(`/portal/entitlements?orderId=${encodeURIComponent(order.id)}`)}>
              查看权益
            </Button>
          </Flex>
        </section>
      </section>
    </main>
  );
}

const billColumns: ColumnsType<PortalOrderDetail["billingSummary"]["bills"][number]> = [
  {
    dataIndex: "billType",
    render: (value: string) => labelOf(BILL_TYPE_LABELS, value),
    title: "类型"
  },
  {
    dataIndex: "billStatus",
    render: (value: string) => labelOf(BILL_STATUS_LABELS, value),
    title: "状态"
  },
  {
    dataIndex: "amount",
    render: (value: number) => formatMoney(value),
    title: "应付"
  },
  {
    dataIndex: "remainingAmount",
    render: (value: number) => formatMoney(value),
    title: "待付"
  }
];

function nextActionText(value: string) {
  const labels: Record<string, string> = {
    NONE: "当前暂无待办事项。",
    PAY_BILL: "存在待支付账单，请完成支付。",
    SIGN_CONTRACT: "合同待签署，请先完成签约。",
    VIEW_ENTITLEMENTS: "订单已进入履约，可查看权益余额。",
    WAIT_DELIVERY: "平台正在安排车辆交付。"
  };
  return labels[value] ?? value;
}

function formatMoney(amount?: number | null) {
  return amount === null || amount === undefined
    ? "-"
    : `${(amount / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} 元`;
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

const sectionStyle = {
  background: "#ffffff",
  border: "1px solid #e5eaf2",
  borderRadius: 8,
  marginBottom: 14,
  padding: 18
};
