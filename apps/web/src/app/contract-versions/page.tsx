"use client";

import { PlusOutlined } from "@ant-design/icons";
import { App, Button, DatePicker, Drawer, Form, Input, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import { STATUS_LABELS, labelOf } from "../../constants/labels";
import { apiFetch, ApiError } from "../../lib/api";

interface ContractVersionRow {
  businessType: string;
  createdAt: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  id: string;
  status: string;
  templateName: string;
  versionNo: string;
}

interface ContractVersionFormValues {
  contentTemplate: string;
  effectiveFrom?: dayjs.Dayjs;
  effectiveTo?: dayjs.Dayjs;
  templateName: string;
  versionNo: string;
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

export default function ContractVersionsPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<ContractVersionFormValues>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState<ContractVersionRow[]>([]);

  const loadVersions = useCallback(async () => {
    setLoading(true);
    try {
      setVersions(await apiFetch<ContractVersionRow[]>("/contract-versions"));
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  async function saveVersion() {
    const values = await form.validateFields();
    try {
      await apiFetch("/contract-versions", {
        body: JSON.stringify({
          businessType: "SUBSCRIPTION",
          contentTemplate: values.contentTemplate,
          effectiveFrom: values.effectiveFrom?.format("YYYY-MM-DD"),
          effectiveTo: values.effectiveTo?.format("YYYY-MM-DD"),
          templateName: values.templateName,
          versionNo: values.versionNo
        }),
        method: "POST"
      });
      void message.success("合同模板已创建");
      setDrawerOpen(false);
      form.resetFields();
      await loadVersions();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function setStatus(id: string, action: "activate" | "deactivate") {
    try {
      await apiFetch(`/contract-versions/${id}/${action}`, { method: "POST" });
      void message.success(action === "activate" ? "合同模板已启用" : "合同模板已停用");
      await loadVersions();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  const columns: ColumnsType<ContractVersionRow> = [
    { dataIndex: "templateName", title: "模板名称", width: 220 },
    { dataIndex: "versionNo", title: "版本号", width: 100 },
    { dataIndex: "businessType", render: () => "订阅业务", title: "业务类型", width: 120 },
    { dataIndex: "status", render: (value: string) => <Tag>{labelOf(STATUS_LABELS, value)}</Tag>, title: "状态", width: 110 },
    { dataIndex: "effectiveFrom", render: formatTime, title: "生效日期", width: 150 },
    { dataIndex: "effectiveTo", render: formatTime, title: "失效日期", width: 150 },
    { dataIndex: "createdAt", render: formatTime, title: "创建时间", width: 150 },
    {
      render: (_, record) => (
        <Space>
          {record.status !== "ACTIVE" ? (
            <Button onClick={() => setStatus(record.id, "activate")} size="small">
              启用
            </Button>
          ) : null}
          {record.status === "ACTIVE" ? (
            <Button onClick={() => setStatus(record.id, "deactivate")} size="small">
              停用
            </Button>
          ) : null}
        </Space>
      ),
      title: "操作",
      width: 160
    }
  ];

  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            合同模板
          </Typography.Title>
          <Button icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)} type="primary">
            新增模板
          </Button>
        </Space>
        <Table columns={columns} dataSource={versions} loading={loading} rowKey="id" scroll={{ x: 1200 }} />
      </Space>

      <Drawer
        destroyOnHidden
        onClose={() => setDrawerOpen(false)}
        open={drawerOpen}
        title="新增合同模板"
        width={560}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="模板名称" name="templateName" rules={[{ required: true, message: "请输入模板名称" }]}>
            <Input />
          </Form.Item>
          <Form.Item label="版本号" name="versionNo" rules={[{ required: true, message: "请输入版本号" }]}>
            <Input placeholder="V1.0" />
          </Form.Item>
          <Form.Item label="生效日期" name="effectiveFrom">
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="失效日期" name="effectiveTo">
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label="合同文本模板"
            name="contentTemplate"
            rules={[{ required: true, message: "请输入合同文本模板" }]}
          >
            <Input.TextArea rows={8} />
          </Form.Item>
          <Space>
            <Button onClick={saveVersion} type="primary">
              保存
            </Button>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
          </Space>
        </Form>
      </Drawer>
    </ProtectedShell>
  );
}
