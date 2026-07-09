import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";

export const CONTRACT_PDF_ARTIFACT_MISSING = "CONTRACT_PDF_ARTIFACT_MISSING";
export const CONTRACT_PDF_ARTIFACT_NOT_PDF = "CONTRACT_PDF_ARTIFACT_NOT_PDF";
export const CONTRACT_PDF_ARTIFACT_TOO_LARGE = "CONTRACT_PDF_ARTIFACT_TOO_LARGE";
export const CONTRACT_PDF_ARTIFACT_GENERATED_REQUIRED = "CONTRACT_PDF_ARTIFACT_GENERATED_REQUIRED";
export const CONTRACT_PDF_ARTIFACT_INVALID_OBJECT_KEY = "CONTRACT_PDF_ARTIFACT_INVALID_OBJECT_KEY";
export const CONTRACT_PDF_ARTIFACT_INVALID_SOURCE = "CONTRACT_PDF_ARTIFACT_INVALID_SOURCE";

const MAX_FADADA_PDF_BYTES = 20 * 1024 * 1024;

export type ContractPdfArtifactPurpose = "FADADA_UPLOAD";
export type ContractPdfArtifactSource = "CONTRACT_FILE" | "CONTRACT_VERSION_FILE" | "TEST_FIXTURE";

export interface ContractPdfArtifactPolicyOptions {
  enterpriseAutoSealEnabled?: boolean;
  fadadaEnabled?: boolean;
  maxBytes?: number;
  purpose?: ContractPdfArtifactPurpose;
  requireGeneratedContractArtifact?: boolean;
}

export interface ContractPdfArtifactPreflightDiagnostics {
  enterpriseAutoSealEnabled: boolean;
  fadadaEnabled: boolean;
  generatedContractArtifact: boolean;
  maxBytes: number;
  purpose?: ContractPdfArtifactPurpose;
  source: ContractPdfArtifactSource;
  textExtractionVerified: false;
}

export interface ContractPdfArtifact {
  buffer: Buffer;
  contentType: "application/pdf";
  fileName: string;
  objectKey?: string;
  preflight?: ContractPdfArtifactPreflightDiagnostics;
  size: number;
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
      return this.readFileArtifact(contract.id, contract.fileId, "CONTRACT_FILE", policy);
    }
    if (contract.contractVersion.fileId) {
      if (policy.requireGeneratedContractArtifact) {
        throw new Error(
          `${CONTRACT_PDF_ARTIFACT_GENERATED_REQUIRED}: generated Contract.fileId artifact is required`
        );
      }
      return this.readFileArtifact(contract.id, contract.contractVersion.fileId, "CONTRACT_VERSION_FILE", policy);
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
    contractId: string,
    fileId: string,
    source: ContractPdfArtifactSource,
    policy: ResolvedContractPdfArtifactPolicy
  ): Promise<ContractPdfArtifact> {
    const fileObject = await this.prisma.fileObject.findUnique({ where: { id: fileId } });
    if (!fileObject) {
      throw new Error(`${CONTRACT_PDF_ARTIFACT_MISSING}: file object not found`);
    }

    assertArtifactSource({
      contractId,
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
    const generatedContractArtifact = isGeneratedContractPdfObjectKey(contractId, fileObject.objectKey);

    return {
      buffer,
      contentType: "application/pdf",
      fileName: fileObject.originalName,
      objectKey: fileObject.objectKey,
      preflight: buildPreflightDiagnostics(policy, source, generatedContractArtifact),
      size: buffer.length,
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
      options.requireGeneratedContractArtifact ?? enterpriseAutoSealEnabled;
    const purpose = options.purpose ?? (fadadaEnabled ? "FADADA_UPLOAD" : undefined);
    const maxBytes = options.maxBytes ?? MAX_FADADA_PDF_BYTES;

    return {
      enterpriseAutoSealEnabled,
      fadadaEnabled,
      maxBytes,
      purpose,
      requireGeneratedContractArtifact,
      strictPdfMetadata: fadadaEnabled || enterpriseAutoSealEnabled || purpose === "FADADA_UPLOAD"
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

function buildPreflightDiagnostics(
  policy: ResolvedContractPdfArtifactPolicy,
  source: ContractPdfArtifactSource,
  generatedContractArtifact: boolean
): ContractPdfArtifactPreflightDiagnostics {
  return {
    enterpriseAutoSealEnabled: policy.enterpriseAutoSealEnabled,
    fadadaEnabled: policy.fadadaEnabled,
    generatedContractArtifact,
    maxBytes: policy.maxBytes,
    purpose: policy.purpose,
    source,
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
