import { ApiError, apiFetch } from "./api";

export interface AdminStage2HandoverESignBlocker {
  code: string;
  message?: string | null;
}

export interface AdminStage2HandoverESignSigner {
  attemptCount: number;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  nextRetryAt: string | null;
  retryAvailable: boolean;
  signedAt: string | null;
  slotId: string;
  status: string | null;
}

export interface AdminStage2HandoverESignStatus {
  archiveStatus: string | null;
  blockers: AdminStage2HandoverESignBlocker[];
  canVoid: boolean;
  createdAt: string | null;
  customerSigner: AdminStage2HandoverESignSigner;
  documentType: "DELIVERY_HANDOVER";
  handoverId: string | null;
  platformSigner: AdminStage2HandoverESignSigner;
  ready: boolean;
  rebuildRequired: boolean;
  signedArtifactAvailable: boolean;
  signingStage: "STAGE2_DELIVERY_HANDOVER";
  status: string | null;
  taskId: string | null;
  updatedAt: string | null;
  workOrderId: string;
}

export interface AdminStage2HandoverSignedDocumentState {
  archiveLastAttemptAt: string | null;
  archiveLastError: string | null;
  archiveRetryCount: number;
  archiveStatus: string | null;
  archivedAt: string | null;
  available: boolean;
  completedAt: string | null;
  handoverId: string | null;
  retryAvailable: boolean;
  taskId: string | null;
  workOrderId: string;
}

export interface AdminStage2HandoverESignDisplayState {
  color?: string;
  detail?: string | null;
  label: string;
}

export interface AdminStage2HandoverESignDisplay {
  archive: AdminStage2HandoverESignDisplayState;
  archiveRetryAvailable: boolean;
  customer: AdminStage2HandoverESignDisplayState;
  platform: AdminStage2HandoverESignDisplayState;
  platformActionLabel: "发起平台盖章" | "重试平台盖章" | null;
  readiness: AdminStage2HandoverESignDisplayState;
  startAvailable: boolean;
  voidAvailable: boolean;
}

const BLOCKER_MESSAGES: Record<string, string> = {
  ACTIVE_ESIGN_TASK_CONFLICT: "已有进行中的电子签任务",
  ADMIN_REVIEW_PENDING: "最新交接资料仍待后台复核",
  CONFIRMED_FIELD_FACTS_MISMATCH: "客户确认未覆盖当前交接信息",
  CONFIRMED_MANIFEST_MISMATCH: "客户确认未覆盖当前证据清单",
  CURRENT_MANIFEST_UNAVAILABLE: "当前证据清单暂不可用",
  CUSTOMER_CERT_NOT_READY: "客户电子签证书尚未就绪",
  CUSTOMER_CONFIRMATION_MISSING: "客户尚未确认交接无异议",
  CUSTOMER_ESIGN_NOT_READY: "客户电子签账户尚未就绪",
  CUSTOMER_OBJECTION_ACTIVE: "客户仍有待处理异议",
  CUSTOMER_READINESS_FRESHNESS_UNCONFIGURED: "客户电子签状态有效期未配置",
  CUSTOMER_READINESS_STALE: "客户电子签状态已过期，请刷新认证状态",
  CUSTOMER_READINESS_TIMESTAMP_INVALID: "客户电子签状态时间无效",
  EVIDENCE_NOT_READY: "交接证据尚未准备完成",
  FIELD_FACTS_INCOMPLETE: "现场交接信息不完整",
  HANDOVER_MISSING: "车辆交接记录不存在",
  HANDOVER_SOURCE_NOT_GENERATED: "交接 PDF 尚未生成",
  LATEST_REVIEW_NOT_CONFIRMED: "最新一次交接复核尚未确认",
  ORDER_MISSING: "订单不存在",
  ORDER_NOT_READY_FOR_DELIVERY: "订单尚未满足交付条件",
  ORDER_TERMINAL_OR_DELIVERED: "订单已结束或已完成交付",
  PLATFORM_CUSTOMER_ID_MISSING: "客户电子签账户标识缺失",
  PLATFORM_SIGNATURE_ID_MISSING: "平台签章配置缺失",
  SIGNING_SLOTS_INVALID: "签署位置配置无效",
  SOURCE_ARTIFACT_VERSION_INVALID: "交接 PDF 版本无效",
  SOURCE_CONTRACT_INVALID: "交接确认单签署源文件无效",
  SOURCE_CONTRACT_MISSING: "交接确认单签署源文件不存在",
  SOURCE_MANIFEST_MISMATCH: "交接 PDF 与证据清单不一致",
  SOURCE_PDF_HASH_INVALID: "交接 PDF 完整性校验失败",
  SOURCE_PDF_INVALID: "交接 PDF 文件无效",
  SOURCE_PDF_MISSING: "交接 PDF 文件不存在",
  SOURCE_PDF_TOO_LARGE: "交接 PDF 超出签署大小限制",
  SOURCE_TEMPLATE_NOT_ACTIVE: "交接确认单模板未生效",
  STAGE1_CONTRACT_NOT_CURRENT: "当前订阅合同不是生效版本",
  STAGE1_CONTRACT_NOT_SIGNED: "订阅合同尚未签署完成",
  WORK_ORDER_MISSING: "现场交接工单不存在",
  WORK_ORDER_NOT_READY_FOR_ESIGN: "现场交接工单尚未满足签署条件",
  WORK_ORDER_TERMINAL: "现场交接工单已结束"
};

const ERROR_MESSAGES: Record<string, string> = {
  STAGE2_CUSTOMER_SIGNATURE_REQUIRED: "客户尚未完成签署",
  STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED: "电子签状态已变化，请刷新后重试",
  STAGE2_HANDOVER_ESIGN_NOT_READY: "交接材料尚未满足电子签条件",
  STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED: "当前签署任务需先作废后才能重新发起",
  STAGE2_HANDOVER_ESIGN_TASK_INVALID: "当前电子签任务无效，请联系管理员",
  STAGE2_HANDOVER_ESIGN_TASK_MISSING: "电子签任务不存在，请刷新状态",
  STAGE2_PLATFORM_SEAL_NOT_RETRYABLE: "当前平台盖章不可重试",
  STAGE2_PLATFORM_SEAL_RETRY_NOT_DUE: "平台盖章尚未到可重试时间"
};

export function loadAdminStage2HandoverESign(id: string) {
  return apiFetch<AdminStage2HandoverESignStatus>(stage2ESignPath(id), {
    method: "GET"
  });
}

export function startAdminStage2HandoverESign(id: string) {
  return postStage2ESignStatus(id, "");
}

export function retryAdminStage2PlatformSeal(id: string) {
  return postStage2ESignStatus(id, "/platform-seal/retry");
}

export function retryAdminStage2HandoverArchive(id: string) {
  return apiFetch<AdminStage2HandoverSignedDocumentState>(
    `${stage2ESignPath(id)}/archive/retry`,
    { method: "POST" }
  );
}

export function voidAdminStage2HandoverESign(id: string, reason: string) {
  return apiFetch<AdminStage2HandoverESignStatus>(`${stage2ESignPath(id)}/void`, {
    body: JSON.stringify({ reason: reason.trim() }),
    method: "POST"
  });
}

export function validateAdminStage2HandoverVoidReason(reason: string) {
  const normalized = reason.trim();
  if (!normalized) {
    return "请填写作废原因";
  }
  if (normalized.length < 3 || normalized.length > 500) {
    return "作废原因需为 3-500 个字符";
  }
  return null;
}

export function getAdminStage2HandoverESignDisplay(
  status: AdminStage2HandoverESignStatus
): AdminStage2HandoverESignDisplay {
  const taskExists = Boolean(status.taskId);
  const platformRetryAvailable = status.platformSigner.retryAvailable === true;

  return {
    archive: getArchiveDisplay(status),
    archiveRetryAvailable:
      status.status === "COMPLETED" &&
      !status.signedArtifactAvailable &&
      (status.archiveStatus === "NOT_STARTED" || status.archiveStatus === "FAILED"),
    customer: getCustomerDisplay(status),
    platform: getPlatformDisplay(status),
    platformActionLabel: platformRetryAvailable
      ? status.platformSigner.attemptCount > 0
        ? "重试平台盖章"
        : "发起平台盖章"
      : null,
    readiness: getReadinessDisplay(status),
    startAvailable: status.ready && !taskExists,
    voidAvailable: status.canVoid === true
  };
}

export function getAdminStage2HandoverESignErrorMessage(error: unknown) {
  if (!(error instanceof ApiError)) {
    return "电子签操作失败，请刷新状态后重试";
  }

  const mappedMessage = error.code ? ERROR_MESSAGES[error.code] : undefined;
  if (mappedMessage) {
    return mappedMessage;
  }
  if (error.status === 403) {
    return "无发起或重试电子签权限";
  }
  if (error.status === 404) {
    return "交接工单或电子签任务不存在";
  }
  if (error.status === 409) {
    return "电子签状态已变化，请刷新后重试";
  }
  if (error.status === 0 || error.status >= 500) {
    return "电子签服务暂不可用，请稍后重试";
  }
  return "电子签操作失败，请刷新状态后重试";
}

function postStage2ESignStatus(id: string, suffix: string) {
  return apiFetch<AdminStage2HandoverESignStatus>(`${stage2ESignPath(id)}${suffix}`, {
    method: "POST"
  });
}

function stage2ESignPath(id: string) {
  return `/handover-work-orders/${encodeURIComponent(id)}/esign`;
}

function formatBlockers(blockers: readonly AdminStage2HandoverESignBlocker[]) {
  const messages = blockers.map((blocker) => BLOCKER_MESSAGES[blocker.code] ?? "存在未满足的电子签条件");
  return Array.from(new Set(messages)).join("；") || "存在未满足的电子签条件";
}

function getReadinessDisplay(
  status: AdminStage2HandoverESignStatus
): AdminStage2HandoverESignDisplayState {
  if (status.rebuildRequired) {
    if (!status.canVoid) {
      return {
        color: "red",
        detail: "供应商已受理该签署交易，不能在本地强制作废，请联系管理员核验处理",
        label: "签署任务需人工处理"
      };
    }
    return {
      color: "red",
      detail: "当前签署任务需先作废后才能重新发起",
      label: "签署任务需处理"
    };
  }
  if (status.taskId) {
    return getTaskLifecycleDisplay(status.status);
  }
  return {
    color: status.ready ? "green" : "orange",
    detail: status.ready ? null : formatBlockers(status.blockers),
    label: status.ready ? "签署条件已就绪" : "暂不可发起"
  };
}

function getTaskLifecycleDisplay(status: string | null): AdminStage2HandoverESignDisplayState {
  const states: Record<string, AdminStage2HandoverESignDisplayState> = {
    CANCELLED: { color: "default", detail: null, label: "签署任务已作废" },
    COMPLETED: { color: "success", detail: null, label: "签署已完成" },
    CREATED: { color: "processing", detail: null, label: "签署任务创建中" },
    EXPIRED: { color: "error", detail: null, label: "签署任务已过期" },
    FAILED: { color: "error", detail: null, label: "签署失败" },
    SIGNING: { color: "processing", detail: null, label: "签署进行中" },
    WAITING_CUSTOMER: { color: "warning", detail: null, label: "待客户签署" }
  };
  return status && states[status]
    ? states[status]
    : { color: "default", detail: null, label: "签署状态待刷新" };
}

function getCustomerDisplay(status: AdminStage2HandoverESignStatus): AdminStage2HandoverESignDisplayState {
  if (!status.taskId) {
    return { label: "待发起" };
  }
  switch (status.customerSigner.status) {
    case "SIGNED":
      return { color: "green", label: "已签署" };
    case "REJECTED":
      return { color: "red", label: "客户拒绝签署" };
    case "EXPIRED":
      return { color: "red", label: "客户签署已过期" };
    case "SIGNING":
    case "PENDING":
      return { color: "orange", label: "待客户签署" };
    default:
      return { label: "状态待刷新" };
  }
}

function getPlatformDisplay(status: AdminStage2HandoverESignStatus): AdminStage2HandoverESignDisplayState {
  if (!status.taskId) {
    return { label: "待发起" };
  }
  if (status.platformSigner.status === "SIGNED") {
    return { color: "green", label: "已盖章" };
  }
  if (status.platformSigner.retryAvailable && status.platformSigner.attemptCount > 0) {
    return {
      color: "red",
      detail: mapPlatformError(status.platformSigner.lastErrorCode),
      label: "平台盖章失败"
    };
  }
  if (status.platformSigner.retryAvailable) {
    return { color: "orange", label: "待平台盖章" };
  }
  if (status.customerSigner.status !== "SIGNED") {
    return { label: "待客户签署" };
  }
  if (status.platformSigner.status === "SIGNING") {
    return { color: "blue", label: "平台盖章处理中" };
  }
  return { color: "orange", label: "等待平台盖章" };
}

function getArchiveDisplay(status: AdminStage2HandoverESignStatus): AdminStage2HandoverESignDisplayState {
  if (status.signedArtifactAvailable && status.archiveStatus === "ARCHIVED") {
    return { color: "green", label: "签署文件已归档" };
  }
  if (status.archiveStatus === "FAILED") {
    return { color: "red", label: "签署文件归档失败" };
  }
  if (status.archiveStatus === "PENDING") {
    return { color: "blue", label: "签署文件归档中" };
  }
  if (status.status === "COMPLETED") {
    return { color: "orange", label: "签署完成，待归档" };
  }
  return { label: "待签署完成" };
}

function mapPlatformError(code: string | null) {
  if (code === "STAGE2_PLATFORM_SEAL_RETRY_NOT_DUE") {
    return "平台盖章尚未到可重试时间";
  }
  return "平台盖章未完成，请重试";
}
