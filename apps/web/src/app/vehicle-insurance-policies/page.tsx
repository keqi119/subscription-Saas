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
  VEHICLE_DOCUMENT_STATUS_LABELS,
  VEHICLE_DOCUMENT_TYPE_LABELS,
  VEHICLE_INSURANCE_COVERAGE_TYPE_LABELS,
  VEHICLE_INSURANCE_POLICY_STATUS_LABELS,
  VEHICLE_INSURANCE_POLICY_TYPE_LABELS,
  labelOf
} from "../../constants/labels";
import { API_BASE_URL, ApiError, apiFetch } from "../../lib/api";
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
  series?: string | null;
  vehicleNo: string;
}

interface VehicleInsurancePolicyRow {
  claimCount: number;
  coverages: VehicleInsuranceCoverage[];
  createdAt: string;
  currency?: string | null;
  daysUntilExpiry: number;
  documentCount: number;
  documents: VehicleDocument[];
  effectiveFrom: string;
  effectiveTo: string;
  id: string;
  insuredAmount?: number | null;
  insuredName?: string | null;
  insurerName?: string | null;
  isExpiringSoon: boolean;
  policyHolderName?: string | null;
  policyNo: string;
  policyStatus: string;
  policyType: string;
  premiumAmount?: number | null;
  remark?: string | null;
  renewalReminderAt?: string | null;
  vehicle: {
    displayName: string;
    id: string;
    plateNo?: string | null;
    vehicleNo: string;
  };
  vehicleId: string;
}

interface VehicleInsuranceCoverage {
  coverageName?: string | null;
  coverageType: string;
  deductibleAmount?: number | null;
  id?: string;
  insuredAmount?: number | null;
  remark?: string | null;
}

interface VehicleDocument {
  createdAt: string;
  customerVisible: boolean;
  description?: string | null;
  documentStatus: string;
  documentType: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  fileName: string;
  fileSize?: number | null;
  id: string;
  mimeType?: string | null;
  originalName?: string | null;
  policyId?: string | null;
  previewUrl: string;
  title?: string | null;
  vehicleId: string;
}

interface PolicyListResponse {
  items: VehicleInsurancePolicyRow[];
  page: number;
  pageSize: number;
  total: number;
}

interface FilterValues {
  expiringWithinDays?: number;
  policyStatus?: string;
  policyType?: string;
  vehicleId?: string;
}

interface PolicyFormValues {
  coverages?: Array<{
    coverageName?: string | null;
    coverageType?: string;
    deductibleAmountYuan?: number | null;
    insuredAmountYuan?: number | null;
    remark?: string | null;
  }>;
  currency?: string | null;
  effectiveFrom?: Dayjs;
  effectiveTo?: Dayjs;
  insuredAmountYuan?: number | null;
  insuredName?: string | null;
  insurerName?: string | null;
  policyHolderName?: string | null;
  policyNo?: string;
  policyStatus?: string;
  policyType?: string;
  premiumAmountYuan?: number | null;
  remark?: string | null;
  renewalReminderAt?: Dayjs | null;
  vehicleId?: string;
}

interface DocumentFormValues {
  customerVisible?: boolean;
  description?: string | null;
  documentType?: string;
  effectiveFrom?: Dayjs | null;
  effectiveTo?: Dayjs | null;
  title?: string | null;
}

const statusColors: Record<string, string> = {
  ACTIVE: "green",
  ARCHIVED: "default",
  CANCELLED: "default",
  EXPIRED: "red",
  PENDING_RENEWAL: "orange"
};

const policyTypeOptions = optionsFromLabels(VEHICLE_INSURANCE_POLICY_TYPE_LABELS);
const policyStatusOptions = optionsFromLabels(VEHICLE_INSURANCE_POLICY_STATUS_LABELS);
const coverageTypeOptions = optionsFromLabels(VEHICLE_INSURANCE_COVERAGE_TYPE_LABELS);
const documentTypeOptions = optionsFromLabels(VEHICLE_DOCUMENT_TYPE_LABELS);

export default function VehicleInsurancePoliciesPage() {
  const { message } = App.useApp();
  const [filterForm] = Form.useForm<FilterValues>();
  const [policyForm] = Form.useForm<PolicyFormValues>();
  const [documentForm] = Form.useForm<DocumentFormValues>();
  const [rows, setRows] = useState<VehicleInsurancePolicyRow[]>([]);
  const [vehicles, setVehicles] = useState<VehicleBrief[]>([]);
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [detail, setDetail] = useState<VehicleInsurancePolicyRow | null>(null);
  const [editing, setEditing] = useState<VehicleInsurancePolicyRow | null>(null);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);

  const vehicleOptions = useMemo(
    () =>
      vehicles.map((vehicle) => ({
        label: [vehicle.vehicleNo, vehicle.plateNo, vehicle.brand, vehicle.series, vehicle.model].filter(Boolean).join(" / "),
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
      const query = buildQuery(filterForm.getFieldsValue());
      const result = await apiFetch<PolicyListResponse>(`/vehicle-insurance-policies${query}`);
      setRows(result.items);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [filterForm, message]);

  useEffect(() => {
    void loadVehicles();
    void loadPolicies();
  }, [loadPolicies, loadVehicles]);

  async function openDetail(id: string) {
    try {
      const row = await apiFetch<VehicleInsurancePolicyRow>(`/vehicle-insurance-policies/${id}`);
      setDetail(row);
      setDrawerOpen(true);
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function openCreate() {
    setEditing(null);
    policyForm.resetFields();
    policyForm.setFieldsValue({
      currency: "CNY",
      policyStatus: "ACTIVE"
    });
    setFormOpen(true);
  }

  function openEdit(row: VehicleInsurancePolicyRow) {
    setEditing(row);
    policyForm.setFieldsValue({
      coverages: row.coverages.map((coverage) => ({
        coverageName: coverage.coverageName,
        coverageType: coverage.coverageType,
        deductibleAmountYuan: yuanFromCents(coverage.deductibleAmount),
        insuredAmountYuan: yuanFromCents(coverage.insuredAmount),
        remark: coverage.remark
      })),
      currency: row.currency ?? "CNY",
      effectiveFrom: row.effectiveFrom ? dayjs(row.effectiveFrom) : undefined,
      effectiveTo: row.effectiveTo ? dayjs(row.effectiveTo) : undefined,
      insuredAmountYuan: yuanFromCents(row.insuredAmount),
      insuredName: row.insuredName,
      insurerName: row.insurerName,
      policyHolderName: row.policyHolderName,
      policyNo: row.policyNo,
      policyStatus: row.policyStatus,
      policyType: row.policyType,
      premiumAmountYuan: yuanFromCents(row.premiumAmount),
      remark: row.remark,
      renewalReminderAt: row.renewalReminderAt ? dayjs(row.renewalReminderAt) : null,
      vehicleId: row.vehicleId
    });
    setFormOpen(true);
  }

  async function submitPolicy(values: PolicyFormValues) {
    const vehicleId = values.vehicleId;
    if (!editing && !vehicleId) {
      void message.warning("请选择车辆");
      return;
    }
    setSubmitting(true);
    try {
      const body = JSON.stringify(toPolicyPayload(values));
      if (editing) {
        await apiFetch(`/vehicle-insurance-policies/${editing.id}`, {
          body,
          method: "PATCH"
        });
      } else {
        await apiFetch(`/vehicles/${vehicleId}/insurance-policies`, {
          body,
          method: "POST"
        });
      }
      void message.success("保单已保存");
      setFormOpen(false);
      await loadPolicies();
      if (detail) {
        await openDetail(detail.id);
      }
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadDocument(values: DocumentFormValues) {
    if (!detail) {
      return;
    }
    const file = fileList.find((item) => item.originFileObj);
    if (!file?.originFileObj) {
      void message.warning("请选择保单附件或车辆材料");
      return;
    }
    if (!values.documentType) {
      void message.warning("请选择材料类型");
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("files", file.originFileObj, file.name);
      formData.append("documentType", values.documentType);
      formData.append("policyId", detail.id);
      formData.append("customerVisible", values.customerVisible ? "true" : "false");
      appendIfPresent(formData, "title", values.title);
      appendIfPresent(formData, "description", values.description);
      appendIfPresent(formData, "effectiveFrom", values.effectiveFrom?.format("YYYY-MM-DD"));
      appendIfPresent(formData, "effectiveTo", values.effectiveTo?.format("YYYY-MM-DD"));
      await apiFetch(`/vehicles/${detail.vehicleId}/documents`, {
        body: formData,
        method: "POST"
      });
      setFileList([]);
      documentForm.resetFields();
      void message.success("材料已上传");
      await openDetail(detail.id);
      await loadPolicies();
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : getErrorMessage(error));
    } finally {
      setUploading(false);
    }
  }

  const columns: ColumnsType<VehicleInsurancePolicyRow> = [
    {
      dataIndex: "policyNo",
      title: "保单号"
    },
    {
      dataIndex: "policyType",
      render: (value: string) => labelOf(VEHICLE_INSURANCE_POLICY_TYPE_LABELS, value),
      title: "类型"
    },
    {
      dataIndex: "policyStatus",
      render: (value: string) => (
        <Tag color={statusColors[value] ?? "default"}>{labelOf(VEHICLE_INSURANCE_POLICY_STATUS_LABELS, value)}</Tag>
      ),
      title: "状态"
    },
    {
      render: (_, row) => row.vehicle.displayName || row.vehicle.vehicleNo,
      title: "车辆"
    },
    {
      dataIndex: "insurerName",
      render: (value?: string | null) => value ?? "-",
      title: "保险公司"
    },
    {
      render: (_, row) => `${formatDate(row.effectiveFrom)} 至 ${formatDate(row.effectiveTo)}`,
      title: "保险期间"
    },
    {
      dataIndex: "daysUntilExpiry",
      render: (value: number, row) => row.isExpiringSoon ? <Tag color="orange">{value} 天后到期</Tag> : `${value} 天`,
      title: "到期"
    },
    {
      render: (_, row) => (
        <Space>
          <Button icon={<EyeOutlined />} onClick={() => void openDetail(row.id)} size="small">
            查看
          </Button>
          <Button onClick={() => openEdit(row)} size="small">
            编辑
          </Button>
        </Space>
      ),
      title: "操作",
      width: 150
    }
  ];

  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          保单管理
        </Typography.Title>

        <Form form={filterForm} layout="inline" onFinish={() => void loadPolicies()}>
          <Form.Item label="车辆" name="vehicleId">
            <Select allowClear options={vehicleOptions} showSearch style={{ width: 260 }} />
          </Form.Item>
          <Form.Item label="类型" name="policyType">
            <Select allowClear options={policyTypeOptions} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item label="状态" name="policyStatus">
            <Select allowClear options={policyStatusOptions} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item label="到期天数" name="expiringWithinDays">
            <InputNumber min={1} placeholder="如 30" style={{ width: 120 }} />
          </Form.Item>
          <Button htmlType="submit" icon={<ReloadOutlined />} loading={loading}>
            查询
          </Button>
          <Button icon={<PlusOutlined />} onClick={openCreate} type="primary">
            新建保单
          </Button>
        </Form>

        <Table columns={columns} dataSource={rows} loading={loading} rowKey="id" scroll={{ x: 1100 }} />
      </Space>

      <Drawer destroyOnClose onClose={() => setDrawerOpen(false)} open={drawerOpen} title={detail?.policyNo ?? "保单详情"} width={760}>
        {detail ? (
          <Space direction="vertical" size={18} style={{ width: "100%" }}>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="车辆">{detail.vehicle.displayName || detail.vehicle.vehicleNo}</Descriptions.Item>
              <Descriptions.Item label="保单类型">{labelOf(VEHICLE_INSURANCE_POLICY_TYPE_LABELS, detail.policyType)}</Descriptions.Item>
              <Descriptions.Item label="状态">{labelOf(VEHICLE_INSURANCE_POLICY_STATUS_LABELS, detail.policyStatus)}</Descriptions.Item>
              <Descriptions.Item label="保险公司">{detail.insurerName ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="投保人">{detail.policyHolderName ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="被保险人">{detail.insuredName ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="保险期间">{formatDate(detail.effectiveFrom)} 至 {formatDate(detail.effectiveTo)}</Descriptions.Item>
              <Descriptions.Item label="保费">{formatYuan(detail.premiumAmount)}</Descriptions.Item>
              <Descriptions.Item label="保额">{formatYuan(detail.insuredAmount)}</Descriptions.Item>
              <Descriptions.Item label="续保提醒">{formatDateTime(detail.renewalReminderAt)}</Descriptions.Item>
              <Descriptions.Item label="备注">{detail.remark ?? "-"}</Descriptions.Item>
            </Descriptions>

            <div>
              <Typography.Title level={5}>险种明细</Typography.Title>
              <Table
                columns={coverageColumns}
                dataSource={detail.coverages}
                pagination={false}
                rowKey={(row) => row.id ?? `${row.coverageType}-${row.coverageName}`}
                size="small"
              />
            </div>

            <div>
              <Typography.Title level={5}>保单附件 / 车辆材料</Typography.Title>
              <Table
                columns={documentColumns}
                dataSource={detail.documents}
                pagination={false}
                rowKey="id"
                size="small"
              />
            </div>

            <Form form={documentForm} layout="vertical" onFinish={(values) => void uploadDocument(values)}>
              <Typography.Title level={5}>上传附件</Typography.Title>
              <Form.Item label="材料类型" name="documentType" rules={[{ required: true, message: "请选择材料类型" }]}>
                <Select options={documentTypeOptions} />
              </Form.Item>
              <Form.Item label="标题" name="title">
                <Input maxLength={128} />
              </Form.Item>
              <Form.Item label="有效期">
                <Space wrap>
                  <Form.Item name="effectiveFrom" noStyle>
                    <DatePicker placeholder="起期" />
                  </Form.Item>
                  <Form.Item name="effectiveTo" noStyle>
                    <DatePicker placeholder="止期" />
                  </Form.Item>
                </Space>
              </Form.Item>
              <Form.Item name="customerVisible" valuePropName="checked">
                <Checkbox>客户在租期间可见</Checkbox>
              </Form.Item>
              <Form.Item label="说明" name="description">
                <Input.TextArea rows={2} />
              </Form.Item>
              <Upload beforeUpload={() => false} fileList={fileList} maxCount={1} onChange={({ fileList: next }) => setFileList(next)}>
                <Button icon={<UploadOutlined />}>选择文件</Button>
              </Upload>
              <Button htmlType="submit" loading={uploading} style={{ marginTop: 12 }} type="primary">
                上传
              </Button>
            </Form>

            {detail.claimCount ? (
              <Typography.Text type="secondary">
                已关联理赔 {detail.claimCount} 条，可在服务工单或理赔 API 中继续维护。
              </Typography.Text>
            ) : null}
          </Space>
        ) : null}
      </Drawer>

      <Drawer destroyOnClose onClose={() => setFormOpen(false)} open={formOpen} title={editing ? "编辑保单" : "新建保单"} width={720}>
        <Form form={policyForm} layout="vertical" onFinish={(values) => void submitPolicy(values)}>
          <Form.Item hidden={Boolean(editing)} label="车辆" name="vehicleId" rules={[{ required: !editing, message: "请选择车辆" }]}>
            <Select options={vehicleOptions} showSearch />
          </Form.Item>
          <Form.Item label="保单号" name="policyNo" rules={[{ required: true, message: "请输入保单号" }]}>
            <Input maxLength={128} />
          </Form.Item>
          <Space style={{ width: "100%" }} wrap>
            <Form.Item label="保单类型" name="policyType" rules={[{ required: true, message: "请选择保单类型" }]}>
              <Select options={policyTypeOptions} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item label="状态" name="policyStatus">
              <Select options={policyStatusOptions} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item label="币种" name="currency">
              <Input style={{ width: 100 }} />
            </Form.Item>
          </Space>
          <Space style={{ width: "100%" }} wrap>
            <Form.Item label="起保日期" name="effectiveFrom" rules={[{ required: true, message: "请选择起保日期" }]}>
              <DatePicker />
            </Form.Item>
            <Form.Item label="终保日期" name="effectiveTo" rules={[{ required: true, message: "请选择终保日期" }]}>
              <DatePicker />
            </Form.Item>
            <Form.Item label="续保提醒" name="renewalReminderAt">
              <DatePicker showTime />
            </Form.Item>
          </Space>
          <Space style={{ width: "100%" }} wrap>
            <Form.Item label="保险公司" name="insurerName">
              <Input style={{ width: 220 }} />
            </Form.Item>
            <Form.Item label="投保人" name="policyHolderName">
              <Input style={{ width: 180 }} />
            </Form.Item>
            <Form.Item label="被保险人" name="insuredName">
              <Input style={{ width: 180 }} />
            </Form.Item>
          </Space>
          <Space style={{ width: "100%" }} wrap>
            <Form.Item label="保费（元）" name="premiumAmountYuan">
              <InputNumber min={0} precision={2} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item label="保额（元）" name="insuredAmountYuan">
              <InputNumber min={0} precision={2} style={{ width: 180 }} />
            </Form.Item>
          </Space>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>

          <Typography.Title level={5}>险种明细</Typography.Title>
          <Form.List name="coverages">
            {(fields, { add, remove }) => (
              <Space direction="vertical" style={{ width: "100%" }}>
                {fields.map((field) => (
                  <Space align="baseline" key={field.key} wrap>
                    <Form.Item name={[field.name, "coverageType"]} rules={[{ required: true, message: "请选择险种" }]}>
                      <Select options={coverageTypeOptions} placeholder="险种" style={{ width: 170 }} />
                    </Form.Item>
                    <Form.Item name={[field.name, "coverageName"]}>
                      <Input placeholder="险种名称" style={{ width: 150 }} />
                    </Form.Item>
                    <Form.Item name={[field.name, "insuredAmountYuan"]}>
                      <InputNumber min={0} placeholder="保额(元)" precision={2} style={{ width: 130 }} />
                    </Form.Item>
                    <Form.Item name={[field.name, "deductibleAmountYuan"]}>
                      <InputNumber min={0} placeholder="免赔(元)" precision={2} style={{ width: 130 }} />
                    </Form.Item>
                    <Button danger onClick={() => remove(field.name)} size="small">
                      删除
                    </Button>
                  </Space>
                ))}
                <Button onClick={() => add()} size="small">
                  添加险种
                </Button>
              </Space>
            )}
          </Form.List>

          <Space style={{ marginTop: 18 }}>
            <Button htmlType="submit" loading={submitting} type="primary">
              保存
            </Button>
            <Button onClick={() => setFormOpen(false)}>取消</Button>
          </Space>
        </Form>
      </Drawer>
    </ProtectedShell>
  );
}

const coverageColumns: ColumnsType<VehicleInsuranceCoverage> = [
  {
    dataIndex: "coverageType",
    render: (value: string) => labelOf(VEHICLE_INSURANCE_COVERAGE_TYPE_LABELS, value),
    title: "险种"
  },
  {
    dataIndex: "coverageName",
    render: (value?: string | null) => value ?? "-",
    title: "名称"
  },
  {
    dataIndex: "insuredAmount",
    render: (value?: number | null) => formatYuan(value),
    title: "保额"
  },
  {
    dataIndex: "deductibleAmount",
    render: (value?: number | null) => formatYuan(value),
    title: "免赔"
  }
];

const documentColumns: ColumnsType<VehicleDocument> = [
  {
    dataIndex: "documentType",
    render: (value: string) => labelOf(VEHICLE_DOCUMENT_TYPE_LABELS, value),
    title: "类型"
  },
  {
    dataIndex: "documentStatus",
    render: (value: string) => labelOf(VEHICLE_DOCUMENT_STATUS_LABELS, value),
    title: "状态"
  },
  {
    dataIndex: "customerVisible",
    render: (value: boolean) => value ? <Tag color="green">客户可见</Tag> : <Tag>后台可见</Tag>,
    title: "可见性"
  },
  {
    dataIndex: "fileName",
    title: "文件"
  },
  {
    render: (_, row) => (
      <Button icon={<FileTextOutlined />} onClick={() => window.open(buildAdminPreviewUrl(row.previewUrl), "_blank", "noopener,noreferrer")} size="small" type="link">
        预览
      </Button>
    ),
    title: "操作"
  }
];

function toPolicyPayload(values: PolicyFormValues) {
  return {
    coverages: (values.coverages ?? [])
      .filter((coverage) => coverage.coverageType)
      .map((coverage) => ({
        coverageName: coverage.coverageName,
        coverageType: coverage.coverageType,
        deductibleAmount: toCentAmount(coverage.deductibleAmountYuan),
        insuredAmount: toCentAmount(coverage.insuredAmountYuan),
        remark: coverage.remark
      })),
    currency: values.currency,
    effectiveFrom: values.effectiveFrom?.format("YYYY-MM-DD"),
    effectiveTo: values.effectiveTo?.format("YYYY-MM-DD"),
    insuredAmount: toCentAmount(values.insuredAmountYuan),
    insuredName: values.insuredName,
    insurerName: values.insurerName,
    policyHolderName: values.policyHolderName,
    policyNo: values.policyNo,
    policyStatus: values.policyStatus,
    policyType: values.policyType,
    premiumAmount: toCentAmount(values.premiumAmountYuan),
    remark: values.remark,
    renewalReminderAt: values.renewalReminderAt?.toISOString()
  };
}

function appendIfPresent(formData: FormData, key: string, value?: string | null) {
  if (value) {
    formData.append(key, value);
  }
}

function buildAdminPreviewUrl(previewUrl: string) {
  const origin = API_BASE_URL.replace(/\/api$/, "");
  return `${origin}${previewUrl}`;
}
