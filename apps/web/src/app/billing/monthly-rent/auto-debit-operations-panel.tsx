"use client";

import { Alert, Button, Card, Descriptions, Empty, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import Link from "next/link";

import {
  autoDebitAttemptStatusView,
  autoDebitMandateStatusView
} from "../../../lib/billing-automation-view-model";

export interface AdminPaymentMandate {
  customer: { customerNo: string; name: string } | null;
  effectiveAt: string | null;
  expiresAt: string | null;
  id: string;
  lastSyncedAt: string | null;
  mandateNo: string;
  order: { orderNo: string } | null;
  orderId: string;
  providerMode: string;
  revokedAt: string | null;
  signedAt: string | null;
  status: string;
}

export interface AdminAutoDebitAttempt {
  bill: { billNo: string; remainingAmount: string };
  billId: string;
  createdAt: string;
  customer: { customerNo: string; name: string } | null;
  debitAttemptNo: string;
  id: string;
  mandate: { mandateNo: string; providerMode: string };
  order: { orderNo: string } | null;
  orderId: string;
  paymentOrder: {
    paymentOrderNo: string;
    paymentStatus: string;
    providerTransactionId: string | null;
    paymentRecord?: {
      paymentNo: string;
      paymentStatus: string;
      writeOffs: Array<{
        billId: string;
        writeOffAmount: string;
        writeOffAt: string;
      }>;
    } | null;
  };
  requestedAmount: string;
  retrySlot: string;
  status: string;
}

export function AutoDebitOperationsPanel({
  attempts,
  canExecute,
  canManage,
  loading,
  mandates,
  onManualDebit,
  onMockResult,
  onQueryAttempt,
  onRevokeMandate,
  onSyncMandate
}: {
  attempts: AdminAutoDebitAttempt[];
  canExecute: boolean;
  canManage: boolean;
  loading: boolean;
  mandates: AdminPaymentMandate[];
  onManualDebit: (attempt: AdminAutoDebitAttempt) => void;
  onMockResult: (attempt: AdminAutoDebitAttempt) => void;
  onQueryAttempt: (attempt: AdminAutoDebitAttempt) => void;
  onRevokeMandate: (mandate: AdminPaymentMandate) => void;
  onSyncMandate: (mandate: AdminPaymentMandate) => void;
}) {
  const mockMode =
    mandates.some((item) => item.providerMode === "mock") ||
    attempts.some((item) => item.mandate.providerMode === "mock");

  const mandateColumns: ColumnsType<AdminPaymentMandate> = [
    {
      dataIndex: "mandateNo",
      title: "授权编号",
      width: 190
    },
    {
      render: (_, record) => (
        <Link href={`/orders/${record.orderId}?tab=finance`}>
          {record.order?.orderNo ?? record.orderId}
        </Link>
      ),
      title: "订单",
      width: 190
    },
    {
      render: (_, record) =>
        record.customer ? `${record.customer.name} / ${record.customer.customerNo}` : "-",
      title: "客户",
      width: 170
    },
    {
      dataIndex: "status",
      render: (value: string) => {
        const status = autoDebitMandateStatusView(value);
        return <Tag color={status.color}>{status.label}</Tag>;
      },
      title: "状态",
      width: 100
    },
    {
      dataIndex: "signedAt",
      render: formatTime,
      title: "签约时间",
      width: 160
    },
    {
      dataIndex: "lastSyncedAt",
      render: formatTime,
      title: "最近同步",
      width: 160
    },
    {
      fixed: "right",
      render: (_, record) =>
        canManage && ["PENDING", "ACTIVE", "SUSPENDED"].includes(record.status) ? (
          <Space size={4}>
            <Button onClick={() => onSyncMandate(record)} size="small">
              同步授权
            </Button>
            <Button danger onClick={() => onRevokeMandate(record)} size="small">
              关闭授权
            </Button>
          </Space>
        ) : (
          "-"
        ),
      title: "操作",
      width: 190
    }
  ];

  const attemptColumns: ColumnsType<AdminAutoDebitAttempt> = [
    { dataIndex: "debitAttemptNo", title: "扣款尝试", width: 190 },
    {
      render: (_, record) => (
        <Link href={`/orders/${record.orderId}?tab=finance&focus=${record.id}`}>
          {record.order?.orderNo ?? record.orderId}
        </Link>
      ),
      title: "订单",
      width: 190
    },
    {
      render: (_, record) => `${record.bill.billNo} / ${formatFen(record.requestedAmount)}`,
      title: "账单 / 金额",
      width: 220
    },
    {
      dataIndex: "status",
      render: (value: string) => {
        const status = autoDebitAttemptStatusView(value);
        return <Tag color={status.color}>{status.label}</Tag>;
      },
      title: "状态",
      width: 110
    },
    { dataIndex: "retrySlot", title: "轮次", width: 80 },
    {
      render: (_, record) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text>{record.paymentOrder.paymentOrderNo}</Typography.Text>
          <Typography.Text type="secondary">{record.paymentOrder.paymentStatus}</Typography.Text>
        </Space>
      ),
      title: "支付单",
      width: 190
    },
    {
      render: (_, record) =>
        record.paymentOrder.paymentRecord ? (
          <Space orientation="vertical" size={0}>
            <Typography.Text>{record.paymentOrder.paymentRecord.paymentNo}</Typography.Text>
            <Typography.Text type="secondary">
              核销 {record.paymentOrder.paymentRecord.writeOffs.length} 笔
            </Typography.Text>
          </Space>
        ) : (
          "-"
        ),
      title: "收款 / 核销",
      width: 180
    },
    { dataIndex: "createdAt", render: formatTime, title: "创建时间", width: 160 },
    {
      fixed: "right",
      render: (_, record) => {
        if (!canExecute) {
          return "-";
        }
        if (record.status === "UNKNOWN") {
          return (
            <Space size={4}>
              <Button onClick={() => onQueryAttempt(record)} size="small" type="primary">
                查询结果
              </Button>
              {record.mandate.providerMode === "mock" ? (
                <Button onClick={() => onMockResult(record)} size="small">
                  设置模拟结果
                </Button>
              ) : null}
            </Space>
          );
        }
        if (record.mandate.providerMode === "mock" && record.status === "PROCESSING") {
          return (
            <Button onClick={() => onMockResult(record)} size="small">
              设置模拟结果
            </Button>
          );
        }
        if (["FAILED_RETRYABLE", "FAILED_FINAL", "CANCELLED"].includes(record.status)) {
          return (
            <Button onClick={() => onManualDebit(record)} size="small" type="primary">
              人工扣款
            </Button>
          );
        }
        return "-";
      },
      title: "操作",
      width: 210
    }
  ];

  return (
    <Card title="自动扣款授权与尝试">
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        {mockMode ? (
          <Alert message="STAGING MOCK，不会发生真实扣款" showIcon type="warning" />
        ) : null}
        <Table
          columns={mandateColumns}
          dataSource={mandates}
          loading={loading}
          pagination={false}
          rowKey="id"
          scroll={{ x: 1200 }}
          size="small"
          title={() => "支付授权"}
        />
        <Table
          columns={attemptColumns}
          dataSource={attempts}
          loading={loading}
          pagination={false}
          rowKey="id"
          scroll={{ x: 1550 }}
          size="small"
          title={() => "扣款尝试与结算链路"}
        />
      </Space>
    </Card>
  );
}

export function OrderAutoDebitTracePanel({
  attempts,
  loading,
  mandates
}: {
  attempts: AdminAutoDebitAttempt[];
  loading: boolean;
  mandates: AdminPaymentMandate[];
}) {
  const mandate = mandates[0];
  return (
    <Card
      extra={<Link href="/billing/monthly-rent">进入自动扣款操作台</Link>}
      loading={loading}
      title="自动扣款结算追踪"
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "支付授权", children: mandate?.mandateNo ?? "尚无授权" },
            {
              label: "授权状态",
              children: mandate ? autoDebitMandateStatusView(mandate.status).label : "-"
            },
            { label: "签约时间", children: formatTime(mandate?.signedAt) },
            { label: "最近同步", children: formatTime(mandate?.lastSyncedAt) }
          ]}
          size="small"
        />
        {attempts.length ? (
          <Space orientation="vertical" size={10} style={{ width: "100%" }}>
            {attempts.map((attempt) => {
              const paymentRecord = attempt.paymentOrder.paymentRecord;
              const status = autoDebitAttemptStatusView(attempt.status);
              return (
                <Card data-workspace-record={attempt.id} key={attempt.id} size="small">
                  <Space orientation="vertical" size={6} style={{ width: "100%" }}>
                    <Space wrap>
                      <Typography.Text strong>{attempt.debitAttemptNo}</Typography.Text>
                      <Tag color={status.color}>{status.label}</Tag>
                      <Tag>{attempt.retrySlot}</Tag>
                    </Space>
                    <Typography.Text type="secondary">
                      Mandate {attempt.mandate.mandateNo} → Attempt {attempt.debitAttemptNo} →
                      PaymentOrder {attempt.paymentOrder.paymentOrderNo} → PaymentRecord{" "}
                      {paymentRecord?.paymentNo ?? "-"}→ WriteOff{" "}
                      {paymentRecord?.writeOffs.length ?? 0} 笔
                    </Typography.Text>
                    {paymentRecord?.writeOffs.map((writeOff) => (
                      <Typography.Text key={`${attempt.id}-${writeOff.billId}`} type="secondary">
                        核销账单 {writeOff.billId}：{formatFen(writeOff.writeOffAmount)} /{" "}
                        {formatTime(writeOff.writeOffAt)}
                      </Typography.Text>
                    ))}
                  </Space>
                </Card>
              );
            })}
          </Space>
        ) : (
          <Empty description="暂无自动扣款尝试" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Space>
    </Card>
  );
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function formatFen(value: string) {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? `${(amount / 100).toLocaleString("zh-CN", {
        minimumFractionDigits: 2
      })} 元`
    : "-";
}
