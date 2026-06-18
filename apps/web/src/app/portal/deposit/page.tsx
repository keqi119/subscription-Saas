"use client";

import { ArrowLeftOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { App, Button, Descriptions, Empty, Flex, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  DEPOSIT_TRANSACTION_STATUS_LABELS,
  DEPOSIT_TRANSACTION_TYPE_LABELS,
  ORDER_STATUS_LABELS,
  labelOf
} from "../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import {
  PortalDepositAccount,
  PortalDepositOverview,
  PortalDepositTransaction,
  PortalPagedResponse
} from "../../../lib/portal-types";

export default function PortalDepositPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [overview, setOverview] = useState<PortalDepositOverview>();
  const [transactions, setTransactions] = useState<PortalDepositTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      portalApiFetch<PortalDepositOverview>("/portal/deposit"),
      portalApiFetch<PortalPagedResponse<PortalDepositTransaction>>("/portal/deposit/transactions")
    ])
      .then(([overviewResult, transactionResult]) => {
        setOverview(overviewResult);
        setTransactions(transactionResult.items);
      })
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/deposit")}`);
          return;
        }
        void message.error(error instanceof PortalApiError ? error.message : "无法加载押金信息");
      })
      .finally(() => setLoading(false));
  }, [message, router]);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 900 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 18 }}>
          <div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal")} style={{ marginBottom: 12 }}>
              返回门户
            </Button>
            <Typography.Title level={2} style={{ margin: 0 }}>
              我的押金
            </Typography.Title>
            <Typography.Text type="secondary">查看押金收取、扣减、冻结和退款记录</Typography.Text>
          </div>
        </Flex>

        <section style={sectionStyle}>
          <Flex align="center" gap={12} style={{ marginBottom: 12 }}>
            <SafetyCertificateOutlined style={{ color: "#1677ff", fontSize: 24 }} />
            <Typography.Title level={4} style={{ margin: 0 }}>
              押金总览
            </Typography.Title>
          </Flex>
          <Descriptions
            column={1}
            items={[
              { label: "已收押金", children: formatMoney(overview?.totalCollectedAmount) },
              { label: "已扣减", children: formatMoney(overview?.totalDeductedAmount) },
              { label: "已退款", children: formatMoney(overview?.totalRefundedAmount) },
              { label: "冻结中", children: formatMoney(overview?.totalFrozenAmount) },
              { label: "可用余额", children: formatMoney(overview?.availableAmount) }
            ]}
          />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            押金账户
          </Typography.Title>
          <Table
            columns={accountColumns}
            dataSource={overview?.accounts ?? []}
            loading={loading}
            locale={{ emptyText: <Empty description="暂无押金账户" /> }}
            pagination={false}
            rowKey="orderId"
            size="small"
          />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            押金交易记录
          </Typography.Title>
          <Table
            columns={transactionColumns}
            dataSource={transactions}
            loading={loading}
            locale={{ emptyText: <Empty description="暂无押金交易" /> }}
            pagination={false}
            rowKey="transactionId"
            size="small"
          />
        </section>
      </section>
    </main>
  );
}

const accountColumns: ColumnsType<PortalDepositAccount> = [
  {
    dataIndex: "orderNo",
    render: (value: string | null) => value ?? "-",
    title: "订单"
  },
  {
    dataIndex: "orderStatus",
    render: (value: string | null) => value ? labelOf(ORDER_STATUS_LABELS, value) : "-",
    title: "订单状态"
  },
  {
    dataIndex: "collectedAmount",
    render: (value: number) => formatMoney(value),
    title: "已收"
  },
  {
    dataIndex: "remainingAmount",
    render: (value: number) => formatMoney(value),
    title: "余额"
  },
  {
    dataIndex: "status",
    render: (value: string) => <Tag>{depositAccountStatusLabel(value)}</Tag>,
    title: "状态"
  }
];

const transactionColumns: ColumnsType<PortalDepositTransaction> = [
  {
    dataIndex: "orderNo",
    title: "订单"
  },
  {
    dataIndex: "transactionType",
    render: (value: string) => labelOf(DEPOSIT_TRANSACTION_TYPE_LABELS, value),
    title: "类型"
  },
  {
    dataIndex: "transactionStatus",
    render: (value: string) => labelOf(DEPOSIT_TRANSACTION_STATUS_LABELS, value),
    title: "状态"
  },
  {
    dataIndex: "amount",
    render: (value: number) => formatMoney(value),
    title: "金额"
  },
  {
    dataIndex: "occurredAt",
    render: (value: string | null) => formatTime(value),
    title: "发生时间"
  }
];

function depositAccountStatusLabel(value: string) {
  const labels: Record<string, string> = {
    ACTIVE: "可用",
    NONE: "暂无押金",
    SETTLED: "已结清"
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
