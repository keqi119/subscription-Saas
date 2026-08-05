"use client";

import { ArrowLeftOutlined } from "@ant-design/icons";
import { App, Button, Empty, Flex, List, Typography } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { buildPortalAutoDebitView } from "../../../lib/portal-auto-debit-view-model";
import {
  getPortalAutoDebitAvailability,
  getPortalDebitAttempts,
  getPortalPaymentMandates,
  PortalApiError,
  portalApiFetch
} from "../../../lib/portal-api";
import {
  PortalAutoDebitAvailability,
  PortalBillListItem,
  PortalDebitAttempt,
  PortalPagedResponse,
  PortalPaymentMandate,
  PortalPaymentOrder
} from "../../../lib/portal-types";
import { PortalBillCard } from "./portal-bill-card";

function PortalBillsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const [bills, setBills] = useState<PortalBillListItem[]>([]);
  const [availability, setAvailability] = useState<PortalAutoDebitAvailability>();
  const [mandates, setMandates] = useState<PortalPaymentMandate[]>([]);
  const [attempts, setAttempts] = useState<PortalDebitAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [payingBillId, setPayingBillId] = useState<string>();
  const orderId = searchParams.get("orderId");
  const path = useMemo(
    () => `/portal/bills${orderId ? `?orderId=${encodeURIComponent(orderId)}` : ""}`,
    [orderId]
  );

  useEffect(() => {
    Promise.all([
      portalApiFetch<PortalPagedResponse<PortalBillListItem>>(path),
      getPortalAutoDebitAvailability(),
      getPortalPaymentMandates(orderId ?? undefined),
      getPortalDebitAttempts(orderId ? { orderId } : undefined)
    ])
      .then(([result, nextAvailability, nextMandates, nextAttempts]) => {
        setBills(result.items);
        setAvailability(nextAvailability);
        setMandates(nextMandates);
        setAttempts(nextAttempts);
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

        <List
          dataSource={bills}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无账单" /> }}
          renderItem={(bill) => (
            <PortalBillCard
              autoDebit={
                availability
                  ? buildPortalAutoDebitView({
                      attempt:
                        attempts.find((item) => item.billId === bill.billId) ??
                        attempts.find((item) => item.orderId === bill.orderId),
                      availability,
                      bill,
                      mandate: mandates.find((item) => item.orderId === bill.orderId)
                    })
                  : undefined
              }
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
