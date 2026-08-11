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
import dayjs from "dayjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../components/action-button";
import { ProtectedShell } from "../../components/protected-shell";
import {
  APPLICATION_SOURCE_LABELS,
  DEPOSIT_STATUS_LABELS,
  MATERIAL_TYPE_LABELS,
  PLAN_CONFIRM_STATUS_LABELS,
  REVIEW_STATUS_LABELS,
  STATUS_LABELS,
  labelOf
} from "../../constants/labels";
import { actionAvailability } from "../../lib/action-guards";
import { apiFetch, ApiError } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";
import { joinText, snapshotValue, safeText } from "../../lib/application-snapshots";
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

interface ApplicationOrderSummary {
  id: string;
  orderNo: string;
  orderStatus: string;
}

interface ApplicationRow {
  applicationNo: string;
  applicationSource?: string | null;
  approvedAt?: string | null;
  createdAt: string;
  creditReviewStatus?: string | null;
  customer: {
    customerNo: string;
    id: string;
    mobile: string;
    name: string;
    status: string;
  };
  customerSelectedSnapshot?: unknown;
  customerProfileReadiness?: {
    complete: boolean;
    missingFields: Array<{ key: string; label?: string; reason: string }>;
  };
  depositStatus?: string | null;
  finalPlanSnapshot?: unknown;
  id: string;
  intentSnapshot?: unknown;
  intendedModel?: string | null;
  intendedPeriodMonths?: number | null;
  materialReviewStatus?: string | null;
  materials: ApplicationMaterial[];
  orders?: ApplicationOrderSummary[];
  planConfirmStatus?: string | null;
  productReviewStatus?: string | null;
  rejectedReason?: string | null;
  salesUser?: { id: string; name: string; username: string } | null;
  status: string;
  submittedAt?: string | null;
  vehicleReviewStatus?: string | null;
}

interface CreateApplicationValues {
  customerId: string;
  intendedModel?: string;
  intendedPeriodMonths?: number;
}

interface MaterialValues {
  materialType: string;
  reviewRemark?: string;
}

type ReviewFilter =
  | "all"
  | "cancelled"
  | "can-create-order"
  | "credit-pending"
  | "final-plan-pending"
  | "material-pending"
  | "ordered"
  | "product-pending"
  | "rejected"
  | "vehicle-pending";

const statusColors: Record<string, string> = {
  APPROVED: "green",
  CANCELLED: "default",
  CONFIRMED: "green",
  DRAFT: "blue",
  NEED_MORE_INFO: "orange",
  PENDING: "blue",
  PENDING_CONFIRM: "orange",
  REJECTED: "red",
  SUBMITTED: "purple"
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

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function StatusTag({
  labels,
  value
}: {
  labels?: Record<string, string>;
  value?: string | null;
}) {
  return (
    <Tag color={value ? statusColors[value] ?? "default" : "default"}>
      {value ? labelOf(labels ?? STATUS_LABELS, value) : "-"}
    </Tag>
  );
}

function applicationVehicleLabel(row: ApplicationRow) {
  return joinText(
    snapshotValue(row.intentSnapshot, "vehicleSnapshot.vehicleNo"),
    snapshotValue(row.intentSnapshot, "vehicleSnapshot.plateNo"),
    snapshotValue(row.intentSnapshot, "vehicleSnapshot.vin"),
    row.intendedModel
  );
}

function applicationPlanLabel(row: ApplicationRow) {
  return joinText(
    snapshotValue(row.intentSnapshot, "packageSnapshot.subscriptionPlan.planNo"),
    snapshotValue(row.intentSnapshot, "packageSnapshot.subscriptionPlan.planName"),
    snapshotValue(row.customerSelectedSnapshot, "packageSnapshot.subscriptionPlan.planName")
  );
}

function hasOrder(row: ApplicationRow) {
  return Boolean(row.orders?.length);
}

function canCreateOrder(row: ApplicationRow) {
  return row.planConfirmStatus === "CONFIRMED" && !hasOrder(row) && row.status !== "REJECTED" && row.status !== "CANCELLED";
}

function matchesReviewFilter(row: ApplicationRow, filter: ReviewFilter) {
  if (filter === "all") {
    return true;
  }
  if (filter === "material-pending") {
    return row.materialReviewStatus === "PENDING" || row.materialReviewStatus === "NEED_MORE_INFO";
  }
  if (filter === "credit-pending") {
    return row.creditReviewStatus === "PENDING" || row.creditReviewStatus === "NEED_MORE_INFO";
  }
  if (filter === "product-pending") {
    return row.productReviewStatus === "PENDING";
  }
  if (filter === "vehicle-pending") {
    return row.vehicleReviewStatus === "PENDING";
  }
  if (filter === "final-plan-pending") {
    return (
      row.materialReviewStatus === "APPROVED" &&
      row.creditReviewStatus === "APPROVED" &&
      row.productReviewStatus === "APPROVED" &&
      row.vehicleReviewStatus === "APPROVED" &&
      row.depositStatus === "CONFIRMED" &&
      row.planConfirmStatus !== "CONFIRMED"
    );
  }
  if (filter === "can-create-order") {
    return canCreateOrder(row);
  }
  if (filter === "ordered") {
    return hasOrder(row);
  }
  if (filter === "rejected") {
    return row.status === "REJECTED";
  }
  if (filter === "cancelled") {
    return row.status === "CANCELLED";
  }
  return true;
}

export default function ApplicationsPage() {
  const { message } = App.useApp();
  const [applicationForm] = Form.useForm<CreateApplicationValues>();
  const [materialForm] = Form.useForm<MaterialValues>();
  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [materialFile, setMaterialFile] = useState<File | null>(null);
  const [materialFileList, setMaterialFileList] = useState<UploadFile[]>([]);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [uploadingMaterial, setUploadingMaterial] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<ApplicationRow | null>(null);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [applicationRows, customerRows, nextMe] = await Promise.all([
        apiFetch<ApplicationRow[]>("/applications"),
        apiFetch<CustomerOption[]>("/customers"),
        apiFetch<AuthMeResponse>("/auth/me")
      ]);
      setApplications(applicationRows);
      setCustomers(customerRows);
      setMe(nextMe);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const filteredApplications = useMemo(
    () =>
      applications.filter((row) => {
        const sourceMatched = sourceFilter === "all" || row.applicationSource === sourceFilter;
        return sourceMatched && matchesReviewFilter(row, reviewFilter);
      }),
    [applications, reviewFilter, sourceFilter]
  );

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
      fixed: "left",
      render: (value: string, record) => <Link href={`/applications/${record.id}`}>{value}</Link>,
      title: "进件编号",
      width: 170
    },
    {
      dataIndex: "applicationSource",
      render: (value?: string | null) => safeText(labelOf(APPLICATION_SOURCE_LABELS, value)),
      title: "进件来源",
      width: 110
    },
    { dataIndex: ["customer", "name"], title: "客户姓名", width: 110 },
    { dataIndex: ["customer", "mobile"], title: "手机号", width: 130 },
    { render: (_, record) => applicationVehicleLabel(record), title: "意向车辆", width: 230 },
    { render: (_, record) => applicationPlanLabel(record), title: "意向套餐", width: 230 },
    {
      dataIndex: "materialReviewStatus",
      render: (value?: string | null) => <StatusTag labels={REVIEW_STATUS_LABELS} value={value} />,
      title: "资料审核状态",
      width: 130
    },
    {
      dataIndex: "creditReviewStatus",
      render: (value?: string | null) => <StatusTag labels={REVIEW_STATUS_LABELS} value={value} />,
      title: "资质审核状态",
      width: 130
    },
    {
      dataIndex: "depositStatus",
      render: (value?: string | null) => <StatusTag labels={DEPOSIT_STATUS_LABELS} value={value} />,
      title: "押金状态",
      width: 130
    },
    {
      dataIndex: "productReviewStatus",
      render: (value?: string | null) => <StatusTag labels={REVIEW_STATUS_LABELS} value={value} />,
      title: "产品匹配状态",
      width: 130
    },
    {
      dataIndex: "vehicleReviewStatus",
      render: (value?: string | null) => <StatusTag labels={REVIEW_STATUS_LABELS} value={value} />,
      title: "车辆库存状态",
      width: 130
    },
    {
      dataIndex: "planConfirmStatus",
      render: (value?: string | null) => <StatusTag labels={PLAN_CONFIRM_STATUS_LABELS} value={value} />,
      title: "最终方案状态",
      width: 130
    },
    {
      dataIndex: "status",
      render: (value: string) => <StatusTag value={value} />,
      title: "进件状态",
      width: 120
    },
    {
      render: (_, record) =>
        hasOrder(record) ? (
          <Space orientation="vertical" size={2}>
            <Tag color="green">已生成</Tag>
            {record.orders?.[0] ? <Link href={`/orders/${record.orders[0].id}`}>{record.orders[0].orderNo}</Link> : null}
          </Space>
        ) : (
          <Tag>未生成</Tag>
        ),
      title: "是否已生成订单",
      width: 150
    },
    { dataIndex: "createdAt", render: formatTime, title: "创建时间", width: 160 },
    {
      fixed: "right",
      render: (_, record) => (
        <Space wrap>
          <Button href={`/applications/${record.id}`} size="small" type="link">
            查看 / 审核
          </Button>
          <ActionButton
            allowed={uploadableStatuses.includes(record.status)}
            disabledReason="当前进件状态不允许上传资料"
            onClick={() => setUploadTarget(record)}
            permission="application:material_upload"
            permissions={permissions}
            size="small"
          >
            上传资料
          </ActionButton>
          <ActionButton
            allowed={
              ["DRAFT", "NEED_MORE_INFO"].includes(record.status) &&
              Boolean(record.customerProfileReadiness?.complete)
            }
            disabledReason={
              record.customerProfileReadiness && !record.customerProfileReadiness.complete
                ? "客户资料不完整，请客户在 Portal 完成资料后进入详情刷新"
                : "当前进件状态不允许提交"
            }
            onClick={() => submitApplication(record)}
            permission="application:submit"
            permissions={permissions}
            size="small"
          >
            提交
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 250
    }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            进件管理
          </Typography.Title>
          <ActionButton
            availability={actionAvailability({
              permission: "application:manage",
              permissions,
              noPermissionReason: "无创建进件权限"
            })}
            onClick={() => setModalOpen(true)}
            type="primary"
          >
            新建进件
          </ActionButton>
        </Space>

        <Space wrap>
          <Select
            onChange={setSourceFilter}
            options={[
              { label: "全部来源", value: "all" },
              { label: "客户自助", value: "SELF_SERVICE" },
              { label: "销售人工", value: "SALES_ASSISTED" }
            ]}
            style={{ width: 160 }}
            value={sourceFilter}
          />
          <Select<ReviewFilter>
            onChange={setReviewFilter}
            options={[
              { label: "全部审核状态", value: "all" },
              { label: "待资料审核", value: "material-pending" },
              { label: "待资质审核", value: "credit-pending" },
              { label: "待产品审核", value: "product-pending" },
              { label: "待车辆审核", value: "vehicle-pending" },
              { label: "待最终方案确认", value: "final-plan-pending" },
              { label: "可生成订单", value: "can-create-order" },
              { label: "已生成订单", value: "ordered" },
              { label: "已拒绝", value: "rejected" },
              { label: "已取消", value: "cancelled" }
            ]}
            style={{ width: 190 }}
            value={reviewFilter}
          />
          <Typography.Text type="secondary">
            共 {filteredApplications.length} 条进件
          </Typography.Text>
        </Space>

        <Table
          columns={columns}
          dataSource={filteredApplications}
          loading={loading}
          rowKey="id"
          scroll={{ x: 2200 }}
        />
      </Space>

      <Modal
        cancelText="取消"
        okText="保存"
        onCancel={() => setModalOpen(false)}
        onOk={() => applicationForm.submit()}
        open={modalOpen}
        title="新建销售人工进件"
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
            <Input placeholder="ET5 / ET5T / ET7 / ES6 / EC6 / ES8 / ET9 / ES9" />
          </Form.Item>
          <Form.Item label="订阅周期（月）" name="intendedPeriodMonths">
            <InputNumber max={60} min={1} style={{ width: "100%" }} />
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
            <Select
              options={materialOptions.map((option) => ({
                ...option,
                label: MATERIAL_TYPE_LABELS[option.value] ?? option.label
              }))}
            />
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
                  labelOf(REVIEW_STATUS_LABELS, record.reviewStatus ?? value),
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
