"use client";

import { App, Button, Checkbox, Modal, Space, Table, Tag, Typography } from "antd";
import type { CheckboxOptionType } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../../components/protected-shell";
import {
  MENU_LABELS,
  PERMISSION_LABELS,
  ROLE_LABELS,
  STATUS_LABELS,
  labelOf
} from "../../../constants/labels";
import { apiFetch } from "../../../lib/api";

interface LookupRow {
  code: string;
  id: string;
  name: string;
}

interface MenuRow extends LookupRow {
  path: string;
}

interface RoleRow {
  code: string;
  description?: string | null;
  id: string;
  menus: MenuRow[];
  name: string;
  permissions: LookupRow[];
  status: string;
}

type EditorMode = "permissions" | "menus";

export default function RolesPage() {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [menus, setMenus] = useState<MenuRow[]>([]);
  const [permissions, setPermissions] = useState<LookupRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedRole, setSelectedRole] = useState<RoleRow | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("permissions");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [roleRows, permissionRows, menuRows] = await Promise.all([
        apiFetch<RoleRow[]>("/roles"),
        apiFetch<LookupRow[]>("/permissions"),
        apiFetch<MenuRow[]>("/menus")
      ]);
      setRoles(roleRows);
      setPermissions(permissionRows);
      setMenus(menuRows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  function openEditor(role: RoleRow, mode: EditorMode) {
    setSelectedRole(role);
    setEditorMode(mode);
    setSelectedIds((mode === "permissions" ? role.permissions : role.menus).map((item) => item.id));
  }

  async function saveEditor() {
    if (!selectedRole) {
      return;
    }

    await apiFetch(`/roles/${selectedRole.id}/${editorMode}`, {
      body: JSON.stringify({ ids: selectedIds }),
      method: "PUT"
    });
    void message.success("配置已保存");
    setSelectedRole(null);
    await loadData();
  }

  const columns: ColumnsType<RoleRow> = [
    { dataIndex: "code", title: "角色代码" },
    {
      render: (_, record) => ROLE_LABELS[record.code] ?? record.name,
      title: "角色名称"
    },
    { dataIndex: "description", render: (value?: string | null) => value ?? "-", title: "角色说明" },
    {
      dataIndex: "permissions",
      render: (value: LookupRow[]) => value.length,
      title: "关联权限"
    },
    {
      dataIndex: "menus",
      render: (value: MenuRow[]) => value.length,
      title: "关联菜单"
    },
    {
      dataIndex: "status",
      render: (value: string) => (
        <Tag color={value === "ACTIVE" ? "green" : "default"}>{labelOf(STATUS_LABELS, value)}</Tag>
      ),
      title: "状态"
    },
    {
      render: (_, record) => (
        <Space>
          <Button onClick={() => openEditor(record, "permissions")} size="small">
            配置权限
          </Button>
          <Button onClick={() => openEditor(record, "menus")} size="small">
            配置菜单
          </Button>
        </Space>
      ),
      title: "操作"
    }
  ];

  const options: CheckboxOptionType<string>[] = (editorMode === "permissions" ? permissions : menus).map(
    (item) => ({
      label:
        editorMode === "permissions"
          ? `${item.code} ${PERMISSION_LABELS[item.code] ?? item.name}`
          : `${item.code} ${MENU_LABELS[item.code] ?? item.name}`,
      value: item.id
    })
  );

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          角色管理
        </Typography.Title>
        <Table columns={columns} dataSource={roles} loading={loading} rowKey="id" />
      </Space>
      <Modal
        cancelText="取消"
        okText="保存"
        onCancel={() => setSelectedRole(null)}
        onOk={saveEditor}
        open={Boolean(selectedRole)}
        title={editorMode === "permissions" ? "配置权限" : "配置菜单"}
      >
        <Checkbox.Group
          onChange={(values) => setSelectedIds(values.map(String))}
          options={options}
          style={{ display: "grid", gap: 12 }}
          value={selectedIds}
        />
      </Modal>
    </ProtectedShell>
  );
}
