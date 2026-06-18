"use client";

import { ArrowLeftOutlined, PayCircleOutlined } from "@ant-design/icons";
import { App, Button, Empty, Flex, List, Space, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  PAYMENT_CHANNEL_LABELS,
  PAYMENT_ORDER_STATUS_LABELS,
  PAYMENT_PROVIDER_LABELS,
  labelOf
} from "../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import { PortalPagedResponse, PortalPaymentOrder } from "../../../lib/portal-types";

export default function PortalPaymentOrdersPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [paymentOrders, setPaymentOrders] = useState<PortalPaymentOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    portalApiFetch<PortalPagedResponse<PortalPaymentOrder>>("/portal/payment-orders")
      .then((result) => setPaymentOrders(result.items))
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/payment-orders")}`);
          return;
        }
        void message.error(error instanceof PortalApiError ? error.message : "无法加载支付记录");
      })
      .finally(() => setLoading(false));
  }, [message, router]);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
      <section style={{ margin: "0 auto", maxWidth: 860 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 18 }}>
          <div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal")} style={{ marginBottom: 12 }}>
              返回门户
            </Button>
            <Typography.Title level={2} style={{ margin: 0 }}>
              支付记录
            </Typography.Title>
            <Typography.Text type="secondary">查看线上支付单、渠道和支付结果</Typography.Text>
          </div>
        </Flex>

        <List
          dataSource={paymentOrders}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无支付记录" /> }}
          renderItem={(paymentOrder) => (
            <List.Item
              actions={[
                <Button
                  key="detail"
                  onClick={() => router.push(`/portal/payment-orders/${paymentOrder.id}`)}
                  type="link"
                >
                  查看详情
                </Button>
              ]}
              style={{
                background: "#ffffff",
                border: "1px solid #e5eaf2",
                borderRadius: 8,
                marginBottom: 12,
                padding: 16
              }}
            >
              <List.Item.Meta
                avatar={<PayCircleOutlined style={{ color: "#1677ff", fontSize: 26, marginTop: 4 }} />}
                description={
                  <Space direction="vertical" size={8}>
                    <Typography.Text type="secondary">
                      订单 {paymentOrder.orderNo ?? "-"} · 创建 {formatTime(paymentOrder.createdAt)}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      金额 {formatMoney(paymentOrder.amount)} · 已付 {formatMoney(paymentOrder.paidAmount)}
                    </Typography.Text>
                    <Space size={[6, 6]} wrap>
                      <Tag color={paymentOrder.paymentStatus === "PAID" ? "green" : "blue"}>
                        {labelOf(PAYMENT_ORDER_STATUS_LABELS, paymentOrder.paymentStatus)}
                      </Tag>
                      <Tag>{labelOf(PAYMENT_PROVIDER_LABELS, paymentOrder.provider)}</Tag>
                      <Tag>{labelOf(PAYMENT_CHANNEL_LABELS, paymentOrder.paymentChannel)}</Tag>
                    </Space>
                  </Space>
                }
                title={<Typography.Text strong>{paymentOrder.paymentOrderNo}</Typography.Text>}
              />
            </List.Item>
          )}
        />
      </section>
    </main>
  );
}

function formatMoney(amount?: number | null) {
  return amount === null || amount === undefined
    ? "-"
    : `${(amount / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} 元`;
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}
