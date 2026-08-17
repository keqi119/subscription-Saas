"use client";

import { ArrowLeftOutlined } from "@ant-design/icons";
import { Alert, App, Button, Empty, Flex, List, Typography } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import {
  PortalBillListItem,
  PortalPagedResponse,
  PortalPaymentOrder
} from "../../../lib/portal-types";
import { PortalBillCard } from "./portal-bill-card";

function PortalBillsContent() {
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
      .then((result) => {
        setBills(result.items);
      })
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
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => router.push("/portal")}
              style={{ marginBottom: 12 }}
            >
              返回门户
            </Button>
            <Typography.Title level={2} style={{ margin: 0 }}>
              我的账单
            </Typography.Title>
            <Typography.Text type="secondary">查看待支付、已支付和逾期账单</Typography.Text>
          </div>
        </Flex>

        <Alert
          description="系统会按账期生成账单并发送到期、逾期提醒；请在账单页面主动完成微信支付。"
          message="账单提醒 + 主动支付"
          showIcon
          style={{ marginBottom: 16 }}
          type="info"
        />

        <List
          dataSource={bills}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无账单" /> }}
          renderItem={(bill) => (
            <PortalBillCard
              bill={bill}
              onDetails={(item) => router.push(`/portal/bills/${item.billId}`)}
              onPay={(item) => void payBill(item)}
              paying={payingBillId === bill.billId}
            />
          )}
          split={false}
        />
      </section>
    </main>
  );
}

export default function PortalBillsPage() {
  return (
    <Suspense
      fallback={
        <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
          <section style={{ margin: "0 auto", maxWidth: 860 }}>
            <Typography.Text type="secondary">正在加载...</Typography.Text>
          </section>
        </main>
      }
    >
      <PortalBillsContent />
    </Suspense>
  );
}
