"use client";

import { ReloadOutlined, RightOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Flex, Select, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import { apiFetch } from "../../lib/api";
import {
  getMileageReviewPresentation,
  isMileageReviewOverdue,
  sortMileageReviewQueue,
  type MileageReviewPage,
  type MileageReviewStatus,
  type MileageReviewView
} from "../../lib/mileage-review-view-model";

type QueueFilter = MileageReviewStatus | "ALL" | "OVERDUE";

const FILTERS: Array<{ label: string; value: QueueFilter }> = [
  { label: "全部", value: "ALL" },
  { label: "逾期待提交", value: "OVERDUE" },
  { label: "待提交", value: "PENDING_SUBMISSION" },
  { label: "待后台复核", value: "PENDING_REVIEW" },
  { label: "已退回补充", value: "RETURNED" },
  { label: "已确认", value: "CONFIRMED" },
  { label: "已作废", value: "VOIDED" }
];

export default function MileageReviewsPage() {
  return (
    <Suspense>
      <MileageReviewsContent />
    </Suspense>
  );
}

function MileageReviewsContent() {
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const orderId = searchParams.get("orderId") ?? undefined;
  const [status, setStatus] = useState<QueueFilter>("ALL");
  const [page, setPage] = useState<MileageReviewPage>({ items: [], page: 1, pageSize: 50, total: 0 });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: "1", pageSize: "100" });
      if (orderId) params.set("orderId", orderId);
      if (status !== "ALL" && status !== "OVERDUE") params.set("status", status);
      setPage(await apiFetch<MileageReviewPage>("/mileage-reviews?" + params.toString()));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "里程复核列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [message, orderId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => {
    const sorted = sortMileageReviewQueue(page.items);
    return status === "OVERDUE"
      ? sorted.filter((item) => isMileageReviewOverdue(item))
      : sorted;
  }, [page.items, status]);
  const columns: ColumnsType<MileageReviewView> = [
    {
      key: "order",
      render: (_value, item) => (
        <Space orientation="vertical" size={0}>
          <Link href={`/orders/${item.order.id}`}>{item.order.orderNo}</Link>
          <Typography.Text type="secondary">第 {item.cycleNo} 期 / V{item.version}</Typography.Text>
        </Space>
      ),
      title: "订单 / 周期"
    },
    {
      key: "vehicle",
      render: (_value, item) => [item.vehicle.plateNo, item.vehicle.brand, item.vehicle.model].filter(Boolean).join(" / ") || "-",
      title: "车辆"
    },
    {
      key: "period",
      render: (_value, item) => `${dayjs(item.periodStart).format("YYYY-MM-DD")} 至 ${dayjs(item.periodEnd).format("YYYY-MM-DD")}`,
      title: "复核周期"
    },
    {
      dataIndex: "scheduledReviewAt",
      render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm"),
      title: "计划复核时间"
    },
    {
      key: "status",
      render: (_value, item) => {
        const overdue = isMileageReviewOverdue(item);
        const presentation = getMileageReviewPresentation(item.status, overdue);
        return <Tag color={presentation.color}>{presentation.label}</Tag>;
      },
      title: "状态"
    },
    {
      key: "mileage",
      render: (_value, item) => item.submittedMileageKm === null
        ? `${item.baselineMileageKm.toLocaleString("zh-CN")} km 起`
        : `${item.submittedMileageKm.toLocaleString("zh-CN")} km`,
      title: "累计里程"
    },
    {
      key: "action",
      render: (_value, item) => (
        <Link href={`/mileage-reviews/${item.id}`}>
          <Button icon={<RightOutlined />} iconPosition="end" size="small" type="primary">查看 / 处理</Button>
        </Link>
      ),
      title: "操作"
    }
  ];

  return (
    <ProtectedShell>
      <Card
        extra={<Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>}
        title="月度里程复核"
      >
        <Alert
          message="逾期待提交任务优先展示；逾期只延后里程核销与超里程计费，不影响固定月租账单生成。"
          showIcon
          style={{ marginBottom: 16 }}
          type="info"
        />
        <Flex align="center" gap={12} justify="space-between" style={{ marginBottom: 16 }} wrap="wrap">
          <Select onChange={setStatus} options={FILTERS} style={{ minWidth: 180 }} value={status} />
          <Typography.Text type="secondary">
            {orderId ? "当前仅显示指定订单" : "跨订单待办"} · 共 {page.total} 条
          </Typography.Text>
        </Flex>
        <Table
          columns={columns}
          dataSource={items}
          loading={loading}
          locale={{ emptyText: "暂无里程复核任务" }}
          pagination={false}
          rowKey="id"
          scroll={{ x: 980 }}
          size="small"
        />
      </Card>
    </ProtectedShell>
  );
}
