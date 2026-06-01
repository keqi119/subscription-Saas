"use client";

import { Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useEffect, useState } from "react";

import { ProtectedShell } from "../../../components/protected-shell";
import { AUDIT_ACTION_LABELS, MODULE_LABELS } from "../../../constants/labels";
import { apiFetch } from "../../../lib/api";

interface AuditLogRow {
  action: string;
  afterSnapshot?: unknown;
  beforeSnapshot?: unknown;
  createdAt: string;
  entityId?: string | null;
  entityType: string;
  id: string;
  ipAddress?: string | null;
  module: string;
  operatorId?: string | null;
  userAgent?: string | null;
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    apiFetch<AuditLogRow[]>("/audit-logs")
      .then(setLogs)
      .finally(() => setLoading(false));
  }, []);

  const columns: ColumnsType<AuditLogRow> = [
    {
      dataIndex: "createdAt",
      render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm"),
      title: "操作时间",
      width: 150
    },
    { dataIndex: "operatorId", render: (value?: string | null) => value ?? "-", title: "操作人", width: 220 },
    {
      dataIndex: "module",
      render: (value: string) => MODULE_LABELS[value] ?? value,
      title: "模块",
      width: 120
    },
    { dataIndex: "entityType", title: "实体类型", width: 140 },
    { dataIndex: "entityId", render: (value?: string | null) => value ?? "-", title: "实体ID", width: 220 },
    {
      dataIndex: "action",
      render: (value: string) => <Tag color="blue">{AUDIT_ACTION_LABELS[value] ?? value}</Tag>,
      title: "操作类型",
      width: 120
    },
    { dataIndex: "ipAddress", render: (value?: string | null) => value ?? "-", title: "IP地址", width: 140 },
    { dataIndex: "userAgent", render: (value?: string | null) => value ?? "-", title: "浏览器信息", width: 240 }
  ];

  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          操作日志
        </Typography.Title>
        <Table
          columns={columns}
          dataSource={logs}
          loading={loading}
          rowKey="id"
          scroll={{ x: 1350 }}
        />
      </Space>
    </ProtectedShell>
  );
}
