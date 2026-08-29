export type SubscriptionReturnUploadStatus =
  | "IDLE"
  | "READY"
  | "UPLOADING"
  | "SUCCEEDED"
  | "FAILED";

export interface SubscriptionReturnUploadState {
  error: string | null;
  file: File | null;
  progress: number;
  status: SubscriptionReturnUploadStatus;
}

export function initialSubscriptionReturnUploadState(): SubscriptionReturnUploadState {
  return { error: null, file: null, progress: 0, status: "IDLE" };
}

export function selectSubscriptionReturnFile(file: File): SubscriptionReturnUploadState {
  if (file.size <= 0 || file.size > 20 * 1024 * 1024) {
    return { error: "文件必须大于 0 且不超过 20MB。", file, progress: 0, status: "FAILED" };
  }
  if (!subscriptionReturnEvidenceType(file)) {
    return {
      error: "仅支持 JPEG、PNG、WebP、PDF 或 MP4 文件。",
      file,
      progress: 0,
      status: "FAILED"
    };
  }
  return { error: null, file, progress: 0, status: "READY" };
}

export function subscriptionReturnEvidenceType(file: File) {
  if (file.type === "application/pdf") return "DOCUMENT" as const;
  if (file.type === "video/mp4") return "VIDEO" as const;
  if (["image/jpeg", "image/png", "image/webp"].includes(file.type)) return "PHOTO" as const;
  return null;
}

export function uploadingSubscriptionReturnFile(
  state: SubscriptionReturnUploadState
): SubscriptionReturnUploadState {
  return state.file
    ? { ...state, error: null, progress: 20, status: "UPLOADING" }
    : { ...state, error: "请先选择文件。", status: "FAILED" };
}

export function completeSubscriptionReturnUpload(
  state: SubscriptionReturnUploadState
): SubscriptionReturnUploadState {
  return { ...state, error: null, progress: 100, status: "SUCCEEDED" };
}

export function failSubscriptionReturnUpload(
  state: SubscriptionReturnUploadState,
  error: string
): SubscriptionReturnUploadState {
  return { ...state, error, progress: 0, status: "FAILED" };
}
