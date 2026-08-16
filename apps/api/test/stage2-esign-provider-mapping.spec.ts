import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type {
  CreateSignTaskInput,
  ESignSigningSlot,
  ESignSigningSlotCoordinate
} from "../src/esign/esign.provider";
import {
  CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID,
  CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_MISSING,
  CONTRACT_PDF_ARTIFACT_SOURCE_HASH_MISMATCH,
  ContractPdfArtifactService
} from "../src/esign/contract-pdf-artifact.service";
import type {
  Stage2HandoverPdfArtifactSlotCoordinate
} from "../src/esign/contract-pdf-artifact.service";
import { FadadaESignProvider } from "../src/esign/fadada/fadada-esign.provider";
import { loadFadadaConfig } from "../src/esign/fadada/fadada.config";

describe("Stage 2 Fadada provider mapping", () => {
  it("rejects an unknown customer signing stage before provider endpoints", async () => {
    const harness = createProviderHarness();

    await expect(harness.provider.createSignTask({
      ...stage2CustomerInput("HDV-UNKNOWN-STAGE"),
      signingStage: "STAGE2_UNKNOWN"
    } as never)).rejects.toThrow(/FADADA_SIGNING_STAGE_UNSUPPORTED/);

    expect(harness.apiClient.uploadDocs).not.toHaveBeenCalled();
    expect(harness.apiClient.createExternalSignUrl).not.toHaveBeenCalled();
  });

  it("rejects an unknown platform signing stage before provider endpoints", async () => {
    const harness = createProviderHarness();

    await expect(harness.provider.autoSealTask?.({
      contractId: "contract-stage2-1",
      documentType: "DELIVERY_HANDOVER",
      placement: {
        keyword: "legacy-placement-must-not-run",
        type: "KEYWORD"
      },
      signingSlotCoordinates: [stage2ProviderCoordinates()[1]!],
      signingSlots: [stage2PlatformSlot()],
      signingStage: "STAGE2_UNKNOWN",
      taskNo: "HDV-UNKNOWN-STAGE",
      transactionId: "IGNORED"
    } as never)).rejects.toThrow(/FADADA_SIGNING_STAGE_UNSUPPORTED/);

    expect(harness.apiClient.autoSealContract).not.toHaveBeenCalled();
  });

  it("dispatches a Stage 2 customer slot to one coordinate-based manual-sign transaction", async () => {
    const harness = createProviderHarness();
    const input = stage2CustomerInput(`HDV-${"9".repeat(80)}`);
    input.signingSlotCoordinates = [stage2ProviderCoordinates()[0]!];

    const result = await harness.provider.createSignTask(input);

    expect(harness.pdfArtifactService.getContractPdfArtifact).toHaveBeenCalledWith(
      "contract-stage2-1",
      expect.objectContaining({
        fadadaEnabled: true,
        purpose: "FADADA_UPLOAD",
        requireGeneratedContractArtifact: true,
        requireStage2SlotCoordinates: true,
        expectedSha256: sha256(minimalPdf())
      })
    );
    expect(harness.apiClient.uploadDocs).toHaveBeenCalledOnce();
    expect(harness.apiClient.createExternalSignUrl).toHaveBeenCalledWith(expect.objectContaining({
      contractId: `HDV-${"9".repeat(80)}`,
      customerId: "provider-customer-1",
      signaturePositions: [{ pagenum: 9, x: 210, y: 980 }],
      transactionId: "STAGE2CUSTOMERH1"
    }));
    expect(result).toMatchObject({
      actions: [{
        coveredSlotIds: ["STAGE2_HANDOVER_CUSTOMER"],
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        providerTransactionId: "STAGE2CUSTOMERH1",
        signerType: "CUSTOMER",
        signingStage: "STAGE2_DELIVERY_HANDOVER"
      }],
      providerEnvelopeId: `HDV-${"9".repeat(80)}`,
      providerTaskId: "STAGE2CUSTOMERH1",
      signers: [{
        documentType: "DELIVERY_HANDOVER",
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        slotId: "STAGE2_HANDOVER_CUSTOMER",
        signerType: "CUSTOMER"
      }]
    });
    expect(result.providerTaskId.endsWith("H1")).toBe(true);
    expect(result.providerTaskId.length).toBeLessThanOrEqual(32);
    expect(result).not.toHaveProperty("documentObjectKey");
    expect(JSON.stringify(result.rawResponse)).not.toMatch(
      /objectKey|bucket|mock-sign-url|private-storage/i
    );
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["malformed", "not-a-sha256"]
  ])("rejects a %s Stage 2 source hash before provider upload", async (
    _label,
    sourcePdfHash
  ) => {
    const harness = createProviderHarness();

    await expect(harness.provider.createSignTask({
      ...stage2CustomerInput("HDV-SOURCE-HASH"),
      sourcePdfHash
    })).rejects.toThrow(CONTRACT_PDF_ARTIFACT_SOURCE_HASH_MISMATCH);

    expect(harness.apiClient.uploadDocs).not.toHaveBeenCalled();
    expect(harness.apiClient.createExternalSignUrl).not.toHaveBeenCalled();
  });

  it("uses persisted Stage 2 customer coordinates when the optional input assertion is omitted", async () => {
    const harness = createProviderHarness();

    await harness.provider.createSignTask(stage2CustomerInput("HDV-OMIT-COORDINATE"));

    expect(harness.apiClient.createExternalSignUrl).toHaveBeenCalledWith(expect.objectContaining({
      signaturePositions: [{ pagenum: 9, x: 210, y: 980 }]
    }));
  });

  it("rejects persisted Stage 2 slots on a non-final page before provider endpoints", async () => {
    const artifactHarness = createArtifactHarness({
      artifactOverride: { pageCount: 10 },
      slotCoordinates: stage2ArtifactCoordinates(8)
    });
    const harness = createProviderHarness();
    const provider = new FadadaESignProvider(
      harness.config,
      harness.apiClient as never,
      artifactHarness.service
    );

    await expect(provider.createSignTask(
      stage2CustomerInput("HDV-NON-FINAL-PAGE")
    )).rejects.toThrow(CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID);

    expect(harness.apiClient.uploadDocs).not.toHaveBeenCalled();
    expect(harness.apiClient.createExternalSignUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty coordinate list", []],
    ["the platform coordinate", [stage2ProviderCoordinates()[1]!]],
    ["duplicate customer coordinates", [
      stage2ProviderCoordinates()[0]!,
      stage2ProviderCoordinates()[0]!
    ]],
    ["a coordinate that differs from the persisted artifact", [{
      ...stage2ProviderCoordinates()[0]!,
      x: 211
    }]]
  ])("fails Stage 2 customer mapping closed when input supplies %s", async (
    _label,
    signingSlotCoordinates
  ) => {
    const harness = createProviderHarness();

    await expect(harness.provider.createSignTask({
      ...stage2CustomerInput("HDV-ASSERT-COORDINATE"),
      signingSlotCoordinates
    })).rejects.toThrow(/FADADA_STAGE2_CUSTOMER_COORDINATE_INVALID/);

    expect(harness.apiClient.uploadDocs).not.toHaveBeenCalled();
    expect(harness.apiClient.createExternalSignUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong document", {
      documentType: "CONTRACT_BODY"
    }],
    ["wrong slot", {
      signingSlots: [stage2PlatformSlot()]
    }],
    ["wrong role", {
      signingSlots: [{ ...stage2CustomerSlot(), signerRole: "PLATFORM" }]
    }],
    ["wrong action", {
      signingSlots: [{ ...stage2CustomerSlot(), providerActionType: "PLATFORM_AUTO_SEAL" }]
    }],
    ["duplicate slot", {
      signingSlots: [stage2CustomerSlot(), stage2CustomerSlot()]
    }]
  ])("fails Stage 2 customer mapping closed before provider endpoints for %s", async (_label, override) => {
    const harness = createProviderHarness();

    await expect(harness.provider.createSignTask({
      ...stage2CustomerInput("HDV-FAIL-CUSTOMER"),
      ...override
    } as never)).rejects.toThrow(/FADADA_STAGE2_CUSTOMER_MAPPING_INVALID/);

    expect(harness.apiClient.uploadDocs).not.toHaveBeenCalled();
    expect(harness.apiClient.createExternalSignUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["missing coordinate", stage2ArtifactCoordinates().filter((coordinate) =>
      coordinate.slotId !== "STAGE2_HANDOVER_CUSTOMER"
    )],
    ["duplicate coordinate", [
      ...stage2ArtifactCoordinates(),
      stage2ArtifactCoordinates()[0]!
    ]]
  ])("fails Stage 2 customer mapping closed before provider endpoints for %s", async (
    _label,
    slotCoordinates
  ) => {
    const harness = createProviderHarness({ slotCoordinates });

    await expect(harness.provider.createSignTask(
      stage2CustomerInput("HDV-FAIL-COORDINATE")
    )).rejects.toThrow(/FADADA_STAGE2_CUSTOMER_COORDINATE_INVALID/);

    expect(harness.apiClient.uploadDocs).not.toHaveBeenCalled();
    expect(harness.apiClient.createExternalSignUrl).not.toHaveBeenCalled();
  });

  it("dispatches a Stage 2 platform slot to one coordinate-based H2 auto-seal transaction", async () => {
    const harness = createProviderHarness();
    const taskNo = `HDV-${"8".repeat(80)}`;

    const result = await harness.provider.autoSealTask?.({
      callbackUrl: "https://callback.invalid/stage2",
      contractId: "contract-stage2-1",
      documentName: "handover.pdf",
      documentType: "DELIVERY_HANDOVER",
      providerEnvelopeId: taskNo,
      signingSlotCoordinates: [stage2ProviderCoordinates()[1]!],
      signingSlots: [stage2PlatformSlot()],
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: "task-stage2-1",
      taskNo,
      transactionId: "STAGE2PLATFORMH2"
    } as never);

    expect(harness.apiClient.autoSealContract).toHaveBeenCalledWith(expect.objectContaining({
      contractId: taskNo,
      customerId: "platform-customer-1",
      signatureId: "platform-signature-1",
      signaturePositions: [{ pagenum: 9, x: 590, y: 980 }],
      transactionId: "STAGE2PLATFORMH2"
    }));
    const providerInput = harness.apiClient.autoSealContract.mock.calls[0]![0];
    expect(providerInput.transactionId.endsWith("H2")).toBe(true);
    expect(providerInput.transactionId.length).toBeLessThanOrEqual(32);
    expect(result).toMatchObject({
      coveredSlotIds: ["STAGE2_HANDOVER_PLATFORM"],
      providerActionType: "PLATFORM_AUTO_SEAL",
      providerTransactionId: providerInput.transactionId,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      status: "COMPLETED"
    });
    expect(JSON.stringify(result?.rawResponse)).not.toMatch(
      /objectKey|bucket|mock-sign-url|private-storage/i
    );
  });

  it.each([
    ["wrong document", {
      documentType: "CONTRACT_BODY"
    }],
    ["wrong slot", {
      signingSlots: [stage2CustomerSlot()]
    }],
    ["wrong role", {
      signingSlots: [{ ...stage2PlatformSlot(), signerRole: "CUSTOMER" }]
    }],
    ["wrong action", {
      signingSlots: [{ ...stage2PlatformSlot(), providerActionType: "CUSTOMER_MANUAL_SIGN" }]
    }],
    ["missing coordinate", {
      signingSlotCoordinates: []
    }],
    ["duplicate coordinate", {
      signingSlotCoordinates: [
        stage2ProviderCoordinates()[1]!,
        stage2ProviderCoordinates()[1]!
      ]
    }]
  ])("fails Stage 2 platform mapping closed before provider endpoints for %s", async (_label, override) => {
    const harness = createProviderHarness();

    await expect(harness.provider.autoSealTask?.({
      callbackUrl: "https://callback.invalid/stage2",
      contractId: "contract-stage2-1",
      documentName: "handover.pdf",
      documentType: "DELIVERY_HANDOVER",
      providerEnvelopeId: "HDV-FAIL-PLATFORM",
      signingSlotCoordinates: [stage2ProviderCoordinates()[1]!],
      signingSlots: [stage2PlatformSlot()],
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: "task-stage2-1",
      taskNo: "HDV-FAIL-PLATFORM",
      transactionId: "IGNORED",
      ...override
    } as never)).rejects.toThrow(/FADADA_STAGE2_PLATFORM_MAPPING_INVALID/);

    expect(harness.apiClient.autoSealContract).not.toHaveBeenCalled();
  });

  it("requires an explicit configured platform signature id before Stage 2 auto-seal", async () => {
    const harness = createProviderHarness({
      config: {
        FADADA_PLATFORM_SIGNATURE_ID: ""
      }
    });

    await expect(harness.provider.autoSealTask?.({
      contractId: "contract-stage2-1",
      documentType: "DELIVERY_HANDOVER",
      signingSlotCoordinates: [stage2ProviderCoordinates()[1]!],
      signingSlots: [stage2PlatformSlot()],
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskNo: "HDV-NO-SIGNATURE",
      transactionId: "IGNORED"
    } as never)).rejects.toThrow(/FADADA_PLATFORM_AUTO_SEAL_CONFIG_MISSING/);

    expect(harness.apiClient.autoSealContract).not.toHaveBeenCalled();
  });

  it("maps the exact production 9999 pending response without echoed identities to signing", async () => {
    const harness = createProviderHarness();
    harness.apiClient.querySignResult.mockResolvedValueOnce({
      contractId: "HDVQUERY1",
      raw: {
        msg: "success",
        result: "9999",
        result_desc: "待签署"
      },
      resultCode: "9999",
      resultDesc: "待签署",
      status: "UNKNOWN",
      transactionId: "HDVQUERY1H1"
    });

    await expect(harness.provider.querySignerStatus({
      contractId: "HDVQUERY1",
      providerCustomerId: "provider-customer-1",
      providerTaskId: "HDVQUERY1H1",
      providerTransactionId: "HDVQUERY1H1",
      signerId: "signer-stage2-query-1",
      slotId: "STAGE2_HANDOVER_CUSTOMER",
      taskId: "task-stage2-query-1"
    })).resolves.toMatchObject({
      resultCode: "9999",
      resultDescription: "待签署",
      status: "SIGNING"
    });
  });

  it.each([
    {
      name: "different description",
      result: {
        resultCode: "9999",
        resultDesc: "处理中"
      }
    },
    {
      name: "different result code",
      result: {
        resultCode: "1000",
        resultDesc: "待签署"
      }
    },
    {
      name: "conflicting echoed transaction",
      result: {
        providerTransactionId: "OTHERH1",
        resultCode: "9999",
        resultDesc: "待签署"
      }
    }
  ])("keeps $name closed instead of treating it as a pending signature", async ({ result }) => {
    const harness = createProviderHarness();
    harness.apiClient.querySignResult.mockResolvedValueOnce({
      contractId: "HDVQUERY1",
      raw: result,
      status: "UNKNOWN",
      transactionId: "HDVQUERY1H1",
      ...result
    });

    await expect(harness.provider.querySignerStatus({
      contractId: "HDVQUERY1",
      providerCustomerId: "provider-customer-1",
      providerTaskId: "HDVQUERY1H1",
      providerTransactionId: "HDVQUERY1H1",
      signerId: "signer-stage2-query-1",
      slotId: "STAGE2_HANDOVER_CUSTOMER",
      taskId: "task-stage2-query-1"
    })).resolves.toMatchObject({ status: "UNKNOWN" });
  });
});

describe("Stage 2 Contract PDF artifact preflight", () => {
  it("reads only a generated Stage 2 source artifact with complete persisted slot metadata", async () => {
    const harness = createArtifactHarness();

    const artifact = await harness.service.preflightContractPdfArtifact("contract-stage2-1", {
      fadadaEnabled: true,
      purpose: "FADADA_UPLOAD",
      requireGeneratedContractArtifact: true,
      requireStage2SlotCoordinates: true
    } as never);

    expect(artifact.slotCoordinates).toEqual(stage2ArtifactCoordinates());
    expect(artifact.preflight).toMatchObject({
      generatedContractArtifact: true,
      source: "CONTRACT_FILE",
      stage1SlotCoordinatesVerified: false,
      stage2SlotCoordinatesVerified: true
    });
    expect(harness.storageService.getObject).toHaveBeenCalledOnce();
  });

  it("rejects downloaded Stage 2 PDF bytes whose SHA-256 differs from the bound source hash", async () => {
    const boundPdf = minimalPdf();
    const harness = createArtifactHarness({
      downloadedPdf: Buffer.from("%PDF-1.4\nreplaced artifact\n%%EOF\n", "utf8")
    });

    await expect(harness.service.preflightContractPdfArtifact("contract-stage2-1", {
      expectedSha256: sha256(boundPdf),
      fadadaEnabled: true,
      purpose: "FADADA_UPLOAD",
      requireGeneratedContractArtifact: true,
      requireStage2SlotCoordinates: true
    })).rejects.toThrow(CONTRACT_PDF_ARTIFACT_SOURCE_HASH_MISMATCH);
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["fractional", 1.5]
  ])("rejects a Stage 2 artifact with %s pageCount", async (_label, pageCount) => {
    const harness = createArtifactHarness({
      artifactOverride: { pageCount }
    });

    await expect(harness.service.preflightContractPdfArtifact("contract-stage2-1", {
      fadadaEnabled: true,
      purpose: "FADADA_UPLOAD",
      requireGeneratedContractArtifact: true,
      requireStage2SlotCoordinates: true
    })).rejects.toThrow(CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID);
  });

  it.each([
    ["file id", {
      fileId: "different-file"
    }],
    ["artifact kind", {
      artifactKind: "different-kind"
    }],
    ["signing stage", {
      signingStage: "STAGE1_CONTRACT"
    }],
    ["document type", {
      documentType: "CONTRACT_BODY"
    }]
  ])("rejects Stage 2 artifact metadata with the wrong %s", async (_label, artifactOverride) => {
    const harness = createArtifactHarness({ artifactOverride });

    await expect(harness.service.preflightContractPdfArtifact("contract-stage2-1", {
      fadadaEnabled: true,
      purpose: "FADADA_UPLOAD",
      requireGeneratedContractArtifact: true,
      requireStage2SlotCoordinates: true
    } as never)).rejects.toThrow(CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID);
  });

  it.each([
    ["missing metadata", undefined],
    ["missing customer slot", stage2ArtifactCoordinates().filter((coordinate) =>
      coordinate.slotId !== "STAGE2_HANDOVER_CUSTOMER"
    )],
    ["duplicate customer slot", [
      ...stage2ArtifactCoordinates(),
      stage2ArtifactCoordinates()[0]!
    ]]
  ])("rejects a generated Stage 2 artifact with %s", async (_label, slotCoordinates) => {
    const harness = createArtifactHarness({
      ...(slotCoordinates === undefined
        ? { omitStage2Artifact: true }
        : { slotCoordinates })
    });

    await expect(harness.service.preflightContractPdfArtifact("contract-stage2-1", {
      fadadaEnabled: true,
      purpose: "FADADA_UPLOAD",
      requireGeneratedContractArtifact: true,
      requireStage2SlotCoordinates: true
    } as never)).rejects.toThrow(
      slotCoordinates === undefined
        ? CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_MISSING
        : CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_INVALID
    );
  });
});

function createProviderHarness(options: {
  config?: Record<string, string>;
  slotCoordinates?: ReturnType<typeof stage2ArtifactCoordinates>;
} = {}) {
  const apiClient = {
    autoSealContract: vi.fn(async (input) => ({
      contractId: input.contractId,
      raw: {
        bucket: "private-storage",
        objectKey: "private-storage/signed.pdf",
        signUrl: "mock-sign-url"
      },
      resultCode: "1000",
      resultDesc: "success",
      transactionId: input.transactionId
    })),
    createExternalSignUrl: vi.fn(async (input) => ({
      raw: {
        bucket: "private-storage",
        objectKey: "private-storage/source.pdf",
        signUrl: "mock-sign-url"
      },
      signUrl: "mock-sign-url",
      signUrlExpiresAt: new Date("2026-07-26T12:00:00.000Z"),
      transactionId: input.transactionId
    })),
    querySignResult: vi.fn(async () => ({
      contractId: "HDVQUERY1",
      providerContractId: "HDVQUERY1",
      providerCustomerId: "provider-customer-1",
      providerTransactionId: "HDVQUERY1H1",
      raw: { result: "0", result_desc: "签署中" },
      resultCode: "0",
      resultDesc: "签署中",
      status: "SIGNING" as const,
      transactionId: "HDVQUERY1H1"
    })),
    uploadDocs: vi.fn(async (input) => ({
      contractId: input.contractId,
      raw: {
        bucket: "private-storage",
        objectKey: "private-storage/source.pdf"
      }
    }))
  };
  const pdfArtifactService = {
    getContractPdfArtifact: vi.fn(async () => ({
      buffer: minimalPdf(),
      contentType: "application/pdf" as const,
      fileName: "handover.pdf",
      objectKey: "contracts/contract-stage2-1/generated/handover.pdf",
      size: minimalPdf().length,
      slotCoordinates: options.slotCoordinates ?? stage2ArtifactCoordinates(),
      source: "CONTRACT_FILE" as const
    }))
  };
  const config = loadFadadaConfig(new ConfigService({
    ESIGN_PROVIDER: "fadada",
    FADADA_API_VERSION: "2.0",
    FADADA_APP_ID: "app-test",
    FADADA_APP_SECRET: "secret-test",
    FADADA_BASE_URL: "https://provider.invalid/api/",
    FADADA_ENABLED: "false",
    FADADA_ENV: "sandbox",
    FADADA_FULL_SIGNING_SMOKE: "1",
    FADADA_PLATFORM_CUSTOMER_ID: "platform-customer-1",
    FADADA_PLATFORM_SIGNATURE_ID: "platform-signature-1",
    FADADA_TEST_CUSTOMER_ID: "provider-customer-1",
    FADADA_TEST_LOCAL_CUSTOMER_ID: "customer-1",
    ...options.config
  }));
  const prisma = {
    contractESignSigner: {
      findFirst: vi.fn(async () => ({
        customerId: "customer-1",
        documentType: "DELIVERY_HANDOVER",
        id: "signer-stage2-query-1",
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        providerSignerId: "HDVQUERY1H1",
        providerTransactionId: "HDVQUERY1H1",
        signerType: "CUSTOMER",
        slotId: "STAGE2_HANDOVER_CUSTOMER",
        snapshot: null,
        taskId: "task-stage2-query-1"
      }))
    },
    contractESignTask: {
      findFirst: vi.fn(async () => ({
        documentType: "DELIVERY_HANDOVER",
        id: "task-stage2-query-1",
        provider: "FADADA",
        providerEnvelopeId: "HDVQUERY1",
        providerTaskId: "HDVQUERY1H1",
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        taskNo: "HDVQUERY1"
      }))
    },
    customerESignProviderAccount: {
      findFirst: vi.fn(async () => ({
        providerCustomerId: "provider-customer-1"
      }))
    }
  };

  return {
    apiClient,
    config,
    pdfArtifactService,
    provider: new FadadaESignProvider(
      config,
      apiClient as never,
      pdfArtifactService as never,
      prisma as never
    )
  };
}

function createArtifactHarness(options: {
  artifactOverride?: Record<string, unknown>;
  downloadedPdf?: Buffer;
  omitStage2Artifact?: boolean;
  slotCoordinates?: ReturnType<typeof stage2ArtifactCoordinates>;
} = {}) {
  const pdf = options.downloadedPdf ?? minimalPdf();
  const fileObject = {
    bucket: "application-materials",
    id: "file-stage2-1",
    mimeType: "application/pdf",
    objectKey: "contracts/contract-stage2-1/generated/handover.pdf",
    originalName: "handover.pdf",
    sizeBytes: BigInt(pdf.length)
  };
  const stage2HandoverPdfArtifact = {
    artifactKind: "stage2-handover-pdf-source",
    documentType: "DELIVERY_HANDOVER",
    fileId: fileObject.id,
    pageCount: 10,
    signingStage: "STAGE2_DELIVERY_HANDOVER",
    slotCoordinates: options.slotCoordinates ?? stage2ArtifactCoordinates(),
    ...options.artifactOverride
  };
  const contract = {
    contractNo: "HDV-1",
    contractSnapshot: options.omitStage2Artifact
      ? { artifactKind: "stage2-handover-pdf-source" }
      : {
          artifactKind: "stage2-handover-pdf-source",
          stage2HandoverPdfArtifact
        },
    contractVersion: { fileId: null },
    deletedAt: null,
    fileId: fileObject.id,
    id: "contract-stage2-1"
  };
  const prisma = {
    contract: {
      findFirst: vi.fn(async () => contract)
    },
    fileObject: {
      findUnique: vi.fn(async () => fileObject)
    }
  };
  const storageService = {
    getObject: vi.fn(async () => ({
      contentType: "application/pdf",
      stream: Readable.from([pdf])
    }))
  };
  const service = new ContractPdfArtifactService(
    prisma as never,
    storageService as never,
    new ConfigService({ FADADA_ENABLED: "false", NODE_ENV: "test" })
  );

  return { service, storageService };
}

function stage2CustomerInput(taskNo: string): CreateSignTaskInput {
  return {
    callbackUrl: "https://callback.invalid/stage2",
    contractId: "contract-stage2-1",
    documentName: "handover.pdf",
    documentType: "DELIVERY_HANDOVER",
    redirectUrl: "https://portal.invalid/stage2",
    signers: [{
      customerId: "customer-1",
      name: "Customer",
      phone: "masked",
      signerType: "CUSTOMER" as const
    }],
    signingSlots: [stage2CustomerSlot()],
    signingStage: "STAGE2_DELIVERY_HANDOVER" as const,
    sourcePdfHash: sha256(minimalPdf()),
    taskId: "task-stage2-1",
    taskNo,
    transactionId: "STAGE2CUSTOMERH1"
  };
}

function stage2CustomerSlot(): ESignSigningSlot {
  return {
    documentType: "DELIVERY_HANDOVER",
    keyword: "stage2-customer-signature",
    providerActionType: "CUSTOMER_MANUAL_SIGN",
    required: true,
    signerRole: "CUSTOMER",
    signingStage: "STAGE2_DELIVERY_HANDOVER",
    slotId: "STAGE2_HANDOVER_CUSTOMER"
  };
}

function stage2PlatformSlot(): ESignSigningSlot {
  return {
    documentType: "DELIVERY_HANDOVER",
    keyword: "stage2-platform-seal",
    providerActionType: "PLATFORM_AUTO_SEAL",
    required: true,
    signerRole: "PLATFORM",
    signingStage: "STAGE2_DELIVERY_HANDOVER",
    slotId: "STAGE2_HANDOVER_PLATFORM"
  };
}

function stage2ProviderCoordinates(): ESignSigningSlotCoordinate[] {
  return stage2ArtifactCoordinates().map(({ pageNumber, slotId, x, y }) => ({
    pageNumber,
    slotId,
    x,
    y
  }));
}

function stage2ArtifactCoordinates(pageNumber = 9): Stage2HandoverPdfArtifactSlotCoordinate[] {
  return [
    {
      coordinateSource: "PDFKIT_RENDERER",
      coordinateSystem: "FADADA_800_1131_TOP_LEFT",
      documentType: "DELIVERY_HANDOVER",
      height: 90,
      pageNumber,
      pdfPageHeight: 841.89,
      pdfPageWidth: 595.28,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      slotId: "STAGE2_HANDOVER_CUSTOMER",
      width: 250,
      x: 210,
      y: 980
    },
    {
      coordinateSource: "PDFKIT_RENDERER",
      coordinateSystem: "FADADA_800_1131_TOP_LEFT",
      documentType: "DELIVERY_HANDOVER",
      height: 90,
      pageNumber,
      pdfPageHeight: 841.89,
      pdfPageWidth: 595.28,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      slotId: "STAGE2_HANDOVER_PLATFORM",
      width: 250,
      x: 590,
      y: 980
    }
  ];
}

function minimalPdf() {
  return Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
