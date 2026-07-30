"use client";

import { EyeOutlined, FileTextOutlined } from "@ant-design/icons";
import { App, Button, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../components/action-button";
import { ProtectedShell } from "../../components/protected-shell";
import { ORDER_STATUS_LABELS, STATUS_LABELS, labelOf } from "../../constants/labels";
import { canGenerateContract } from "../../lib/action-guards";
import { apiFetch, ApiError } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";

interface OrderRow {
  application?: { applicationNo: string; id: string } | null;
  contract?: { id: string; status: string } | null;
  createdAt: string;
  customer: { name: string; mobile: string };
  depositAmount: number;
  id: string;
  modelDisplayName?: string | null;
  modelDisplaySource?: string | null;
  monthlyFeeAmount: number;
  orderNo: string;
  orderStatus: string;
  periodMonths: number;
  quote?: { quoteNo: string; id: string } | null;
  modelCodeSnapshot?: string | null;
}

const statusColors: Record<string, string> = {
  CANCELLED: "red",
  PENDING_CONTRACT: "blue",
  PENDING_PAYMENT: "orange",
  PENDING_SIGN: "purple"
};

function formatYuan(value: number) {
  return `¥${(value / 100).toFixed(2)}`;
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

export default function OrdersPage() {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me]);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const [nextOrders, nextMe] = await Promise.all([
        apiFetch<OrderRow[]>("/orders"),
        apiFetch<AuthMeResponse>("/auth/me")
      ]);
      setOrders(nextOrders);
      setMe(nextMe);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  async function generateContract(orderId: string) {
    try {
      await apiFetch(`/orders/${orderId}/generate-contract`, { method: "POST" });
      void message.success("合同已生成");
      await loadOrders();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  const columns: ColumnsType<OrderRow> = [
    {
      dataIndex: "orderNo",
      render: (value: string, record) => <Link href={`/orders/${record.id}`}>{value}</Link>,
      title: "订单编号",
      width: 170
    },
    {
      dataIndex: "customer",
      render: (value: OrderRow["customer"]) => `${value.name} / ${value.mobile}`,
      title: "客户姓名",
      width: 180
    },
    {
      dataIndex: "application",
      render: (value?: OrderRow["application"]) =>
        value ? <Link href={`/applications/${value.id}`}>{value.applicationNo}</Link> : "-",
      title: "进件编号",
      width: 160
    },
    {
      dataIndex: "quote",
      render: (value?: OrderRow["quote"]) =>
        value ? <Link href={`/quotes/${value.id}`}>{value.quoteNo}</Link> : "-",
      title: "报价编号",
      width: 160
    },
    { dataIndex: "modelDisplayName", title: "车型", width: 140 },
    { dataIndex: "monthlyFeeAmount", render: formatYuan, title: "月费", width: 110 },
    { dataIndex: "depositAmount", render: formatYuan, title: "押金", width: 110 },
    { dataIndex: "periodMonths", render: (value: number) => `${value} 个月`, title: "订阅周期", width: 110 },
    {
      dataIndex: "orderStatus",
      render: (value: string) => <Tag color={statusColors[value]}>{labelOf(ORDER_STATUS_LABELS, value)}</Tag>,
      title: "订单状态",
      width: 120
    },
    {
      dataIndex: "contract",
      render: (value?: OrderRow["contract"]) =>
        value ? <Tag color="green">{labelOf(STATUS_LABELS, value.status)}</Tag> : "-",
      title: "合同状态",
      width: 120
    },
    {
      dataIndex: "createdAt",
      render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm"),
      title: "创建时间",
      width: 150
    },
    {
      render: (_, record) => (
        <Space>
          <Link href={`/orders/${record.id}`}>
            <Button icon={<EyeOutlined />} size="small">
              查看详情
            </Button>
          </Link>
          <ActionButton
            availability={canGenerateContract(record, permissions)}
            icon={<FileTextOutlined />}
            onClick={() => generateContract(record.id)}
            size="small"
          >
            生成合同
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 210
    }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          订阅订单
        </Typography.Title>
        <Table columns={columns} dataSource={orders} loading={loading} rowKey="id" scroll={{ x: 1600 }} />
      </Space>
    </ProtectedShell>
  );
}
