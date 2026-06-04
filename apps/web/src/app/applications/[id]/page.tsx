"use client";

import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EyeOutlined,
  UploadOutlined
} from "@ant-design/icons";
import {
  App,
  Button,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  Upload
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { UploadFile } from "antd/es/upload/interface";
import dayjs from "dayjs";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProtectedShell } from "../../../components/protected-shell";
import { MATERIAL_STATUS_LABELS, STATUS_LABELS, labelOf } from "../../../constants/labels";
import { API_BASE_URL, apiFetch, ApiError } from "../../../lib/api";

interface UserRef {
  id: string;
  name: string;
  username: string;
}

interface MaterialFile {
  canDelete: boolean;
  deletedAt?: string | null;
  deleteReason?: string | null;
  fileId: string;
  fileName: string;
  fileRecordId: string;
  id: string;
  isDeleted: boolean;
  mimeType?: string | null;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy?: UserRef | null;
  uploader?: UserRef | null;
}

interface MaterialGroup {
  canReview: boolean;
  canUpload: boolean;
  files: MaterialFile[];
  id: string;
  materialGroupId: string;
  materialName: string;
  materialType: string;
  required: boolean;
  reviewComment?: string | null;
  reviewedAt?: string | null;
  reviewer?: UserRef | null;
  reviewStatus: string;
  status: string;
}

interface ApplicationActionLog {
  actionType: string;
  comment?: string | null;
  createdAt: string;
  fromStatus?: string | null;
  id: string;
  material?: {
    id: string;
    materialName?: string | null;
    materialType: string;
  } | null;
  materialFile?: {
    fileName: string;
    id: string;
    materialType: string;
  } | null;
  materialGroup?: {
    id: string;
    materialName?: string | null;
    materialType: string;
  } | null;
  operator?: UserRef | null;
  operatorName?: string | null;
  toStatus?: string | null;
}

interface ApplicationDetail {
  actionLogs: ApplicationActionLog[];
  applicationNo: string;
  approvedAt?: string | null;
  availableActions: string[];
  createdAt: string;
  customer: {
    customerNo: string;
    id: string;
    identity?: {
      driverLicenseNo?: string | null;
      idCardNo?: string | null;
      licenseValidUntil?: string | null;
      realnameVerified?: boolean | null;
    } | null;
    mobile: string;
    name: string;
    profile?: {
      companyName?: string | null;
      emergencyContactMobile?: string | null;
      emergencyContactName?: string | null;
      monthlyIncomeAmount?: number | null;
      occupation?: string | null;
      residenceAddress?: string | null;
    } | null;
    sourceChannel?: string | null;
    status: string;
  };
  id: string;
  intendedModel?: string | null;
  intendedPeriodMonths?: number | null;
  materials: MaterialGroup[];
  rejectedReason?: string | null;
  riskResult?: {
    approvedDepositAmount: number;
    defaultRate: number;
    grade: string;
    score?: number | null;
  } | null;
  salesUser?: UserRef | null;
  status: string;
  submittedAt?: string | null;
}

interface MaterialValues {
  materialType: string;
  reviewRemark?: string;
}

interface ApplicationActionValues {
  comment?: string;
  grade?: string;
  maxVehiclePurchasePriceAmountYuan?: number;
  riskScore?: number;
}

interface MaterialReviewValues {
  comment?: string;
}

interface DeleteFileValues {
  reason: string;
}

interface QuoteValues {
  periodMonths: number;
  subscriptionPlanId: string;
  vehicleBaseFeeAmountYuan: number;
  vehicleId: string;
}

interface AvailableVehicle {
  assetLocation?: string | null;
  brand: string;
  currentMileageKm: number;
  currentSalePriceAmount?: number | null;
  id: string;
  plateNo?: string | null;
  series?: string | null;
  status: string;
  vehicleId?: string;
  vehicleModel?: string | null;
  vehicleNo: string;
  vin?: string | null;
}

interface AvailableSubscriptionPlan {
  benefitDescription?: string | null;
  benefitPackagePriceAmount?: number;
  energyPackagePriceAmount?: number;
  maxPeriodMonths: number;
  maxPurchasePriceAmount?: number | null;
  minPeriodMonths: number;
  minPurchasePriceAmount?: number | null;
  monthlyEnergyCount?: number | null;
  monthlyEnergyKwh?: number | null;
  monthlyFeeCapRate?: number | null;
  monthlyFeeRate: number;
  monthlyMileageKm: number;
  mileagePackagePriceAmount?: number;
  overMileageFeeAmount: number;
  planName: string;
  planNo: string;
  productId: string;
  productName: string;
  productVersionId: string;
  subscriptionPlanId: string;
  vehicleModel: string;
  versionNo: string;
}

const materialOptions = [
  { label: "身份证", value: "ID_CARD" },
  { label: "驾驶证", value: "DRIVER_LICENSE" },
  { label: "银行流水", value: "BANK_FLOW" },
  { label: "工作证明", value: "WORK_PROOF" },
  { label: "居住证明", value: "RESIDENCE_PROOF" },
  { label: "征信授权", value: "CREDIT_AUTH" },
  { label: "其他", value: "OTHER" }
];

const materialLabels = Object.fromEntries(materialOptions.map((option) => [option.value, option.label]));

const unusedLegacyMaterialStatusLabels: Record<string, string> = {
  APPROVED: "通过",
  NEED_MORE_INFO: "补充资料",
  PENDING: "待审核",
  REJECTED: "不通过",
  VERIFIED: "通过"
};

void unusedLegacyMaterialStatusLabels;

const materialStatusColors: Record<string, string> = {
  APPROVED: "green",
  NEED_MORE_INFO: "orange",
  PENDING: "default",
  REJECTED: "red",
  VERIFIED: "green"
};

const applicationStatusColors: Record<string, string> = {
  APPROVED: "green",
  CANCELLED: "default",
  DRAFT: "blue",
  NEED_MORE_INFO: "orange",
  REJECTED: "red",
  SUBMITTED: "purple"
};

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function formatYuan(value?: number | null) {
  return value === undefined || value === null ? "-" : `¥${(value / 100).toFixed(2)}`;
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

export default function ApplicationDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [actionForm] = Form.useForm<ApplicationActionValues>();
  const [deleteFileForm] = Form.useForm<DeleteFileValues>();
  const [materialForm] = Form.useForm<MaterialValues>();
  const [materialReviewForm] = Form.useForm<MaterialReviewValues>();
  const [quoteForm] = Form.useForm<QuoteValues>();
  const [actionType, setActionType] = useState<"approve" | "need-more-info" | "reject" | "submit" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MaterialFile | null>(null);
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [materialFileList, setMaterialFileList] = useState<UploadFile[]>([]);
  const [materialReviewStatus, setMaterialReviewStatus] = useState<"APPROVED" | "NEED_MORE_INFO" | "REJECTED" | null>(null);
  const [materialReviewTarget, setMaterialReviewTarget] = useState<MaterialGroup | null>(null);
  const [availablePlans, setAvailablePlans] = useState<AvailableSubscriptionPlan[]>([]);
  const [availableVehicles, setAvailableVehicles] = useState<AvailableVehicle[]>([]);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const applicationId = params.id;
  const quoteVehicleId = Form.useWatch("vehicleId", quoteForm);
  const quoteSubscriptionPlanId = Form.useWatch("subscriptionPlanId", quoteForm);
  const quoteVehicleBaseFeeYuan = Form.useWatch("vehicleBaseFeeAmountYuan", quoteForm);
  const quotePeriodMonths = Form.useWatch("periodMonths", quoteForm);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      setDetail(await apiFetch<ApplicationDetail>(`/applications/${applicationId}`));
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [applicationId, message]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const availableActions = useMemo(() => new Set(detail?.availableActions ?? []), [detail]);
  const selectedQuoteVehicle = availableVehicles.find((vehicle) => (vehicle.vehicleId ?? vehicle.id) === quoteVehicleId);
  const selectedQuotePlan = availablePlans.find((plan) => plan.subscriptionPlanId === quoteSubscriptionPlanId);
  const quoteVehicleBaseFeeAmount = Math.round(Number(quoteVehicleBaseFeeYuan ?? 0) * 100);
  const quoteVehicleBaseFeeCap =
    selectedQuotePlan && selectedQuoteVehicle?.currentSalePriceAmount
      ? Math.floor(selectedQuoteVehicle.currentSalePriceAmount * selectedQuotePlan.monthlyFeeRate)
      : null;
  const quoteMileagePackagePriceAmount = selectedQuotePlan?.mileagePackagePriceAmount ?? 0;
  const quoteEnergyPackagePriceAmount = selectedQuotePlan?.energyPackagePriceAmount ?? 0;
  const quoteBenefitPackagePriceAmount = selectedQuotePlan?.benefitPackagePriceAmount ?? 0;
  const quotePackageMonthlyFeeAmount =
    quoteVehicleBaseFeeAmount +
    quoteMileagePackagePriceAmount +
    quoteEnergyPackagePriceAmount +
    quoteBenefitPackagePriceAmount;
  const vehicleBaseFeeOutOfRange = Boolean(
    quoteVehicleBaseFeeCap !== null &&
      quoteVehicleBaseFeeAmount > 0 &&
      quoteVehicleBaseFeeAmount > quoteVehicleBaseFeeCap
  );
  const periodOutOfRange = Boolean(
    selectedQuotePlan &&
      quotePeriodMonths !== undefined &&
      (quotePeriodMonths < selectedQuotePlan.minPeriodMonths || quotePeriodMonths > selectedQuotePlan.maxPeriodMonths)
  );

  async function openPreview(file: MaterialFile) {
    if (file.isDeleted) {
      void message.warning("文件暂不可预览");
      return;
    }

    try {
      const response = await fetch(
        `${API_BASE_URL}/applications/${applicationId}/material-files/${file.fileRecordId}/preview`,
        { credentials: "include" }
      );

      if (!response.ok) {
        throw new Error("Preview failed");
      }

      const blob = await response.blob();
      const previewUrl = URL.createObjectURL(blob);
      const opened = window.open(previewUrl, "_blank", "noopener,noreferrer");

      if (!opened) {
        URL.revokeObjectURL(previewUrl);
        void message.warning("文件暂不可预览");
      }
    } catch {
      void message.error("文件暂不可预览");
    }
  }

  function openActionModal(nextAction: typeof actionType) {
    setActionType(nextAction);
    actionForm.setFieldsValue({
      comment: undefined,
      grade: detail?.riskResult?.grade ?? "A",
      maxVehiclePurchasePriceAmountYuan: undefined,
      riskScore: detail?.riskResult?.score ?? undefined
    });
  }

  async function submitAction(values: ApplicationActionValues) {
    if (!actionType || !detail) {
      return;
    }

    setSubmitting(true);
    try {
      if (actionType === "submit") {
        await apiFetch<ApplicationDetail>(`/applications/${detail.id}/submit`, {
          body: JSON.stringify({ comment: values.comment }),
          method: "POST"
        });
      }

      if (actionType === "approve") {
        await apiFetch<ApplicationDetail>(`/applications/${detail.id}/approve`, {
          body: JSON.stringify({
            comment: values.comment,
            grade: values.grade,
            maxVehiclePurchasePriceAmount:
              values.maxVehiclePurchasePriceAmountYuan === undefined
                ? undefined
                : Math.round(values.maxVehiclePurchasePriceAmountYuan * 100),
            riskScore: values.riskScore
          }),
          method: "POST"
        });
      }

      if (actionType === "need-more-info") {
        await apiFetch<ApplicationDetail>(`/applications/${detail.id}/need-more-info`, {
          body: JSON.stringify({ comment: values.comment }),
          method: "POST"
        });
      }

      if (actionType === "reject") {
        await apiFetch<ApplicationDetail>(`/applications/${detail.id}/reject`, {
          body: JSON.stringify({ comment: values.comment }),
          method: "POST"
        });
      }

      void message.success("操作已完成");
      closeActionModal();
      await loadDetail();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  function closeActionModal() {
    setActionType(null);
    actionForm.resetFields();
  }

  function openUploadModal(materialType = "ID_CARD") {
    materialForm.setFieldsValue({ materialType });
    setUploadOpen(true);
  }

  async function uploadMaterial(values: MaterialValues) {
    const files = materialFileList
      .map((file) => file.originFileObj as File | undefined)
      .filter((file): file is File => Boolean(file));

    if (!detail || files.length === 0) {
      void message.error("请选择资料文件");
      return;
    }

    const body = new FormData();
    body.append("materialType", values.materialType);
    files.forEach((file) => body.append("files", file));

    if (values.reviewRemark) {
      body.append("reviewRemark", values.reviewRemark);
    }

    setSubmitting(true);
    try {
      await apiFetch<MaterialGroup>(`/applications/${detail.id}/materials`, {
        body,
        method: "POST"
      });
      void message.success("资料已上传");
      closeUploadModal();
      await loadDetail();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  function closeUploadModal() {
    setUploadOpen(false);
    setMaterialFileList([]);
    materialForm.resetFields();
  }

  function openMaterialReviewModal(
    group: MaterialGroup,
    status: "APPROVED" | "NEED_MORE_INFO" | "REJECTED"
  ) {
    setMaterialReviewTarget(group);
    setMaterialReviewStatus(status);
    materialReviewForm.resetFields();
  }

  async function reviewMaterial(values: MaterialReviewValues) {
    if (!detail || !materialReviewTarget || !materialReviewStatus) {
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch<MaterialGroup>(
        `/applications/${detail.id}/material-groups/${materialReviewTarget.materialGroupId}/review`,
        {
          body: JSON.stringify({
            comment: values.comment,
            status: materialReviewStatus
          }),
          method: "POST"
        }
      );
      void message.success("资料审核已更新");
      closeMaterialReviewModal();
      await loadDetail();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  function closeMaterialReviewModal() {
    setMaterialReviewTarget(null);
    setMaterialReviewStatus(null);
    materialReviewForm.resetFields();
  }

  async function deleteMaterialFile(values: DeleteFileValues) {
    if (!detail || !deleteTarget) {
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch<MaterialFile>(`/applications/${detail.id}/material-files/${deleteTarget.fileRecordId}`, {
        body: JSON.stringify({ reason: values.reason }),
        method: "DELETE"
      });
      void message.success("文件已删除");
      closeDeleteModal();
      await loadDetail();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  function closeDeleteModal() {
    setDeleteTarget(null);
    deleteFileForm.resetFields();
  }

  async function loadQuotePlans(vehicleId?: string) {
    const suffix = vehicleId ? `?vehicleId=${encodeURIComponent(vehicleId)}` : "";
    const plans = await apiFetch<AvailableSubscriptionPlan[]>(
      `/applications/${applicationId}/available-subscription-plans${suffix}`
    );
    setAvailablePlans(plans);
    return plans;
  }

  async function openQuoteModal() {
    try {
      const vehicles = await apiFetch<AvailableVehicle[]>("/vehicles/available");
      setAvailableVehicles(vehicles);
      const firstVehicle = vehicles[0];
      const firstVehicleId = firstVehicle ? (firstVehicle.vehicleId ?? firstVehicle.id) : undefined;
      const plans = firstVehicleId ? await loadQuotePlans(firstVehicleId) : [];
      const firstPlan = plans[0];
      quoteForm.setFieldsValue({
        periodMonths: detail?.intendedPeriodMonths ?? firstPlan?.minPeriodMonths ?? 12,
        subscriptionPlanId: firstPlan?.subscriptionPlanId,
        vehicleId: firstVehicleId
      });
      setQuoteOpen(true);
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function changeQuoteVehicle(vehicleId: string) {
    try {
      quoteForm.setFieldsValue({ subscriptionPlanId: undefined });
      const plans = await loadQuotePlans(vehicleId);
      const firstPlan = plans[0];
      quoteForm.setFieldsValue({
        periodMonths: detail?.intendedPeriodMonths ?? firstPlan?.minPeriodMonths ?? 12,
        subscriptionPlanId: firstPlan?.subscriptionPlanId
      });
    } catch (error) {
      setAvailablePlans([]);
      void message.error(getErrorMessage(error));
    }
  }

  async function createQuote(values: QuoteValues) {
    if (!detail) {
      return;
    }
    const vehicleBaseFeeAmount = Math.round(values.vehicleBaseFeeAmountYuan * 100);
    if (!selectedQuoteVehicle) {
      void message.error("请选择车辆");
      return;
    }
    if (!selectedQuotePlan) {
      void message.error("请选择订阅套餐");
      return;
    }
    if (vehicleBaseFeeAmount <= 0) {
      void message.error("车辆基础费报价必须大于 0");
      return;
    }
    if (periodOutOfRange) {
      void message.error("订阅周期不在套餐允许范围内");
      return;
    }
    if (vehicleBaseFeeOutOfRange) {
      void message.error("车辆基础费超过车型包系数允许上限");
      return;
    }
    setSubmitting(true);
    try {
      const quote = await apiFetch<{ id: string }>(`/applications/${detail.id}/quotes`, {
        body: JSON.stringify({
          periodMonths: values.periodMonths,
          subscriptionPlanId: values.subscriptionPlanId,
          vehicleBaseFeeAmount,
          vehicleId: values.vehicleId
        }),
        method: "POST"
      });
      void message.success("报价已生成");
      setQuoteOpen(false);
      setAvailablePlans([]);
      setAvailableVehicles([]);
      quoteForm.resetFields();
      router.push(`/quotes/${quote.id}`);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  const materialColumns: ColumnsType<MaterialGroup> = [
    {
      dataIndex: "materialType",
      render: (value: string, record) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text strong>{materialLabels[value] ?? value}</Typography.Text>
          <Tag color={record.required ? "red" : "default"}>{record.required ? "必需" : "可选"}</Tag>
        </Space>
      ),
      title: "资料类型",
      width: 130
    },
    {
      render: (_, record) =>
        record.files.length > 0 ? (
          <Space orientation="vertical" size={8} style={{ width: "100%" }}>
            {record.files.map((file) => (
              <Space key={file.fileRecordId} wrap>
                <Button onClick={() => openPreview(file)} type="link">
                  {file.fileName}
                </Button>
                <Typography.Text type="secondary">{file.uploader?.name ?? file.uploadedBy?.name ?? "-"}</Typography.Text>
                <Typography.Text type="secondary">{formatTime(file.uploadedAt)}</Typography.Text>
                <Tag color={file.isDeleted ? "default" : "green"}>{file.isDeleted ? "已删除" : "正常"}</Tag>
                <Button icon={<EyeOutlined />} onClick={() => openPreview(file)} size="small">
                  预览
                </Button>
                {file.canDelete ? (
                  <Button danger icon={<DeleteOutlined />} onClick={() => setDeleteTarget(file)} size="small">
                    删除
                  </Button>
                ) : null}
              </Space>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">暂无文件</Typography.Text>
        ),
      title: "已上传文件",
      width: 460
    },
    {
      dataIndex: "reviewStatus",
      render: (value: string) => (
        <Tag color={materialStatusColors[value] ?? "default"}>
          {labelOf(MATERIAL_STATUS_LABELS, value)}
        </Tag>
      ),
      title: "资料审核状态",
      width: 130
    },
    { dataIndex: "reviewComment", title: "审核意见", width: 180 },
    { dataIndex: "reviewer", render: (value?: UserRef | null) => value?.name ?? "-", title: "审核人", width: 100 },
    { dataIndex: "reviewedAt", render: formatTime, title: "审核时间", width: 150 },
    {
      render: (_, record) => (
        <Space wrap>
          {record.canUpload ? (
            <Button icon={<UploadOutlined />} onClick={() => openUploadModal(record.materialType)} size="small">
              上传文件
            </Button>
          ) : null}
          {record.canReview ? (
            <>
              <Button onClick={() => openMaterialReviewModal(record, "APPROVED")} size="small">
                通过
              </Button>
              <Button onClick={() => openMaterialReviewModal(record, "NEED_MORE_INFO")} size="small">
                补充资料
              </Button>
              <Button danger onClick={() => openMaterialReviewModal(record, "REJECTED")} size="small">
                不通过
              </Button>
            </>
          ) : null}
          {!record.canUpload && !record.canReview ? "-" : null}
        </Space>
      ),
      title: "操作",
      width: 260
    }
  ];

  const actionColumns: ColumnsType<ApplicationActionLog> = [
    { dataIndex: "createdAt", render: formatTime, title: "操作时间", width: 150 },
    {
      dataIndex: "operator",
      render: (value?: UserRef | null, record?: ApplicationActionLog) =>
        value?.name ?? record?.operatorName ?? "-",
      title: "操作人",
      width: 110
    },
    { dataIndex: "actionType", title: "操作类型", width: 170 },
    {
      dataIndex: "fromStatus",
      render: (value?: string | null) => labelOf(STATUS_LABELS, value),
      title: "操作前状态",
      width: 120
    },
    {
      dataIndex: "toStatus",
      render: (value?: string | null) => labelOf(STATUS_LABELS, value),
      title: "操作后状态",
      width: 120
    },
    { dataIndex: "comment", title: "操作理由 / 评论", width: 260 },
    {
      render: (_, record) =>
        record.materialFile?.fileName ??
        record.materialGroup?.materialName ??
        record.material?.materialName ??
        "-",
      title: "备注",
      width: 160
    }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={20} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/applications")} />
            <Typography.Title level={4} style={{ margin: 0 }}>
              {detail?.applicationNo ?? "进件详情"}
            </Typography.Title>
            {detail ? (
              <Tag color={applicationStatusColors[detail.status] ?? "default"}>
                {labelOf(STATUS_LABELS, detail.status)}
              </Tag>
            ) : null}
          </Space>
          {detail ? (
            <Space wrap>
              {availableActions.has("uploadMaterial") ? (
                <Button icon={<UploadOutlined />} onClick={() => openUploadModal()}>
                  上传资料
                </Button>
              ) : null}
              {availableActions.has("createQuote") ? (
                <Button onClick={openQuoteModal} type="primary">
                  生成订阅报价
                </Button>
              ) : null}
              {availableActions.has("submit") ? (
                <Button onClick={() => openActionModal("submit")} type="primary">
                  提交
                </Button>
              ) : null}
              {availableActions.has("approve") ? (
                <Button onClick={() => openActionModal("approve")} type="primary">
                  通过
                </Button>
              ) : null}
              {availableActions.has("needMoreInfo") ? (
                <Button onClick={() => openActionModal("need-more-info")}>补件</Button>
              ) : null}
              {availableActions.has("reject") ? (
                <Button danger onClick={() => openActionModal("reject")}>
                  拒绝
                </Button>
              ) : null}
            </Space>
          ) : null}
        </Space>

        {loading ? (
          <Spin />
        ) : detail ? (
          <Space orientation="vertical" size={24} style={{ width: "100%" }}>
            <section>
              <Typography.Title level={5}>基础信息</Typography.Title>
              <Descriptions
                bordered
                column={3}
                items={[
                  { label: "进件编号", children: detail.applicationNo },
                  { label: "当前状态", children: <Tag>{detail.status}</Tag> },
                  { label: "客户姓名", children: detail.customer.name },
                  { label: "手机号", children: detail.customer.mobile },
                  { label: "意向车型", children: detail.intendedModel ?? "-" },
                  { label: "意向订阅周期", children: detail.intendedPeriodMonths ? `${detail.intendedPeriodMonths} 个月` : "-" },
                  { label: "来源渠道", children: detail.customer.sourceChannel ?? "-" },
                  { label: "所属销售", children: detail.salesUser?.name ?? "-" },
                  { label: "提交时间", children: formatTime(detail.submittedAt) },
                  { label: "审批时间", children: formatTime(detail.approvedAt) },
                  { label: "创建时间", children: formatTime(detail.createdAt) },
                  { label: "风控结果", children: detail.riskResult ? `${detail.riskResult.grade} / ${formatYuan(detail.riskResult.approvedDepositAmount)}` : "-" }
                ]}
              />
            </section>

            <section>
              <Typography.Title level={5}>客户资料</Typography.Title>
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "身份证号", children: detail.customer.identity?.idCardNo ?? "-" },
                  { label: "驾驶证号", children: detail.customer.identity?.driverLicenseNo ?? "-" },
                  { label: "驾驶证有效期", children: detail.customer.identity?.licenseValidUntil ? dayjs(detail.customer.identity.licenseValidUntil).format("YYYY-MM-DD") : "-" },
                  { label: "实名状态", children: detail.customer.identity?.realnameVerified ? "已实名" : "未实名" },
                  { label: "职业", children: detail.customer.profile?.occupation ?? "-" },
                  { label: "工作单位", children: detail.customer.profile?.companyName ?? "-" },
                  { label: "月收入", children: formatYuan(detail.customer.profile?.monthlyIncomeAmount) },
                  { label: "居住地址", children: detail.customer.profile?.residenceAddress ?? "-" },
                  { label: "紧急联系人", children: detail.customer.profile?.emergencyContactName ?? "-" },
                  { label: "紧急联系人电话", children: detail.customer.profile?.emergencyContactMobile ?? "-" }
                ]}
              />
            </section>

            <section>
              <Typography.Title level={5}>资料清单</Typography.Title>
              <Table
                columns={materialColumns}
                dataSource={detail.materials}
                pagination={false}
                rowKey="materialGroupId"
                scroll={{ x: 1500 }}
              />
            </section>

            <section>
              <Typography.Title level={5}>审批记录 / 操作历史</Typography.Title>
              <Table
                columns={actionColumns}
                dataSource={detail.actionLogs}
                pagination={false}
                rowKey="id"
                scroll={{ x: 1200 }}
              />
            </section>
          </Space>
        ) : null}
      </Space>

      <Modal
        confirmLoading={submitting}
        okText="上传"
        onCancel={closeUploadModal}
        onOk={() => materialForm.submit()}
        open={uploadOpen}
        title="上传进件资料"
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
              beforeUpload={() => false}
              fileList={materialFileList}
              multiple
              onChange={({ fileList }) => setMaterialFileList(fileList)}
            >
              <Button icon={<UploadOutlined />}>选择文件</Button>
            </Upload>
          </Form.Item>
          <Form.Item label="备注" name="reviewRemark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        confirmLoading={submitting}
        okText="确认"
        onCancel={closeActionModal}
        onOk={() => actionForm.submit()}
        open={Boolean(actionType)}
        title={actionTitle(actionType)}
      >
        <Form<ApplicationActionValues> form={actionForm} layout="vertical" onFinish={submitAction}>
          {actionType === "approve" ? (
            <>
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
            </>
          ) : null}
          <Form.Item
            label="评论"
            name="comment"
            rules={[{ required: actionType === "need-more-info" || actionType === "reject" }]}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        confirmLoading={submitting}
        okText="保存"
        onCancel={closeMaterialReviewModal}
        onOk={() => materialReviewForm.submit()}
        open={Boolean(materialReviewTarget)}
        title="资料审核"
      >
        <Form<MaterialReviewValues>
          form={materialReviewForm}
          layout="vertical"
          onFinish={reviewMaterial}
        >
          <Form.Item
            label="审核意见"
            name="comment"
            rules={[{ required: materialReviewStatus !== "APPROVED" }]}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        confirmLoading={submitting}
        okText="删除"
        okButtonProps={{ danger: true }}
        onCancel={closeDeleteModal}
        onOk={() => deleteFileForm.submit()}
        open={Boolean(deleteTarget)}
        title="删除资料文件"
      >
        <Form<DeleteFileValues> form={deleteFileForm} layout="vertical" onFinish={deleteMaterialFile}>
          <Typography.Paragraph>
            {deleteTarget ? `确认删除文件：${deleteTarget.fileName}` : ""}
          </Typography.Paragraph>
          <Form.Item label="删除原因" name="reason" rules={[{ required: true }]}>
            <Input.TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        confirmLoading={submitting}
        okText="生成订阅报价"
        onCancel={() => {
          setQuoteOpen(false);
          setAvailablePlans([]);
          setAvailableVehicles([]);
        }}
        onOk={() => quoteForm.submit()}
        open={quoteOpen}
        title="生成订阅报价"
      >
        <Form<QuoteValues> form={quoteForm} layout="vertical" onFinish={createQuote}>
          <Space orientation="vertical" size={4} style={{ marginBottom: 12 }}>
            <Typography.Text>客户等级：{detail?.riskResult?.grade ?? "-"}</Typography.Text>
            <Typography.Text>押金：{formatYuan(detail?.riskResult?.approvedDepositAmount)}</Typography.Text>
            <Typography.Text>违约率：{detail?.riskResult?.defaultRate === undefined ? "-" : `${(detail.riskResult.defaultRate * 100).toFixed(2)}%`}</Typography.Text>
            <Typography.Text>车辆：{selectedQuoteVehicle ? `${selectedQuoteVehicle.vehicleNo} / ${selectedQuoteVehicle.plateNo ?? selectedQuoteVehicle.vin ?? "-"}` : "-"}</Typography.Text>
            <Typography.Text>VIN：{selectedQuoteVehicle?.vin ?? "-"}</Typography.Text>
            <Typography.Text>车牌号：{selectedQuoteVehicle?.plateNo ?? "-"}</Typography.Text>
            <Typography.Text>车型：{selectedQuoteVehicle?.vehicleModel ?? selectedQuotePlan?.vehicleModel ?? "-"}</Typography.Text>
            <Typography.Text>当前车辆销售价：{formatYuan(selectedQuoteVehicle?.currentSalePriceAmount)}</Typography.Text>
            <Typography.Text>当前里程：{selectedQuoteVehicle ? `${selectedQuoteVehicle.currentMileageKm} km` : "-"}</Typography.Text>
            <Typography.Text>资产位置：{selectedQuoteVehicle?.assetLocation ?? "-"}</Typography.Text>
            <Typography.Text>状态：{selectedQuoteVehicle?.status ?? "-"}</Typography.Text>
            <Typography.Text>产品：{selectedQuotePlan ? `${selectedQuotePlan.productName} / ${selectedQuotePlan.versionNo}` : "-"}</Typography.Text>
            <Typography.Text>
              车型包系数：{selectedQuotePlan ? `${(selectedQuotePlan.monthlyFeeRate * 100).toFixed(2)}%` : "-"}
            </Typography.Text>
            <Typography.Text>
              车辆基础费上限：{quoteVehicleBaseFeeCap === null ? "-" : formatYuan(quoteVehicleBaseFeeCap)}
            </Typography.Text>
            <Typography.Text>
              周期范围：{selectedQuotePlan ? `${selectedQuotePlan.minPeriodMonths} - ${selectedQuotePlan.maxPeriodMonths} 个月` : "-"}
            </Typography.Text>
            <Typography.Text>
              里程/补能：{selectedQuotePlan ? `${selectedQuotePlan.monthlyMileageKm} km/月，${selectedQuotePlan.monthlyEnergyKwh ?? "-"} kWh，${selectedQuotePlan.monthlyEnergyCount ?? "-"} 次` : "-"}
            </Typography.Text>
            <Typography.Text>里程包价格：{formatYuan(quoteMileagePackagePriceAmount)}</Typography.Text>
            <Typography.Text>补能包价格：{formatYuan(quoteEnergyPackagePriceAmount)}</Typography.Text>
            <Typography.Text>权益包价格：{formatYuan(quoteBenefitPackagePriceAmount)}</Typography.Text>
            <Typography.Text>套餐总价：{formatYuan(quotePackageMonthlyFeeAmount)}</Typography.Text>
            <Typography.Text>权益：{selectedQuotePlan?.benefitDescription ?? "-"}</Typography.Text>
            {periodOutOfRange ? (
              <Typography.Text type="danger">订阅周期不在套餐允许范围内</Typography.Text>
            ) : null}
            {quoteVehicleBaseFeeCap !== null && quoteVehicleBaseFeeAmount > quoteVehicleBaseFeeCap ? (
              <Typography.Text type="danger">车辆基础费超过车型包系数允许上限</Typography.Text>
            ) : null}
          </Space>
          <Form.Item label="选择车辆" name="vehicleId" rules={[{ required: true, message: "请选择车辆" }]}>
            <Select
              onChange={changeQuoteVehicle}
              options={availableVehicles.map((vehicle) => ({
                label: `${vehicle.vehicleNo} / ${vehicle.plateNo ?? vehicle.vin ?? "-"} / ${vehicle.vehicleModel ?? "-"}`,
                value: vehicle.vehicleId ?? vehicle.id
              }))}
            />
          </Form.Item>
          <Form.Item label="订阅套餐" name="subscriptionPlanId" rules={[{ required: true, message: "请选择订阅套餐" }]}>
            <Select
              options={availablePlans.map((plan) => ({
                label: `${plan.planNo} / ${plan.planName} / ${plan.productName} / ${plan.versionNo}`,
                value: plan.subscriptionPlanId
              }))}
            />
          </Form.Item>
          <Form.Item label="车辆基础费报价（元）" name="vehicleBaseFeeAmountYuan" rules={[{ required: true, message: "请输入车辆基础费报价" }]}>
            <InputNumber min={0} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="订阅周期（月）" name="periodMonths" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>
    </ProtectedShell>
  );
}

function actionTitle(actionType: "approve" | "need-more-info" | "reject" | "submit" | null) {
  if (actionType === "approve") {
    return "审批通过";
  }
  if (actionType === "need-more-info") {
    return "要求补件";
  }
  if (actionType === "reject") {
    return "审批拒绝";
  }
  return "提交进件";
}
