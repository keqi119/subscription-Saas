import { createHash } from "node:crypto";

export const STAGE2_EVIDENCE_MANIFEST_SCHEMA_VERSION = 1;
export const STAGE2_EVIDENCE_ARTIFACT_NOT_READY = "STAGE2_EVIDENCE_ARTIFACT_NOT_READY";
export const STAGE2_EVIDENCE_CONFIRMATION_TEXT =
  "本人已查看本次交接证据包所列全部照片和视频，并确认其反映的车辆交接状态。证据包及文件清单构成本车辆交接确认书不可分割的组成部分。";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const EVIDENCE_TYPE_ORDER = [
  "CUSTOMER_WITH_VEHICLE_FRONT",
  "VEHICLE_FRONT",
  "VEHICLE_REAR",
  "VIN_OR_FRAME_NUMBER",
  "ODOMETER_DASHBOARD",
  "INTERIOR_REAR",
  "INTERIOR_FRONT",
  "WALKAROUND_VIDEO",
  "WHEEL_CLOSEUP_FRONT_LEFT",
  "WHEEL_CLOSEUP_FRONT_RIGHT",
  "WHEEL_CLOSEUP_REAR_LEFT",
  "WHEEL_CLOSEUP_REAR_RIGHT",
  "DAMAGE_STATIC_CLOSEUP",
  "NO_VISIBLE_DAMAGE_DECLARATION"
] as const;
const EVIDENCE_TYPE_INDEX = new Map<string, number>(
  EVIDENCE_TYPE_ORDER.map((value, index) => [value, index])
);

export interface DeliveryHandoverEvidenceManifestFile {
  artifactVersion: number;
  derivativeFileIds: string[];
  detectedMimeType: string;
  evidenceFileId: string;
  evidenceItemId: string;
  evidenceTitle: string;
  evidenceType: string;
  fileId: string;
  mediaType: "PHOTO" | "VIDEO";
  originalName: string;
  processedAt: string;
  sourceSha256: string;
  sourceSizeBytes: number;
  uploadedAt: string;
  videoDurationMs: number | null;
}

export interface DeliveryHandoverEvidenceManifest {
  evidencePackageId: string;
  files: DeliveryHandoverEvidenceManifestFile[];
  handoverId: string;
  orderId: string;
  schemaVersion: number;
  workOrderId: string;
}

export interface DeliveryHandoverEvidencePackage {
  canonicalJson: string;
  manifest: DeliveryHandoverEvidenceManifest;
  manifestHash: string;
  stats: {
    fileCount: number;
    photoCount: number;
    videoCount: number;
  };
}

export interface BuildDeliveryHandoverEvidencePackageInput {
  evidenceChecklist: unknown;
  handoverId: string;
  orderId: string;
  workOrderId: string;
}

export function buildDeliveryHandoverEvidencePackage(
  input: BuildDeliveryHandoverEvidencePackageInput
): DeliveryHandoverEvidencePackage {
  const checklist = asRecord(input.evidenceChecklist);
  const items = Array.isArray(checklist?.items) ? checklist.items.filter(isPlainObject) : [];
  const files = items.flatMap((item) => normalizeEvidenceFiles(item)).sort(compareManifestFiles);
  const manifest: DeliveryHandoverEvidenceManifest = {
    evidencePackageId: requireIdentifier(input.handoverId, "handoverId"),
    files,
    handoverId: requireIdentifier(input.handoverId, "handoverId"),
    orderId: requireIdentifier(input.orderId, "orderId"),
    schemaVersion: STAGE2_EVIDENCE_MANIFEST_SCHEMA_VERSION,
    workOrderId: requireIdentifier(input.workOrderId, "workOrderId")
  };
  const canonicalJson = stableSerialize(manifest);
  const manifestHash = `sha256:${createHash("sha256").update(canonicalJson, "utf8").digest("hex")}`;

  return {
    canonicalJson,
    manifest,
    manifestHash,
    stats: {
      fileCount: files.length,
      photoCount: files.filter((file) => file.mediaType === "PHOTO").length,
      videoCount: files.filter((file) => file.mediaType === "VIDEO").length
    }
  };
}

function normalizeEvidenceFiles(item: Record<string, unknown>) {
  const evidenceType = requireString(item.evidenceType, "evidenceType");
  const evidenceItemId = requireString(item.id, "evidenceItemId");
  const evidenceTitle = requireString(item.title, "evidenceTitle");
  const files = Array.isArray(item.files) ? item.files.filter(isPlainObject) : [];

  return files.map((file): DeliveryHandoverEvidenceManifestFile => {
    const linkedFile = asRecord(file.file);
    const metadata = asRecord(file.metadata);
    const evidenceFileId = requireString(file.id, "evidenceFileId");
    const mediaType = requireMediaType(file.mediaType, evidenceFileId);
    const sourceSha256 = requireString(metadata?.sourceSha256, `${evidenceFileId}.sourceSha256`);
    if (!SHA256_PATTERN.test(sourceSha256)) {
      notReady(`${evidenceFileId} source SHA-256 is invalid`);
    }
    if (metadata?.processingStatus !== "READY") {
      notReady(`${evidenceFileId} processing status is not READY`);
    }

    const derivativeFileIds = mediaType === "PHOTO"
      ? [requireString(metadata?.photoPreviewFileId, `${evidenceFileId}.photoPreviewFileId`)]
      : requireVideoFrames(metadata, evidenceType, evidenceFileId);
    const videoDurationMs = mediaType === "VIDEO"
      ? requirePositiveNumber(metadata?.videoDurationMs, `${evidenceFileId}.videoDurationMs`)
      : null;

    return {
      artifactVersion: requirePositiveInteger(metadata?.artifactVersion, `${evidenceFileId}.artifactVersion`),
      derivativeFileIds,
      detectedMimeType: requireString(metadata?.detectedMimeType, `${evidenceFileId}.detectedMimeType`),
      evidenceFileId,
      evidenceItemId,
      evidenceTitle,
      evidenceType,
      fileId: requireString(file.fileId ?? linkedFile?.id, `${evidenceFileId}.fileId`),
      mediaType,
      originalName: requireString(linkedFile?.originalName, `${evidenceFileId}.originalName`),
      processedAt: requireIsoDate(metadata?.processedAt, `${evidenceFileId}.processedAt`),
      sourceSha256,
      sourceSizeBytes: requirePositiveInteger(metadata?.sourceSizeBytes, `${evidenceFileId}.sourceSizeBytes`),
      uploadedAt: requireIsoDate(file.uploadedAt, `${evidenceFileId}.uploadedAt`),
      videoDurationMs
    };
  });
}

function requireVideoFrames(
  metadata: null | Record<string, unknown>,
  evidenceType: string,
  evidenceFileId: string
) {
  const frameIds = Array.isArray(metadata?.videoFrameFileIds)
    ? metadata.videoFrameFileIds.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
  const requiredCount = evidenceType === "WALKAROUND_VIDEO" ? 4 : 2;
  if (frameIds.length !== requiredCount || new Set(frameIds).size !== requiredCount) {
    notReady(`${evidenceFileId} requires ${requiredCount} distinct video keyframes`);
  }
  return frameIds;
}

function compareManifestFiles(
  left: DeliveryHandoverEvidenceManifestFile,
  right: DeliveryHandoverEvidenceManifestFile
) {
  const typeDifference =
    (EVIDENCE_TYPE_INDEX.get(left.evidenceType) ?? Number.MAX_SAFE_INTEGER) -
    (EVIDENCE_TYPE_INDEX.get(right.evidenceType) ?? Number.MAX_SAFE_INTEGER);
  if (typeDifference !== 0) {
    return typeDifference;
  }
  const uploadedDifference = left.uploadedAt.localeCompare(right.uploadedAt);
  return uploadedDifference !== 0
    ? uploadedDifference
    : left.evidenceFileId.localeCompare(right.evidenceFileId);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableSerialize(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireMediaType(value: unknown, evidenceFileId: string): "PHOTO" | "VIDEO" {
  if (value === "PHOTO" || value === "VIDEO") {
    return value;
  }
  return notReady(`${evidenceFileId} media type is invalid`);
}

function requireIdentifier(value: unknown, key: string) {
  return requireString(value, key);
}

function requireString(value: unknown, key: string) {
  if (typeof value !== "string" || !value.trim()) {
    return notReady(`${key} is missing`);
  }
  return value.trim();
}

function requirePositiveInteger(value: unknown, key: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return notReady(`${key} is invalid`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, key: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return notReady(`${key} is invalid`);
  }
  return value;
}

function requireIsoDate(value: unknown, key: string) {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return notReady(`${key} is invalid`);
  }
  return date.toISOString();
}

function notReady(message: string): never {
  throw new Error(`${STAGE2_EVIDENCE_ARTIFACT_NOT_READY}: ${message}`);
}

function asRecord(value: unknown) {
  return isPlainObject(value) ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
