import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";

import { createESignProviderClient } from "../src/esign/esign.module";
import { buildFadadaMsgDigest } from "../src/esign/fadada/fadada-digest";
import { FadadaESignProvider } from "../src/esign/fadada/fadada-esign.provider";
import { loadFadadaConfig } from "../src/esign/fadada/fadada.config";
import { MockESignProvider } from "../src/esign/mock-esign.provider";

describe("Fadada provider configuration", () => {
  it("does not require Fadada env when the selected provider is mock", () => {
    const provider = createESignProviderClient(new ConfigService({ ESIGN_PROVIDER: "mock" }));

    expect(provider).toBeInstanceOf(MockESignProvider);
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
  it("rejects Stage 1 slot-aware input before upload because multi-position mapping is not implemented", async () => {
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
    })).rejects.toThrow(/FADADA_STAGE1_MULTI_SLOT_MAPPING_NOT_IMPLEMENTED/);

    expect(pdfArtifactService.getContractPdfArtifact).not.toHaveBeenCalled();
    expect(apiClient.uploadDocs).not.toHaveBeenCalled();
    expect(apiClient.createExternalSignUrl).not.toHaveBeenCalled();
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
        customerId: "customer-1",
        provider: "FADADA",
        providerCustomerId: { not: null },
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
