import { ApiError, apiFetch } from "./api";

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

export interface FieldHandoverWorkOrderListItem {
  adminReviewStatus?: string | null;
  customer?: FieldHandoverCustomerSummary | null;
  deliveryLocation?: string | null;
  evidenceProgress?: FieldHandoverEvidenceProgress | null;
  fieldResubmissionRequested?: boolean | null;
  handoverId?: string | null;
  handoverType?: string | null;
  id: string;
  orderNo?: string | null;
  scheduledAt?: string | null;
  status?: string | null;
  vehicle?: FieldHandoverVehicleSummary | null;
}

export interface FieldHandoverEvidenceChecklist {
  blockingReasons?: string[];
  items?: FieldHandoverEvidenceItem[];
  ready?: boolean;
}

export type FieldHandoverEvidenceMediaType = "PHOTO" | "VIDEO" | string;

export interface FieldHandoverEvidenceFile {
  file?: {
    id?: string | null;
    mimeType?: string | null;
    originalName?: string | null;
    sizeBytes?: number | string | null;
  } | null;
  id?: string | null;
  mediaType?: FieldHandoverEvidenceMediaType | null;
  uploadedAt?: string | null;
}

export interface FieldHandoverEvidenceItem {
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

export interface AttachFieldHandoverEvidenceFileInput {
  fileId: string;
  mediaType: FieldHandoverEvidenceMediaType;
}

export interface FieldHandoverUploadedFile {
  fileId: string;
  fileName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
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

export async function uploadFieldHandoverEvidenceFile(id: string, file: File): Promise<FieldHandoverUploadedFile> {
  const formData = new FormData();
  formData.append("files", file, file.name);
  const response = await apiFetch<FieldHandoverUploadedFile & { objectKey?: string }>(
    `/field/handover/work-orders/${encodeURIComponent(id)}/evidence-files`,
    {
      body: formData,
      method: "POST"
    }
  );

  return {
    fileId: response.fileId,
    fileName: response.fileName,
    mimeType: response.mimeType,
    sizeBytes: response.sizeBytes ?? null
  };
}

export function attachFieldHandoverEvidenceFile(
  id: string,
  itemId: string,
  input: AttachFieldHandoverEvidenceFileInput
) {
  return apiFetch<FieldHandoverEvidenceItem>(
    `/field/handover/work-orders/${encodeURIComponent(id)}/evidence/${encodeURIComponent(itemId)}/files`,
    {
      body: JSON.stringify(input),
      method: "POST"
    }
  );
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
