import { FieldEvidenceVideoUploadStatus } from "@prisma/client";

export interface FieldVideoUploadPartSnapshot {
  completedAt: Date;
  internal: { ossEtag: string };
  partNumber: number;
  sha256: string;
  sizeBytes: number;
}

export interface FieldVideoUploadSessionSnapshot {
  cancelledAt: Date | null;
  chunkSizeBytes: number;
  completedAt: Date | null;
  createdAt: Date;
  createdBySessionId: string | null;
  evidenceItemId: string;
  evidenceTitle: string;
  expiresAt: Date;
  failureCode: string | null;
  failureMessage: string | null;
  fingerprintHash: string;
  id: string;
  internal: {
    objectEtag: string | null;
    objectKey: string | null;
    ossUploadId: string | null;
  };
  lastModifiedMs: number;
  leaseExpiresAt: Date | null;
  leaseOwner: string | null;
  mimeType: string;
  objectCompletedAt: Date | null;
  originalName: string;
  parts: FieldVideoUploadPartSnapshot[];
  processingCompletedAt: Date | null;
  replaceEvidenceFileId: string | null;
  resumeStage: FieldEvidenceVideoUploadStatus | null;
  retryCount: number;
  sizeBytes: number;
  status: FieldEvidenceVideoUploadStatus;
  totalParts: number;
  updatedAt: Date;
  version: number;
  workOrderId: string;
}

export type FieldVideoUploadPublicStatus = `${FieldEvidenceVideoUploadStatus}`;

export interface FieldVideoUploadSessionPublicSnapshot {
  chunkSizeBytes: number;
  completedPartNumbers: number[];
  evidenceItemId: string;
  evidenceTitle: string;
  expiresAt: string;
  failure?: { code: string; message: string };
  fileName: string;
  sessionId: string;
  sizeBytes: number;
  status: FieldVideoUploadPublicStatus;
  totalParts: number;
  uploadedBytes: number;
  workOrderId: string;
}

export interface DiskUploadedFile {
  destination: string;
  encoding: string;
  fieldname: string;
  filename: string;
  mimetype: string;
  originalname: string;
  path: string;
  size: number;
}

export function toPublicFieldVideoUploadSnapshot(
  session: FieldVideoUploadSessionSnapshot
): FieldVideoUploadSessionPublicSnapshot {
  const completedPartNumbers = session.parts.map((part) => part.partNumber);
  return {
    chunkSizeBytes: session.chunkSizeBytes,
    completedPartNumbers,
    evidenceItemId: session.evidenceItemId,
    evidenceTitle: session.evidenceTitle,
    expiresAt: session.expiresAt.toISOString(),
    failure:
      session.failureCode && session.failureMessage
        ? { code: session.failureCode, message: session.failureMessage }
        : undefined,
    fileName: session.originalName,
    sessionId: session.id,
    sizeBytes: session.sizeBytes,
    status: session.status,
    totalParts: session.totalParts,
    uploadedBytes: session.parts.reduce((total, part) => total + part.sizeBytes, 0),
    workOrderId: session.workOrderId
  };
}
