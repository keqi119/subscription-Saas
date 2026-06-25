import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ContractStatus, ESignProviderType, ESignTaskStatus, OrderStatus } from "@prisma/client";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  FadadaSignedArtifactApi,
  FadadaSignedArtifactService
} from "../src/esign/fadada/fadada-signed-artifact.service";
import { RequestUser } from "../src/auth/auth.types";
import { CurrentCustomer } from "../src/portal/portal-auth.types";

describe("FadadaSignedArtifactService", () => {
  it("requires a completed Fadada task before archiving signed artifacts", async () => {
    const { service, state } = createFixture();
    state.task.taskStatus = ESignTaskStatus.WAITING_CUSTOMER;

    await expect(service.archiveSignedContract({ taskId: "task-1" })).rejects.toBeInstanceOf(BadRequestException);

    state.task.taskStatus = ESignTaskStatus.COMPLETED;
    state.task.provider = ESignProviderType.MOCK;

    await expect(service.archiveSignedContract({ taskId: "task-1" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("downloads, validates, stores and records a signed PDF without changing contract or order state", async () => {
    const { apiClient, service, state, storageService } = createFixture();
    const signedAt = state.contract.signedAt;
    const orderStatus = state.contract.order.orderStatus;
    const finance = financeSnapshot(state);

    const result = await service.archiveSignedContract({ taskId: "task-1" });

    expect(apiClient.querySignResult).toHaveBeenCalledWith({
      contractId: "FADADA-CON-1",
      transactionId: "TX-1"
    });
    expect(apiClient.downloadSignedContract).toHaveBeenCalledWith({
      contractId: "FADADA-CON-1",
      downloadUrl: "https://download.example.test/file.pdf?token=secret"
    });
    expect(apiClient.createContractFiling).toHaveBeenCalledWith({ contractId: "FADADA-CON-1" });
    expect(storageService.putContractSignedArtifact).toHaveBeenCalledWith(expect.objectContaining({
      buffer: expect.any(Buffer),
      contentType: "application/pdf",
      contractId: "contract-1",
      originalName: "CON-1-signed.pdf",
      provider: "fadada"
    }));
    expect(result).toMatchObject({
      archived: true,
      evidenceObjectKey: null,
      signedPdfObjectKey: "contracts/contract-1/esign/fadada/signed/2026/signed-1.pdf"
    });
    expect(state.task.signedDocumentObjectKey).toBe("contracts/contract-1/esign/fadada/signed/2026/signed-1.pdf");
    expect(state.task.evidenceObjectKey).toBeNull();
    expect(state.contract.signedAt).toBe(signedAt);
    expect(state.contract.order.orderStatus).toBe(orderStatus);
    expect(financeSnapshot(state)).toEqual(finance);
    expect(JSON.stringify(state.task.responseSnapshot)).not.toContain("token=secret");
    expect(JSON.stringify(state.task.responseSnapshot)).toContain("[redacted-url]");
  });

  it("skips archive idempotently when a signed PDF already exists", async () => {
    const { apiClient, service, state, storageService } = createFixture();
    state.task.signedDocumentObjectKey = "contracts/contract-1/esign/fadada/signed/2026/existing.pdf";

    const result = await service.archiveSignedContract({ taskId: "task-1" });

    expect(result).toEqual({
      archived: false,
      evidenceObjectKey: null,
      signedPdfObjectKey: "contracts/contract-1/esign/fadada/signed/2026/existing.pdf",
      skippedReason: "SIGNED_PDF_ALREADY_ARCHIVED"
    });
    expect(apiClient.downloadSignedContract).not.toHaveBeenCalled();
    expect(storageService.putContractSignedArtifact).not.toHaveBeenCalled();
  });

  it("force archives a new signed PDF object key without changing finance state", async () => {
    const { service, state, storageService } = createFixture();
    const signedAt = state.contract.signedAt;
    const orderStatus = state.contract.order.orderStatus;
    const finance = financeSnapshot(state);

    const first = await service.archiveSignedContract({ taskId: "task-1" });
    const firstObjectKey = state.task.signedDocumentObjectKey;
    const forced = await service.archiveSignedContract({ force: true, taskId: "task-1" });

    expect(first).toMatchObject({
      archived: true,
      signedPdfObjectKey: "contracts/contract-1/esign/fadada/signed/2026/signed-1.pdf"
    });
    expect(forced).toMatchObject({
      archived: true,
      evidenceObjectKey: null,
      signedPdfObjectKey: "contracts/contract-1/esign/fadada/signed/2026/signed-2.pdf"
    });
    expect(forced.signedPdfObjectKey).not.toBe(firstObjectKey);
    expect(state.task.signedDocumentObjectKey).toBe(forced.signedPdfObjectKey);
    expect(state.task.evidenceObjectKey).toBeNull();
    expect(state.contract.signedAt).toBe(signedAt);
    expect(state.contract.order.orderStatus).toBe(orderStatus);
    expect(financeSnapshot(state)).toEqual(finance);
    expect(storageService.putContractSignedArtifact).toHaveBeenCalledTimes(2);
  });

  it("streams archived signed PDFs for admins and owning portal customers only", async () => {
    const { service, state, storageService } = createFixture();
    state.task.signedDocumentObjectKey = "contracts/contract-1/esign/fadada/signed/2026/signed.pdf";

    const adminPreview = await service.getAdminSignedContractPreview("task-1", adminUser());
    const portalPreview = await service.getPortalSignedContractPreview("contract-1", currentCustomer("customer-1"));

    expect(adminPreview).toMatchObject({
      contentType: "application/pdf",
      filename: "CON-1-signed.pdf",
      sizeBytes: minimalPdf().length
    });
    expect(portalPreview).toMatchObject({
      contentType: "application/pdf",
      filename: "CON-1-signed.pdf",
      sizeBytes: minimalPdf().length
    });
    expect(storageService.getContractSignedArtifactStream).toHaveBeenCalledWith(
      "contracts/contract-1/esign/fadada/signed/2026/signed.pdf"
    );
    expect(adminPreview).not.toHaveProperty("objectKey");
    expect(portalPreview).not.toHaveProperty("objectKey");
    await expect(
      service.getPortalSignedContractPreview("contract-1", currentCustomer("customer-other"))
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

class TestFadadaSignedArtifactService extends FadadaSignedArtifactService {
  constructor(
    prisma: never,
    storageService: never,
    configService: ConfigService,
    private readonly testApiClient: FadadaSignedArtifactApi
  ) {
    super(prisma, storageService, configService);
  }

  protected override getApiClient(): FadadaSignedArtifactApi {
    return this.testApiClient;
  }
}

function createFixture() {
  const state = {
    contract: {
      contractNo: "CON-1",
      customerId: "customer-1",
      deletedAt: null,
      id: "contract-1",
      order: {
        application: { salesUserId: "user-sales" },
        deletedAt: null,
        id: "order-1",
        orderStatus: OrderStatus.PENDING_PAYMENT
      },
      signedAt: new Date("2026-01-03T04:05:06.000Z"),
      status: ContractStatus.SIGNED
    },
    finance: {
      paymentOrders: [
        {
          amount: "120000.00",
          id: "payment-order-1",
          paymentStatus: "PENDING"
        }
      ],
      paymentRecords: [
        {
          amount: "0.00",
          id: "payment-record-1",
          paymentStatus: "DRAFT"
        }
      ],
      paymentWriteOffs: [
        {
          amount: "0.00",
          id: "writeoff-1"
        }
      ],
      receivableBills: [
        {
          amount: "120000.00",
          billStatus: "PENDING",
          id: "bill-1"
        }
      ]
    },
    task: {
      callbackSnapshot: null as unknown,
      completedAt: new Date("2026-01-03T04:05:06.000Z"),
      contractId: "contract-1",
      customerId: "customer-1",
      deletedAt: null as Date | null,
      documentName: "Subscription Contract",
      errorSnapshot: null as unknown,
      evidenceObjectKey: null as string | null,
      id: "task-1",
      orderId: "order-1",
      provider: ESignProviderType.FADADA as ESignProviderType,
      providerEnvelopeId: "FADADA-CON-1",
      providerTaskId: "TX-1",
      responseSnapshot: null as unknown,
      signedDocumentObjectKey: null as string | null,
      taskNo: "ESG-1",
      taskStatus: ESignTaskStatus.COMPLETED as ESignTaskStatus
    }
  };
  const pdf = minimalPdf();
  const apiClient: FadadaSignedArtifactApi = {
    createContractFiling: vi.fn(async () => ({
      contractId: "FADADA-CON-1",
      filingNo: "FILING-1",
      raw: { filing_no: "FILING-1" }
    })),
    downloadSignedContract: vi.fn(async () => ({
      buffer: pdf,
      contentType: "application/pdf" as const,
      fileName: "provider-signed.pdf"
    })),
    queryContractStatus: vi.fn(async () => ({
      contractId: "FADADA-CON-1",
      raw: { contractStatus: "2" },
      status: "2"
    })),
    querySignResult: vi.fn(async () => ({
      contractId: "FADADA-CON-1",
      downloadUrl: "https://download.example.test/file.pdf?token=secret",
      raw: {
        download_url: "https://download.example.test/file.pdf?token=secret",
        result: "3000",
        viewpdf_url: "https://view.example.test/file.pdf?token=secret"
      },
      resultCode: "3000",
      transactionId: "TX-1",
      viewPdfUrl: "https://view.example.test/file.pdf?token=secret"
    }))
  };
  const prisma = {
    contractESignTask: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id && where.id !== state.task.id) return null;
        if (where.contractId && where.contractId !== state.task.contractId) return null;
        if (where.customerId && where.customerId !== state.task.customerId) return null;
        if (where.provider && where.provider !== state.task.provider) return null;
        if (where.taskStatus && where.taskStatus !== state.task.taskStatus) return null;
        if (where.deletedAt === null && state.task.deletedAt !== null) return null;
        const signedWhere = where.signedDocumentObjectKey as { not?: null } | undefined;
        if (signedWhere?.not === null && !state.task.signedDocumentObjectKey) return null;
        return hydrateTask(state);
      }),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        if (where.id !== state.task.id) {
          throw new Error("task not found");
        }
        Object.assign(state.task, data);
        return hydrateTask(state);
      })
    }
  };
  let signedArtifactWriteCount = 0;
  const storageService = {
    getContractSignedArtifactStream: vi.fn(async () => ({
      contentLength: pdf.length,
      contentType: "application/pdf",
      originalName: "signed.pdf",
      stream: Readable.from([pdf])
    })),
    putContractSignedArtifact: vi.fn(async () => {
      signedArtifactWriteCount += 1;
      const objectKey = `contracts/contract-1/esign/fadada/signed/2026/signed-${signedArtifactWriteCount}.pdf`;
      return {
        bucket: "application-materials",
        objectKey,
        stored: {
          contentType: "application/pdf",
          driver: "local",
          key: `application-materials/${objectKey}`,
          size: pdf.length
        }
      };
    })
  };
  const service = new TestFadadaSignedArtifactService(
    prisma as never,
    storageService as never,
    new ConfigService({
      ESIGN_PROVIDER: "fadada",
      FADADA_API_VERSION: "2.0",
      FADADA_APP_ID: "app-123",
      FADADA_APP_SECRET: "secret-xyz",
      FADADA_BASE_URL: "https://testapi.fadada.com:8443/api/",
      FADADA_ENABLED: "false",
      FADADA_ENV: "sandbox"
    }),
    apiClient
  );

  return { apiClient, prisma, service, state, storageService };
}

function hydrateTask(state: ReturnType<typeof createFixture>["state"]) {
  return {
    ...state.task,
    contract: state.contract
  };
}

function financeSnapshot(state: ReturnType<typeof createFixture>["state"]) {
  return JSON.parse(JSON.stringify(state.finance));
}

function minimalPdf() {
  return Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");
}

function adminUser(): RequestUser {
  return {
    id: "user-admin",
    menus: [],
    name: "Admin",
    permissions: ["contract:view", "contract:archive"],
    roles: ["admin"],
    username: "admin"
  };
}

function currentCustomer(customerId: string): CurrentCustomer {
  return {
    accountStatus: "ACTIVE",
    customerAccountId: customerId === "customer-1" ? "account-1" : "account-other",
    customerId,
    phone: "13800000000"
  } as CurrentCustomer;
}
