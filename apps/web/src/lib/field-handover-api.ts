import { API_BASE_URL, ApiError, apiFetch } from "./api";

const FIELD_EVIDENCE_UPLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const FIELD_EVIDENCE_UPLOAD_FAILED_MESSAGE = "上传失败，请稍后重试。";
const FIELD_EVIDENCE_UPLOAD_NETWORK_ERROR_MESSAGE = "上传失败，请检查网络后重试。";
const FIELD_EVIDENCE_UPLOAD_TIMEOUT_ERROR_MESSAGE = "上传超时，请检查网络后重试。";
const FIELD_EVIDENCE_UPLOAD_CANCELLED_ERROR_MESSAGE = "上传已取消。";
const FIELD_EVIDENCE_UPLOAD_TOO_LARGE_MESSAGE =
  "文件过大，单个视频不得超过 300MB。若文件未超过限制，请联系管理员检查上传网关配置。";

export interface FieldHandoverCodeResponse {
  expiresIn: number;
  sent: boolean;
}

export interface FieldHandoverSession {
  authenticated?: boolean;
  operatorType?: "EXTERNAL" | "INTERNAL" | string | null;
  phoneMasked?: string | null;
  taskCount?: number;
}

export interface FieldHandoverEvidenceProgress {
  approved?: number | null;
  required?: number | null;
  total?: number | null;
  uploaded?: number | null;
}

export interface FieldHandoverCustomerSummary {
  displayName?: string | null;
  mobileMasked?: string | null;
}

export interface FieldHandoverVehicleSummary {
  brand?: string | null;
  model?: string | null;
  plateMasked?: string | null;
  vinSuffix?: string | null;
}

export type FieldHandoverDisplayStatus =
  | "HANDOVER_PDF_GENERATING"
  | "ESIGN_INITIATION_PENDING"
  | "CUSTOMER_SIGNATURE_PENDING"
  | "PLATFORM_SEAL_PENDING"
  | "ARCHIVE_PENDING"
  | "ARCHIVE_FAILED"
  | "COMPLETED"
  | "CANCELLED"
  | "VOIDED"
  | "FAILED"
  | "INCONSISTENT"
  | "FIELD_WORK_PENDING"
  | "CUSTOMER_REVIEW_PENDING";

export interface FieldHandoverWorkOrderListItem {
  adminReviewStatus?: string | null;
  completedAt?: string | null;
  customer?: FieldHandoverCustomerSummary | null;
  deliveryLocation?: string | null;
  displayStatus?: FieldHandoverDisplayStatus;
  displayStatusLabel?: string;
  evidenceProgress?: FieldHandoverEvidenceProgress | null;
  fieldResubmissionRequested?: boolean | null;
  handoverId?: string | null;
  handoverType?: string | null;
  id: string;
  orderNo?: string | null;
  scheduledAt?: string | null;
  status?: string | null;
  taskGroup?: "ACTIVE" | "ENDED";
  vehicle?: FieldHandoverVehicleSummary | null;
}

export interface FieldHandoverEvidenceChecklist {
  blockingReasons?: string[];
  items?: FieldHandoverEvidenceItem[];
  ready?: boolean;
}

export type FieldHandoverEvidenceMediaType = "PHOTO" | "VIDEO" | string;

export interface FieldHandoverEvidenceFile {
  displayName?: string | null;
  downloadUrl?: string | null;
  evidenceFileId?: string | null;
  file?: {
    id?: string | null;
    mimeType?: string | null;
    originalName?: string | null;
    sizeBytes?: number | string | null;
  } | null;
  id?: string | null;
  lifecycleStatus?: string | null;
  mediaType?: FieldHandoverEvidenceMediaType | null;
  metadata?: Record<string, unknown> | null;
  mimeType?: string | null;
  previewAvailable?: boolean | null;
  previewUrl?: string | null;
  sizeBytes?: number | string | null;
  uploadedAt?: string | null;
}

export interface FieldHandoverEvidenceItem {
  allowsMultiple?: boolean | null;
  allowedMediaTypes?: FieldHandoverEvidenceMediaType[];
  conditionKey?: string | null;
  conditionValue?: string | null;
  declaredNoDamage?: boolean | null;
  description?: string | null;
  evidenceType?: string | null;
  fileCount?: number | null;
  fileRequired?: boolean | null;
  files?: FieldHandoverEvidenceFile[];
  id?: string | null;
  isConditional?: boolean | null;
  isRequired?: boolean | null;
  rejectionReason?: string | null;
  requirementLevel?: string | null;
  reviewedAt?: string | null;
  reviewStatus?: string | null;
  status?: string | null;
  title?: string | null;
}

export interface FieldEvidenceUploadProgress {
  loadedBytes: number;
  percent: number;
  totalBytes: number;
}

export interface FieldEvidenceUploadOptions {
  onProgress?: (progress: FieldEvidenceUploadProgress) => void;
  onUploadComplete?: () => void;
  replaceEvidenceFileId?: string;
  signal?: AbortSignal;
}

export interface FieldHandoverFieldFacts {
  accessoryChecklist?: unknown;
  damageDeclared?: boolean | null;
  deliveryLocation?: string | null;
  energyLevelText?: string | null;
  fieldNotes?: string | null;
  fieldStartedAt?: string | null;
  fieldSubmittedAt?: string | null;
  fuelLevelText?: string | null;
  handoverMileageKm?: number | null;
  noVisibleDamageDeclared?: boolean | null;
  scheduledAt?: string | null;
}

export interface FieldHandoverWorkOrderDetail extends FieldHandoverWorkOrderListItem {
  evidenceChecklist?: FieldHandoverEvidenceChecklist | null;
  fieldFacts?: FieldHandoverFieldFacts | null;
  reviewContext?: FieldHandoverReviewContext | null;
  stage2Capabilities: FieldStage2HandoverCapabilities;
  stage2ESign: FieldStage2ESignSummary;
  stage2Notification: FieldStage2NotificationSummary;
  stage2Pdf: FieldStage2HandoverPdfArtifact;
}

export interface FieldStage2HandoverCapabilities {
  canDownload: boolean;
  canPreview: boolean;
  canStartESign: boolean;
  shouldPollESign: boolean;
}

export interface FieldStage2HandoverPdfArtifact {
  artifactId?: string | null;
  artifactVersion?: number | null;
  capabilities?: FieldStage2HandoverCapabilities | null;
  documentNo?: string | null;
  downloadUrl?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  generatedAt?: string | null;
  notificationStatus?: string | null;
  orderNo?: string | null;
  previewUrl?: string | null;
  sourcePdfHash?: string | null;
  status?: "GENERATED" | "NOT_GENERATED" | string | null;
  workOrderId?: string | null;
}

export interface FieldStage2ESignSummary {
  finalizationPending: boolean;
  status: string | null;
  taskId: string | null;
}

export interface FieldStage2NotificationSummary {
  status: string | null;
}

export interface StartFieldHandoverESignInput {
  acknowledgement: true;
  artifactVersion: number;
  sourcePdfHash: string;
}

export interface FieldStage2ESignResult {
  finalizationPending?: boolean;
  signingStage?: "STAGE2_DELIVERY_HANDOVER" | string;
  status?: string | null;
  taskId?: string | null;
}

export interface FieldHandoverReviewContext {
  adminStatus?: string | null;
  adminNote?: string | null;
  attemptNo?: number | null;
  customerObjectionDetails?: string | null;
  customerObjectionReason?: string | null;
  requestedEvidenceItems?: Array<{ id: string; title: string }>;
  requestedFieldKeys?: string[];
}

export interface UpdateFieldHandoverFactsInput {
  accessoryChecklist?: unknown;
  damageDeclared?: boolean | null;
  deliveryLocation?: string | null;
  energyLevelText?: string | null;
  fieldNotes?: string | null;
  fuelLevelText?: string | null;
  handoverMileageKm?: number | null;
  noVisibleDamageDeclared?: boolean | null;
  scheduledAt?: string | null;
}

export interface FieldHandoverReadiness {
  blockingReasons?: string[];
  ready?: boolean;
}

export function isValidFieldHandoverPhone(phone: string) {
  return /^1[3-9]\d{9}$/.test(phone.trim());
}

export async function sendFieldHandoverCode(phone: string): Promise<FieldHandoverCodeResponse> {
  const response = await apiFetch<FieldHandoverCodeResponse & { debugCode?: string }>("/field/handover/send-code", {
    body: JSON.stringify({ phone: phone.trim() }),
    method: "POST"
  });

  return {
    expiresIn: response.expiresIn,
    sent: response.sent
  };
}

export function loginFieldHandover(phone: string, code: string) {
  return apiFetch<FieldHandoverSession>("/field/handover/login", {
    body: JSON.stringify({ code: code.trim(), phone: phone.trim() }),
    method: "POST"
  });
}

export function getFieldHandoverSession() {
  return apiFetch<FieldHandoverSession>("/field/handover/session");
}

export function logoutFieldHandover() {
  return apiFetch<{ success: boolean }>("/field/handover/logout", { method: "POST" });
}

export function listFieldHandoverWorkOrders() {
  return apiFetch<FieldHandoverWorkOrderListItem[]>("/field/handover/work-orders");
}

export function getFieldHandoverWorkOrder(id: string) {
  return apiFetch<FieldHandoverWorkOrderDetail>(`/field/handover/work-orders/${encodeURIComponent(id)}`);
}

export function startFieldHandoverWorkOrder(id: string) {
  return apiFetch<FieldHandoverWorkOrderDetail>(`/field/handover/work-orders/${encodeURIComponent(id)}/start`, {
    method: "POST"
  });
}

export function updateFieldHandoverFacts(id: string, input: UpdateFieldHandoverFactsInput) {
  return apiFetch<FieldHandoverWorkOrderDetail>(`/field/handover/work-orders/${encodeURIComponent(id)}/facts`, {
    body: JSON.stringify(input),
    method: "PATCH"
  });
}

export function uploadAndAttachFieldHandoverEvidenceFile(
  id: string,
  itemId: string,
  file: File,
  options: FieldEvidenceUploadOptions | string = {}
) {
  const uploadOptions = typeof options === "string" ? { replaceEvidenceFileId: options } : options;
  const formData = new FormData();
  formData.append("files", file, file.name);
  if (uploadOptions.replaceEvidenceFileId) {
    formData.append("replaceEvidenceFileId", uploadOptions.replaceEvidenceFileId);
  }

  return new Promise<FieldHandoverEvidenceItem>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abortFromCaller = () => xhr.abort();
    xhr.upload.onprogress = (event) => {
      const totalBytes = Math.max(0, file.size);
      const rawLoaded = Number.isFinite(event.loaded) ? event.loaded : 0;
      const loadedBytes = Math.min(totalBytes, Math.max(0, rawLoaded));
      const percent =
        totalBytes > 0
          ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100))
          : 0;
      uploadOptions.onProgress?.({ loadedBytes, percent, totalBytes });
    };
    xhr.upload.onload = () => uploadOptions.onUploadComplete?.();
    xhr.onload = () => settleFieldEvidenceUpload(xhr, resolve, reject);
    xhr.onerror = () => reject(new ApiError(FIELD_EVIDENCE_UPLOAD_NETWORK_ERROR_MESSAGE, 0));
    xhr.ontimeout = () => reject(new ApiError(FIELD_EVIDENCE_UPLOAD_TIMEOUT_ERROR_MESSAGE, 0));
    xhr.onabort = () => reject(new ApiError(FIELD_EVIDENCE_UPLOAD_CANCELLED_ERROR_MESSAGE, 0));
    xhr.onloadend = () => uploadOptions.signal?.removeEventListener("abort", abortFromCaller);
    xhr.open(
      "POST",
      `${API_BASE_URL}/field/handover/work-orders/${encodeURIComponent(id)}/evidence/${encodeURIComponent(itemId)}/upload`
    );
    xhr.withCredentials = true;
    xhr.timeout = FIELD_EVIDENCE_UPLOAD_TIMEOUT_MS;

    if (uploadOptions.signal?.aborted) {
      reject(new ApiError(FIELD_EVIDENCE_UPLOAD_CANCELLED_ERROR_MESSAGE, 0));
      return;
    }

    uploadOptions.signal?.addEventListener("abort", abortFromCaller, { once: true });
    xhr.send(formData);
  });
}

function settleFieldEvidenceUpload(
  xhr: XMLHttpRequest,
  resolve: (item: FieldHandoverEvidenceItem) => void,
  reject: (error: ApiError) => void
) {
  if (xhr.status < 200 || xhr.status >= 300) {
    if (xhr.status === 413) {
      reject(new ApiError(FIELD_EVIDENCE_UPLOAD_TOO_LARGE_MESSAGE, 413));
      return;
    }
    reject(new ApiError(readFieldEvidenceUploadErrorMessage(xhr.responseText), xhr.status));
    return;
  }

  try {
    const item = JSON.parse(xhr.responseText) as unknown;
    if (isFieldHandoverEvidenceItem(item)) {
      resolve(item);
      return;
    }
  } catch {
    // The caller receives a safe error for malformed successful responses.
  }

  reject(new ApiError(FIELD_EVIDENCE_UPLOAD_FAILED_MESSAGE, xhr.status));
}

function readFieldEvidenceUploadErrorMessage(responseText: string) {
  try {
    const body = JSON.parse(responseText) as { message?: unknown };
    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
    if (Array.isArray(body.message)) {
      const messages = body.message
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
      if (messages.length > 0) {
        return messages.join(", ");
      }
    }
  } catch {
    // Error response bodies are intentionally not exposed to callers.
  }

  return FIELD_EVIDENCE_UPLOAD_FAILED_MESSAGE;
}

function isFieldHandoverEvidenceItem(value: unknown): value is FieldHandoverEvidenceItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as { id?: unknown; status?: unknown };
  return typeof item.id === "string" && typeof item.status === "string";
}

export function removeFieldHandoverEvidenceFile(id: string, itemId: string, evidenceFileId: string) {
  return apiFetch<FieldHandoverEvidenceItem>(
    `/field/handover/work-orders/${encodeURIComponent(id)}/evidence/${encodeURIComponent(itemId)}/files/${encodeURIComponent(evidenceFileId)}`,
    { method: "DELETE" }
  );
}

export function buildFieldHandoverFileUrl(path: null | string | undefined) {
  if (!path) {
    return null;
  }
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalized = path.startsWith("/api/") ? path.slice(4) : path;
  return `${API_BASE_URL}${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

export function declareFieldHandoverNoVisibleDamage(id: string, remark?: string) {
  return apiFetch<FieldHandoverWorkOrderDetail>(
    `/field/handover/work-orders/${encodeURIComponent(id)}/no-visible-damage`,
    {
      body: JSON.stringify({ remark }),
      method: "POST"
    }
  );
}

export function getFieldHandoverReadiness(id: string) {
  return apiFetch<FieldHandoverReadiness>(`/field/handover/work-orders/${encodeURIComponent(id)}/readiness`);
}

export function submitFieldHandoverEvidence(id: string) {
  return apiFetch<FieldHandoverWorkOrderDetail>(`/field/handover/work-orders/${encodeURIComponent(id)}/submit`, {
    method: "POST"
  });
}

export function startFieldHandoverESign(
  id: string,
  input: StartFieldHandoverESignInput
) {
  return apiFetch<FieldStage2ESignResult>(
    `/field/handover/work-orders/${encodeURIComponent(id)}/esign`,
    {
      body: JSON.stringify(input),
      method: "POST"
    }
  );
}

export function createFieldESignSubmissionController<TResult>({
  submit
}: {
  submit: (input: StartFieldHandoverESignInput) => Promise<TResult>;
}) {
  let inFlight: null | Promise<TResult> = null;
  return {
    submit(
      input: Omit<StartFieldHandoverESignInput, "acknowledgement"> & {
        acknowledgement: boolean;
      }
    ) {
      if (input.acknowledgement !== true) {
        return null;
      }
      if (inFlight) {
        return inFlight;
      }
      const request = submit({
        ...input,
        acknowledgement: true
      }).finally(() => {
        if (inFlight === request) {
          inFlight = null;
        }
      });
      inFlight = request;
      return request;
    }
  };
}

export function isFieldHandoverUnauthorized(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}

export function isFieldHandoverSessionExpired(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 401) {
    return false;
  }

  return !/no access/i.test(error.message);
}

export function getFieldHandoverSendCodeErrorMessage(error: unknown) {
  if (!(error instanceof ApiError)) {
    return "验证码发送失败，请稍后重试";
  }

  if (error.status === 429) {
    return "验证码发送过于频繁，请稍后再试";
  }

  if (error.status === 0 || error.status >= 500) {
    return "验证码发送失败，请稍后重试";
  }

  return error.message || "验证码发送失败，请稍后重试";
}

export function getFieldHandoverLoginErrorMessage(error: unknown) {
  if (error instanceof ApiError && [400, 401, 403].includes(error.status)) {
    return "验证码错误或已过期，请重新获取";
  }

  if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
    return "登录失败，请稍后重试";
  }

  return error instanceof ApiError && error.message ? error.message : "登录失败，请稍后重试";
}

export function getFieldHandoverActionErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    return "登录状态已过期，请重新登录";
  }
  if (error instanceof ApiError && error.message) {
    return error.message;
  }
  return "操作失败，请稍后重试";
}
