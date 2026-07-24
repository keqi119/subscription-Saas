"use client";

import { ReloadOutlined, RightOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import { apiFetch } from "../../lib/api";

interface HandoverReviewQueueItem {
  adminReview?: { status?: string | null } | null;
  customer?: { displayName?: string | null; mobileMasked?: string | null } | null;
  customerObjectedAt?: string | null;
  id: string;
  objection?: { details?: string | null; reason?: string | null } | null;
  orderId?: string | null;
  orderNo?: string | null;
  status?: string | null;
}

export default function HandoverReviewQueuePage() {
  const { message } = App.useApp();
  const [items, setItems] = useState<HandoverReviewQueueItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadQueue = useCallback(async () => {
    try {
      setLoading(true);
      setItems(await apiFetch<HandoverReviewQueueItem[]>("/handover-work-orders/review-queue"));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "异议队列加载失败");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const columns: ColumnsType<HandoverReviewQueueItem> = [
    {
      dataIndex: "orderNo",
      render: (value: string | null | undefined) => <Typography.Text strong>{value || "-"}</Typography.Text>,
      title: "订单"
    },
    {
      dataIndex: "customer",
      render: (_value, row) => [row.customer?.displayName, row.customer?.mobileMasked].filter(Boolean).join(" / ") || "-",
      title: "客户"
    },
    {
      dataIndex: "objection",
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text type="danger">{row.objection?.reason || "-"}</Typography.Text>
          {row.objection?.details ? <Typography.Text type="secondary">{row.objection.details}</Typography.Text> : null}
        </Space>
      ),
      title: "异议"
    },
    {
      dataIndex: "adminReview",
      render: (_value, row) => <Tag color="orange">{formatAdminStatus(row.adminReview?.status)}</Tag>,
      title: "后台处理"
    },
    {
      dataIndex: "customerObjectedAt",
      render: (value: string | null | undefined) => value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-",
      title: "提交时间"
    },
    {
      key: "action",
      render: (_value, row) => row.orderId ? (
        <Link href={`/orders/${row.orderId}`}>
          <Button icon={<RightOutlined />} iconPosition="end" size="small" type="primary">
            进入订单处理
          </Button>
        </Link>
      ) : "-",
      title: "操作"
    }
  ];

  return (
    <ProtectedShell>
      <Card
        extra={<Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadQueue()}>刷新</Button>}
        title="客户异议处理队列"
      >
        <Alert
          message="按客户提交时间排序；请进入订单依次完成受理、要求现场复检、后台复核和送回客户确认。"
          showIcon
          style={{ marginBottom: 12 }}
          type="info"
        />
        <Table
          columns={columns}
          dataSource={items}
          loading={loading}
          locale={{ emptyText: "暂无待处理客户异议" }}
          pagination={false}
          rowKey="id"
          size="small"
        />
      </Card>
    </ProtectedShell>
  );
}

function formatAdminStatus(value?: string | null) {
  const labels: Record<string, string> = {
    ACKNOWLEDGED: "已受理",
    NONE: "待受理",
    RESUBMISSION_REQUESTED: "等待现场复检",
    RESUBMITTED_PENDING_ADMIN: "现场已重提，待后台复核"
  };
  return value ? labels[value] ?? value : "待受理";
}
