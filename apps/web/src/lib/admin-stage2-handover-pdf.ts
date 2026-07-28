import { API_BASE_URL, apiFetch } from "./api";

export interface Stage2HandoverPdfArtifact {
  artifactId?: null | string;
  documentNo?: null | string;
  downloadUrl?: null | string;
  fileName?: null | string;
  fileSize?: null | number;
  generatedAt?: null | string;
  orderNo?: null | string;
  status?: "GENERATED" | "NOT_GENERATED" | string;
  workOrderId?: string;
}

export function getStage2HandoverPdf(id: string) {
  return apiFetch<Stage2HandoverPdfArtifact>(`/handover-work-orders/${encodeURIComponent(id)}/pdf`);
}

export function generateStage2HandoverPdf(id: string) {
  return apiFetch<Stage2HandoverPdfArtifact>(`/handover-work-orders/${encodeURIComponent(id)}/pdf`, {
    method: "POST"
  });
}

export function buildAdminStage2HandoverPdfUrl(path?: null | string) {
  if (!path) {
    return null;
  }
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalized = path.startsWith("/api/") ? path.slice(4) : path;
  return `${API_BASE_URL}${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

export function buildAdminStage2HandoverPdfDownloadUrl(id: string) {
  return buildAdminStage2HandoverPdfUrl(
    `/handover-work-orders/${encodeURIComponent(id)}/pdf/download`
  )!;
}
