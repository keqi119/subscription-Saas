"use client";

import { CheckCircleOutlined, EyeOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  App,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import {
  RESCUE_TYPE_LABELS,
  SERVICE_CASE_ACTION_TYPE_LABELS,
  SERVICE_CASE_ACTOR_TYPE_LABELS,
  SERVICE_CASE_PRIORITY_LABELS,
  SERVICE_CASE_STATUS_LABELS,
  SERVICE_CASE_TYPE_LABELS,
  labelOf
} from "../../constants/labels";
import { ApiError, apiFetch } from "../../lib/api";
import { PortalPagedResponse, PortalServiceCase } from "../../lib/portal-types";

interface FilterValues {
  caseStatus?: string;
  caseType?: string;
  priority?: string;
}

interface ActionFormValues {
  remark?: string;
}

interface StatusFormValues {
  remark?: string;
  toStatus?: string;
}

const statusColors: Record<string, string> = {
  ACCEPTED: "blue",
  CANCELLED: "default",
  CLOSED: "green",
  IN_PROGRESS: "processing",
  RESOLVED: "green",
  SUBMITTED: "gold",
  WAITING_CUSTOMER: "orange"
};

const statusOptions = Object.entries(SERVICE_CASE_STATUS_LABELS).map(([value, label]) => ({ label, value }));
const typeOptions = Object.entries(SERVICE_CASE_TYPE_LABELS).map(([value, label]) => ({ label, value }));
const priorityOptions = Object.entries(SERVICE_CASE_PRIORITY_LABELS).map(([value, label]) => ({ label, value }));
const nextStatusOptions = [
  "IN_PROGRESS",
  "WAITING_CUSTOMER",
  "RESOLVED",
  "CLOSED"
].map((value) => ({ label: labelOf(SERVICE_CASE_STATUS_LABELS, value), value }));

export default function ServiceCasesPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<FilterValues>();
  const [actionForm] = Form.useForm<ActionFormValues>();
  const [statusForm] = Form.useForm<StatusFormValues>();
  const [items, setItems] = useState<PortalServiceCase[]>([]);
  const [detail, setDetail] = useState<PortalServiceCase>();
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadCases = useCallback(async () => {
    setLoading(true);
    try {
      const values = form.getFieldsValue();
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(values)) {
        if (value) {
          params.set(key, String(value));
        }
      }
      const result = await apiFetch<PortalPagedResponse<PortalServiceCase>>(
        `/service-cases${params.size ? `?${params.toString()}` : ""}`
      );
      setItems(result.items);
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : "无法加载服务工单");
    } finally {
      setLoading(false);
    }
  }, [form, message]);

  useEffect(() => {
    void loadCases();
  }, [loadCases]);

  async function openDetail(id: string) {
    try {
      const row = await apiFetch<PortalServiceCase>(`/service-cases/${id}`);
      setDetail(row);
      setDrawerOpen(true);
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : "无法加载工单详情");
    }
  }

  async function mutateDetail(action: () => Promise<PortalServiceCase>) {
    setSubmitting(true);
    try {
      const row = await action();
      setDetail(row);
      actionForm.resetFields();
      statusForm.resetFields();
      void message.success("操作成功");
      await loadCases();
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  const columns: ColumnsType<PortalServiceCase> = [
    {
      dataIndex: "caseNo",
      title: "工单编号"
    },
    {
      dataIndex: "caseType",
      render: (value: string) => labelOf(SERVICE_CASE_TYPE_LABELS, value),
      title: "类型"
    },
    {
      dataIndex: "caseStatus",
      render: (value: string) => (
        <Tag color={statusColors[value] ?? "default"}>{labelOf(SERVICE_CASE_STATUS_LABELS, value)}</Tag>
      ),
      title: "状态"
    },
    {
      dataIndex: "priority",
      render: (value: string) => labelOf(SERVICE_CASE_PRIORITY_LABELS, value),
      title: "优先级"
    },
    {
      render: (_, row) => row.customer?.name ?? "-",
      title: "客户"
    },
    {
      render: (_, row) => row.order?.orderNo ?? "-",
      title: "订单"
    },
    {
      render: (_, row) => row.vehicle?.displayName ?? "-",
      title: "车辆"
    },
    {
      dataIndex: "createdAt",
      render: formatTime,
      title: "提交时间"
    },
    {
      fixed: "right",
      render: (_, row) => (
        <Button icon={<EyeOutlined />} onClick={() => void openDetail(row.id)} type="link">
          查看
        </Button>
      ),
      title: "操作",
      width: 100
    }
  ];

  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          服务工单
        </Typography.Title>

        <Form form={form} layout="inline" onFinish={() => void loadCases()}>
          <Form.Item label="类型" name="caseType">
            <Select allowClear options={typeOptions} placeholder="全部" style={{ width: 150 }} />
          </Form.Item>
          <Form.Item label="状态" name="caseStatus">
            <Select allowClear options={statusOptions} placeholder="全部" style={{ width: 150 }} />
          </Form.Item>
          <Form.Item label="优先级" name="priority">
            <Select allowClear options={priorityOptions} placeholder="全部" style={{ width: 130 }} />
          </Form.Item>
          <Button htmlType="submit" icon={<ReloadOutlined />} loading={loading}>
            查询
          </Button>
        </Form>

        <Table
          columns={columns}
          dataSource={items}
          loading={loading}
          rowKey="id"
          scroll={{ x: 980 }}
        />
      </Space>

      <Drawer
        destroyOnClose
        onClose={() => setDrawerOpen(false)}
        open={drawerOpen}
        title={detail?.caseNo ?? "服务工单"}
        width={720}
      >
        {detail ? (
          <Space direction="vertical" size={18} style={{ width: "100%" }}>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="类型">{labelOf(SERVICE_CASE_TYPE_LABELS, detail.caseType)}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={statusColors[detail.caseStatus] ?? "default"}>
                  {labelOf(SERVICE_CASE_STATUS_LABELS, detail.caseStatus)}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="客户">
                {detail.customer?.name ?? "-"} / {detail.customer?.mobile ?? "-"}
              </Descriptions.Item>
              <Descriptions.Item label="订单">{detail.order?.orderNo ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="车辆">{detail.vehicle?.displayName ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="联系人">{detail.contactName ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="联系电话">{detail.contactPhone ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="位置">{detail.locationText ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="发生时间">{formatTime(detail.occurredAt)}</Descriptions.Item>
              {detail.caseType === "RESCUE_REQUEST" ? (
                <>
                  <Descriptions.Item label="救援类型">
                    {labelOf(RESCUE_TYPE_LABELS, detail.rescueType ?? "")}
                  </Descriptions.Item>
                  <Descriptions.Item label="救援地址">{detail.rescueAddress ?? "-"}</Descriptions.Item>
                </>
              ) : (
                <Descriptions.Item label="保险报案号">{detail.insuranceReportNo ?? "-"}</Descriptions.Item>
              )}
              <Descriptions.Item label="描述">{detail.description ?? "-"}</Descriptions.Item>
            </Descriptions>

            <Space wrap>
              <Button
                disabled={detail.caseStatus !== "SUBMITTED"}
                icon={<CheckCircleOutlined />}
                loading={submitting}
                onClick={() =>
                  void mutateDetail(() =>
                    apiFetch<PortalServiceCase>(`/service-cases/${detail.id}/accept`, {
                      body: JSON.stringify({ remark: "已受理工单" }),
                      method: "POST"
                    })
                  )
                }
                type="primary"
              >
                受理
              </Button>
            </Space>

            <Form form={statusForm} layout="vertical" onFinish={(values) => {
              if (!values.toStatus) {
                void message.warning("请选择目标状态");
                return;
              }
              void mutateDetail(() =>
                apiFetch<PortalServiceCase>(`/service-cases/${detail.id}/status`, {
                  body: JSON.stringify(values),
                  method: "POST"
                })
              );
            }}>
              <Form.Item label="更新状态" name="toStatus">
                <Select options={nextStatusOptions} placeholder="请选择目标状态" />
              </Form.Item>
              <Form.Item label="处理说明" name="remark">
                <Input.TextArea rows={2} />
              </Form.Item>
              <Button htmlType="submit" loading={submitting}>
                更新状态
              </Button>
            </Form>

            <Form form={actionForm} layout="vertical" onFinish={(values) => {
              if (!values.remark?.trim()) {
                void message.warning("请输入处理记录");
                return;
              }
              void mutateDetail(() =>
                apiFetch<PortalServiceCase>(`/service-cases/${detail.id}/actions`, {
                  body: JSON.stringify(values),
                  method: "POST"
                })
              );
            }}>
              <Form.Item label="添加处理记录" name="remark">
                <Input.TextArea rows={3} />
              </Form.Item>
              <Button htmlType="submit" loading={submitting}>
                添加记录
              </Button>
            </Form>

            <Form layout="vertical" onFinish={(values: { closeRemark?: string }) => {
              if (!values.closeRemark?.trim()) {
                void message.warning("请输入关闭说明");
                return;
              }
              void mutateDetail(() =>
                apiFetch<PortalServiceCase>(`/service-cases/${detail.id}/close`, {
                  body: JSON.stringify(values),
                  method: "POST"
                })
              );
            }}>
              <Form.Item label="关闭说明" name="closeRemark">
                <Input.TextArea rows={2} />
              </Form.Item>
              <Button danger htmlType="submit" loading={submitting}>
                关闭工单
              </Button>
            </Form>

            <div>
              <Typography.Title level={5}>处理记录</Typography.Title>
              <Timeline
                items={detail.actions.map((action) => ({
                  children: (
                    <Space direction="vertical" size={2}>
                      <Typography.Text strong>{labelOf(SERVICE_CASE_ACTION_TYPE_LABELS, action.actionType)}</Typography.Text>
                      <Typography.Text type="secondary">
                        {formatTime(action.createdAt)} · {labelOf(SERVICE_CASE_ACTOR_TYPE_LABELS, action.actorType)}
                        {action.actorName ? ` / ${action.actorName}` : ""}
                      </Typography.Text>
                      {action.remark ? <Typography.Text>{action.remark}</Typography.Text> : null}
                    </Space>
                  )
                }))}
              />
            </div>
          </Space>
        ) : null}
      </Drawer>
    </ProtectedShell>
  );
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}
