"use client";

import { ArrowLeftOutlined, CheckCircleOutlined, PayCircleOutlined } from "@ant-design/icons";
import { Alert, App, Button, Descriptions, Empty, Flex, Space, Spin, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  BILL_STATUS_LABELS,
  BILL_TYPE_LABELS,
  ORDER_STATUS_LABELS,
  PAYMENT_CHANNEL_LABELS,
  PAYMENT_ORDER_STATUS_LABELS,
  PAYMENT_PROVIDER_LABELS,
  labelOf
} from "../../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../../lib/portal-api";
import { PortalPaymentOrder, PortalPaymentOrderItem, PortalWeChatJsapiParams } from "../../../../lib/portal-types";

declare global {
  interface Window {
    WeixinJSBridge?: {
      invoke: (
        name: "getBrandWCPayRequest",
        params: PortalWeChatJsapiParams,
        callback: (response: { err_msg?: string }) => void
      ) => void;
    };
  }
}

export default function PortalPaymentOrderPage() {
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
        router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/payment-orders/${params.id}`)}`);
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

  async function startPayment() {
    if (!paymentOrder) {
      return;
    }

    setPaying(true);
    try {
      const result = await portalApiFetch<PortalPaymentOrder>(
        `/portal/payment-orders/${paymentOrder.id}/pay`,
        { method: "POST" }
      );
      setPaymentOrder(result);
      if (result.paymentStatus === "PAID") {
        void message.success("支付单已支付");
        return;
      }
      if (result.paymentChannel === "MOCK") {
        router.push(`/portal/payment-orders/${result.id}/mock-pay`);
        return;
      }
      if (result.requiresWechatBinding && result.wechatAuthUrl) {
        window.location.assign(result.wechatAuthUrl);
        return;
      }
      if (result.paymentChannel === "WECHAT_JSAPI") {
        if (!isWeChatBrowser()) {
          void message.warning("请在微信中打开页面完成支付。");
          return;
        }
        if (!result.jsapiParams) {
          void message.warning("微信支付参数暂不可用，请稍后重试。");
          return;
        }
        await invokeWeChatPay(result.jsapiParams);
        void message.success("微信支付已提交，请稍后查看支付结果。");
        window.setTimeout(() => {
          void loadPaymentOrder();
        }, 1500);
        return;
      }
      if (result.cashierUrl) {
        window.location.assign(result.cashierUrl);
        return;
      }
      void message.warning("支付链接暂不可用，请稍后重试");
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "无法发起支付");
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

  if (!paymentOrder) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: 32 }}>
        <Empty description="支付单不存在" />
      </main>
    );
  }

  const canStartPayment = isPaymentOrderPayable(paymentOrder);
  const paymentActionText = canStartPayment
    ? paymentOrder.paymentChannel === "MOCK"
      ? "模拟支付"
      : paymentOrder.paymentChannel === "WECHAT_JSAPI"
        ? "微信支付"
        : "去支付"
    : paymentOrder.paymentStatus === "PAID"
      ? "已支付"
      : "不可继续支付";

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 860 }}>
        <Flex justify="space-between" style={{ marginBottom: 16 }} wrap="wrap">
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.back()}>
            返回
          </Button>
          <Button onClick={() => router.push("/portal")}>返回门户</Button>
        </Flex>

        <section style={sectionStyle}>
          <Flex align="flex-start" justify="space-between" gap={16} wrap="wrap">
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>
                {paymentOrder.paymentOrderNo}
              </Typography.Title>
              <Typography.Text type="secondary">{paymentOrder.subject ?? "账单支付"}</Typography.Text>
            </div>
            <Space size={[6, 6]} wrap>
              <Tag color={paymentOrder.paymentStatus === "PAID" ? "green" : "blue"}>
                {labelOf(PAYMENT_ORDER_STATUS_LABELS, paymentOrder.paymentStatus)}
              </Tag>
              <Tag>{labelOf(PAYMENT_CHANNEL_LABELS, paymentOrder.paymentChannel)}</Tag>
            </Space>
          </Flex>

          {paymentOrder.paymentStatus === "PAID" ? (
            <Alert
              message="支付已完成，系统已登记收款并核销对应账单。"
              showIcon
              style={{ marginTop: 16 }}
              type="success"
            />
          ) : !canStartPayment ? (
            <Alert
              message="当前支付单状态或账单状态不允许继续支付。请返回账单或支付记录查看最新状态。"
              showIcon
              style={{ marginTop: 16 }}
              type="warning"
            />
          ) : (
            <Alert
              message={paymentOrder.paymentChannel === "MOCK"
                ? "当前为模拟支付，用于测试客户线上支付闭环。"
                : paymentOrder.paymentChannel === "WECHAT_JSAPI"
                  ? "请在微信内置浏览器中完成 JSAPI 支付。"
                  : "请在支付链接有效期内完成付款。"}
              showIcon
              style={{ marginTop: 16 }}
              type="info"
            />
          )}
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            支付摘要
          </Typography.Title>
          <Descriptions
            column={1}
            items={[
              { label: "订单编号", children: paymentOrder.orderNo ?? "-" },
              { label: "订单状态", children: labelOf(ORDER_STATUS_LABELS, paymentOrder.orderStatus) },
              { label: "支付服务商", children: labelOf(PAYMENT_PROVIDER_LABELS, paymentOrder.provider) },
              { label: "支付通道", children: labelOf(PAYMENT_CHANNEL_LABELS, paymentOrder.paymentChannel) },
              { label: "支付金额", children: formatMoney(paymentOrder.amount) },
              { label: "已付金额", children: formatMoney(paymentOrder.paidAmount) },
              { label: "支付时间", children: formatTime(paymentOrder.paidAt) },
              { label: "支付链接有效期", children: formatTime(paymentOrder.cashierUrlExpiresAt) },
              { label: "收款记录", children: paymentOrder.paymentRecord?.paymentNo ?? "-" }
            ]}
          />
        </section>

        <section style={sectionStyle}>
          <Flex align="center" justify="space-between" gap={12} style={{ marginBottom: 12 }} wrap="wrap">
            <Typography.Title level={4} style={{ margin: 0 }}>
              账单明细
            </Typography.Title>
            <Button
              disabled={!canStartPayment}
              icon={canStartPayment ? <PayCircleOutlined /> : <CheckCircleOutlined />}
              loading={paying}
              onClick={startPayment}
              type="primary"
            >
              {paymentActionText}
            </Button>
          </Flex>
          <Table columns={columns} dataSource={paymentOrder.items} pagination={false} rowKey="id" size="small" />
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
  },
  {
    dataIndex: "dueDate",
    render: (value: string | null) => formatTime(value),
    title: "到期日"
  }
];

function isWeChatBrowser() {
  return /MicroMessenger/i.test(window.navigator.userAgent);
}

function invokeWeChatPay(params: PortalWeChatJsapiParams) {
  return new Promise<void>((resolve, reject) => {
    const invoke = () => {
      if (!window.WeixinJSBridge) {
        reject(new Error("WECHAT_BRIDGE_NOT_READY"));
        return;
      }
      window.WeixinJSBridge.invoke("getBrandWCPayRequest", params, (response) => {
        if (response.err_msg === "get_brand_wcpay_request:ok") {
          resolve();
          return;
        }
        reject(new Error(response.err_msg ?? "WECHAT_PAY_CANCELLED"));
      });
    };

    if (window.WeixinJSBridge) {
      invoke();
      return;
    }

    document.addEventListener("WeixinJSBridgeReady", invoke, { once: true });
  });
}

const PAYABLE_PAYMENT_ORDER_STATUSES = new Set(["CREATED", "PENDING"]);
const PAYABLE_BILL_STATUSES = new Set(["PENDING", "PARTIALLY_PAID", "OVERDUE"]);

function isPaymentOrderPayable(paymentOrder: PortalPaymentOrder) {
  return PAYABLE_PAYMENT_ORDER_STATUSES.has(paymentOrder.paymentStatus) &&
    paymentOrder.items.some((item) => PAYABLE_BILL_STATUSES.has(item.billStatus) && item.remainingAmount > 0);
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
