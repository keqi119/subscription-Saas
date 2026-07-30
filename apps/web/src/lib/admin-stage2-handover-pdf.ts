import { API_BASE_URL, apiFetch } from "./api";

export interface Stage2HandoverPdfArtifact {
  archiveStatus?: null | string;
  artifactId?: null | string;
  documentNo?: null | string;
  downloadUrl?: null | string;
  fileName?: null | string;
  fileSize?: null | number;
  generatedAt?: null | string;
  handoverStatus?: null | string;
  orderNo?: null | string;
  signedArtifactAvailable?: boolean;
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

export function buildAdminStage2HandoverSignedPdfDownloadUrl(id: string) {
  return buildAdminStage2HandoverPdfUrl(
    `/handover-work-orders/${encodeURIComponent(id)}/esign/signed-document/download`
  )!;
}

export function getAdminStage2HandoverDocumentDownload(input: {
  archiveStatus?: null | string;
  handoverStatus?: null | string;
  signedArtifactAvailable?: boolean;
  sourceDownloadUrl?: null | string;
  workOrderId: string;
}) {
  if (
    input.archiveStatus === "ARCHIVED" &&
    input.handoverStatus === "ARCHIVED" &&
    input.signedArtifactAvailable === true
  ) {
    return {
      kind: "SIGNED" as const,
      label: "下载已签署 PDF",
      url: buildAdminStage2HandoverSignedPdfDownloadUrl(input.workOrderId)
    };
  }

  const sourceUrl = buildAdminStage2HandoverPdfUrl(input.sourceDownloadUrl);
  return sourceUrl
    ? {
        kind: "SOURCE" as const,
        label: "查看待签原件",
        url: sourceUrl
      }
    : null;
}
