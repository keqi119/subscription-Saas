"use client";

import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import {
  App,
  Button,
  DatePicker,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../../components/protected-shell";
import { STATUS_LABELS, labelOf } from "../../../constants/labels";
import { apiFetch } from "../../../lib/api";

interface DepositRuleRow {
  createdAt: string;
  customerRatio?: number | null;
  defaultRate: number;
  depositAmount: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  grade: string;
  id: string;
  status: string;
}

interface DepositRuleValues {
  customerRatio?: number | null;
  defaultRate: number;
  depositAmountYuan: number;
  effectiveFrom: Dayjs;
  effectiveTo?: Dayjs | null;
  grade: string;
  status: string;
}

const gradeOptions = [
  { label: "A", value: "A" },
  { label: "B", value: "B" },
  { label: "C", value: "C" }
];

const statusOptions = [
  { label: "启用", value: "ACTIVE" },
  { label: "停用", value: "INACTIVE" }
];

function formatYuan(amount: number) {
  return `￥${(amount / 100).toFixed(2)}`;
}

function formatRate(value?: number | null) {
  return value === undefined || value === null ? "-" : `${(value * 100).toFixed(2)}%`;
}

export default function DepositRulesPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<DepositRuleValues>();
  const [editingRule, setEditingRule] = useState<DepositRuleRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [rules, setRules] = useState<DepositRuleRow[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      setRules(await apiFetch<DepositRuleRow[]>("/deposit-rules"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  function openCreateModal() {
    setEditingRule(null);
    form.setFieldsValue({
      defaultRate: 0.028,
      depositAmountYuan: 10000,
      effectiveFrom: dayjs(),
      grade: "B",
      status: "ACTIVE"
    });
    setModalOpen(true);
  }

  function openEditModal(record: DepositRuleRow) {
    setEditingRule(record);
    form.setFieldsValue({
      customerRatio: record.customerRatio,
      defaultRate: record.defaultRate,
      depositAmountYuan: record.depositAmount / 100,
      effectiveFrom: dayjs(record.effectiveFrom),
      effectiveTo: record.effectiveTo ? dayjs(record.effectiveTo) : null,
      grade: record.grade,
      status: record.status
    });
    setModalOpen(true);
  }

  async function saveRule(values: DepositRuleValues) {
    const body = {
      customerRatio: values.customerRatio ?? null,
      defaultRate: values.defaultRate,
      depositAmount: Math.round(values.depositAmountYuan * 100),
      effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
      effectiveTo: values.effectiveTo ? values.effectiveTo.format("YYYY-MM-DD") : null,
      grade: values.grade,
      status: values.status
    };

    if (editingRule) {
      await apiFetch<DepositRuleRow>(`/deposit-rules/${editingRule.id}`, {
        body: JSON.stringify(body),
        method: "PATCH"
      });
      void message.success("押金规则已更新");
    } else {
      await apiFetch<DepositRuleRow>("/deposit-rules", {
        body: JSON.stringify(body),
        method: "POST"
      });
      void message.success("押金规则已创建");
    }

    setModalOpen(false);
    form.resetFields();
    await loadData();
  }

  async function deleteRule(record: DepositRuleRow) {
    await apiFetch<{ id: string }>(`/deposit-rules/${record.id}`, { method: "DELETE" });
    void message.success("押金规则已删除");
    await loadData();
  }

  const columns: ColumnsType<DepositRuleRow> = [
    {
      dataIndex: "grade",
      render: (value: string) => <Tag color="blue">{value}</Tag>,
      title: "客户等级",
      width: 90
    },
    {
      dataIndex: "depositAmount",
      render: (value: number) => formatYuan(value),
      title: "押金金额",
      width: 140
    },
    {
      dataIndex: "customerRatio",
      render: (value?: number | null) => formatRate(value),
      title: "客户占比",
      width: 120
    },
    {
      dataIndex: "defaultRate",
      render: (value: number) => formatRate(value),
      title: "违约率",
      width: 120
    },
    { dataIndex: "effectiveFrom", title: "生效日期", width: 130 },
    {
      dataIndex: "effectiveTo",
      render: (value?: string | null) => value ?? "-",
      title: "失效日期",
      width: 130
    },
    {
      dataIndex: "status",
      render: (value: string) => (
        <Tag color={value === "ACTIVE" ? "green" : "default"}>{labelOf(STATUS_LABELS, value)}</Tag>
      ),
      title: "状态",
      width: 100
    },
    {
      render: (_, record) => (
        <Space>
          <Button icon={<EditOutlined />} onClick={() => openEditModal(record)} size="small" />
          <Popconfirm
            cancelText="取消"
            okText="删除"
            onConfirm={() => deleteRule(record)}
            title="确认删除该押金规则？"
          >
            <Button danger icon={<DeleteOutlined />} size="small" />
          </Popconfirm>
        </Space>
      ),
      title: "操作",
      width: 120
    }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            押金规则
          </Typography.Title>
          <Button icon={<PlusOutlined />} onClick={openCreateModal} type="primary">
            新增押金规则
          </Button>
        </Space>
        <Table columns={columns} dataSource={rules} loading={loading} rowKey="id" />
      </Space>

      <Modal
        cancelText="取消"
        okText="保存"
        onCancel={() => {
          setModalOpen(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        open={modalOpen}
        title={editingRule ? "编辑押金规则" : "新增押金规则"}
      >
        <Form<DepositRuleValues> form={form} layout="vertical" onFinish={saveRule}>
          <Form.Item label="客户等级" name="grade" rules={[{ required: true }]}>
            <Select options={gradeOptions} />
          </Form.Item>
          <Form.Item label="押金金额（元）" name="depositAmountYuan" rules={[{ required: true }]}>
            <InputNumber min={0} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="客户占比" name="customerRatio">
            <InputNumber max={1} min={0} precision={6} step={0.01} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="违约率" name="defaultRate" rules={[{ required: true }]}>
            <InputNumber max={1} min={0} precision={6} step={0.001} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="失效日期" name="effectiveTo">
            <DatePicker allowClear style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="状态" name="status" rules={[{ required: true }]}>
            <Select options={statusOptions} />
          </Form.Item>
        </Form>
      </Modal>
    </ProtectedShell>
  );
}
