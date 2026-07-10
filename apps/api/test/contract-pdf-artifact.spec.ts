import { ConfigService } from "@nestjs/config";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { STAGE1_CONTRACT_PDF_SIGNING_SLOT_DEFINITIONS } from "../src/contract/contract-pdf-render-model";
import { ContractPdfArtifactService } from "../src/esign/contract-pdf-artifact.service";

describe("ContractPdfArtifactService", () => {
  it("reads an existing ContractVersion PDF file through StorageService", async () => {
    const pdf = minimalPdf();
    const { prisma, service, storageService } = createFixture({
      fileObject: {
        bucket: "application-materials",
        id: "file-1",
        mimeType: "application/pdf",
        objectKey: "contracts/version-1.pdf",
        originalName: "version-1.pdf",
        sizeBytes: BigInt(pdf.length)
      },
      storageObject: { contentType: "application/pdf", stream: Readable.from([pdf]) }
    });

    const artifact = await service.getContractPdfArtifact("contract-1");

    expect(prisma.contract.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { deletedAt: null, id: "contract-1" }
    }));
    expect(prisma.fileObject.findUnique).toHaveBeenCalledWith({ where: { id: "file-1" } });
    expect(storageService.getObject).toHaveBeenCalledWith("application-materials", "contracts/version-1.pdf");
    expect(artifact).toMatchObject({
      contentType: "application/pdf",
      fileName: "version-1.pdf",
      size: pdf.length,
      source: "CONTRACT_VERSION_FILE"
    });
    expect(artifact.buffer.equals(pdf)).toBe(true);
  });

  it("returns CONTRACT_PDF_ARTIFACT_MISSING when real signing is enabled and no PDF exists", async () => {
    const { service } = createFixture({
      config: { FADADA_ENABLED: "true", NODE_ENV: "test" },
      contract: { fileId: null, contractVersion: { fileId: null } }
    });

    await expect(service.getContractPdfArtifact("contract-1")).rejects.toThrow(/CONTRACT_PDF_ARTIFACT_MISSING/);
  });

  it("can generate a deterministic test fixture PDF when real signing is disabled", async () => {
    const { service } = createFixture({
      config: { FADADA_ENABLED: "false", NODE_ENV: "test" },
      contract: { fileId: null, contractVersion: { fileId: null } }
    });

    const artifact = await service.getContractPdfArtifact("contract-1");

    expect(artifact).toMatchObject({
      contentType: "application/pdf",
      fileName: "CON-1.pdf",
      source: "TEST_FIXTURE"
    });
    expect(artifact.buffer.subarray(0, 5).toString("utf8")).toBe("%PDF-");
  });

  it("rejects non-PDF contract files", async () => {
    const { service } = createFixture({
      fileObject: {
        bucket: "application-materials",
        id: "file-1",
        mimeType: "text/plain",
        objectKey: "contracts/version-1.txt",
        originalName: "version-1.txt",
        sizeBytes: 7n
      },
      storageObject: { contentType: "text/plain", stream: Readable.from(["not-pdf"]) }
    });

    await expect(service.getContractPdfArtifact("contract-1")).rejects.toThrow(/CONTRACT_PDF_ARTIFACT_NOT_PDF/);
  });

  it("rejects contract-version fallback when enterprise auto seal requires a generated contract artifact", async () => {
    const pdf = minimalPdf();
    const { service } = createFixture({
      config: { ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED: "true", FADADA_ENABLED: "true" },
      fileObject: {
        bucket: "application-materials",
        id: "file-1",
        mimeType: "application/pdf",
        objectKey: "contracts/version-1.pdf",
        originalName: "version-1.pdf",
        sizeBytes: BigInt(pdf.length)
      },
      storageObject: { contentType: "application/pdf", stream: Readable.from([pdf]) }
    });

    await expect(service.getContractPdfArtifact("contract-1")).rejects.toThrow(
      /CONTRACT_PDF_ARTIFACT_GENERATED_REQUIRED/
    );
  });

  it("rejects non-generated contract files when enterprise auto seal is enabled", async () => {
    const pdf = minimalPdf();
    const { service } = createFixture({
      config: { ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED: "true", FADADA_ENABLED: "true" },
      contract: { fileId: "file-1" },
      fileObject: {
        bucket: "application-materials",
        id: "file-1",
        mimeType: "application/pdf",
        objectKey: "contracts/contract-1/manual/source.pdf",
        originalName: "source.pdf",
        sizeBytes: BigInt(pdf.length)
      },
      storageObject: { contentType: "application/pdf", stream: Readable.from([pdf]) }
    });

    await expect(service.getContractPdfArtifact("contract-1")).rejects.toThrow(
      /CONTRACT_PDF_ARTIFACT_INVALID_OBJECT_KEY/
    );
  });

  it("accepts generated contract artifacts with storage prefixes when enterprise auto seal is enabled", async () => {
    const pdf = minimalPdf();
    const { service } = createFixture({
      config: { ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED: "true", FADADA_ENABLED: "true" },
      contract: { fileId: "file-1" },
      fileObject: {
        bucket: "application-materials",
        id: "file-1",
        mimeType: "application/pdf",
        objectKey: "oss:private/contracts/contract-1/generated/CON-1.pdf",
        originalName: "CON-1.pdf",
        sizeBytes: BigInt(pdf.length)
      },
      storageObject: { contentType: "application/pdf", stream: Readable.from([pdf]) }
    });

    const artifact = await service.getContractPdfArtifact("contract-1");

    expect(artifact).toMatchObject({
      objectKey: "oss:private/contracts/contract-1/generated/CON-1.pdf",
      source: "CONTRACT_FILE"
    });
    expect(artifact.preflight).toMatchObject({
      generatedContractArtifact: true,
      source: "CONTRACT_FILE",
      textExtractionVerified: false
    });
  });

  it("returns persisted Stage 1 slot coordinates for generated contract files", async () => {
    const pdf = minimalPdf();
    const objectKey = "contracts/contract-1/generated/CON-1.pdf";
    const slotCoordinates = createSlotCoordinates();
    const { service } = createFixture({
      config: { FADADA_ENABLED: "true" },
      contract: {
        contractSnapshot: generatedArtifactSnapshot({
          fileId: "file-1",
          objectKey,
          slotCoordinates
        }),
        fileId: "file-1"
      },
      fileObject: {
        bucket: "application-materials",
        id: "file-1",
        mimeType: "application/pdf",
        objectKey,
        originalName: "CON-1.pdf",
        sizeBytes: BigInt(pdf.length)
      },
      storageObject: { contentType: "application/pdf", stream: Readable.from([pdf]) }
    });

    const artifact = await service.preflightContractPdfArtifact("contract-1", {
      fadadaEnabled: true,
      purpose: "FADADA_UPLOAD",
      requireGeneratedContractArtifact: true,
      requireStage1SlotCoordinates: true
    });

    expect(artifact.slotCoordinates).toEqual(slotCoordinates);
    expect(artifact.preflight).toMatchObject({
      generatedContractArtifact: true,
      source: "CONTRACT_FILE",
      stage1SlotCoordinatesVerified: true
    });
    expect(artifact.preflight?.slotCoordinates).toEqual(slotCoordinates);
  });

  it("does not invent slot coordinates for ContractVersion fallback artifacts", async () => {
    const pdf = minimalPdf();
    const { service } = createFixture({
      fileObject: {
        bucket: "application-materials",
        id: "file-1",
        mimeType: "application/pdf",
        objectKey: "contracts/version-1.pdf",
        originalName: "version-1.pdf",
        sizeBytes: BigInt(pdf.length)
      },
      storageObject: { contentType: "application/pdf", stream: Readable.from([pdf]) }
    });

    const artifact = await service.getContractPdfArtifact("contract-1");

    expect(artifact.source).toBe("CONTRACT_VERSION_FILE");
    expect(artifact.slotCoordinates).toBeUndefined();
    expect(artifact.preflight?.slotCoordinates).toBeUndefined();
    expect(artifact.preflight?.stage1SlotCoordinatesVerified).toBe(false);
  });

  it("fails slot-aware preflight when a generated artifact lacks persisted coordinates", async () => {
    const pdf = minimalPdf();
    const { service } = createFixture({
      config: { FADADA_ENABLED: "true" },
      contract: {
        contractSnapshot: {},
        fileId: "file-1"
      },
      fileObject: {
        bucket: "application-materials",
        id: "file-1",
        mimeType: "application/pdf",
        objectKey: "contracts/contract-1/generated/CON-1.pdf",
        originalName: "CON-1.pdf",
        sizeBytes: BigInt(pdf.length)
      },
      storageObject: { contentType: "application/pdf", stream: Readable.from([pdf]) }
    });

    await expect(service.preflightContractPdfArtifact("contract-1", {
      fadadaEnabled: true,
      purpose: "FADADA_UPLOAD",
      requireGeneratedContractArtifact: true,
      requireStage1SlotCoordinates: true
    })).rejects.toThrow(/CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_MISSING/);
  });

  it("rejects signed-artifact paths as generated signing source artifacts", async () => {
    const pdf = minimalPdf();
    const { service } = createFixture({
      config: { ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED: "true", FADADA_ENABLED: "true" },
      contract: { fileId: "file-1" },
      fileObject: {
        bucket: "application-materials",
        id: "file-1",
        mimeType: "application/pdf",
        objectKey: "contracts/contract-1/esign/fadada/signed/CON-1.pdf",
        originalName: "CON-1.pdf",
        sizeBytes: BigInt(pdf.length)
      },
      storageObject: { contentType: "application/pdf", stream: Readable.from([pdf]) }
    });

    await expect(service.getContractPdfArtifact("contract-1")).rejects.toThrow(
      /CONTRACT_PDF_ARTIFACT_INVALID_OBJECT_KEY/
    );
  });

  it("rejects oversized file objects before reading storage", async () => {
    const { service, storageService } = createFixture({
      config: { FADADA_ENABLED: "true" },
      contract: { fileId: "file-1" },
      fileObject: {
        bucket: "application-materials",
        id: "file-1",
        mimeType: "application/pdf",
        objectKey: "contracts/contract-1/generated/CON-1.pdf",
        originalName: "CON-1.pdf",
        sizeBytes: BigInt(20 * 1024 * 1024 + 1)
      },
      storageObject: { contentType: "application/pdf", stream: Readable.from([minimalPdf()]) }
    });

    await expect(service.getContractPdfArtifact("contract-1")).rejects.toThrow(/CONTRACT_PDF_ARTIFACT_TOO_LARGE/);
    expect(storageService.getObject).not.toHaveBeenCalled();
  });

  it("requires application/pdf mime type for Fadada uploads", async () => {
    const pdf = minimalPdf();
    const { service } = createFixture({
      config: { FADADA_ENABLED: "true" },
      contract: { fileId: "file-1" },
      fileObject: {
        bucket: "application-materials",
        id: "file-1",
        mimeType: "application/octet-stream",
        objectKey: "contracts/contract-1/generated/CON-1.pdf",
        originalName: "CON-1.pdf",
        sizeBytes: BigInt(pdf.length)
      },
      storageObject: { contentType: "application/pdf", stream: Readable.from([pdf]) }
    });

    await expect(service.getContractPdfArtifact("contract-1")).rejects.toThrow(/CONTRACT_PDF_ARTIFACT_NOT_PDF/);
  });

  it("rejects obvious sandbox source PDFs for Fadada uploads", async () => {
    const pdf = minimalPdf();
    const { service } = createFixture({
      config: { FADADA_ENABLED: "true" },
      contract: { fileId: "file-1" },
      fileObject: {
        bucket: "application-materials",
        id: "file-1",
        mimeType: "application/pdf",
        objectKey: "uploads/sandbox-contract-0117.pdf",
        originalName: "sandbox-contract-0117.pdf",
        sizeBytes: BigInt(pdf.length)
      },
      storageObject: { contentType: "application/pdf", stream: Readable.from([pdf]) }
    });

    await expect(service.getContractPdfArtifact("contract-1")).rejects.toThrow(
      /CONTRACT_PDF_ARTIFACT_INVALID_SOURCE/
    );
  });
});

function createFixture(options: {
  config?: Record<string, string>;
  contract?: Record<string, unknown>;
  fileObject?: Record<string, unknown> | null;
  storageObject?: { contentType?: string; stream: Readable };
} = {}) {
  const contract = {
    contractNo: "CON-1",
    contractSnapshot: {},
    contractTitle: "Subscription Contract",
    contractVersion: { fileId: "file-1" },
    deletedAt: null,
    fileId: null,
    id: "contract-1",
    ...options.contract
  };
  const prisma = {
    contract: {
      findFirst: vi.fn(async () => contract)
    },
    fileObject: {
      findUnique: vi.fn(async () => options.fileObject ?? null)
    }
  };
  const storageService = {
    getObject: vi.fn(async () => options.storageObject)
  };
  const configService = new ConfigService({
    FADADA_ENABLED: "false",
    NODE_ENV: "test",
    ...options.config
  });

  return {
    prisma,
    service: new ContractPdfArtifactService(prisma as never, storageService as never, configService),
    storageService
  };
}

function minimalPdf() {
  return Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");
}

function createSlotCoordinates() {
  return STAGE1_CONTRACT_PDF_SIGNING_SLOT_DEFINITIONS.map((slot, index) => ({
    coordinateSource: "PDFKIT_RENDERER",
    coordinateSystem: "FADADA_800_1131_TOP_LEFT",
    documentType: slot.documentType,
    height: 48,
    keyword: slot.keyword,
    pageNumber: index < 2 ? 0 : 1,
    pdfPageHeight: 841.89,
    pdfPageWidth: 595.28,
    signerRole: slot.signerRole,
    signingStage: "STAGE1_CONTRACT",
    slotId: slot.slotId,
    width: 160,
    x: 520 + index,
    y: 730 + index
  }));
}

function generatedArtifactSnapshot(input: {
  fileId: string;
  objectKey: string;
  slotCoordinates: ReturnType<typeof createSlotCoordinates>;
}) {
  return {
    generatedContractPdfArtifact: {
      fileId: input.fileId,
      mimeType: "application/pdf",
      objectKey: input.objectKey,
      originalName: "CON-1.pdf",
      signingStage: "STAGE1_CONTRACT",
      slotCoordinates: input.slotCoordinates,
      source: "GENERATED_CONTRACT_PDF"
    }
  };
}
