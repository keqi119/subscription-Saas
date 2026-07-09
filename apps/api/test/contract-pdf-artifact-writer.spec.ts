import { describe, expect, it, vi } from "vitest";

import type { ContractPdfRenderDiagnostics, ContractPdfRenderModel } from "../src/contract/contract-pdf-render-model";
import { ContractPdfArtifactWriterService } from "../src/contract/contract-pdf-artifact-writer.service";
import {
  CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE,
  CONTRACT_PDF_ARTIFACT_APPENDIX_MISSING,
  CONTRACT_PDF_ARTIFACT_EXISTING_FILE,
  CONTRACT_PDF_ARTIFACT_LEGAL_BODY_MISSING,
  CONTRACT_PDF_ARTIFACT_PROTECTED_STATUS,
  CONTRACT_PDF_ARTIFACT_TOO_LARGE
} from "../src/contract/contract-pdf-artifact.types";
import { StorageService } from "../src/storage/storage.service";
import { UploadObjectInput } from "../src/storage/storage.types";

describe("ContractPdfArtifactWriterService", () => {
  it("writes a generated PDF artifact to private storage and creates a FileObject", async () => {
    const { fileObjectCreate, prisma, renderer, storage, writer } = createWriter();

    const result = await writer.writeGeneratedContractPdfArtifact({
      allowBuiltinFontForAsciiOnlyTests: true,
      renderModel: createModel(),
      uploadedBy: "user-1"
    });

    expect(renderer.render).toHaveBeenCalledWith(createModel(), {
      allowBuiltinFontForAsciiOnlyTests: true,
      cjkFontPath: undefined,
      maxBytes: undefined
    });
    expect(storage.putGeneratedContractPdfArtifact).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      contentType: "application/pdf",
      contractId: "contract-1",
      metadata: {
        artifactKind: "contract-signing-source",
        contractNo: "CON-TEST-001",
        templateName: "Synthetic Artifact Writer Template",
        templateVersion: "V0.TEST"
      },
      objectKey: "contracts/contract-1/generated/CON-TEST-001.pdf",
      originalName: "CON-TEST-001.pdf"
    });
    expect(fileObjectCreate).toHaveBeenCalledWith({
      data: {
        bucket: "application-materials",
        mimeType: "application/pdf",
        objectKey: "contracts/contract-1/generated/CON-TEST-001.pdf",
        originalName: "CON-TEST-001.pdf",
        sizeBytes: BigInt(18),
        uploadedBy: "user-1"
      }
    });
    expect(prisma.contract?.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      bucket: "application-materials",
      fileId: "file-1",
      mimeType: "application/pdf",
      objectKey: "contracts/contract-1/generated/CON-TEST-001.pdf",
      originalName: "CON-TEST-001.pdf",
      sizeBytes: 18
    });
    expect(result.diagnostics.anchorOccurrences).toEqual({
      customerSignatureKeyword: 1,
      platformSealKeyword: 1
    });
  });

  it("rejects missing platform anchor before rendering or storage writes", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter();

    await expect(writer.writeGeneratedContractPdfArtifact({
      renderModel: createModel({
        signingAnchors: {
          customerSignatureKeyword: "Customer signature",
          platformSealKeyword: ""
        }
      })
    })).rejects.toThrow(CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects missing customer anchor before rendering or storage writes", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter();

    await expect(writer.writeGeneratedContractPdfArtifact({
      renderModel: createModel({
        signingAnchors: {
          customerSignatureKeyword: "",
          platformSealKeyword: "Provider seal"
        }
      })
    })).rejects.toThrow(CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects duplicate platform anchor before rendering or storage writes", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter();

    await expect(writer.writeGeneratedContractPdfArtifact({
      renderModel: createModel({
        contentTemplate: "Synthetic non-legal text. Provider seal appears here too."
      })
    })).rejects.toThrow(CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects duplicate customer anchor before rendering or storage writes", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter();

    await expect(writer.writeGeneratedContractPdfArtifact({
      renderModel: createModel({
        appendix: {
          sections: [{
            rows: [{ label: "Customer anchor duplicate", value: "Customer signature" }],
            title: "Synthetic appendix"
          }]
        }
      })
    })).rejects.toThrow(CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects renderer diagnostics without legal body", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter({
      rendererResult: { diagnostics: { hasLegalBody: false } }
    });

    await expect(writer.writeGeneratedContractPdfArtifact({
      renderModel: createModel()
    })).rejects.toThrow(CONTRACT_PDF_ARTIFACT_LEGAL_BODY_MISSING);

    expect(renderer.render).toHaveBeenCalledOnce();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects renderer diagnostics without appendix", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter({
      rendererResult: { diagnostics: { hasAppendix: false } }
    });

    await expect(writer.writeGeneratedContractPdfArtifact({
      renderModel: createModel()
    })).rejects.toThrow(CONTRACT_PDF_ARTIFACT_APPENDIX_MISSING);

    expect(renderer.render).toHaveBeenCalledOnce();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects protected contract statuses", async () => {
    const { renderer, storage, writer } = createWriter();

    await expect(writer.writeGeneratedContractPdfArtifact({
      contractStatus: "SIGNED",
      renderModel: createModel()
    })).rejects.toThrow(CONTRACT_PDF_ARTIFACT_PROTECTED_STATUS);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
  });

  it("rejects an existing contract file unless regeneration is explicitly allowed", async () => {
    const { renderer, storage, writer } = createWriter();

    await expect(writer.writeGeneratedContractPdfArtifact({
      existingContractFileId: "existing-file-1",
      renderModel: createModel()
    })).rejects.toThrow(CONTRACT_PDF_ARTIFACT_EXISTING_FILE);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
  });

  it("enforces the 20MB-compatible maximum size before storage writes", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter({
      rendererResult: {
        buffer: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(20)])
      }
    });

    await expect(writer.writeGeneratedContractPdfArtifact({
      maxBytes: 10,
      renderModel: createModel()
    })).rejects.toThrow(CONTRACT_PDF_ARTIFACT_TOO_LARGE);

    expect(renderer.render).toHaveBeenCalledOnce();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("does not create FileObject when storage fails", async () => {
    const storageError = new Error("storage unavailable");
    const { fileObjectCreate, storage, writer } = createWriter({
      storageError
    });

    await expect(writer.writeGeneratedContractPdfArtifact({
      renderModel: createModel()
    })).rejects.toThrow(storageError);

    expect(storage.putGeneratedContractPdfArtifact).toHaveBeenCalledOnce();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("best-effort deletes the private object when FileObject creation fails", async () => {
    const dbError = new Error("file object create failed");
    const { fileObjectCreate, storage, writer } = createWriter({
      fileObjectCreateError: dbError
    });

    await expect(writer.writeGeneratedContractPdfArtifact({
      renderModel: createModel()
    })).rejects.toThrow(dbError);

    expect(fileObjectCreate).toHaveBeenCalledOnce();
    expect(storage.deleteObject).toHaveBeenCalledWith(
      "application-materials",
      "contracts/contract-1/generated/CON-TEST-001.pdf"
    );
  });

  it("sanitizes generated object keys and uses private storage", async () => {
    const local = {
      deleteObject: vi.fn(),
      getObject: vi.fn(),
      putObject: vi.fn(async (input: UploadObjectInput) => ({
        driver: "local" as const,
        key: input.key,
        size: input.buffer.length
      }))
    };
    const storage = new StorageService(
      { get: (key: string) => ({ UPLOAD_STORAGE_DRIVER: "local" })[key] } as never,
      local as never,
      {} as never
    );

    const stored = await storage.putGeneratedContractPdfArtifact({
      buffer: Buffer.from("%PDF-synthetic"),
      contentType: "application/pdf",
      contractId: "contract-1",
      originalName: "CON 2026/Unsafe Name.pdf"
    });

    expect(stored.bucket).toBe("application-materials");
    expect(stored.contentType).toBe("application/pdf");
    expect(stored.objectKey).toBe("contracts/contract-1/generated/CON_2026_Unsafe_Name.pdf");
    expect(stored.objectKey.length).toBeLessThanOrEqual(255);
    expect(local.putObject).toHaveBeenCalledWith(expect.objectContaining({
      key: "application-materials/contracts/contract-1/generated/CON_2026_Unsafe_Name.pdf"
    }));
  });
});

function createWriter(options: {
  fileObjectCreateError?: Error;
  rendererResult?: {
    buffer?: Buffer;
    diagnostics?: Partial<ContractPdfRenderDiagnostics>;
  };
  storageError?: Error;
} = {}) {
  const rendererResult = {
    buffer: options.rendererResult?.buffer ?? Buffer.from("%PDF-synthetic-pdf"),
    contentType: "application/pdf" as const,
    diagnostics: {
      hasAppendix: true,
      hasCjkContent: false,
      hasCustomerSignatureKeyword: true,
      hasLegalBody: true,
      hasPlatformSealKeyword: true,
      ...options.rendererResult?.diagnostics
    },
    fileName: "CON-TEST-001.pdf"
  };
  const renderer = {
    render: vi.fn(async () => rendererResult)
  };
  const storage = {
    deleteObject: vi.fn(async () => undefined),
    putGeneratedContractPdfArtifact: vi.fn(async () => {
      if (options.storageError) {
        throw options.storageError;
      }
      return {
        bucket: "application-materials",
        contentType: "application/pdf",
        objectKey: "contracts/contract-1/generated/CON-TEST-001.pdf",
        originalName: "CON-TEST-001.pdf",
        sizeBytes: rendererResult.buffer.length
      };
    })
  };
  const fileObjectCreate = vi.fn(async () => {
    if (options.fileObjectCreateError) {
      throw options.fileObjectCreateError;
    }
    return {
      id: "file-1"
    };
  });
  const prisma = {
    contract: {
      update: vi.fn()
    },
    fileObject: {
      create: fileObjectCreate,
      findFirst: vi.fn(async () => null)
    }
  };

  return {
    fileObjectCreate,
    prisma,
    renderer,
    storage,
    writer: new ContractPdfArtifactWriterService(renderer as never, storage as never, prisma as never)
  };
}

function createModel(overrides: Partial<ContractPdfRenderModel> = {}): ContractPdfRenderModel {
  return {
    appendix: {
      sections: [{
        rows: [
          { label: "Order number", value: "ORD-TEST-001" },
          { label: "Plan", value: "Synthetic monthly plan" }
        ],
        title: "Synthetic order snapshot appendix"
      }]
    },
    contentTemplate: "Synthetic non-legal contract body for artifact writer tests only.",
    contractId: "contract-1",
    contractNo: "CON-TEST-001",
    generatedAt: new Date("2026-07-09T00:00:00.000Z"),
    orderNo: "ORD-TEST-001",
    signingAnchors: {
      customerSignatureKeyword: "Customer signature",
      platformSealKeyword: "Provider seal",
      platformSealOffsetX: 60,
      platformSealOffsetY: 0
    },
    templateName: "Synthetic Artifact Writer Template",
    templateVersion: "V0.TEST",
    ...overrides
  };
}
