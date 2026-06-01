"use client";

import { Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";

import { ProtectedShell } from "../../../components/protected-shell";
import {
  MODULE_LABELS,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  STATUS_LABELS,
  labelOf
} from "../../../constants/labels";
import { apiFetch } from "../../../lib/api";

interface PermissionRow {
  action: string;
  code: string;
  id: string;
  module: string;
  name: string;
  status: string;
}

export default function PermissionsPage() {
  const [loading, setLoading] = useState(false);
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);

  useEffect(() => {
    setLoading(true);
    apiFetch<PermissionRow[]>("/permissions")
      .then(setPermissions)
      .finally(() => setLoading(false));
  }, []);

  const columns: ColumnsType<PermissionRow> = [
    { dataIndex: "code", title: "权限代码" },
    {
      render: (_, record) => PERMISSION_LABELS[record.code] ?? record.name,
      title: "权限名称"
    },
    {
      render: (_, record) => PERMISSION_DESCRIPTIONS[record.code] ?? "-",
      title: "权限说明"
    },
    {
      dataIndex: "module",
      render: (value: string) => MODULE_LABELS[value] ?? value,
      title: "所属模块"
    },
    {
      dataIndex: "status",
      render: (value: string) => (
        <Tag color={value === "ACTIVE" ? "green" : "default"}>{labelOf(STATUS_LABELS, value)}</Tag>
      ),
      title: "状态"
    }
  ];

  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          权限管理
        </Typography.Title>
        <Table columns={columns} dataSource={permissions} loading={loading} rowKey="id" />
      </Space>
    </ProtectedShell>
  );
}
