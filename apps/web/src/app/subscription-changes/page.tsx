"use client";

import { ReloadOutlined, RightOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Checkbox, Flex, Select, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  RENEWAL_CONSIDERATION_STATUS_LABELS,
  SUBSCRIPTION_CHANGE_STATUS_LABELS
} from "../../constants/labels";
import { ProtectedShell } from "../../components/protected-shell";
import {
  listRenewalConsiderations,
  type AdminRenewalConsideration,
  type AdminRenewalConsiderationPage
} from "../../lib/subscription-change-api";

const STATUS_OPTIONS = [
  { label: "全部状态", value: "ALL" },
  ...Object.entries(RENEWAL_CONSIDERATION_STATUS_LABELS).map(([value, label]) => ({
    label,
    value
  }))
];

export default function SubscriptionChangesPage() {
  const [data, setData] = useState<AdminRenewalConsiderationPage>({
    items: [],
    page: 1,
    pageSize: 20,
    total: 0
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [smsFailed, setSmsFailed] = useState(false);
  const [status, setStatus] = useState("ALL");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await listRenewalConsiderations({
          page,
          pageSize,
          smsFailed: smsFailed || undefined,
          status: status === "ALL" ? undefined : status
        })
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "合同变更中心加载失败");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, smsFailed, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<AdminRenewalConsideration> = [
    {
      key: "order",
      render: (_value, item) => (
        <Space orientation="vertical" size={0}>
          <Link href={`/orders/${encodeURIComponent(item.order.id)}?tab=change`}>
            {item.order.orderNo}
          </Link>
          <Typography.Text type="secondary">
            {item.order.vehicle?.plateNo ?? item.order.vehicle?.vehicleNo ?? "未绑定车辆"}
          </Typography.Text>
        </Space>
      ),
      title: "订单 / 车辆"
    },
    {
      key: "consideration",
      render: (_value, item) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text>{item.considerationNo}</Typography.Text>
          <Tag>{RENEWAL_CONSIDERATION_STATUS_LABELS[item.status] ?? item.status}</Tag>
        </Space>
      ),
      title: "续订考虑期"
    },
    {
      dataIndex: ["segment", "endDate"],
      render: formatDate,
      title: "原合同到期日"
    },
    {
      key: "contractedThrough",
      render: (_value, item) =>
        formatDate(
          item.changeOrder && ["SCHEDULED", "EXECUTING", "COMPLETED"].includes(item.changeOrder.status)
            ? item.changeOrder.targetEndDate
            : item.segment.endDate
        ),
      title: "已签约至"
    },
    {
      key: "change",
      render: (_value, item) =>
        item.changeOrder ? (
          <Space orientation="vertical" size={0}>
            <Typography.Text>{item.changeOrder.changeNo}</Typography.Text>
            <Tag color={statusColor(item.changeOrder.status)}>
              {SUBSCRIPTION_CHANGE_STATUS_LABELS[item.changeOrder.status] ?? item.changeOrder.status}
            </Tag>
          </Space>
        ) : (
          <Typography.Text type="secondary">尚未发起协议延长</Typography.Text>
        ),
      title: "协议延长"
    },
    {
      dataIndex: "completionDeadlineAt",
      render: formatDateTime,
      title: "完成期限"
    },
    {
      key: "reminder",
      render: (_value, item) => {
        const failed = item.reminders.filter(
          (reminder) => reminder.status === "FAILED" || reminder.smsStatus === "FAILED"
        ).length;
        return failed ? <Tag color="red">{failed} 个渠道失败</Tag> : <Tag color="green">正常</Tag>;
      },
      title: "提醒"
    },
    {
      key: "action",
      render: (_value, item) =>
        item.changeOrder ? (
          <Link href={`/subscription-changes/${encodeURIComponent(item.changeOrder.id)}`}>
            <Button icon={<RightOutlined />} iconPosition="end" size="small" type="primary">
              查看 / 处理
            </Button>
          </Link>
        ) : (
          <Link href={`/orders/${encodeURIComponent(item.order.id)}?tab=change`}>
            <Button size="small">查看订单</Button>
          </Link>
        ),
      title: "操作"
    }
  ];

  return (
    <ProtectedShell>
      <Card
        extra={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        }
        title="合同变更中心"
      >
        <Alert
          description="原合同到期日保留历史事实；只有补充协议完成归档并建立续期分段后，已签约至才会延长。"
          message="首批范围：协议延长"
          showIcon
          style={{ marginBottom: 16 }}
          type="info"
        />
        {error ? (
          <Alert
            action={<Button onClick={() => void load()}>重试加载</Button>}
            message={error}
            showIcon
            style={{ marginBottom: 16 }}
            type="error"
          />
        ) : null}
        <Flex gap={12} justify="space-between" style={{ marginBottom: 16 }} wrap="wrap">
          <Space wrap>
            <Select
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              options={STATUS_OPTIONS}
              style={{ minWidth: 190 }}
              value={status}
            />
            <Checkbox
              checked={smsFailed}
              onChange={(event) => {
                setSmsFailed(event.target.checked);
                setPage(1);
              }}
            >
              仅看短信失败
            </Checkbox>
          </Space>
          <Typography.Text type="secondary">共 {data.total} 条</Typography.Text>
        </Flex>
        <Table
          columns={columns}
          dataSource={data.items}
          loading={loading}
          locale={{ emptyText: "暂无续订考虑期或协议延长记录" }}
          pagination={{
            current: page,
            onChange: (nextPage, nextSize) => {
              setPage(nextSize === pageSize ? nextPage : 1);
              setPageSize(nextSize);
            },
            pageSize,
            showSizeChanger: true,
            total: data.total
          }}
          rowKey="id"
          scroll={{ x: 1280 }}
          size="small"
        />
      </Card>
    </ProtectedShell>
  );
}

function formatDate(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD") : "-";
}

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function statusColor(status: string) {
  if (status === "COMPLETED") return "green";
  if (status === "FAILED" || status === "MANUAL_TAKEOVER") return "red";
  if (status === "CANCELLED") return "default";
  return "blue";
}
