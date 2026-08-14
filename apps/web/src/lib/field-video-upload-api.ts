import { API_BASE_URL, ApiError, apiFetch } from "./api";

const PART_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const PUBLIC_STATUSES = new Set([
  "UPLOADING",
  "FINALIZE_QUEUED",
  "OSS_COMPLETING",
  "OBJECT_READY",
  "PROCESSING",
  "RETRYABLE_FAILED",
  "VALIDATION_FAILED",
  "COMPLETED",
  "CANCELLED",
  "EXPIRED"
]);

export interface CreateFieldVideoUploadSessionInput {
  fileName: string;
  fingerprintSha256: string;
  lastModifiedMs: number;
  mimeType: string;
  replaceEvidenceFileId?: string;
  sizeBytes: number;
}

export interface FieldVideoUploadSession {
  chunkSizeBytes: number;
  completedPartNumbers: number[];
  evidenceItemId: string;
  evidenceTitle: string;
  expiresAt: string;
  failure?: { code: string; message: string };
  fileName: string;
  sessionId: string;
  sizeBytes: number;
  status: string;
  totalParts: number;
  uploadedBytes: number;
  workOrderId: string;
}

export interface FieldVideoUploadedPart {
  completedAt: string;
  partNumber: number;
  sizeBytes: number;
}

export interface UploadFieldVideoPartInput {
  blob: Blob;
  evidenceItemId: string;
  onProgress?: (progress: { loadedBytes: number; totalBytes: number }) => void;
  partNumber: number;
  sessionId: string;
  sha256: string;
  signal?: AbortSignal;
  workOrderId: string;
}

export async function createFieldVideoUploadSession(
  workOrderId: string,
  evidenceItemId: string,
  input: CreateFieldVideoUploadSessionInput
) {
  const value = await apiFetch<unknown>(sessionCollectionPath(workOrderId, evidenceItemId), {
    body: JSON.stringify(input),
    method: "POST"
  });
  return parseSession(value);
}

export async function getFieldVideoUploadSession(
  workOrderId: string,
  evidenceItemId: string,
  sessionId: string
) {
  return parseSession(await apiFetch<unknown>(sessionPath(workOrderId, evidenceItemId, sessionId)));
}

export async function listActiveFieldVideoUploadSessions() {
  const value = await apiFetch<unknown>("/field/handover/video-upload-sessions/active");
  if (!Array.isArray(value)) {
    throw new Error("VIDEO_UPLOAD_RESPONSE_INVALID");
  }
  return value.map(parseSession);
}

export async function completeFieldVideoUploadSession(
  workOrderId: string,
  evidenceItemId: string,
  sessionId: string
) {
  return parseSession(
    await apiFetch<unknown>(`${sessionPath(workOrderId, evidenceItemId, sessionId)}/complete`, {
      method: "POST"
    })
  );
}

export async function retryFieldVideoUploadSession(
  workOrderId: string,
  evidenceItemId: string,
  sessionId: string
) {
  return parseSession(
    await apiFetch<unknown>(`${sessionPath(workOrderId, evidenceItemId, sessionId)}/retry`, {
      method: "POST"
    })
  );
}

export async function cancelFieldVideoUploadSession(
  workOrderId: string,
  evidenceItemId: string,
  sessionId: string
) {
  return parseSession(
    await apiFetch<unknown>(sessionPath(workOrderId, evidenceItemId, sessionId), {
      method: "DELETE"
    })
  );
}

export function uploadFieldVideoPart(input: UploadFieldVideoPartInput) {
  return new Promise<FieldVideoUploadedPart>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.upload.onprogress = (event) => {
      input.onProgress?.({
        loadedBytes: Math.min(input.blob.size, Math.max(0, event.loaded)),
        totalBytes: input.blob.size
      });
    };
    xhr.onload = () => settlePart(xhr, resolve, reject);
    xhr.onerror = () => reject(new ApiError("分片上传失败，请检查网络后重试。", 0));
    xhr.ontimeout = () => reject(new ApiError("分片上传超时，请稍后重试。", 0));
    xhr.onabort = () => reject(new ApiError("分片上传已暂停。", 0, "VIDEO_UPLOAD_PAUSED"));
    xhr.onloadend = () => input.signal?.removeEventListener("abort", abort);
    xhr.open(
      "POST",
      `${API_BASE_URL}${sessionPath(input.workOrderId, input.evidenceItemId, input.sessionId)}/parts/${input.partNumber}`
    );
    xhr.withCredentials = true;
    xhr.timeout = PART_UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("X-Part-SHA256", input.sha256);
    if (input.signal?.aborted) {
      reject(new ApiError("分片上传已暂停。", 0, "VIDEO_UPLOAD_PAUSED"));
      return;
    }
    input.signal?.addEventListener("abort", abort, { once: true });
    const form = new FormData();
    form.append("file", input.blob, `part-${input.partNumber}.bin`);
    xhr.send(form);
  });
}

function settlePart(
  xhr: XMLHttpRequest,
  resolve: (value: FieldVideoUploadedPart) => void,
  reject: (reason: ApiError | Error) => void
) {
  let body: unknown;
  try {
    body = JSON.parse(xhr.responseText);
  } catch {
    body = null;
  }
  if (xhr.status < 200 || xhr.status >= 300) {
    const error = asRecord(body);
    reject(
      new ApiError(
        typeof error?.message === "string" ? error.message : "分片上传失败，请稍后重试。",
        xhr.status,
        typeof error?.code === "string" ? error.code : undefined
      )
    );
    return;
  }
  const record = asRecord(body);
  if (
    !record ||
    typeof record.completedAt !== "string" ||
    !isPositiveInteger(record.partNumber) ||
    !isPositiveInteger(record.sizeBytes)
  ) {
    reject(new Error("VIDEO_UPLOAD_PART_RESPONSE_INVALID"));
    return;
  }
  resolve({
    completedAt: record.completedAt,
    partNumber: record.partNumber,
    sizeBytes: record.sizeBytes
  });
}

function parseSession(value: unknown): FieldVideoUploadSession {
  const record = asRecord(value);
  if (
    !record ||
    !isPositiveInteger(record.chunkSizeBytes) ||
    !Array.isArray(record.completedPartNumbers) ||
    !record.completedPartNumbers.every(isPositiveInteger) ||
    typeof record.evidenceItemId !== "string" ||
    typeof record.evidenceTitle !== "string" ||
    typeof record.expiresAt !== "string" ||
    typeof record.fileName !== "string" ||
    typeof record.sessionId !== "string" ||
    !isPositiveInteger(record.sizeBytes) ||
    typeof record.status !== "string" ||
    !PUBLIC_STATUSES.has(record.status) ||
    !isPositiveInteger(record.totalParts) ||
    !isNonNegativeInteger(record.uploadedBytes) ||
    typeof record.workOrderId !== "string"
  ) {
    throw new Error("VIDEO_UPLOAD_RESPONSE_INVALID");
  }
  const failure = asRecord(record.failure);
  return {
    chunkSizeBytes: record.chunkSizeBytes,
    completedPartNumbers: [...record.completedPartNumbers],
    evidenceItemId: record.evidenceItemId,
    evidenceTitle: record.evidenceTitle,
    expiresAt: record.expiresAt,
    failure:
      failure && typeof failure.code === "string" && typeof failure.message === "string"
        ? { code: failure.code, message: failure.message }
        : undefined,
    fileName: record.fileName,
    sessionId: record.sessionId,
    sizeBytes: record.sizeBytes,
    status: record.status,
    totalParts: record.totalParts,
    uploadedBytes: record.uploadedBytes,
    workOrderId: record.workOrderId
  };
}

function sessionCollectionPath(workOrderId: string, evidenceItemId: string) {
  return `/field/handover/work-orders/${encodeURIComponent(workOrderId)}/evidence/${encodeURIComponent(evidenceItemId)}/video-upload-sessions`;
}

function sessionPath(workOrderId: string, evidenceItemId: string, sessionId: string) {
  return `${sessionCollectionPath(workOrderId, evidenceItemId)}/${encodeURIComponent(sessionId)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
