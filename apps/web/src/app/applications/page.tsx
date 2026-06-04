"use client";

import { UploadOutlined } from "@ant-design/icons";
import {
  App,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { UploadFile } from "antd/es/upload/interface";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import {
  MATERIAL_STATUS_LABELS,
  MATERIAL_TYPE_LABELS,
  STATUS_LABELS,
  labelOf
} from "../../constants/labels";
import { apiFetch, ApiError } from "../../lib/api";
import type { CompatibleMaterialFile } from "../../lib/application-materials";
import { renderMaterialFileNames } from "../../lib/application-materials";

interface CustomerOption {
  customerNo: string;
  id: string;
  mobile: string;
  name: string;
}

interface ApplicationMaterial {
  file?: CompatibleMaterialFile | null;
  fileName?: string | null;
  files?: CompatibleMaterialFile[];
  id: string;
  materialName?: string | null;
  materialType: string;
  reviewStatus?: string | null;
  status?: string | null;
}

interface ApplicationRow {
  applicationNo: string;
  approvedAt?: string | null;
  createdAt: string;
  customer: {
    customerNo: string;
    id: string;
    mobile: string;
    name: string;
    status: string;
  };
  id: string;
  intendedModel?: string | null;
  intendedPeriodMonths?: number | null;
  materials: ApplicationMaterial[];
  rejectedReason?: string | null;
  riskResult?: RiskResult | null;
  salesUser?: { id: string; name: string; username: string } | null;
  status: string;
  submittedAt?: string | null;
}

interface RiskResult {
  approvedDepositAmount: number;
  defaultRate: number;
  grade: string;
  maxVehiclePurchasePriceAmount?: number | null;
  result: string;
  score?: number | null;
}

interface CreateApplicationValues {
  customerId: string;
  intendedModel?: string;
  intendedPeriodMonths?: number;
}

interface ApproveValues {
  grade: string;
  maxVehiclePurchasePriceAmountYuan?: number;
  remark?: string;
  riskScore?: number;
}

interface MaterialValues {
  materialType: string;
  reviewRemark?: string;
}

const statusColors: Record<string, string> = {
  APPROVED: "green",
  DRAFT: "blue",
  NEED_MORE_INFO: "orange",
  REJECTED: "red",
  SUBMITTED: "purple",
  UNDER_REVIEW: "purple"
};

const materialOptions = [
  { label: "身份证", value: "ID_CARD" },
  { label: "驾驶证", value: "DRIVER_LICENSE" },
  { label: "银行流水", value: "BANK_FLOW" },
  { label: "工作证明", value: "WORK_PROOF" },
  { label: "居住证明", value: "RESIDENCE_PROOF" },
  { label: "征信授权", value: "CREDIT_AUTH" },
  { label: "其他", value: "OTHER" }
];

const uploadableStatuses = ["DRAFT", "SUBMITTED", "NEED_MORE_INFO"];

function formatYuan(amount: number) {
  return `￥${(amount / 100).toFixed(2)}`;
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

export default function ApplicationsPage() {
  const { message, modal } = App.useApp();
  const [approveForm] = Form.useForm<ApproveValues>();
  const [applicationForm] = Form.useForm<CreateApplicationValues>();
  const [materialForm] = Form.useForm<MaterialValues>();
  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [approveTarget, setApproveTarget] = useState<ApplicationRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [materialFile, setMaterialFile] = useState<File | null>(null);
  const [materialFileList, setMaterialFileList] = useState<UploadFile[]>([]);
  const [uploadingMaterial, setUploadingMaterial] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<ApplicationRow | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [applicationRows, customerRows] = await Promise.all([
        apiFetch<ApplicationRow[]>("/applications"),
        apiFetch<CustomerOption[]>("/customers")
      ]);
      setApplications(applicationRows);
      setCustomers(customerRows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function createApplication(values: CreateApplicationValues) {
    await apiFetch<ApplicationRow>("/applications", {
      body: JSON.stringify(values),
      method: "POST"
    });
    void message.success("进件已创建");
    setModalOpen(false);
    applicationForm.resetFields();
    await loadData();
  }

  async function submitApplication(record: ApplicationRow) {
    await apiFetch<ApplicationRow>(`/applications/${record.id}/submit`, { method: "POST" });
    void message.success("进件已提交");
    await loadData();
  }

  async function approveApplication(values: ApproveValues) {
    if (!approveTarget) {
      return;
    }

    await apiFetch<ApplicationRow>(`/applications/${approveTarget.id}/approve`, {
      body: JSON.stringify({
        grade: values.grade,
        maxVehiclePurchasePriceAmount:
          values.maxVehiclePurchasePriceAmountYuan === undefined
            ? undefined
            : Math.round(values.maxVehiclePurchasePriceAmountYuan * 100),
        remark: values.remark,
        riskScore: values.riskScore
      }),
      method: "POST"
    });
    void message.success("进件已通过");
    setApproveTarget(null);
    approveForm.resetFields();
    await loadData();
  }

  async function reviewApplication(record: ApplicationRow, action: "need-more-info" | "reject") {
    const config =
      action === "need-more-info"
        ? { body: { reason: "需补充资料" }, title: "确认要求补件？" }
        : { body: { reason: "暂不符合准入要求" }, title: "确认拒绝该进件？" };

    modal.confirm({
      okText: "确认",
      cancelText: "取消",
      onOk: async () => {
        await apiFetch<ApplicationRow>(`/applications/${record.id}/${action}`, {
          body: JSON.stringify(config.body),
          method: "POST"
        });
        void message.success("状态已更新");
        await loadData();
      },
      title: config.title
    });
  }

  async function uploadMaterial(values: MaterialValues) {
    if (!uploadTarget || !materialFile) {
      void message.error("请选择资料文件");
      return;
    }

    if (!uploadableStatuses.includes(uploadTarget.status)) {
      void message.warning("当前进件状态不可上传资料");
      return;
    }

    const body = new FormData();
    body.append("materialType", values.materialType);
    body.append("file", materialFile);
    if (values.reviewRemark) {
      body.append("reviewRemark", values.reviewRemark);
    }

    setUploadingMaterial(true);
    try {
      await apiFetch<ApplicationMaterial>(`/applications/${uploadTarget.id}/materials`, {
        body,
        method: "POST"
      });
      void message.success("资料已上传");
      closeUploadDrawer();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setUploadingMaterial(false);
    }
  }

  function closeUploadDrawer() {
    setUploadTarget(null);
    setMaterialFile(null);
    setMaterialFileList([]);
    materialForm.resetFields();
  }

  const columns: ColumnsType<ApplicationRow> = [
    {
      dataIndex: "applicationNo",
      render: (value: string, record) => <Link href={`/applications/${record.id}`}>{value}</Link>,
      title: "进件编号",
      width: 180
    },
    {
      dataIndex: "customer",
      render: (value: ApplicationRow["customer"]) => `${value.name} ${value.mobile}`,
      title: "客户姓名",
      width: 180
    },
    { dataIndex: "intendedModel", title: "意向车型", width: 120 },
    { dataIndex: "intendedPeriodMonths", title: "意向周期（月）", width: 120 },
    {
      dataIndex: "status",
      render: (value: string) => (
        <Tag color={statusColors[value] ?? "default"}>{labelOf(STATUS_LABELS, value)}</Tag>
      ),
      title: "当前状态",
      width: 150
    },
    {
      dataIndex: "riskResult",
      render: (value?: RiskResult | null) =>
        value ? (
          <Space size={4}>
            <Tag color="green">{value.grade}</Tag>
            <span>{formatYuan(value.approvedDepositAmount)}</span>
          </Space>
        ) : (
          "-"
        ),
      title: "风控结果",
      width: 160
    },
    {
      dataIndex: "materials",
      render: (value: ApplicationMaterial[]) => value.length,
      title: "资料数",
      width: 90
    },
    {
      dataIndex: "salesUser",
      render: (value?: ApplicationRow["salesUser"]) => value?.name ?? "-",
      title: "所属销售",
      width: 120
    },
    {
      render: (_, record) => (
        <Space wrap>
          <Button
            disabled={!uploadableStatuses.includes(record.status)}
            onClick={() => setUploadTarget(record)}
            size="small"
          >
            上传资料
          </Button>
          <Button
            disabled={!["DRAFT", "NEED_MORE_INFO"].includes(record.status)}
            onClick={() => submitApplication(record)}
            size="small"
          >
            提交
          </Button>
          <Button
            disabled={record.status !== "SUBMITTED"}
            onClick={() => {
              approveForm.setFieldsValue({ grade: "A" });
              setApproveTarget(record);
            }}
            size="small"
          >
            通过
          </Button>
          <Button
            disabled={record.status !== "SUBMITTED"}
            onClick={() => reviewApplication(record, "need-more-info")}
            size="small"
          >
            补件
          </Button>
          <Button
            danger
            disabled={record.status !== "SUBMITTED"}
            onClick={() => reviewApplication(record, "reject")}
            size="small"
          >
            拒绝
          </Button>
        </Space>
      ),
      title: "操作",
      width: 380
    }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            进件管理
          </Typography.Title>
          <Button onClick={() => setModalOpen(true)} type="primary">
            新建进件
          </Button>
        </Space>
        <Table columns={columns} dataSource={applications} loading={loading} rowKey="id" />
      </Space>

      <Modal
        cancelText="取消"
        okText="保存"
        onCancel={() => setModalOpen(false)}
        onOk={() => applicationForm.submit()}
        open={modalOpen}
        title="新建进件"
      >
        <Form<CreateApplicationValues>
          form={applicationForm}
          layout="vertical"
          onFinish={createApplication}
        >
          <Form.Item label="客户" name="customerId" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={customers.map((customer) => ({
                label: `${customer.name} ${customer.mobile} / ${customer.customerNo}`,
                value: customer.id
              }))}
            />
          </Form.Item>
          <Form.Item label="意向车型" name="intendedModel">
            <Input placeholder="ET5 / ET7 / ES6" />
          </Form.Item>
          <Form.Item label="订阅周期（月）" name="intendedPeriodMonths">
            <InputNumber max={60} min={1} style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        cancelText="取消"
        okText="通过"
        onCancel={() => {
          setApproveTarget(null);
          approveForm.resetFields();
        }}
        onOk={() => approveForm.submit()}
        open={Boolean(approveTarget)}
        title={approveTarget ? `风控审批 / ${approveTarget.applicationNo}` : "风控审批"}
      >
        <Form<ApproveValues> form={approveForm} layout="vertical" onFinish={approveApplication}>
          <Form.Item label="客户等级" name="grade" rules={[{ required: true }]}>
            <Select
              options={[
                { label: "A", value: "A" },
                { label: "B", value: "B" },
                { label: "C", value: "C" }
              ]}
            />
          </Form.Item>
          <Form.Item label="风控评分" name="riskScore">
            <InputNumber max={1000} min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="最高可承租车价（元）" name="maxVehiclePurchasePriceAmountYuan">
            <InputNumber min={0} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="审批意见" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        onClose={closeUploadDrawer}
        open={Boolean(uploadTarget)}
        title={uploadTarget ? `上传资料 / ${uploadTarget.applicationNo}` : "上传资料"}
        size={520}
      >
        <Form<MaterialValues>
          form={materialForm}
          initialValues={{ materialType: "ID_CARD" }}
          layout="vertical"
          onFinish={uploadMaterial}
        >
          <Form.Item label="资料类型" name="materialType" rules={[{ required: true }]}>
            <Select options={materialOptions} />
          </Form.Item>
          <Form.Item label="文件" required>
            <Upload
              beforeUpload={(file) => {
                setMaterialFile(file as File);
                setMaterialFileList([file]);
                return false;
              }}
              fileList={materialFileList}
              maxCount={1}
              onChange={({ fileList }) => {
                setMaterialFileList(fileList.slice(-1));
                const latestFile = fileList.at(-1);
                setMaterialFile((latestFile?.originFileObj as File | undefined) ?? null);
              }}
              onRemove={() => {
                setMaterialFile(null);
                setMaterialFileList([]);
              }}
            >
              <Button icon={<UploadOutlined />}>选择文件</Button>
            </Upload>
          </Form.Item>
          <Form.Item label="备注" name="reviewRemark">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Button block htmlType="submit" loading={uploadingMaterial} type="primary">
            上传
          </Button>
        </Form>
        {uploadTarget?.materials.length ? (
          <Table
            columns={[
              {
                dataIndex: "materialType",
                render: (value: string) => labelOf(MATERIAL_TYPE_LABELS, value),
                title: "资料类型"
              },
              {
                render: (_, record: ApplicationMaterial) => renderMaterialFileNames(record),
                title: "文件名"
              },
              {
                dataIndex: "status",
                render: (value: string | null | undefined, record: ApplicationMaterial) =>
                  labelOf(MATERIAL_STATUS_LABELS, record.reviewStatus ?? value),
                title: "资料状态"
              }
            ]}
            dataSource={uploadTarget.materials}
            pagination={false}
            rowKey="id"
            size="small"
            style={{ marginTop: 24 }}
          />
        ) : null}
      </Drawer>
    </ProtectedShell>
  );
}
