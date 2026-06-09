"use client";

import { EyeOutlined, PlusOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import {
  App,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../components/action-button";
import { ProtectedShell } from "../../components/protected-shell";
import {
  FINANCING_INSTRUMENT_TYPE_LABELS,
  REVENUE_RIGHT_ASSIGNEE_TYPE_LABELS,
  REVENUE_RIGHT_ASSIGNMENT_STATUS_LABELS,
  REVENUE_RIGHT_ASSIGNMENT_TYPE_LABELS,
  REVENUE_RIGHT_TARGET_TYPE_LABELS,
  labelOf
} from "../../constants/labels";
import { apiFetch } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";
import {
  buildQuery,
  formatDate,
  formatPercentFromBps,
  formatYuan,
  getErrorMessage,
  optionsFromLabels,
  percentToBps,
  safeText
} from "../../lib/capital-format";

interface AssignmentVehicle {
  acquisitionMode?: string | null;
  id: string;
  vehicleNo?: string | null;
}

interface AssignmentOrder {
  id: string;
  orderNo?: string | null;
  vehicleId?: string | null;
}

interface AssignmentBill {
  billNo?: string | null;
  billType?: string | null;
  id: string;
  paidAmount?: number | null;
  remainingAmount?: number | null;
}

interface AssignmentInstrument {
  id: string;
  instrumentNo?: string | null;
  instrumentType?: string | null;
  lenderName?: string | null;
}

interface RevenueRightAssignmentRow {
  assigneeName?: string | null;
  assigneeType: string;
  assignmentNo: string;
  assignmentStatus: string;
  assignmentType: string;
  bill?: AssignmentBill | null;
  billId?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  financingInstrument?: AssignmentInstrument | null;
  financingInstrumentId?: string | null;
  id: string;
  order?: AssignmentOrder | null;
  orderId?: string | null;
  priority?: number | null;
  releaseReason?: string | null;
  releasedAt?: string | null;
  remark?: string | null;
  shareRatioBps?: number | null;
  targetType: string;
  vehicle?: AssignmentVehicle | null;
  vehicleId?: string | null;
}

interface AssignmentListResponse {
  items: RevenueRightAssignmentRow[];
  page: number;
  pageSize: number;
  total: number;
}

interface AssignmentFilterValues {
  assigneeType?: string;
  assignmentStatus?: string;
  assignmentType?: string;
  billId?: string;
  financingInstrumentId?: string;
  orderId?: string;
  targetType?: string;
  vehicleId?: string;
}

interface AssignmentFormValues {
  assigneeName?: string | null;
  assigneeType: string;
  assignmentType: string;
  billId?: string | null;
  effectiveFrom: Dayjs;
  financingInstrumentId?: string | null;
  orderId?: string | null;
  priority?: number | null;
  remark?: string | null;
  shareRatioPercent?: number | null;
  targetType: string;
  vehicleId?: string | null;
}

interface ReleaseAssignmentFormValues {
  releaseReason?: string | null;
  releasedAt: Dayjs;
  remark?: string | null;
}

const statusColors: Record<string, string> = {
  ACTIVE: "green",
  CANCELLED: "default",
  RELEASED: "blue"
};

const financingRequiredTypes = new Set(["PLEDGE", "TRANSFER", "SPV_POOL"]);

function formatTag(labels: Record<string, string>, value?: string | null) {
  if (!value) {
    return "-";
  }
  return <Tag color={statusColors[value] ?? "default"}>{labelOf(labels, value)}</Tag>;
}

function vehicleText(vehicle?: AssignmentVehicle | null, vehicleId?: string | null) {
  return vehicle?.vehicleNo ?? vehicleId ?? "-";
}

function orderText(order?: AssignmentOrder | null, orderId?: string | null) {
  return order?.orderNo ?? orderId ?? "-";
}

function billText(bill?: AssignmentBill | null, billId?: string | null) {
  return bill?.billNo ?? billId ?? "-";
}

function instrumentText(instrument?: AssignmentInstrument | null, instrumentId?: string | null) {
  if (!instrument) {
    return instrumentId ?? "-";
  }
  return [instrument.instrumentNo, instrument.lenderName].filter(Boolean).join(" / ") || instrument.id;
}

export default function RevenueRightsPage() {
  const { message, modal } = App.useApp();
  const [filterForm] = Form.useForm<AssignmentFilterValues>();
  const [assignmentForm] = Form.useForm<AssignmentFormValues>();
  const [releaseForm] = Form.useForm<ReleaseAssignmentFormValues>();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [rows, setRows] = useState<RevenueRightAssignmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<RevenueRightAssignmentRow | null>(null);
  const [assignmentModalOpen, setAssignmentModalOpen] = useState(false);
  const [releaseTarget, setReleaseTarget] = useState<RevenueRightAssignmentRow | null>(null);
  const permissions = useMemo(() => new Set(me?.user.permissions ?? []), [me]);
  const canView = permissions.has("revenue_right:view");
  const selectedTargetType = Form.useWatch("targetType", assignmentForm);
  const selectedAssignmentType = Form.useWatch("assignmentType", assignmentForm);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const query = buildQuery(filterForm.getFieldsValue());
      const result = await apiFetch<AssignmentListResponse>(`/revenue-right-assignments${query}`);
      setRows(result.items);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [filterForm, message]);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      try {
        const nextDetail = await apiFetch<RevenueRightAssignmentRow>(`/revenue-right-assignments/${id}`);
        setDetail(nextDetail);
        return nextDetail;
      } catch (error) {
        void message.error(getErrorMessage(error));
        return null;
      } finally {
        setDetailLoading(false);
      }
    },
    [message]
  );

  useEffect(() => {
    apiFetch<AuthMeResponse>("/auth/me")
      .then(setMe)
      .catch((error) => message.error(getErrorMessage(error)));
  }, [message]);

  useEffect(() => {
    if (canView) {
      void loadData();
    }
  }, [canView, loadData]);

  function openCreate() {
    assignmentForm.resetFields();
    assignmentForm.setFieldsValue({
      assigneeType: "FINANCIER",
      assignmentType: "PLEDGE",
      effectiveFrom: dayjs(),
      shareRatioPercent: 100,
      targetType: "RECEIVABLE_BILL"
    });
    setAssignmentModalOpen(true);
  }

  async function submitAssignment(values: AssignmentFormValues) {
    try {
      await apiFetch("/revenue-right-assignments", {
        body: JSON.stringify({
          assigneeName: values.assigneeName,
          assigneeType: values.assigneeType,
          assignmentType: values.assignmentType,
          billId: values.billId,
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          financingInstrumentId: values.financingInstrumentId,
          orderId: values.orderId,
          priority: values.priority,
          remark: values.remark,
          shareRatioBps: percentToBps(values.shareRatioPercent),
          targetType: values.targetType,
          vehicleId: values.vehicleId
        }),
        method: "POST"
      });
      void message.success("收益权安排已创建");
      setAssignmentModalOpen(false);
      assignmentForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function openDetail(record: RevenueRightAssignmentRow) {
    setDetailOpen(true);
    await loadDetail(record.id);
  }

  function openReleaseModal(record: RevenueRightAssignmentRow) {
    setReleaseTarget(record);
    releaseForm.resetFields();
    releaseForm.setFieldsValue({ releasedAt: dayjs() });
  }

  async function submitRelease() {
    if (!releaseTarget) {
      return;
    }

    const values = await releaseForm.validateFields();
    modal.confirm({
      cancelText: "取消",
      content: "确认释放该收益权安排？",
      okText: "确认释放",
      onOk: async () => {
        try {
          await apiFetch(`/revenue-right-assignments/${releaseTarget.id}/release`, {
            body: JSON.stringify({
              releaseReason: values.releaseReason,
              releasedAt: values.releasedAt.format("YYYY-MM-DD"),
              remark: values.remark
            }),
            method: "POST"
          });
          void message.success("收益权安排已释放");
          setReleaseTarget(null);
          releaseForm.resetFields();
          await loadData();
          if (detail?.id === releaseTarget.id) {
            await loadDetail(releaseTarget.id);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        }
      },
      title: "释放收益权安排"
    });
  }

  const columns: ColumnsType<RevenueRightAssignmentRow> = [
    { dataIndex: "assignmentNo", title: "收益权编号", width: 190 },
    {
      dataIndex: "assignmentType",
      render: (value: string) => labelOf(REVENUE_RIGHT_ASSIGNMENT_TYPE_LABELS, value),
      title: "类型",
      width: 130
    },
    {
      dataIndex: "assignmentStatus",
      render: (value: string) => formatTag(REVENUE_RIGHT_ASSIGNMENT_STATUS_LABELS, value),
      title: "状态",
      width: 100
    },
    {
      dataIndex: "targetType",
      render: (value: string) => labelOf(REVENUE_RIGHT_TARGET_TYPE_LABELS, value),
      title: "目标类型",
      width: 120
    },
    { render: (_, record) => vehicleText(record.vehicle, record.vehicleId), title: "车辆", width: 160 },
    { render: (_, record) => orderText(record.order, record.orderId), title: "订单", width: 170 },
    { render: (_, record) => billText(record.bill, record.billId), title: "账单", width: 170 },
    { render: (_, record) => instrumentText(record.financingInstrument, record.financingInstrumentId), title: "融资工具", width: 210 },
    {
      dataIndex: "assigneeType",
      render: (value: string) => labelOf(REVENUE_RIGHT_ASSIGNEE_TYPE_LABELS, value),
      title: "受让 / 质押方类型",
      width: 150
    },
    { dataIndex: "assigneeName", render: safeText, title: "受让 / 质押方名称", width: 170 },
    { dataIndex: "priority", render: safeText, title: "优先级", width: 90 },
    { dataIndex: "shareRatioBps", render: formatPercentFromBps, title: "分配比例", width: 110 },
    { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
    { dataIndex: "releasedAt", render: formatDate, title: "解除日期", width: 120 },
    { dataIndex: "remark", render: safeText, title: "备注", width: 180 },
    {
      fixed: "right",
      render: (_, record) => (
        <Space>
          <ActionButton icon={<EyeOutlined />} onClick={() => openDetail(record)} permission="revenue_right:view" permissions={permissions} size="small">
            查看详情
          </ActionButton>
          <ActionButton
            allowed={record.assignmentStatus === "ACTIVE"}
            disabledReason="仅生效中的收益权安排可以释放"
            icon={<StopOutlined />}
            onClick={() => openReleaseModal(record)}
            permission="revenue_right:manage"
            permissions={permissions}
            size="small"
          >
            释放
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 180
    }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            收益权管理
          </Typography.Title>
          <Space>
            <ActionButton icon={<PlusOutlined />} onClick={openCreate} permission="revenue_right:manage" permissions={permissions} type="primary">
              新增收益权安排
            </ActionButton>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={loadData}>
              刷新
            </Button>
          </Space>
        </Space>

        <Form form={filterForm} layout="inline" onFinish={loadData}>
          <Form.Item label="收益权类型" name="assignmentType">
            <Select allowClear options={optionsFromLabels(REVENUE_RIGHT_ASSIGNMENT_TYPE_LABELS)} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item label="状态" name="assignmentStatus">
            <Select allowClear options={optionsFromLabels(REVENUE_RIGHT_ASSIGNMENT_STATUS_LABELS)} style={{ width: 130 }} />
          </Form.Item>
          <Form.Item label="目标类型" name="targetType">
            <Select allowClear options={optionsFromLabels(REVENUE_RIGHT_TARGET_TYPE_LABELS)} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item label="车辆 ID" name="vehicleId">
            <Input allowClear placeholder="vehicleId" />
          </Form.Item>
          <Form.Item label="订单 ID" name="orderId">
            <Input allowClear placeholder="orderId" />
          </Form.Item>
          <Form.Item label="账单 ID" name="billId">
            <Input allowClear placeholder="billId" />
          </Form.Item>
          <Form.Item label="融资工具 ID" name="financingInstrumentId">
            <Input allowClear placeholder="financingInstrumentId" />
          </Form.Item>
          <Form.Item label="受让方类型" name="assigneeType">
            <Select allowClear options={optionsFromLabels(REVENUE_RIGHT_ASSIGNEE_TYPE_LABELS)} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button htmlType="submit" loading={loading}>
                查询
              </Button>
              <Button
                onClick={() => {
                  filterForm.resetFields();
                  void loadData();
                }}
              >
                重置
              </Button>
            </Space>
          </Form.Item>
        </Form>

        <Table
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: true }}
          rowKey="id"
          scroll={{ x: 2260 }}
          size="small"
        />

        <Drawer
          destroyOnHidden
          loading={detailLoading}
          onClose={() => {
            setDetailOpen(false);
            setDetail(null);
          }}
          open={detailOpen}
          size="large"
          title={detail ? `${detail.assignmentNo} 收益权详情` : "收益权详情"}
        >
          {detail ? (
            <Descriptions
              bordered
              column={2}
              items={[
                { label: "收益权编号", children: detail.assignmentNo },
                { label: "类型", children: labelOf(REVENUE_RIGHT_ASSIGNMENT_TYPE_LABELS, detail.assignmentType) },
                { label: "状态", children: formatTag(REVENUE_RIGHT_ASSIGNMENT_STATUS_LABELS, detail.assignmentStatus) },
                { label: "目标类型", children: labelOf(REVENUE_RIGHT_TARGET_TYPE_LABELS, detail.targetType) },
                { label: "车辆", children: vehicleText(detail.vehicle, detail.vehicleId) },
                { label: "订单", children: orderText(detail.order, detail.orderId) },
                { label: "账单", children: billText(detail.bill, detail.billId) },
                { label: "账单已收金额", children: formatYuan(detail.bill?.paidAmount) },
                { label: "融资工具", children: instrumentText(detail.financingInstrument, detail.financingInstrumentId) },
                {
                  label: "融资类型",
                  children: labelOf(FINANCING_INSTRUMENT_TYPE_LABELS, detail.financingInstrument?.instrumentType)
                },
                { label: "受让 / 质押方类型", children: labelOf(REVENUE_RIGHT_ASSIGNEE_TYPE_LABELS, detail.assigneeType) },
                { label: "受让 / 质押方名称", children: safeText(detail.assigneeName) },
                { label: "优先级", children: safeText(detail.priority) },
                { label: "分配比例", children: formatPercentFromBps(detail.shareRatioBps) },
                { label: "生效日期", children: formatDate(detail.effectiveFrom) },
                { label: "结束日期", children: formatDate(detail.effectiveTo) },
                { label: "解除日期", children: formatDate(detail.releasedAt) },
                { label: "释放原因", children: safeText(detail.releaseReason) },
                { label: "备注", children: safeText(detail.remark) }
              ]}
            />
          ) : null}
        </Drawer>

        <Modal
          destroyOnHidden
          okText="保存"
          onCancel={() => setAssignmentModalOpen(false)}
          onOk={() => assignmentForm.submit()}
          open={assignmentModalOpen}
          title="新增收益权安排"
          width={720}
        >
          <Form<AssignmentFormValues> form={assignmentForm} layout="vertical" onFinish={submitAssignment}>
            <Form.Item label="收益权类型" name="assignmentType" rules={[{ required: true, message: "请选择收益权类型" }]}>
              <Select options={optionsFromLabels(REVENUE_RIGHT_ASSIGNMENT_TYPE_LABELS)} />
            </Form.Item>
            <Form.Item label="目标类型" name="targetType" rules={[{ required: true, message: "请选择目标类型" }]}>
              <Select options={optionsFromLabels(REVENUE_RIGHT_TARGET_TYPE_LABELS)} />
            </Form.Item>
            <Form.Item label="车辆 ID" name="vehicleId" rules={[{ required: selectedTargetType === "VEHICLE", message: "请输入车辆 ID" }]}>
              <Input placeholder="targetType = VEHICLE 时必填" />
            </Form.Item>
            <Form.Item label="订单 ID" name="orderId" rules={[{ required: selectedTargetType === "ORDER", message: "请输入订单 ID" }]}>
              <Input placeholder="targetType = ORDER 时必填" />
            </Form.Item>
            <Form.Item label="账单 ID" name="billId" rules={[{ required: selectedTargetType === "RECEIVABLE_BILL", message: "请输入账单 ID" }]}>
              <Input placeholder="targetType = RECEIVABLE_BILL 时必填" />
            </Form.Item>
            <Form.Item
              label="融资工具 ID"
              name="financingInstrumentId"
              rules={[
                {
                  required: financingRequiredTypes.has(selectedAssignmentType ?? ""),
                  message: "请输入融资工具 ID"
                }
              ]}
            >
              <Input placeholder="PLEDGE / TRANSFER / SPV_POOL 时必填" />
            </Form.Item>
            <Form.Item label="受让 / 质押方类型" name="assigneeType" rules={[{ required: true, message: "请选择受让 / 质押方类型" }]}>
              <Select options={optionsFromLabels(REVENUE_RIGHT_ASSIGNEE_TYPE_LABELS)} />
            </Form.Item>
            <Form.Item label="受让 / 质押方名称" name="assigneeName">
              <Input maxLength={128} />
            </Form.Item>
            <Form.Item label="优先级" name="priority">
              <InputNumber min={0} precision={0} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="分配比例（%）" name="shareRatioPercent">
              <InputNumber max={100} min={0} precision={2} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}>
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          okText="释放"
          onCancel={() => setReleaseTarget(null)}
          onOk={submitRelease}
          open={Boolean(releaseTarget)}
          title="释放收益权安排"
        >
          <Form<ReleaseAssignmentFormValues> form={releaseForm} layout="vertical">
            <Form.Item label="释放日期" name="releasedAt" rules={[{ required: true, message: "请选择释放日期" }]}>
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="释放原因" name="releaseReason">
              <Input.TextArea rows={3} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>
      </Space>
    </ProtectedShell>
  );
}
