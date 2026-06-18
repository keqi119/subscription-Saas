"use client";

import { ArrowLeftOutlined, ProfileOutlined } from "@ant-design/icons";
import { App, Button, Empty, Flex, List, Space, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ORDER_STATUS_LABELS, STATUS_LABELS, labelOf } from "../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import { PortalOrderListItem, PortalPagedResponse } from "../../../lib/portal-types";

export default function PortalOrdersPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [orders, setOrders] = useState<PortalOrderListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    portalApiFetch<PortalPagedResponse<PortalOrderListItem>>("/portal/orders")
      .then((result) => setOrders(result.items))
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/orders")}`);
          return;
        }
        void message.error(error instanceof PortalApiError ? error.message : "无法加载订单列表");
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
              我的订单
            </Typography.Title>
            <Typography.Text type="secondary">查看订阅订单、合同、账单和交付进度</Typography.Text>
          </div>
        </Flex>

        <List
          dataSource={orders}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无订单" /> }}
          renderItem={(order) => (
            <List.Item
              actions={[
                <Button key="detail" onClick={() => router.push(`/portal/orders/${order.id}`)} type="link">
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
                avatar={<ProfileOutlined style={{ color: "#1677ff", fontSize: 26, marginTop: 4 }} />}
                description={
                  <Space direction="vertical" size={8}>
                    <Typography.Text type="secondary">
                      {order.vehicleSummary?.displayName ?? "车辆待确认"} · {order.subscriptionPlanSummary.planName ?? "订阅套餐"}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      创建时间 {formatTime(order.createdAt)} · 待付 {formatMoney(order.remainingAmount)}
                    </Typography.Text>
                    <Space size={[6, 6]} wrap>
                      <Tag color="blue">{labelOf(ORDER_STATUS_LABELS, order.orderStatus)}</Tag>
                      <Tag>{labelOf(STATUS_LABELS, order.paymentStatus)}</Tag>
                      {order.contractStatus ? <Tag>{labelOf(STATUS_LABELS, order.contractStatus)}</Tag> : null}
                    </Space>
                  </Space>
                }
                title={<Typography.Text strong>{order.orderNo}</Typography.Text>}
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
