import type {
  PortalHandoverReviewDetail,
  PortalHandoverReviewEvidenceItem,
  PortalHandoverReviewEvidenceProgress,
  PortalHandoverReviewFieldFacts,
  PortalHandoverReviewListItem
} from "./portal-handover-review-api";

export interface PortalHandoverReviewCardView {
  ctaText: string;
  deliveryLocationText: string;
  evidenceText: string;
  fieldSubmittedAtText: string;
  id: string;
  plateText: string;
  scheduledAtText: string;
  statusLabel: string;
  statusTone: "blue" | "green" | "orange" | "red" | "default";
  title: string;
  vehicleText: string;
  vinText: string;
}

export interface PortalHandoverReviewDetailView {
  decision: PortalHandoverReviewDecisionView;
  evidenceItems: PortalHandoverReviewEvidenceItemView[];
  evidenceSummaryText: string;
  fieldFactRows: Array<{ label: string; value: string }>;
  readinessText: string;
  statusLabel: string;
  statusTone: "blue" | "green" | "orange" | "red" | "default";
  summaryRows: Array<{ label: string; value: string }>;
  title: string;
}

export interface PortalHandoverReviewEvidenceItemView {
  fileCountText: string;
  rejectionReason: string;
  requiredText: string;
  statusLabel: string;
  title: string;
}

export type PortalHandoverReviewDecisionView =
  | {
      mode: "ACTIONABLE";
      message: string;
      primaryText: "确认无异议";
      secondaryText: "提交异议";
    }
  | {
      message: string;
      mode: "CONFIRMED";
    }
  | {
      details: string;
      message: string;
      mode: "OBJECTED";
      reason: string;
    }
  | {
      message: string;
      mode: "LOCKED";
    };

const REVIEW_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "不可处理 / 已关闭",
  CUSTOMER_CONFIRMED: "已确认无异议",
  CUSTOMER_OBJECTED: "已提出异议",
  CUSTOMER_REVIEWING: "待确认",
  CUSTOMER_SIGNED: "不可处理 / 已关闭",
  EVIDENCE_SUBMITTED: "待确认",
  FAILED: "不可处理 / 已关闭",
  FIELD_COMPLETED: "不可处理 / 已关闭",
  OPS_REVIEW_PENDING: "不可处理 / 已关闭",
  OPS_REVIEWED: "不可处理 / 已关闭",
  PLATFORM_SEALED: "不可处理 / 已关闭",
  SIGNING: "不可处理 / 已关闭",
  VOIDED: "不可处理 / 已关闭"
};

const ACTIONABLE_REVIEW_STATUSES = new Set(["EVIDENCE_SUBMITTED", "CUSTOMER_REVIEWING"]);
const SENSITIVE_ACCESSORY_KEYS = new Set([
  "bucket",
  "deposit",
  "idcard",
  "idcardno",
  "lease",
  "objectkey",
  "payment",
  "signingurl",
  "token"
]);

export function formatPortalHandoverReviewStatus(value: null | string | undefined) {
  if (!value) {
    return "不可处理 / 已关闭";
  }
  return REVIEW_STATUS_LABELS[value] ?? "不可处理 / 已关闭";
}

export function isPortalHandoverReviewActionable(value: null | string | undefined) {
  return ACTIONABLE_REVIEW_STATUSES.has(String(value ?? ""));
}

export function buildPortalHandoverReviewCard(
  review: PortalHandoverReviewListItem
): PortalHandoverReviewCardView {
  return {
    ctaText: "查看交接资料",
    deliveryLocationText: review.deliveryLocation || "-",
    evidenceText: formatEvidenceProgress(review.evidenceProgress),
    fieldSubmittedAtText: formatDateTime(review.fieldSubmittedAt),
    id: review.id,
    plateText: review.vehicle?.plateMasked || "-",
    scheduledAtText: formatDateTime(review.scheduledAt),
    statusLabel: formatPortalHandoverReviewStatus(review.status),
    statusTone: getStatusTone(review.status),
    title: review.orderNo || "交接确认事项",
    vehicleText: joinVehicleText(review.vehicle?.brand, review.vehicle?.model),
    vinText: review.vehicle?.vinSuffix ? `VIN 后六位 ${review.vehicle.vinSuffix}` : "-"
  };
}

export function buildPortalHandoverReviewDetailView(
  detail: PortalHandoverReviewDetail
): PortalHandoverReviewDetailView {
  const card = buildPortalHandoverReviewCard(detail);
  return {
    decision: buildDecisionView(detail),
    evidenceItems: (detail.evidenceChecklist?.items ?? []).map(buildEvidenceItemView),
    evidenceSummaryText: formatChecklistSummary(detail),
    fieldFactRows: buildFieldFactRows(detail),
    readinessText: formatReadiness(detail),
    statusLabel: card.statusLabel,
    statusTone: card.statusTone,
    summaryRows: [
      { label: "订单编号", value: card.title },
      { label: "交接状态", value: card.statusLabel },
      { label: "车辆", value: card.vehicleText },
      { label: "车牌", value: card.plateText },
      { label: "VIN", value: card.vinText },
      { label: "预约时间", value: card.scheduledAtText },
      { label: "交接地点", value: card.deliveryLocationText },
      { label: "现场提交时间", value: card.fieldSubmittedAtText }
    ],
    title: "车辆交接资料确认"
  };
}

export function validatePortalHandoverObjectionReason(value: string) {
  return value.trim() ? null : "请填写异议原因";
}

function buildFieldFactRows(detail: PortalHandoverReviewDetail) {
  const facts = detail.fieldFacts;
  return [
    { label: "交接里程", value: formatMileage(facts?.handoverMileageKm) },
    { label: "能源/油量", value: joinNonEmpty([facts?.energyLevelText, facts?.fuelLevelText]) || "-" },
    { label: "随车物品", value: formatAccessoryChecklist(facts?.accessoryChecklist) },
    { label: "损伤情况", value: formatDamageState(facts) },
    { label: "现场备注", value: facts?.fieldNotes || "-" },
    { label: "现场提交时间", value: formatDateTime(facts?.fieldSubmittedAt ?? detail.fieldSubmittedAt) }
  ];
}

function buildDecisionView(detail: PortalHandoverReviewDetail): PortalHandoverReviewDecisionView {
  if (isPortalHandoverReviewActionable(detail.status)) {
    return {
      message: "请核对交接资料后选择确认无异议或提出异议。",
      mode: "ACTIONABLE",
      primaryText: "确认无异议",
      secondaryText: "提交异议"
    };
  }
  if (detail.status === "CUSTOMER_CONFIRMED") {
    return {
      message: "您已确认无异议，后续将进入车辆交接确认单签署流程",
      mode: "CONFIRMED"
    };
  }
  if (detail.status === "CUSTOMER_OBJECTED") {
    return {
      details: detail.objection?.details ?? "",
      message: "您已提交异议，工作人员将联系您处理",
      mode: "OBJECTED",
      reason: detail.objection?.reason ?? "-"
    };
  }
  return {
    message: "当前交接确认事项暂不可处理，如有疑问请联系工作人员。",
    mode: "LOCKED"
  };
}

function buildEvidenceItemView(item: PortalHandoverReviewEvidenceItem): PortalHandoverReviewEvidenceItemView {
  return {
    fileCountText: `${getEvidenceFileCount(item)} 个文件`,
    rejectionReason: item.rejectionReason ?? "",
    requiredText: item.isRequired ? "必传" : item.isConditional ? "条件必传" : "选填",
    statusLabel: formatEvidenceStatus(item),
    title: item.title || "现场资料"
  };
}

function getStatusTone(value: null | string | undefined) {
  if (value === "CUSTOMER_CONFIRMED") {
    return "green";
  }
  if (value === "CUSTOMER_OBJECTED") {
    return "red";
  }
  if (isPortalHandoverReviewActionable(value)) {
    return "orange";
  }
  return "default";
}

function formatEvidenceProgress(progress: PortalHandoverReviewEvidenceProgress | null | undefined) {
  if (!progress) {
    return "资料 -";
  }
  return `资料 ${numberOrZero(progress.uploaded)}/${numberOrZero(progress.total)}，必传 ${numberOrZero(progress.required)}，已通过 ${numberOrZero(progress.approved)}`;
}

function formatChecklistSummary(detail: PortalHandoverReviewDetail) {
  const items = detail.evidenceChecklist?.items ?? [];
  if (items.length === 0) {
    return "暂无资料清单";
  }
  const uploaded = items.filter((item) => getEvidenceFileCount(item) > 0 || item.status === "APPROVED").length;
  const required = items.filter((item) => item.isRequired === true).length;
  return `已提交 ${uploaded}/${items.length}，必传 ${required}`;
}

function formatEvidenceStatus(item: PortalHandoverReviewEvidenceItem) {
  if (item.reviewStatus === "REJECTED" || item.status === "REJECTED") {
    return "已驳回";
  }
  if (item.reviewStatus === "APPROVED" || item.status === "APPROVED") {
    return "已通过";
  }
  if (getEvidenceFileCount(item) > 0 || item.status === "UPLOADED") {
    return "已上传";
  }
  if (item.reviewStatus === "PENDING" || item.status === "PENDING_REVIEW") {
    return "待复核";
  }
  return "待上传";
}

function getEvidenceFileCount(item: PortalHandoverReviewEvidenceItem) {
  if (typeof item.fileCount === "number" && Number.isFinite(item.fileCount)) {
    return item.fileCount;
  }
  return item.files?.length ?? 0;
}

function formatReadiness(detail: PortalHandoverReviewDetail) {
  if (detail.status === "CUSTOMER_OBJECTED") {
    return "客户已提出异议，后续流程暂停。";
  }
  if (detail.status === "CUSTOMER_CONFIRMED") {
    return "已确认无异议，等待后续车辆交接确认单流程。";
  }
  if (isPortalHandoverReviewActionable(detail.status)) {
    return "等待客户确认交接资料。";
  }
  return "当前状态只读。";
}

function formatDamageState(facts: PortalHandoverReviewFieldFacts | null | undefined) {
  if (facts?.damageDeclared === true) {
    return "有损伤/瑕疵";
  }
  if (facts?.noVisibleDamageDeclared === true) {
    return "无可见损伤";
  }
  return "未声明";
}

function formatAccessoryChecklist(value: unknown) {
  if (!value) {
    return "-";
  }
  if (Array.isArray(value)) {
    const lines = value.map(String).filter(Boolean);
    return lines.length ? lines.join("；") : "-";
  }
  if (typeof value === "object") {
    const lines = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_ACCESSORY_KEYS.has(key.toLowerCase()))
      .map(([key, entry]) => `${key}：${formatAccessoryValue(entry)}`)
      .filter(Boolean);
    return lines.length ? lines.join("；") : "-";
  }
  return String(value);
}

function formatAccessoryValue(value: unknown) {
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }
  return "-";
}

function formatMileage(value: null | number | undefined) {
  return typeof value === "number" ? `${value} km` : "-";
}

function formatDateTime(value: null | string | undefined) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

function joinVehicleText(brand: null | string | undefined, model: null | string | undefined) {
  return [brand?.trim(), model?.trim()].filter((value): value is string => Boolean(value)).join(" ") || "-";
}

function joinNonEmpty(values: Array<null | string | undefined>) {
  return values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)).join(" / ");
}

function numberOrZero(value: null | number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
