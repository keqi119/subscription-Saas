import { FieldEvidenceVideoUploadStatus } from "@prisma/client";

export const FIELD_VIDEO_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const MAX_FIELD_VIDEO_SIZE_BYTES = 300 * 1024 * 1024;
export const FIELD_VIDEO_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const FIELD_VIDEO_FINALIZE_LEASE_MS = 5 * 60 * 1000;
export const MAX_FIELD_VIDEO_PARTS = 38;

export const FIELD_VIDEO_LIVE_STATUSES: readonly FieldEvidenceVideoUploadStatus[] = [
  FieldEvidenceVideoUploadStatus.UPLOADING,
  FieldEvidenceVideoUploadStatus.FINALIZE_QUEUED,
  FieldEvidenceVideoUploadStatus.OSS_COMPLETING,
  FieldEvidenceVideoUploadStatus.OBJECT_READY,
  FieldEvidenceVideoUploadStatus.PROCESSING,
  FieldEvidenceVideoUploadStatus.RETRYABLE_FAILED
] as const;

export const FIELD_VIDEO_TERMINAL_STATUSES: readonly FieldEvidenceVideoUploadStatus[] = [
  FieldEvidenceVideoUploadStatus.VALIDATION_FAILED,
  FieldEvidenceVideoUploadStatus.COMPLETED,
  FieldEvidenceVideoUploadStatus.CANCELLED,
  FieldEvidenceVideoUploadStatus.EXPIRED
] as const;
