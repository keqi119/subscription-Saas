"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { App, Button, Input, Modal, Space, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import {
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_EVENT_STATUS_LABELS,
  NOTIFICATION_EVENT_TYPE_LABELS,
  NOTIFICATION_STATUS_LABELS,
  NOTIFICATION_TEMPLATE_STATUS_LABELS,
  NOTIFICATION_TEMPLATE_TYPE_LABELS,
  NOTIFICATION_TYPE_LABELS,
  labelOf
} from "../../constants/labels";
import { ApiError, apiFetch } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";
import type {
  AdminNotificationEvent,
  AdminNotificationRecord,
  AdminNotificationTemplate,
  PortalPagedResponse
} from "../../lib/portal-types";

const statusColors: Record<string, string> = {
  ACTIVE: "green",
  FAILED: "red",
  INACTIVE: "default",
  PENDING: "gold",
  PROCESSED: "green",
  PROCESSING: "blue",
  READ: "default",
  SENT: "green",
  SKIPPED: "default"
};

type ProcessingResolution = "CONFIRMED_NOT_SENT" | "CONFIRMED_SENT";

export default function NotificationsPage() {
  const { message } = App.useApp();
  const [templates, setTemplates] = useState<AdminNotificationTemplate[]>([]);
  const [records, setRecords] = useState<AdminNotificationRecord[]>([]);
  const [events, setEvents] = useState<AdminNotificationEvent[]>([]);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [processingReason, setProcessingReason] = useState("");
  const [processingResolution, setProcessingResolution] = useState<{
    record: AdminNotificationRecord;
    resolution: ProcessingResolution;
  } | null>(null);
  const [resolving, setResolving] = useState(false);
  const canManageNotifications = useMemo(
    () => me?.user.permissions.includes("notification:manage") ?? false,
    [me]
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [templateResult, recordResult, eventResult, nextMe] = await Promise.all([
        apiFetch<PortalPagedResponse<AdminNotificationTemplate>>("/notifications/templates?pageSize=100"),
        apiFetch<PortalPagedResponse<AdminNotificationRecord>>("/notifications/records?pageSize=100"),
        apiFetch<PortalPagedResponse<AdminNotificationEvent>>("/notifications/events?pageSize=100"),
        apiFetch<AuthMeResponse>("/auth/me")
      ]);
      setTemplates(templateResult.items);
      setRecords(recordResult.items);
      setEvents(eventResult.items);
      setMe(nextMe);
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : "无法加载通知中心数据");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function resolveProcessingRecord() {
    if (!processingResolution) {
      return;
    }
    const reason = processingReason.trim();
    if (reason.length < 2) {
      void message.error("请填写至少 2 个字符的渠道核对说明");
      throw new Error("PROCESSING_NOTIFICATION_REASON_REQUIRED");
    }
    setResolving(true);
    try {
      await apiFetch(
        `/notifications/records/${processingResolution.record.notificationId}/resolve-processing`,
        {
          body: JSON.stringify({
            reason,
            resolution: processingResolution.resolution
          }),
          method: "POST"
        }
      );
      void message.success(
        processingResolution.resolution === "CONFIRMED_SENT"
          ? "已确认渠道发送成功"
          : "已确认渠道未发送，可在修复原因后重试原任务"
      );
      setProcessingResolution(null);
      setProcessingReason("");
      await loadData();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "PROCESSING_NOTIFICATION_REASON_REQUIRED"
      ) {
        void message.error(
          error instanceof ApiError ? error.message : "通知核对处置失败"
        );
      }
      throw error;
    } finally {
      setResolving(false);
    }
  }

  const templateColumns: ColumnsType<AdminNotificationTemplate> = [
    { dataIndex: "templateCode", title: "模板编码", width: 260 },
    { dataIndex: "title", title: "标题" },
    {
      dataIndex: "channel",
      render: (value: string) => labelOf(NOTIFICATION_CHANNEL_LABELS, value),
      title: "渠道",
      width: 150
    },
    {
      dataIndex: "templateType",
      render: (value: string) => labelOf(NOTIFICATION_TEMPLATE_TYPE_LABELS, value),
      title: "类型",
      width: 170
    },
    {
      dataIndex: "templateStatus",
      render: (value: string) => (
        <Tag color={statusColors[value] ?? "default"}>{labelOf(NOTIFICATION_TEMPLATE_STATUS_LABELS, value)}</Tag>
      ),
      title: "状态",
      width: 110
    },
    { dataIndex: "providerTemplateId", title: "服务号模板 ID", width: 180 },
    { dataIndex: "updatedAt", render: formatTime, title: "更新时间", width: 170 }
  ];

  const recordColumns: ColumnsType<AdminNotificationRecord> = [
    { dataIndex: "notificationNo", title: "通知编号", width: 220 },
    {
      dataIndex: "notificationType",
      render: (value: string) => labelOf(NOTIFICATION_TYPE_LABELS, value),
      title: "类型",
      width: 170
    },
    {
      dataIndex: "channel",
      render: (value: string) => labelOf(NOTIFICATION_CHANNEL_LABELS, value),
      title: "渠道",
      width: 150
    },
    { dataIndex: "title", title: "标题", width: 220 },
    {
      render: (_, row) => row.customer?.name ?? row.recipientPhone ?? row.recipientOpenIdMasked ?? "-",
      title: "接收人",
      width: 180
    },
    {
      dataIndex: "notificationStatus",
      render: (value: string) => (
        <Tag color={statusColors[value] ?? "default"}>{labelOf(NOTIFICATION_STATUS_LABELS, value)}</Tag>
      ),
      title: "状态",
      width: 110
    },
    { dataIndex: "sentAt", render: formatTime, title: "发送时间", width: 170 },
    { dataIndex: "errorMessage", title: "错误", width: 220 }
  ];

  recordColumns.push({
    fixed: "right",
    render: (_, record) =>
      record.notificationStatus === "PROCESSING" && canManageNotifications ? (
        <Space size={4}>
          <Button
            onClick={() => {
              setProcessingReason("");
              setProcessingResolution({
                record,
                resolution: "CONFIRMED_SENT"
              });
            }}
            size="small"
            type="link"
          >
            确认已发送
          </Button>
          <Button
            danger
            onClick={() => {
              setProcessingReason("");
              setProcessingResolution({
                record,
                resolution: "CONFIRMED_NOT_SENT"
              });
            }}
            size="small"
            type="link"
          >
            确认未发送
          </Button>
        </Space>
      ) : null,
    title: "人工核对",
    width: 190
  });

  const eventColumns: ColumnsType<AdminNotificationEvent> = [
    {
      dataIndex: "eventType",
      render: (value: string) => labelOf(NOTIFICATION_EVENT_TYPE_LABELS, value),
      title: "事件",
      width: 190
    },
    { dataIndex: "aggregateType", title: "业务对象", width: 150 },
    { dataIndex: "aggregateId", title: "业务 ID", width: 220 },
    {
      dataIndex: "eventStatus",
      render: (value: string) => (
        <Tag color={statusColors[value] ?? "default"}>{labelOf(NOTIFICATION_EVENT_STATUS_LABELS, value)}</Tag>
      ),
      title: "状态",
      width: 110
    },
    { dataIndex: "attempts", title: "次数", width: 80 },
    {
      render: (_, row) => row.customer?.name ?? "-",
      title: "客户",
      width: 160
    },
    { dataIndex: "notificationNo", title: "通知编号", width: 220 },
    { dataIndex: "createdAt", render: formatTime, title: "创建时间", width: 170 },
    { dataIndex: "lastError", title: "错误", width: 220 }
  ];

  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              通知中心
            </Typography.Title>
            <Typography.Text type="secondary">查看通知模板、发送记录和业务事件处理状态</Typography.Text>
          </div>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadData()}>
            刷新
          </Button>
        </Space>

        <Tabs
          items={[
            {
              children: (
                <Table
                  columns={templateColumns}
                  dataSource={templates}
                  loading={loading}
                  rowKey="templateId"
                  scroll={{ x: 1260 }}
                />
              ),
              key: "templates",
              label: "模板"
            },
            {
              children: (
                <Table
                  columns={recordColumns}
                  dataSource={records}
                  loading={loading}
                  rowKey="notificationId"
                  scroll={{ x: 1460 }}
                />
              ),
              key: "records",
              label: "发送记录"
            },
            {
              children: (
                <Table
                  columns={eventColumns}
                  dataSource={events}
                  loading={loading}
                  rowKey="eventId"
                  scroll={{ x: 1460 }}
                />
              ),
              key: "events",
              label: "事件"
            }
          ]}
        />
        <Modal
          cancelText="取消"
          confirmLoading={resolving}
          destroyOnHidden
          okText={
            processingResolution?.resolution === "CONFIRMED_SENT"
              ? "确认已发送"
              : "确认未发送"
          }
          onCancel={() => {
            setProcessingResolution(null);
            setProcessingReason("");
          }}
          onOk={resolveProcessingRecord}
          open={processingResolution !== null}
          title="核对不确定发送结果"
        >
          <Typography.Paragraph type="secondary">
            请先在微信渠道后台核对真实发送结果。确认“未发送”后，原通知才会恢复为可安全重试状态。
          </Typography.Paragraph>
          <Input.TextArea
            maxLength={500}
            onChange={(event) => setProcessingReason(event.target.value)}
            placeholder="填写渠道回执、核对时间或未发送依据"
            rows={4}
            showCount
            value={processingReason}
          />
        </Modal>
      </Space>
    </ProtectedShell>
  );
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}
