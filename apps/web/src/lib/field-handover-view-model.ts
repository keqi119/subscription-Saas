import type {
  FieldHandoverEvidenceProgress,
  FieldHandoverWorkOrderDetail,
  FieldHandoverWorkOrderListItem
} from "./field-handover-api";

export interface FieldHandoverTaskCardView {
  customerText: string;
  deliveryLocationText: string;
  evidenceText: string;
  handoverTypeLabel: string;
  id: string;
  plateText: string;
  scheduledAtText: string;
  statusLabel: string;
  title: string;
  vehicleText: string;
  vinText: string;
}

export interface FieldHandoverDetailView {
  card: FieldHandoverTaskCardView;
  checklistSummary: string;
  fieldFactRows: Array<{ label: string; value: string }>;
  nextStepText: string;
}

const HANDOVER_TYPE_LABELS: Record<string, string> = {
  DELIVERY_OUTBOUND: "交付出库",
  RETURN_INBOUND: "退租入库"
};

const WORK_ORDER_STATUS_LABELS: Record<string, string> = {
  ASSIGNED: "已分配",
  CANCELLED: "已取消",
  CUSTOMER_CONFIRMED: "客户已确认",
  CUSTOMER_OBJECTED: "客户有异议",
  CUSTOMER_REVIEWING: "客户复核中",
  CUSTOMER_SIGNED: "客户已签署",
  DRAFT: "草稿",
  EVIDENCE_SUBMITTED: "资料已提交",
  FAILED: "失败",
  FIELD_COMPLETED: "现场已完成",
  FIELD_IN_PROGRESS: "现场处理中",
  OPS_REVIEW_PENDING: "运营复核中",
  OPS_REVIEWED: "运营已复核",
  PLATFORM_SEALED: "平台已盖章",
  SIGNING: "签署中",
  VOIDED: "已作废"
};

export function formatFieldHandoverType(value: null | string | undefined) {
  if (!value) {
    return "-";
  }
  return HANDOVER_TYPE_LABELS[value] ?? value;
}

export function formatFieldWorkOrderStatus(value: null | string | undefined) {
  if (!value) {
    return "-";
  }
  return WORK_ORDER_STATUS_LABELS[value] ?? value;
}

export function buildFieldHandoverTaskCard(task: FieldHandoverWorkOrderListItem): FieldHandoverTaskCardView {
  return {
    customerText: joinNonEmpty([task.customer?.displayName, task.customer?.mobileMasked]) || "-",
    deliveryLocationText: task.deliveryLocation || "-",
    evidenceText: formatEvidenceProgress(task.evidenceProgress),
    handoverTypeLabel: formatFieldHandoverType(task.handoverType),
    id: task.id,
    plateText: task.vehicle?.plateMasked || "-",
    scheduledAtText: formatDateTime(task.scheduledAt),
    statusLabel: formatFieldWorkOrderStatus(task.status),
    title: task.orderNo || "交接任务",
    vehicleText: joinVehicleText(task.vehicle?.brand, task.vehicle?.model),
    vinText: task.vehicle?.vinSuffix ? `VIN 后六位 ${task.vehicle.vinSuffix}` : "-"
  };
}

export function buildFieldHandoverDetailView(detail: FieldHandoverWorkOrderDetail): FieldHandoverDetailView {
  const fieldFacts = detail.fieldFacts;

  return {
    card: buildFieldHandoverTaskCard(detail),
    checklistSummary: formatChecklistSummary(detail),
    fieldFactRows: [
      { label: "预约时间", value: formatDateTime(fieldFacts?.scheduledAt ?? detail.scheduledAt) },
      { label: "交接地点", value: fieldFacts?.deliveryLocation || detail.deliveryLocation || "-" },
      { label: "交接里程", value: formatMileage(fieldFacts?.handoverMileageKm) },
      { label: "能源/油量", value: joinNonEmpty([fieldFacts?.energyLevelText, fieldFacts?.fuelLevelText]) || "-" },
      { label: "现场备注", value: fieldFacts?.fieldNotes || "-" }
    ],
    nextStepText: "现场资料采集将在下一阶段开放"
  };
}

function formatEvidenceProgress(progress: FieldHandoverEvidenceProgress | null | undefined) {
  if (!progress) {
    return "资料进度 -";
  }

  const uploaded = numberOrZero(progress.uploaded);
  const total = numberOrZero(progress.total);
  const required = numberOrZero(progress.required);
  const approved = numberOrZero(progress.approved);
  return `资料 ${uploaded}/${total}，必传 ${required}，已通过 ${approved}`;
}

function formatChecklistSummary(detail: FieldHandoverWorkOrderDetail) {
  const items = detail.evidenceChecklist?.items ?? [];
  if (items.length === 0) {
    return "暂无资料清单";
  }

  const completed = items.filter((item) =>
    item.status === "APPROVED" || item.reviewStatus === "APPROVED" || numberOrZero(item.fileCount) > 0
  ).length;
  const required = items.filter((item) => item.isRequired === true).length;
  return `已完成 ${completed}/${items.length}，必传 ${required}`;
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

function joinNonEmpty(values: Array<null | string | undefined>) {
  return values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)).join(" / ");
}

function joinVehicleText(brand: null | string | undefined, model: null | string | undefined) {
  return [brand?.trim(), model?.trim()].filter((value): value is string => Boolean(value)).join(" ") || "-";
}

function numberOrZero(value: null | number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
