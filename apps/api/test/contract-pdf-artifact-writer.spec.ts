import { describe, expect, it, vi } from "vitest";

import type {
  ContractPdfRenderDiagnostics,
  ContractPdfRenderModel,
  ContractPdfSigningSlot,
  ContractPdfSigningSlotCoordinate
} from "../src/contract/contract-pdf-render-model";
import { ContractPdfArtifactWriterService } from "../src/contract/contract-pdf-artifact-writer.service";
import {
  CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE,
  CONTRACT_PDF_ARTIFACT_APPENDIX_MISSING,
  CONTRACT_PDF_ARTIFACT_EXISTING_FILE,
  CONTRACT_PDF_ARTIFACT_LEGAL_BODY_MISSING,
  CONTRACT_PDF_ARTIFACT_PROTECTED_STATUS,
  CONTRACT_PDF_ARTIFACT_SLOT_COORDINATE_INVALID,
  CONTRACT_PDF_ARTIFACT_SLOT_COORDINATE_MISSING,
  CONTRACT_PDF_ARTIFACT_TOO_LARGE
} from "../src/contract/contract-pdf-artifact.types";
import { StorageService } from "../src/storage/storage.service";
import { UploadObjectInput } from "../src/storage/storage.types";

const STAGE1_SIGNING_SLOTS: ContractPdfSigningSlot[] = [
  {
    documentType: "CONTRACT_BODY",
    keyword: "合同正文-订阅方签字",
    label: "订阅方签字",
    signerRole: "CUSTOMER",
    slotId: "STAGE1_BODY_CUSTOMER",
    stage: "STAGE1_CONTRACT",
    title: "合同正文签署区"
  },
  {
    documentType: "CONTRACT_BODY",
    keyword: "合同正文-服务提供方盖章",
    label: "服务提供方盖章",
    offsetX: 60,
    offsetY: 0,
    signerRole: "PLATFORM",
    slotId: "STAGE1_BODY_PLATFORM",
    stage: "STAGE1_CONTRACT",
    title: "合同正文签署区"
  },
  {
    documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
    keyword: "附件1订阅方案-订阅方签字",
    label: "订阅方签字",
    signerRole: "CUSTOMER",
    slotId: "STAGE1_ATTACHMENT1_CUSTOMER",
    stage: "STAGE1_CONTRACT",
    title: "附件1订阅方案签署区"
  },
  {
    documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
    keyword: "附件1订阅方案-服务提供方盖章",
    label: "服务提供方盖章",
    offsetX: 60,
    offsetY: 0,
    signerRole: "PLATFORM",
    slotId: "STAGE1_ATTACHMENT1_PLATFORM",
    stage: "STAGE1_CONTRACT",
    title: "附件1订阅方案签署区"
  }
];

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
      stage1SigningSlots: {
        STAGE1_ATTACHMENT1_CUSTOMER: 1,
        STAGE1_ATTACHMENT1_PLATFORM: 1,
        STAGE1_BODY_CUSTOMER: 1,
        STAGE1_BODY_PLATFORM: 1
      }
    });
    expect(result.diagnostics.slotCoordinates).toHaveLength(4);
    expect(
      result.diagnostics.slotCoordinates.map((coordinate) => coordinate.slotId).sort()
    ).toEqual([
      "STAGE1_ATTACHMENT1_CUSTOMER",
      "STAGE1_ATTACHMENT1_PLATFORM",
      "STAGE1_BODY_CUSTOMER",
      "STAGE1_BODY_PLATFORM"
    ]);
    expect(result.diagnostics).toMatchObject({
      signingStage: "STAGE1_CONTRACT",
      source: "GENERATED_CONTRACT_PDF"
    });
    expect(result.diagnostics.slotCoordinates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentType: "CONTRACT_BODY",
          signerRole: "CUSTOMER",
          signingStage: "STAGE1_CONTRACT",
          slotId: "STAGE1_BODY_CUSTOMER"
        }),
        expect.objectContaining({
          documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
          signerRole: "PLATFORM",
          signingStage: "STAGE1_CONTRACT",
          slotId: "STAGE1_ATTACHMENT1_PLATFORM"
        })
      ])
    );
  });

  it.each([
    ["Stage 1 body customer", "STAGE1_BODY_CUSTOMER"],
    ["Stage 1 body platform", "STAGE1_BODY_PLATFORM"],
    ["Stage 1 Attachment 1 customer", "STAGE1_ATTACHMENT1_CUSTOMER"],
    ["Stage 1 Attachment 1 platform", "STAGE1_ATTACHMENT1_PLATFORM"]
  ])("rejects missing %s slot before rendering or storage writes", async (_label, slotId) => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter();

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        renderModel: createModel({
          signingSlots: STAGE1_SIGNING_SLOTS.filter((slot) => slot.slotId !== slotId)
        })
      })
    ).rejects.toThrow(CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects duplicate Stage 1 body platform slot before rendering or storage writes", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter();

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        renderModel: createModel({
          contentTemplate: "Synthetic non-legal text. 合同正文-服务提供方盖章 appears here too."
        })
      })
    ).rejects.toThrow(CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects duplicate Stage 1 attachment customer slot in appendix data before rendering or storage writes", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter();

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        renderModel: createModel({
          appendix: {
            sections: [
              {
                rows: [{ label: "Accidental slot duplicate", value: "附件1订阅方案-订阅方签字" }],
                title: "Synthetic appendix"
              }
            ]
          }
        })
      })
    ).rejects.toThrow(CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("does not accept legacy signing anchor metadata as rendered Stage 1 slot text", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter();

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        renderModel: createModel({
          signingAnchors: {
            customerSignatureKeyword: "合同正文-订阅方签字",
            platformSealKeyword: "合同正文-服务提供方盖章"
          },
          signingSlots: []
        })
      })
    ).rejects.toThrow(CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects duplicate Stage 1 slot definitions before rendering or storage writes", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter();

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        renderModel: createModel({
          signingSlots: [
            ...STAGE1_SIGNING_SLOTS,
            {
              ...STAGE1_SIGNING_SLOTS[0]!
            }
          ]
        })
      })
    ).rejects.toThrow(CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects an incomplete customer/platform slot pair before rendering or storage writes", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter();

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        renderModel: createModel({
          signingSlots: STAGE1_SIGNING_SLOTS.filter(
            (slot) => slot.slotId !== "STAGE1_ATTACHMENT1_PLATFORM"
          )
        })
      })
    ).rejects.toThrow(CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects renderer diagnostics without Stage 1 slots", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter({
      rendererResult: {
        diagnostics: {
          hasStage1SigningSlots: false
        }
      }
    });

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        renderModel: createModel()
      })
    ).rejects.toThrow(/CONTRACT_PDF_ARTIFACT_RENDER_ANCHOR_MISSING/);

    expect(renderer.render).toHaveBeenCalledOnce();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects renderer diagnostics without legal body", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter({
      rendererResult: { diagnostics: { hasLegalBody: false } }
    });

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        renderModel: createModel()
      })
    ).rejects.toThrow(CONTRACT_PDF_ARTIFACT_LEGAL_BODY_MISSING);

    expect(renderer.render).toHaveBeenCalledOnce();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects renderer diagnostics without appendix", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter({
      rendererResult: { diagnostics: { hasAppendix: false } }
    });

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        renderModel: createModel()
      })
    ).rejects.toThrow(CONTRACT_PDF_ARTIFACT_APPENDIX_MISSING);

    expect(renderer.render).toHaveBeenCalledOnce();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("rejects missing Stage 1 slot coordinates before storage writes", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter({
      rendererResult: {
        slotCoordinates: createSlotCoordinates().filter(
          (coordinate) => coordinate.slotId !== "STAGE1_BODY_CUSTOMER"
        )
      }
    });

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        renderModel: createModel()
      })
    ).rejects.toThrow(CONTRACT_PDF_ARTIFACT_SLOT_COORDINATE_MISSING);

    expect(renderer.render).toHaveBeenCalledOnce();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid page", { pageNumber: -1 }],
    ["out-of-range x", { x: 801 }],
    ["out-of-range y", { y: 1132 }],
    ["invalid width", { width: 0 }],
    ["invalid height", { height: 0 }]
  ])(
    "rejects %s in Stage 1 slot coordinates before storage writes",
    async (_label, coordinateOverride) => {
      const { fileObjectCreate, renderer, storage, writer } = createWriter({
        rendererResult: {
          slotCoordinates: createSlotCoordinates({
            STAGE1_BODY_CUSTOMER: coordinateOverride
          })
        }
      });

      await expect(
        writer.writeGeneratedContractPdfArtifact({
          renderModel: createModel()
        })
      ).rejects.toThrow(CONTRACT_PDF_ARTIFACT_SLOT_COORDINATE_INVALID);

      expect(renderer.render).toHaveBeenCalledOnce();
      expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
      expect(fileObjectCreate).not.toHaveBeenCalled();
    }
  );

  it("rejects protected contract statuses", async () => {
    const { renderer, storage, writer } = createWriter();

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        contractStatus: "SIGNED",
        renderModel: createModel()
      })
    ).rejects.toThrow(CONTRACT_PDF_ARTIFACT_PROTECTED_STATUS);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
  });

  it("rejects an existing contract file unless regeneration is explicitly allowed", async () => {
    const { renderer, storage, writer } = createWriter();

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        existingContractFileId: "existing-file-1",
        renderModel: createModel()
      })
    ).rejects.toThrow(CONTRACT_PDF_ARTIFACT_EXISTING_FILE);

    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
  });

  it("recovers the existing deterministic object after a generation crash", async () => {
    const existingFileObject = {
      bucket: "application-materials",
      id: "file-existing",
      mimeType: "application/pdf",
      objectKey: "contracts/contract-1/generated/CON-TEST-001.pdf",
      originalName: "CON-TEST-001.pdf",
      sizeBytes: 18n
    };
    const { fileObjectCreate, storage, writer } = createWriter({ existingFileObject });

    const recovered = await writer.writeGeneratedContractPdfArtifact({
      recoverExistingObject: true,
      renderModel: createModel()
    });

    expect(recovered).toMatchObject({
      fileId: "file-existing",
      objectKey: existingFileObject.objectKey,
      sizeBytes: 18
    });
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("enforces the 20MB-compatible maximum size before storage writes", async () => {
    const { fileObjectCreate, renderer, storage, writer } = createWriter({
      rendererResult: {
        buffer: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(20)])
      }
    });

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        maxBytes: 10,
        renderModel: createModel()
      })
    ).rejects.toThrow(CONTRACT_PDF_ARTIFACT_TOO_LARGE);

    expect(renderer.render).toHaveBeenCalledOnce();
    expect(storage.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("does not create FileObject when storage fails", async () => {
    const storageError = new Error("storage unavailable");
    const { fileObjectCreate, storage, writer } = createWriter({
      storageError
    });

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        renderModel: createModel()
      })
    ).rejects.toThrow(storageError);

    expect(storage.putGeneratedContractPdfArtifact).toHaveBeenCalledOnce();
    expect(fileObjectCreate).not.toHaveBeenCalled();
  });

  it("best-effort deletes the private object when FileObject creation fails", async () => {
    const dbError = new Error("file object create failed");
    const { fileObjectCreate, storage, writer } = createWriter({
      fileObjectCreateError: dbError
    });

    await expect(
      writer.writeGeneratedContractPdfArtifact({
        renderModel: createModel()
      })
    ).rejects.toThrow(dbError);

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
    expect(local.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "application-materials/contracts/contract-1/generated/CON_2026_Unsafe_Name.pdf"
      })
    );
  });
});

function createWriter(
  options: {
    existingFileObject?: Record<string, unknown>;
    fileObjectCreateError?: Error;
    rendererResult?: {
      buffer?: Buffer;
      diagnostics?: Partial<ContractPdfRenderDiagnostics>;
      slotCoordinates?: ReturnType<typeof createSlotCoordinates>;
    };
    storageError?: Error;
  } = {}
) {
  const rendererResult = {
    buffer: options.rendererResult?.buffer ?? Buffer.from("%PDF-synthetic-pdf"),
    contentType: "application/pdf" as const,
    diagnostics: {
      hasAppendix: true,
      hasCjkContent: false,
      hasCustomerSignatureKeyword: true,
      hasLegalBody: true,
      hasPlatformSealKeyword: true,
      hasStage1SigningSlots: true,
      stage1SigningSlotOccurrences: {
        STAGE1_ATTACHMENT1_CUSTOMER: 1,
        STAGE1_ATTACHMENT1_PLATFORM: 1,
        STAGE1_BODY_CUSTOMER: 1,
        STAGE1_BODY_PLATFORM: 1
      },
      ...options.rendererResult?.diagnostics
    },
    slotCoordinates: options.rendererResult?.slotCoordinates ?? createSlotCoordinates(),
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
      findFirst: vi.fn(async () => options.existingFileObject ?? null)
    }
  };

  return {
    fileObjectCreate,
    prisma,
    renderer,
    storage,
    writer: new ContractPdfArtifactWriterService(
      renderer as never,
      storage as never,
      prisma as never
    )
  };
}

function createSlotCoordinates(
  overrides: Partial<
    Record<ContractPdfSigningSlot["slotId"], Partial<ContractPdfSigningSlotCoordinate>>
  > = {}
): ContractPdfSigningSlotCoordinate[] {
  return STAGE1_SIGNING_SLOTS.map((slot, index) => ({
    coordinateSource: "PDFKIT_RENDERER" as const,
    coordinateSystem: "FADADA_800_1131_TOP_LEFT" as const,
    height: 24,
    keyword: slot.keyword,
    pageNumber: index < 2 ? 0 : 1,
    pdfPageHeight: 841.89,
    pdfPageWidth: 595.28,
    slotId: slot.slotId,
    width: 180,
    x: 500,
    y: 600 + index,
    ...overrides[slot.slotId]
  }));
}

function createModel(
  overrides: Omit<Partial<ContractPdfRenderModel>, "signingSlots"> & {
    signingSlots?: ContractPdfSigningSlot[];
    signingStage?: string;
  } = {}
): ContractPdfRenderModel {
  return {
    appendix: {
      sections: [
        {
          rows: [
            { label: "Order number", value: "ORD-TEST-001" },
            { label: "Plan", value: "Synthetic monthly plan" }
          ],
          title: "Synthetic order snapshot appendix"
        }
      ]
    },
    contentTemplate: "Synthetic non-legal contract body for artifact writer tests only.",
    contractId: "contract-1",
    contractNo: "CON-TEST-001",
    generatedAt: new Date("2026-07-09T00:00:00.000Z"),
    orderNo: "ORD-TEST-001",
    signingStage: "STAGE1_CONTRACT",
    signingSlots: STAGE1_SIGNING_SLOTS.map((slot) => ({ ...slot })),
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
