"use client";

import { ArrowLeftOutlined, PayCircleOutlined } from "@ant-design/icons";
import { Alert, App, Button, Descriptions, Empty, Flex, Space, Spin, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { BILL_STATUS_LABELS, BILL_TYPE_LABELS, labelOf } from "../../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../../lib/portal-api";
import { PortalBillDetail, PortalPaymentOrder } from "../../../../lib/portal-types";
import { PortalPaymentOrderRecords, PortalWriteOffRecords } from "./bill-records";

export default function PortalBillDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [bill, setBill] = useState<PortalBillDetail>();
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);

  const loadBill = useCallback(async () => {
    if (!params.id) {
      return;
    }
    setLoading(true);
    try {
      setBill(await portalApiFetch<PortalBillDetail>(`/portal/bills/${params.id}`));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(
          `/portal/login?redirect=${encodeURIComponent(`/portal/bills/${params.id}`)}`
        );
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "无法加载账单详情");
    } finally {
      setLoading(false);
    }
  }, [message, params.id, router]);

  useEffect(() => {
    void loadBill();
  }, [loadBill]);

  async function payBill() {
    if (!bill) {
      return;
    }
    setPaying(true);
    try {
      const result = await portalApiFetch<PortalPaymentOrder>("/portal/payment-orders", {
        body: JSON.stringify({ billIds: [bill.billId] }),
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

  if (!bill) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: 32 }}>
        <Empty description="账单不存在" />
      </main>
    );
  }

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 900 }}>
        <Flex justify="space-between" style={{ marginBottom: 16 }} wrap="wrap">
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/bills")}>
            返回账单列表
          </Button>
          <Button onClick={() => router.push("/portal")}>返回门户</Button>
        </Flex>

        <section style={sectionStyle}>
          <Flex align="flex-start" justify="space-between" gap={16} wrap="wrap">
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>
                {bill.billNo}
              </Typography.Title>
              <Typography.Text type="secondary">订单 {bill.orderNo}</Typography.Text>
            </div>
            <Space size={[6, 6]} wrap>
              <Tag color={bill.canPay ? "orange" : "green"}>
                {labelOf(BILL_STATUS_LABELS, bill.billStatus)}
              </Tag>
              <Tag>{labelOf(BILL_TYPE_LABELS, bill.billType)}</Tag>
            </Space>
          </Flex>
        </section>

        <Alert
          description="系统会按账期生成账单并发送到期、逾期提醒；请在账单页面主动完成微信支付。"
          message="账单提醒 + 主动支付"
          showIcon
          style={{ marginBottom: 14 }}
          type="info"
        />

        <section style={sectionStyle}>
          <Flex
            align="center"
            justify="space-between"
            gap={12}
            style={{ marginBottom: 12 }}
            wrap="wrap"
          >
            <Typography.Title level={4} style={{ margin: 0 }}>
              账单详情
            </Typography.Title>
            <Button
              disabled={!bill.canPay}
              icon={<PayCircleOutlined />}
              loading={paying}
              onClick={payBill}
              type="primary"
            >
              去支付
            </Button>
          </Flex>
          <Descriptions
            column={1}
            items={[
              { label: "账单编号", children: bill.billNo },
              { label: "账单类型", children: labelOf(BILL_TYPE_LABELS, bill.billType) },
              { label: "账单状态", children: labelOf(BILL_STATUS_LABELS, bill.billStatus) },
              { label: "应付金额", children: formatMoney(bill.amount) },
              { label: "已付金额", children: formatMoney(bill.paidAmount) },
              { label: "待付金额", children: formatMoney(bill.remainingAmount) },
              { label: "账期", children: `${bill.periodStart ?? "-"} 至 ${bill.periodEnd ?? "-"}` },
              { label: "到期日", children: formatTime(bill.dueDate) }
            ]}
          />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            支付单
          </Typography.Title>
          <PortalPaymentOrderRecords rows={bill.paymentOrders} />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            核销记录
          </Typography.Title>
          <PortalWriteOffRecords rows={bill.writeOffs} />
        </section>
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

const sectionStyle = {
  background: "#ffffff",
  border: "1px solid #e5eaf2",
  borderRadius: 8,
  marginBottom: 14,
  padding: 18
};
