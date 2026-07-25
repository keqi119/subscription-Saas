export const MAX_FIELD_PHOTO_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_FIELD_VIDEO_SIZE_BYTES = 300 * 1024 * 1024;

export type FieldEvidenceMediaType = "PHOTO" | "VIDEO";

export interface FieldEvidenceUploadInputContract {
  accept: string;
  capture?: "environment";
  key: "library" | "photo-capture" | "video-capture";
  label: string;
  multiple: boolean;
}

const SAFE_PHOTO_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp"
]);

const SAFE_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v"
]);

export function resolveFieldEvidenceMediaType(file: File): FieldEvidenceMediaType | null {
  const mimeType = file.type.trim().toLowerCase();
  if (mimeType && mimeType !== "application/octet-stream") {
    return SAFE_PHOTO_MIME_TYPES.has(mimeType)
      ? "PHOTO"
      : SAFE_VIDEO_MIME_TYPES.has(mimeType)
        ? "VIDEO"
        : null;
  }
  if (/\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)) {
    return "PHOTO";
  }
  if (/\.(m4v|mov|mp4|webm)$/i.test(file.name)) {
    return "VIDEO";
  }
  return null;
}

export function validateFieldEvidenceFile(
  allowedMediaTypes: FieldEvidenceMediaType[],
  file: File
): string | null {
  const mediaType = resolveFieldEvidenceMediaType(file);
  if (!mediaType || !allowedMediaTypes.includes(mediaType)) {
    return "请选择符合要求的图片或视频";
  }
  if (mediaType === "PHOTO" && file.size > MAX_FIELD_PHOTO_SIZE_BYTES) {
    return `图片 ${file.name} 超过 10MB`;
  }
  if (mediaType === "VIDEO" && file.size > MAX_FIELD_VIDEO_SIZE_BYTES) {
    return `视频 ${file.name} 超过 300MB`;
  }
  return null;
}

export function buildFieldEvidenceUploadInputContracts(
  allowedMediaTypes: FieldEvidenceMediaType[],
  allowsMultiple: boolean
): FieldEvidenceUploadInputContract[] {
  const contracts: FieldEvidenceUploadInputContract[] = [];
  if (allowedMediaTypes.includes("PHOTO")) {
    contracts.push({
      accept: "image/*",
      capture: "environment",
      key: "photo-capture",
      label: "现场拍照",
      multiple: false
    });
  }
  if (allowedMediaTypes.includes("VIDEO")) {
    contracts.push({
      accept: "video/*",
      capture: "environment",
      key: "video-capture",
      label: "现场录像",
      multiple: false
    });
  }
  if (allowedMediaTypes.length > 0) {
    contracts.push({
      accept: [
        allowedMediaTypes.includes("PHOTO") ? "image/*" : null,
        allowedMediaTypes.includes("VIDEO") ? "video/*" : null
      ].filter(Boolean).join(","),
      key: "library",
      label:
        allowedMediaTypes.length === 1 && allowedMediaTypes[0] === "PHOTO"
          ? "从相册选择"
          : "从相册/文件选择",
      multiple: allowsMultiple
    });
  }
  return contracts;
}

export function formatUploadBytes(value: number): string {
  if (value < 1024) {
    return `${value}B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)}KB`;
  }
  return `${Math.round(value / (1024 * 1024))}MB`;
}
