"use client";

import {
  EditOutlined,
  FileTextOutlined,
  PlusOutlined,
  UploadOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
  Upload
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { UploadFile } from "antd/es/upload/interface";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  VEHICLE_BAAS_BILLING_CYCLE_LABELS,
  VEHICLE_BAAS_CONTRACT_STATUS_LABELS,
  VEHICLE_BATTERY_USAGE_TYPE_LABELS,
  VEHICLE_INSURANCE_COVERAGE_TYPE_LABELS,
  VEHICLE_INSURANCE_POLICY_STATUS_LABELS,
  VEHICLE_INSURANCE_POLICY_TYPE_LABELS,
  labelOf
} from "../../constants/labels";
import { API_BASE_URL, ApiError, apiFetch } from "../../lib/api";
import {
  formatDate,
  formatYuan,
  getErrorMessage,
  optionsFromLabels,
  toCentAmount,
  yuanFromCents
} from "../../lib/capital-format";
import type { VehicleWorkspaceTabProps } from "./vehicle-workspace-types";

interface VehicleInsuranceCoverage {
  coverageName?: string | null;
  coverageType: string;
  deductibleAmount?: number | null;
  id?: string;
  insuredAmount?: number | null;
  remark?: string | null;
}

interface VehicleInsurancePolicy {
  claimCount: number;
  coverages: VehicleInsuranceCoverage[];
  currency?: string | null;
  documentCount: number;
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
  vehicleId: string;
}

interface VehicleInsurancePolicyListResponse {
  items: VehicleInsurancePolicy[];
  page: number;
  pageSize: number;
  total: number;
}

interface VehicleInsuranceDocument {
  createdAt: string;
  customerVisible: boolean;
  description?: string | null;
  documentStatus: string;
  documentType: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  fileName: string;
  id: string;
  originalName?: string | null;
  policyId?: string | null;
  previewUrl: string;
  title?: string | null;
}

interface VehicleConditionReport {
  archivedAt?: string | null;
  batteryCheckedAt?: string | null;
  batteryCycleCount?: number | null;
  batteryEstimatedRangeKm?: number | null;
  batteryHealthPercent?: number | null;
  batteryRemark?: string | null;
  batteryWarrantyUntil?: string | null;
  inspectionDate?: string | null;
  publishedAt?: string | null;
  reportNo: string;
  reportStatus: string;
  updatedAt: string;
}

interface VehicleBaasContractSummary {
  billingCycle: string;
  contractNo: string;
  contractStatus: string;
  id: string;
  nextDueDate?: string | null;
  paymentDayOfMonth: number;
  providerName: string;
  rentalAmount: number;
  unpaidCostCount: number;
}

interface VehicleBaasSummary {
  activeContract?: VehicleBaasContractSummary | null;
  contractCount: number;
  unpaidCostCount: number;
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
}

interface DocumentFormValues {
  customerVisible?: boolean;
  description?: string | null;
  effectiveFrom?: Dayjs | null;
  effectiveTo?: Dayjs | null;
  title?: string | null;
}

const INSURANCE_DOCUMENT_TYPES = new Set([
  "COMPULSORY_INSURANCE_POLICY",
  "COMMERCIAL_INSURANCE_POLICY"
]);

const POLICY_STATUS_COLORS: Record<string, string> = {
  ACTIVE: "green",
  ARCHIVED: "default",
  CANCELLED: "default",
  EXPIRED: "red",
  NOT_EFFECTIVE: "blue",
  PENDING_RENEWAL: "orange"
};

export function VehicleInsuranceBatteryTab({
  onVehicleChanged,
  permissions,
  vehicle
}: Readonly<VehicleWorkspaceTabProps>) {
  const { message } = App.useApp();
  const [policyForm] = Form.useForm<PolicyFormValues>();
  const [documentForm] = Form.useForm<DocumentFormValues>();
  const [policies, setPolicies] = useState<VehicleInsurancePolicy[]>([]);
  const [documents, setDocuments] = useState<VehicleInsuranceDocument[]>([]);
  const [conditionReports, setConditionReports] = useState<VehicleConditionReport[]>([]);
  const [baasSummary, setBaasSummary] = useState<VehicleBaasSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [policyDrawerOpen, setPolicyDrawerOpen] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<VehicleInsurancePolicy | null>(null);
  const [attachmentPolicy, setAttachmentPolicy] = useState<VehicleInsurancePolicy | null>(null);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const canViewInsurance = permissions.has("vehicle_insurance:view");
  const canManageInsurance = permissions.has("vehicle_insurance:manage");
  const canViewDocuments = permissions.has("vehicle_document:view");
  const canManageDocuments = permissions.has("vehicle_document:manage");
  const canViewBaas = permissions.has("vehicle_baas:view");
  const vehicleId = vehicle.id;

  const loadWorkspace = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [policyResult, documentRows, reportRows, nextBaasSummary] = await Promise.all([
          canViewInsurance
            ? apiFetch<VehicleInsurancePolicyListResponse>(
                `/vehicle-insurance-policies?vehicleId=${encodeURIComponent(vehicleId)}`,
                { signal }
              )
            : Promise.resolve({ items: [], page: 1, pageSize: 20, total: 0 }),
          canViewDocuments
            ? apiFetch<VehicleInsuranceDocument[]>(
                `/vehicles/${encodeURIComponent(vehicleId)}/documents`,
                { signal }
              )
            : Promise.resolve([]),
          apiFetch<VehicleConditionReport[]>(
            `/vehicles/${encodeURIComponent(vehicleId)}/condition-reports`,
            { signal }
          ),
          canViewBaas && vehicle.batteryUsageType === "BAAS"
            ? apiFetch<VehicleBaasSummary>(
                `/vehicles/${encodeURIComponent(vehicleId)}/baas-summary`,
                { signal }
              )
            : Promise.resolve(null)
        ]);

        setPolicies(policyResult.items);
        setDocuments(documentRows.filter((document) => INSURANCE_DOCUMENT_TYPES.has(document.documentType)));
        setConditionReports(reportRows);
        setBaasSummary(nextBaasSummary);
      } catch (loadError) {
        if (!signal?.aborted) {
          setError(getErrorMessage(loadError));
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [canViewBaas, canViewDocuments, canViewInsurance, vehicle.batteryUsageType, vehicleId]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadWorkspace(controller.signal);
    return () => controller.abort();
  }, [loadWorkspace]);

  const currentPolicies = useMemo(
    () => ({
      commercial: getCurrentPolicy(policies, "COMMERCIAL"),
      compulsory: getCurrentPolicy(policies, "COMPULSORY_TRAFFIC")
    }),
    [policies]
  );
  const latestValidConditionReport = useMemo(
    () =>
      conditionReports
        .filter((report) => report.reportStatus === "PUBLISHED" && !report.archivedAt)
        .sort((left, right) => reportTimestamp(right) - reportTimestamp(left))[0] ?? null,
    [conditionReports]
  );

  function openCreatePolicy(policyType?: "COMMERCIAL" | "COMPULSORY_TRAFFIC") {
    setEditingPolicy(null);
    policyForm.resetFields();
    policyForm.setFieldsValue({
      currency: "CNY",
      policyStatus: "ACTIVE",
      policyType
    });
    setPolicyDrawerOpen(true);
  }

  function openEditPolicy(policy: VehicleInsurancePolicy) {
    setEditingPolicy(policy);
    policyForm.setFieldsValue(policyToFormValues(policy));
    setPolicyDrawerOpen(true);
  }

  async function savePolicy(values: PolicyFormValues) {
    setSavingPolicy(true);
    try {
      const body = JSON.stringify(toPolicyPayload(values));
      if (editingPolicy) {
        await apiFetch(`/vehicle-insurance-policies/${editingPolicy.id}`, {
          body,
          method: "PATCH"
        });
      } else {
        await apiFetch(`/vehicles/${encodeURIComponent(vehicleId)}/insurance-policies`, {
          body,
          method: "POST"
        });
      }
      setPolicyDrawerOpen(false);
      void message.success("保单已保存");
      await Promise.all([loadWorkspace(), onVehicleChanged()]);
    } catch (saveError) {
      void message.error(getErrorMessage(saveError));
    } finally {
      setSavingPolicy(false);
    }
  }

  function openAttachmentDrawer(policy: VehicleInsurancePolicy) {
    setAttachmentPolicy(policy);
    setFileList([]);
    documentForm.resetFields();
  }

  async function uploadPolicyAttachment(values: DocumentFormValues) {
    const file = fileList.find((item) => item.originFileObj);
    if (!attachmentPolicy || !file?.originFileObj) {
      void message.warning("请选择保单附件");
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("files", file.originFileObj, file.name);
      formData.append("documentType", getInsuranceDocumentType(attachmentPolicy.policyType));
      formData.append("policyId", attachmentPolicy.id);
      formData.append("customerVisible", values.customerVisible ? "true" : "false");
      appendIfPresent(formData, "title", values.title);
      appendIfPresent(formData, "description", values.description);
      appendIfPresent(formData, "effectiveFrom", values.effectiveFrom?.format("YYYY-MM-DD"));
      appendIfPresent(formData, "effectiveTo", values.effectiveTo?.format("YYYY-MM-DD"));
      await apiFetch(`/vehicles/${encodeURIComponent(vehicleId)}/documents`, {
        body: formData,
        method: "POST"
      });
      setFileList([]);
      documentForm.resetFields();
      void message.success("保单附件已上传");
      await Promise.all([loadWorkspace(), onVehicleChanged()]);
    } catch (uploadError) {
      void message.error(uploadError instanceof ApiError ? uploadError.message : getErrorMessage(uploadError));
    } finally {
      setUploading(false);
    }
  }

  if (loading) {
    return (
      <Flex align="center" justify="center" style={{ minHeight: 280 }}>
        <Spin tip="正在加载保险与电池信息" />
      </Flex>
    );
  }

  return (
    <Flex data-vehicle-insurance-battery="true" gap={16} vertical>
      {error ? <Alert message="保险与电池信息加载失败" description={error} showIcon type="error" /> : null}

      <section aria-labelledby="vehicle-insurance-title">
        <Flex align="center" justify="space-between" wrap="wrap">
          <Typography.Title id="vehicle-insurance-title" level={4}>
            车辆保险
          </Typography.Title>
          <Space wrap>
            {canManageInsurance ? (
              <Button icon={<PlusOutlined />} onClick={() => openCreatePolicy()} type="primary">
                新建保单
              </Button>
            ) : null}
            {canViewInsurance ? (
              <Button href={`/vehicle-insurance-policies?vehicleId=${encodeURIComponent(vehicleId)}`}>
                保单管理
              </Button>
            ) : null}
          </Space>
        </Flex>

        {canViewInsurance ? (
          <Row gutter={[16, 16]}>
            <Col lg={12} xs={24}>
              <CurrentPolicyCard
                canManageDocuments={canManageDocuments}
                canManageInsurance={canManageInsurance}
                documents={documents}
                label="交强险"
                onCreate={() => openCreatePolicy("COMPULSORY_TRAFFIC")}
                onEdit={openEditPolicy}
                onUpload={openAttachmentDrawer}
                policy={currentPolicies.compulsory}
              />
            </Col>
            <Col lg={12} xs={24}>
              <CurrentPolicyCard
                canManageDocuments={canManageDocuments}
                canManageInsurance={canManageInsurance}
                documents={documents}
                label="商业险"
                onCreate={() => openCreatePolicy("COMMERCIAL")}
                onEdit={openEditPolicy}
                onUpload={openAttachmentDrawer}
                policy={currentPolicies.commercial}
              />
            </Col>
          </Row>
        ) : (
          <Empty description="无车辆保险查看权限" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}

        {canViewInsurance ? (
          <Card style={{ marginTop: 16 }} title="保险历史">
            <Table
              columns={policyHistoryColumns(canManageInsurance, openEditPolicy)}
              dataSource={policies}
              pagination={policies.length > 8 ? { pageSize: 8 } : false}
              rowKey="id"
              scroll={{ x: 900 }}
              size="small"
            />
          </Card>
        ) : null}
      </section>

      <section aria-labelledby="vehicle-battery-title">
        <Typography.Title id="vehicle-battery-title" level={4}>
          电池与 BaaS
        </Typography.Title>
        <Row gutter={[16, 16]}>
          <Col lg={12} xs={24}>
            <Card title="电池状态">
              <Descriptions
                column={1}
                items={[
                  {
                    children:
                      vehicle.batteryCapacityKwh === null ? "-" : `${vehicle.batteryCapacityKwh} kWh`,
                    label: "电池容量"
                  },
                  {
                    children: vehicle.batteryUsageType
                      ? labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, vehicle.batteryUsageType)
                      : "-",
                    label: "使用方式"
                  },
                  {
                    children: percentage(latestValidConditionReport?.batteryHealthPercent),
                    label: "电池健康度"
                  },
                  {
                    children: formatDate(
                      latestValidConditionReport?.batteryCheckedAt ??
                        latestValidConditionReport?.inspectionDate
                    ),
                    label: "检测日期"
                  },
                  {
                    children: numberWithUnit(latestValidConditionReport?.batteryCycleCount, "次"),
                    label: "循环次数"
                  },
                  {
                    children: numberWithUnit(latestValidConditionReport?.batteryEstimatedRangeKm, "公里"),
                    label: "预估续航"
                  },
                  {
                    children: formatDate(latestValidConditionReport?.batteryWarrantyUntil),
                    label: "质保到期"
                  },
                  {
                    children: latestValidConditionReport?.reportNo ?? "暂无已发布车况报告",
                    label: "数据来源"
                  }
                ]}
                size="small"
              />
              {latestValidConditionReport?.batteryRemark ? (
                <Alert
                  message="电池检测备注"
                  description={latestValidConditionReport.batteryRemark}
                  showIcon
                  style={{ marginTop: 12 }}
                  type="info"
                />
              ) : null}
            </Card>
          </Col>
          <Col lg={12} xs={24}>
            <Card title="BaaS 服务">
              {vehicle.batteryUsageType === "BAAS" ? (
                canViewBaas ? (
                  <BaasDetails summary={baasSummary} vehicleId={vehicleId} />
                ) : (
                  <Empty description="无 BaaS 服务查看权限" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                )
              ) : (
                <Alert message="不需要 BaaS 服务" description="该车辆电池为买断模式。" showIcon type="success" />
              )}
            </Card>
          </Col>
        </Row>
      </section>

      <Drawer
        destroyOnClose
        onClose={() => setPolicyDrawerOpen(false)}
        open={policyDrawerOpen}
        title={editingPolicy ? "编辑保单" : "新建保单"}
        width={720}
      >
        <PolicyForm form={policyForm} onFinish={savePolicy} saving={savingPolicy} />
      </Drawer>

      <Drawer
        destroyOnClose
        onClose={() => setAttachmentPolicy(null)}
        open={Boolean(attachmentPolicy)}
        title={attachmentPolicy ? `${attachmentPolicy.policyNo} · 保单附件` : "保单附件"}
        width={640}
      >
        {attachmentPolicy ? (
          <Flex gap={16} vertical>
            <PolicyDocumentList documents={documents.filter((document) => document.policyId === attachmentPolicy.id)} />
            {canManageDocuments ? (
              <Form
                form={documentForm}
                layout="vertical"
                onFinish={(values) => void uploadPolicyAttachment(values)}
              >
                <Typography.Title level={5}>上传保单附件</Typography.Title>
                <Form.Item label="标题" name="title">
                  <Input maxLength={128} />
                </Form.Item>
                <Space wrap>
                  <Form.Item label="起期" name="effectiveFrom">
                    <DatePicker />
                  </Form.Item>
                  <Form.Item label="止期" name="effectiveTo">
                    <DatePicker />
                  </Form.Item>
                  <Form.Item label="客户可见" name="customerVisible" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Space>
                <Form.Item label="说明" name="description">
                  <Input.TextArea rows={2} />
                </Form.Item>
                <Upload
                  beforeUpload={() => false}
                  fileList={fileList}
                  maxCount={1}
                  onChange={({ fileList: next }) => setFileList(next)}
                >
                  <Button icon={<UploadOutlined />}>选择文件</Button>
                </Upload>
                <Button htmlType="submit" loading={uploading} style={{ marginTop: 12 }} type="primary">
                  上传附件
                </Button>
              </Form>
            ) : null}
          </Flex>
        ) : null}
      </Drawer>
    </Flex>
  );
}

function CurrentPolicyCard({
  canManageDocuments,
  canManageInsurance,
  documents,
  label,
  onCreate,
  onEdit,
  onUpload,
  policy
}: Readonly<{
  canManageDocuments: boolean;
  canManageInsurance: boolean;
  documents: VehicleInsuranceDocument[];
  label: string;
  onCreate: () => void;
  onEdit: (policy: VehicleInsurancePolicy) => void;
  onUpload: (policy: VehicleInsurancePolicy) => void;
  policy?: VehicleInsurancePolicy;
}>) {
  const policyDocuments = policy
    ? documents.filter((document) => document.policyId === policy.id && document.documentStatus === "ACTIVE")
    : [];
  const expiryDays = policy ? dayjs(policy.effectiveTo).startOf("day").diff(dayjs().startOf("day"), "day") : null;
  const expiringSoon = expiryDays !== null && expiryDays >= 0 && expiryDays <= 30;

  return (
    <Card
      actions={
        policy
          ? [
              ...(canManageInsurance
                ? [
                    <Button icon={<EditOutlined />} key="edit" onClick={() => onEdit(policy)} type="link">
                      编辑
                    </Button>
                  ]
                : []),
              ...(canManageDocuments || policyDocuments.length > 0
                ? [
                    <Button
                      icon={<FileTextOutlined />}
                      key="attachments"
                      onClick={() => onUpload(policy)}
                      type="link"
                    >
                      附件（{policyDocuments.length}）
                    </Button>
                  ]
                : [])
            ]
          : canManageInsurance
            ? [
                <Button icon={<PlusOutlined />} key="create" onClick={onCreate} type="link">
                  新建{label}保单
                </Button>
              ]
            : undefined
      }
      title={label}
    >
      {policy ? (
        <Flex gap={12} vertical>
          {expiringSoon ? (
            <Alert message={`${label}将在 ${expiryDays} 天后到期`} showIcon type="warning" />
          ) : null}
          <Descriptions
            column={1}
            items={[
              { children: policy.policyNo, label: "保单号" },
              { children: policy.insurerName ?? "-", label: "保险公司" },
              {
                children: `${formatDate(policy.effectiveFrom)} 至 ${formatDate(policy.effectiveTo)}`,
                label: "保险期间"
              },
              { children: formatYuan(policy.premiumAmount), label: "保费" },
              {
                children: (
                  <Tag color={POLICY_STATUS_COLORS[policy.policyStatus] ?? "default"}>
                    {labelOf(VEHICLE_INSURANCE_POLICY_STATUS_LABELS, policy.policyStatus)}
                  </Tag>
                ),
                label: "状态"
              }
            ]}
            size="small"
          />
        </Flex>
      ) : (
        <Empty description={`暂无生效中的${label}保单`} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
    </Card>
  );
}

function PolicyDocumentList({ documents }: Readonly<{ documents: VehicleInsuranceDocument[] }>) {
  if (documents.length === 0) {
    return <Empty description="暂无保单附件" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <Table
      columns={[
        {
          dataIndex: "title",
          render: (value: string | null | undefined, row: VehicleInsuranceDocument) =>
            value || row.originalName || row.fileName,
          title: "文件"
        },
        {
          dataIndex: "customerVisible",
          render: (value: boolean) => (value ? <Tag color="green">客户可见</Tag> : <Tag>仅后台可见</Tag>),
          title: "可见性",
          width: 110
        },
        {
          render: (_: unknown, row: VehicleInsuranceDocument) => (
            <Button href={buildAdminPreviewUrl(row.previewUrl)} target="_blank" type="link">
              预览
            </Button>
          ),
          title: "操作",
          width: 80
        }
      ]}
      dataSource={documents}
      pagination={false}
      rowKey="id"
      size="small"
    />
  );
}

function PolicyForm({
  form,
  onFinish,
  saving
}: Readonly<{
  form: ReturnType<typeof Form.useForm<PolicyFormValues>>[0];
  onFinish: (values: PolicyFormValues) => Promise<void>;
  saving: boolean;
}>) {
  return (
    <Form form={form} layout="vertical" onFinish={(values) => void onFinish(values)}>
      <Form.Item label="保单号" name="policyNo" rules={[{ required: true, message: "请输入保单号" }]}>
        <Input maxLength={128} />
      </Form.Item>
      <Space style={{ width: "100%" }} wrap>
        <Form.Item label="保单类型" name="policyType" rules={[{ required: true, message: "请选择保单类型" }]}>
          <Select options={optionsFromLabels(VEHICLE_INSURANCE_POLICY_TYPE_LABELS)} style={{ width: 180 }} />
        </Form.Item>
        <Form.Item label="状态" name="policyStatus">
          <Select options={optionsFromLabels(VEHICLE_INSURANCE_POLICY_STATUS_LABELS)} style={{ width: 180 }} />
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
          <Flex gap={8} vertical>
            {fields.map((field) => (
              <Space align="baseline" key={field.key} wrap>
                <Form.Item name={[field.name, "coverageType"]} rules={[{ required: true, message: "请选择险种" }]}>
                  <Select
                    options={optionsFromLabels(VEHICLE_INSURANCE_COVERAGE_TYPE_LABELS)}
                    placeholder="险种"
                    style={{ width: 170 }}
                  />
                </Form.Item>
                <Form.Item name={[field.name, "coverageName"]}>
                  <Input placeholder="险种名称" style={{ width: 150 }} />
                </Form.Item>
                <Form.Item name={[field.name, "insuredAmountYuan"]}>
                  <InputNumber min={0} placeholder="保额（元）" precision={2} style={{ width: 130 }} />
                </Form.Item>
                <Form.Item name={[field.name, "deductibleAmountYuan"]}>
                  <InputNumber min={0} placeholder="免赔（元）" precision={2} style={{ width: 130 }} />
                </Form.Item>
                <Button danger onClick={() => remove(field.name)} size="small">
                  删除
                </Button>
              </Space>
            ))}
            <Button onClick={() => add()} size="small">
              添加险种
            </Button>
          </Flex>
        )}
      </Form.List>
      <Button htmlType="submit" loading={saving} style={{ marginTop: 18 }} type="primary">
        保存
      </Button>
    </Form>
  );
}

function BaasDetails({ summary, vehicleId }: Readonly<{ summary: VehicleBaasSummary | null; vehicleId: string }>) {
  const active = summary?.activeContract ?? null;

  if (!active) {
    return (
      <Flex gap={12} vertical>
        <Alert message="尚未配置生效中的 BaaS 合同" showIcon type="warning" />
        <Button href={`/vehicle-baas-contracts?vehicleId=${encodeURIComponent(vehicleId)}`} type="link">
          前往 BaaS 合同管理
        </Button>
      </Flex>
    );
  }

  return (
    <Flex gap={12} vertical>
      <Descriptions
        column={1}
        items={[
          { children: active.providerName, label: "服务商" },
          { children: active.contractNo, label: "合同号" },
          { children: formatYuan(active.rentalAmount), label: "月租费" },
          {
            children: labelOf(VEHICLE_BAAS_BILLING_CYCLE_LABELS, active.billingCycle),
            label: "计费周期"
          },
          { children: `每月 ${active.paymentDayOfMonth} 日`, label: "支付日" },
          { children: formatDate(active.nextDueDate), label: "下次付款" },
          { children: `${summary?.unpaidCostCount ?? active.unpaidCostCount} 笔`, label: "未支付成本" },
          {
            children: (
              <Tag color={active.contractStatus === "ACTIVE" ? "green" : "default"}>
                {labelOf(VEHICLE_BAAS_CONTRACT_STATUS_LABELS, active.contractStatus)}
              </Tag>
            ),
            label: "合同状态"
          }
        ]}
        size="small"
      />
      <Button href={`/vehicle-baas-contracts?vehicleId=${encodeURIComponent(vehicleId)}`} type="link">
        查看 BaaS 合同与成本记录
      </Button>
    </Flex>
  );
}

function policyHistoryColumns(
  canManage: boolean,
  onEdit: (policy: VehicleInsurancePolicy) => void
): ColumnsType<VehicleInsurancePolicy> {
  return [
    { dataIndex: "policyNo", title: "保单号" },
    {
      dataIndex: "policyType",
      render: (value: string) => labelOf(VEHICLE_INSURANCE_POLICY_TYPE_LABELS, value),
      title: "类型"
    },
    {
      dataIndex: "policyStatus",
      render: (value: string) => (
        <Tag color={POLICY_STATUS_COLORS[value] ?? "default"}>
          {labelOf(VEHICLE_INSURANCE_POLICY_STATUS_LABELS, value)}
        </Tag>
      ),
      title: "状态"
    },
    { dataIndex: "insurerName", render: (value?: string | null) => value ?? "-", title: "保险公司" },
    {
      render: (_: unknown, row: VehicleInsurancePolicy) =>
        `${formatDate(row.effectiveFrom)} 至 ${formatDate(row.effectiveTo)}`,
      title: "保险期间"
    },
    { dataIndex: "documentCount", title: "附件", width: 80 },
    ...(canManage
      ? [
          {
            render: (_: unknown, row: VehicleInsurancePolicy) => (
              <Button onClick={() => onEdit(row)} size="small" type="link">
                编辑
              </Button>
            ),
            title: "操作",
            width: 80
          }
        ]
      : [])
  ];
}

function getCurrentPolicy(policies: VehicleInsurancePolicy[], policyType: string) {
  return policies
    .filter((policy) => policy.policyType === policyType && policy.policyStatus === "ACTIVE")
    .sort((left, right) => dayjs(right.effectiveFrom).valueOf() - dayjs(left.effectiveFrom).valueOf())[0];
}

function policyToFormValues(policy: VehicleInsurancePolicy): PolicyFormValues {
  return {
    coverages: policy.coverages.map((coverage) => ({
      coverageName: coverage.coverageName,
      coverageType: coverage.coverageType,
      deductibleAmountYuan: yuanFromCents(coverage.deductibleAmount),
      insuredAmountYuan: yuanFromCents(coverage.insuredAmount),
      remark: coverage.remark
    })),
    currency: policy.currency ?? "CNY",
    effectiveFrom: dayjs(policy.effectiveFrom),
    effectiveTo: dayjs(policy.effectiveTo),
    insuredAmountYuan: yuanFromCents(policy.insuredAmount),
    insuredName: policy.insuredName,
    insurerName: policy.insurerName,
    policyHolderName: policy.policyHolderName,
    policyNo: policy.policyNo,
    policyStatus: policy.policyStatus,
    policyType: policy.policyType,
    premiumAmountYuan: yuanFromCents(policy.premiumAmount),
    remark: policy.remark,
    renewalReminderAt: policy.renewalReminderAt ? dayjs(policy.renewalReminderAt) : null
  };
}

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

function getInsuranceDocumentType(policyType: string) {
  return policyType === "COMPULSORY_TRAFFIC"
    ? "COMPULSORY_INSURANCE_POLICY"
    : "COMMERCIAL_INSURANCE_POLICY";
}

function appendIfPresent(formData: FormData, key: string, value?: string | null) {
  if (value) {
    formData.append(key, value);
  }
}

function buildAdminPreviewUrl(previewUrl: string) {
  if (/^https?:\/\//.test(previewUrl)) {
    return previewUrl;
  }
  return `${API_BASE_URL.replace(/\/api$/, "")}${previewUrl}`;
}

function reportTimestamp(report: VehicleConditionReport) {
  return dayjs(report.inspectionDate ?? report.publishedAt ?? report.updatedAt).valueOf();
}

function percentage(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${value}%` : "-";
}

function numberWithUnit(value: number | null | undefined, unit: string) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("zh-CN")} ${unit}` : "-";
}
