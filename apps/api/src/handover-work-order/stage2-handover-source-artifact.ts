import {
  ContractStatus,
  DeliveryHandoverStatus
} from "@prisma/client";

export const STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION = 1;

export interface Stage2SourceArtifactBinding {
  artifactVersion: number;
  contract: Record<string, unknown>;
  fileObject: Record<string, unknown>;
  manifestHash: string;
  sourceObjectKey: string;
  sourcePdfHash: string;
}

export interface Stage2SourceArtifactBindingInput {
  allowedContractStatuses?: readonly ContractStatus[];
  allowedHandoverStatuses?: readonly DeliveryHandoverStatus[];
  expectedCustomerId?: string | null;
  expectedHandoverId: string;
  expectedManifestHash: string;
  expectedOrderId: string;
  expectedWorkOrderId: string;
  fileObject: unknown;
  handover: unknown;
  maxSizeBytes: number;
}

export function hasStage2SourceArtifactState(handover: unknown) {
  const source = asRecord(handover);
  if (!source) {
    return false;
  }
  return (
    readString(source, "handoverContractId") !== null ||
    readString(source, "sourceDocumentFileId") !== null ||
    readString(source, "sourceObjectKey") !== null ||
    readString(source, "sourcePdfHash") !== null ||
    readString(source, "manifestHash") !== null ||
    readString(source, "status") === DeliveryHandoverStatus.SOURCE_GENERATED
  );
}

export function validateStage2SourceArtifactBinding(
  input: Stage2SourceArtifactBindingInput
): Stage2SourceArtifactBinding | null {
  const handover = asRecord(input.handover);
  const fileObject = asRecord(input.fileObject);
  const expectedManifestHash = normalizeSha256(input.expectedManifestHash);
  if (!handover || !fileObject || !expectedManifestHash) {
    return null;
  }

  const artifactVersion = readPositiveInteger(handover, "artifactVersion");
  const handoverId = readString(handover, "id");
  const orderId = readString(handover, "orderId");
  const contractId = readString(handover, "handoverContractId");
  const fileId = readString(handover, "sourceDocumentFileId");
  const sourceObjectKey = readString(handover, "sourceObjectKey");
  const sourcePdfHash = normalizeSha256(
    readString(handover, "sourcePdfHash")
  );
  const manifestHash = normalizeSha256(readString(handover, "manifestHash"));
  const contract = asRecord(handover.handoverContract);
  const contractSnapshot = asRecord(contract?.contractSnapshot);
  const evidencePackage = asRecord(contractSnapshot?.evidencePackage);
  const artifact = asRecord(
    contractSnapshot?.stage2HandoverPdfArtifact
  );
  const fileSize = toSafeInteger(fileObject.sizeBytes);

  if (
    artifactVersion !== STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION ||
    handoverId !== input.expectedHandoverId ||
    orderId !== input.expectedOrderId ||
    !(
      input.allowedHandoverStatuses ?? [
        DeliveryHandoverStatus.SOURCE_GENERATED
      ]
    ).includes(readString(handover, "status") as DeliveryHandoverStatus) ||
    manifestHash !== expectedManifestHash ||
    !sourcePdfHash ||
    !contractId ||
    !fileId ||
    !sourceObjectKey ||
    !contract ||
    readString(contract, "id") !== contractId ||
    readUnknown(contract, "deletedAt") !== null ||
    !(
      input.allowedContractStatuses ?? [ContractStatus.GENERATED]
    ).includes(readString(contract, "status") as ContractStatus) ||
    readString(contract, "fileId") !== fileId ||
    readString(contract, "orderId") !== input.expectedOrderId ||
    (
      input.expectedCustomerId !== undefined &&
      input.expectedCustomerId !== null &&
      readString(contract, "customerId") !== input.expectedCustomerId
    ) ||
    !contractSnapshot ||
    readString(contractSnapshot, "workOrderId") !==
      input.expectedWorkOrderId ||
    readString(contractSnapshot, "handoverId") !== input.expectedHandoverId ||
    readString(contractSnapshot, "orderId") !== input.expectedOrderId ||
    readString(contractSnapshot, "fileId") !== fileId ||
    normalizeSha256(readString(evidencePackage, "manifestHash")) !==
      expectedManifestHash ||
    readPositiveInteger(artifact, "artifactVersion") !== artifactVersion ||
    readString(artifact, "fileId") !== fileId ||
    normalizeSha256(readString(artifact, "sourcePdfHash")) !== sourcePdfHash ||
    readString(fileObject, "id") !== fileId ||
    !readString(fileObject, "bucket") ||
    readString(fileObject, "objectKey") !== sourceObjectKey ||
    readString(fileObject, "mimeType")?.trim().toLowerCase() !==
      "application/pdf" ||
    fileSize === null ||
    fileSize <= 0 ||
    fileSize > input.maxSizeBytes
  ) {
    return null;
  }

  return {
    artifactVersion,
    contract,
    fileObject,
    manifestHash,
    sourceObjectKey,
    sourcePdfHash
  };
}

export function normalizeStage2Sha256(value: unknown) {
  return normalizeSha256(value);
}

function asRecord(value: unknown): null | Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeSha256(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const digest = value.trim().toLowerCase().replace(/^sha256:/, "");
  return /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

function readPositiveInteger(
  record: null | Record<string, unknown>,
  key: string
) {
  const value = record?.[key];
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : null;
}

function readString(
  record: null | Record<string, unknown>,
  key: string
) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readUnknown(
  record: null | Record<string, unknown>,
  key: string
) {
  return record?.[key] ?? null;
}

function toSafeInteger(value: unknown) {
  const numberValue =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "number"
        ? value
        : Number.NaN;
  return Number.isSafeInteger(numberValue) ? numberValue : null;
}
