import type {
  FieldHandoverEvidenceItem,
  FieldHandoverEvidenceProgress,
  FieldHandoverFieldFacts,
  FieldHandoverWorkOrderDetail,
  FieldHandoverWorkOrderListItem,
  UpdateFieldHandoverFactsInput
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

export interface FieldHandoverEvidenceItemView {
  allowsMultiple: boolean;
  description: string;
  evidenceType: string;
  fileCountText: string;
  files: FieldHandoverEvidenceFileView[];
  id: string;
  isActive: boolean;
  rejectionReason: string;
  requiredText: string;
  showDeclarationComplete: boolean;
  showUpload: boolean;
  statusLabel: string;
  title: string;
  uploadAccept: string;
  uploadLabel: string;
}

export interface FieldHandoverEvidenceFileView {
  displayName: string;
  downloadUrl: string | null;
  evidenceFileId: string;
  mediaType: string;
  previewUrl: string | null;
  sizeText: string;
}

export interface FieldEvidenceCaptureView {
  canEdit: boolean;
  damageStateLabel: string;
  evidenceItems: FieldHandoverEvidenceItemView[];
  fieldFactsStatus: string;
  lockedMessage: string | null;
  nextStepText: string;
  progressText: string;
  showSaveAction: boolean;
  showStartAction: boolean;
  showSubmitAction: boolean;
  submitBlockers: string[];
}

export interface FieldHandoverFactsDraft {
  accessoryChecklistText?: string | null;
  damageDeclared?: boolean | null;
  deliveryLocation?: string | null;
  energyLevelText?: string | null;
  fieldNotes?: string | null;
  fuelLevelText?: string | null;
  handoverMileageKm?: number | null;
  noVisibleDamageDeclared?: boolean | null;
  scheduledAt?: string | null;
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

const LOCKED_WORK_ORDER_STATUSES = new Set([
  "CUSTOMER_OBJECTED",
  "CUSTOMER_REVIEWING",
  "CUSTOMER_CONFIRMED",
  "CUSTOMER_SIGNED",
  "PLATFORM_SEALED",
  "FIELD_COMPLETED",
  "OPS_REVIEW_PENDING",
  "OPS_REVIEWED",
  "VOIDED",
  "FAILED",
  "CANCELLED"
]);

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
    nextStepText: "下一步：提交后等待客户确认"
  };
}

export function buildFieldEvidenceCaptureView(detail: FieldHandoverWorkOrderDetail): FieldEvidenceCaptureView {
  const canEdit = canEditFieldEvidence(detail);
  const evidenceItems = (detail.evidenceChecklist?.items ?? []).map((item) => buildEvidenceItemView(item, detail, canEdit));
  const activeEvidenceItems = evidenceItems.filter((item) => item.isActive);
  const completed = activeEvidenceItems.filter(isEvidenceItemComplete).length;
  const submitBlockers = getFieldHandoverSubmitBlockers(detail);

  return {
    canEdit,
    damageStateLabel: `损伤状态：${formatDamageState(detail.fieldFacts)}`,
    evidenceItems,
    fieldFactsStatus: submitBlockers.some((reason) => FIELD_FACT_BLOCKER_MESSAGES.has(reason)) ? "现场信息：待补充" : "现场信息：已完整",
    lockedMessage: canEdit ? null : formatFieldLockedMessage(detail),
    nextStepText: formatFieldNextStepText(detail),
    progressText: `资料完成度：${completed} / ${activeEvidenceItems.length}`,
    showSaveAction: canEdit,
    showStartAction: canEdit && detail.status !== "FIELD_IN_PROGRESS" && detail.status !== "CUSTOMER_OBJECTED",
    showSubmitAction: canEdit,
    submitBlockers
  };
}

function canEditFieldEvidence(detail: FieldHandoverWorkOrderDetail) {
  if (detail.status === "CUSTOMER_OBJECTED") {
    return detail.fieldResubmissionRequested === true;
  }
  return !LOCKED_WORK_ORDER_STATUSES.has(String(detail.status ?? ""));
}

function formatFieldLockedMessage(detail: FieldHandoverWorkOrderDetail) {
  if (detail.status === "CUSTOMER_OBJECTED" && detail.adminReviewStatus === "RESUBMITTED_PENDING_ADMIN") {
    return "现场交接资料已重新提交，等待后台送回客户复核";
  }
  if (detail.status === "CUSTOMER_OBJECTED") {
    return "客户已提交异议，等待后台介入处理";
  }
  return "当前交接任务已提交或不可继续编辑";
}

function formatFieldNextStepText(detail: FieldHandoverWorkOrderDetail) {
  if (detail.status === "CUSTOMER_OBJECTED" && detail.fieldResubmissionRequested === true) {
    return "下一步：按后台要求补充资料后重新提交";
  }
  if (detail.status === "CUSTOMER_OBJECTED" && detail.adminReviewStatus === "RESUBMITTED_PENDING_ADMIN") {
    return "现场资料已重新提交，等待后台送回客户复核";
  }
  return "下一步：提交后等待客户确认";
}

export function validateFieldHandoverFactsInput(
  input: FieldHandoverFactsDraft,
  options: { requireComplete?: boolean } = {}
) {
  const errors: string[] = [];
  if (options.requireComplete || input.handoverMileageKm !== null && input.handoverMileageKm !== undefined) {
    if (typeof input.handoverMileageKm !== "number" || !Number.isFinite(input.handoverMileageKm) || input.handoverMileageKm <= 0) {
      errors.push("请填写交接里程");
    }
  }
  if (options.requireComplete && !normalizeText(input.energyLevelText) && !normalizeText(input.fuelLevelText)) {
    errors.push("请填写能源/油量状态");
  }
  if (options.requireComplete && !normalizeText(input.accessoryChecklistText)) {
    errors.push("请填写随车物品清单");
  }
  if (input.damageDeclared === true && input.noVisibleDamageDeclared === true) {
    errors.push("损伤状态冲突，请选择存在损伤或无可见损伤");
  } else if (options.requireComplete && input.damageDeclared !== true && input.noVisibleDamageDeclared !== true) {
    errors.push("请先声明是否存在损伤/瑕疵");
  }
  return errors;
}

export function getFieldHandoverSubmitBlockers(
  detail: FieldHandoverWorkOrderDetail,
  draft: FieldHandoverFactsDraft = fieldFactsToDraft(detail.fieldFacts)
) {
  const blockers = [...validateFieldHandoverFactsInput(draft, { requireComplete: true })];
  if (draft.damageDeclared === true && !hasDamageCloseupFile(detail.evidenceChecklist?.items ?? [])) {
    blockers.push("请上传损伤/瑕疵近拍");
  }
  for (const reason of detail.evidenceChecklist?.blockingReasons ?? []) {
    const normalized = normalizeText(reason);
    if (normalized && !blockers.includes(normalized)) {
      blockers.push(normalized);
    }
  }
  return blockers;
}

export function buildFieldHandoverFactsPayload(input: FieldHandoverFactsDraft): UpdateFieldHandoverFactsInput {
  return {
    accessoryChecklist: parseAccessoryChecklist(input.accessoryChecklistText),
    damageDeclared: input.damageDeclared ?? null,
    deliveryLocation: normalizeText(input.deliveryLocation) || null,
    energyLevelText: normalizeText(input.energyLevelText) || null,
    fieldNotes: normalizeText(input.fieldNotes) || null,
    fuelLevelText: normalizeText(input.fuelLevelText) || null,
    handoverMileageKm: input.handoverMileageKm ?? null,
    noVisibleDamageDeclared: input.noVisibleDamageDeclared ?? null,
    scheduledAt: normalizeText(input.scheduledAt) || null
  };
}

export function fieldFactsToDraft(fieldFacts: FieldHandoverFieldFacts | null | undefined): FieldHandoverFactsDraft {
  return {
    accessoryChecklistText: formatAccessoryChecklist(fieldFacts?.accessoryChecklist),
    damageDeclared: fieldFacts?.damageDeclared ?? null,
    deliveryLocation: fieldFacts?.deliveryLocation ?? null,
    energyLevelText: fieldFacts?.energyLevelText ?? null,
    fieldNotes: fieldFacts?.fieldNotes ?? null,
    fuelLevelText: fieldFacts?.fuelLevelText ?? null,
    handoverMileageKm: fieldFacts?.handoverMileageKm ?? null,
    noVisibleDamageDeclared: fieldFacts?.noVisibleDamageDeclared ?? null,
    scheduledAt: fieldFacts?.scheduledAt ?? null
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

const FIELD_FACT_BLOCKER_MESSAGES = new Set([
  "请填写交接里程",
  "请填写能源/油量状态",
  "请填写随车物品清单",
  "损伤状态冲突，请选择存在损伤或无可见损伤",
  "请先声明是否存在损伤/瑕疵"
]);

function buildEvidenceItemView(
  item: FieldHandoverEvidenceItem,
  detail: FieldHandoverWorkOrderDetail,
  canEdit: boolean
): FieldHandoverEvidenceItemView {
  const evidenceType = item.evidenceType ?? "";
  const active = isEvidenceItemActive(item, detail.fieldFacts);
  const fileRequired = item.fileRequired !== false && evidenceType !== "NO_VISIBLE_DAMAGE_DECLARATION";
  const showDeclarationComplete = evidenceType === "NO_VISIBLE_DAMAGE_DECLARATION" &&
    (item.declaredNoDamage === true || detail.fieldFacts?.noVisibleDamageDeclared === true);
  const files = (item.files ?? []).map((file) => ({
    displayName: file.displayName || file.file?.originalName || "现场资料",
    downloadUrl: file.downloadUrl ?? null,
    evidenceFileId: file.evidenceFileId || file.id || "",
    mediaType: file.mediaType || "",
    previewUrl: file.previewUrl ?? null,
    sizeText: formatFileSize(file.sizeBytes ?? file.file?.sizeBytes)
  })).filter((file) => Boolean(file.evidenceFileId));
  const allowsMultiple = item.allowsMultiple === true;

  return {
    allowsMultiple,
    description: item.description ?? "",
    evidenceType,
    fileCountText: `${getEvidenceFileCount(item)} 个文件`,
    files,
    id: item.id ?? "",
    isActive: active,
    rejectionReason: item.rejectionReason ?? "",
    requiredText: item.isRequired ? "必传" : item.isConditional ? "条件必传" : "选填",
    showDeclarationComplete,
    showUpload: canEdit && active && fileRequired && Boolean(item.id),
    statusLabel: formatEvidenceStatus(item, showDeclarationComplete),
    title: item.title ?? "现场资料",
    uploadAccept: formatUploadAccept(item.allowedMediaTypes ?? []),
    uploadLabel: allowsMultiple ? "继续添加" : files.length > 0 ? "替换资料" : "上传资料"
  };
}

function isEvidenceItemActive(item: FieldHandoverEvidenceItem, fieldFacts: FieldHandoverFieldFacts | null | undefined) {
  if (item.evidenceType === "DAMAGE_STATIC_CLOSEUP") {
    return fieldFacts?.damageDeclared === true;
  }
  if (item.evidenceType === "NO_VISIBLE_DAMAGE_DECLARATION") {
    return fieldFacts?.noVisibleDamageDeclared === true;
  }
  return item.isRequired === true || item.isConditional !== true;
}

function isEvidenceItemComplete(item: FieldHandoverEvidenceItemView) {
  return ["已上传", "已通过", "声明已完成"].includes(item.statusLabel);
}

function hasDamageCloseupFile(items: FieldHandoverEvidenceItem[]) {
  return items.some((item) =>
    item.evidenceType === "DAMAGE_STATIC_CLOSEUP" && getEvidenceFileCount(item) > 0
  );
}

function formatEvidenceStatus(item: FieldHandoverEvidenceItem, declarationComplete: boolean) {
  if (declarationComplete) {
    return "声明已完成";
  }
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

function formatUploadAccept(mediaTypes: string[]) {
  const accepts = new Set<string>();
  if (mediaTypes.includes("PHOTO")) {
    accepts.add("image/*");
  }
  if (mediaTypes.includes("VIDEO")) {
    accepts.add("video/*");
  }
  return [...accepts].join(",");
}

function getEvidenceFileCount(item: FieldHandoverEvidenceItem) {
  if (typeof item.fileCount === "number") {
    return item.fileCount;
  }
  return item.files?.length ?? 0;
}

function formatDamageState(fieldFacts: FieldHandoverFieldFacts | null | undefined) {
  if (fieldFacts?.damageDeclared === true) {
    return "有损伤/瑕疵";
  }
  if (fieldFacts?.noVisibleDamageDeclared === true) {
    return "无可见损伤";
  }
  return "未声明";
}

function parseAccessoryChecklist(value: string | null | undefined) {
  const lines = normalizeText(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return {};
  }
  return Object.fromEntries(lines.map((line, index) => [`item${index + 1}`, line]));
}

function formatAccessoryChecklist(value: unknown) {
  if (!value) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(String).join("\n");
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(String).join("\n");
  }
  return String(value);
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

function formatFileSize(value: null | number | string | undefined) {
  const bytes = typeof value === "string" ? Number(value) : value;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "-";
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeText(value: null | string | undefined) {
  return value?.trim() ?? "";
}
