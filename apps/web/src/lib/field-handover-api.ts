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
  customer?: FieldHandoverCustomerSummary | null;
  deliveryLocation?: string | null;
  evidenceProgress?: FieldHandoverEvidenceProgress | null;
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

export interface FieldHandoverEvidenceItem {
  fileCount?: number | null;
  id?: string | null;
  isRequired?: boolean | null;
  reviewStatus?: string | null;
  status?: string | null;
  title?: string | null;
}

export interface FieldHandoverFieldFacts {
  deliveryLocation?: string | null;
  energyLevelText?: string | null;
  fieldNotes?: string | null;
  fuelLevelText?: string | null;
  handoverMileageKm?: number | null;
  scheduledAt?: string | null;
}

export interface FieldHandoverWorkOrderDetail extends FieldHandoverWorkOrderListItem {
  evidenceChecklist?: FieldHandoverEvidenceChecklist | null;
  fieldFacts?: FieldHandoverFieldFacts | null;
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
