import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import {
  CONTRACT_PDF_GENERATED_ARTIFACT_SOURCE,
  ContractPdfArtifactSlotCoordinateDiagnostic
} from "../contract/contract-pdf-artifact.types";
import {
  STAGE1_CONTRACT_PDF_REQUIRED_SLOT_IDS,
  STAGE1_CONTRACT_PDF_SIGNING_SLOT_DEFINITIONS
} from "../contract/contract-pdf-render-model";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";

export const CONTRACT_PDF_ARTIFACT_MISSING = "CONTRACT_PDF_ARTIFACT_MISSING";
export const CONTRACT_PDF_ARTIFACT_NOT_PDF = "CONTRACT_PDF_ARTIFACT_NOT_PDF";
export const CONTRACT_PDF_ARTIFACT_TOO_LARGE = "CONTRACT_PDF_ARTIFACT_TOO_LARGE";
export const CONTRACT_PDF_ARTIFACT_GENERATED_REQUIRED = "CONTRACT_PDF_ARTIFACT_GENERATED_REQUIRED";
export const CONTRACT_PDF_ARTIFACT_INVALID_OBJECT_KEY = "CONTRACT_PDF_ARTIFACT_INVALID_OBJECT_KEY";
export const CONTRACT_PDF_ARTIFACT_INVALID_SOURCE = "CONTRACT_PDF_ARTIFACT_INVALID_SOURCE";
export const CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID = "CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID";
export const CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_MISSING = "CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_MISSING";

const MAX_FADADA_PDF_BYTES = 20 * 1024 * 1024;

export type ContractPdfArtifactPurpose = "FADADA_UPLOAD";
export type ContractPdfArtifactSource = "CONTRACT_FILE" | "CONTRACT_VERSION_FILE" | "TEST_FIXTURE";

export interface ContractPdfArtifactPolicyOptions {
  enterpriseAutoSealEnabled?: boolean;
  fadadaEnabled?: boolean;
  maxBytes?: number;
  purpose?: ContractPdfArtifactPurpose;
  requireGeneratedContractArtifact?: boolean;
  requireStage1SlotCoordinates?: boolean;
  requireStage2SlotCoordinates?: boolean;
}

export interface Stage2HandoverPdfArtifactSlotCoordinate {
  coordinateSource: "PDFKIT_RENDERER";
  coordinateSystem: "FADADA_800_1131_TOP_LEFT";
  documentType: "DELIVERY_HANDOVER_CONFIRMATION";
  height: number;
  pageNumber: number;
  pdfPageHeight: number;
  pdfPageWidth: number;
  signingStage: "STAGE2_DELIVERY_HANDOVER";
  slotId: "STAGE2_HANDOVER_CUSTOMER" | "STAGE2_HANDOVER_PLATFORM";
  width: number;
  x: number;
  y: number;
}

export type ResolvedContractPdfArtifactSlotCoordinate =
  | ContractPdfArtifactSlotCoordinateDiagnostic
  | Stage2HandoverPdfArtifactSlotCoordinate;

export interface ContractPdfArtifactPreflightDiagnostics {
  enterpriseAutoSealEnabled: boolean;
  fadadaEnabled: boolean;
  generatedContractArtifact: boolean;
  maxBytes: number;
  purpose?: ContractPdfArtifactPurpose;
  slotCoordinates?: ResolvedContractPdfArtifactSlotCoordinate[];
  source: ContractPdfArtifactSource;
  stage1SlotCoordinatesVerified: boolean;
  stage2SlotCoordinatesVerified: boolean;
  textExtractionVerified: false;
}

export interface ContractPdfArtifact {
  buffer: Buffer;
  contentType: "application/pdf";
  fileName: string;
  objectKey?: string;
  preflight?: ContractPdfArtifactPreflightDiagnostics;
  size: number;
  slotCoordinates?: ResolvedContractPdfArtifactSlotCoordinate[];
  source: ContractPdfArtifactSource;
}

const contractArtifactInclude = {
  contractVersion: { select: { fileId: true } }
} satisfies Prisma.ContractInclude;

type ContractArtifactSource = Prisma.ContractGetPayload<{ include: typeof contractArtifactInclude }>;

interface ResolvedContractPdfArtifactPolicy {
  enterpriseAutoSealEnabled: boolean;
  fadadaEnabled: boolean;
  maxBytes: number;
  purpose?: ContractPdfArtifactPurpose;
  requireGeneratedContractArtifact: boolean;
  requireStage1SlotCoordinates: boolean;
  requireStage2SlotCoordinates: boolean;
  strictPdfMetadata: boolean;
}

@Injectable()
export class ContractPdfArtifactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService
  ) {}

  async getContractPdfArtifact(
    contractId: string,
    options: ContractPdfArtifactPolicyOptions = {}
  ): Promise<ContractPdfArtifact> {
    const policy = this.resolvePolicy(options);
    const contract = await this.prisma.contract.findFirst({
      include: contractArtifactInclude,
      where: { deletedAt: null, id: contractId }
    });

    if (!contract) {
      throw new Error(`${CONTRACT_PDF_ARTIFACT_MISSING}: contract not found`);
    }

    if (contract.fileId) {
      return this.readFileArtifact(contract, contract.fileId, "CONTRACT_FILE", policy);
    }
    if (contract.contractVersion.fileId) {
      if (policy.requireGeneratedContractArtifact) {
        throw new Error(
          `${CONTRACT_PDF_ARTIFACT_GENERATED_REQUIRED}: generated Contract.fileId artifact is required`
        );
      }
      return this.readFileArtifact(contract, contract.contractVersion.fileId, "CONTRACT_VERSION_FILE", policy);
    }
    if (policy.requireGeneratedContractArtifact) {
      throw new Error(`${CONTRACT_PDF_ARTIFACT_GENERATED_REQUIRED}: contract has no generated PDF artifact`);
    }
    if (this.canUseTestFixture(policy)) {
      return this.buildTestFixture(contract, policy);
    }

    throw new Error(`${CONTRACT_PDF_ARTIFACT_MISSING}: contract has no PDF file artifact`);
  }

  async preflightContractPdfArtifact(
    contractId: string,
    options: ContractPdfArtifactPolicyOptions = {}
  ): Promise<ContractPdfArtifact> {
    return this.getContractPdfArtifact(contractId, options);
  }

  private async readFileArtifact(
    contract: ContractArtifactSource,
    fileId: string,
    source: ContractPdfArtifactSource,
    policy: ResolvedContractPdfArtifactPolicy
  ): Promise<ContractPdfArtifact> {
    const fileObject = await this.prisma.fileObject.findUnique({ where: { id: fileId } });
    if (!fileObject) {
      throw new Error(`${CONTRACT_PDF_ARTIFACT_MISSING}: file object not found`);
    }

    assertArtifactSource({
      contractId: contract.id,
      fileName: fileObject.originalName,
      objectKey: fileObject.objectKey,
      policy,
      source
    });
    assertPdfMetadata(fileObject.originalName, fileObject.mimeType, policy);
    assertDeclaredSize(fileObject.sizeBytes, policy.maxBytes);

    const downloaded = await this.storageService.getObject(fileObject.bucket, fileObject.objectKey);
    const buffer = await streamToBuffer(downloaded.stream);
    assertPdfBuffer(buffer, policy.maxBytes);
    const generatedContractArtifact = isGeneratedContractPdfObjectKey(contract.id, fileObject.objectKey);
    const slotCoordinates = policy.requireStage2SlotCoordinates
      ? resolveStage2HandoverSlotCoordinates({
          contractSnapshot: contract.contractSnapshot,
          fileId,
          generatedContractArtifact,
          source
        })
      : resolveGeneratedContractSlotCoordinates({
          contractSnapshot: contract.contractSnapshot,
          fileId,
          generatedContractArtifact,
          objectKey: fileObject.objectKey,
          source
        });

    if (policy.requireStage1SlotCoordinates && !slotCoordinates) {
      throw new Error(
        `${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_MISSING}: generated Stage 1 slot coordinates are required`
      );
    }
    if (policy.requireStage2SlotCoordinates && !slotCoordinates) {
      throw new Error(
        `${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_MISSING}: generated Stage 2 slot coordinates are required`
      );
    }

    return {
      buffer,
      contentType: "application/pdf",
      fileName: fileObject.originalName,
      objectKey: fileObject.objectKey,
      preflight: buildPreflightDiagnostics(policy, source, generatedContractArtifact, slotCoordinates),
      size: buffer.length,
      ...(slotCoordinates ? { slotCoordinates } : {}),
      source
    };
  }

  private buildTestFixture(
    contract: ContractArtifactSource,
    policy: ResolvedContractPdfArtifactPolicy
  ): ContractPdfArtifact {
    const fileName = `${sanitizeFileName(contract.contractNo)}.pdf`;
    const body = [
      "%PDF-1.4",
      "1 0 obj",
      "<< /Type /Catalog /Pages 2 0 R >>",
      "endobj",
      "2 0 obj",
      "<< /Type /Pages /Count 0 >>",
      "endobj",
      `% Stage 10D-B2-A deterministic test fixture for ${contract.contractNo}`,
      "trailer",
      "<< /Root 1 0 R >>",
      "%%EOF",
      ""
    ].join("\n");
    const buffer = Buffer.from(body, "utf8");

    return {
      buffer,
      contentType: "application/pdf",
      fileName,
      preflight: buildPreflightDiagnostics(policy, "TEST_FIXTURE", false),
      size: buffer.length,
      source: "TEST_FIXTURE"
    };
  }

  private canUseTestFixture(policy: ResolvedContractPdfArtifactPolicy) {
    if (policy.fadadaEnabled || policy.requireGeneratedContractArtifact) {
      return false;
    }

    const explicit = (this.configService.get<string>("FADADA_TEST_PDF_ARTIFACT_ENABLED") ?? "").toLowerCase();
    return explicit === "true" || this.configService.get<string>("NODE_ENV") === "test";
  }

  private resolvePolicy(options: ContractPdfArtifactPolicyOptions): ResolvedContractPdfArtifactPolicy {
    const fadadaEnabled = options.fadadaEnabled ?? parseBoolean(this.configService.get<string>("FADADA_ENABLED"));
    const enterpriseAutoSealEnabled =
      options.enterpriseAutoSealEnabled ??
      parseBoolean(this.configService.get<string>("ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED"));
    const requireGeneratedContractArtifact =
      options.requireGeneratedContractArtifact ??
      (
        enterpriseAutoSealEnabled ||
        options.requireStage1SlotCoordinates === true ||
        options.requireStage2SlotCoordinates === true
      );
    const purpose = options.purpose ?? (fadadaEnabled ? "FADADA_UPLOAD" : undefined);
    const maxBytes = options.maxBytes ?? MAX_FADADA_PDF_BYTES;

    return {
      enterpriseAutoSealEnabled,
      fadadaEnabled,
      maxBytes,
      purpose,
      requireGeneratedContractArtifact,
      requireStage1SlotCoordinates: options.requireStage1SlotCoordinates === true,
      requireStage2SlotCoordinates: options.requireStage2SlotCoordinates === true,
      strictPdfMetadata:
        fadadaEnabled ||
        enterpriseAutoSealEnabled ||
        options.requireStage1SlotCoordinates === true ||
        options.requireStage2SlotCoordinates === true ||
        purpose === "FADADA_UPLOAD"
    };
  }
}

function assertArtifactSource(input: {
  contractId: string;
  fileName: string;
  objectKey: string;
  policy: ResolvedContractPdfArtifactPolicy;
  source: ContractPdfArtifactSource;
}) {
  if (input.policy.requireGeneratedContractArtifact && input.source !== "CONTRACT_FILE") {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_GENERATED_REQUIRED}: generated Contract.fileId artifact is required`);
  }
  if (
    input.policy.requireGeneratedContractArtifact &&
    !isGeneratedContractPdfObjectKey(input.contractId, input.objectKey)
  ) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_INVALID_OBJECT_KEY}: signing source is not a generated contract PDF`);
  }
  if (input.policy.fadadaEnabled && isObviousTestArtifact(input.objectKey, input.fileName)) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_INVALID_SOURCE}: test or sandbox PDF artifacts cannot be uploaded`);
  }
}

function assertPdfMetadata(
  fileName: string,
  mimeType: string | null,
  policy: ResolvedContractPdfArtifactPolicy
) {
  const looksLikePdf = fileName.toLowerCase().endsWith(".pdf") || mimeType === "application/pdf";
  if (policy.strictPdfMetadata && mimeType !== "application/pdf") {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_NOT_PDF}: contract artifact mimeType must be application/pdf`);
  }
  if (!looksLikePdf) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_NOT_PDF}: contract artifact must be a PDF`);
  }
}

function assertDeclaredSize(sizeBytes: bigint | number | null, maxBytes: number) {
  if (sizeBytes === null) {
    return;
  }
  const size = typeof sizeBytes === "bigint" ? sizeBytes : BigInt(sizeBytes);
  if (size > BigInt(maxBytes)) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_TOO_LARGE}: PDF must be <= ${maxBytes} bytes`);
  }
}

function assertPdfBuffer(buffer: Buffer, maxBytes: number) {
  if (buffer.length > maxBytes) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_TOO_LARGE}: PDF must be <= ${maxBytes} bytes`);
  }
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-", "utf8"))) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_NOT_PDF}: contract artifact must start with %PDF-`);
  }
}

function resolveGeneratedContractSlotCoordinates(input: {
  contractSnapshot: unknown;
  fileId: string;
  generatedContractArtifact: boolean;
  objectKey: string;
  source: ContractPdfArtifactSource;
}): ContractPdfArtifactSlotCoordinateDiagnostic[] | undefined {
  if (input.source !== "CONTRACT_FILE" || !input.generatedContractArtifact) {
    return undefined;
  }

  const snapshot = asRecord(input.contractSnapshot);
  const artifact = asRecord(snapshot?.generatedContractPdfArtifact);
  if (!artifact) {
    return undefined;
  }
  if (
    artifact.source !== CONTRACT_PDF_GENERATED_ARTIFACT_SOURCE ||
    artifact.signingStage !== "STAGE1_CONTRACT" ||
    artifact.fileId !== input.fileId ||
    normalizeObjectKey(String(artifact.objectKey ?? "")) !== normalizeObjectKey(input.objectKey)
  ) {
    return undefined;
  }

  return validatePersistedStage1SlotCoordinates(artifact.slotCoordinates);
}

function resolveStage2HandoverSlotCoordinates(input: {
  contractSnapshot: unknown;
  fileId: string;
  generatedContractArtifact: boolean;
  source: ContractPdfArtifactSource;
}): Stage2HandoverPdfArtifactSlotCoordinate[] | undefined {
  if (input.source !== "CONTRACT_FILE" || !input.generatedContractArtifact) {
    return undefined;
  }

  const snapshot = asRecord(input.contractSnapshot);
  const artifact = asRecord(snapshot?.stage2HandoverPdfArtifact);
  if (!artifact) {
    return undefined;
  }
  if (
    artifact.artifactKind !== "stage2-handover-pdf-source" ||
    artifact.documentType !== "DELIVERY_HANDOVER_CONFIRMATION" ||
    artifact.fileId !== input.fileId ||
    artifact.signingStage !== "STAGE2_DELIVERY_HANDOVER"
  ) {
    throw new Error(
      `${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID}: Stage 2 artifact metadata is invalid`
    );
  }

  if (!Number.isInteger(artifact.pageCount) || (artifact.pageCount as number) <= 0) {
    throw new Error(
      `${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID}: Stage 2 artifact pageCount must be a positive integer`
    );
  }

  return validatePersistedStage2SlotCoordinates(
    artifact.slotCoordinates,
    artifact.pageCount as number
  );
}

function validatePersistedStage1SlotCoordinates(value: unknown): ContractPdfArtifactSlotCoordinateDiagnostic[] {
  if (!Array.isArray(value)) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID}: slotCoordinates must be an array`);
  }

  const coordinates: ContractPdfArtifactSlotCoordinateDiagnostic[] = [];
  for (const slotId of STAGE1_CONTRACT_PDF_REQUIRED_SLOT_IDS) {
    const matches = value.filter((item) => asRecord(item)?.slotId === slotId);
    if (matches.length !== 1) {
      throw new Error(`${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID}: ${slotId} coordinate must appear once`);
    }
    const coordinate = asRecord(matches[0]);
    const expected = STAGE1_CONTRACT_PDF_SIGNING_SLOT_DEFINITIONS.find((slot) => slot.slotId === slotId)!;
    if (!coordinate) {
      throw new Error(`${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID}: ${slotId} coordinate is invalid`);
    }
    if (
      coordinate.coordinateSource !== "PDFKIT_RENDERER" ||
      coordinate.coordinateSystem !== "FADADA_800_1131_TOP_LEFT" ||
      coordinate.documentType !== expected.documentType ||
      coordinate.keyword !== expected.keyword ||
      coordinate.signerRole !== expected.signerRole ||
      coordinate.signingStage !== expected.stage ||
      !Number.isInteger(coordinate.pageNumber) ||
      (coordinate.pageNumber as number) < 0 ||
      !isFiniteNumberInRange(coordinate.x, 0, 800) ||
      !isFiniteNumberInRange(coordinate.y, 0, 1131) ||
      !isFinitePositiveNumber(coordinate.width) ||
      !isFinitePositiveNumber(coordinate.height) ||
      !isFinitePositiveNumber(coordinate.pdfPageWidth) ||
      !isFinitePositiveNumber(coordinate.pdfPageHeight)
    ) {
      throw new Error(`${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID}: ${slotId} coordinate is invalid`);
    }

    coordinates.push(coordinate as unknown as ContractPdfArtifactSlotCoordinateDiagnostic);
  }

  return coordinates;
}

function validatePersistedStage2SlotCoordinates(
  value: unknown,
  pageCount: number
): Stage2HandoverPdfArtifactSlotCoordinate[] {
  if (!Array.isArray(value)) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID}: slotCoordinates must be an array`);
  }

  const requiredSlotIds: Stage2HandoverPdfArtifactSlotCoordinate["slotId"][] = [
    "STAGE2_HANDOVER_CUSTOMER",
    "STAGE2_HANDOVER_PLATFORM"
  ];
  if (value.length !== requiredSlotIds.length) {
    throw new Error(
      `${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID}: exactly two Stage 2 coordinates are required`
    );
  }

  const coordinates = requiredSlotIds.map((slotId) => {
    const matches = value.filter((item) => asRecord(item)?.slotId === slotId);
    if (matches.length !== 1) {
      throw new Error(
        `${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID}: ${slotId} coordinate must appear once`
      );
    }
    const coordinate = asRecord(matches[0]);
    if (
      !coordinate ||
      coordinate.coordinateSource !== "PDFKIT_RENDERER" ||
      coordinate.coordinateSystem !== "FADADA_800_1131_TOP_LEFT" ||
      coordinate.documentType !== "DELIVERY_HANDOVER_CONFIRMATION" ||
      coordinate.signingStage !== "STAGE2_DELIVERY_HANDOVER" ||
      !Number.isInteger(coordinate.pageNumber) ||
      (coordinate.pageNumber as number) < 0 ||
      !isFiniteNumberInRange(coordinate.x, 0, 800) ||
      !isFiniteNumberInRange(coordinate.y, 0, 1131) ||
      !isFinitePositiveNumber(coordinate.width) ||
      !isFinitePositiveNumber(coordinate.height) ||
      !isFinitePositiveNumber(coordinate.pdfPageWidth) ||
      !isFinitePositiveNumber(coordinate.pdfPageHeight) ||
      (coordinate.x as number) - (coordinate.width as number) / 2 < 0 ||
      (coordinate.x as number) + (coordinate.width as number) / 2 > 800 ||
      (coordinate.y as number) - (coordinate.height as number) / 2 < 0 ||
      (coordinate.y as number) + (coordinate.height as number) / 2 > 1131
    ) {
      throw new Error(`${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID}: ${slotId} coordinate is invalid`);
    }

    return coordinate as unknown as Stage2HandoverPdfArtifactSlotCoordinate;
  });

  if (coordinates.some((coordinate) => coordinate.pageNumber !== pageCount - 1)) {
    throw new Error(
      `${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID}: Stage 2 coordinates must use the final PDF page`
    );
  }

  return coordinates;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isFiniteNumberInRange(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isFinitePositiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function buildPreflightDiagnostics(
  policy: ResolvedContractPdfArtifactPolicy,
  source: ContractPdfArtifactSource,
  generatedContractArtifact: boolean,
  slotCoordinates?: ResolvedContractPdfArtifactSlotCoordinate[]
): ContractPdfArtifactPreflightDiagnostics {
  const signingStage = slotCoordinates?.[0]?.signingStage;
  return {
    enterpriseAutoSealEnabled: policy.enterpriseAutoSealEnabled,
    fadadaEnabled: policy.fadadaEnabled,
    generatedContractArtifact,
    maxBytes: policy.maxBytes,
    purpose: policy.purpose,
    ...(slotCoordinates ? { slotCoordinates } : {}),
    source,
    stage1SlotCoordinatesVerified: signingStage === "STAGE1_CONTRACT",
    stage2SlotCoordinatesVerified: signingStage === "STAGE2_DELIVERY_HANDOVER",
    textExtractionVerified: false
  };
}

export function isGeneratedContractPdfObjectKey(contractId: string, objectKey: string | null | undefined) {
  if (!objectKey) {
    return false;
  }
  const normalized = normalizeObjectKey(objectKey);
  const pattern = new RegExp(`(?:^|/)contracts/${escapeRegExp(contractId)}/generated/[^/]+$`);
  return pattern.test(normalized);
}

function isObviousTestArtifact(objectKey: string | null | undefined, fileName: string | null | undefined) {
  return [objectKey, fileName].some((value) => {
    if (!value) {
      return false;
    }
    const normalized = normalizeObjectKey(value).toLowerCase();
    return (
      normalized.includes("sandbox-contract-") ||
      /(?:^|\/)(?:__fixtures__|fixtures|test-fixtures?|sandbox)(?:\/|$)/.test(normalized) ||
      /(?:^|\/)(?:test-fixture|fixture)-[^/]*\.pdf$/.test(normalized)
    );
  });
}

function normalizeObjectKey(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBoolean(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

async function streamToBuffer(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks);
}

function sanitizeFileName(value: string) {
  return (value.replace(/[^\w.-]+/g, "_").slice(0, 120) || "contract").replace(/^\.+$/, "contract");
}
