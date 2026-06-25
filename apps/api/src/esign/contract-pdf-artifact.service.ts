import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";

export const CONTRACT_PDF_ARTIFACT_MISSING = "CONTRACT_PDF_ARTIFACT_MISSING";
export const CONTRACT_PDF_ARTIFACT_NOT_PDF = "CONTRACT_PDF_ARTIFACT_NOT_PDF";
export const CONTRACT_PDF_ARTIFACT_TOO_LARGE = "CONTRACT_PDF_ARTIFACT_TOO_LARGE";

const MAX_FADADA_PDF_BYTES = 20 * 1024 * 1024;

export interface ContractPdfArtifact {
  buffer: Buffer;
  contentType: "application/pdf";
  fileName: string;
  objectKey?: string;
  size: number;
  source: "CONTRACT_FILE" | "CONTRACT_VERSION_FILE" | "TEST_FIXTURE";
}

const contractArtifactInclude = {
  contractVersion: { select: { fileId: true } }
} satisfies Prisma.ContractInclude;

type ContractArtifactSource = Prisma.ContractGetPayload<{ include: typeof contractArtifactInclude }>;

@Injectable()
export class ContractPdfArtifactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService
  ) {}

  async getContractPdfArtifact(contractId: string): Promise<ContractPdfArtifact> {
    const contract = await this.prisma.contract.findFirst({
      include: contractArtifactInclude,
      where: { deletedAt: null, id: contractId }
    });

    if (!contract) {
      throw new Error(`${CONTRACT_PDF_ARTIFACT_MISSING}: contract not found`);
    }

    if (contract.fileId) {
      return this.readFileArtifact(contract.fileId, "CONTRACT_FILE");
    }
    if (contract.contractVersion.fileId) {
      return this.readFileArtifact(contract.contractVersion.fileId, "CONTRACT_VERSION_FILE");
    }
    if (this.canUseTestFixture()) {
      return this.buildTestFixture(contract);
    }

    throw new Error(`${CONTRACT_PDF_ARTIFACT_MISSING}: contract has no PDF file artifact`);
  }

  private async readFileArtifact(fileId: string, source: ContractPdfArtifact["source"]): Promise<ContractPdfArtifact> {
    const fileObject = await this.prisma.fileObject.findUnique({ where: { id: fileId } });
    if (!fileObject) {
      throw new Error(`${CONTRACT_PDF_ARTIFACT_MISSING}: file object not found`);
    }

    assertPdfMetadata(fileObject.originalName, fileObject.mimeType);

    const downloaded = await this.storageService.getObject(fileObject.bucket, fileObject.objectKey);
    const buffer = await streamToBuffer(downloaded.stream);
    assertPdfBuffer(buffer);

    return {
      buffer,
      contentType: "application/pdf",
      fileName: fileObject.originalName,
      objectKey: fileObject.objectKey,
      size: buffer.length,
      source
    };
  }

  private buildTestFixture(contract: ContractArtifactSource): ContractPdfArtifact {
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
      size: buffer.length,
      source: "TEST_FIXTURE"
    };
  }

  private canUseTestFixture() {
    const fadadaEnabled = (this.configService.get<string>("FADADA_ENABLED") ?? "false").toLowerCase() === "true";
    if (fadadaEnabled) {
      return false;
    }

    const explicit = (this.configService.get<string>("FADADA_TEST_PDF_ARTIFACT_ENABLED") ?? "").toLowerCase();
    return explicit === "true" || this.configService.get<string>("NODE_ENV") === "test";
  }
}

function assertPdfMetadata(fileName: string, mimeType: string | null) {
  const looksLikePdf = fileName.toLowerCase().endsWith(".pdf") || mimeType === "application/pdf";
  if (!looksLikePdf) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_NOT_PDF}: contract artifact must be a PDF`);
  }
}

function assertPdfBuffer(buffer: Buffer) {
  if (buffer.length > MAX_FADADA_PDF_BYTES) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_TOO_LARGE}: PDF must be <= 20MB`);
  }
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-", "utf8"))) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_NOT_PDF}: contract artifact must start with %PDF-`);
  }
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
