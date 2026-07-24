import { PORTAL_API_BASE_URL, PortalApiError, portalApiFetch } from "./portal-api";

export interface PortalHandoverReviewCustomer {
  displayName?: string | null;
  mobileMasked?: string | null;
}

export interface PortalHandoverReviewVehicle {
  brand?: string | null;
  model?: string | null;
  plateMasked?: string | null;
  series?: string | null;
  vinSuffix?: string | null;
}

export interface PortalHandoverReviewEvidenceProgress {
  approved?: number | null;
  required?: number | null;
  total?: number | null;
  uploaded?: number | null;
}

export interface PortalHandoverReviewObjection {
  details?: string | null;
  objectedAt?: string | null;
  reason?: string | null;
}

export interface PortalHandoverSummary {
  archiveStatus?: string | null;
  archivedAt?: string | null;
  completedAt?: string | null;
  id?: string | null;
  status?: string | null;
}

export interface PortalHandoverReviewListItem {
  adminReviewStatus?: string | null;
  customer?: PortalHandoverReviewCustomer | null;
  customerConfirmedAt?: string | null;
  customerObjectedAt?: string | null;
  customerReviewStartedAt?: string | null;
  deliveryLocation?: string | null;
  evidenceProgress?: PortalHandoverReviewEvidenceProgress | null;
  fieldSubmittedAt?: string | null;
  handover?: PortalHandoverSummary | null;
  handoverId?: string | null;
  handoverType?: string | null;
  id: string;
  objection?: PortalHandoverReviewObjection | null;
  orderNo?: string | null;
  scheduledAt?: string | null;
  status?: string | null;
  vehicle?: PortalHandoverReviewVehicle | null;
}

export interface PortalHandoverReviewFieldFacts {
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

export interface PortalHandoverReviewEvidenceChecklist {
  blockingReasons?: string[];
  items?: PortalHandoverReviewEvidenceItem[];
  ready?: boolean;
}

export interface PortalHandoverReviewEvidenceItem {
  allowedMediaTypes?: string[];
  conditionKey?: string | null;
  conditionValue?: string | null;
  declaredNoDamage?: boolean | null;
  description?: string | null;
  evidenceType?: string | null;
  fileCount?: number | null;
  fileRequired?: boolean | null;
  files?: PortalHandoverReviewEvidenceFile[];
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

export interface PortalHandoverReviewEvidenceFile {
  displayName?: string | null;
  downloadUrl?: string | null;
  evidenceFileId?: string | null;
  file?: {
    id?: string | null;
    mimeType?: string | null;
    originalName?: string | null;
    sizeBytes?: number | string | null;
  } | null;
  fileId?: string | null;
  id?: string | null;
  mimeType?: string | null;
  mediaType?: string | null;
  previewAvailable?: boolean | null;
  previewUrl?: string | null;
  sizeBytes?: number | string | null;
  uploadedAt?: string | null;
}

export interface PortalHandoverReviewReadiness {
  blockingReasons?: string[];
  readyForDeliveryConfirmation?: boolean;
  readyForStage2ESign?: boolean;
  readyForStage2Pdf?: boolean;
  workOrderId?: string | null;
}

export interface PortalHandoverReviewHistoryItem {
  adminStatus?: string | null;
  attemptNo?: number | null;
  customerConfirmedAt?: string | null;
  customerObjectedAt?: string | null;
  customerObjectionDetails?: string | null;
  customerObjectionReason?: string | null;
  customerReviewStartedAt?: string | null;
  fieldSubmittedAt?: string | null;
  id?: string | null;
  sentBackToCustomerReviewAt?: string | null;
  status?: string | null;
}

export interface PortalHandoverReviewDetail extends PortalHandoverReviewListItem {
  evidenceChecklist?: PortalHandoverReviewEvidenceChecklist | null;
  fieldFacts?: PortalHandoverReviewFieldFacts | null;
  readiness?: PortalHandoverReviewReadiness | null;
  reviewHistory?: PortalHandoverReviewHistoryItem[];
}

export interface PortalHandoverReviewObjectionInput {
  details?: string | null;
  reason: string;
}

export function listPortalHandoverReviews() {
  return portalApiFetch<PortalHandoverReviewListItem[]>("/portal/handover-reviews");
}

export function getPortalHandoverReview(id: string) {
  return portalApiFetch<PortalHandoverReviewDetail>(`/portal/handover-reviews/${encodeURIComponent(id)}`);
}

export function confirmPortalHandoverReview(id: string, acknowledgement: boolean) {
  return portalApiFetch<PortalHandoverReviewDetail>(
    `/portal/handover-reviews/${encodeURIComponent(id)}/confirm`,
    {
      body: JSON.stringify({ acknowledgement }),
      method: "POST"
    }
  );
}

export function objectPortalHandoverReview(id: string, input: PortalHandoverReviewObjectionInput) {
  return portalApiFetch<PortalHandoverReviewDetail>(
    `/portal/handover-reviews/${encodeURIComponent(id)}/object`,
    {
      body: JSON.stringify({
        details: input.details ?? undefined,
        reason: input.reason
      }),
      method: "POST"
    }
  );
}

export function buildPortalHandoverReviewFileUrl(path: null | string | undefined) {
  if (!path) {
    return null;
  }
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalized = path.startsWith("/api/") ? path.slice(4) : path;
  return `${PORTAL_API_BASE_URL}${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

export function getPortalHandoverReviewErrorMessage(error: unknown) {
  if (!(error instanceof PortalApiError)) {
    return "操作失败，请稍后重试";
  }
  if (error.status === 401) {
    return "登录状态已过期，请重新登录";
  }
  if (error.status === 404 || error.status === 403) {
    return "交接确认事项不存在或已关闭";
  }
  if (error.status === 0 || error.status >= 500) {
    return "交接确认服务暂不可用，请稍后重试";
  }
  return error.message || "操作失败，请稍后重试";
}
