import {
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus
} from "@prisma/client";

export interface Stage2HandoverArchiveState {
  archiveStatus: DeliveryHandoverArchiveStatus | null;
  signedDocumentFileId: string | null;
  signedObjectKey: string | null;
  signedPdfHash: string | null;
  status: DeliveryHandoverStatus | null;
}

export interface CompleteStage2HandoverArchiveState
  extends Stage2HandoverArchiveState {
  archiveStatus: typeof DeliveryHandoverArchiveStatus.ARCHIVED;
  signedDocumentFileId: string;
  signedObjectKey: string;
  signedPdfHash: string;
  status: typeof DeliveryHandoverStatus.ARCHIVED;
}

export function hasCompleteStage2HandoverArchive(
  handover: Stage2HandoverArchiveState | null | undefined
): handover is CompleteStage2HandoverArchiveState {
  return Boolean(
    handover?.archiveStatus === DeliveryHandoverArchiveStatus.ARCHIVED &&
      handover.status === DeliveryHandoverStatus.ARCHIVED &&
      hasText(handover.signedDocumentFileId) &&
      hasText(handover.signedObjectKey) &&
      isSha256Digest(handover.signedPdfHash)
  );
}

export function hasAuthoritativeStage2HandoverRelation<T>(
  handover: T | null | undefined
): handover is T {
  return handover != null;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
