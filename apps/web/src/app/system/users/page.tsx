"use client";

import { App, Button, Form, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../../components/protected-shell";
import { ROLE_LABELS, STATUS_LABELS, labelOf } from "../../../constants/labels";
import { apiFetch } from "../../../lib/api";

interface RoleOption {
  code: string;
  id: string;
  name: string;
}

interface UserRow {
  email?: string | null;
  id: string;
  mobile?: string | null;
  name: string;
  roles: RoleOption[];
  status: string;
  username: string;
}

interface CreateUserValues {
  email?: string;
  mobile?: string;
  name: string;
  password: string;
  roleIds?: string[];
  username: string;
}

export default function UsersPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<CreateUserValues>();
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [userRows, roleRows] = await Promise.all([
        apiFetch<UserRow[]>("/users"),
        apiFetch<RoleOption[]>("/roles")
      ]);
      setUsers(userRows);
      setRoles(roleRows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function createUser(values: CreateUserValues) {
    await apiFetch<UserRow>("/users", {
      body: JSON.stringify(values),
      method: "POST"
    });
    void message.success("用户已创建");
    setModalOpen(false);
    form.resetFields();
    await loadData();
  }

  const columns: ColumnsType<UserRow> = [
    { dataIndex: "username", title: "用户编号" },
    { dataIndex: "name", title: "用户姓名" },
    { dataIndex: "mobile", render: (value?: string | null) => value ?? "-", title: "手机号" },
    { dataIndex: "email", render: (value?: string | null) => value ?? "-", title: "邮箱" },
    {
      dataIndex: "roles",
      render: (value: RoleOption[]) => (
        <Space wrap>
          {value.map((role) => (
            <Tag color="blue" key={role.id}>
              {ROLE_LABELS[role.code] ?? role.name}
            </Tag>
          ))}
        </Space>
      ),
      title: "所属角色"
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
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            用户管理
          </Typography.Title>
          <Button onClick={() => setModalOpen(true)} type="primary">
            新增用户
          </Button>
        </Space>
        <Table columns={columns} dataSource={users} loading={loading} rowKey="id" />
      </Space>
      <Modal
        cancelText="取消"
        okText="保存"
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        open={modalOpen}
        title="新增用户"
      >
        <Form<CreateUserValues>
          form={form}
          initialValues={{ password: "Admin@123456" }}
          layout="vertical"
          onFinish={createUser}
        >
          <Form.Item label="用户编号" name="username" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="用户姓名" name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, min: 8 }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item label="手机号" name="mobile">
            <Input />
          </Form.Item>
          <Form.Item label="邮箱" name="email">
            <Input />
          </Form.Item>
          <Form.Item label="所属角色" name="roleIds">
            <Select
              mode="multiple"
              options={roles.map((role) => ({
                label: `${role.code} ${ROLE_LABELS[role.code] ?? role.name}`,
                value: role.id
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </ProtectedShell>
  );
}
