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

export type AdminStage2HandoverWorkflowJobType =
  | "GENERATE_SOURCE_PDF"
  | "NOTIFY_FIELD_HANDOVER_ASSIGNED"
  | "NOTIFY_FIELD_ESIGN_READY"
  | "NOTIFY_CUSTOMER_ESIGN_READY"
  | "RECONCILE_CUSTOMER_SIGNATURE"
  | "AUTO_SEAL_PLATFORM"
  | "RECONCILE_PLATFORM_SEAL"
  | "ARCHIVE_SIGNED_PDF";

export type AdminStage2HandoverWorkflowJobStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "DEAD_LETTER"
  | "CANCELLED";

export interface AdminStage2HandoverWorkflowJob {
  attemptCount: number;
  availableAt?: string | null;
  createdAt?: string | null;
  id: string;
  jobStatus: AdminStage2HandoverWorkflowJobStatus;
  jobType: AdminStage2HandoverWorkflowJobType;
  lastErrorCode?: string | null;
  maxAttempts: number;
  updatedAt: string | null;
}

export interface AdminStage2HandoverESignStatus {
  archiveStatus: string | null;
  blockers: AdminStage2HandoverESignBlocker[];
  canAdminInitiate: boolean;
  canReconcileCustomer: boolean;
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
  sourceArtifact: {
    artifactVersion: number;
    createdAt: string;
    sourcePdfHash: string;
  } | null;
  status: string | null;
  taskId: string | null;
  updatedAt: string | null;
  workOrderId: string;
  workflowJobs?: AdminStage2HandoverWorkflowJob[];
}

export interface AdminStage2HandoverFallbackInput {
  acknowledgement: true;
  artifactVersion: number;
  reason: string;
  sourcePdfHash: string;
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

export type AdminStage2HandoverWorkflowStepKey =
  | "FIELD_ASSIGNMENT_NOTIFICATION"
  | "CUSTOMER_CONFIRMATION"
  | "SOURCE_PDF"
  | "FIELD_INITIATION"
  | "CUSTOMER_SIGNATURE"
  | "PLATFORM_SEAL"
  | "ARCHIVE";

export interface AdminStage2HandoverWorkflowStep {
  detail?: string | null;
  key: AdminStage2HandoverWorkflowStepKey;
  label: string;
  state: "complete" | "current" | "error" | "waiting";
}

export interface AdminStage2HandoverWorkflowRecovery {
  jobId: string;
  jobType: AdminStage2HandoverWorkflowJobType;
  kind: "RECONCILE_CUSTOMER" | "RETRY_JOB";
  label: string;
}

export interface AdminStage2HandoverWorkflowContext {
  customerConfirmedAt?: string | null;
  pdfStatus?: string | null;
  workflowJobs?: AdminStage2HandoverWorkflowJob[];
}

export interface AdminStage2HandoverWorkflowDisplay {
  deliveryConfirmationAvailable: boolean;
  recoveries: AdminStage2HandoverWorkflowRecovery[];
  steps: AdminStage2HandoverWorkflowStep[];
}

export interface AdminStage2DeliveryVerification {
  allowed: boolean;
  reason:
    | "SIGNED"
    | "LOAD_ERROR"
    | "NO_STAGE2_WORK_ORDER"
    | "NOT_SIGNED";
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
  STAGE2_HANDOVER_ADMIN_FALLBACK_NOT_ELIGIBLE:
    "Field 经办人仍可处理且尚未超过 15 分钟",
  STAGE2_HANDOVER_ADMIN_FALLBACK_REASON_INVALID:
    "兜底原因需为 3-500 个字符",
  STAGE2_HANDOVER_ADMIN_REVIEW_STALE:
    "交接确认单已更新，请重新核对后发起",
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

export function startAdminStage2HandoverESign(
  id: string,
  input: AdminStage2HandoverFallbackInput
) {
  return apiFetch<AdminStage2HandoverESignStatus>(
    stage2ESignPath(id),
    {
      body: JSON.stringify({
        acknowledgement: input.acknowledgement,
        artifactVersion: input.artifactVersion,
        reason: input.reason.trim().replace(/\s+/g, " "),
        sourcePdfHash: input.sourcePdfHash.trim().toLowerCase()
      }),
      method: "POST"
    }
  );
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

export function retryAdminStage2WorkflowJob(workOrderId: string, jobId: string) {
  return apiFetch<Record<string, unknown>>(
    `/handover-work-orders/${encodeURIComponent(workOrderId)}/workflow-jobs/${encodeURIComponent(jobId)}/retry`,
    { method: "POST" }
  );
}

export function reconcileAdminStage2CustomerSignature(workOrderId: string) {
  return apiFetch<Record<string, unknown>>(
    `/handover-work-orders/${encodeURIComponent(workOrderId)}/workflow/reconcile-customer`,
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

export function validateAdminStage2HandoverFallbackReason(
  reason: string
) {
  const normalized = reason.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "请填写兜底发起原因";
  }
  if (normalized.length < 3 || normalized.length > 500) {
    return "兜底原因需为 3-500 个字符";
  }
  return null;
}

export function getAdminStage2HandoverESignDisplay(
  status: AdminStage2HandoverESignStatus
): AdminStage2HandoverESignDisplay {
  const providerSigningCompleted =
    status.status === "COMPLETED" ||
    status.customerSigner.status === "SIGNED" ||
    status.platformSigner.status === "SIGNED";

  return {
    archive: getArchiveDisplay(status),
    archiveRetryAvailable: false,
    customer: getCustomerDisplay(status),
    platform: getPlatformDisplay(status),
    platformActionLabel: null,
    readiness: getReadinessDisplay(status),
    startAvailable:
      status.canAdminInitiate === true &&
      status.ready === true &&
      !status.taskId,
    voidAvailable: status.canVoid === true && !providerSigningCompleted
  };
}

export function getAdminStage2HandoverWorkflowDisplay(
  status?: AdminStage2HandoverESignStatus | null,
  context: AdminStage2HandoverWorkflowContext = {}
): AdminStage2HandoverWorkflowDisplay {
  const workflowJobs = status?.workflowJobs ?? context.workflowJobs ?? [];
  const currentJobs = getAuthoritativeCurrentWorkflowJobs(workflowJobs);
  const archived =
    status?.archiveStatus === "ARCHIVED" && status.signedArtifactAvailable === true;
  const platformComplete = signerCompleted(
    status?.platformSigner,
    "STAGE2_HANDOVER_PLATFORM"
  );
  const customerComplete = signerCompleted(
    status?.customerSigner,
    "STAGE2_HANDOVER_CUSTOMER"
  );
  const signingComplete = stage2SigningCompleted(status);
  const fieldInitiationComplete = customerComplete || Boolean(status?.taskId);
  const pdfComplete =
    fieldInitiationComplete || context.pdfStatus === "GENERATED";
  const customerConfirmationComplete =
    pdfComplete || Boolean(context.customerConfirmedAt);
  const assignmentJob = currentJobs.valid
    ? currentJobs.jobs.find(
        (job) => job.jobType === "NOTIFY_FIELD_HANDOVER_ASSIGNED"
      ) ?? null
    : null;
  const completed: Record<AdminStage2HandoverWorkflowStepKey, boolean> = {
    ARCHIVE: archived,
    CUSTOMER_CONFIRMATION: customerConfirmationComplete,
    CUSTOMER_SIGNATURE: customerComplete,
    FIELD_ASSIGNMENT_NOTIFICATION:
      customerConfirmationComplete || assignmentJob?.jobStatus === "COMPLETED",
    FIELD_INITIATION: fieldInitiationComplete,
    PLATFORM_SEAL: platformComplete,
    SOURCE_PDF: pdfComplete
  };
  const currentDeadLetters = currentJobs.valid
    ? currentJobs.jobs.filter(
        (job) =>
          job.jobStatus === "DEAD_LETTER" &&
          (
            job.jobType !== "RECONCILE_CUSTOMER_SIGNATURE" ||
            status?.canReconcileCustomer === true
          ) &&
          !completed[WORKFLOW_JOB_STEP[job.jobType]]
      )
    : [];
  const newestDeadLetter = selectSingleNewestJob(currentDeadLetters);
  const recovery = newestDeadLetter
    ? toWorkflowRecovery(newestDeadLetter)
    : null;
  const recoveries = recovery ? [recovery] : [];
  const errorSteps = new Set(
    currentDeadLetters.map((job) => WORKFLOW_JOB_STEP[job.jobType])
  );
  const currentJobByStep = new Map(
    currentJobs.valid
      ? currentJobs.jobs.map((job) => [WORKFLOW_JOB_STEP[job.jobType], job] as const)
      : []
  );
  const firstIncomplete = WORKFLOW_STEP_KEYS.find((key) => !completed[key]) ?? null;

  return {
    deliveryConfirmationAvailable: signingComplete,
    recoveries,
    steps: WORKFLOW_STEP_KEYS.map((key) => {
      const state = completed[key]
        ? "complete"
        : errorSteps.has(key)
          ? "error"
          : key === firstIncomplete
            ? "current"
            : "waiting";
      return {
        detail: getWorkflowStepDetail(
          key,
          currentJobByStep.get(key) ?? null,
          customerConfirmationComplete
        ),
        key,
        label: workflowStepLabel(key, state, status),
        state
      };
    })
  };
}

export function createAdminStage2DeliveryVerifier({
  loadESignStatus,
  loadWorkOrders
}: {
  loadESignStatus: (
    workOrderId: string
  ) => Promise<Pick<
    AdminStage2HandoverESignStatus,
    | "customerSigner"
    | "documentType"
    | "platformSigner"
    | "signingStage"
    | "status"
    | "taskId"
  >>;
  loadWorkOrders: (
    orderId: string
  ) => Promise<Array<{ id: string; status?: string | null }>>;
}) {
  return {
    async verify(orderId: string): Promise<AdminStage2DeliveryVerification> {
      try {
        const workOrders = await loadWorkOrders(orderId);
        const activeWorkOrders = workOrders.filter(
          (workOrder) =>
            !["CANCELLED", "FAILED", "VOIDED"].includes(
              workOrder.status ?? ""
            )
        );
        if (activeWorkOrders.length === 0) {
          return { allowed: true, reason: "NO_STAGE2_WORK_ORDER" };
        }
        if (activeWorkOrders.length !== 1) {
          return { allowed: false, reason: "NOT_SIGNED" };
        }
        const [activeWorkOrder] = activeWorkOrders;
        if (!activeWorkOrder) {
          return { allowed: false, reason: "NOT_SIGNED" };
        }
        const status = await loadESignStatus(activeWorkOrder.id);
        return stage2SigningCompleted(status)
          ? { allowed: true, reason: "SIGNED" }
          : { allowed: false, reason: "NOT_SIGNED" };
      } catch {
        return { allowed: false, reason: "LOAD_ERROR" };
      }
    }
  };
}

function stage2SigningCompleted(
  status?: Pick<
    AdminStage2HandoverESignStatus,
    | "customerSigner"
    | "documentType"
    | "platformSigner"
    | "signingStage"
    | "status"
    | "taskId"
  > | null
) {
  return Boolean(
    status?.documentType === "DELIVERY_HANDOVER" &&
    status.signingStage === "STAGE2_DELIVERY_HANDOVER" &&
    status.taskId &&
    status.status === "COMPLETED" &&
    signerCompleted(
      status.customerSigner,
      "STAGE2_HANDOVER_CUSTOMER"
    ) &&
    signerCompleted(
      status.platformSigner,
      "STAGE2_HANDOVER_PLATFORM"
    )
  );
}

function signerCompleted(
  signer: AdminStage2HandoverESignSigner | null | undefined,
  slotId: string
) {
  return Boolean(
    signer?.slotId === slotId &&
    signer.status === "SIGNED" &&
    signer.signedAt
  );
}

export function createAdminStage2DeliveryConfirmationController({
  onBlocked,
  verifier
}: {
  onBlocked: (
    verification: AdminStage2DeliveryVerification,
    boundary: "BEFORE_POST" | "MODAL_OPEN"
  ) => void;
  verifier: {
    verify(orderId: string): Promise<AdminStage2DeliveryVerification>;
  };
}) {
  return {
    async run({
      boundary,
      onAllowed,
      orderId
    }: {
      boundary: "BEFORE_POST" | "MODAL_OPEN";
      onAllowed: () => Promise<void> | void;
      orderId: string;
    }) {
      const verification = await verifier.verify(orderId);
      if (!verification.allowed) {
        onBlocked(verification, boundary);
        return false;
      }
      await onAllowed();
      return true;
    }
  };
}

export async function runAdminStage2WorkflowRecovery({
  allowed,
  execute,
  recovery,
  workOrderId
}: {
  allowed: boolean;
  execute: (
    workOrderId: string,
    recovery: AdminStage2HandoverWorkflowRecovery
  ) => Promise<unknown>;
  recovery: AdminStage2HandoverWorkflowRecovery;
  workOrderId: string;
}) {
  if (!allowed) {
    return false;
  }
  await execute(workOrderId, recovery);
  return true;
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

const WORKFLOW_STEP_KEYS: AdminStage2HandoverWorkflowStepKey[] = [
  "FIELD_ASSIGNMENT_NOTIFICATION",
  "CUSTOMER_CONFIRMATION",
  "SOURCE_PDF",
  "FIELD_INITIATION",
  "CUSTOMER_SIGNATURE",
  "PLATFORM_SEAL",
  "ARCHIVE"
];

const WORKFLOW_JOB_STEP: Record<
  AdminStage2HandoverWorkflowJobType,
  AdminStage2HandoverWorkflowStepKey
> = {
  ARCHIVE_SIGNED_PDF: "ARCHIVE",
  AUTO_SEAL_PLATFORM: "PLATFORM_SEAL",
  GENERATE_SOURCE_PDF: "SOURCE_PDF",
  NOTIFY_CUSTOMER_ESIGN_READY: "CUSTOMER_SIGNATURE",
  NOTIFY_FIELD_HANDOVER_ASSIGNED: "FIELD_ASSIGNMENT_NOTIFICATION",
  NOTIFY_FIELD_ESIGN_READY: "FIELD_INITIATION",
  RECONCILE_CUSTOMER_SIGNATURE: "CUSTOMER_SIGNATURE",
  RECONCILE_PLATFORM_SEAL: "PLATFORM_SEAL"
};

const WORKFLOW_RECOVERY: Record<
  AdminStage2HandoverWorkflowJobType,
  Pick<AdminStage2HandoverWorkflowRecovery, "kind" | "label">
> = {
  ARCHIVE_SIGNED_PDF: {
    kind: "RETRY_JOB",
    label: "重试签署文件归档"
  },
  AUTO_SEAL_PLATFORM: {
    kind: "RETRY_JOB",
    label: "重试平台盖章"
  },
  GENERATE_SOURCE_PDF: {
    kind: "RETRY_JOB",
    label: "重试生成交接确认单"
  },
  NOTIFY_CUSTOMER_ESIGN_READY: {
    kind: "RETRY_JOB",
    label: "重发客户通知"
  },
  NOTIFY_FIELD_HANDOVER_ASSIGNED: {
    kind: "RETRY_JOB",
    label: "重发交接任务通知"
  },
  NOTIFY_FIELD_ESIGN_READY: {
    kind: "RETRY_JOB",
    label: "重发经办人通知"
  },
  RECONCILE_CUSTOMER_SIGNATURE: {
    kind: "RECONCILE_CUSTOMER",
    label: "核对客户签署状态"
  },
  RECONCILE_PLATFORM_SEAL: {
    kind: "RETRY_JOB",
    label: "重试平台盖章"
  }
};

const WORKFLOW_JOB_STATUSES = new Set<AdminStage2HandoverWorkflowJobStatus>([
  "CANCELLED",
  "COMPLETED",
  "DEAD_LETTER",
  "PENDING",
  "PROCESSING"
]);

function getAuthoritativeCurrentWorkflowJobs(
  jobs: readonly AdminStage2HandoverWorkflowJob[]
): {
  jobs: AdminStage2HandoverWorkflowJob[];
  valid: boolean;
} {
  const newestByStep = new Map<
    AdminStage2HandoverWorkflowStepKey,
    AdminStage2HandoverWorkflowJob
  >();
  for (const job of jobs) {
    if (
      !job.id ||
      !Object.prototype.hasOwnProperty.call(
        WORKFLOW_JOB_STEP,
        job.jobType
      ) ||
      !WORKFLOW_JOB_STATUSES.has(job.jobStatus) ||
      getWorkflowJobTimestamp(job) === null
    ) {
      return { jobs: [], valid: false };
    }
    const step = WORKFLOW_JOB_STEP[job.jobType];
    const current = newestByStep.get(step);
    if (!current) {
      newestByStep.set(step, job);
      continue;
    }
    const currentTimestamp = getWorkflowJobTimestamp(current);
    const nextTimestamp = getWorkflowJobTimestamp(job);
    if (currentTimestamp === nextTimestamp) {
      return { jobs: [], valid: false };
    }
    if (
      currentTimestamp !== null &&
      nextTimestamp !== null &&
      nextTimestamp > currentTimestamp
    ) {
      newestByStep.set(step, job);
    }
  }
  return { jobs: Array.from(newestByStep.values()), valid: true };
}

function selectSingleNewestJob(
  jobs: readonly AdminStage2HandoverWorkflowJob[]
) {
  let newest: AdminStage2HandoverWorkflowJob | null = null;
  for (const job of jobs) {
    if (!newest) {
      newest = job;
      continue;
    }
    const newestTimestamp = getWorkflowJobTimestamp(newest);
    const nextTimestamp = getWorkflowJobTimestamp(job);
    if (newestTimestamp === nextTimestamp) {
      return null;
    }
    if (
      newestTimestamp !== null &&
      nextTimestamp !== null &&
      nextTimestamp > newestTimestamp
    ) {
      newest = job;
    }
  }
  return newest;
}

function getWorkflowJobTimestamp(job: AdminStage2HandoverWorkflowJob) {
  const timestamp = Date.parse(job.updatedAt ?? job.createdAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function toWorkflowRecovery(
  job: AdminStage2HandoverWorkflowJob
): AdminStage2HandoverWorkflowRecovery | null {
  const recovery = WORKFLOW_RECOVERY[job.jobType];
  if (!job.id || !recovery) {
    return null;
  }
  return {
    jobId: job.id,
    jobType: job.jobType,
    ...recovery
  };
}

function getWorkflowStepDetail(
  key: AdminStage2HandoverWorkflowStepKey,
  job: AdminStage2HandoverWorkflowJob | null,
  customerConfirmationComplete: boolean
) {
  if (!job) {
    return null;
  }
  const errorCode = safeWorkflowErrorCode(job.lastErrorCode);
  if (
    key === "FIELD_ASSIGNMENT_NOTIFICATION" &&
    customerConfirmationComplete &&
    job.jobStatus === "DEAD_LETTER"
  ) {
    return appendWorkflowErrorCode(
      "通知任务异常，但后续流程已推进，不影响电子签",
      errorCode
    );
  }
  switch (job.jobStatus) {
    case "PENDING": {
      const availableAt = safeWorkflowTimestamp(job.availableAt);
      return appendWorkflowErrorCode(
        `等待系统重试，下次运行：${availableAt ?? "待调度"}`,
        errorCode
      );
    }
    case "PROCESSING":
      return "系统正在处理";
    case "DEAD_LETTER":
      return appendWorkflowErrorCode("系统重试已用尽", errorCode);
    case "COMPLETED":
      return key === "FIELD_ASSIGNMENT_NOTIFICATION"
        ? "交接任务通知已完成"
        : null;
    case "CANCELLED":
      return "任务已取消";
  }
}

function appendWorkflowErrorCode(message: string, errorCode: string | null) {
  return errorCode ? `${message}（错误码：${errorCode}）` : message;
}

function safeWorkflowErrorCode(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return /^[A-Z0-9_]{1,128}$/.test(normalized) ? normalized : null;
}

function safeWorkflowTimestamp(value: string | null | undefined) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function workflowStepLabel(
  key: AdminStage2HandoverWorkflowStepKey,
  state: AdminStage2HandoverWorkflowStep["state"],
  status?: AdminStage2HandoverESignStatus | null
) {
  if (state === "complete") {
    return {
      ARCHIVE: "签署文件已归档",
      CUSTOMER_CONFIRMATION: "客户已确认",
      CUSTOMER_SIGNATURE: "客户已签署",
      FIELD_ASSIGNMENT_NOTIFICATION: "交接任务通知已处理",
      FIELD_INITIATION: "经办人已发起签署",
      PLATFORM_SEAL: "平台已盖章",
      SOURCE_PDF: "交接确认单已生成"
    }[key];
  }
  if (state === "error") {
    return {
      ARCHIVE: "签署文件归档异常",
      CUSTOMER_CONFIRMATION: "客户确认异常",
      CUSTOMER_SIGNATURE: "客户签署流程异常",
      FIELD_ASSIGNMENT_NOTIFICATION: "交接任务通知异常",
      FIELD_INITIATION: "经办人签署发起流程异常",
      PLATFORM_SEAL: "平台盖章流程异常",
      SOURCE_PDF: "交接确认单生成异常"
    }[key];
  }
  if (state === "current") {
    return {
      ARCHIVE:
        status?.archiveStatus === "PENDING"
          ? "签署文件归档中"
          : "等待签署文件归档",
      CUSTOMER_CONFIRMATION: "等待客户确认",
      CUSTOMER_SIGNATURE: "待客户签署",
      FIELD_ASSIGNMENT_NOTIFICATION: "等待交接任务通知",
      FIELD_INITIATION: "等待经办人发起签署",
      PLATFORM_SEAL: "平台盖章处理中",
      SOURCE_PDF: "交接确认单生成中"
    }[key];
  }
  return {
    ARCHIVE: "等待签署文件归档",
    CUSTOMER_CONFIRMATION: "等待客户确认",
    CUSTOMER_SIGNATURE: "等待客户签署",
    FIELD_ASSIGNMENT_NOTIFICATION: "等待交接任务通知",
    FIELD_INITIATION: "等待经办人发起签署",
    PLATFORM_SEAL: "等待平台盖章",
    SOURCE_PDF: "等待生成交接确认单"
  }[key];
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
