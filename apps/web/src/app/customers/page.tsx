"use client";

import {
  App,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import { STATUS_LABELS, labelOf } from "../../constants/labels";
import { apiFetch } from "../../lib/api";

interface CustomerApplicationSummary {
  applicationNo: string;
  id: string;
  intendedModel?: string | null;
  status: string;
}

interface CustomerRow {
  applications: CustomerApplicationSummary[];
  createdAt: string;
  customerNo: string;
  customerType: string;
  grade?: string | null;
  id: string;
  mobile: string;
  name: string;
  ownerUser?: { id: string; name: string; username: string } | null;
  remark?: string | null;
  riskScore?: number | null;
  sourceChannel?: string | null;
  status: string;
}

interface CreateCustomerValues {
  customerType?: string;
  mobile: string;
  name: string;
  remark?: string;
  sourceChannel?: string;
}

const statusColors: Record<string, string> = {
  ACTIVE: "green",
  APPROVED: "green",
  BLACKLISTED: "red",
  FROZEN: "orange",
  LEAD: "blue",
  PENDING_APPLICATION: "gold",
  REJECTED: "red",
  UNDER_REVIEW: "purple"
};

function customerTypeLabel(value: string) {
  return value === "COMPANY" ? "企业" : "个人";
}

export default function CustomersPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<CreateCustomerValues>();
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [detail, setDetail] = useState<CustomerRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      setCustomers(await apiFetch<CustomerRow[]>("/customers"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function createCustomer(values: CreateCustomerValues) {
    await apiFetch<CustomerRow>("/customers", {
      body: JSON.stringify(values),
      method: "POST"
    });
    void message.success("客户已创建");
    setModalOpen(false);
    form.resetFields();
    await loadData();
  }

  async function openDetail(id: string) {
    setDetail(await apiFetch<CustomerRow>(`/customers/${id}`));
  }

  const columns: ColumnsType<CustomerRow> = [
    { dataIndex: "customerNo", title: "客户编号", width: 180 },
    { dataIndex: "name", title: "客户姓名", width: 120 },
    { dataIndex: "mobile", title: "手机号", width: 140 },
    {
      dataIndex: "customerType",
      render: customerTypeLabel,
      title: "客户类型",
      width: 100
    },
    { dataIndex: "sourceChannel", render: (value?: string | null) => value ?? "-", title: "来源渠道", width: 120 },
    {
      dataIndex: "status",
      render: (value: string) => (
        <Tag color={statusColors[value] ?? "default"}>{labelOf(STATUS_LABELS, value)}</Tag>
      ),
      title: "状态",
      width: 160
    },
    {
      dataIndex: "ownerUser",
      render: (value?: CustomerRow["ownerUser"]) => value?.name ?? "-",
      title: "所属销售",
      width: 120
    },
    {
      render: (_, record) => (
        <Button onClick={() => openDetail(record.id)} size="small">
          查看详情
        </Button>
      ),
      title: "操作",
      width: 100
    }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            客户中心
          </Typography.Title>
          <Button onClick={() => setModalOpen(true)} type="primary">
            新增客户
          </Button>
        </Space>
        <Table columns={columns} dataSource={customers} loading={loading} rowKey="id" />
      </Space>

      <Modal
        cancelText="取消"
        okText="保存"
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        open={modalOpen}
        title="新增客户"
      >
        <Form<CreateCustomerValues>
          form={form}
          initialValues={{ customerType: "PERSONAL" }}
          layout="vertical"
          onFinish={createCustomer}
        >
          <Form.Item label="客户姓名" name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="手机号" name="mobile" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="客户类型" name="customerType">
            <Select
              options={[
                { label: "个人", value: "PERSONAL" },
                { label: "企业", value: "COMPANY" }
              ]}
            />
          </Form.Item>
          <Form.Item label="来源渠道" name="sourceChannel">
            <Input />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        onClose={() => setDetail(null)}
        open={Boolean(detail)}
        title={detail ? `${detail.name} / ${detail.customerNo}` : "客户详情"}
        size={720}
      >
        {detail ? (
          <Space orientation="vertical" size={18} style={{ width: "100%" }}>
            <Descriptions
              bordered
              column={2}
              items={[
                { label: "客户姓名", children: detail.name },
                { label: "手机号", children: detail.mobile },
                { label: "客户类型", children: customerTypeLabel(detail.customerType) },
                {
                  label: "状态",
                  children: (
                    <Tag color={statusColors[detail.status] ?? "default"}>
                      {labelOf(STATUS_LABELS, detail.status)}
                    </Tag>
                  )
                },
                { label: "客户等级", children: detail.grade ?? "-" },
                { label: "风控评分", children: detail.riskScore ?? "-" },
                { label: "所属销售", children: detail.ownerUser?.name ?? "-" },
                { label: "来源渠道", children: detail.sourceChannel ?? "-" },
                { label: "备注", children: detail.remark ?? "-", span: 2 }
              ]}
            />
            <Table
              columns={[
                { dataIndex: "applicationNo", title: "进件编号" },
                { dataIndex: "intendedModel", title: "意向车型" },
                {
                  dataIndex: "status",
                  render: (value: string) => <Tag>{labelOf(STATUS_LABELS, value)}</Tag>,
                  title: "状态"
                }
              ]}
              dataSource={detail.applications}
              pagination={false}
              rowKey="id"
              size="small"
              title={() => "关联进件"}
            />
          </Space>
        ) : null}
      </Drawer>
    </ProtectedShell>
  );
}
