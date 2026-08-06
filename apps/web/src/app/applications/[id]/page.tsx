"use client";

import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EyeOutlined,
  UploadOutlined
} from "@ant-design/icons";
import {
  Alert,
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
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../../components/action-button";
import { ProtectedShell } from "../../../components/protected-shell";
import { ApplicationJourneyActions } from "../../../components/subscription-journey/application-journey-actions";
import {
  APPLICATION_SOURCE_LABELS,
  DEPOSIT_STATUS_LABELS,
  MATERIAL_STATUS_LABELS,
  PLAN_CONFIRM_STATUS_LABELS,
  REVIEW_STATUS_LABELS,
  STATUS_LABELS,
  VEHICLE_BASE_FEE_MODE_LABELS,
  VEHICLE_BATTERY_USAGE_TYPE_LABELS,
  labelOf
} from "../../../constants/labels";
import {
  API_BASE_URL,
  apiFetch,
  ApiError,
  loadAdminJourneyByApplication
} from "../../../lib/api";
import {
  actionAvailability,
  canCreateOrderFromApplication as getCreateOrderAvailability,
  canFinalizeApplicationPlan as getFinalizePlanAvailability,
  canGenerateApplicationQuote
} from "../../../lib/action-guards";
import {
  formatMoneyCent,
  formatMonths,
  joinText,
  safeText,
  snapshotValue,
  toNumber
} from "../../../lib/application-snapshots";
import type { AuthMeResponse } from "../../../lib/auth";
import type { AdminSubscriptionJourney } from "../../../lib/subscription-journey-view-model";

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
  source?: string;
  sourceLabel?: string;
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
  applicationSource?: string | null;
  approvedAt?: string | null;
  availableActions: string[];
  createdAt: string;
  creditReviewComment?: string | null;
  creditReviewStatus?: string | null;
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
  customerGrade?: string | null;
  customerSelectedSnapshot?: unknown;
  depositRuleId?: string | null;
  depositRuleSnapshot?: unknown;
  depositStatus?: string | null;
  finalDepositAmount?: number | null;
  finalPeriodMonths?: number | null;
  finalPlanConfirmedAt?: string | null;
  finalPlanSnapshot?: unknown;
  finalQuoteSnapshot?: unknown;
  finalSubscriptionPlanId?: string | null;
  finalVehicleBaseFeeAmount?: number | null;
  finalVehicleId?: string | null;
  id: string;
  intentPeriodMonths?: number | null;
  intentSnapshot?: unknown;
  intentSubscriptionPlanId?: string | null;
  intentVehicleBaseFeeAmount?: number | null;
  intentVehicleId?: string | null;
  intendedModel?: string | null;
  intendedPeriodMonths?: number | null;
  materialReviewStatus?: string | null;
  materials: MaterialGroup[];
  orders?: Array<{
    id: string;
    orderNo: string;
    orderStatus: string;
  }>;
  rejectedReason?: string | null;
  riskResult?: {
    approvedAt?: string | null;
    approvedDepositAmount: number;
    defaultRate: number;
    grade: string;
    maxVehiclePurchasePriceAmount?: number | null;
    remark?: string | null;
    score?: number | null;
  } | null;
  salesUser?: UserRef | null;
  softReservationExpiresAt?: string | null;
  softReservedAt?: string | null;
  softReservedVehicleId?: string | null;
  status: string;
  submittedAt?: string | null;
  planConfirmStatus?: string | null;
  productReviewStatus?: string | null;
  vehicleReviewStatus?: string | null;
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

interface CreateOrderResult {
  applicationId: string;
  orderId: string;
  orderNo: string;
  orderStatus: string;
  quoteId: string;
  quoteNo: string;
  vehicleStatus: string;
}

interface AvailableVehicle {
  assetLocation?: string | null;
  batteryCapacityKwh?: number | null;
  batteryUsageType?: string | null;
  batteryUsageTypeLabel?: string | null;
  brand: string;
  currentMileageKm: number;
  currentSalePriceAmount?: number | null;
  id: string;
  model?: string | null;
  modelCode?: string | null;
  modelDefinitionId?: string | null;
  modelDisplayName?: string | null;
  plateNo?: string | null;
  series?: string | null;
  status: string;
  vehicleId?: string;
  vehicleNo: string;
  vin?: string | null;
}

interface AvailableSubscriptionPlan {
  baseMonthlyFeeAmount?: number | null;
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
  monthlyFeeMode: "FIXED_AMOUNT" | "MANUAL_QUOTE" | "RATE_FORMULA";
  monthlyFeeModeLabel?: string;
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
  modelCode: string;
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

function normalizeVehicleModel(value?: string | null) {
  return value?.trim().toUpperCase() ?? "";
}

function vehicleBaseFeeModeLabel(plan?: AvailableSubscriptionPlan) {
  return plan ? (plan.monthlyFeeModeLabel ?? VEHICLE_BASE_FEE_MODE_LABELS[plan.monthlyFeeMode] ?? plan.monthlyFeeMode) : "-";
}

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

function formatKwh(value?: unknown) {
  const kwh = toNumber(value);
  return kwh === null ? "-" : `${kwh.toLocaleString("zh-CN")} kWh`;
}

function formatBatteryUsageType(type?: unknown, label?: unknown) {
  const labelText = safeText(label);
  if (labelText !== "-") {
    return labelText;
  }
  const typeText = safeText(type);
  return typeText === "-" ? "-" : labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, typeText);
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
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [journey, setJourney] = useState<AdminSubscriptionJourney | null>(null);
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
      const [nextDetail, nextMe] = await Promise.all([
        apiFetch<ApplicationDetail>(`/applications/${applicationId}`),
        apiFetch<AuthMeResponse>("/auth/me")
      ]);
      setDetail(nextDetail);
      setMe(nextMe);
      setLoading(false);
      if (nextMe.user.permissions.includes("subscription_journey:view")) {
        try {
          setJourney(await loadAdminJourneyByApplication(applicationId));
        } catch {
          setJourney(null);
          void message.warning("订阅流程加载失败，原有进件信息仍可继续查看");
        }
      } else {
        setJourney(null);
      }
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
  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me]);
  const isSelfServiceApplication = detail?.applicationSource === "SELF_SERVICE";
  const canReviewApplication = permissions.has("application:review");
  const canCreateOrderChange = permissions.has("order_change:create");
  const currentOrder = detail?.orders?.[0] ?? null;
  const intentSnapshot = detail?.intentSnapshot ?? detail?.customerSelectedSnapshot;
  const finalPlanSnapshot = detail?.finalPlanSnapshot ?? detail?.finalQuoteSnapshot;
  const uploadMaterialAvailability = actionAvailability({
    allowed: availableActions.has("uploadMaterial"),
    disabledReason: "当前进件状态不允许上传资料",
    noPermissionReason: "无上传进件资料权限",
    permission: "application:material_upload",
    permissions
  });
  const createQuoteAvailability = canGenerateApplicationQuote(detail, permissions);
  const submitAvailability = actionAvailability({
    allowed: availableActions.has("submit"),
    disabledReason: "当前进件状态不允许提交",
    permissions
  });
  const approveAvailability = actionAvailability({
    allowed: availableActions.has("approve"),
    disabledReason: "当前进件状态不允许审核",
    noPermissionReason: "无进件审核权限",
    permission: "application:review",
    permissions
  });
  const needMoreInfoAvailability = actionAvailability({
    allowed: availableActions.has("needMoreInfo"),
    disabledReason: "当前进件不需要补件",
    noPermissionReason: "无进件审核权限",
    permission: "application:review",
    permissions
  });
  const rejectAvailability = actionAvailability({
    allowed: availableActions.has("reject"),
    disabledReason: "当前进件状态不允许拒绝",
    noPermissionReason: "无进件审核权限",
    permission: "application:review",
    permissions
  });
  const finalizeApplicationPlanAvailability = getFinalizePlanAvailability(detail, permissions);
  const createOrderFromApplicationAvailability = getCreateOrderAvailability(detail, permissions);
  const selectedQuoteVehicle = availableVehicles.find((vehicle) => (vehicle.vehicleId ?? vehicle.id) === quoteVehicleId);
  const selectedQuotePlan = availablePlans.find((plan) => plan.subscriptionPlanId === quoteSubscriptionPlanId);
  const quotePlanEmptyReason =
    selectedQuoteVehicle && availablePlans.length === 0
      ? `当前所选车辆车型 ${selectedQuoteVehicle.modelDisplayName ?? selectedQuoteVehicle.modelCode ?? "-"} 暂无可报价订阅套餐。请确认该车型套餐已启用，且所属产品和产品版本已激活。`
      : null;
  const quoteVehicleBaseFeeModeDescription =
    selectedQuotePlan?.monthlyFeeMode === "FIXED_AMOUNT"
      ? "该套餐为固定金额，车辆基础月费由产品中心预设。"
      : selectedQuotePlan?.monthlyFeeMode === "RATE_FORMULA"
        ? "该套餐为固定费率，车辆基础月费由当前车辆销售价和费率自动计算。"
        : selectedQuotePlan?.monthlyFeeMode === "MANUAL_QUOTE"
          ? "该套餐允许现场报价，车辆基础费不得超过上限。"
          : null;
  const quoteVehicleBaseFeeEditable = selectedQuotePlan?.monthlyFeeMode === "MANUAL_QUOTE";
  const computedQuoteVehicleBaseFeeAmount =
    selectedQuotePlan?.monthlyFeeMode === "FIXED_AMOUNT"
      ? (selectedQuotePlan.baseMonthlyFeeAmount ?? null)
      : selectedQuotePlan?.monthlyFeeMode === "RATE_FORMULA" && selectedQuoteVehicle?.currentSalePriceAmount
        ? Math.floor(selectedQuoteVehicle.currentSalePriceAmount * selectedQuotePlan.monthlyFeeRate)
        : null;
  const quoteVehicleBaseFeeAmount = quoteVehicleBaseFeeEditable
    ? Math.round(Number(quoteVehicleBaseFeeYuan ?? 0) * 100)
    : (computedQuoteVehicleBaseFeeAmount ?? 0);
  const quoteVehicleBaseFeeCap =
    selectedQuotePlan && selectedQuoteVehicle?.currentSalePriceAmount
      ? Math.floor(selectedQuoteVehicle.currentSalePriceAmount * (selectedQuotePlan.monthlyFeeCapRate ?? selectedQuotePlan.monthlyFeeRate))
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

  useEffect(() => {
    if (!quoteOpen || !selectedQuotePlan || quoteVehicleBaseFeeEditable) {
      return;
    }
    quoteForm.setFieldsValue({
      vehicleBaseFeeAmountYuan:
        computedQuoteVehicleBaseFeeAmount === null ? undefined : computedQuoteVehicleBaseFeeAmount / 100
    });
  }, [
    computedQuoteVehicleBaseFeeAmount,
    quoteForm,
    quoteOpen,
    quoteVehicleBaseFeeEditable,
    selectedQuotePlan
  ]);

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
      const intendedModel = normalizeVehicleModel(detail?.intendedModel);
      const firstVehicle =
        vehicles.find((vehicle) => {
          const canonicalModel = normalizeVehicleModel(
            vehicle.modelDisplayName ?? vehicle.modelCode ?? vehicle.model
          );
          return intendedModel && canonicalModel === intendedModel;
        }) ?? vehicles[0];
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
    const vehicleBaseFeeAmount = Math.round(Number(values.vehicleBaseFeeAmountYuan ?? 0) * 100);
    if (!selectedQuoteVehicle) {
      void message.error("请选择车辆");
      return;
    }
    if (!selectedQuotePlan) {
      void message.error("请选择订阅套餐");
      return;
    }
    if (selectedQuotePlan.monthlyFeeMode === "MANUAL_QUOTE" && vehicleBaseFeeAmount <= 0) {
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
          vehicleBaseFeeAmount: selectedQuotePlan.monthlyFeeMode === "MANUAL_QUOTE" ? vehicleBaseFeeAmount : undefined,
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

  async function finalizeApplicationPlan() {
    if (!detail) {
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch<ApplicationDetail>(`/applications/${detail.id}/finalize-plan`, { method: "POST" });
      void message.success("最终方案已生成，等待客户确认");
      await loadDetail();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function createOrderFromApplication() {
    if (!detail) {
      return;
    }

    setSubmitting(true);
    try {
      const result = await apiFetch<CreateOrderResult>(`/applications/${detail.id}/create-order`, {
        method: "POST"
      });
      void message.success(`正式订单已生成：${result.orderNo}`);
      await loadDetail();
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
                {file.sourceLabel ? <Tag>{file.sourceLabel}</Tag> : null}
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
          <ActionButton
            allowed={record.canUpload}
            disabledReason="当前资料项不可上传"
            icon={<UploadOutlined />}
            onClick={() => openUploadModal(record.materialType)}
            permission="application:material_upload"
            permissions={permissions}
            size="small"
          >
            上传文件
          </ActionButton>
          <ActionButton
            allowed={record.canReview}
            disabledReason="当前资料项不可审核"
            onClick={() => openMaterialReviewModal(record, "APPROVED")}
            permission="application:review"
            permissions={permissions}
            size="small"
          >
            通过
          </ActionButton>
          <ActionButton
            allowed={record.canReview}
            disabledReason="当前资料项不可审核"
            onClick={() => openMaterialReviewModal(record, "NEED_MORE_INFO")}
            permission="application:review"
            permissions={permissions}
            size="small"
          >
            补充资料
          </ActionButton>
          <ActionButton
            allowed={record.canReview}
            danger
            disabledReason="当前资料项不可审核"
            onClick={() => openMaterialReviewModal(record, "REJECTED")}
            permission="application:review"
            permissions={permissions}
            size="small"
          >
            不通过
          </ActionButton>
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
              {currentOrder ? (
                <>
                  <Button onClick={() => router.push(`/orders/${currentOrder.id}`)}>
                    查看订单
                  </Button>
                  {canCreateOrderChange ? (
                    <Button onClick={() => router.push(`/orders/${currentOrder.id}?createChange=1`)}>
                      申请变更方案
                    </Button>
                  ) : null}
                </>
              ) : null}
              <ActionButton
                availability={uploadMaterialAvailability}
                icon={<UploadOutlined />}
                onClick={() => openUploadModal()}
              >
                上传资料
              </ActionButton>
              {!isSelfServiceApplication ? (
                <ActionButton
                  availability={createQuoteAvailability}
                  onClick={openQuoteModal}
                  type="primary"
                >
                  生成订阅报价
                </ActionButton>
              ) : null}
              <ActionButton
                availability={submitAvailability}
                onClick={() => openActionModal("submit")}
                type="primary"
              >
                提交
              </ActionButton>
              <ActionButton
                availability={approveAvailability}
                onClick={() => openActionModal("approve")}
                type="primary"
              >
                通过
              </ActionButton>
              <ActionButton
                availability={needMoreInfoAvailability}
                onClick={() => openActionModal("need-more-info")}
              >
                补件
              </ActionButton>
              <ActionButton
                availability={rejectAvailability}
                danger
                onClick={() => openActionModal("reject")}
              >
                拒绝
              </ActionButton>
              {journey ? null : (
                <ActionButton
                  availability={createOrderFromApplicationAvailability}
                  loading={submitting}
                  onClick={createOrderFromApplication}
                  type="primary"
                >
                  生成正式订单
                </ActionButton>
              )}
            </Space>
          ) : null}
        </Space>

        {loading ? (
          <Spin />
        ) : detail ? (
          <Space orientation="vertical" size={24} style={{ width: "100%" }}>
            {journey ? (
              <ApplicationJourneyActions
                journey={journey}
                onChanged={loadDetail}
                permissions={permissions}
              />
            ) : null}
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

            {isSelfServiceApplication ? (
              <section>
                <Typography.Title level={5}>客户意向选择</Typography.Title>
                <Descriptions
                  bordered
                  column={3}
                  items={[
                    { label: "VIN", children: safeText(snapshotValue(intentSnapshot, "vehicleSnapshot.vin")) },
                    { label: "车牌号", children: safeText(snapshotValue(intentSnapshot, "vehicleSnapshot.plateNo")) },
                    { label: "品牌", children: safeText(snapshotValue(intentSnapshot, "vehicleSnapshot.brand")) },
                    { label: "车系", children: safeText(snapshotValue(intentSnapshot, "vehicleSnapshot.series")) },
                    {
                      label: "车型",
                      children: safeText(
                        snapshotValue(
                          intentSnapshot,
                          "vehicleSnapshot.modelDisplayNameSnapshot",
                          "vehicleSnapshot.model"
                        )
                      )
                    },
                    {
                      label: "电池容量",
                      children: formatKwh(snapshotValue(intentSnapshot, "vehicleSnapshot.batteryCapacityKwh"))
                    },
                    {
                      label: "电池使用方式",
                      children: formatBatteryUsageType(
                        snapshotValue(intentSnapshot, "vehicleSnapshot.batteryUsageType"),
                        snapshotValue(intentSnapshot, "vehicleSnapshot.batteryUsageTypeLabel")
                      )
                    },
                    {
                      label: "当前车辆销售价",
                      children: formatMoneyCent(snapshotValue(intentSnapshot, "vehicleSnapshot.currentSalePriceAmount"))
                    },
                    {
                      label: "车辆状态",
                      children: (
                        <Tag>
                          {labelOf(
                            STATUS_LABELS,
                            safeText(snapshotValue(intentSnapshot, "vehicleSnapshot.status")) === "-"
                              ? "REVIEW_RESERVED"
                              : safeText(snapshotValue(intentSnapshot, "vehicleSnapshot.status"))
                          )}
                        </Tag>
                      )
                    },
                    {
                      label: "套餐名称",
                      children: joinText(
                        snapshotValue(intentSnapshot, "packageSnapshot.subscriptionPlan.planNo"),
                        snapshotValue(intentSnapshot, "packageSnapshot.subscriptionPlan.planName")
                      )
                    },
                    {
                      label: "车辆基础月费模式",
                      children: labelOf(
                        VEHICLE_BASE_FEE_MODE_LABELS,
                        safeText(
                          snapshotValue(
                            intentSnapshot,
                            "packageSnapshot.pricing.vehicleBaseFeeMode",
                            "packageSnapshot.subscriptionPlan.monthlyFeeMode"
                          )
                        )
                      )
                    },
                    {
                      label: "车辆基础费",
                      children: formatMoneyCent(
                        snapshotValue(
                          intentSnapshot,
                          "vehicleBaseFeeAmount",
                          "packageSnapshot.pricing.vehicleBaseFeeAmount"
                        )
                      )
                    },
                    {
                      label: "里程包",
                      children: joinText(
                        snapshotValue(intentSnapshot, "packageSnapshot.mileagePackage.packageName"),
                        formatMoneyCent(snapshotValue(intentSnapshot, "packageSnapshot.pricing.mileagePackagePriceAmount"))
                      )
                    },
                    {
                      label: "补能包",
                      children: joinText(
                        snapshotValue(intentSnapshot, "packageSnapshot.energyPackage.packageName"),
                        formatMoneyCent(snapshotValue(intentSnapshot, "packageSnapshot.pricing.energyPackagePriceAmount"))
                      )
                    },
                    {
                      label: "权益包",
                      children: joinText(
                        snapshotValue(intentSnapshot, "packageSnapshot.benefitPackage.packageName"),
                        formatMoneyCent(snapshotValue(intentSnapshot, "packageSnapshot.pricing.benefitPackagePriceAmount"))
                      )
                    },
                    {
                      label: "套餐月费合计",
                      children: formatMoneyCent(snapshotValue(intentSnapshot, "packageSnapshot.pricing.monthlyFeeAmount"))
                    },
                    {
                      label: "订阅周期",
                      children: formatMonths(snapshotValue(intentSnapshot, "periodMonths") ?? detail.intentPeriodMonths)
                    },
                    {
                      label: "押金",
                      children: labelOf(DEPOSIT_STATUS_LABELS, detail.depositStatus ?? "PENDING_CONFIRM")
                    },
                    {
                      label: "最终押金",
                      children: formatMoneyCent(detail.finalDepositAmount)
                    }
                  ]}
                />
              </section>
            ) : (
              <section>
                <Typography.Title level={5}>销售人工进件说明</Typography.Title>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  B 线销售人工进件继续沿用现有资料上传、资质审批、生成报价、确认报价和创建订单流程；本页仅补充统一审核状态展示，不改变原有报价和订单主流程。
                </Typography.Paragraph>
              </section>
            )}

            <section>
              <Typography.Title level={5}>统一审核面板</Typography.Title>
              <Descriptions
                bordered
                column={3}
                items={[
                  {
                    label: "进件来源",
                    children: labelOf(APPLICATION_SOURCE_LABELS, detail.applicationSource)
                  },
                  {
                    label: "资料审核",
                    children: <Tag>{labelOf(REVIEW_STATUS_LABELS, detail.materialReviewStatus)}</Tag>
                  },
                  {
                    label: "资质审核",
                    children: <Tag>{labelOf(REVIEW_STATUS_LABELS, detail.creditReviewStatus)}</Tag>
                  },
                  {
                    label: "押金状态",
                    children: <Tag>{labelOf(DEPOSIT_STATUS_LABELS, detail.depositStatus)}</Tag>
                  },
                  {
                    label: "最终押金",
                    children: formatMoneyCent(detail.finalDepositAmount)
                  },
                  {
                    label: "产品匹配",
                    children: <Tag>{labelOf(REVIEW_STATUS_LABELS, detail.productReviewStatus)}</Tag>
                  },
                  {
                    label: "车辆库存",
                    children: <Tag>{labelOf(REVIEW_STATUS_LABELS, detail.vehicleReviewStatus)}</Tag>
                  },
                  {
                    label: "最终方案",
                    children: <Tag>{labelOf(PLAN_CONFIRM_STATUS_LABELS, detail.planConfirmStatus)}</Tag>
                  },
                  {
                    label: "生成订单",
                    children: currentOrder ? (
                      <Link href={`/orders/${currentOrder.id}`}>{currentOrder.orderNo}</Link>
                    ) : (
                      "未生成"
                    )
                  }
                ]}
              />
              {canReviewApplication ? (
                <Space orientation="vertical" size={12} style={{ marginTop: 16, width: "100%" }}>
                  <Alert
                    message="自助进件审核已复用人工进件流程"
                    description="资料请在下方资料清单逐项审核；资料不齐使用顶部补件；客户资质 / 授信使用顶部通过并填写评级、评分、车价和押金信息。"
                    showIcon
                    type="info"
                  />
                  <Descriptions
                    bordered
                    column={3}
                    items={[
                      { label: "资料审核", children: "使用资料清单逐项审核" },
                      { label: "客户资质 / 授信", children: "使用顶部通过打开风控审核弹窗" },
                      { label: "产品匹配", children: "生成订阅报价 / 生成最终方案时自动校验" },
                      { label: "车辆库存", children: "生成订阅报价 / 生成最终方案时自动校验审核占用" },
                      { label: "复购简易审核扩展", children: "保留历史评级参考，后续可在有效期内走简易审核通道" },
                      { label: "最终方案确认", children: "后台生成最终方案后，由客户在门户二次确认" }
                    ]}
                  />
                  {isSelfServiceApplication ? (
                    <Alert
                      message="后台按钮仅生成最终方案并进入客户待确认状态；客户确认后，后台才能生成正式订单。"
                      showIcon
                      type="warning"
                    />
                  ) : null}
                  {journey ? null : (
                    <Space wrap>
                      <ActionButton
                        availability={finalizeApplicationPlanAvailability}
                        loading={submitting}
                        onClick={finalizeApplicationPlan}
                        type="primary"
                      >
                        生成最终方案并待客户确认
                      </ActionButton>
                      <ActionButton
                        availability={createOrderFromApplicationAvailability}
                        loading={submitting}
                        onClick={createOrderFromApplication}
                        type="primary"
                      >
                        生成正式订单
                      </ActionButton>
                    </Space>
                  )}
                </Space>
              ) : null}
            </section>

            {finalPlanSnapshot ? (
              <section>
                <Typography.Title level={5}>最终方案</Typography.Title>
                <Descriptions
                  bordered
                  column={3}
                  items={[
                    { label: "客户等级", children: safeText(snapshotValue(finalPlanSnapshot, "customerGrade") ?? detail.customerGrade) },
                    { label: "最终押金", children: formatMoneyCent(snapshotValue(finalPlanSnapshot, "depositAmount") ?? detail.finalDepositAmount) },
                    {
                      label: "最终车辆",
                      children: joinText(
                        snapshotValue(finalPlanSnapshot, "vehicleSnapshot.vehicleNo"),
                        snapshotValue(finalPlanSnapshot, "vehicleSnapshot.plateNo"),
                        snapshotValue(finalPlanSnapshot, "vehicleSnapshot.vin")
                      )
                    },
                    {
                      label: "电池容量",
                      children: formatKwh(snapshotValue(finalPlanSnapshot, "vehicleSnapshot.batteryCapacityKwh"))
                    },
                    {
                      label: "电池使用方式",
                      children: formatBatteryUsageType(
                        snapshotValue(finalPlanSnapshot, "vehicleSnapshot.batteryUsageType"),
                        snapshotValue(finalPlanSnapshot, "vehicleSnapshot.batteryUsageTypeLabel")
                      )
                    },
                    {
                      label: "最终套餐",
                      children: joinText(
                        snapshotValue(finalPlanSnapshot, "subscriptionPlan.planNo"),
                        snapshotValue(finalPlanSnapshot, "subscriptionPlan.planName")
                      )
                    },
                    { label: "最终周期", children: formatMonths(snapshotValue(finalPlanSnapshot, "periodMonths") ?? detail.finalPeriodMonths) },
                    {
                      label: "车辆基础费",
                      children: formatMoneyCent(
                        snapshotValue(finalPlanSnapshot, "vehicleBaseFeeAmount", "pricing.vehicleBaseFeeAmount") ??
                          detail.finalVehicleBaseFeeAmount
                      )
                    },
                    {
                      label: "套餐月费合计",
                      children: formatMoneyCent(snapshotValue(finalPlanSnapshot, "pricing.monthlyFeeAmount"))
                    },
                    { label: "确认状态", children: labelOf(PLAN_CONFIRM_STATUS_LABELS, detail.planConfirmStatus) },
                    { label: "确认时间", children: formatTime(detail.finalPlanConfirmedAt) }
                  ]}
                />
              </section>
            ) : null}

            <section>
              <Typography.Title level={5}>资料清单</Typography.Title>
              {detail.materials.length > 0 ? (
                <Table
                  columns={materialColumns}
                  dataSource={detail.materials}
                  pagination={false}
                  rowKey="materialGroupId"
                  scroll={{ x: 1500 }}
                />
              ) : (
                <Typography.Text type="secondary">客户尚未上传资质材料</Typography.Text>
              )}
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
              {detail?.riskResult ? (
                <Alert
                  message="历史评级参考"
                  description={`最近评级：${detail.riskResult.grade}；历史评分：${detail.riskResult.score ?? "-"}；历史押金：${formatYuan(detail.riskResult.approvedDepositAmount)}；通过时间：${formatTime(detail.riskResult.approvedAt)}`}
                  showIcon
                  type="info"
                />
              ) : null}
              <Typography.Paragraph type="secondary">
                后续可扩展复购简易审核通道：在评级有效期内参考历史评级、评分和押金结果，本轮仅展示参考，不自动覆盖本次风控结论。
              </Typography.Paragraph>
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
            <Typography.Text>车型：{selectedQuoteVehicle?.modelDisplayName ?? selectedQuoteVehicle?.modelCode ?? selectedQuotePlan?.modelCode ?? "-"}</Typography.Text>
            <Typography.Text>电池容量：{formatKwh(selectedQuoteVehicle?.batteryCapacityKwh)}</Typography.Text>
            <Typography.Text>
              电池使用方式：{formatBatteryUsageType(selectedQuoteVehicle?.batteryUsageType, selectedQuoteVehicle?.batteryUsageTypeLabel)}
            </Typography.Text>
            <Typography.Text>当前车辆销售价：{formatYuan(selectedQuoteVehicle?.currentSalePriceAmount)}</Typography.Text>
            <Typography.Text>当前里程：{selectedQuoteVehicle ? `${selectedQuoteVehicle.currentMileageKm} km` : "-"}</Typography.Text>
            <Typography.Text>资产位置：{selectedQuoteVehicle?.assetLocation ?? "-"}</Typography.Text>
            <Typography.Text>状态：{selectedQuoteVehicle?.status ?? "-"}</Typography.Text>
            <Typography.Text>产品：{selectedQuotePlan ? `${selectedQuotePlan.productName} / ${selectedQuotePlan.versionNo}` : "-"}</Typography.Text>
            <Typography.Text>车辆基础月费模式：{vehicleBaseFeeModeLabel(selectedQuotePlan)}</Typography.Text>
            <Typography.Text>
              车型包系数：{selectedQuotePlan ? `${((selectedQuotePlan.monthlyFeeCapRate ?? selectedQuotePlan.monthlyFeeRate) * 100).toFixed(2)}%` : "-"}
            </Typography.Text>
            <Typography.Text>
              固定费率：{selectedQuotePlan?.monthlyFeeMode === "RATE_FORMULA" ? `${(selectedQuotePlan.monthlyFeeRate * 100).toFixed(2)}%` : "-"}
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
            {quoteVehicleBaseFeeModeDescription ? (
              <Typography.Text type={quoteVehicleBaseFeeEditable ? "secondary" : "success"}>
                {quoteVehicleBaseFeeModeDescription}
              </Typography.Text>
            ) : null}
            {periodOutOfRange ? (
              <Typography.Text type="danger">订阅周期不在套餐允许范围内</Typography.Text>
            ) : null}
            {quoteVehicleBaseFeeCap !== null && quoteVehicleBaseFeeAmount > quoteVehicleBaseFeeCap ? (
              <Typography.Text type="danger">车辆基础费超过车型包系数允许上限</Typography.Text>
            ) : null}
            {quotePlanEmptyReason ? <Alert message={quotePlanEmptyReason} showIcon type="warning" /> : null}
          </Space>
          <Form.Item label="选择车辆" name="vehicleId" rules={[{ required: true, message: "请选择车辆" }]}>
            <Select
              onChange={changeQuoteVehicle}
              options={availableVehicles.map((vehicle) => ({
                label: `${vehicle.vehicleNo} / ${vehicle.plateNo ?? vehicle.vin ?? "-"} / ${vehicle.modelDisplayName ?? vehicle.modelCode ?? "-"}`,
                value: vehicle.vehicleId ?? vehicle.id
              }))}
            />
          </Form.Item>
          <Form.Item label="订阅套餐" name="subscriptionPlanId" rules={[{ required: true, message: "请选择订阅套餐" }]}>
            <Select
              notFoundContent={quotePlanEmptyReason ?? "暂无可报价套餐"}
              options={availablePlans.map((plan) => ({
                label: `${plan.planNo} / ${plan.planName} / ${vehicleBaseFeeModeLabel(plan)} / ${plan.productName} / ${plan.versionNo} / ${plan.modelCode}`,
                value: plan.subscriptionPlanId
              }))}
              optionFilterProp="label"
              placeholder="请选择订阅套餐"
              showSearch
            />
          </Form.Item>
          <Form.Item
            label="车辆基础费报价（元）"
            name="vehicleBaseFeeAmountYuan"
            rules={[{ required: quoteVehicleBaseFeeEditable, message: "请输入车辆基础费报价" }]}
          >
            <InputNumber disabled={!quoteVehicleBaseFeeEditable} min={0} precision={2} style={{ width: "100%" }} />
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
