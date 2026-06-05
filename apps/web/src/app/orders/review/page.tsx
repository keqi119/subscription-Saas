"use client";

import { EyeOutlined } from "@ant-design/icons";
import { App, Button, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../../components/protected-shell";
import { STATUS_LABELS, labelOf } from "../../../constants/labels";
import { apiFetch, ApiError } from "../../../lib/api";

interface ReviewOrderRow {
  creditReviewStatus: string;
  customer: { name: string; mobile: string };
  depositStatus: string;
  finalDepositAmount?: number | null;
  id: string;
  monthlyFeeAmount: number;
  orderNo: string;
  orderSource: string;
  orderStatus: string;
  productReviewStatus: string;
  quoteSnapshot?: unknown;
  vehicle?: { plateNo?: string | null; vehicleNo?: string; vin?: string | null } | null;
  vehicleModel: string;
  vehicleReviewStatus: string;
}

const ORDER_SOURCE_LABELS: Record<string, string> = {
  CUSTOMER_SELF_SERVICE: "客户自动下单",
  SALES_ASSISTED: "销售手动下单"
};

const statusColors: Record<string, string> = {
  APPROVED: "green",
  CONFIRMED: "green",
  NEED_MORE_INFO: "orange",
  PENDING: "blue",
  PENDING_CONFIRM: "orange",
  PENDING_CUSTOMER_CONFIRMATION: "purple",
  PENDING_REVIEW: "blue",
  REJECTED: "red"
};

function formatYuan(value?: number | null) {
  return typeof value === "number" ? `${(value / 100).toFixed(2)} 元` : "-";
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

function snapshotValue(snapshot: unknown, path: string) {
  let current = toRecord(snapshot);
  for (const key of path.split(".")) {
    if (!current || !(key in current)) {
      return undefined;
    }
    const next = current[key];
    if (key === path.split(".").at(-1)) {
      return next;
    }
    current = toRecord(next);
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      return toRecord(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function planName(record: ReviewOrderRow) {
  const value =
    snapshotValue(record.quoteSnapshot, "packageSnapshot.subscriptionPlan.planName") ??
    snapshotValue(record.quoteSnapshot, "subscriptionPlan.planName");
  return typeof value === "string" ? value : "-";
}

function StatusTag({ value }: { value: string }) {
  return <Tag color={statusColors[value]}>{labelOf(STATUS_LABELS, value)}</Tag>;
}

export default function OrderReviewQueuePage() {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [orders, setOrders] = useState<ReviewOrderRow[]>([]);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      setOrders(await apiFetch<ReviewOrderRow[]>("/orders/review-queue"));
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  async function finalizePlan(orderId: string) {
    try {
      await apiFetch<unknown>(`/orders/${orderId}/finalize-plan`, { method: "POST" });
      void message.success("最终方案已确认");
      await loadOrders();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function customerConfirm(orderId: string) {
    try {
      await apiFetch<unknown>(`/orders/${orderId}/customer-confirm`, { method: "POST" });
      void message.success("订单已进入合同签约");
      await loadOrders();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  const columns: ColumnsType<ReviewOrderRow> = [
    {
      dataIndex: "orderNo",
      render: (value: string, record) => <Link href={`/orders/${record.id}`}>{value}</Link>,
      title: "订单编号",
      width: 170
    },
    {
      dataIndex: "orderSource",
      render: (value: string) => ORDER_SOURCE_LABELS[value] ?? value,
      title: "来源",
      width: 120
    },
    {
      dataIndex: "customer",
      render: (value: ReviewOrderRow["customer"]) => `${value.name} / ${value.mobile}`,
      title: "客户",
      width: 180
    },
    {
      dataIndex: "vehicle",
      render: (value: ReviewOrderRow["vehicle"], record) =>
        value ? `${value.vehicleNo ?? "-"} / ${value.plateNo ?? value.vin ?? "-"}` : record.vehicleModel,
      title: "车辆",
      width: 200
    },
    { render: (_, record) => planName(record), title: "套餐", width: 180 },
    { dataIndex: "monthlyFeeAmount", render: formatYuan, title: "月费", width: 110 },
    { dataIndex: "finalDepositAmount", render: formatYuan, title: "最终押金", width: 120 },
    { dataIndex: "creditReviewStatus", render: (value: string) => <StatusTag value={value} />, title: "客户审核", width: 120 },
    { dataIndex: "productReviewStatus", render: (value: string) => <StatusTag value={value} />, title: "产品审核", width: 120 },
    { dataIndex: "vehicleReviewStatus", render: (value: string) => <StatusTag value={value} />, title: "车辆审核", width: 120 },
    { dataIndex: "depositStatus", render: (value: string) => <StatusTag value={value} />, title: "押金状态", width: 120 },
    { dataIndex: "orderStatus", render: (value: string) => <StatusTag value={value} />, title: "订单状态", width: 140 },
    {
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Link href={`/orders/${record.id}`}>
            <Button icon={<EyeOutlined />} size="small">
              查看
            </Button>
          </Link>
          {canFinalize(record) ? (
            <Button onClick={() => finalizePlan(record.id)} size="small" type="primary">
              确认方案
            </Button>
          ) : null}
          {record.orderStatus === "PENDING_CUSTOMER_CONFIRMATION" ? (
            <Button onClick={() => customerConfirm(record.id)} size="small">
              进入签约
            </Button>
          ) : null}
        </Space>
      ),
      title: "操作",
      width: 230
    }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          订单申请审核
        </Typography.Title>
        <Table columns={columns} dataSource={orders} loading={loading} rowKey="id" scroll={{ x: 1760 }} />
      </Space>
    </ProtectedShell>
  );
}

function canFinalize(record: ReviewOrderRow) {
  return (
    record.orderStatus === "PENDING_REVIEW" &&
    record.creditReviewStatus === "APPROVED" &&
    record.productReviewStatus === "APPROVED" &&
    record.vehicleReviewStatus === "APPROVED"
  );
}
