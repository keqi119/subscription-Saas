"use client";

import {
  EyeOutlined,
  FileTextOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined
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
  Typography,
  Upload
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { UploadFile } from "antd/es/upload/interface";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import {
  VEHICLE_BAAS_BILLING_CYCLE_LABELS,
  VEHICLE_BAAS_CONTRACT_ATTACHMENT_TYPE_LABELS,
  VEHICLE_BAAS_CONTRACT_STATUS_LABELS,
  VEHICLE_BAAS_COST_RECORD_STATUS_LABELS,
  VEHICLE_BAAS_COST_SOURCE_LABELS,
  labelOf
} from "../../constants/labels";
import { API_BASE_URL, apiFetch } from "../../lib/api";
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
  batteryUsageType?: string | null;
  brand: string;
  id: string;
  model?: string | null;
  plateNo?: string | null;
  series?: string | null;
  vehicleNo: string;
}

interface VehicleBaasContractRow {
  activatedAt?: string | null;
  archivedAt?: string | null;
  attachmentCount: number;
  attachments: VehicleBaasAttachment[];
  batteryPackageName?: string | null;
  batterySerialNo?: string | null;
  billingCycle: string;
  contractNo: string;
  contractStatus: string;
  costRecordCount: number;
  costRecords: VehicleBaasCostRecord[];
  createdAt: string;
  currency?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  graceDays?: number | null;
  id: string;
  invoiceRequired: boolean;
  nextDueDate?: string | null;
  paymentDayOfMonth: number;
  providerContractNo?: string | null;
  providerName: string;
  remark?: string | null;
  rentalAmount: number;
  suspendedAt?: string | null;
  taxIncluded: boolean;
  terminatedAt?: string | null;
  unpaidCostCount: number;
  vehicle: {
    batteryUsageType?: string | null;
    displayName: string;
    id: string;
    plateNo?: string | null;
    vehicleNo: string;
  };
  vehicleId: string;
}

interface VehicleBaasAttachment {
  attachmentType: string;
  contractId: string;
  createdAt: string;
  description?: string | null;
  fileName: string;
  fileSize?: number | null;
  id: string;
  mimeType?: string | null;
  originalName?: string | null;
  previewUrl: string;
  title?: string | null;
}

interface VehicleBaasCostRecord {
  confirmedAt?: string | null;
  contractId: string;
  costAmount: number;
  costPeriod: string;
  costRecordNo: string;
  costSource: string;
  costStatus: string;
  createdAt?: string | null;
  currency?: string | null;
  dueDate: string;
  id: string;
  invoiceNo?: string | null;
  paidAt?: string | null;
  paymentRefNo?: string | null;
  periodEnd?: string | null;
  periodStart?: string | null;
  remark?: string | null;
  vehicleId?: string | null;
  voidedAt?: string | null;
}

interface ListResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

interface FilterValues {
  contractStatus?: string;
  providerName?: string;
  vehicleId?: string;
}

interface ContractFormValues {
  batteryPackageName?: string | null;
  batterySerialNo?: string | null;
  billingCycle?: string;
  contractNo?: string | null;
  contractStatus?: string;
  currency?: string | null;
  effectiveFrom?: Dayjs;
  effectiveTo?: Dayjs | null;
  graceDays?: number | null;
  invoiceRequired?: boolean;
  paymentDayOfMonth?: number;
  providerContractNo?: string | null;
  providerName?: string;
  remark?: string | null;
  rentalAmountYuan?: number;
  taxIncluded?: boolean;
  vehicleId?: string;
}

interface AttachmentFormValues {
  attachmentType?: string;
  description?: string | null;
  title?: string | null;
}

interface GenerateFormValues {
  dryRun?: boolean;
  fromPeriod?: string;
  toPeriod?: string;
}

const contractStatusOptions = optionsFromLabels(VEHICLE_BAAS_CONTRACT_STATUS_LABELS);
const billingCycleOptions = optionsFromLabels(VEHICLE_BAAS_BILLING_CYCLE_LABELS);
const attachmentTypeOptions = optionsFromLabels(VEHICLE_BAAS_CONTRACT_ATTACHMENT_TYPE_LABELS);

const statusColors: Record<string, string> = {
  ACTIVE: "green",
  ARCHIVED: "default",
  DRAFT: "default",
  EXPIRED: "red",
  SUSPENDED: "orange",
  TERMINATED: "red"
};

export default function VehicleBaasContractsPage() {
  const { message, modal } = App.useApp();
  const [filterForm] = Form.useForm<FilterValues>();
  const [contractForm] = Form.useForm<ContractFormValues>();
  const [attachmentForm] = Form.useForm<AttachmentFormValues>();
  const [generateForm] = Form.useForm<GenerateFormValues>();
  const [rows, setRows] = useState<VehicleBaasContractRow[]>([]);
  const [vehicles, setVehicles] = useState<VehicleBrief[]>([]);
  const [detail, setDetail] = useState<VehicleBaasContractRow | null>(null);
  const [editing, setEditing] = useState<VehicleBaasContractRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);

  const vehicleOptions = useMemo(
    () =>
      vehicles.map((vehicle) => ({
        label: [vehicle.vehicleNo, vehicle.plateNo, vehicle.brand, vehicle.series, vehicle.model, vehicle.batteryUsageType].filter(Boolean).join(" / "),
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

  const loadContracts = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiFetch<ListResponse<VehicleBaasContractRow>>(
        `/vehicle-baas-contracts${buildQuery(filterForm.getFieldsValue())}`
      );
      setRows(result.items);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [filterForm, message]);

  useEffect(() => {
    void loadVehicles();
    void loadContracts();
  }, [loadContracts, loadVehicles]);

  function openCreate() {
    setEditing(null);
    contractForm.resetFields();
    contractForm.setFieldsValue({
      billingCycle: "MONTHLY",
      contractStatus: "DRAFT",
      currency: "CNY",
      graceDays: 0,
      invoiceRequired: false,
      paymentDayOfMonth: 1,
      taxIncluded: true
    });
    setFormOpen(true);
  }

  function openEdit(row: VehicleBaasContractRow) {
    setEditing(row);
    contractForm.setFieldsValue({
      batteryPackageName: row.batteryPackageName,
      batterySerialNo: row.batterySerialNo,
      billingCycle: row.billingCycle,
      contractNo: row.contractNo,
      contractStatus: row.contractStatus,
      currency: row.currency ?? "CNY",
      effectiveFrom: dayjs(row.effectiveFrom),
      effectiveTo: row.effectiveTo ? dayjs(row.effectiveTo) : null,
      graceDays: row.graceDays ?? 0,
      invoiceRequired: row.invoiceRequired,
      paymentDayOfMonth: row.paymentDayOfMonth,
      providerContractNo: row.providerContractNo,
      providerName: row.providerName,
      remark: row.remark,
      rentalAmountYuan: yuanFromCents(row.rentalAmount),
      taxIncluded: row.taxIncluded,
      vehicleId: row.vehicleId
    });
    setFormOpen(true);
  }

  async function openDetail(row: VehicleBaasContractRow) {
    try {
      setDetail(await apiFetch<VehicleBaasContractRow>(`/vehicle-baas-contracts/${row.id}`));
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function submitContract(values: ContractFormValues) {
    if (!values.providerName || !values.effectiveFrom || !values.rentalAmountYuan || !values.paymentDayOfMonth) {
      void message.warning("请填写服务商、生效日期、月租金和支付日");
      return;
    }
    if (!editing && !values.vehicleId) {
      void message.warning("请选择车辆");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        batteryPackageName: values.batteryPackageName ?? null,
        batterySerialNo: values.batterySerialNo ?? null,
        billingCycle: values.billingCycle ?? "MONTHLY",
        contractNo: values.contractNo ?? null,
        contractStatus: values.contractStatus ?? "DRAFT",
        currency: values.currency ?? "CNY",
        effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
        effectiveTo: values.effectiveTo?.format("YYYY-MM-DD") ?? null,
        graceDays: values.graceDays ?? 0,
        invoiceRequired: Boolean(values.invoiceRequired),
        paymentDayOfMonth: values.paymentDayOfMonth,
        providerContractNo: values.providerContractNo ?? null,
        providerName: values.providerName,
        remark: values.remark ?? null,
        rentalAmount: toCentAmount(values.rentalAmountYuan),
        taxIncluded: values.taxIncluded ?? true
      };
      if (editing) {
        await apiFetch(`/vehicle-baas-contracts/${editing.id}`, {
          body: JSON.stringify(payload),
          method: "PATCH"
        });
      } else {
        await apiFetch(`/vehicles/${values.vehicleId}/baas-contracts`, {
          body: JSON.stringify(payload),
          method: "POST"
        });
      }
      setFormOpen(false);
      void message.success("BaaS 合同已保存");
      await loadContracts();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function runContractAction(row: VehicleBaasContractRow, action: "activate" | "archive" | "suspend" | "terminate") {
    try {
      await apiFetch(`/vehicle-baas-contracts/${row.id}/${action}`, { method: "POST" });
      void message.success("合同状态已更新");
      await loadContracts();
      if (detail?.id === row.id) {
        await openDetail(row);
      }
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function uploadAttachment(values: AttachmentFormValues) {
    if (!detail) {
      return;
    }
    const file = fileList.find((item) => item.originFileObj);
    if (!file?.originFileObj) {
      void message.warning("请选择附件文件");
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("files", file.originFileObj, file.name);
      formData.append("attachmentType", values.attachmentType ?? "CONTRACT");
      appendIfPresent(formData, "title", values.title);
      appendIfPresent(formData, "description", values.description);
      await apiFetch(`/vehicle-baas-contracts/${detail.id}/attachments`, {
        body: formData,
        method: "POST"
      });
      setFileList([]);
      attachmentForm.resetFields();
      void message.success("附件已上传");
      await openDetail(detail);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setUploading(false);
    }
  }

  async function generateCostRecords(values: GenerateFormValues) {
    if (!detail || !values.fromPeriod || !values.toPeriod) {
      void message.warning("请填写起止账期");
      return;
    }
    setGenerating(true);
    try {
      const result = await apiFetch<{ dryRun: boolean; generatedCount: number; skippedCount: number }>(
        `/vehicle-baas-contracts/${detail.id}/cost-records/generate`,
        {
          body: JSON.stringify({
            dryRun: Boolean(values.dryRun),
            fromPeriod: values.fromPeriod,
            toPeriod: values.toPeriod
          }),
          method: "POST"
        }
      );
      void message.success(
        values.dryRun
          ? `试算完成，预计跳过 ${result.skippedCount} 条已存在账期`
          : `已生成 ${result.generatedCount} 条，跳过 ${result.skippedCount} 条`
      );
      await openDetail(detail);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setGenerating(false);
    }
  }

  async function runCostAction(record: VehicleBaasCostRecord, action: "confirm" | "mark-paid" | "void") {
    try {
      await apiFetch(`/vehicle-baas-cost-records/${record.id}/${action}`, { body: "{}", method: "POST" });
      void message.success("成本记录状态已更新");
      if (detail) {
        await openDetail(detail);
      }
      await loadContracts();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  const columns: ColumnsType<VehicleBaasContractRow> = [
    { dataIndex: "contractNo", title: "合同编号", width: 150 },
    { dataIndex: ["vehicle", "displayName"], title: "车辆", width: 220 },
    { dataIndex: "providerName", title: "服务商", width: 160 },
    {
      dataIndex: "contractStatus",
      render: (value: string) => (
        <Tag color={statusColors[value] ?? "default"}>{labelOf(VEHICLE_BAAS_CONTRACT_STATUS_LABELS, value)}</Tag>
      ),
      title: "状态",
      width: 110
    },
    { dataIndex: "rentalAmount", render: formatYuan, title: "月租金", width: 110 },
    { dataIndex: "paymentDayOfMonth", render: (value: number) => `${value} 日`, title: "支付日", width: 90 },
    { dataIndex: "nextDueDate", render: formatDate, title: "下次付款", width: 120 },
    { dataIndex: "unpaidCostCount", title: "未支付", width: 90 },
    {
      render: (_, row) => (
        <Space>
          <Button icon={<EyeOutlined />} onClick={() => void openDetail(row)} size="small" type="link">
            详情
          </Button>
          <Button onClick={() => openEdit(row)} size="small" type="link">
            编辑
          </Button>
          <Button onClick={() => void runContractAction(row, "activate")} size="small" type="link">
            激活
          </Button>
          <Button onClick={() => void runContractAction(row, "suspend")} size="small" type="link">
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
              BaaS合同
            </Typography.Title>
            <Typography.Text type="secondary">管理车辆电池服务合同、附件和月度成本台账。</Typography.Text>
          </div>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void loadContracts()}>
              刷新
            </Button>
            <Button icon={<PlusOutlined />} onClick={openCreate} type="primary">
              新建合同
            </Button>
          </Space>
        </Space>

        <Form form={filterForm} layout="inline" onFinish={() => void loadContracts()}>
          <Form.Item label="车辆" name="vehicleId">
            <Select allowClear options={vehicleOptions} showSearch style={{ width: 260 }} />
          </Form.Item>
          <Form.Item label="状态" name="contractStatus">
            <Select allowClear options={contractStatusOptions} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item label="服务商" name="providerName">
            <Input allowClear style={{ width: 180 }} />
          </Form.Item>
          <Button htmlType="submit" type="primary">
            查询
          </Button>
        </Form>

        <Table columns={columns} dataSource={rows} loading={loading} rowKey="id" scroll={{ x: 1240 }} />
      </Space>

      <Drawer
        destroyOnClose
        onClose={() => setFormOpen(false)}
        open={formOpen}
        title={editing ? "编辑 BaaS 合同" : "新建 BaaS 合同"}
        width={640}
      >
        <Form form={contractForm} layout="vertical" onFinish={(values) => void submitContract(values)}>
          {!editing ? (
            <Form.Item label="车辆" name="vehicleId" rules={[{ required: true, message: "请选择车辆" }]}>
              <Select options={vehicleOptions} showSearch />
            </Form.Item>
          ) : null}
          <Space style={{ width: "100%" }} wrap>
            <Form.Item label="合同编号" name="contractNo" style={{ flex: "1 1 220px" }}>
              <Input placeholder="为空时自动生成" />
            </Form.Item>
            <Form.Item label="服务商" name="providerName" rules={[{ required: true, message: "请输入服务商" }]} style={{ flex: "1 1 220px" }}>
              <Input />
            </Form.Item>
          </Space>
          <Space style={{ width: "100%" }} wrap>
            <Form.Item label="服务商合同号" name="providerContractNo" style={{ flex: "1 1 220px" }}>
              <Input />
            </Form.Item>
            <Form.Item label="电池套餐" name="batteryPackageName" style={{ flex: "1 1 220px" }}>
              <Input />
            </Form.Item>
          </Space>
          <Form.Item label="电池编号" name="batterySerialNo">
            <Input />
          </Form.Item>
          <Space style={{ width: "100%" }} wrap>
            <Form.Item label="状态" name="contractStatus" style={{ flex: "1 1 160px" }}>
              <Select options={contractStatusOptions} />
            </Form.Item>
            <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]} style={{ flex: "1 1 160px" }}>
              <DatePicker />
            </Form.Item>
            <Form.Item label="结束日期" name="effectiveTo" style={{ flex: "1 1 160px" }}>
              <DatePicker />
            </Form.Item>
          </Space>
          <Space style={{ width: "100%" }} wrap>
            <Form.Item label="计费周期" name="billingCycle" style={{ flex: "1 1 140px" }}>
              <Select options={billingCycleOptions} />
            </Form.Item>
            <Form.Item label="月租金（元）" name="rentalAmountYuan" rules={[{ required: true, message: "请输入月租金" }]} style={{ flex: "1 1 150px" }}>
              <InputNumber min={0} precision={2} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="每月支付日" name="paymentDayOfMonth" rules={[{ required: true, message: "请输入支付日" }]} style={{ flex: "1 1 150px" }}>
              <InputNumber max={31} min={1} precision={0} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="宽限天数" name="graceDays" style={{ flex: "1 1 120px" }}>
              <InputNumber min={0} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Space>
          <Space>
            <Form.Item name="invoiceRequired" valuePropName="checked">
              <Checkbox>需要发票</Checkbox>
            </Form.Item>
            <Form.Item name="taxIncluded" valuePropName="checked">
              <Checkbox>含税</Checkbox>
            </Form.Item>
          </Space>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Button htmlType="submit" loading={submitting} type="primary">
            保存
          </Button>
        </Form>
      </Drawer>

      <Drawer onClose={() => setDetail(null)} open={Boolean(detail)} title="BaaS 合同详情" width={980}>
        {detail ? (
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Descriptions
              bordered
              column={2}
              size="small"
              items={[
                { label: "合同编号", children: detail.contractNo },
                { label: "车辆", children: detail.vehicle.displayName },
                { label: "服务商", children: detail.providerName },
                { label: "服务商合同号", children: detail.providerContractNo ?? "-" },
                { label: "状态", children: labelOf(VEHICLE_BAAS_CONTRACT_STATUS_LABELS, detail.contractStatus) },
                { label: "期间", children: `${formatDate(detail.effectiveFrom)} 至 ${formatDate(detail.effectiveTo)}` },
                { label: "月租金", children: formatYuan(detail.rentalAmount) },
                { label: "每月支付日", children: `${detail.paymentDayOfMonth} 日` },
                { label: "下次付款日", children: formatDate(detail.nextDueDate) },
                { label: "未支付成本", children: `${detail.unpaidCostCount} 条` }
              ]}
            />
            <Space>
              <Button onClick={() => void runContractAction(detail, "activate")}>激活</Button>
              <Button onClick={() => void runContractAction(detail, "suspend")}>暂停</Button>
              <Button onClick={() => void runContractAction(detail, "terminate")} danger>
                终止
              </Button>
              <Button
                danger
                onClick={() =>
                  modal.confirm({
                    content: "归档后合同不再作为可用合同展示，确认归档？",
                    onOk: () => runContractAction(detail, "archive"),
                    title: "归档 BaaS 合同"
                  })
                }
              >
                归档
              </Button>
            </Space>

            <Typography.Title level={5}>附件</Typography.Title>
            <Table columns={attachmentColumns} dataSource={detail.attachments} pagination={false} rowKey="id" size="small" />
            <Form form={attachmentForm} layout="inline" onFinish={(values) => void uploadAttachment(values)}>
              <Form.Item name="attachmentType">
                <Select options={attachmentTypeOptions} placeholder="附件类型" style={{ width: 140 }} />
              </Form.Item>
              <Form.Item name="title">
                <Input placeholder="标题" style={{ width: 160 }} />
              </Form.Item>
              <Upload beforeUpload={() => false} fileList={fileList} maxCount={1} onChange={({ fileList: next }) => setFileList(next)}>
                <Button icon={<UploadOutlined />}>选择文件</Button>
              </Upload>
              <Button htmlType="submit" loading={uploading} type="primary">
                上传
              </Button>
            </Form>

            <Typography.Title level={5}>成本记录</Typography.Title>
            <Form form={generateForm} layout="inline" onFinish={(values) => void generateCostRecords(values)}>
              <Form.Item label="起始账期" name="fromPeriod">
                <Input placeholder="2026-07" style={{ width: 120 }} />
              </Form.Item>
              <Form.Item label="结束账期" name="toPeriod">
                <Input placeholder="2026-12" style={{ width: 120 }} />
              </Form.Item>
              <Form.Item name="dryRun" valuePropName="checked">
                <Checkbox>仅试算</Checkbox>
              </Form.Item>
              <Button htmlType="submit" loading={generating} type="primary">
                生成成本
              </Button>
            </Form>
            <Table
              columns={costRecordColumns(runCostAction)}
              dataSource={detail.costRecords}
              pagination={false}
              rowKey="id"
              scroll={{ x: 960 }}
              size="small"
            />
          </Space>
        ) : null}
      </Drawer>
    </ProtectedShell>
  );
}

const attachmentColumns: ColumnsType<VehicleBaasAttachment> = [
  {
    dataIndex: "attachmentType",
    render: (value: string) => labelOf(VEHICLE_BAAS_CONTRACT_ATTACHMENT_TYPE_LABELS, value),
    title: "类型"
  },
  { dataIndex: "title", render: (value?: string | null) => value ?? "-", title: "标题" },
  { dataIndex: "originalName", render: (value?: string | null) => value ?? "-", title: "文件名" },
  { dataIndex: "createdAt", render: formatDateTime, title: "上传时间" },
  {
    render: (_, row) => (
      <Button icon={<FileTextOutlined />} onClick={() => window.open(buildAdminPreviewUrl(row.previewUrl), "_blank", "noopener,noreferrer")} size="small" type="link">
        预览
      </Button>
    ),
    title: "操作"
  }
];

function costRecordColumns(
  runCostAction: (record: VehicleBaasCostRecord, action: "confirm" | "mark-paid" | "void") => Promise<void>
): ColumnsType<VehicleBaasCostRecord> {
  return [
    { dataIndex: "costPeriod", title: "账期", width: 90 },
    { dataIndex: "dueDate", render: formatDate, title: "应付日", width: 110 },
    { dataIndex: "costAmount", render: formatYuan, title: "金额", width: 110 },
    {
      dataIndex: "costStatus",
      render: (value: string) => <Tag>{labelOf(VEHICLE_BAAS_COST_RECORD_STATUS_LABELS, value)}</Tag>,
      title: "状态",
      width: 110
    },
    {
      dataIndex: "costSource",
      render: (value: string) => labelOf(VEHICLE_BAAS_COST_SOURCE_LABELS, value),
      title: "来源",
      width: 100
    },
    { dataIndex: "paymentRefNo", render: (value?: string | null) => value ?? "-", title: "付款参考号", width: 140 },
    {
      render: (_, row) => (
        <Space>
          <Button onClick={() => void runCostAction(row, "confirm")} size="small" type="link">
            确认
          </Button>
          <Button onClick={() => void runCostAction(row, "mark-paid")} size="small" type="link">
            已支付
          </Button>
          <Button danger onClick={() => void runCostAction(row, "void")} size="small" type="link">
            作废
          </Button>
        </Space>
      ),
      title: "操作",
      width: 180
    }
  ];
}

function buildAdminPreviewUrl(previewUrl: string) {
  const origin = API_BASE_URL.replace(/\/api$/, "");
  return `${origin}${previewUrl}`;
}

function appendIfPresent(formData: FormData, key: string, value?: string | null) {
  if (value) {
    formData.append(key, value);
  }
}
