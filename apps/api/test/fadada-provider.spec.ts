import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";

import { createESignProviderClient } from "../src/esign/esign.module";
import type { ESignSigningSlot, ESignSigningSlotCoordinate } from "../src/esign/esign.provider";
import { buildFadadaMsgDigest } from "../src/esign/fadada/fadada-digest";
import { FadadaESignProvider } from "../src/esign/fadada/fadada-esign.provider";
import { loadFadadaConfig } from "../src/esign/fadada/fadada.config";
import { MockESignProvider } from "../src/esign/mock-esign.provider";

describe("Fadada provider configuration", () => {
  it("does not require Fadada env when the selected provider is mock", () => {
    const provider = createESignProviderClient(new ConfigService({ ESIGN_PROVIDER: "mock" }));

    expect(provider).toBeInstanceOf(MockESignProvider);
  });

  it("maps the actual mock provider through typed Stage 2 customer and platform actions", async () => {
    const provider = createESignProviderClient(new ConfigService({
      ESIGN_PROVIDER: "mock",
      PORTAL_BASE_URL: "https://portal.invalid"
    }));
    const customer = await provider.createSignTask({
      contractId: "contract-stage2-mock",
      documentName: "handover.pdf",
      documentType: "DELIVERY_HANDOVER",
      signers: [{
        customerId: "customer-1",
        signerId: "signer-stage2-mock",
        signerType: "CUSTOMER"
      }],
      signingSlots: [{
        documentType: "DELIVERY_HANDOVER",
        keyword: "stage2-handover-customer",
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        required: true,
        signerRole: "CUSTOMER",
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        slotId: "STAGE2_HANDOVER_CUSTOMER"
      }],
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      sourcePdfHash: "a".repeat(64),
      taskId: "task-stage2-mock",
      taskNo: "MOCKSTAGE2TASK",
      transactionId: "MOCKSTAGE2H1"
    });
    const platform = await provider.autoSealTask?.({
      contractId: "contract-stage2-mock",
      documentType: "DELIVERY_HANDOVER",
      platformCustomerId: "platform-customer-1",
      providerEnvelopeId: "MOCKSTAGE2TASK",
      providerTaskId: "MOCKSTAGE2H1",
      signerId: "platform-signer-stage2-mock",
      signingSlots: [{
        documentType: "DELIVERY_HANDOVER",
        keyword: "stage2-handover-platform",
        providerActionType: "PLATFORM_AUTO_SEAL",
        required: true,
        signerRole: "PLATFORM",
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        slotId: "STAGE2_HANDOVER_PLATFORM"
      }],
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: "task-stage2-mock",
      taskNo: "MOCKSTAGE2TASK",
      transactionId: "MOCKSTAGE2H2"
    });

    expect(customer).toMatchObject({
      actions: [{
        coveredSlotIds: ["STAGE2_HANDOVER_CUSTOMER"],
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        providerTransactionId: "MOCKSTAGE2H1",
        signerType: "CUSTOMER",
        signingStage: "STAGE2_DELIVERY_HANDOVER"
      }],
      providerEnvelopeId: "MOCKSTAGE2TASK",
      providerTaskId: "MOCKSTAGE2H1"
    });
    expect(platform).toMatchObject({
      coveredSlotIds: ["STAGE2_HANDOVER_PLATFORM"],
      providerActionType: "PLATFORM_AUTO_SEAL",
      providerTransactionId: "MOCKSTAGE2H2",
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      status: "COMPLETED"
    });

    await expect(provider.autoSealTask?.({
      contractId: "contract-stage1-mock",
      signingStage: "STAGE1_CONTRACT",
      taskNo: "MOCKSTAGE1TASK",
      transactionId: "MOCKSTAGE1H2"
    })).rejects.toThrow(/ESIGN_PLATFORM_AUTO_SEAL_UNSUPPORTED/);
  });

  it("requires base URL, app ID, and app secret when ESIGN_PROVIDER=fadada", () => {
    expect(() => loadFadadaConfig(new ConfigService({ ESIGN_PROVIDER: "fadada" }))).toThrow(
      /FADADA_CONFIG_MISSING: FADADA_BASE_URL, FADADA_APP_ID, FADADA_APP_SECRET/
    );
  });

  it("creates a Fadada skeleton provider when selected and configured", () => {
    const provider = createESignProviderClient(configService({ ESIGN_PROVIDER: "fadada" }));

    expect(provider).toBeInstanceOf(FadadaESignProvider);
  });

  it("rejects unknown provider values with a clear error", () => {
    expect(() => createESignProviderClient(new ConfigService({ ESIGN_PROVIDER: "unexpected" }))).toThrow(
      /ESIGN_PROVIDER_UNSUPPORTED: unexpected/
    );
  });
});

describe("Fadada provider B2-A flow", () => {
  it("rejects Stage 1 customer mapping before upload when required customer slot data is incomplete", async () => {
    const apiClient = {
      createExternalSignUrl: vi.fn(),
      uploadDocs: vi.fn()
    };
    const pdfArtifactService = {
      getContractPdfArtifact: vi.fn()
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_FULL_SIGNING_SMOKE: "1",
      FADADA_TEST_CUSTOMER_ID: "fadada-provider-customer-1",
      FADADA_TEST_LOCAL_CUSTOMER_ID: "customer-1"
    })), apiClient as never, pdfArtifactService as never);

    await expect(provider.createSignTask({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      documentName: "Contract.pdf",
      redirectUrl: "https://app.example.test/portal/contracts/contract-1",
      signers: [{ customerId: "customer-1", name: "Customer", phone: "13800000000", signerType: "CUSTOMER" }],
      signingStage: "STAGE1_CONTRACT",
      signingSlots: [{
        documentType: "CONTRACT_BODY",
        keyword: "合同正文-订阅方签字",
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        required: true,
        signerRole: "CUSTOMER",
        signingStage: "STAGE1_CONTRACT",
        slotId: "STAGE1_BODY_CUSTOMER"
      }],
      taskId: "task-1",
      taskNo: "ESG-1"
    })).rejects.toThrow(/FADADA_STAGE1_CUSTOMER_SLOT/);

    expect(pdfArtifactService.getContractPdfArtifact).not.toHaveBeenCalled();
    expect(apiClient.uploadDocs).not.toHaveBeenCalled();
    expect(apiClient.createExternalSignUrl).not.toHaveBeenCalled();
  });

  it("maps Stage 1 customer slots to one coordinate-based manual signing transaction", async () => {
    const apiClient = {
      createExternalSignUrl: vi.fn(async () => ({
        raw: { endpoint: "extsign.api", signaturePositions: 2 },
        signUrl: "https://sign.example.test/customer-stage1",
        signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z"),
        transactionId: "ESG1S1"
      })),
      uploadDocs: vi.fn(async () => ({
        contractId: "ESG-1",
        raw: { upload: "ok" }
      }))
    };
    const pdfArtifactService = {
      getContractPdfArtifact: vi.fn(async () => ({
        buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
        contentType: "application/pdf" as const,
        fileName: "contract.pdf",
        objectKey: "contracts/contract-1/generated/contract.pdf",
        size: 15,
        slotCoordinates: stage1SlotCoordinates(),
        source: "CONTRACT_FILE" as const
      }))
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_FULL_SIGNING_SMOKE: "1",
      FADADA_TEST_CUSTOMER_ID: "fadada-provider-customer-1",
      FADADA_TEST_LOCAL_CUSTOMER_ID: "customer-1"
    })), apiClient as never, pdfArtifactService as never);

    const result = await provider.createSignTask({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      documentName: "Contract.pdf",
      redirectUrl: "https://app.example.test/portal/contracts/contract-1",
      signers: [{ customerId: "customer-1", name: "Customer", phone: "13800000000", signerType: "CUSTOMER" }],
      signingStage: "STAGE1_CONTRACT",
      signingSlotCoordinates: stage1SlotCoordinates(),
      signingSlots: stage1SigningSlots(),
      taskId: "task-1",
      taskNo: "ESG-1"
    });

    expect(pdfArtifactService.getContractPdfArtifact).toHaveBeenCalledWith("contract-1", expect.objectContaining({
      purpose: "FADADA_UPLOAD",
      requireGeneratedContractArtifact: true,
      requireStage1SlotCoordinates: true
    }));
    expect(apiClient.uploadDocs).toHaveBeenCalledWith(expect.objectContaining({
      contractId: "ESG-1",
      fileName: "contract.pdf",
      pdf: expect.any(Buffer)
    }));
    expect(apiClient.createExternalSignUrl).toHaveBeenCalledWith(expect.objectContaining({
      contractId: "ESG-1",
      customerId: "fadada-provider-customer-1",
      notifyUrl: "https://api.example.test/esign/callback/fadada",
      returnUrl: "https://app.example.test/portal/contracts/contract-1",
      signaturePositions: [
        { pagenum: 0, x: 520, y: 730 },
        { pagenum: 2, x: 522, y: 732 }
      ],
      transactionId: "ESG1S1"
    }));
    expect(result).toMatchObject({
      documentObjectKey: "contracts/contract-1/generated/contract.pdf",
      providerEnvelopeId: "ESG-1",
      providerTaskId: "ESG1S1",
      signUrl: "https://sign.example.test/customer-stage1",
      actions: [{
        coveredSlotIds: ["STAGE1_BODY_CUSTOMER", "STAGE1_ATTACHMENT1_CUSTOMER"],
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        providerSignerId: "ESG1S1",
        providerTransactionId: "ESG1S1",
        signerType: "CUSTOMER",
        signingStage: "STAGE1_CONTRACT"
      }]
    });
  });

  it("rejects createSignTask before upload when provider customer id is unavailable", async () => {
    const apiClient = {
      createExternalSignUrl: vi.fn(),
      uploadDocs: vi.fn()
    };
    const pdfArtifactService = {
      getContractPdfArtifact: vi.fn()
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService()), apiClient as never, pdfArtifactService as never);

    await expect(provider.createSignTask({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      documentName: "Contract.pdf",
      redirectUrl: "https://app.example.test/portal/contracts/contract-1",
      signers: [{ customerId: "customer-1", name: "Customer", phone: "13800000000", signerType: "CUSTOMER" }],
      taskId: "task-1",
      taskNo: "ESG-1"
    })).rejects.toThrow(/FADADA_SIGNER_CUSTOMER_ID_MISSING/);

    expect(pdfArtifactService.getContractPdfArtifact).not.toHaveBeenCalled();
    expect(apiClient.uploadDocs).not.toHaveBeenCalled();
    expect(apiClient.createExternalSignUrl).not.toHaveBeenCalled();
  });

  it("uses the B5 smoke provider customer id only for the matching local customer", async () => {
    const apiClient = {
      createExternalSignUrl: vi.fn(async () => ({
        raw: { sign_url: "https://sign.example.test/customer" },
        signUrl: "https://sign.example.test/customer",
        signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z"),
        transactionId: "ESG1S1"
      })),
      uploadDocs: vi.fn(async () => ({
        contractId: "ESG-1",
        raw: { upload: "ok" }
      }))
    };
    const pdfArtifactService = {
      getContractPdfArtifact: vi.fn(async () => ({
        buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
        contentType: "application/pdf" as const,
        fileName: "contract.pdf",
        objectKey: "contracts/contract.pdf",
        size: 15,
        source: "CONTRACT_VERSION_FILE" as const
      }))
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_FULL_SIGNING_SMOKE: "1",
      FADADA_TEST_CUSTOMER_ID: "fadada-provider-customer-1",
      FADADA_TEST_LOCAL_CUSTOMER_ID: "customer-1"
    })), apiClient as never, pdfArtifactService as never);

    const result = await provider.createSignTask({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      documentName: "Contract.pdf",
      redirectUrl: "https://app.example.test/portal/contracts/contract-1",
      signers: [{ customerId: "customer-1", name: "Customer", phone: "13800000000", signerType: "CUSTOMER" }],
      taskId: "task-1",
      taskNo: "ESG-1"
    });

    expect(pdfArtifactService.getContractPdfArtifact).toHaveBeenCalledWith("contract-1");
    expect(apiClient.uploadDocs).toHaveBeenCalledWith({
      contractId: "ESG-1",
      docTitle: "Contract.pdf",
      fileName: "contract.pdf",
      pdf: expect.any(Buffer)
    });
    expect(apiClient.createExternalSignUrl).toHaveBeenCalledWith(expect.objectContaining({
      contractId: "ESG-1",
      customerId: "fadada-provider-customer-1",
      notifyUrl: "https://api.example.test/esign/callback/fadada",
      returnUrl: "https://app.example.test/portal/contracts/contract-1",
      transactionId: "ESG1S1"
    }));
    expect(result).toMatchObject({
      documentObjectKey: "contracts/contract.pdf",
      providerEnvelopeId: "ESG-1",
      providerTaskId: "ESG1S1",
      signUrl: "https://sign.example.test/customer",
      signers: [{
        customerId: "customer-1",
        providerSignerId: "ESG1S1",
        signUrl: "https://sign.example.test/customer",
        signerType: "CUSTOMER"
      }]
    });
  });

  it("generates documented-safe transaction ids from long task numbers", async () => {
    const apiClient = {
      createExternalSignUrl: vi.fn(async () => ({
        raw: { sign_url: "https://sign.example.test/customer" },
        signUrl: "https://sign.example.test/customer",
        signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z"),
        transactionId: "ignored-by-provider"
      })),
      uploadDocs: vi.fn(async () => ({
        contractId: "ESG-1",
        raw: { upload: "ok" }
      }))
    };
    const pdfArtifactService = {
      getContractPdfArtifact: vi.fn(async () => ({
        buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
        contentType: "application/pdf" as const,
        fileName: "contract.pdf",
        objectKey: "contracts/contract.pdf",
        size: 15,
        source: "CONTRACT_VERSION_FILE" as const
      }))
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_FULL_SIGNING_SMOKE: "1",
      FADADA_TEST_CUSTOMER_ID: "fadada-provider-customer-1",
      FADADA_TEST_LOCAL_CUSTOMER_ID: "customer-1"
    })), apiClient as never, pdfArtifactService as never);

    const result = await provider.createSignTask({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      documentName: "Contract.pdf",
      signers: [{ customerId: "customer-1", name: "Customer", phone: "13800000000", signerType: "CUSTOMER" }],
      taskId: "task-1",
      taskNo: `ESG${"9".repeat(80)}`
    });

    expect(result.providerTaskId).toMatch(/^[A-Za-z0-9]{1,32}$/);
    expect(result.providerTaskId.length).toBeLessThanOrEqual(32);
    expect(result.providerTaskId.endsWith("S1")).toBe(true);
    expect(apiClient.createExternalSignUrl).toHaveBeenCalledWith(expect.objectContaining({
      transactionId: result.providerTaskId
    }));
  });

  it("rejects the B5 smoke override in production even when smoke env is enabled", async () => {
    const apiClient = {
      createExternalSignUrl: vi.fn(),
      uploadDocs: vi.fn()
    };
    const pdfArtifactService = {
      getContractPdfArtifact: vi.fn()
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_ENV: "production",
      FADADA_FULL_SIGNING_SMOKE: "1",
      FADADA_TEST_CUSTOMER_ID: "fadada-provider-customer-1",
      FADADA_TEST_LOCAL_CUSTOMER_ID: "customer-1"
    })), apiClient as never, pdfArtifactService as never);

    await expect(provider.createSignTask({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      documentName: "Contract.pdf",
      redirectUrl: "https://app.example.test/portal/contracts/contract-1",
      signers: [{ customerId: "customer-1", name: "Customer", phone: "13800000000", signerType: "CUSTOMER" }],
      taskId: "task-1",
      taskNo: "ESG-1"
    })).rejects.toThrow(/FADADA_PRODUCTION_SMOKE_OVERRIDE_DISABLED/);

    expect(pdfArtifactService.getContractPdfArtifact).not.toHaveBeenCalled();
    expect(apiClient.uploadDocs).not.toHaveBeenCalled();
    expect(apiClient.createExternalSignUrl).not.toHaveBeenCalled();
  });

  it("uses a verified formal binding before the B5 smoke override", async () => {
    const apiClient = {
      createExternalSignUrl: vi.fn(async () => ({
        raw: { sign_url: "https://sign.example.test/customer" },
        signUrl: "https://sign.example.test/customer",
        signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z"),
        transactionId: "ESG1S1"
      })),
      uploadDocs: vi.fn(async () => ({
        contractId: "ESG-1",
        raw: { upload: "ok" }
      }))
    };
    const pdfArtifactService = {
      getContractPdfArtifact: vi.fn(async () => ({
        buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
        contentType: "application/pdf" as const,
        fileName: "contract.pdf",
        objectKey: "contracts/contract.pdf",
        size: 15,
        source: "CONTRACT_VERSION_FILE" as const
      }))
    };
    const prisma = {
      customerESignProviderAccount: {
        findFirst: vi.fn(async () => ({
          providerCustomerId: "fadada-formal-customer-1"
        }))
      }
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_FULL_SIGNING_SMOKE: "1",
      FADADA_TEST_CUSTOMER_ID: "fadada-smoke-customer-1",
      FADADA_TEST_LOCAL_CUSTOMER_ID: "customer-1"
    })), apiClient as never, pdfArtifactService as never, prisma as never);

    const result = await provider.createSignTask({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      documentName: "Contract.pdf",
      redirectUrl: "https://app.example.test/portal/contracts/contract-1",
      signers: [{ customerId: "customer-1", name: "Customer", phone: "13800000000", signerType: "CUSTOMER" }],
      taskId: "task-1",
      taskNo: "ESG-1"
    });

    expect(prisma.customerESignProviderAccount.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        accountType: "PERSONAL",
        certBindingStatus: "BOUND",
        customerId: "customer-1",
        provider: "FADADA",
        providerCustomerId: { not: null },
        realNameProviderStatusSource: { not: "UNKNOWN" },
        realNameStatus: "VERIFIED",
        registrationStatus: "REGISTERED"
      })
    }));
    expect(apiClient.createExternalSignUrl).toHaveBeenCalledWith(expect.objectContaining({
      customerId: "fadada-formal-customer-1"
    }));
    expect(result.rawResponse).toMatchObject({
      signerCustomer: {
        source: "FORMAL_BINDING"
      }
    });
  });

  it("rejects an unverified formal binding unless the B5 smoke override is explicitly enabled", async () => {
    const apiClient = {
      createExternalSignUrl: vi.fn(),
      uploadDocs: vi.fn()
    };
    const pdfArtifactService = {
      getContractPdfArtifact: vi.fn()
    };
    const prisma = {
      customerESignProviderAccount: {
        findFirst: vi.fn(async () => null)
      }
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_FULL_SIGNING_SMOKE: "0",
      FADADA_TEST_CUSTOMER_ID: "fadada-smoke-customer-1",
      FADADA_TEST_LOCAL_CUSTOMER_ID: "customer-1"
    })), apiClient as never, pdfArtifactService as never, prisma as never);

    await expect(provider.createSignTask({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      documentName: "Contract.pdf",
      redirectUrl: "https://app.example.test/portal/contracts/contract-1",
      signers: [{ customerId: "customer-1", name: "Customer", phone: "13800000000", signerType: "CUSTOMER" }],
      taskId: "task-1",
      taskNo: "ESG-1"
    })).rejects.toThrow(/FADADA_SIGNER_CUSTOMER_ID_MISSING/);

    expect(pdfArtifactService.getContractPdfArtifact).not.toHaveBeenCalled();
    expect(apiClient.uploadDocs).not.toHaveBeenCalled();
    expect(apiClient.createExternalSignUrl).not.toHaveBeenCalled();
  });

  it("rejects the B5 smoke provider customer id when the local customer does not match", async () => {
    const apiClient = {
      createExternalSignUrl: vi.fn(),
      uploadDocs: vi.fn()
    };
    const pdfArtifactService = {
      getContractPdfArtifact: vi.fn()
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_FULL_SIGNING_SMOKE: "1",
      FADADA_TEST_CUSTOMER_ID: "fadada-provider-customer-1",
      FADADA_TEST_LOCAL_CUSTOMER_ID: "customer-allowed"
    })), apiClient as never, pdfArtifactService as never);

    await expect(provider.createSignTask({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      documentName: "Contract.pdf",
      redirectUrl: "https://app.example.test/portal/contracts/contract-1",
      signers: [{ customerId: "customer-denied", name: "Customer", phone: "13800000000", signerType: "CUSTOMER" }],
      taskId: "task-1",
      taskNo: "ESG-1"
    })).rejects.toThrow(/FADADA_TEST_CUSTOMER_ID_MISMATCH/);

    expect(pdfArtifactService.getContractPdfArtifact).not.toHaveBeenCalled();
    expect(apiClient.uploadDocs).not.toHaveBeenCalled();
    expect(apiClient.createExternalSignUrl).not.toHaveBeenCalled();
  });

  it("rejects the B5 smoke provider customer id when smoke gates or ids are missing", async () => {
    const apiClient = {
      createExternalSignUrl: vi.fn(),
      uploadDocs: vi.fn()
    };
    const pdfArtifactService = {
      getContractPdfArtifact: vi.fn()
    };

    const disabled = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_FULL_SIGNING_SMOKE: "0",
      FADADA_TEST_CUSTOMER_ID: "fadada-provider-customer-1",
      FADADA_TEST_LOCAL_CUSTOMER_ID: "customer-1"
    })), apiClient as never, pdfArtifactService as never);
    await expect(disabled.createSignTask({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      documentName: "Contract.pdf",
      redirectUrl: "https://app.example.test/portal/contracts/contract-1",
      signers: [{ customerId: "customer-1", name: "Customer", phone: "13800000000", signerType: "CUSTOMER" }],
      taskId: "task-1",
      taskNo: "ESG-1"
    })).rejects.toThrow(/FADADA_SIGNER_CUSTOMER_ID_MISSING/);

    const missingProviderCustomer = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_FULL_SIGNING_SMOKE: "1",
      FADADA_TEST_LOCAL_CUSTOMER_ID: "customer-1"
    })), apiClient as never, pdfArtifactService as never);
    await expect(missingProviderCustomer.createSignTask({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      documentName: "Contract.pdf",
      redirectUrl: "https://app.example.test/portal/contracts/contract-1",
      signers: [{ customerId: "customer-1", name: "Customer", phone: "13800000000", signerType: "CUSTOMER" }],
      taskId: "task-1",
      taskNo: "ESG-1"
    })).rejects.toThrow(/FADADA_SIGNER_CUSTOMER_ID_MISSING/);

    expect(pdfArtifactService.getContractPdfArtifact).not.toHaveBeenCalled();
    expect(apiClient.uploadDocs).not.toHaveBeenCalled();
    expect(apiClient.createExternalSignUrl).not.toHaveBeenCalled();
  });

  it("returns an existing non-expired signer URL from local storage", async () => {
    const prisma = {
      contractESignSigner: {
        findFirst: vi.fn(async () => ({
          providerSignerId: "ESG1S1",
          signUrl: "https://sign.example.test/customer",
          signUrlExpiresAt: new Date(Date.now() + 60_000)
        }))
      }
    };
    const provider = new FadadaESignProvider(
      loadFadadaConfig(configService()),
      undefined,
      undefined,
      prisma as never
    );

    await expect(provider.getSignerUrl({ providerTaskId: "ESG1S1", taskId: "task-1" })).resolves.toMatchObject({
      rawResponse: { source: "LOCAL_SIGNER_URL" },
      signUrl: "https://sign.example.test/customer"
    });
  });

  it("allows stored signer URLs without a local expiry for legacy Fadada tasks", async () => {
    const prisma = {
      contractESignSigner: {
        findFirst: vi.fn(async () => ({
          providerSignerId: "ESG1S1",
          signUrl: "https://sign.example.test/customer",
          signUrlExpiresAt: null
        }))
      }
    };
    const provider = new FadadaESignProvider(
      loadFadadaConfig(configService()),
      undefined,
      undefined,
      prisma as never
    );

    await expect(provider.getSignerUrl({ providerTaskId: "ESG1S1", taskId: "task-1" })).resolves.toMatchObject({
      rawResponse: { source: "LOCAL_SIGNER_URL" },
      signUrl: "https://sign.example.test/customer"
    });
  });

  it("returns a clear error when no usable stored signer URL exists", async () => {
    const prisma = {
      contractESignSigner: {
        findFirst: vi.fn(async () => ({
          providerSignerId: "ESG1S1",
          signUrl: "https://sign.example.test/expired",
          signUrlExpiresAt: new Date(Date.now() - 60_000)
        }))
      }
    };
    const provider = new FadadaESignProvider(
      loadFadadaConfig(configService()),
      undefined,
      undefined,
      prisma as never
    );

    await expect(provider.getSignerUrl({ providerTaskId: "ESG1S1", taskId: "task-1" })).rejects.toThrow(
      /FADADA_SIGN_URL_NOT_AVAILABLE/
    );
  });

  it("auto seals with configured platform account and signature IDs", async () => {
    const apiClient = {
      autoSealContract: vi.fn(async () => ({
        contractId: "ESG-1",
        raw: { code: "1000" },
        resultCode: "1000",
        resultDesc: "success",
        transactionId: "ESG1S2"
      }))
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_PLATFORM_CUSTOMER_ID: "platform-customer-1",
      FADADA_PLATFORM_SIGNATURE_ID: "platform-signature-1"
    })), apiClient as never);

    const result = await provider.autoSealTask?.({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      documentName: "Contract.pdf",
      placement: {
        keyword: "出租方盖章",
        type: "KEYWORD"
      },
      providerEnvelopeId: "ESG-1",
      taskId: "task-1",
      taskNo: "ESG-1",
      transactionId: "ESG1S2"
    });

    expect(apiClient.autoSealContract).toHaveBeenCalledWith(expect.objectContaining({
      contractId: "ESG-1",
      customerId: "platform-customer-1",
      docTitle: "Contract.pdf",
      notifyUrl: "https://api.example.test/esign/callback/fadada",
      placement: {
        keyword: "出租方盖章",
        type: "KEYWORD"
      },
      signatureId: "platform-signature-1",
      transactionId: "ESG1S2"
    }));
    expect(result).toMatchObject({
      providerSignerId: "ESG1S2",
      resultCode: "1000",
      status: "COMPLETED"
    });
  });

  it("maps Stage 1 platform slots to one coordinate-based auto-seal transaction", async () => {
    const apiClient = {
      autoSealContract: vi.fn(async () => ({
        contractId: "ESG-1",
        raw: { code: "1000" },
        resultCode: "1000",
        resultDesc: "success",
        transactionId: "ESG1S2"
      }))
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_PLATFORM_CUSTOMER_ID: "platform-customer-1",
      FADADA_PLATFORM_SIGNATURE_ID: "platform-signature-1"
    })), apiClient as never);

    const result = await provider.autoSealTask?.({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      documentName: "Contract.pdf",
      providerEnvelopeId: "ESG-1",
      signingSlotCoordinates: stage1SlotCoordinates(),
      signingSlots: stage1SigningSlots(),
      signingStage: "STAGE1_CONTRACT",
      taskId: "task-1",
      taskNo: "ESG-1",
      transactionId: "ESG1S2"
    } as never);

    expect(apiClient.autoSealContract).toHaveBeenCalledWith(expect.objectContaining({
      contractId: "ESG-1",
      customerId: "platform-customer-1",
      docTitle: "Contract.pdf",
      notifyUrl: "https://api.example.test/esign/callback/fadada",
      signatureId: "platform-signature-1",
      signaturePositions: [
        { pagenum: 0, x: 521, y: 731 },
        { pagenum: 2, x: 523, y: 733 }
      ],
      transactionId: "ESG1S2"
    }));
    expect(result).toMatchObject({
      coveredSlotIds: ["STAGE1_BODY_PLATFORM", "STAGE1_ATTACHMENT1_PLATFORM"],
      providerActionType: "PLATFORM_AUTO_SEAL",
      providerSignerId: "ESG1S2",
      providerTransactionId: "ESG1S2",
      status: "COMPLETED"
    });
  });

  it("rejects Stage 1 platform auto seal before provider calls when platform coordinates are missing", async () => {
    const apiClient = {
      autoSealContract: vi.fn()
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_PLATFORM_CUSTOMER_ID: "platform-customer-1",
      FADADA_PLATFORM_SIGNATURE_ID: "platform-signature-1"
    })), apiClient as never);

    await expect(provider.autoSealTask?.({
      callbackUrl: "https://api.example.test/esign/callback/fadada",
      contractId: "contract-1",
      providerEnvelopeId: "ESG-1",
      signingSlotCoordinates: stage1SlotCoordinates().filter((coordinate) =>
        coordinate.slotId !== "STAGE1_ATTACHMENT1_PLATFORM"
      ),
      signingSlots: stage1SigningSlots(),
      signingStage: "STAGE1_CONTRACT",
      taskId: "task-1",
      taskNo: "ESG-1",
      transactionId: "ESG1S2"
    } as never)).rejects.toThrow(/FADADA_STAGE1_PLATFORM_SLOT_COORDINATES_MISSING/);
    expect(apiClient.autoSealContract).not.toHaveBeenCalled();
  });

  it("fails auto seal safely when platform seal positioning is missing", async () => {
    const apiClient = {
      autoSealContract: vi.fn()
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService({
      FADADA_PLATFORM_CUSTOMER_ID: "platform-customer-1",
      FADADA_PLATFORM_SIGNATURE_ID: "platform-signature-1"
    })), apiClient as never);

    await expect(provider.autoSealTask?.({
      contractId: "contract-1",
      providerEnvelopeId: "ESG-1",
      taskId: "task-1",
      taskNo: "ESG-1",
      transactionId: "ESG1S2"
    })).rejects.toThrow(/FADADA_PLATFORM_AUTO_SEAL_POSITIONING_MISSING/);
    expect(apiClient.autoSealContract).not.toHaveBeenCalled();
  });

  it("fails auto seal safely when platform config is missing", async () => {
    const apiClient = {
      autoSealContract: vi.fn()
    };
    const provider = new FadadaESignProvider(loadFadadaConfig(configService()), apiClient as never);

    await expect(provider.autoSealTask?.({
      contractId: "contract-1",
      providerEnvelopeId: "ESG-1",
      taskId: "task-1",
      taskNo: "ESG-1",
      transactionId: "ESG1S2"
    })).rejects.toThrow(/FADADA_PLATFORM_AUTO_SEAL_CONFIG_MISSING/);
    expect(apiClient.autoSealContract).not.toHaveBeenCalled();
  });

  it("verifies form callback digest without advancing business state", async () => {
    const provider = new FadadaESignProvider(loadFadadaConfig(configService()));
    const receivedMsgDigest = buildFadadaMsgDigest({
      appId: "app-123",
      appSecret: "secret-xyz",
      explicitSortString: "transaction-1",
      timestamp: "20260102030405"
    });

    const result = await provider.verifyCallback({
      contract_id: "contract-1",
      download_url: "https://example.test/download",
      msg_digest: receivedMsgDigest,
      result_code: "3000",
      result_desc: "success",
      timestamp: "20260102030405",
      transaction_id: "transaction-1",
      viewpdf_url: "https://example.test/view"
    });

    expect(result).toMatchObject({
      eventType: "FADADA_SIGN_COMPLETED",
      providerContractId: "contract-1",
      providerTaskId: "transaction-1",
      resultCode: "3000",
      verified: true
    });
    expect(result.payload).toMatchObject({
      download_url: "[redacted-url]",
      viewpdf_url: "[redacted-url]"
    });
  });

  it("parses form-urlencoded callback payloads and maps unknown result codes", async () => {
    const provider = new FadadaESignProvider(loadFadadaConfig(configService()));
    const receivedMsgDigest = buildFadadaMsgDigest({
      appId: "app-123",
      appSecret: "secret-xyz",
      explicitSortString: "transaction-form-1",
      timestamp: "20260102030405"
    });
    const payload = new URLSearchParams({
      contract_id: "contract-form-1",
      download_url: "https://download.example.test/file.pdf?token=secret",
      msg_digest: receivedMsgDigest,
      result_code: "3999",
      result_desc: "pending manual review",
      timestamp: "20260102030405",
      transaction_id: "transaction-form-1",
      viewpdf_url: "https://view.example.test/file.pdf?token=secret"
    });

    await expect(provider.verifyCallback(payload)).resolves.toMatchObject({
      eventType: "FADADA_SIGN_UNKNOWN",
      payload: {
        download_url: "[redacted-url]",
        result_code: "3999",
        viewpdf_url: "[redacted-url]"
      },
      providerContractId: "contract-form-1",
      providerTaskId: "transaction-form-1",
      resultCode: "3999",
      verified: true
    });
  });

  it("returns verified=false for invalid or missing callback digest", async () => {
    const provider = new FadadaESignProvider(loadFadadaConfig(configService()));

    await expect(
      provider.verifyCallback({
        result_code: "3000",
        timestamp: "20260102030405",
        transaction_id: "transaction-1"
      })
    ).resolves.toMatchObject({
      providerTaskId: "transaction-1",
      verified: false
    });

    await expect(
      provider.verifyCallback({
        msg_digest: "bad-digest",
        result_code: "3003",
        timestamp: "20260102030405",
        transaction_id: "transaction-1"
      })
    ).resolves.toMatchObject({
      eventType: "FADADA_SIGN_REJECTED",
      verified: false
    });
  });
});

function stage1SigningSlots(): ESignSigningSlot[] {
  return [
    {
      documentType: "CONTRACT_BODY",
      keyword: "stage1-body-customer",
      providerActionType: "CUSTOMER_MANUAL_SIGN",
      required: true,
      signerRole: "CUSTOMER",
      signingStage: "STAGE1_CONTRACT",
      slotId: "STAGE1_BODY_CUSTOMER"
    },
    {
      documentType: "CONTRACT_BODY",
      keyword: "stage1-body-platform",
      providerActionType: "PLATFORM_AUTO_SEAL",
      required: true,
      signerRole: "PLATFORM",
      signingStage: "STAGE1_CONTRACT",
      slotId: "STAGE1_BODY_PLATFORM"
    },
    {
      documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
      keyword: "stage1-attachment1-customer",
      providerActionType: "CUSTOMER_MANUAL_SIGN",
      required: true,
      signerRole: "CUSTOMER",
      signingStage: "STAGE1_CONTRACT",
      slotId: "STAGE1_ATTACHMENT1_CUSTOMER"
    },
    {
      documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
      keyword: "stage1-attachment1-platform",
      providerActionType: "PLATFORM_AUTO_SEAL",
      required: true,
      signerRole: "PLATFORM",
      signingStage: "STAGE1_CONTRACT",
      slotId: "STAGE1_ATTACHMENT1_PLATFORM"
    }
  ];
}

function stage1SlotCoordinates(): ESignSigningSlotCoordinate[] {
  return [
    {
      pageNumber: 0,
      slotId: "STAGE1_BODY_CUSTOMER",
      x: 520,
      y: 730
    },
    {
      pageNumber: 0,
      slotId: "STAGE1_BODY_PLATFORM",
      x: 521,
      y: 731
    },
    {
      pageNumber: 2,
      slotId: "STAGE1_ATTACHMENT1_CUSTOMER",
      x: 522,
      y: 732
    },
    {
      pageNumber: 2,
      slotId: "STAGE1_ATTACHMENT1_PLATFORM",
      x: 523,
      y: 733
    }
  ];
}

function configService(overrides: Record<string, string> = {}) {
  return new ConfigService({
    ESIGN_PROVIDER: "fadada",
    FADADA_API_VERSION: "2.0",
    FADADA_APP_ID: "app-123",
    FADADA_APP_SECRET: "secret-xyz",
    FADADA_BASE_URL: "https://testapi.fadada.com:8443/api/",
    FADADA_ENABLED: "false",
    FADADA_ENV: "sandbox",
    FADADA_REQUEST_TIMEOUT_MS: "15000",
    ...overrides
  });
}
