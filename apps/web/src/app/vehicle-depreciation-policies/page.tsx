"use client";

import {
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined
} from "@ant-design/icons";
import {
  App,
  Button,
  Checkbox,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import {
  VEHICLE_DEPRECIATION_BASIS_SOURCE_LABELS,
  VEHICLE_DEPRECIATION_METHOD_LABELS,
  VEHICLE_DEPRECIATION_POLICY_STATUS_LABELS,
  VEHICLE_DEPRECIATION_RECORD_SOURCE_LABELS,
  VEHICLE_DEPRECIATION_RECORD_STATUS_LABELS,
  VEHICLE_DEPRECIATION_SCHEDULE_STATUS_LABELS,
  labelOf
} from "../../constants/labels";
import { apiFetch } from "../../lib/api";
import {
  buildQuery,
  formatDate,
  formatDateTime,
  formatYuan,
  getErrorMessage,
  optionsFromLabels,
  toCentAmount,
  yuanFromCents
} from "../../lib/capital-format";

interface VehicleBrief {
  brand: string;
  id: string;
  model?: string | null;
  plateNo?: string | null;
  purchasePriceAmount: number;
  series?: string | null;
  vehicleNo: string;
}

interface VehicleDepreciationPolicyRow {
  activatedAt?: string | null;
  archivedAt?: string | null;
  assetCostProfileId?: string | null;
  basisSource: string;
  confirmedRecordCount: number;
  createdAt: string;
  currency?: string | null;
  depreciationBasisAmount: number;
  depreciationEndDate?: string | null;
  depreciationMethod: string;
  depreciationStartDate: string;
  id: string;
  monthlyDepreciationAmount?: number | null;
  policyNo: string;
  policyStatus: string;
  recordCount: number;
  records: VehicleDepreciationRecordRow[];
  remark?: string | null;
  residualValueAmount: number;
  scheduleCount: number;
  schedules: VehicleDepreciationScheduleRow[];
  suspendedAt?: string | null;
  terminatedAt?: string | null;
  updatedAt: string;
  usefulLifeMonths?: number | null;
  vehicle: {
    displayName: string;
    id: string;
    plateNo?: string | null;
    purchasePriceAmount: number;
    vehicleNo: string;
  };
  vehicleId: string;
}

interface VehicleDepreciationScheduleRow {
  confirmedAt?: string | null;
  costPeriod: string;
  createdAt?: string | null;
  currency?: string | null;
  generatedAt?: string | null;
  id: string;
  lockedAt?: string | null;
  periodEnd: string;
  periodStart: string;
  records?: VehicleDepreciationRecordRow[];
  remark?: string | null;
  scheduleNo: string;
  scheduleStatus: string;
  scheduledAmount: number;
  voidedAt?: string | null;
}

interface VehicleDepreciationRecordRow {
  confirmedAt?: string | null;
  costPeriod: string;
  createdAt?: string | null;
  currency?: string | null;
  depreciationAmount: number;
  id: string;
  lockedAt?: string | null;
  periodEnd: string;
  periodStart: string;
  recordNo: string;
  recordSource: string;
  recordStatus: string;
  remark?: string | null;
  scheduleId?: string | null;
  voidedAt?: string | null;
}

interface ListResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

interface FilterValues {
  depreciationMethod?: string;
  policyStatus?: string;
  vehicleId?: string;
}

interface PolicyFormValues {
  assetCostProfileId?: string | null;
  basisSource?: string;
  currency?: string | null;
  depreciationBasisAmountYuan?: number;
  depreciationEndDate?: Dayjs | null;
  depreciationMethod?: string;
  depreciationStartDate?: Dayjs;
  policyNo?: string | null;
  remark?: string | null;
  residualValueAmountYuan?: number;
  usefulLifeMonths?: number | null;
  vehicleId?: string;
}

interface GenerateFormValues {
  dryRun?: boolean;
}

interface RecordFormValues {
  costPeriod?: string;
  depreciationAmountYuan?: number;
  periodEnd?: Dayjs;
  periodStart?: Dayjs;
  remark?: string | null;
}

type PolicyAction = "activate" | "archive" | "suspend" | "terminate";
type ScheduleAction = "confirm" | "lock" | "void";
type RecordAction = "confirm" | "lock" | "void";

const policyStatusOptions = optionsFromLabels(VEHICLE_DEPRECIATION_POLICY_STATUS_LABELS);
const methodOptions = optionsFromLabels(VEHICLE_DEPRECIATION_METHOD_LABELS);
const basisSourceOptions = optionsFromLabels(VEHICLE_DEPRECIATION_BASIS_SOURCE_LABELS);

const policyStatusColors: Record<string, string> = {
  ACTIVE: "green",
  ARCHIVED: "default",
  DRAFT: "default",
  SUSPENDED: "orange",
  TERMINATED: "red"
};

const scheduleStatusColors: Record<string, string> = {
  CONFIRMED: "green",
  LOCKED: "blue",
  SCHEDULED: "orange",
  VOIDED: "red"
};

export default function VehicleDepreciationPoliciesPage() {
  const { message, modal } = App.useApp();
  const [filterForm] = Form.useForm<FilterValues>();
  const [policyForm] = Form.useForm<PolicyFormValues>();
  const [generateForm] = Form.useForm<GenerateFormValues>();
  const [recordForm] = Form.useForm<RecordFormValues>();
  const [rows, setRows] = useState<VehicleDepreciationPolicyRow[]>([]);
  const [vehicles, setVehicles] = useState<VehicleBrief[]>([]);
  const [detail, setDetail] = useState<VehicleDepreciationPolicyRow | null>(null);
  const [editing, setEditing] = useState<VehicleDepreciationPolicyRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [dryRunRows, setDryRunRows] = useState<VehicleDepreciationScheduleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [creatingRecord, setCreatingRecord] = useState(false);

  const vehicleOptions = useMemo(
    () =>
      vehicles.map((vehicle) => ({
        label: [vehicle.vehicleNo, vehicle.plateNo, vehicle.brand, vehicle.series, vehicle.model]
          .filter(Boolean)
          .join(" / "),
        value: vehicle.id
      })),
    [vehicles]
  );

  const loadVehicles = useCallback(async () => {
    try {
      setVehicles(await apiFetch<VehicleBrief[]>("/vehicles"));
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }, [message]);

  const loadPolicies = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiFetch<ListResponse<VehicleDepreciationPolicyRow>>(
        `/vehicle-depreciation-policies${buildQuery(filterForm.getFieldsValue())}`
      );
      setRows(result.items);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [filterForm, message]);

  useEffect(() => {
    const vehicleId = new URLSearchParams(window.location.search).get("vehicleId");
    if (vehicleId) {
      filterForm.setFieldsValue({ vehicleId });
    }
    void loadVehicles();
    void loadPolicies();
  }, [filterForm, loadPolicies, loadVehicles]);

  function openCreate() {
    setEditing(null);
    policyForm.resetFields();
    policyForm.setFieldsValue({
      basisSource: "PURCHASE_COST",
      currency: "CNY",
      depreciationMethod: "STRAIGHT_LINE",
      depreciationStartDate: dayjs(),
      residualValueAmountYuan: 0
    });
    setFormOpen(true);
  }

  function openEdit(row: VehicleDepreciationPolicyRow) {
    setEditing(row);
    policyForm.setFieldsValue({
      assetCostProfileId: row.assetCostProfileId,
      basisSource: row.basisSource,
      currency: row.currency ?? "CNY",
      depreciationBasisAmountYuan: yuanFromCents(row.depreciationBasisAmount),
      depreciationEndDate: row.depreciationEndDate ? dayjs(row.depreciationEndDate) : null,
      depreciationMethod: row.depreciationMethod,
      depreciationStartDate: dayjs(row.depreciationStartDate),
      policyNo: row.policyNo,
      remark: row.remark,
      residualValueAmountYuan: yuanFromCents(row.residualValueAmount),
      usefulLifeMonths: row.usefulLifeMonths,
      vehicleId: row.vehicleId
    });
    setFormOpen(true);
  }

  async function openDetail(row: VehicleDepreciationPolicyRow) {
    try {
      const next = await apiFetch<VehicleDepreciationPolicyRow>(`/vehicle-depreciation-policies/${row.id}`);
      setDetail(next);
      setDryRunRows([]);
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function refreshDetail() {
    if (!detail) {
      return;
    }
    await openDetail(detail);
  }

  async function submitPolicy(values: PolicyFormValues) {
    if (!values.depreciationMethod || !values.depreciationStartDate || values.depreciationBasisAmountYuan === undefined) {
      void message.warning("请填写折旧方法、折旧基数和起算日");
      return;
    }
    if (!editing && !values.vehicleId) {
      void message.warning("请选择车辆");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        assetCostProfileId: values.assetCostProfileId ?? null,
        basisSource: values.basisSource ?? "PURCHASE_COST",
        currency: values.currency ?? "CNY",
        depreciationBasisAmount: toCentAmount(values.depreciationBasisAmountYuan),
        depreciationEndDate: values.depreciationEndDate?.format("YYYY-MM-DD") ?? null,
        depreciationMethod: values.depreciationMethod,
        depreciationStartDate: values.depreciationStartDate.format("YYYY-MM-DD"),
        policyNo: values.policyNo ?? null,
        remark: values.remark ?? null,
        residualValueAmount: toCentAmount(values.residualValueAmountYuan ?? 0),
        usefulLifeMonths: values.usefulLifeMonths ?? null
      };
      if (editing) {
        await apiFetch(`/vehicle-depreciation-policies/${editing.id}`, {
          body: JSON.stringify(payload),
          method: "PATCH"
        });
      } else {
        await apiFetch(`/vehicles/${values.vehicleId}/depreciation-policies`, {
          body: JSON.stringify(payload),
          method: "POST"
        });
      }
      setFormOpen(false);
      void message.success("折旧 policy 已保存");
      await loadPolicies();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function runPolicyAction(row: VehicleDepreciationPolicyRow, action: PolicyAction) {
    try {
      await apiFetch(`/vehicle-depreciation-policies/${row.id}/${action}`, { method: "POST" });
      void message.success("policy 状态已更新");
      await loadPolicies();
      if (detail?.id === row.id) {
        await openDetail(row);
      }
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function generateSchedules(values: GenerateFormValues) {
    if (!detail) {
      return;
    }
    setGenerating(true);
    try {
      const result = await apiFetch<{
        dryRun: boolean;
        generatedCount: number;
        schedules: VehicleDepreciationScheduleRow[];
        skippedCount: number;
      }>(`/vehicle-depreciation-policies/${detail.id}/schedules/generate`, {
        body: JSON.stringify({ dryRun: Boolean(values.dryRun) }),
        method: "POST"
      });
      if (values.dryRun) {
        setDryRunRows(result.schedules);
        void message.success(`试算完成，已有 ${result.skippedCount} 个账期会跳过`);
      } else {
        setDryRunRows([]);
        void message.success(`已生成 ${result.generatedCount} 条，跳过 ${result.skippedCount} 条`);
        await refreshDetail();
        await loadPolicies();
      }
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setGenerating(false);
    }
  }

  async function runScheduleAction(row: VehicleDepreciationScheduleRow, action: ScheduleAction) {
    try {
      await apiFetch(`/vehicle-depreciation-schedules/${row.id}/${action}`, {
        body: "{}",
        method: "POST"
      });
      void message.success("schedule 状态已更新");
      await refreshDetail();
      await loadPolicies();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function createManualRecord(values: RecordFormValues) {
    if (!detail || !values.costPeriod || !values.periodStart || !values.periodEnd || values.depreciationAmountYuan === undefined) {
      void message.warning("请填写账期、归属期间和折旧金额");
      return;
    }
    setCreatingRecord(true);
    try {
      await apiFetch(`/vehicle-depreciation-policies/${detail.id}/records`, {
        body: JSON.stringify({
          costPeriod: values.costPeriod,
          depreciationAmount: toCentAmount(values.depreciationAmountYuan),
          periodEnd: values.periodEnd.format("YYYY-MM-DD"),
          periodStart: values.periodStart.format("YYYY-MM-DD"),
          recordSource: "MANUAL",
          remark: values.remark ?? null
        }),
        method: "POST"
      });
      recordForm.resetFields();
      void message.success("手工折旧 record 已创建");
      await refreshDetail();
      await loadPolicies();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setCreatingRecord(false);
    }
  }

  async function runRecordAction(row: VehicleDepreciationRecordRow, action: RecordAction) {
    try {
      await apiFetch(`/vehicle-depreciation-records/${row.id}/${action}`, {
        body: "{}",
        method: "POST"
      });
      void message.success("record 状态已更新");
      await refreshDetail();
      await loadPolicies();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  const columns: ColumnsType<VehicleDepreciationPolicyRow> = [
    { dataIndex: "policyNo", title: "Policy No", width: 170 },
    { dataIndex: ["vehicle", "displayName"], title: "车辆", width: 240 },
    {
      dataIndex: "policyStatus",
      render: (value: string) => (
        <Tag color={policyStatusColors[value] ?? "default"}>
          {labelOf(VEHICLE_DEPRECIATION_POLICY_STATUS_LABELS, value)}
        </Tag>
      ),
      title: "状态",
      width: 100
    },
    {
      dataIndex: "depreciationMethod",
      render: (value: string) => labelOf(VEHICLE_DEPRECIATION_METHOD_LABELS, value),
      title: "折旧方法",
      width: 120
    },
    { dataIndex: "depreciationBasisAmount", render: formatYuan, title: "折旧基数", width: 120 },
    { dataIndex: "residualValueAmount", render: formatYuan, title: "残值", width: 120 },
    { dataIndex: "usefulLifeMonths", render: (value?: number | null) => value ?? "-", title: "使用月数", width: 100 },
    { dataIndex: "depreciationStartDate", render: formatDate, title: "起算日", width: 120 },
    { dataIndex: "scheduleCount", title: "Schedule", width: 100 },
    { dataIndex: "confirmedRecordCount", title: "已确认", width: 90 },
    {
      fixed: "right",
      render: (_, row) => (
        <Space>
          <Button icon={<EyeOutlined />} onClick={() => void openDetail(row)} size="small" type="link">
            详情
          </Button>
          <Button onClick={() => openEdit(row)} size="small" type="link">
            编辑
          </Button>
          <Button onClick={() => void runPolicyAction(row, "activate")} size="small" type="link">
            激活
          </Button>
          <Button onClick={() => void runPolicyAction(row, "suspend")} size="small" type="link">
            暂停
          </Button>
        </Space>
      ),
      title: "操作",
      width: 260
    }
  ];

  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
          <div>
            <Typography.Title level={3} style={{ marginBottom: 4 }}>
              车辆折旧管理
            </Typography.Title>
            <Typography.Text type="secondary">维护折旧 policy、schedule 和月度 record。</Typography.Text>
          </div>
          <Space>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadPolicies()}>
              刷新
            </Button>
            <Button icon={<PlusOutlined />} onClick={openCreate} type="primary">
              新建 policy
            </Button>
          </Space>
        </Space>

        <Form form={filterForm} layout="inline" onFinish={() => void loadPolicies()}>
          <Form.Item label="车辆" name="vehicleId">
            <Select allowClear options={vehicleOptions} showSearch style={{ width: 280 }} />
          </Form.Item>
          <Form.Item label="状态" name="policyStatus">
            <Select allowClear options={policyStatusOptions} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item label="方法" name="depreciationMethod">
            <Select allowClear options={methodOptions} style={{ width: 140 }} />
          </Form.Item>
          <Button htmlType="submit" type="primary">
            查询
          </Button>
        </Form>

        <Table columns={columns} dataSource={rows} loading={loading} rowKey="id" scroll={{ x: 1500 }} />
      </Space>

      <Drawer
        destroyOnClose
        onClose={() => setFormOpen(false)}
        open={formOpen}
        title={editing ? "编辑折旧 policy" : "新建折旧 policy"}
        width={700}
      >
        <Form form={policyForm} layout="vertical" onFinish={(values) => void submitPolicy(values)}>
          {!editing ? (
            <Form.Item label="车辆" name="vehicleId" rules={[{ required: true, message: "请选择车辆" }]}>
              <Select options={vehicleOptions} showSearch />
            </Form.Item>
          ) : null}
          <Space style={{ width: "100%" }} wrap>
            <Form.Item label="Policy No" name="policyNo" style={{ flex: "1 1 220px" }}>
              <Input placeholder="为空时自动生成" />
            </Form.Item>
            <Form.Item label="折旧方法" name="depreciationMethod" rules={[{ required: true, message: "请选择折旧方法" }]} style={{ flex: "1 1 180px" }}>
              <Select options={methodOptions} />
            </Form.Item>
            <Form.Item label="基数来源" name="basisSource" style={{ flex: "1 1 180px" }}>
              <Select options={basisSourceOptions} />
            </Form.Item>
          </Space>
          <Space style={{ width: "100%" }} wrap>
            <Form.Item label="折旧基数（元）" name="depreciationBasisAmountYuan" rules={[{ required: true, message: "请输入折旧基数" }]} style={{ flex: "1 1 180px" }}>
              <InputNumber min={0} precision={2} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="残值（元）" name="residualValueAmountYuan" style={{ flex: "1 1 180px" }}>
              <InputNumber min={0} precision={2} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="使用月数" name="usefulLifeMonths" style={{ flex: "1 1 140px" }}>
              <InputNumber min={1} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Space>
          <Space style={{ width: "100%" }} wrap>
            <Form.Item label="起算日" name="depreciationStartDate" rules={[{ required: true, message: "请选择起算日" }]} style={{ flex: "1 1 180px" }}>
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="结束日" name="depreciationEndDate" style={{ flex: "1 1 180px" }}>
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="币种" name="currency" style={{ flex: "1 1 120px" }}>
              <Input maxLength={16} />
            </Form.Item>
          </Space>
          <Form.Item label="Asset Cost Profile ID" name="assetCostProfileId">
            <Input placeholder="可选，用于记录来源快照" />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Button htmlType="submit" loading={submitting} type="primary">
            保存
          </Button>
        </Form>
      </Drawer>

      <Drawer onClose={() => setDetail(null)} open={Boolean(detail)} title="折旧 policy 详情" width={1080}>
        {detail ? (
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Descriptions
              bordered
              column={2}
              size="small"
              items={[
                { label: "Policy No", children: detail.policyNo },
                { label: "车辆", children: detail.vehicle.displayName },
                {
                  label: "状态",
                  children: (
                    <Tag color={policyStatusColors[detail.policyStatus] ?? "default"}>
                      {labelOf(VEHICLE_DEPRECIATION_POLICY_STATUS_LABELS, detail.policyStatus)}
                    </Tag>
                  )
                },
                { label: "折旧方法", children: labelOf(VEHICLE_DEPRECIATION_METHOD_LABELS, detail.depreciationMethod) },
                { label: "折旧基数", children: formatYuan(detail.depreciationBasisAmount) },
                { label: "残值", children: formatYuan(detail.residualValueAmount) },
                { label: "使用月数", children: detail.usefulLifeMonths ?? "-" },
                { label: "月折旧", children: formatYuan(detail.monthlyDepreciationAmount) },
                { label: "起算日", children: formatDate(detail.depreciationStartDate) },
                { label: "结束日", children: formatDate(detail.depreciationEndDate) },
                { label: "Schedule 数", children: detail.scheduleCount },
                { label: "已确认 Record 数", children: detail.confirmedRecordCount },
                { label: "更新时间", children: formatDateTime(detail.updatedAt) },
                { label: "备注", children: detail.remark ?? "-" }
              ]}
            />
            <Space>
              <Button onClick={() => void runPolicyAction(detail, "activate")}>激活</Button>
              <Button onClick={() => void runPolicyAction(detail, "suspend")}>暂停</Button>
              <Button danger onClick={() => void runPolicyAction(detail, "terminate")}>
                终止
              </Button>
              <Button
                danger
                onClick={() =>
                  modal.confirm({
                    content: "归档后该 policy 不再作为可用策略展示，确认归档？",
                    onOk: () => runPolicyAction(detail, "archive"),
                    title: "归档折旧 policy"
                  })
                }
              >
                归档
              </Button>
            </Space>

            <Typography.Title level={5}>Schedule 生成</Typography.Title>
            <Form form={generateForm} layout="inline" onFinish={(values) => void generateSchedules(values)}>
              <Form.Item name="dryRun" valuePropName="checked">
                <Checkbox>仅试算</Checkbox>
              </Form.Item>
              <Button htmlType="submit" loading={generating} type="primary">
                生成直线法 schedule
              </Button>
            </Form>
            {dryRunRows.length > 0 ? (
              <Table
                columns={dryRunScheduleColumns}
                dataSource={dryRunRows}
                pagination={false}
                rowKey={(row) => `${row.costPeriod}-${row.periodStart}`}
                scroll={{ x: 700 }}
                size="small"
              />
            ) : null}

            <Typography.Title level={5}>Schedule 列表</Typography.Title>
            <Table
              columns={scheduleColumns(runScheduleAction)}
              dataSource={detail.schedules}
              pagination={false}
              rowKey="id"
              scroll={{ x: 900 }}
              size="small"
            />

            <Typography.Title level={5}>手工折旧补录</Typography.Title>
            <Form form={recordForm} layout="inline" onFinish={(values) => void createManualRecord(values)}>
              <Form.Item label="账期" name="costPeriod">
                <Input placeholder="2026-07" style={{ width: 120 }} />
              </Form.Item>
              <Form.Item label="开始" name="periodStart">
                <DatePicker />
              </Form.Item>
              <Form.Item label="结束" name="periodEnd">
                <DatePicker />
              </Form.Item>
              <Form.Item label="金额（元）" name="depreciationAmountYuan">
                <InputNumber min={0} precision={2} style={{ width: 140 }} />
              </Form.Item>
              <Form.Item name="remark">
                <Input placeholder="备注" style={{ width: 180 }} />
              </Form.Item>
              <Button htmlType="submit" loading={creatingRecord} type="primary">
                创建 record
              </Button>
            </Form>

            <Typography.Title level={5}>Record 列表</Typography.Title>
            <Table
              columns={recordColumns(runRecordAction)}
              dataSource={detail.records}
              pagination={false}
              rowKey="id"
              scroll={{ x: 980 }}
              size="small"
            />
          </Space>
        ) : null}
      </Drawer>
    </ProtectedShell>
  );
}

const dryRunScheduleColumns: ColumnsType<VehicleDepreciationScheduleRow> = [
  { dataIndex: "costPeriod", title: "账期", width: 90 },
  { dataIndex: "periodStart", render: formatDate, title: "开始", width: 120 },
  { dataIndex: "periodEnd", render: formatDate, title: "结束", width: 120 },
  { dataIndex: "scheduledAmount", render: formatYuan, title: "金额", width: 120 },
  {
    dataIndex: "exists",
    render: (value?: boolean) => (value ? <Tag color="orange">已存在</Tag> : <Tag color="green">待生成</Tag>),
    title: "状态",
    width: 100
  } as ColumnsType<VehicleDepreciationScheduleRow>[number]
];

function scheduleColumns(
  runScheduleAction: (row: VehicleDepreciationScheduleRow, action: ScheduleAction) => Promise<void>
): ColumnsType<VehicleDepreciationScheduleRow> {
  return [
    { dataIndex: "costPeriod", title: "账期", width: 90 },
    { dataIndex: "periodStart", render: formatDate, title: "开始", width: 110 },
    { dataIndex: "periodEnd", render: formatDate, title: "结束", width: 110 },
    { dataIndex: "scheduledAmount", render: formatYuan, title: "计划金额", width: 120 },
    {
      dataIndex: "scheduleStatus",
      render: (value: string) => (
        <Tag color={scheduleStatusColors[value] ?? "default"}>
          {labelOf(VEHICLE_DEPRECIATION_SCHEDULE_STATUS_LABELS, value)}
        </Tag>
      ),
      title: "状态",
      width: 110
    },
    {
      render: (_, row) => (
        <Space>
          <Button onClick={() => void runScheduleAction(row, "confirm")} size="small" type="link">
            确认
          </Button>
          <Button onClick={() => void runScheduleAction(row, "lock")} size="small" type="link">
            锁定
          </Button>
          <Button danger onClick={() => void runScheduleAction(row, "void")} size="small" type="link">
            作废
          </Button>
        </Space>
      ),
      title: "操作",
      width: 170
    }
  ];
}

function recordColumns(
  runRecordAction: (row: VehicleDepreciationRecordRow, action: RecordAction) => Promise<void>
): ColumnsType<VehicleDepreciationRecordRow> {
  return [
    { dataIndex: "recordNo", title: "Record No", width: 160 },
    { dataIndex: "costPeriod", title: "账期", width: 90 },
    { dataIndex: "periodStart", render: formatDate, title: "开始", width: 110 },
    { dataIndex: "periodEnd", render: formatDate, title: "结束", width: 110 },
    { dataIndex: "depreciationAmount", render: formatYuan, title: "金额", width: 120 },
    {
      dataIndex: "recordStatus",
      render: (value: string) => (
        <Tag color={scheduleStatusColors[value] ?? "default"}>
          {labelOf(VEHICLE_DEPRECIATION_RECORD_STATUS_LABELS, value)}
        </Tag>
      ),
      title: "状态",
      width: 110
    },
    {
      dataIndex: "recordSource",
      render: (value: string) => labelOf(VEHICLE_DEPRECIATION_RECORD_SOURCE_LABELS, value),
      title: "来源",
      width: 110
    },
    {
      render: (_, row) => (
        <Space>
          <Button onClick={() => void runRecordAction(row, "confirm")} size="small" type="link">
            确认
          </Button>
          <Button onClick={() => void runRecordAction(row, "lock")} size="small" type="link">
            锁定
          </Button>
          <Button danger onClick={() => void runRecordAction(row, "void")} size="small" type="link">
            作废
          </Button>
        </Space>
      ),
      title: "操作",
      width: 170
    }
  ];
}
