"use client";

import { ArrowLeftOutlined, FileTextOutlined, PayCircleOutlined } from "@ant-design/icons";
import { App, Button, Empty, Flex, List, Space, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { BILL_STATUS_LABELS, BILL_TYPE_LABELS, labelOf } from "../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import { PortalBillListItem, PortalPagedResponse, PortalPaymentOrder } from "../../../lib/portal-types";

export default function PortalBillsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const [bills, setBills] = useState<PortalBillListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [payingBillId, setPayingBillId] = useState<string>();
  const orderId = searchParams.get("orderId");
  const path = useMemo(
    () => `/portal/bills${orderId ? `?orderId=${encodeURIComponent(orderId)}` : ""}`,
    [orderId]
  );

  useEffect(() => {
    portalApiFetch<PortalPagedResponse<PortalBillListItem>>(path)
      .then((result) => setBills(result.items))
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace(`/portal/login?redirect=${encodeURIComponent(path)}`);
          return;
        }
        void message.error(error instanceof PortalApiError ? error.message : "无法加载账单列表");
      })
      .finally(() => setLoading(false));
  }, [message, path, router]);

  async function payBill(bill: PortalBillListItem) {
    setPayingBillId(bill.billId);
    try {
      const result = await portalApiFetch<PortalPaymentOrder>("/portal/payment-orders", {
        body: JSON.stringify({ billIds: [bill.billId] }),
        method: "POST"
      });
      router.push(`/portal/payment-orders/${result.id}`);
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "无法创建支付单");
    } finally {
      setPayingBillId(undefined);
    }
  }

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
      <section style={{ margin: "0 auto", maxWidth: 860 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 18 }}>
          <div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal")} style={{ marginBottom: 12 }}>
              返回门户
            </Button>
            <Typography.Title level={2} style={{ margin: 0 }}>
              我的账单
            </Typography.Title>
            <Typography.Text type="secondary">查看待支付、已支付和逾期账单</Typography.Text>
          </div>
        </Flex>

        <List
          dataSource={bills}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无账单" /> }}
          renderItem={(bill) => (
            <List.Item
              actions={[
                bill.canPay ? (
                  <Button
                    icon={<PayCircleOutlined />}
                    key="pay"
                    loading={payingBillId === bill.billId}
                    onClick={() => void payBill(bill)}
                    type="link"
                  >
                    去支付
                  </Button>
                ) : null,
                <Button key="detail" onClick={() => router.push(`/portal/bills/${bill.billId}`)} type="link">
                  查看详情
                </Button>
              ].filter(Boolean)}
              style={{
                background: "#ffffff",
                border: "1px solid #e5eaf2",
                borderRadius: 8,
                marginBottom: 12,
                padding: 16
              }}
            >
              <List.Item.Meta
                avatar={<FileTextOutlined style={{ color: "#1677ff", fontSize: 26, marginTop: 4 }} />}
                description={
                  <Space direction="vertical" size={8}>
                    <Typography.Text type="secondary">
                      订单 {bill.orderNo} · 到期 {formatTime(bill.dueDate)}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      应付 {formatMoney(bill.amount)} · 待付 {formatMoney(bill.remainingAmount)}
                    </Typography.Text>
                    <Space size={[6, 6]} wrap>
                      <Tag color={bill.canPay ? "orange" : "green"}>{labelOf(BILL_STATUS_LABELS, bill.billStatus)}</Tag>
                      <Tag>{labelOf(BILL_TYPE_LABELS, bill.billType)}</Tag>
                    </Space>
                  </Space>
                }
                title={<Typography.Text strong>{bill.billNo}</Typography.Text>}
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
  return value ? dayjs(value).format("YYYY-MM-DD") : "-";
}
