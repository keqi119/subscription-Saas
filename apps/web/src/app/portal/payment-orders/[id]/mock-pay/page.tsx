"use client";

import { ArrowLeftOutlined, CheckCircleOutlined, PayCircleOutlined } from "@ant-design/icons";
import { Alert, App, Button, Descriptions, Flex, Space, Spin, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { BILL_TYPE_LABELS, PAYMENT_ORDER_STATUS_LABELS, labelOf } from "../../../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../../../lib/portal-api";
import { PortalPaymentOrder, PortalPaymentOrderItem } from "../../../../../lib/portal-types";

export default function PortalMockPaymentPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [paymentOrder, setPaymentOrder] = useState<PortalPaymentOrder>();
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);

  const loadPaymentOrder = useCallback(async () => {
    if (!params.id) {
      return;
    }

    setLoading(true);
    try {
      setPaymentOrder(await portalApiFetch<PortalPaymentOrder>(`/portal/payment-orders/${params.id}`));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/payment-orders/${params.id}/mock-pay`)}`);
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "无法加载支付单");
    } finally {
      setLoading(false);
    }
  }, [message, params.id, router]);

  useEffect(() => {
    void loadPaymentOrder();
  }, [loadPaymentOrder]);

  async function mockPay() {
    if (!paymentOrder) {
      return;
    }

    setPaying(true);
    try {
      const result = await portalApiFetch<PortalPaymentOrder>(
        `/portal/payment-orders/${paymentOrder.id}/mock-pay`,
        { method: "POST" }
      );
      setPaymentOrder(result);
      void message.success("模拟支付完成");
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "模拟支付失败");
    } finally {
      setPaying(false);
    }
  }

  if (loading || !paymentOrder) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: 32 }}>
        <Flex justify="center">
          <Spin />
        </Flex>
      </main>
    );
  }

  const paid = paymentOrder.paymentStatus === "PAID";

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 760 }}>
        <Flex justify="space-between" style={{ marginBottom: 16 }} wrap="wrap">
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push(`/portal/payment-orders/${paymentOrder.id}`)}>
            返回支付单
          </Button>
          <Button onClick={() => router.push("/portal")}>返回门户</Button>
        </Flex>

        <section style={sectionStyle}>
          <Typography.Title level={2} style={{ marginTop: 0 }}>
            模拟支付
          </Typography.Title>
          <Alert
            message="当前为 Mock 支付，仅用于测试；真实微信支付接入后将跳转微信收银台。"
            showIcon
            style={{ marginBottom: 16 }}
            type="warning"
          />
          {paid ? (
            <Alert message="支付已完成，账单已自动核销。" showIcon style={{ marginBottom: 16 }} type="success" />
          ) : null}
          <Descriptions
            column={1}
            items={[
              { label: "支付单号", children: paymentOrder.paymentOrderNo },
              { label: "支付状态", children: labelOf(PAYMENT_ORDER_STATUS_LABELS, paymentOrder.paymentStatus) },
              { label: "支付金额", children: formatMoney(paymentOrder.amount) },
              { label: "创建时间", children: formatTime(paymentOrder.createdAt) },
              { label: "支付时间", children: formatTime(paymentOrder.paidAt) }
            ]}
          />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            账单列表
          </Typography.Title>
          <Table columns={columns} dataSource={paymentOrder.items} pagination={false} rowKey="id" size="small" />
        </section>

        <section style={sectionStyle}>
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Button
              block
              disabled={paid}
              icon={paid ? <CheckCircleOutlined /> : <PayCircleOutlined />}
              loading={paying}
              onClick={mockPay}
              size="large"
              type="primary"
            >
              {paid ? "已完成支付" : "确认模拟支付"}
            </Button>
            <Button block onClick={() => router.push(`/portal/payment-orders/${paymentOrder.id}`)}>
              查看支付单详情
            </Button>
          </Space>
        </section>
      </section>
    </main>
  );
}

const columns: ColumnsType<PortalPaymentOrderItem> = [
  {
    dataIndex: "billNo",
    title: "账单编号"
  },
  {
    dataIndex: "billType",
    render: (value: string) => labelOf(BILL_TYPE_LABELS, value),
    title: "类型"
  },
  {
    dataIndex: "amount",
    render: (value: number) => formatMoney(value),
    title: "本次支付"
  }
];

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
